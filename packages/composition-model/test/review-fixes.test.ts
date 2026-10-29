// Regression tests for the adversarial review of 2026-10-29 (composition-model / catalogue part): C1 Duplicate / Copy-Paste keep
// every field, C4 bezier x outside 0..1 rejected, C8 paste of non-adjacent scenes + paste slot after a transition, C9 a voice of
// unknown length keeps its captions when the next voice moves earlier.
import { describe, expect, it } from 'vitest';
import { validateParams } from '@expertmotion/catalogue';
import { applyOperations, copySnapshot, createEmptyModel, duplicationSteps, pasteSlot, pasteSteps, type CompositionModelT } from '../src/index.js';
import { ctx, must, op } from './helpers.js';

const empty = () => createEmptyModel('p1', { autoRatio: false });
type Visual = CompositionModelT['tracks']['text'][number] | CompositionModelT['tracks']['overlay'][number];
/** Everything of an element except what a copy gets new: id, start time and lane. */
const body = (x: Visual) => { const { id: _i, layer: _l, timing, ...rest } = x; return { ...rest, durationMs: timing.durationMs }; };

/** One text, one shape and one image with every optional field set, plus a static text (motion null). */
function rich(): CompositionModelT {
  const m = must(empty(), [
    op('op:text.add', { text: 'Rp 1,2 triliun', variant: 'preset:text.title', atMs: 500, durationMs: 2500, position: { x: 12, y: -300 }, maxWidth: 640, valign: 'top',
      styleOverrides: { colour: '#FFD400', fontSize: 96, weight: 800, lineHeight: 1.3, italic: true, align: 'left', opacity: 0.9, box: { colour: '#102030', padX: 24, padY: 12, radius: 40 } },
      motion: { presetId: 'preset:motion.rise', durationMs: 700, delayMs: 200, easingId: 'preset:easing.out-cubic', exit: false, params: { distanceU: 60, bezier: [0.2, 0.8, 0.2, 1] } },
      effect: { presetId: 'preset:texteffect.counter', params: { from: 0, durationMs: 1200 } } }),
    op('op:text.add', { text: 'Diam', variant: 'preset:text.subtitle', atMs: 0, durationMs: 1000, position: { x: 0, y: 500 }, motion: { presetId: 'preset:motion.none' } }),
    op('op:shape.add', { presetId: 'preset:shape.rect', atMs: 0, durationMs: 2000, position: { x: -100, y: 200 }, size: 600, height: 56, fill: '#00AA55', stroke: '#FFFFFF', strokeWidth: 4, opacity: 0.8,
      params: { cornerRadius: 8 }, motion: { presetId: 'preset:motion.grow', durationMs: 900, params: { direction: 'up' } } }),
    op('op:overlay.addImage', { assetId: 'img', atMs: 1000, durationMs: 3000, position: { x: 50, y: -50 }, size: 300, objectFit: 'cover', opacity: 0.7, motion: { presetId: 'preset:motion.scale-in', durationMs: 500 } }),
  ]);
  const sh = m.tracks.overlay.find((o) => o.kind === 'shape')!, img = m.tracks.overlay.find((o) => o.kind === 'image')!;
  return must(m, [op('op:element.setTransform', { scale: 1.5, rotation: 30 }, { kind: 'shape', id: sh.id }), op('op:element.setTransform', { scale: 0.5, rotation: -10 }, { kind: 'image', id: img.id })]);
}
const all = (m: CompositionModelT): Visual[] => [...m.tracks.text, ...m.tracks.overlay];

describe('C1 Duplicate and Copy / Paste copy every field', () => {
  it('duplicate(x) equals x except id, start and lane (text maxWidth / valign / motion / effect / style; shape height / opacity / motion / zoom; image zoom / motion)', () => {
    const m = rich();
    const r = must(m, duplicationSteps(m, all(m).map((x) => ({ kind: 'kind' in x ? x.kind : 'text' as const, id: x.id }))).map((s) => s.op));
    for (const x of all(m)) {
      const copy = all(r).find((y) => !all(m).some((o) => o.id === y.id) && ('kind' in y ? y.kind : 'text') === ('kind' in x ? x.kind : 'text') && JSON.stringify(body(y)) === JSON.stringify(body(x)));
      expect(copy, `copy of ${x.id}`).toBeDefined();
      expect(body(copy!)).toEqual(body(x));
      expect(copy!.timing.atMs).toBe(x.timing.atMs + x.timing.durationMs);
    }
    const sh = r.tracks.overlay.filter((o) => o.kind === 'shape');
    expect(sh.map((o) => [o.size.w, o.size.h])).toEqual([[600, 56], [600, 56]]);           // a bar stays a bar (was 600 × 600)
  });
  it('copy then paste rebuilds the same elements at the paste time', () => {
    const m = rich();
    const { entries } = copySnapshot(m, all(m).map((x) => ({ kind: 'kind' in x ? x.kind : 'text' as const, id: x.id })));
    const r = must(m, pasteSteps(m, entries, 10_000).map((s) => s.op));
    const fresh = all(r).filter((y) => !all(m).some((o) => o.id === y.id));
    expect(fresh.map(body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(all(m).map(body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });
});

describe('C4 bezier easing x values must be in 0..1', () => {
  it('the catalogue rejects x outside 0..1 for motions and the counter effect, keeps y overshoot', () => {
    expect(validateParams('preset:motion.rise', { bezier: [1.2, 0, 0.5, 1] }).ok).toBe(false);
    expect(validateParams('preset:motion.rise', { bezier: [0.2, 0, -0.1, 1] }).ok).toBe(false);
    expect(validateParams('preset:motion.rise', { bezier: [0.2, -1, 0.8, 2.5] }).ok).toBe(true);
    expect(validateParams('preset:texteffect.counter', { bezier: [0.3, 0, 1.5, 1] }).ok).toBe(false);
  });
  it('a direct op with such a bezier is blocked with EM-2102 instead of crashing every frame', () => {
    const r = applyOperations(empty(), [op('op:text.add', { text: 'Halo', variant: 'preset:text.title', atMs: 0, durationMs: 1000, motion: { presetId: 'preset:motion.rise', params: { bezier: [1.2, 0, 0.5, 1] } } })], ctx());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]!.code).toBe('EM-2102');
  });
});

describe('C8 paste of scenes that were not next to each other', () => {
  const faceless = () => must(empty(), [
    op('op:scene.add', { durationMs: 3000, title: 'A' }, { kind: 'sequence' }),
    op('op:scene.add', { durationMs: 4000, title: 'B' }, { kind: 'sequence' }),
    op('op:scene.add', { durationMs: 2000, title: 'C' }, { kind: 'sequence' }),
  ], { ...ctx(), assets: [] });
  it('scenes A and C pasted back to back keep their own titles on them', () => {
    const m = faceless();
    const [a, , c] = m.tracks.video;
    const { entries } = copySnapshot(m, [{ kind: 'clip', id: a!.id }, { kind: 'clip', id: c!.id }]);
    const r = must(m, pasteSteps(m, entries, 9000).map((s) => s.op), { ...ctx(), assets: [] });
    expect(r.tracks.video.map((v) => v.durationMs)).toEqual([3000, 4000, 2000, 3000, 2000]);
    const titles = r.tracks.text.filter((x) => x.timing.atMs >= 9000).map((x) => [x.text, x.timing.atMs]).sort((p, q) => Number(p[1]) - Number(q[1]));
    expect(titles).toEqual([['A', 9000], ['C', 12000]]);                                // C was at 16000 (its offset from A)
  });
  it('pasteSlot inside a clip followed by a transition starts where the next clip started', () => {
    const m = must(faceless(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 })], { ...ctx(), assets: [] });
    expect(pasteSlot(m, 1000)).toEqual({ index: 1, startMs: 2500 });
  });
});

describe('C9 captions of a voice with unknown length', () => {
  it('moving the next voice earlier does not drop the first voice\'s caption pages', () => {
    const assets = [{ id: 'va', kind: 'audio' as const, status: 'ready' as const, name: 'a.wav' }, { id: 'vb', kind: 'audio' as const, status: 'ready' as const, durationMs: 2000, name: 'b.wav' }];
    const c = { ...ctx(), assets };
    const m = must(empty(), [op('op:audio.addLayer', { assetId: 'va', atMs: 0, volume: 1 }), op('op:audio.addLayer', { assetId: 'vb', atMs: 5000, volume: 1 }),
      op('op:caption.setPages', { pages: [{ text: 'satu dua', startMs: 1000, durationMs: 2000, tokens: [{ text: 'satu', fromMs: 1000, toMs: 2000 }, { text: ' dua', fromMs: 2000, toMs: 3000 }] }] }, { kind: 'project' })], c);
    const b = m.tracks.audio.find((x) => x.assetId === 'vb')!;
    const r = must(m, [op('op:element.setTiming', { atMs: 2500, durationMs: 2000 }, { kind: 'audio', id: b.id })], c);
    expect(r.tracks.caption.pages.map((p) => [p.text, p.startMs, p.durationMs])).toEqual([['satu dua', 1000, 2000]]);
  });
});
