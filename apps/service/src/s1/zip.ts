// Minimal store-only ZIP (PKWARE APPNOTE 6.3) writer and reader for project backups (DATABASE_SCHEMA §6). No compression:
// media is already compressed and JSON is small. ZIP64 records are written when a size or offset reaches 4 GiB.
// CRC-32 via zlib.crc32 (Node 22). The reader is defensive: it trusts only the central directory, rejects unsafe names,
// encryption, compression, duplicates and out-of-range ranges, caps counts and sizes, and verifies CRC while extracting.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_LOC64 = 0x07064b50;
const U32 = 0xffffffff, U16 = 0xffff;
const CHUNK = 1 << 20;
const FLAG_UTF8 = 1 << 11;

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

interface Written { name: Buffer; crc: number; size: number; offset: number; time: number; date: number; zip64: boolean }

/** Streams entries into a file. Usage: `const w = await ZipWriter.create(p); await w.addBuffer(...); await w.addFile(...); await w.close();` */
export class ZipWriter {
  private pos = 0; private readonly entries: Written[] = []; private readonly names = new Set<string>(); private closed = false;
  private constructor(private readonly fh: fsp.FileHandle) {}
  static async create(file: string): Promise<ZipWriter> { return new ZipWriter(await fsp.open(file, 'wx', 0o600)); }

  async addBuffer(name: string, data: Uint8Array, mtime = new Date()): Promise<void> {
    await this.add(name, data.length, mtime, async (write) => { await write(data); });
  }
  /** Copies a file; `onChunk` sees every chunk (hashing, progress). The size is taken at start and must not change while copying. */
  async addFile(name: string, src: string, onChunk?: (b: Uint8Array) => void): Promise<void> {
    const st = await fsp.stat(src);
    const rh = await fsp.open(src, 'r');
    try {
      await this.add(name, st.size, st.mtime, async (write) => {
        const buf = Buffer.allocUnsafe(CHUNK); let done = 0;
        while (done < st.size) {
          const { bytesRead } = await rh.read(buf, 0, Math.min(CHUNK, st.size - done), done);
          if (bytesRead === 0) throw new Error(`file shrank while copying: ${name}`);
          const chunk = buf.subarray(0, bytesRead); onChunk?.(chunk); await write(chunk); done += bytesRead;
        }
      });
    } finally { await rh.close(); }
  }

  private async add(name: string, size: number, mtime: Date, body: (write: (b: Uint8Array) => Promise<void>) => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('zip closed');
    assertSafeName(name);
    if (this.names.has(name)) throw new Error(`duplicate zip entry ${name}`);
    this.names.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(mtime);
    const zip64 = size >= U32 || this.pos >= U32;
    const offset = this.pos;
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); extra.writeBigUInt64LE(BigInt(size), 4); extra.writeBigUInt64LE(BigInt(size), 12); }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG_LOCAL, 0); h.writeUInt16LE(zip64 ? 45 : 20, 4); h.writeUInt16LE(FLAG_UTF8, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(0, 14);                // CRC patched after the data
    h.writeUInt32LE(zip64 ? U32 : size, 18); h.writeUInt32LE(zip64 ? U32 : size, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([h, nameBuf, extra]));
    let crc = 0, written = 0;
    await body(async (b) => { crc = zlib.crc32(b, crc); written += b.length; await this.write(b); });
    if (written !== size) throw new Error(`size changed while writing ${name}`);
    const c = Buffer.alloc(4); c.writeUInt32LE(crc >>> 0, 0);
    await this.fh.write(c, 0, 4, offset + 14);
    this.entries.push({ name: nameBuf, crc: crc >>> 0, size, offset, time, date, zip64 });
  }

  private async write(b: Uint8Array): Promise<void> {
    let off = 0;
    while (off < b.length) { const { bytesWritten } = await this.fh.write(b, off, b.length - off, this.pos); off += bytesWritten; this.pos += bytesWritten; }
  }

  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try {
      const cdStart = this.pos; const parts: Buffer[] = [];
      for (const e of this.entries) {
        const needSize = e.size >= U32, needOff = e.offset >= U32;
        const x: Buffer[] = [];
        if (needSize) { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(e.size), 0); b.writeBigUInt64LE(BigInt(e.size), 8); x.push(b); }
        if (needOff) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(e.offset), 0); x.push(b); }
        const xBody = Buffer.concat(x);
        const extra = xBody.length ? Buffer.concat([Buffer.from([0x01, 0x00, xBody.length & 0xff, xBody.length >> 8]), xBody]) : Buffer.alloc(0);
        const h = Buffer.alloc(46);
        h.writeUInt32LE(SIG_CENTRAL, 0); h.writeUInt16LE(45, 4); h.writeUInt16LE(e.zip64 || needOff ? 45 : 20, 6); h.writeUInt16LE(FLAG_UTF8, 8); h.writeUInt16LE(0, 10);
        h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14); h.writeUInt32LE(e.crc, 16);
        h.writeUInt32LE(needSize ? U32 : e.size, 20); h.writeUInt32LE(needSize ? U32 : e.size, 24);
        h.writeUInt16LE(e.name.length, 28); h.writeUInt16LE(extra.length, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36);
        h.writeUInt32LE(0, 38); h.writeUInt32LE(needOff ? U32 : e.offset, 42);
        parts.push(h, e.name, extra);
      }
      await this.write(Buffer.concat(parts));
      const cdSize = this.pos - cdStart, n = this.entries.length;
      const need64 = n >= U16 || cdStart >= U32 || cdSize >= U32;
      if (need64) {
        const eocd64At = this.pos;
        const r = Buffer.alloc(56);
        r.writeUInt32LE(SIG_EOCD64, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14); r.writeUInt32LE(0, 16); r.writeUInt32LE(0, 20);
        r.writeBigUInt64LE(BigInt(n), 24); r.writeBigUInt64LE(BigInt(n), 32); r.writeBigUInt64LE(BigInt(cdSize), 40); r.writeBigUInt64LE(BigInt(cdStart), 48);
        const l = Buffer.alloc(20); l.writeUInt32LE(SIG_LOC64, 0); l.writeUInt32LE(0, 4); l.writeBigUInt64LE(BigInt(eocd64At), 8); l.writeUInt32LE(1, 16);
        await this.write(Buffer.concat([r, l]));
      }
      const e = Buffer.alloc(22);
      e.writeUInt32LE(SIG_EOCD, 0); e.writeUInt16LE(0, 4); e.writeUInt16LE(0, 6);
      e.writeUInt16LE(need64 ? U16 : n, 8); e.writeUInt16LE(need64 ? U16 : n, 10);
      e.writeUInt32LE(need64 ? U32 : cdSize, 12); e.writeUInt32LE(need64 ? U32 : cdStart, 16); e.writeUInt16LE(0, 20);
      await this.write(e);
      await this.fh.sync();
    } finally { await this.fh.close(); }
  }
  /** Close without finishing (on error); the caller deletes the file. */
  async abort(): Promise<void> { if (!this.closed) { this.closed = true; await this.fh.close().catch(() => {}); } }
}

// ───────────────────────────── reader ─────────────────────────────
export class ZipError extends Error { constructor(message: string) { super(message); this.name = 'ZipError'; } }

export interface ZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number; maxCentralDirBytes: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 20_000, maxEntryBytes: 5 * 1024 ** 3, maxTotalBytes: 128 * 1024 ** 3, maxCentralDirBytes: 32 * 1024 ** 2 };

export interface ZipEntry { name: string; size: number; crc: number; localOffset: number }

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** Entry names are relative POSIX paths of safe segments: no absolute paths, drive letters, backslashes, `.`/`..`, NUL or controls. */
export function assertSafeName(name: string): void {
  if (!name || name.length > 512) throw new ZipError('entry name length');
  const segs = name.split('/');
  for (const s of segs) if (!SAFE_SEGMENT.test(s) || s === '.' || s === '..') throw new ZipError(`unsafe entry name: ${JSON.stringify(name.slice(0, 80))}`);
}

export class ZipReader {
  private constructor(private readonly fh: fsp.FileHandle, readonly fileSize: number, readonly entries: ZipEntry[]) {}

  static async open(file: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipReader> {
    const fh = await fsp.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      if (size < 22) throw new ZipError('not a zip file');
      const tailLen = Math.min(size, 22 + 0xffff + 20 + 56);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      let at = -1;
      for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tailLen) { at = i; break; }
      if (at < 0) throw new ZipError('end of central directory not found');
      const eocdPos = size - tailLen + at;
      if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0) throw new ZipError('multi-disk zip');
      let count: number = tail.readUInt16LE(at + 10), cdSize: number = tail.readUInt32LE(at + 12), cdOff: number = tail.readUInt32LE(at + 16);
      if (count === U16 || cdSize === U32 || cdOff === U32) {
        const locAt = at - 20;
        if (locAt < 0 || tail.readUInt32LE(locAt) !== SIG_LOC64) throw new ZipError('zip64 locator missing');
        const e64Pos = Number(tail.readBigUInt64LE(locAt + 8));
        if (e64Pos < 0 || e64Pos + 56 > eocdPos) throw new ZipError('zip64 record out of range');
        const r = Buffer.alloc(56); await fh.read(r, 0, 56, e64Pos);
        if (r.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('zip64 record missing');
        count = Number(r.readBigUInt64LE(32)); cdSize = Number(r.readBigUInt64LE(40)); cdOff = Number(r.readBigUInt64LE(48));
      }
      if (count > limits.maxEntries) throw new ZipError('too many entries');
      if (cdSize > limits.maxCentralDirBytes || cdOff + cdSize > eocdPos) throw new ZipError('central directory out of range');
      const cd = Buffer.alloc(cdSize); await fh.read(cd, 0, cdSize, cdOff);
      const entries: ZipEntry[] = []; const seen = new Set<string>(); let total = 0; let p = 0;
      for (let k = 0; k < count; k++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('bad central directory entry');
        const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
        let csize: number = cd.readUInt32LE(p + 20), usize: number = cd.readUInt32LE(p + 24);
        const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
        let off: number = cd.readUInt32LE(p + 42);
        if (p + 46 + nlen + xlen + clen > cd.length) throw new ZipError('central directory truncated');
        const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
        const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
        if (usize === U32 || csize === U32 || off === U32) {
          let q = 0, found = false;
          while (q + 4 <= extra.length) {
            const id = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2); let r = q + 4;
            if (r + len > extra.length) throw new ZipError('bad extra field');
            if (id === 0x0001) {
              found = true;
              if (usize === U32) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
              if (csize === U32) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
              if (off === U32) { off = Number(extra.readBigUInt64LE(r)); r += 8; }
              if (r > q + 4 + len) throw new ZipError('bad zip64 extra');
            }
            q += 4 + len;
          }
          if (!found) throw new ZipError('zip64 extra missing');
        }
        if (flags & 0x0001) throw new ZipError('encrypted entries are not supported');
        if (method !== 0 || csize !== usize) throw new ZipError('compressed entries are not supported');
        assertSafeName(name);
        if (seen.has(name)) throw new ZipError('duplicate entry');
        seen.add(name);
        if (usize > limits.maxEntryBytes) throw new ZipError('entry too large');
        total += usize; if (total > limits.maxTotalBytes) throw new ZipError('archive too large');
        if (off + 30 + nlen + usize > cdOff) throw new ZipError('entry data out of range');
        entries.push({ name, size: usize, crc, localOffset: off });
        p += 46 + nlen + xlen + clen;
      }
      return new ZipReader(fh, size, entries);
    } catch (e) { await fh.close(); throw e; }
  }

  get(name: string): ZipEntry | undefined { return this.entries.find((e) => e.name === name); }

  private async dataStart(e: ZipEntry): Promise<number> {
    const h = Buffer.alloc(30); await this.fh.read(h, 0, 30, e.localOffset);
    if (h.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('bad local header');
    const nlen = h.readUInt16LE(26), xlen = h.readUInt16LE(28);
    const nm = Buffer.alloc(nlen); await this.fh.read(nm, 0, nlen, e.localOffset + 30);
    if (nm.toString('utf8') !== e.name) throw new ZipError('local header name mismatch');
    const start = e.localOffset + 30 + nlen + xlen;
    if (start + e.size > this.fileSize) throw new ZipError('entry data out of range');
    return start;
  }

  /** Streams the entry's bytes to `onChunk`, verifying the CRC at the end. */
  async read(e: ZipEntry, onChunk: (b: Buffer) => void | Promise<void>): Promise<void> {
    const start = await this.dataStart(e);
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, e.size)));
    let done = 0, crc = 0;
    while (done < e.size) {
      const { bytesRead } = await this.fh.read(buf, 0, Math.min(buf.length, e.size - done), start + done);
      if (bytesRead === 0) throw new ZipError('truncated entry');
      const chunk = buf.subarray(0, bytesRead); crc = zlib.crc32(chunk, crc); await onChunk(chunk); done += bytesRead;
    }
    if ((crc >>> 0) !== e.crc) throw new ZipError(`CRC mismatch in ${e.name}`);
  }

  async readBuffer(e: ZipEntry, max: number): Promise<Buffer> {
    if (e.size > max) throw new ZipError(`${e.name} is too large`);
    const parts: Buffer[] = []; await this.read(e, (b) => { parts.push(Buffer.from(b)); });
    return Buffer.concat(parts);
  }

  /** Extracts to `dest` (created exclusively; the caller chooses a safe path). */
  async extractTo(e: ZipEntry, dest: string, onChunk?: (b: Buffer) => void): Promise<void> {
    const out = await fsp.open(dest, 'wx', 0o600);
    try { await this.read(e, async (b) => { onChunk?.(b); let o = 0; while (o < b.length) o += (await out.write(b, o, b.length - o)).bytesWritten; }); } finally { await out.close(); }
  }

  async close(): Promise<void> { await this.fh.close(); }
}

export const isZipFile = (file: string): boolean => {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(4); return fs.readSync(fd, b, 0, 4, 0) === 4 && b.readUInt32LE(0) === SIG_LOCAL; } finally { fs.closeSync(fd); }
};
