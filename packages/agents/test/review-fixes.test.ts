// Regression tests for the adversarial review of 2026-10-29 (agents part): C2 quality-gate fixes paired by the op that created the
// element, C3 quality-gate fixes respect Locked Keys, C5 one transition length per cut (= the clip overlap), C6 scene durations
// inside the op:scene.add range, C7 more than 8 native tool calls in one reply, C9 bar-chart edge cases, A7 duplicate voice clip ids.
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, deriveTiming, hashModel, qualityCheck, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { composeScenes, EditPlan, MAX_TOOL_CALLS_PER_TURN, runToolCalls, validatePlan, EDITOR_TOOL_NAMES } from '../src/index.js';

let n = 0; const newId = () => `r${++n}`;
const empty = () => createEmptyModel('p', { autoRatio: false, ratio: '9:16' });
const IMG = { id: 'img', kind: 'image' as const, status: 'ready' as const, width: 1000, height: 1000, name: 'logo.png' };
const planOf = (model: CompositionModelT, ops: OperationT[]) => EditPlan.parse({ id: 'pl', projectId: 'p', baseVersion: hashModel(model), origin: 'editor-agent', goal: 'x', status: 'draft',
  steps: [{ n: 1, tool: 'composition.applyOps', ops, expectedDiff: '' }] });
const must = (m: CompositionModelT, ops: OperationT[], assets = [IMG]) => { const r = applyOperations(m, ops, { assets, tier: 'T1', newId }); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model; };

describe('C2 quality gate pairs fixes with the op that created the element', () => {
  it('op:element.split, op:scene.add {title}, op:generated.insert before the add ops: the text and the shape that are off get their own fix', () => {
    const base = must(empty(), [{ op: 'op:text.add', args: { text: 'Lama', variant: 'preset:text.subtitle', atMs: 0, durationMs: 4000, position: { x: 0, y: -200 } } }]);
    const old = base.tracks.text[0]!;
    const ops: OperationT[] = [
      { op: 'op:element.split', target: { kind: 'text', id: old.id }, args: { atMs: 2000 } },
      { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 4000, title: 'Judul adegan' } },
      { op: 'op:generated.insert', target: { kind: 'project' }, args: { kind: 'thumbnail', jobId: 'j1', atMs: 0 } },
      { op: 'op:text.add', args: { text: 'Di pojok bawah', variant: 'preset:text.subtitle', atMs: 0, durationMs: 3000, position: { x: 0, y: 900 } } },
      { op: 'op:shape.add', args: { presetId: 'preset:shape.circle', atMs: 0, durationMs: 3000, position: { x: 0, y: 1100 }, size: 200 } },
    ];
    const ctx = { model: base, baseVersion: hashModel(base), assets: [IMG], tier: 'T1' as const, lockedKeys: [], newId, jobs: { j1: { kind: 'thumbnail' as const, assetId: 'img' } } };
    const v = validatePlan(planOf(base, ops), ctx);
    expect(v.plan.status).toBe('valid');
    const out = v.plan.steps[0]!.ops;
    const text = out.find((o) => o.op === 'op:text.add')!, shape = out.find((o) => o.op === 'op:shape.add')!;
    expect((text.args['position'] as { y: number }).y).toBeLessThan(900);                     // moved inside the safe area
    expect((shape.args['position'] as { y: number }).y).toBeLessThan(1100);                   // moved inside the frame
    expect(out.find((o) => o.op === 'op:scene.add')!.args).toEqual(ops[1]!.args);             // nothing landed on the wrong op
    const fresh = qualityCheck(v.predicted!.model).filter((q) => q.severity === 'warn' && (q.code === 'outside-safe-area' || q.code === 'off-frame'));
    expect(fresh).toEqual([]);
  });
});

describe('C3 quality-gate fixes respect Locked Keys', () => {
  const setup = () => {
    const base = must(empty(), [{ op: 'op:text.add', args: { text: 'Teks lama', variant: 'preset:text.subtitle', atMs: 0, durationMs: 3000, styleOverrides: { colour: '#FFFFFF' } } }]);
    const plan = planOf(base, [{ op: 'op:background.set', target: { kind: 'project' }, args: { presetId: 'preset:background.solid', params: { colourA: '#FFFFFF' } } }]);
    return { base, plan, id: base.tracks.text[0]!.id };
  };
  it('without a lock the low-contrast existing text gets a colour fix step', () => {
    const { base, plan } = setup();
    const v = validatePlan(plan, { model: base, baseVersion: hashModel(base), assets: [], tier: 'T1', lockedKeys: [], newId });
    expect(v.plan.steps.flatMap((s) => s.ops).some((o) => o.op === 'op:text.setStyle')).toBe(true);
  });
  it('with the colour locked the fix is dropped, the plan stays valid and the risk names the lock', () => {
    const { base, plan, id } = setup();
    const v = validatePlan(plan, { model: base, baseVersion: hashModel(base), assets: [], tier: 'T1', lockedKeys: [`text:${id}.colour`], newId });
    expect(v.plan.status).toBe('valid');
    expect(v.plan.steps.flatMap((s) => s.ops).some((o) => o.op === 'op:text.setStyle')).toBe(false);
    expect(v.plan.risks.find((r) => r.code === 'quality-locked')?.message).toContain(`text:${id}.colour`);
  });
});

describe('C5 / C6 composer timing', () => {
  const scenes = [{ role: 'hook' as const, headline: 'Satu' }, { role: 'body' as const, headline: 'Dua' }, { role: 'cta' as const, headline: 'Tiga' }];
  const timing = (spec: unknown) => {
    const r = composeScenes(spec, { model: empty(), assets: [] });
    if (!r.ok) throw new Error(r.problem);
    const m = must(empty(), r.ops, []);
    return { r, m, t: deriveTiming(m) };
  };
  it('ms 0 and frames 1: hard cuts, no overlap, so the scenes do not drift', () => {
    for (const tr of [{ ms: 0 }, { frames: 1 }]) {
      const { r, m, t } = timing({ style: { transition: tr }, scenes });
      expect(r.ops.filter((o) => o.op === 'op:transition.set')).toEqual([]);
      expect(m.tracks.video.map((c) => c.durationMs)).toEqual(r.scenes.map((s) => s.durationMs));
      expect(t.clipStartMs).toEqual(r.scenes.map((s) => s.startMs));
    }
  });
  it('a long transition is capped at 2000 ms and half of each neighbour; every scene starts where the composer says', () => {
    const { r, m, t } = timing({ style: { transition: { ms: 5000, type: 'preset:transition.fade' } }, scenes: [{ role: 'hook', headline: 'A', durationMs: 3000 }, { role: 'body', headline: 'B', durationMs: 9000 }, { role: 'cta', headline: 'C', durationMs: 9000 }] });
    const tr = r.ops.filter((o) => o.op === 'op:transition.set').map((o) => o.args['durationMs']);
    expect(tr).toEqual([1500, 2000]);
    expect(m.transitions.map((x) => x.durationMs)).toEqual([1500, 2000]);                   // nothing shortened by applyOps
    expect(t.clipStartMs).toEqual(r.scenes.map((s) => s.startMs));
  });
  it('scene lengths stay inside 500…120 000 ms (a 2-minute voice clip, a 100 ms clip with tailMs 0)', () => {
    const r = composeScenes({ voice: { clips: [{ id: 'v1', text: 'panjang sekali', durationMs: 120_000 }, { id: 'v2', text: 'pendek', durationMs: 100 }], tailMs: 0, generate: false },
      scenes: [{ role: 'hook', headline: 'A', clips: ['v1'] }, { role: 'cta', headline: 'B', clips: ['v2'], tailMs: 0 }] }, { model: empty(), assets: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const durs = r.ops.filter((o) => o.op === 'op:scene.add').map((o) => Number(o.args['durationMs']));
    expect(durs.every((d) => d >= 500 && d <= 120_000)).toBe(true);
    expect(r.risks.map((x) => x.code)).toContain('scene-too-long');
    expect(applyOperations(empty(), r.ops, { assets: [], tier: 'T1', newId }).ok).toBe(true);
  });
});

describe('C9 bar chart edge cases', () => {
  it('all 8 bars at heightPx 0 without room and barGapPx 400 (7 gaps wider than the frame) give finite, valid shapes', () => {
    const r = composeScenes({ scenes: [{ role: 'bar-chart', headline: 'Judul yang sangat panjang sekali untuk mengisi seluruh ruang grafik batang ini sampai habis', topPx: 2500,
      barGapPx: 400, bars: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((label) => ({ label, heightPx: 0 })) }] }, { model: empty(), assets: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const o of r.ops.filter((x) => x.op === 'op:shape.add')) for (const k of ['size', 'height']) expect(Number.isFinite(Number(o.args[k]))).toBe(true);
    expect(applyOperations(empty(), r.ops, { assets: [], tier: 'T1', newId }).ok).toBe(true);
  });
});

describe('A7 VideoSpec voice clip ids are unique', () => {
  it('two clips named v1 are rejected with a message naming the id', () => {
    const r = composeScenes({ voice: { clips: [{ id: 'v1', text: 'satu' }, { id: 'v1', text: 'dua' }] }, scenes: [{ role: 'hook', headline: 'A', clips: ['v1'] }] }, { model: empty(), assets: [] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problem).toMatch(/v1/);
  });
});

describe('C7 more than 8 native tool calls in one reply', () => {
  it('every call gets a tool_result: the first 8 run, the rest get an error result', async () => {
    const calls = Array.from({ length: 12 }, (_, i) => ({ id: `toolu_${i}`, name: 'assets_list', input: {} }));
    let ran = 0;
    const records: unknown[] = [];
    const out = await runToolCalls(calls, { 'assets.list': () => { ran++; return []; } }, EDITOR_TOOL_NAMES, () => undefined, records as never);
    expect(out.map((x) => x.id)).toEqual(calls.map((c) => c.id));
    expect(ran).toBe(MAX_TOOL_CALLS_PER_TURN);
    expect(out.slice(MAX_TOOL_CALLS_PER_TURN).every((x) => x.isError === true && x.content.includes('EM-4503'))).toBe(true);
    expect(out.slice(0, MAX_TOOL_CALLS_PER_TURN).every((x) => !x.isError)).toBe(true);
  });
});
