// ADR-031: manual Delete / Duplicate steps (removalSteps / duplicationSteps) and scene-anchored texts (followSceneAnchors in
// applyOperations): a scene's own texts move with it when an earlier scene is removed, inserted, moved or trimmed.
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, deriveTiming, duplicationSteps, hashModel, laneConflicts, removalSteps, sceneAnchors, sceneItemsOf, type CompositionModelT } from '../src/index.js';
import { base, ctx, must, op } from './helpers.js';

const empty = () => createEmptyModel('p1', { autoRatio: false });
/** Three scenes A (3 s), B (4 s), C (2 s) with one title each, no transitions. */
const faceless = (): CompositionModelT => must(empty(), [
  op('op:scene.add', { durationMs: 3000, title: 'A' }, { kind: 'sequence' }),
  op('op:scene.add', { durationMs: 4000, title: 'B' }, { kind: 'sequence' }),
  op('op:scene.add', { durationMs: 2000, title: 'C' }, { kind: 'sequence' }),
], { ...ctx(), assets: [] });
const titleAt = (m: CompositionModelT, text: string) => m.tracks.text.find((x) => x.text === text)?.timing;
const apply = (m: CompositionModelT, steps: ReturnType<typeof removalSteps>) => must(m, steps.map((s) => s.op), { ...ctx() });

describe('ADR-031 scene anchors', () => {
  it('texts fully inside a scene clip belong to it; media clips anchor nothing', () => {
    const m = faceless();
    const [a, b] = m.tracks.video;
    expect(sceneItemsOf(m, b!.id).map((r) => m.tracks.text.find((x) => x.id === r.id)?.text)).toEqual(['B']);
    expect(sceneAnchors(m)).toHaveLength(3);
    expect(sceneItemsOf(m, a!.id)).toHaveLength(1);
    const media = must(base(), [op('op:text.add', { text: 'Promo', variant: 'preset:text.title', atMs: 0, durationMs: 1000 })]);
    expect(sceneAnchors(media)).toEqual([]);
  });
  it('op:clip.remove of scene A moves B and C texts left with their scenes (lane rule kept)', () => {
    const m = faceless();
    const r = must(m, [op('op:clip.remove', {}, { kind: 'clip', id: m.tracks.video[0]!.id })], { ...ctx(), assets: [] });
    expect(titleAt(r, 'B')).toEqual({ atMs: 0, durationMs: 4000 });
    expect(titleAt(r, 'C')).toEqual({ atMs: 4000, durationMs: 2000 });
    expect(titleAt(r, 'A')).toEqual({ atMs: 0, durationMs: 3000 });                 // the removed scene's own text is not removed by the op itself
    expect(laneConflicts(r)).toEqual([]);
  });
  it('op:clip.move, op:scene.add at an index, op:clip.setTrim and op:transition.set move later scene texts too', () => {
    const m = faceless();
    const [a, , c] = m.tracks.video;
    const moved = must(m, [op('op:clip.move', { toIndex: 0 }, { kind: 'clip', id: c!.id })], { ...ctx(), assets: [] });
    expect([titleAt(moved, 'C')!.atMs, titleAt(moved, 'A')!.atMs, titleAt(moved, 'B')!.atMs]).toEqual([0, 2000, 5000]);
    const inserted = must(m, [op('op:scene.add', { durationMs: 1000, atIndex: 1 }, { kind: 'sequence' })], { ...ctx(), assets: [] });
    expect([titleAt(inserted, 'A')!.atMs, titleAt(inserted, 'B')!.atMs, titleAt(inserted, 'C')!.atMs]).toEqual([0, 4000, 8000]);
    const trimmed = must(m, [op('op:clip.setTrim', { trimBeforeMs: 0, durationMs: 1000 }, { kind: 'clip', id: a!.id })], { ...ctx(), assets: [] });
    expect([titleAt(trimmed, 'B')!.atMs, titleAt(trimmed, 'C')!.atMs]).toEqual([1000, 5000]);
    const faded = must(m, [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 })], { ...ctx(), assets: [] });
    expect([titleAt(faded, 'B')!.atMs, titleAt(faded, 'C')!.atMs]).toEqual([2500, 6500]);
  });
  it('items across a cut or over the whole video keep their absolute times', () => {
    const m = must(faceless(), [op('op:text.add', { text: 'Logo', variant: 'preset:text.title', atMs: 0, durationMs: 9000 }), op('op:text.add', { text: 'Lintas', variant: 'preset:text.title', atMs: 2500, durationMs: 1000 })], { ...ctx(), assets: [] });
    const r = must(m, [op('op:clip.remove', {}, { kind: 'clip', id: m.tracks.video[0]!.id })], { ...ctx(), assets: [] });
    expect(titleAt(r, 'Logo')).toEqual({ atMs: 0, durationMs: 9000 });
    expect(titleAt(r, 'Lintas')).toEqual({ atMs: 2500, durationMs: 1000 });
  });
});

describe('ADR-031 Delete (removalSteps)', () => {
  it('a scene clip takes its own texts with it; later scenes close the gap; one apply = one version', () => {
    const m = faceless();
    const b = m.tracks.video[1]!;
    const steps = removalSteps(m, [{ kind: 'clip', id: b.id }]);
    expect(steps.map((s) => s.op.op)).toEqual(['op:text.remove', 'op:clip.remove']);
    const r = apply(m, steps);
    expect(r.tracks.text.map((x) => [x.text, x.timing.atMs])).toEqual([['A', 0], ['C', 3000]]);
    expect(deriveTiming(r).durationMs).toBe(5000);
  });
  it('orders transitions and effects before clips, merges caption pages into one setPages, skips unknown and duplicate refs', () => {
    let m = must(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 400 }, { kind: 'cut', index: 1 }),
      op('op:caption.setPages', { pages: [0, 1, 2].map((i) => ({ text: `p${i}`, startMs: i * 1000, durationMs: 900, tokens: [] })) }, { kind: 'project' }),
      op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1 })]);
    m = must(m, [op('op:effect.add', { presetId: 'preset:effect.vignette' }, { kind: 'clip', id: m.tracks.video[2]!.id })]);
    const [c1, , c3] = m.tracks.video;
    const steps = removalSteps(m, [{ kind: 'clip', id: c1!.id }, { kind: 'caption', index: 2 }, { kind: 'cut', index: 1 }, { kind: 'caption', index: 0 }, { kind: 'audio', id: m.tracks.audio[0]!.id },
      { kind: 'effect', id: `${c3!.id}|preset:effect.vignette` }, { kind: 'clip', id: c1!.id }, { kind: 'text', id: 'gone' }]);
    expect(steps.map((s) => s.op.op)).toEqual(['op:transition.clear', 'op:effect.remove', 'op:caption.setPages', 'op:audio.remove', 'op:clip.remove']);
    const r = apply(m, steps);
    expect(r.tracks.caption.pages.map((p) => p.text)).toEqual(['p1']);
    expect(r.transitions).toEqual([]);
    expect(r.tracks.video).toHaveLength(2);
    expect(r.tracks.audio).toEqual([]);
    expect(r.tracks.video[1]!.effects).toEqual([]);
  });
  it('the effect of a deleted clip is dropped with the clip; nothing that exists → no steps', () => {
    const m0 = base();
    const m = must(m0, [op('op:effect.add', { presetId: 'preset:effect.vignette' }, { kind: 'clip', id: m0.tracks.video[0]!.id })]);
    const id = m.tracks.video[0]!.id;
    expect(removalSteps(m, [{ kind: 'effect', id: `${id}|preset:effect.vignette` }, { kind: 'clip', id }]).map((s) => s.op.op)).toEqual(['op:clip.remove']);
    expect(removalSteps(m, [{ kind: 'text', id: 'nope' }, { kind: 'cut', index: 9 }])).toEqual([]);
  });
  it('is pure', () => {
    const m = faceless(); const h = hashModel(m);
    removalSteps(m, [{ kind: 'clip', id: m.tracks.video[0]!.id }]);
    expect(hashModel(m)).toBe(h);
  });
});

describe('ADR-031 Duplicate (duplicationSteps)', () => {
  it('a text / image / shape copy starts where the original ends, on a free lane, with content, style, position and size', () => {
    const m = must(base(), [op('op:text.add', { text: 'Halo', variant: 'preset:text.title', atMs: 1000, durationMs: 2000, styleOverrides: { colour: '#FF0000' } }),
      op('op:overlay.addImage', { assetId: 'img', atMs: 0, durationMs: 1000, size: 300 }), op('op:shape.add', { presetId: 'preset:shape.circle', atMs: 0, durationMs: 1500, fill: '#00FF00' })]);
    const t = m.tracks.text[0]!, img = m.tracks.overlay.find((o) => o.kind === 'image')!, sh = m.tracks.overlay.find((o) => o.kind === 'shape')!;
    const r = apply(m, duplicationSteps(m, [{ kind: 'text', id: t.id }, { kind: 'image', id: img.id }, { kind: 'shape', id: sh.id }, { kind: 'audio', id: 'x' }]));
    const copy = r.tracks.text.find((x) => x.id !== t.id)!;
    expect(copy).toMatchObject({ text: 'Halo', variantId: 'preset:text.title', timing: { atMs: 3000, durationMs: 2000 }, position: t.position, style: { colour: '#FF0000' } });
    expect(r.tracks.overlay.filter((o) => o.kind === 'image').map((o) => [o.timing.atMs, o.size.w])).toEqual([[0, 300], [1000, 300]]);
    expect(r.tracks.overlay.filter((o) => o.kind === 'shape').map((o) => [o.timing.atMs, o.kind === 'shape' ? o.fill : ''])).toEqual([[0, '#00FF00'], [1500, '#00FF00']]);
    expect(laneConflicts(r)).toEqual([]);
  });
  it('a media clip copy goes right after it with the same media, trim and length', () => {
    const b0 = base();
    const m = must(b0, [op('op:clip.setTrim', { trimBeforeMs: 1000, durationMs: 3000 }, { kind: 'clip', id: b0.tracks.video[0]!.id })]);
    const steps = duplicationSteps(m, [{ kind: 'clip', id: m.tracks.video[0]!.id }]);
    expect(steps.map((s) => s.op)).toMatchObject([{ op: 'op:clip.insert', args: { assetId: 'v1', atIndex: 1, trimBeforeMs: 1000, durationMs: 3000 } }]);
    const r = apply(m, steps);
    expect(r.tracks.video.map((c) => [c.assetId, c.trimBeforeMs, c.durationMs])).toEqual([['v1', 1000, 3000], ['v1', 1000, 3000], ['v2', 0, 6000], ['v3', 0, 5000]]);
  });
  it('a scene copy brings its own title; later scenes and their texts move after it; two scenes at once stay consistent', () => {
    const m = faceless();
    const [a, b] = m.tracks.video;
    const r = apply(m, duplicationSteps(m, [{ kind: 'clip', id: a!.id }]));
    expect(r.tracks.video).toHaveLength(4);
    expect(r.tracks.text.map((x) => [x.text, x.timing.atMs]).sort((p, q) => Number(p[1]) - Number(q[1]))).toEqual([['A', 0], ['A', 3000], ['B', 6000], ['C', 10000]]);
    const both = apply(m, duplicationSteps(m, [{ kind: 'clip', id: a!.id }, { kind: 'clip', id: b!.id }, { kind: 'text', id: m.tracks.text[0]!.id }]));
    expect(both.tracks.text.map((x) => [x.text, x.timing.atMs]).sort((p, q) => Number(p[1]) - Number(q[1]))).toEqual([['A', 0], ['A', 3000], ['B', 6000], ['B', 10000], ['C', 14000]]);
    const t = deriveTiming(both);
    both.tracks.text.forEach((x) => { const inside = both.tracks.video.some((c) => x.timing.atMs >= t.elementWindows[c.id]!.fromMs && x.timing.atMs + x.timing.durationMs <= t.elementWindows[c.id]!.toMs); expect(inside, x.text).toBe(true); });
  });
  it('audio, captions, transitions, effects and the background are not duplicable', () => {
    const m = must(base(), [op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1 })]);
    expect(duplicationSteps(m, [{ kind: 'audio', id: m.tracks.audio[0]!.id }, { kind: 'background' }, { kind: 'cut', index: 0 }])).toEqual([]);
  });
});

describe('ADR-031 whole pick on one apply', () => {
  it('applyOperations is still pure and blocks unknown targets with EM-2203', () => {
    const m = faceless();
    const r = applyOperations(m, [op('op:text.remove', {}, { kind: 'text', id: 'nope' })], { ...ctx(), assets: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('EM-2203');
  });
});
