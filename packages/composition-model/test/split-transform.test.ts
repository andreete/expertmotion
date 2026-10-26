// ADR-028: op:element.split (cut a clip / text / image / shape / audio layer in two) and op:element.setTransform (picture
// position, zoom and rotation inside the frame). Split maths (source offsets, playback rate, transitions, fades, lanes),
// transform apply / validation / locking keys, and the "optional field, no schema bump" policy (hashes of old models unchanged).
import { describe, expect, it } from 'vitest';
import { applyOperations, CompositionModel, conflictsWithLocked, createEmptyModel, deriveTiming, hashModel, migrateModel, normaliseRotation, propertyKeysOf, summarizeForAgent, type CompositionModelT } from '../src/index.js';
import { ASSETS, base, ctx, deepFreeze, must, op } from './helpers.js';

const blocked = (r: ReturnType<typeof applyOperations>) => (r.ok ? null : r.issues[0]!);
const split = (kind: string, id: string, atMs: number) => op('op:element.split', { atMs }, { kind: kind as 'clip', id });
const tf = (kind: string, id: string, args: Record<string, unknown>) => op('op:element.setTransform', args, { kind: kind as 'clip', id });
const ids = (m: CompositionModelT) => m.tracks.video.map((c) => c.id);

describe('op:element.split on a video clip', () => {
  it('two adjacent parts; the second continues the source with trimBeforeMs + d × playbackRate', () => {
    const m0 = must(createEmptyModel('p', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v1', trimBeforeMs: 1000, durationMs: 4000 })]);
    const id = m0.tracks.video[0]!.id;
    const m1 = must(m0, [op('op:clip.setPlaybackRate', { rate: 2 }, { kind: 'clip', id })]);       // uses 1000 + 4000 × 2 = 9000 of 10 000 ms
    const m = must(m1, [split('clip', id, 1500)]);
    expect(m.tracks.video.map((c) => [c.trimBeforeMs, c.durationMs, c.playbackRate])).toEqual([[1000, 1500, 2], [4000, 2500, 2]]);
    expect(m.tracks.video[0]!.id).toBe(id);
    expect(m.tracks.video[1]!.id).not.toBe(id);
    // The picture is continuous: part 2 starts where part 1 ends in the source, and the source end is unchanged.
    const [a, b] = m.tracks.video as [typeof m.tracks.video[0], typeof m.tracks.video[0]];
    expect(a.trimBeforeMs + a.durationMs * a.playbackRate).toBe(b.trimBeforeMs);
    expect(b.trimBeforeMs + b.durationMs * b.playbackRate).toBe(9000);
    expect(deriveTiming(m).durationMs).toBe(deriveTiming(m1).durationMs);
  });
  it('the transition after the clip moves to the second part; the new cut has none; total duration unchanged', () => {
    const b0 = must(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 }), op('op:transition.set', { presetId: 'preset:transition.wipe', durationMs: 1000 }, { kind: 'cut', index: 1 })]);
    const clip2 = b0.tracks.video[1]!;
    const at = deriveTiming(b0).clipStartMs[1]! + 3000;                                          // 3 s into clip 2 (6 s)
    const m = must(b0, [split('clip', clip2.id, at)]);
    expect(m.tracks.video.map((c) => [c.assetId, c.durationMs, c.trimBeforeMs])).toEqual([['v1', 8000, 0], ['v2', 3000, 0], ['v2', 3000, 3000], ['v3', 5000, 0]]);
    expect(m.transitions.map((t) => [t.cutIndex, t.presetId])).toEqual([[0, 'preset:transition.fade'], [2, 'preset:transition.wipe']]);
    expect(deriveTiming(m).durationMs).toBe(deriveTiming(b0).durationMs);
    expect(deriveTiming(m).cutStartMs[1]).toBe(at);                                              // the new cut is exactly at the split point
  });
  it('transitions next to a part that became too short are shortened (EM-2305 warn) or removed', () => {
    const b0 = must(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 1000 }, { kind: 'cut', index: 0 })]);
    const clip2 = b0.tracks.video[1]!, start = deriveTiming(b0).clipStartMs[1]!;
    const r = applyOperations(b0, [split('clip', clip2.id, start + 1200)], ctx());
    expect(r.ok && r.value.model.transitions).toEqual([expect.objectContaining({ cutIndex: 0, durationMs: 600 })]);
    expect(r.ok && r.warnings.map((i) => [i.code, i.severity])).toContainEqual(['EM-2305', 'warn']);
    const r2 = applyOperations(b0, [split('clip', clip2.id, start + 150)], ctx());
    expect(r2.ok && r2.value.model.transitions).toEqual([]);
  });
  it('fades: the first part keeps the fade-in, the second the fade-out; motion stays on the first part without exit; effects and transform on both', () => {
    const b0 = base(); const id = b0.tracks.video[0]!.id;
    const m0 = must(b0, [op('op:clip.setVolume', { volume: 0.8, fadeInMs: 500, fadeOutMs: 700 }, { kind: 'clip', id }), op('op:motion.set', { presetId: 'preset:motion.rise' }, { kind: 'clip', id }),
      op('op:effect.add', { presetId: 'preset:effect.vignette' }, { kind: 'clip', id }), tf('clip', id, { scale: 1.2, x: -0.1 })]);
    const m = must(m0, [split('clip', id, 4000)]);
    const [a, b] = m.tracks.video;
    expect([a!.fadeInMs, a!.fadeOutMs, b!.fadeInMs, b!.fadeOutMs]).toEqual([500, 0, 0, 700]);
    expect(a!.motion).toMatchObject({ presetId: 'preset:motion.rise', exit: false });
    expect(b!.motion).toBeNull();
    expect(b!.effects.map((e) => e.presetId)).toEqual(['preset:effect.vignette']);
    expect([a!.transform, b!.transform]).toEqual([{ x: -0.1, y: 0, scale: 1.2, rotation: 0 }, { x: -0.1, y: 0, scale: 1.2, rotation: 0 }]);
    expect(a!.volume).toBe(0.8); expect(b!.volume).toBe(0.8);
  });
  it('an image clip keeps trimBeforeMs 0 on both parts', () => {
    const m0 = must(createEmptyModel('p', { autoRatio: false }), [op('op:clip.insert', { assetId: 'img' })]);
    const m = must(m0, [split('clip', m0.tracks.video[0]!.id, 2000)]);
    expect(m.tracks.video.map((c) => [c.trimBeforeMs, c.durationMs])).toEqual([[0, 2000], [0, 3000]]);
  });
  it('outside the clip, closer than 100 ms to an edge, or a gone clip → EM-2102 / EM-2203', () => {
    const b0 = base(); const id = b0.tracks.video[1]!.id;                                        // clip 2: 8000–14 000 ms
    expect(blocked(applyOperations(b0, [split('clip', id, 3000)], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.atMs' });
    expect(blocked(applyOperations(b0, [split('clip', id, 8050)], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(b0, [split('clip', id, 13_950)], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(b0, [split('clip', 'gone', 9000)], ctx()))).toMatchObject({ code: 'EM-2203' });
    expect(blocked(applyOperations(b0, [op('op:element.split', { atMs: 9000 }, { kind: 'cut', index: 0 })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target.kind' });
  });
  it('two splits in one plan (cut a section out) and purity', () => {
    const b0 = deepFreeze(base()); const id = b0.tracks.video[0]!.id;
    const m = must(b0, [split('clip', id, 2000), split('clip', id, 1000)]);
    expect(m.tracks.video.slice(0, 3).map((c) => [c.trimBeforeMs, c.durationMs])).toEqual([[0, 1000], [1000, 1000], [2000, 6000]]);
    expect(ids(b0).length).toBe(3);
  });
});

describe('op:element.split on texts, images, shapes and audio', () => {
  it('text: two parts on the same layer, the second right after the first in storage order', () => {
    const m0 = must(base(), [op('op:text.add', { text: 'Judul', variant: 'preset:text.title', atMs: 1000, durationMs: 3000 })]);
    const t = m0.tracks.text[0]!;
    const m = must(m0, [split('text', t.id, 2500)]);
    expect(m.tracks.text.map((x) => [x.text, x.timing.atMs, x.timing.durationMs, x.layer])).toEqual([['Judul', 1000, 1500, 0], ['Judul', 2500, 1500, 0]]);
    expect(m.tracks.text[0]!.motion?.exit).toBe(false);
    expect(m.tracks.text[1]!.motion).toBeNull();
  });
  it('image and shape overlays keep position, size, scale and rotation', () => {
    const m0 = must(base(), [op('op:overlay.addImage', { assetId: 'img', atMs: 0, durationMs: 4000 }), op('op:shape.add', { presetId: 'preset:shape.circle', atMs: 0, durationMs: 2000 })]);
    const img = m0.tracks.overlay[0]!, sh = m0.tracks.overlay[1]!;
    const m1 = must(m0, [tf('image', img.id, { scale: 1.5, rotation: 90 })]);
    const m = must(m1, [split('image', img.id, 1000), split('shape', sh.id, 500)]);
    expect(m.tracks.overlay.map((o) => [o.kind, o.timing.atMs, o.timing.durationMs, o.layer])).toEqual([['image', 0, 1000, 0], ['image', 1000, 3000, 0], ['shape', 0, 500, 1], ['shape', 500, 1500, 1]]);
    expect(m.tracks.overlay[1]).toMatchObject({ scale: 1.5, rotation: 90, size: img.size, position: img.position });
  });
  it('audio: the second part moves the source offset by d; open-ended layers stay open; looping beds wrap the offset', () => {
    const m0 = must(base(), [op('op:audio.addLayer', { assetId: 'vo', atMs: 1000, volume: 1, fadeInMs: 300, fadeOutMs: 400 })]);   // 4 s voice
    const vo = m0.tracks.audio[0]!;
    const m = must(m0, [split('audio', vo.id, 2500)]);
    expect(m.tracks.audio.map((a) => [a.atMs, a.durationMs, a.trimBeforeMs, a.fadeInMs, a.fadeOutMs, a.lane])).toEqual([[1000, 1500, 0, 300, 0, 0], [2500, 2500, 1500, 0, 400, 0]]);
    const bed0 = must(base(), [op('op:audio.addBed', { assetId: 'mus' })]);
    const bed = bed0.tracks.audio[0]!;
    const withTrim = structuredClone(bed0); withTrim.tracks.audio[0]!.trimBeforeMs = 59_000;
    const mb = must(withTrim, [split('audio', bed.id, 5000)]);
    expect(mb.tracks.audio.map((a) => [a.atMs, a.durationMs, a.trimBeforeMs])).toEqual([[0, 5000, 59_000], [5000, undefined, 4000]]);   // (59 000 + 5000) mod 60 000
  });
  it('a split point outside the item → EM-2102', () => {
    const m0 = must(base(), [op('op:text.add', { text: 'A', variant: 'preset:text.title', atMs: 1000, durationMs: 1000 })]);
    expect(blocked(applyOperations(m0, [split('text', m0.tracks.text[0]!.id, 2000)], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(m0, [split('image', 'nope', 1500)], ctx()))).toMatchObject({ code: 'EM-2203' });
  });
});

describe('op:element.setTransform', () => {
  it('clip: absolute values, omitted fields kept, rotation normalised to [0, 360)', () => {
    const b0 = base(); const id = b0.tracks.video[0]!.id;
    const m = must(b0, [tf('clip', id, { scale: 1.2, x: -0.25 }), tf('clip', id, { rotation: -90 })]);
    expect(m.tracks.video[0]!.transform).toEqual({ x: -0.25, y: 0, scale: 1.2, rotation: 270 });
    expect(normaliseRotation(450)).toBe(90); expect(normaliseRotation(-0.001)).toBe(0);
  });
  it('reset to identity removes the field, so the hash is the same as before any transform', () => {
    const b0 = base(); const id = b0.tracks.video[0]!.id;
    const moved = must(b0, [tf('clip', id, { x: 0.3, y: 0.1, scale: 2, rotation: 45 })]);
    expect(hashModel(moved)).not.toBe(hashModel(b0));
    const back = must(moved, [tf('clip', id, { x: 0, y: 0, scale: 1, rotation: 0 })]);
    expect('transform' in back.tracks.video[0]!).toBe(false);
    expect(hashModel(back)).toBe(hashModel(b0));
  });
  it('validation: empty args, a clip scale outside 10 %–1000 %, args out of range, wrong target kind → EM-2102; gone → EM-2203', () => {
    const b0 = base(); const id = b0.tracks.video[0]!.id;
    expect(blocked(applyOperations(b0, [tf('clip', id, {})], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args' });
    expect(blocked(applyOperations(b0, [tf('clip', id, { scale: 0.05 })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.scale' });
    expect(blocked(applyOperations(b0, [tf('clip', id, { x: 3 })], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(b0, [tf('text', 't', { x: 0.1 })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target.kind' });
    expect(blocked(applyOperations(b0, [tf('clip', 'gone', { x: 0.1 })], ctx()))).toMatchObject({ code: 'EM-2203' });
    expect(blocked(applyOperations(b0, [tf('image', 'gone', { x: 0.1 })], ctx()))).toMatchObject({ code: 'EM-2203' });
  });
  it('image / shape: x / y fractions of the frame go to position (u); scale and rotation are stored, removed again at 1 / 0', () => {
    const m0 = must(base(), [op('op:overlay.addImage', { assetId: 'img', atMs: 0, durationMs: 3000 })]);   // 9:16 frame = 1080 × 1920 u
    const o = m0.tracks.overlay[0]!;
    const m = must(m0, [tf('image', o.id, { x: 0.25, y: -0.5, scale: 0.5, rotation: 30 })]);
    expect(m.tracks.overlay[0]).toMatchObject({ position: { x: 270, y: -960 }, scale: 0.5, rotation: 30, size: o.size });
    const r = must(m, [tf('image', o.id, { x: 0, y: 0, scale: 1, rotation: 0 })]);
    expect('scale' in r.tracks.overlay[0]! || 'rotation' in r.tracks.overlay[0]!).toBe(false);
    expect(hashModel(r)).toBe(hashModel(m0));
  });
  it('diff lists the changed field; the agent summary carries the transform and overlay x / y', () => {
    const b0 = must(base(), [op('op:overlay.addImage', { assetId: 'img', atMs: 0, durationMs: 3000, position: { x: -270, y: 480 } })]);
    const id = b0.tracks.video[0]!.id;
    const r = applyOperations(b0, [tf('clip', id, { scale: 1.2 })], ctx());
    expect(r.ok && r.value.diff).toEqual([{ elementId: id, change: 'modified', fields: ['transform'] }]);
    const s = summarizeForAgent(r.ok ? r.value.model : b0, ASSETS);
    expect(s.video[0]!.transform).toEqual({ x: 0, y: 0, scale: 1.2, rotation: 0 });
    expect(s.video[1]!.transform).toBeUndefined();
    expect(s.overlay[0]).toMatchObject({ x: -0.25, y: 0.25 });
  });
});

describe('locking keys (AI_WORKFLOW §6)', () => {
  it('split: a clip locks its trim and the sequence order (cut keys conflict); others lock their timing', () => {
    expect(propertyKeysOf(split('clip', 'c1', 1000))).toEqual(['clip:c1.trim', 'sequence.order']);
    expect(propertyKeysOf(split('audio', 'a1', 1000))).toEqual(['audio:a1.timing']);
    expect(propertyKeysOf(split('text', 't1', 1000))).toEqual(['text:t1.timing']);
    expect(conflictsWithLocked(propertyKeysOf(split('clip', 'c1', 1000)), ['cut:1.transition'])).toEqual(['cut:1.transition']);
    expect(conflictsWithLocked(propertyKeysOf(split('text', 't1', 1000)), ['text:t1.timing'])).toEqual(['text:t1.timing']);
  });
  it('transform: <kind>:<id>.transform; a remove of the element conflicts with it', () => {
    expect(propertyKeysOf(tf('clip', 'c1', { x: 0.1 }))).toEqual(['clip:c1.transform']);
    expect(propertyKeysOf(tf('image', 'o1', { scale: 2 }))).toEqual(['image:o1.transform']);
    expect(conflictsWithLocked(['clip:c1'], ['clip:c1.transform'])).toEqual(['clip:c1.transform']);
  });
});

describe('ADR-028 schema policy: optional fields, no schemaVersion bump', () => {
  it('a stored v2 model without transform loads unchanged (same hash) and keeps a stored transform', () => {
    const b0 = base();
    const json = JSON.parse(JSON.stringify(b0)) as Record<string, unknown>;
    const r = migrateModel(json);
    expect(r.ok && hashModel(r.value)).toBe(hashModel(b0));
    expect(r.ok && 'transform' in r.value.tracks.video[0]!).toBe(false);
    const withT = must(b0, [tf('clip', b0.tracks.video[0]!.id, { scale: 1.5 })]);
    const back = migrateModel(JSON.parse(JSON.stringify(withT)));
    expect(back.ok && back.value.tracks.video[0]!.transform).toEqual({ x: 0, y: 0, scale: 1.5, rotation: 0 });
    expect(withT.schemaVersion).toBe(2);
  });
  it('the Zod schema rejects transforms outside their ranges in hand-made JSON', () => {
    const b0 = base();
    const bad = JSON.parse(JSON.stringify(b0)) as CompositionModelT;
    bad.tracks.video[0]!.transform = { x: 0, y: 0, scale: 50, rotation: 0 };
    expect(CompositionModel.safeParse(bad).success).toBe(false);
  });
});
