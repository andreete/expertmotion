// S2 test harness: boots the real service with selected modules, seeds projects/versions, and replaces the S1 composition hooks
// with a small in-memory head (applyOperations from the real package) so assets/renders can be tested on their own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyOperations, createEmptyModel, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { EmError, newId } from '@expertmotion/shared';
import { startService, tempDir, type TestService } from '../helpers.js';
import type { ServiceModule } from '../../src/modules/types.js';
import type { ServiceConfig } from '../../src/config.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const BIN = path.join(ROOT, 'node_modules/@remotion/compositor-linux-x64-gnu');
export const FFMPEG = path.join(BIN, 'ffmpeg'); export const FFPROBE = path.join(BIN, 'ffprobe');
export const FIXTURES = path.join(ROOT, 'test/fixtures/media');
export const hasFfmpeg = (() => { try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' }); return fs.existsSync(path.join(FIXTURES, 'clip-a-audio.mp4')); } catch { return false; } })();

export interface S2Service extends TestService {
  heads: Map<string, { model: CompositionModelT; versionId: string }>;
  applied: Array<{ projectId: string; ops: OperationT[]; source: { kind: string; summary: string; jobs?: Record<string, unknown> } }>;
  project(name?: string): string;
  version(projectId: string, model: CompositionModelT): string;
  events: Array<{ name: string; data: Record<string, unknown> }>;
  waitEvent(pred: (e: { name: string; data: Record<string, unknown> }) => boolean, ms?: number): Promise<{ name: string; data: Record<string, unknown> }>;
}

export async function startS2(modules: readonly ServiceModule[], opts: { dataDir?: string; cfg?: Partial<ServiceConfig> } = {}): Promise<S2Service> {
  const s = await startService({ modules, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), ...(opts.cfg ? { cfg: opts.cfg } : {}) });
  s.ctx.resources.ffmpeg = hasFfmpeg ? FFMPEG : '/nonexistent/ffmpeg';
  s.ctx.resources.ffprobe = hasFfmpeg ? FFPROBE : '/nonexistent/ffprobe';
  const heads = new Map<string, { model: CompositionModelT; versionId: string }>();
  const applied: S2Service['applied'] = [];
  const events: S2Service['events'] = [];
  const waiters: Array<{ pred: (e: S2Service['events'][number]) => boolean; res: (e: S2Service['events'][number]) => void }> = [];
  const origEmit = s.ctx.bus.emit.bind(s.ctx.bus);
  s.ctx.bus.emit = (name, data) => {
    const ev = origEmit(name, data); const e = { name, data };
    events.push(e);
    for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.res(e); }
    return ev;
  };
  const version = (projectId: string, model: CompositionModelT): string => {
    const id = newId();
    s.ctx.db.prepare("INSERT INTO composition_versions (id, project_id, parent_id, hash, model_json, cause, duration_ms, created_at) VALUES (?,?,?,?,?,'system',0,?)")
      .run(id, projectId, heads.get(projectId)?.versionId ?? null, crypto.randomBytes(16).toString('hex'), JSON.stringify(model), new Date().toISOString());
    heads.set(projectId, { model, versionId: id });
    return id;
  };
  const project = (name = 'Promo Kopi'): string => {
    const id = newId(); const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO projects (id, name, settings_json, language, created_at, updated_at) VALUES (?,?,'{}','id',?,?)").run(id, name, now, now);
    version(id, createEmptyModel(id, { autoRatio: true, ratio: '16:9', resolution: '720p', fps: 30 }));
    return id;
  };
  s.ctx.hooks.composition = (projectId) => { const h = heads.get(projectId); if (!h) throw new EmError('EM-9003', 'Not found.'); return h; };
  s.ctx.hooks.applyOps = (projectId, ops, source) => {
    const h = heads.get(projectId); if (!h) throw new EmError('EM-9003', 'Not found.');
    const r = applyOperations(h.model, ops, { assets: s.ctx.hooks.assetFacts(projectId), tier: 'T0', newId, ...(source.jobs ? { jobs: source.jobs } : {}) });
    if (!r.ok) { const i = r.issues[0]!; throw new EmError(i.code as `EM-${number}`, i.message, { status: 422 }); }
    applied.push({ projectId, ops, source });
    return version(projectId, r.value.model);
  };
  const waitEvent: S2Service['waitEvent'] = (pred, ms = 20_000) => {
    const hit = events.find(pred); if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('event timeout')), ms); waiters.push({ pred, res: (e) => { clearTimeout(t); res(e); } }); });
  };
  return Object.assign(s, { heads, applied, project, version, events, waitEvent });
}

/** A temp folder that the assets module accepts as an import root, with copies of the committed fixtures. */
export function importDir(): string {
  const d = tempDir('em-s2-src-');
  if (fs.existsSync(FIXTURES)) for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(d, f));
  return d;
}
export function ffmpeg(args: string[]): void { execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); }

/** Minimal valid PCM WAV (mono 16-bit) with a sine, made in JS (no FFmpeg needed). */
export function wavBuffer(ms: number, hz = 440, rate = 8000): Buffer {
  const n = Math.round((rate * ms) / 1000); const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
export const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;
export const shell = { 'X-Expertmotion-Caller': 'shell' };
