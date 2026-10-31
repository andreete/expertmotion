// Footage prep job (FR-285 … FR-287, ADR-039, API R-130 kind `prep`, R-145, R-148, R-149, R-154): probe → sync (camera vs separate
// voice recording, 16 kHz envelopes) → master (ONE ffmpeg pass: rotation, fps, short side 1080, the recorder's voice replaces the camera
// audio, voice clean-up + two-pass loudnorm, H.264/AAC; registered as an Asset through ingest) → phrases (envelope of the cleaned
// voice) → listen (every phrase as its own 16 kHz piece, ONE whisper-cli run with a names-only prompt, piece time + piece start = recording time)
// → takes (script lines ↔ phrases) → timing (syllable-proportional words per cut) → FootageAnalysis stored in `footage_analyses`.
// The analysis maths is `@expertmotion/models` `analysis` (packages/models/src/analysis, FR-280 … FR-284); this file is the I/O.
// Memory discipline (shared 1.9 GB server, PERFORMANCE §2): every ffmpeg runs under the Service-wide heavy lock with `-threads 2`,
// never two at once; whisper goes through the generator engine step. Generic constants only — nothing here knows a particular video.
import fs from 'node:fs';
import path from 'node:path';
import { analysis, type JobContext, type RecognisedToken } from '@expertmotion/models';
import { EmError, sanitizeFilename } from '@expertmotion/shared';
import type { ServiceContext } from '../../context.js';
import { getAsset, type AssetRow } from '../assets-repo.js';
import { em, freeBytes } from '../common.js';
import { detectH264, h264Args } from '../h264.js';
import type { ProbeJson } from '../probe.js';
import { ToolError, runTool, type ToolResult } from '../proc.js';

export type FootageAnalysis = analysis.FootageAnalysis;
export type Cut = analysis.Cut;
export type SyncResult = analysis.SyncResult;
export const PREP_STAGES = ['probe', 'sync', 'master', 'phrases', 'listen', 'takes', 'timing'] as const;
export type PrepStage = (typeof PREP_STAGES)[number];
/** Stage labels the UI shows on the progress card (Indonesian first, FR-285). */
export const PREP_STAGE_LABELS: Readonly<Record<PrepStage, { id: string; en: string }>> = Object.freeze({
  probe: { id: 'Membaca rekaman', en: 'Reading the recordings' }, sync: { id: 'Menyelaraskan suara dan video', en: 'Syncing audio and video' },
  master: { id: 'Membangun video master', en: 'Building the master video' }, phrases: { id: 'Mencari frasa suara', en: 'Finding voice phrases' },
  listen: { id: 'Mendengarkan kata-kata', en: 'Listening to the words' }, takes: { id: 'Memilih pengambilan terbaik', en: 'Picking the best takes' },
  timing: { id: 'Menyelaraskan teks dengan suara', en: 'Timing the words' },
});
export type Rotation = 0 | 90 | 180 | 270;
export interface PrepInput {
  voiceAssetId: string; cameraAssetId?: string; script?: string; rotation?: Rotation; targetFps?: number; maxTotalMs?: number; sttModelKey?: string;
  /** Continuation (R-148): the offset / sync measured by the job that stopped for the rotation confirmation. */
  offsetMs?: number; sync?: SyncResult; resumedFrom?: string;
  /** Short side of the master in pixels (default 1080; tests use a small value). */
  shortSide?: number;
  /** FR-286: always ask the Creator for the rotation of a landscape file without a rotation flag (skip the orientation heuristic). */
  confirmRotation?: boolean;
}
/** Speech budget for the picked takes: a Reel stays under 60 s, and the silent pieces (source card ≈ 3 s, hold ≈ 1.2 s, poster ≈ 3.5 s) take
 *  about 8 s of it, so extra lines that would push the speech past 52 s are dropped (the brief's own cap wins when given). */
export const DEFAULT_MAX_TOTAL_MS = 52_000;
const HOP_MS = 10; const JOIN_GAP_MS = 2000; const JOIN_PAD_MS = 150; const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
const ROT_FILTER: Record<Rotation, string | null> = { 0: null, 90: 'transpose=1', 180: 'hflip,vflip', 270: 'transpose=2' };

/** What the generator service lends the job: ffmpeg under the heavy lock, Asset registration through ingest, the whisper engine step. */
export interface PrepDeps {
  ctx: ServiceContext;
  ffmpeg(j: JobContext, args: string[], cwd: string, timeoutMs: number, o?: { onStderrLine?: (l: string) => void; onStdoutLine?: (l: string) => void; verbose?: boolean }): Promise<ToolResult>;
  register(projectId: string, file: string, name: string): Promise<string>;
  /** One whisper-cli process over several piece wavs; one token list per file, in order. */
  listen(j: JobContext, i: { wavPaths: string[]; language: string; audioDurationMs: number; prompt?: string }): Promise<RecognisedToken[][]>;
  modelKey: string;
}

/** Folder of a job's rotation thumbnails (`rot-<deg>.jpg`; transient, under tmp). */
export const prepDir = (ctx: ServiceContext, jobId: string): string => path.join(ctx.paths.tmp, `prep-${jobId}`);
export const rotationOf = (v: unknown): Rotation | null => (v === 0 || v === 90 || v === 180 || v === 270 ? v : null);

/** Display rotation from the stored ffprobe JSON (`side_data_list[].rotation`, e.g. -90 = rotate 90° clockwise to display), or null. */
export function metadataRotation(probeJson: string | null): Rotation | null {
  if (!probeJson) return null;
  try {
    const j = JSON.parse(probeJson) as ProbeJson;
    const v = j.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const raw = v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? (v?.tags?.['rotate'] !== undefined ? Number(v.tags['rotate']) : undefined);
    if (raw === undefined || !Number.isFinite(Number(raw))) return null;
    return rotationOf(((Math.round(-Number(raw) / 90) * 90) % 360 + 360) % 360);
  } catch { return null; }
}

const filterCache = new Map<string, Promise<Set<string>>>();
/** Names of the filters the ffmpeg binary has (`ffmpeg -filters`), cached per binary. */
export function availableFilters(ffmpeg: string): Promise<Set<string>> {
  let p = filterCache.get(ffmpeg);
  if (!p) {
    p = runTool({ exe: ffmpeg, args: ['-hide_banner', '-filters'], timeoutMs: 15_000, maxCollectBytes: 2_000_000 })
      .then((r) => new Set(r.stdout.split('\n').map((l) => /^\s*[.TSC]{2,4}\s+(\S+)\s+[AVN|]+->/.exec(l)?.[1]).filter((x): x is string => !!x))).catch(() => new Set<string>());
    filterCache.set(ffmpeg, p);
  }
  return p;
}
/** The clean-up chain limited to the filters this ffmpeg has (the full LGPL build has them all; the slim compositor build has none). */
export function cleanFilterFor(filters: ReadonlySet<string>): { filter: string | null; dropped: string[] } {
  const parts = analysis.voiceCleanFilter().split(','); const dropped: string[] = [];
  const kept = parts.filter((p) => { const name = p.split('=')[0]!; if (filters.has(name)) return true; dropped.push(name); return false; });
  return { filter: kept.length ? kept.join(',') : null, dropped };
}

/** The newest stored analysis of a project (R-145), or undefined. */
export function latestAnalysis(ctx: ServiceContext, projectId: string): (FootageAnalysis & { id: string; createdAt: string }) | undefined {
  const r = ctx.db.prepare('SELECT id, json, created_at FROM footage_analyses WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(projectId) as { id: string; json: string; created_at: string } | undefined;
  if (!r) return undefined;
  try { return { ...(JSON.parse(r.json) as FootageAnalysis), id: r.id, createdAt: r.created_at }; } catch { return undefined; }
}

const sourceOf = (ctx: ServiceContext, a: AssetRow): string => path.resolve(ctx.paths.media, a.playable_path ?? a.original_path);
const sec = (ms: number): string => (ms / 1000).toFixed(3);
const dataUrl = (file: string): string => `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;

/** The whole prep job. `j.progress(fraction, stage)` with the PREP_STAGES ids; the generator service turns `needsInput` into status `needs-input`. */
export async function runFootagePrep(d: PrepDeps, j: JobContext, projectId: string, input: PrepInput): Promise<{ assetId?: string; result: Record<string, unknown> }> {
  const { ctx } = d; const warnings: string[] = [];
  const dir = path.join(ctx.paths.tmp, 'jobs', j.jobId); fs.mkdirSync(dir, { recursive: true });
  const voice = getAsset(ctx, input.voiceAssetId, projectId);
  if (!voice || voice.deleted_at) throw em('EM-9003', 'Not found.');
  if (voice.status !== 'ready') throw em('EM-1301', `"${voice.name}" is not ready yet.`, { status: 422 });
  if (voice.has_audio !== 1) throw em('EM-7103', `"${voice.name}" has no audio.`, { details: { tool: 'media.analyze', reason: 'no-audio' } });
  const cameraId = input.cameraAssetId ?? (voice.kind === 'video' ? voice.id : undefined);
  const camera = cameraId ? getAsset(ctx, cameraId, projectId) : undefined;
  if (cameraId && (!camera || camera.deleted_at || camera.kind !== 'video')) throw em('EM-9003', 'Not found.', { path: 'body.cameraAssetId' });
  if (camera && camera.status !== 'ready') throw em('EM-1301', `"${camera.name}" is not ready yet.`, { status: 422 });
  const durationMs = voice.duration_ms ?? 0; const fps = input.targetFps ?? 30; const shortSide = Math.max(240, input.shortSide ?? 1080);
  const sameFile = camera?.id === voice.id;
  const language = (() => { try { return ctx.hooks.composition(projectId).model.settings.language; } catch { return 'id'; } })();
  const filters = await availableFilters(ctx.resources.ffmpeg);
  const clean = cleanFilterFor(filters);
  if (clean.dropped.length) warnings.push(`voice clean-up without ${clean.dropped.join(', ')} (not in this ffmpeg build)`);
  const ff = (args: string[], timeoutMs: number, o?: Parameters<PrepDeps['ffmpeg']>[4]) => d.ffmpeg(j, ['-threads', '2', ...args], dir, timeoutMs, o);
  const toPcm16k = async (src: string, out: string, af?: string) => {
    await ff(['-i', src, '-vn', '-map', '0:a:0', ...(af ? ['-af', af] : []), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', out], Math.max(60_000, 2 * durationMs));
    return analysis.readWav16(fs.readFileSync(out));
  };
  // sync (FR-285): both tracks to 16 kHz mono, envelope cross-correlation; EM-1500 below confidence 0.5
  const measureSync = async (): Promise<SyncResult> => {
    j.progress(0.08, 'sync');
    const v = await toPcm16k(sourceOf(ctx, voice), path.join(dir, 'voice16k.wav'));
    const c = await toPcm16k(sourceOf(ctx, camera!), path.join(dir, 'camera16k.wav'));
    // the lag search never exceeds half the shorter recording (a near-full lag has almost no overlap and correlates spuriously)
    const maxLagMs = Math.max(1000, Math.min(15000, Math.floor(Math.min(v.pcm.length, c.pcm.length) / 16 / 2)));
    const r = analysis.syncOffset(v.pcm, c.pcm, 16000, { maxLagMs });
    if (r.confidence < 0.5) throw em('EM-1500', 'The two recordings could not be synchronised.', { details: { confidence: r.confidence, offsetMs: r.offsetMs } });
    return r;
  };

  // ── probe: rotation from metadata, the Creator, or the orientation heuristic (FR-286)
  j.progress(0.02, 'probe');
  let rotation: Rotation = 0; let rotationSource: FootageAnalysis['rotationSource'] = 'none';
  const metaRot = camera ? metadataRotation(camera.probe_json) : null;
  const portraitWanted = (() => { try { return ['9:16', '4:5', '3:4'].includes(ctx.hooks.composition(projectId).model.settings.ratio); } catch { return true; } })();
  if (camera && input.rotation !== undefined) { rotation = input.rotation; rotationSource = 'creator'; }
  else if (metaRot !== null) { rotation = 0; rotationSource = 'metadata'; }   // ffmpeg applies the display matrix itself; nothing to add
  else if (camera && portraitWanted && (camera.width ?? 0) > (camera.height ?? 0)) {
    // a landscape file for a portrait video: look at a grey frame
    const grey = path.join(dir, 'grey.raw'); const gw = 160; const gh = Math.max(8, Math.round((gw * (camera.height ?? 9)) / Math.max(1, camera.width ?? 16)));
    let suggestion: { rotation: Rotation; confidence: number } = { rotation: 0, confidence: 0 };
    if (!input.confirmRotation) {
      try {
        await ff(['-ss', sec(0.35 * (camera.duration_ms ?? 0)), '-i', sourceOf(ctx, camera), '-frames:v', '1', '-vf', `scale=${gw}:${gh},format=gray`, '-f', 'rawvideo', grey], 60_000);
        const s = analysis.suggestRotation(new Uint8Array(fs.readFileSync(grey)), gw, gh); suggestion = { rotation: s.rotation, confidence: s.confidence };
      } catch (e) { if (j.signal.aborted) throw e; warnings.push('orientation heuristic failed'); }
    }
    if (suggestion.confidence >= 0.7 && !input.confirmRotation) { rotation = suggestion.rotation; rotationSource = 'heuristic'; }
    else {
      // EM-1503: the Creator decides from four thumbnails (data URLs in the result for a plain <img>, also served by R-154);
      // the job stops with needs-input and R-148 continues it with the offset already measured
      const out = prepDir(ctx, j.jobId); fs.mkdirSync(out, { recursive: true });
      const thumbnails: Array<{ rotation: Rotation; url: string }> = [];
      for (const deg of ROTATIONS) {
        const vf = [ROT_FILTER[deg], 'scale=-2:320'].filter(Boolean).join(',');
        const file = path.join(out, `rot-${deg}.jpg`);
        await ff(['-ss', sec(0.35 * (camera.duration_ms ?? 0)), '-i', sourceOf(ctx, camera), '-frames:v', '1', '-vf', vf, '-q:v', '6', file], 60_000);
        thumbnails.push({ rotation: deg, url: dataUrl(file) });
      }
      let offsetMs = input.offsetMs ?? 0; let sync = input.sync;
      if (input.offsetMs === undefined && !sameFile) { const r = await measureSync(); offsetMs = r.offsetMs; sync = r; }
      return { result: { needsInput: true, needsRotationConfirm: true, code: 'EM-1503', suggested: suggestion, offsetMs, ...(sync ? { sync } : {}), thumbnails,
        thumbs: Object.fromEntries(ROTATIONS.map((deg) => [deg, `/api/v1/projects/${projectId}/footage-prep/${j.jobId}/thumbs/${deg}`])), input: { ...input, offsetMs, ...(sync ? { sync } : {}) }, warnings } };
    }
  }

  let offsetMs = 0; let sync: SyncResult | undefined;
  if (camera && !sameFile) {
    if (input.offsetMs !== undefined) { offsetMs = input.offsetMs; sync = input.sync; } else { sync = await measureSync(); offsetMs = sync.offsetMs; }
  }

  // ── master (FR-287): disk check, loudnorm pass 1 on the cleaned voice, one video pass, register through ingest
  let masterAssetId: string | undefined; let loudness: FootageAnalysis['loudness']; let masterOffsetMs = 0;
  const voiceSrc = sourceOf(ctx, voice);
  j.progress(0.18, 'master');
  // the voice keeps −16 LUFS; a −2 dBTP ceiling leaves room for the music bed and SFX so the final mix stays ≤ −1 dBTP (QA A17)
  const ln = analysis.loudnormArgs({ targetI: -16, tp: -2.0, lra: 11 });
  let measured: analysis.LoudnessMeasure | null = null;
  {
    const lines: string[] = [];
    try {
      await ff(['-i', voiceSrc, '-vn', '-map', '0:a:0', '-af', [clean.filter, ln.measureFilter].filter(Boolean).join(','), '-f', 'null', '-'], Math.max(60_000, 2 * durationMs), { verbose: true, onStderrLine: (l) => { if (lines.length < 400) lines.push(l); } });
    } catch (e) { if (j.signal.aborted) throw e; throw new EmError('EM-1505', 'The loudness of the voice recording could not be measured.', { details: { engine: 'ffmpeg', stderrTail: e instanceof ToolError ? e.stderrTail : [] }, cause: e }); }
    measured = analysis.parseEbur128(lines.join('\n'));
    if (!measured || !Number.isFinite(measured.integratedLufs)) throw em('EM-1505', 'The loudness of the voice recording could not be measured.', { details: { engine: 'ffmpeg', reason: 'no-json' } });
    loudness = { inputI: measured.integratedLufs, inputTp: measured.truePeakDb, outputI: ln.target.targetI };
  }
  const audioFilter = [clean.filter, ln.applyFilter(measured)].filter(Boolean).join(',');
  if (camera) {
    const free = await freeBytes(ctx.paths.media); const need = 2 * camera.bytes + 500_000_000;
    if (free < need) throw em('EM-6005', 'Not enough disk space to build the master video.', { details: { needBytes: need, freeBytes: free } });
    const enc = (await detectH264(ctx.resources.ffmpeg)) ?? 'libopenh264';
    const outW = rotation === 90 || rotation === 270 ? camera.height : camera.width, outH = rotation === 90 || rotation === 270 ? camera.width : camera.height;
    const big = Math.max(outW ?? 0, outH ?? 0) > 1920;
    const vf: string[] = [];
    if (offsetMs < 0) { if (filters.has('tpad')) vf.push(`tpad=start_duration=${sec(-offsetMs)}:color=black`); else { masterOffsetMs = -offsetMs; warnings.push(`camera started ${-offsetMs} ms late and this ffmpeg has no tpad: master time = recording time − ${-offsetMs} ms`); } }
    if (ROT_FILTER[rotation]) vf.push(ROT_FILTER[rotation]!);
    vf.push(`fps=${fps}`, `scale='if(gte(iw,ih),-2,${shortSide})':'if(gte(iw,ih),${shortSide},-2)'`);
    const camIn = offsetMs > 0 ? ['-ss', sec(offsetMs), '-i', sourceOf(ctx, camera)] : ['-i', sourceOf(ctx, camera)];
    const voiceIn = masterOffsetMs > 0 ? ['-ss', sec(masterOffsetMs), '-i', voiceSrc] : ['-i', voiceSrc];
    const out = path.join(dir, 'master.mp4');
    const args = ['-progress', 'pipe:1', ...camIn, ...voiceIn, '-map', '0:v:0', '-map', '1:a:0', '-vf', vf.join(','), ...h264Args(enc, 'playable', { width: outW ?? null, height: outH ?? null }, big), '-pix_fmt', 'yuv420p',
      '-af', audioFilter, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-map_metadata', '-1', '-movflags', '+faststart', out];
    const camMs = camera.duration_ms ?? durationMs; const expectMs = Math.min(durationMs, Math.max(1, camMs - Math.max(0, offsetMs)));
    try {
      await ff(args, Math.max(180_000, 6 * camMs), { onStdoutLine: (l) => { const m = /^out_time_us=(\d+)/.exec(l); if (m) j.progress(0.2 + 0.4 * Math.min(1, Number(m[1]) / 1000 / expectMs), 'master'); } });
    } catch (e) {
      if (j.signal.aborted) throw e;
      const tail = e instanceof ToolError ? e.stderrTail : [];
      throw new EmError(tail.some((l) => /No space left/i.test(l)) ? 'EM-6005' : 'EM-1504', 'The master video could not be built.', { details: { engine: 'ffmpeg', rotation, stderrTail: tail }, cause: e });
    }
    j.progress(0.6, 'master');
    const stem = sanitizeFilename(voice.name.replace(/\.[^.]+$/, ''), 'voice');
    masterAssetId = await d.register(projectId, out, `${stem} · master.mp4`);
  }

  // ── phrases (FR-285): envelope of the RAW recorder voice (the gate in the clean-up chain flattens every pause to −80 dB, so
  // thresholds, phrase gaps and the quiet-edge search are measured on the original; the cleaned copy only feeds the recogniser)
  j.progress(0.64, 'phrases');
  const raw = await toPcm16k(voiceSrc, path.join(dir, 'raw16k.wav'));
  const cleaned = audioFilter ? await toPcm16k(voiceSrc, path.join(dir, 'clean16k.wav'), audioFilter) : raw;
  const env = analysis.makeEnvelope(raw.pcm, 16000, HOP_MS);
  const phrases = analysis.findPhrases(env, { mergeGapMs: 250, minMs: 500 });
  if (!phrases.length) throw em('EM-1501', 'No voice phrases were found in the recording.', { details: { durationMs } });
  const cleanedMs = Math.round((Math.min(raw.pcm.length, cleaned.pcm.length) / 16000) * 1000);

  // ── listen (FR-285): every phrase (150 ms pads) as its own piece wav from the CLEANED pcm (same timeline as the raw), ONE
  // whisper-cli run (word level, names-only prompt); a piece's word time + the piece start = recording time, so a recogniser's
  // timestamp drift in a long joined file cannot bleed words across phrases (real-kit run 5). `analysis.mapJoinedWords` stays unused.
  j.progress(0.68, 'listen');
  const plan = analysis.joinPlan(phrases, { gapMs: JOIN_GAP_MS, padMs: JOIN_PAD_MS, durationMs: cleanedMs });
  const piecesDir = path.join(dir, 'pieces'); fs.mkdirSync(piecesDir, { recursive: true });
  const at = (ms: number) => Math.min(cleaned.pcm.length, Math.round((ms / 1000) * 16000));
  const wavPaths = plan.pieces.map((pc, i) => { const f = path.join(piecesDir, `p-${String(i + 1).padStart(2, '0')}.wav`); fs.writeFileSync(f, analysis.writeWav16(cleaned.pcm.slice(at(pc.recFromMs), at(pc.recToMs)), 16000)); return f; });
  const prompt = input.script ? analysis.namesPrompt(input.script) : '';
  const perPiece = await d.listen(j, { wavPaths, language, audioDurationMs: plan.pieces.reduce((s, pc) => s + pc.recToMs - pc.recFromMs, 0), ...(prompt ? { prompt } : {}) });
  const phraseWords: analysis.TimedWord[][] = plan.pieces.map((pc, i) => (perPiece[i] ?? [])
    .filter((t) => { const x = t.text.trim(); return x && /[\p{L}\p{N}]/u.test(x); })
    .map((t) => { const clamp = (ms: number) => Math.max(pc.recFromMs, Math.min(pc.recToMs, pc.recFromMs + ms)); const fromMs = clamp(t.fromMs); return { text: t.text.trim(), fromMs, toMs: Math.max(fromMs, clamp(t.toMs)), ...(typeof t.conf === 'number' ? { conf: t.conf } : {}) }; }));
  if (!phraseWords.some((p) => p.length)) throw em('EM-1501', 'No words were recognised in the voice phrases.', { details: { phrases: phrases.length } });

  // ── takes (FR-285): script lines ↔ phrases; EM-1502 when a script matches nothing
  j.progress(0.9, 'takes');
  const scriptLines = input.script ? analysis.splitScriptLines(input.script) : [];
  const groups = analysis.groupTakes(scriptLines, phraseWords, { phrases });
  const maxTotalMs = input.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  // the recognition prompt's names (acronyms, brands) also spell the extra lines ("data senter" → "data center")
  const vocabulary = prompt ? prompt.split(/[,.]\s*/).flatMap((w) => w.split(/\s+/)).filter(Boolean) : [];
  const picked = analysis.pickTakes(groups, { maxTotalMs, padBeforeMs: 120, padAfterMs: 150, env, phraseWords, phrases, vocabulary });
  warnings.push(...picked.warnings);
  const lineOf = (c: Cut) => picked.lines.find((l) => l.index === c.lineIndex);
  if (scriptLines.length && !picked.cuts.some((c) => lineOf(c)?.source === 'script')) throw em('EM-1502', 'The script does not match the recording.', { details: { lines: scriptLines.length, phrases: phrases.length } });
  if (!picked.cuts.length) throw em('EM-1502', 'No usable take was found.', { details: { phrases: phrases.length } });

  // ── timing (FR-285): words spread by syllables over the voiced parts of each cut, the recogniser's times as the guide
  j.progress(0.95, 'timing');
  const cuts: Cut[] = picked.cuts.map((c) => {
    const voiced = analysis.voicedRanges(env, { fromMs: c.startMs, toMs: c.endMs, minPauseMs: 120 });
    const timed = analysis.timeWordsBySyllables(c.words.map((w) => w.text), voiced, { guide: c.words, fallback: { fromMs: c.startMs, toMs: c.endMs } });
    return { ...c, words: timed.length === c.words.length ? timed : c.words };
  });
  const result: FootageAnalysis = {
    version: 1, voiceAssetId: voice.id, ...(camera ? { cameraAssetId: camera.id } : {}), ...(masterAssetId ? { masterAssetId } : {}), offsetMs, ...(sync ? { sync } : {}), rotation, rotationSource,
    phrases, words: cuts.flatMap((c) => c.words), lines: picked.lines, takes: groups, cuts, dropped: picked.dropped,
    ...(loudness ? { loudness } : {}), durationMs, model: d.modelKey, warnings,
  };
  const id = ctx.newId();
  ctx.db.prepare('INSERT INTO footage_analyses (id, project_id, voice_asset_id, camera_asset_id, master_asset_id, json, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, projectId, voice.id, camera?.id ?? null, masterAssetId ?? null, JSON.stringify(result), ctx.now());
  // result_json: the analysis (spread, for the tools) + `analysis` (the UI reads it first), ids and totals
  return { ...(masterAssetId ? { assetId: masterAssetId } : {}), result: { ...result, analysis: result, analysisId: id, masterOffsetMs, totalCutMs: picked.totalMs, maxTotalMs } };
}

/** Compact summary for the Brainstorming tool `media.analyze` (recording seconds, spoken text, dropped reasons). */
export function analysisSummary(a: FootageAnalysis & { id?: string }): Record<string, unknown> {
  const s = (ms: number) => Math.round(ms / 10) / 100;
  return { analysisId: a.id ?? null, voiceAssetId: a.voiceAssetId, cameraAssetId: a.cameraAssetId ?? null, masterAssetId: a.masterAssetId ?? null, offsetMs: a.offsetMs, rotation: a.rotation, rotationSource: a.rotationSource,
    durationS: s(a.durationMs), phrases: a.phrases.length, totalCutS: s(a.cuts.reduce((n, c) => n + c.endMs - c.startMs, 0)),
    cuts: a.cuts.map((c) => ({ id: c.id, line: c.lineIndex, fromS: s(c.startMs), toS: s(c.endMs), text: c.text, ...(c.confidence === 'low' ? { confidence: 'low' } : {}) })),
    dropped: a.dropped.map((d) => ({ fromS: s(d.startMs), toS: s(d.endMs), text: d.text.slice(0, 80), reason: d.reason })),
    lines: a.lines.map((l) => ({ index: l.index, source: l.source, text: l.text.slice(0, 160) })), loudness: a.loudness ?? null, model: a.model, warnings: a.warnings };
}

/** R-149 / `media.frames`: the frame times to show — explicit `atMs[]`, the middles of `cutIds`, or `count` cuts from `atMs` on (middles), else evenly spaced. */
export function frameTimes(a: FootageAnalysis | undefined, q: { atMs?: number[]; cutIds?: string[]; count?: number; fromMs?: number }): number[] {
  const mid = (c: Cut) => Math.round((c.startMs + c.endMs) / 2);
  if (q.atMs?.length) return q.atMs.slice(0, 12);
  if (q.cutIds?.length) return q.cutIds.map((id) => a?.cuts.find((c) => c.id === id)).filter((c): c is Cut => !!c).map(mid).slice(0, 12);
  const n = Math.max(1, Math.min(12, q.count ?? 1)); const from = q.fromMs ?? 0;
  const cuts = (a?.cuts ?? []).filter((c) => c.endMs > from);
  if (cuts.length) return cuts.slice(0, n).map(mid);
  const span = Math.max(1000, (a?.durationMs ?? 60_000) - from);
  return Array.from({ length: n }, (_, i) => Math.round(from + ((i + 0.5) * span) / n));
}

/**
 * FR-286 / R-149: a contact sheet JPG of frames at `atMs[]` (recording time) from the master (else the camera with `rotation`),
 * cells at 35 % of the frame, `ceil(sqrt(n))` columns, row-major; returns the file and the cell geometry. One ffmpeg per frame
 * (small) + one tile pass, all under the heavy lock.
 */
export async function contactSheet(ctx: ServiceContext, projectId: string, o: { atMs: number[]; rotation?: Rotation; signal?: AbortSignal; heavy: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<{ file: string; dir: string; cells: Array<{ atMs: number; x: number; y: number; w: number; h: number }>; cols: number; rows: number }> {
  const a = latestAnalysis(ctx, projectId);
  const src = (a?.masterAssetId && getAsset(ctx, a.masterAssetId, projectId)) || (a?.cameraAssetId && getAsset(ctx, a.cameraAssetId, projectId)) || undefined;
  if (!src || src.status !== 'ready') throw em('EM-9003', 'No analysed footage in this project.');
  const useMaster = src.id === a?.masterAssetId;
  const rot: Rotation = useMaster ? 0 : o.rotation ?? (a?.rotationSource === 'creator' || a?.rotationSource === 'heuristic' ? a.rotation : 0);
  const times = o.atMs.map((t) => Math.max(0, Math.round(t))).slice(0, 12);
  if (!times.length) throw em('EM-9002', 'Invalid request: atMs is empty.', { status: 400, path: 'body.atMs' });
  const shift = useMaster ? 0 : Math.max(0, a?.offsetMs ?? 0);   // camera time = recording time + offset
  const w0 = (rot === 90 || rot === 270 ? src.height : src.width) ?? 1080, h0 = (rot === 90 || rot === 270 ? src.width : src.height) ?? 1920;
  const cw = Math.round((w0 * 0.35) / 2) * 2, ch = Math.round((h0 * 0.35) / 2) * 2;
  const cols = Math.ceil(Math.sqrt(times.length)), rows = Math.ceil(times.length / cols);
  const dir = path.join(ctx.paths.tmp, `frames-${ctx.newId()}`); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sheet.jpg');
  const run = (args: string[], timeoutMs: number) => o.heavy(() => runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', '-threads', '2', ...args], cwd: dir, timeoutMs, ...(o.signal ? { signal: o.signal } : {}) }));
  const input = path.resolve(ctx.paths.media, (useMaster ? src.proxy_path ?? src.playable_path : src.playable_path) ?? src.original_path);
  for (const [i, t] of times.entries()) {
    const vf = [ROT_FILTER[rot], `scale=${cw}:${ch}`].filter(Boolean).join(',');
    await run(['-ss', sec(t + shift), '-i', input, '-frames:v', '1', '-vf', vf, '-q:v', '4', path.join(dir, `f-${String(i + 1).padStart(2, '0')}.jpg`)], 60_000);
  }
  await run(['-framerate', '1', '-i', path.join(dir, 'f-%02d.jpg'), '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', file], 60_000);
  return { file, dir, cols, rows, cells: times.map((atMs, i) => ({ atMs, x: (i % cols) * cw, y: Math.floor(i / cols) * ch, w: cw, h: ch })) };
}
