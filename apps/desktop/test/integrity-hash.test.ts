// SEC-133 startup integrity: streamed, bounded-parallel hashing gives the same digests as a whole-file sha256, keeps the
// concurrency bound, reports progress, leaves missing files out and does not hash a file whose size already differs.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashManifestFiles, mapBounded, sha256File, type HashProgress } from '../src/lib/integrity-hash.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('integrity hashing (SEC-133, FR-184)', () => {
  it('streams files larger than one chunk to the same digest as a whole-buffer hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'em-int-'));
    try {
      const big = Buffer.alloc(3 * 1024 * 1024 + 17);
      for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
      writeFileSync(join(dir, 'big.bin'), big);
      writeFileSync(join(dir, 'empty.bin'), Buffer.alloc(0));
      expect(await sha256File(join(dir, 'big.bin'), 64 * 1024)).toBe(sha(big));
      expect(await sha256File(join(dir, 'empty.bin'))).toBe(sha(Buffer.alloc(0)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('hashes every listed file with real fs, leaves missing ones out and skips the hash on a size mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'em-int-'));
    try {
      const files = { 'dist/a.jsc': Buffer.from('alpha'), 'engine/b.exe': Buffer.alloc(200_000, 7), 'engine/c.dll': Buffer.from('gamma!') };
      for (const [p, b] of Object.entries(files)) { const f = join(dir, p.replace('/', '_')); writeFileSync(f, b); }
      const entries = [
        { path: 'dist/a.jsc', bytes: 5 }, { path: 'engine/b.exe', bytes: 200_000 }, { path: 'engine/c.dll', bytes: 999 }, { path: 'engine/missing.dll', bytes: 3 },
      ];
      const progress: HashProgress[] = [];
      const d = await hashManifestFiles(entries, (p) => join(dir, p.replace('/', '_')), { concurrency: 2, onProgress: (p) => progress.push(p) });
      expect(d.get('dist/a.jsc')).toEqual({ sha256: sha(files['dist/a.jsc']), bytes: 5 });
      expect(d.get('engine/b.exe')).toEqual({ sha256: sha(files['engine/b.exe']), bytes: 200_000 });
      expect(d.get('engine/c.dll')).toEqual({ sha256: '', bytes: 6 });               // size differs → verifyManifest says size-mismatch
      expect(d.has('engine/missing.dll')).toBe(false);                              // → verifyManifest says missing
      expect(progress).toHaveLength(4);
      expect(progress.at(-1)).toMatchObject({ files: 4, totalFiles: 4, bytes: 200_000 + 5 + 999 + 3, totalBytes: 200_000 + 5 + 999 + 3 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never runs more than the bound at once, starts the largest file first, and keeps result order', async () => {
    let active = 0, peak = 0;
    const started: string[] = [];
    const entries = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, bytes: (i + 1) * 10 }));
    const d = await hashManifestFiles(entries, (p) => p, {
      concurrency: 3,
      sizeOf: async (p) => entries.find((e) => e.path === p)!.bytes,
      hashFile: async (p) => { started.push(p); active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return `h-${p}`; },
    });
    expect(peak).toBe(3);
    expect(started[0]).toBe('f8');
    expect(d.size).toBe(9);
    expect(d.get('f4')).toEqual({ sha256: 'h-f4', bytes: 50 });
    expect(await mapBounded([3, 1, 2], 2, async (n) => n * 2)).toEqual([6, 2, 4]);
    expect(await mapBounded([], 3, async (n: number) => n)).toEqual([]);
  });

  it('propagates a read error (the check then fails closed, EM-8007)', async () => {
    await expect(hashManifestFiles([{ path: 'x', bytes: 1 }], (p) => p, { sizeOf: async () => 1, hashFile: async () => { throw new Error('EACCES'); } })).rejects.toThrow('EACCES');
  });
});
