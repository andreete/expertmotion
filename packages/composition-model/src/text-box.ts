// ADR-034: where a Text Layer sits and how big it is, in layout units u (frame short side = 1080 u), computed with the shared
// deterministic estimator. ONE function for the Engine renderer (packages/engine/src/text-fit.ts converts it to px), the scene
// composer (packages/agents/src/auto-motion.ts), automatic text stacking in applyOperations and the quality gate, so a layout
// that is checked is the layout that renders.
import { getPreset } from '@expertmotion/catalogue';
import type { FitResult } from '@expertmotion/shared';
import type { Ratio, TextLayerT, ThemeT } from './schema.js';
import { frameInUnits, safeAreaU } from './units.js';

/** Average glyph width as a fraction of the font size, by weight (bold faces are wider). */
export const charWidthFor = (weight: number): number => (weight >= 700 ? 0.6 : weight >= 600 ? 0.57 : weight >= 500 ? 0.55 : 0.54);
/** Smallest size (u) a Text Layer is shrunk to before it reports overflow. */
export const MIN_FIT_U = 34;
export const DEFAULT_LINE_HEIGHT = 1.15;

// Approximate advance widths (em) of the bundled sans faces (Inter / Plus Jakarta Sans / Archivo at regular weight), per glyph,
// so line breaks and pill / prefix widths follow the real text closely (a fixed average over-wrapped "Empat bulan terakhir" and
// "25,96" in the 2026-10-28 reference comparison). Unknown glyphs use the weight average. JetBrains Mono is 0.6 em throughout.
const W: Record<string, number> = {};
const set = (chars: string, w: number) => { for (const ch of chars) W[ch] = w; };
set('ijl|!.,:;\'`·', 0.26); set('ftrI()[]{}', 0.36); set(' ', 0.27); set('0123456789', 0.57); set('sczvxyk', 0.515); set('aeJ?', 0.555); set('bdghnopqu', 0.59);
set('m', 0.86); set('M', 0.87); set('w', 0.78); set('ABCDGHKNOQRUVXY', 0.7); set('EFLPSTZ', 0.62); set('W', 0.95); set('%', 0.8); set('@', 0.95); set('+−–-=±<>~$#&*/', 0.6); set('—', 0.9); set('"“”\'‘’', 0.3);
const WEIGHT_FACTOR = (weight: number) => 1 + Math.max(0, weight - 400) * 0.00018;
/** Estimated width of a text run in em (no wrapping). */
export function textWidthEm(text: string, weight = 400, family?: string): number {
  if (family && /mono/i.test(family)) return text.length * 0.6;
  const tab = family === 'tabular';
  let w = 0;
  for (const ch of text) w += tab && ch >= '0' && ch <= '9' ? 0.62 : W[ch] ?? (ch.charCodeAt(0) > 0x2000 ? 0.6 : 0.56);
  return w * WEIGHT_FACTOR(weight);
}
/** Greedy line count of `text` wrapped at `width` (same unit as fontSize). */
export function wrapLines(text: string, fontSize: number, width: number, weight = 400, family?: string): number {
  const space = textWidthEm(' ', weight, family) * fontSize;
  let lines = 0;
  for (const para of text.split('\n')) {
    let used = 0; lines += 1;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const ww = textWidthEm(word, weight, family) * fontSize;
      if (used === 0) { used = ww; if (ww > width) { lines += Math.ceil(ww / width) - 1; used = ww % width; } continue; }
      if (used + space + ww <= width) used += space + ww;
      else { lines += 1; used = ww; if (ww > width) { lines += Math.ceil(ww / width) - 1; used = ww % width; } }
    }
  }
  return Math.max(1, lines);
}
/** fitText with the glyph-width estimator: largest size ≤ maxSize (2 u steps) whose wrapped lines fit maxLines and height. */
export function fitTextWidth(text: string, o: { width: number; height: number; maxSize: number; minSize: number; lineHeight: number; maxLines: number; weight: number; family?: string | undefined }): FitResult {
  const clean = text.trim();
  if (!clean) return { fontSize: o.maxSize, lines: 0, overflow: false };
  for (let size = o.maxSize; size >= o.minSize; size -= 2) {
    const lines = wrapLines(clean, size, o.width, o.weight, o.family);
    if (!/\s/.test(clean) && textWidthEm(clean, o.weight, o.family) * size > o.width) continue;   // one word is never broken: shrink instead
    if (lines <= o.maxLines && lines * size * o.lineHeight <= o.height) return { fontSize: size, lines, overflow: false };
  }
  return { fontSize: o.minSize, lines: wrapLines(clean, o.minSize, o.width, o.weight, o.family), overflow: true };
}
/** Width (u) of the longest wrapped line, for one-line and short texts. */
function longestLine(text: string, fontSize: number, width: number, weight: number, family?: string): number {
  const space = textWidthEm(' ', weight, family) * fontSize;
  let best = 0, used = 0;
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const ww = textWidthEm(word, weight, family) * fontSize;
    if (used === 0) used = Math.min(ww, width); else if (used + space + ww <= width) used += space + ww; else { best = Math.max(best, used); used = Math.min(ww, width); }
  }
  return Math.max(best, used);
}

export interface BoxU { x0: number; y0: number; x1: number; y1: number }
export interface TextGeometry {
  weight: number; wantU: number; fontSizeU: number; lineHeight: number; lines: number; overflow: boolean;
  /** Width of the text box (u), its centre x (u from the left edge) and the anchor (u from the top-left corner). */
  boxW: number; boxCx: number; anchor: { x: number; y: number };
  /** Estimated painted area (u, top-left origin): the text lines plus the background box padding. */
  box: BoxU; fit: FitResult;
}

export function textGeometry(layer: Pick<TextLayerT, 'text' | 'variantId' | 'position' | 'maxWidth' | 'style' | 'valign'> & { effect?: TextLayerT['effect'] | undefined }, ratio: Ratio, textDefaults: ThemeT['textDefaults'], custom?: { w: number; h: number }): TextGeometry {
  const v = (getPreset(layer.variantId)?.data ?? {}) as Record<string, unknown>;
  const f = frameInUnits(ratio, custom), safe = safeAreaU(ratio);
  const contentW = f.w - safe.left - safe.right, contentH = f.h - safe.top - safe.bottom;
  const weight = layer.style.weight ?? Number(v['weight'] ?? textDefaults.weight);
  const wantU = layer.style.fontSize ?? Number(v['fontSize'] ?? textDefaults.fontSize);
  const lineHeight = layer.style.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const anchor = { x: f.w / 2 + layer.position.x, y: f.h / 2 + layer.position.y };
  // The box is centred on its anchor and kept inside the safe area (lower thirds, corner callouts): its width is at most twice the
  // room to the nearer safe edge; when that room is tiny a minimum width is kept and the box is shifted inward instead.
  const room = 2 * Math.max(0, Math.min(anchor.x - safe.left, f.w - safe.right - anchor.x));
  const boxW = Math.max(Math.min(0.3 * contentW, layer.maxWidth ?? Infinity), Math.min(layer.maxWidth ?? Infinity, contentW, room));
  const boxCx = Math.min(Math.max(anchor.x, safe.left + boxW / 2), f.w - safe.right - boxW / 2);
  const padX = layer.style.box?.padX ?? (v['box'] ? 0.5 * wantU : 0), padY = layer.style.box?.padY ?? (v['box'] ? 0.3 * wantU : 0);
  // a count-up that is centred / right-aligned uses tabular figures (no jitter of its left edge), which are wider (0.62 em)
  const align0 = layer.style.align ?? (v['align'] as string | undefined) ?? textDefaults.align;
  const tabular = layer.effect?.presetId === 'preset:texteffect.counter' && align0 !== 'left';
  const family = tabular ? 'tabular' : layer.style.fontFamily ?? textDefaults.fontFamily;
  const innerW = Math.max(10, boxW - 2 * padX);
  const fit = fitTextWidth(layer.text, { width: innerW, height: Math.max(contentH * 0.5, wantU * lineHeight), maxSize: wantU, minSize: Math.min(MIN_FIT_U, wantU), maxLines: 6, lineHeight, weight, family });
  const fs = fit.fontSize;
  const textH = Math.max(1, fit.lines) * fs * lineHeight + 2 * padY;
  const longest = Math.min(boxW, longestLine(layer.text, fs, innerW, weight, family) + 2 * padX);
  const align = layer.style.align ?? (v['align'] as 'left' | 'center' | 'right' | undefined) ?? textDefaults.align;
  const left = align === 'left' ? boxCx - boxW / 2 : align === 'right' ? boxCx + boxW / 2 - longest : boxCx - longest / 2;
  const top = layer.valign === 'top' ? anchor.y : anchor.y - textH / 2;
  return { weight, wantU, fontSizeU: fs, lineHeight, lines: fit.lines, overflow: fit.overflow, boxW, boxCx, anchor, fit,
    box: { x0: left, y0: top, x1: left + longest, y1: top + textH } };
}

export const boxesOverlap = (a: BoxU, b: BoxU, gap = 0): boolean => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
