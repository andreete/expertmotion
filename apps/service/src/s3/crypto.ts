// Field-level secret encryption (SEC-041, TR-031, DATABASE_SCHEMA §1): AES-256-GCM under a key derived with HKDF-SHA256
// from the Database Key, label `provider-secrets`. Separate from the SQLCipher-style DB encryption, so a leaked page cache,
// a backup or a log dump never contains a usable provider key or licence token. AAD binds a ciphertext to its row.
import crypto from 'node:crypto';
import { EmError } from '@expertmotion/shared';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function deriveSecretKey(dbKeyHex: string, label = 'provider-secrets'): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(dbKeyHex)) throw new EmError('EM-4402', 'The key could not be stored securely.');
  const ikm = Buffer.from(dbKeyHex, 'hex');
  try { return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from('expertmotion.secrets.v1'), Buffer.from(label), 32)); } finally { ikm.fill(0); }
}

export interface SecretBox { seal(plain: string, aad: string): Buffer; open(blob: Buffer | Uint8Array, aad: string): string }

export function createSecretBox(dbKeyHex: string, label = 'provider-secrets'): SecretBox {
  const key = deriveSecretKey(dbKeyHex, label);
  return {
    seal(plain, aad) {
      try {
        const iv = crypto.randomBytes(IV_BYTES);
        const c = crypto.createCipheriv('aes-256-gcm', key, iv);
        c.setAAD(Buffer.from(aad));
        const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
        return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
      } catch (e) { throw new EmError('EM-4402', 'The key could not be stored securely.', { cause: e }); }
    },
    open(blob, aad) {
      const b = Buffer.from(blob);
      if (b.length < 1 + IV_BYTES + TAG_BYTES || b[0] !== VERSION) throw new EmError('EM-4402', 'A stored key could not be read. Enter it again.');
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(1, 1 + IV_BYTES));
        d.setAAD(Buffer.from(aad));
        d.setAuthTag(b.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
        return Buffer.concat([d.update(b.subarray(1 + IV_BYTES + TAG_BYTES)), d.final()]).toString('utf8');
      } catch (e) { throw new EmError('EM-4402', 'A stored key could not be read. Enter it again.', { cause: e }); }
    },
  };
}

/** Masked display form: last 4 characters only (SEC-042). */
export const secretHint = (secret: string): string => `…${secret.trim().slice(-4)}`;
