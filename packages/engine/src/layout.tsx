import { useVideoConfig } from 'remotion';
import type { Ratio } from '@expertmotion/composition-model';
import { safeAreaFor, type SafeArea } from './formats.js';

export interface Layout { width: number; height: number; ratio: Ratio; u: number; safe: SafeArea; contentW: number; contentH: number; isLandscape: boolean;
  /** Position in u (origin frame centre) → px from the top-left corner. */ toPx: (x: number, y: number) => { left: number; top: number } }
/** Layout unit u = min(width, height) / 1080 (ported from the predecessor layout.tsx). */
export function useLayout(ratio: Ratio): Layout {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const safe = safeAreaFor(ratio, width, height);
  return { width, height, ratio, u, safe, contentW: width - safe.left - safe.right, contentH: height - safe.top - safe.bottom, isLandscape: width >= height,
    toPx: (x, y) => ({ left: width / 2 + x * u, top: height / 2 + y * u }) };
}
