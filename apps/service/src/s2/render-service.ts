// Render queue (API_SPECIFICATION §6.11, PERFORMANCE §2/§7, ARCHITECTURE §6.2): preflight + estimate, one Render Job at a time,
// renderMedia/renderStill from the prebuilt Engine bundle with a per-job media grant, progress SSE, ffprobe validation, Outputs.
// @remotion/renderer is imported lazily inside the job so the Service (and its tests) start without Chrome.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deriveFrameTiming, deriveTiming, type CompositionModelT } from '@expertmotion/composition-model';
import { EmError, errorMessage, sanitizeFilename, timestamp, type EmCode } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { SerialQueue, clamp01, em, emit, freeBytes, isInside, requireProject, throttle } from './common.js';
import { getAsset } from './assets-repo.js';
import { ffprobe } from './probe.js';
import { moveFile } from './ingest.js';
import { runTool } from './proc.js';
import { getJob, getOutput, outputRelPath, outputRoots, profileDims, toJobDto, toOutputDto, type OutputProfileT, type RenderJobRow } from './render-repo.js';
import { s2 } from './state.js';

export type PerfProfile = 'standard' | 'accelerated' | 'turbo';
export interface RenderInput { projectId: string; versionId?: string | undefined; outputProfile: OutputProfileT; performanceProfile: PerfProfile; fileName?: string | undefined; folder?: string | undefined }
export interface Check { check: 'disk' | 'memory' | 'dimensions' | 'duration' | 'assets' | 'engine' | 'licence'; ok: boolean; code?: string; details?: Record<string, unknown> }

/** The subset of @remotion/renderer the queue uses (kept loose so a fake can stand in for tests). */
export interface RendererLike {
  selectComposition(o: Record<string, unknown>): Promise<{ width: number; height: number; fps: number; durationInFrames: number } & Record<string, unknown>>;
  renderMedia(o: Record<string, unknown>): Promise<unknown>;
  renderStill(o: Record<string, unknown>): Promise<unknown>;
  makeCancelSignal(): { cancelSignal: unknown; cancel: () => void };
}
export interface RenderOptions {
  renderer?: () => Promise<RendererLike>;
  freeMemBytes?: () => number;
  /** Remotion's own bundle server port (never 3000/4000): dev 4130…4139, packaged a free port in 47600…47699. */
  remotionPort?: (ctx: ServiceContext) => Promise<number>;
  stallMs?: number;
  wallClockMs?: number;
  /** SEC-011 render starts per minute (default 5). */
  maxStartsPerMinute?: number;
}

const COMPOSITION_ID = 'ExpertmotionTimeline';
const MEM_NEED: Record<PerfProfile, number> = { standard: 2 * 1024 ** 3, accelerated: 3 * 1024 ** 3, turbo: 4 * 1024 ** 3 };
const EXT: Record<OutputProfileT['format'], string> = { mp4: 'mp4', webm: 'webm', gif: 'gif', png: 'png', wav: 'wav' };
const KIND: Record<OutputProfileT['format'], 'video' | 'gif' | 'still' | 'audio'> = { mp4: 'video', webm: 'video', gif: 'gif', png: 'still', wav: 'audio' };
const PROFILE_POLICY: Record<PerfProfile, { cache: number; parallelEncoding: boolean }> = {
  standard: { cache: 256 * 1024 ** 2, parallelEncoding: false }, accelerated: { cache: 512 * 1024 ** 2, parallelEncoding: true }, turbo: { cache: 1024 ** 3, parallelEncoding: true },
};

export async function defaultRemotionPort(ctx: ServiceContext): Promise<number> {
  const [lo, hi] = ctx.cfg.dev ? [4130, 4139] : [47600, 47699];
  for (let p = lo; p <= hi; p++) {
    if (p === ctx.cfg.port || p === 3000 || p === 4000) continue;
    const free = await new Promise<boolean>((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
    if (free) return p;
  }
  throw em('EM-3002', 'The rendering engine could not start (no free port).');
}
const loadRemotion = async (): Promise<RendererLike> => (await import('@remotion/renderer')) as unknown as RendererLike;

interface Prepared {
  model: CompositionModelT; versionId: string; profile: OutputProfileT; watermark: boolean; dims: { width: number; height: number }; frames: number; durationMs: number;
  assetIds: string[]; checks: Check[]; warnings: Array<{ code: string; path: string; message: string; severity: 'info' | 'warn' }>; notices: string[];
  estimate: { seconds: number | null; bytes: number | null; confidence: 'low' | 'medium' | 'high' };
}

export class RenderService {
  private readonly queue = new SerialQueue();
  private readonly inputs = new Map<string, { prep: Prepared; input: RenderInput; outFile: string }>();
  private readonly cancels = new Map<string, { cancel: () => void; reason: 'user' | 'stalled' | 'shutdown' | null }>();
  private readonly idem = new Map<string, { projectId: string; jobId: string; at: number }>();
  private starts: number[] = [];
  constructor(private readonly ctx: ServiceContext, private readonly opts: RenderOptions = {}) {}

  /** Marks interrupted jobs failed (EM-3203) and sweeps their temp folders (DATABASE_SCHEMA §7, SEC-062). */
  recover(): number {
    const now = this.ctx.now();
    const r = this.ctx.db.prepare("UPDATE render_jobs SET status = 'failed', error_code = 'EM-3203', error_detail = 'interrupted', finished_at = ? WHERE status IN ('queued','rendering')").run(now);
    for (const d of fs.readdirSync(this.ctx.paths.tmp)) if (d.startsWith('render-')) fs.rmSync(path.join(this.ctx.paths.tmp, d), { recursive: true, force: true });
    return r.changes;
  }
  get active(): string | null { return this.queue.running; }
  idle(): Promise<void> { return this.queue.idle(); }

  /** PERFORMANCE §7 preflight + estimate (R-110). Never throws for a failed check; 404 only for project/version. */
  async prepare(input: RenderInput): Promise<Prepared> {
    const ctx = this.ctx;
    requireProject(ctx, input.projectId);
    let model: CompositionModelT; let versionId: string;
    const head = ctx.hooks.composition(input.projectId);
    if (!input.versionId || input.versionId === head.versionId) { model = structuredClone(head.model); versionId = head.versionId; }
    else {
      const v = ctx.db.prepare('SELECT model_json FROM composition_versions WHERE id = ? AND project_id = ?').get(input.versionId, input.projectId) as { model_json: string } | undefined;
      if (!v) throw em('EM-2401', 'That version of the project no longer exists.');
      model = JSON.parse(v.model_json) as CompositionModelT; versionId = input.versionId;
    }
    const checks: Check[] = []; const warnings: Prepared['warnings'] = []; const notices: string[] = [];
    const watermark = ctx.hooks.isTrial();
    const profile: OutputProfileT = { ...input.outputProfile };
    if (watermark) { if (profile.resolution !== '720p') profile.resolution = '720p'; notices.push('EM-5001'); }
    checks.push({ check: 'licence', ok: true, ...(watermark ? { code: 'EM-5001', details: { watermark: true, maxResolution: '720p' } } : {}) });
    if (ctx.hooks.tier() === 'T0' && (profile.resolution === '2k' || profile.resolution === '2160p')) warnings.push({ code: 'EM-3105', path: 'outputProfile.resolution', message: `${profile.resolution} needs a graphics card; 1080p is the highest option here.`, severity: 'info' });
    model.settings = { ...model.settings, ratio: profile.ratio, resolution: profile.resolution, fps: profile.fps, ...(profile.ratio === 'custom' && profile.customRatio ? { customRatio: profile.customRatio } : {}) };

    let dims = { width: 0, height: 0 };
    try { dims = profileDims(profile); } catch { /* reported below */ }
    const dimOk = dims.width >= 240 && dims.height >= 240 && dims.width <= 4096 && dims.height <= 4096 && dims.width % 2 === 0 && dims.height % 2 === 0;
    checks.push({ check: 'dimensions', ok: dimOk, ...(dimOk ? {} : { code: 'EM-3103' }), details: dims });

    const timing = deriveTiming(model); const frames = deriveFrameTiming(model).durationInFrames;
    const durOk = model.tracks.video.length > 0 && timing.durationMs >= 1000 && timing.durationMs <= 1_800_000;
    checks.push({ check: 'duration', ok: durOk, ...(durOk ? {} : { code: model.tracks.video.length === 0 ? 'EM-2202' : 'EM-3104' }), details: { durationMs: timing.durationMs } });

    const assetIds = [...new Set([...model.tracks.video.map((c) => c.assetId), ...model.tracks.audio.map((a) => a.assetId),
      ...model.tracks.overlay.map((o) => (o as { assetId?: string }).assetId).filter((x): x is string => typeof x === 'string')])];
    const missing = assetIds.filter((id) => {
      const a = getAsset(ctx, id, input.projectId);
      return !a || a.status !== 'ready' || !a.playable_path || !fs.existsSync(path.resolve(ctx.paths.media, a.playable_path));
    });
    checks.push({ check: 'assets', ok: missing.length === 0, ...(missing.length ? { code: 'EM-1301', details: { assetIds: missing } } : {}) });

    const engineOk = fs.existsSync(path.join(ctx.resources.engineBundle, 'index.html')) && (!ctx.resources.browserExecutable || fs.existsSync(ctx.resources.browserExecutable));
    checks.push({ check: 'engine', ok: engineOk, ...(engineOk ? {} : { code: 'EM-3001' }) });

    const estimate = estimateOf(profile, dims, frames, timing.durationMs, ctx.hooks.tier(), input.performanceProfile);
    const folder = this.folderFor(input);
    const free = await freeBytes(fs.existsSync(folder) ? folder : ctx.paths.outputs);
    const needDisk = 3 * (estimate.bytes ?? 0) + 500_000_000;
    checks.push({ check: 'disk', ok: free >= needDisk, ...(free >= needDisk ? {} : { code: 'EM-3102' }), details: { needBytes: needDisk, freeBytes: free } });
    const mem = (this.opts.freeMemBytes ?? os.freemem)();
    const needMem = MEM_NEED[input.performanceProfile];
    checks.push({ check: 'memory', ok: mem >= needMem, ...(mem >= needMem ? {} : { code: 'EM-3101' }), details: { needBytes: needMem, freeBytes: mem } });
    if (this.queue.size > 0) notices.push('EM-3208');
    return { model, versionId, profile, watermark, dims, frames, durationMs: timing.durationMs, assetIds, checks, warnings, notices, estimate };
  }

  estimateResponse(p: Prepared): Record<string, unknown> {
    return { ok: p.checks.every((c) => c.ok), dimensions: p.dims, totalFrames: p.frames, durationMs: p.durationMs, estimate: p.estimate, checks: p.checks,
      effectiveProfile: p.profile, watermark: p.watermark, warnings: p.warnings, notices: p.notices };
  }

  private folderFor(input: RenderInput): string {
    const chosen = input.folder ?? this.ctx.settings.get().outputFolder;
    return chosen ? path.resolve(chosen) : path.join(this.ctx.paths.outputs, input.projectId);
  }

  /** R-111. Returns the job DTO (+ notices) and whether it was an idempotent repeat. */
  async create(input: RenderInput, idempotencyKey?: string): Promise<{ job: Record<string, unknown>; notices: string[]; repeat: boolean }> {
    const ctx = this.ctx;
    const now = Date.now();
    for (const [k, v] of this.idem) if (now - v.at > 24 * 3_600_000) this.idem.delete(k);
    if (idempotencyKey) {
      const prev = this.idem.get(idempotencyKey);
      if (prev && prev.projectId === input.projectId) { const j = getJob(ctx, prev.jobId); if (j) return { job: toJobDto(j), notices: ['EM-2308'], repeat: true }; }
    }
    this.starts = this.starts.filter((t) => now - t < 60_000);
    if (this.starts.length >= (this.opts.maxStartsPerMinute ?? 5)) throw em('EM-9005', 'Too many exports started. Try again in a minute.', { status: 429 });
    const prep = await this.prepare(input);
    const failed = prep.checks.find((c) => !c.ok);
    if (failed) throw em(failed.code as EmCode, `Export preflight failed (${failed.check}).`, { status: failed.code === 'EM-3001' ? 503 : 422, ...(failed.details ? { details: failed.details } : {}) });
    const folder = this.folderFor(input);
    if (input.folder !== undefined || ctx.settings.get().outputFolder) {
      if (!outputRoots(ctx).some((r) => isInside(r, folder) || path.resolve(r) === folder)) throw em('EM-8302', 'Expertmotion can only save to folders inside your user profile.');
    }
    try { fs.mkdirSync(folder, { recursive: true }); fs.accessSync(folder, fs.constants.W_OK); } catch { throw em('EM-3206', 'Expertmotion cannot save files in this folder.', { details: { folder: path.basename(folder) } }); }
    const project = requireProject(ctx, input.projectId);
    const ratio = prep.profile.ratio === 'custom' ? 'custom' : prep.profile.ratio.replace(':', 'x');
    const stem = sanitizeFilename(input.fileName ?? `${project.name}-${ratio}-${prep.profile.resolution}-${timestamp()}`, 'video');
    const ext = EXT[prep.profile.format];
    let outFile = path.join(folder, `${stem}.${ext}`);
    for (let i = 2; fs.existsSync(outFile) || [...this.inputs.values()].some((x) => x.outFile === outFile); i++) outFile = path.join(folder, `${stem}-${i}.${ext}`);

    const id = ctx.newId(); const at = ctx.now();
    ctx.db.prepare(`INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, progress, total_frames, created_at)
      VALUES (?,?,?,?,?,'queued',0,?,?)`).run(id, input.projectId, prep.versionId, JSON.stringify(prep.profile), input.performanceProfile, prep.frames, at);
    this.starts.push(now);
    if (idempotencyKey) this.idem.set(idempotencyKey, { projectId: input.projectId, jobId: id, at: now });
    this.inputs.set(id, { prep, input, outFile });
    const job = toJobDto(getJob(ctx, id)!);
    emit(ctx, 'render.queued', { projectId: input.projectId, jobId: id, job });
    this.queue.enqueue(id, () => this.run(id));
    return { job, notices: prep.notices, repeat: false };
  }

  /** R-114: queued → cancelled at once; rendering → cancelSignal (Chrome killed, partial removed). Finished jobs unchanged. */
  cancel(jobId: string, reason: 'user' | 'shutdown' = 'user'): RenderJobRow | undefined {
    const job = getJob(this.ctx, jobId);
    if (!job) return undefined;
    if (job.status === 'queued' && this.queue.remove(jobId)) { this.finish(job, 'cancelled', null); return getJob(this.ctx, jobId); }
    const c = this.cancels.get(jobId);
    if (c) { c.reason = reason; c.cancel(); }
    return getJob(this.ctx, jobId);
  }
  async stopAll(): Promise<void> {
    for (const r of this.ctx.db.prepare("SELECT id FROM render_jobs WHERE status IN ('queued','rendering')").all() as Array<{ id: string }>) this.cancel(r.id, 'shutdown');
  }

  private finish(job: RenderJobRow, status: 'done' | 'failed' | 'cancelled', code: string | null, detail?: string, extra: Record<string, unknown> = {}): void {
    const ctx = this.ctx;
    ctx.db.prepare('UPDATE render_jobs SET status = ?, error_code = ?, error_detail = ?, finished_at = ? WHERE id = ?').run(status, code, detail ?? null, ctx.now(), job.id);
    ctx.grants.revokeJob(job.id);
    this.inputs.delete(job.id);
    const percent = Math.round((getJob(ctx, job.id)?.progress ?? 0) * 100);
    if (status === 'failed') emit(ctx, 'render.failed', { projectId: job.project_id, jobId: job.id, code, percent });
    else if (status === 'cancelled') emit(ctx, 'render.cancelled', { projectId: job.project_id, jobId: job.id, percent, notices: ['EM-3202'] });
    else emit(ctx, 'render.done', { projectId: job.project_id, jobId: job.id, ...extra });
    s2(ctx).events.emit('render.final', job.id);
  }

  private async run(jobId: string): Promise<void> {
    const ctx = this.ctx; const entry = this.inputs.get(jobId); const job0 = getJob(ctx, jobId);
    if (!entry || !job0) return;
    const { prep, input, outFile } = entry;
    const tmpDir = path.join(ctx.paths.tmp, `render-${jobId}`);
    const ctl: { cancel: () => void; reason: 'user' | 'stalled' | 'shutdown' | null } = { cancel: () => {}, reason: null };
    this.cancels.set(jobId, ctl);
    await s2(ctx).heavy.run(async () => {
      if (ctl.reason) { this.cancels.delete(jobId); this.finish(getJob(ctx, jobId)!, 'cancelled', null); return; }
      const startedAt = Date.now();
      ctx.db.prepare("UPDATE render_jobs SET status = 'rendering', started_at = ? WHERE id = ?").run(ctx.now(), jobId);
      const grant = ctx.grants.issueRender(input.projectId, jobId, prep.assetIds);
      const origins: string[] = [];
      let lastProgressAt = Date.now(); let samples = 0; let progress = 0;
      const tickSse = throttle(250), tickDb = throttle(1000);
      const report = (p: number, rendered: number | null, stage: 'preparing' | 'rendering' | 'encoding' | 'validating', force = false) => {
        progress = clamp01(p); lastProgressAt = Date.now(); samples++;
        const elapsed = Date.now() - startedAt;
        const etaMs = progress >= 0.05 && samples >= 3 ? Math.round((elapsed / progress) * (1 - progress)) : null;
        if (tickDb(force)) ctx.db.prepare('UPDATE render_jobs SET progress = ?, rendered_frames = ?, eta_ms = ? WHERE id = ?').run(progress, rendered, etaMs, jobId);
        if (tickSse(force)) emit(ctx, 'render.progress', { projectId: input.projectId, jobId, progress, renderedFrames: rendered, totalFrames: prep.frames, etaMs, stage });
      };
      const watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt > (this.opts.stallMs ?? 120_000) || Date.now() - startedAt > (this.opts.wallClockMs ?? 2 * 3_600_000)) { ctl.reason = 'stalled'; ctl.cancel(); }
      }, Math.min(5000, Math.max(50, Math.floor((this.opts.stallMs ?? 120_000) / 4))));
      let stage: 'compose' | 'render' | 'validate' = 'compose';
      try {
        report(0, 0, 'preparing', true);
        fs.mkdirSync(tmpDir, { recursive: true });
        const R = await (this.opts.renderer ?? loadRemotion)();
        const port = await (this.opts.remotionPort ?? defaultRemotionPort)(ctx);
        origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
        for (const o of origins) ctx.mediaOrigins.add(o);
        const { cancelSignal, cancel } = R.makeCancelSignal();
        ctl.cancel = cancel;
        if (ctl.reason) cancel();
        const base = `http://127.0.0.1:${ctx.cfg.port}/media/${grant.token}`;
        const assets: Record<string, Record<string, unknown>> = {};
        for (const id of prep.assetIds) {
          const a = getAsset(ctx, id)!;
          assets[id] = { kind: a.kind === 'subtitle' ? 'image' : a.kind, playable: `${base}/${id}/playable`, ...(a.proxy_path ? { proxy: `${base}/${id}/proxy` } : {}),
            ...(a.duration_ms !== null ? { durationMs: a.duration_ms } : {}), ...(a.width !== null ? { width: a.width } : {}), ...(a.height !== null ? { height: a.height } : {}), hasAudio: a.has_audio === 1 };
        }
        const inputProps = { model: prep.model, assets, quality: 'full', watermark: prep.watermark };
        const tier = ctx.hooks.tier(); const pol = PROFILE_POLICY[input.performanceProfile];
        const threads = os.cpus().length;
        const concurrency = input.performanceProfile === 'standard' ? 1 : Math.max(1, Math.min(input.performanceProfile === 'turbo' ? 4 : 2, Math.floor(threads / 2)));
        const common: Record<string, unknown> = { serveUrl: ctx.resources.engineBundle, inputProps, port, logLevel: 'error', timeoutInMilliseconds: 60_000,
          chromiumOptions: { gl: tier === 'T0' ? 'swangle' : 'angle' }, ...(ctx.resources.browserExecutable ? { browserExecutable: ctx.resources.browserExecutable } : {}),
          ...(ctx.resources.binariesDirectory ? { binariesDirectory: ctx.resources.binariesDirectory } : {}) };
        const composition = await R.selectComposition({ ...common, id: COMPOSITION_ID });
        stage = 'render';
        const tmpOut = path.join(tmpDir, `out.${EXT[prep.profile.format]}`);
        const f = prep.profile.format;
        if (f === 'png') {
          const frame = Math.min(composition.durationInFrames - 1, Math.round(((prep.profile.stillAtMs ?? 0) / 1000) * composition.fps));
          await R.renderStill({ ...common, composition, output: tmpOut, frame, imageFormat: 'png', cancelSignal });
        } else {
          const codec = f === 'mp4' ? 'h264' : f === 'webm' ? 'vp9' : f === 'gif' ? 'gif' : 'wav';
          await R.renderMedia({ ...common, composition, codec, outputLocation: tmpOut, cancelSignal, concurrency,
            imageFormat: prep.profile.alpha ? 'png' : 'jpeg', ...(prep.profile.alpha && f === 'webm' ? { pixelFormat: 'yuva420p' } : {}),
            ...(f === 'mp4' || f === 'webm' ? { crf: prep.profile.crf ?? 18 } : {}), ...(f === 'gif' ? { everyNthFrame: Math.max(1, Math.round(composition.fps / 15)) } : {}),
            ...(f === 'mp4' ? { audioBitrate: '192k' } : {}), offthreadVideoCacheSizeInBytes: pol.cache, disallowParallelEncoding: !pol.parallelEncoding,
            ...(tier === 'T2' && input.performanceProfile !== 'standard' ? { hardwareAcceleration: 'if-possible' } : {}),
            onProgress: (p: { progress: number; renderedFrames?: number; stitchStage?: string }) => report(p.progress * 0.97, p.renderedFrames ?? null, p.stitchStage === 'muxing' ? 'encoding' : 'rendering') });
        }
        stage = 'validate';
        report(0.98, prep.frames, 'validating', true);
        const v = await validateOutput(ctx, tmpOut, prep, composition);
        if (v.mismatch) {
          const failedDir = path.join(ctx.paths.outputs, '_failed'); fs.mkdirSync(failedDir, { recursive: true });
          await moveFile(tmpOut, path.join(failedDir, `${jobId}.${EXT[f]}`));
          this.finish(getJob(ctx, jobId)!, 'failed', 'EM-3205', v.mismatch);
          return;
        }
        await moveFile(tmpOut, outFile);
        const outputId = ctx.newId();
        let thumbRel: string | null = null;
        if (f === 'mp4' || f === 'webm' || f === 'gif') {
          const thumbDir = path.join(ctx.paths.outputs, input.projectId, '.thumbs'); fs.mkdirSync(thumbDir, { recursive: true });
          const thumb = path.join(thumbDir, `${outputId}.jpg`);
          try {
            await runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', '-ss', (0.35 * prep.durationMs / 1000).toFixed(3), '-i', outFile, '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '3', thumb], cwd: tmpDir, timeoutMs: 60_000 });
            thumbRel = outputRelPath(ctx, thumb);
          } catch { thumbRel = null; }
        }
        const bytes = fs.statSync(outFile).size;
        ctx.db.transaction(() => {
          ctx.db.prepare(`INSERT INTO outputs (id, project_id, render_job_id, path, thumb_path, kind, bytes, width, height, fps, duration_ms, validated, watermarked, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(outputId, input.projectId, jobId, outputRelPath(ctx, outFile), thumbRel, KIND[f], bytes, f === 'wav' ? null : composition.width,
            f === 'wav' ? null : composition.height, f === 'png' || f === 'wav' ? null : composition.fps, f === 'png' ? null : prep.durationMs, v.validated ? 1 : 0, prep.watermark ? 1 : 0, ctx.now());
          ctx.db.prepare('UPDATE render_jobs SET progress = 1, rendered_frames = ?, output_id = ?, eta_ms = 0 WHERE id = ?').run(prep.frames, outputId, jobId);
        })();
        this.finish(getJob(ctx, jobId)!, 'done', null, undefined, { output: toOutputDto(ctx, getOutput(ctx, outputId)!), notices: prep.notices.filter((n) => n !== 'EM-3208') });
      } catch (e) {
        const job = getJob(ctx, jobId)!;
        if (ctl.reason === 'user' || ctl.reason === 'shutdown') this.finish(job, 'cancelled', null);
        else if (ctl.reason === 'stalled') this.finish(job, 'failed', 'EM-3207', 'stalled');
        else {
          const msg = errorMessage(e);
          const code = e instanceof EmError ? e.code : stage === 'compose' ? 'EM-3002' : /ENOSPC|EACCES|EPERM|write/i.test(msg) && stage !== 'render' ? 'EM-3204' : 'EM-3201';
          ctx.log.error({ jobId, stage, err: msg.slice(0, 500) }, 'render failed');
          this.finish(job, 'failed', code, stage);
        }
      } finally {
        clearInterval(watchdog);
        for (const o of origins) ctx.mediaOrigins.delete(o);
        this.cancels.delete(jobId);
        ctx.grants.revokeJob(jobId);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
}

/** SEC-068 / FR-145: dimensions equal, duration ± 1 frame (+50 ms container slack). A missing ffprobe leaves `validated` false. */
async function validateOutput(ctx: ServiceContext, file: string, prep: Prepared, comp: { width: number; height: number; fps: number }): Promise<{ validated: boolean; mismatch?: string }> {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return { validated: false, mismatch: 'file: empty' };
  let pj;
  try { pj = await ffprobe(ctx.resources.ffprobe, file); } catch (e) {
    if ((e as { reason?: string }).reason === 'spawn') { ctx.log.warn({ err: errorMessage(e) }, 'output not validated (ffprobe unavailable)'); return { validated: false }; }
    return { validated: false, mismatch: 'probe: unreadable' };
  }
  const f = prep.profile.format;
  const v = pj.streams?.find((s) => s.codec_type === 'video');
  if (f !== 'wav') {
    if (!v || v.width !== comp.width || v.height !== comp.height) return { validated: false, mismatch: `dimensions: expected ${comp.width}x${comp.height}, got ${v?.width ?? 0}x${v?.height ?? 0}` };
  }
  if (f === 'mp4' || f === 'webm' || f === 'wav') {
    const d = Number(pj.format?.duration ?? NaN) * 1000;
    if (Number.isFinite(d) && Math.abs(d - prep.durationMs) > 1000 / comp.fps + 50) return { validated: false, mismatch: `duration: expected ${prep.durationMs}, got ${Math.round(d)}` };
  }
  return { validated: true };
}

function estimateOf(p: OutputProfileT, dims: { width: number; height: number }, frames: number, durationMs: number, tier: 'T0' | 'T1' | 'T2', perf: PerfProfile): Prepared['estimate'] {
  const px = dims.width * dims.height; const durS = durationMs / 1000;
  const baseMs = (tier === 'T0' ? 100 : tier === 'T1' ? 70 : 40) * (px / (1920 * 1080)) / (perf === 'standard' ? 1 : perf === 'accelerated' ? 1.6 : 2.5);
  const effFrames = p.format === 'png' ? 1 : p.format === 'gif' ? Math.ceil(frames / Math.max(1, Math.round(p.fps / 15))) : frames;
  const bytes = p.format === 'mp4' ? px * p.fps * 0.13 / 8 * durS + 24_000 * durS
    : p.format === 'webm' ? px * p.fps * 0.17 / 8 * durS
      : p.format === 'gif' ? px * Math.min(p.fps, 15) * durS * 0.05
        : p.format === 'png' ? px * 1.5 : 48_000 * 4 * durS;
  return { seconds: Math.max(1, Math.round((effFrames * baseMs) / 1000 + 3)), bytes: Math.round(bytes), confidence: 'low' };
}

const services = new WeakMap<ServiceContext, RenderService>();
export function renderServiceOf(ctx: ServiceContext, opts?: RenderOptions): RenderService {
  let s = services.get(ctx);
  if (!s) { s = new RenderService(ctx, opts); services.set(ctx, s); }
  return s;
}
