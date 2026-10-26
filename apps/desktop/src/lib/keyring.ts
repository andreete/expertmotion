/**
 * Database Key keyring policy (SECURITY.md SEC-040). The key itself is 32 random bytes generated
 * on first run, wrapped with Electron `safeStorage.encryptString` (DPAPI on Windows, Keychain on macOS, the Secret Service —
 * GNOME Keyring / KWallet — on Linux) into
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

/** Native EM-6001 dialog (shown while the Editor shows the same code in `sys.fatal`). Button order = index. Windows wording. */
export const STORAGE_LOCKED_DIALOG = {
  title: 'Expertmotion',
  message: 'EM-6001 Project storage cannot be opened',
  detail: 'Expertmotion cannot unlock its project storage with this Windows account. Sign in with the account that installed it, or restore a backup. '
    + 'Restore backup keeps the locked files (renamed) and starts with empty storage so you can restore a backup zip.',
  buttons: ['Restore backup…', 'Quit'] as const,
  defaultId: 1,
  cancelId: 1,
} as const;

/** The same dialog with the platform's account / keyring wording (DPAPI is per Windows account; Keychain and the Secret Service per user). */
export function storageLockedDialog(platform: NodeJS.Platform): typeof STORAGE_LOCKED_DIALOG | (Omit<typeof STORAGE_LOCKED_DIALOG, 'detail'> & { detail: string }) {
  if (platform === 'win32') return STORAGE_LOCKED_DIALOG;
  const store = platform === 'darwin' ? 'the macOS Keychain of this user account' : 'the system keyring (GNOME Keyring or KWallet) of this user account';
  return { ...STORAGE_LOCKED_DIALOG, detail: `Expertmotion cannot unlock its project storage with ${store}. Sign in with the account that created it, or restore a backup. `
    + 'Restore backup keeps the locked files (renamed) and starts with empty storage so you can restore a backup zip.' };
}

/**
 * Creator-facing text for a refused keyring gate (EM-6001 before any key exists). On Linux the usual cause is a session without a
 * Secret Service: Electron then falls back to `basic_text` (a fixed, publicly known key), which the gate refuses (SEC-040).
 * English first, then Indonesian (native dialogs are not localised through the Editor's i18n).
 */
export function keyringRefusalMessage(gate: Extract<KeyringGate, { ok: false }>, facts: Pick<SafeStorageFacts, 'platform' | 'backend'>): string {
  if (facts.platform === 'linux') {
    return 'Expertmotion protects your project storage with the system keyring, but no keyring service (GNOME Keyring or KWallet) is available in this desktop session'
      + `${facts.backend ? ` (backend: ${facts.backend})` : ''}. On Ubuntu install it with "sudo apt install gnome-keyring", sign out and sign in again, then start Expertmotion.\n\n`
      + 'Expertmotion melindungi penyimpanan proyek dengan keyring sistem, tetapi tidak ada layanan keyring (GNOME Keyring atau KWallet) di sesi desktop ini. '
      + 'Di Ubuntu pasang dengan "sudo apt install gnome-keyring", keluar lalu masuk lagi, kemudian buka Expertmotion.';
  }
  if (facts.platform === 'darwin') return `Project storage cannot be opened: the macOS Keychain is not available (${gate.reason}). Sign in to your user account and try again.`;
  return `Project storage cannot be opened: ${gate.reason}`;
}
