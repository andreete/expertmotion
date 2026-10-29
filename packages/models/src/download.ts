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
/** FR-245: why a transfer failed, in words the Creator can act on (ERROR_CATALOGUE EM-7002 reasons). */
export type DownloadFailReason = 'rate-limited' | 'server' | 'http' | 'dns' | 'tls' | 'connection' | 'timeout' | 'stalled' | 'range' | 'network';
export interface DownloadRetry { file: string; attempt: number; delayMs: number; reason: DownloadFailReason; httpStatus?: number; netCode?: string; bytesDone: number }

export interface DownloadOptions {
  fetch: FetchLike;
  /** Free bytes on the volume holding `path` (statfs in the service). */
  freeBytes: (path: string) => Promise<number>;
  allowedHosts?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** Checked before the first request and before every retry (SEC-076). */
  privateMode?: () => boolean;
  /** Retries in a row WITHOUT new bytes (FR-245: 6; a retry that brought new bytes resets the count, so a long download over an
   *  unstable connection keeps going from its `.part`). */
  retries?: number;
  /** Hard cap on transfers per file, progress or not (FR-245: 40). */
  maxAttempts?: number;
  /** Retries in a row with NO route to the internet before giving up (default: maxAttempts, i.e. wait the outage out). A small
   *  interactive download (a 3 MB music track the Creator is waiting for) passes a few, so "no internet" ends as EM-7002 in seconds. */
  offlineRetries?: number;
  /** Delay before retry `attempt` (0-based). Default: 2 s · 2^attempt, max 60 s, ±20 % jitter. 429/503 use Retry-After / RateLimit `t=` instead (max 5 min). */
  backoffMs?: (attempt: number) => number;
  /** No byte for this long while streaming → the transfer is dropped and resumed (FR-245: 60 s). */
  stallMs?: number;
  /** Until the response headers arrive (FR-245: 45 s). */
  headersTimeoutMs?: number;
  /** Called before every automatic retry (the Service shows "Mencoba lagi…" with the reason). */
  onRetry?: (r: DownloadRetry) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  progressIntervalMs?: number;
  /** Abort when free disk falls under this while downloading (SEC-073: 1 GB). */
  minFreeBytes?: number;
  /** Free-disk re-check interval in bytes (SEC-073: every 64 MB). */
  diskCheckEveryBytes?: number;
  maxRedirects?: number;
  /** Called whenever an existing `.part` is read back from disk to hash it (diagnostics and tests; R9: once per call, not per retry). */
  onPartHash?: (bytes: number) => void;
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
  // Exact match, or `*.domain` for a subdomain of a CDN the host owns (Hugging Face redirects to regional <x>.cdn.hf.co hosts).
  const ok = hosts.map((h) => h.toLowerCase()).some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));
  if (!ok) throw emError('EM-8203', `Download host ${host} is not allowed`, { host, purpose: 'model-download', reason: 'host-not-allowed' });
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
  constructor(message: string, readonly detail: Record<string, unknown> & { reason: DownloadFailReason; retryAfterMs?: number } = { reason: 'network' }) { super(message); this.name = 'RetryableError'; }
}
const TLS_CODES = /^(UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_CERT_ALTNAME_INVALID|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|CERT_REVOKED|ERR_SSL_.*|EPROTO)$/;
/**
 * FR-245: what a failed fetch() really was. Node's fetch throws `TypeError: fetch failed` and hides the cause one or two levels
 * down (`cause.code` ECONNRESET / ENOTFOUND / UND_ERR_* / a TLS code). The QA log of 2026-10-28 only had "Download of … failed".
 */
export function classifyNetError(err: unknown): { reason: DownloadFailReason; netCode: string | null; message: string } {
  let c: unknown = err; let code: string | null = null; let name = '';
  const msg = err instanceof Error ? err.message : String(err);
  for (let i = 0; i < 5 && c; i++) {
    const x = c as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof x.code === 'string' && !code) code = x.code;
    if (typeof x.name === 'string' && /Timeout/i.test(x.name)) name = x.name;
    c = x.cause;
  }
  const reason: DownloadFailReason = code && TLS_CODES.test(code) ? 'tls'
    : code && /^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME)$/.test(code) ? 'dns'
    : (code && /TIMEOUT|ETIMEDOUT/.test(code)) || name ? 'timeout'
    : code && /^(ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code) ? 'connection'
    : /terminated|other side closed|socket/i.test(msg) ? 'connection' : 'network';
  return { reason, netCode: code, message: msg.slice(0, 200) };
}
/** Retry-After (seconds or HTTP date) or Hugging Face's `RateLimit: "resolvers";r=0;t=123` (seconds until the window resets). */
export function retryAfterMs(headers: { get(name: string): string | null }, nowMs = Date.now()): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) { const n = Number(ra); if (Number.isFinite(n)) return Math.max(0, n * 1000); const d = Date.parse(ra); if (Number.isFinite(d)) return Math.max(0, d - nowMs); }
  const rl = /\bt=(\d+)/.exec(headers.get('ratelimit') ?? '');
  return rl ? Number(rl[1]) * 1000 : undefined;
}
export const RETRY_AFTER_MAX_MS = 5 * 60_000;
const defaultBackoff = (a: number): number => Math.round(Math.min(60_000, 2000 * 2 ** a) * (0.8 + Math.random() * 0.4));
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
  const retries = opts.retries ?? 6;
  const maxAttempts = opts.maxAttempts ?? 40;
  const backoff = opts.backoffMs ?? defaultBackoff;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const stallMs = opts.stallMs ?? 60_000;
  const headersTimeoutMs = opts.headersTimeoutMs ?? 45_000;
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
  let lastHost = '';
  let running: { hash: Hash; bytes: number } | null = null;
  const transfer = async (): Promise<{ hash: string; size: number }> => {
    // FR-245: one AbortController per transfer — the caller's signal, the header timeout and the stall watchdog all end it.
    const tc = new AbortController(); let timedOut: 'headers' | 'stalled' | null = null;
    const onOuter = (): void => tc.abort();
    opts.signal?.addEventListener('abort', onOuter, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, why: 'headers' | 'stalled'): void => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => { timedOut = why; tc.abort(); }, ms); (watchdog as { unref?: () => void }).unref?.(); };
    try { return await transferOnce(tc.signal, arm, () => timedOut); } catch (err) {
      if (timedOut && !opts.signal?.aborted && !(err instanceof EmError)) throw new RetryableError(timedOut === 'stalled' ? `no data for ${Math.round(stallMs / 1000)} s` : 'no answer from the download server', { reason: timedOut === 'stalled' ? 'stalled' : 'timeout' });
      throw err;
    } finally { if (watchdog) clearTimeout(watchdog); opts.signal?.removeEventListener('abort', onOuter); }
  };
  const transferOnce = async (signal: AbortSignal, arm: (ms: number, why: 'headers' | 'stalled') => void, timedOut: () => string | null): Promise<{ hash: string; size: number }> => {
    let have = await fileSize(paths.partPath);
    if (have > cap) { await rm(paths.partPath, { force: true }); have = 0; }
    // hash the bytes we already have BEFORE asking for more: a multi-GB `.part` takes a while, and no watchdog runs meanwhile
    // R9: within one downloadFile call the running hash of what this process wrote is kept, so a retry re-reads the part only
    // when its size differs from the bytes that hash covers (first resume, a partial write, or a part changed by someone else)
    let pre: Hash | null = null;
    if (have > 0) {
      if (running && running.bytes === have) pre = running.hash.copy();
      else { opts.onPartHash?.(have); pre = await hashFile(paths.partPath); }
    }
    let url = spec.url;
    let res: FetchResponseLike | undefined;
    for (let hop = 0; ; hop++) {
      throwIfAborted(opts.signal);
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (have > 0) headers.Range = `bytes=${have}-`;
      const init: FetchInit = { method: 'GET', headers, redirect: 'manual', signal };
      lastHost = new URL(url).hostname;
      arm(headersTimeoutMs, 'headers');
      try { res = await opts.fetch(url, init); } catch (err) {
        if (opts.signal?.aborted) throw new CancelledError();
        if (timedOut()) throw err;
        const mapped = mapEgressError(err, spec, have);
        if (mapped instanceof EmError) throw mapped;
        const net = classifyNetError(err);
        throw new RetryableError(net.message, { reason: net.reason, netError: net.message, ...(net.netCode ? { netCode: net.netCode } : {}), host: lastHost });
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
    if (r.status === 416 && have > 0 && pre) return { hash: pre.digest('hex'), size: have };   // part already complete (verify decides)
    if (r.status === 429 || r.status >= 500) {
      const after = retryAfterMs(r.headers, now());
      throw new RetryableError(`HTTP ${r.status}`, { reason: r.status === 429 ? 'rate-limited' : 'server', httpStatus: r.status, host: lastHost, ...(after !== undefined && (r.status === 429 || r.status === 503) ? { retryAfterMs: Math.min(RETRY_AFTER_MAX_MS, after) } : {}) });
    }
    if (r.status !== 200 && r.status !== 206) throw emError('EM-7002', `Download failed with HTTP ${r.status}`, { modelId: spec.modelKey ?? null, bytesDone: have, httpStatus: r.status, reason: 'http', host: lastHost });

    let append = false;
    if (r.status === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(r.headers.get('content-range') ?? '');
      if (!m || Number(m[1]) !== have) { await rm(paths.partPath, { force: true }); throw new RetryableError('unexpected Content-Range', { reason: 'range', contentRange: r.headers.get('content-range'), host: lastHost }); }
      if (m[3] !== '*' && Number(m[3]) > cap) await sizeExceeded(Number(m[3]));
      append = true;
    } else {
      const len = Number(r.headers.get('content-length') ?? NaN);
      if (Number.isFinite(len) && len > cap) await sizeExceeded(len);
    }
    const hasher = append && pre ? pre : createHash('sha256');
    if (!append) have = 0;
    running = { hash: hasher, bytes: have };
    const fh = await open(paths.partPath, append ? 'a' : 'w');
    let written = have; let sinceDiskCheck = 0;
    arm(stallMs, 'stalled');
    try {
      try {
        for await (const chunk of iterateBody(r.body)) {
          throwIfAborted(opts.signal);
          arm(stallMs, 'stalled');
          if (written + chunk.byteLength > cap) { await fh.close().catch(() => undefined); await sizeExceeded(written + chunk.byteLength); }
          await fh.write(chunk);
          hasher.update(chunk);
          written += chunk.byteLength; sinceDiskCheck += chunk.byteLength;
          running.bytes = written;
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
        if (timedOut()) throw err;
        const net = classifyNetError(err);
        throw new RetryableError(net.message, { reason: net.reason, netError: net.message, ...(net.netCode ? { netCode: net.netCode } : {}), host: lastHost });
      }
    } finally { await fh.close().catch(() => undefined); }
    progress(written, true);
    running = { hash: hasher.copy(), bytes: written };
    return { hash: hasher.digest('hex'), size: written };
  };

  const sizeExceeded = async (bytes: number): Promise<never> => {
    await rm(paths.partPath, { force: true });
    throw emError('EM-7003', `${spec.name} is larger than its registry size`, { modelId: spec.modelKey ?? null, expectedHash: spec.sha256, reason: 'size-exceeded', bytes, capBytes: cap });
  };

  for (let hashAttempt = 0; ; hashAttempt++) {
    let out: { hash: string; size: number } | undefined;
    let failsInRow = 0; let attempts = 0;
    for (;;) {
      throwIfAborted(opts.signal);
      const before = await fileSize(paths.partPath);
      checkPrivate(before);
      attempts++;
      try { out = await transfer(); break; } catch (err) {
        if (!(err instanceof RetryableError)) throw err;
        const done = await fileSize(paths.partPath);
        failsInRow = done > before ? 1 : failsInRow + 1;          // new bytes since the last failure → the count starts again
        // A refused secure connection (antivirus HTTPS scanning, a proxy, an ISP block page) does not heal by retrying quickly.
        // QA P1-9: no route to the internet at all (cable out, Wi-Fi off) is waited out up to maxAttempts (~40 min at the 60 s cap),
        // so the download resumes by itself when the network returns; the Service says "no internet" from the first failure.
        const offline = typeof err.detail.netCode === 'string' && /^(ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ENETDOWN)$/.test(err.detail.netCode);
        const limit = err.detail.reason === 'tls' ? Math.min(1, retries) : offline ? (opts.offlineRetries ?? maxAttempts) : retries;
        if (failsInRow > limit || attempts >= maxAttempts) {
          const { retryAfterMs: _ra, ...detail } = err.detail;
          throw emError('EM-7002', `Download of ${spec.name} failed (${err.detail.reason}${err.detail.httpStatus ? ` HTTP ${String(err.detail.httpStatus)}` : ''}${err.detail.netCode ? ` ${String(err.detail.netCode)}` : ''})`,
            { modelId: spec.modelKey ?? null, bytesDone: done, percent: spec.bytes > 0 ? Math.floor((done / spec.bytes) * 100) : 0, attempts, resumable: done > 0, ...detail });
        }
        const delayMs = err.detail.retryAfterMs ?? backoff(failsInRow - 1);
        opts.onRetry?.({ file: spec.name, attempt: attempts, delayMs, reason: err.detail.reason, bytesDone: done,
          ...(typeof err.detail.httpStatus === 'number' ? { httpStatus: err.detail.httpStatus } : {}), ...(typeof err.detail.netCode === 'string' ? { netCode: err.detail.netCode } : {}) });
        speedT0 = now(); speedB0 = done;
        await sleep(delayMs, opts.signal);
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
