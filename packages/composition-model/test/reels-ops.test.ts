// ADR-039 (Reels pipeline, section B): the OverlayVideo kind (op:overlay.addVideo / setShape), Clip.zoom (op:clip.setZoom),
// AudioLayer.gain (op:audio.setVolume / setGain), their Locked Keys, validation, split / timing / Duplicate / Paste of a video
// overlay, and schema round-trips without a version bump.
import { describe, expect, it } from 'vitest';
import { applyOperations, CompositionModel, copySnapshot, createEmptyModel, duplicationSteps, hashModel, lockedKeysOf, pasteSteps, propertyKeysOf, summarizeForAgent, validate, type CompositionModelT, type OverlayVideoT } from '../src/index.js';
import { ASSETS, ctx, must, op } from './helpers.js';

const blocked = (r: ReturnType<typeof applyOperations>) => (r.ok ? null : r.issues[0]!);
const video = (m: CompositionModelT): OverlayVideoT => m.tracks.overlay.find((o): o is OverlayVideoT => o.kind === 'video')!;
/** A 9:16 scene with a circular face bubble of the talking-head asset v1 (260 u, yellow 6 u ring, centre 540 / 1770 → y = +810 u). */
const bubbleScene = () => must(createEmptyModel('p', { autoRatio: false }), [
  op('op:scene.add', { durationMs: 6000, background: 'preset:background.solid' }, { kind: 'sequence' }),
  op('op:overlay.addVideo', { assetId: 'v1', atMs: 0, durationMs: 6000, trimBeforeMs: 2000, size: 260, shape: 'circle', ring: { colour: '#FFD43B', widthU: 6 }, focus: { x: 0.5, y: 0.32, zoom: 0.62 }, position: { x: 0, y: 810 } }),
]);

describe('op:overlay.addVideo', () => {
  it('adds a muted circular video overlay with ring and focus; a circle is square; defaults follow the design', () => {
    const m = bubbleScene(); const v = video(m);
    expect(v).toMatchObject({ kind: 'video', assetId: 'v1', trimBeforeMs: 2000, muted: true, shape: 'circle', size: { w: 260, h: 260 }, ring: { colour: '#FFD43B', widthU: 6 }, focus: { x: 0.5, y: 0.32, zoom: 0.62 }, position: { x: 0, y: 810 }, timing: { atMs: 0, durationMs: 6000 } });
    expect(v.radius).toBeUndefined();
    expect(v.motion?.presetId).toBe('preset:motion.scale-in');                        // default entrance like an image
    expect(validate(m, { assets: ASSETS, tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
    expect(CompositionModel.parse(JSON.parse(JSON.stringify(m)))).toEqual(m);          // round-trip, schema v2
    expect(m.schemaVersion).toBe(2);
  });
  it('rect: height from the source aspect, radius kept; duration defaults to the rest of the source; unmuted and static on request', () => {
    const m = must(createEmptyModel('p', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v2' }), op('op:overlay.addVideo', { assetId: 'v1', atMs: 500, trimBeforeMs: 4000, size: 480, radius: 32, muted: false, motion: { presetId: 'preset:motion.none' } })]);
    const v = video(m);
    expect(v).toMatchObject({ shape: 'rect', radius: 32, size: { w: 480, h: 270 }, muted: false, timing: { atMs: 500, durationMs: 6000 }, motion: null });
  });
  it('refuses a non-video asset, a trim beyond the source and more than the source holds', () => {
    const base = createEmptyModel('p', { autoRatio: false });
    expect(blocked(applyOperations(base, [op('op:overlay.addVideo', { assetId: 'img', atMs: 0 })], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(base, [op('op:overlay.addVideo', { assetId: 'v1', atMs: 0, trimBeforeMs: 10_000 })], ctx()))).toMatchObject({ code: 'EM-2306', path: 'ops[0].args.trimBeforeMs' });
    expect(blocked(applyOperations(base, [op('op:overlay.addVideo', { assetId: 'v1', atMs: 0, trimBeforeMs: 8000, durationMs: 3000 })], ctx()))).toMatchObject({ code: 'EM-2306' });
    expect(blocked(applyOperations(base, [op('op:overlay.addVideo', { assetId: 'v1', atMs: 0, focus: { x: 1.5, y: 0, zoom: 1 } })], ctx()))).toMatchObject({ code: 'EM-2102' });
  });
  it('validate reports a missing / wrong-kind asset and too little source for a stored video overlay', () => {
    const m = bubbleScene();
    const broken = structuredClone(m); video(broken).trimBeforeMs = 9000;
    expect(validate(broken, { assets: ASSETS, tier: 'T1' }).map((i) => i.code)).toContain('CM-002');
    const gone = structuredClone(m); video(gone).assetId = 'img';
    expect(validate(gone, { assets: ASSETS, tier: 'T1' }).filter((i) => i.code === 'CM-001').length).toBe(1);
  });
});

describe('op:overlay.setShape and the element ops on a video overlay', () => {
  it('changes mask, radius, ring and focus; null removes; circle drops the radius; key video:<id>.shape', () => {
    const m = bubbleScene(); const id = video(m).id;
    const r1 = must(m, [op('op:overlay.setShape', { shape: 'rect', radius: 40, ring: null }, { kind: 'video', id })]);
    expect(video(r1)).toMatchObject({ shape: 'rect', radius: 40, focus: { x: 0.5, y: 0.32, zoom: 0.62 } });
    expect(video(r1).ring).toBeUndefined();
    const r2 = must(r1, [op('op:overlay.setShape', { shape: 'circle', focus: null, ring: { colour: '#4DD4C4', widthU: 4 } }, { kind: 'video', id })]);
    expect(video(r2)).toMatchObject({ shape: 'circle', ring: { colour: '#4DD4C4', widthU: 4 } });
    expect(video(r2).radius).toBeUndefined(); expect(video(r2).focus).toBeUndefined();
    expect(propertyKeysOf(op('op:overlay.setShape', { shape: 'rect' }, { kind: 'video', id }))).toEqual([`video:${id}.shape`]);
    expect(blocked(applyOperations(m, [op('op:overlay.setShape', {}, { kind: 'video', id })], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(m, [op('op:overlay.setShape', { shape: 'rect' }, { kind: 'image', id })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target.kind' });
  });
  it('opacity, timing (+ trim within the source), layer, transform, split (second part continues the source) and remove', () => {
    const m = bubbleScene(); const id = video(m).id; const t = { kind: 'video' as const, id };
    const r = must(m, [
      op('op:overlay.setOpacity', { opacity: 0.8 }, t),
      op('op:element.setTiming', { atMs: 1000, durationMs: 4000, trimBeforeMs: 3000 }, t),
      op('op:element.setTransform', { x: 0.1, scale: 1.2 }, t),
    ]);
    expect(video(r)).toMatchObject({ opacity: 0.8, timing: { atMs: 1000, durationMs: 4000 }, trimBeforeMs: 3000, position: { x: 108, y: 810 }, scale: 1.2 });
    expect(blocked(applyOperations(r, [op('op:element.setTiming', { atMs: 0, durationMs: 8000, trimBeforeMs: 3000 }, t)], ctx()))).toMatchObject({ code: 'EM-2306' });
    const split = must(r, [op('op:element.split', { atMs: 2500 }, t)]);
    const parts = split.tracks.overlay.filter((o) => o.kind === 'video') as OverlayVideoT[];
    expect(parts.map((p) => [p.timing.atMs, p.timing.durationMs, p.trimBeforeMs])).toEqual([[1000, 1500, 3000], [2500, 2500, 4500]]);
    const removed = must(split, [op('op:overlay.remove', {}, { kind: 'video', id: parts[1]!.id })]);
    expect(removed.tracks.overlay.filter((o) => o.kind === 'video')).toHaveLength(1);
    expect(blocked(applyOperations(split, [op('op:overlay.remove', {}, { kind: 'image', id })], ctx()))).toMatchObject({ code: 'EM-2203' });
    expect(summarizeForAgent(removed, ASSETS).overlay[0]).toMatchObject({ kind: 'video', asset: 'unboxing.mp4' });
  });
  it('Duplicate and Copy / Paste rebuild a video overlay with every field (op:overlay.addVideo)', () => {
    const m = bubbleScene(); const v = video(m);
    const steps = duplicationSteps(m, [{ kind: 'video', id: v.id }]);
    expect(steps.map((s) => s.op.op)).toEqual(['op:overlay.addVideo']);
    const d = must(m, steps.map((s) => s.op));
    const copy = (d.tracks.overlay.filter((o) => o.kind === 'video') as OverlayVideoT[]).find((o) => o.id !== v.id)!;
    const { id: _a, timing: _b, layer: _c, ...orig } = v; const { id: _d, timing: _e, layer: _f, ...dup } = copy;
    expect(dup).toEqual(orig);
    expect(copy.timing.atMs).toBe(6000);
    const snap = copySnapshot(m, [{ kind: 'video', id: v.id }]);
    expect(snap.entries.map((e) => [e.kind, e.op.op])).toEqual([['video', 'op:overlay.addVideo']]);
    const pasted = must(m, pasteSteps(m, snap.entries, 1000).map((s) => s.op));
    expect(pasted.tracks.overlay.filter((o) => o.kind === 'video')).toHaveLength(2);
  });
});

describe('op:clip.setZoom (Clip.zoom)', () => {
  it('stores from / to and sorted pops, carries through insert, is a scalar key, and the identity removes the field', () => {
    const m = must(createEmptyModel('p', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v1', durationMs: 5000 })]);
    const id = m.tracks.video[0]!.id;
    const r = must(m, [op('op:clip.setZoom', { from: 1.12, to: 1.2, pops: [{ atMs: 3000, amount: 0.1 }, { atMs: 800, amount: 0.1, durationMs: 300 }] }, { kind: 'clip', id })]);
    expect(r.tracks.video[0]!.zoom).toEqual({ from: 1.12, to: 1.2, pops: [{ atMs: 800, amount: 0.1, durationMs: 300 }, { atMs: 3000, amount: 0.1 }] });
    expect(propertyKeysOf(op('op:clip.setZoom', { from: 1, to: 1.1 }, { kind: 'clip', id }))).toEqual([`clip:${id}.zoom`]);
    const reset = must(r, [op('op:clip.setZoom', { from: 1, to: 1 }, { kind: 'clip', id })]);
    expect(reset.tracks.video[0]!.zoom).toBeUndefined();
    expect(hashModel(reset)).toBe(hashModel(m));                                        // a reset restores the earlier hash
    const late = applyOperations(m, [op('op:clip.setZoom', { from: 1, to: 1.05, pops: [{ atMs: 9000, amount: 0.2 }] }, { kind: 'clip', id })], ctx());
    expect(late.ok && late.warnings.map((w) => w.code)).toEqual(['EM-2102']);
    const ins = must(createEmptyModel('p', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v1', durationMs: 3000, zoom: { from: 1.28, to: 1.36 } })]);
    expect(ins.tracks.video[0]!.zoom).toEqual({ from: 1.28, to: 1.36 });
    expect(blocked(applyOperations(m, [op('op:clip.setZoom', { from: 0, to: 1 }, { kind: 'clip', id })], ctx()))).toMatchObject({ code: 'EM-2102' });
  });
  it('Duplicate of a zoomed clip keeps the zoom', () => {
    const m = must(createEmptyModel('p', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v1', durationMs: 3000, zoom: { from: 1.1, to: 1.2, pops: [{ atMs: 500, amount: 0.1 }] } })]);
    const d = must(m, duplicationSteps(m, [{ kind: 'clip', id: m.tracks.video[0]!.id }]).map((s) => s.op));
    expect(d.tracks.video[1]!.zoom).toEqual(m.tracks.video[0]!.zoom);
  });
});

describe('op:audio.setVolume / op:audio.setGain (AudioLayer.gain)', () => {
  const withBed = () => must(createEmptyModel('p', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v1', durationMs: 8000 }), op('op:audio.addBed', { assetId: 'mus', volume: 0.3 })]);
  it('sets the level and sorted gain segments (composition time); empty removes; keys audio:<id>.volume / .gain', () => {
    const m = withBed(); const id = m.tracks.audio[0]!.id; const t = { kind: 'audio' as const, id };
    const r = must(m, [op('op:audio.setVolume', { volume: 0.5 }, t), op('op:audio.setGain', { segments: [{ atMs: 5000, durationMs: 2000, mul: 1.5 }, { atMs: 1000, durationMs: 500, mul: 0.6, rampMs: 100 }] }, t)]);
    expect(r.tracks.audio[0]).toMatchObject({ volume: 0.5, gain: [{ atMs: 1000, durationMs: 500, mul: 0.6, rampMs: 100 }, { atMs: 5000, durationMs: 2000, mul: 1.5 }] });
    expect(lockedKeysOf([op('op:audio.setVolume', { volume: 1 }, t), op('op:audio.setGain', { segments: [] }, t)])).toEqual([`audio:${id}.volume`, `audio:${id}.gain`]);
    const cleared = must(r, [op('op:audio.setGain', { segments: [] }, t)]);
    expect(cleared.tracks.audio[0]!.gain).toBeUndefined();
    expect(blocked(applyOperations(m, [op('op:audio.setGain', { segments: [{ atMs: 0, durationMs: 100, mul: 5 }] }, t)], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(m, [op('op:audio.setVolume', { volume: 0.5 }, { kind: 'clip', id })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target.kind' });
  });
  it('op:audio.addLayer carries gain, so Duplicate keeps it', () => {
    const m = must(createEmptyModel('p', { autoRatio: false }), [op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 0.9, role: 'sfx', gain: [{ atMs: 0, durationMs: 1000, mul: 1.2 }] })]);
    expect(m.tracks.audio[0]!.gain).toEqual([{ atMs: 0, durationMs: 1000, mul: 1.2 }]);
    const d = must(m, duplicationSteps(m, [{ kind: 'audio', id: m.tracks.audio[0]!.id }]).map((s) => s.op));
    expect(d.tracks.audio[1]!.gain).toEqual(m.tracks.audio[0]!.gain);
  });
});
