/**
 * Startup integrity hashing (SEC-133; QA 2026-10-26: the sequential check of ~80 packaged files, large engine binaries
 * included, held the startup on a slow laptop). Every file listed in the signed manifest is still hashed in full — the
 * verification itself (lib/integrity.ts `verifyManifest`) is unchanged — but reads are streamed in 1 MB chunks and run
 * a few files at a time, largest first, so the main process stays responsive and the progress can be shown.
 * No `electron` import (unit-tested on Linux); node:fs / node:crypto only.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';

export const HASH_CHUNK_BYTES = 1024 * 1024;
/** Files hashed at the same time. Three keeps an HDD from seeking itself to death and still overlaps CPU and I/O. */
export const INTEGRITY_CONCURRENCY = 3;

/** Streaming sha256 of one file (never reads the whole file into memory). */
export function sha256File(path: string, chunkBytes: number = HASH_CHUNK_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path, { highWaterMark: chunkBytes })
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(lanes);
  return out;
}

export interface HashProgress { files: number; totalFiles: number; bytes: number; totalBytes: number }
export interface HashOptions {
  concurrency?: number;
  onProgress?: (p: HashProgress) => void;
  /** Injected for tests; defaults to `sha256File`. */
  hashFile?: (path: string) => Promise<string>;
  /** Injected for tests; resolves the size in bytes, or null when the file does not exist. */
  sizeOf?: (path: string) => Promise<number | null>;
}

async function defaultSizeOf(path: string): Promise<number | null> {
  try { const s = await fsp.stat(path); return s.isFile() ? s.size : null; } catch { return null; }
}

/**
 * Digests of the manifest's files for `verifyManifest`. A missing file is left out (verification reports `missing`); a file
 * whose size already differs is not hashed (verification reports `size-mismatch` before it compares hashes).
 */
export async function hashManifestFiles(
  entries: readonly { path: string; bytes: number }[],
  fileFor: (logical: string) => string,
  opts: HashOptions = {},
): Promise<Map<string, { sha256: string; bytes: number }>> {
  const hashFile = opts.hashFile ?? sha256File;
  const sizeOf = opts.sizeOf ?? defaultSizeOf;
  const ordered = [...entries].sort((a, b) => b.bytes - a.bytes);           // largest first: the long reads start early
  const totalBytes = ordered.reduce((n, e) => n + e.bytes, 0);
  const progress: HashProgress = { files: 0, totalFiles: ordered.length, bytes: 0, totalBytes };
  const digests = new Map<string, { sha256: string; bytes: number }>();
  await mapBounded(ordered, opts.concurrency ?? INTEGRITY_CONCURRENCY, async (entry) => {
    const file = fileFor(entry.path);
    const size = await sizeOf(file);
    if (size !== null) digests.set(entry.path, { sha256: size === entry.bytes ? await hashFile(file) : '', bytes: size });
    progress.files += 1; progress.bytes += entry.bytes;
    opts.onProgress?.({ ...progress });
  });
  return digests;
}
