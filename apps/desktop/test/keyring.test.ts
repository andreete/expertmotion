import { describe, expect, it } from 'vitest';
import { STORAGE_LOCKED_DIALOG, evaluateKeyring, isValidDbKeyHex, keyringRefusalMessage, quarantineTargets, storageLockedDialog, unwrapDbKey } from '../src/lib/keyring.js';

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
    for (const b of ['kwallet', 'kwallet5', 'kwallet6'] as const) expect(evaluateKeyring({ available: true, backend: b, platform: 'linux' }).ok).toBe(true);
  });

  it('basic_text on Linux: EM-6001 with a Creator-facing fix (install gnome-keyring), in English and Indonesian', () => {
    const facts = { available: true, backend: 'basic_text' as const, platform: 'linux' as const };
    const g = evaluateKeyring(facts);
    if (g.ok) throw new Error('expected refusal');
    expect(g.code).toBe('EM-6001');
    const msg = keyringRefusalMessage(g, facts);
    expect(msg).toContain('sudo apt install gnome-keyring');
    expect(msg).toContain('basic_text');
    expect(msg).toContain('Expertmotion melindungi penyimpanan proyek');
    expect(msg).not.toContain('Windows');
  });

  it('the locked-storage dialog names the platform\'s own account store', () => {
    expect(storageLockedDialog('win32')).toBe(STORAGE_LOCKED_DIALOG);
    expect(storageLockedDialog('linux').detail).toContain('GNOME Keyring or KWallet');
    expect(storageLockedDialog('darwin').detail).toContain('macOS Keychain');
    for (const p of ['linux', 'darwin'] as const) { expect(storageLockedDialog(p).detail).not.toContain('Windows'); expect(storageLockedDialog(p).buttons).toEqual(STORAGE_LOCKED_DIALOG.buttons); }
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
