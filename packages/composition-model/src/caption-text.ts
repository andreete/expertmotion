// ADR-033 (QA 2026-10-28 "energi besi"): precise caption text edits. Pure helpers behind op:caption.replaceText and
// op:caption.editPage. Pages keep their startMs / durationMs; only the tokens that held the edited text are re-split, over
// their own time span, in proportion to the characters of the new words (the renderer draws `tokens`, so text and tokens stay in step).
import type { CaptionPageT } from './schema.js';

type Token = CaptionPageT['tokens'][number];
/** atMs addressing: a page within this distance of atMs counts when no page contains it (spoken-second estimates are rough). */
export const CAPTION_NEAR_MS = 1500;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const finder = (find: string, caseSensitive: boolean) => new RegExp(escapeRe(find), caseSensitive ? 'g' : 'gi');
const joined = (p: CaptionPageT) => p.tokens.map((t) => t.text).join('');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Distance of atMs from a page's [startMs, endMs) (0 when inside). */
export function pageDistance(p: Pick<CaptionPageT, 'startMs' | 'durationMs'>, atMs: number): number {
  const end = p.startMs + Math.max(1, p.durationMs);
  return atMs < p.startMs ? p.startMs - atMs : atMs >= end ? atMs - end + 1 : 0;
}
/** Page indexes that atMs addresses, best first: containing pages, then pages within CAPTION_NEAR_MS by distance. */
export function pagesNear(pages: readonly CaptionPageT[], atMs: number): number[] {
  return pages.map((p, i) => ({ i, d: pageDistance(p, atMs) })).filter((x) => x.d <= CAPTION_NEAR_MS).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.i);
}
export const pageHas = (p: CaptionPageT, find: string, caseSensitive: boolean): boolean =>
  finder(find, caseSensitive).test(p.tokens.length && norm(joined(p)) === norm(p.text) ? joined(p) : p.text);

/** Words of `text` (each keeps the whitespace before it) timed over [from, to] in proportion to their characters. */
function splitTimed(text: string, from: number, to: number): Token[] {
  const words = text.match(/\s*\S+/g) ?? [];
  const w = words.map((x) => Math.max(1, x.trim().length));
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return words.map((x, i) => {
    const f = from + Math.round(((to - from) * acc) / total);
    acc += w[i]!;
    return { text: x, fromMs: f, toMs: i === words.length - 1 ? to : from + Math.round(((to - from) * acc) / total) };
  });
}
/** The page text follows its tokens, with the page's own leading-space convention. */
function textFromTokens(p: CaptionPageT, tokens: Token[]): string {
  const t = tokens.map((x) => x.text).join('');
  return /^\s/.test(p.text) ? t : t.trimStart();
}

/** Replaces `find` in one page (first occurrence, or every one with `all`). Returns null when the page does not contain it. */
export function replaceInPage(p: CaptionPageT, find: string, replace: string, opts: { all: boolean; caseSensitive: boolean }): { page: CaptionPageT; count: number } | null {
  const tokensMatchText = p.tokens.length > 0 && norm(joined(p)) === norm(p.text);
  if (!tokensMatchText) {
    // No tokens (or tokens that disagree with the text): edit the text, re-time the whole page.
    const hits = [...p.text.matchAll(finder(find, opts.caseSensitive))];
    if (!hits.length) return null;
    const used = opts.all ? hits : hits.slice(0, 1);
    let text = p.text;
    for (const h of [...used].reverse()) text = text.slice(0, h.index) + replace + text.slice(h.index! + h[0].length);
    return { page: retextPage(p, text), count: used.length };
  }
  const hits = [...joined(p).matchAll(finder(find, opts.caseSensitive))];
  if (!hits.length) return null;
  const used = opts.all ? hits : hits.slice(0, 1);
  const leadingSpace = /^\s/.test(p.tokens[0]!.text);
  let tokens = p.tokens.map((t) => ({ ...t }));
  for (const h of [...used].reverse()) {                         // right to left: earlier offsets stay valid
    const s = h.index!, e = s + h[0].length;
    let off = 0, i = -1, j = -1, offI = 0, offJ = 0;
    tokens.forEach((t, k) => {
      const end = off + t.text.length;
      if (i < 0 && end > s) { i = k; offI = off; }
      if (off < e) { j = k; offJ = off; }
      off = end;
    });
    const a = tokens[i]!, b = tokens[j]!;
    const combined = a.text.slice(0, s - offI) + replace + b.text.slice(e - offJ);
    tokens = [...tokens.slice(0, i), ...splitTimed(combined, a.fromMs, b.toMs), ...tokens.slice(j + 1)];
  }
  if (tokens[0] && !leadingSpace) tokens[0] = { ...tokens[0], text: tokens[0].text.trimStart() };
  return { page: { ...p, tokens, text: textFromTokens(p, tokens) }, count: used.length };
}

/** New text for a whole page (op:caption.editPage): same start / duration, tokens re-split over the old tokens' span. */
export function retextPage(p: CaptionPageT, text: string): CaptionPageT {
  const from = p.tokens[0]?.fromMs ?? p.startMs, to = p.tokens.at(-1)?.toMs ?? p.startMs + p.durationMs;
  const leadingSpace = p.tokens.length ? /^\s/.test(p.tokens[0]!.text) : false;
  const tokens = splitTimed(text.trim(), from, Math.max(from, to)).map((t, i) => ({ ...t, text: i === 0 ? (leadingSpace ? ` ${t.text.trimStart()}` : t.text.trimStart()) : t.text.replace(/^\s+/, ' ') }));
  return { ...p, tokens, text: textFromTokens(p, tokens) };
}
