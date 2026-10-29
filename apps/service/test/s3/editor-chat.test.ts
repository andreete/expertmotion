// FR-067 / FR-072 / FR-074 / FR-080 / FR-084 with the real S1 + S3 modules: an Editor Chat message becomes a chat Edit Intent with
// the inspector target, selection and playhead in the envelope, image parts only for image-input models, the read-only tool
// loop, contextLength on queue-started plans, Cancel removes the chat intent, and Cancel before the Execute transaction.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashModel, type AssetFacts } from '@expertmotion/composition-model';
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
import { s1 } from '../../src/s1/index.js';
import { body, waitFor } from './s3-helpers.js';

const ASSETS: AssetFacts[] = [
  { id: 'a1', kind: 'video', status: 'ready', durationMs: 10_000, name: 'unboxing.mp4', hasAudio: true },
  { id: 'a2', kind: 'video', status: 'ready', durationMs: 6000, name: 'fitur.mp4' },
];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const env = (req: ChatRequest) => JSON.parse(req.messages[0]!.content) as Record<string, any>;
const planReply = (req: ChatRequest) => JSON.stringify({ goal: 'Judul pembuka', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:text.add', args: { text: 'Kopi Pagi', variant: 'preset:text.title', atMs: 0, durationMs: 2000 } }], expectedDiff: 'judul' }], risks: [], baseVersion: env(req)['baseVersion'] });
type Ev = { name: string; data: Record<string, any> };

describe('Editor Chat → chat Edit Intent → Editor Agent (FR-080)', () => {
  let s: TestService; let pid = ''; let clipId = ''; let imageId = ''; const events: Ev[] = [];
  let provider: ChatProvider = fakeProvider([planReply]);
  const setCap = (imageInput: boolean) => s.ctx.db.prepare('UPDATE provider_connections SET models_json = ? WHERE id = ?').run(JSON.stringify([{ modelId: 'fake/model', label: 'Fake', contextLength: 100_000, toolCalling: false, imageInput, pricePerMInput: null, pricePerMOutput: null }]), 'C1');
  const head = () => hashModel(s.ctx.hooks.composition(pid).model);
  const chatStatus = (messageId: string) => (s.ctx.db.prepare('SELECT status FROM edit_intents WHERE property_key = ?').get(`chat:${messageId}`) as { status: string } | undefined)?.status;
  const queue = async () => (await body<{ items: Array<Record<string, any>> }>(await s.api(`/projects/${pid}/intents`))).items;
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, intentsModule, agentsModule] });
    s.ctx.hooks.assetFacts = () => ASSETS;
    s.ctx.hooks.providerFor = () => provider;
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { events.push({ name, data: data as Record<string, any> }); return emit(name, data); };
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Kopi' } }))).id;
    s.ctx.hooks.applyOps(pid, ['a1', 'a2'].map((assetId) => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId } })), { kind: 'asset', summary: 'insert' });
    clipId = s.ctx.hooks.composition(pid).model.tracks.video[1]!.id;
    const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO provider_connections (id, provider, label, secret_enc, secret_hint, status, created_at, updated_at) VALUES ('C1','openrouter','Fake',x'00','abcd','valid',?,?)").run(now, now);
    s.ctx.db.prepare("INSERT INTO model_assignments (agent, connection_id, model_id, settings_json, updated_at) VALUES ('editor','C1','fake/model','{}',?)").run(now);
    imageId = s.ctx.newId();
    fs.mkdirSync(path.join(s.ctx.paths.media, 'img'), { recursive: true });
    fs.writeFileSync(path.join(s.ctx.paths.media, 'img', 'logo.png'), PNG);
    s.ctx.db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, status, created_at, updated_at) VALUES (?,?,'image','logo.png','sha-logo',?,?,'ready',?,?)").run(imageId, pid, PNG.length, 'img/logo.png', now, now);
  });
  afterAll(async () => { await s.close(); });

  it('target, selection, playhead and an image reach the Editor Agent; the message is a chat intent; tools are offered', async () => {
    setCap(true);
    const prov = fakeProvider([planReply]); provider = prov;
    const r = await s.api(`/projects/${pid}/conversations/editor/messages`, { method: 'POST', json: { text: 'buat lebih energik', baseVersion: head(), target: { kind: 'clip', id: clipId }, selection: [{ kind: 'cut', index: 0 }], playheadMs: 3000, attachments: [{ assetId: imageId }] } });
    expect(r.status).toBe(202);
    const { runId, message } = await body<{ runId: string; message: { id: string } }>(r);
    await waitFor(async () => (await body<{ status: string }>(await s.api(`/agent-runs/${runId}`))).status === 'done', 5000);
    const req = prov.calls[0]!;
    expect(req.messages[0]!.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64'), name: 'logo.png' }]);
    const e = env(req);
    expect(e).toMatchObject({ selection: [{ kind: 'clip', id: clipId }, { kind: 'cut', index: 0 }], playheadMs: 3000, attachments: ['logo.png'], creatorMessage: 'buat lebih energik' });
    expect(e['intents']).toContainEqual(expect.objectContaining({ propertyKey: `chat:${message.id}`, category: 'layout', needsInterpretation: true, instruction: 'buat lebih energik', resolvedTargets: [{ kind: 'clip', id: clipId }] }));
    expect(req.system).toContain('composition.validateOps');
    const chat = (await queue()).find((i) => i['propertyKey'] === `chat:${message.id}`);
    expect(chat).toMatchObject({ source: 'chat', target: { kind: 'clip', id: clipId }, status: 'queued' });
    // FR-074: usage recorded once under the chat run, with the model's context length
    const run = await body<{ usage: { contextLength: number | null } | null }>(await s.api(`/agent-runs/${runId}`));
    expect(run.usage?.contextLength).toBe(100_000);
    // FR-084: Cancel after the Execute was accepted but before its transaction → EM-4303, version unchanged
    const plan = (events.filter((x) => x.name === 'plan.ready').at(-1)!.data['plan'] ?? {}) as { id?: string };
    const planId = plan.id ?? (s.ctx.db.prepare("SELECT id FROM edit_plans WHERE project_id = ? AND status = 'valid' ORDER BY created_at DESC LIMIT 1").get(pid) as { id: string }).id;
    const before = head();
    const wf = s1(s.ctx).workflow;
    const exec = wf.execute(planId, { confirmDestructive: false });
    expect(wf.cancel(planId).status).toBe('cancelled');
    await expect(exec).rejects.toSatisfy((x: unknown) => x instanceof EmError && x.code === 'EM-4303');
    expect(head()).toBe(before);
    expect(chatStatus(message.id)).toBe('removed');
  });

  it('FR-213: an image to a model without image input is sent as its file name only (no refusal, no image part)', async () => {
    setCap(false);
    const prov = fakeProvider([planReply]); provider = prov; events.length = 0;
    const r = await s.api(`/projects/${pid}/conversations/editor/messages`, { method: 'POST', json: { text: 'lihat logo', baseVersion: head(), attachments: [{ assetId: imageId }] } });
    expect(r.status).toBe(202);
    const sent = await body<{ message: { blocks: Array<{ type: string; sent?: string; name?: string }> } }>(r);
    expect(sent.message.blocks.find((b) => b.type === 'attachment')).toMatchObject({ sent: 'name' });
    await waitFor(() => events.some((x) => x.name === 'agent.run.done' || x.name === 'agent.run.failed'), 5000);
    expect(prov.calls.length).toBeGreaterThan(0);
    expect(prov.calls.every((c) => c.messages.every((m) => !m.images?.length))).toBe(true);
    setCap(true);
  });

  it('FR-074: a plan started from the queue reports contextLength and the last request tokens', async () => {
    provider = fakeProvider([planReply]);
    events.length = 0;
    const r = await s.api(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: head(), message: 'judul pembuka', mode: 'agent' } });
    expect(r.status).toBe(202);
    await waitFor(() => events.some((x) => x.name === 'agent.run.done'), 5000);
    const done = events.find((x) => x.name === 'agent.run.done')!;
    expect(done.data['contextUsage']).toMatchObject({ contextLength: 100_000, usedTokens: expect.any(Number) });
    expect(done.data['contextUsage'].usedTokens).toBeGreaterThan(0);
  });

  it('FR-084: cancelling a chat run removes its chat intent and leaves no plan to execute', async () => {
    provider = { id: 'hang', model: 'fake/model', complete: (req) => new Promise((_r, rej) => req.signal?.addEventListener('abort', () => rej(new EmError('EM-4303', 'Cancelled.')), { once: true })) };
    const r = await s.api(`/projects/${pid}/conversations/editor/messages`, { method: 'POST', json: { text: 'tunggu', baseVersion: head() } });
    const { runId, message } = await body<{ runId: string; message: { id: string } }>(r);
    await waitFor(async () => (await queue()).some((i) => i['propertyKey'] === `chat:${message.id}`));
    await s.api(`/agent-runs/${runId}/cancel`, { method: 'POST' });
    await waitFor(() => chatStatus(message.id) === 'removed');
    expect((await body<{ status: string; errorCode: string }>(await s.api(`/agent-runs/${runId}`)))).toMatchObject({ status: 'cancelled', errorCode: 'EM-4303' });
  });

  it('Entry 35: Re-plan (replanOf) sends the Creator\'s ORIGINAL long message, not the plan\'s one-line goal', async () => {
    const prov = fakeProvider([planReply, planReply]); provider = prov;
    const long = `Buat video "Ekspor Nikel Indonesia 2026". v1: "Ekspor nikel Indonesia naik tujuh belas persen." ${'Detail angka 25,96 miliar. '.repeat(200)}`;
    expect(long.length).toBeGreaterThan(4000);
    const r = await s.api(`/projects/${pid}/conversations/editor/messages`, { method: 'POST', json: { text: long, baseVersion: head() } });
    const { runId } = await body<{ runId: string }>(r);
    await waitFor(async () => (await body<{ status: string }>(await s.api(`/agent-runs/${runId}`))).status === 'done', 5000);
    const planId = (s.ctx.db.prepare('SELECT id FROM edit_plans WHERE agent_run_id = ? ORDER BY created_at DESC LIMIT 1').get(runId) as { id: string }).id;
    const rp = await s.api(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: head(), message: 'Judul pembuka', mode: 'agent', replanOf: planId } });
    expect(rp.status).toBe(202);
    await waitFor(() => prov.calls.length >= 2, 5000);
    expect(env(prov.calls[1]!)['creatorMessage']).toBe(long.trim());
    // a plan without a chat message (or an unknown one): the given message is used
    const rp2 = await s.api(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: head(), message: 'Judul pembuka', mode: 'agent', replanOf: s.ctx.newId() } });
    expect(rp2.status).toBe(202);
  });
});
