// Licence Key building/signing + a support-side verifier (§6 steps 1–9 when inputs are given).
// The Local Service's TypeScript verifier is authoritative; tests assert both agree.
import { createHash } from 'node:crypto';
import {
  base32Decode, base32Encode, canonicalJson, isMissing, normaliseBase32Field, REVOCATION_SIGNING_PREFIX,
  signingMessage, stripAndUpper, TOKEN_PREFIX,
} from './format.mjs';
import { sign, verify } from './keys.mjs';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function buildPayload({ lid, name, eh, tier, fp, fpc, iat, upd, rev, feat = [] }) {
  return { eh, feat, fp, fpc, iat, lid, name, rev, tier, upd, v: 1 };
}

export function signToken(payload, key) {
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  if (bytes.length > 4096) throw new Error('payload exceeds 4 KB');
  const sig = sign(signingMessage(TOKEN_PREFIX, key.kid, bytes), key.seed);
  return `${TOKEN_PREFIX}-${key.kid}-${base32Encode(bytes)}-${base32Encode(sig)}`;
}

export function signRevocationList(bytes, key) {
  const sig = sign(signingMessage(REVOCATION_SIGNING_PREFIX, key.kid, bytes), key.seed);
  return `${REVOCATION_SIGNING_PREFIX}-${key.kid}-${base32Encode(sig)}\n`;
}

/** Verify revoked.json + sig text against the key table; returns Map lid→epoch or null. */
export function verifyRevocationList(bytes, sigText, keys) {
  const parts = stripAndUpper(sigText).split('-');
  if (parts.length !== 3 || parts[0] !== REVOCATION_SIGNING_PREFIX) return null;
  const key = keys.find((k) => k.kid === parts[1]);
  const sig = base32Decode(normaliseBase32Field(parts[2]));
  if (!key || key.status === 'revoked' || !sig || sig.length !== 64) return null;
  if (!verify(sig, signingMessage(REVOCATION_SIGNING_PREFIX, key.kid, bytes), key.publicKeyHex)) return null;
  const list = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const epochs = new Map();
  for (const e of list.entries ?? []) epochs.set(e.lid, Math.max(epochs.get(e.lid) ?? 0, e.epoch));
  return epochs;
}

function matchFingerprint(machine, fpc) {
  let compared = 0;
  let matched = 0;
  for (let i = 0; i < 3; i++) {
    const remote = base32Decode(fpc[i] ?? '');
    if (!machine.present[i] || !remote || remote.length !== 8 || isMissing(remote)) continue;
    compared++;
    if (Buffer.from(remote).equals(Buffer.from(machine.components[i]))) matched++;
  }
  return { ok: compared === 3 ? matched >= 2 : compared === 2 ? matched === 2 : false, compared, matched };
}

/**
 * @param {string} input
 * @param {{keys: Array, machine?: object, revocations?: Map, buildDate?: string}} ctx
 */
export function verifyKey(input, ctx) {
  const out = (code, extra = {}) => ({ code, valid: code === null, ...extra });
  if (typeof input !== 'string' || input.length > 16384) return out('EM-5006');
  const parts = stripAndUpper(input).split('-');
  if (parts.length !== 4 || parts.some((p) => p === '')) return out('EM-5006');
  const [prefix, kid] = parts;
  const payloadB32 = normaliseBase32Field(parts[2]);
  const sigB32 = normaliseBase32Field(parts[3]);
  if (prefix !== TOKEN_PREFIX) return out('EM-5006');
  const key = ctx.keys.find((k) => k.kid === kid);
  if (!key) return out('EM-5009', { kid });
  if (key.status === 'revoked') return out('EM-5002', { kid });
  const bytes = base32Decode(payloadB32);
  const sig = base32Decode(sigB32);
  if (!bytes || !sig || sig.length !== 64 || bytes.length === 0 || bytes.length > 4096) return out('EM-5006');
  if (!verify(sig, signingMessage(TOKEN_PREFIX, kid, bytes), key.publicKeyHex)) return out('EM-5002', { kid });
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return out('EM-5006');
  }
  const shapeOk = payload && payload.v === 1 && ULID_RE.test(payload.lid) && ['standard', 'pro'].includes(payload.tier)
    && Array.isArray(payload.fpc) && payload.fpc.length === 3 && Number.isSafeInteger(payload.rev) && payload.rev >= 0
    && /^\d{4}-\d{2}-\d{2}$/.test(payload.upd) && typeof payload.name === 'string';
  if (!shapeOk) return out('EM-5006');
  const fpCheck = payload.fpc.map((s) => base32Decode(s));
  if (fpCheck.some((b) => !b || b.length !== 8)
    || createHash('sha256').update(Buffer.concat(fpCheck)).digest('hex') !== payload.fp) return out('EM-5006');
  if (ctx.revocations) {
    const epoch = ctx.revocations.get(payload.lid);
    if (epoch !== undefined && epoch > payload.rev) return out('EM-5004', { kid, payload, revokedEpoch: epoch });
  }
  let fingerprint;
  if (ctx.machine) {
    fingerprint = matchFingerprint(ctx.machine, payload.fpc);
    if (!fingerprint.ok) return out('EM-5003', { kid, payload, fingerprint });
  }
  if (ctx.buildDate && !(ctx.buildDate <= payload.upd)) return out('EM-5005', { kid, payload, fingerprint });
  return out(null, { kid, payload, fingerprint });
}
