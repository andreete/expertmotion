// ADR-039 (Reels music lifts): how gain segments change an audio layer's level at one moment. A segment multiplies the layer's
// volume by `mul` from `atMs` (COMPOSITION time) for `durationMs`, ramping linearly in over `rampMs` before `atMs` … at `atMs`
// and out after the end (default ramp 300 ms); overlapping segments multiply. Pure, frame-exact in the Player and the render.
import type { GainSegmentT } from '@expertmotion/composition-model';

export const DEFAULT_GAIN_RAMP_MS = 300;
export function gainMultiplier(segments: readonly GainSegmentT[] | undefined, atMs: number): number {
  if (!segments || segments.length === 0) return 1;
  let mul = 1;
  for (const g of segments) {
    const ramp = Math.max(0, g.rampMs ?? DEFAULT_GAIN_RAMP_MS), end = g.atMs + g.durationMs;
    let k = 0;
    if (atMs >= g.atMs && atMs < end) k = 1;
    else if (ramp > 0 && atMs < g.atMs && atMs >= g.atMs - ramp) k = (atMs - (g.atMs - ramp)) / ramp;
    else if (ramp > 0 && atMs >= end && atMs < end + ramp) k = 1 - (atMs - end) / ramp;
    if (k > 0) mul *= 1 + (g.mul - 1) * Math.min(1, Math.max(0, k));
  }
  return Math.max(0, Math.round(mul * 10_000) / 10_000);
}
