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

/** Result of unwrapping `keyring.bin` (SEC-040, FR-176). A failure never throws out of the Shell's boot. */
export type UnwrapResult = { ok: true; keyHex: string } | { ok: false; code: 'EM-6001'; reason: 'decrypt-failed' | 'invalid-key' };

/**
 * Unwraps the Database Key. `safeStorage.decryptString` throws when the wrapped key belongs to another Windows account or the
 * DPAPI master key changed (FR-176 "different Windows user account"); that and a malformed key both map to EM-6001, whose
 * documented recovery is Restore backup (ERROR_CATALOGUE.md), never a silent new key.
 */
export function unwrapDbKey(wrapped: Uint8Array, decrypt: (b: Uint8Array) => string): UnwrapResult {
  let hex: string;
  try { hex = decrypt(wrapped); } catch { return { ok: false, code: 'EM-6001', reason: 'decrypt-failed' }; }
  return isValidDbKeyHex(hex) ? { ok: true, keyHex: hex } : { ok: false, code: 'EM-6001', reason: 'invalid-key' };
}

/**
 * Restore-backup path for EM-6001: the unreadable database and keyring are moved aside (never deleted — the Creator may still
 * open them with the original Windows account) and a fresh, empty storage is created so a backup zip can be restored into it.
 */
export function quarantineTargets(files: { keyring: string; db: string }, ts: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const f of [files.keyring, files.db, `${files.db}-wal`, `${files.db}-shm`]) out.push({ from: f, to: `${f}.unreadable-${ts}` });
  return out;
}

/** Native EM-6001 dialog (shown while the Editor shows the same code in `sys.fatal`). Button order = index. */
export const STORAGE_LOCKED_DIALOG = {
  title: 'Expertmotion',
  message: 'EM-6001 Project storage cannot be opened',
  detail: 'Expertmotion cannot unlock its project storage with this Windows account. Sign in with the account that installed it, or restore a backup. '
    + 'Restore backup keeps the locked files (renamed) and starts with empty storage so you can restore a backup zip.',
  buttons: ['Restore backup…', 'Quit'] as const,
  defaultId: 1,
  cancelId: 1,
} as const;
