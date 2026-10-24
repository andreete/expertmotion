// S2 shared helpers: event envelope, request parsing, pagination, path confinement, disk space, a FIFO mutex.
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { EmError, type EmCode } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';

export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Emits an SSE event with the API_SPECIFICATION §7.2 envelope (`at`, `projectId` when project-scoped). */
export function emit(ctx: ServiceContext, name: string, data: Record<string, unknown>): void {
  ctx.bus.emit(name, { at: ctx.now(), ...data });
}

export const em = (code: EmCode, message: string, opts: { status?: number; details?: unknown; path?: string; cause?: unknown } = {}): EmError => new EmError(code, message, opts);

/** Zod parse with the same EM-9002 envelope as route() (for bodies that route() cannot validate, e.g. raw uploads). */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw em('EM-9002', `Invalid request: ${i?.message ?? 'bad input'}`, { status: 400, path: [where, ...(i?.path ?? []).map(String)].join('.') });
}

export function requireProject(ctx: ServiceContext, projectId: string): { id: string; name: string; settings_json: string } {
  const row = ctx.db.prepare('SELECT id, name, settings_json FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId) as { id: string; name: string; settings_json: string } | undefined;
  if (!row) throw em('EM-6101', 'This project no longer exists.');
  return row;
}

// Pagination (API_SPECIFICATION §1): opaque cursor = base64url(JSON [sortKey, id]).
export const encodeCursor = (sortKey: string, id: string): string => Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
export function decodeCursor(c: string | undefined): [string, string] | null {
  if (!c) return null;
  try { const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown; if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]]; } catch { /* fallthrough */ }
  throw em('EM-9002', 'Invalid request: bad cursor', { status: 400, path: 'query.cursor' });
}

/** `p` strictly inside `root` (lexically, after resolve). */
export function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
/** Second guard for file serving (SEC-010): the real path (symlinks resolved) must stay inside the real root. */
export function realInside(root: string, p: string): string | null {
  try { const r = fs.realpathSync(root); const f = fs.realpathSync(p); return isInside(r, f) ? f : null; } catch { return null; }
}

export async function freeBytes(dir: string): Promise<number> {
  try { const s = await fs.promises.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Number.MAX_SAFE_INTEGER; }
}

/** FIFO async mutex: one heavy child process (FFmpeg, Chrome, Engine Binary) at a time on the whole Service (memory policy). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = 0;
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.tail;
    this.tail = new Promise<void>((r) => { release = r; });
    await prev;
    this.held++;
    try { return await fn(); } finally { this.held--; release(); }
  }
  get busy(): boolean { return this.held > 0; }
}

/** Serial job queue (concurrency 1) with cancellation of queued entries. */
export class SerialQueue<K extends string = string> {
  private readonly pending: Array<{ key: K; run: () => Promise<void> }> = [];
  private current: K | null = null;
  private idleWaiters: Array<() => void> = [];
  enqueue(key: K, run: () => Promise<void>): void { this.pending.push({ key, run }); void this.pump(); }
  /** Removes a queued (not running) entry. */
  remove(key: K): boolean { const i = this.pending.findIndex((p) => p.key === key); if (i < 0) return false; this.pending.splice(i, 1); return true; }
  has(key: K): boolean { return this.current === key || this.pending.some((p) => p.key === key); }
  get running(): K | null { return this.current; }
  get size(): number { return this.pending.length + (this.current ? 1 : 0); }
  idle(): Promise<void> { return this.size === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r)); }
  private async pump(): Promise<void> {
    if (this.current !== null) return;
    const next = this.pending.shift();
    if (!next) { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((f) => f()); return; }
    this.current = next.key;
    try { await next.run(); } catch { /* jobs record their own failures */ } finally { this.current = null; void this.pump(); }
  }
}

/**
 * Job queue with bounded concurrency (FR-042: two ingest jobs at a time) and cancellation of queued entries. Heavy child
 * processes inside the jobs still go through the Service-wide `heavy` Mutex, so two jobs overlap their copy/hash and bookkeeping
 * while at most one FFmpeg runs (shared-server memory policy).
 */
export class WorkQueue<K extends string = string> {
  private readonly pending: Array<{ key: K; run: () => Promise<void> }> = [];
  private readonly active = new Set<K>();
  private idleWaiters: Array<() => void> = [];
  constructor(readonly concurrency = 1) {}
  enqueue(key: K, run: () => Promise<void>): void { this.pending.push({ key, run }); this.pump(); }
  /** Removes a queued (not running) entry. */
  remove(key: K): boolean { const i = this.pending.findIndex((p) => p.key === key); if (i < 0) return false; this.pending.splice(i, 1); this.pump(); return true; }
  has(key: K): boolean { return this.active.has(key) || this.pending.some((p) => p.key === key); }
  get running(): K[] { return [...this.active]; }
  get size(): number { return this.pending.length + this.active.size; }
  idle(): Promise<void> { return this.size === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r)); }
  private pump(): void {
    while (this.active.size < this.concurrency) {
      const next = this.pending.shift();
      if (!next) break;
      this.active.add(next.key);
      void (async () => { try { await next.run(); } catch { /* jobs record their own failures */ } finally { this.active.delete(next.key); this.pump(); } })();
    }
    if (this.size === 0) { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((f) => f()); }
  }
}

const CT: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.apng': 'image/apng', '.json': 'application/json', '.srt': 'application/x-subrip', '.vtt': 'text/vtt',
};
export const contentTypeFor = (file: string): string => CT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Throttle helper: returns true at most once per `ms` (always true when `force`). */
export function throttle(ms: number): (force?: boolean) => boolean {
  let last = -Infinity;
  return (force = false) => { const t = Date.now(); if (force || t - last >= ms) { last = t; return true; } return false; };
}

export const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
