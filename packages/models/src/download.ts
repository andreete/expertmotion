// Download manager for Model Downloads (docs/LOCAL_AI_MODELS.md §4.3; docs/SECURITY.md SEC-070…076).
// The network goes only through the injected `fetch` (the Local Service's single egress fetch, which enforces Private Mode
// and raises EM-8202). Resume with HTTP Range into `<file>.part`, streaming sha256, size cap, atomic rename.
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EmError } from '@expertmotion/shared';
import { CancelledError, emError, throwIfAborted } from './errors.js';
import { DOWNLOAD_HOSTS } from './registry.js';

export interface ReadableStreamLike {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>; cancel(reason?: unknown): Promise<void>; releaseLock?(): void };
}
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | ReadableStreamLike | null;
}
export interface FetchInit { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface DownloadProgress { file: string; bytesDone: number; bytesTotal: number; bps: number }

export interface DownloadOptions {
  fetch: FetchLike;
  /** Free bytes on the volume holding `path` (statfs in the service). */
  freeBytes: (path: string) => Promise<number>;
  allowedHosts?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** Checked before the first request and before every retry (SEC-076). */
  privateMode?: () => boolean;
  /** Retries per network error (LOCAL_AI_MODELS §4.3: 2). */
  retries?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  progressIntervalMs?: number;
  /** Abort when free disk falls under this while downloading (SEC-073: 1 GB). */
  minFreeBytes?: number;
  /** Free-disk re-check interval in bytes (SEC-073: every 64 MB). */
  diskCheckEveryBytes?: number;
  maxRedirects?: number;
}

export interface DownloadSpec { name: string; url: string; bytes: number; bytesExact: boolean; sha256: string; modelKey?: string }
export interface DownloadResult { sha256: string; bytes: number; path: string; resumedFromBytes: number }

export const MIN_FREE_BYTES = 1_000_000_000;
export const DISK_CHECK_EVERY = 64 * 1024 * 1024;
/** SEC-073: manifest size + 1 %. */
export const sizeCap = (bytes: number): number => Math.ceil(bytes * 1.01);

/** SEC-070/071: https only, host on the allow-list (exact match, case-insensitive). Throws EM-8203. */
export function assertAllowedUrl(url: string, hosts: readonly string[] = DOWNLOAD_HOSTS): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw emError('EM-8203', 'Download URL is not valid', { host: null, purpose: 'model-download', reason: 'invalid-url' }); }
  if (u.protocol !== 'https:') throw emError('EM-8203', 'Model downloads must use https', { host: u.hostname, purpose: 'model-download', reason: 'insecure-url' });
  if (u.username || u.password) throw emError('EM-8203', 'Download URL must not carry credentials', { host: u.hostname, purpose: 'model-download', reason: 'credentials-in-url' });
  const host = u.hostname.toLowerCase();
  if (!hosts.map((h) => h.toLowerCase()).includes(host)) throw emError('EM-8203', `Download host ${host} is not allowed`, { host, purpose: 'model-download', reason: 'host-not-allowed' });
  return u;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new CancelledError()); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = (): void => { clearTimeout(t); reject(new CancelledError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function* iterateBody(body: FetchResponseLike['body']): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  if (Symbol.asyncIterator in body) { yield* body as AsyncIterable<Uint8Array>; return; }
  const reader = (body as ReadableStreamLike).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally { reader.releaseLock?.(); }
}

async function fileSize(p: string): Promise<number> {
  try { return (await stat(p)).size; } catch { return 0; }
}

/** Streaming sha256 of a file on disk (node:crypto; no full read into memory). */
export async function hashFile(p: string, into?: Hash): Promise<Hash> {
  const h = into ?? createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h;
}
export async function sha256File(p: string): Promise<string> { return (await hashFile(p)).digest('hex'); }

class RetryableError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown> = {}) { super(message); this.name = 'RetryableError'; }
}
class HashMismatch extends Error {
  constructor(readonly actual: string, readonly reason: 'hash' | 'size') { super(`checksum mismatch (${reason})`); this.name = 'HashMismatch'; }
}

function mapEgressError(err: unknown, spec: DownloadSpec, bytesDone: number): Error {
  if (err instanceof EmError) {
    if (err.code === 'EM-8202') return emError('EM-7006', 'Downloads are paused while Private Mode is on', { modelId: spec.modelKey ?? null, reason: 'private', bytesDone }, err);
    if (err.code === 'EM-8201') return emError('EM-7006', 'Downloads are paused while offline', { modelId: spec.modelKey ?? null, reason: 'offline', bytesDone }, err);
    return err;
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Downloads one file into `partPath`, verifies size and sha256, and renames it atomically to `destPath`.
 * Errors: EM-7002 (network after retries), EM-7003 (checksum/size, `.part` removed), EM-7004 (disk), EM-7006 (Private Mode/offline,
 * `.part` kept), EM-8203 (scheme/host), CancelledError (signal; `.part` kept for resume).
 */
export async function downloadFile(spec: DownloadSpec, paths: { partPath: string; destPath: string }, opts: DownloadOptions): Promise<DownloadResult> {
  const hosts = opts.allowedHosts ?? DOWNLOAD_HOSTS;
  assertAllowedUrl(spec.url, hosts);
  if (!/^[0-9a-f]{64}$/.test(spec.sha256)) throw emError('EM-7003', `${spec.name} has no pinned checksum; refusing to download`, { modelId: spec.modelKey ?? null, expectedHash: spec.sha256, reason: 'unpinned' });
  const retries = opts.retries ?? 2;
  const backoff = opts.backoffMs ?? ((a: number) => 1000 * 2 ** a);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const cap = sizeCap(spec.bytes);
  const minFree = opts.minFreeBytes ?? MIN_FREE_BYTES;
  const diskEvery = opts.diskCheckEveryBytes ?? DISK_CHECK_EVERY;
  const interval = opts.progressIntervalMs ?? 500;
  await mkdir(dirname(paths.partPath), { recursive: true });
  const resumedFromBytes = await fileSize(paths.partPath);

  const checkPrivate = (bytesDone: number): void => {
    if (opts.privateMode?.()) throw emError('EM-7006', 'Downloads are paused while Private Mode is on', { modelId: spec.modelKey ?? null, reason: 'private', bytesDone });
  };

  let lastEmit = -Infinity; let speedT0 = now(); let speedB0 = resumedFromBytes;
  const progress = (bytesDone: number, force = false): void => {
    if (!opts.onProgress) return;
    const t = now();
    if (!force && t - lastEmit < interval) return;
    lastEmit = t;
    const dt = (t - speedT0) / 1000;
    const bps = dt > 0 ? Math.max(0, Math.round((bytesDone - speedB0) / dt)) : 0;
    opts.onProgress({ file: spec.name, bytesDone, bytesTotal: spec.bytes, bps });
  };

  /** One HTTP transfer (following redirects); appends to `.part`; returns the hash of the whole part file. */
  const transfer = async (): Promise<{ hash: string; size: number }> => {
    let have = await fileSize(paths.partPath);
    if (have > cap) { await rm(paths.partPath, { force: true }); have = 0; }
    let url = spec.url;
    let res: FetchResponseLike | undefined;
    for (let hop = 0; ; hop++) {
      throwIfAborted(opts.signal);
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (have > 0) headers.Range = `bytes=${have}-`;
      const init: FetchInit = { method: 'GET', headers, redirect: 'manual', ...(opts.signal ? { signal: opts.signal } : {}) };
      try { res = await opts.fetch(url, init); } catch (err) {
        if (opts.signal?.aborted) throw new CancelledError();
        const mapped = mapEgressError(err, spec, have);
        if (mapped instanceof EmError) throw mapped;
        throw new RetryableError(mapped.message, { netError: mapped.message });
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw emError('EM-7002', 'Redirect without a location', { modelId: spec.modelKey ?? null, bytesDone: have, httpStatus: res.status });
        if (hop + 1 > (opts.maxRedirects ?? 5)) throw emError('EM-7002', 'Too many redirects', { modelId: spec.modelKey ?? null, bytesDone: have, reason: 'too-many-redirects' });
        url = new URL(loc, url).toString();
        assertAllowedUrl(url, hosts);
        continue;
      }
      break;
    }
    const r = res;
    if (r.status === 416 && have > 0) return { hash: (await hashFile(paths.partPath)).digest('hex'), size: have };   // part already complete (verify decides)
    if (r.status === 429 || r.status >= 500) throw new RetryableError(`HTTP ${r.status}`, { httpStatus: r.status });
    if (r.status !== 200 && r.status !== 206) throw emError('EM-7002', `Download failed with HTTP ${r.status}`, { modelId: spec.modelKey ?? null, bytesDone: have, httpStatus: r.status });

    let append = false;
    if (r.status === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(r.headers.get('content-range') ?? '');
      if (!m || Number(m[1]) !== have) { await rm(paths.partPath, { force: true }); throw new RetryableError('unexpected Content-Range', { contentRange: r.headers.get('content-range') }); }
      if (m[3] !== '*' && Number(m[3]) > cap) await sizeExceeded(Number(m[3]));
      append = true;
    } else {
      const len = Number(r.headers.get('content-length') ?? NaN);
      if (Number.isFinite(len) && len > cap) await sizeExceeded(len);
    }
    const hasher = createHash('sha256');
    if (append) await hashFile(paths.partPath, hasher); else have = 0;
    const fh = await open(paths.partPath, append ? 'a' : 'w');
    let written = have; let sinceDiskCheck = 0;
    try {
      try {
        for await (const chunk of iterateBody(r.body)) {
          throwIfAborted(opts.signal);
          if (written + chunk.byteLength > cap) { await fh.close().catch(() => undefined); await sizeExceeded(written + chunk.byteLength); }
          await fh.write(chunk);
          hasher.update(chunk);
          written += chunk.byteLength; sinceDiskCheck += chunk.byteLength;
          if (sinceDiskCheck >= diskEvery) {
            sinceDiskCheck = 0;
            const free = await opts.freeBytes(dirname(paths.partPath));
            if (free < minFree) throw emError('EM-7004', 'Not enough free disk to continue the download', { modelId: spec.modelKey ?? null, requiredBytes: minFree, freeBytes: free });
          }
          progress(written);
        }
      } catch (err) {
        if (err instanceof EmError || err instanceof CancelledError) throw err;
        if (opts.signal?.aborted) throw new CancelledError();
        throw new RetryableError(err instanceof Error ? err.message : String(err), { netError: String(err) });
      }
    } finally { await fh.close().catch(() => undefined); }
    progress(written, true);
    return { hash: hasher.digest('hex'), size: written };
  };

  const sizeExceeded = async (bytes: number): Promise<never> => {
    await rm(paths.partPath, { force: true });
    throw emError('EM-7003', `${spec.name} is larger than its registry size`, { modelId: spec.modelKey ?? null, expectedHash: spec.sha256, reason: 'size-exceeded', bytes, capBytes: cap });
  };

  for (let hashAttempt = 0; ; hashAttempt++) {
    let out: { hash: string; size: number } | undefined;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(opts.signal);
      checkPrivate(await fileSize(paths.partPath));
      try { out = await transfer(); break; } catch (err) {
        if (!(err instanceof RetryableError)) throw err;
        if (attempt >= retries) {
          const done = await fileSize(paths.partPath);
          throw emError('EM-7002', `Download of ${spec.name} failed`, { modelId: spec.modelKey ?? null, bytesDone: done, percent: spec.bytes > 0 ? Math.floor((done / spec.bytes) * 100) : 0, ...err.detail });
        }
        speedT0 = now(); speedB0 = await fileSize(paths.partPath);
        await sleep(backoff(attempt), opts.signal);
      }
    }
    try {
      if (spec.bytesExact && out.size !== spec.bytes) throw new HashMismatch(out.hash, 'size');
      if (out.hash !== spec.sha256) throw new HashMismatch(out.hash, 'hash');
    } catch (err) {
      if (!(err instanceof HashMismatch)) throw err;
      await rm(paths.partPath, { force: true });
      if (hashAttempt >= 1) throw emError('EM-7003', `${spec.name} did not verify`, { modelId: spec.modelKey ?? null, expectedHash: spec.sha256, actualHash: err.actual, reason: err.reason });
      continue;   // one automatic re-download (LOCAL_AI_MODELS §4.3 step 4)
    }
    await mkdir(dirname(paths.destPath), { recursive: true });
    await rename(paths.partPath, paths.destPath);
    await writeFile(`${paths.destPath}.sha256`, `${out.hash}\n`, 'utf8');
    return { sha256: out.hash, bytes: out.size, path: paths.destPath, resumedFromBytes };
  }
}
