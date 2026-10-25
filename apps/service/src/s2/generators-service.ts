// Generator jobs (API_SPECIFICATION §6.13, LOCAL_AI_MODELS §3/§8, FR-100…FR-108): captions (whisper.cpp), voice (sherpa-onnx/Piper),
// music (ACE-Step or the CC0 loop library), thumbnail (frame + title via renderStill, or stable-diffusion.cpp), hashtags/social caption
// (connected LLM, ADR-009). One job at a time (JobRunner concurrency 1); every engine step runs under the Service-wide heavy lock.
// Generated media files are registered as Assets through the ingest pipeline; Insert goes through hooks.applyOps.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOperations, deriveTiming, type CompositionModelT, type GeneratedResult, type OperationT } from '@expertmotion/composition-model';
import { compileDefaults } from '@expertmotion/catalogue';
import { EmError, sanitizeFilename, timestamp } from '@expertmotion/shared';
import { JobRunner, createJobDir, defaultModelFor, defaultThreads, generateImage, generateMusic, removeJobDir, synthesize, transcribeToPages,
  type JobContext, type JobEvent, type ModelDef } from '@expertmotion/models';
import type { ServiceContext } from '../context.js';
import { em, emit } from './common.js';
import { getAsset, listAssets, toFacts } from './assets-repo.js';
import { ingestOf, inspectSource } from './ingest.js';
import { modelsServiceOf } from './models-service.js';
import { runTool } from './proc.js';
import { defaultRemotionPort, type RendererLike } from './render-service.js';
import { getOutput, outputRelPath, toOutputDto } from './render-repo.js';
import { s2, useModel } from './state.js';
import { assertEngineSpawnAllowed } from './spawn-gate.js';

export const GENERATOR_KINDS = ['voice', 'music', 'thumbnail', 'captions', 'hashtags'] as const;
/** FR-103: thumbnail styles: the title Text Layer variant in still mode, prompt wording in prompt mode. */
export const THUMBNAIL_STYLES = ['bold', 'clean', 'cinematic', 'playful'] as const;
export type ThumbnailStyle = (typeof THUMBNAIL_STYLES)[number];
const THUMB_VARIANT: Record<ThumbnailStyle, string> = { bold: 'preset:text.title', clean: 'preset:text.subtitle', cinematic: 'preset:text.quote', playful: 'preset:text.callout' };
const THUMB_PROMPT: Record<ThumbnailStyle, string> = { bold: 'bold high-contrast colours, strong subject', clean: 'clean minimal composition, soft light', cinematic: 'cinematic lighting, film look, shallow depth of field', playful: 'bright playful colours, fun mood' };
/** FR-105: hashtag / social caption tones. */
export const HASHTAG_TONES = ['casual', 'professional', 'energetic', 'informative', 'funny'] as const;
/** FR-104: caption style applied on Insert when the project has none (same default as op:caption.importSrt). */
export const DEFAULT_CAPTION_STYLE = 'preset:caption.editorial';
/** FR-102: an inserted music bed uses the preset:audio.bed-soft Compile defaults (volume, loop, fades). */
export function musicBedOp(assetId: string): OperationT {
  const cd = compileDefaults('preset:audio.bed-soft');
  return { op: 'op:audio.addBed', target: { kind: 'project' }, args: { volume: 0.2, loop: true, fadeInMs: 1000, fadeOutMs: 1000, ...(cd?.args ?? {}), assetId } } as OperationT;
}
/** FR-104: Sequence-mode transcription: pages of one clip's source audio moved onto the Sequence timeline (trim, rate, window). */
export function shiftPages(pages: unknown[], w: { fromMs: number; toMs: number; trimBeforeMs: number; playbackRate: number }): unknown[] {
  const at = (src: number) => Math.round(w.fromMs + (src - w.trimBeforeMs) / w.playbackRate);
  const out: unknown[] = [];
  for (const raw of pages) {
    const p = raw as { text: string; startMs: number; durationMs: number; tokens?: Array<{ text: string; fromMs: number; toMs: number }> };
    const start = at(p.startMs), end = at(p.startMs + p.durationMs);
    if (end <= w.fromMs || start >= w.toMs) continue;
    const s0 = Math.max(w.fromMs, start), e0 = Math.min(w.toMs, end);
    out.push({ ...p, startMs: s0, durationMs: Math.max(1, e0 - s0), tokens: (p.tokens ?? []).map((t) => ({ ...t, fromMs: Math.max(s0, at(t.fromMs)), toMs: Math.min(e0, Math.max(at(t.fromMs), at(t.toMs))) })) });
  }
  return out;
}
export type GeneratorKind = (typeof GENERATOR_KINDS)[number];
/** ADR-016 priority tag per Generator Card (FR-100). */
export const GENERATOR_PRIORITY: Record<GeneratorKind, 'P1' | 'P2'> = { voice: 'P1', captions: 'P1', hashtags: 'P1', music: 'P2', thumbnail: 'P2' };
/** FR-108: results that were not inserted stay listed for 7 days. */
export const GENERATED_RETENTION_MS = 7 * 24 * 3_600_000;
const TIER_RANK = { T0: 0, T1: 1, T2: 2 } as const;
const MODEL_TASKS: Record<Exclude<GeneratorKind, 'hashtags'>, ReadonlyArray<ModelDef['task']>> = { captions: ['stt'], voice: ['tts'], music: ['music', 'library'], thumbnail: ['image'] };

export interface EngineStepCtx { engineDir: string; jobDir: string; signal: AbortSignal; onProgress: (f: number) => void }
/** Engine steps (default: packages/models adapters). Tests inject fakes; nothing here knows engine argv. */
export interface GeneratorEngines {
  captions(i: { modelPath: string; wavPath: string; language: string; audioDurationMs: number }, c: EngineStepCtx): Promise<{ pages: unknown[]; language: string | null }>;
  voice(i: { modelDir: string; text: string; speed?: number }, c: EngineStepCtx): Promise<{ wavPath: string }>;
  music(i: { modelDir: string; prompt: string; durationMs: number; seed: number; tier: 'T0' | 'T1' | 'T2' }, c: EngineStepCtx): Promise<{ wavPath: string }>;
  image(i: { model: ModelDef; modelDir: string; prompt: string; width: number; height: number; seed: number; tier: 'T0' | 'T1' | 'T2' }, c: EngineStepCtx): Promise<{ pngPath: string }>;
  frame(i: { model: CompositionModelT; projectId: string; frameMs: number; outPath: string; assetIds: string[] }, c: EngineStepCtx & { ctx: ServiceContext; jobId: string }): Promise<void>;
}
export interface GeneratorsOptions {
  /** Kinds enabled in this build; others answer EM-9004 (API §6.13: a P0 build passes []). Default: all. */
  enabledKinds?: readonly GeneratorKind[];
  engines?: Partial<GeneratorEngines>;
  enginesDir?: string;
  renderer?: () => Promise<RendererLike>;
}

const threads = () => defaultThreads(os.cpus().length);
const firstWith = (dir: string, re: RegExp): string => { const f = fs.readdirSync(dir).find((n) => re.test(n)); if (!f) throw em('EM-7108', 'The installed model file is damaged.'); return path.join(dir, f); };
function defaultEngines(opts: GeneratorsOptions): GeneratorEngines {
  const ectx = (c: EngineStepCtx) => ({ engineDir: c.engineDir, jobDir: c.jobDir, signal: c.signal, onProgress: c.onProgress });
  return {
    captions: async (i, c) => { const r = await transcribeToPages({ modelPath: i.modelPath, wavPath: i.wavPath, language: i.language, threads: threads(), audioDurationMs: i.audioDurationMs }, ectx(c)); return { pages: r.pages, language: r.language }; },
    voice: async (i, c) => {
      // Kokoro (sherpa-onnx export) ships a voice table; Piper/VITS voices are one .onnx + tokens.txt.
      const kokoro = fs.existsSync(path.join(i.modelDir, 'voices.bin'));
      const lexicon = path.join(i.modelDir, 'lexicon-us-en.txt');
      const voice = kokoro
        ? { kind: 'kokoro' as const, modelPath: path.join(i.modelDir, 'model.onnx'), voicesPath: path.join(i.modelDir, 'voices.bin'), tokensPath: path.join(i.modelDir, 'tokens.txt'),
            ...(fs.existsSync(lexicon) ? { lexiconPath: lexicon } : {}) }
        : { kind: 'vits' as const, modelPath: firstWith(i.modelDir, /\.onnx$/), tokensPath: path.join(i.modelDir, 'tokens.txt') };
      return synthesize({ voice, text: i.text, threads: threads(), ...(i.speed !== undefined ? { speed: i.speed } : {}) }, ectx(c));
    },
    music: async (i, c) => {
      const python = path.join(c.engineDir, process.platform === 'win32' ? 'python.exe' : 'python');
      return generateMusic({ pythonExe: python, modelDir: i.modelDir, prompt: i.prompt, durationMs: i.durationMs, seed: i.seed, device: i.tier === 'T2' ? 'cuda' : 'cpu', offload: i.tier === 'T1' }, ectx(c));
    },
    image: async (i, c) => {
      const model = i.model.key.startsWith('flux')
        ? { kind: 'flux' as const, diffusionModelPath: firstWith(i.modelDir, /\.gguf$/), clipLPath: path.join(i.modelDir, 'clip_l.safetensors'), t5xxlPath: firstWith(i.modelDir, /^t5xxl/), vaePath: path.join(i.modelDir, 'ae.safetensors') }
        : { kind: 'sd15' as const, modelPath: firstWith(i.modelDir, /\.safetensors$/) };
      return generateImage({ model, prompt: i.prompt, width: i.width, height: i.height, seed: i.seed, threads: threads(), tier: i.tier }, ectx(c));
    },
    frame: async (i, c) => {
      const ctx = c.ctx;
      const R = await (opts.renderer ?? (async () => (await import('@remotion/renderer')) as unknown as RendererLike))();
      const grant = ctx.grants.issueRender(i.projectId, c.jobId, i.assetIds);
      const port = await defaultRemotionPort(ctx);
      const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
      for (const o of origins) ctx.mediaOrigins.add(o);
      try {
        const base = `http://127.0.0.1:${ctx.cfg.port}/media/${grant.token}`;
        const assets: Record<string, unknown> = {};
        for (const id of i.assetIds) { const a = getAsset(ctx, id); if (a) assets[id] = { kind: a.kind === 'subtitle' ? 'image' : a.kind, playable: `${base}/${id}/playable`, ...(a.duration_ms !== null ? { durationMs: a.duration_ms } : {}) }; }
        const { cancelSignal, cancel } = R.makeCancelSignal();
        c.signal.addEventListener('abort', () => cancel(), { once: true });
        const common = { serveUrl: ctx.resources.engineBundle, inputProps: { model: i.model, assets, quality: 'full' }, port, logLevel: 'error',
          chromiumOptions: { gl: ctx.hooks.tier() === 'T0' ? 'swangle' : 'angle' }, ...(ctx.resources.browserExecutable ? { browserExecutable: ctx.resources.browserExecutable } : {}),
          ...(ctx.resources.binariesDirectory ? { binariesDirectory: ctx.resources.binariesDirectory } : {}) };
        const composition = await R.selectComposition({ ...common, id: 'ExpertmotionTimeline' });
        const frame = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round((i.frameMs / 1000) * composition.fps)));
        await R.renderStill({ ...common, composition, frame, output: i.outPath, imageFormat: 'png', cancelSignal });
      } finally { for (const o of origins) ctx.mediaOrigins.delete(o); ctx.grants.revokeJob(c.jobId); }
    },
  };
}

interface GenRow { id: string; project_id: string; kind: GeneratorKind; input_json: string; model_key: string | null; status: string; progress: number; result_asset_id: string | null;
  result_json: string | null; error_code: string | null; created_at: string; started_at: string | null; finished_at: string | null }
export const toGenDto = (r: GenRow): Record<string, unknown> => ({ id: r.id, projectId: r.project_id, kind: r.kind, status: r.status, progress: r.progress, modelKey: r.model_key,
  resultAssetId: r.result_asset_id, result: r.result_json ? JSON.parse(r.result_json) as unknown : null, errorCode: r.error_code, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at });

interface Prepared { modelKey: string | null; run: (j: JobContext) => Promise<{ assetId?: string; result: Record<string, unknown>; ops?: OperationT[] }> }

export class GeneratorsService {
  private readonly runner: JobRunner;
  private readonly engines: GeneratorEngines;
  private readonly inserts = new Map<string, boolean>();
  constructor(private readonly ctx: ServiceContext, private readonly opts: GeneratorsOptions = {}) {
    this.engines = { ...defaultEngines(opts), ...(opts.engines ?? {}) };
    this.runner = new JobRunner({ emit: (e) => this.onEvent(e), concurrency: 1, progressIntervalMs: 500, newId: ctx.newId, keepFinished: 20 });
  }
  get(id: string): GenRow | undefined { return this.ctx.db.prepare('SELECT * FROM generator_jobs WHERE id = ?').get(id) as GenRow | undefined; }
  idle(): Promise<void> { return this.runner.idle(); }

  recover(): number {
    this.purge();
    return this.ctx.db.prepare("UPDATE generator_jobs SET status = 'failed', error_code = 'EM-8003', finished_at = ? WHERE status IN ('queued','running')").run(this.ctx.now()).changes;
  }
  /** FR-108: jobs older than 7 days leave the "Generated" list (rows only; imported Assets stay in the Asset Panel). */
  purge(nowMs = Date.parse(this.ctx.now())): number {
    const cutoff = new Date(nowMs - GENERATED_RETENTION_MS).toISOString();
    return this.ctx.db.prepare("DELETE FROM generator_jobs WHERE created_at < ? AND status NOT IN ('queued','running')").run(cutoff).changes;
  }
  /** R-137: remove a job from the "Generated" list (a running job is cancelled first). */
  remove(id: string): boolean {
    const r = this.get(id); if (!r) return false;
    if (r.status === 'queued' || r.status === 'running') this.runner.cancel(id);
    this.ctx.db.prepare('DELETE FROM generator_jobs WHERE id = ?').run(id);
    return true;
  }
  /** R-135: Generator Cards (FR-100, FR-107): enabled in this build, priority, required model with installed state, size and tier hint. */
  async cards(): Promise<Array<Record<string, unknown>>> {
    const ctx = this.ctx; const tier = ctx.hooks.tier(); const models = modelsServiceOf(ctx);
    const lang = ctx.settings.get().defaultLanguage;
    const enabled = this.opts.enabledKinds ?? GENERATOR_KINDS;
    const out: Array<Record<string, unknown>> = [];
    for (const kind of GENERATOR_KINDS) {
      const base = { kind, enabled: enabled.includes(kind), priority: GENERATOR_PRIORITY[kind] };
      if (kind === 'hashtags') { out.push({ ...base, model: null, models: [], llm: true, tierHint: 'ok' }); continue; }
      const task = kind === 'captions' ? 'stt' : kind === 'voice' ? 'tts' : kind === 'music' ? 'music' : 'image';
      const defKey = defaultModelFor(task, tier, { language: lang });
      const list = await Promise.all(models.defs().filter((d) => MODEL_TASKS[kind].includes(d.task)).map(async (d) => ({
        key: d.key, label: d.label, bytes: d.bytes, installed: await models.isInstalled(d.key), languages: d.languages, minTier: d.minTier, belowTier: TIER_RANK[tier] < TIER_RANK[d.minTier],
        cc0: d.engine === 'loops' })));
      const def = list.find((m) => m.key === defKey) ?? null;
      // frame-composite (T0 thumbnails) needs no model: a still of the current frame plus the title (LOCAL_AI_MODELS §5)
      const model = def ?? (defKey === 'frame-composite' ? { key: defKey, label: 'Frame + title', bytes: 0, installed: true, languages: [], minTier: 'T0', belowTier: false, cc0: false } : null);
      out.push({ ...base, model, models: list, llm: false, tierHint: model?.belowTier ? 'slow' : 'ok', tier });
    }
    return out;
  }
  enginesDir(): string { return this.opts.enginesDir ?? this.ctx.resources.enginesDir; }
  /** `<engines>/<engine>/` or its single version sub-folder (LOCAL_AI_MODELS §3.1 `resources/engines/<engine>/<version>/`). */
  engineDir(engine: string): string {
    const d = path.join(this.enginesDir(), engine);
    try { const subs = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()); if (subs.length === 1) return path.join(d, subs[0]!.name); } catch { /* missing */ }
    return d;
  }

  private onEvent(e: JobEvent): void {
    const ctx = this.ctx; const j = e.job; const now = ctx.now();
    if (e.type === 'running') ctx.db.prepare("UPDATE generator_jobs SET status = 'running', started_at = ? WHERE id = ?").run(now, j.id);
    else if (e.type === 'progress') ctx.db.prepare('UPDATE generator_jobs SET progress = ? WHERE id = ?').run(j.progress, j.id);
    else if (e.type === 'failed' || e.type === 'cancelled') ctx.db.prepare('UPDATE generator_jobs SET status = ?, error_code = ?, finished_at = ? WHERE id = ?').run(e.type, j.error?.code ?? null, now, j.id);
    else if (e.type === 'done') {
      const r = e.result as { assetId?: string; result: Record<string, unknown> };
      ctx.db.prepare("UPDATE generator_jobs SET status = 'done', progress = 1, result_asset_id = ?, result_json = ?, finished_at = ? WHERE id = ?").run(r.assetId ?? null, JSON.stringify(r.result), now, j.id);
    }
    if (e.type !== 'queued') emit(ctx, 'service.notice', { kind: 'generator', projectId: j.projectId, jobId: j.id, generator: j.kind, status: j.status, percent: Math.round(j.progress * 100),
      done: e.type === 'done' || e.type === 'failed' || e.type === 'cancelled', ...(j.error ? { code: j.error.code } : {}) });
    if (e.type === 'done' || e.type === 'failed' || e.type === 'cancelled') { if (j.modelKey) useModel(ctx, j.modelKey, -1); this.inserts.delete(j.id); s2(ctx).events.emit('generator.final', j.id); }
  }

  async create(projectId: string, kind: GeneratorKind, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ctx = this.ctx;
    if (!(this.opts.enabledKinds ?? GENERATOR_KINDS).includes(kind)) throw em('EM-9004', `"${kind}" is not available in this version of Expertmotion yet.`, { status: 422, details: { feature: `generator.${kind}` } });
    const prep = await this.prepare(projectId, kind, body);
    const id = ctx.newId();
    ctx.db.prepare("INSERT INTO generator_jobs (id, project_id, kind, input_json, model_key, status, progress, created_at) VALUES (?,?,?,?,?,'queued',0,?)")
      .run(id, projectId, kind, JSON.stringify(body), prep.modelKey, ctx.now());
    if (prep.modelKey) useModel(ctx, prep.modelKey, 1);
    this.inserts.set(id, body['insert'] === true);
    this.runner.submit({ id, kind, projectId, ...(prep.modelKey ? { modelKey: prep.modelKey } : {}), run: async (j) => {
      const out = await prep.run(j);
      if (out.ops) out.ops = this.withCaptionStyle(projectId, out.ops);
      if (this.inserts.get(id) && out.ops?.length) {
        const versionId = ctx.hooks.applyOps(projectId, out.ops, { kind: 'generator', ref: id, summary: `Inserted generated ${kind}` });
        out.result['versionId'] = versionId;
      }
      if (out.ops) out.result['proposedOps'] = out.ops;
      return out;
    } });
    return toGenDto(this.get(id)!);
  }
  /** R-134: insert a finished job's result later (no re-run). Idempotent: a second call returns the same version with notice EM-2308. */
  /** FR-104: caption Insert also sets the default caption style when the project has none yet. */
  private withCaptionStyle(projectId: string, ops: OperationT[]): OperationT[] {
    if (!ops.some((o) => o.op === 'op:caption.setPages') || ops.some((o) => o.op === 'op:caption.setStyle')) return ops;
    let styled = true;
    try { styled = this.ctx.hooks.composition(projectId).model.tracks.caption.styleId !== null; } catch { /* no head: leave as is */ }
    return styled ? ops : [...ops, { op: 'op:caption.setStyle', target: { kind: 'project' }, args: { presetId: DEFAULT_CAPTION_STYLE } } as OperationT];
  }
  insertResult(id: string, override: { pages?: unknown[]; assetId?: string; atMs?: number } = {}): { versionId: string; notice?: string } | undefined {
    const ctx = this.ctx; const r = this.get(id); if (!r) return undefined;
    if (r.status !== 'done') throw em('EM-9002', 'This result is not ready yet.', { status: 422, details: { reason: 'not-done', status: r.status } });
    const result = (r.result_json ? JSON.parse(r.result_json) : {}) as Record<string, unknown>;
    if (typeof result['versionId'] === 'string') return { versionId: result['versionId'], notice: 'EM-2308' };
    let ops = result['proposedOps'] as OperationT[] | undefined;
    let jobs: Record<string, GeneratedResult> | undefined;
    if (!ops?.length) throw em('EM-9002', 'This result has nothing to insert.', { status: 422, details: { reason: 'no-ops' } });
    // FR-104: the Creator may edit caption text in the preview before Insert; timings stay the engine's
    if (override.pages && r.kind === 'captions') ops = ops.map((o) => (o.op === 'op:caption.setPages' ? { ...o, args: { ...o.args, pages: override.pages } } as OperationT : o));
    // FR-103: Insert as overlay = op:generated.insert {kind: thumbnail, jobId, atMs} with the chosen candidate as the job result (an image overlay at the playhead)
    if (r.kind === 'thumbnail') {
      const cands = new Set([r.result_asset_id, ...((result['candidates'] as Array<{ assetId: string }> | undefined) ?? []).map((c) => c.assetId)].filter(Boolean));
      if (override.assetId && !cands.has(override.assetId)) throw em('EM-9002', 'Invalid request: assetId is not a result of this job.', { status: 400, path: 'body.assetId' });
      const first = ops.find((o) => o.op === 'op:overlay.addImage');
      const chosen = override.assetId ?? String((first?.args as { assetId?: unknown } | undefined)?.assetId ?? r.result_asset_id ?? '');
      const atMs = override.atMs ?? Number((first?.args as { atMs?: unknown } | undefined)?.atMs ?? 0);
      jobs = { [id]: { kind: 'thumbnail', assetId: chosen } };
      ops = [{ op: 'op:generated.insert', target: { kind: 'project' }, args: { kind: 'thumbnail', jobId: id, atMs } } as OperationT];
    }
    ops = this.withCaptionStyle(r.project_id, ops);
    const versionId = ctx.hooks.applyOps(r.project_id, ops, { kind: 'generator', ref: id, summary: `Inserted generated ${r.kind}`, ...(jobs ? { jobs } : {}) });
    ctx.db.prepare('UPDATE generator_jobs SET result_json = ? WHERE id = ?').run(JSON.stringify({ ...result, versionId }), id);
    return { versionId };
  }
  /** R-136 (FR-103): copy a thumbnail candidate into the Project output folder as an Output (kind still). */
  saveOutput(id: string, assetId: string): Record<string, unknown> | undefined {
    const ctx = this.ctx; const r = this.get(id); if (!r) return undefined;
    if (r.status !== 'done') throw em('EM-9002', 'This result is not ready yet.', { status: 422, details: { reason: 'not-done', status: r.status } });
    const result = (r.result_json ? JSON.parse(r.result_json) : {}) as { candidates?: Array<{ assetId: string }>; assetId?: string };
    const allowed = new Set([r.result_asset_id, result.assetId, ...(result.candidates ?? []).map((c) => c.assetId)].filter(Boolean));
    if (!allowed.has(assetId)) throw em('EM-9002', 'Invalid request: assetId is not a result of this job.', { status: 400, path: 'body.assetId' });
    const a = getAsset(ctx, assetId, r.project_id); if (!a) throw em('EM-9003', 'Not found.');
    const src = path.resolve(ctx.paths.media, a.original_path);
    if (!fs.existsSync(src)) throw em('EM-1301', 'The generated file is missing.');
    const project = ctx.db.prepare('SELECT name FROM projects WHERE id = ?').get(r.project_id) as { name: string } | undefined;
    const folder = ctx.settings.get().outputFolder ? path.resolve(ctx.settings.get().outputFolder!) : path.join(ctx.paths.outputs, r.project_id);
    try { fs.mkdirSync(folder, { recursive: true }); fs.accessSync(folder, fs.constants.W_OK); } catch { throw em('EM-3206', 'Expertmotion cannot save files in this folder.', { details: { folder: path.basename(folder) } }); }
    const stem = sanitizeFilename(`${project?.name ?? 'thumbnail'}-thumbnail-${timestamp().slice(0, 13)}`, 'thumbnail');
    let file = path.join(folder, `${stem}.png`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(folder, `${stem}-${i}.png`);
    fs.copyFileSync(src, file);
    const head = ctx.hooks.composition(r.project_id);
    const jobId = ctx.newId(); const outputId = ctx.newId(); const at = ctx.now();
    const profile = { ...head.model.settings, format: 'png', codec: 'png', alpha: false };
    ctx.db.transaction(() => {
      ctx.db.prepare("INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, progress, created_at, started_at, finished_at) VALUES (?,?,?,?,'standard','done',1,?,?,?)")
        .run(jobId, r.project_id, head.versionId, JSON.stringify(profile), at, at, at);
      ctx.db.prepare(`INSERT INTO outputs (id, project_id, render_job_id, path, thumb_path, kind, bytes, width, height, fps, duration_ms, validated, watermarked, created_at)
        VALUES (?,?,?,?,NULL,'still',?,?,?,NULL,NULL,1,0,?)`).run(outputId, r.project_id, jobId, outputRelPath(ctx, file), fs.statSync(file).size, a.width, a.height, at);
      ctx.db.prepare('UPDATE render_jobs SET output_id = ? WHERE id = ?').run(outputId, jobId);
    })();
    return toOutputDto(ctx, getOutput(ctx, outputId)!);
  }
  cancel(id: string): Record<string, unknown> | undefined {
    const r = this.get(id); if (!r) return undefined;
    this.runner.cancel(id);
    return toGenDto(this.get(id)!);
  }

  private async requireInstalled(key: string, tool: string): Promise<ModelDef> {
    const models = modelsServiceOf(this.ctx); const def = models.def(key);
    if (!def || !(await models.isInstalled(key))) throw em('EM-7001', `"${tool}" needs the ${def?.label ?? key} model.`, { details: { modelKey: key, bytes: def?.bytes ?? null } });
    return def;
  }
  /** Engine step under the heavy lock, in a per-job temp dir (SEC-062). */
  private async engineStep<T>(j: JobContext, engine: string, stage: string, fn: (c: EngineStepCtx) => Promise<T>): Promise<T> {
    return s2(this.ctx).heavy.run(async () => {
      if (j.signal.aborted) throw new EmError('EM-7101', 'cancelled');
      await assertEngineSpawnAllowed(this.ctx, engine, this.engineDir(engine));   // SEC-066 Private Mode / network need, SEC-061 hashes
      j.progress(0.05, stage);
      return fn({ engineDir: this.engineDir(engine), jobDir: path.join(this.ctx.paths.tmp, 'jobs', j.jobId), signal: j.signal, onProgress: (f) => j.progress(0.05 + f * 0.8, stage) });
    });
  }
  /** Copies an engine output into the project as an Asset (ingest pipeline) and waits for it. */
  private async register(projectId: string, file: string, name: string): Promise<string> {
    const s = await inspectSource(file, name);
    const ingest = ingestOf(this.ctx);
    await ingest.checkCapacity(projectId, s.bytes);
    const row = ingest.importFile({ projectId, source: file, name, kind: s.kind, bytes: s.bytes, ext: s.ext, move: true });
    const o = await ingest.whenSettled(row.id);
    if (o.status === 'duplicate' && o.row) return o.row.id;
    if (o.status !== 'ready' || !o.row) throw em('EM-7101', 'The generated file could not be imported.', { details: { reason: o.status } });
    return o.row.id;
  }
  private withJobDir<T>(j: JobContext, fn: () => Promise<T>): Promise<T> {
    return (async () => { await createJobDir(this.ctx.paths.tmp, j.jobId); try { return await fn(); } finally { await removeJobDir(this.ctx.paths.tmp, j.jobId).catch(() => undefined); } })();
  }

  /** FR-104: captions for the Sequence audio: each video Clip's audio segment is transcribed and its pages placed on the timeline. */
  private async prepareSequenceCaptions(projectId: string, b: Record<string, unknown>, tier: 'T0' | 'T1' | 'T2'): Promise<Prepared> {
    const ctx = this.ctx; const models = modelsServiceOf(ctx);
    const head = ctx.hooks.composition(projectId).model;
    const timing = deriveTiming(head);
    const segs = head.tracks.video.flatMap((c) => {
      const a = getAsset(ctx, c.assetId, projectId); const w = timing.elementWindows[c.id];
      if (!a || !w || a.kind !== 'video' || a.status !== 'ready' || a.has_audio !== 1 || c.muted) return [];
      return [{ src: path.resolve(ctx.paths.media, a.playable_path ?? a.original_path), trimBeforeMs: c.trimBeforeMs, playbackRate: c.playbackRate, fromMs: w.fromMs, toMs: w.toMs }];
    });
    if (!segs.length) throw em('EM-7103', 'The Sequence has no audio to transcribe.', { details: { tool: 'captions.generate', reason: 'no-audio' } });
    if (timing.durationMs > 1_800_000) throw em('EM-1011', 'This Sequence is longer than 30 minutes.', { details: { reason: 'duration' } });
    const key = typeof b['modelKey'] === 'string' ? b['modelKey'] : defaultModelFor('stt', tier);
    const def = await this.requireInstalled(key, 'Generate Captions');
    const language = String(b['language'] ?? 'id');
    return { modelKey: def.key, run: (j) => this.withJobDir(j, async () => {
      const modelPath = firstWith(models.dirOf(def), /\.bin$/);
      const pages: unknown[] = []; let detected: string | null = null;
      for (const [i, sg] of segs.entries()) {
        const srcMs = Math.max(100, Math.round((sg.toMs - sg.fromMs) * sg.playbackRate));
        const wav = path.join(ctx.paths.tmp, 'jobs', j.jobId, `seg-${i + 1}.wav`);
        await s2(ctx).heavy.run(() => runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', '-ss', (sg.trimBeforeMs / 1000).toFixed(3), '-t', (srcMs / 1000).toFixed(3), '-i', sg.src,
          '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], cwd: path.dirname(wav), timeoutMs: Math.max(60_000, srcMs), signal: j.signal }));
        const r = await this.engineStep(j, 'whisper.cpp', 'transcribe', (c) => this.engines.captions({ modelPath, wavPath: wav, language, audioDurationMs: srcMs }, { ...c, onProgress: (f) => c.onProgress((i + f) / segs.length) }));
        detected ??= r.language;
        // the extracted segment starts at the clip's trim point: page times are relative to it
        pages.push(...shiftPages(r.pages, { fromMs: sg.fromMs, toMs: sg.toMs, trimBeforeMs: 0, playbackRate: sg.playbackRate }));
      }
      return { result: { pages, language: detected, modelId: def.key, durationMs: timing.durationMs, source: 'sequence' }, ops: [{ op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages } } as OperationT] };
    }) };
  }
  private async prepare(projectId: string, kind: GeneratorKind, b: Record<string, unknown>): Promise<Prepared> {
    const ctx = this.ctx; const tier = ctx.hooks.tier(); const models = modelsServiceOf(ctx);
    const lang = b['language'];
    if (lang !== undefined && lang !== 'id' && lang !== 'en') throw em('EM-7105', 'Only Indonesian and English are supported.', { details: { tool: kind, language: lang } });
    const short = (id: string) => id.slice(-8).toLowerCase();

    if (kind === 'captions' && (b['source'] === 'sequence' || b['assetId'] === undefined)) return this.prepareSequenceCaptions(projectId, b, tier);
    if (kind === 'captions') {
      const asset = getAsset(ctx, String(b['assetId']), projectId);
      if (!asset) throw em('EM-9003', 'Not found.');
      if (asset.status !== 'ready') throw em('EM-1301', `"${asset.name}" is not ready yet.`, { status: 422 });
      if (asset.has_audio !== 1) throw em('EM-7103', `"${asset.name}" has no audio to transcribe.`, { details: { tool: 'captions.generate', reason: 'no-audio' } });
      if ((asset.duration_ms ?? 0) > 1_800_000) throw em('EM-1011', 'This clip is longer than 30 minutes.', { details: { reason: 'duration' } });
      const key = typeof b['modelKey'] === 'string' ? b['modelKey'] : defaultModelFor('stt', tier);
      const def = await this.requireInstalled(key, 'Generate Captions');
      const src = path.resolve(ctx.paths.media, asset.playable_path ?? asset.original_path);
      return { modelKey: def.key, run: (j) => this.withJobDir(j, async () => {
        const wav = path.join(ctx.paths.tmp, 'jobs', j.jobId, 'in.wav');
        await s2(ctx).heavy.run(() => runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', '-i', src, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
          cwd: path.dirname(wav), timeoutMs: Math.max(60_000, asset.duration_ms ?? 0), signal: j.signal }));
        const modelPath = firstWith(models.dirOf(def), /\.bin$/);
        const r = await this.engineStep(j, 'whisper.cpp', 'transcribe', (c) => this.engines.captions({ modelPath, wavPath: wav, language: String(lang ?? 'id'), audioDurationMs: asset.duration_ms ?? 0 }, c));
        return { result: { pages: r.pages, language: r.language, modelId: def.key, durationMs: asset.duration_ms }, ops: [{ op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages: r.pages } }] };
      }) };
    }
    if (kind === 'voice') {
      const text = String(b['text'] ?? '');
      if ([...text].length > 2000) throw em('EM-7106', 'Voice generation accepts up to 2,000 characters at a time.', { details: { chars: [...text].length, limit: 2000 } });
      const def = await this.requireInstalled(String(b['voiceId']), 'Generate Voice');
      if (def.task !== 'tts') throw em('EM-9002', 'Invalid request: voiceId is not a voice.', { status: 400, path: 'body.voiceId' });
      const atMs = typeof b['atMs'] === 'number' ? b['atMs'] : 0;
      return { modelKey: def.key, run: (j) => this.withJobDir(j, async () => {
        const r = await this.engineStep(j, 'sherpa-onnx', 'synthesize', (c) => this.engines.voice({ modelDir: models.dirOf(def), text, ...(typeof b['speed'] === 'number' ? { speed: b['speed'] } : {}) }, c));
        j.progress(0.9, 'ingest');
        const assetId = await this.register(projectId, r.wavPath, `voice-${short(j.jobId)}.wav`);
        return { assetId, result: { assetId, waveform: true }, ops: [{ op: 'op:audio.addLayer', args: { assetId, atMs, volume: 1, role: 'voice' } }] };
      }) };
    }
    if (kind === 'music') {
      const key = typeof b['modelKey'] === 'string' ? b['modelKey'] : defaultModelFor('music', tier);
      const def = await this.requireInstalled(key, 'Generate Music');
      const durationMs = Number(b['durationMs']);
      const vocals = lang === 'en' ? ', English vocals' : ', Indonesian vocals';   // FR-106: the language of sung lyrics
      const prompt = `${String(b['prompt'] ?? '')}${typeof b['style'] === 'string' && b['style'] ? `, ${b['style']}` : ''}${b['instrumental'] === false ? vocals : ', instrumental'}`;
      return { modelKey: def.key, run: (j) => this.withJobDir(j, async () => {
        const seed = crypto.createHash('sha256').update(prompt).digest().readUInt32BE(0);
        let wav: string; let source: 'ace-step' | 'loop-library';
        if (def.engine === 'loops') {
          source = 'loop-library';
          const dir = models.dirOf(def);
          const loops = fs.readdirSync(dir).filter((n) => /\.(wav|mp3|m4a|ogg|flac)$/i.test(n)).sort();
          if (!loops.length) throw em('EM-7108', 'The installed loop library is damaged.');
          wav = path.join(ctx.paths.tmp, 'jobs', j.jobId, 'out.wav');
          await this.engineStep(j, 'loops', 'generate', () => runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', '-stream_loop', '-1', '-i', path.join(dir, loops[seed % loops.length]!),
            '-t', (durationMs / 1000).toFixed(3), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', wav], cwd: path.dirname(wav), timeoutMs: 120_000, signal: j.signal }));
        } else {
          source = 'ace-step';
          wav = (await this.engineStep(j, 'ace-step', 'generate', (c) => this.engines.music({ modelDir: models.dirOf(def), prompt, durationMs, seed, tier }, c))).wavPath;
        }
        j.progress(0.9, 'ingest');
        const assetId = await this.register(projectId, wav, `music-${short(j.jobId)}.wav`);
        return { assetId, result: { assetId, durationMs, source, instrumental: b['instrumental'] !== false, cc0: source === 'loop-library' }, ops: [musicBedOp(assetId)] };
      }) };
    }
    if (kind === 'thumbnail') {
      const prompt = typeof b['prompt'] === 'string' ? b['prompt'] : undefined;
      const size = (b['size'] as { w?: number; h?: number } | undefined) ?? {};
      const count = Math.max(1, Math.min(4, typeof b['count'] === 'number' ? Math.round(b['count']) : 1));   // FR-103: 1–4 candidates
      const style = (THUMBNAIL_STYLES as readonly string[]).includes(String(b['style'])) ? b['style'] as ThumbnailStyle : 'bold';
      const title = typeof b['titleText'] === 'string' && b['titleText'].trim() ? b['titleText'].trim().slice(0, 500) : '';
      const atMs = typeof b['frameMs'] === 'number' ? b['frameMs'] : 0;
      const overlay = (assetId: string): OperationT[] => [{ op: 'op:overlay.addImage', args: { assetId, atMs } } as OperationT];
      if (prompt) {
        // FR-103: style wording and the title text go into the diffusion prompt (prompt mode has no separate overlay pass)
        const fullPrompt = [prompt, THUMB_PROMPT[style], ...(title ? [`thumbnail with the title text "${title}"`] : [])].join(', ');
        let key = defaultModelFor('image', tier);
        if (key === 'frame-composite') key = 'sd15-emaonly';
        const def = await this.requireInstalled(key, 'Generate Thumbnail');
        return { modelKey: def.key, run: (j) => this.withJobDir(j, async () => {
          const candidates: Array<{ assetId: string; seed: number }> = [];
          for (let i = 0; i < count; i++) {
            const seed = crypto.randomInt(0, 2 ** 31);
            const r = await this.engineStep(j, 'stable-diffusion.cpp', 'diffuse', (c) => this.engines.image({ model: def, modelDir: models.dirOf(def), prompt: fullPrompt, width: size.w ?? 1280, height: size.h ?? 720, seed, tier },
              { ...c, onProgress: (f) => c.onProgress((i + f) / count) }));
            candidates.push({ assetId: await this.register(projectId, r.pngPath, `thumbnail-${short(j.jobId)}-${i + 1}.png`), seed });
          }
          j.progress(0.9, 'ingest');
          const assetId = candidates[0]!.assetId;
          return { assetId, result: { assetId, candidates, source: def.key.startsWith('flux') ? 'flux' : 'sd15', style, prompt: fullPrompt }, ops: overlay(assetId) };
        }) };
      }
      const head = ctx.hooks.composition(projectId);
      if (head.model.tracks.video.length === 0) throw em('EM-2202', 'Insert at least one asset first.');
      let model = structuredClone(head.model);
      const frameMs = typeof b['frameMs'] === 'number' ? b['frameMs'] : 0;
      if (title) {
        const r = applyOperations(model, [{ op: 'op:text.add', args: { text: title, variant: THUMB_VARIANT[style], atMs: frameMs, durationMs: 1000 } }],
          { assets: listAssets(ctx, projectId).map(toFacts), tier, newId: ctx.newId });
        if (r.ok) model = r.value.model;
      }
      const assetIds = [...new Set([...model.tracks.video.map((c) => c.assetId), ...model.tracks.audio.map((a) => a.assetId)])];
      // candidates: the chosen frame first, then frames spread over the Sequence (still + title overlay each)
      const durationMs = Math.max(1, deriveTiming(model).durationMs);
      const times = [...new Set(Array.from({ length: count }, (_, i) => (i === 0 ? frameMs : Math.round((frameMs + (i * durationMs) / (count + 1)) % durationMs))))];
      return { modelKey: null, run: (j) => this.withJobDir(j, async () => {
        const candidates: Array<{ assetId: string; frameMs: number }> = [];
        for (const [i, at] of times.entries()) {
          const out = path.join(ctx.paths.tmp, 'jobs', j.jobId, `still-${i + 1}.png`);
          await this.engineStep(j, 'none', 'still', (c) => this.engines.frame({ model, projectId, frameMs: at, outPath: out, assetIds }, { ...c, onProgress: (f) => c.onProgress((i + f) / times.length), ctx, jobId: j.jobId }));
          candidates.push({ assetId: await this.register(projectId, out, `thumbnail-${short(j.jobId)}-${i + 1}.png`), frameMs: at });
        }
        j.progress(0.9, 'ingest');
        const assetId = candidates[0]!.assetId;
        return { assetId, result: { assetId, candidates, source: 'frame-composite', frameMs, style }, ops: overlay(assetId) };
      }) };
    }
    // hashtags / social caption text (FR-105, ADR-009): connected LLM; never touches the Composition Model
    if (ctx.settings.get().privateMode) throw em('EM-8202', 'Private Mode is on, so "Suggest Hashtags" was not sent to the internet.', { details: { action: 'Suggest Hashtags' } });
    ctx.hooks.budgetCheck(projectId);
    const provider = ctx.hooks.providerFor('brainstorm', projectId);
    const project = ctx.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    let texts: string[] = [];
    try { const m = ctx.hooks.composition(projectId).model; texts = [...m.tracks.text.map((t) => t.text), ...m.tracks.caption.pages.map((p) => p.text)].slice(0, 60); } catch { /* no composition yet */ }
    const count = Number(b['count'] ?? 15); const platform = String(b['platform'] ?? 'instagram');
    const tone = (HASHTAG_TONES as readonly string[]).includes(String(b['tone'])) ? String(b['tone']) : 'casual';   // FR-105
    return { modelKey: provider.model, run: async (j) => {
      j.progress(0.1, 'ask');
      const r = await provider.complete({ system: 'You write social media captions. Write in the requested language and tone. Reply with JSON only: {"caption": string, "hashtags": string[]}. Hashtags start with #, no spaces.',
        messages: [{ role: 'user', content: JSON.stringify({ language: lang ?? 'id', platform, tone, count, title: project?.name ?? '', texts }).slice(0, 8000) }], maxTokens: 800, temperature: 0.7, signal: j.signal, timeoutMs: 60_000 });
      ctx.hooks.recordUsage(projectId, 'brainstorm', j.jobId, [r.usage]);
      let parsed: { caption?: unknown; hashtags?: unknown };
      try { parsed = JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as typeof parsed; } catch (e) { throw em('EM-7103', 'The model did not return hashtags.', { cause: e }); }
      const hashtags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : []).map((h) => String(h).trim().replace(/\s+/g, '')).filter((h) => /^#[\p{L}\p{N}_]+$/u.test(h)).slice(0, count);
      if (!hashtags.length || typeof parsed.caption !== 'string') throw em('EM-7103', 'The model did not return hashtags.');
      return { result: { caption: parsed.caption.slice(0, 2200), hashtags, modelId: provider.model, tone } };
    } };
  }
}

const services = new WeakMap<ServiceContext, GeneratorsService>();
export function generatorsServiceOf(ctx: ServiceContext, opts?: GeneratorsOptions): GeneratorsService {
  let s = services.get(ctx); if (!s) { s = new GeneratorsService(ctx, opts); services.set(ctx, s); } return s;
}

