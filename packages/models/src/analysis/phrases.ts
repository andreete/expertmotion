// Phrases (voiced stretches) of a recording from its RMS envelope in dB (FR-281): threshold relative to the envelope's own
// floor and ceiling (p10 + 0.35·(p97 − p10)), short gaps merged, short blips dropped. Also the "is it quiet here" helpers that
// the take picker uses to place cuts in silence, and the finer voiced ranges (pauses ≥ 120 ms) that the word timing uses.
import { percentile, rmsEnvelopeDb } from './pcm.js';
import type { Phrase, VoicedRange } from './types.js';

/** An RMS envelope in dB with its hop (10 ms by default). */
export interface EnvelopeDb { db: Float64Array; hopMs: number }
export const makeEnvelope = (pcm: Int16Array, sr: number, hopMs = 10): EnvelopeDb => ({ db: rmsEnvelopeDb(pcm, sr, hopMs), hopMs });

/** Speech / silence threshold: 35 % of the way from the quiet floor (p10) to the loud ceiling (p97). */
export function phraseThreshold(envDb: ArrayLike<number>): number {
  const p10 = percentile(envDb, 0.1), p97 = percentile(envDb, 0.97);
  return p10 + 0.35 * (p97 - p10);
}

export interface PhraseOptions { thrFn?: (envDb: Float64Array) => number; thrDb?: number; mergeGapMs?: number; minMs?: number }
/** Voiced stretches above the threshold; gaps shorter than `mergeGapMs` (250) are bridged, stretches under `minMs` (500) dropped. */
export function findPhrases(env: EnvelopeDb, o: PhraseOptions = {}): Phrase[] {
  const { db, hopMs } = env;
  const thr = o.thrDb ?? (o.thrFn ?? phraseThreshold)(db);
  const mergeGap = Math.round((o.mergeGapMs ?? 250) / hopMs), min = Math.round((o.minMs ?? 500) / hopMs);
  const segs: Array<{ s: number; e: number }> = []; let cur: { s: number; e: number } | null = null;
  for (let i = 0; i < db.length; i++) {
    if (db[i]! > thr) { if (cur) cur.e = i + 1; else cur = { s: i, e: i + 1 }; } else if (cur) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  const merged: Array<{ s: number; e: number }> = [];
  for (const s of segs) { const last = merged[merged.length - 1]; if (last && s.s - last.e < mergeGap) last.e = s.e; else merged.push({ ...s }); }
  return merged.filter((s) => s.e - s.s >= min).map((s, index) => ({ index, fromMs: s.s * hopMs, toMs: s.e * hopMs, durationMs: (s.e - s.s) * hopMs }));
}

const frameAt = (env: EnvelopeDb, ms: number): number => Math.max(0, Math.min(env.db.length - 1, Math.floor(ms / env.hopMs)));

/** The LOUDEST frame (dB) inside the window centred on `ms` — "how quiet is it here" (−120 for an empty window). */
export function silenceDbAt(env: EnvelopeDb, ms: number, windowMs = 100): number {
  if (!env.db.length) return -120;
  const a = frameAt(env, ms - windowMs / 2), b = frameAt(env, ms + windowMs / 2);
  let m = -Infinity; for (let k = a; k <= b; k++) if (env.db[k]! > m) m = env.db[k]!;
  return m;
}
export const isQuietAround = (env: EnvelopeDb, ms: number, o: { maxDb?: number; windowMs?: number } = {}): boolean => silenceDbAt(env, ms, o.windowMs ?? 100) <= (o.maxDb ?? -43);

/** The quietest frame between `fromMs` and `toMs` (start of the frame, and its level); among frames within 1 dB of the
 *  minimum the one nearest to `preferMs` (default: the window start) wins, so a flat silence snaps to the intended point. */
export function quietestFrame(env: EnvelopeDb, fromMs: number, toMs: number, preferMs?: number): { ms: number; db: number } {
  const a = frameAt(env, Math.min(fromMs, toMs)), b = frameAt(env, Math.max(fromMs, toMs));
  let min = Infinity; for (let k = a; k <= b; k++) if (env.db[k]! < min) min = env.db[k]!;
  const target = preferMs ?? Math.min(fromMs, toMs);
  let m = a, best = Infinity;
  for (let k = a; k <= b; k++) { if (env.db[k]! > min + 1) continue; const d = Math.abs(k * env.hopMs - target); if (d < best) { best = d; m = k; } }
  return { ms: m * env.hopMs, db: env.db[m] ?? -120 };
}

export interface VoicedOptions { fromMs?: number; toMs?: number; thrDb?: number; minPauseMs?: number; minVoicedMs?: number }
/**
 * Voiced ranges inside [fromMs, toMs]: the stretches between pauses, a pause being a run below the threshold of at least
 * `minPauseMs` (120). Shorter dips stay inside their range; voiced blips under `minVoicedMs` (40) are dropped.
 */
export function voicedRanges(env: EnvelopeDb, o: VoicedOptions = {}): VoicedRange[] {
  const { db, hopMs } = env; if (!db.length) return [];
  const a = frameAt(env, o.fromMs ?? 0), b = o.toMs === undefined ? db.length : Math.min(db.length, Math.ceil(o.toMs / hopMs));
  const thr = o.thrDb ?? phraseThreshold(db.subarray(a, b).length > 10 ? db.subarray(a, b) : db);
  const minPause = Math.max(1, Math.round((o.minPauseMs ?? 120) / hopMs)), minVoiced = Math.max(1, Math.round((o.minVoicedMs ?? 40) / hopMs));
  const out: VoicedRange[] = [];
  let start = -1, lastVoiced = -1;
  for (let k = a; k < b; k++) {
    const voiced = db[k]! > thr;
    if (voiced) { if (start < 0) start = k; lastVoiced = k; }
    else if (start >= 0 && k - lastVoiced >= minPause) { out.push({ fromMs: start * hopMs, toMs: (lastVoiced + 1) * hopMs }); start = -1; }
  }
  if (start >= 0) out.push({ fromMs: start * hopMs, toMs: (lastVoiced + 1) * hopMs });
  return out.filter((r) => r.toMs - r.fromMs >= minVoiced * hopMs);
}
