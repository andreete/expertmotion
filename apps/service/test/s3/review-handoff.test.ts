// Review 2026-10-29 A4: the Diskusi hand-off card follows its Editor run to "failed" when the run is cancelled or interrupted by a
// Service restart (it stayed at "planning" for ever, and a reload showed "ready … n adegan" for a run that produced nothing).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashModel } from '@expertmotion/composition-model';
import { EmError } from '@expertmotion/shared';
import { fakeProvider, type ChatProvider, type ChatRequest } from '@expertmotion/agents';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { agentsModule } from '../../src/modules/agents.js';
import { projectsModule } from '../../src/modules/projects.js';
import { compositionModule } from '../../src/modules/composition.js';
import { intentsModule } from '../../src/modules/intents.js';
import { body, waitFor } from './s3-helpers.js';

type Block = { type: string; state?: string; editorRunId?: string };
type Msg = { id: string; role: string; blocks: Block[] };
const DRAFT = JSON.stringify({ reply: 'Draf: Adegan 1 (3 dtk): "Ekspor nikel naik". Mau saya kirim ke Editor?', suggestedNextStep: 'send-to-editor' });
/** An Editor model that answers only when cancelled (a long reasoning run). */
const hanging = (): ChatProvider => {
  const complete = (req: ChatRequest) => new Promise<never>((_res, rej) => { req.signal?.addEventListener('abort', () => rej(new EmError('EM-4303', 'Cancelled.')), { once: true }); });
  return { id: 'fake', model: 'claude-sonnet-5-5', complete, stream: (req) => complete(req) } as unknown as ChatProvider;
};

describe('review A4: hand-off card after cancel / restart', () => {
  let s: TestService; let pid = '';
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const head = () => hashModel(s.ctx.hooks.composition(pid).model);
  const thread = async () => (await body<{ messages: { items: Msg[] } }>(await s.api(`/projects/${pid}/conversations/brainstorm`))).messages.items;
  const card = async (draftId: string) => (await thread()).find((m) => m.id === draftId)!.blocks.find((b) => b.type === 'handoff');
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, intentsModule, agentsModule] });
    s.ctx.hooks.providerFor = (agent) => (agent === 'editor' ? hanging() : fakeProvider([DRAFT], 'claude-sonnet-5-5', { nativeTools: true }));
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { events.push({ name, data: data as Record<string, unknown> }); return emit(name, data); };
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Nikel' } }))).id;
    const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO provider_connections (id, provider, label, secret_enc, secret_hint, status, created_at, updated_at) VALUES ('C1','anthropic','Anthropic',x'00','abcd','valid',?,?)").run(now, now);
    for (const a of ['brainstorm', 'editor']) s.ctx.db.prepare("INSERT INTO model_assignments (agent, connection_id, model_id, settings_json, updated_at) VALUES (?,'C1','claude-sonnet-5-5','{}',?)").run(a, now);
  });
  afterAll(async () => { await s.close(); });
  const handOff = async () => {
    const r = await body<{ runId: string }>(await s.api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'ide video ekspor nikel', baseVersion: head() } }));
    await waitFor(() => events.some((e) => e.name === 'agent.run.done' && (e.data['run'] as { id?: string }).id === r.runId), 8000);
    const draft = (await thread()).filter((m) => m.role === 'assistant').at(-1)!;
    const res = await body<{ runId: string }>(await s.api(`/projects/${pid}/conversations/brainstorm/messages/${draft.id}/send-to-editor`, { method: 'POST', json: { baseVersion: head() } }));
    expect(await card(draft.id)).toMatchObject({ state: 'planning', editorRunId: res.runId });
    return { draftId: draft.id, runId: res.runId };
  };

  it('Stop on the Editor run → the hand-off card is "failed" (not "planning" for ever)', async () => {
    const { draftId, runId } = await handOff();
    expect((await s.api(`/agent-runs/${runId}/cancel`, { method: 'POST' })).status).toBe(200);
    await waitFor(async () => (await card(draftId))?.state === 'failed', 8000);
  });

  it('a Service restart during the hand-off → the card is "failed" (the run was interrupted, EM-4304)', async () => {
    const { draftId, runId } = await handOff();
    await agentsModule.start!(s.ctx);                                                    // the start-up recovery of a restarted Service
    expect(await card(draftId)).toMatchObject({ state: 'failed' });
    await s.api(`/agent-runs/${runId}/cancel`, { method: 'POST' });                      // let the hanging run end
  });
});
