/**
 * Offline verification (LICENSE_OPERATIONS.md §6). Steps 1–10 are implemented here as a pure,
 * synchronous function with injected clock, last-seen store, fingerprint, key table, revocation list
 * and build date. Steps 11 (persist to the `license` table) and 12 (SSE `license.updated`) belong to the
 * service integration, which receives everything it needs in `LicenseResult`.
 */
import { z } from 'zod';
import { base32Decode, MAX_PAYLOAD_BYTES, SIGNATURE_BYTES, signingMessage, splitToken, TOKEN_PREFIX, TOKEN_SIGNING_PREFIX } from './format.js';
import { combinedFingerprintHex, matchFingerprint, type FingerprintMatch, type LocalFingerprint } from './fingerprint.js';
import { ed25519Verify, findKey, type PublicKeyEntry } from './keys.js';
import { isRevoked, type TrustedRevocationList } from './revocations.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FPC_RE = /^[A-Z2-7]{13}$/; // base32 of 8 bytes, no padding

export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidIsoSeconds(s: string): boolean {
  if (!ISO_SECONDS_RE.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().replace('.000Z', 'Z') === s;
}

export const TIERS = ['standard', 'pro'] as const;
export type Tier = (typeof TIERS)[number];

/** Payload schema (§3.1). */
export const LicensePayloadSchema = z
  .object({
    v: z.literal(1),
    lid: z.string().regex(ULID_RE),
    name: z.string().min(1).refine((s) => [...s].length <= 64 && s === s.trim(), 'name: trimmed, ≤ 64 characters'),
    eh: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    tier: z.enum(TIERS),
    fp: z.string().regex(/^[0-9a-f]{64}$/),
    fpc: z.array(z.string().regex(FPC_RE)).length(3),
    iat: z.string().refine(isValidIsoSeconds, 'iat: ISO 8601 UTC seconds'),
    upd: z.string().refine(isValidIsoDate, 'upd: ISO date'),
    feat: z.array(z.string().max(64)).max(64),
    rev: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine((p) => {
    const parts = p.fpc.map((s) => base32Decode(s));
    if (parts.some((b) => b === null || b.length !== 8)) return false;
    return combinedFingerprintHex(parts as unknown as readonly [Uint8Array, Uint8Array, Uint8Array]) === p.fp;
  }, 'fp must equal SHA-256(c1 ‖ c2 ‖ c3)');

export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

/** Licence states (single edition, no Trial Mode; Operator decision 2026-10-25). Only `licensed` unlocks the product. */
export type LicenseStatus = 'licensed' | 'unlicensed' | 'invalid' | 'revoked' | 'machine-mismatch';
export type LicenseErrorCode = 'EM-5002' | 'EM-5003' | 'EM-5004' | 'EM-5005' | 'EM-5006' | 'EM-5009';

export interface ClockWarning {
  readonly code: 'EM-5007';
  readonly lastSeen: string;
  readonly now: string;
}

/** Persistent monotonic "latest wall-clock time observed" (§9). Backed by `license.last_seen_at` + keyring copy. */
export interface LastSeenStore {
  get(): Date | null;
  set(value: Date): void;
}

export interface VerifyContext {
  /** embedded public-key table (`embeddedKeyTable()` in production) */
  readonly keys: readonly PublicKeyEntry[];
  /** this machine's fingerprint, read once per launch */
  readonly fingerprint: LocalFingerprint;
  /** compiled release date, YYYY-MM-DD */
  readonly buildDate: string;
  /** newest trusted revoked.json, or null */
  readonly revocations: TrustedRevocationList | null;
  readonly now: () => Date;
  readonly lastSeen: LastSeenStore;
}

export interface LicenseeInfo {
  readonly lid: string;
  readonly name: string;
  readonly kid: string;
  readonly rev: number;
  readonly issuedAt: string;
  readonly features: readonly string[];
}

export interface LicenseResult {
  readonly status: LicenseStatus;
  readonly code?: LicenseErrorCode;
  /** null unless the signature verified */
  readonly tier: Tier | null;
  readonly updatesUntil: string | null;
  readonly licensee: LicenseeInfo | null;
  /** EM-5007 when the clock went backwards by more than 24 h; never affects status */
  readonly warnings: readonly ClockWarning[];
  readonly clockAnomaly: boolean;
  /** max(lastSeen, now) — use for update-feed eligibility and revoked.json freshness */
  readonly effectiveNow: string;
  /** support diagnostics only (no raw identifiers) */
  readonly fingerprintMatch?: FingerprintMatch;
  /** the normalised key string, kept so a rejected key stays visible for copying */
  readonly keyInput: string | null;
}

export const CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export interface ClockCheck {
  readonly anomaly: boolean;
  readonly warning: ClockWarning | null;
  readonly newLastSeen: Date;
  readonly effectiveNow: Date;
}

/** §9: pure clock check. Forward jumps are ignored; rollbacks > 24 h set the anomaly flag. */
export function checkClock(now: Date, lastSeen: Date | null): ClockCheck {
  const anomaly = lastSeen !== null && now.getTime() < lastSeen.getTime() - CLOCK_ROLLBACK_TOLERANCE_MS;
  const newLastSeen = lastSeen !== null && lastSeen.getTime() > now.getTime() ? lastSeen : now;
  return {
    anomaly,
    warning: anomaly && lastSeen ? { code: 'EM-5007', lastSeen: lastSeen.toISOString(), now: now.toISOString() } : null,
    newLastSeen,
    effectiveNow: newLastSeen,
  };
}

/** Update `lastSeen` (call at startup, hourly and at shutdown) and report a rollback. */
export function tickClock(ctx: Pick<VerifyContext, 'now' | 'lastSeen'>): ClockCheck {
  const c = checkClock(ctx.now(), ctx.lastSeen.get());
  ctx.lastSeen.set(c.newLastSeen);
  return c;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Verify a Licence Key offline (§6 steps 1–10). Never throws for any input string.
 * `input` null / empty → `unlicensed` (the product stays locked until a key is activated).
 */
export function verifyLicense(input: string | null | undefined, ctx: VerifyContext): LicenseResult {
  const clock = tickClock(ctx); // step 10 runs on every path so lastSeen stays monotonic even without a key
  const base = {
    warnings: clock.warning ? [clock.warning] : [],
    clockAnomaly: clock.anomaly,
    effectiveNow: clock.effectiveNow.toISOString(),
  };
  const raw = typeof input === 'string' ? input : '';
  if (raw.trim() === '') {
    return { ...base, status: 'unlicensed', tier: null, updatesUntil: null, licensee: null, keyInput: null };
  }

  const reject = (code: LicenseErrorCode, keyInput: string | null, extra?: { fingerprintMatch?: FingerprintMatch; payload?: LicensePayload; kid?: string }): LicenseResult => {
    const p = extra?.payload;
    const r: LicenseResult = {
      ...base,
      status: code === 'EM-5004' ? 'revoked' : code === 'EM-5003' ? 'machine-mismatch' : 'invalid',   // EM-5005 (build not covered) → invalid
      code,
      tier: p ? p.tier : null,
      updatesUntil: p ? p.upd : null,
      licensee: p && extra?.kid ? toLicensee(p, extra.kid) : null,
      keyInput,
      ...(extra?.fingerprintMatch ? { fingerprintMatch: extra.fingerprintMatch } : {}),
    };
    return r;
  };

  // Step 1: normalise, split into exactly four parts.
  const parts = splitToken(raw);
  if (!parts) return reject('EM-5006', raw.length <= 16384 ? raw.trim() : null);
  const keyInput = `${parts.prefix}-${parts.kid}-${parts.payloadB32}-${parts.signatureB32}`;
  // Step 2: known prefix.
  if (parts.prefix !== TOKEN_PREFIX) return reject('EM-5006', keyInput);
  // Step 3: kid lookup.
  const key = findKey(ctx.keys, parts.kid);
  if (!key) return reject('EM-5009', keyInput);
  if (key.status === 'revoked') return reject('EM-5002', keyInput);
  // Step 4: decode, bounds.
  if (parts.payloadB32.length > Math.ceil((MAX_PAYLOAD_BYTES * 8) / 5)) return reject('EM-5006', keyInput);
  const payloadBytes = base32Decode(parts.payloadB32);
  const signature = base32Decode(parts.signatureB32);
  if (!payloadBytes || !signature || signature.length !== SIGNATURE_BYTES || payloadBytes.length === 0 || payloadBytes.length > MAX_PAYLOAD_BYTES) {
    return reject('EM-5006', keyInput);
  }
  // Step 5: signature over the bytes exactly as received.
  if (!ed25519Verify(signature, signingMessage(TOKEN_SIGNING_PREFIX, parts.kid, payloadBytes), key.publicKeyHex)) {
    return reject('EM-5002', keyInput);
  }
  // Step 6: parse + schema.
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return reject('EM-5006', keyInput);
  }
  const parsed = LicensePayloadSchema.safeParse(json);
  if (!parsed.success) return reject('EM-5006', keyInput);
  const payload = parsed.data;
  // Step 7: revocation epoch.
  if (isRevoked(ctx.revocations, payload.lid, payload.rev)) return reject('EM-5004', keyInput, { payload, kid: parts.kid });
  // Step 8: fingerprint, 2-of-3 tolerance for hardware drift on the same machine only.
  const fingerprintMatch = matchFingerprint(ctx.fingerprint, payload.fpc);
  if (!fingerprintMatch.ok) return reject('EM-5003', keyInput, { payload, kid: parts.kid, fingerprintMatch });
  // Step 9: updates eligibility uses the compiled build date, never the clock.
  if (!(ctx.buildDate <= payload.upd)) return reject('EM-5005', keyInput, { payload, kid: parts.kid, fingerprintMatch });

  return {
    ...base,
    status: 'licensed',
    tier: payload.tier,   // kept for compatibility; never gates a feature (single edition)
    updatesUntil: payload.upd,
    licensee: toLicensee(payload, parts.kid),
    fingerprintMatch,
    keyInput,
  };
}

function toLicensee(p: LicensePayload, kid: string): LicenseeInfo {
  return { lid: p.lid, name: p.name, kid, rev: p.rev, issuedAt: p.iat, features: p.feat };
}

/** Decode a key's Payload WITHOUT trusting it (support/diagnostics only; never use for decisions). */
export function decodeUntrustedPayload(input: string): unknown {
  const parts = splitToken(input);
  if (!parts) return null;
  const bytes = base32Decode(parts.payloadB32);
  if (!bytes || bytes.length > MAX_PAYLOAD_BYTES) return null;
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
