// Entry 25b (live QA with free OpenRouter models, 2026-10-26): the Editor Agent on an EMPTY project must turn real model replies
// into a valid faceless plan. The golden fixture is a raw reply captured live (nemotron-3-ultra :free); the other cases are the
// reply shapes the free models produced or are known to produce: reasoning in <think>, several JSON objects, a reply cut off at
// the output limit, preset params with unknown names / out-of-range values, and replies with no JSON at all.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOperations } from '@expertmotion/composition-model';
import { repairJsonClosers, stripReasoning } from '@expertmotion/shared';
import { EDITOR_MAX_TOKENS, MAX_TOOL_ROUNDS, buildRewriteEnvelope, extractJson, runBrainstorm, correctionMessage, extractPlanJson, fakeProvider, mapProviderError, normalizeModelReply, parseModelReply, planOps, repairPresetParams, retryAfterMsOf, runEditorAgent, withRateLimitRetry, type ChatProvider, type ChatRequest, type EditPlanT } from '../src/index.js';
import { Scenario } from './golden/harness.js';

const RUN6 = JSON.parse(fs.readFileSync(new URL('./golden/fixtures/live-nemotron-ultra-run6.json', import.meta.url), 'utf8')) as { replies: Array<{ text: string }> };
const RUN8 = JSON.parse(fs.readFileSync(new URL('./golden/fixtures/live-nemotron-ultra-run8.json', import.meta.url), 'utf8')) as { replies: Array<{ text: string }>; thenProvider: { error: { details: { reason: string } } } };
const LIVE = JSON.parse(fs.readFileSync(new URL('./golden/fixtures/live-nemotron-ultra-faceless.json', import.meta.url), 'utf8')) as { content: string; reasoningTail: string; model: string };

function setup() {
  const s = new Scenario({ ratio: '9:16', assets: [] });
  const env = buildRewriteEnvelope({ model: s.model, baseVersion: s.head, assets: [], intents: [], lockedKeys: [], creatorMessage: 'Buat videonya sekarang dari ide tadi: hook, 3 adegan tips, dan penutup ajakan.', tier: s.tier });
  const ctx = { model: s.model, baseVersion: s.head, assets: [], tier: s.tier, lockedKeys: [], newId: s.newId, planId: 'pl', projectId: 'gs', language: 'id' as const };
  return { s, env, ctx };
}
const apply = (s: Scenario, p: EditPlanT) => { const a = applyOperations(s.model, planOps(p), { assets: [], tier: s.tier, newId: s.newId }); if (!a.ok) throw new Error(JSON.stringify(a.issues)); return a.value.model; };
/** A fake provider that also reports a finish reason (the real adapters do). */
const withFinish = (items: Array<{ text: string; finishReason?: string }>): ChatProvider & { calls: ChatRequest[] } => {
  const calls: ChatRequest[] = [];
  return { id: 'fake', model: 'fake/model', calls, async complete(req) { const r = items[Math.min(calls.length, items.length - 1)]!; calls.push(req); return { text: r.text, usage: { model: 'fake/model', inputTokens: 1, outputTokens: 1, costUsd: 0, approximate: false }, ...(r.finishReason ? { finishReason: r.finishReason } : {}) }; } };
};

describe('live free-model replies → valid faceless plan (empty project)', () => {
  it('golden: the captured nemotron-3-ultra reply is valid on the first attempt and builds ≥ 3 scenes with text and transitions', async () => {
    const { s, env, ctx } = setup();
    const prov = fakeProvider([LIVE.content]);
    const r = await runEditorAgent(env, prov, ctx);
    expect(r.ok && r.plan.status).toBe('valid');
    if (!r.ok) return;
    expect(r.attempts).toBe(1);
    expect(prov.calls[0]!.maxTokens).toBe(EDITOR_MAX_TOKENS);                       // room for reasoning tokens + the plan
    const m = apply(s, r.plan);
    expect(m.tracks.video.filter((c) => c.scene).length).toBeGreaterThanOrEqual(3);
    expect(m.tracks.text.length).toBeGreaterThanOrEqual(3);
    expect(m.transitions.length).toBeGreaterThanOrEqual(2);
  });

  it('golden (run 6): a tool call with wrong closing brackets is read as the tool call, and colors / color / speed params are repaired → valid', async () => {
    const { s, env, ctx } = setup();
    const [toolCall, planText] = RUN6.replies.map((r) => r.text);
    expect(extractJson(toolCall!)).toMatchObject({ tool: 'composition.validateOps' });
    const prov = fakeProvider([toolCall!, planText!]);
    const r = await runEditorAgent(env, prov, ctx, { tools: {} });
    expect(r.ok && r.plan.status).toBe('valid');
    if (!r.ok) return;
    expect(r.diagnostics.parseFailures).toBe(0);
    expect(r.toolCalls.map((c) => c.name)).toEqual(['composition.validateOps']);
    expect(prov.calls[1]!.messages.at(-1)!.content).toContain('composition.validateOps');
    const bg = r.plan.steps[0]!.ops.map((o) => (o.args as Record<string, unknown>)['backgroundParams']);
    expect(bg[0]).toEqual({ colourA: '#0066FF', colourB: '#00CC99', angle: 45 });       // speed dropped (no such param)
    expect(bg[1]).toEqual({ colourA: '#1E1E1E' });
    const m = apply(s, r.plan);
    expect(m.tracks.video.filter((c) => c.scene).length).toBe(5);
    expect(m.tracks.text.length).toBeGreaterThanOrEqual(5);
  });

  it('golden (run 8): captions.generate {stylePreset} without a script → presetId, captions from the scene texts, plan valid', async () => {
    const { s, env, ctx } = setup();
    const r = await runEditorAgent(env, fakeProvider(RUN8.replies.map((x) => x.text)), ctx, { tools: {} });
    expect(r.ok && r.plan.status).toBe('valid');
    if (!r.ok) return;
    const ops = planOps(r.plan);
    expect(ops.some((o) => o.op === 'op:caption.setPages')).toBe(true);
    expect(ops.find((o) => o.op === 'op:caption.setStyle')?.args).toEqual({ presetId: 'preset:caption.editorial' });
    const m = apply(s, r.plan);
    expect(m.tracks.video.filter((c) => c.scene).length).toBeGreaterThanOrEqual(3);
    expect(m.tracks.caption.pages.length).toBeGreaterThan(0);
  });
  it('captions with nothing to caption are left out with a warning instead of blocking the plan', async () => {
    const { env, ctx } = setup();
    const plan = { goal: 'x', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:background.set', target: { kind: 'project' }, args: { presetId: 'preset:background.gradient' } }] }, { n: 2, tool: 'captions.generate', args: { style: 'editorial' } }] };
    const r = await runEditorAgent(env, fakeProvider([JSON.stringify(plan)]), ctx);
    expect(r.ok && r.plan.status).toBe('valid');
    if (r.ok) { expect(r.plan.steps).toHaveLength(1); expect(r.plan.risks.map((x) => x.code)).toContain('step-dropped'); }
  });
  it('a daily free-model quota (run 8, 429 free-models-per-day) is not retried', async () => {
    const waits: number[] = [];
    const daily = Object.assign(new Error('rate'), { statusCode: 429, responseBody: JSON.stringify({ error: { message: RUN8.thenProvider.error.details.reason } }) });
    const prov = withRateLimitRetry(fakeProvider([daily]), { sleep: async (ms) => { waits.push(ms); } });
    await expect(prov.complete({ system: '', messages: [], maxTokens: 10, temperature: 0 })).rejects.toMatchObject({ code: 'EM-4102', details: { retries: 0, daily: true } });
    expect(waits).toEqual([]);
  });

  it('JSON closer repair: mismatched closers fixed, up to two missing closers appended, strings untouched', () => {
    expect(repairJsonClosers('{"a": [1, 2}]')).toBe('{"a": [1, 2]}');
    expect(repairJsonClosers('{"a": {"b": [1]}')).toBe('{"a": {"b": [1]}}');
    expect(repairJsonClosers('{"a": "x]}"}')).toBeNull();
    expect(repairJsonClosers('{"a": "cut')).toBeNull();
  });

  it('reasoning blocks are stripped: a JSON example inside <think> is never taken as the plan', async () => {
    const { env, ctx } = setup();
    const text = `<think>Maybe {"goal": "contoh", "steps": []} … ${LIVE.reasoningTail}</think>\n${LIVE.content}`;
    expect(stripReasoning(text).trim().startsWith('{"goal": "Membuat video')).toBe(true);
    expect(stripReasoning('<think>only thinking, cut off')).toBe('');
    expect(stripReasoning('reasoning without opening tag</think>{"a":1}')).toBe('{"a":1}');
    const r = await runEditorAgent(env, fakeProvider([text]), ctx);
    expect(r.ok && r.plan.status).toBe('valid');
  });

  it('several JSON objects in one reply (tool-call habit, examples): the plan-shaped one wins', async () => {
    const { env, ctx } = setup();
    const text = `{"note": "draft"}\n${LIVE.content}\n{"tool": "catalogue.search", "input": {"query": "background"}}`;
    expect((extractPlanJson(text) as { steps?: unknown[] }).steps?.length).toBe(1);
    const r = await runEditorAgent(env, fakeProvider([text]), ctx);
    expect(r.ok && r.plan.status).toBe('valid');
  });

  it('a reply cut off at the output limit asks for a SHORTER plan (not "invalid JSON") and the next reply is accepted', async () => {
    const { env, ctx } = setup();
    const prov = withFinish([{ text: LIVE.content.slice(0, 900), finishReason: 'length' }, { text: LIVE.content, finishReason: 'stop' }]);
    const r = await runEditorAgent(env, prov, ctx);
    expect(r.ok && r.plan.status).toBe('valid');
    expect(prov.calls[1]!.messages.at(-1)!.content).toContain('cut off at the output limit');
    if (r.ok) expect(r.diagnostics.truncated).toBe(1);
  });

  it('two replies without any JSON stop the run early (EM-4301 after 2 calls, not 3)', async () => {
    const { env, ctx } = setup();
    const prov = fakeProvider(['Baik, saya akan membuat videonya.', 'Tentu! Berikut rencananya: adegan 1 …']);
    const r = await runEditorAgent(env, prov, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.code).toBe('EM-4301'); expect(r.attempts).toBe(2); }
    expect(prov.calls).toHaveLength(2);
  });

  it('EM-2102 on preset params (the live lastIssues) is repaired: unknown names dropped, near-miss names / enums mapped, numbers clamped', async () => {
    const { s, env, ctx } = setup();
    const plan = JSON.parse(LIVE.content) as { steps: Array<{ ops: Array<{ args: Record<string, unknown> }> }> };
    const ops = plan.steps[0]!.ops;
    ops[0]!.args['backgroundParams'] = { colors: ['#ff0000', '#00ff00'], speed: 2, angle: 400, animate: 'true', 'colour-a': '#f00' };
    ops[1]!.args['backgroundParams'] = { cellPx: 5 };                                   // gradient has no cellPx → dropped
    ops[2]!.args['backgroundParams'] = { cellPx: '500' };                               // grid: string number clamped to 200
    ops.push({ op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.slide', durationMs: 400, params: { direction: 'left', easing: 'smooth' } } } as never);
    const r = await runEditorAgent(env, fakeProvider([JSON.stringify(plan)]), ctx);
    expect(r.ok && r.plan.status).toBe('valid');
    if (!r.ok) return;
    const a = r.plan.steps[0]!.ops.map((o) => o.args as Record<string, unknown>);
    expect(a[0]!['backgroundParams']).toEqual({ angle: 360, animate: true, colourA: '#ff0000', colourB: '#00ff00' });
    expect(a[1]!['backgroundParams']).toBeUndefined();
    expect(a[2]!['backgroundParams']).toEqual({ cellPx: 200 });
    expect(a[5]!['params']).toEqual({ direction: 'from-left' });
    expect(r.diagnostics.repairKinds.length).toBeGreaterThan(0);
    apply(s, r.plan);
  });

  it('background params written at the op top level move into backgroundParams; ambiguous required values are left for validation', () => {
    const { s } = setup();
    const n = normalizeModelReply({ steps: [{ ops: [{ op: 'op:scene.add', args: { durationMs: 3000, background: 'preset:background.grid', title: 'A', cellPx: 40, animate: true } }] }] }, { model: s.model, baseVersion: s.head });
    const args = ((n.value!['steps'] as Array<{ ops: Array<{ args: Record<string, unknown> }> }>)[0]!.ops[0]!.args);
    expect(args['backgroundParams']).toEqual({ cellPx: 40, animate: true });
    const fixes: string[] = [];
    expect(repairPresetParams('preset:background.gradient', { colourA: 'blue' }, fixes, 'x')).toEqual({});   // optional, unfixable → default
    expect(fixes.join(' ')).toContain('dropped invalid param colourA');
  });

  it('correction messages list the allowed params of the failing preset and the valid ids of its category', () => {
    const plan = { steps: [{ n: 1, ops: [{ op: 'op:scene.add', args: { durationMs: 3000, background: 'preset:background.grid', backgroundParams: { cellPx: 'x' } } }, { op: 'op:scene.add', args: { durationMs: 3000, background: 'preset:background.lava' } }] }] } as unknown as EditPlanT;
    const msg = correctionMessage(plan, [
      { code: 'EM-2102', severity: 'block', path: 'steps[0].ops[0].args.params.cellPx', message: 'Expected number' },
      { code: 'EM-2101', severity: 'block', path: 'steps[0].ops[1].args.presetId', message: 'preset:background.lava is not a background preset in the Design Catalogue.' },
    ]);
    expect(msg).toContain('Allowed backgroundParams for preset:background.grid: {colourA?: #RRGGBB');
    expect(msg).toContain('cellPx?: int 10..200');
    expect(msg).toContain('Valid background values: preset:background.solid, preset:background.gradient');
  });
});

describe('Brainstorm tool loop (live QA: the model kept calling catalogue.search)', () => {
  it('when the tool rounds are used up it gets one "answer now" call instead of a bare "…" reply', async () => {
    const tool = '{"tool": "catalogue.search", "input": {"category": "backgrounds"}} {"tool": "catalogue.search", "input": {"category": "transitions"}}';
    const prov = fakeProvider([...Array(MAX_TOOL_ROUNDS + 1).fill(tool), '{"reply": "Siap, ini dua konsep."}']);
    const r = await runBrainstorm([{ role: 'user', content: 'video 30 detik' }], {}, 'id', prov, { tools: { 'catalogue.search': () => [] } });
    expect(r.ok && r.turn.reply).toBe('Siap, ini dua konsep.');
    expect(prov.calls.at(-1)!.messages.at(-1)!.content).toContain('No more tool calls');
  });
});

describe('rate limits (EM-4102): Retry-After and backoff', () => {
  it('reads Retry-After seconds / HTTP date and OpenRouter X-RateLimit-Reset from the error body', () => {
    expect(retryAfterMsOf({ 'Retry-After': '3' })).toBe(3000);
    expect(retryAfterMsOf({ 'retry-after': new Date(10_000).toUTCString() }, '', 4000)).toBe(6000);
    expect(retryAfterMsOf({}, '{"error":{"metadata":{"headers":{"X-RateLimit-Reset":"1700000005000"}}}}', 1700000000000)).toBe(5000);
    expect(retryAfterMsOf({})).toBeNull();
    const e = mapProviderError(Object.assign(new Error('x'), { statusCode: 429, responseHeaders: { 'retry-after': '1' }, responseBody: '{"error":{"message":"google/gemma-4-31b-it:free is temporarily rate-limited upstream"}}' }));
    expect(e.code).toBe('EM-4102');
    expect(e.details).toMatchObject({ status: 429, retryAfterMs: 1000, reason: expect.stringContaining('rate-limited upstream') });
  });
  it('retries twice within 20 s, reports each wait, then gives up with details.retries; the runner does not retry again', async () => {
    const waits: number[] = []; const seen: Array<{ n: number; of: number }> = [];
    const prov = withRateLimitRetry(fakeProvider([Object.assign(new Error('rate'), { statusCode: 429 })]), { sleep: async (ms) => { waits.push(ms); } });
    await expect(prov.complete({ system: '', messages: [], maxTokens: 10, temperature: 0, onRetry: (r) => seen.push(r) })).rejects.toMatchObject({ code: 'EM-4102', details: { retries: 2 } });
    expect(waits).toEqual([3000, 6000]);
    expect(seen.map((x) => `${x.n}/${x.of}`)).toEqual(['1/2', '2/2']);
    // A Retry-After beyond the 20 s budget: no pointless wait.
    const far = withRateLimitRetry(fakeProvider([Object.assign(new Error('rate'), { statusCode: 429, responseHeaders: { 'retry-after': '60' } })]), { sleep: async (ms) => { waits.push(ms); } });
    await expect(far.complete({ system: '', messages: [], maxTokens: 10, temperature: 0 })).rejects.toMatchObject({ details: { retries: 0 } });
    expect(waits).toHaveLength(2);
    // Through the Editor run: progress shows "waiting n/m", and the run fails after the adapter's retries without a 4th call.
    const { env, ctx } = setup();
    const inner = fakeProvider([Object.assign(new Error('rate'), { statusCode: 429 })]);
    const phases: string[] = [];
    const r = await runEditorAgent(env, withRateLimitRetry(inner, { sleep: async () => {} }), ctx, { onProgress: (p) => phases.push(`${p.phase}${p.attempt ? ` ${p.attempt}/${p.of}` : ''}`) });
    expect(r.ok).toBe(false);
    expect(inner.calls).toHaveLength(3);
    expect(phases).toContain('waiting 1/2');
    // Recovers when the second try succeeds.
    const ok = withRateLimitRetry(fakeProvider([Object.assign(new Error('rate'), { statusCode: 429 }), LIVE.content]), { sleep: async () => {} });
    const r2 = await runEditorAgent(env, ok, ctx);
    expect(r2.ok && r2.plan.status).toBe('valid');
  });
  it('parseModelReply flags replies without any JSON (noJson) separately from broken JSON', () => {
    const meta = { id: 'a', projectId: 'b' };
    expect(parseModelReply('Siap, saya buatkan.', meta).noJson).toBe(true);
    expect(parseModelReply('{"goal": "x", "steps": [', meta).noJson).toBe(false);
  });
});
