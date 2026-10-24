// Passphrase-encrypted backup container (SECURITY SEC-052): AES-256-GCM over the whole backup zip, streamed.
// KDF deviation: SEC-052 names Argon2id via the `argon2` npm package, which is not a dependency and Node 22 has no built-in
// Argon2; this uses Node's scrypt with a comparable memory cost (N=2^16, r=8, p=1 → 64 MiB). The header records the KDF and its
// parameters so a later version can add Argon2id and still open these files.
// Layout: "EMBK" | u8 version=1 | u32le headerLen | header JSON (also the GCM AAD) | ciphertext | 16-byte tag.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

export const BOX_MAGIC = Buffer.from('EMBK', 'latin1');
const CHUNK = 1 << 20;
export interface BoxHeader { kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; cipher: 'aes-256-gcm' }
export class BoxError extends Error { constructor(readonly reason: 'not-a-box' | 'bad-header' | 'wrong-passphrase', message: string) { super(message); this.name = 'BoxError'; } }

const DEFAULT_KDF = { N: 1 << 16, r: 8, p: 1 };
function derive(passphrase: string, h: Pick<BoxHeader, 'N' | 'r' | 'p' | 'salt'>): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(passphrase.normalize('NFC'), Buffer.from(h.salt, 'base64'), 32, { N: h.N, r: h.r, p: h.p, maxmem: 256 * h.N * h.r + (1 << 20) },
    (err, key) => (err ? reject(err) : resolve(key))));
}

export async function isBox(file: string): Promise<boolean> {
  const fh = await fsp.open(file, 'r');
  try { const b = Buffer.alloc(4); const { bytesRead } = await fh.read(b, 0, 4, 0); return bytesRead === 4 && b.equals(BOX_MAGIC); } finally { await fh.close(); }
}

export async function encryptFile(src: string, dest: string, passphrase: string, kdf: { N: number; r: number; p: number } = DEFAULT_KDF): Promise<void> {
  const header: BoxHeader = { kdf: 'scrypt', ...kdf, salt: crypto.randomBytes(16).toString('base64'), iv: crypto.randomBytes(12).toString('base64'), cipher: 'aes-256-gcm' };
  const key = await derive(passphrase, header);
  const hjson = Buffer.from(JSON.stringify(header), 'utf8');
  const c = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  c.setAAD(hjson);
  const rh = await fsp.open(src, 'r'); const wh = await fsp.open(dest, 'wx', 0o600);
  try {
    let pos = 0;
    const put = async (b: Buffer) => { let o = 0; while (o < b.length) { const { bytesWritten } = await wh.write(b, o, b.length - o, pos); o += bytesWritten; pos += bytesWritten; } };
    const pre = Buffer.alloc(9); BOX_MAGIC.copy(pre, 0); pre.writeUInt8(1, 4); pre.writeUInt32LE(hjson.length, 5);
    await put(Buffer.concat([pre, hjson]));
    const buf = Buffer.allocUnsafe(CHUNK); let off = 0;
    for (;;) { const { bytesRead } = await rh.read(buf, 0, CHUNK, off); if (!bytesRead) break; off += bytesRead; await put(c.update(buf.subarray(0, bytesRead))); }
    await put(c.final()); await put(c.getAuthTag());
    await wh.sync();
  } finally { await rh.close(); await wh.close(); key.fill(0); }
}

/** Decrypts to `dest`; throws BoxError('wrong-passphrase') when the tag does not verify (dest is removed). */
export async function decryptFile(src: string, dest: string, passphrase: string): Promise<void> {
  const rh = await fsp.open(src, 'r');
  let wh: fsp.FileHandle | undefined;
  try {
    const size = (await rh.stat()).size;
    const pre = Buffer.alloc(9); await rh.read(pre, 0, 9, 0);
    if (!pre.subarray(0, 4).equals(BOX_MAGIC)) throw new BoxError('not-a-box', 'not an encrypted backup');
    const hlen = pre.readUInt32LE(5);
    if (pre.readUInt8(4) !== 1 || hlen > 4096 || 9 + hlen + 16 > size) throw new BoxError('bad-header', 'unsupported backup encryption header');
    const hjson = Buffer.alloc(hlen); await rh.read(hjson, 0, hlen, 9);
    let h: BoxHeader;
    try { h = JSON.parse(hjson.toString('utf8')) as BoxHeader; } catch { throw new BoxError('bad-header', 'unreadable backup encryption header'); }
    if (h.kdf !== 'scrypt' || h.cipher !== 'aes-256-gcm' || ![1 << 14, 1 << 15, 1 << 16, 1 << 17].includes(h.N) || h.r < 1 || h.r > 16 || h.p < 1 || h.p > 4) throw new BoxError('bad-header', 'unsupported backup encryption parameters');
    const key = await derive(passphrase, h);
    const tag = Buffer.alloc(16); await rh.read(tag, 0, 16, size - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(h.iv, 'base64'));
    d.setAAD(hjson); d.setAuthTag(tag);
    wh = await fsp.open(dest, 'wx', 0o600);
    let pos = 0; const end = size - 16; let off = 9 + hlen;
    const put = async (b: Buffer) => { let o = 0; while (o < b.length) { const { bytesWritten } = await wh!.write(b, o, b.length - o, pos); o += bytesWritten; pos += bytesWritten; } };
    const buf = Buffer.allocUnsafe(CHUNK);
    while (off < end) { const { bytesRead } = await rh.read(buf, 0, Math.min(CHUNK, end - off), off); if (!bytesRead) break; off += bytesRead; await put(d.update(buf.subarray(0, bytesRead))); }
    try { await put(d.final()); } catch { throw new BoxError('wrong-passphrase', 'passphrase does not open this backup'); } finally { key.fill(0); }
  } catch (e) {
    if (wh) { await wh.close().catch(() => {}); wh = undefined; await fsp.rm(dest, { force: true }); }
    throw e;
  } finally { await rh.close(); if (wh) await wh.close(); }
}
