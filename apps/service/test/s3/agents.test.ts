import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyModel, hashModel } from '@expertmotion/composition-model';
import { fakeProvider, type ChatProvider, type EditIntentT } from '@expertmotion/agents';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { agentsModule } from '../../src/modules/agents.js';
import { eventsModule } from '../../src/modules/events.js';
import { addProject, body, collectSse, waitFor } from './s3-helpers.js';

const TURN = JSON.stringify({ reply: 'Ide bagus! Kita buat video yang energik.', questions: ['Berapa durasinya?'], suggestedNextStep: 'send-to-editor', proposedIntents: [
  { category: 'caption', presetId: 'preset:caption.editorial', needsInterpretation: false, source: 'brainstorm' },
  { category: 'transition', presetId: 'preset:transition.fade', needsInterpretation: false, source: 'brainstorm' },
  { category: 'text', instruction: 'Judul pembuka yang kuat', needsInterpretation: true, source: 'brainstorm' },
] });
const modules = [health, settingsModule, providersModule, usageModule, agentsModule, eventsModule];
type Msg = { id: string; role: string; blocks: Array<{ type: string; intents?: Array<{ id: string; category: string }>; handoffState?: string; text?: string }>; agentRunId: string | null };
type Run = { id: string; status: string; errorCode: string | null; planId: string | null; usage: { inputTokens: number } | null };

describe('agents module', () => {
  let s: TestService; let projectId = ''; let otherProject = '';
  let provider: ChatProvider = fakeProvider([TURN]);
  beforeAll(async () => {
    s = await startService({ modules });
    projectId = addProject(s); otherProject = addProject(s);
    s.ctx.hooks.providerFor = () => provider;
    s.ctx.hooks.composition = (id) => ({ model: createEmptyModel(id), versionId: 'v1' });
  });
  afterAll(async () => { await s.close(); });

  const send = (agent: string, text: string, baseVersion = 'v1') => s.api(`/projects/${projectId}/conversations/${agent}/messages`, { method: 'POST', json: { text, baseVersion } });
  const run = async (id: string) => body<Run>(await s.api(`/agent-runs/${id}`));
  const thread = async (agent = 'brainstorm') => body<{ conversationId: string; messages: { items: Msg[]; total: number; nextCursor: string | null } }>(await s.api(`/projects/${projectId}/conversations/${agent}`));

  it('brainstorm: 202, run events on the project stream only, assistant message with a pending handoff card, usage recorded', async () => {
    expect((await thread()).messages.total).toBe(0);
    const sse = collectSse(`${s.base}/api/v1/events?token=${s.token}&projectId=${projectId}`, (ev) => ev.some((e) => e.event === 'agent.run.done'));
    await new Promise((r) => setTimeout(r, 50));
    s.ctx.bus.emit('probe.other', { projectId: otherProject });
    s.ctx.bus.emit('probe.global', { kind: 'x' });
    const r = await send('brainstorm', 'Saya mau video promo kopi 30 detik');
    expect(r.status).toBe(202);
    const { runId, message } = await body<{ runId: string; message: Msg }>(r);
    expect(message.role).toBe('user');
    const events = await sse;
    const names = events.map((e) => e.event);
    expect(names).toContain('agent.run.started');
    expect(names).toContain('probe.global');
    expect(names).not.toContain('probe.other');
    const done = events.find((e) => e.event === 'agent.run.done')!;
    expect(done.data).toMatchObject({ projectId, run: { id: runId, status: 'done' } });
    expect(typeof done.data['at']).toBe('string');
    const t = await thread();
    expect(t.messages.items.map((m) => m.role)).toEqual(['user', 'assistant']);
    const card = t.messages.items[1]!.blocks.find((b) => b.type === 'proposed_intents')!;
    expect(card.handoffState).toBe('pending');
    expect(card.intents).toHaveLength(3);
    expect(t.messages.items[1]!.blocks[0]!.text).toContain('Ide bagus');
    expect((await run(runId)).usage?.inputTokens).toBeGreaterThan(0);
    const sys = (provider as ReturnType<typeof fakeProvider>).calls[0]!.system;
    expect(sys).toContain('Bahasa Indonesia');
  });

  it('FR-075: streams agent.run.delta with reply text only, runs read-only tools, never emits composition.updated', async () => {
    const before = provider;
    provider = fakeProvider(['{"tool":"catalogue.search","input":{"query":"pudar"}}', JSON.stringify({ reply: 'Coba transisi Pudar yang lembut di setiap potongan.' })]);
    const sse = collectSse(`${s.base}/api/v1/events?token=${s.token}&projectId=${otherProject}`, (ev) => ev.some((e) => e.event === 'agent.run.done'));
    await new Promise((r) => setTimeout(r, 50));
    const r = await s.api(`/projects/${otherProject}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'transisi halus?', baseVersion: 'v1' } });
    expect(r.status).toBe(202);
    const events = await sse;
    const deltas = events.filter((e) => e.event === 'agent.run.delta').map((e) => String(e.data['delta']));
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join('')).toBe('Coba transisi Pudar yang lembut di setiap potongan.');
    expect(events.map((e) => e.event)).not.toContain('composition.updated');
    const t = await body<{ messages: { items: Msg[] } }>(await s.api(`/projects/${otherProject}/conversations/brainstorm`));
    const blocks = t.messages.items.at(-1)!.blocks;
    expect(blocks[0]).toMatchObject({ type: 'tool_result', name: 'catalogue.search' });
    expect(blocks.find((b) => b.type === 'text')?.text).toContain('Pudar');
    const second = (provider as ReturnType<typeof fakeProvider>).calls[1]!;
    expect(second.messages.at(-1)!.content).toContain('preset:transition.fade');
    provider = before;
  });

  it('handoff: stale base → EM-2301; converts proposals into EditIntents, rejects what cannot be placed, stores the payload without an enqueue hook', async () => {
    const msg = (await thread()).messages.items[1]!;
    const stale = await s.api(`/projects/${projectId}/conversations/brainstorm/handoff`, { method: 'POST', json: { messageId: msg.id, baseVersion: 'v0' } });
    expect(stale.status).toBe(409);
    expect((await body<{ error: { code: string } }>(stale)).error.code).toBe('EM-2301');
    const r = await s.api(`/projects/${projectId}/conversations/brainstorm/handoff`, { method: 'POST', json: { messageId: msg.id, baseVersion: 'v1' } });
    expect(r.status).toBe(200);
    const h = await body<{ accepted: string[]; rejected: Array<{ id: string; code: string }>; queue: unknown; planId: null; pendingEnqueue: boolean; intents: EditIntentT[] }>(r);
    const [caption, transition, text] = msg.blocks.find((b) => b.type === 'proposed_intents')!.intents!;
    expect(h.accepted).toEqual([caption!.id, text!.id]);
    expect(h.rejected).toEqual([{ id: transition!.id, code: 'EM-2202' }]);
    expect(h.pendingEnqueue).toBe(true);
    expect(h.intents.every((i) => i.source === 'brainstorm' && i.projectId === projectId && i.baseVersion === hashModel(createEmptyModel(projectId)) && i.status === 'queued')).toBe(true);
    expect(h.intents.find((i) => i.category === 'text')?.needsInterpretation).toBe(true);
    const stored = s.ctx.db.prepare('SELECT status, intents_json FROM brainstorm_handoffs WHERE message_id = ?').get(msg.id) as { status: string; intents_json: string };
    expect(stored.status).toBe('pending');
    expect((JSON.parse(stored.intents_json) as unknown[]).length).toBe(h.intents.length);
    const card = (await thread()).messages.items[1]!.blocks.find((b) => b.type === 'proposed_intents')!;
    expect(card.handoffState).toBe('sent');
    const again = await s.api(`/projects/${projectId}/conversations/brainstorm/handoff`, { method: 'POST', json: { messageId: msg.id, baseVersion: 'v1' } });
    expect(again.status).toBe(404);
  });

  it('handoff uses the intents module enqueue hook when installed, and honours a subset', async () => {
    const r = await send('brainstorm', 'Tambahkan caption');
    const { runId } = await body<{ runId: string }>(r);
    await waitFor(async () => (await run(runId)).status === 'done');
    const msg = (await thread()).messages.items.at(-1)!;
    const caption = msg.blocks.find((b) => b.type === 'proposed_intents')!.intents![0]!;
    const got: EditIntentT[] = [];
    (s.ctx.hooks as unknown as { enqueueIntents: (p: string, i: EditIntentT[]) => { queue: unknown } }).enqueueIntents = (_p, i) => { got.push(...i); return { queue: { projectId, items: i } }; };
    const h = await body<{ accepted: string[]; queue: { items: unknown[] }; pendingEnqueue?: boolean }>(await s.api(`/projects/${projectId}/conversations/brainstorm/handoff`, { method: 'POST', json: { messageId: msg.id, intentIds: [caption.id], baseVersion: 'v1' } }));
    expect(h.accepted).toEqual([caption.id]);
    expect(h.pendingEnqueue).toBeUndefined();
    expect(h.queue.items).toHaveLength(got.length);
    expect((s.ctx.db.prepare('SELECT status FROM brainstorm_handoffs WHERE message_id = ?').get(msg.id) as { status: string }).status).toBe('enqueued');
    delete (s.ctx.hooks as unknown as { enqueueIntents?: unknown }).enqueueIntents;
  });

  it('one run at a time (EM-4305); cancel aborts the provider call and is final', async () => {
    let started = false;
    provider = { id: 'slow', model: 'slow/model', complete: (req) => { started = true; return new Promise((_res, rej) => req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); } };
    const { runId } = await body<{ runId: string }>(await send('brainstorm', 'Pelan-pelan'));
    await waitFor(() => started);
    const busy = await send('brainstorm', 'Lagi');
    expect(busy.status).toBe(409);
    expect((await body<{ error: { code: string } }>(busy)).error.code).toBe('EM-4305');
    expect((await s.api(`/projects/${projectId}/conversations/brainstorm`, { method: 'DELETE' })).status).toBe(409);
    const c = await body<Run>(await s.api(`/agent-runs/${runId}/cancel`, { method: 'POST' }));
    expect(c).toMatchObject({ status: 'cancelled', errorCode: 'EM-4303' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await run(runId)).toMatchObject({ status: 'cancelled', errorCode: 'EM-4303' });
    expect(await body<Run>(await s.api(`/agent-runs/${runId}/cancel`, { method: 'POST' }))).toMatchObject({ status: 'cancelled' });
  });

  it('provider failure: retried once, then failed with the mapped code and a system message', async () => {
    provider = fakeProvider([Object.assign(new Error('rate'), { statusCode: 429 })]);
    const { runId } = await body<{ runId: string }>(await send('brainstorm', 'Coba lagi'));
    await waitFor(async () => (await run(runId)).status === 'failed');
    expect((await run(runId)).errorCode).toBe('EM-4102');
    expect((provider as ReturnType<typeof fakeProvider>).calls).toHaveLength(2);
    const last = (await thread()).messages.items.at(-1)!;
    expect(last.role).toBe('system');
    expect(last.blocks[0]!.text).toContain('EM-4102');
  });

  it('editor: base check, plan via the createPlan hook, planId on the run', async () => {
    let seen: { instruction?: string; mode?: string } = {};
    s.ctx.hooks.createPlan = async (_p, input) => { seen = input; return { planId: s.ctx.newId(), id: 'x', projectId, baseVersion: 'v1', origin: 'editor-agent', goal: 'Judul pembuka energik', steps: [], touchesLockedKeys: [], risks: [], status: 'valid', validation: [],
      usage: { model: 'fake/model', inputTokens: 900, outputTokens: 100, costUsd: 0.001, approximate: false } }; };
    const stale = await send('editor', 'buat judul', 'v0');
    expect(stale.status).toBe(409);
    const { runId } = await body<{ runId: string }>(await send('editor', 'buat judul pembuka yang kuat'));
    await waitFor(async () => (await run(runId)).status === 'done');
    const r = await run(runId);
    expect(r.planId).toMatch(/^[0-9A-Z]{26}$/);
    expect(r.usage?.inputTokens).toBe(900);
    expect(seen).toMatchObject({ instruction: 'buat judul pembuka yang kuat', mode: 'agent' });
    const t = await thread('editor');
    expect(t.messages.items.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('usage summary and paging; clearing a thread keeps usage', async () => {
    const u = await body<{ project: { runs: number }; byAgent: { brainstorm: { runs: number }; editor: { runs: number } } }>(await s.api(`/projects/${projectId}/usage`));
    expect(u.byAgent.editor.runs).toBe(1);
    expect(u.byAgent.brainstorm.runs).toBeGreaterThanOrEqual(2);
    const p1 = await body<{ messages: { items: Msg[]; nextCursor: string | null } }>(await s.api(`/projects/${projectId}/conversations/brainstorm?limit=2`));
    expect(p1.messages.items).toHaveLength(2);
    const p2 = await body<{ messages: { items: Msg[] } }>(await s.api(`/projects/${projectId}/conversations/brainstorm?limit=2&cursor=${p1.messages.nextCursor}`));
    expect(p2.messages.items[1]!.id < p1.messages.items[0]!.id).toBe(true);
    expect((await s.api(`/projects/${projectId}/conversations/brainstorm`, { method: 'DELETE' })).status).toBe(204);
    expect((await thread()).messages.total).toBe(0);
    const u2 = await body<{ project: { runs: number } }>(await s.api(`/projects/${projectId}/usage`));
    expect(u2.project.runs).toBe(u.project.runs);
    expect((await s.api(`/projects/${s.ctx.newId()}/conversations/brainstorm`)).status).toBe(404);
  });

  it('Private Mode: R-081 → 423 EM-4401', async () => {
    s.ctx.settings.update({ privateMode: true });
    const r = await send('brainstorm', 'halo');
    expect(r.status).toBe(423);
    expect((await body<{ error: { code: string } }>(r)).error.code).toBe('EM-4401');
    s.ctx.settings.update({ privateMode: false });
  });

  it('a restart marks interrupted runs cancelled (EM-4304)', async () => {
    const id = s.ctx.newId();
    s.ctx.db.prepare("INSERT INTO agent_runs(id, project_id, agent, model_id, status, started_at) VALUES (?,?,?,?,'running',?)").run(id, projectId, 'brainstorm', 'm', new Date().toISOString());
    const { dataDir, dbKeyHex } = s.cfg;
    await s.close();
    s = await startService({ modules, dataDir, cfg: { dbKeyHex } });
    expect(await run(id)).toMatchObject({ status: 'cancelled', errorCode: 'EM-4304' });
  });
});

describe('agents with the real S1 composition and intents modules', () => {
  it('editor message → createPlan (S1): S1 errors surface on the run and in the thread', async () => {
    const { projectsModule } = await import('../../src/modules/projects.js');
    const { compositionModule } = await import('../../src/modules/composition.js');
    const { intentsModule } = await import('../../src/modules/intents.js');
    const s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, intentsModule, agentsModule] });
    try {
      const fake = fakeProvider(['not a plan']);
      s.ctx.hooks.providerFor = () => fake;
      const created = await s.api('/projects', { method: 'POST', json: { name: 'Integrasi' } });
      expect(created.status).toBe(201);
      const projectId = (await body<{ id: string }>(created)).id;
      const base = hashModel(s.ctx.hooks.composition(projectId).model);
      const r = await s.api(`/projects/${projectId}/conversations/editor/messages`, { method: 'POST', json: { text: 'buat judul', baseVersion: base } });
      expect(r.status).toBe(202);
      const { runId } = await body<{ runId: string }>(r);
      await waitFor(async () => (await body<Run>(await s.api(`/agent-runs/${runId}`))).status !== 'running', 5000);
      // S1 refuses to plan an empty composition: the S1 error reaches the agents run and the thread unchanged.
      expect(await body<Run>(await s.api(`/agent-runs/${runId}`))).toMatchObject({ status: 'failed', errorCode: 'EM-2202' });
      const th = await body<{ messages: { items: Msg[] } }>(await s.api(`/projects/${projectId}/conversations/editor`));
      expect(th.messages.items.map((m) => m.role)).toEqual(['user', 'system']);
      expect(fake.calls).toHaveLength(0);
      expect((s.ctx.db.prepare('SELECT count(*) n FROM usage_records WHERE project_id = ?').get(projectId) as { n: number }).n).toBe(0);
    } finally { await s.close(); }
  });
});
