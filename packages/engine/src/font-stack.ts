// QA A16 (ADR-039): display faces such as Poppins draw math / arrow symbols (≤ ≥ ± × ÷ ≈ ≠ → ∞) small or odd at heading
// weights, or lack them. Two measures, both pure: every text run uses a font STACK that falls back per glyph to Inter (bundled)
// and the system sans; and `symbolRuns` wraps such symbols in an explicit Inter span, so "≤ 300 MWe" reads at the heading size.
import React from 'react';

export const fontStack = (family: string): string => (/^\s*inter\s*$/i.test(family) ? `"${family}", sans-serif` : `"${family}", Inter, sans-serif`);
export const SYMBOL_RE = /([≤≥±×÷≈≠→←↑↓∞≪≫]+)/u;
export const hasSymbols = (text: string): boolean => SYMBOL_RE.test(text);
/** `text` split into plain runs and symbol spans (fontFamily Inter); a plain string when there is nothing to wrap. */
export function symbolRuns(text: string, keyPrefix = 's'): React.ReactNode {
  if (!hasSymbols(text)) return text;
  return text.split(SYMBOL_RE).map((part, i) => (part && SYMBOL_RE.test(part)
    ? React.createElement('span', { key: `${keyPrefix}${i}`, 'data-em-symbol': true, style: { fontFamily: 'Inter, sans-serif' } }, part)
    : part));
}
