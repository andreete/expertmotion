// ADR-030: videos without media ("faceless"): scene clips (op:scene.add / op:scene.setBackground) and fit-content without Clips.
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, deriveFrameTiming, deriveTiming, propertyKeysOf, summarizeForAgent, validate } from '../src/index.js';
import { ASSETS, base, ctx, must, op } from './helpers.js';

const empty = () => createEmptyModel('p1', { autoRatio: false });
const blocks = (m: ReturnType<typeof empty>) => validate(m, { assets: [], tier: 'T1' }).filter((i) => i.severity === 'block');

describe('ADR-030 scene clips', () => {
  it('scenes append clips without media with their texts; transitions sit between scenes; duration = Σ scenes − transitions', () => {
    const m = must(empty(), [
      op('op:scene.add', { durationMs: 3000, background: 'preset:background.spotlight', title: 'Tagihan listrik bengkak?' }, { kind: 'sequence' }),
      op('op:scene.add', { durationMs: 8000, background: 'preset:background.gradient', title: 'Tips 1', text: 'Cabut charger yang tidak dipakai', transition: 'preset:transition.fade', transitionMs: 400 }, { kind: 'sequence' }),
      op('op:scene.add', { durationMs: 4000, background: 'preset:background.solid', title: 'Follow untuk tips lain', transition: 'preset:transition.slide' }, { kind: 'sequence' }),
    ], { ...ctx(), assets: [] });
    expect(m.tracks.video.map((c) => [c.assetId, c.scene?.presetId, c.durationMs])).toEqual([[undefined, 'preset:background.spotlight', 3000], [undefined, 'preset:background.gradient', 8000], [undefined, 'preset:background.solid', 4000]]);
    expect(m.transitions.map((t) => [t.cutIndex, t.presetId, t.durationMs])).toEqual([[0, 'preset:transition.fade', 400], [1, 'preset:transition.slide', 500]]);
    expect(m.tracks.text.map((t) => [t.text, t.timing.atMs, t.timing.durationMs])).toEqual([
      ['Tagihan listrik bengkak?', 0, 3000], ['Tips 1', 3000, 7600], ['Cabut charger yang tidak dipakai', 3000, 7600], ['Follow untuk tips lain', 10600, 3500]]);
    expect(deriveTiming(m).durationMs).toBe(14100);
    expect(deriveFrameTiming(m).durationInFrames).toBe(423);
    expect(blocks(m)).toEqual([]);
    expect(summarizeForAgent(m, []).video[0]).toMatchObject({ asset: null, scene: 'preset:background.spotlight' });
  });
  it('defaults: gradient background; text alone becomes the title; scene.setBackground only on scene clips; bad presets refused', () => {
    const m = must(empty(), [op('op:scene.add', { durationMs: 2000, text: 'Hemat 30%' })], { ...ctx(), assets: [] });
    expect(m.tracks.video[0]!.scene).toMatchObject({ presetId: 'preset:background.gradient' });
    expect(m.tracks.text[0]).toMatchObject({ text: 'Hemat 30%', variantId: 'preset:text.title' });
    const id = m.tracks.video[0]!.id;
    const m2 = must(m, [op('op:scene.setBackground', { presetId: 'preset:background.dots' }, { kind: 'clip', id })], { ...ctx(), assets: [] });
    expect(m2.tracks.video[0]!.scene?.presetId).toBe('preset:background.dots');
    expect(propertyKeysOf(op('op:scene.setBackground', { presetId: 'preset:background.dots' }, { kind: 'clip', id }))).toEqual([`clip:${id}.scene`]);
    const media = base();
    const r = applyOperations(media, [op('op:scene.setBackground', { presetId: 'preset:background.dots' }, { kind: 'clip', id: media.tracks.video[0]!.id })], ctx());
    expect(!r.ok && r.issues[0]).toMatchObject({ code: 'EM-2102' });
    const bad = applyOperations(empty(), [op('op:scene.add', { durationMs: 2000, background: 'preset:shape.rect' })], ctx());
    expect(!bad.ok && bad.issues[0]).toMatchObject({ code: 'EM-2101' });
  });
  it('scene clips split and trim without source media; a clip with neither media nor scene is CM-001', () => {
    const m = must(empty(), [op('op:scene.add', { durationMs: 4000, title: 'A' })], { ...ctx(), assets: [] });
    const id = m.tracks.video[0]!.id;
    const s = must(m, [op('op:element.split', { atMs: 1500 }, { kind: 'clip', id }), op('op:clip.setTrim', { trimBeforeMs: 300, durationMs: 1000 }, { kind: 'clip', id })], { ...ctx(), assets: [] });
    expect(s.tracks.video.map((c) => [c.trimBeforeMs, c.durationMs, c.scene?.presetId])).toEqual([[0, 1000, 'preset:background.gradient'], [0, 2500, 'preset:background.gradient']]);
    const broken = structuredClone(s); delete broken.tracks.video[0]!.scene;
    expect(blocks(broken).map((i) => i.code)).toContain('CM-001');
  });
  it('a project without Clips fits its texts and a voice-over with a length (not a looping bed); with Clips it fits the Clips', () => {
    const m = must(empty(), [op('op:text.add', { text: 'Halo', variant: 'preset:text.title', atMs: 0, durationMs: 3000 }), op('op:audio.addLayer', { assetId: 'vo', atMs: 500, volume: 1 }), op('op:audio.addBed', { assetId: 'mus', volume: 0.2, loop: true })]);
    expect(deriveTiming(m).durationMs).toBe(4500);
    expect(deriveTiming(must(base(), [op('op:text.add', { text: 'Akhir', variant: 'preset:text.title', atMs: 30000, durationMs: 3000 })])).durationMs).toBe(19000);
    expect(validate(empty(), { assets: ASSETS, tier: 'T1' }).some((i) => i.code === 'CM-005' && i.severity === 'block')).toBe(true);
  });
});
