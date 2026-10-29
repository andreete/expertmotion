// Round 2 (QA 2026-10-29, nikel vs the reference video Ekspektasi.mp4): bound groups never break and lines are balanced like the
// reference ("Ekspor nikel Indonesia, / Jan–Agu 2026", "Nilai ekspor nikel / (miliar US$)", "Sumber: ESDM via / ANTARA, 28 Okt
// 2026"); the estimator uses the advance widths measured from the bundled Inter files.
import { describe, expect, it } from 'vitest';
import { balancedLineTexts, glueText, gluedPair, greedyLineTexts, NBSP, textGeometry, textWidthEm } from '../src/index.js';
import { INTER_CHECK } from '../src/inter-metrics.generated.js';

const lines = (text: string, size: number, width: number, weight = 400) => balancedLineTexts(text, size, width, weight).map((l) => l.text.replace(/ /g, ' '));
// nikel spec: safe area left 88 / right 160 → 832 u of content width on 1080 × 1920
const W = 1080 - 88 - 160;

describe('glueText', () => {
  it('glues month ranges + year, day + month, parenthesised units, number + unit, currency + number', () => {
    expect(glueText('Ekspor nikel Indonesia, Jan–Agu 2026')).toBe(`Ekspor nikel Indonesia, Jan–Agu${NBSP}2026`);
    expect(glueText('Nilai ekspor nikel (miliar US$)')).toBe(`Nilai ekspor nikel (miliar${NBSP}US$)`);
    expect(glueText('Sumber: ESDM via ANTARA, 28 Okt 2026')).toBe(`Sumber: ESDM via ANTARA, 28${NBSP}Okt${NBSP}2026`);
    expect(glueText('hampir 25,96 miliar dolar')).toBe(`hampir 25,96${NBSP}miliar dolar`);
    expect(glueText('target US$ 45 miliar')).toBe(`target US$${NBSP}45${NBSP}miliar`);
    expect(glueText('Januari–Agustus 2026')).toBe(`Januari–Agustus${NBSP}2026`);
  });
  it('keeps breaks after clause punctuation, keeps length and newlines, ignores long parentheses', () => {
    expect(gluedPair('Indonesia,', 'Jan–Agu')).toBe(false);
    expect(gluedPair('2026,', 'miliar')).toBe(false);
    const t = 'Satu dua\n(tiga empat lima enam tujuh delapan sembilan)';
    expect(glueText(t)).toBe(t);
    expect(glueText('Rp 472 triliun').length).toBe('Rp 472 triliun'.length);
  });
});

describe('measured Inter widths', () => {
  it('match Chrome\'s own width of the kicker within 1.5 % (kerning of common pairs included)', () => {
    for (const w of [400, 500, 700]) expect(Math.abs(textWidthEm('Ekspor nikel Indonesia, Jan–Agu 2026', w, 'Inter') / INTER_CHECK[w]! - 1)).toBeLessThan(0.015);
  });
});

describe('balanced lines like the reference', () => {
  it('kicker 52 u, headline 64 u / 500, source 44 u: the reference line breaks', () => {
    expect(lines('Ekspor nikel Indonesia, Jan–Agu 2026', 52, W)).toEqual(['Ekspor nikel Indonesia,', 'Jan–Agu 2026']);
    expect(lines('Nilai ekspor nikel (miliar US$)', 64, W, 500)).toEqual(['Nilai ekspor nikel', '(miliar US$)']);
    expect(lines('Sumber: ESDM via ANTARA, 28 Okt 2026', 44, W)).toEqual(['Sumber: ESDM via', 'ANTARA, 28 Okt 2026']);
    expect(lines('Sumber: ESDM, 14 Okt 2026; ESDM via ANTARA', 44, W)).toEqual(['Sumber: ESDM, 14 Okt 2026;', 'ESDM via ANTARA']);
  });
  it('balancing never adds a line; greedy fill was the old (wider) result', () => {
    const t = 'Sumber: ESDM via ANTARA, 28 Okt 2026';
    expect(greedyLineTexts(t, 44, W).map((l) => l.text.replace(/\u00A0/g, ' '))).toEqual(['Sumber: ESDM via ANTARA,', '28 Okt 2026']);
    expect(greedyLineTexts(t, 44, W).length).toBe(balancedLineTexts(t, 44, W).length);
    expect(Math.max(...balancedLineTexts(t, 44, W).map((l) => l.width))).toBeLessThan(Math.max(...greedyLineTexts(t, 44, W).map((l) => l.width)));
    // a paragraph break of the Creator is kept, each paragraph laid out on its own
    expect(lines('Satu\nEkspor nikel Indonesia, Jan–Agu 2026', 52, W)).toEqual(['Satu', 'Ekspor nikel Indonesia,', 'Jan–Agu 2026']);
  });
  it('a bound group wider than the line falls back to its words (bar label "Jan–Agu / 2026"); a too-long word is never repeated', () => {
    const w = textWidthEm('Jan–Agu', 400) * 40 + 4;
    expect(lines('Jan–Agu 2026', 40, w)).toEqual(['Jan–Agu', '2026']);
    const long = 'Supercalifragilisticexpialidocious kata';
    const g = textGeometry({ text: long, variantId: 'preset:text.subtitle', position: { x: 0, y: 0 }, maxWidth: 300, valign: 'top', style: { fontSize: 60, weight: 400 } as never },
      '9:16', { fontSize: 64, weight: 400, colour: '#FFFFFF', align: 'left', opacity: 1 });
    expect(g.lineTexts.join(' ').replace(/\u00A0/g, ' ').split(/\s+/)).toEqual(long.split(' '));
    expect(g.lines).toBeGreaterThan(g.lineTexts.length - 1);
  });
  it('the painted box (quality gate / stacking) is the balanced width and textGeometry hands the Engine the same lines', () => {
    const g = textGeometry({ text: 'Sumber: ESDM via ANTARA, 28 Okt 2026', variantId: 'preset:text.subtitle', position: { x: -(1080 / 2) + 88 + W / 2, y: 0 }, maxWidth: W, valign: 'top', style: { fontSize: 44, weight: 400, align: 'left' } as never },
      '9:16', { fontSize: 64, weight: 400, colour: '#FFFFFF', align: 'left', opacity: 1 });
    expect(g.lines).toBe(2);
    expect(g.lineTexts.map((l) => l.replace(/\u00A0/g, ' '))).toEqual(['Sumber: ESDM via', 'ANTARA, 28 Okt 2026']);
    expect(g.box.x1 - g.box.x0).toBeLessThan(W * 0.65);
  });
});
