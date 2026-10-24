// Encrypted prompt set (SEC-133). Release builds (scripts/build.mjs --encrypt-prompts) strip the prompts
// from service.cjs and write dist/assets.enc = iv(12) | tag(16) | AES-256-GCM(JSON prompt set).
// The key is split: half A is a build constant inside this bundle, half B is a build constant inside the
// Desktop Shell and arrives in the bootstrap message. key = sha256(A xor B) (desktop lib/keysplit.ts).
// This raises the cost of lifting the prompts from the install; it does not stop the device owner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPromptSet, PROMPT_SET_KEYS, type PromptSet } from '@expertmotion/agents';

declare const __EM_PROMPT_HALF_A__: string | undefined;
/** Half A, injected by the release build; empty in development and tests (prompts stay in the bundle). */
export const PROMPT_HALF_A = typeof __EM_PROMPT_HALF_A__ === 'string' ? __EM_PROMPT_HALF_A__ : '';

const HEX32 = /^[0-9a-f]{64}$/;

export function promptKey(halfA: string, halfB: string): Buffer {
  if (!HEX32.test(halfA) || !HEX32.test(halfB)) throw new Error('prompt key halves must be 64 lowercase hex chars');
  const a = Buffer.from(halfA, 'hex'); const b = Buffer.from(halfB, 'hex');
  const mixed = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) mixed[i] = a[i]! ^ b[i]!;
  return crypto.createHash('sha256').update(mixed).digest();
}

export function encryptPromptSet(set: PromptSet, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(set), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function decryptPromptSet(blob: Buffer, key: Buffer): PromptSet {
  if (blob.length < 29) throw new Error('prompt assets truncated');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  const set = JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8')) as Record<string, unknown>;
  for (const k of PROMPT_SET_KEYS) if (typeof set[k] !== 'string') throw new Error(`prompt assets: ${k} missing`);
  return set as unknown as PromptSet;
}

/**
 * Release builds: decrypts assets.enc next to the bundle and installs the prompt set. Throws an error
 * with code EM-8007 when the file or half B is missing or the data was altered. No-op in development.
 */
export function loadPromptAssets(halfB: string | undefined, file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets.enc'), halfA = PROMPT_HALF_A): boolean {
  if (halfA === '') return false;
  try {
    if (!halfB) throw new Error('prompt key half missing from bootstrap');
    installPromptSet(decryptPromptSet(fs.readFileSync(file), promptKey(halfA, halfB)));
    return true;
  } catch (e) {
    throw Object.assign(new Error(`prompt assets unavailable: ${(e as Error).message}`), { code: 'EM-8007' });
  }
}
