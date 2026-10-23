// Deterministic text fitting without DOM measurement (ported unchanged from the predecessor packages/video/src/fit.ts).
// Used by composition-model (CM-008) and as the fallback in packages/engine text/fitTextSafe.ts.
export interface FitOptions {
  width: number; height: number; maxSize: number; minSize: number;
  lineHeight?: number;
  /** Average glyph width as a fraction of font size. Bold sans ~0.58, regular ~0.54, mono 0.6 */
  charWidth?: number;
  maxLines?: number;
}
export interface FitResult { fontSize: number; lines: number; overflow: boolean }

export function estimateLines(text: string, fontSize: number, width: number, charWidth: number): number {
  const avg = fontSize * charWidth;
  const perLine = Math.max(1, Math.floor(width / avg));
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const len = word.length;
    if (len > perLine) {
      const extra = Math.ceil(len / perLine);
      if (used > 0) lines += 1;
      lines += extra - 1;
      used = len - (extra - 1) * perLine;
      continue;
    }
    if (used === 0) used = len;
    else if (used + 1 + len <= perLine) used += 1 + len;
    else { lines += 1; used = len; }
  }
  return lines;
}

export function fitText(text: string, o: FitOptions): FitResult {
  const lineHeight = o.lineHeight ?? 1.15;
  const charWidth = o.charWidth ?? 0.58;
  const maxLines = o.maxLines ?? Infinity;
  const clean = text.trim();
  if (!clean) return { fontSize: o.maxSize, lines: 0, overflow: false };
  for (let size = Math.floor(o.maxSize); size >= o.minSize; size -= 2) {
    const lines = estimateLines(clean, size, o.width, charWidth);
    if (lines <= maxLines && lines * size * lineHeight <= o.height) return { fontSize: size, lines, overflow: false };
  }
  const size = Math.floor(o.minSize);
  return { fontSize: size, lines: estimateLines(clean, size, o.width, charWidth), overflow: true };
}

export function fitSingleLine(text: string, width: number, maxSize: number, minSize: number, charWidth = 0.62): number {
  const len = Math.max(1, text.length);
  const size = Math.floor(width / (len * charWidth));
  return Math.max(minSize, Math.min(maxSize, size));
}
