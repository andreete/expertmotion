import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionPageT } from '@expertmotion/composition-model';
import { useTheme } from '../theme.js';
import type { Layout } from '../layout.js';
import { fontStack } from '../font-stack.js';

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
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', paddingLeft: layout.safe.left, paddingRight: layout.safe.right, ...pad }}>
      <div data-em-caption style={{ fontFamily: fontStack(family), fontWeight: weight, fontSize: size, lineHeight: 1.2, textAlign: 'center', whiteSpace: 'pre', color: t.text, textShadow: styleId === 'preset:caption.box' ? 'none' : `0 ${0.04 * size}px ${0.12 * size}px rgba(0,0,0,0.8)`, ...box }}>
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
