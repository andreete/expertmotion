// One assistant chat, two modes (Operator decision 2026-10-26; AI_WORKFLOW §10.1) with the real S1 + S3 modules: the Editor
// Agent's envelope carries the recent Brainstorming ("Diskusi") messages as `discussion`; the Brainstorming Agent's CONTEXT
// carries `recentEdits` (plan goals, applied → undone after Undo). Both stay within their budgets.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashModel, type AssetFacts } from '@expertmotion/composition-model';
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
import { s1 } from '../../src/s1/index.js';
import { discussionFor, recentEditsFor } from '../../src/s3/shared-context.js';
import { body, waitFor } from './s3-helpers.js';

const ASSETS: AssetFacts[] = [
  { id: 'a1', kind: 'video', status: 'ready', durationMs: 10_000, name: 'unboxing.mp4', hasAudio: true },
  { id: 'a2', kind: 'video', status: 'ready', durationMs: 6000, name: 'fitur.mp4' },
];
const env = (req: ChatRequest) => JSON.parse(req.messages[0]!.content) as Record<string, any>;
const planReply = (req: ChatRequest) => JSON.stringify({ goal: 'Saya tambahkan judul pembuka.', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:text.add', args: { text: 'Kopi Pagi', variant: 'preset:text.title', atMs: 0, durationMs: 2000 } }], expectedDiff: 'judul' }], risks: [], baseVersion: env(req)['baseVersion'] });
const contextOf = (req: ChatRequest) => JSON.parse(req.system.split('CONTEXT\n')[1]!.split('\n')[0]!) as Record<string, any>;

describe('shared context between Diskusi and Edit (AI_WORKFLOW §10.1)', () => {
  let s: TestService; let pid = '';
  let brainstorm = fakeProvider([JSON.stringify({ reply: 'Pakai judul besar "Kopi Pagi" di 0–2 detik.' })]);
  let editor = fakeProvider([planReply]);
  const head = () => hashModel(s.ctx.hooks.composition(pid).model);
  const send = async (agent: 'brainstorm' | 'editor', text: string) => {
    const r = await s.api(`/projects/${pid}/conversations/${agent}/messages`, { method: 'POST', json: { text, baseVersion: head() } });
    expect(r.status).toBe(202);
    const { runId } = await body<{ runId: string }>(r);
    await waitFor(async () => (await body<{ status: string }>(await s.api(`/agent-runs/${runId}`))).status !== 'running', 5000);
    return runId;
  };
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, intentsModule, agentsModule] });
    s.ctx.hooks.assetFacts = () => ASSETS;
    s.ctx.hooks.providerFor = (agent: string) => (agent === 'brainstorm' ? brainstorm : editor) as ChatProvider;
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Kopi' } }))).id;
    s.ctx.hooks.applyOps(pid, ['a1', 'a2'].map((assetId) => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId } })), { kind: 'asset', summary: 'insert' });
    const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO provider_connections (id, provider, label, secret_enc, secret_hint, status, created_at, updated_at) VALUES ('C1','openrouter','Fake',x'00','abcd','valid',?,?)").run(now, now);
    s.ctx.db.prepare('UPDATE provider_connections SET models_json = ? WHERE id = ?').run(JSON.stringify([{ modelId: 'fake/model', label: 'Fake', contextLength: 100_000, toolCalling: false, imageInput: false, pricePerMInput: null, pricePerMOutput: null }]), 'C1');
    for (const a of ['brainstorm', 'editor']) s.ctx.db.prepare("INSERT INTO model_assignments (agent, connection_id, model_id, settings_json, updated_at) VALUES (?,'C1','fake/model','{}',?)").run(a, now);
  });
  afterAll(async () => { await s.close(); });

  it('the Editor Agent sees the recent Diskusi (newest first) so "do what we discussed" works', async () => {
    await send('brainstorm', 'Ide judul pembuka untuk video kopi?');
    await send('editor', 'kerjakan yang tadi');
    const e = env(editor.calls[0]!);
    expect(e['creatorMessage']).toBe('kerjakan yang tadi');
    expect(e['discussion']).toEqual({ items: [{ from: 'brainstorm', text: 'Pakai judul besar "Kopi Pagi" di 0–2 detik.' }, { from: 'creator', text: 'Ide judul pembuka untuk video kopi?' }], summary: null, omitted: 0 });
    expect(e['constraints']).toContainEqual(expect.stringMatching(/^discussion is earlier chat/));
    // the Editor's own thread is never part of `discussion`
    expect(JSON.stringify(e['discussion'])).not.toContain('kerjakan yang tadi');
  });

  it('a long Diskusi stays within the budget and is summarised', async () => {
    const conv = (s.ctx.db.prepare("SELECT id FROM conversations WHERE project_id = ? AND agent = 'brainstorm'").get(pid) as { id: string }).id;
    const ins = s.ctx.db.prepare('INSERT INTO messages(id, conversation_id, role, blocks_json, agent_run_id, created_at) VALUES (?,?,?,?,NULL,?)');
    for (let i = 0; i < 30; i++) ins.run(s.ctx.newId(), conv, i % 2 ? 'assistant' : 'user', JSON.stringify([{ type: 'text', text: `${i} ${'panjang '.repeat(200)}` }]), `2000-01-01T00:00:${String(i).padStart(2, '0')}.000Z`);
    const d = discussionFor(s.ctx, pid, 100_000)!;
    expect(JSON.stringify(d.items).length).toBeLessThanOrEqual(4000 + 200);
    expect(d.items[0]!.text).toBe('Pakai judul besar "Kopi Pagi" di 0–2 detik.');    // the newest real message first
    expect(d.omitted).toBeGreaterThan(0);
    expect(d.summary).toMatch(/older message\(s\) left out/);
    // a small model gets a smaller window
    expect(JSON.stringify(discussionFor(s.ctx, pid, 4000)!.items).length).toBeLessThanOrEqual(1600 + 200);
    s.ctx.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at LIKE ?').run(conv, '2000-%');
  });

  it('the Brainstorming Agent sees what Edit changed: applied, then undone after Undo', async () => {
    const plan = s.ctx.db.prepare("SELECT id FROM edit_plans WHERE project_id = ? AND status = 'valid' ORDER BY created_at DESC LIMIT 1").get(pid) as { id: string };
    await s1(s.ctx).workflow.execute(plan.id, { confirmDestructive: false });
    expect(recentEditsFor(s.ctx, pid)!.items[0]).toEqual({ goal: 'Saya tambahkan judul pembuka.', status: 'applied', by: 'editor', changes: expect.stringMatching(/added/) });
    brainstorm = fakeProvider([JSON.stringify({ reply: 'Judulnya sudah ada.' })]);
    await send('brainstorm', 'apa yang sudah diubah?');
    const ctx1 = contextOf(brainstorm.calls[0]!);
    expect(ctx1['recentEdits'].items[0]).toMatchObject({ goal: 'Saya tambahkan judul pembuka.', status: 'applied' });
    expect(ctx1['composition']).toBeTruthy();                                        // the composition summary stays
    expect((await s.api(`/projects/${pid}/composition/undo`, { method: 'POST' })).status).toBe(200);
    brainstorm = fakeProvider([JSON.stringify({ reply: 'Judulnya dibatalkan.' })]);
    await send('brainstorm', 'dan sekarang?');
    expect(contextOf(brainstorm.calls[0]!)['recentEdits'].items[0]).toMatchObject({ goal: 'Saya tambahkan judul pembuka.', status: 'undone' });
  });
});
