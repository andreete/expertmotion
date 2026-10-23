import type { Ratio } from './schema.js';
/** Aspect ratio as width/height. Custom ratios are clamped to 1:3 … 3:1 (PERFORMANCE.md §3). */
export function aspectOf(ratio: Ratio, custom?: { w: number; h: number }): number {
  const fixed: Record<Exclude<Ratio, 'custom'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '5:4': 5 / 4, '4:3': 4 / 3, '3:4': 3 / 4 };
  if (ratio !== 'custom') return fixed[ratio];
  const a = custom ? custom.w / custom.h : 1;
  return Math.min(3, Math.max(1 / 3, a));
}
/** Frame size in layout units u (u = shortSide / 1080), so the short side is always 1080 u at every Resolution. */
export function frameInUnits(ratio: Ratio, custom?: { w: number; h: number }): { w: number; h: number } {
  const a = aspectOf(ratio, custom);
  return a >= 1 ? { w: 1080 * a, h: 1080 } : { w: 1080, h: 1080 / a };
}
/** Safe-area margin in u used for default placement and the CM-008 text box (platform UI overlays). */
export const SAFE_MARGIN_U = 72;
export const framesOf = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);
