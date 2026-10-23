import { describe, expect, it } from 'vitest';
import { createEmptyModel, deriveTiming, deriveFrameTiming, validate, diffModels, hashModel, migrateModel, summarizeForAgent, framesOf, frameInUnits, aspectOf, type CompositionModelT } from '../src/index.js';
import { ASSETS, base, must, op } from './helpers.js';

const withFades = () => must(base(), [op('op:transition.set', { presetId: 'preset:transition.fade', durationMs: 500 }, { kind: 'cut', index: 0 }), op('op:transition.set', { presetId: 'preset:transition.wipe', durationMs: 1000 }, { kind: 'cut', index: 1 })]);
const codes = (m: CompositionModelT, tier: 'T0' | 'T1' | 'T2' = 'T1') => validate(m, { assets: ASSETS, tier }).map((i) => `${i.code}:${i.severity}`);

describe('timing (DATABASE_SCHEMA §4.3)', () => {
  it('duration = Σ clips − Σ transitions; cut and clip starts', () => {
    const t = deriveTiming(withFades());                       // 8000 + 6000 + 5000 − 500 − 1000
    expect(t.durationMs).toBe(17_500);
    expect(t.clipStartMs).toEqual([0, 7500, 12_500]);
    expect(t.cutStartMs).toEqual([7500, 12_500]);
  });
  it('element windows clip at the end with a warning; loops run to the end', () => {
    const m = must(withFades(), [op('op:text.add', { text: 'x', variant: 'preset:text.title', atMs: 17_000, durationMs: 2000 }), op('op:audio.addBed', { assetId: 'mus' })]);
    const t = deriveTiming(m);
    expect(t.elementWindows[m.tracks.text[0]!.id]).toEqual({ fromMs: 17_000, toMs: 17_500 });
    expect(t.elementWindows[m.tracks.audio[0]!.id]).toEqual({ fromMs: 0, toMs: 17_500 });
    expect(t.warnings.map((w) => w.code)).toEqual(['CM-005']);
  });
  it('fixed policy and the 1 s minimum', () => {
    expect(deriveTiming(must(base(), [op('op:project.setDurationPolicy', { policy: 'fixed', fixedMs: 4000 })])).durationMs).toBe(4000);
    expect(deriveTiming(createEmptyModel('p')).durationMs).toBe(1000);
  });
  it('frames: rounded per element and summed so TransitionSeries matches durationInFrames exactly', () => {
    for (const fps of [24, 25, 30, 50, 60] as const) {
      const m = must(withFades(), [op('op:project.setFps', { fps })]);
      const f = deriveFrameTiming(m);
      const sum = f.clipFrames.reduce((a, b) => a + b, 0) - Object.values(f.transitionFrames).reduce((a, b) => a + b, 0);
      expect(f.durationInFrames).toBe(sum);
      expect(Math.abs(f.durationInFrames - framesOf(17_500, fps))).toBeLessThanOrEqual(2);
      expect(f.clipStartFrames[1]).toBe(f.clipFrames[0]! - f.transitionFrames[0]!);
    }
  });
  it('a transition is never as long as an adjacent clip in frames', () => {
    const m = must(createEmptyModel('p'), [op('op:clip.insert', { assetId: 'v1', durationMs: 200 }), op('op:clip.insert', { assetId: 'v2', durationMs: 200 })]);
    m.transitions.push({ cutIndex: 0, presetId: 'preset:transition.fade', durationMs: 100, timing: 'linear', params: {} });
    const f = deriveFrameTiming({ ...m, settings: { ...m.settings, fps: 24 } });
    expect(f.transitionFrames[0]).toBeLessThan(f.clipFrames[0]!);
  });
  it('units: aspect and frame size in u', () => {
    expect(frameInUnits('9:16')).toEqual({ w: 1080, h: 1920 });
    expect(frameInUnits('16:9')).toEqual({ w: 1920, h: 1080 });
    expect(aspectOf('custom', { w: 10, h: 1 })).toBe(3);
    expect(aspectOf('custom')).toBe(1);
  });
});

describe('validate CM-001 … CM-011', () => {
  it('a clean model has no issues', () => expect(codes(withFades())).toEqual([]));
  it('CM-001 missing asset, CM-002 source too short', () => {
    const m = withFades(); m.tracks.video[0]!.assetId = 'gone';
    expect(codes(m)).toContain('CM-001:block');
    const m2 = withFades(); m2.tracks.video[2]!.playbackRate = 2;      // 5 s × 2 > 5 s source
    expect(codes(m2)).toContain('CM-002:block');
  });
  it('CM-003 cut out of range and duplicates; CM-004 too long (warn) and too short clips (block)', () => {
    const m = withFades(); m.transitions.push({ cutIndex: 5, presetId: 'preset:transition.fade', durationMs: 500, timing: 'linear', params: {} }, { cutIndex: 0, presetId: 'preset:transition.iris', durationMs: 500, timing: 'linear', params: {} });
    expect(codes(m)).toEqual(expect.arrayContaining(['CM-003:block']));
    expect(codes(m).filter((c) => c === 'CM-003:block').length).toBe(2);
    const m2 = withFades(); m2.transitions[1]!.durationMs = 2000; m2.tracks.video[2]!.durationMs = 3000;
    expect(codes(m2)).toContain('CM-004:warn');
    const m3 = withFades(); m3.tracks.video[1]!.durationMs = 150;
    expect(codes(m3)).toContain('CM-004:block');
  });
  it('CM-005 duration bounds', () => {
    expect(codes(createEmptyModel('p'))).toContain('CM-005:block');
    const m = withFades(); m.durationPolicy = 'fixed'; m.fixedDurationMs = 1_900_000;
    expect(codes(m)).toContain('CM-005:block');
  });
  it('CM-006 effect count by tier; CM-007 preset category, params, webgpu, gpu warn on T0', () => {
    const w = withFades(); const m = must(w, [op('op:effect.add', { presetId: 'preset:effect.vignette' }, { kind: 'clip', id: w.tracks.video[0]!.id })]);
    m.tracks.video[0]!.effects.push({ presetId: 'preset:effect.blur', params: {}, motion: 'static' }, { presetId: 'preset:effect.glow', params: {}, motion: 'static' });
    expect(codes(m, 'T0')).toEqual(expect.arrayContaining(['CM-006:block', 'CM-007:warn']));
    expect(codes(m, 'T1')).not.toContain('CM-006:block');
    const m2 = withFades(); m2.background = { presetId: 'preset:transition.fade', params: {} };
    expect(codes(m2)).toContain('CM-007:block');
    const m3 = withFades(); m3.transitions[0]!.params = { direction: 'sideways' };
    expect(codes(m3)).toContain('CM-007:block');
    const m4 = withFades(); m4.tracks.video[0]!.effects.push({ presetId: 'preset:effect.page-turn', params: {}, motion: 'static' });
    expect(codes(m4, 'T1')).toContain('CM-007:block');
    expect(codes(m4, 'T2')).not.toContain('CM-007:block');
  });
  it('CM-008 text that cannot fit even at 34 u warns', () => {
    const m = must(withFades(), [op('op:text.add', { text: 'kata '.repeat(100).trim(), variant: 'preset:text.title', atMs: 0, durationMs: 2000 })]);
    expect(codes(m)).toContain('CM-008:warn');
    expect(codes(must(withFades(), [op('op:text.add', { text: 'Harga cabai naik lagi', variant: 'preset:text.title', atMs: 0, durationMs: 2000 })]))).toEqual([]);
  });
  it('CM-009 overlapping and late caption pages warn; CM-010 tier; CM-011 duplicate ids', () => {
    const m = must(withFades(), [op('op:caption.setPages', { pages: [{ text: 'a', startMs: 0, durationMs: 1000, tokens: [] }, { text: 'b', startMs: 500, durationMs: 1000, tokens: [] }, { text: 'c', startMs: 17_000, durationMs: 2000, tokens: [] }] })]);
    expect(codes(m).filter((c) => c.startsWith('CM-009'))).toEqual(['CM-009:warn', 'CM-009:warn']);
    const m2 = must(withFades(), [op('op:output.setResolution', { preset: '2k' })]);
    expect(codes(m2, 'T0')).toContain('CM-010:warn'); expect(codes(m2, 'T1')).not.toContain('CM-010:warn');
    const m3 = withFades(); m3.tracks.video[1]!.id = m3.tracks.video[0]!.id;
    expect(codes(m3)).toContain('CM-011:block');
  });
});

describe('diff, hash, migration, agent summary', () => {
  it('diff reports added, removed and modified elements with fields', () => {
    const a = withFades();
    const b = must(a, [op('op:clip.remove', {}, { kind: 'clip', id: a.tracks.video[2]!.id }), op('op:text.add', { text: 'x', variant: 'preset:text.title', atMs: 0, durationMs: 1000 }), op('op:clip.setVolume', { volume: 0.5 }, { kind: 'clip', id: a.tracks.video[0]!.id })]);
    const d = diffModels(a, b);
    expect(d).toEqual(expect.arrayContaining([
      { elementId: a.tracks.video[2]!.id, change: 'removed', fields: [] },
      { elementId: a.tracks.video[0]!.id, change: 'modified', fields: ['volume'] },
      { elementId: 'cut:1', change: 'removed', fields: [] },
      { elementId: 'sequence.order', change: 'modified', fields: ['ids'] },
      { elementId: b.tracks.text[0]!.id, change: 'added', fields: [] },
    ]));
    expect(diffModels(a, a)).toEqual([]);
  });
  it('hash is stable, key-order independent and changes with content', () => {
    const a = withFades(); const b = JSON.parse(JSON.stringify(a)) as CompositionModelT;
    expect(hashModel(a)).toBe(hashModel(b));
    expect(hashModel(a)).toMatch(/^[0-9a-f]{64}$/);
    b.tracks.video[0]!.volume = 0.9;
    expect(hashModel(a)).not.toBe(hashModel(b));
  });
  it('migrateModel accepts v1, refuses newer, unknown and broken documents', () => {
    expect(migrateModel(JSON.parse(JSON.stringify(withFades()))).ok).toBe(true);
    expect(migrateModel({ ...withFades(), schemaVersion: 2 })).toMatchObject({ ok: false, issues: [{ code: 'EM-2001' }] });
    expect(migrateModel({ schemaVersion: 0 }).ok).toBe(false);
    expect(migrateModel('x').ok).toBe(false);
    expect(migrateModel({ ...withFades(), tracks: null }).ok).toBe(false);
  });
  it('summary has ids, durations and asset names but never paths, and truncates to budget', () => {
    const m = must(withFades(), Array.from({ length: 60 }, (_, i) => op('op:text.add', { text: `Teks nomor ${i} `.repeat(6), variant: 'preset:text.subtitle', atMs: i * 100, durationMs: 1000 })));
    const s = summarizeForAgent(m, ASSETS, 4000);
    expect(s.video[0]).toMatchObject({ asset: 'unboxing.mp4', durationMs: 8000 });
    expect(s.cuts).toEqual([{ index: 0, transition: 'preset:transition.fade', durationMs: 500 }, { index: 1, transition: 'preset:transition.wipe', durationMs: 1000 }]);
    expect(JSON.stringify(s)).not.toMatch(/[A-Z]:\\|\/home\//);
    const small = summarizeForAgent(m, ASSETS, 300);
    expect(small.truncated).toBe(true);
    expect(small.text.length).toBeLessThan(60);
  });
});
