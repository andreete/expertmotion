// tts.generate engine step: sherpa-onnx offline TTS (docs/LOCAL_AI_MODELS.md §3.2 row 2).
import { join } from 'node:path';
import { emError, throwIfAborted } from '../errors.js';
import { ENGINE_TIMEOUTS, assertAbsolute, buildChildEnv, exeName, runProcess, safeArgValue } from './process.js';
import { adapterFrom, jobFile, nodeFs, reporter, type EngineAdapter, type EngineContext } from './common.js';

export const TTS_MAX_CHARS = 2000;
export const TTS_CHUNK_CHARS = 400;
export const TTS_CHUNK_SILENCE_MS = 250;
export const WAV_MAX_BYTES = 500 * 1024 * 1024;

export type TtsVoice =
  | { kind: 'vits'; modelPath: string; tokensPath: string; dataDir?: string }
  /** Kokoro flag names are UNVERIFIED against the sherpa-onnx v2.0.0 CLI (LOCAL_AI_MODELS §3.2). */
  | { kind: 'kokoro'; modelPath: string; voicesPath: string; tokensPath: string; dataDir?: string; speakerId?: number; lexiconPath?: string };

export interface TtsInput {
  voice: TtsVoice;
  /** Already normalised text (numbers → words is a Local Service pre-step). */
  text: string;
  threads: number;
  /** 0.8..1.2; mapped to length scale 1/speed (`--vits-length-scale`, `--kokoro-length-scale`; UNVERIFIED flag names). */
  speed?: number;
  chunkChars?: number;
}
export interface TtsResult { wavPath: string; chunks: number; durationMs: number }

/** Splits on sentence ends (. ! ? … ; and newlines), then on commas/spaces, so every chunk is ≤ `max` characters. */
export function splitTtsText(text: string, max = TTS_CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return [];
  // Split only where sentence punctuation is followed by whitespace, so "Rp 1.250.000" and "3,5" stay whole.
  const sentences = clean.split(/(?<=[.!?…;]["')\]]*)\s+/).filter((x) => x !== '');
  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length <= max) { pieces.push(s); continue; }
    let rest = s;
    while (rest.length > max) {
      const window = rest.slice(0, max + 1);
      const space = window.lastIndexOf(' ');
      if (space > 0) { pieces.push(rest.slice(0, space).trim()); rest = rest.slice(space + 1).trim(); }
      else { pieces.push(rest.slice(0, max)); rest = rest.slice(max).trim(); }
    }
    if (rest !== '') pieces.push(rest);
  }
  const chunks: string[] = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + p.length <= max) chunks[chunks.length - 1] = `${last} ${p}`; else chunks.push(p);
  }
  return chunks;
}

export function sherpaTtsArgs(voice: TtsVoice, opts: { engineDir: string; threads: number; outPath: string; text: string; speed?: number }): string[] {
  const dataDir = voice.dataDir ?? join(opts.engineDir, 'espeak-ng-data');
  const scale = opts.speed !== undefined && opts.speed !== 1 ? (1 / opts.speed).toFixed(3) : null;
  const args = voice.kind === 'vits'
    ? [`--vits-model=${voice.modelPath}`, `--vits-tokens=${voice.tokensPath}`, `--vits-data-dir=${dataDir}`, ...(scale ? [`--vits-length-scale=${scale}`] : [])]
    : [`--kokoro-model=${voice.modelPath}`, `--kokoro-voices=${voice.voicesPath}`, `--kokoro-tokens=${voice.tokensPath}`, `--kokoro-data-dir=${dataDir}`,
      ...(voice.lexiconPath ? [`--kokoro-lexicon=${voice.lexiconPath}`] : []),
      ...(scale ? [`--kokoro-length-scale=${scale}`] : []), ...(voice.speakerId !== undefined ? [`--sid=${voice.speakerId}`] : [])];
  return [...args, `--num-threads=${opts.threads}`, `--output-filename=${opts.outPath}`, safeArgValue(opts.text)];
}

// --- minimal PCM WAV handling (concatenate chunks with silence; no FFmpeg needed for this step) ---
export interface WavInfo { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number; blockAlign: number; data: Uint8Array }
export function parseWav(buf: Uint8Array): WavInfo {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number): string => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new SyntaxError('not a RIFF/WAVE file');
  let off = 12; let fmt: Omit<WavInfo, 'data'> | null = null;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off); let size = dv.getUint32(off + 4, true); const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16) throw new SyntaxError('fmt chunk too small');
      fmt = { audioFormat: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), blockAlign: dv.getUint16(body + 12, true), bitsPerSample: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new SyntaxError('data before fmt');
      if (size === 0xffffffff || body + size > buf.byteLength) size = buf.byteLength - body;
      return { ...fmt, data: buf.subarray(body, body + size) };
    }
    off = body + size + (size % 2);
  }
  throw new SyntaxError('no data chunk');
}
export function encodeWav(fmt: Omit<WavInfo, 'data'>, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + data.byteLength); const dv = new DataView(out.buffer);
  const put = (o: number, s: string): void => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + data.byteLength, true); put(8, 'WAVE'); put(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, fmt.audioFormat, true); dv.setUint16(22, fmt.channels, true); dv.setUint32(24, fmt.sampleRate, true);
  dv.setUint32(28, fmt.sampleRate * fmt.blockAlign, true); dv.setUint16(32, fmt.blockAlign, true); dv.setUint16(34, fmt.bitsPerSample, true);
  put(36, 'data'); dv.setUint32(40, data.byteLength, true); out.set(data, 44);
  return out;
}
export const wavDurationMs = (w: WavInfo): number => (w.blockAlign > 0 && w.sampleRate > 0 ? Math.round((w.data.byteLength / w.blockAlign / w.sampleRate) * 1000) : 0);
/** Joins PCM wavs of identical format with `silenceMs` of zeros between them. */
export function concatWavs(wavs: readonly Uint8Array[], silenceMs = TTS_CHUNK_SILENCE_MS): Uint8Array {
  const parsed = wavs.map(parseWav);
  const first = parsed[0];
  if (!first) throw new RangeError('no wav to concatenate');
  for (const w of parsed) if (w.audioFormat !== first.audioFormat || w.channels !== first.channels || w.sampleRate !== first.sampleRate || w.bitsPerSample !== first.bitsPerSample) throw new SyntaxError('wav formats differ');
  const silence = Math.round((first.sampleRate * silenceMs) / 1000) * first.blockAlign;
  const total = parsed.reduce((a, w) => a + w.data.byteLength, 0) + silence * (parsed.length - 1);
  const data = new Uint8Array(total); let o = 0;
  parsed.forEach((w, i) => { if (i > 0) o += silence; data.set(w.data, o); o += w.data.byteLength; });
  return encodeWav(first, data);
}

/** One sherpa-onnx process per chunk (60 s timeout each), then `<jobDir>/out.wav`. EM-7106 > 2 000 chars; EM-9002 empty. */
export async function synthesize(input: TtsInput, ctx: EngineContext): Promise<TtsResult> {
  const text = input.text.trim();
  if (text === '') throw emError('EM-9002', 'Text is empty', { tool: 'tts.generate' });
  if ([...text].length > TTS_MAX_CHARS) throw emError('EM-7106', 'Text too long', { chars: [...text].length, limit: TTS_MAX_CHARS });
  if (input.speed !== undefined && !(input.speed >= 0.8 && input.speed <= 1.2)) throw emError('EM-9002', 'speed must be 0.8..1.2', { speed: input.speed });
  assertAbsolute(input.voice.modelPath, 'voice model'); assertAbsolute(input.voice.tokensPath, 'voice tokens');
  const fs = ctx.fs ?? nodeFs;
  const report = reporter(ctx);
  const chunks = splitTtsText(text, input.chunkChars ?? TTS_CHUNK_CHARS);
  const outPath = jobFile(ctx, 'out.wav');
  const env = buildChildEnv({ engineDir: ctx.engineDir, jobDir: ctx.jobDir, ...(ctx.parentEnv ? { parentEnv: ctx.parentEnv } : {}) });
  const parts: string[] = [];
  report(0);
  for (const [i, chunk] of chunks.entries()) {
    throwIfAborted(ctx.signal);
    const part = chunks.length === 1 ? outPath : jobFile(ctx, `out-${String(i + 1).padStart(3, '0')}.wav`);
    await fs.remove(part);
    await runProcess({
      engine: 'sherpa-onnx', exe: join(ctx.engineDir, exeName('sherpa-onnx-offline-tts', ctx.platform)),
      args: sherpaTtsArgs(input.voice, { engineDir: ctx.engineDir, threads: Math.max(1, Math.floor(input.threads)), outPath: part, text: chunk, ...(input.speed !== undefined ? { speed: input.speed } : {}) }),
      cwd: ctx.jobDir, env, timeoutMs: ctx.timeoutMs ?? ENGINE_TIMEOUTS.ttsChunk,
      ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.spawn ? { spawn: ctx.spawn } : {}), ...(ctx.killTree ? { killTree: ctx.killTree } : {}),
    });
    const size = await fs.size(part).catch(() => -1);
    if (size <= 44) throw emError('EM-7103', 'Voice engine produced no audio', { engine: 'sherpa-onnx', chunk: i });
    if (size > WAV_MAX_BYTES) throw emError('EM-7101', 'Voice output is too large', { engine: 'sherpa-onnx', cause: 'output-too-large', bytes: size });
    parts.push(part);
    report((i + 1) / chunks.length * 0.95);
  }
  let durationMs: number;
  try {
    if (parts.length > 1) {
      const joined = concatWavs(await Promise.all(parts.map((p) => fs.readFile(p))));
      await fs.writeFile(outPath, joined);
      durationMs = wavDurationMs(parseWav(joined));
    } else durationMs = wavDurationMs(parseWav(await fs.readFile(outPath)));
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof RangeError) throw emError('EM-7101', 'Voice output is not a valid wav', { engine: 'sherpa-onnx', cause: 'output', message: e.message }, e);
    throw e;
  }
  report(1);
  return { wavPath: outPath, chunks: chunks.length, durationMs };
}

export const sherpaTtsAdapter = (engineDir: string, defaults: Partial<EngineContext> = {}): EngineAdapter<TtsInput, TtsResult> => adapterFrom('synthesize', engineDir, synthesize, defaults);
