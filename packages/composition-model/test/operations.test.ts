import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyOperations, createEmptyModel, OP_NAMES, propertyKeysOf, lockedKeysOf, conflictsWithLocked, detectRatio, type CompositionModelT } from '../src/index.js';
import { base, ctx, deepFreeze, must, op } from './helpers.js';

const blocked = (r: ReturnType<typeof applyOperations>) => (r.ok ? null : r.issues[0]!);
const okModel = (r: ReturnType<typeof applyOperations>): CompositionModelT => { if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model; };

describe('vocabulary matches docs/AI_WORKFLOW.md §5', () => {
  it('same set of operation names', () => {
    const doc = fs.readFileSync(new URL('../../../docs/AI_WORKFLOW.md', import.meta.url), 'utf8').split('## 5.')[1]!.split('## 6.')[0]!;
    const docOps = new Set([...doc.matchAll(/^\| `(op:[a-z]+\.[a-zA-Z]+)`/gm)].map((m) => m[1]!));
    expect([...docOps].sort()).toEqual([...OP_NAMES].sort());
    expect(OP_NAMES.length).toBe(53);
  });
});

describe('general behaviour', () => {
  it('is pure: frozen input is never mutated and a new model is returned', () => {
    const m = deepFreeze(base());
    const r = applyOperations(m, [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 })], ctx());
    expect(r.ok).toBe(true);
    expect(m.transitions).toEqual([]);
  });
  it('stops at the first blocking issue and applies nothing', () => {
    const r = applyOperations(base(), [op('op:background.set', { presetId: 'preset:background.solid' }), op('op:clip.remove', {}, { kind: 'clip', id: 'nope' }), op('op:theme.set', { paletteId: 'preset:palette.neon-tech' })], ctx());
    expect(blocked(r)).toMatchObject({ code: 'EM-2203', path: 'ops[1].target' });
  });
  it('unknown op → EM-2303; bad args → EM-2102 with path; wrong target kind → EM-2102', () => {
    expect(blocked(applyOperations(base(), [op('op:render.start')], ctx()))).toMatchObject({ code: 'EM-2303' });
    expect(blocked(applyOperations(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 50 }, { kind: 'cut', index: 0 })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.durationMs' });
    expect(blocked(applyOperations(base(), [op('op:clip.setVolume', { volume: 0.5 }, { kind: 'text', id: 'x' })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target.kind' });
    expect(blocked(applyOperations(base(), [op('op:clip.setVolume', { volume: 0.5, extra: 1 }, { kind: 'clip', id: 'x' })], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(base(), [op('op:clip.remove')], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target' });
  });
  it('returns a diff', () => {
    const r = applyOperations(base(), [op('op:background.set', { presetId: 'preset:background.grid' })], ctx());
    expect(r.ok && r.value.diff).toEqual([{ elementId: 'project.background', change: 'modified', fields: ['params', 'presetId'] }]);
  });
});

describe('clips', () => {
  it('insert: append, defaults from the asset, image 5 s', () => {
    const m = must(createEmptyModel('p', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v1' }), op('op:clip.insert', { assetId: 'img' })]);
    expect(m.tracks.video.map((c) => [c.assetId, c.durationMs, c.trimBeforeMs])).toEqual([['v1', 10_000, 0], ['img', 5000, 0]]);
  });
  it('insert with trim uses the rest of the source; over-long trim → EM-2306', () => {
    expect(must(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'v1', trimBeforeMs: 4000 })]).tracks.video[0]!.durationMs).toBe(6000);
    expect(blocked(applyOperations(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'v1', trimBeforeMs: 4000, durationMs: 7000 })], ctx()))).toMatchObject({ code: 'EM-2306' });
  });
  it('insert refuses missing, not-ready and wrong-kind assets', () => {
    expect(blocked(applyOperations(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'zzz' })], ctx()))).toMatchObject({ code: 'EM-1301' });
    expect(blocked(applyOperations(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'busy' })], ctx()))).toMatchObject({ code: 'EM-1301' });
    expect(blocked(applyOperations(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'mus' })], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(blocked(applyOperations(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'v1', atIndex: 3 })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.atIndex' });
  });
  it('Auto ratio follows the first inserted clip only', () => {
    const m = must(createEmptyModel('p', { autoRatio: true, ratio: '9:16' }), [op('op:clip.insert', { assetId: 'v1' }), op('op:clip.insert', { assetId: 'v2' })]);
    expect(m.settings.ratio).toBe('16:9');
  });
  it('FR-088: Auto re-checks when the first clip changes; setAutoRatio on applies now, off keeps the ratio', () => {
    let m = must(createEmptyModel('p', { autoRatio: true, ratio: '16:9' }), [op('op:clip.insert', { assetId: 'v1' }), op('op:clip.insert', { assetId: 'v2' })]);
    expect(m.settings.ratio).toBe('16:9');
    m = must(m, [op('op:clip.move', { toIndex: 0 }, { kind: 'clip', id: m.tracks.video[1]!.id })]);
    expect(m.settings.ratio).toBe('9:16');                                     // v2 (portrait) is now first
    m = must(m, [op('op:clip.remove', {}, { kind: 'clip', id: m.tracks.video[0]!.id })]);
    expect(m.settings.ratio).toBe('16:9');
    const manual = must(m, [op('op:output.setRatio', { ratio: '1:1' }), op('op:clip.insert', { assetId: 'v2', atIndex: 0 })]);
    expect(manual.settings).toMatchObject({ ratio: '1:1', autoRatio: false });  // manual pick turned Auto off: first-clip change ignored
    const back = must(manual, [op('op:output.setAutoRatio', { on: true }, { kind: 'project' })]);
    expect(back.settings).toMatchObject({ ratio: '9:16', autoRatio: true });
    expect(must(back, [op('op:output.setAutoRatio', { on: false }, { kind: 'project' })]).settings).toMatchObject({ ratio: '9:16', autoRatio: false });
    expect(must(createEmptyModel('p', { autoRatio: false, ratio: '4:5' }), [op('op:output.setAutoRatio', { on: true }, { kind: 'project' })]).settings).toMatchObject({ ratio: '4:5', autoRatio: true });
    expect(propertyKeysOf(op('op:output.setAutoRatio', { on: true }, { kind: 'project' }))).toEqual(['project.ratioAuto']);
  });
  it('insert in the middle shifts later cuts and keeps the earlier cut transition', () => {
    let m = must(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 }), op('op:transition.set', { presetId: 'preset:transition.wipe', durationMs: 500 }, { kind: 'cut', index: 1 })]);
    m = must(m, [op('op:clip.insert', { assetId: 'img', atIndex: 1 })]);
    expect(m.tracks.video.map((c) => c.assetId)).toEqual(['v1', 'img', 'v2', 'v3']);
    expect(m.transitions.map((t) => [t.cutIndex, t.presetId])).toEqual([[0, 'preset:transition.fade'], [2, 'preset:transition.wipe']]);
  });
  it('remove in the middle merges the two cuts keeping the first transition', () => {
    const m0 = must(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 }), op('op:transition.set', { presetId: 'preset:transition.wipe', durationMs: 500 }, { kind: 'cut', index: 1 })]);
    const r = applyOperations(m0, [op('op:clip.remove', {}, { kind: 'clip', id: m0.tracks.video[1]!.id })], ctx());
    const m = okModel(r);
    expect(m.tracks.video.map((c) => c.assetId)).toEqual(['v1', 'v3']);
    expect(m.transitions).toMatchObject([{ cutIndex: 0, presetId: 'preset:transition.fade' }]);
    expect(r.ok && r.value.diff.some((d) => d.change === 'removed')).toBe(true);
    expect(r.ok && r.warnings.some((w) => w.code === 'EM-2203' && w.severity === 'info')).toBe(true);
  });
  it('remove first and last clips drop the outer cuts', () => {
    const m0 = must(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 }), op('op:transition.set', { presetId: 'preset:transition.iris', durationMs: 500 }, { kind: 'cut', index: 1 })]);
    expect(must(m0, [op('op:clip.remove', {}, { kind: 'clip', id: m0.tracks.video[0]!.id })]).transitions).toMatchObject([{ cutIndex: 0, presetId: 'preset:transition.iris' }]);
    expect(must(m0, [op('op:clip.remove', {}, { kind: 'clip', id: m0.tracks.video[2]!.id })]).transitions).toMatchObject([{ cutIndex: 0, presetId: 'preset:transition.fade' }]);
  });
  it('move reorders; same index is a no-op; out of range blocked', () => {
    const m0 = base(); const id = m0.tracks.video[0]!.id;
    expect(must(m0, [op('op:clip.move', { toIndex: 2 }, { kind: 'clip', id })]).tracks.video.map((c) => c.assetId)).toEqual(['v2', 'v3', 'v1']);
    expect(must(m0, [op('op:clip.move', { toIndex: 0 }, { kind: 'clip', id })]).tracks.video.map((c) => c.assetId)).toEqual(['v1', 'v2', 'v3']);
    expect(blocked(applyOperations(m0, [op('op:clip.move', { toIndex: 3 }, { kind: 'clip', id })], ctx()))).toMatchObject({ code: 'EM-2102' });
    const withFades = must(m0, [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 }), op('op:transition.set', { presetId: 'preset:transition.wipe', durationMs: 500 }, { kind: 'cut', index: 1 })]);
    const moved = must(withFades, [op('op:clip.move', { toIndex: 0 }, { kind: 'clip', id: withFades.tracks.video[2]!.id })]);
    expect(moved.tracks.video.map((c) => c.assetId)).toEqual(['v3', 'v1', 'v2']);
    expect(moved.transitions.map((t) => [t.cutIndex, t.presetId])).toEqual([[0, 'preset:transition.fade'], [1, 'preset:transition.wipe']]);   // FR-068: re-attached to the new cuts
  });
  it('trim and playback rate obey trimBefore + duration × rate ≤ source (CM-002 corrected)', () => {
    const m0 = base(); const id = m0.tracks.video[0]!.id;       // v1 has 10 s
    expect(must(m0, [op('op:clip.setTrim', { trimBeforeMs: 2000, durationMs: 4000 }, { kind: 'clip', id }), op('op:clip.setPlaybackRate', { rate: 2 }, { kind: 'clip', id })]).tracks.video[0]).toMatchObject({ trimBeforeMs: 2000, durationMs: 4000, playbackRate: 2 });
    expect(blocked(applyOperations(m0, [op('op:clip.setTrim', { trimBeforeMs: 2000, durationMs: 5000 }, { kind: 'clip', id }), op('op:clip.setPlaybackRate', { rate: 2 }, { kind: 'clip', id })], ctx()))).toMatchObject({ code: 'EM-2306' });
    expect(blocked(applyOperations(m0, [op('op:clip.setTrim', { trimBeforeMs: 9000, durationMs: 2000 }, { kind: 'clip', id })], ctx()))).toMatchObject({ code: 'EM-2306' });
  });
  it('volume, fades and fit', () => {
    const m0 = base(); const id = m0.tracks.video[0]!.id;
    const c = must(m0, [op('op:clip.setVolume', { volume: 0.3, fadeInMs: 500 }, { kind: 'clip', id }), op('op:clip.setFit', { objectFit: 'contain', crop: { left: 0.1, right: 0, top: 0, bottom: 0 } }, { kind: 'clip', id })]).tracks.video[0]!;
    expect(c).toMatchObject({ volume: 0.3, fadeInMs: 500, fadeOutMs: 0, objectFit: 'contain', crop: { left: 0.1 } });
    expect(must(m0, [op('op:clip.setFit', { objectFit: 'cover' }, { kind: 'clip', id })]).tracks.video[0]!.crop).toBeUndefined();
  });
});

describe('transitions', () => {
  it('set stores params, replaces the same cut (exclusive), sorts by cut', () => {
    const m = must(base(), [op('op:transition.set', { presetId: 'preset:transition.slide', durationMs: 600, params: { direction: 'from-left' } }, { kind: 'cut', index: 1 }), op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 }), op('op:transition.set', { presetId: 'preset:transition.wipe', durationMs: 400 }, { kind: 'cut', index: 1 })]);
    expect(m.transitions).toEqual([{ cutIndex: 0, presetId: 'preset:transition.fade', durationMs: 500, timing: 'linear', params: {} }, { cutIndex: 1, presetId: 'preset:transition.wipe', durationMs: 400, timing: 'linear', params: { direction: 'from-left' } }]);
  });
  it('clamps to half the shorter clip with a warning; blocks when below 100 ms', () => {
    const r = applyOperations(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 2000 }, { kind: 'cut', index: 1 })], ctx());
    expect(okModel(r).transitions[0]!.durationMs).toBe(2000);   // cut 1 is between 6 s and 5 s: half = 2500 ≥ 2000, no clamp
    const short = must(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'v1', durationMs: 150 }), op('op:clip.insert', { assetId: 'v2', durationMs: 3000 })]);
    expect(blocked(applyOperations(short, [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 })], ctx()))).toMatchObject({ code: 'EM-2305' });
    const mid = must(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'v1', durationMs: 1000 }), op('op:clip.insert', { assetId: 'v2', durationMs: 3000 })]);
    const r2 = applyOperations(mid, [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 900 }, { kind: 'cut', index: 0 })], ctx());
    expect(okModel(r2).transitions[0]!.durationMs).toBe(500);
    expect(r2.ok && r2.warnings[0]).toMatchObject({ code: 'EM-2305', severity: 'warn' });
  });
  it('none and clear remove; invalid cut gives a human message; wrong preset category and params rejected', () => {
    const m = must(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 })]);
    expect(must(m, [op('op:transition.set', { presetId: 'preset:transition.none', durationMs: 500 }, { kind: 'cut', index: 0 })]).transitions).toEqual([]);
    expect(must(m, [op('op:transition.clear', {}, { kind: 'cut', index: 0 })]).transitions).toEqual([]);
    expect(blocked(applyOperations(m, [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 2 })], ctx()))?.message).toContain('Cut 3 does not exist; this sequence has 2 cut(s)');
    expect(blocked(applyOperations(m, [op('op:transition.set', { presetId: 'preset:effect.blur', durationMs: 500 }, { kind: 'cut', index: 0 })], ctx()))).toMatchObject({ code: 'EM-2101' });
    expect(blocked(applyOperations(m, [op('op:transition.set', { presetId: 'preset:transition.slide', durationMs: 500, params: { direction: 'diagonal' } }, { kind: 'cut', index: 0 })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].args.params.direction' });
  });
});

describe('text', () => {
  it('add: variant default position and motion; named and explicit positions; style overrides', () => {
    const m = must(base(), [
      op('op:text.add', { text: 'Harga cabai naik lagi', variant: 'preset:text.title', atMs: 300, durationMs: 3000 }),
      op('op:text.add', { text: 'Halo', variant: 'preset:text.lower-third', atMs: 0, durationMs: 2000, styleOverrides: { colour: '#FFFFFF' } }),
      op('op:text.add', { text: 'Pojok', variant: 'preset:text.callout', atMs: 0, durationMs: 2000, position: 'top-right' }),
      op('op:text.add', { text: 'Pas', variant: 'preset:text.subtitle', atMs: 0, durationMs: 2000, position: { x: 10, y: 20 } }),
    ]);
    const [title, lower, corner, sub] = m.tracks.text;
    expect(title).toMatchObject({ variantId: 'preset:text.title', position: { x: 0, y: -240 }, motion: { presetId: 'preset:motion.rise', durationMs: 600 }, effect: null });
    expect(lower!.position.y).toBeGreaterThan(0); expect(lower!.position.x).toBeLessThan(0); expect(lower!.style).toEqual({ colour: '#FFFFFF' });
    expect(corner!.position).toEqual({ x: 270, y: -480 });
    expect(sub!.position).toEqual({ x: 10, y: 20 });
  });
  it('setContent, setStyle merges fields, setEffect validated, setTiming, remove', () => {
    const m0 = must(base(), [op('op:text.add', { text: 'A', variant: 'preset:text.title', atMs: 0, durationMs: 2000 })]);
    const id = m0.tracks.text[0]!.id;
    const m = must(m0, [op('op:text.setContent', { text: 'B' }, { kind: 'text', id }), op('op:text.setStyle', { fontSize: 90 }, { kind: 'text', id }), op('op:text.setStyle', { colour: '#112233' }, { kind: 'text', id }), op('op:text.setEffect', { presetId: 'preset:texteffect.highlight' }, { kind: 'text', id }), op('op:text.setTiming', { atMs: 500, durationMs: 1500 }, { kind: 'text', id })]);
    expect(m.tracks.text[0]).toMatchObject({ text: 'B', style: { fontSize: 90, colour: '#112233' }, effect: { presetId: 'preset:texteffect.highlight', params: {} }, timing: { atMs: 500, durationMs: 1500 } });
    expect(blocked(applyOperations(m0, [op('op:text.setEffect', { presetId: 'preset:transition.fade' }, { kind: 'text', id })], ctx()))).toMatchObject({ code: 'EM-2101' });
    expect(blocked(applyOperations(m0, [op('op:text.setStyle', { fontSize: 10 }, { kind: 'text', id })], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(must(m0, [op('op:text.remove', {}, { kind: 'text', id })]).tracks.text).toEqual([]);
    expect(blocked(applyOperations(m0, [op('op:text.add', { text: 'x', variant: 'preset:caption.box', atMs: 0, durationMs: 1000 })], ctx()))).toMatchObject({ code: 'EM-2101' });
  });
});

describe('captions, background, motion, easing', () => {
  it('importSrt sets pages, source and a default style with an info notice', () => {
    const r = applyOperations(base(), [op('op:caption.importSrt', { assetId: 'srt' }, { kind: 'project' })], ctx());
    expect(okModel(r).tracks.caption).toMatchObject({ styleId: 'preset:caption.editorial', sourceAssetId: 'srt', pages: [{ text: ' Halo dunia' }] });
    expect(r.ok && r.warnings[0]).toMatchObject({ code: 'EM-2403', severity: 'info' });
    expect(blocked(applyOperations(base(), [op('op:caption.importSrt', { assetId: 'srt-empty' })], ctx()))).toMatchObject({ code: 'EM-1009' });
    expect(blocked(applyOperations(base(), [op('op:caption.importSrt', { assetId: 'v1' })], ctx()))).toMatchObject({ code: 'EM-2102' });
  });
  it('setStyle keeps an existing style choice on import; setPages sorts; clear resets', () => {
    const m = must(base(), [op('op:caption.setStyle', { presetId: 'preset:caption.karaoke', params: { position: 'center' } }), op('op:caption.importSrt', { assetId: 'srt' })]);
    expect(m.tracks.caption).toMatchObject({ styleId: 'preset:caption.karaoke', params: { position: 'center', fontSize: 56 } });
    const pages = [{ text: 'b', startMs: 2000, durationMs: 500, tokens: [] }, { text: 'a', startMs: 0, durationMs: 500, tokens: [] }];
    expect(must(m, [op('op:caption.setPages', { pages })]).tracks.caption.pages.map((p) => p.text)).toEqual(['a', 'b']);
    expect(must(m, [op('op:caption.clear')]).tracks.caption).toEqual({ styleId: null, params: {}, pages: [] });
  });
  it('background set/clear with params; motion set/clear on clip, text and shape; none → null; easing default', () => {
    const m0 = base(); const clip = m0.tracks.video[0]!.id;
    let m = must(m0, [op('op:background.set', { presetId: 'preset:background.gradient', params: { angle: 90 } }), op('op:motion.set', { presetId: 'preset:motion.zoom-drift' }, { kind: 'clip', id: clip }), op('op:easing.setDefault', { easingId: 'preset:easing.back' })]);
    expect(m.background).toEqual({ presetId: 'preset:background.gradient', params: { intensity: 1, animate: false, angle: 90 } });
    expect(m.tracks.video[0]!.motion).toMatchObject({ presetId: 'preset:motion.zoom-drift', durationMs: 600, delayMs: 0, exit: true, params: { toScale: 1.08 } });
    expect(m.theme.defaultEasingId).toBe('preset:easing.back');
    m = must(m, [op('op:motion.set', { presetId: 'preset:motion.none' }, { kind: 'clip', id: clip }), op('op:background.clear')]);
    expect(m.tracks.video[0]!.motion).toBeNull(); expect(m.background).toBeNull();
    m = must(m, [op('op:shape.add', { presetId: 'preset:shape.star', atMs: 0, durationMs: 1000 })]);
    const sid = m.tracks.overlay[0]!.id;
    expect(must(m, [op('op:motion.set', { presetId: 'preset:motion.pop' }, { kind: 'shape', id: sid })]).tracks.overlay[0]!.motion?.presetId).toBe('preset:motion.pop');
    expect(must(must(m, [op('op:motion.set', { presetId: 'preset:motion.pop' }, { kind: 'shape', id: sid })]), [op('op:motion.clear', {}, { kind: 'shape', id: sid })]).tracks.overlay[0]!.motion).toBeNull();
    expect(blocked(applyOperations(m, [op('op:easing.setDefault', { easingId: 'preset:motion.pop' })], ctx()))).toMatchObject({ code: 'EM-2101' });
  });
});

describe('effects', () => {
  const id = (m: CompositionModelT) => m.tracks.video[0]!.id;
  it('add dedupes by preset (newest params win), remove, setParams', () => {
    const m0 = base();
    const m = must(m0, [op('op:effect.add', { presetId: 'preset:effect.vignette' }, { kind: 'clip', id: id(m0) }), op('op:effect.add', { presetId: 'preset:effect.vignette', params: { intensity: 0.9 } }, { kind: 'clip', id: id(m0) })]);
    expect(m.tracks.video[0]!.effects).toEqual([{ presetId: 'preset:effect.vignette', params: { intensity: 0.9 }, motion: 'static' }]);
    expect(must(m, [op('op:effect.setParams', { presetId: 'preset:effect.vignette', params: { intensity: 0.2, motion: 'in' } }, { kind: 'clip', id: id(m0) })]).tracks.video[0]!.effects[0]).toEqual({ presetId: 'preset:effect.vignette', params: { intensity: 0.2 }, motion: 'in' });
    expect(must(m, [op('op:effect.remove', { presetId: 'preset:effect.vignette' }, { kind: 'clip', id: id(m0) })]).tracks.video[0]!.effects).toEqual([]);
    expect(blocked(applyOperations(m0, [op('op:effect.setParams', { presetId: 'preset:effect.blur', params: {} }, { kind: 'clip', id: id(m0) })], ctx()))).toMatchObject({ code: 'EM-2203' });
  });
  it('limit 2 on T0 (with gpu warnings), 3 on T1; webgpu blocked below T2', () => {
    const m0 = base(); const t = { kind: 'clip' as const, id: id(m0) };
    const three = [op('op:effect.add', { presetId: 'preset:effect.vignette' }, t), op('op:effect.add', { presetId: 'preset:effect.blur' }, t), op('op:effect.add', { presetId: 'preset:effect.glow' }, t)];
    expect(blocked(applyOperations(m0, three, ctx({ tier: 'T0' })))).toMatchObject({ code: 'EM-2105', path: 'ops[2].args.presetId' });
    const r = applyOperations(m0, three, ctx({ tier: 'T1' }));
    expect(r.ok).toBe(true);
    const r0 = applyOperations(m0, three.slice(0, 1), ctx({ tier: 'T0' }));
    expect(r0.ok && r0.warnings[0]).toMatchObject({ code: 'EM-2103', severity: 'warn' });
    expect(blocked(applyOperations(m0, [op('op:effect.add', { presetId: 'preset:effect.sphere' }, t)], ctx({ tier: 'T1' })))).toMatchObject({ code: 'EM-2103' });
    expect(applyOperations(m0, [op('op:effect.add', { presetId: 'preset:effect.sphere' }, t)], ctx({ tier: 'T2' })).ok).toBe(true);
    expect(blocked(applyOperations(m0, [op('op:effect.add', { presetId: 'preset:effect.blur' }, { kind: 'text', id: 'x' })], ctx()))).toMatchObject({ code: 'EM-2102', path: 'ops[0].target.kind' });
  });
});

describe('shapes and audio', () => {
  it('shape.add uses palette accent, size and named position; params keep shape-specific fields', () => {
    const m = must(base(), [op('op:shape.add', { presetId: 'preset:shape.star', atMs: 100, durationMs: 1500, position: 'bottom-right', motionId: 'preset:motion.pop', params: { points: 6 } })]);
    expect(m.tracks.overlay[0]).toMatchObject({ kind: 'shape', presetId: 'preset:shape.star', fill: '#E8913A', size: { w: 200, h: 200 }, position: { x: 270, y: 480 }, params: { points: 6, innerRadius: 0.44 }, motion: { presetId: 'preset:motion.pop' } });
    expect(must(m, [op('op:shape.remove', {}, { kind: 'shape', id: m.tracks.overlay[0]!.id })]).tracks.overlay).toEqual([]);
  });
  it('audio bed with fades and ducking; voice layer; setFades bounds; setDucking only the ducking preset; remove', () => {
    let m = must(base(), [op('op:audio.addBed', { assetId: 'mus', volume: 0.2, loop: true, fadeInMs: 1000, fadeOutMs: 1000, duckingPresetId: 'preset:audio.duck-voice' }), op('op:audio.addLayer', { assetId: 'vo', atMs: 1000, volume: 1 })]);
    const [bed, voice] = m.tracks.audio;
    expect(bed).toMatchObject({ role: 'bed', atMs: 0, loop: true, fadeInMs: 1000, ducking: { presetId: 'preset:audio.duck-voice', params: { duckTo: 0.15 } } });
    expect(voice).toMatchObject({ role: 'voice', atMs: 1000, durationMs: 4000, loop: false });
    expect(blocked(applyOperations(m, [op('op:audio.setFades', { fadeInMs: 2500 }, { kind: 'audio', id: voice!.id })], ctx()))).toMatchObject({ code: 'EM-2102' });
    m = must(m, [op('op:audio.setFades', { fadeInMs: 200, fadeOutMs: 300 }, { kind: 'audio', id: voice!.id }), op('op:audio.setDucking', { presetId: 'preset:audio.duck-voice', params: { duckTo: 0.1 } }, { kind: 'audio', id: bed!.id })]);
    expect(m.tracks.audio[1]).toMatchObject({ fadeInMs: 200, fadeOutMs: 300 });
    expect(m.tracks.audio[0]!.ducking?.params).toMatchObject({ duckTo: 0.1 });
    expect(blocked(applyOperations(m, [op('op:audio.setDucking', { presetId: 'preset:audio.bed-soft' }, { kind: 'audio', id: bed!.id })], ctx()))).toMatchObject({ code: 'EM-2101' });
    expect(must(m, [op('op:audio.remove', {}, { kind: 'audio', id: bed!.id })]).tracks.audio.length).toBe(1);
    expect(blocked(applyOperations(m, [op('op:audio.addBed', { assetId: 'v1' })], ctx()))).toMatchObject({ code: 'EM-2102' });
  });
});

describe('project, theme and output', () => {
  it('palette change moves the default text colour, but not a Creator-chosen colour', () => {
    expect(must(base(), [op('op:theme.set', { paletteId: 'preset:palette.paper-light' })]).theme.textDefaults.colour).toBe('#1B1B1B');
    const m = must(base(), [op('op:theme.setTextDefaults', { colour: '#123456', fontSize: 80 }), op('op:theme.set', { paletteId: 'preset:palette.paper-light', fontPairId: 'preset:fontpair.inter-mono', defaultEasingId: 'preset:easing.in-quad' })]);
    expect(m.theme).toMatchObject({ paletteId: 'preset:palette.paper-light', fontPairId: 'preset:fontpair.inter-mono', defaultEasingId: 'preset:easing.in-quad', textDefaults: { colour: '#123456', fontSize: 80 } });
  });
  it('ratio: custom needs dimensions within 1:3…3:1; manual pick turns Auto off', () => {
    const m0 = must(createEmptyModel('p', { autoRatio: true }), []);
    expect(must(m0, [op('op:output.setRatio', { ratio: '1:1' })]).settings).toMatchObject({ ratio: '1:1', autoRatio: false });
    expect(blocked(applyOperations(m0, [op('op:output.setRatio', { ratio: 'custom' })], ctx()))).toMatchObject({ code: 'EM-2402' });
    expect(blocked(applyOperations(m0, [op('op:output.setRatio', { ratio: 'custom', customRatio: { w: 4, h: 1 } })], ctx()))).toMatchObject({ code: 'EM-2402' });
    const c = must(m0, [op('op:output.setRatio', { ratio: 'custom', customRatio: { w: 21, h: 9 } })]);
    expect(c.settings.customRatio).toEqual({ w: 21, h: 9 });
    expect(must(c, [op('op:output.setRatio', { ratio: '16:9' })]).settings.customRatio).toBeUndefined();
  });
  it('resolution on T0 warns (EM-3105 info); fps; duration policy', () => {
    const r = applyOperations(base(), [op('op:output.setResolution', { preset: '2160p' }), op('op:project.setFps', { fps: 60 }), op('op:project.setDurationPolicy', { policy: 'fixed', fixedMs: 15000 })], ctx({ tier: 'T0' }));
    expect(okModel(r)).toMatchObject({ settings: { resolution: '2160p', fps: 60 }, durationPolicy: 'fixed', fixedDurationMs: 15000 });
    expect(r.ok && r.warnings[0]).toMatchObject({ code: 'EM-3105', severity: 'info' });
    expect(blocked(applyOperations(base(), [op('op:project.setDurationPolicy', { policy: 'fixed' })], ctx()))).toMatchObject({ code: 'EM-2102' });
    expect(must(okModel(r), [op('op:project.setDurationPolicy', { policy: 'fit-content' })]).fixedDurationMs).toBeUndefined();
  });
  it('generated.insert: voice, music, captions, thumbnail (FR-103 overlay); unknown job refused', () => {
    const jobs = { j1: { kind: 'voice' as const, assetId: 'vo' }, j2: { kind: 'music' as const, assetId: 'mus' }, j3: { kind: 'captions' as const, pages: [{ text: 'x', startMs: 0, durationMs: 500, tokens: [] }] }, j4: { kind: 'thumbnail' as const, assetId: 'img' } };
    const m = must(base(), [op('op:generated.insert', { kind: 'voice', jobId: 'j1', atMs: 500 }), op('op:generated.insert', { kind: 'music', jobId: 'j2' }), op('op:generated.insert', { kind: 'captions', jobId: 'j3' })], ctx({ jobs }));
    expect(m.tracks.audio.map((a) => [a.role, a.atMs])).toEqual([['voice', 500], ['bed', 0]]);
    expect(m.tracks.caption.pages).toHaveLength(1);
    expect(must(base(), [op('op:generated.insert', { kind: 'thumbnail', jobId: 'j4', atMs: 1500 })], ctx({ jobs })).tracks.overlay.at(-1)).toMatchObject({ kind: 'image', assetId: 'img', timing: { atMs: 1500 } });
    expect(blocked(applyOperations(base(), [op('op:generated.insert', { kind: 'thumbnail', jobId: 'j2' })], ctx({ jobs })))).toMatchObject({ code: 'EM-9003' });
    expect(blocked(applyOperations(base(), [op('op:generated.insert', { kind: 'voice', jobId: 'nope' })], ctx({ jobs })))).toMatchObject({ code: 'EM-9003' });
  });
});

describe('Locked Keys (AI_WORKFLOW §6)', () => {
  it('property keys per operation', () => {
    expect(propertyKeysOf(op('op:transition.set', { presetId: 'x' }, { kind: 'cut', index: 2 }))).toEqual(['cut:2.transition']);
    expect(propertyKeysOf(op('op:text.setStyle', { fontSize: 80, colour: '#000000' }, { kind: 'text', id: 't1' }))).toEqual(['text:t1.fontSize', 'text:t1.colour']);
    expect(propertyKeysOf(op('op:theme.setTextDefaults', { colour: '#000000' }))).toEqual(['theme.textDefaults.colour']);
    expect(propertyKeysOf(op('op:effect.add', { presetId: 'preset:effect.blur' }, { kind: 'clip', id: 'c' }))).toEqual(['clip:c.effects.preset:effect.blur']);
    expect(propertyKeysOf(op('op:clip.insert', { assetId: 'a' }))).toEqual([]);
    expect(propertyKeysOf(op('op:clip.insert', { assetId: 'a', atIndex: 0 }))).toEqual(['sequence.order']);
    expect(propertyKeysOf(op('op:text.add', { text: 'x' }))).toEqual([]);
    expect(lockedKeysOf([op('op:caption.setStyle', { presetId: 'x' }), op('op:caption.clear')])).toEqual(['project.captionStyle', 'project.captionPages']);
  });
  it('conflicts: equality, element removal vs field locks, sequence changes vs cut locks', () => {
    expect(conflictsWithLocked(['cut:0.transition'], ['cut:0.transition'])).toEqual(['cut:0.transition']);
    expect(conflictsWithLocked(['cut:1.transition'], ['cut:0.transition'])).toEqual([]);
    expect(conflictsWithLocked(['text:t1'], ['text:t1.fontSize'])).toEqual(['text:t1.fontSize']);
    expect(conflictsWithLocked(['text:t10'], ['text:t1.fontSize'])).toEqual([]);
    expect(conflictsWithLocked(['clip:c', 'sequence.order'], ['cut:3.transition'])).toEqual(['cut:3.transition']);
  });
});

describe('detectRatio', () => {
  it('picks the nearest of the seven ratios', () => {
    expect([detectRatio(1920, 1080), detectRatio(1080, 1920), detectRatio(1000, 1000), detectRatio(1080, 1350), detectRatio(1350, 1080), detectRatio(1440, 1080), detectRatio(1080, 1440), detectRatio(3840, 1600)])
      .toEqual(['16:9', '9:16', '1:1', '4:5', '5:4', '4:3', '3:4', '16:9']);
  });
});
