// Ingest pipeline (ASSET_INGESTION.md §3): copy + sha256 → probe → playable copy → proxy → thumbnails → filmstrip → waveform →
// index + SSE. One job at a time (serial queue) and every FFmpeg step under the Service-wide heavy lock, so ingest never runs
// beside a render or a generator engine on a small machine. Files are streamed, never buffered in memory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { EmError, errorMessage, type EmCode } from '@expertmotion/shared';
import { cuesToPages, parseSubtitles } from '@expertmotion/models';
import type { ServiceContext } from '../context.js';
import { SerialQueue, clamp01, emit, freeBytes, throttle } from './common.js';
import { getAsset, toAssetDto, type AssetRow } from './assets-repo.js';
import { SIZE_LIMIT, WaveformReducer, checkLimits, decidePlayable, ffprobe, isFastStart, kindFromExt, normalizeProbe, readHead, sniffMatches, type AssetKind, type MediaFacts } from './probe.js';
import { ToolError, runTool } from './proc.js';
import { s2 } from './state.js';

export const MAX_ASSETS_PER_PROJECT = 200;
/** FR-042: poster + 10 filmstrip frames. */
export const FILMSTRIP_FRAMES = 10;
export type IngestStage = 'hash' | 'probe' | 'transcode' | 'proxy' | 'thumbs' | 'filmstrip' | 'waveform';
type Outcome = { status: 'ready' | 'failed' | 'duplicate' | 'cancelled'; row?: AssetRow };

/** Source checks before anything is copied (§2 step 1, SEC-067). Throws EM-1001 / EM-1002 / EM-1010. */
export async function inspectSource(file: string, displayName: string): Promise<{ kind: AssetKind; bytes: number; ext: string }> {
  let st: fs.Stats;
  try { st = await fs.promises.stat(file); } catch { throw new EmError('EM-1010', 'The file was removed before the import finished.', { details: { name: displayName } }); }
  if (!st.isFile()) throw new EmError('EM-1001', 'This file type is not supported.', { details: { name: displayName, reason: 'not-a-file' } });
  const kind = kindFromExt(displayName);
  const ext = path.extname(displayName).toLowerCase();
  if (!kind) throw new EmError('EM-1001', 'This file type is not supported.', { details: { name: displayName, reason: 'extension', ext } });
  if (st.size > SIZE_LIMIT[kind]) throw new EmError('EM-1002', 'This file is too large.', { details: { name: displayName, size: st.size, limit: SIZE_LIMIT[kind] } });
  if (st.size === 0 || !sniffMatches(kind, await readHead(file))) throw new EmError('EM-1001', 'This file type is not supported.', { details: { name: displayName, reason: 'content', ext } });
  return { kind, bytes: st.size, ext };
}

export const assetDir = (ctx: ServiceContext, projectId: string, assetId: string): string => path.join(ctx.paths.media, projectId, assetId);
const rel = (projectId: string, assetId: string, file: string): string => `${projectId}/${assetId}/${file}`;
const abs = (ctx: ServiceContext, r: string): string => path.resolve(ctx.paths.media, r);
const displayName = (name: string): string => name.normalize('NFC').replace(/[\u0000-\u001f\\/]/g, '_').slice(-120) || 'file';

export class IngestService {
  private readonly queue = new SerialQueue();
  private readonly progress = new Map<string, number>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Array<(o: Outcome) => void>>();
  constructor(private readonly ctx: ServiceContext) {}

  progressOf(assetId: string): number | undefined { return this.progress.get(assetId); }
  get pending(): number { return this.queue.size; }
  idle(): Promise<void> { return this.queue.idle(); }

  /** Pre-copy checks that depend on the project (count, disk); throws EM-1401 / EM-6005. */
  async checkCapacity(projectId: string, bytes: number, adding = 1): Promise<void> {
    const n = (this.ctx.db.prepare('SELECT count(*) AS n FROM assets WHERE project_id = ?').get(projectId) as { n: number }).n;
    if (n + adding > MAX_ASSETS_PER_PROJECT) throw new EmError('EM-1401', 'A project can hold up to 200 assets.', { details: { count: n, limit: MAX_ASSETS_PER_PROJECT } });
    const free = await freeBytes(this.ctx.paths.media);
    if (free < 2 * bytes + 500_000_000) throw new EmError('EM-6005', 'Not enough disk space to import.', { details: { needBytes: 2 * bytes + 500_000_000, freeBytes: free } });
  }

  /** Creates the `ingesting` row and queues copy+hash from `source` (Shell paths, generated files). */
  importFile(spec: { projectId: string; source: string; name: string; kind: AssetKind; bytes: number; ext: string; move?: boolean }): AssetRow {
    const id = this.ctx.newId(); const now = this.ctx.now();
    this.insertRow({ id, projectId: spec.projectId, kind: spec.kind, name: displayName(spec.name), sha256: `pending-${id}`, bytes: spec.bytes, original: rel(spec.projectId, id, `original${spec.ext}`), now });
    this.enqueue(id, { from: 'hash', source: spec.source, move: spec.move ?? false });
    return getAsset(this.ctx, id)!;
  }

  /** Registers an already hashed file (raw dev upload in tmp): dedupe now, then move into place and queue from probe. */
  async importHashed(spec: { projectId: string; tmpFile: string; name: string; kind: AssetKind; bytes: number; ext: string; sha256: string }): Promise<{ row: AssetRow; duplicate: boolean }> {
    const dup = this.ctx.db.prepare('SELECT id FROM assets WHERE project_id = ? AND sha256 = ?').get(spec.projectId, spec.sha256) as { id: string } | undefined;
    if (dup) { await fs.promises.rm(spec.tmpFile, { force: true }); return { row: getAsset(this.ctx, dup.id)!, duplicate: true }; }
    const id = this.ctx.newId(); const now = this.ctx.now();
    const original = rel(spec.projectId, id, `original${spec.ext}`);
    await fs.promises.mkdir(assetDir(this.ctx, spec.projectId, id), { recursive: true });
    await moveFile(spec.tmpFile, abs(this.ctx, original));
    this.insertRow({ id, projectId: spec.projectId, kind: spec.kind, name: displayName(spec.name), sha256: spec.sha256, bytes: spec.bytes, original, now });
    this.enqueue(id, { from: 'probe' });
    return { row: getAsset(this.ctx, id)!, duplicate: false };
  }

  /** Re-runs probe and derived files from the kept original (restart recovery, relocate). */
  requeue(assetId: string): void {
    this.ctx.db.prepare("UPDATE assets SET status = 'ingesting', error_code = NULL, updated_at = ? WHERE id = ?").run(this.ctx.now(), assetId);
    this.enqueue(assetId, { from: 'probe' });
  }

  /** Cancels a queued or running ingest; the job removes the asset folder. */
  cancel(assetId: string): void {
    if (this.queue.remove(assetId)) { this.settle(assetId, { status: 'cancelled' }); return; }
    this.aborts.get(assetId)?.abort();
  }

  whenSettled(assetId: string): Promise<Outcome> {
    const r = getAsset(this.ctx, assetId);
    if (r && r.status !== 'ingesting' && !this.queue.has(assetId)) return Promise.resolve({ status: r.status === 'ready' ? 'ready' : 'failed', row: r });
    return new Promise((res) => { const w = this.waiters.get(assetId) ?? []; w.push(res); this.waiters.set(assetId, w); });
  }

  /** Startup recovery (§6 "Service restart mid-ingest"): complete originals are re-queued from probe, partial copies fail with EM-1201. */
  recover(): { requeued: string[]; failed: string[] } {
    const rows = this.ctx.db.prepare("SELECT * FROM assets WHERE status = 'ingesting'").all() as AssetRow[];
    const out = { requeued: [] as string[], failed: [] as string[] };
    for (const r of rows) {
      if (!r.sha256.startsWith('pending-') && fs.existsSync(abs(this.ctx, r.original_path))) { this.requeue(r.id); out.requeued.push(r.id); continue; }
      this.ctx.db.prepare("UPDATE assets SET status = 'failed', error_code = 'EM-1201', updated_at = ? WHERE id = ?").run(this.ctx.now(), r.id);
      fs.rmSync(assetDir(this.ctx, r.project_id, r.id), { recursive: true, force: true });
      out.failed.push(r.id);
    }
    return out;
  }

  private insertRow(r: { id: string; projectId: string; kind: AssetKind; name: string; sha256: string; bytes: number; original: string; now: string }): void {
    this.ctx.db.prepare(`INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,'ingesting',?,?)`).run(r.id, r.projectId, r.kind, r.name, r.sha256, r.bytes, r.original, r.now, r.now);
    this.progress.set(r.id, 0);
  }

  private enqueue(assetId: string, job: { from: 'hash'; source: string; move: boolean } | { from: 'probe' }): void {
    this.queue.enqueue(assetId, async () => {
      const ac = new AbortController(); this.aborts.set(assetId, ac);
      let outcome: Outcome;
      try { outcome = await this.run(assetId, job, ac.signal); } catch (e) { outcome = { status: 'failed' }; this.ctx.log.error({ assetId, err: errorMessage(e) }, 'ingest crashed'); }
      finally { this.aborts.delete(assetId); this.progress.delete(assetId); }
      this.settle(assetId, outcome);
    });
  }
  private settle(assetId: string, o: Outcome): void { const w = this.waiters.get(assetId) ?? []; this.waiters.delete(assetId); w.forEach((f) => f(o)); }

  private async run(assetId: string, job: { from: 'hash'; source: string; move: boolean } | { from: 'probe' }, signal: AbortSignal): Promise<Outcome> {
    const ctx = this.ctx; const heavy = s2(ctx).heavy;
    let row = getAsset(ctx, assetId);
    if (!row) return { status: 'cancelled' };
    const { project_id: projectId } = row;
    const dir = assetDir(ctx, projectId, assetId);
    const tick = throttle(250);
    const report = (stage: IngestStage, p: number, force = false) => {
      this.progress.set(assetId, clamp01(p));
      if (tick(force)) emit(ctx, 'ingest.progress', { projectId, assetId, stage, progress: clamp01(p) });
    };
    const cancelled = async (): Promise<Outcome> => { await fs.promises.rm(dir, { recursive: true, force: true }); return { status: 'cancelled' }; };
    const fail = async (code: EmCode, keepOriginal: boolean, detail?: string): Promise<Outcome> => {
      if (!keepOriginal) await fs.promises.rm(dir, { recursive: true, force: true });
      else for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) if (!f.startsWith('original.') && f !== 'probe.json') await fs.promises.rm(path.join(dir, f), { force: true });
      ctx.db.prepare("UPDATE assets SET status = 'failed', error_code = ?, playable_path = NULL, proxy_path = NULL, thumb_path = NULL, filmstrip_path = NULL, waveform_path = NULL, updated_at = ? WHERE id = ?").run(code, ctx.now(), assetId);
      if (detail) ctx.log.warn({ assetId, code, detail }, 'ingest failed');
      emit(ctx, 'ingest.failed', { projectId, assetId, code, name: row!.name });
      return { status: 'failed', ...(getAsset(ctx, assetId) ? { row: getAsset(ctx, assetId)! } : {}) };
    };

    // 1. copy + hash (streaming), dedupe within the project
    if (job.from === 'hash') {
      report('hash', 0, true);
      await fs.promises.mkdir(dir, { recursive: true });
      const dst = abs(ctx, row.original_path);
      let sha: string;
      try { sha = await copyWithHash(job.source, dst, row.bytes, signal, (p) => report('hash', p)); } catch (e) {
        if (signal.aborted) return cancelled();
        const enospc = (e as NodeJS.ErrnoException).code === 'ENOSPC';
        return fail(enospc ? 'EM-6005' : 'EM-1010', false, errorMessage(e));
      }
      if (job.move) await fs.promises.rm(job.source, { force: true });
      const dup = ctx.db.prepare('SELECT id FROM assets WHERE project_id = ? AND sha256 = ? AND id != ?').get(projectId, sha, assetId) as { id: string } | undefined;
      if (dup) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        ctx.db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
        emit(ctx, 'ingest.failed', { projectId, assetId, code: 'EM-1006', name: row.name, existingAssetId: dup.id });
        return { status: 'duplicate', row: getAsset(ctx, dup.id)! };
      }
      ctx.db.prepare('UPDATE assets SET sha256 = ?, updated_at = ? WHERE id = ?').run(sha, ctx.now(), assetId);
      row = getAsset(ctx, assetId)!;
    }
    if (signal.aborted) return cancelled();
    const original = abs(ctx, row.original_path);

    // Subtitles: parsed pages instead of ffprobe (FR-047, op:caption.importSrt)
    if (row.kind === 'subtitle') {
      try {
        const text = await fs.promises.readFile(original, 'utf8');
        const cues = parseSubtitles(text, { fileName: row.name });
        const pages = cuesToPages(cues);
        ctx.db.prepare("UPDATE assets SET status = 'ready', error_code = NULL, playable_path = original_path, probe_json = ?, duration_ms = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify({ subtitle: { cues: cues.length, pages } }), cues.length ? Math.max(...cues.map((c) => c.endMs)) : 0, ctx.now(), assetId);
      } catch (e) { return fail('EM-1009', true, errorMessage(e)); }
      const done = getAsset(ctx, assetId)!;
      emit(ctx, 'ingest.done', { projectId, asset: toAssetDto(done, 1) });
      return { status: 'ready', row: done };
    }

    // 2. probe
    report('probe', 0, true);
    let facts: MediaFacts; let probeText: string;
    try {
      const pj = await heavy.run(() => ffprobe(ctx.resources.ffprobe, original, signal));
      probeText = JSON.stringify(pj); facts = normalizeProbe(row.kind, pj);
    } catch (e) { if (signal.aborted) return cancelled(); return fail('EM-1003', true, errorMessage(e)); }
    await fs.promises.writeFile(path.join(dir, 'probe.json'), probeText);
    const limit = checkLimits(facts);
    if (limit) { ctx.log.info({ assetId, reason: limit.reason }, 'asset rejected'); return fail(limit.code, true); }
    if (signal.aborted) return cancelled();

    const ff = (args: string[], stage: IngestStage, timeoutMs: number, durMs?: number | null) => heavy.run(() => runTool({
      exe: ctx.resources.ffmpeg, args, cwd: dir, timeoutMs, signal,
      onStdoutLine: (l) => { const m = /^out_time_us=(\d+)/.exec(l); if (m && durMs) report(stage, Number(m[1]) / 1000 / durMs); },
    }));
    const durMs = facts.durationMs; const durS = (durMs ?? 0) / 1000;
    const longTimeout = Math.max(120_000, 4 * (durMs ?? 0)), shortTimeout = Math.max(60_000, 2 * (durMs ?? 0));
    const cols: Partial<Record<'playable_path' | 'proxy_path' | 'thumb_path' | 'filmstrip_path' | 'waveform_path', string>> = {};
    let warn = false;
    const optional = async (stage: IngestStage, fn: () => Promise<unknown>): Promise<boolean> => {
      if (signal.aborted) return false;
      report(stage, 0, true);
      try { await fn(); return true; } catch (e) {
        if (signal.aborted) return false;
        warn = true; ctx.log.warn({ assetId, stage, err: e instanceof ToolError ? `${e.reason} ${e.stderrTail.join(' | ')}` : errorMessage(e) }, 'ingest variant failed');
        return false;
      }
    };

    // 3–4. playable copy
    const plan = decidePlayable(facts, row.kind === 'video' ? await isFastStart(original).catch(() => false) : true);
    let playable = original;
    if (plan === 'original') cols.playable_path = row.original_path;
    else {
      report('transcode', 0, true);
      const out = row.kind === 'audio' ? 'playable.m4a' : 'playable.mp4';
      const args = plan === 'remux'
        ? ['-v', 'error', '-nostdin', '-y', '-i', original, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', out]
        : row.kind === 'audio'
          ? ['-v', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-i', original, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', out]
          : transcodeArgs(original, facts, out);
      try { await ff(args, 'transcode', longTimeout, durMs); } catch (e) {
        if (signal.aborted) return cancelled();
        const enospc = e instanceof ToolError && e.stderrTail.some((l) => /No space left/i.test(l));
        return fail(enospc ? 'EM-6005' : 'EM-1004', true, e instanceof ToolError ? `${e.reason} ${e.stderrTail.join(' | ')}` : errorMessage(e));
      }
      cols.playable_path = rel(projectId, assetId, out); playable = path.join(dir, out);
    }
    if (signal.aborted) return cancelled();

    // 5. proxy
    if (row.kind === 'video') {
      const short = Math.min(facts.width ?? 0, facts.height ?? 0);
      if (short <= 720) cols.proxy_path = cols.playable_path!;
      else if (await optional('proxy', () => ff(['-v', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-i', playable, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', "scale='if(gte(iw,ih),-2,720)':'if(gte(iw,ih),720,-2)':flags=bicubic", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30',
        '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000', '-map_metadata', '-1', '-movflags', '+faststart', 'proxy.mp4'], 'proxy', longTimeout, durMs))) cols.proxy_path = rel(projectId, assetId, 'proxy.mp4');
    } else if (row.kind === 'image' && !facts.animated) {
      if (await optional('proxy', () => ff(['-v', 'error', '-nostdin', '-y', '-i', original, '-frames:v', '1', '-vf', "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease",
        '-q:v', '3', '-map_metadata', '-1', 'proxy.jpg'], 'proxy', shortTimeout))) cols.proxy_path = rel(projectId, assetId, 'proxy.jpg');
    }
    // 6. thumbnails (poster at 35 %)
    if (row.kind === 'video' || row.kind === 'image') {
      const at = row.kind === 'video' ? ['-ss', (0.35 * durS).toFixed(3)] : [];
      if (await optional('thumbs', () => ff(['-v', 'error', '-nostdin', '-y', ...at, '-i', playable, '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '3', '-map_metadata', '-1', 'thumb.jpg'], 'thumbs', shortTimeout)))
        cols.thumb_path = rel(projectId, assetId, 'thumb.jpg');
    }
    // 6b. filmstrip (10 frames in one row, FR-042; needs the `fps` and `tile` filters of the full FFmpeg build)
    if (row.kind === 'video' && durS > 0) {
      if (await optional('filmstrip', () => ff(['-v', 'error', '-nostdin', '-y', '-i', playable, '-vf', `fps=${FILMSTRIP_FRAMES}/${durS.toFixed(3)},scale=160:-2,tile=${FILMSTRIP_FRAMES}x1`, '-frames:v', '1', '-q:v', '4', 'strip.jpg'], 'filmstrip', shortTimeout)))
        cols.filmstrip_path = rel(projectId, assetId, 'strip.jpg');
    }
    // 7. waveform
    if (facts.hasAudio && (row.kind === 'video' || row.kind === 'audio')) {
      if (await optional('waveform', async () => {
        const red = new WaveformReducer();
        await heavy.run(() => runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-i', playable, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-bitexact', '-f', 'wav', 'pipe:1'],
          cwd: dir, timeoutMs: shortTimeout, signal, onStdout: (c) => red.push(c) }));
        await fs.promises.writeFile(path.join(dir, 'wave.json'), JSON.stringify(red.finish()));
      })) cols.waveform_path = rel(projectId, assetId, 'wave.json');
    }
    if (signal.aborted) return cancelled();

    // 8. index (one statement, after every file exists) + event
    const r = ctx.db.prepare(`UPDATE assets SET status = 'ready', error_code = ?, playable_path = ?, proxy_path = ?, thumb_path = ?, filmstrip_path = ?, waveform_path = ?, probe_json = ?,
      duration_ms = ?, width = ?, height = ?, fps = ?, has_audio = ?, updated_at = ? WHERE id = ?`).run(warn ? 'EM-1005' : null, cols.playable_path ?? null, cols.proxy_path ?? null,
      cols.thumb_path ?? null, cols.filmstrip_path ?? null, cols.waveform_path ?? null, probeText, row.kind === 'image' ? 5000 : durMs, facts.width, facts.height, facts.fps, facts.hasAudio ? 1 : 0, ctx.now(), assetId);
    if (r.changes === 0) return cancelled();
    const done = getAsset(ctx, assetId)!;
    emit(ctx, 'ingest.done', { projectId, asset: toAssetDto(done, 1) });
    return { status: 'ready', row: done };
  }
}

/** §3.4 playable H.264/AAC transcode; HDR sources get the tone-map chain (§6). */
function transcodeArgs(input: string, f: MediaFacts, out: string): string[] {
  const filters = ['scale=trunc(iw/2)*2:trunc(ih/2)*2'];
  if (f.hdr) filters.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p');
  const big = Math.max(f.width ?? 0, f.height ?? 0) > 1920 || (f.fps ?? 30) > 60;
  return ['-v', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', big ? '5.1' : '4.2', '-vf', filters.join(','), '-fps_mode', 'cfr', '-r', String(f.fps ?? 30),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-map_metadata', '-1', '-movflags', '+faststart', out];
}

/** Streaming copy with sha256 (§3.1); `wx` never overwrites. */
export async function copyWithHash(src: string, dst: string, size: number, signal: AbortSignal, onProgress?: (p: number) => void): Promise<string> {
  const hash = crypto.createHash('sha256'); let done = 0;
  await pipeline(fs.createReadStream(src, { highWaterMark: 1 << 20 }), new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); done += chunk.length; onProgress?.(size ? done / size : 0); cb(null, chunk); } }),
    fs.createWriteStream(dst, { flags: 'wx' }), { signal });
  return hash.digest('hex');
}
export async function hashFile(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file, { highWaterMark: 1 << 20 }), new Transform({ transform(c: Buffer, _e, cb) { h.update(c); cb(); } }));
  return h.digest('hex');
}
export async function moveFile(src: string, dst: string): Promise<void> {
  try { await fs.promises.rename(src, dst); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await pipeline(fs.createReadStream(src), fs.createWriteStream(dst, { flags: 'wx' })); await fs.promises.rm(src, { force: true });
  }
}

export const ingestOf = (ctx: ServiceContext): IngestService => (s2(ctx).ingest ??= new IngestService(ctx));
