// React-free: output dimensions from docs/PERFORMANCE.md §3 (the owner). The preset number is the SHORT side;
// long side = round-to-even(short × aspect); every side even; custom ratios clamped to 1:3…3:1; long side ≤ 4096.
import { aspectOf, detectRatio, safeAreaU, type Ratio, type Resolution } from '@expertmotion/composition-model';

export { detectRatio };
export type { Ratio, Resolution };
export const SHORT_SIDE: Record<Resolution, number> = { '720p': 720, '1080p': 1080, '2k': 1440, '2160p': 2160 };
export const MAX_SIDE = 4096, MIN_SIDE = 240;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function resolveDimensions(ratio: Ratio, resolution: Resolution, custom?: { w: number; h: number }): { width: number; height: number } {
  const a = aspectOf(ratio, custom);
  let short = SHORT_SIDE[resolution];
  let long = short * (a >= 1 ? a : 1 / a);
  if (long > MAX_SIDE) { short = short * (MAX_SIDE / long); long = MAX_SIDE; }
  const s = Math.max(MIN_SIDE, even(short)), l = Math.max(MIN_SIDE, even(long));
  return a >= 1 ? { width: l, height: s } : { width: s, height: l };
}

export interface SafeArea { top: number; right: number; bottom: number; left: number }
/**
 * Safe-area margins in px for the given frame (ported from the predecessor formats.ts, generalised): vertical keeps clear of the
 * status bar, caption/action area and like rail (Reels/TikTok/Shorts); other ratios use a uniform 72 u margin.
 */
export function safeAreaFor(ratio: Ratio, width: number, height: number): SafeArea {
  const u = Math.min(width, height) / 1080, s = safeAreaU(ratio);             // values in u: composition-model units.ts (single source)
  return { top: Math.round(s.top * u), right: Math.round(s.right * u), bottom: Math.round(s.bottom * u), left: Math.round(s.left * u) };
}
export const isRatio = (v: unknown): v is Ratio => typeof v === 'string' && ['16:9', '9:16', '1:1', '4:5', '5:4', '4:3', '3:4', 'custom'].includes(v);
