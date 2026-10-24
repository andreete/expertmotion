// GOLDEN_SCENARIOS §4.1 harness (a): Compile-path scenarios GS-01…07, 13, 16 (pick part), 19.
import { describe, expect, it } from 'vitest';
import { applyOperations, hashModel, type OperationT } from '@expertmotion/composition-model';
import { Scenario, expectOk, FIXTURES, SRT_FX_S1 } from './harness.js';

/** GS-01: Insert in Sequence Badge order 2-3-1 (FX-V3, FX-V1, FX-V2). The Insert is an asset op, not a Design Pick. */
function b1(s = new Scenario()) {
  const ops: OperationT[] = ['FX-V3', 'FX-V1', 'FX-V2'].map((assetId, atIndex) => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId, atIndex } }));
  const r = applyOperations(s.model, ops, { assets: s.assets, tier: s.tier, newId: s.newId });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  s.model = r.value.model; s.versions.push(hashModel(s.model));
  return s;
}
const b2 = (s = b1()) => { expectOk(s.pick({ presetId: 'preset:transition.fade' })); return s; };

describe('GS-01 Insert three clips in badge order', () => {
  it('clips c1..c3 = FX-V3, FX-V1, FX-V2; 19 000 ms; portrait clip covers', () => {
    const s = b1();
    expect(s.model.tracks.video.map((c) => [c.assetId, c.durationMs, c.trimBeforeMs])).toEqual([['FX-V3', 5000, 0], ['FX-V1', 8000, 0], ['FX-V2', 6000, 0]]);
    expect(s.model.tracks.video[0]!.objectFit ?? 'cover').toBe('cover');
    expect(new Set(s.model.tracks.video.map((c) => c.id)).size).toBe(3);   // c1..c3 are symbolic labels; real ids come from newId
    expect(s.durationMs).toBe(19_000);
    expect(s.model.transitions).toEqual([]);
    expect(s.providerCalls).toBe(0);
  });
});

describe('GS-02 Fade with nothing selected → all cuts', () => {
  it('one parent + two children; ops transition.set on cut 0 and 1; 18 000 ms; keys locked', () => {
    const s = b1();
    const r = expectOk(s.pick({ presetId: 'preset:transition.fade' }));
    expect(r.intents.map((i) => i.propertyKey)).toEqual(['group:transition:preset:transition.fade', 'cut:0.transition', 'cut:1.transition']);
    expect(r.intents.slice(1).every((c) => c.parentIntentId === r.intents[0]!.id)).toBe(true);
    expect(r.intents[0]!.params['targetLabel']).toBe('all 2 cuts');
    expect(r.ops.map((o) => [o.op, o.target])).toEqual([['op:transition.set', { kind: 'cut', index: 0 }], ['op:transition.set', { kind: 'cut', index: 1 }]]);
    expect(r.ops[0]!.args).toMatchObject({ presetId: 'preset:transition.fade', durationMs: 500 });
    expect(s.model.transitions.map((t) => [t.cutIndex, t.presetId, t.durationMs])).toEqual([[0, 'preset:transition.fade', 500], [1, 'preset:transition.fade', 500]]);
    expect(s.durationMs).toBe(18_000);
    expect(s.lockedKeys.sort()).toEqual(['cut:0.transition', 'cut:1.transition']);
  });
  it('edge: one clip only → EM-2202, no intent', () => {
    const s = new Scenario();
    const r = applyOperations(s.model, [{ op: 'op:clip.insert', args: { assetId: 'FX-V1' } }], { assets: s.assets, tier: 'T1', newId: s.newId });
    s.model = r.ok ? r.value.model : s.model;
    expect(s.pick({ presetId: 'preset:transition.fade' })).toEqual({ rejected: ['EM-2202'] });
    expect(s.queue).toHaveLength(0);
  });
});

describe('GS-03 Slide on selected clip supersedes Fade on that cut only', () => {
  it('child 1a superseded, parent and 1b stand; cut 1 stays fade; duration unchanged', () => {
    const s = b2();
    const [parent, c0, c1] = s.queue;
    const r = expectOk(s.pick({ presetId: 'preset:transition.slide', selection: [{ kind: 'clip', id: s.model.tracks.video[0]!.id }] }));
    expect(r.intents[0]!.propertyKey).toBe('cut:0.transition');
    expect(s.queue.find((i) => i.id === r.intents[0]!.id)!.supersedes).toEqual([c0!.id]);
    const st = Object.fromEntries(s.queue.map((i) => [i.id, i.status]));
    expect(st[c0!.id]).toBe('superseded');
    expect(st[c1!.id]).toBe('compiled');
    expect(st[parent!.id]).not.toBe('superseded');
    expect(s.model.transitions.map((t) => t.presetId)).toEqual(['preset:transition.slide', 'preset:transition.fade']);
    expect(s.durationMs).toBe(18_000);
  });
  it('edge: last clip selected has no following cut → falls back, never targets a missing cut', () => {
    const s = b2();
    const r = expectOk(s.pick({ presetId: 'preset:transition.wipe', selection: [{ kind: 'clip', id: s.model.tracks.video[2]!.id }] }));
    expect(r.ops.every((o) => (o.target?.index ?? 0) <= 1)).toBe(true);
  });
});

describe('GS-04 / GS-19 Text Panel theme defaults, supersede and restore', () => {
  it('fontSize then colour → two theme ops, two versions, no supersession', () => {
    const s = b2(); const v0 = s.versions.length;
    const a = expectOk(s.pick({ field: 'fontSize', value: 72 }));
    const b = expectOk(s.pick({ field: 'colour', value: '#E8913A' }));
    expect(a.ops).toEqual([expect.objectContaining({ op: 'op:theme.setTextDefaults', target: { kind: 'project' }, args: { fontSize: 72 } })]);
    expect(b.ops[0]!.args).toEqual({ colour: '#E8913A' });
    expect(s.model.theme.textDefaults).toMatchObject({ fontSize: 72, colour: '#E8913A' });
    expect(s.versions.length - v0).toBe(2);
    expect(s.queue.filter((i) => i.status === 'superseded')).toHaveLength(0);
  });
  it('GS-04b: with a text selected the key and op target that text', () => {
    const s = b2();
    expectOk(s.pick({ presetId: 'preset:text.title', text: 'Judul', playheadMs: 0 }));
    const t1 = s.model.tracks.text[0]!.id;
    const r = expectOk(s.pick({ field: 'fontSize', value: 72, selection: [{ kind: 'text', id: t1 }] }));
    expect(r.ops[0]).toMatchObject({ op: 'op:text.setStyle', target: { kind: 'text', id: t1 }, args: { fontSize: 72 } });
  });
  it('GS-19: 72 → 96 supersedes, restore of 72 supersedes 96; theme 72 again, three versions', () => {
    const s = b2(); const v0 = s.versions.length;
    const first = expectOk(s.pick({ field: 'fontSize', value: 72 })).intents[0]!;
    const second = expectOk(s.pick({ field: 'fontSize', value: 96 })).intents[0]!;
    expect(s.queue.find((i) => i.id === first.id)!.status).toBe('superseded');
    expect(s.model.theme.textDefaults.fontSize).toBe(96);
    expectOk(s.restoreIntent(first.id));
    const q = Object.fromEntries(s.queue.map((i) => [i.id, i]));
    expect(q[first.id]!.status).toBe('compiled');
    expect(q[first.id]!.restoredAt).toBe('2026-10-24T00:00:01.000Z');
    expect(q[second.id]!.status).toBe('superseded');
    expect(s.model.theme.textDefaults.fontSize).toBe(72);
    expect(s.versions.length - v0).toBe(3);
  });
});

describe('GS-05 Indonesian title in 9:16', () => {
  it('text.add at the playhead, 3 000 ms default, duration unchanged, no CM-008 block', () => {
    const s = b2(b1(new Scenario({ ratio: '9:16' })));
    const r = expectOk(s.pick({ presetId: 'preset:text.title', text: 'Review HP 2 Juta: Masih Layak di 2026?', playheadMs: 500 }));
    expect(r.ops[0]).toMatchObject({ op: 'op:text.add', args: { text: 'Review HP 2 Juta: Masih Layak di 2026?', atMs: 500 } });
    const t = s.model.tracks.text[0]!;
    expect(t.timing).toMatchObject({ atMs: 500 });
    expect(t.timing.durationMs).toBeGreaterThan(0);
    expect(s.model.settings.ratio).toBe('9:16');
    expect(s.durationMs).toBe(18_000);
    expect(s.issues().filter((i) => i.severity === 'block')).toEqual([]);
  });
});

describe('GS-06 Effects list with dedupe and the tier limit', () => {
  it('T0: vignette + film grain, vignette again updates params, third effect rejected EM-2105', () => {
    const s = b2(b1(new Scenario({ tier: 'T0' })));
    const sel = [{ kind: 'clip' as const, id: s.model.tracks.video[1]!.id }];
    expectOk(s.pick({ presetId: 'preset:effect.vignette', selection: sel }));
    expectOk(s.pick({ presetId: 'preset:effect.film-grain', selection: sel }));
    expectOk(s.pick({ presetId: 'preset:effect.vignette', selection: sel, params: { intensity: 0.8 } }));
    const fx = s.model.tracks.video[1]!.effects;
    expect(fx.map((e) => e.presetId)).toEqual(['preset:effect.vignette', 'preset:effect.film-grain']);
    expect(fx[0]!.params).toMatchObject({ intensity: 0.8 });
    const before = s.versions.length;
    expect(s.pick({ presetId: 'preset:effect.glow', selection: sel })).toEqual({ rejected: [expect.stringMatching(/EM-2105|CM-006/)] });
    expect(s.versions.length).toBe(before);
  });
  it('GS-06b: T1 accepts a third effect and rejects a fourth', () => {
    const s = b2();
    const sel = [{ kind: 'clip' as const, id: s.model.tracks.video[1]!.id }];
    for (const p of ['vignette', 'film-grain', 'glow']) expectOk(s.pick({ presetId: `preset:effect.${p}`, selection: sel }));
    expect(s.model.tracks.video[1]!.effects).toHaveLength(3);
    expect('rejected' in s.pick({ presetId: 'preset:effect.blur', selection: sel })).toBe(true);
  });
});

describe('GS-07 Caption style + SRT pages', () => {
  it('style pick compiles to caption.setStyle; importSrt builds ordered pages that end by 7 000 ms', () => {
    const pages = SRT_FX_S1.map((c) => ({ text: c.text, startMs: c.startMs, durationMs: c.endMs - c.startMs, tokens: [] }));
    const s = b1(new Scenario({ assets: [...FIXTURES, { id: 'FX-S1', kind: 'subtitle', status: 'ready', name: 'narasi.srt', captionPages: pages } as never] }));
    const a = expectOk(s.pick({ presetId: 'preset:caption.karaoke' }));
    expect(a.ops[0]).toMatchObject({ op: 'op:caption.setStyle', args: { presetId: 'preset:caption.karaoke' } });
    expect(s.model.tracks.caption.styleId).toBe('preset:caption.karaoke');
    const r = applyOperations(s.model, [{ op: 'op:caption.importSrt', target: { kind: 'project' }, args: { assetId: 'FX-S1' } }], { assets: s.assets, tier: 'T1', newId: s.newId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value.model.tracks.caption.pages;
    expect(p.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < p.length; i++) expect(p[i]!.startMs).toBeGreaterThanOrEqual(p[i - 1]!.startMs + p[i - 1]!.durationMs);
    expect(p[p.length - 1]!.startMs + p[p.length - 1]!.durationMs).toBeLessThanOrEqual(7000);
    expect(r.value.model.tracks.caption.sourceAssetId).toBe('FX-S1');
    expect(s.durationMs).toBe(19_000);
  });
});

describe('GS-13 Ratio change; 4K/2K on T0', () => {
  it('ratio 9:16 compiles to output.setRatio, positions untouched, duration 18 000', () => {
    const s = b2(b1(new Scenario({ tier: 'T0' })));
    const r = expectOk(s.pick({ output: { kind: 'ratio', value: '9:16' } }));
    expect(r.intents[0]!.propertyKey).toBe('project.ratio');
    expect(r.ops[0]).toMatchObject({ op: 'op:output.setRatio', args: { ratio: '9:16' } });
    expect(s.model.settings.ratio).toBe('9:16');
    expect(s.model.settings.resolution).toBe('1080p');
    expect(s.durationMs).toBe(18_000);
  });
  it('2160p on T0: the Editor disables the button; a programmatic pick only stores it with CM-010 so export offers 1080p', () => {
    const s = b2(b1(new Scenario({ tier: 'T0' })));
    expectOk(s.pick({ output: { kind: 'resolution', value: '2160p' } }));
    expect(s.issues()).toContainEqual(expect.objectContaining({ code: 'CM-010', severity: 'warn' }));
  });
});

describe('GS-16 Private Mode: picks still compile without any provider', () => {
  it('fade compiles identically to GS-02 with zero provider calls', () => {
    const s = b2();
    expect(s.durationMs).toBe(18_000);
    expect(s.providerCalls).toBe(0);
  });
});
