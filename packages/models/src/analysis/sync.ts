// Camera ↔ recorder sync (FR-280, ADR-039): cross-correlation of the two loudness curves. Coarse pass on 10 ms RMS envelopes
// (z-scored dB), then a 1 ms refinement around evenly spread points that contain speech; the offset is the median of the
// refined points. Positive `offsetMs` = `other` started BEFORE `ref` (ref[t] ≈ other[t + offset]).
import { median, percentile, rmsEnvelopeDb, zscore } from './pcm.js';
import type { SyncResult } from './types.js';

export interface SyncOptions { maxLagMs?: number; refinePoints?: number; hopMs?: number; refineWindowMs?: number; refineRangeMs?: number }

/** Best lag of `b` relative to `a` (a[i] ≈ b[i + lag]) by mean product of the z-scored series, plus the second-best peak far from it. */
export function xcorrBest(a: Float64Array, b: Float64Array, maxLag: number): { lag: number; r: number; second: number } {
  let best = -Infinity, bestLag = 0;
  const rs = new Float64Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const i0 = Math.max(0, -lag), i1 = Math.min(a.length, b.length - lag);
    let s = 0; const n = i1 - i0;
    if (n < 8) { rs[lag + maxLag] = -Infinity; continue; }
    for (let i = i0; i < i1; i++) s += a[i]! * b[i + lag]!;
    const r = s / n; rs[lag + maxLag] = r;
    if (r > best) { best = r; bestLag = lag; }
  }
  let second = -Infinity;
  const guard = Math.max(5, Math.round(maxLag * 0.02));
  for (let k = 0; k < rs.length; k++) if (Math.abs(k - maxLag - bestLag) > guard && rs[k]! > second) second = rs[k]!;
  return { lag: bestLag, r: best, second: Number.isFinite(second) ? second : 0 };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Offset of `other` against `ref` (both mono Int16 at `sr`). Coarse: ±`maxLagMs` on `hopMs` envelopes. Refine: at
 * `refinePoints` evenly spread positions with speech, 1 ms envelopes over `refineWindowMs`, ±`refineRangeMs` around the coarse lag.
 */
export function syncOffset(ref: Int16Array, other: Int16Array, sr: number, o: SyncOptions = {}): SyncResult {
  const hopMs = o.hopMs ?? 10, maxLagMs = o.maxLagMs ?? 15000, nPoints = o.refinePoints ?? 5, win = o.refineWindowMs ?? 6000, range = o.refineRangeMs ?? 100;
  const ea = rmsEnvelopeDb(ref, sr, hopMs), eb = rmsEnvelopeDb(other, sr, hopMs);
  if (ea.length < 2 || eb.length < 2) return { offsetMs: 0, points: [], driftMs: 0, confidence: 0, coarse: { offsetMs: 0, r: 0 } };
  const coarse = xcorrBest(zscore(ea), zscore(eb), Math.round(maxLagMs / hopMs));
  const coarseMs = coarse.lag * hopMs;
  // refinement points: speech present when the window's loud part rises clearly above its floor
  const refMs = (ref.length / sr) * 1000, otherMs = (other.length / sr) * 1000;
  const speechThr = percentile(ea, 0.1) + 0.35 * (percentile(ea, 0.97) - percentile(ea, 0.1));
  const points: SyncResult['points'] = [];
  const env1 = (pcm: Int16Array, fromMs: number, lenMs: number): Float64Array | null => {
    const a = Math.round((fromMs / 1000) * sr), b = Math.round(((fromMs + lenMs) / 1000) * sr);
    if (a < 0 || b > pcm.length) return null;
    return zscore(rmsEnvelopeDb(pcm.subarray(a, b), sr, 1));
  };
  const usable = refMs - win;
  if (usable > 0) {
    for (let k = 0; k < nPoints; k++) {
      const at = Math.round(((k + 0.5) * usable) / nPoints);
      const h0 = Math.floor(at / hopMs), h1 = Math.min(ea.length, Math.floor((at + win) / hopMs));
      let loud = 0; for (let h = h0; h < h1; h++) if (ea[h]! > speechThr) loud++;
      if (loud < (h1 - h0) * 0.1) continue;                                   // < 10 % of the window has speech: skip
      const wa = env1(ref, at, win); const wb = env1(other, at + coarseMs - range, win + 2 * range);
      if (!wa || !wb || at + coarseMs - range < 0 || at + coarseMs + win + range > otherMs) continue;
      const r = xcorrBest(wa, wb, range);                                     // wa[i] ≈ wb[i + lag]; absolute = coarse − range + lag
      if (!Number.isFinite(r.r)) continue;
      points.push({ atMs: at, offsetMs: coarseMs - range + r.lag, r: Math.round(r.r * 1000) / 1000 });
    }
  }
  const offs = points.map((p) => p.offsetMs);
  const offsetMs = offs.length ? Math.round(median(offs)) : coarseMs;
  const driftMs = offs.length ? Math.max(...offs) - Math.min(...offs) : 0;
  // confidence: how far the coarse peak stands above the best other lag (0 = indistinct), damped by disagreeing points
  const peak = coarse.r > 0 ? clamp01((coarse.r - Math.max(0, coarse.second)) / coarse.r) : 0;
  const agree = points.length >= 2 ? clamp01(1 - driftMs / 200) : 0.6;
  const rMed = points.length ? clamp01(median(points.map((p) => p.r))) : clamp01(coarse.r);
  const confidence = Math.round(clamp01(0.5 * peak + 0.5 * rMed) * agree * 1000) / 1000;
  return { offsetMs, points, driftMs, confidence, coarse: { offsetMs: coarseMs, r: Math.round(coarse.r * 1000) / 1000 } };
}
