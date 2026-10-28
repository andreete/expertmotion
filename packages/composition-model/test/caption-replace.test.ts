// ADR-033 (QA 2026-10-28 "energi besi"): op:caption.replaceText / op:caption.editPage change one caption page only.
import { describe, expect, it } from 'vitest';
import { applyOperations, conflictsWithLocked, propertyKeysOf, summarizeForAgent, type CaptionPageT, type CompositionModelT } from '../src/index.js';
import { ASSETS, base, ctx, deepFreeze, must, op } from './helpers.js';

const PAGES: CaptionPageT[] = [
  { text: 'Halo semua', startMs: 0, durationMs: 2000, tokens: [{ text: 'Halo', fromMs: 0, toMs: 1000 }, { text: ' semua', fromMs: 1000, toMs: 2000 }] },
  { text: 'Kita butuh energi besi', startMs: 11000, durationMs: 2000, tokens: [{ text: 'Kita', fromMs: 11000, toMs: 11400 }, { text: ' butuh', fromMs: 11400, toMs: 11900 }, { text: ' energi', fromMs: 11900, toMs: 12500 }, { text: ' besi', fromMs: 12500, toMs: 13000 }] },
  // script-caption convention: page text and every token keep their leading space
  { text: ' Energi besi murah', startMs: 15000, durationMs: 2000, tokens: [{ text: ' Energi', fromMs: 15000, toMs: 15600 }, { text: ' besi', fromMs: 15600, toMs: 16200 }, { text: ' murah', fromMs: 16200, toMs: 17000 }] },
];
const withCaptions = (): CompositionModelT => must(base(), [op('op:caption.setPages', { pages: PAGES })]);
const replace = (args: Record<string, unknown>, m = withCaptions()) => applyOperations(m, [op('op:caption.replaceText', args, { kind: 'project' })], ctx());
const pagesOf = (r: ReturnType<typeof applyOperations>) => { if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model.tracks.caption.pages; };
const blocked = (r: ReturnType<typeof applyOperations>) => (r.ok ? null : r.issues[0]!);
const texts = (p: CaptionPageT[]) => p.map((x) => x.text);
/** Tokens keep order, never overlap, stay inside the page and tile the edited span. */
function wellTimed(p: CaptionPageT) {
  for (const [i, t] of p.tokens.entries()) {
    expect(t.toMs).toBeGreaterThanOrEqual(t.fromMs);
    if (i > 0) expect(t.fromMs).toBe(p.tokens[i - 1]!.toMs);
  }
  expect(p.tokens.map((t) => t.text).join('').trim()).toBe(p.text.trim());
}

describe('op:caption.replaceText', () => {
  it('atMs: only the page that holds that moment changes; its tokens are re-split over the old span', () => {
    const p = pagesOf(replace({ find: 'energi besi', replace: 'energi bersih', atMs: 12000 }));
    expect(texts(p)).toEqual(['Halo semua', 'Kita butuh energi bersih', ' Energi besi murah']);
    expect(p[0]).toEqual(PAGES[0]); expect(p[2]).toEqual(PAGES[2]);
    expect(p[1]).toMatchObject({ startMs: 11000, durationMs: 2000 });
    expect(p[1]!.tokens).toEqual([PAGES[1]!.tokens[0], PAGES[1]!.tokens[1], { text: ' energi', fromMs: 11900, toMs: 12450 }, { text: ' bersih', fromMs: 12450, toMs: 13000 }]);
    wellTimed(p[1]!);
  });
  it('a single word inside one token keeps every other token untouched', () => {
    const p = pagesOf(replace({ find: 'besi', replace: 'bersih', atMs: 12000 }));
    expect(p[1]!.tokens.slice(0, 3)).toEqual(PAGES[1]!.tokens.slice(0, 3));
    expect(p[1]!.tokens[3]).toEqual({ text: ' bersih', fromMs: 12500, toMs: 13000 });
  });
  it('atMs between pages: the nearest page within 1.5 s that contains the text; nothing near → EM-2102', () => {
    expect(texts(pagesOf(replace({ find: 'besi', replace: 'bersih', atMs: 13500 })))[1]).toBe('Kita butuh energi bersih');
    // 14 000 ms is nearer page 2, but only page 1 has "butuh"
    expect(texts(pagesOf(replace({ find: 'butuh', replace: 'perlu', atMs: 14000 })))).toEqual(['Halo semua', 'Kita perlu energi besi', ' Energi besi murah']);
    expect(blocked(replace({ find: 'besi', replace: 'x', atMs: 40_000 }))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.atMs' });
    const miss = blocked(replace({ find: 'murah', replace: 'mahal', atMs: 12000 }));
    expect(miss).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.find' });
    expect(miss!.message).toContain('Kita butuh energi besi');                // the correction message shows the page that is there
  });
  it('pageIndex addresses one page (case-insensitive by default; the replacement is used as written)', () => {
    const p = pagesOf(replace({ find: 'energi besi', replace: 'energi bersih', pageIndex: 2 }));
    expect(texts(p)).toEqual(['Halo semua', 'Kita butuh energi besi', ' energi bersih murah']);
    expect(p[2]!.tokens.map((t) => t.text)).toEqual([' energi', ' bersih', ' murah']);
    expect(p[2]!.tokens.at(-1)).toEqual(PAGES[2]!.tokens[2]);
    wellTimed(p[2]!);
    expect(blocked(replace({ find: 'besi', replace: 'x', pageIndex: 3 }))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.pageIndex' });
    expect(blocked(replace({ find: 'halo', replace: 'x', pageIndex: 1 }))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.find' });
  });
  it('no address: the first occurrence only; all: every occurrence', () => {
    expect(texts(pagesOf(replace({ find: 'energi besi', replace: 'energi bersih' })))).toEqual(['Halo semua', 'Kita butuh energi bersih', ' Energi besi murah']);
    expect(texts(pagesOf(replace({ find: 'besi', replace: 'bersih', all: true })))).toEqual(['Halo semua', 'Kita butuh energi bersih', ' Energi bersih murah']);
    const m = must(base(), [op('op:caption.setPages', { pages: [{ ...PAGES[1]!, text: 'besi dan besi', tokens: [{ text: 'besi', fromMs: 11000, toMs: 11500 }, { text: ' dan', fromMs: 11500, toMs: 12000 }, { text: ' besi', fromMs: 12000, toMs: 13000 }] }] })]);
    expect(texts(pagesOf(replace({ find: 'besi', replace: 'baja', atMs: 11000 }, m)))).toEqual(['baja dan besi']);
    const all = pagesOf(replace({ find: 'besi', replace: 'baja', atMs: 11000, all: true }, m));
    expect(texts(all)).toEqual(['baja dan baja']);
    expect(all[0]!.tokens).toEqual([{ text: 'baja', fromMs: 11000, toMs: 11500 }, { text: ' dan', fromMs: 11500, toMs: 12000 }, { text: ' baja', fromMs: 12000, toMs: 13000 }]);
  });
  it('caseSensitive: true matches the exact case only', () => {
    expect(texts(pagesOf(replace({ find: 'Energi besi', replace: 'Energi bersih', caseSensitive: true })))).toEqual(['Halo semua', 'Kita butuh energi besi', ' Energi bersih murah']);
    expect(blocked(replace({ find: 'HALO', replace: 'Hai', caseSensitive: true }))).toMatchObject({ code: 'EM-2102' });
  });
  it('a match across tokens re-splits only those tokens: span, order and the other tokens are kept', () => {
    const p = pagesOf(replace({ find: 'butuh energi', replace: 'sangat perlu energi', atMs: 12000 }))[1]!;
    expect(p.text).toBe('Kita sangat perlu energi besi');
    expect(p.tokens.map((t) => t.text)).toEqual(['Kita', ' sangat', ' perlu', ' energi', ' besi']);
    expect(p.tokens[0]).toEqual(PAGES[1]!.tokens[0]); expect(p.tokens[4]).toEqual(PAGES[1]!.tokens[3]);
    expect(p.tokens[1]!.fromMs).toBe(11400); expect(p.tokens[3]!.toMs).toBe(12500);
    wellTimed(p);
  });
  it('replace "" drops words; a page left without words is removed (info)', () => {
    expect(pagesOf(replace({ find: ' besi', replace: '', atMs: 12000 }))[1]!.tokens.map((t) => t.text)).toEqual(['Kita', ' butuh', ' energi']);
    const r = replace({ find: 'halo semua', replace: '', pageIndex: 0 });
    expect(texts(pagesOf(r))).toEqual(['Kita butuh energi besi', ' Energi besi murah']);
    expect(r.ok && r.warnings.some((w) => w.code === 'EM-2203' && w.severity === 'info')).toBe(true);
  });
  it('a page without tokens: the text is replaced and tokens are timed over the page', () => {
    const m = must(base(), [op('op:caption.setPages', { pages: [{ text: 'energi besi', startMs: 1000, durationMs: 1200, tokens: [] }] })]);
    const p = pagesOf(replace({ find: 'besi', replace: 'bersih' }, m))[0]!;
    expect(p.text).toBe('energi bersih');
    expect(p.tokens).toEqual([{ text: 'energi', fromMs: 1000, toMs: 1600 }, { text: ' bersih', fromMs: 1600, toMs: 2200 }]);
  });
  it('invalid use → EM-2102: no captions, both addresses, empty find, unknown arg', () => {
    expect(blocked(replace({ find: 'a', replace: 'b' }, base()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(replace({ find: 'besi', replace: 'b', atMs: 12000, pageIndex: 1 }))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.pageIndex' });
    expect(blocked(replace({ find: '', replace: 'b' }))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.find' });
    expect(blocked(replace({ find: 'a', replace: 'b', page: 1 }))).toMatchObject({ code: 'EM-2102' });
  });
  it('is pure and its diff is the caption track only (Undo = the previous Composition Version)', () => {
    const m = deepFreeze(withCaptions());
    const r = replace({ find: 'besi', replace: 'bersih', atMs: 12000 }, m);
    expect(m.tracks.caption.pages[1]!.text).toBe('Kita butuh energi besi');
    expect(r.ok && r.value.diff).toEqual([{ elementId: 'project.caption', change: 'modified', fields: ['pages'] }]);
    // the inverse edit restores the original page exactly when the word lengths match
    const back = pagesOf(replace({ find: 'bersih', replace: 'besi', atMs: 12000 }, (r as { value: { model: CompositionModelT } }).value.model));
    expect(back).toEqual(PAGES);
  });
  it('Locked Keys: only the text of the addressed page', () => {
    const k = (args: Record<string, unknown>) => propertyKeysOf(op('op:caption.replaceText', { find: 'a', replace: 'b', ...args }, { kind: 'project' }));
    expect(k({ pageIndex: 3 })).toEqual(['project.captionPages.3.text']);
    expect(k({ atMs: 12000 })).toEqual(['project.captionPages.@12000.text']);
    expect(k({})).toEqual(['project.captionPages.text']);
    expect(conflictsWithLocked(k({ pageIndex: 3 }), ['project.captionPages'])).toEqual(['project.captionPages']);
    expect(conflictsWithLocked(k({ atMs: 12000 }), ['project.captionStyle', 'project.captionPages.2.text'])).toEqual([]);
    expect(conflictsWithLocked(k({ pageIndex: 2 }), ['project.captionPages.2.text'])).toEqual(['project.captionPages.2.text']);
  });
});

describe('op:caption.editPage', () => {
  const edit = (args: Record<string, unknown>, m = withCaptions()) => applyOperations(m, [op('op:caption.editPage', args, { kind: 'project' })], ctx());
  it('retypes one page; start / duration kept; tokens re-timed over the page span', () => {
    const p = pagesOf(edit({ atMs: 12000, text: 'Kita butuh energi bersih sekarang' }));
    expect(texts(p)).toEqual(['Halo semua', 'Kita butuh energi bersih sekarang', ' Energi besi murah']);
    expect(p[1]).toMatchObject({ startMs: 11000, durationMs: 2000 });
    expect(p[1]!.tokens[0]!).toMatchObject({ text: 'Kita', fromMs: 11000 }); expect(p[1]!.tokens.at(-1)!.toMs).toBe(13000);
    expect(p[1]!.tokens).toHaveLength(5);
    wellTimed(p[1]!);
    expect(pagesOf(edit({ pageIndex: 2, text: 'Energi bersih murah' }))[2]!.tokens.map((t) => t.text)).toEqual([' Energi', ' bersih', ' murah']);
  });
  it('needs exactly one address and a non-blank text; keys like replaceText', () => {
    expect(blocked(edit({ text: 'x' }))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(edit({ text: '   ', pageIndex: 0 }))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.text' });
    expect(blocked(edit({ text: 'x', pageIndex: 0, atMs: 0 }))).toMatchObject({ code: 'EM-2102' });
    expect(propertyKeysOf(op('op:caption.editPage', { text: 'x', pageIndex: 1 }))).toEqual(['project.captionPages.1.text']);
  });
});

describe('summarizeForAgent lists caption pages (ADR-033)', () => {
  it('index, start, end and text so one page can be addressed', () => {
    const s = summarizeForAgent(withCaptions(), ASSETS);
    expect(s.captions.pages).toBe(3);
    expect(s.captions.list).toEqual([{ i: 0, startMs: 0, endMs: 2000, text: 'Halo semua' }, { i: 1, startMs: 11000, endMs: 13000, text: 'Kita butuh energi besi' }, { i: 2, startMs: 15000, endMs: 17000, text: 'Energi besi murah' }]);
  });
  it('is budgeted: long caption lists are cut first and marked truncated', () => {
    const pages = Array.from({ length: 150 }, (_, i) => ({ text: `Kalimat panjang nomor ${i} tentang energi bersih untuk semua`, startMs: i * 100, durationMs: 100, tokens: [] }));
    const s = summarizeForAgent(must(base(), [op('op:caption.setPages', { pages })]), ASSETS, 1500);
    expect(s.truncated).toBe(true);
    expect(s.captions.list.length).toBeLessThan(150);
    expect(s.captions.list[0]!.i).toBe(0);
    expect(s.video).toHaveLength(3);
  });
});
