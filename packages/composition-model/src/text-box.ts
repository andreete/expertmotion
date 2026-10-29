// ADR-034: where a Text Layer sits and how big it is, in layout units u (frame short side = 1080 u), computed with the shared
// deterministic estimator. ONE function for the Engine renderer (packages/engine/src/text-fit.ts converts it to px), the scene
// composer (packages/agents/src/auto-motion.ts), automatic text stacking in applyOperations and the quality gate, so a layout
// that is checked is the layout that renders.
import { getPreset } from '@expertmotion/catalogue';
import type { FitResult } from '@expertmotion/shared';
import type { Ratio, TextLayerT, ThemeT } from './schema.js';
import { frameInUnits, safeAreaU } from './units.js';
import { glueText } from './glue.js';
import { INTER_ADVANCE, INTER_KERN, INTER_WEIGHTS } from './inter-metrics.generated.js';

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
W['\u00A0'] = W[' ']!;
const WEIGHT_FACTOR = (weight: number) => 1 + Math.max(0, weight - 400) * 0.00018;
/** Inter (the default and editorial face) uses the advance widths MEASURED from the bundled files (round 2), the nearest weights
 *  interpolated, plus Chrome's kerning for common pairs; other sans faces keep the approximate table above. */
const usesInter = (family?: string): boolean => family === undefined || family === '' || /inter/i.test(family);
function interWidthEm(text: string, weight: number): number {
  const ws = INTER_WEIGHTS as readonly number[];
  const wq = Math.max(ws[0]!, Math.min(ws[ws.length - 1]!, weight));
  let lo = ws[0]!, hi = ws[ws.length - 1]!;
  for (const w of ws) { if (w <= wq) lo = w; if (w >= wq && hi >= w) hi = w; }
  const k = hi === lo ? 0 : (wq - lo) / (hi - lo);
  const one = (w: number) => {
    const adv = INTER_ADVANCE[w]!, kern = INTER_KERN[w]!; let sum = 0, prev = '';
    for (const ch of text) { sum += adv[ch] ?? (W[ch] ?? (ch.charCodeAt(0) > 0x2000 ? 0.6 : 0.56)) * WEIGHT_FACTOR(w); if (prev) sum += kern[prev + ch] ?? 0; prev = ch; }
    return sum;
  };
  return k === 0 ? one(lo) : one(lo) * (1 - k) + one(hi) * k;
}
/** Estimated width of a text run in em (no wrapping). */
export function textWidthEm(text: string, weight = 400, family?: string): number {
  if (family && /mono/i.test(family)) return [...text].length * 0.6;
  const tab = family === 'tabular';
  if (!tab && usesInter(family)) return interWidthEm(text, weight);
  let w = 0;
  for (const ch of text) w += tab && ch >= '0' && ch <= '9' ? 0.62 : W[ch] ?? (ch.charCodeAt(0) > 0x2000 ? 0.6 : 0.56);
  return w * WEIGHT_FACTOR(weight);
}
/** Breakable white space (a no-break space glues, glue.ts). */
const BREAK = /[^\S\u00A0\n]+/;
/** `cont`: an extra line the browser needs for a word longer than the line (overflow-wrap: anywhere); it carries no text of its own. */
export interface WrappedLine { text: string; width: number; cont?: true }
/** Words of a paragraph; a glued group wider than the line falls back to its own words (it may then break inside). */
function wordsOf(para: string, fontSize: number, width: number, weight: number, family?: string): string[] {
  return glueText(para).split(BREAK).filter(Boolean).flatMap((w) => (w.includes('\u00A0') && textWidthEm(w, weight, family) * fontSize > width ? w.split('\u00A0').filter(Boolean) : [w]));
}
/** The lines of `text` wrapped greedily at `width` (as the browser fills lines; bound groups glued, glue.ts). */
export function greedyLineTexts(text: string, fontSize: number, width: number, weight = 400, family?: string): WrappedLine[] {
  const space = textWidthEm(' ', weight, family) * fontSize;
  const out: WrappedLine[] = [];
  for (const para of text.split('\n')) {
    let used = 0, line: string[] = [];
    for (const word of wordsOf(para, fontSize, width, weight, family)) {
      const ww = textWidthEm(word, weight, family) * fontSize;
      if (line.length && used + space + ww <= width) { used += space + ww; line.push(word); continue; }
      if (line.length) out.push({ text: line.join(' '), width: used });
      line = [word]; used = ww;
      while (used > width) { out.push({ text: '', width, cont: true }); used -= width; }   // overflow-wrap: anywhere splits a word longer than the line
    }
    out.push({ text: line.join(' '), width: used });
  }
  return out.length ? out : [{ text: '', width: 0 }];
}
const greedyLines = (text: string, fontSize: number, width: number, weight: number, family?: string): number[] => greedyLineTexts(text, fontSize, width, weight, family).map((l) => l.width);
/**
 * Round 2 (QA 2026-10-29, the reference wraps "Ekspor nikel Indonesia, / Jan–Agu 2026" and "Nilai ekspor nikel / (miliar US$)"):
 * the line breaks of a Text Layer are CHOSEN here and the Engine renders exactly these lines (explicit breaks), so the Player,
 * the export and the quality gate agree. Per paragraph: the greedy (fewest) line count n is kept; among all ways to break into n
 * lines that fit `width` (bound groups glued, glue.ts), the one with the smallest cost wins: the widest line (balance), minus a
 * bonus of 0.6 em for a break after clause punctuation (, ; : . ! ?) or before an opening parenthesis / dash, plus 2 em when the
 * last line is one short word (orphan). Paragraphs of 1 line or more than 6 lines keep the greedy result.
 */
export function balancedLineTexts(text: string, fontSize: number, width: number, weight = 400, family?: string): WrappedLine[] {
  const out: WrappedLine[] = [];
  const space = textWidthEm(' ', weight, family) * fontSize;
  for (const para of text.split('\n')) {
    const greedy = greedyLineTexts(para, fontSize, width, weight, family);
    const n = greedy.length;
    const words = wordsOf(para, fontSize, width, weight, family);
    if (n < 2 || n > 6 || words.length > 80) { out.push(...greedy); continue; }
    const ww = words.map((w) => textWidthEm(w, weight, family) * fontSize);
    if (ww.some((x) => x > width)) { out.push(...greedy); continue; }
    const span = (a: number, b: number) => { let x = 0; for (let k = a; k < b; k++) x += ww[k]! + (k > a ? space : 0); return x; };
    const bonus = (k: number) => (/[,;:.!?]["'”’)]*$/.test(words[k - 1]!) || /^[(\[–—]/.test(words[k]!) ? 0.6 * fontSize : 0);
    // best[l][k]: lines 0..l-1 cover words 0..k-1 → { max width, bonus sum, cut }
    type Cell = { max: number; bonus: number; cut: number } | null;
    const best: Cell[][] = Array.from({ length: n + 1 }, () => Array<Cell>(words.length + 1).fill(null));
    best[0]![0] = { max: 0, bonus: 0, cut: 0 };
    const cost = (c: { max: number; bonus: number }) => c.max - c.bonus;
    for (let l = 1; l <= n; l++) for (let k = l; k <= words.length; k++) {
      for (let a = l - 1; a < k; a++) {
        const prev = best[l - 1]![a]; if (!prev) continue;
        const w = span(a, k); if (w > width) continue;
        const c = { max: Math.max(prev.max, w), bonus: prev.bonus + (a > 0 ? bonus(a) : 0), cut: a };
        const cur = best[l]![k];
        if (!cur || cost(c) < cost(cur) - 1e-9) best[l]![k] = c;
      }
    }
    if (!best[n]![words.length]) { out.push(...greedy); continue; }
    const cuts: number[] = []; let k = words.length;
    for (let l = n; l > 0; l--) { cuts.unshift(k); k = best[l]![k]!.cut; }
    const lines: WrappedLine[] = []; let a = 0;
    for (const b of cuts) { lines.push({ text: words.slice(a, b).join(' '), width: span(a, b) }); a = b; }
    // orphan: a last line of one short word → try moving one word down (if it still fits and costs < 2 em more)
    const last = lines[lines.length - 1]!;
    if (lines.length >= 2 && !/ /.test(last.text) && [...last.text].length <= 4) {
      const prevWords = lines[lines.length - 2]!.text.split(' ');
      if (prevWords.length >= 2) {
        const moved = prevWords.pop()! + ' ' + last.text;
        const mw = textWidthEm(moved, weight, family) * fontSize;
        if (mw <= width) { lines[lines.length - 2] = { text: prevWords.join(' '), width: textWidthEm(prevWords.join(' '), weight, family) * fontSize }; lines[lines.length - 1] = { text: moved, width: mw }; }
      }
    }
    out.push(...lines);
  }
  return out.length ? out : [{ text: '', width: 0 }];
}
export const balancedLines = (text: string, fontSize: number, width: number, weight = 400, family?: string): number[] => balancedLineTexts(text, fontSize, width, weight, family).map((l) => l.width);
/** Line count of `text` wrapped at `width` (same unit as fontSize); balancing never changes the count. */
export function wrapLines(text: string, fontSize: number, width: number, weight = 400, family?: string): number {
  return Math.max(1, greedyLines(text, fontSize, width, weight, family).length);
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

export interface BoxU { x0: number; y0: number; x1: number; y1: number }
export interface TextGeometry {
  weight: number; wantU: number; fontSizeU: number; lineHeight: number; lines: number; overflow: boolean;
  /** Width of the text box (u), its centre x (u from the left edge) and the anchor (u from the top-left corner). */
  boxW: number; boxCx: number; anchor: { x: number; y: number };
  /** Estimated painted area (u, top-left origin): the text lines plus the background box padding. */
  box: BoxU; fit: FitResult;
  /** Round 2: the lines the Engine renders (explicit breaks; bound groups joined with U+00A0), from balancedLineTexts. */
  lineTexts: string[];
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
  const laid = balancedLineTexts(layer.text.trim(), fs, innerW, weight, family);
  const longest = Math.min(boxW, Math.min(innerW, Math.max(...laid.map((l) => l.width))) + 2 * padX);
  const align = layer.style.align ?? (v['align'] as 'left' | 'center' | 'right' | undefined) ?? textDefaults.align;
  const left = align === 'left' ? boxCx - boxW / 2 : align === 'right' ? boxCx + boxW / 2 - longest : boxCx - longest / 2;
  const top = layer.valign === 'top' ? anchor.y : anchor.y - textH / 2;
  return { weight, wantU, fontSizeU: fs, lineHeight, lines: fit.lines, overflow: fit.overflow, boxW, boxCx, anchor, fit, lineTexts: laid.filter((l) => !l.cont).map((l) => l.text),
    box: { x0: left, y0: top, x1: left + longest, y1: top + textH } };
}

export const boxesOverlap = (a: BoxU, b: BoxU, gap = 0): boolean => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
