import type { Ratio } from './schema.js';
import { aspectOf } from './units.js';
const FIXED: Exclude<Ratio, 'custom'>[] = ['16:9', '9:16', '1:1', '4:5', '5:4', '4:3', '3:4'];
/** Nearest of the seven fixed ratios by log-aspect distance (Auto ratio; ported idea of detectFormat). */
export function detectRatio(width: number, height: number): Exclude<Ratio, 'custom'> {
  const a = Math.log(width / height);
  let best = FIXED[0]!, bestD = Infinity;
  for (const r of FIXED) { const d = Math.abs(Math.log(aspectOf(r)) - a); if (d < bestD - 1e-12) { best = r; bestD = d; } }
  return best;
}
