import { describe, expect, it } from 'vitest';
import { isRevoked, newestTrustedList, parseRevocationSignature, selectNewerList, verifyRevocationList } from '../../src/license/index.js';
import { makeDevKey, signedRevocationList, signRevocationBytes } from './helpers.js';

const key = makeDevKey('T1');
const LID = '01JB5X7K2QG6V9ZT3M4N8P0R1S';
const LID2 = '01JB7A1C9DE2F3G4H5J6K7M8N9';

describe('revoked.json (§8.2)', () => {
  it('verifies, and applies the epoch rule entry.epoch > payload.rev', () => {
    const { trusted } = signedRevocationList([{ lid: LID, epoch: 1, reason: 'rebind' }, { lid: LID, epoch: 3, reason: 'renewal' }, { lid: LID2, epoch: 1, reason: 'refund' }], key);
    expect(isRevoked(trusted, LID, 0)).toBe(true);
    expect(isRevoked(trusted, LID, 2)).toBe(true);
    expect(isRevoked(trusted, LID, 3)).toBe(false); // the replacement key with rev = epoch stays valid
    expect(isRevoked(trusted, LID2, 0)).toBe(true);
    expect(isRevoked(trusted, '01JB5X7K2QG6V9ZT3M4N8P0R1T', 0)).toBe(false);
    expect(isRevoked(null, LID, 0)).toBe(false);
  });

  it('rejects a tampered list, a wrong prefix, an unknown or revoked kid', () => {
    const { bytes, sig } = signedRevocationList([{ lid: LID, epoch: 1, reason: 'rebind' }], key);
    const tampered = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('"epoch": 1', '"epoch": 0'));
    expect(verifyRevocationList(tampered, sig, [key.entry])).toEqual({ ok: false, reason: 'signature' });
    expect(verifyRevocationList(bytes, sig.replace('EMREV1', 'EM1'), [key.entry])).toEqual({ ok: false, reason: 'format' });
    expect(verifyRevocationList(bytes, sig, [makeDevKey('Q7').entry])).toEqual({ ok: false, reason: 'unknown-kid' });
    expect(verifyRevocationList(bytes, sig, [{ ...key.entry, status: 'revoked' }])).toEqual({ ok: false, reason: 'revoked-kid' });
    expect(verifyRevocationList(bytes, sig, [makeDevKey('T1').entry])).toEqual({ ok: false, reason: 'signature' });
  });

  it('a Licence Key signature cannot be reused as a revocation signature (different prefix)', () => {
    expect(parseRevocationSignature('EMREV1-T1-AAAA')).toBeNull();
  });

  it('rejects a validly signed list with an invalid schema or non-JSON bytes', () => {
    for (const text of ['{"v":1,"generatedAt":"2026-12-15T10:00:00Z","entries":[{"lid":"bad","epoch":1,"reason":"x"}]}', '{"v":2,"generatedAt":"2026-12-15T10:00:00Z","entries":[]}', 'not json']) {
      const bytes = new TextEncoder().encode(text);
      expect(verifyRevocationList(bytes, signRevocationBytes(bytes, key), [key.entry])).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('monotonicity: an older signed list cannot replace a newer one (replay to un-revoke)', () => {
    const newer = signedRevocationList([{ lid: LID, epoch: 1, reason: 'rebind' }], key, '2026-12-15T10:00:00Z');
    const older = signedRevocationList([], key, '2026-12-01T10:00:00Z');
    expect(selectNewerList(newer.trusted, older.trusted)).toBe(newer.trusted);
    expect(selectNewerList(older.trusted, newer.trusted)).toBe(newer.trusted);
    expect(selectNewerList(null, older.trusted)).toBe(older.trusted);
    const best = newestTrustedList(
      [{ bytes: older.bytes, signatureText: older.sig }, { bytes: newer.bytes, signatureText: newer.sig }, { bytes: newer.bytes, signatureText: 'garbage' }],
      [key.entry],
    );
    expect(best?.list.generatedAt).toBe('2026-12-15T10:00:00Z');
    expect(isRevoked(best, LID, 0)).toBe(true);
  });
});
