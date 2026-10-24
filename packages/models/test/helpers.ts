import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildLike, FetchInit, FetchLike, FetchResponseLike, SpawnLike, SpawnOptionsStrict } from '../src/index.js';

export const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export async function tempDir(): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'em-models-'));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

export async function expectEm(p: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  try { await p; } catch (e) {
    const err = e as { code?: string; details?: Record<string, unknown> };
    if (err.code !== code) throw new Error(`expected ${code}, got ${err.code ?? String(e)}`);
    return err.details ?? {};
  }
  throw new Error(`expected ${code}, but resolved`);
}

// ---------------- fake HTTP server for downloads ----------------
export interface FakeFile { body: Uint8Array; ignoreRange?: boolean; contentLength?: number }
export interface FakeServerOpts {
  files: Record<string, FakeFile>;
  redirects?: Record<string, string>;
  /** Fail the body stream after N bytes, for the first `times` responses of a url. */
  breakAfter?: { url: string; bytes: number; times: number };
  status?: Record<string, number>;
  /** Throw from fetch itself (e.g. the egress gate). */
  throwOnFetch?: (url: string) => unknown;
  chunk?: number;
  /** Bytes appended to the body (server sends more than declared). */
  extra?: Record<string, number>;
}
export function fakeServer(o: FakeServerOpts): { fetch: FetchLike; calls: { url: string; init: FetchInit }[] } {
  const calls: { url: string; init: FetchInit }[] = [];
  const broken = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const thrown = o.throwOnFetch?.(url);
    if (thrown) throw thrown;
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const headers = (h: Record<string, string>): FetchResponseLike['headers'] => ({ get: (n) => h[n.toLowerCase()] ?? null });
    const redirect = o.redirects?.[url];
    if (redirect) return { status: 302, headers: headers({ location: redirect }), body: null };
    const st = o.status?.[url];
    if (st) return { status: st, headers: headers({}), body: null };
    const f = o.files[url];
    if (!f) return { status: 404, headers: headers({}), body: null };
    let body = f.body;
    const extra = o.extra?.[url];
    if (extra) { const b = new Uint8Array(body.length + extra); b.set(body); body = b; }
    let start = 0; let status = 200;
    const range = /^bytes=(\d+)-$/.exec(init.headers.Range ?? '');
    const h: Record<string, string> = {};
    if (range && !f.ignoreRange) {
      start = Number(range[1]);
      if (start >= body.length) return { status: 416, headers: headers({ 'content-range': `bytes */${body.length}` }), body: null };
      status = 206; h['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }
    h['content-length'] = String(f.contentLength ?? body.length - start);
    const slice = body.subarray(start);
    const chunk = o.chunk ?? 1024;
    let breakAt = Infinity;
    if (o.breakAfter && o.breakAfter.url === url && (broken.get(url) ?? 0) < o.breakAfter.times) { broken.set(url, (broken.get(url) ?? 0) + 1); breakAt = o.breakAfter.bytes; }
    async function* gen(): AsyncGenerator<Uint8Array> {
      let i = 0;
      while (i < slice.length) {
        if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (i >= breakAt) throw new TypeError('socket hang up');
        const end = Math.min(slice.length, i + chunk, breakAt);
        yield slice.subarray(i, end);
        i = end;
        await new Promise((r) => setImmediate(r));
      }
    }
    return { status, headers: headers(h), body: gen() };
  };
  return { fetch, calls };
}

// ---------------- fake child process ----------------
export class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed: string | null = null;
  constructor(readonly hangOnKill = false) { super(); }
  out(s: string): void { this.stdout.emit('data', Buffer.from(s)); }
  err(s: string): void { this.stderr.emit('data', Buffer.from(s)); }
  exit(code: number | null, signal: string | null = null): void { setImmediate(() => this.emit('close', code, signal)); }
  kill(signal?: NodeJS.Signals): boolean { this.killed = signal ?? 'SIGTERM'; if (!this.hangOnKill) this.exit(null, this.killed); return true; }
}
export interface SpawnCall { command: string; args: readonly string[]; options: SpawnOptionsStrict; child: FakeChild }
export function fakeSpawn(behaviour: (call: SpawnCall) => void | Promise<void>, opts: { hangOnKill?: boolean } = {}): { spawn: SpawnLike; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const child = new FakeChild(opts.hangOnKill ?? false);
    const call = { command, args, options, child };
    calls.push(call);
    setImmediate(() => { void Promise.resolve(behaviour(call)).catch((e: unknown) => child.emit('error', e)); });
    return child;
  };
  return { spawn, calls };
}

/** Minimal 16-bit mono PCM wav with `samples` frames of value v. */
export function makeWav(samples: number, sampleRate = 22050, v = 1000): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(v, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
