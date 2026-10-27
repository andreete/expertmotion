// QA 2026-10-27 (Windows, Claude Sonnet 5.5, direct Anthropic key) with the real S1 + S3 modules:
//  - FR-212: an assistant message stored WITHOUT `params` on a proposed intent (what crashed the chat on every open) is returned
//    normalised by R-080 and can still be handed off; stored tool-call markup is not sent back to the model.
//  - FR-211: a Diskusi run with native tools stores a clean reply and proposals with params {}.
//  - FR-213: an image attached while it is still importing is waited for; a model without image input gets the file name only;
//    a provider that refuses the image part gets the request again with names only.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashModel } from '@expertmotion/composition-model';
import { fakeProvider, mapProviderError, type ChatProvider, type ChatRequest } from '@expertmotion/agents';
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

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const QA_INVOKE = '<invoke>\n<parameter name="input">{"query": "gradient", "category": "backgrounds"}</parameter>\n<parameter name="tool">catalogue.search</parameter>\n</invoke>';
type Block = { type: string; text?: string; sent?: string; intents?: Array<Record<string, unknown>>; handoffState?: string };
type Msg = { id: string; role: string; blocks: Block[] };

describe('QA 2026-10-27 Diskusi: stored bad proposals, native tools, image attachments', () => {
  let s: TestService; let pid = ''; let imageId = '';
  let provider: ChatProvider = fakeProvider(['{"reply":"ok"}']);
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const head = () => hashModel(s.ctx.hooks.composition(pid).model);
  const setCap = (imageInput: boolean | null) => s.ctx.db.prepare('UPDATE provider_connections SET models_json = ? WHERE id = ?').run(JSON.stringify([{ modelId: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextLength: 1_000_000, toolCalling: true, structuredOutput: true, streaming: true, imageInput, pricePerMInput: null, pricePerMOutput: null }]), 'C1');
  const thread = async () => (await body<{ messages: { items: Msg[] } }>(await s.api(`/projects/${pid}/conversations/brainstorm`))).messages.items;
  const finished = (runId: string) => waitFor(() => events.some((e) => (e.name === 'agent.run.done' || e.name === 'agent.run.failed') && (e.data['runId'] === runId || (e.data['run'] as { id?: string } | undefined)?.id === runId)), 5000);
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, intentsModule, agentsModule] });
    s.ctx.hooks.providerFor = () => provider;
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { events.push({ name, data: data as Record<string, unknown> }); return emit(name, data); };
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Data Center' } }))).id;
    const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO provider_connections (id, provider, label, secret_enc, secret_hint, status, created_at, updated_at) VALUES ('C1','anthropic','Anthropic',x'00','abcd','valid',?,?)").run(now, now);
    s.ctx.db.prepare("INSERT INTO model_assignments (agent, connection_id, model_id, settings_json, updated_at) VALUES ('brainstorm','C1','claude-sonnet-5-5','{}',?)").run(now);
    setCap(true);
    imageId = s.ctx.newId();
    fs.mkdirSync(path.join(s.ctx.paths.media, 'img'), { recursive: true });
    fs.writeFileSync(path.join(s.ctx.paths.media, 'img', 'cta.png'), PNG);
    s.ctx.db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, status, created_at, updated_at) VALUES (?,?,'image','cta.png','sha-cta',?,?,'ready',?,?)").run(imageId, pid, PNG.length, 'img/cta.png', now, now);
  });
  afterAll(async () => { await s.close(); });

  it('FR-212: a message stored with a proposal lacking params (older build) reads normalised and can be handed off', async () => {
    const conv = (await body<{ conversationId: string }>(await s.api(`/projects/${pid}/conversations/brainstorm`))).conversationId;
    const mid = s.ctx.newId(); const pidA = s.ctx.newId(); const pidB = s.ctx.newId();
    const stored = [{ type: 'text', text: `${QA_INVOKE}\nIde CTA: "Bangun Bersama Kami".` },
      { type: 'proposed_intents', handoffState: 'pending', intents: [
        { id: pidA, category: 'text', needsInterpretation: true, instruction: 'Tambahkan teks CTA "Bangun Bersama Kami" di akhir', source: 'brainstorm' },
        { id: pidB, category: 'asset', needsInterpretation: true, instruction: 'pakai gambar cta.png sebagai CTA', source: 'brainstorm', params: null }] }];
    s.ctx.db.prepare("INSERT INTO messages (id, conversation_id, role, blocks_json, agent_run_id, created_at) VALUES (?,?,'assistant',?,NULL,?)").run(mid, conv, JSON.stringify(stored), new Date().toISOString());
    const items = await thread();
    const m = items.find((x) => x.id === mid)!;
    const card = m.blocks.find((b) => b.type === 'proposed_intents')!;
    expect(card.intents!.map((i) => i['params'])).toEqual([{}, {}]);
    // what the model gets back as history never carries the markup (it taught Claude to write more of it)
    let seen: ChatRequest | null = null;
    provider = fakeProvider([(req) => { seen = req; return '{"reply":"Siap."}'; }], 'claude-sonnet-5-5');
    const r = await s.api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'lanjut', baseVersion: head() } });
    expect(r.status).toBe(202);
    await finished((await body<{ runId: string }>(r)).runId);
    expect(JSON.stringify(seen!.messages)).not.toMatch(/invoke|parameter name/);
    expect(JSON.stringify(seen!.messages)).toContain('Bangun Bersama Kami');
    const h = await s.api(`/projects/${pid}/conversations/brainstorm/handoff`, { method: 'POST', json: { messageId: mid, baseVersion: head() } });
    expect(h.status).toBe(200);
    const res = await body<{ accepted: string[]; rejected: Array<{ id: string; code: string }> }>(h);
    expect([...res.accepted, ...res.rejected.map((x) => x.id)].sort()).toEqual([pidA, pidB].sort());
  });

  it('FR-211: native tool calls in Diskusi; the stored answer is clean and its proposals carry params {}', async () => {
    provider = fakeProvider([
      { text: 'Saya cek katalog dulu.', toolCalls: [{ id: 'toolu_1', name: 'catalogue_search', input: { query: 'gradient', category: 'background' } }] },
      JSON.stringify({ reply: 'Struktur 6 adegan dengan latar gradasi.', proposedIntents: [{ category: 'text', needsInterpretation: true, instruction: 'CTA di adegan 6', source: 'brainstorm' }] }),
    ], 'claude-sonnet-5-5', { nativeTools: true });
    events.length = 0;
    const r = await s.api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'Buatkan konten edukasi data center', baseVersion: head() } });
    const { runId } = await body<{ runId: string }>(r);
    await finished(runId);
    expect(events.filter((e) => e.name === 'agent.run.progress').map((e) => e.data['tool'] ? `tool:${String(e.data['tool'])}` : e.data['phase'])).toEqual(expect.arrayContaining(['reading', 'planning', 'tool:catalogue.search']));
    const last = (await thread()).at(-1)!;
    expect(last.blocks.find((b) => b.type === 'text')!.text).toBe('Struktur 6 adegan dengan latar gradasi.');
    expect(last.blocks.find((b) => b.type === 'proposed_intents')!.intents![0]).toMatchObject({ params: {}, category: 'text' });
  });

  it('FR-213: an image still importing is waited for, then sent as an image part', async () => {
    const id = s.ctx.newId(); const now = new Date().toISOString();
    fs.writeFileSync(path.join(s.ctx.paths.media, 'img', 'late.png'), PNG);
    s.ctx.db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, status, created_at, updated_at) VALUES (?,?,'image','late.png','pending-x',?,?,'ingesting',?,?)").run(id, pid, PNG.length, 'img/late.png', now, now);
    setTimeout(() => s.ctx.db.prepare("UPDATE assets SET status = 'ready' WHERE id = ?").run(id), 400);
    let seen: ChatRequest | null = null;
    provider = fakeProvider([(req) => { seen = req; return '{"reply":"Gambarnya cocok untuk CTA."}'; }], 'claude-sonnet-5-5');
    const r = await s.api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'pakai gambar ini sebagai CTA', baseVersion: head(), attachments: [{ assetId: id }] } });
    expect(r.status).toBe(202);
    const sent = await body<{ runId: string; message: Msg }>(r);
    expect(sent.message.blocks.find((b) => b.type === 'attachment')).toMatchObject({ sent: 'image' });
    await finished(sent.runId);
    expect(seen!.messages.at(-1)!.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64'), name: 'late.png' }]);
  });

  it('FR-213: an import that failed is refused with its code; a model without image input gets the name only', async () => {
    const bad = s.ctx.newId(); const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, status, error_code, created_at, updated_at) VALUES (?,?,'image','broken.png','sha-b',1,'img/broken.png','failed','EM-1003',?,?)").run(bad, pid, now, now);
    const f = await s.api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'ini', baseVersion: head(), attachments: [{ assetId: bad }] } });
    expect(f.status).toBe(422);
    expect((await body<{ error: { code: string } }>(f)).error.code).toBe('EM-1003');
    setCap(false);
    let seen: ChatRequest | null = null;
    provider = fakeProvider([(req) => { seen = req; return '{"reply":"Nama filenya cta.png."}'; }], 'claude-sonnet-5-5');
    const r = await s.api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'pakai ini', baseVersion: head(), attachments: [{ assetId: imageId }] } });
    expect(r.status).toBe(202);
    const sent = await body<{ runId: string; message: Msg }>(r);
    expect(sent.message.blocks.find((b) => b.type === 'attachment')).toMatchObject({ sent: 'name' });
    await finished(sent.runId);
    expect(seen!.messages.some((m) => m.images?.length)).toBe(false);
    expect(seen!.messages.at(-1)!.content).toContain('only the file name was sent');
    setCap(true);
  });

  it('FR-213: unknown image capability: a provider that refuses the image part gets the request again with the name only', async () => {
    setCap(null);
    const calls: ChatRequest[] = [];
    provider = { id: 'anthropic', model: 'claude-sonnet-5-5', complete: async () => { throw new Error('stream only'); }, async stream(req, onDelta) {
      calls.push(req);
      if (req.messages.some((m) => m.images?.length)) throw mapProviderError(Object.assign(new Error('provider HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.0: image input is not supported for this model"}}'), { statusCode: 400 }));
      onDelta('{"reply":"Oke."}'); return { text: '{"reply":"Oke."}', usage: { model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1, costUsd: null, approximate: true } };
    } };
    const r = await s.api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'lihat gambar', baseVersion: head(), attachments: [{ assetId: imageId }] } });
    const sent = await body<{ runId: string; message: Msg }>(r);
    await finished(sent.runId);
    expect(calls.map((c) => c.messages.some((m) => m.images?.length))).toEqual([true, false]);
    const stored = (await thread()).find((m) => m.id === sent.message.id)!;
    expect(stored.blocks.find((b) => b.type === 'attachment')).toMatchObject({ sent: 'name' });
    expect((await thread()).at(-1)!.blocks[0]!.text).toBe('Oke.');
    const cached = JSON.parse((s.ctx.db.prepare("SELECT models_json FROM provider_connections WHERE id = 'C1'").get() as { models_json: string }).models_json) as Array<{ imageInput: boolean | null }>;
    expect(cached[0]!.imageInput).toBe(false);
  });
});
