// Render queue (API_SPECIFICATION §6.11, PERFORMANCE §2/§7, ARCHITECTURE §6.2): preflight + estimate, one Render Job at a time,
// renderMedia/renderStill from the prebuilt Engine bundle with a per-job media grant, progress SSE, ffprobe validation, Outputs.
// @remotion/renderer is imported lazily inside the job so the Service (and its tests) start without Chrome.
import { availableMemBytes } from '../services/memory.js';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deriveFrameTiming, deriveTiming, type CompositionModelT } from '@expertmotion/composition-model';
import { EmError, errorMessage, sanitizeFilename, timestamp, type EmCode } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { SerialQueue, clamp01, em, emit, freeBytes, isInside, requireProject, throttle } from './common.js';
import { getAsset } from './assets-repo.js';
import { ffprobe, type ProbeJson } from './probe.js';
import { moveFile } from './ingest.js';
import { getEngineLog, runTool } from './proc.js';
import { defaultOutputFolder, getJob, getOutput, outputRelPath, outputRoots, profileDims, toJobDto, toOutputDto, type OutputProfileT, type RenderJobRow } from './render-repo.js';
import { s2 } from './state.js';
import { engineBrowserOf, type BrowserLike } from '../services/engine-browser.js';
import { engineStatus } from './engine-check.js';

/** FR-137 default filename stem: `<project>-<ratio>-<res>-<yyyymmdd-hhmm>` (the extension follows the codec). */
export function defaultFileStem(projectName: string, profile: Pick<OutputProfileT, 'ratio' | 'resolution'>, d: Date = new Date()): string {
  const ratio = profile.ratio === 'custom' ? 'custom' : profile.ratio.replace(':', 'x');
  return sanitizeFilename(`${projectName}-${ratio}-${profile.resolution}-${timestamp(d).slice(0, 13)}`, 'video');
}
/** GIF via palette generation (FR-147): ≤ 15 fps, one palette per clip, Sierra dithering, endless loop. */
export function gifPaletteArgs(input: string, output: string, fps: number): string[] {
  const f = Math.min(15, fps);
  // `-r` instead of the fps filter: the slim compositor FFmpeg has no fps filter, the full ingestion build has both
  return ['-v', 'error', '-nostdin', '-y', '-i', input, '-filter_complex', '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a', '-r', String(f), '-loop', '0', output];
}

export type PerfProfile = 'standard' | 'accelerated' | 'turbo';
export interface RenderInput { projectId: string; versionId?: string | undefined; outputProfile: OutputProfileT; performanceProfile: PerfProfile; fileName?: string | undefined; folder?: string | undefined }
export interface Check { check: 'disk' | 'memory' | 'dimensions' | 'duration' | 'assets' | 'engine' | 'folder'; ok: boolean; code?: string; details?: Record<string, unknown> }

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
  /** Remotion's own bundle server port (never 3000/4000): dev 4130…4139, packaged a free port in 42300…42399. */
  remotionPort?: (ctx: ServiceContext) => Promise<number>;
  stallMs?: number;
  wallClockMs?: number;
  /** SEC-011 render starts per minute (default 5). */
  maxStartsPerMinute?: number;
  /** Dev/tests only: when ffprobe cannot run, keep the Output with `validated: false` instead of failing it (FR-145 default: fail). */
  acceptUnvalidated?: boolean;
  /** FR-204: how long a job waits for free memory before it starts in low-memory mode (default 90 s), and the poll step (3 s). */
  lowMemWaitMs?: number;
  lowMemPollMs?: number;
}

const COMPOSITION_ID = 'ExpertmotionTimeline';
// FR-204 (QA 2026-10-27, T0 laptop with 0.5–1.1 GB available): free memory never blocks an export any more. Below the
// comfortable amount the job waits (queued, EM-3107) for up to LOW_MEM_WAIT_MS, then renders in low-memory mode (one frame at
// a time, small video cache); only below MEM_FLOOR after the wait it fails with EM-3108 and the next action. Measured on the
// 1.9 GB server: a 6 s 720p render peaks ≈ 700 MB for the whole Service + Chrome Headless Shell + compositor.
const MB = 1024 ** 2;
const MEM_NEED: Record<PerfProfile, number> = { standard: 2 * 1024 ** 3, accelerated: 3 * 1024 ** 3, turbo: 4 * 1024 ** 3 };
/** Comfortable free memory for the Standard profile by output size (≤ 720p, ≤ 1080p, larger); faster profiles keep MEM_NEED. */
export function memoryNeed(profile: PerfProfile, dims: { width: number; height: number }): number {
  if (profile !== 'standard') return MEM_NEED[profile];
  const px = dims.width * dims.height;
  return px <= 1280 * 720 ? 900 * MB : px <= 1920 * 1080 ? 1200 * MB : MEM_NEED.standard;
}
export const MEM_FLOOR = 300 * MB;
const LOW_MEM_WAIT_MS = 90_000;
const LOW_MEM_CACHE = 64 * MB;
const EXT: Record<OutputProfileT['format'], string> = { mp4: 'mp4', webm: 'webm', gif: 'gif', png: 'png', wav: 'wav' };
const KIND: Record<OutputProfileT['format'], 'video' | 'gif' | 'still' | 'audio'> = { mp4: 'video', webm: 'video', gif: 'gif', png: 'still', wav: 'audio' };
const PROFILE_POLICY: Record<PerfProfile, { cache: number; parallelEncoding: boolean }> = {
  standard: { cache: 256 * 1024 ** 2, parallelEncoding: false }, accelerated: { cache: 512 * 1024 ** 2, parallelEncoding: true }, turbo: { cache: 1024 ** 3, parallelEncoding: true },
};

export async function defaultRemotionPort(ctx: ServiceContext): Promise<number> {
  const [lo, hi] = ctx.cfg.dev ? [4130, 4139] : [42300, 42399];
  for (let p = lo; p <= hi; p++) {
    if (p === ctx.cfg.port || p === 3000 || p === 4000) continue;
    const free = await new Promise<boolean>((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
    if (free) return p;
  }
  throw em('EM-3002', 'The rendering engine could not start (no free port).');
}
const loadRemotion = async (): Promise<RendererLike> => (await import('@remotion/renderer')) as unknown as RendererLike;

interface Prepared {
  model: CompositionModelT; versionId: string; profile: OutputProfileT; dims: { width: number; height: number }; frames: number; durationMs: number;
  assetIds: string[]; checks: Check[]; warnings: Array<{ code: string; path: string; message: string; severity: 'info' | 'warn' }>; notices: string[];
  estimate: { seconds: number | null; bytes: number | null; confidence: 'low' | 'medium' | 'high' };
  defaultFileName: string; privateMode: boolean; queue: { active: string | null; queued: number };
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
    const r = this.ctx.db.prepare("UPDATE render_jobs SET status = 'failed', error_code = 'EM-3203', error_detail = 'interrupted', failed_frame = CASE WHEN status = 'rendering' THEN rendered_frames END, finished_at = ? WHERE status IN ('queued','rendering')").run(now);
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
    const profile: OutputProfileT = { ...input.outputProfile };   // single edition: no resolution cap, never a watermark
    // FR-138: WebM with alpha only when the background is None (or absent); the Editor disables the option with a reason
    if (profile.alpha && profile.format === 'webm' && model.background && model.background.presetId !== 'preset:background.none')
      throw em('EM-9002', 'A transparent WebM needs the background set to None.', { status: 422, path: 'outputProfile.alpha', details: { reason: 'alpha-needs-background-none', background: model.background.presetId } });
    // FR-138: GIF is capped at 720p (and 15 fps at encode time)
    if (profile.format === 'gif' && profile.resolution !== '720p') { warnings.push({ code: 'EM-3103', path: 'outputProfile.resolution', message: `GIF exports are limited to 720p (${profile.resolution} chosen).`, severity: 'info' }); profile.resolution = '720p'; }
    if (ctx.hooks.tier() === 'T0' && (profile.resolution === '2k' || profile.resolution === '2160p')) warnings.push({ code: 'EM-3105', path: 'outputProfile.resolution', message: `${profile.resolution} needs a graphics card; 1080p is the highest option here.`, severity: 'info' });
    model.settings = { ...model.settings, ratio: profile.ratio, resolution: profile.resolution, fps: profile.fps, ...(profile.ratio === 'custom' && profile.customRatio ? { customRatio: profile.customRatio } : {}) };

    let dims = { width: 0, height: 0 };
    try { dims = profileDims(profile); } catch { /* reported below */ }
    const dimOk = dims.width >= 240 && dims.height >= 240 && dims.width <= 4096 && dims.height <= 4096 && dims.width % 2 === 0 && dims.height % 2 === 0;
    checks.push({ check: 'dimensions', ok: dimOk, ...(dimOk ? {} : { code: 'EM-3103' }), details: dims });

    const timing = deriveTiming(model); const frames = deriveFrameTiming(model).durationInFrames;
    // ADR-030: a video without media (scene clips, or only texts / shapes / a voice-over) renders too; only an empty one is refused.
    const empty = model.tracks.video.length === 0 && model.tracks.text.length === 0 && model.tracks.overlay.length === 0 && !model.tracks.audio.some((a) => a.durationMs !== undefined);
    const durOk = !empty && timing.durationMs >= 1000 && timing.durationMs <= 1_800_000;
    checks.push({ check: 'duration', ok: durOk, ...(durOk ? {} : { code: empty ? 'EM-2202' : 'EM-3104' }), details: { durationMs: timing.durationMs } });

    const assetIds = [...new Set([...model.tracks.video.flatMap((c) => (c.assetId ? [c.assetId] : [])), ...model.tracks.audio.map((a) => a.assetId),
      ...model.tracks.overlay.map((o) => (o as { assetId?: string }).assetId).filter((x): x is string => typeof x === 'string')])];
    await ctx.hooks.mediaCheck?.(input.projectId).catch(() => undefined);    // FR-048: hash check before render (changed copies re-ingest)
    const missing = assetIds.filter((id) => {
      const a = getAsset(ctx, id, input.projectId);
      return !a || a.status !== 'ready' || !a.playable_path || !fs.existsSync(path.resolve(ctx.paths.media, a.playable_path)) || !fs.existsSync(path.resolve(ctx.paths.media, a.original_path));
    });
    checks.push({ check: 'assets', ok: missing.length === 0, ...(missing.length ? { code: 'EM-1301', details: { assetIds: missing } } : {}) });

    const eng = await engineStatus(ctx);   // FR-140: Headless Shell, compositor FFmpeg, bundle hash
    checks.push({ check: 'engine', ok: eng.ok, ...(eng.code ? { code: eng.code, details: { missing: eng.missing, mismatched: eng.mismatched.slice(0, 20) } } : {}) });

    const estimate = estimateOf(profile, dims, frames, timing.durationMs, ctx.hooks.tier(), input.performanceProfile);
    const folder = this.folderFor(input);
    // FR-137: the folder must be on the allow-list and writable (nearest existing parent when it does not exist yet)
    const custom = input.folder !== undefined || Boolean(ctx.settings.get().outputFolder);
    const allowed = !custom || outputRoots(ctx).some((r) => isInside(r, folder) || path.resolve(r) === folder);
    let writable = allowed;
    if (allowed) { let d = folder; while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d); try { fs.accessSync(d, fs.constants.W_OK); } catch { writable = false; } }
    checks.push({ check: 'folder', ok: allowed && writable, ...(allowed ? writable ? {} : { code: 'EM-3206' } : { code: 'EM-8302' }), details: { folder: path.basename(folder) } });
    const free = await freeBytes(fs.existsSync(folder) ? folder : ctx.paths.outputs);
    const needDisk = 3 * (estimate.bytes ?? 0) + 500_000_000;
    checks.push({ check: 'disk', ok: free >= needDisk, ...(free >= needDisk ? {} : { code: 'EM-3102' }), details: { needBytes: needDisk, freeBytes: free } });
    // EM_TEST_FREE_MEM_MB: development-only fault injection (GOLDEN_SCENARIOS §1 EM_TEST_*), ignored in packaged builds.
    const testMem = ctx.cfg.dev ? Number(process.env['EM_TEST_FREE_MEM_MB'] ?? NaN) : NaN;
    const mem = Number.isFinite(testMem) ? testMem * 1048576 : (this.opts.freeMemBytes ?? availableMemBytes)();
    const needMem = memoryNeed(input.performanceProfile, dims);
    // FR-204: an info note, never a block — the job waits for memory and then runs in low-memory mode.
    checks.push({ check: 'memory', ok: true, ...(mem >= needMem ? {} : { code: 'EM-3107' }), details: { needBytes: needMem, freeBytes: mem } });
    if (this.queue.size > 0) notices.push('EM-3208');
    const projectName = (ctx.db.prepare('SELECT name FROM projects WHERE id = ?').get(input.projectId) as { name: string } | undefined)?.name ?? 'video';
    return { model, versionId, profile, dims, frames, durationMs: timing.durationMs, assetIds, checks, warnings, notices, estimate,
      defaultFileName: defaultFileStem(projectName, profile), privateMode: ctx.settings.get().privateMode, queue: { active: this.queue.running, queued: Math.max(0, this.queue.size - (this.queue.running ? 1 : 0)) } };
  }

  estimateResponse(p: Prepared): Record<string, unknown> {
    return { ok: p.checks.every((c) => c.ok), dimensions: p.dims, totalFrames: p.frames, durationMs: p.durationMs, estimate: p.estimate, checks: p.checks,
      effectiveProfile: p.profile, warnings: p.warnings, notices: p.notices, defaultFileName: p.defaultFileName, privateMode: p.privateMode, queue: p.queue };
  }

  /** FR-009/FR-015: a project's own output folder (R-018 `outputFolder`) beats the app default. */
  private projectFolder(projectId: string): string | undefined {
    try {
      const r = this.ctx.db.prepare("SELECT json_extract(settings_json, '$.outputFolder') AS f FROM projects WHERE id = ?").get(projectId) as { f: unknown } | undefined;
      return typeof r?.f === 'string' && r.f ? r.f : undefined;
    } catch { return undefined; }
  }
  private folderFor(input: RenderInput): string {
    const chosen = input.folder ?? this.projectFolder(input.projectId) ?? this.ctx.settings.get().outputFolder;
    return chosen ? path.resolve(chosen) : defaultOutputFolder(this.ctx, input.projectId);
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
    if (failed) throw em(failed.code as EmCode, `Export preflight failed (${failed.check}).`, { status: failed.code === 'EM-3001' || failed.code === 'EM-3003' ? 503 : failed.code === 'EM-8302' ? 403 : 422, ...(failed.details ? { details: failed.details } : {}) });
    const folder = this.folderFor(input);
    if (input.folder !== undefined || this.projectFolder(input.projectId) || ctx.settings.get().outputFolder) {
      if (!outputRoots(ctx).some((r) => isInside(r, folder) || path.resolve(r) === folder)) throw em('EM-8302', 'Expertmotion can only save to folders inside your user profile.');
    }
    try { fs.mkdirSync(folder, { recursive: true }); fs.accessSync(folder, fs.constants.W_OK); } catch { throw em('EM-3206', 'Expertmotion cannot save files in this folder.', { details: { folder: path.basename(folder) } }); }
    requireProject(ctx, input.projectId);
    const stem = input.fileName?.trim() ? sanitizeFilename(input.fileName.replace(/\.(mp4|webm|gif|png|wav)$/i, ''), 'video') : prep.defaultFileName;
    const ext = EXT[prep.profile.format];
    let outFile = path.join(folder, `${stem}.${ext}`);
    for (let i = 2; fs.existsSync(outFile) || [...this.inputs.values()].some((x) => x.outFile === outFile); i++) outFile = path.join(folder, `${stem}-${i}.${ext}`);

    ctx.hooks.checkpoint?.(input.projectId, 'pre-render');           // FR-165: checkpoint right before the render starts
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

  private finish(job: RenderJobRow, status: 'done' | 'failed' | 'cancelled', code: string | null, detail?: string, extra: Record<string, unknown> = {}, failedFrame: number | null = null): void {
    const ctx = this.ctx;
    ctx.db.prepare('UPDATE render_jobs SET status = ?, error_code = ?, error_detail = ?, failed_frame = ?, finished_at = ? WHERE id = ?').run(status, code, detail ?? null, status === 'failed' ? failedFrame : null, ctx.now(), job.id);
    ctx.grants.revokeJob(job.id);
    this.inputs.delete(job.id);
    const percent = Math.round((getJob(ctx, job.id)?.progress ?? 0) * 100);
    if (status === 'failed') emit(ctx, 'render.failed', { projectId: job.project_id, jobId: job.id, code, percent, frame: status === 'failed' ? failedFrame : null });
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
      // FR-204: wait (queued, EM-3107) for free memory, then start anyway in low-memory mode; fail only below MEM_FLOOR.
      const testMem = ctx.cfg.dev ? Number(process.env['EM_TEST_FREE_MEM_MB'] ?? NaN) : NaN;
      const freeMem = () => (Number.isFinite(testMem) ? testMem * MB : (this.opts.freeMemBytes ?? availableMemBytes)());
      const need = memoryNeed(input.performanceProfile, prep.dims);
      let mem = freeMem(); let lowMem = false;
      if (mem < need) {
        const waitMs = this.opts.lowMemWaitMs ?? LOW_MEM_WAIT_MS; const pollMs = this.opts.lowMemPollMs ?? 3000;
        ctx.log.info({ jobId, freeMb: Math.round(mem / MB), needMb: Math.round(need / MB), waitMs }, 'render waiting for free memory');
        // Sent now and again after each poll that is still short (≤ every 10 s): the POST /renders answer, which carries no
        // notice, can reach the Editor after the first one (found in the packaged e2e run, Entry 29).
        const waiting = () => emit(ctx, 'render.queued', { projectId: input.projectId, jobId, job: { ...toJobDto(getJob(ctx, jobId)!), notices: ['EM-3107'] } });
        waiting();
        const until = Date.now() + waitMs; let lastSent = Date.now(); let polls = 0;
        while (Date.now() < until && !ctl.reason && mem < need) {
          await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, until - Date.now()))));
          mem = freeMem(); polls++;
          if (mem < need && (polls === 1 || Date.now() - lastSent >= 10_000)) { waiting(); lastSent = Date.now(); }
        }
        if (ctl.reason) { this.cancels.delete(jobId); this.finish(getJob(ctx, jobId)!, 'cancelled', null); return; }
        if (mem < MEM_FLOOR) {
          ctx.log.warn({ jobId, freeMb: Math.round(mem / MB), floorMb: Math.round(MEM_FLOOR / MB) }, 'render not started: not enough free memory');
          this.cancels.delete(jobId); this.finish(getJob(ctx, jobId)!, 'failed', 'EM-3108', 'low-memory'); return;
        }
        lowMem = mem < need;
        if (lowMem) ctx.log.info({ jobId, freeMb: Math.round(mem / MB) }, 'render starts in low-memory mode');
      }
      const startedAt = Date.now();
      ctx.db.prepare("UPDATE render_jobs SET status = 'rendering', started_at = ? WHERE id = ?").run(ctx.now(), jobId);
      const grant = ctx.grants.issueRender(input.projectId, jobId, prep.assetIds);
      const origins: string[] = [];
      let lastProgressAt = Date.now(); let samples = 0; let progress = 0; let lastFrame: number | null = null;   // FR-143: frame of a failure
      const tickSse = throttle(250), tickDb = throttle(1000);
      const report = (p: number, rendered: number | null, stage: 'preparing' | 'rendering' | 'encoding' | 'validating', force = false) => {
        progress = clamp01(p); lastProgressAt = Date.now(); samples++;
        if (rendered !== null && stage === 'rendering') lastFrame = rendered;
        const elapsed = Date.now() - startedAt;
        const etaMs = progress >= 0.05 && samples >= 3 ? Math.round((elapsed / progress) * (1 - progress)) : null;
        if (tickDb(force)) ctx.db.prepare('UPDATE render_jobs SET progress = ?, rendered_frames = ?, eta_ms = ? WHERE id = ?').run(progress, rendered, etaMs, jobId);
        if (tickSse(force)) emit(ctx, 'render.progress', { projectId: input.projectId, jobId, progress, renderedFrames: rendered, totalFrames: prep.frames, etaMs, stage });
      };
      const watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt > (this.opts.stallMs ?? 120_000) || Date.now() - startedAt > (this.opts.wallClockMs ?? 2 * 3_600_000)) { ctl.reason = 'stalled'; ctl.cancel(); }
      }, Math.min(5000, Math.max(50, Math.floor((this.opts.stallMs ?? 120_000) / 4))));
      let stage: 'compose' | 'render' | 'validate' = 'compose';
      let warm: BrowserLike | null = null;                   // FR-003: the warmed Engine browser, borrowed for this job
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
        const inputProps = { model: prep.model, assets, quality: 'full' };
        const tier = ctx.hooks.tier(); const pol = PROFILE_POLICY[input.performanceProfile];
        const threads = os.cpus().length;
        const concurrency = input.performanceProfile === 'standard' || lowMem ? 1 : Math.max(1, Math.min(input.performanceProfile === 'turbo' ? 4 : 2, Math.floor(threads / 2)));
        const common: Record<string, unknown> = { serveUrl: ctx.resources.engineBundle, inputProps, port, logLevel: 'error', timeoutInMilliseconds: 60_000,
          chromiumOptions: { gl: tier === 'T0' ? 'swangle' : 'angle' }, ...(ctx.resources.browserExecutable ? { browserExecutable: ctx.resources.browserExecutable } : {}),
          ...(ctx.resources.binariesDirectory ? { binariesDirectory: ctx.resources.binariesDirectory } : {}) };
        warm = this.opts.renderer ? null : await (engineBrowserOf(ctx)?.acquire() ?? Promise.resolve(null));
        if (warm) common['puppeteerInstance'] = warm;
        const composition = await R.selectComposition({ ...common, id: COMPOSITION_ID });
        stage = 'render';
        const tmpOut = path.join(tmpDir, `out.${EXT[prep.profile.format]}`);
        const f = prep.profile.format;
        if (f === 'png') {
          const frame = Math.min(composition.durationInFrames - 1, Math.round(((prep.profile.stillAtMs ?? 0) / 1000) * composition.fps));
          await R.renderStill({ ...common, composition, output: tmpOut, frame, imageFormat: 'png', cancelSignal });
        } else {
          // GIF: render a near-lossless H.264 intermediate, then palettegen/paletteuse with the ingestion FFmpeg (FR-147)
          const codec = f === 'mp4' || f === 'gif' ? 'h264' : f === 'webm' ? 'vp9' : 'wav';
          const mediaOut = f === 'gif' ? path.join(tmpDir, 'gif-source.mp4') : tmpOut;
          await R.renderMedia({ ...common, composition, codec, outputLocation: mediaOut, cancelSignal, concurrency,
            imageFormat: prep.profile.alpha ? 'png' : 'jpeg', ...(prep.profile.alpha && f === 'webm' ? { pixelFormat: 'yuva420p' } : {}),
            ...(f === 'mp4' || f === 'webm' ? { crf: prep.profile.crf ?? 18 } : {}), ...(f === 'gif' ? { crf: 12, muted: true } : {}),
            ...(f === 'mp4' ? { audioBitrate: '192k' } : {}), offthreadVideoCacheSizeInBytes: lowMem ? LOW_MEM_CACHE : pol.cache, disallowParallelEncoding: lowMem || !pol.parallelEncoding,
            ...(tier === 'T2' && input.performanceProfile !== 'standard' ? { hardwareAcceleration: 'if-possible' } : {}),
            onProgress: (p: { progress: number; renderedFrames?: number; stitchStage?: string }) => report(p.progress * (f === 'gif' ? 0.9 : 0.97), p.renderedFrames ?? null, p.stitchStage === 'muxing' ? 'encoding' : 'rendering') });
          if (f === 'gif') {
            report(0.92, prep.frames, 'encoding', true);
            const gifCancel = new AbortController(); const prevCancel = ctl.cancel;
            ctl.cancel = () => { gifCancel.abort(); prevCancel(); };
            if (ctl.reason) gifCancel.abort();
            await runTool({ exe: ctx.resources.ffmpeg, args: gifPaletteArgs(mediaOut, tmpOut, prep.profile.fps), cwd: tmpDir, timeoutMs: Math.max(120_000, prep.durationMs * 20), signal: gifCancel.signal });
          }
        }
        stage = 'validate';
        report(0.98, prep.frames, 'validating', true);
        const v = await validateOutput(ctx, tmpOut, prep, composition, this.opts.acceptUnvalidated);
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
            f === 'wav' ? null : composition.height, f === 'png' || f === 'wav' ? null : composition.fps, f === 'png' ? null : prep.durationMs, v.validated ? 1 : 0, 0, ctx.now());   // outputs.watermarked: legacy column, always 0
          ctx.db.prepare('UPDATE render_jobs SET progress = 1, rendered_frames = ?, output_id = ?, eta_ms = 0 WHERE id = ?').run(prep.frames, outputId, jobId);
        })();
        this.finish(getJob(ctx, jobId)!, 'done', null, undefined, { output: toOutputDto(ctx, getOutput(ctx, outputId)!), notices: prep.notices.filter((n) => n !== 'EM-3208') });
      } catch (e) {
        const job = getJob(ctx, jobId)!;
        if (ctl.reason === 'user' || ctl.reason === 'shutdown') this.finish(job, 'cancelled', null);
        else if (ctl.reason === 'stalled') this.finish(job, 'failed', 'EM-3207', 'stalled', {}, lastFrame);
        else {
          const msg = errorMessage(e);
          const code = e instanceof EmError ? e.code : stage === 'compose' ? 'EM-3002' : /ENOSPC|EACCES|EPERM|write/i.test(msg) && stage !== 'render' ? 'EM-3204' : 'EM-3201';
          ctx.log.error({ jobId, stage, err: msg.slice(0, 500) }, 'render failed');
          getEngineLog()?.error({ jobId, stage, code, err: msg.slice(0, 4000) }, 'render failed');
          this.finish(job, 'failed', code, stage, {}, stage === 'compose' ? null : failedFrameOf(e, lastFrame));
        }
      } finally {
        if (warm) engineBrowserOf(ctx)?.release(getJob(ctx, jobId)?.status === 'done');
        clearInterval(watchdog);
        for (const o of origins) ctx.mediaOrigins.delete(o);
        this.cancels.delete(jobId);
        ctx.grants.revokeJob(jobId);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
}

/** FR-143: the frame a render failed at: Remotion errors carry `frame` (or say "frame N"); otherwise the last reported frame. */
export function failedFrameOf(e: unknown, lastFrame: number | null): number | null {
  const f = (e as { frame?: unknown } | null)?.frame;
  if (typeof f === 'number' && Number.isInteger(f) && f >= 0) return f;
  const m = /\bframe\s+(?:#|no\.?\s*)?(\d+)/i.exec(errorMessage(e));
  return m ? Number(m[1]) : lastFrame;
}

/** FR-145: the Composition Model has audible audio (an audio layer, or an unmuted video clip whose asset has audio). */
export function modelHasAudio(model: CompositionModelT, assetHasAudio: (assetId: string) => boolean): boolean {
  return model.tracks.audio.some((a) => a.volume > 0) || model.tracks.video.some((c) => !c.muted && c.volume > 0 && c.assetId !== undefined && assetHasAudio(c.assetId));
}

const probeRate = (r?: string): number => { if (!r) return 0; const [a, b] = r.split('/').map(Number); return b ? (a ?? 0) / b : Number(a ?? 0); };

/**
 * SEC-068 / FR-145 pure check of an ffprobe result: dimensions equal, duration ± 1 frame (+50 ms container slack), fps equal
 * (video formats), audio stream present when the model has audio. Returns the first mismatch as "field: expected …, got …".
 */
export function probeMismatch(pj: ProbeJson, exp: { format: OutputProfileT['format']; width: number; height: number; fps: number; durationMs: number; audio: boolean }): string | null {
  const f = exp.format;
  const v = pj.streams?.find((st) => st.codec_type === 'video');
  if (f !== 'wav' && (!v || v.width !== exp.width || v.height !== exp.height)) return `dimensions: expected ${exp.width}x${exp.height}, got ${v?.width ?? 0}x${v?.height ?? 0}`;
  if (f === 'mp4' || f === 'webm' || f === 'wav') {
    const d = Number(pj.format?.duration ?? NaN) * 1000;
    if (Number.isFinite(d) && Math.abs(d - exp.durationMs) > 1000 / exp.fps + 50) return `duration: expected ${exp.durationMs}, got ${Math.round(d)}`;
  }
  if ((f === 'mp4' || f === 'webm') && v) {
    const got = probeRate(v.avg_frame_rate) || probeRate(v.r_frame_rate);
    if (!(got > 0) || Math.abs(got - exp.fps) > 0.01) return `fps: expected ${exp.fps}, got ${Math.round(got * 100) / 100}`;
  }
  if ((f === 'mp4' || f === 'webm' || f === 'wav') && exp.audio && !pj.streams?.some((st) => st.codec_type === 'audio')) return 'audio: expected an audio stream, got none';
  return null;
}

/**
 * SEC-068 / FR-145 / NFR-026: an Output is marked done only after ffprobe verified it. A missing or unrunnable ffprobe is a
 * failed check (EM-3205 "probe: unavailable", file kept) unless `acceptUnvalidated` (dev/tests only) keeps `validated` false.
 */
async function validateOutput(ctx: ServiceContext, file: string, prep: Prepared, comp: { width: number; height: number; fps: number }, acceptUnvalidated = false): Promise<{ validated: boolean; mismatch?: string }> {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return { validated: false, mismatch: 'file: empty' };
  let pj: ProbeJson;
  try { pj = await ffprobe(ctx.resources.ffprobe, file); } catch (e) {
    if ((e as { reason?: string }).reason === 'spawn') {
      ctx.log.warn({ err: errorMessage(e) }, 'output not validated (ffprobe unavailable)');
      return acceptUnvalidated ? { validated: false } : { validated: false, mismatch: 'probe: ffprobe unavailable' };
    }
    return { validated: false, mismatch: 'probe: unreadable' };
  }
  const audio = modelHasAudio(prep.model, (id) => getAsset(ctx, id)?.has_audio === 1);
  const mismatch = probeMismatch(pj, { format: prep.profile.format, width: comp.width, height: comp.height, fps: comp.fps, durationMs: prep.durationMs, audio });
  return mismatch ? { validated: false, mismatch } : { validated: true };
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
