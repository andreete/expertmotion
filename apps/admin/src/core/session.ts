/**
 * The unlocked signing key, held in main-process memory only. Auto-locks after `idleMs` without
 * Operator activity (default 15 minutes). Locking overwrites the seed bytes with zeros and drops the
 * reference. Limits (honest, ADR-007): JavaScript strings (the typed passphrase) cannot be wiped, and
 * intermediate buffers created during unsealing are only reclaimed by the garbage collector.
 */
import { AdminError } from './errors.js';

export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

export interface SigningKey {
  readonly kid: string;
  readonly seed: Uint8Array;
  readonly publicKeyHex: string;
}

export type LockReason = 'manual' | 'idle' | 'replaced' | 'quit';

export interface KeySessionOptions {
  idleMs?: number;
  now?: () => number;
  onLock?: (reason: LockReason) => void;
}

export interface KeySession {
  unlock(key: SigningKey, file: string): void;
  /** the key for one signing operation; throws LOCKED when locked or idle too long */
  require(): SigningKey;
  touch(): void;
  lock(reason: LockReason): void;
  /** lock if idle; call from a timer */
  checkIdle(): boolean;
  status(): { unlocked: boolean; kid: string | null; publicKeyHex: string | null; file: string | null; idleRemainingMs: number | null };
}

export function createKeySession(opts: KeySessionOptions = {}): KeySession {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const now = opts.now ?? Date.now;
  let key: SigningKey | null = null;
  let file: string | null = null;
  let last = now();

  const lock = (reason: LockReason): void => {
    if (!key) return;
    key.seed.fill(0);
    key = null;
    file = null;
    opts.onLock?.(reason);
  };
  const checkIdle = (): boolean => {
    if (key && now() - last >= idleMs) {
      lock('idle');
      return true;
    }
    return false;
  };

  return {
    unlock(k, f) {
      if (key) lock('replaced');
      key = k;
      file = f;
      last = now();
    },
    require() {
      checkIdle();
      if (!key) throw new AdminError('LOCKED', 'The signing key is locked. Open the key file with its passphrase (Keys).');
      last = now();
      return key;
    },
    touch() {
      if (!checkIdle()) last = now();
    },
    lock,
    checkIdle,
    status() {
      checkIdle();
      return key
        ? { unlocked: true, kid: key.kid, publicKeyHex: key.publicKeyHex, file, idleRemainingMs: Math.max(0, idleMs - (now() - last)) }
        : { unlocked: false, kid: null, publicKeyHex: null, file: null, idleRemainingMs: null };
    },
  };
}
