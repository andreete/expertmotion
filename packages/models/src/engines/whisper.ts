// captions.generate engine step: whisper.cpp `whisper-cli` (docs/LOCAL_AI_MODELS.md §3.2 row 1).
import { emError } from '../errors.js';
import { captionsToPages } from '../captions/pages.js';
import type { Caption, CaptionPage } from '../captions/types.js';
import { ENGINE_TIMEOUTS, assertAbsolute, assertInside, buildChildEnv, exeName, runProcess } from './process.js';
import { adapterFrom, jobFile, nodeFs, reporter, type EngineAdapter, type EngineContext } from './common.js';
import { join } from 'node:path';

export interface TranscribeInput {
  /** Absolute path of `ggml-<model>.bin` under `<models>/whisper.cpp/<model>/`. */
  modelPath: string;
  /** 16 kHz mono PCM wav inside the job dir (default `<jobDir>/in.wav`, written by the FFmpeg pre-step). */
  wavPath?: string;
  language: string;
  threads: number;
  /** Duration of the audio; sets the timeout (10 × seconds + 60 s). */
  audioDurationMs: number;
  /** FR-285 (Reels prep): an initial prompt (names / acronyms only, never the script) that steers spelling; `--prompt`. */
  prompt?: string;
  /** Beam size (`-bs`); whisper-cli's default when absent. */
  beamSize?: number;
}
export interface TranscribeResult { captions: Caption[]; language: string | null }

export const CAPTIONS_JSON_MAX_BYTES = 10 * 1024 * 1024;
export const WHISPER_LANGUAGES = ['id', 'en', 'auto'] as const;

/** Exact argv of LOCAL_AI_MODELS §3.2 (`-oj -ojf -ml 1 -sow -np -of <jobDir>/out`). */
export function whisperArgs(input: { modelPath: string; wavPath: string; language: string; threads: number; outBase: string; prompt?: string; beamSize?: number }): string[] {
  const prompt = input.prompt?.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 800);
  return ['-m', input.modelPath, '-f', input.wavPath, '-l', input.language, '-t', String(input.threads), '-oj', '-ojf', '-ml', '1', '-sow', '-np', '-pp', '-of', input.outBase,   // -pp: `progress = NN%` lines on stderr
    ...(prompt ? ['--prompt', prompt] : []), ...(input.beamSize !== undefined && Number.isInteger(input.beamSize) && input.beamSize >= 1 ? ['-bs', String(Math.min(8, input.beamSize))] : [])];
}

interface WhisperToken { text?: unknown; p?: unknown }
interface WhisperSegment { text?: unknown; offsets?: { from?: unknown; to?: unknown }; tokens?: unknown }

const isSpecialToken = (t: string): boolean => /^\[_[A-Z_]+/.test(t) || /^\[_TT_\d+\]$/.test(t) || /^<\|.*\|>$/.test(t);
/** Non-speech annotations whisper emits as segments ([BLANK_AUDIO], [Musik], (tertawa), ♪ …). */
const isNonSpeech = (t: string): boolean => /^\s*(\[[^\]]*\]|\([^)]*\)|[♪♫\s]+)\s*$/.test(t);

/** Parses whisper-cli `-oj -ojf` output into Caption[] (text keeps its leading space; times in ms). */
export function parseWhisperJson(json: string): TranscribeResult {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) { throw emError('EM-7101', 'Transcription output is not valid JSON', { engine: 'whisper.cpp', cause: 'output' }, e); }
  const root = raw as { transcription?: unknown; result?: { language?: unknown } };
  if (!root || typeof root !== 'object' || !Array.isArray(root.transcription)) throw emError('EM-7101', 'Transcription output has no segments', { engine: 'whisper.cpp', cause: 'output' });
  const captions: Caption[] = [];
  for (const seg of root.transcription as WhisperSegment[]) {
    if (!seg || typeof seg.text !== 'string') continue;
    const from = Number(seg.offsets?.from); const to = Number(seg.offsets?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const text = seg.text;
    if (text.trim() === '' || isNonSpeech(text)) continue;
    const probs = Array.isArray(seg.tokens)
      ? (seg.tokens as WhisperToken[]).filter((t) => typeof t?.text === 'string' && !isSpecialToken(t.text) && typeof t.p === 'number' && Number.isFinite(t.p)).map((t) => t.p as number)
      : [];
    const startMs = Math.max(0, Math.round(from)); const endMs = Math.max(startMs, Math.round(to));
    captions.push({ text, startMs, endMs, timestampMs: (startMs + endMs) / 2, confidence: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null });
  }
  const lang = root.result?.language;
  return { captions, language: typeof lang === 'string' ? lang : null };
}

/** Runs whisper-cli on `<jobDir>/in.wav`, reads `<jobDir>/out.json`. EM-7105 language, EM-7103 nothing recognised. */
export async function transcribe(input: TranscribeInput, ctx: EngineContext): Promise<TranscribeResult> {
  if (!(WHISPER_LANGUAGES as readonly string[]).includes(input.language)) throw emError('EM-7105', 'Language not supported', { tool: 'captions.generate', language: input.language });
  assertAbsolute(input.modelPath, 'model');
  const wavPath = input.wavPath ?? jobFile(ctx, 'in.wav');
  assertInside(ctx.jobDir, wavPath, 'input audio');
  const threads = Math.max(1, Math.floor(input.threads));
  const report = reporter(ctx);
  report(0);
  const fs = ctx.fs ?? nodeFs;
  const outBase = jobFile(ctx, 'out');
  await fs.remove(`${outBase}.json`);
  const onLine = (line: string): void => { const m = /progress\s*=\s*(\d{1,3})%/.exec(line); if (m) report(Number(m[1]) / 100); };
  await runProcess({
    engine: 'whisper.cpp', exe: join(ctx.engineDir, exeName('whisper-cli', ctx.platform)),
    args: whisperArgs({ modelPath: input.modelPath, wavPath, language: input.language, threads, outBase, ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.beamSize !== undefined ? { beamSize: input.beamSize } : {}) }),
    cwd: ctx.jobDir, env: buildChildEnv({ engineDir: ctx.engineDir, jobDir: ctx.jobDir, ...(ctx.parentEnv ? { parentEnv: ctx.parentEnv } : {}), ...(ctx.platform ? { platform: ctx.platform } : {}) }),
    timeoutMs: ctx.timeoutMs ?? ENGINE_TIMEOUTS.captions(input.audioDurationMs),
    onStderrLine: onLine, onStdoutLine: onLine,
    ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.spawn ? { spawn: ctx.spawn } : {}), ...(ctx.killTree ? { killTree: ctx.killTree } : {}),
  });
  const outJson = `${outBase}.json`;
  const size = await fs.size(outJson).catch(() => -1);
  if (size < 0) throw emError('EM-7101', 'Transcription produced no output file', { engine: 'whisper.cpp', cause: 'output-missing' });
  if (size > CAPTIONS_JSON_MAX_BYTES) throw emError('EM-7101', 'Transcription output is too large', { engine: 'whisper.cpp', cause: 'output-too-large', bytes: size });
  const result = parseWhisperJson((await fs.readFile(outJson)).toString('utf8'));
  if (result.captions.length === 0) throw emError('EM-7103', 'No speech was found', { engine: 'whisper.cpp' });
  report(1);
  return result;
}

/** transcribe + TikTok-style paging (captions.generate result `{captions, pages}`). */
export async function transcribeToPages(input: TranscribeInput & { combineTokensWithinMs?: number }, ctx: EngineContext): Promise<TranscribeResult & { pages: CaptionPage[] }> {
  const r = await transcribe(input, ctx);
  return { ...r, pages: captionsToPages(r.captions, { combineTokensWithinMilliseconds: input.combineTokensWithinMs ?? 1200 }) };
}

export interface TranscribeManyInput extends Omit<TranscribeInput, 'wavPath'> { /** 16 kHz mono wavs inside the job dir; whisper-cli takes several `-f` and writes `<file>.json` for each. */ wavPaths: string[] }
/** Argv for several files in ONE process (model loaded once): no `-of`, so `-oj` writes `<wav>.json` beside every input. */
export function whisperArgsMany(input: { modelPath: string; wavPaths: string[]; language: string; threads: number; prompt?: string; beamSize?: number }): string[] {
  const prompt = input.prompt?.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 800);
  return ['-m', input.modelPath, ...input.wavPaths.flatMap((f) => ['-f', f]), '-l', input.language, '-t', String(input.threads), '-oj', '-ojf', '-ml', '1', '-sow', '-np', '-pp',
    ...(prompt ? ['--prompt', prompt] : []), ...(input.beamSize !== undefined && Number.isInteger(input.beamSize) && input.beamSize >= 1 ? ['-bs', String(Math.min(8, input.beamSize))] : [])];
}
/**
 * FR-285 (Reels prep "listen"): every phrase as its own file in one whisper-cli run, so timestamps never drift across pieces.
 * Progress = files finished (`output_json: saving output to` lines). A piece with no speech yields an empty caption list; the
 * result only fails when NO piece produced output. One result per input, in input order.
 */
export async function transcribeMany(input: TranscribeManyInput, ctx: EngineContext): Promise<TranscribeResult[]> {
  if (!(WHISPER_LANGUAGES as readonly string[]).includes(input.language)) throw emError('EM-7105', 'Language not supported', { tool: 'captions.generate', language: input.language });
  assertAbsolute(input.modelPath, 'model');
  if (!input.wavPaths.length) return [];
  for (const w of input.wavPaths) assertInside(ctx.jobDir, w, 'input audio');
  const threads = Math.max(1, Math.floor(input.threads));
  const report = reporter(ctx); report(0);
  const fs = ctx.fs ?? nodeFs;
  for (const w of input.wavPaths) await fs.remove(`${w}.json`);
  let done = 0;
  const onLine = (line: string): void => { if (/output_json: saving output to/.test(line)) { done++; report(Math.min(0.99, done / input.wavPaths.length)); } };
  await runProcess({
    engine: 'whisper.cpp', exe: join(ctx.engineDir, exeName('whisper-cli', ctx.platform)),
    args: whisperArgsMany({ modelPath: input.modelPath, wavPaths: input.wavPaths, language: input.language, threads, ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.beamSize !== undefined ? { beamSize: input.beamSize } : {}) }),
    cwd: ctx.jobDir, env: buildChildEnv({ engineDir: ctx.engineDir, jobDir: ctx.jobDir, ...(ctx.parentEnv ? { parentEnv: ctx.parentEnv } : {}), ...(ctx.platform ? { platform: ctx.platform } : {}) }),
    timeoutMs: ctx.timeoutMs ?? ENGINE_TIMEOUTS.captions(input.audioDurationMs),
    onStderrLine: onLine, onStdoutLine: onLine,
    ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.spawn ? { spawn: ctx.spawn } : {}), ...(ctx.killTree ? { killTree: ctx.killTree } : {}),
  });
  const out: TranscribeResult[] = []; let any = false;
  for (const w of input.wavPaths) {
    const file = `${w}.json`; const size = await fs.size(file).catch(() => -1);
    if (size < 0) { out.push({ captions: [], language: null }); continue; }
    if (size > CAPTIONS_JSON_MAX_BYTES) throw emError('EM-7101', 'Transcription output is too large', { engine: 'whisper.cpp', cause: 'output-too-large', bytes: size });
    const r = parseWhisperJson((await fs.readFile(file)).toString('utf8')); any = true; out.push(r);
  }
  if (!any) throw emError('EM-7101', 'Transcription produced no output file', { engine: 'whisper.cpp', cause: 'output-missing' });
  report(1);
  return out;
}

export const whisperAdapter = (engineDir: string, defaults: Partial<EngineContext> = {}): EngineAdapter<TranscribeInput, TranscribeResult> => adapterFrom('transcribe', engineDir, transcribe, defaults);
