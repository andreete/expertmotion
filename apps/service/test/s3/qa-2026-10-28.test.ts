// QA 2026-10-28 (Windows, Claude Sonnet 5.5, direct Anthropic key) with the real S1 + S3 modules:
//  - FR-216 #1: research in Diskusi — the run gets the research block and native web tools, the answer stores its sources; with the
//    setting off the model is told why (never "I cannot browse");
//  - FR-219 #2/#3: "Kirim ke Editor" turns the draft into an Editor run (origin block, hand-off block planning → ready → applied);
//    "buatkan videonya" with a finished draft hands it over automatically;
//  - FR-221 #14: a document attached in the chat reaches the model as text;
//  - EM-4002: a 401 during an agent run marks the connection invalid; caption chips resolve to their page (FR-220).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyModel, hashModel } from '@expertmotion/composition-model';
import { fakeProvider, mapProviderError, resolvePointedTargets, type ChatProvider, type ChatRequest } from '@expertmotion/agents';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { agentsModule, draftRequest, MAKE_VIDEO_RE } from '../../src/modules/agents.js';
import { projectsModule } from '../../src/modules/projects.js';
import { compositionModule } from '../../src/modules/composition.js';
import { intentsModule } from '../../src/modules/intents.js';
import { body, waitFor } from './s3-helpers.js';

type Block = { type: string; text?: string; state?: string; editorRunId?: string; items?: Array<Record<string, unknown>>; from?: string; auto?: boolean; sent?: string; chars?: number };
type Msg = { id: string; role: string; blocks: Block[]; agentRunId: string | null };
const PLAN = JSON.stringify({ goal: 'Membuat 2 adegan', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'Ekspor nikel naik', background: 'preset:background.gradient' } }, { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 4000, title: 'Volume turun' } }], expectedDiff: '2 adegan' }], risks: [] });
const DRAFT = JSON.stringify({ reply: 'Draf: Adegan 1 (3 dtk): "Ekspor nikel naik". Adegan 2 (4 dtk): "Volume turun". Mau saya kirim ke Editor?', suggestedNextStep: 'send-to-editor' });

describe('QA 2026-10-28: research, separate chats with hand-off, documents, key refusal', () => {
  let s: TestService; let pid = '';
  let brain: ChatProvider & { calls: ChatRequest[] } = fakeProvider([DRAFT], 'claude-sonnet-5-5', { nativeTools: true, nativeWebResearch: true });
  let editor: ChatProvider & { calls: ChatRequest[] } = fakeProvider([PLAN], 'claude-sonnet-5-5', { nativeTools: true, nativeWebResearch: true });
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const head = () => hashModel(s.ctx.hooks.composition(pid).model);
  const thread = async (agent: 'brainstorm' | 'editor') => (await body<{ messages: { items: Msg[] } }>(await s.api(`/projects/${pid}/conversations/${agent}`))).messages.items;
  const finished = (runId: string) => waitFor(() => events.some((e) => (e.name === 'agent.run.done' || e.name === 'agent.run.failed') && (e.data['runId'] === runId || (e.data['run'] as { id?: string } | undefined)?.id === runId)), 8000);
  const send = async (agent: 'brainstorm' | 'editor', text: string, extra: Record<string, unknown> = {}) => body<{ runId: string; message: Msg }>(await s.api(`/projects/${pid}/conversations/${agent}/messages`, { method: 'POST', json: { text, baseVersion: head(), ...extra } }));
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, intentsModule, agentsModule] });
    s.ctx.hooks.providerFor = (agent) => (agent === 'editor' ? editor : brain);
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { events.push({ name, data: data as Record<string, unknown> }); return emit(name, data); };
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Nikel' } }))).id;
    const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO provider_connections (id, provider, label, secret_enc, secret_hint, status, created_at, updated_at) VALUES ('C1','anthropic','Anthropic',x'00','abcd','valid',?,?)").run(now, now);
    for (const a of ['brainstorm', 'editor']) s.ctx.db.prepare("INSERT INTO model_assignments (agent, connection_id, model_id, settings_json, updated_at) VALUES (?,'C1','claude-sonnet-5-5','{}',?)").run(a, now);
  });
  afterAll(async () => { await s.close(); });

  it('FR-216: Diskusi gets the research block + native web tools and stores the sources of the answer', async () => {
    brain = fakeProvider([{ text: '{"reply":"Nilai ekspor nikel naik 17,2% (ANTARA)."}', citations: [{ url: 'https://www.antaranews.com/berita/nikel', title: 'ANTARA', cited: true, citedText: 'naik 17,2 persen' }], webQueries: ['ekspor nikel 2026'] }], 'claude-sonnet-5-5', { nativeTools: true, nativeWebResearch: true });
    const r = await send('brainstorm', 'riset data ekspor nikel terbaru dong');
    await finished(r.runId);
    expect(brain.calls[0]!.system).toMatch(/You CAN research the internet/);
    expect(brain.calls[0]!.system).not.toMatch(/NOT available/);
    expect(brain.calls[0]!.webResearch).toMatchObject({ search: true, fetch: true });
    const last = (await thread('brainstorm')).at(-1)!;
    const src = last.blocks.find((b) => b.type === 'sources')!;
    expect(src.items).toEqual([{ url: 'https://www.antaranews.com/berita/nikel', title: 'ANTARA', citedText: 'naik 17,2 persen', cited: true }]);
    expect((src as { queries?: string[] }).queries).toEqual(['ekspor nikel 2026']);
    const progress = events.filter((e) => e.name === 'agent.run.progress' && e.data['runId'] === r.runId);
    expect(progress.some((e) => e.data['tool'] === 'web.search' && e.data['query'] === 'ekspor nikel 2026')).toBe(true);
  });

  it('FR-216: with "Izinkan riset internet" off the model is told the exact reason and gets no web tools', async () => {
    await s.api('/settings', { method: 'PUT', json: { webResearch: false } });
    brain = fakeProvider(['{"reply":"ok"}'], 'claude-sonnet-5-5', { nativeTools: true, nativeWebResearch: true });
    const r = await send('brainstorm', 'cari di internet');
    await finished(r.runId);
    expect(brain.calls[0]!.system).toMatch(/Internet research is NOT available in this chat right now because the setting "Allow internet research" \(Izinkan riset internet\) is off/);
    expect(brain.calls[0]!.webResearch).toBeUndefined();
    await s.api('/settings', { method: 'PUT', json: { webResearch: true } });
  });

  it('FR-219: "Kirim ke Editor" starts an Editor run from the whole draft; the draft\'s hand-off card follows it to applied', async () => {
    brain = fakeProvider([DRAFT], 'claude-sonnet-5-5', { nativeTools: true });
    editor = fakeProvider([PLAN], 'claude-sonnet-5-5', { nativeTools: true });
    const r = await send('brainstorm', 'ide video ekspor nikel');
    await finished(r.runId);
    const draft = (await thread('brainstorm')).at(-1)!;
    const res = await body<{ runId: string; message: Msg; brainstormMessage: Msg }>(await s.api(`/projects/${pid}/conversations/brainstorm/messages/${draft.id}/send-to-editor`, { method: 'POST', json: { baseVersion: head() } }));
    expect(res.message.blocks.find((b) => b.type === 'origin')).toMatchObject({ from: 'brainstorm' });
    expect(res.message.blocks[0]!.text).toMatch(/^Kerjakan draf dari Diskusi ini di video sekarang\. Ikuti persis/);
    expect(res.message.blocks[0]!.text).toContain('Ekspor nikel naik');
    expect(res.brainstormMessage.blocks.find((b) => b.type === 'handoff')).toMatchObject({ state: 'planning', editorRunId: res.runId });
    await finished(res.runId);
    const after = (await thread('brainstorm')).find((m) => m.id === draft.id)!;
    expect(after.blocks.find((b) => b.type === 'handoff')).toMatchObject({ state: 'ready' });
    expect(events.some((e) => e.name === 'agent.message.updated')).toBe(true);
    expect(editor.calls[0]!.messages[0]!.content).toContain('"discussion"');                       // the Editor also sees the discussion
    const planId = events.filter((e) => e.name === 'agent.run.done' && (e.data['run'] as { id: string }).id === res.runId).map((e) => e.data['planId'] as string)[0]!;
    const ex = await body<{ ok: boolean }>(await s.api(`/plans/${planId}/execute`, { method: 'POST', json: {} }));
    expect(ex.ok).toBe(true);
    expect((await thread('brainstorm')).find((m) => m.id === draft.id)!.blocks.find((b) => b.type === 'handoff')).toMatchObject({ state: 'applied' });
  });

  it('FR-219: "buatkan videonya" with a finished draft hands it to the Editor automatically', async () => {
    expect(MAKE_VIDEO_RE.test('oke buatkan videonya')).toBe(true);
    expect(MAKE_VIDEO_RE.test('gas, kerjakan di editor')).toBe(true);
    expect(MAKE_VIDEO_RE.test('apa itu hook?')).toBe(false);
    brain = fakeProvider([DRAFT], 'claude-sonnet-5-5', { nativeTools: true });
    editor = fakeProvider([PLAN], 'claude-sonnet-5-5', { nativeTools: true });
    const before = (await thread('editor')).length;
    const r = await send('brainstorm', 'oke buatkan videonya sekarang');
    await finished(r.runId);
    await waitFor(async () => (await thread('editor')).length > before, 5000);
    const origin = (await thread('editor')).filter((m) => m.role === 'user').at(-1)!.blocks.find((b) => b.type === 'origin');
    expect(origin).toMatchObject({ from: 'brainstorm', auto: true });
    await waitFor(() => events.some((e) => e.name === 'agent.run.done' && (e.data['run'] as { agent?: string }).agent === 'editor' && events.indexOf(e) > events.findIndex((x) => x.data['runId'] === r.runId)), 8000);
  });

  it('draftRequest keeps the texts and proposals and says not to ask back', () => {
    const d = draftRequest({ blocks: [{ type: 'text', text: 'Adegan 1: "Halo"' }, { type: 'proposed_intents', handoffState: 'pending', intents: [{ id: 'a', category: 'text', params: {}, needsInterpretation: true, source: 'brainstorm', instruction: 'Adegan 1 (3s): judul Halo' } as never] }] }, 'id');
    expect(d.text).toMatch(/jangan ubah angka, teks, atau naskah narasi/);
    expect(d.text).toContain('1. Adegan 1 (3s): judul Halo');
    expect(d.scenes).toBe(1);
  });

  it('FR-221: a document attached in the chat reaches the model as text (truncation noted)', async () => {
    const doc = await body<{ document: { id: string; kind: string; chars: number } }>(await s.api(`/projects/${pid}/chat-documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Expertmotion-Filename': encodeURIComponent('naskah nikel.md') }, body: '# Naskah\n\nv1: Ekspor nikel Indonesia naik tujuh belas persen.\n' }));
    expect(doc.document).toMatchObject({ kind: 'text' });
    brain = fakeProvider(['{"reply":"Naskahnya sudah saya baca."}'], 'claude-sonnet-5-5', { nativeTools: true });
    const r = await send('brainstorm', 'baca naskah ini', { documents: [{ documentId: doc.document.id }] });
    await finished(r.runId);
    const last = brain.calls[0]!.messages.at(-1)!;
    expect(last.content).toContain('[Attached document "naskah nikel.md"');
    expect(last.content).toContain('Ekspor nikel Indonesia naik tujuh belas persen.');
    const user = (await thread('brainstorm')).find((m) => m.agentRunId === r.runId && m.role === 'user')!;
    expect(user.blocks.find((b) => b.type === 'attachment')).toMatchObject({ sent: 'text', name: 'naskah nikel.md' });
    const bad = await s.api(`/projects/${pid}/chat-documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Expertmotion-Filename': 'film.mp4' }, body: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]) });
    expect(bad.status).toBe(422);
  });

  it('EM-4002: Anthropic 401 "invalid x-api-key" keeps its reason in the failure', async () => {
    const real = providersModule;
    void real;
    brain = fakeProvider([Object.assign(new Error('provider HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { statusCode: 401 })]);
    // the hook replaced by the test bypasses the real providerFor, so call the mapping and the marker path the way providerFor does
    const em = mapProviderError(Object.assign(new Error('provider HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { statusCode: 401 }));
    expect(em).toMatchObject({ code: 'EM-4002', details: { status: 401, reason: 'invalid x-api-key' } });
    const r = await send('brainstorm', 'halo');
    await finished(r.runId);
    const failed = events.find((e) => e.name === 'agent.run.failed' && e.data['runId'] === r.runId)!;
    expect(failed.data['code']).toBe('EM-4002');
    expect((failed.data['details'] as { reason?: string }).reason).toBe('invalid x-api-key');
  });

  it('FR-220: a caption chip resolves to its page text and time; the envelope names op:caption.replaceText', () => {
    const model = createEmptyModel('p');
    model.tracks.caption.pages = [{ text: 'Kita butuh energi', startMs: 0, durationMs: 2000, tokens: [] }, { text: 'energi besi. Tantangannya', startMs: 17_000, durationMs: 1500, tokens: [] }] as never;
    const [t] = resolvePointedTargets([{ kind: 'caption', index: 1, label: 'Caption 0:17 “energi besi…”', startMs: 17_000, endMs: 18_500 }], model, []);
    expect(t).toMatchObject({ kind: 'caption', index: 1, facts: { pageIndex: 1, text: 'energi besi. Tantangannya', startMs: 17_000, endMs: 18_500 } });
    const [byTime] = resolvePointedTargets([{ kind: 'caption', label: 'Caption', startMs: 17_200 }], model, []);
    expect(byTime).toMatchObject({ index: 1 });
  });
});

describe('QA 2026-10-28 EM-4002: a key the provider rejects during an agent run (real providerFor)', () => {
  let s: TestService; let pid = '';
  const KEY = `sk-ant-api03-${'x'.repeat(40)}`;
  let rejected = false;
  beforeAll(async () => {
    const { createProvidersModule } = await import('../../src/modules/providers.js');
    const { fakeEgress, json } = await import('./s3-helpers.js');
    s = await startService({ modules: [health, settingsModule, createProvidersModule({ enabledProviders: ['anthropic'] }), usageModule, projectsModule, compositionModule, intentsModule, agentsModule] });
    fakeEgress(s, [(c) => {
      if (!c.url.startsWith('https://api.anthropic.com/')) return undefined;
      if (c.url.includes('/v1/models')) return json(200, { data: [{ type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1_000_000, capabilities: { image_input: { supported: true } } }], has_more: false });
      if (c.url.endsWith('/v1/messages')) return rejected ? json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) : json(403, { type: 'error', error: { type: 'permission_error', message: 'Web search is not enabled for this organization' } });
      return undefined;
    }]);
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Key' } }))).id;
  });
  afterAll(async () => { await s.close(); });

  it('a 403 about a feature is not "key not accepted"; a 401 invalid x-api-key marks the connection invalid', async () => {
    const conn = await body<{ id: string; status: string }>(await s.api('/providers/connections', { method: 'POST', json: { provider: 'anthropic', label: 'Anthropic', secret: KEY, validateNow: true } }));
    expect(conn.status).toBe('valid');
    s.ctx.db.prepare("INSERT OR REPLACE INTO model_assignments (agent, connection_id, model_id, settings_json, updated_at) VALUES ('brainstorm',?,'claude-sonnet-5-5','{}',?)").run(conn.id, new Date().toISOString());
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { events.push({ name, data: data as Record<string, unknown> }); return emit(name, data); };
    const head = () => hashModel(s.ctx.hooks.composition(pid).model);
    const ask = async () => {
      const r = await body<{ runId: string }>(await s.api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', json: { text: 'halo', baseVersion: head() } }));
      await waitFor(() => events.some((e) => e.name === 'agent.run.failed' && e.data['runId'] === r.runId), 8000);
      return events.find((e) => e.name === 'agent.run.failed' && e.data['runId'] === r.runId)!.data;
    };
    const f1 = await ask();
    expect(f1['code']).not.toBe('EM-4002');
    expect((s.ctx.db.prepare('SELECT status FROM provider_connections WHERE id = ?').get(conn.id) as { status: string }).status).toBe('valid');
    rejected = true;
    const f2 = await ask();
    expect(f2['code']).toBe('EM-4002');
    expect((f2['details'] as { reason?: string }).reason).toBe('invalid x-api-key');
    expect((s.ctx.db.prepare('SELECT status FROM provider_connections WHERE id = ?').get(conn.id) as { status: string }).status).toBe('invalid');
    expect(events.some((e) => e.name === 'settings.changed' && e.data['scope'] === 'providers')).toBe(true);
  });
});

describe('FR-224 voice-first Execute (acceptance prompt "Ekspor Nikel Indonesia 2026")', () => {
  let s: TestService; let pid = '';
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  let fail = false;
  beforeAll(async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../packages/agents/test/fixtures/nikel-spec.json'), 'utf8')) as Record<string, unknown>;
    const { assetsModule } = await import('../../src/modules/assets.js');
    s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, assetsModule, intentsModule, agentsModule] });
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { events.push({ name, data: data as Record<string, unknown> }); return emit(name, data); };
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Nikel 9:16', settings: { ratio: '9:16', resolution: '1080p', fps: 30, language: 'id' } } }))).id;
    s.ctx.hooks.providerFor = () => fakeProvider([JSON.stringify({ goal: 'Video ekspor nikel 6 adegan', steps: [{ n: 1, tool: 'scene.compose', args: spec, expectedDiff: '6 adegan' }], risks: [] })], 'claude-sonnet-5-5');
    // G's voice batch (FR-251): one job, every clip an audio asset with its measured length
    s.ctx.hooks.voiceBatch = async (projectId, input) => {
      if (fail) throw Object.assign(new (await import('@expertmotion/shared')).EmError('EM-7001', 'The voice model is not installed.'), {});
      const now = new Date().toISOString(); let at = 0;
      const clips = input.clips.map((c, i) => {
        const id = s.ctx.newId(); const durationMs = 2000 + i * 150;
        s.ctx.db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, duration_ms, has_audio, status, created_at, updated_at) VALUES (?,?,'audio',?,?,100,?,?,1,'ready',?,?)").run(id, projectId, `${c.id}.wav`, `sha-${id}`, `a/${c.id}.wav`, durationMs, now, now);
        const r = { id: c.id, assetId: id, name: `${c.id}.wav`, durationMs, atMs: at, endMs: at + durationMs, scene: null, timing: 'measured', cues: [] }; at += durationMs + 300; return r;
      });
      return { jobId: 'job1', batch: true, voiceId: input.voiceId, speed: 1, regenerated: false, totalMs: at, overLimit: false, costUsd: 0, clips };
    };
  });
  afterAll(async () => { await s.close(); });
  const plan = async () => {
    const head = hashModel(s.ctx.hooks.composition(pid).model);
    const r = await body<{ plan: { id: string } }>(await s.api(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: head, message: 'Buat video … jangan tanya balik' } }));
    await waitFor(() => events.some((e) => e.name === 'plan.ready' && (e.data['plan'] as { id: string }).id === r.plan.id), 8000);
    return events.filter((e) => e.name === 'plan.ready' && (e.data['plan'] as { id: string }).id === r.plan.id).at(-1)!.data['plan'] as { id: string; steps: Array<{ n: number; tool: string; args: Record<string, unknown>; ops: unknown[] }> };
  };

  it('the preview plan keeps the VideoSpec and one voice step per clip (estimated timing until Execute)', async () => {
    const p = await plan();
    expect(p.steps[0]!.tool).toBe('composition.applyOps');
    expect((p.steps[0]!.args['sceneCompose'] as { voice: { clips: unknown[] } }).voice.clips).toHaveLength(9);
    expect(p.steps.filter((x) => x.tool === 'tts.generate').map((x) => x.args['clipId'])).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
  });

  it('Execute makes the 9 voice clips FIRST, measures them, composes again and applies ONE version with every clip placed', async () => {
    fail = false;
    const p = await plan();
    const before = s.ctx.hooks.composition(pid).versionId;
    const r = await body<{ ok: boolean; toVersion: string }>(await s.api(`/plans/${p.id}/execute`, { method: 'POST', json: {} }));
    expect(r.ok).toBe(true);
    const phases = events.filter((e) => e.name === 'plan.progress' && e.data['planId'] === p.id).map((e) => e.data['phase']);
    expect(phases).toEqual(['voice', 'measure', 'compose', 'apply']);
    const m = s.ctx.hooks.composition(pid).model;
    expect(s.ctx.hooks.composition(pid).versionId).not.toBe(before);
    const voices = m.tracks.audio.filter((a) => a.role === 'voice');
    expect(voices).toHaveLength(9);
    for (let i = 1; i < voices.length; i++) expect(voices[i]!.atMs).toBeGreaterThan(voices[i - 1]!.atMs);   // in order, after each other
    const stored = (await body<{ steps: Array<{ tool: string; args: Record<string, unknown> }> ; risks: Array<{ code: string; message: string }> }>(await s.api(`/plans/${p.id}`)));
    expect(stored.steps.some((x) => x.tool === 'tts.generate')).toBe(false);                 // the voices were made before the commit
    expect(stored.steps[0]!.args['measured']).toBe(true);
    expect(stored.risks.find((x) => x.code === 'voice-measured')?.message).toMatch(/Durasi adegan mengikuti suara yang dibuat: 6 adegan/);
  });

  it('a failed voice-over stops Execute with the reason and changes nothing (no invented timing)', async () => {
    fail = true;
    const p = await plan();
    const before = s.ctx.hooks.composition(pid).versionId;
    const r = await body<{ ok: boolean; error: { code: string; message: string } }>(await s.api(`/plans/${p.id}/execute`, { method: 'POST', json: {} }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('EM-7001');
    expect(r.error.message).toMatch(/Nothing was changed/);
    expect(s.ctx.hooks.composition(pid).versionId).toBe(before);
    fail = false;
  });
});
