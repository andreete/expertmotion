// ULID (26 chars, Crockford base32, 48-bit ms timestamp + 80 random bits), monotonic within one millisecond.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function incrementRandom(r: Uint8Array): Uint8Array {
  const out = new Uint8Array(r);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 255) { out[i]! += 1; return out; }
    out[i] = 0;
  }
  throw new Error('ULID random overflow within one millisecond');
}

function encodeTime(ms: number): string {
  let s = '';
  for (let i = 0; i < 10; i++) { s = ALPHABET[ms % 32]! + s; ms = Math.floor(ms / 32); }
  return s;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits → 16 base32 characters
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 16; i++) { s = ALPHABET[Number(bits & 31n)]! + s; bits >>= 5n; }
  return s;
}

export function newId(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) throw new RangeError('ULID time out of range');
  if (now === lastTime) lastRandom = incrementRandom(lastRandom);
  else { lastTime = now; lastRandom = randomBytes(10); }
  return encodeTime(now) + encodeRandom(lastRandom);
}

export const isUlid = (v: unknown): v is string => typeof v === 'string' && ULID_RE.test(v);

export type IdPrefix = 'prj' | 'ast' | 'ver' | 'int' | 'pln' | 'run' | 'job' | 'out' | 'ckp';
/** Log display only, never stored (DATABASE_SCHEMA.md §2). */
export const shortId = (prefix: IdPrefix, id: string): string => `${prefix}_${id.slice(-8)}`;

/** Ported unchanged from the predecessor util.ts: safe file stem, path separators and traversal collapse into text. */
export function sanitizeFilename(input: string, fallback = 'video'): string {
  const cleaned = input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\.(mp4|mov|webm)$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** Ported from util.ts: local time YYYYMMDD-HHmmss. */
export const timestamp = (d: Date = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
