// Generator jobs (API_SPECIFICATION §6.13, LOCAL_AI_MODELS §3/§8, FR-100…FR-108): captions (whisper.cpp), voice (sherpa-onnx/Piper),
// music (ACE-Step or the CC0 loop library), thumbnail (frame + title via renderStill, or stable-diffusion.cpp), hashtags/social caption
// (connected LLM, ADR-009). One job at a time (JobRunner concurrency 1); every engine step runs under the Service-wide heavy lock.
// Generated media files are registered as Assets through the ingest pipeline; Insert goes through hooks.applyOps.
import { settledCaptureMs } from './thumbnail-frame.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scriptPages, type ToolModel } from '@expertmotion/agents';
import { applyOperations, deriveTiming, type CompositionModelT, type GeneratedResult, type OperationT } from '@expertmotion/composition-model';
import { compileDefaults } from '@expertmotion/catalogue';
import { EmError, sanitizeFilename, timestamp } from '@expertmotion/shared';
import { SUPERTONIC_FILES, CancelledError, JobRunner, createJobDir, defaultModelFor, defaultThreads, generateImage, generateMusic, preparePiperVoice, removeJobDir, synthesize, transcribe, transcribeToPages,
  displayNameOf, buildTranscript, cuesToCaptionPages, energyFrames, parseWav, refineWordTimes, silences, speechWindow, transcribeMany, transcriptToSrt, wavDurationMs,
  MUSIC_LIBRARY, MUSIC_LIBRARY_LICENCE, type JobContext, type JobEvent, type ModelDef, type RecognisedToken, type Transcript } from '@expertmotion/models';
import { voicesServiceOf, type VoiceDto } from './voices-service.js';
import { musicLibraryOf } from './music-library-service.js';
import type { ServiceContext } from '../context.js';
import { em, emit } from './common.js';
import { getAsset, listAssets, toFacts } from './assets-repo.js';
import { assetDir, ingestOf, inspectSource } from './ingest.js';
import { modelsServiceOf } from './models-service.js';
import { ToolError, getEngineLog, runTool } from './proc.js';
import { defaultRemotionPort, type RendererLike } from './render-service.js';
import { engineBrowserOf, type BrowserLike } from '../services/engine-browser.js';
import { getOutput, outputRelPath, toOutputDto } from './render-repo.js';
import { s2, useModel } from './state.js';
import { assertEngineSpawnAllowed } from './spawn-gate.js';
import { PREP_STAGE_LABELS, analysisSummary, latestAnalysis, rotationOf, runFootagePrep, type PrepInput, type PrepStage } from './reels/footage-prep.js';
import { renderCover, type CoverSpec } from './reels/cover-service.js';

/** Review A2: voice-first clips remembered for reuse (ids + durations only). */
const VOICE_REUSE_MAX = 256;
export const GENERATOR_KINDS = ['voice', 'music', 'thumbnail', 'captions', 'hashtags', 'prep'] as const;
/** FR-251 batch input / output (documented in API_SPECIFICATION R-138 and for the agent runtime). */
export interface VoiceBatchInput { clips: Array<{ id: string; text: string; written?: string }>; voiceId: string; language?: 'id' | 'en'; speed?: number; style?: string; maxTotalMs?: number;
  startMs?: number; gapMs?: number; sceneGapMs?: number; scenes?: string[][]; insert?: boolean; captions?: boolean }
export interface VoiceCueDto { index: number; text: string; written: string; fromMs: number; toMs: number; words: Array<{ text: string; fromMs: number; toMs: number }> }
export interface VoiceBatchResult { jobId: string; batch: true; voiceId: string; speed: number; regenerated: boolean; totalMs: number; overLimit: boolean; costUsd: number;
  clips: Array<{ id: string; assetId: string; name: string; durationMs: number; atMs: number; endMs: number; scene: number | null; timing: string; cues: VoiceCueDto[] }> }
/** Cue times are relative to the clip start (0 = first sample of the clip). */
export const cueDto = (c: Transcript['cues'][number]): VoiceCueDto => ({ index: c.index, text: c.text, written: c.written, fromMs: c.fromMs, toMs: c.toMs, words: c.words.map((w) => ({ text: w.text, fromMs: w.fromMs, toMs: w.toMs })) });
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
export function musicBedOp(assetId: string, opts: { volume?: number; fadeInMs?: number; fadeOutMs?: number } = {}): OperationT {
  const cd = compileDefaults('preset:audio.bed-soft');
  const args: Record<string, unknown> = { volume: 0.2, loop: true, fadeInMs: 1000, fadeOutMs: 1000, ...(cd?.args ?? {}), assetId };
  if (opts.volume !== undefined) args['volume'] = opts.volume;
  if (opts.fadeInMs !== undefined) args['fadeInMs'] = opts.fadeInMs;    // ADR-039: the Reels composer's fades
  if (opts.fadeOutMs !== undefined) args['fadeOutMs'] = opts.fadeOutMs;
  // FR-266: the bed always ducks under speech (voice layers and footage with sound): its own level between speech, ~1/3 under it
  const v = Number(args['volume']);
  args['duckingPresetId'] = 'preset:audio.duck-voice';
  args['duckingParams'] = { volume: v, duckTo: Math.round(v * 0.35 * 1000) / 1000, rampMs: 400 };
  return { op: 'op:audio.addBed', target: { kind: 'project' }, args } as OperationT;
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
/** FR-104: one place where an Asset's audio is heard on the Sequence: the element's visible window, its source trim and rate. */
export interface AudioPlacement { elementId: string; assetId: string; fromMs: number; toMs: number; trimBeforeMs: number; playbackRate: number }
/**
 * Where audio plays on the Sequence: video Clips (by their derived window) and audio layers (atMs, limited to the source length
 * after the trim unless the layer loops, and to the Sequence end). With `assetId`, every placement of that Asset (muted or not:
 * the Creator chose it); without, the audible ones: unmuted Clips and non-bed layers with volume > 0.
 */
export function audioPlacements(model: CompositionModelT, sourceMs: (assetId: string) => number | null, opts: { assetId?: string } = {}): AudioPlacement[] {
  const timing = deriveTiming(model); const out: AudioPlacement[] = [];
  for (const c of model.tracks.video) {
    if (c.assetId === undefined) continue;                    // ADR-030 scene clips have no audio
    if (opts.assetId ? c.assetId !== opts.assetId : c.muted || c.volume === 0) continue;
    const w = timing.elementWindows[c.id]; if (!w || w.toMs <= w.fromMs) continue;
    out.push({ elementId: c.id, assetId: c.assetId, fromMs: w.fromMs, toMs: w.toMs, trimBeforeMs: c.trimBeforeMs, playbackRate: c.playbackRate });
  }
  for (const a of model.tracks.audio) {
    if (opts.assetId ? a.assetId !== opts.assetId : a.role === 'bed' || a.volume === 0) continue;
    const w = timing.elementWindows[a.id]; if (!w) continue;
    const src = sourceMs(a.assetId);
    const toMs = src !== null && !a.loop ? Math.min(w.toMs, a.atMs + Math.max(0, src - a.trimBeforeMs)) : w.toMs;
    if (toMs <= w.fromMs) continue;
    out.push({ elementId: a.id, assetId: a.assetId, fromMs: w.fromMs, toMs, trimBeforeMs: a.trimBeforeMs, playbackRate: 1 });
  }
  return out.sort((x, y) => x.fromMs - y.fromMs);
}
/** Pages of one transcription placed at every placement of its source, in timeline order (FR-104). */
export function placePages(pages: unknown[], placements: readonly AudioPlacement[]): unknown[] {
  return placements.flatMap((pl) => shiftPages(pages, pl)).sort((a, b) => (a as { startMs: number }).startMs - (b as { startMs: number }).startMs);
}
export type GeneratorKind = (typeof GENERATOR_KINDS)[number];
/** ADR-016 priority tag per Generator Card (FR-100). */
export const GENERATOR_PRIORITY: Record<GeneratorKind, 'P1' | 'P2'> = { voice: 'P1', captions: 'P1', hashtags: 'P1', music: 'P2', thumbnail: 'P2', prep: 'P1' };
/** FR-108: results that were not inserted stay listed for 7 days. */
export const GENERATED_RETENTION_MS = 7 * 24 * 3_600_000;
const TIER_RANK = { T0: 0, T1: 1, T2: 2 } as const;
const MODEL_TASKS: Record<Exclude<GeneratorKind, 'hashtags'>, ReadonlyArray<ModelDef['task']>> = { captions: ['stt'], voice: ['tts'], music: ['music', 'library'], thumbnail: ['image'], prep: ['stt'] };
/** FR-285: RAM the Service, Chrome and ffmpeg keep for themselves when choosing the prep's whisper model (the model's `ramBytes` must fit the rest). */
export const PREP_RAM_RESERVE = 1.5 * 1024 ** 3;

export interface EngineStepCtx { engineDir: string; jobDir: string; signal: AbortSignal; onProgress: (f: number) => void }
/** Engine steps (default: packages/models adapters). Tests inject fakes; nothing here knows engine argv. */
export interface GeneratorEngines {
  captions(i: { modelPath: string; wavPath: string; language: string; audioDurationMs: number }, c: EngineStepCtx): Promise<{ pages: unknown[]; language: string | null }>;
  voice(i: { modelDir: string; text: string; speed?: number; speakerId?: number; language?: 'id' | 'en' }, c: EngineStepCtx): Promise<{ wavPath: string }>;
  /** FR-249: word timings for alignment (whisper.cpp word tokens of a 16 kHz mono wav). Default: transcribeToPages captions. */
  wordTokens?(i: { modelPath: string; wavPath: string; language: string; audioDurationMs: number; /** FR-285: names-only initial prompt */ prompt?: string }, c: EngineStepCtx): Promise<RecognisedToken[]>;
  /** FR-285 (Reels listen): word tokens of SEVERAL short wavs in one whisper-cli process (one list per file, in order). Default: transcribeMany. */
  listenPieces?(i: { modelPath: string; wavPaths: string[]; language: string; audioDurationMs: number; prompt?: string }, c: EngineStepCtx): Promise<RecognisedToken[][]>;
  music(i: { modelDir: string; prompt: string; durationMs: number; seed: number; tier: 'T0' | 'T1' | 'T2' }, c: EngineStepCtx): Promise<{ wavPath: string }>;
  image(i: { model: ModelDef; modelDir: string; prompt: string; width: number; height: number; seed: number; tier: 'T0' | 'T1' | 'T2' }, c: EngineStepCtx): Promise<{ pngPath: string }>;
  frame(i: { model: CompositionModelT; projectId: string; frameMs: number; outPath: string; assetIds: string[]; /** FR-289: JPEG stills (cover), default PNG */ format?: 'png' | 'jpeg' }, c: EngineStepCtx & { ctx: ServiceContext; jobId: string }): Promise<void>;
}
export interface GeneratorsOptions {
  /** Kinds enabled in this build; others answer EM-9004 (API §6.13: a P0 build passes []). Default: all. */
  enabledKinds?: readonly GeneratorKind[];
  engines?: Partial<GeneratorEngines>;
  enginesDir?: string;
  renderer?: () => Promise<RendererLike>;
}

const threads = () => defaultThreads(os.cpus().length);
/**
 * SEC-101 / DEPLOYMENT §14: every Generator engine failure (non-zero exit, crash, timeout, unreadable output) goes to the engine
 * log with the engine name, exit code and the last stderr lines (already argument-redacted by the adapters; the logger removes
 * secrets and the Windows user name), so a QA log shows the cause without a debugger.
 */
export function logEngineFailure(ctx: ServiceContext, where: { jobId: string; kind: string; engine: string; stage: string }, e: unknown): void {
  const d = (e instanceof EmError && e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
  const tool = e instanceof ToolError ? { reason: e.reason, exitCode: e.code, stderrTail: e.stderrTail } : {};
  const entry = {
    ...where, code: e instanceof EmError ? e.code : 'EM-7101', message: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    ...(d['engine'] !== undefined ? { binary: d['engine'] } : {}), ...(d['cause'] !== undefined ? { cause: d['cause'] } : {}),
    ...(d['exitCode'] !== undefined ? { exitCode: d['exitCode'] } : {}), ...(d['signal'] ? { signal: d['signal'] } : {}), ...(d['timeoutMs'] !== undefined ? { timeoutMs: d['timeoutMs'] } : {}),
    ...(Array.isArray(d['stderrTail']) ? { stderrTail: (d['stderrTail'] as unknown[]).slice(-20).map((l) => String(l).slice(0, 400)) } : {}),
    ...(typeof d['message'] === 'string' ? { detail: d['message'].slice(0, 2000) } : {}), ...tool,
  };
  getEngineLog()?.error(entry, 'generator engine failed');
  ctx.log.warn({ jobId: where.jobId, kind: where.kind, engine: where.engine, code: entry.code, exitCode: entry.exitCode ?? null }, 'generator engine failed');
}
const firstWith = (dir: string, re: RegExp): string => { const f = fs.readdirSync(dir).find((n) => re.test(n)); if (!f) throw em('EM-7108', 'The installed model file is damaged.'); return path.join(dir, f); };
function defaultEngines(opts: GeneratorsOptions): GeneratorEngines {
  const ectx = (c: EngineStepCtx) => ({ engineDir: c.engineDir, jobDir: c.jobDir, signal: c.signal, onProgress: c.onProgress });
  return {
    wordTokens: async (i, c) => (await transcribe({ modelPath: i.modelPath, wavPath: i.wavPath, language: i.language, threads: threads(), audioDurationMs: i.audioDurationMs, ...(i.prompt ? { prompt: i.prompt } : {}) }, ectx(c))).captions
      .map((x) => ({ text: x.text, fromMs: x.startMs, toMs: x.endMs })),
    // per-piece runs pay a decode warm-up per file and a medium model on 2 threads runs ~18× realtime: 40× speech + 2 min
    listenPieces: async (i, c) => (await transcribeMany({ modelPath: i.modelPath, wavPaths: i.wavPaths, language: i.language, threads: threads(), audioDurationMs: i.audioDurationMs, ...(i.prompt ? { prompt: i.prompt } : {}) }, { ...ectx(c), timeoutMs: 40 * i.audioDurationMs + 120_000 }))
      .map((r) => r.captions.map((x) => ({ text: x.text, fromMs: x.startMs, toMs: x.endMs, ...(typeof x.confidence === 'number' ? { conf: x.confidence } : {}) }))),
    captions: async (i, c) => { const r = await transcribeToPages({ modelPath: i.modelPath, wavPath: i.wavPath, language: i.language, threads: threads(), audioDurationMs: i.audioDurationMs }, ectx(c)); return { pages: r.pages, language: r.language }; },
    voice: async (i, c) => {
      // FR-267: Supertonic 3 (vector_estimator + voice.bin speaker table); Kokoro (sherpa-onnx export) ships a voice table;
      // Piper/VITS voices are one .onnx + tokens.txt.
      if (fs.existsSync(path.join(i.modelDir, SUPERTONIC_FILES.vectorEstimator))) {
        return synthesize({ voice: { kind: 'supertonic', dir: i.modelDir, lang: i.language ?? 'id', ...(i.speakerId !== undefined ? { speakerId: i.speakerId } : {}) }, text: i.text, threads: threads(), ...(i.speed !== undefined ? { speed: i.speed } : {}) }, ectx(c));
      }
      const kokoro = fs.existsSync(path.join(i.modelDir, 'voices.bin'));
      const lexicon = path.join(i.modelDir, 'lexicon-us-en.txt');
      const voice = kokoro
        ? { kind: 'kokoro' as const, modelPath: path.join(i.modelDir, 'model.onnx'), voicesPath: path.join(i.modelDir, 'voices.bin'), tokensPath: path.join(i.modelDir, 'tokens.txt'),
            ...(fs.existsSync(lexicon) ? { lexiconPath: lexicon } : {}) }
        // Piper: sherpa-onnx needs tokens.txt and the voice metadata inside the .onnx (prepared once; repairs older installs)
        : { kind: 'vits' as const, ...(await preparePiperVoice(i.modelDir).then(({ modelPath, tokensPath }) => ({ modelPath, tokensPath }))) };
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
      let warm: BrowserLike | null = null; let ok = false;
      try {
        const base = `http://127.0.0.1:${ctx.cfg.port}/media/${grant.token}`;
        const assets: Record<string, unknown> = {};
        // the same asset facts and Engine options as an Export still (render-service), so a thumbnail renders whatever exports
        for (const id of i.assetIds) {
          const a = getAsset(ctx, id); if (!a) continue;
          assets[id] = { kind: a.kind === 'subtitle' ? 'image' : a.kind, playable: `${base}/${id}/playable`, ...(a.proxy_path ? { proxy: `${base}/${id}/proxy` } : {}),
            ...(a.duration_ms !== null ? { durationMs: a.duration_ms } : {}), ...(a.width !== null ? { width: a.width } : {}), ...(a.height !== null ? { height: a.height } : {}), hasAudio: a.has_audio === 1 };
        }
        const { cancelSignal, cancel } = R.makeCancelSignal();
        c.signal.addEventListener('abort', () => cancel(), { once: true });
        const common: Record<string, unknown> = { serveUrl: ctx.resources.engineBundle, inputProps: { model: i.model, assets, quality: 'full' }, port, logLevel: 'error', timeoutInMilliseconds: 60_000,
          chromiumOptions: { gl: ctx.hooks.tier() === 'T0' ? 'swangle' : 'angle' }, ...(ctx.resources.browserExecutable ? { browserExecutable: ctx.resources.browserExecutable } : {}),
          ...(ctx.resources.binariesDirectory ? { binariesDirectory: ctx.resources.binariesDirectory } : {}) };
        // borrow the warmed Engine browser like renders do: no second Chrome on an 8 GB PC (NFR memory budget)
        warm = opts.renderer ? null : await (engineBrowserOf(ctx)?.acquire() ?? Promise.resolve(null));
        if (warm) common['puppeteerInstance'] = warm;
        const composition = await R.selectComposition({ ...common, id: 'ExpertmotionTimeline' });
        const frame = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round((i.frameMs / 1000) * composition.fps)));
        await R.renderStill({ ...common, composition, frame, output: i.outPath, imageFormat: i.format ?? 'png', ...(i.format === 'jpeg' ? { jpegQuality: 92 } : {}), cancelSignal });
        ok = true;
      } catch (e) {
        if (c.signal.aborted) throw new CancelledError();
        // a still that cannot be rendered is a thumbnail failure with the Engine's own message in the engine log (EM-7101 {tool})
        throw new EmError('EM-7101', 'The thumbnail frame could not be rendered.', { details: { engine: 'remotion', cause: 'still', message: (e instanceof Error ? e.message : String(e)).slice(0, 2000) }, cause: e });
      } finally {
        if (warm) engineBrowserOf(ctx)?.release(ok);
        for (const o of origins) ctx.mediaOrigins.delete(o); ctx.grants.revokeJob(c.jobId);
      }
    },
  };
}

interface GenRow { id: string; project_id: string; kind: GeneratorKind; input_json: string; model_key: string | null; status: string; progress: number; result_asset_id: string | null;
  result_json: string | null; error_code: string | null; created_at: string; started_at: string | null; finished_at: string | null }
export const toGenDto = (r: GenRow): Record<string, unknown> => ({ id: r.id, projectId: r.project_id, kind: r.kind, status: r.status, progress: r.progress, modelKey: r.model_key,
  resultAssetId: r.result_asset_id, result: r.result_json ? JSON.parse(r.result_json) as unknown : null, errorCode: r.error_code, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at });

interface Prepared { modelKey: string | null; run: (j: JobContext) => Promise<{ assetId?: string; result: Record<string, unknown>; ops?: OperationT[] }> }

/** Asset name of a generated voice: its first words ("Ekspor-nikel-Indonesia-naik-tajam"), so the Creator recognises it in Assets. */
function voiceAssetName(text: string, jobId: string): string {
  const fallback = `voice-${jobId.slice(-8).toLowerCase()}`;
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ').slice(0, 48);
  return words ? sanitizeFilename(words, fallback) : fallback;
}

export class GeneratorsService {
  private readonly runner: JobRunner;
  private readonly engines: GeneratorEngines;
  private readonly inserts = new Map<string, boolean>();
  /** Review A2: voice-first clips already made (project, voice, speed, language, style, text) → asset, so a re-planned stale plan reuses
   *  them instead of paying for every voice again. Metadata only (ids + durations), at most VOICE_REUSE_MAX entries. */
  private readonly voiceReuse = new Map<string, { assetId: string; durationMs: number }>();
  /** FR-252: plan generator steps waiting for a model install (model key → held runs). */
  private readonly held = new Map<string, Array<{ projectId: string; planId: string; steps: Array<{ n: number; tool: string; args: Record<string, unknown>; dependsOn: number[] }> }>>();
  constructor(private readonly ctx: ServiceContext, private readonly opts: GeneratorsOptions = {}) {
    this.engines = { ...defaultEngines(opts), ...(opts.engines ?? {}) };
    s2(ctx).events.on('model.installed', (key: string) => this.resumeHeld(key));
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
      if (kind === 'prep') continue;                                  // FR-285: the footage prep is a job behind the Assets panel / Brainstorm tool, not a Generator Card
      const base = { kind, enabled: enabled.includes(kind), priority: GENERATOR_PRIORITY[kind] };
      if (kind === 'hashtags') { out.push({ ...base, model: null, models: [], llm: true, tierHint: 'ok' }); continue; }
      const task = kind === 'captions' ? 'stt' : kind === 'voice' ? 'tts' : kind === 'music' ? 'music' : 'image';
      const defKey = defaultModelFor(task, tier, { language: lang });
      const list = await Promise.all(models.defs().filter((d) => MODEL_TASKS[kind].includes(d.task)).map(async (d) => ({
        key: d.key, label: d.label, displayName: displayNameOf(d), bytes: d.bytes, installed: await models.isInstalled(d.key), languages: d.languages, minTier: d.minTier, belowTier: TIER_RANK[tier] < TIER_RANK[d.minTier],
        cc0: d.engine === 'loops' })));
      // frame-composite (thumbnails) needs no model: a still of the current frame plus the title (LOCAL_AI_MODELS §5). It is always
      // one of the options, so the sheet's model picker can show and select it (QA 14: it showed an uninstalled image model instead)
      // FR-247: the CC0 music library is always an option (tracks download on demand); AI music is explained, never offered
      if (kind === 'music' && !list.some((m) => m.key === 'loop-library-cc0')) list.push({ key: 'loop-library-cc0', label: 'CC0 music library', displayName: { en: 'Music Library · CC0', id: 'Pustaka Musik · CC0' }, bytes: 0, installed: true, languages: [], minTier: 'T0', belowTier: false, cc0: true });
      if (kind === 'thumbnail') list.push({ key: 'frame-composite', label: 'Frame + title', displayName: displayNameOf({ key: 'frame-composite', label: 'Frame + title' }), bytes: 0, installed: true, languages: [], minTier: 'T0', belowTier: false, cc0: false });
      let model = list.find((m) => m.key === defKey) ?? null;
      // a thumbnail never waits for a download: when the tier's image model is not installed, the frame still is the default
      if (kind === 'thumbnail' && (!model || !model.installed)) model = list.find((m) => m.key === 'frame-composite')!;
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

  /** QA UX round 1: per-clip progress of a running voice batch (voiceBatch `onClip`), by job id. */
  private readonly clipHooks = new Map<string, (done: number, total: number) => void>();
  private onEvent(e: JobEvent): void {
    const ctx = this.ctx; const j = e.job; const now = ctx.now();
    if (e.type === 'running') ctx.db.prepare("UPDATE generator_jobs SET status = 'running', started_at = ? WHERE id = ?").run(now, j.id);
    else if (e.type === 'progress') ctx.db.prepare('UPDATE generator_jobs SET progress = ? WHERE id = ?').run(j.progress, j.id);
    else if (e.type === 'failed' || e.type === 'cancelled') ctx.db.prepare('UPDATE generator_jobs SET status = ?, error_code = ?, finished_at = ? WHERE id = ?').run(e.type, j.error?.code ?? null, now, j.id);
    let status: string = j.status;
    if (e.type === 'done') {
      const r = e.result as { assetId?: string; result: Record<string, unknown> };
      // FR-286: a prep job that stopped for the rotation confirmation (R-148 continues it) is `needs-input`, not done
      if (j.kind === 'prep' && r.result['needsInput'] === true) status = 'needs-input';
      ctx.db.prepare("UPDATE generator_jobs SET status = ?, progress = 1, result_asset_id = ?, result_json = ?, finished_at = ? WHERE id = ?").run(status, r.assetId ?? null, JSON.stringify(r.result), now, j.id);
    }
    // FR-285: the prep job's stage id and its Indonesian / English label, so the progress card can name the step
    const stage = j.kind === 'prep' && j.stage && (PREP_STAGE_LABELS as Record<string, { id: string; en: string }>)[j.stage] ? { stage: j.stage, stageLabel: PREP_STAGE_LABELS[j.stage as PrepStage] } : {};
    if (e.type !== 'queued') emit(ctx, 'service.notice', { kind: 'generator', projectId: j.projectId, jobId: j.id, generator: j.kind, status, percent: Math.round(j.progress * 100), ...stage,
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
        // ADR-039: the Reels composer's gain lifts over silent cards go on the bed the job just inserted
        if (kind === 'music' && Array.isArray(body['gain']) && body['gain'].length && out.assetId) { const v2 = this.applyBedGain(projectId, out.assetId, body['gain'] as unknown[], id); if (v2) out.result['versionId'] = v2; }
      }
      if (out.ops) out.result['proposedOps'] = out.ops;
      return out;
    } });
    return toGenDto(this.get(id)!);
  }
  /** ADR-039: `op:audio.setGain {segments}` on the newest bed of `assetId` (the layer id exists only after the bed was added). */
  private applyBedGain(projectId: string, assetId: string, segments: unknown[], ref: string): string | null {
    const ctx = this.ctx;
    const bed = [...ctx.hooks.composition(projectId).model.tracks.audio].reverse().find((a) => a.assetId === assetId && a.role === 'bed');
    if (!bed) return null;
    try { return ctx.hooks.applyOps(projectId, [{ op: 'op:audio.setGain', target: { kind: 'audio', id: bed.id }, args: { segments } } as OperationT], { kind: 'generator', ref, summary: 'Music lifts over silent scenes' }); }
    catch (e) { ctx.log.warn({ projectId, assetId, code: e instanceof EmError ? e.code : 'EM-7101' }, 'bed gain not applied'); return null; }
  }
  /** ADR-030: the model behind a generator plan step — an installed one for the language first (default first), else the default. */
  async planToolModel(task: 'tts' | 'stt', language: 'id' | 'en'): Promise<ToolModel | null> {
    const models = modelsServiceOf(this.ctx); const tier = this.ctx.hooks.tier();
    const defKey = defaultModelFor(task, tier, { language });
    const cands = models.defs().filter((d) => d.task === task && (task === 'stt' || !d.languages?.length || d.languages.includes(language))).sort((a, b) => Number(b.key === defKey) - Number(a.key === defKey));
    for (const d of cands) if (await models.isInstalled(d.key)) return { installed: true, modelKey: d.key, label: displayNameOf(d)[language] };
    const d = models.def(defKey) ?? cands[0];
    return d ? { installed: false, modelKey: d.key, label: displayNameOf(d)[language] } : null;
  }
  /** Resolves when a job reaches done / failed / cancelled. */
  private waitJob(id: string): Promise<GenRow | undefined> {
    const final = (r: GenRow | undefined) => !r || ['done', 'failed', 'cancelled'].includes(r.status);
    const now = this.get(id);
    if (final(now)) return Promise.resolve(now);
    return new Promise((resolve) => { const on = (jid: string) => { if (jid !== id) return; s2(this.ctx).events.off('generator.final', on); resolve(this.get(id)); }; s2(this.ctx).events.on('generator.final', on); });
  }
  /**
   * ADR-030: generator steps of an executed plan, in order, in the background: `tts.generate` → a voice job inserted at atMs;
   * `captions.generate` {source: voice} → after that voice job, caption pages from the script timed over the voice layer (no
   * transcription model needed); {source: sequence} → a captions job over the Sequence audio. Failures are logged and reported
   * as `service.notice` {kind: 'plan-step'}; they never undo the committed composition change.
   */
  runPlanSteps(projectId: string, planId: string, steps: Array<{ n: number; tool: string; args: Record<string, unknown>; dependsOn: number[] }>) {
    const ctx = this.ctx;
    const lang = (a: Record<string, unknown>): 'id' | 'en' => (a['language'] === 'en' ? 'en' : a['language'] === 'id' ? 'id' : ctx.hooks.composition(projectId).model.settings.language);
    const notice = (n: number, tool: string, status: string, extra: Record<string, unknown> = {}) => emit(ctx, 'service.notice', { kind: 'plan-step', projectId, planId, step: n, tool, status, ...extra });
    const voices = new Map<number, Promise<GenRow | undefined>>(); const voiceAt = new Map<Promise<GenRow | undefined>, number>();
    const work = (async () => {
      for (const st of steps) {
        try {
          if (st.tool === 'tts.generate') {
            const language = lang(st.args);
            // FR-246: a voice id, a legacy model key or a description ("suara perempuan hangat"); empty → the best available voice
            const voiceId = String(st.args['voiceId'] ?? st.args['voice'] ?? st.args['modelKey'] ?? '');
            const job = await this.create(projectId, 'voice', { text: String(st.args['text'] ?? ''), voiceId, language, atMs: typeof st.args['atMs'] === 'number' ? st.args['atMs'] : 0,
              ...(typeof st.args['speed'] === 'number' ? { speed: st.args['speed'] } : {}), ...(typeof st.args['style'] === 'string' ? { style: st.args['style'] } : {}), insert: true });
            const wait = this.waitJob(String(job['id'])); voices.set(st.n, wait); voiceAt.set(wait, typeof st.args['atMs'] === 'number' ? st.args['atMs'] : 0);
            notice(st.n, st.tool, 'started', { jobId: job['id'] });
          } else if (st.tool === 'music.generate' && typeof st.args['assetId'] === 'string') {
            // ADR-039: a music Asset already in the project → the bed (volume, fades, ducking) + the composer's gain lifts, no job
            const assetId = st.args['assetId']; const a = getAsset(ctx, assetId, projectId);
            if (!a || a.status !== 'ready' || a.has_audio !== 1) throw em('EM-1301', 'The music asset is not in the project.', { details: { assetId } });
            const fades = { ...(typeof st.args['fadeInMs'] === 'number' ? { fadeInMs: st.args['fadeInMs'] } : {}), ...(typeof st.args['fadeOutMs'] === 'number' ? { fadeOutMs: st.args['fadeOutMs'] } : {}) };
            let versionId = ctx.hooks.applyOps(projectId, [musicBedOp(assetId, { ...(typeof st.args['volume'] === 'number' ? { volume: st.args['volume'] } : {}), ...fades })], { kind: 'generator', ref: planId, summary: 'Music bed' });
            if (Array.isArray(st.args['gain']) && st.args['gain'].length) versionId = this.applyBedGain(projectId, assetId, st.args['gain'] as unknown[], planId) ?? versionId;
            notice(st.n, st.tool, 'done', { assetId, versionId });
          } else if (st.tool === 'music.generate') {
            // FR-266: a best-fit CC0 library track (downloaded + verified on first use), looped / faded to the video, ducked under speech;
            // ADR-039: `trackId` picks the track, `fadeInMs` / `fadeOutMs` / `gain` come from the Reels composer
            const model = ctx.hooks.composition(projectId).model;
            const durationMs = Math.max(1000, Math.min(1_800_000, typeof st.args['durationMs'] === 'number' ? st.args['durationMs'] : deriveTiming(model).durationMs));
            const job = await this.create(projectId, 'music', { prompt: String(st.args['prompt'] ?? 'calm'), durationMs, modelKey: 'loop-library-cc0', insert: true,
              ...(typeof st.args['volume'] === 'number' ? { volume: st.args['volume'] } : {}), ...(typeof st.args['trackId'] === 'string' ? { trackId: st.args['trackId'] } : {}),
              ...(typeof st.args['fadeInMs'] === 'number' ? { fadeInMs: st.args['fadeInMs'] } : {}), ...(typeof st.args['fadeOutMs'] === 'number' ? { fadeOutMs: st.args['fadeOutMs'] } : {}), ...(Array.isArray(st.args['gain']) ? { gain: st.args['gain'] } : {}) });
            notice(st.n, st.tool, 'started', { jobId: job['id'] });
          } else if (st.tool === 'cover.render') {
            // ADR-039 (FR-289): the cover still through the same path as R-153 (composeCover → JPEG still → Output kind still)
            const spec = (st.args['spec'] ?? {}) as CoverSpec;
            const out = await renderCover(ctx, projectId, { ...spec, ...(typeof st.args['masterAssetId'] === 'string' ? { masterAssetId: st.args['masterAssetId'] } : {}) });
            notice(st.n, st.tool, 'done', { outputId: out['id'], path: out['path'], fileName: out['fileName'] });
          } else if (st.tool === 'captions.generate' && st.args['source'] === 'sequence') {
            const job = await this.create(projectId, 'captions', { source: 'sequence', language: lang(st.args), insert: true, ...(typeof st.args['presetId'] === 'string' ? { presetId: st.args['presetId'] } : {}),
              ...(typeof st.args['modelKey'] === 'string' ? { modelKey: st.args['modelKey'] } : {}) });   // the installed model the plan checked (prepareToolSteps)
            notice(st.n, st.tool, 'started', { jobId: job['id'] });
          } else if (st.tool === 'captions.generate') {
            // ADR-041 (E2E run 6, 2026-11-01): caption pages for EVERY narration voice of this plan, each from its own voice's timed
            // transcript / script text. Before, one voice job was picked (the first) and its few words were spread over the video.
            const depNs = st.dependsOn.filter((n) => voices.has(n));
            const jobNs = (depNs.length ? depNs : [...voices.keys()]).sort((a, b) => a - b);
            const pages: ReturnType<typeof scriptPages> = []; let timedTo: 'voice' | 'video' = 'video'; let method: string | undefined;
            if (!jobNs.length) {
              // voice-first Execute (ADR-035): the voices were made before this runner started, so no job is in `voices` — read every
              // voice layer of the model with its stored timed transcript instead; the old fallback spread the first line over the video
              const model = ctx.hooks.composition(projectId).model; const totalMs = deriveTiming(model).durationMs;
              for (const layer of [...model.tracks.audio.filter((a) => a.role === 'voice')].sort((a, b) => a.atMs - b.atMs)) {
                const tx = this.transcriptOf(layer.assetId, projectId); if (!tx) continue;
                const to = Math.min(layer.durationMs !== undefined ? layer.atMs + layer.durationMs : totalMs, totalMs);
                pages.push(...cuesToCaptionPages(tx.cues, layer.atMs, { trimBeforeMs: layer.trimBeforeMs, untilMs: to })); timedTo = 'voice'; method = tx.method ?? method;
              }
              const voiceLayers = model.tracks.audio.filter((a) => a.role === 'voice');
              ctx.log.info({ projectId, planId, step: st.n, voiceLayers: voiceLayers.length, withTranscript: voiceLayers.filter((a) => !!this.transcriptOf(a.assetId, projectId)).length, pages: pages.length }, 'captions from the model voices');
              if (!pages.length) {
                // no stored transcript: one line of the step's text per voice layer, proportionally inside that layer's window
                const lines = String(st.args['text'] ?? '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
                voiceLayers.sort((a, b) => a.atMs - b.atMs).forEach((layer, i) => { const line = lines[i] ?? (lines.length === 1 && i === 0 ? lines[0] : undefined); if (!line) return;
                  const to = Math.min(layer.durationMs !== undefined ? layer.atMs + layer.durationMs : totalMs, totalMs); pages.push(...scriptPages(line, layer.atMs, to)); });
                if (!pages.length) pages.push(...scriptPages(String(st.args['text'] ?? '').trim(), 0, totalMs));
              }
            }
            for (const n of jobNs) {
              const wait = voices.get(n)!; const row = await wait;
              const model = ctx.hooks.composition(projectId).model;
              const same = row?.status === 'done' && row.result_asset_id ? model.tracks.audio.filter((a) => a.assetId === row.result_asset_id && a.role === 'voice') : [];
              const layer = same.find((a) => a.atMs === voiceAt.get(wait)) ?? same.at(-1);
              if (!layer) continue;
              const from = layer.atMs, to = Math.min(layer.durationMs !== undefined ? from + layer.durationMs : Number.POSITIVE_INFINITY, deriveTiming(model).durationMs);
              // FR-248: the caption text is the script (this voice step's text), never recognition; the voice's timed transcript gives the times
              const stepText = String(steps.find((x) => x.n === n)?.args['text'] ?? (jobNs.length === 1 ? st.args['text'] ?? '' : '')).trim();
              const stored = row?.result_asset_id ? this.transcriptOf(row.result_asset_id) : null;
              const tx = stored && stepText && stepText !== stored.spoken && stepText !== stored.written
                ? buildTranscript({ spoken: stored.spoken, written: stepText, language: stored.language, durationMs: stored.durationMs, tokens: stored.words, method: 'engine' })
                : stored;
              const pg = tx ? cuesToCaptionPages(tx.cues, from, { trimBeforeMs: layer.trimBeforeMs, untilMs: to }) : scriptPages(stepText, from, to);
              pages.push(...pg); timedTo = 'voice'; method = tx?.method ?? method;
            }
            if (!pages.length) { notice(st.n, st.tool, 'skipped', { code: 'EM-7103' }); continue; }
            const ops = this.withCaptionStyle(projectId, [{ op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages } } as OperationT, // the same style already set by the composer keeps its params (keywords, emphasis colour, font): re-setting it reset them to the defaults (E2E Satu-Persen look)
              ...(typeof st.args['presetId'] === 'string' && ctx.hooks.composition(projectId).model.tracks.caption.styleId !== st.args['presetId'] ? [{ op: 'op:caption.setStyle', target: { kind: 'project' }, args: { presetId: st.args['presetId'] } } as OperationT] : [])]);
            ctx.hooks.applyOps(projectId, ops, { kind: 'generator', ref: planId, summary: 'Captions from the script' });
            notice(st.n, st.tool, 'done', { pages: pages.length, voices: jobNs.length, timedTo, timing: method ?? 'proportional' });
          }
        } catch (e) {
          const code = e instanceof EmError ? e.code : 'EM-7101';
          const d = (e instanceof EmError && e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
          ctx.log.warn({ projectId, planId, step: st.n, tool: st.tool, code, ...(d['modelKey'] ? { modelKey: d['modelKey'] } : {}), ...(d['voiceId'] ? { voiceId: d['voiceId'] } : {}) }, 'plan generator step failed');
          // FR-252: a missing local model holds this step and the ones after it; installing the model (one click on the notice)
          // continues them automatically. The notice carries what the Editor needs for the "Pasang" button.
          if (code === 'EM-7001' && typeof d['modelKey'] === 'string') {
            const rest = steps.slice(steps.indexOf(st));
            this.held.set(d['modelKey'], [...(this.held.get(d['modelKey']) ?? []).filter((h) => h.planId !== planId), { projectId, planId, steps: rest }]);
            notice(st.n, st.tool, 'needs-model', { code, modelKey: d['modelKey'], bytes: d['bytes'] ?? null, held: rest.map((x) => x.n) });
            return;
          }
          notice(st.n, st.tool, 'failed', { code });
        }
      }
    })();
    void work.catch(() => undefined);
    return steps.map((st) => ({ n: st.n, tool: st.tool, status: 'started' as const }));
  }
  /**
   * FR-262: transcription of the Creator's footage before an Editor run ("buat video dari footage ini"): one captions job per
   * video asset (insert: false — nothing changes on the timeline), one at a time, bounded by `timeoutMs`; the result's `sources`
   * become AssetFacts.transcript (assets-repo withTranscripts). Without an installed transcription model nothing runs (the
   * plan then trims by duration only). Resolves with the ids that were read.
   */
  async readFootage(projectId: string, assetIds: string[], o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string[]> {
    const tier = this.ctx.hooks.tier();
    const key = defaultModelFor('stt', tier);
    const models = modelsServiceOf(this.ctx);
    const stt = (await models.isInstalled(key)) ? key : (models.defs().find((d) => d.task === 'stt' && d.availability !== 'virtual')?.key ?? null);
    if (!stt || !(await models.isInstalled(stt))) return [];
    const done: string[] = [];
    const until = Date.now() + (o.timeoutMs ?? 150_000);
    for (const id of assetIds) {
      if (o.signal?.aborted || Date.now() > until) break;
      try {
        const job = await this.create(projectId, 'captions', { assetId: id, modelKey: stt, insert: false, purpose: 'footage-read' });
        const row = await Promise.race([this.waitJob(String(job['id'])), new Promise<undefined>((r) => { const h = setTimeout(() => r(undefined), Math.max(1000, until - Date.now())); h.unref?.(); })]);
        if (row?.status === 'done') done.push(id);
        else { if (!row) this.cancel(String(job['id'])); break; }
      } catch (e) { this.ctx.log.info({ projectId, assetId: id, code: e instanceof EmError ? e.code : 'EM-7101' }, 'footage read skipped'); }
    }
    return done;
  }
  /** FR-252: continues the plan steps that waited for `modelKey` (called when the model is installed). */
  resumeHeld(modelKey: string): number {
    const runs = this.held.get(modelKey) ?? []; this.held.delete(modelKey);
    for (const r of runs) {
      emit(this.ctx, 'service.notice', { kind: 'plan-step', projectId: r.projectId, planId: r.planId, step: r.steps[0]?.n ?? 0, tool: r.steps[0]?.tool ?? '', status: 'resumed', modelKey });
      this.runPlanSteps(r.projectId, r.planId, r.steps);
    }
    return runs.length;
  }
  heldSteps(): Array<{ modelKey: string; projectId: string; planId: string; steps: number[] }> { return [...this.held.entries()].flatMap(([modelKey, rs]) => rs.map((r) => ({ modelKey, projectId: r.projectId, planId: r.planId, steps: r.steps.map((x) => x.n) }))); }
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
    if (!def || !(await models.isInstalled(key))) throw em('EM-7001', `"${tool}" needs the ${def ? displayNameOf(def).en : key} model.`, { details: { modelKey: key, bytes: def?.bytes ?? null } });
    return def;
  }
  /** Engine step under the heavy lock, in a per-job temp dir (SEC-062). */
  private async engineStep<T>(j: JobContext, engine: string, stage: string, fn: (c: EngineStepCtx) => Promise<T>): Promise<T> {
    return s2(this.ctx).heavy.run(async () => {
      if (j.signal.aborted) throw new EmError('EM-7101', 'cancelled');
      await assertEngineSpawnAllowed(this.ctx, engine, this.engineDir(engine));   // SEC-066 Private Mode / network need, SEC-061 hashes
      j.progress(0.05, stage);
      try {
        return await fn({ engineDir: this.engineDir(engine), jobDir: path.join(this.ctx.paths.tmp, 'jobs', j.jobId), signal: j.signal, onProgress: (f) => j.progress(0.05 + f * 0.8, stage) });
      } catch (e) {
        if (!j.signal.aborted && !(e instanceof CancelledError)) logEngineFailure(this.ctx, { jobId: j.jobId, kind: this.get(j.jobId)?.kind ?? 'unknown', engine, stage }, e);
        throw e;
      }
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

  // ───────────────────────────── voices (FR-246 … FR-251, ADR-035) ─────────────────────────────
  /** A voice id, a legacy model key or a description → a voice that can run now; EM-7001 (local model missing, installable), EM-8202 / EM-7113 (cloud). */
  async resolveVoice(idOrDescription: string, language: 'id' | 'en'): Promise<VoiceDto> {
    const models = modelsServiceOf(this.ctx);
    const asModel = models.def(idOrDescription);
    if (asModel && asModel.task !== 'tts') throw em('EM-9002', 'Invalid request: voiceId is not a voice.', { status: 400, path: 'body.voiceId' });
    const v = await voicesServiceOf(this.ctx).resolve(idOrDescription || (language === 'id' ? 'natural jelas' : 'natural clear'), language);
    if (!v) throw em('EM-9002', 'Invalid request: voiceId is not a voice.', { status: 400, path: 'body.voiceId' });
    if (!v.cloud && v.availability !== 'ready') { const def = models.def(v.modelKey!); throw em('EM-7001', `"Generate Voice" needs the ${def ? displayNameOf(def).en : v.modelKey} model.`, { details: { modelKey: v.modelKey, modelId: v.modelKey, bytes: def?.bytes ?? null, voiceId: v.id } }); }
    if (v.availability === 'private-mode') throw em('EM-8202', 'Private Mode is on, so cloud voices are not used.', { details: { action: 'cloud voice', voiceId: v.id } });
    if (v.availability === 'no-connection') throw em('EM-7113', 'This cloud voice needs its provider connected.', { details: { provider: v.provider, voiceId: v.id, reason: 'no-connection' } });
    return v;
  }
  /** FR-249: the installed recogniser used only for word TIMES (smallest first); null → proportional timing over the speech window. */
  private async alignModel(): Promise<ModelDef | null> {
    const models = modelsServiceOf(this.ctx);
    const keys = ['whisper-small', 'whisper-large-v3-turbo', 'whisper-medium', 'whisper-large-v3', ...models.defs().filter((d) => d.task === 'stt').map((d) => d.key)];
    for (const k of keys) { const d = models.def(k); if (d && await models.isInstalled(k)) return d; }
    return null;
  }
  private ffmpeg(j: JobContext, args: string[], cwd: string, timeoutMs = 120_000): Promise<unknown> {
    return s2(this.ctx).heavy.run(() => runTool({ exe: this.ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', ...args], cwd, timeoutMs, signal: j.signal }));
  }
  /**
   * One voice clip (FR-246, FR-249): synthesis (local engine or the Creator's cloud voice), pitch / tempo post-processing, a timed
   * transcript built from the SCRIPT (engine word times, else whisper word times aligned to the script and snapped to the audio,
   * else proportional), the WAV registered as an Asset named `<name>.wav`, the transcript stored for that Asset (JSON + SRT).
   */
  async voiceClip(j: JobContext, projectId: string, voice: VoiceDto, clip: { name: string; text: string; written?: string },
    o: { language: 'id' | 'en'; speed?: number; style?: string; align?: boolean; part?: (f: number) => void }): Promise<{ assetId: string; durationMs: number; transcript: Transcript; usd: number }> {
    const ctx = this.ctx; const models = modelsServiceOf(ctx);
    const dir = path.join(ctx.paths.tmp, 'jobs', j.jobId, clip.name.replace(/[^\w-]/g, '_')); fs.mkdirSync(dir, { recursive: true });
    const wav = path.join(dir, 'clip.wav');
    let tokens: RecognisedToken[] | null = null; let method: 'engine' | 'aligned' = 'aligned'; let usd = 0;
    if (!voice.cloud) {
      const def = await this.requireInstalled(voice.modelKey!, 'Generate Voice');
      const speed = o.speed === undefined ? undefined : Math.max(0.8, Math.min(1.2, o.speed));
      const r = await this.engineStep(j, 'sherpa-onnx', 'synthesize', (c) => this.engines.voice({ modelDir: models.dirOf(def), text: clip.text, language: o.language, ...(voice.speakerId !== undefined ? { speakerId: voice.speakerId } : {}), ...(speed !== undefined ? { speed } : {}) }, { ...c, onProgress: (f) => o.part?.(f * 0.6) }));
      if (voice.pitch) {
        const f = 2 ** (voice.pitch / 12); const sr = parseWav(fs.readFileSync(r.wavPath)).sampleRate;
        await this.ffmpeg(j, ['-i', r.wavPath, '-af', `asetrate=${Math.round(sr * f)},aresample=${sr},atempo=${(1 / f).toFixed(5)}`, '-ac', '1', '-c:a', 'pcm_s16le', wav], dir);
      } else fs.copyFileSync(r.wavPath, wav);
    } else {
      j.progress(0.05, 'cloud');
      const res = await voicesServiceOf(ctx).synthesizeCloud(voice, clip.text, { language: o.language, ...(o.speed !== undefined ? { speed: o.speed } : {}), ...(o.style ? { style: o.style } : {}), signal: j.signal });
      usd = res.usd; tokens = res.tokens; if (tokens?.length) method = 'engine';
      const raw = path.join(dir, `cloud.${res.ext}`); fs.writeFileSync(raw, res.audio);
      const tempo = voice.provider === 'gemini' && o.speed && Math.abs(o.speed - 1) > 0.01 ? ['-af', `atempo=${Math.max(0.5, Math.min(2, o.speed)).toFixed(3)}`] : [];
      await this.ffmpeg(j, ['-i', raw, ...tempo, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wav], dir);
      if (tempo.length && tokens) tokens = tokens.map((t) => ({ ...t, fromMs: Math.round(t.fromMs / o.speed!), toMs: Math.round(t.toMs / o.speed!) }));
      o.part?.(0.6);
    }
    const buf = fs.readFileSync(wav);
    const durationMs = wavDurationMs(parseWav(buf));
    if (!tokens && o.align !== false) {
      const am = await this.alignModel();
      if (am) {
        try {
          const w16 = path.join(dir, 'align16k.wav');
          await this.ffmpeg(j, ['-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', w16], dir);
          const modelPath = firstWith(models.dirOf(am), /\.bin$/);
          tokens = await this.engineStep(j, 'whisper.cpp', 'align', (c) => this.engines.wordTokens!({ modelPath, wavPath: w16, language: o.language, audioDurationMs: durationMs }, { ...c, onProgress: (f) => o.part?.(0.6 + f * 0.35) }));
        } catch (e) {
          if (j.signal.aborted || e instanceof CancelledError) throw e;
          ctx.log.warn({ jobId: j.jobId, code: e instanceof EmError ? e.code : 'EM-7101' }, 'voice alignment skipped; proportional timing');   // never fails the voice
          tokens = null;
        }
      }
    }
    // R4: the audio is already made (and possibly paid for); a timing failure falls back to proportional timing, never loses the clip
    const base = { spoken: clip.text, ...(clip.written ? { written: clip.written } : {}), language: o.language, durationMs, tokens, method };
    let transcript: ReturnType<typeof buildTranscript>;
    try {
      const frames = energyFrames(buf);
      // QA P1 2026-10-29: caption pages break at the real pauses of this clip (silences of the energy envelope) and snap to them
      transcript = buildTranscript({ ...base, speech: speechWindow(buf) ?? { fromMs: 0, toMs: durationMs }, refine: (w) => refineWordTimes(w, frames), cues: { pauses: silences(frames) } });
    } catch (e) {
      ctx.log.warn({ jobId: j.jobId, err: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, 'voice energy timing failed; timing without the energy envelope');
      try { transcript = buildTranscript({ ...base, speech: { fromMs: 0, toMs: durationMs } }); } catch (e2) {
        throw new EmError('EM-7101', 'The voice audio was generated but its word timing could not be computed.', { details: { engine: 'transcript', cause: 'timing', message: (e2 instanceof Error ? e2.message : String(e2)).slice(0, 2000) }, cause: e2 });
      }
    }
    o.part?.(1);
    const assetId = await this.register(projectId, wav, `${clip.name}.wav`);
    ctx.db.prepare('INSERT OR REPLACE INTO voice_transcripts (asset_id, project_id, voice_id, method, json, srt, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(assetId, projectId, voice.id, transcript.method, JSON.stringify(transcript), transcriptToSrt(transcript.cues), ctx.now());
    return { assetId, durationMs, transcript, usd };
  }
  /** FR-246 (R-216): a short preview sample of a voice, cached in `<models>/voice-previews/` (local: needs the model; cloud: one small paid call). */
  async previewVoice(voice: VoiceDto, language: 'id' | 'en', outFile: string, text: string): Promise<void> {
    const jobId = this.ctx.newId(); const ac = new AbortController();
    const j = { jobId, signal: ac.signal, progress: () => undefined } as unknown as JobContext;
    await createJobDir(this.ctx.paths.tmp, jobId);
    try {
      const dir = path.join(this.ctx.paths.tmp, 'jobs', jobId);
      let src: string;
      if (!voice.cloud) {
        const def = await this.requireInstalled(voice.modelKey!, 'Generate Voice');
        src = (await this.engineStep(j, 'sherpa-onnx', 'preview', (c) => this.engines.voice({ modelDir: modelsServiceOf(this.ctx).dirOf(def), text, language, ...(voice.speakerId !== undefined ? { speakerId: voice.speakerId } : {}) }, c))).wavPath;
      } else {
        const res = await voicesServiceOf(this.ctx).synthesizeCloud(voice, text, { language, signal: ac.signal });
        src = path.join(dir, `cloud.${res.ext}`); fs.writeFileSync(src, res.audio);
      }
      const f = voice.pitch ? 2 ** (voice.pitch / 12) : 1;
      const sr = 24000;
      const af = voice.pitch ? ['-af', `aresample=${sr},asetrate=${Math.round(sr * f)},aresample=${sr},atempo=${(1 / f).toFixed(5)}`] : [];
      const tmp = path.join(dir, 'preview.wav');
      await this.ffmpeg(j, ['-i', src, ...af, '-ac', '1', '-ar', String(sr), '-c:a', 'pcm_s16le', tmp], dir);
      // A8: atomic — the cache is served when the file exists, so a half-written WAV must never appear under its final name
      const part = `${outFile}.${jobId}.part`;
      try { fs.copyFileSync(tmp, part); fs.renameSync(part, outFile); } finally { fs.rmSync(part, { force: true }); }
    } finally { await removeJobDir(this.ctx.paths.tmp, jobId).catch(() => undefined); }
  }
  /** FR-247 (R-222): a downloaded library track copied into the project as an Asset (`music-<id>.mp3`). */
  async importLibraryTrack(projectId: string, trackId: string): Promise<{ assetId: string }> {
    const lib = musicLibraryOf(this.ctx); const t = lib.require(trackId);
    await lib.download(trackId);
    const src = await lib.readyFile(trackId);
    const dir = path.join(this.ctx.paths.tmp, 'library', this.ctx.newId()); fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, t.file); fs.copyFileSync(src, copy);
    try { return { assetId: await this.register(projectId, copy, `music-${t.id}.mp3`) }; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  /** FR-249: the stored transcript of a voice Asset (built from its script), or null. */
  transcriptOf(assetId: string, projectId?: string): Transcript | null {   // A8: the route passes its project, so another project's transcript is never served
    const r = (projectId === undefined ? this.ctx.db.prepare('SELECT json FROM voice_transcripts WHERE asset_id = ?').get(assetId)
      : this.ctx.db.prepare('SELECT json FROM voice_transcripts WHERE asset_id = ? AND project_id = ?').get(assetId, projectId)) as { json: string } | undefined;
    if (!r) return null; try { return JSON.parse(r.json) as Transcript; } catch { return null; }
  }
  /** FR-250: ONE op:caption.setPages with the cues of every given clip at its timeline position; other pages outside those windows stay. */
  captionPagesOp(projectId: string, placed: ReadonlyArray<{ transcript: Transcript; atMs: number; durationMs: number }>): OperationT {
    let existing: CompositionModelT['tracks']['caption']['pages'] = [];
    try { existing = this.ctx.hooks.composition(projectId).model.tracks.caption.pages; } catch { /* no head yet */ }
    const windows = placed.map((p) => [p.atMs, p.atMs + p.durationMs] as const);
    const kept = existing.filter((p) => !windows.some(([a, b]) => p.startMs < b && p.startMs + p.durationMs > a));
    const fresh = placed.flatMap((p) => cuesToCaptionPages(p.transcript.cues, p.atMs, { untilMs: p.atMs + p.durationMs }));
    return { op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages: [...kept, ...fresh].sort((a, b) => a.startMs - b.startMs) } } as OperationT;
  }
  /**
   * FR-251: several voice clips in ONE request (one per sentence; `v1` … `vN`), each a Library Asset named after its id with a
   * measured duration and timed cues. Placement: clips in order from `startMs`, `gapMs` (0.3 s) between clips of the same scene,
   * `sceneGapMs` (0.5 s) after a scene's last clip. `maxTotalMs`: when the total is longer, the whole set is generated again a
   * little faster (never cut). A failed clip fails the whole batch: nothing is placed, no timing is invented.
   */
  private async prepareVoiceBatch(projectId: string, b: Record<string, unknown>, language: 'id' | 'en'): Promise<Prepared> {
    const clips = (b['clips'] as Array<{ id: string; text: string; written?: string }>);
    const voice = await this.resolveVoice(String(b['voiceId'] ?? b['voice'] ?? ''), language);
    const scenes = Array.isArray(b['scenes']) ? (b['scenes'] as string[][]) : null;
    const sceneOf = new Map<string, number>(); scenes?.forEach((sc, i) => sc.forEach((id) => sceneOf.set(id, i)));
    const gap = typeof b['gapMs'] === 'number' ? b['gapMs'] : 300; const sceneGap = typeof b['sceneGapMs'] === 'number' ? b['sceneGapMs'] : 500;
    const startMs = typeof b['startMs'] === 'number' ? b['startMs'] : 0;
    const maxTotal = typeof b['maxTotalMs'] === 'number' ? b['maxTotalMs'] : null;
    const style = typeof b['style'] === 'string' ? b['style'] : undefined;
    const maxSpeed = voice.cloud ? (voice.provider === 'elevenlabs' ? 1.2 : 1.25) : 1.2;
    const gapAfter = (i: number): number => (i === clips.length - 1 ? 0 : scenes ? (sceneOf.get(clips[i]!.id) === sceneOf.get(clips[i + 1]!.id) ? gap : sceneGap) : gap);
    const reuse = b['insert'] === false;                                    // review A2: only the agent's voice-first batches (never a "new take")
    return { modelKey: voice.cloud ? null : voice.modelKey ?? null, run: (j) => this.withJobDir(j, async () => {
      let speed = typeof b['speed'] === 'number' ? b['speed'] : 1;
      const since = this.ctx.now();
      const fresh: string[][] = [[], []];                                   // review A3: assets this batch registered, per pass
      const runAll = async (pass: number) => {
        const out: Array<{ id: string; assetId: string; durationMs: number; transcript: Transcript; usd: number }> = [];
        for (const [i, c] of clips.entries()) {
          const key = [projectId, voice.id, speed, language, style ?? '', c.text, c.written ?? ''].join('\u0000');
          const hit = reuse ? this.voiceReuse.get(key) : undefined;
          const hitTranscript = hit && getAsset(this.ctx, hit.assetId, projectId)?.status === 'ready' ? this.transcriptOf(hit.assetId) : null;
          if (hit && hitTranscript) { out.push({ id: c.id, assetId: hit.assetId, durationMs: hit.durationMs, transcript: hitTranscript, usd: 0 }); this.clipHooks.get(j.jobId)?.(out.length, clips.length); continue; }
          if (hit) this.voiceReuse.delete(key);
          const r = await this.voiceClip(j, projectId, voice, { name: pass ? `${c.id}-${pass + 1}` : c.id, text: c.text, ...(c.written ? { written: c.written } : {}) },
            { language, speed, ...(style ? { style } : {}), part: (f) => j.progress(Math.min(0.94, (pass ? 0.5 : 0) + ((i + f) / clips.length) * (pass ? 0.45 : (maxTotal ? 0.5 : 0.9))), `clip ${c.id}`) });
          fresh[pass]!.push(r.assetId);
          if (reuse) { this.voiceReuse.delete(key); this.voiceReuse.set(key, { assetId: r.assetId, durationMs: r.durationMs }); while (this.voiceReuse.size > VOICE_REUSE_MAX) this.voiceReuse.delete(this.voiceReuse.keys().next().value!); }
          out.push({ id: c.id, ...r });
          this.clipHooks.get(j.jobId)?.(out.length, clips.length);           // QA UX round 1: "n of 9 clips ready" on the Plan Card
        }
        return out;
      };
      const total = (rs: ReadonlyArray<{ durationMs: number }>) => rs.reduce((s, r, i) => s + r.durationMs + gapAfter(i), 0);
      let done: Awaited<ReturnType<typeof runAll>>; let regenerated = false;
      try {
        done = await runAll(0);
        if (maxTotal !== null && total(done) > maxTotal && speed < maxSpeed) {
          // shorten by speaking a little faster: the speech part must shrink by (total − max), gaps stay
          const speech = done.reduce((s, r) => s + r.durationMs, 0); const gaps = total(done) - speech;
          speed = Math.min(maxSpeed, Math.round(speed * (speech / Math.max(1, maxTotal - gaps)) * 1.02 * 100) / 100);
          done = await runAll(1); regenerated = true;
          // review A3: the first, too-long takes are replaced: they leave the Library
          const kept = new Set(done.map((r) => r.assetId));
          this.discardGenerated(projectId, fresh[0]!.filter((id) => !kept.has(id)), since);
        }
        if (j.signal.aborted) throw new CancelledError();                  // Cancel during the last clip: nothing is kept either
      } catch (e) {
        // review A3: a failed or cancelled batch places nothing, so the clips it already made leave the Library too (none is half-used)
        this.discardGenerated(projectId, [...fresh[0]!, ...fresh[1]!], since);
        throw e;
      }
      let at = startMs;
      const placed = done.map((r, i) => { const atMs = at; at += r.durationMs + gapAfter(i); return { ...r, atMs, endMs: atMs + r.durationMs, scene: sceneOf.get(r.id) ?? null }; });
      const ops: OperationT[] = placed.map((p) => ({ op: 'op:audio.addLayer', args: { assetId: p.assetId, atMs: p.atMs, volume: 1, role: 'voice' } } as OperationT));
      if (b['captions'] === true) ops.push(this.captionPagesOp(projectId, placed));
      j.progress(0.96, 'place');
      const totalMs = placed.length ? placed.at(-1)!.endMs - startMs : 0;
      return { ...(placed[0] ? { assetId: placed[0].assetId } : {}), result: { batch: true, voiceId: voice.id, speed, regenerated, totalMs, overLimit: maxTotal !== null && totalMs > maxTotal, costUsd: Math.round(placed.reduce((s, p) => s + p.usd, 0) * 10000) / 10000,
        clips: placed.map((p) => ({ id: p.id, assetId: p.assetId, name: getAsset(this.ctx, p.assetId, projectId)?.name ?? `${p.id}.wav`, durationMs: p.durationMs, atMs: p.atMs, endMs: p.endMs, scene: p.scene, timing: p.transcript.method, cues: p.transcript.cues.map(cueDto) })) }, ops };
    }) };
  }
  /**
   * Review A3: removes clips a voice batch registered but will not use (failed / cancelled batch, replaced first pass). Only assets made
   * by this batch (created at or after `since`, so never an older asset the ingest de-duplicated to) and not on the current head.
   */
  private discardGenerated(projectId: string, ids: readonly string[], since: string): void {
    const ctx = this.ctx; const gone: string[] = [];
    let head = '';
    try { head = JSON.stringify(ctx.hooks.composition(projectId).model); } catch { /* no head yet */ }
    for (const id of new Set(ids)) {
      const a = getAsset(ctx, id, projectId);
      if (!a || a.created_at < since || head.includes(id)) continue;
      try {
        ctx.db.transaction(() => {
          ctx.db.prepare('UPDATE generator_jobs SET result_asset_id = NULL WHERE result_asset_id = ?').run(id);
          ctx.db.prepare('DELETE FROM voice_transcripts WHERE asset_id = ?').run(id);
          ctx.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
        })();
        fs.rmSync(assetDir(ctx, projectId, id), { recursive: true, force: true });
        for (const [k, v] of this.voiceReuse) if (v.assetId === id) this.voiceReuse.delete(k);
        gone.push(id);
      } catch (e) { ctx.log.warn({ projectId, assetId: id, err: String(e).slice(0, 300) }, 'unused voice clip could not be removed'); }
    }
    // the Asset Panel reloads its list (same notice as FR-052 restores)
    if (gone.length) ctx.bus.emit('service.notice', { at: ctx.now(), kind: 'assets-removed', projectId, assetIds: gone });
  }
  /** FR-251 for the agent runtime: runs a batch and resolves with the clips once done; rejects with the job's EM code (nothing placed).
   *  Review A1: `signal` (Cancel on the Plan Card) cancels the batch job; the clips it already made are removed (A3). */
  async voiceBatch(projectId: string, body: VoiceBatchInput, opts: { signal?: AbortSignal; onClip?: (done: number, total: number) => void } = {}): Promise<VoiceBatchResult> {
    if (opts.signal?.aborted) throw em('EM-4303', 'The change was cancelled before it was applied. Nothing changed.', { status: 409 });
    const job = await this.create(projectId, 'voice', { ...body, clips: body.clips, language: body.language ?? 'id', insert: body.insert ?? false });
    const onAbort = () => { this.cancel(String(job['id'])); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.onClip) this.clipHooks.set(String(job['id']), (d, n) => { try { opts.onClip!(d, n); } catch { /* progress only */ } });
    const row = await this.waitJob(String(job['id'])).finally(() => { opts.signal?.removeEventListener('abort', onAbort); this.clipHooks.delete(String(job['id'])); });
    if (opts.signal?.aborted) throw em('EM-4303', 'The change was cancelled before it was applied. Nothing changed.', { status: 409, details: { jobId: job['id'] } });
    if (!row || row.status !== 'done') throw em((row?.error_code ?? 'EM-7101') as 'EM-7101', 'The voice clips could not be generated.', { details: { jobId: job['id'], status: row?.status ?? 'missing' } });
    return { jobId: row.id, ...(JSON.parse(row.result_json ?? '{}') as Omit<VoiceBatchResult, 'jobId'>) };
  }

  /**
   * FR-285: the transcription model of a prep job: the LARGEST installed whisper whose `ramBytes` fits `totalmem − 1.5 GB` (small-q5
   * is weak on Indonesian speech; an 8 GB laptop runs medium-q5), then the Creator's `sttModelKey`, then the download default
   * (small-q5 below 6 GB RAM, else medium-q5; EM-7001 names it so the notice can offer the install).
   */
  async prepModel(asked?: string, totalMem = os.totalmem()): Promise<ModelDef> {
    const models = modelsServiceOf(this.ctx);
    const fits = models.defs().filter((d) => d.task === 'stt' && d.engine === 'whisper.cpp' && d.availability !== 'virtual' && d.ramBytes <= totalMem - PREP_RAM_RESERVE).sort((a, b) => b.ramBytes - a.ramBytes || b.bytes - a.bytes);
    for (const d of fits) if (await models.isInstalled(d.key)) return d;
    if (asked) return this.requireInstalled(asked, 'Siapkan rekaman');
    const want = totalMem < 6 * 1024 ** 3 ? 'whisper-small-q5' : 'whisper-medium-q5';
    return this.requireInstalled(models.def(want) ? want : defaultModelFor('stt', this.ctx.hooks.tier()), 'Siapkan rekaman');
  }
  /**
   * FR-285 … FR-287 (R-130 kind `prep`): the footage prep job (s2/reels/footage-prep.ts) with this service's ffmpeg (heavy lock),
   * Asset registration (ingest) and whisper engine step. The master Asset is the job's `resultAssetId`.
   */
  private async prepareFootagePrep(projectId: string, b: Record<string, unknown>, _tier: 'T0' | 'T1' | 'T2'): Promise<Prepared> {
    const ctx = this.ctx; const models = modelsServiceOf(ctx);
    const voice = getAsset(ctx, String(b['voiceAssetId']), projectId);
    if (!voice || voice.deleted_at) throw em('EM-9003', 'Not found.', { path: 'body.voiceAssetId' });
    const def = await this.prepModel(typeof b['sttModelKey'] === 'string' ? b['sttModelKey'] : undefined);
    const input: PrepInput = { voiceAssetId: voice.id, ...(typeof b['cameraAssetId'] === 'string' ? { cameraAssetId: b['cameraAssetId'] } : {}), ...(typeof b['script'] === 'string' && b['script'].trim() ? { script: b['script'] } : {}),
      ...(rotationOf(b['rotation']) !== null ? { rotation: rotationOf(b['rotation'])! } : {}), ...(typeof b['targetFps'] === 'number' ? { targetFps: b['targetFps'] } : {}), ...(typeof b['maxTotalMs'] === 'number' ? { maxTotalMs: b['maxTotalMs'] } : {}),
      sttModelKey: def.key, ...(typeof b['offsetMs'] === 'number' ? { offsetMs: b['offsetMs'] } : {}), ...(b['sync'] && typeof b['sync'] === 'object' ? { sync: b['sync'] as NonNullable<PrepInput['sync']> } : {}),
      ...(typeof b['resumedFrom'] === 'string' ? { resumedFrom: b['resumedFrom'] } : {}), ...(typeof b['shortSide'] === 'number' ? { shortSide: b['shortSide'] } : {}), ...(b['confirmRotation'] === true ? { confirmRotation: true } : {}) };
    return { modelKey: def.key, run: (j) => this.withJobDir(j, () => runFootagePrep({
      ctx, modelKey: def.key,
      ffmpeg: (jj, args, cwd, timeoutMs, o = {}) => s2(ctx).heavy.run(() => runTool({ exe: ctx.resources.ffmpeg, args: ['-v', o.verbose ? 'info' : 'error', '-nostdin', '-y', ...args], cwd, timeoutMs, signal: jj.signal,
        ...(o.onStderrLine ? { onStderrLine: o.onStderrLine } : {}), ...(o.onStdoutLine ? { onStdoutLine: o.onStdoutLine } : {}) })),
      register: (pid, file, name) => this.register(pid, file, name),
      listen: (jj, i) => this.engineStep(jj, 'whisper.cpp', 'listen', (c) => this.engines.listenPieces!({ modelPath: firstWith(models.dirOf(def), /\.bin$/), wavPaths: i.wavPaths, language: i.language, audioDurationMs: i.audioDurationMs, ...(i.prompt ? { prompt: i.prompt } : {}) },
        { ...c, onProgress: (f) => jj.progress(0.68 + f * 0.2, 'listen') })),
    }, j, projectId, input)) };
  }
  /**
   * FR-286 (R-148): continue a prep job that stopped for the rotation confirmation: a new prep job with the Creator's rotation and
   * the offset already measured; the stopped job is closed as `done` so it leaves the pending list. Returns the new job DTO.
   */
  async continuePrep(projectId: string, jobId: string, rotation: 0 | 90 | 180 | 270): Promise<Record<string, unknown>> {
    const r = this.get(jobId);
    if (!r || r.project_id !== projectId || r.kind !== 'prep') throw em('EM-9003', 'Not found.');
    if (r.status !== 'needs-input') throw em('EM-9002', 'This job is not waiting for a rotation.', { status: 409, details: { status: r.status } });
    const res = (r.result_json ? JSON.parse(r.result_json) : {}) as { input?: Record<string, unknown> };
    const body = { ...(res.input ?? JSON.parse(r.input_json) as Record<string, unknown>), rotation, resumedFrom: jobId };
    const job = await this.create(projectId, 'prep', body);
    this.ctx.db.prepare("UPDATE generator_jobs SET status = 'done' WHERE id = ?").run(jobId);
    return job;
  }
  /** FR-289: one still of a Composition Model rendered with the Engine (PNG or JPEG) into `outPath`, under the heavy lock. */
  async renderStill(projectId: string, model: CompositionModelT, frameMs: number, outPath: string, format: 'png' | 'jpeg' = 'png', signal?: AbortSignal): Promise<void> {
    const jobId = this.ctx.newId(); const ac = new AbortController();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });
    const j = { jobId, signal: ac.signal, progress: () => undefined } as unknown as JobContext;
    const assetIds = [...new Set([...model.tracks.video.flatMap((c) => (c.assetId ? [c.assetId] : [])), ...model.tracks.audio.map((a) => a.assetId), ...model.tracks.overlay.map((o) => (o as { assetId?: string }).assetId).filter((x): x is string => typeof x === 'string')])];
    await createJobDir(this.ctx.paths.tmp, jobId);
    try { await this.engineStep(j, 'none', 'still', (c) => this.engines.frame({ model, projectId, frameMs, outPath, assetIds, format }, { ...c, ctx: this.ctx, jobId })); }
    finally { await removeJobDir(this.ctx.paths.tmp, jobId).catch(() => undefined); }
  }
  /**
   * FR-285 (Brainstorm tool `media.analyze`): the stored analysis for these assets, else a prep job started now and awaited up to
   * `waitMs`; a job still running after that answers `{status: 'running', jobId}` (the next call returns the result).
   */
  async analyzeFootage(projectId: string, input: { voiceAssetId: string; cameraAssetId?: string; script?: string }, waitMs = 150_000): Promise<Record<string, unknown>> {
    const ctx = this.ctx;
    const stored = latestAnalysis(ctx, projectId);
    if (stored && stored.voiceAssetId === input.voiceAssetId && (input.cameraAssetId === undefined || stored.cameraAssetId === input.cameraAssetId)) return { status: 'done', ...analysisSummary(stored) };
    const live = ctx.db.prepare("SELECT id FROM generator_jobs WHERE project_id = ? AND kind = 'prep' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(projectId) as { id: string } | undefined;
    const waiting = ctx.db.prepare("SELECT id, result_json FROM generator_jobs WHERE project_id = ? AND kind = 'prep' AND status = 'needs-input' ORDER BY created_at DESC LIMIT 1").get(projectId) as { id: string; result_json: string | null } | undefined;
    if (waiting && !live) return { status: 'needs-input', jobId: waiting.id, code: 'EM-1503', note: 'The Creator must confirm the video rotation (four thumbnails are shown in the chat); call again afterwards.' };
    const jobId = live?.id ?? String((await this.create(projectId, 'prep', { voiceAssetId: input.voiceAssetId, ...(input.cameraAssetId ? { cameraAssetId: input.cameraAssetId } : {}), ...(input.script ? { script: input.script } : {}) }))['id']);
    const row = await Promise.race([this.waitJob(jobId), new Promise<undefined>((r) => { const h = setTimeout(() => r(undefined), waitMs); h.unref?.(); })]);
    if (!row) return { status: 'running', jobId, note: 'Still analysing; call media.analyze again in a minute.' };
    if (row.status === 'needs-input') return { status: 'needs-input', jobId, code: 'EM-1503', note: 'The Creator must confirm the video rotation (four thumbnails are shown in the chat); call again afterwards.' };
    if (row.status !== 'done') return { status: row.status, jobId, error: { code: row.error_code ?? 'EM-7101' } };
    const a = latestAnalysis(ctx, projectId);
    return a ? { status: 'done', jobId, ...analysisSummary(a) } : { status: 'done', jobId };
  }

  /** FR-104: captions for the Sequence audio: each video Clip's audio segment is transcribed and its pages placed on the timeline. */
  private async prepareSequenceCaptions(projectId: string, b: Record<string, unknown>, tier: 'T0' | 'T1' | 'T2'): Promise<Prepared> {
    const ctx = this.ctx; const models = modelsServiceOf(ctx);
    const head = ctx.hooks.composition(projectId).model;
    const timing = deriveTiming(head);
    // video Clips and audio layers (e.g. a voice-over placed later on the timeline), each at its own window
    const segs = audioPlacements(head, (id) => getAsset(ctx, id, projectId)?.duration_ms ?? null).flatMap((pl) => {
      const a = getAsset(ctx, pl.assetId, projectId);
      if (!a || (a.kind !== 'video' && a.kind !== 'audio') || a.status !== 'ready' || a.has_audio !== 1) return [];
      return [{ ...pl, src: path.resolve(ctx.paths.media, a.playable_path ?? a.original_path) }];
    });
    if (!segs.length) throw em('EM-7103', 'The Sequence has no audio to transcribe.', { details: { tool: 'captions.generate', reason: 'no-audio' } });
    if (timing.durationMs > 1_800_000) throw em('EM-1011', 'This Sequence is longer than 30 minutes.', { details: { reason: 'duration' } });
    const key = typeof b['modelKey'] === 'string' ? b['modelKey'] : defaultModelFor('stt', tier);
    const def = await this.requireInstalled(key, 'Generate Captions');
    const language = String(b['language'] ?? 'id');
    return { modelKey: def.key, run: (j) => this.withJobDir(j, async () => {
      const modelPath = firstWith(models.dirOf(def), /\.bin$/);
      const pages: unknown[] = []; let detected: string | null = null;
      const sources: Array<{ assetId: string; pages: unknown[] }> = [];             // FR-261: what each clip says, in its SOURCE time
      for (const [i, sg] of segs.entries()) {
        const srcMs = Math.max(100, Math.round((sg.toMs - sg.fromMs) * sg.playbackRate));
        const wav = path.join(ctx.paths.tmp, 'jobs', j.jobId, `seg-${i + 1}.wav`);
        await s2(ctx).heavy.run(() => runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', '-ss', (sg.trimBeforeMs / 1000).toFixed(3), '-t', (srcMs / 1000).toFixed(3), '-i', sg.src,
          '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], cwd: path.dirname(wav), timeoutMs: Math.max(60_000, srcMs), signal: j.signal }));
        const r = await this.engineStep(j, 'whisper.cpp', 'transcribe', (c) => this.engines.captions({ modelPath, wavPath: wav, language, audioDurationMs: srcMs }, { ...c, onProgress: (f) => c.onProgress((i + f) / segs.length) }));
        detected ??= r.language;
        // the extracted segment starts at the clip's trim point: page times are relative to it
        pages.push(...shiftPages(r.pages, { fromMs: sg.fromMs, toMs: sg.toMs, trimBeforeMs: 0, playbackRate: sg.playbackRate }));
        sources.push({ assetId: sg.assetId, pages: shiftPages(r.pages, { fromMs: sg.trimBeforeMs, toMs: sg.trimBeforeMs + srcMs, trimBeforeMs: 0, playbackRate: 1 }) });
      }
      pages.sort((a, b) => (a as { startMs: number }).startMs - (b as { startMs: number }).startMs);
      // FR-261: a caption look asked by the plan (kinetic captions over footage) comes with the pages
      const style = typeof b['presetId'] === 'string' && /^preset:caption\.[a-z0-9-]+$/.test(b['presetId']) ? [{ op: 'op:caption.setStyle', target: { kind: 'project' }, args: { presetId: b['presetId'] } } as OperationT] : [];
      return { result: { pages, language: detected, modelId: def.key, durationMs: timing.durationMs, source: 'sequence', sources }, ops: [{ op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages } } as OperationT, ...style] };
    }) };
  }
  private async prepare(projectId: string, kind: GeneratorKind, b: Record<string, unknown>): Promise<Prepared> {
    const ctx = this.ctx; const tier = ctx.hooks.tier(); const models = modelsServiceOf(ctx);
    const lang = b['language'];
    if (lang !== undefined && lang !== 'id' && lang !== 'en') throw em('EM-7105', 'Only Indonesian and English are supported.', { details: { tool: kind, language: lang } });
    const short = (id: string) => id.slice(-8).toLowerCase();

    if (kind === 'prep') return this.prepareFootagePrep(projectId, b, tier);
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
        // FR-104: page times are source times; move them to where this Asset is heard on the Sequence (its Clip / audio layer
        // start minus its trim, over its playback rate, limited to its visible window). An Asset not on the timeline keeps them.
        let placements: AudioPlacement[] = [];
        try { placements = audioPlacements(ctx.hooks.composition(projectId).model, (id) => getAsset(ctx, id, projectId)?.duration_ms ?? null, { assetId: asset.id }); } catch { /* no head yet */ }
        const pages = placements.length ? placePages(r.pages, placements) : r.pages;
        return { result: { pages, language: r.language, modelId: def.key, durationMs: asset.duration_ms, placements: placements.length, sources: [{ assetId: asset.id, pages: r.pages }] }, ops: [{ op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages } }] };
      }) };
    }
    if (kind === 'voice') {
      const language = lang === 'en' ? 'en' : 'id';
      if (Array.isArray(b['clips'])) return this.prepareVoiceBatch(projectId, b, language);
      const text = String(b['text'] ?? '');
      if ([...text].length > 2000) throw em('EM-7106', 'Voice generation accepts up to 2,000 characters at a time.', { details: { chars: [...text].length, limit: 2000 } });
      const voice = await this.resolveVoice(String(b['voiceId'] ?? ''), language);
      const atMs = typeof b['atMs'] === 'number' ? b['atMs'] : 0;
      const written = typeof b['captionText'] === 'string' && b['captionText'].trim() ? b['captionText'] : undefined;
      return { modelKey: voice.cloud ? null : voice.modelKey ?? null, run: (j) => this.withJobDir(j, async () => {
        const c = await this.voiceClip(j, projectId, voice, { name: voiceAssetName(text, j.jobId), text, ...(written ? { written } : {}) },
          { language, ...(typeof b['speed'] === 'number' ? { speed: b['speed'] } : {}), ...(typeof b['style'] === 'string' ? { style: b['style'] } : {}), part: (f) => j.progress(0.05 + f * 0.85, 'synthesize') });
        j.progress(0.95, 'ingest');
        const ops: OperationT[] = [{ op: 'op:audio.addLayer', args: { assetId: c.assetId, atMs, volume: 1, role: 'voice' } } as OperationT];
        if (b['captions'] === true) ops.push(this.captionPagesOp(projectId, [{ transcript: c.transcript, atMs, durationMs: c.durationMs }]));
        return { assetId: c.assetId, result: { assetId: c.assetId, waveform: true, durationMs: c.durationMs, voiceId: voice.id, timing: c.transcript.method, costUsd: c.usd, captions: b['captions'] === true,
          cues: c.transcript.cues.map(cueDto) }, ops };
      }) };
    }
    if (kind === 'music') {
      const key = typeof b['modelKey'] === 'string' ? b['modelKey'] : defaultModelFor('music', tier);
      const durationMs = Number(b['durationMs']);
      const vocals = lang === 'en' ? ', English vocals' : ', Indonesian vocals';   // FR-106: the language of sung lyrics
      const prompt = `${String(b['prompt'] ?? '')}${typeof b['style'] === 'string' && b['style'] ? `, ${b['style']}` : ''}${b['instrumental'] === false ? vocals : ', instrumental'}`;
      if (key !== 'loop-library-cc0') {
        // FR-247: AI music needs the ACE-Step engine (embedded Python, GPU ≥ 4 GB), which this version does not ship
        const def = models.def(key);
        if (!def || def.engine === 'ace-step') throw em('EM-7107', 'AI music generation is not available in this version; use the CC0 music library.', { details: { modelKey: key, fallback: 'loop-library-cc0' } });
        await this.requireInstalled(key, 'Generate Music');
      }
      const lib = musicLibraryOf(ctx);
      const asked = typeof b['trackId'] === 'string' ? lib.require(b['trackId']) : null;
      if (ctx.settings.get().privateMode && !(asked ? lib.isReady(asked) : MUSIC_LIBRARY.some((t) => lib.isReady(t)))) throw em('EM-8202', 'Private Mode is on, so no music track can be downloaded.', { details: { action: 'music download' } });
      return { modelKey: null, run: (j) => this.withJobDir(j, async () => {
        j.progress(0.05, 'download');
        const track = asked ?? await lib.pickFor(prompt);
        if (asked) await lib.download(asked.id);
        const src = await lib.readyFile(track.id);
        const wav = path.join(ctx.paths.tmp, 'jobs', j.jobId, 'out.wav');
        // looped to the length; no ffmpeg filter (the slim FFmpeg has no afade): the bed op's fadeInMs / fadeOutMs fade it in the Engine
        await this.engineStep(j, 'loops', 'generate', () => runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', '-stream_loop', '-1', '-i', src,
          '-t', (durationMs / 1000).toFixed(3), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', wav], cwd: path.dirname(wav), timeoutMs: 120_000, signal: j.signal }));
        j.progress(0.9, 'ingest');
        const assetId = await this.register(projectId, wav, `music-${track.id}.wav`);
        const bed = { ...(typeof b['volume'] === 'number' && b['volume'] >= 0.02 && b['volume'] <= 1 ? { volume: b['volume'] } : {}), ...(typeof b['fadeInMs'] === 'number' ? { fadeInMs: b['fadeInMs'] } : {}), ...(typeof b['fadeOutMs'] === 'number' ? { fadeOutMs: b['fadeOutMs'] } : {}) };
        return { assetId, result: { assetId, durationMs, source: 'loop-library', instrumental: true, cc0: true, trackId: track.id, title: track.title, artist: track.artist, credit: track.credit, licence: MUSIC_LIBRARY_LICENCE.url }, ops: [musicBedOp(assetId, bed)] };
      }) };
    }
    if (kind === 'thumbnail') {
      const prompt = typeof b['prompt'] === 'string' && b['prompt'].trim() ? b['prompt'].trim() : undefined;
      const size = (b['size'] as { w?: number; h?: number } | undefined) ?? {};
      const count = Math.max(1, Math.min(4, typeof b['count'] === 'number' ? Math.round(b['count']) : 1));   // FR-103: 1–4 candidates
      const style = (THUMBNAIL_STYLES as readonly string[]).includes(String(b['style'])) ? b['style'] as ThumbnailStyle : 'bold';
      const title = typeof b['titleText'] === 'string' && b['titleText'].trim() ? b['titleText'].trim().slice(0, 500) : '';
      const atMs = typeof b['frameMs'] === 'number' ? b['frameMs'] : 0;
      const overlay = (assetId: string): OperationT[] => [{ op: 'op:overlay.addImage', args: { assetId, atMs } } as OperationT];
      // Which path: an explicit modelKey wins ('frame-composite' = still of a frame, never sd-cli; an image model = diffusion and
      // must be installed, EM-7001). Without one, a prompt uses the tier's image model when it is installed (else the first
      // installed one) and falls back to the frame still, so a T0 PC without a model always gets a thumbnail.
      const asked = typeof b['modelKey'] === 'string' ? b['modelKey'] : null;
      if (asked !== null && asked !== 'frame-composite' && models.def(asked)?.task !== 'image') throw em('EM-9002', 'Invalid request: modelKey is not an image model.', { status: 400, path: 'body.modelKey' });
      let imageKey: string | null = asked === 'frame-composite' ? null : asked;
      if (asked === null && prompt) {
        const preferred = defaultModelFor('image', tier);
        const candidates = [preferred, ...models.defs().filter((d) => d.task === 'image' && d.availability !== 'virtual').map((d) => d.key)].filter((k) => k !== 'frame-composite');
        for (const k of candidates) if (await models.isInstalled(k)) { imageKey = k; break; }
      }
      if (imageKey !== null) {
        // FR-103: style wording and the title text go into the diffusion prompt (prompt mode has no separate overlay pass)
        const fullPrompt = [prompt ?? (title || 'video thumbnail'), THUMB_PROMPT[style], ...(title ? [`thumbnail with the title text "${title}"`] : [])].join(', ');
        const def = await this.requireInstalled(imageKey, 'Generate Thumbnail');
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
      if (deriveTiming(head.model).durationMs <= 1000 && head.model.tracks.video.length === 0 && head.model.tracks.text.length === 0) throw em('EM-2202', 'Add a scene or insert an asset first.');
      let model = structuredClone(head.model);
      const frameMs = typeof b['frameMs'] === 'number' ? b['frameMs'] : 0;
      if (title) {
        // QA P1 2026-10-29 "Title on the cover" missing: the variant's entrance motion (title = rise) starts at the captured frame, so
        // the still showed it at opacity 0, and the other candidates fell outside its 1 s. The cover title is static (motion none)
        // and spans the whole Sequence, so every candidate frame shows it fully.
        const coverMs = Math.max(1000, Math.round(deriveTiming(model).durationMs));
        const r = applyOperations(model, [{ op: 'op:text.add', args: { text: title, variant: THUMB_VARIANT[style], atMs: 0, durationMs: coverMs, motion: { presetId: 'preset:motion.none' } } }],
          { assets: listAssets(ctx, projectId).map(toFacts), tier, newId: ctx.newId });
        if (r.ok) model = r.value.model; else ctx.log.warn({ projectId }, "thumbnail cover title could not be added");
      }
      const assetIds = [...new Set([...model.tracks.video.flatMap((c) => (c.assetId ? [c.assetId] : [])), ...model.tracks.audio.map((a) => a.assetId)])];
      // candidates: the chosen frame first, then frames spread over the Sequence (still + title overlay each)
      const durationMs = Math.max(1, deriveTiming(model).durationMs);
      const times = [...new Set(Array.from({ length: count }, (_, i) => (i === 0 ? frameMs : Math.round((frameMs + (i * durationMs) / (count + 1)) % durationMs))))];
      return { modelKey: null, run: (j) => this.withJobDir(j, async () => {
        const candidates: Array<{ assetId: string; frameMs: number }> = [];
        for (const [i, at] of times.entries()) {
          const out = path.join(ctx.paths.tmp, 'jobs', j.jobId, `still-${i + 1}.png`);
          await this.engineStep(j, 'none', 'still', (c) => this.engines.frame({ model, projectId, frameMs: settledCaptureMs(model, at), outPath: out, assetIds }, { ...c, onProgress: (f) => c.onProgress((i + f) / times.length), ctx, jobId: j.jobId }));
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

