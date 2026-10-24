import { describe, expect, it } from 'vitest';
import { evaluateKeyring, isValidDbKeyHex } from '../src/lib/keyring.js';

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
