import { describe, expect, it } from 'vitest';
import { evaluateKeyring, isValidDbKeyHex, quarantineTargets, unwrapDbKey } from '../src/lib/keyring.js';

describe('keyring gate (SEC-040)', () => {
  it('refuses when safeStorage is unavailable (EM-6001)', () => {
    const g = evaluateKeyring({ available: false, backend: null, platform: 'win32' });
    expect(g.ok).toBe(false);
    expect(g.ok === false && g.code).toBe('EM-6001');
  });

  it('allows DPAPI on Windows', () => {
    expect(evaluateKeyring({ available: true, backend: null, platform: 'win32' }).ok).toBe(true);
  });

  it('refuses basic_text on Linux unless explicitly accepted', () => {
    expect(evaluateKeyring({ available: true, backend: 'basic_text', platform: 'linux' }).ok).toBe(false);
    expect(evaluateKeyring({ available: true, backend: 'basic_text', platform: 'linux', acceptInsecureBackend: true }).ok).toBe(true);
  });

  it('allows a real secret backend on Linux', () => {
    expect(evaluateKeyring({ available: true, backend: 'gnome_libsecret', platform: 'linux' }).ok).toBe(true);
  });

  it('validates the Database Key hex', () => {
    expect(isValidDbKeyHex('a'.repeat(64))).toBe(true);
    expect(isValidDbKeyHex('A'.repeat(64))).toBe(false);
    expect(isValidDbKeyHex('a'.repeat(63))).toBe(false);
  });
});

describe('keyring unwrap (FR-176, SEC-040)', () => {
  it('maps a throwing decryptString (other Windows account) to EM-6001 instead of crashing', () => {
    const r = unwrapDbKey(new Uint8Array([1, 2]), () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); });
    expect(r).toEqual({ ok: false, code: 'EM-6001', reason: 'decrypt-failed' });
  });
  it('rejects a malformed key and accepts a valid one', () => {
    expect(unwrapDbKey(new Uint8Array(), () => 'nothex')).toMatchObject({ ok: false, code: 'EM-6001', reason: 'invalid-key' });
    expect(unwrapDbKey(new Uint8Array(), () => 'b'.repeat(64))).toEqual({ ok: true, keyHex: 'b'.repeat(64) });
  });
  it('moves the locked files aside instead of deleting them', () => {
    const t = quarantineTargets({ keyring: '/d/keyring.bin', db: '/d/expertmotion.db' }, '20261024-120000');
    expect(t.map((x) => x.to)).toEqual(['/d/keyring.bin.unreadable-20261024-120000', '/d/expertmotion.db.unreadable-20261024-120000',
      '/d/expertmotion.db-wal.unreadable-20261024-120000', '/d/expertmotion.db-shm.unreadable-20261024-120000']);
  });
});
