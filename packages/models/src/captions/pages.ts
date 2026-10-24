// TikTok-style page grouping, behaviourally equivalent to @remotion/captions `createTikTokStyleCaptions`
// (v4.0.535) without importing Remotion, plus the conversion to composition-model CaptionPage (integer ms).
import type { Caption, CaptionPage, CaptionToken } from './types.js';

export interface TikTokToken { text: string; fromMs: number; toMs: number; pageBreakAfter?: boolean }
export interface TikTokPage { text: string; startMs: number; durationMs: number; tokens: TikTokToken[] }

export interface PageOptions { combineTokensWithinMilliseconds: number; breakOnSilenceAfterMilliseconds?: number }

/**
 * Words that start with a space begin a new page once the current page spans more than `combineTokensWithinMilliseconds`
 * (or after a silence ≥ `breakOnSilenceAfterMilliseconds`); words without a leading space always join the current page.
 * A page lasts until the next page starts; the last page lasts until its last token ends.
 */
export function createTikTokStyleCaptions(captions: readonly Caption[], opts: PageOptions): { pages: TikTokPage[] } {
  const pages: TikTokPage[] = [];
  let currentText = ''; let currentTokens: TikTokToken[] = []; let currentFrom = 0; let currentTo = 0;
  const tok = (text: string, c: Caption): TikTokToken => ({ text, fromMs: c.startMs, toMs: c.endMs, ...(c.pageBreakAfter ? { pageBreakAfter: true } : {}) });
  const add = (): void => {
    const text = currentText.endsWith('\n') ? currentText.slice(0, -1) : currentText;
    pages.push({ text: text.trimStart(), startMs: currentFrom, tokens: currentTokens, durationMs: Infinity });
    const prev = pages[pages.length - 2];
    if (prev) prev.durationMs = currentFrom - prev.startMs;
  };
  captions.forEach((item, index) => {
    const { text } = item;
    const exceedsDuration = currentTo - currentFrom > opts.combineTokensWithinMilliseconds;
    const silence = opts.breakOnSilenceAfterMilliseconds !== undefined && currentText !== '' && item.startMs - currentTo >= opts.breakOnSilenceAfterMilliseconds;
    if (text.startsWith(' ') && (exceedsDuration || silence)) {
      if (currentText !== '') add();
      currentText = text.trimStart();
      currentTokens = [tok(text.trimStart(), item)].filter((t) => t.text !== '');
      currentFrom = item.startMs; currentTo = item.endMs;
    } else {
      if (currentText === '') currentFrom = item.startMs;
      currentText = (currentText + text).trimStart();
      if (text.trim() !== '') currentTokens.push(tok(currentTokens.length === 0 ? currentText.trimStart() : text, item));
      currentTo = item.endMs;
    }
    if (item.pageBreakAfter && currentText !== '') { add(); currentText = ''; currentTokens = []; }
    if (index === captions.length - 1 && currentText !== '') {
      add();
      const last = pages[pages.length - 1]!;
      last.durationMs = currentTo - last.startMs;
    }
  });
  const last = pages[pages.length - 1];
  if (last && last.durationMs === Infinity) last.durationMs = currentTo - last.startMs;
  return { pages };
}

/** Integer-ms CaptionPage[] for the Composition Model (`op:caption.setPages`); empty pages dropped, durations ≥ 0. */
export function toCaptionPages(pages: readonly TikTokPage[]): CaptionPage[] {
  return pages.filter((p) => p.text.trim() !== '').map((p) => ({
    text: p.text,
    startMs: Math.round(p.startMs),
    durationMs: Math.max(0, Math.round(p.durationMs)),
    tokens: p.tokens.map((t): CaptionToken => ({ text: t.text, fromMs: Math.round(t.fromMs), toMs: Math.round(t.toMs) })),
  }));
}

/** captions.generate default (LOCAL_AI_MODELS §8: combineTokensWithinMs 1200). */
export const DEFAULT_COMBINE_MS = 1200;
export function captionsToPages(captions: readonly Caption[], opts: Partial<PageOptions> = {}): CaptionPage[] {
  return toCaptionPages(createTikTokStyleCaptions(captions, { combineTokensWithinMilliseconds: opts.combineTokensWithinMilliseconds ?? DEFAULT_COMBINE_MS,
    ...(opts.breakOnSilenceAfterMilliseconds === undefined ? {} : { breakOnSilenceAfterMilliseconds: opts.breakOnSilenceAfterMilliseconds }) }).pages);
}

/**
 * Subtitle import (op:caption.importSrt): one page per cue (cue boundaries are the author's page breaks), tokens per word
 * with the cue time split in proportion to word length. Multi-line cue text is joined with spaces.
 */
export function cuesToPages(cues: readonly Caption[]): CaptionPage[] {
  const pages: CaptionPage[] = [];
  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) continue;
    const start = Math.round(cue.startMs); const end = Math.max(start, Math.round(cue.endMs));
    const totalChars = words.reduce((a, w) => a + w.length, 0);
    let acc = 0;
    const tokens = words.map((w, i): CaptionToken => {
      const from = start + Math.round(((end - start) * acc) / totalChars);
      acc += w.length;
      const to = i === words.length - 1 ? end : start + Math.round(((end - start) * acc) / totalChars);
      return { text: i === 0 ? w : ` ${w}`, fromMs: from, toMs: to };
    });
    pages.push({ text: words.join(' '), startMs: start, durationMs: end - start, tokens });
  }
  return pages;
}
