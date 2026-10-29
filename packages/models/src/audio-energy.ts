// Speech window of a PCM WAV from its energy envelope (FR-249): where the voice starts and ends inside a generated clip (TTS
// engines add leading / trailing silence), and the pauses in between. Used by the proportional transcript fallback and by the
// real-engine drift check. 16-bit PCM only (sherpa-onnx, OpenAI pcm/wav, Gemini, ElevenLabs wav_*); anything else → null.
import { parseWav } from './engines/sherpa.js';

export interface EnergyFrame { fromMs: number; rms: number }
/** Loudest frame. A loop, never `Math.max(...frames)`: one frame per 10 ms overflows the argument stack past ~20 min. */
export function peakRms(frames: readonly EnergyFrame[]): number {
  let p = 0; for (const f of frames) if (f.rms > p) p = f.rms; return p;
}
/** RMS per `frameMs` window (mono mix), in [0, 1]. */
export function energyFrames(wav: Uint8Array, frameMs = 10): EnergyFrame[] | null {
  let w; try { w = parseWav(wav); } catch { return null; }
  if (w.audioFormat !== 1 || w.bitsPerSample !== 16 || w.sampleRate <= 0) return null;
  // provider data: a zero / short blockAlign would loop forever (total = Infinity) or read past the buffer
  if (!Number.isInteger(w.channels) || w.channels < 1 || !Number.isInteger(w.blockAlign) || w.blockAlign < w.channels * 2) return null;
  const view = new DataView(w.data.buffer, w.data.byteOffset, w.data.byteLength);
  const per = Math.max(1, Math.round((w.sampleRate * frameMs) / 1000));
  const total = Math.floor(w.data.byteLength / w.blockAlign);
  const out: EnergyFrame[] = [];
  for (let f = 0; f * per < total; f++) {
    let s = 0; let n = 0;
    for (let i = f * per; i < Math.min(total, (f + 1) * per); i++) {
      let v = 0; for (let c = 0; c < w.channels; c++) v += view.getInt16(i * w.blockAlign + c * 2, true);
      v /= w.channels * 32768; s += v * v; n++;
    }
    out.push({ fromMs: f * frameMs, rms: Math.sqrt(s / Math.max(1, n)) });
  }
  return out;
}
/** First and last voiced millisecond (threshold relative to the loudest frame), or null for silence / unsupported audio. */
export function speechWindow(wav: Uint8Array, o: { frameMs?: number; rel?: number } = {}): { fromMs: number; toMs: number } | null {
  const frameMs = o.frameMs ?? 10; const fr = energyFrames(wav, frameMs); if (!fr?.length) return null;
  const peak = peakRms(fr); if (peak <= 0) return null;
  const th = peak * (o.rel ?? 0.06);
  const a = fr.findIndex((x) => x.rms >= th); let b = fr.length - 1; while (b >= 0 && fr[b]!.rms < th) b--;
  if (a < 0 || b < a) return null;
  return { fromMs: fr[a]!.fromMs, toMs: fr[b]!.fromMs + frameMs };
}

/**
 * Snaps word boundaries to the audio (FR-249): recognisers place word edges coarsely (whisper tiny/small: ±100–300 ms, segments
 * touch each other). Around every boundary between two words the quietest 10 ms frame within ±`searchMs` (never past the
 * neighbours' midpoints) becomes the cut, and the next word starts at its first voiced frame after that cut. Text and order
 * never change; times only move inside the window.
 */
export function refineWordTimes<T extends { fromMs: number; toMs: number }>(words: readonly T[], frames: readonly EnergyFrame[] | null, o: { searchMs?: number; frameMs?: number; rel?: number } = {}): T[] {
  if (!frames?.length || words.length === 0) return words.map((w) => ({ ...w }));
  const frameMs = o.frameMs ?? (frames.length > 1 ? frames[1]!.fromMs - frames[0]!.fromMs : 10);
  const search = o.searchMs ?? 250;
  const peak = peakRms(frames); const th = peak * (o.rel ?? 0.06);
  const at = (ms: number) => Math.max(0, Math.min(frames.length - 1, Math.round(ms / frameMs)));
  const out = words.map((w) => ({ ...w }));
  // first word: its first voiced frame near the recognised start
  const onsetFrom = (fromIdx: number, limitIdx: number): number | null => { for (let k = fromIdx; k <= limitIdx; k++) if (frames[k]!.rms >= th) return k; return null; };
  const s0 = onsetFrom(at(Math.max(0, out[0]!.fromMs - search)), at(out[0]!.fromMs + search));
  if (s0 !== null) out[0]!.fromMs = frames[s0]!.fromMs;
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!, cur = out[i]!;
    const lo = at(Math.max((prev.fromMs + Math.min(prev.toMs, cur.fromMs)) / 2, cur.fromMs - search));
    const hi = at(Math.min((cur.fromMs + cur.toMs) / 2, cur.fromMs + search));
    if (hi <= lo) continue;
    let m = lo; for (let k = lo; k <= hi; k++) if (frames[k]!.rms < frames[m]!.rms) m = k;
    const on = onsetFrom(m, Math.min(frames.length - 1, m + Math.round(search / frameMs)));
    const startMs = frames[on ?? m]!.fromMs;
    if (startMs <= prev.fromMs) continue;
    prev.toMs = Math.min(Math.max(prev.fromMs, frames[m]!.fromMs + frameMs), startMs);
    cur.fromMs = startMs;
    if (cur.toMs < cur.fromMs) cur.toMs = cur.fromMs;
  }
  return out;
}

/** QA P1 2026-10-29 (caption paging): the pauses inside the speech — runs of frames below the voice threshold lasting at least
 *  `minMs` (default 120 ms), in clip time. Leading / trailing silence is not a pause. */
export function silences(frames: readonly EnergyFrame[] | null, o: { minMs?: number; rel?: number; frameMs?: number } = {}): Array<{ fromMs: number; toMs: number }> {
  if (!frames?.length) return [];
  const frameMs = o.frameMs ?? (frames.length > 1 ? frames[1]!.fromMs - frames[0]!.fromMs : 10);
  const th = peakRms(frames) * (o.rel ?? 0.06); const min = o.minMs ?? 120;
  if (th <= 0) return [];
  const out: Array<{ fromMs: number; toMs: number }> = []; let start = -1; let voiced = false;
  for (let k = 0; k < frames.length; k++) {
    const quiet = frames[k]!.rms < th;
    if (quiet && voiced && start < 0) start = k;
    if (!quiet) { if (start >= 0 && (k - start) * frameMs >= min) out.push({ fromMs: frames[start]!.fromMs, toMs: frames[k]!.fromMs }); start = -1; voiced = true; }
  }
  return out;
}
