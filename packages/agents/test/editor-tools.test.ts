// FR-080 Editor Agent read-only tool loop (incl. composition.validateOps), FR-072 image parts, FR-081 EM-2302 dropped steps,
// FR-084 streamed plan goal, FR-080 chat intents and envelope selection/playhead. Fake provider only; no network.
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, hashModel, type AssetFacts, type CompositionModelT } from '@expertmotion/composition-model';
import { buildRewriteEnvelope, chatIntent, fakeProvider, runEditorAgent, runBrainstorm, toSdkMessages, type ToolHandlers } from '../src/index.js';

const ASSETS: AssetFacts[] = [
  { id: 'a1', kind: 'video', status: 'ready', durationMs: 10_000, name: 'unboxing.mp4', hasAudio: true },
  { id: 'a2', kind: 'video', status: 'ready', durationMs: 6000, name: 'fitur.mp4' },
];
let n = 0; const newId = () => `t${++n}`;
function base(): CompositionModelT {
  const r = applyOperations(createEmptyModel('p1', { autoRatio: false }), [{ op: 'op:clip.insert', args: { assetId: 'a1', durationMs: 8000 } }, { op: 'op:clip.insert', args: { assetId: 'a2' } }], { assets: ASSETS, tier: 'T1', newId });
  if (!r.ok) throw new Error('fixture'); return r.value.model;
}
const setup = (locked: string[] = [], extra: Parameters<typeof buildRewriteEnvelope>[0] extends infer X ? Partial<X> : never = {}) => {
  const m = base(); const h = hashModel(m);
  return { m, h, env: buildRewriteEnvelope({ model: m, baseVersion: h, assets: ASSETS, intents: [], lockedKeys: locked, creatorMessage: 'judul pembuka', tier: 'T1', ...extra }),
    ctx: { model: m, baseVersion: h, assets: ASSETS, tier: 'T1' as const, lockedKeys: locked, newId, planId: 'pl1', projectId: 'p1' } };
};
const fade = (h: string, steps: number[][] = [[0]]) => JSON.stringify({ goal: 'Transisi pudar yang halus', baseVersion: h, risks: [],
  steps: steps.map((cuts, i) => ({ n: i + 1, tool: 'composition.applyOps', expectedDiff: `Fade on cut ${cuts.join(',')}`, ops: cuts.map((c) => ({ op: 'op:transition.set', target: { kind: 'cut', index: c }, args: { presetId: 'preset:transition.fade', durationMs: 400 } })) })) });
const tools: ToolHandlers = { 'assets.list': () => ASSETS.map((a) => ({ id: a.id, kind: a.kind })) };

describe('Editor Agent tool loop (FR-080)', () => {
  it('dry-runs operations with composition.validateOps, then returns the plan; tool rounds are not corrections', async () => {
    const { h, env, ctx } = setup();
    const req = JSON.stringify({ tool: 'composition.validateOps', input: { baseVersion: h, ops: [{ op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.fade', durationMs: 400 } }] } });
    const prov = fakeProvider([JSON.stringify({ tool: 'assets.list', input: {} }), req, fade(h)]);
    const r = await runEditorAgent(env, prov, ctx, { tools });
    expect(r.ok).toBe(true);
    expect(r.ok && r.attempts).toBe(1);
    expect(r.toolCalls.map((c) => [c.name, c.ok])).toEqual([['assets.list', true], ['composition.validateOps', true]]);
    expect(r.toolCalls[1]!.output).toMatchObject({ ok: true, predictedDiff: [expect.objectContaining({ change: expect.any(String) })] });
    expect(prov.calls[0]!.system).toContain('composition.validateOps');
    expect(prov.calls[2]!.messages.at(-1)!.content).toContain('"toolResult"');
  });
  it('a wrong base echoed to validateOps is ignored (the runtime owns the base, QA 2026-10-26); a mutating tool is refused without failing the run', async () => {
    const { h, env, ctx } = setup();
    const prov = fakeProvider([JSON.stringify({ tool: 'composition.validateOps', input: { baseVersion: 'old', ops: [] } }), JSON.stringify({ tool: 'composition.applyOps', input: {} }), fade(h)]);
    const r = await runEditorAgent(env, prov, ctx, { tools });
    expect(r.ok).toBe(true);
    expect(r.toolCalls[0]!.output).not.toMatchObject({ issues: [{ code: 'EM-2301' }] });
    expect(r.toolCalls[1]!.output).toMatchObject({ error: { code: 'EM-4502' } });
  });
  it('without tools the prompt has no tool block (golden replay unchanged)', async () => {
    const { h, env, ctx } = setup();
    const prov = fakeProvider([fade(h)]);
    await runEditorAgent(env, prov, ctx);
    expect(prov.calls[0]!.system).not.toContain('Read-only tools');
  });
});

describe('FR-072 images, FR-084 streamed goal, FR-081 dropped steps', () => {
  it('images go on the first user message as image parts', async () => {
    const { h, env, ctx } = setup();
    const prov = fakeProvider([fade(h)]);
    await runEditorAgent(env, prov, ctx, { images: [{ mediaType: 'image/png', data: 'iVBORw0K', name: 'logo.png' }] });
    expect(prov.calls[0]!.messages[0]!.images).toEqual([{ mediaType: 'image/png', data: 'iVBORw0K', name: 'logo.png' }]);
    expect(toSdkMessages(prov.calls[0]!.messages)[0]).toEqual({ role: 'user', content: [{ type: 'text', text: prov.calls[0]!.messages[0]!.content }, { type: 'image', image: 'iVBORw0K', mediaType: 'image/png' }] });
    expect(toSdkMessages([{ role: 'assistant', content: 'x' }])).toEqual([{ role: 'assistant', content: 'x' }]);
    const b = fakeProvider([JSON.stringify({ reply: 'ok' })]);
    await runBrainstorm([{ role: 'user', content: 'lihat logo ini' }], {}, 'id', b, { images: [{ mediaType: 'image/png', data: 'AAAA' }] });
    expect(b.calls[0]!.messages.at(-1)!.images).toHaveLength(1);
  });
  it('streams only the plan goal', async () => {
    const { h, env, ctx } = setup();
    let seen = '';
    await runEditorAgent(env, fakeProvider([fade(h)]), ctx, { onDelta: (d) => { seen += d; } });
    expect(seen).toBe('Transisi pudar yang halus');
  });
  it('a partly locked plan keeps the free steps and lists the dropped one as an EM-2302 validation entry', async () => {
    const m = base();
    const r0 = applyOperations(m, [{ op: 'op:clip.insert', args: { assetId: 'a2' } }], { assets: ASSETS, tier: 'T1', newId });
    if (!r0.ok) throw new Error('fixture');
    const m3 = r0.value.model; const h = hashModel(m3);
    const env = buildRewriteEnvelope({ model: m3, baseVersion: h, assets: ASSETS, intents: [], lockedKeys: ['cut:0.transition'], tier: 'T1' });
    const ctx = { model: m3, baseVersion: h, assets: ASSETS, tier: 'T1' as const, lockedKeys: ['cut:0.transition'], newId, planId: 'pl2', projectId: 'p1' };
    const r = await runEditorAgent(env, fakeProvider([fade(h, [[0], [1]]), fade(h, [[0], [1]])]), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.map((s) => s.n)).toEqual([2]);
    expect(r.plan.validation).toContainEqual({ path: 'droppedSteps[1]', code: 'EM-2302', message: '1. Fade on cut 0 (cut:0.transition)' });
  });
});

describe('FR-080 chat intent and envelope', () => {
  it('chat message → EditIntent source chat, propertyKey chat:<id>, needsInterpretation; target wins over selection', () => {
    const i = chatIntent({ projectId: 'p1', messageId: 'M1', text: 'buat lebih cepat', target: { kind: 'clip', id: 'c2' }, selection: [{ kind: 'text', id: 'x' }], baseVersion: 'h', newId: () => 'I1', now: () => '2026-10-24T00:00:00.000Z' });
    expect(i).toMatchObject({ id: 'I1', source: 'chat', category: 'layout', propertyKey: 'chat:M1', needsInterpretation: true, instruction: 'buat lebih cepat', status: 'queued', target: { kind: 'clip', id: 'c2' }, resolvedTargets: [{ kind: 'clip', id: 'c2' }] });
    expect(chatIntent({ projectId: 'p1', messageId: 'M2', text: 'x', baseVersion: 'h', newId: () => 'I2', now: () => '2026-10-24T00:00:00.000Z' }).target).toEqual({ kind: 'project' });
  });
  it('selection, playhead and attachment names are in the envelope only when given', () => {
    const { env } = setup([], { selection: [{ kind: 'clip', id: 'c1' }], playheadMs: 3000.4, attachments: ['logo.png'] });
    expect(env).toMatchObject({ selection: [{ kind: 'clip', id: 'c1' }], playheadMs: 3000, attachments: ['logo.png'] });
    const { env: plain } = setup();
    expect('selection' in plain || 'playheadMs' in plain || 'attachments' in plain).toBe(false);
  });
});

describe('assets.probe (Editor Agent only)', () => {
  it('is offered to the Editor Agent, not the Brainstorming Agent, and validates its input', async () => {
    const { EDITOR_TOOL_NAMES, BRAINSTORM_TOOL_NAMES, runTool } = await import('../src/tools.js');
    expect(EDITOR_TOOL_NAMES).toContain('assets.probe');
    expect(BRAINSTORM_TOOL_NAMES as readonly string[]).not.toContain('assets.probe');
    const handlers = { 'assets.probe': (i: Record<string, unknown>) => ({ id: i['assetId'], fps: 30 }) };
    expect((await runTool('assets.probe', { assetId: 'a1' }, handlers, EDITOR_TOOL_NAMES)).output).toEqual({ id: 'a1', fps: 30 });
    expect((await runTool('assets.probe', {}, handlers, EDITOR_TOOL_NAMES)).ok).toBe(false);
    expect((await runTool('assets.probe', { assetId: 'a1' }, handlers)).ok).toBe(false);
  });
});
