import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { textWidthEm, type CaptionPageT } from '@expertmotion/composition-model';
import { useTheme, type ThemeTokens } from '../theme.js';
import type { Layout } from '../layout.js';
import { fontStack } from '../font-stack.js';
import { easingFn } from '../easing.js';

type Token = CaptionPageT['tokens'][number];
export interface CaptionKeywordGroup { words: readonly string[]; colour: string }
const normalise = (w: string) => w.toLowerCase().replace(/[.,!?;:"“”'‘’()%…—–-]/g, '').trim();
/**
 * ADR-039: the colour of a caption word named by a `keywords` group (`[{words, colour}]`, caption style params); words match
 * after lower-casing and stripping punctuation ("SMR," = "smr"); the first matching group wins; undefined when none.
 */
export function captionKeywordColour(word: string, keywords: unknown): string | undefined {
  if (!Array.isArray(keywords)) return undefined;
  const w = normalise(word);
  if (!w) return undefined;
  for (const g of keywords as Array<Partial<CaptionKeywordGroup>>) {
    if (!g || !Array.isArray(g.words) || typeof g.colour !== 'string') continue;
    if (g.words.some((k) => typeof k === 'string' && normalise(k) === w)) return g.colour;
  }
  return undefined;
}
/**
 * ADR-039 `maxWordsPerPage`: a page is shown in chunks of at most `max` tokens; the chunk holding `nowMs` is returned (the first
 * chunk before any token starts, the last after the page ends). Without a limit the whole page is one chunk.
 */
export function captionChunk(tokens: readonly Token[], max: number | undefined, nowMs: number): Token[] {
  if (!max || max < 1 || tokens.length <= max) return [...tokens];
  const chunks: Token[][] = [];
  for (let i = 0; i < tokens.length; i += max) chunks.push(tokens.slice(i, i + max));
  let shown = chunks[0]!;
  for (const c of chunks) if (c[0]!.fromMs <= nowMs) shown = c;
  return shown;
}

/**
 * One caption page inside its <Sequence> (book §7.7). whiteSpace: 'pre' keeps the leading spaces that separate tokens.
 * ADR-039 params (absent = before): `keywords` per-word colours, `yU` (block top from the frame top, u), `fontSizeU`,
 * `fontFamily` / `weight`, `maxWordsPerPage`. A page without tokens (a silent card) renders nothing.
 */
export const CaptionPageView: React.FC<{ page: CaptionPageT; styleId: string; params: Record<string, unknown>; layout: Layout }> = ({ page, styleId, params, layout }) => {
  const t = useTheme(); const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  if (styleId === 'preset:caption.none') return null;
  if (page.tokens.length === 0 || page.text.trim() === '') return null;
  const nowMs = page.startMs + (frame / fps) * 1000;
  if (styleId === 'preset:caption.emphasis') return <EmphasisPage page={page} params={params} layout={layout} t={t} frame={frame} fps={fps} nowMs={nowMs} />;
  const size = Number(params['fontSizeU'] ?? params['fontSize'] ?? 56) * layout.u;
  const accent = String(params['highlightColour'] ?? t.accent);
  const family = typeof params['fontFamily'] === 'string' && params['fontFamily'] ? params['fontFamily'] : t.headingFont;
  const weight = typeof params['weight'] === 'number' ? params['weight'] : 800;
  const yU = typeof params['yU'] === 'number' ? params['yU'] : undefined;
  const pos = String(params['position'] ?? 'bottom');
  const justify = yU !== undefined || pos === 'top' ? 'flex-start' : pos === 'center' ? 'center' : 'flex-end';
  const pad = yU !== undefined ? { paddingTop: yU * layout.u } : pos === 'top' ? { paddingTop: layout.safe.top } : pos === 'bottom' ? { paddingBottom: layout.safe.bottom } : {};
  const box = styleId === 'preset:caption.box' ? { background: 'rgba(0,0,0,0.75)', borderRadius: 0.3 * size, padding: `${0.25 * size}px ${0.45 * size}px` } : {};
  const tokens = captionChunk(page.tokens, typeof params['maxWordsPerPage'] === 'number' ? params['maxWordsPerPage'] : undefined, nowMs);
  // a long one-line page shrinks to stay inside the safe area (never wraps or runs to the frame edge)
  const availPx = layout.width - layout.safe.left - layout.safe.right;
  const widthEm = textWidthEm(tokens.map((x) => x.text).join('').trim(), weight, family);
  const fitPx = widthEm > 0 ? Math.min(size, availPx / widthEm) : size;
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', paddingLeft: layout.safe.left, paddingRight: layout.safe.right, ...pad }}>
      <div data-em-caption style={{ fontFamily: fontStack(family), fontWeight: weight, fontSize: fitPx, lineHeight: 1.2, textAlign: 'center', whiteSpace: 'pre', color: t.text, textShadow: styleId === 'preset:caption.box' ? 'none' : `0 ${0.04 * size}px ${0.12 * size}px rgba(0,0,0,0.8)`, ...box }}>
        {tokens.map((tok, i) => {
          const active = tok.fromMs <= nowMs && tok.toMs > nowMs;
          const spoken = tok.toMs <= nowMs;
          const key = captionKeywordColour(tok.text, params['keywords']);   // a keyword keeps its colour spoken or not
          let style: React.CSSProperties = {};
          switch (styleId) {
            case 'preset:caption.karaoke': style = { color: key ?? (spoken || active ? accent : t.text) }; break;
            case 'preset:caption.pop': { const s = active ? spring({ frame: frame - Math.round(((tok.fromMs - page.startMs) / 1000) * fps), fps, config: { damping: 10 } }) : 0; style = { color: key ?? (active ? accent : t.text), display: 'inline-block', scale: 1 + 0.2 * s }; break; }
            case 'preset:caption.moving-pill': style = active ? { background: key ?? accent, color: t.bg, borderRadius: 0.25 * size, padding: `0 ${0.15 * size}px` } : key ? { color: key } : {}; break;
            default: style = { color: key ?? (active ? accent : t.text) };     // editorial, box
          }
          return <span key={i} data-em-token={active ? 'active' : spoken ? 'spoken' : 'next'} style={style}>{tok.text}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------------------------------------------------------
// ADR-041 `preset:caption.emphasis` (Sampel 4 "LO *Bayangin* NIH"): a centred kinetic caption page — the ordinary words small,
// upper-case, in the theme body font with letter-spacing; the page's keyword words (the existing `keywords[{words}]` groups) large
// in an italic serif (`emphasisFont`, default Playfair Display) in `emphasisColour` (default theme accent). The whole page rises
// and fades in. The shared text estimator (composition-model textWidthEm) wraps the words and shrinks BOTH sizes together until
// the block fits the safe width and ≤ EMPHASIS_MAX_HEIGHT of the frame (floor EMPHASIS_MIN_SCALE; never cut, never clipped).
// ---------------------------------------------------------------------------------------------------------------------------
export const EMPHASIS_SMALL_U = 34, EMPHASIS_BIG_RATIO = 92 / 34, EMPHASIS_LETTER_SPACING_EM = 0.08, EMPHASIS_MAX_HEIGHT = 0.5, EMPHASIS_MIN_SCALE = 0.45;
export interface EmphasisWord { text: string; big: boolean; active: boolean; spoken: boolean }
export interface EmphasisLayout { smallPx: number; bigPx: number; scale: number; lines: EmphasisWord[][]; heightPx: number }
/** Width (px) of one word of the emphasis page at the given sizes: small words upper-case with letter spacing, big words serif italic 700. */
export function emphasisWordWidth(w: EmphasisWord, smallPx: number, bigPx: number, smallFamily: string, bigFamily: string, smallWeight: number): number {
  const text = w.text.trim();
  if (w.big) return textWidthEm(text, 700, bigFamily) * bigPx * 1.04;                           // italic serif overhangs a little
  const upper = text.toUpperCase();
  return textWidthEm(upper, smallWeight, smallFamily) * smallPx + EMPHASIS_LETTER_SPACING_EM * smallPx * Math.max(0, [...upper].length - 1);
}
/**
 * Lines and sizes of an emphasis page (pure). `widthPx` = the room between the safe margins, `heightPx` = the frame height. Words
 * wrap greedily; the gap between words is 0.3 × the small size; a line with a big word is bigPx × 1.1 tall, else smallPx × 1.5.
 * Shrinks in 5 % steps until the widest line and the block height fit (or the floor is reached).
 */
export function emphasisLayout(words: readonly EmphasisWord[], widthPx: number, heightPx: number, baseSmallPx: number, smallFamily: string, bigFamily: string, smallWeight = 600): EmphasisLayout {
  const maxH = heightPx * EMPHASIS_MAX_HEIGHT;
  let scale = 1;
  for (;;) {
    const smallPx = baseSmallPx * scale, bigPx = baseSmallPx * EMPHASIS_BIG_RATIO * scale, gap = 0.3 * smallPx;
    const lines: EmphasisWord[][] = []; let line: EmphasisWord[] = [], lineW = 0, widest = 0;
    for (const w of words) {
      const ww = emphasisWordWidth(w, smallPx, bigPx, smallFamily, bigFamily, smallWeight);
      if (line.length && lineW + gap + ww > widthPx) { lines.push(line); widest = Math.max(widest, lineW); line = []; lineW = 0; }
      lineW += (line.length ? gap : 0) + ww; line.push(w);
    }
    if (line.length) { lines.push(line); widest = Math.max(widest, lineW); }
    const height = lines.reduce((h, l) => h + (l.some((w) => w.big) ? bigPx * 1.1 : smallPx * 1.5), 0);
    if ((widest <= widthPx && height <= maxH) || scale <= EMPHASIS_MIN_SCALE + 1e-9) return { smallPx, bigPx, scale, lines, heightPx: height };
    scale = Math.max(EMPHASIS_MIN_SCALE, Math.round((scale - 0.05) * 100) / 100);
  }
}
const serifStack = (family: string) => `"${family}", Georgia, "Times New Roman", serif`;
const EmphasisPage: React.FC<{ page: CaptionPageT; params: Record<string, unknown>; layout: Layout; t: ThemeTokens; frame: number; fps: number; nowMs: number }> = ({ page, params, layout, t, frame, fps, nowMs }) => {
  const u = layout.u;
  const tokens = captionChunk(page.tokens, typeof params['maxWordsPerPage'] === 'number' ? params['maxWordsPerPage'] : undefined, nowMs);
  const words: EmphasisWord[] = tokens.filter((tok) => tok.text.trim()).map((tok) => ({ text: tok.text.trim(), big: captionKeywordColour(tok.text, params['keywords']) !== undefined, active: tok.fromMs <= nowMs && tok.toMs > nowMs, spoken: tok.toMs <= nowMs }));
  if (!words.length) return null;
  const smallFamily = typeof params['fontFamily'] === 'string' && params['fontFamily'] ? params['fontFamily'] : t.bodyFont;
  const bigFamily = typeof params['emphasisFont'] === 'string' && params['emphasisFont'] ? params['emphasisFont'] : 'Playfair Display';
  const smallWeight = typeof params['weight'] === 'number' ? params['weight'] : 600;
  const baseSmall = (typeof params['fontSizeU'] === 'number' ? params['fontSizeU'] : EMPHASIS_SMALL_U) * u;
  const room = Math.max(10, layout.contentW - 2 * 24 * u);
  const lay = emphasisLayout(words, room, layout.height, baseSmall, smallFamily, bigFamily, smallWeight);
  const colour = String(params['emphasisColour'] ?? t.accent);
  // rise + fade of the page (0.3 s, out-cubic); exit none — the next page replaces it
  const k = interpolate(frame, [0, Math.max(1, Math.round(0.3 * fps))], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: easingFn('preset:easing.out-cubic') });
  const yU = typeof params['yU'] === 'number' ? params['yU'] : undefined;
  const pos = String(params['position'] ?? 'bottom');
  const justify = yU !== undefined || pos === 'top' ? 'flex-start' : 'center';                 // ADR-041: centred unless placed at the top / yU
  const pad = yU !== undefined ? { paddingTop: yU * u } : pos === 'top' ? { paddingTop: layout.safe.top } : {};
  const shadow = `0 ${Math.round(0.06 * lay.smallPx * 100) / 100}px ${Math.round(0.35 * lay.smallPx * 100) / 100}px rgba(0,0,0,0.65)`;
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', paddingLeft: layout.safe.left, paddingRight: layout.safe.right, ...pad }}>
      <div data-em-caption data-em-emphasis-scale={lay.scale} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: Math.round(k * 1000) / 1000, translate: `0px ${Math.round((1 - k) * 24 * u * 100) / 100}px`, textAlign: 'center', textShadow: shadow, color: t.text }}>
        {lay.lines.map((line, li) => (
          <div key={li} data-em-emphasis-line style={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'baseline', justifyContent: 'center', columnGap: `${Math.round(0.3 * lay.smallPx * 100) / 100}px`, whiteSpace: 'nowrap', lineHeight: line.some((w) => w.big) ? 1.1 : 1.5 }}>
            {line.map((w, wi) => (w.big
              ? <span key={wi} data-em-token={w.active ? 'active' : w.spoken ? 'spoken' : 'next'} data-em-emphasis="big" style={{ fontFamily: serifStack(bigFamily), fontStyle: 'italic', fontWeight: 700, fontSize: Math.round(lay.bigPx * 100) / 100, color: colour }}>{w.text}</span>
              : <span key={wi} data-em-token={w.active ? 'active' : w.spoken ? 'spoken' : 'next'} data-em-emphasis="small" style={{ fontFamily: fontStack(smallFamily), fontWeight: smallWeight, fontSize: Math.round(lay.smallPx * 100) / 100, letterSpacing: `${EMPHASIS_LETTER_SPACING_EM}em`, textTransform: 'uppercase' }}>{w.text.toUpperCase()}</span>))}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
