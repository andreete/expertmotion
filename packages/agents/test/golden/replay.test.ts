// GOLDEN_SCENARIOS §4.2 harness (b) at package level: the agent half of GS-08, 09, 10, 17, 18, 20 with the fake provider.
// The service-level half (DB rows, SSE, HTTP) lives in apps/service/test/s1.
import { describe, expect, it } from 'vitest';
import { applyOperations, hashModel, type OperationT } from '@expertmotion/composition-model';
import { buildRewriteEnvelope, createIntents, enqueue, fakeProvider, mapProviderError, runBrainstorm, runEditorAgent, validatePlan, planOps } from '../../src/index.js';
import { Scenario, expectOk } from './harness.js';

function b1() {
  const s = new Scenario();
  const ops: OperationT[] = ['FX-V3', 'FX-V1', 'FX-V2'].map((assetId, atIndex) => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId, atIndex } }));
  const r = applyOperations(s.model, ops, { assets: s.assets, tier: s.tier, newId: s.newId });
  if (!r.ok) throw new Error('fixture');
  s.model = r.value.model; s.versions.push(hashModel(s.model));
  return s;
}
/** B3: push-cut 400 ms on both cuts set by an agent plan (not Locked). */
function b3() {
  const s = b1();
  const r = applyOperations(s.model, [0, 1].map((index) => ({ op: 'op:transition.set', target: { kind: 'cut', index }, args: { presetId: 'preset:transition.push-cut', durationMs: 400 } })), { assets: s.assets, tier: s.tier, newId: s.newId });
  if (!r.ok) throw new Error('b3');
  s.model = r.value.model; s.versions.push(hashModel(s.model));
  return s;
}
function b2() {
  const s = new Scenario();
  const ops: OperationT[] = ['FX-V3', 'FX-V1', 'FX-V2'].map((assetId, atIndex) => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId, atIndex } }));
  const r = applyOperations(s.model, ops, { assets: s.assets, tier: s.tier, newId: s.newId });
  if (!r.ok) throw new Error('fixture');
  s.model = r.value.model; s.versions.push(hashModel(s.model));
  expectOk(s.pick({ presetId: 'preset:transition.fade' }));
  return s;
}
const envFor = (s: Scenario, creatorMessage: string) => buildRewriteEnvelope({ model: s.model, baseVersion: s.head, assets: s.assets, intents: s.queue, lockedKeys: s.lockedKeys, creatorMessage, tier: s.tier });
const ctxFor = (s: Scenario) => ({ model: s.model, baseVersion: s.head, assets: s.assets, tier: s.tier, lockedKeys: s.lockedKeys, newId: s.newId, planId: 'pl', projectId: 'gs' });
const reply = (base: string, ops: unknown[], risks: unknown[] = []) => JSON.stringify({ goal: 'g', steps: [{ n: 1, tool: 'composition.applyOps', ops, expectedDiff: 'd' }], risks, baseVersion: base });

describe('GS-08 brainstorm → handoff → plan', () => {
  it('proposals become brainstorm intents; the deterministic ones compile without the Editor Agent', async () => {
    const s = b2();
    const turn = JSON.stringify({ reply: 'Usul: judul energik + transisi push.', proposedIntents: [
      { category: 'transition', presetId: 'preset:transition.push-cut', needsInterpretation: false, source: 'brainstorm' },
      { category: 'text', presetId: 'preset:text.title', needsInterpretation: true, instruction: 'judul energik untuk review HP', source: 'brainstorm' }], suggestedNextStep: 'send-to-editor' });
    const b = await runBrainstorm([{ role: 'user', content: 'buat intro energik untuk video review HP' }], { durationMs: s.durationMs }, 'id', fakeProvider([turn]));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const proposals = b.turn.proposedIntents ?? [];
    expect(proposals).toHaveLength(2);
    const created = proposals.flatMap((p) => { const r = createIntents({ projectId: 'gs', source: 'brainstorm', ...(p.presetId ? { presetId: p.presetId } : {}), ...(p.instruction ? { instruction: p.instruction } : {}), category: p.category }, { model: s.model, baseVersion: s.head, newId: s.newId }); return r.ok ? r.value : []; });
    const q = enqueue(s.queue, created);
    expect(q.filter((i) => i.source === 'brainstorm' && i.needsInterpretation).length).toBeGreaterThan(0);
    // Brainstorm push-cut supersedes the Creator's fade children? No: brainstorm intents never override Locked Keys (AI_WORKFLOW §6).
    const env = buildRewriteEnvelope({ model: s.model, baseVersion: s.head, assets: s.assets, intents: q, lockedKeys: s.lockedKeys, tier: s.tier });
    expect(env.lockedKeys).toEqual(expect.arrayContaining(['cut:0.transition', 'cut:1.transition']));
  });
});

describe('GS-09 locked cut respected', () => {
  it('a plan that rewrites the locked cut is re-prompted and the final plan leaves it alone', async () => {
    const s = b3();
    // Creator picked Slide on cut 0 only (locked); cut 1 is agent-set push-cut; the agent is asked to change "all transitions".
    expectOk(s.pick({ presetId: 'preset:transition.slide', selection: [{ kind: 'clip', id: s.model.tracks.video[0]!.id }] }));
    expect(s.lockedKeys).toEqual(['cut:0.transition']);
    expect(s.durationMs).toBe(18_100);
    const wipe = (i: number) => ({ op: 'op:transition.set', target: { kind: 'cut', index: i }, args: { presetId: 'preset:transition.wipe', durationMs: 500, params: { direction: 'from-left' } } });
    const prov = fakeProvider([reply(s.head, [wipe(0), wipe(1)]), reply(s.head, [wipe(1)])]);
    const r = await runEditorAgent(envFor(s, 'ganti semua transisi jadi wipe dari kiri'), prov, ctxFor(s));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(prov.calls).toHaveLength(2);
    expect(planOps(r.plan).map((o) => o.target)).toEqual([{ kind: 'cut', index: 1 }]);
    expect(r.plan.touchesLockedKeys).toEqual([]);
  });
});

describe('GS-10 stale plan after an Insert', () => {
  it('a plan on the old base version is stale (EM-2301) once the head moved', () => {
    const s = b2(); const oldHead = s.head;
    const plan = { id: 'p', projectId: 'gs', origin: 'agent' as const, baseVersion: oldHead, goal: 'g', steps: [{ n: 1, tool: 'composition.applyOps' as const, ops: [{ op: 'op:transition.set', target: { kind: 'cut', index: 1 }, args: { presetId: 'preset:transition.wipe', durationMs: 500 } }] as OperationT[], expectedDiff: 'd' }], risks: [], touchesLockedKeys: [], status: 'draft' as const };
    const a = applyOperations(s.model, [{ op: 'op:clip.insert', args: { assetId: 'FX-V2' } }], { assets: s.assets, tier: s.tier, newId: s.newId });
    if (!a.ok) throw new Error('insert');
    s.model = a.value.model; s.versions.push(hashModel(s.model));
    const v = validatePlan(plan as never, { model: s.model, baseVersion: s.head, assets: s.assets, tier: s.tier, lockedKeys: [], newId: s.newId });
    expect(v.plan.status).toBe('stale');
    expect(v.issues[0]?.code).toBe('EM-2301');
  });
});

describe('GS-17 failure mid-plan rolls back', () => {
  it('an op that fails after valid ones leaves the model and head unchanged', () => {
    const s = b2(); const before = s.head; const snapshot = JSON.stringify(s.model);
    const r = applyOperations(s.model, [
      { op: 'op:transition.set', target: { kind: 'cut', index: 1 }, args: { presetId: 'preset:transition.wipe', durationMs: 500 } },
      { op: 'op:effect.setParams', target: { kind: 'clip', id: 'missing' }, args: { presetId: 'preset:effect.vignette', params: {} } }], { assets: s.assets, tier: s.tier, newId: s.newId });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(s.model)).toBe(snapshot);
    expect(hashModel(s.model)).toBe(before);
  });
});

describe('GS-18 budget exceeded', () => {
  it('EM-4201 stops the Editor Agent before any provider call', async () => {
    const s = b2(); const prov = fakeProvider(['{}']);
    const r = await runEditorAgent(envFor(s, 'tambah judul'), prov, ctxFor(s), { budgetCheck: () => { throw mapProviderError(Object.assign(new Error('budget'), { statusCode: 402 })); } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('EM-4201');
    expect(prov.calls).toHaveLength(0);
  });
});

describe('GS-20 English request: captions pop + soft bed ducked under voice', () => {
  it('bed without an asset needs the Editor Agent; with FX-M1 it compiles to addBed', () => {
    const s = b2();
    const no = expectOk(s.pick({ presetId: 'preset:caption.karaoke' }));
    expect(no.ops[0]!.op).toBe('op:caption.setStyle');
    const r = createIntents({ projectId: 'gs', source: 'editor', presetId: 'preset:audio.bed-soft' }, { model: s.model, baseVersion: s.head, newId: s.newId });
    expect(r.ok && r.value[0]!.needsInterpretation).toBe(true);
    const bed = expectOk(s.pick({ presetId: 'preset:audio.bed-soft', assetId: 'FX-M1' }));
    expect(bed.ops[0]).toMatchObject({ op: 'op:audio.addBed', args: { assetId: 'FX-M1' } });
    expect(s.model.tracks.audio.some((a) => a.role === 'bed')).toBe(true);
    const duck = expectOk(s.pick({ presetId: 'preset:audio.duck-voice' }));
    expect(duck.ops).toHaveLength(1);
  });
});
