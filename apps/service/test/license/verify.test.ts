import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Decode, base32Encode, canonicalJson, checkClock, computeFingerprint, embeddedKeyTable, PRODUCTION_PUBLIC_KEY_A1_HEX,
  verifyLicense,
} from '../../src/license/index.js';
import { BUILD_DATE, ctxFor, fpA, fpB, MACHINE_A, makeDevKey, memoryLastSeen, payloadFor, signBytes, signedRevocationList, signPayload } from './helpers.js';

const key = makeDevKey('T1');
const validKey = signPayload(payloadFor(fpA), key);

describe('LICENSE_OPERATIONS §15 L-cases (module level)', () => {
  it('L-1 valid key activates', () => {
    const r = verifyLicense(validKey, ctxFor(key));
    expect(r).toMatchObject({ status: 'licensed', tier: 'standard', updatesUntil: '2027-11-01', warnings: [] });
    expect(r.code).toBeUndefined();
    expect(r.licensee).toMatchObject({ lid: '01JB5X7K2QG6V9ZT3M4N8P0R1S', name: 'Test Buyer', kid: 'T1', rev: 0 });
  });

  it('L-2 tampered key (one character inside the payload field) → EM-5002, state invalid (product locked), key kept for copying', () => {
    const [p, k, payload, sig] = validKey.split('-') as [string, string, string, string];
    const i = Math.floor(payload.length / 2);
    const tampered = `${p}-${k}-${payload.slice(0, i)}${payload[i] === 'A' ? 'B' : 'A'}${payload.slice(i + 1)}-${sig}`;
    const r = verifyLicense(tampered, ctxFor(key));
    expect(r).toMatchObject({ status: 'invalid', code: 'EM-5002', tier: null, keyInput: tampered });
  });

  it('L-2b tampered payload semantics (upd extended, signature reused) → EM-5002', () => {
    const sig = validKey.split('-')[3];
    const forged = `EM1-T1-${base32Encode(new TextEncoder().encode(canonicalJson({ ...payloadFor(fpA), upd: '2099-01-01' })))}-${sig}`;
    expect(verifyLicense(forged, ctxFor(key)).code).toBe('EM-5002');
  });

  it('L-3 wrong machine (all three components differ) → EM-5003', () => {
    const other = computeFingerprint({ machineGuid: 'x', diskSerial: 'Y', cpuModel: 'Z' });
    const r = verifyLicense(validKey, ctxFor(key, { fingerprint: other }));
    expect(r).toMatchObject({ status: 'machine-mismatch', code: 'EM-5003' });
    expect(r.fingerprintMatch).toMatchObject({ compared: 3, matched: 0 });
  });

  it('L-4 2-of-3 tolerance: fpc[1] wrong → active; also fpc[2] wrong → EM-5003', () => {
    const wrong = 'MFRGGZDFMZTWQ'; // some other 8-byte component
    const oneWrong = { ...payloadFor(fpA), fpc: [fpA.fpc[0], wrong, fpA.fpc[2]] };
    const oneWrongKey = signPayload({ ...oneWrong, fp: fpOf(oneWrong.fpc) }, key);
    expect(verifyLicense(oneWrongKey, ctxFor(key)).status).toBe('licensed');
    const twoWrong = { ...payloadFor(fpA), fpc: [fpA.fpc[0], wrong, 'ONSWG4TFOQQGC'] };
    const twoWrongKey = signPayload({ ...twoWrong, fp: fpOf(twoWrong.fpc) }, key);
    expect(verifyLicense(twoWrongKey, ctxFor(key)).code).toBe('EM-5003');
  });

  it('L-5 revocation: list epoch 1 > rev 0 → EM-5004 (state revoked); re-bound key rev 1 → licensed', () => {
    const list = signedRevocationList([{ lid: '01JB5X7K2QG6V9ZT3M4N8P0R1S', epoch: 1, reason: 'rebind' }], key);
    const r = verifyLicense(validKey, ctxFor(key, { revocations: list.trusted }));
    expect(r).toMatchObject({ status: 'revoked', code: 'EM-5004' });
    const rebound = signPayload(payloadFor(fpA, { rev: 1 }), key);
    expect(verifyLicense(rebound, ctxFor(key, { revocations: list.trusted })).status).toBe('licensed');
  });

  it('L-6 updates expired for this build (upd < buildDate) → EM-5005, state invalid (this build is not covered)', () => {
    const k = signPayload(payloadFor(fpA, { upd: '2026-11-01' }), key);
    const r = verifyLicense(k, ctxFor(key, { buildDate: '2026-11-15' }));
    expect(r).toMatchObject({ status: 'invalid', code: 'EM-5005', updatesUntil: '2026-11-01', tier: 'standard' });
    // upd == buildDate is still covered
    expect(verifyLicense(signPayload(payloadFor(fpA, { upd: BUILD_DATE }), key), ctxFor(key)).status).toBe('licensed');
  });

  it('L-7 no key: status unlicensed (no Trial Mode; the service gate locks the product)', () => {
    for (const input of [null, undefined, '', '  \n ']) {
      const r = verifyLicense(input, ctxFor(key));
      expect(r).toMatchObject({ status: 'unlicensed', tier: null, keyInput: null });
      expect(r.code).toBeUndefined();
    }
  });

  it('L-8 clock rollback of 3 days → EM-5007 warning, licence still active, lastSeen not lowered', () => {
    const last = new Date('2026-11-20T10:00:00Z');
    const store = memoryLastSeen(last);
    const r = verifyLicense(validKey, ctxFor(key, { now: () => new Date('2026-11-17T10:00:00Z'), lastSeen: store }));
    expect(r.status).toBe('licensed');
    expect(r.clockAnomaly).toBe(true);
    expect(r.warnings).toEqual([{ code: 'EM-5007', lastSeen: last.toISOString(), now: '2026-11-17T10:00:00.000Z' }]);
    expect(store.value).toEqual(last);
    expect(r.effectiveNow).toBe(last.toISOString());
  });
});

describe('additional verification cases', () => {
  it('one Licence Key works on exactly one computer: same key on a second fingerprint → EM-5003', () => {
    expect(verifyLicense(validKey, ctxFor(key, { fingerprint: fpA })).status).toBe('licensed');
    const r = verifyLicense(validKey, ctxFor(key, { fingerprint: fpB })); // same laptop model, other machine
    expect(r).toMatchObject({ status: 'machine-mismatch', code: 'EM-5003' });
    expect(r.fingerprintMatch).toMatchObject({ compared: 3, matched: 1 });
  });

  it('old key after re-bind + revocation → EM-5004 on the old machine; new key works only on the new machine', () => {
    const lid = '01JB5X7K2QG6V9ZT3M4N8P0R1S';
    const oldKey = signPayload(payloadFor(fpA, { lid, rev: 0 }), key);
    const newKey = signPayload(payloadFor(fpB, { lid, rev: 1 }), key);
    // before revoked.json reaches the old machine: accepted leakage (ASM-021)
    expect(verifyLicense(oldKey, ctxFor(key, { fingerprint: fpA })).status).toBe('licensed');
    const list = signedRevocationList([{ lid, epoch: 1, reason: 'rebind' }], key).trusted;
    expect(verifyLicense(oldKey, ctxFor(key, { fingerprint: fpA, revocations: list })).code).toBe('EM-5004');
    expect(verifyLicense(newKey, ctxFor(key, { fingerprint: fpB, revocations: list })).status).toBe('licensed');
    expect(verifyLicense(newKey, ctxFor(key, { fingerprint: fpA, revocations: list })).code).toBe('EM-5003');
  });

  it('fingerprint drift: 1 component changed → active; 2 changed → EM-5003', () => {
    const one = computeFingerprint({ ...MACHINE_A, diskSerial: 'REPLACED-DISK' });
    expect(verifyLicense(validKey, ctxFor(key, { fingerprint: one })).status).toBe('licensed');
    const two = computeFingerprint({ ...MACHINE_A, diskSerial: 'REPLACED-DISK', machineGuid: 'reinstalled' });
    expect(verifyLicense(validKey, ctxFor(key, { fingerprint: two })).code).toBe('EM-5003');
  });

  it('unknown kid → EM-5009', () => {
    const other = makeDevKey('Q7');
    expect(verifyLicense(signPayload(payloadFor(fpA), other), ctxFor(key))).toMatchObject({ status: 'invalid', code: 'EM-5009' });
  });

  it('kid known but signed by a different private key → EM-5002', () => {
    const impostor = { ...makeDevKey('T1') };
    expect(verifyLicense(signPayload(payloadFor(fpA), impostor), ctxFor(key)).code).toBe('EM-5002');
  });

  it('revoked kid → EM-5002; retiring kid still verifies', () => {
    const revokedKey = { ...key, entry: { ...key.entry, status: 'revoked' as const } };
    expect(verifyLicense(validKey, ctxFor(revokedKey)).code).toBe('EM-5002');
    const retiring = { ...key, entry: { ...key.entry, status: 'retiring' as const } };
    expect(verifyLicense(validKey, ctxFor(retiring)).status).toBe('licensed');
  });

  it('malformed inputs → EM-5006', () => {
    const [, , payload, sig] = validKey.split('-') as [string, string, string, string];
    const cases = [
      'hello',
      'EM1-T1-ABC',
      `EM2-T1-${payload}-${sig}`,
      `EM1-T1-${payload}-${sig}-EXTRA`,
      `EM1-T1-${payload}!-${sig}`,
      `EM1-T1-${payload}-${sig.slice(0, -8)}`, // signature too short
      `EM1-T1-${'A'.repeat(7000)}-${sig}`, // payload > 4 KB
      'x'.repeat(100000),
    ];
    for (const c of cases) expect(verifyLicense(c, ctxFor(key)).code, c.slice(0, 40)).toBe('EM-5006');
  });

  it('validly signed but schema-invalid payloads → EM-5006', () => {
    const bad = [
      { ...payloadFor(fpA), v: 2 },
      { ...payloadFor(fpA), tier: 'gold' },
      { ...payloadFor(fpA), lid: 'not-a-ulid' },
      { ...payloadFor(fpA), fpc: fpA.fpc.slice(0, 2) },
      { ...payloadFor(fpA), upd: '2027-02-30' },
      { ...payloadFor(fpA), fp: '0'.repeat(64) }, // fp inconsistent with fpc
      { ...payloadFor(fpA), name: 'x'.repeat(65) },
    ];
    for (const p of bad) expect(verifyLicense(signPayload(p, key), ctxFor(key)).code).toBe('EM-5006');
    expect(verifyLicense(signBytes(new TextEncoder().encode('{not json'), key), ctxFor(key)).code).toBe('EM-5006');
  });

  it('accepts display grouping, line breaks, lower case and OCR slips', () => {
    const grouped = validKey.split('-').map((f) => f.replace(/(.{8})/g, '$1 ')).join('-\n').toLowerCase();
    expect(verifyLicense(` ${grouped} ​`, ctxFor(key)).status).toBe('licensed');
    const [p, k, payload, sig] = validKey.split('-') as [string, string, string, string];
    const slip = `${p}-${k}-${payload.replace(/O/g, '0').replace(/I/g, '1')}-${sig.replace(/B/g, '8')}`;
    expect(verifyLicense(slip, ctxFor(key)).status).toBe('licensed');
  });

  it('build date check does not use the clock: rolling the clock back cannot un-expire', () => {
    const k = signPayload(payloadFor(fpA, { upd: '2026-11-01' }), key);
    expect(verifyLicense(k, ctxFor(key, { now: () => new Date('2020-01-01T00:00:00Z') })).code).toBe('EM-5005');
  });

  it('clock: forward jumps and small rollbacks are not anomalies', () => {
    const last = new Date('2026-11-20T10:00:00Z');
    expect(checkClock(new Date('2027-01-01T00:00:00Z'), last).anomaly).toBe(false);
    expect(checkClock(new Date('2026-11-19T11:00:00Z'), last).anomaly).toBe(false);
    expect(checkClock(new Date('2026-11-19T09:00:00Z'), last).anomaly).toBe(true);
    expect(checkClock(new Date(), null).anomaly).toBe(false);
  });

  it('never throws on random input', () => {
    const chars = 'EM1-ABCZ234567=+/ \n\u0000é';
    for (let i = 0; i < 300; i++) {
      let s = '';
      for (let j = 0; j < (i % 90); j++) s += chars[(i * 31 + j * 7) % chars.length];
      expect(() => verifyLicense(s, ctxFor(key))).not.toThrow();
    }
  });

  it('production key table: placeholder is filtered out, so no key verifies until the Operator key is embedded', () => {
    expect(PRODUCTION_PUBLIC_KEY_A1_HEX).toMatch(/PLACEHOLDER/);
    expect(embeddedKeyTable()).toEqual([]);
    expect(verifyLicense(validKey, ctxFor(key, { keys: embeddedKeyTable() })).code).toBe('EM-5009');
  });
});

function fpOf(fpc: readonly string[]): string {
  const h = createHash('sha256');
  for (const s of fpc) h.update(base32Decode(s) ?? new Uint8Array());
  return h.digest('hex');
}
