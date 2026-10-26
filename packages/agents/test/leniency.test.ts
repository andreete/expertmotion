// QA 2026-10-26 #4/#5: what real models (Claude Haiku 4.5) write is repaired when unambiguous; the rest goes back to the model
// with a message that names the step, the op and its exact args (plan-normalize.ts, runner.ts correctionMessage).
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, hashModel, type OperationT } from '@expertmotion/composition-model';
import { buildRewriteEnvelope, fakeProvider, normalizeModelReply, opArgsTable, parseModelReply, planOps, resolvePointedTargets, runEditorAgent, scriptPages } from '../src/index.js';
import { FIXTURES } from './golden/harness.js';

function twoClips() {
  let n = 0; const newId = () => `c${++n}`;
  const r = applyOperations(createEmptyModel('p', { autoRatio: false }), ['FX-V1', 'FX-V2'].map((assetId): OperationT => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId } })), { assets: FIXTURES, tier: 'T1', newId });
  if (!r.ok) throw new Error('fixture');
  const model = r.value.model; const base = hashModel(model);
  return { model, base, ctx: { model, baseVersion: base, assets: FIXTURES, tier: 'T1' as const, lockedKeys: [], newId: () => `n${++n}`, planId: 'pl', projectId: 'p', language: 'id' as const } };
}
const parse = (text: string, f = twoClips()) => parseModelReply(text, { id: 'pl', projectId: 'p' }, { model: f.model, baseVersion: f.base, assets: FIXTURES });

describe('lenient plan parsing (unambiguous repairs only)', () => {
  it('code fence with prose, missing n / expectedDiff / risks / baseVersion, "op:" missing, args at the top level, near-miss names, short preset ids', () => {
    const r = parse('Oke, ini rencananya:\n```json\n{"goal":"Tambah judul dan transisi","steps":[{"tool":"applyOps","ops":[{"op":"text.add","content":"Halo","startMs":0,"duration":3000,"variant":"title"},{"op":"op:transition.set","target":{"kind":"cut","index":0},"args":{"preset":"fade"}}]}]}\n```');
    expect(r.problem).toBeUndefined();
    expect(planOps(r.plan!)).toEqual([
      { op: 'op:text.add', args: { text: 'Halo', atMs: 0, durationMs: 3000, variant: 'preset:text.title' } },
      { op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.fade', durationMs: 500 } }]);
    expect(r.plan!.steps[0]).toMatchObject({ n: 1, tool: 'composition.applyOps', expectedDiff: '' });
    expect(r.fixes!.length).toBeGreaterThan(3);
  });
  it('wrapped plan, a step that is one op, "params" for args, string targets, asset ids for clips, percent volume, long texts clipped', () => {
    const f = twoClips();
    const long = 'x'.repeat(260);
    const r = parse(JSON.stringify({ plan: { goal: long + long, steps: [
      { op: 'op:clip.setVolume', target: { kind: 'clip', id: 'FX-V1', name: 'kota-pagi.mp4' }, params: { volume: 40 }, expectedDiff: long },
      { tool: 'composition.applyOps', ops: [{ op: 'op:text.setContent', target: 'nope', args: { text: 'a' } }, { op: 'op:clip.setPlaybackRate', target: f.model.tracks.video[1]!.id, args: { speed: '2' } }] }] } }), f);
    expect(r.problem).toBeUndefined();
    const ops = planOps(r.plan!);
    expect(ops[0]).toEqual({ op: 'op:clip.setVolume', target: { kind: 'clip', id: f.model.tracks.video[0]!.id }, args: { volume: 0.4 } });
    expect(ops[1]).toMatchObject({ target: { kind: 'text', id: 'nope' } });
    expect(ops[2]).toEqual({ op: 'op:clip.setPlaybackRate', target: { kind: 'clip', id: f.model.tracks.video[1]!.id }, args: { rate: 2 } });
    expect(r.plan!.goal.length).toBeLessThanOrEqual(300);
    expect(r.plan!.steps[0]!.expectedDiff.length).toBeLessThanOrEqual(200);
  });
  it('risks as strings and questions become risks; a top-level ops array becomes one step; the model base is never trusted', () => {
    const f = twoClips();
    const n = normalizeModelReply({ goal: 'g', ops: [{ op: 'op:background.set', args: { presetId: 'grid' } }], risks: ['hati-hati'], questions: ['Musik apa?'], baseVersion: 'old' }, { model: f.model, baseVersion: f.base });
    expect(n.value).toMatchObject({ baseVersion: f.base, steps: [{ n: 1, ops: [{ op: 'op:background.set', target: { kind: 'project' }, args: { presetId: 'preset:background.grid' } }] }],
      risks: [{ code: 'note', message: 'hati-hati', severity: 'info' }, { code: 'needs-input', message: 'Musik apa?', severity: 'warn' }] });
  });
  it('intents instead of a plan: fully specified ones compile without another model call', async () => {
    const f = twoClips();
    const env = buildRewriteEnvelope({ model: f.model, baseVersion: f.base, assets: FIXTURES, intents: [], lockedKeys: [], creatorMessage: 'pakai transisi fade', tier: 'T1' });
    const prov = fakeProvider([JSON.stringify({ intents: [{ category: 'transition', presetId: 'preset:transition.fade', target: { kind: 'cut', index: 0 } }] })]);
    const r = await runEditorAgent(env, prov, f.ctx);
    expect(r.ok && planOps(r.plan)).toMatchObject([{ op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.fade' } }]);
    expect(prov.calls).toHaveLength(1);
    expect(r.diagnostics.intentsReturned).toBe(true);
  });
  it('the correction message names the step, the op and its exact args; the second reply is accepted; diagnostics record the codes', async () => {
    const f = twoClips();
    const env = buildRewriteEnvelope({ model: f.model, baseVersion: f.base, assets: FIXTURES, intents: [], lockedKeys: [], creatorMessage: 'judul', tier: 'T1' });
    const bad = JSON.stringify({ goal: 'g', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:text.add', args: { text: 'Halo', variant: 'preset:text.title', atMs: 0, durationMs: 50, colour: 'red' } }], expectedDiff: 'd' }] });
    const good = JSON.stringify({ goal: 'g', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:text.add', args: { text: 'Halo', variant: 'preset:text.title', atMs: 0, durationMs: 3000 } }], expectedDiff: 'd' }] });
    const prov = fakeProvider([bad, good]);
    const r = await runEditorAgent(env, prov, f.ctx);
    expect(r.ok).toBe(true);
    const msg = prov.calls[1]!.messages.at(-1)!.content;
    expect(msg).toContain('step 1, op 1 (op:text.add)');
    expect(msg).toContain('Expected: op:text.add {text: string, variant: preset id, atMs: int');
    expect(msg).toContain('Ignored argument names');
    expect(r.diagnostics.attempts).toBe(2);
  });
  it('an unknown op reaches EM-4301 after the corrections, with the last codes in the details', async () => {
    const f = twoClips();
    const env = buildRewriteEnvelope({ model: f.model, baseVersion: f.base, assets: FIXTURES, intents: [], lockedKeys: [], creatorMessage: 'blur', tier: 'T1' });
    const r = await runEditorAgent(env, fakeProvider([JSON.stringify({ goal: 'g', steps: [{ ops: [{ op: 'op:clip.blur', args: {} }] }] })]), f.ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('EM-4301');
    expect(r.diagnostics.lastIssues[0]).toMatchObject({ code: 'EM-2303' });
  });
  it('the envelope carries every op signature', () => {
    const t = opArgsTable();
    expect(Object.keys(t)).toHaveLength(51);
    expect(t['op:clip.setVolume']).toBe("{volume: number 0..1, fadeInMs?: int 0.., fadeOutMs?: int 0..} target: clip");
  });
});

describe('FR-189 pointing: targets in the envelope and a question instead of a failure', () => {
  it('targets resolve with facts; an asset target lists the clip that shows it; gone ids are flagged', () => {
    const f = twoClips();
    const t = resolvePointedTargets([{ kind: 'asset', id: 'FX-V2', label: 'unboxing-hp.mp4' }, { kind: 'clip', id: f.model.tracks.video[0]!.id, label: 'Klip 1' }, { kind: 'text', id: 'gone', label: 'Judul' }, { kind: 'asset', id: 'FX-M1', label: 'bed-lofi.mp3' }], f.model, FIXTURES);
    expect(t[0]).toMatchObject({ facts: { assetKind: 'video', onTimeline: [{ kind: 'clip', id: f.model.tracks.video[1]!.id }] } });
    expect(t[1]).toMatchObject({ facts: { order: 1, asset: 'kota-pagi.mp4', startMs: 0 } });
    expect(t[2]).toMatchObject({ missing: true });
    expect(t[3]).toMatchObject({ facts: { onTimeline: [] } });
    const env = buildRewriteEnvelope({ model: f.model, baseVersion: f.base, assets: FIXTURES, intents: [], lockedKeys: [], creatorMessage: 'kecilkan suara ini', tier: 'T1', targets: [{ kind: 'clip', id: f.model.tracks.video[0]!.id, label: 'Klip 1' }] });
    expect(env.targets).toHaveLength(1);
    expect(env.constraints.join(' ')).toContain('"klip ini"');
  });
  it('"kecilkan suara ini" with @Klip 1 → the model targets the clip; a vague "ubah ini" that yields no plan → one short question', async () => {
    const f = twoClips();
    const clipId = f.model.tracks.video[0]!.id;
    const env = buildRewriteEnvelope({ model: f.model, baseVersion: f.base, assets: FIXTURES, intents: [], lockedKeys: [], creatorMessage: 'kecilkan suara ini', tier: 'T1', targets: [{ kind: 'clip', id: clipId, label: 'Klip 1' }] });
    const ok = await runEditorAgent(env, fakeProvider([JSON.stringify({ goal: 'Mengecilkan suara Klip 1', steps: [{ ops: [{ op: 'op:clip.setVolume', target: { kind: 'clip', id: clipId }, args: { volume: 0.3 } }] }] })]), f.ctx);
    expect(ok.ok && planOps(ok.plan)[0]).toMatchObject({ target: { id: clipId }, args: { volume: 0.3 } });
    const vague = { ...env, creatorMessage: 'ubah ini' };
    const r = await runEditorAgent(vague, fakeProvider(['Maaf, saya tidak yakin.']), f.ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps).toHaveLength(0);
    expect(r.plan.risks).toEqual([expect.objectContaining({ code: 'needs-input', severity: 'block' })]);
    expect(r.plan.risks[0]!.message).toContain('Klip 1');
    expect(r.diagnostics.fallbackQuestion).toBe(true);
  });
});

describe('captions from a script (deterministic Caption Sub-agent)', () => {
  it('pages ≤ 5 words, break after sentences, ordered, inside the window', () => {
    const p = scriptPages('Tagihan listrik bengkak? Coba tiga tips ini sekarang juga ya teman.', 1000, 9000);
    expect(p.map((x) => x.text.trim())).toEqual(['Tagihan listrik bengkak?', 'Coba tiga tips ini sekarang', 'juga ya teman.']);
    expect(p[0]!.startMs).toBe(1000);
    expect(p.at(-1)!.startMs + p.at(-1)!.durationMs).toBe(9000);
    for (let i = 1; i < p.length; i++) expect(p[i]!.startMs).toBeGreaterThanOrEqual(p[i - 1]!.startMs + p[i - 1]!.durationMs);
    expect(scriptPages('', 0, 1000)).toEqual([]);
  });
});
