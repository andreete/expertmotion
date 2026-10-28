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
/**
 * Safe-area margins in u per ratio (single source; the Engine's safeAreaFor converts them to px): vertical keeps clear of the
 * status bar, caption / action area and like rail (Reels / TikTok / Shorts); 16:9 a little wider at the sides; others 72 u.
 */
export function safeAreaU(ratio: Ratio): { top: number; right: number; bottom: number; left: number } {
  if (ratio === '9:16') return { top: 190, right: 120, bottom: 340, left: 72 };
  if (ratio === '16:9') return { top: 72, right: 96, bottom: 72, left: 96 };
  return { top: SAFE_MARGIN_U, right: SAFE_MARGIN_U, bottom: SAFE_MARGIN_U, left: SAFE_MARGIN_U };
}
