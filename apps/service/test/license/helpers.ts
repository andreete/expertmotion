/** Test helpers. DEV-ONLY key pairs are generated in memory at test time and never written to disk. */
import { createHash } from 'node:crypto';
import {
  canonicalJson, computeFingerprint, ed25519PublicKeyHex, ed25519Sign, encodeToken, generateDevPrivateKey,
  signingMessage, TOKEN_SIGNING_PREFIX, REVOCATION_SIGNING_PREFIX, base32Encode, verifyRevocationList,
  type LastSeenStore, type LocalFingerprint, type PublicKeyEntry, type RawComponents, type TrustedRevocationList,
  type VerifyContext, type LicensePayload,
} from '../../src/license/index.js';

export interface DevKey {
  readonly kid: string;
  readonly seed: Uint8Array;
  readonly entry: PublicKeyEntry;
}

export function makeDevKey(kid = 'T1', status: PublicKeyEntry['status'] = 'active'): DevKey {
  const seed = generateDevPrivateKey();
  return { kid, seed, entry: { kid, publicKeyHex: ed25519PublicKeyHex(seed), status, since: '2026-10-24' } };
}

export const MACHINE_A: RawComponents = {
  machineGuid: '6F1C2B3A-1111-4C5D-9E8F-0123456789AB',
  diskSerial: ' S4EVNX0N 123456 ',
  cpuModel: 'Intel(R) Core(TM) i5-1235U',
};
/** a different computer of the same model: c1 and c2 differ, c3 equal */
export const MACHINE_B: RawComponents = {
  machineGuid: '0A0B0C0D-2222-4E4E-8F8F-FEDCBA987654',
  diskSerial: 'WD-WX12A3456789',
  cpuModel: 'Intel(R) Core(TM) i5-1235U',
};

export const fpA: LocalFingerprint = computeFingerprint(MACHINE_A);
export const fpB: LocalFingerprint = computeFingerprint(MACHINE_B);

export const BUILD_DATE = '2026-11-15';

export function payloadFor(fp: LocalFingerprint, over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    lid: '01JB5X7K2QG6V9ZT3M4N8P0R1S',
    name: 'Test Buyer',
    eh: createHash('sha256').update('buyer@example.com').digest().subarray(0, 16).toString('base64url'),
    tier: 'standard',
    fp: fp.fpHex,
    fpc: [...fp.fpc],
    iat: '2026-11-01T08:00:00Z',
    upd: '2027-11-01',
    feat: [],
    rev: 0,
    ...over,
  };
}

/** Sign raw payload bytes exactly as the CLI does. */
export function signBytes(payloadBytes: Uint8Array, key: DevKey): string {
  return encodeToken(key.kid, payloadBytes, ed25519Sign(signingMessage(TOKEN_SIGNING_PREFIX, key.kid, payloadBytes), key.seed));
}

export function signPayload(payload: LicensePayload | Record<string, unknown>, key: DevKey): string {
  return signBytes(new TextEncoder().encode(canonicalJson(payload as Parameters<typeof canonicalJson>[0])), key);
}

export function memoryLastSeen(initial: Date | null = null): LastSeenStore & { value: Date | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (d: Date) => {
      store.value = d;
    },
  };
  return store;
}

export function ctxFor(key: DevKey | readonly DevKey[], over: Partial<VerifyContext> = {}): VerifyContext {
  const keys = (Array.isArray(key) ? key : [key]) as readonly DevKey[];
  return {
    keys: keys.map((k) => k.entry),
    fingerprint: fpA,
    buildDate: BUILD_DATE,
    revocations: null,
    now: () => new Date('2026-11-20T10:00:00Z'),
    lastSeen: memoryLastSeen(),
    ...over,
  };
}

export function signedRevocationList(
  entries: readonly { lid: string; epoch: number; reason: string }[],
  key: DevKey,
  generatedAt = '2026-12-15T10:00:00Z',
): { bytes: Uint8Array; sig: string; trusted: TrustedRevocationList } {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, generatedAt, entries }, null, 2));
  const sig = signRevocationBytes(bytes, key);
  const r = verifyRevocationList(bytes, sig, [key.entry]);
  if (!r.ok) throw new Error(`test list did not verify: ${r.reason}`);
  return { bytes, sig, trusted: r.trusted };
}

export function signRevocationBytes(bytes: Uint8Array, key: DevKey): string {
  return `${REVOCATION_SIGNING_PREFIX}-${key.kid}-${base32Encode(ed25519Sign(signingMessage(REVOCATION_SIGNING_PREFIX, key.kid, bytes), key.seed))}`;
}
