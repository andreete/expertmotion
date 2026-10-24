/**
 * Signed revocation list `revoked.json` + `revoked.json.sig` (LICENSE_OPERATIONS.md §8.2).
 *
 * Signature file format (resolved here; §8.2 says "detached Ed25519 signature … same key table and kid,
 * prefix EMREV1"): one line `EMREV1-<kid>-<BASE32(signature)>`. The signed message is
 * UTF8("EMREV1") ‖ 0x00 ‖ UTF8(kid) ‖ 0x00 ‖ exact bytes of revoked.json.
 */
import { z } from 'zod';
import { base32Decode, normaliseBase32Field, REVOCATION_SIGNING_PREFIX, SIGNATURE_BYTES, signingMessage, stripAndUpper } from './format.js';
import { ed25519Verify, findKey, type PublicKeyEntry } from './keys.js';

export const MAX_REVOCATION_LIST_BYTES = 4 * 1024 * 1024;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const RevocationEntrySchema = z.object({
  lid: z.string().regex(ULID_RE),
  epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** informational: rebind | renewal | refund | fraud | keyrotation */
  reason: z.string().max(32),
});

export const RevocationListSchema = z.object({
  v: z.literal(1),
  generatedAt: z.string().regex(ISO_SECONDS_RE).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date'),
  entries: z.array(RevocationEntrySchema),
});

export type RevocationList = z.infer<typeof RevocationListSchema>;

/** A list whose signature has been verified. Keep `bytes` and `signatureText` to persist it unchanged. */
export interface TrustedRevocationList {
  readonly list: RevocationList;
  readonly generatedAtMs: number;
  /** highest epoch per lid */
  readonly epochs: ReadonlyMap<string, number>;
  readonly kid: string;
  readonly bytes: Uint8Array;
  readonly signatureText: string;
}

export type RevocationVerifyResult =
  | { readonly ok: true; readonly trusted: TrustedRevocationList }
  | { readonly ok: false; readonly reason: 'format' | 'unknown-kid' | 'revoked-kid' | 'signature' };

export function parseRevocationSignature(sigText: string): { kid: string; signature: Uint8Array } | null {
  if (sigText.length > 1024) return null;
  const parts = stripAndUpper(sigText).split('-');
  if (parts.length !== 3 || parts[0] !== REVOCATION_SIGNING_PREFIX) return null;
  const kid = parts[1] as string;
  const signature = base32Decode(normaliseBase32Field(parts[2] as string));
  if (!kid || !signature || signature.length !== SIGNATURE_BYTES) return null;
  return { kid, signature };
}

/** Verify the signature over the exact bytes FIRST, then parse (never re-serialise before verifying). */
export function verifyRevocationList(bytes: Uint8Array, signatureText: string, keys: readonly PublicKeyEntry[]): RevocationVerifyResult {
  if (bytes.length > MAX_REVOCATION_LIST_BYTES) return { ok: false, reason: 'format' };
  const sig = parseRevocationSignature(signatureText);
  if (!sig) return { ok: false, reason: 'format' };
  const key = findKey(keys, sig.kid);
  if (!key) return { ok: false, reason: 'unknown-kid' };
  if (key.status === 'revoked') return { ok: false, reason: 'revoked-kid' };
  if (!ed25519Verify(sig.signature, signingMessage(REVOCATION_SIGNING_PREFIX, sig.kid, bytes), key.publicKeyHex)) {
    return { ok: false, reason: 'signature' };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: 'format' };
  }
  const parsed = RevocationListSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'format' };
  const epochs = new Map<string, number>();
  for (const e of parsed.data.entries) epochs.set(e.lid, Math.max(epochs.get(e.lid) ?? 0, e.epoch));
  return {
    ok: true,
    trusted: {
      list: parsed.data,
      generatedAtMs: Date.parse(parsed.data.generatedAt),
      epochs,
      kid: sig.kid,
      bytes,
      signatureText: signatureText.trim(),
    },
  };
}

/** A Licence Key is revoked when an entry for its lid has epoch > payload.rev (§8.2). */
export function isRevoked(list: TrustedRevocationList | null, lid: string, rev: number): boolean {
  if (!list) return false;
  const epoch = list.epochs.get(lid);
  return epoch !== undefined && epoch > rev;
}

/**
 * Monotonicity (§8.2): a candidate replaces the stored list only if it verified and its generatedAt is
 * strictly newer. Returns the list to keep.
 */
export function selectNewerList(current: TrustedRevocationList | null, candidate: TrustedRevocationList | null): TrustedRevocationList | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate.generatedAtMs > current.generatedAtMs ? candidate : current;
}

/**
 * Convenience for the service: verify each available copy (embedded in the release, stored under
 * %APPDATA%, freshly fetched) and keep the newest trusted one. Unverifiable copies are ignored.
 */
export function newestTrustedList(
  copies: readonly { readonly bytes: Uint8Array; readonly signatureText: string }[],
  keys: readonly PublicKeyEntry[],
): TrustedRevocationList | null {
  let best: TrustedRevocationList | null = null;
  for (const c of copies) {
    const r = verifyRevocationList(c.bytes, c.signatureText, keys);
    if (r.ok) best = selectNewerList(best, r.trusted);
  }
  return best;
}
