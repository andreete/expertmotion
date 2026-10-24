/**
 * Database Key keyring policy (SECURITY.md SEC-040). The key itself is 32 random bytes generated
 * on first run, wrapped with Electron `safeStorage.encryptString` (DPAPI on Windows) into
 * `data/keyring.bin`, and unwrapped on start. The Shell refuses to run when encryption is not
 * available, and on Linux refuses the `basic_text` backend unless the Creator accepts the downgrade.
 * These are pure decision helpers; the actual safeStorage calls live in main.ts.
 */
import { EM } from './constants.js';

export type StorageBackend = 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown';

export interface SafeStorageFacts {
  available: boolean;
  /** Only meaningful on Linux; Windows always uses DPAPI (null there). */
  backend: StorageBackend | null;
  platform: NodeJS.Platform;
  /** Creator explicitly accepted an insecure backend (never true by default). */
  acceptInsecureBackend?: boolean;
}

export type KeyringGate = { ok: true } | { ok: false; code: string; reason: string };

/** Decides whether the keyring may be used (SEC-040). Fatal EM-6001 otherwise. */
export function evaluateKeyring(facts: SafeStorageFacts): KeyringGate {
  if (!facts.available) {
    return { ok: false, code: EM.storageUnavailable, reason: 'safeStorage.isEncryptionAvailable() is false' };
  }
  if (facts.platform === 'linux' && facts.backend === 'basic_text' && facts.acceptInsecureBackend !== true) {
    return { ok: false, code: EM.storageUnavailable, reason: 'safeStorage backend is basic_text (unencrypted); refusing without explicit acceptance' };
  }
  return { ok: true };
}

const HEX32 = /^[0-9a-f]{64}$/;

/** Validates an unwrapped Database Key hex string before it is sent in the bootstrap (SEC-002). */
export function isValidDbKeyHex(hex: string): boolean {
  return HEX32.test(hex);
}
