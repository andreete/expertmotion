// ADR-027: layers (texts, images, shapes) and audio lanes — migration v1 → v2, the lane rule in applyOps,
// op:element.setTiming / op:element.setLayer, locking keys, render order and CM-012.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyOperations, CompositionModel, conflictsWithLocked, migrateModel, propertyKeysOf, summarizeForAgent, topmostAt, validate, visualStack, type CompositionModelT } from '../src/index.js';
import { ASSETS, base, ctx, deepFreeze, must, op } from './helpers.js';

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const blocked = (r: ReturnType<typeof applyOperations>) => (r.ok ? null : r.issues[0]!);
/** id → layer for every text, image and shape. */
const layers = (m: CompositionModelT) => Object.fromEntries([...m.tracks.overlay, ...m.tracks.text].map((x) => [x.id, x.layer]));
const lanes = (m: CompositionModelT) => Object.fromEntries(m.tracks.audio.map((a) => [a.id, a.lane]));
const stackIds = (m: CompositionModelT) => visualStack(m).map((x) => x.id);
const textAt = (atMs: number, durationMs: number, text = 'Teks', layer?: number) => op('op:text.add', { text, variant: 'preset:text.title', atMs, durationMs, ...(layer === undefined ? {} : { layer }) });
const imageAt = (atMs: number, durationMs: number) => op('op:overlay.addImage', { assetId: 'img', atMs, durationMs });
const shapeAt = (atMs: number, durationMs: number) => op('op:shape.add', { presetId: 'preset:shape.circle', atMs, durationMs });
const tgt = (m: CompositionModelT, i: number, kind: 'text' | 'image' | 'shape' = 'text') => ({ kind, id: (kind === 'text' ? m.tracks.text : m.tracks.overlay.filter((o) => o.kind === kind))[i]!.id });

describe('schema v1 → v2 migration (golden fixture, DATABASE_SCHEMA §5)', () => {
  it('assigns layers and audio lanes exactly as the expected JSON', () => {
    const r = migrateModel(fixture('model-v1.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(CompositionModel.parse(fixture('model-v2.expected.json')));
    expect(r.value.schemaVersion).toBe(2);
  });
  it('keeps the v1 picture: every overlapping pair renders in the v1 order (overlays under texts, array order within)', () => {
    const v1 = fixture('model-v1.json') as unknown as CompositionModelT;
    const before = [...v1.tracks.overlay, ...v1.tracks.text].map((x) => x.id);
    const r = migrateModel(v1);
    if (!r.ok) throw new Error('migration');
    const after = stackIds(r.value);
    const span = (id: string) => { const x = [...r.value.tracks.overlay, ...r.value.tracks.text].find((y) => y.id === id)!; return [x.timing.atMs, x.timing.atMs + x.timing.durationMs] as const; };
    for (const a of before) for (const b of before) {
      if (before.indexOf(a) >= before.indexOf(b)) continue;
      const [a0, a1] = span(a), [b0, b1] = span(b);
      if (a0 < b1 && b0 < a1) expect(after.indexOf(a), `${a} under ${b}`).toBeLessThan(after.indexOf(b));
    }
    expect(validate(r.value, { assets: ASSETS, tier: 'T1' }).filter((i) => i.code === 'CM-012')).toEqual([]);
  });
  it('a v1 looping layer loses its durationMs (v1 looped to the end regardless); the migrated model is not re-migrated', () => {
    const r = migrateModel(fixture('model-v1.json'));
    if (!r.ok) throw new Error('migration');
    expect(r.value.tracks.audio[0]).not.toHaveProperty('durationMs');
    expect(migrateModel(JSON.parse(JSON.stringify(r.value)))).toEqual(r);
  });
});

describe('lane rule on add (ADR-027)', () => {
  it('a new item goes just in front of everything it overlaps; one that overlaps nothing goes on layer 0', () => {
    const m = must(base(), [imageAt(0, 5000), textAt(1000, 2000), shapeAt(1500, 1000), textAt(8000, 1000)]);
    expect(layers(m)).toEqual({ [tgt(m, 0, 'image').id]: 0, [tgt(m, 0).id]: 1, [tgt(m, 0, 'shape').id]: 2, [tgt(m, 1).id]: 0 });
    expect(stackIds(m)).toEqual([tgt(m, 0, 'image').id, tgt(m, 1).id, tgt(m, 0).id, tgt(m, 0, 'shape').id]);
  });
  it('an explicit layer is honoured when free there, else the item goes to the lane above (inserting one when needed)', () => {
    const m0 = must(base(), [imageAt(0, 5000), textAt(0, 5000)]);                    // image 0, text 1
    const free = must(m0, [textAt(6000, 1000, 'b', 1)]);
    expect(free.tracks.text[1]!.layer).toBe(1);
    const busy = must(m0, [textAt(1000, 1000, 'c', 0)]);                             // 0 busy (image), 1 busy (text) → new lane 1, old text → 2
    expect(layers(busy)).toEqual({ [tgt(busy, 0, 'image').id]: 0, [tgt(busy, 1).id]: 1, [tgt(busy, 0).id]: 2 });
  });
  it('generated thumbnails and image inserts follow the same rule', () => {
    const m = must(base(), [textAt(0, 3000)]);
    const j = { th: { kind: 'thumbnail' as const, assetId: 'img' } };
    const r = applyOperations(m, [op('op:generated.insert', { kind: 'thumbnail', jobId: 'th', atMs: 1000 }, { kind: 'project' })], ctx({ jobs: j }));
    expect(r.ok && r.value.model.tracks.overlay[0]!.layer).toBe(1);
  });
  it('audio layers take the first free lane; a looping bed occupies its lane to the end', () => {
    const m = must(base(), [op('op:audio.addBed', { assetId: 'mus' }, { kind: 'project' }), op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1 }), op('op:audio.addLayer', { assetId: 'vo', atMs: 5000, volume: 1 }), op('op:audio.addLayer', { assetId: 'vo', atMs: 1000, volume: 1 })]);
    expect(m.tracks.audio.map((a) => a.lane)).toEqual([0, 1, 1, 2]);
  });
});

describe('op:element.setTiming', () => {
  it('moves and trims a text, image or shape; it stays on its lane when free', () => {
    const m0 = must(base(), [imageAt(0, 2000), textAt(0, 2000)]);
    const m = must(m0, [op('op:element.setTiming', { atMs: 3000, durationMs: 4000 }, tgt(m0, 0, 'image')), op('op:element.setTiming', { atMs: 500, durationMs: 1000 }, tgt(m0, 0))]);
    expect(m.tracks.overlay[0]!.timing).toEqual({ atMs: 3000, durationMs: 4000 });
    expect(m.tracks.text[0]!.timing).toEqual({ atMs: 500, durationMs: 1000 });
    expect(layers(m)).toEqual(layers(m0));                                           // image 0, text 1: both still free
  });
  it('a move onto a busy lane goes to the lane above; when that is busy too a new lane is inserted there', () => {
    const m0 = must(base(), [textAt(0, 2000, 'a'), textAt(3000, 2000, 'b')]);       // both on lane 0
    const up = must(m0, [op('op:element.setTiming', { atMs: 1000, durationMs: 2000 }, tgt(m0, 1))]);
    expect(layers(up)).toEqual({ [tgt(m0, 0).id]: 0, [tgt(m0, 1).id]: 1 });
    const m1 = must(base(), [textAt(0, 2000, 'a'), textAt(0, 2000, 'top'), textAt(5000, 1000, 'c')]);   // a 0, top 1, c 0
    const ins = must(m1, [op('op:element.setTiming', { atMs: 500, durationMs: 1000 }, tgt(m1, 2))]);
    expect(layers(ins)).toEqual({ [tgt(m1, 0).id]: 0, [tgt(m1, 2).id]: 1, [tgt(m1, 1).id]: 2 });       // c inserted between a and top
  });
  it('`layer` moves across lanes in the same op (one drag gesture); a lane that empties disappears', () => {
    const m0 = must(base(), [imageAt(0, 3000), textAt(0, 3000), textAt(4000, 1000)]);   // image 0, t0 1, t1 0
    const m = must(m0, [op('op:element.setTiming', { atMs: 4000, durationMs: 1000, layer: 0 }, tgt(m0, 0))]);
    expect(layers(m)).toEqual({ [tgt(m0, 0, 'image').id]: 0, [tgt(m0, 0).id]: 1, [tgt(m0, 1).id]: 0 });   // 0 busy at 4–5 s → lane above
    const top = must(m0, [op('op:element.setTiming', { atMs: 0, durationMs: 3000, layer: 9 }, tgt(m0, 1))]);
    expect(top.tracks.text[1]!.layer).toBe(2);                                         // clamped to a new top lane
  });
  it('audio: move, right-edge and left-edge trim (trimBeforeMs) inside the source; EM-2306 past it; lane rule', () => {
    const m0 = must(base(), [op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1, fadeInMs: 1500 }), op('op:audio.addLayer', { assetId: 'vo', atMs: 6000, volume: 1 })]);
    const id = m0.tracks.audio[0]!.id;
    const m = must(m0, [op('op:element.setTiming', { atMs: 1000, durationMs: 2000, trimBeforeMs: 1000 }, { kind: 'audio', id })]);
    expect(m.tracks.audio[0]).toMatchObject({ atMs: 1000, durationMs: 2000, trimBeforeMs: 1000, fadeInMs: 1000, lane: 0 });
    expect(blocked(applyOperations(m0, [op('op:element.setTiming', { atMs: 0, durationMs: 3500, trimBeforeMs: 1000 }, { kind: 'audio', id })], ctx()))).toMatchObject({ code: 'EM-2306' });
    const over = must(m0, [op('op:element.setTiming', { atMs: 5000, durationMs: 2000 }, { kind: 'audio', id })]);
    expect(lanes(over)).toEqual({ [id]: 1, [m0.tracks.audio[1]!.id]: 0 });
  });
  it('rejects trimBeforeMs on visual items, clips as targets and gone elements', () => {
    const m = must(base(), [textAt(0, 1000)]);
    expect(blocked(applyOperations(m, [op('op:element.setTiming', { atMs: 0, durationMs: 1000, trimBeforeMs: 10 }, tgt(m, 0))], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.trimBeforeMs' });
    expect(blocked(applyOperations(m, [op('op:element.setTiming', { atMs: 0, durationMs: 1000 }, { kind: 'clip', id: m.tracks.video[0]!.id })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target.kind' });
    expect(blocked(applyOperations(m, [op('op:element.setTiming', { atMs: 0, durationMs: 1000 }, { kind: 'shape', id: m.tracks.text[0]!.id })], ctx()))).toMatchObject({ code: 'EM-2203' });
    expect(blocked(applyOperations(m, [op('op:element.setTiming', { atMs: 0, durationMs: 50 }, tgt(m, 0))], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.durationMs' });
    expect(blocked(applyOperations(m, [op('op:element.setTiming', { atMs: 0, durationMs: 1000 })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target' });
  });
  it('op:text.setTiming keeps working and follows the lane rule', () => {
    const m0 = must(base(), [textAt(0, 1000, 'a'), textAt(2000, 1000, 'b')]);
    const m = must(m0, [op('op:text.setTiming', { atMs: 500, durationMs: 1000 }, tgt(m0, 1))]);
    expect(m.tracks.text[1]).toMatchObject({ timing: { atMs: 500, durationMs: 1000 }, layer: 1 });
  });
  it('locking keys: timing (+ layer with a lane change); conflicts with a locked timing key', () => {
    expect(propertyKeysOf(op('op:element.setTiming', { atMs: 0, durationMs: 1000 }, { kind: 'image', id: 'i1' }))).toEqual(['image:i1.timing']);
    expect(propertyKeysOf(op('op:element.setTiming', { atMs: 0, durationMs: 1000, layer: 2 }, { kind: 'text', id: 't1' }))).toEqual(['text:t1.timing', 'text:t1.layer']);
    expect(propertyKeysOf(op('op:text.setTiming', { atMs: 0, durationMs: 1000 }, { kind: 'text', id: 't1' }))).toEqual(['text:t1.timing']);
    expect(conflictsWithLocked(['text:t1.timing'], ['text:t1.timing'])).toEqual(['text:t1.timing']);
  });
});

describe('op:element.setLayer', () => {
  /** image (0–5 s, layer 0) under title (0–3 s, layer 1), shape 1–2 s on top (2). */
  const stack = () => must(base(), [imageAt(0, 5000), textAt(0, 3000, 'Judul'), shapeAt(1000, 1000)]);
  it('front / back put an item in front of / behind everything it overlaps ("put the title above the image")', () => {
    const m0 = must(base(), [textAt(0, 3000, 'Judul'), imageAt(0, 5000)]);         // the image went in front of the title
    expect(stackIds(m0)).toEqual([tgt(m0, 0).id, tgt(m0, 0, 'image').id]);
    const m = must(m0, [op('op:element.setLayer', { move: 'front' }, tgt(m0, 0))]);
    expect(stackIds(m)).toEqual([tgt(m0, 0, 'image').id, tgt(m0, 0).id]);
    const s = stack();
    const back = must(s, [op('op:element.setLayer', { move: 'back' }, tgt(s, 0, 'shape'))]);
    expect(stackIds(back)[0]).toBe(tgt(s, 0, 'shape').id);
    expect(layers(back)).toEqual({ [tgt(s, 0, 'shape').id]: 0, [tgt(s, 0, 'image').id]: 1, [tgt(s, 0).id]: 2 });
  });
  it('up / down move one lane and pass the item that is there at this time; no-ops at the ends', () => {
    const s = stack();
    const down = must(s, [op('op:element.setLayer', { move: 'down' }, tgt(s, 0))]);    // title passes below the image
    expect(stackIds(down)).toEqual([tgt(s, 0).id, tgt(s, 0, 'image').id, tgt(s, 0, 'shape').id]);
    const up = must(down, [op('op:element.setLayer', { move: 'up' }, tgt(s, 0))]);
    expect(layers(up)).toEqual(layers(s));
    expect(layers(must(s, [op('op:element.setLayer', { move: 'down' }, tgt(s, 0, 'image'))]))).toEqual(layers(s));   // bottom lane
    expect(layers(must(s, [op('op:element.setLayer', { move: 'front' }, tgt(s, 0, 'shape'))]))).toEqual(layers(s)); // already front
    const lone = must(base(), [textAt(0, 1000, 'a'), textAt(5000, 1000, 'b')]);         // both on lane 0
    const split = must(lone, [op('op:element.setLayer', { move: 'up' }, tgt(lone, 1))]);
    expect(layers(split)).toEqual({ [tgt(lone, 0).id]: 0, [tgt(lone, 1).id]: 1 });      // a new top lane, nothing overlaps
  });
  it('an absolute layer uses the lane rule; empty lanes are removed afterwards', () => {
    const s = stack();
    const m = must(s, [op('op:element.setLayer', { layer: 0 }, tgt(s, 0, 'shape'))]);   // 0 busy (image), 1 busy (title) → new lane 1
    expect(layers(m)).toEqual({ [tgt(s, 0, 'image').id]: 0, [tgt(s, 0, 'shape').id]: 1, [tgt(s, 0).id]: 2 });
    const gone = must(s, [op('op:text.remove', {}, tgt(s, 0))]);
    expect(layers(gone)).toEqual({ [tgt(s, 0, 'image').id]: 0, [tgt(s, 0, 'shape').id]: 1 });
  });
  it('audio lanes: a lane number or up/down; front/back → EM-2102', () => {
    const m0 = must(base(), [op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1 }), op('op:audio.addLayer', { assetId: 'vo', atMs: 6000, volume: 1 })]);
    const a = m0.tracks.audio[1]!.id;
    const down = must(m0, [op('op:element.setLayer', { move: 'down' }, { kind: 'audio', id: a })]);
    expect(lanes(down)[a]).toBe(1);
    expect(lanes(must(down, [op('op:element.setLayer', { move: 'up' }, { kind: 'audio', id: a })]))[a]).toBe(0);
    expect(lanes(must(m0, [op('op:element.setLayer', { layer: 3 }, { kind: 'audio', id: a })]))[a]).toBe(1);
    expect(blocked(applyOperations(m0, [op('op:element.setLayer', { move: 'front' }, { kind: 'audio', id: a })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.move' });
  });
  it('needs exactly one of layer / move; unknown move, gone element, wrong kind are refused', () => {
    const s = stack();
    expect(blocked(applyOperations(s, [op('op:element.setLayer', {}, tgt(s, 0))], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args' });
    expect(blocked(applyOperations(s, [op('op:element.setLayer', { layer: 1, move: 'up' }, tgt(s, 0))], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(s, [op('op:element.setLayer', { move: 'top' }, tgt(s, 0))], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.move' });
    expect(blocked(applyOperations(s, [op('op:element.setLayer', { move: 'up' }, { kind: 'text', id: 'nope' })], ctx()))).toMatchObject({ code: 'EM-2203' });
    expect(blocked(applyOperations(s, [op('op:element.setLayer', { move: 'up' }, { kind: 'cut', index: 0 })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target.kind' });
    expect(propertyKeysOf(op('op:element.setLayer', { move: 'front' }, { kind: 'shape', id: 's1' }))).toEqual(['shape:s1.layer']);
  });
  it('is pure', () => {
    const s = deepFreeze(stack());
    expect(applyOperations(s, [op('op:element.setLayer', { move: 'back' }, tgt(s, 0))], ctx()).ok).toBe(true);
  });
});

describe('render order, picking, CM-012 and the agent summary', () => {
  it('topmostAt picks the front-most item playing at a time (optionally of some kinds)', () => {
    const m = must(base(), [imageAt(0, 5000), textAt(0, 3000, 'Judul'), textAt(0, 3000, 'Atas')]);
    expect(topmostAt(m, 1000)?.id).toBe(m.tracks.text[1]!.id);
    expect(topmostAt(m, 4000)?.id).toBe(m.tracks.overlay[0]!.id);
    expect(topmostAt(m, 4000, ['text'])).toBeUndefined();
    expect(topmostAt(m, 9000)).toBeUndefined();
  });
  it('CM-012 warns about items that overlap on one lane (hand-made JSON)', () => {
    const m = must(base(), [textAt(0, 2000, 'a'), textAt(5000, 1000, 'b')]);
    m.tracks.text[1]!.timing.atMs = 1000;
    expect(validate(m, { assets: ASSETS, tier: 'T1' }).filter((i) => i.code === 'CM-012').map((i) => i.severity)).toEqual(['warn']);
  });
  it('the agent summary carries layers, overlay durations and audio lanes', () => {
    const m = must(base(), [imageAt(0, 5000), textAt(0, 3000, 'Judul'), op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1 })]);
    const s = summarizeForAgent(m, ASSETS);
    expect(s.overlay[0]).toMatchObject({ kind: 'image', asset: 'logo.png', atMs: 0, durationMs: 5000, layer: 0 });
    expect(s.text[0]).toMatchObject({ text: 'Judul', layer: 1 });
    expect(s.audio[0]).toMatchObject({ lane: 0, durationMs: 4000 });
  });
});
