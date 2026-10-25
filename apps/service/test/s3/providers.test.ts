import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmError } from '@expertmotion/shared';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { createSecretBox } from '../../src/s3/crypto.js';
import { chatProviderFor, listModels, validateKey } from '../../src/s3/adapters.js';
import { addProject, body, fakeEgress, json, waitFor, type FakeCall } from './s3-helpers.js';

const GOOD = `sk-or-v1-${'a1b2c3d4'.repeat(5)}WXYZ`;
const BAD = `sk-or-v1-${'0'.repeat(40)}BADK`;
const MODELS = { data: [
  { id: 'good/model', name: 'Good', context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools', 'response_format'], architecture: { input_modalities: ['text', 'image'] } },
  { id: 'nojson/model', name: 'No JSON', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
  { id: 'small/model', name: 'Small', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000001' }, supported_parameters: ['response_format'] },
] };
let chatReply: (c: FakeCall) => Response = () => json(200, { id: 'gen-1', object: 'chat.completion', created: 1, model: 'good/model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'halo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0042 } });
const openrouter = (c: FakeCall) => {
  if (!c.url.startsWith('https://openrouter.ai/')) return undefined;
  if (c.headers['authorization'] !== `Bearer ${GOOD}`) return json(401, { error: { message: 'No auth credentials found', code: 401 } });
  if (c.url.endsWith('/api/v1/key')) return json(200, { data: { label: 'x' } });
  if (c.url.endsWith('/api/v1/models')) return json(200, MODELS);
  if (c.url.endsWith('/chat/completions')) return chatReply(c);
  return undefined;
};

describe('providers module', () => {
  let s: TestService; let calls: FakeCall[]; let connId = ''; let projectId = '';
  beforeAll(async () => { s = await startService({ modules: [health, settingsModule, providersModule, usageModule] }); calls = fakeEgress(s, [openrouter]); projectId = addProject(s); });
  afterAll(async () => { await s.close(); });

  it('adds a connection: validates, stores the key sealed, returns only a hint, refreshes models in the background', async () => {
    const r = await s.api('/providers/connections', { method: 'POST', json: { provider: 'openrouter', label: 'Utama', secret: GOOD } });
    const txt = await r.text();
    expect(r.status).toBe(201);
    expect(txt).not.toContain(GOOD);
    const dto = JSON.parse(txt) as { id: string; status: string; secretHint: string };
    connId = dto.id;
    expect(dto).toMatchObject({ status: 'valid', secretHint: '…WXYZ' });
    expect(r.headers.get('location')).toBe(`/api/v1/providers/connections/${connId}`);
    const row = s.ctx.db.prepare('SELECT secret_enc FROM provider_connections WHERE id = ?').get(connId) as { secret_enc: Buffer };
    expect(Buffer.isBuffer(row.secret_enc)).toBe(true);
    expect(row.secret_enc.includes(Buffer.from(GOOD))).toBe(false);
    expect(row.secret_enc.includes(Buffer.from('a1b2c3d4'))).toBe(false);
    expect(createSecretBox(s.cfg.dbKeyHex).open(row.secret_enc, `provider_connections:${connId}`)).toBe(GOOD);
    expect(() => createSecretBox(s.cfg.dbKeyHex).open(row.secret_enc, 'provider_connections:OTHER')).toThrow(EmError);
    await waitFor(() => !!(s.ctx.db.prepare('SELECT models_fetched_at f FROM provider_connections WHERE id = ?').get(connId) as { f: string | null }).f);
    const m = await body<{ items: Array<{ modelId: string; structuredOutput: boolean; pricePerMInput: number | null; imageInput: boolean }>; stale: boolean }>(await s.api(`/providers/connections/${connId}/models`));
    expect(m.stale).toBe(false);
    expect(m.items.find((x) => x.modelId === 'good/model')).toMatchObject({ structuredOutput: true, pricePerMInput: 1, imageInput: true });
    expect(m.items.find((x) => x.modelId === 'nojson/model')?.structuredOutput).toBe(false);
    const list = await (await s.api('/providers/connections')).text();
    expect(list).not.toContain(GOOD);
    expect(calls.every((c) => c.url.startsWith('https://openrouter.ai/'))).toBe(true);
  });

  it('a rejected key → 422 EM-4002 and the connection is kept as invalid', async () => {
    const r = await s.api('/providers/connections', { method: 'POST', json: { provider: 'openrouter', label: 'Salah', secret: BAD } });
    expect(r.status).toBe(422);
    const e = await body<{ error: { code: string; details: { connectionId: string } } }>(r);
    expect(e.error.code).toBe('EM-4002');
    const row = s.ctx.db.prepare('SELECT status FROM provider_connections WHERE id = ?').get(e.error.details.connectionId) as { status: string };
    expect(row.status).toBe('invalid');
    expect((await s.api(`/providers/connections/${e.error.details.connectionId}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('OpenRouter, OpenAI, Anthropic and Gemini are enabled; custom stays P2 (PRD-032 pulled forward)', async () => {
    const r = await s.api('/providers/kinds');
    const items = (await body<{ items: { provider: string; enabled: boolean }[] }>(r)).items;
    expect(Object.fromEntries(items.map((i) => [i.provider, i.enabled]))).toEqual({ openrouter: true, openai: true, anthropic: true, google: true, custom: false });
  });

  it('PATCH with a new secret resets status; custom providers are EM-9004', async () => {
    const r = await s.api(`/providers/connections/${connId}`, { method: 'PATCH', json: { label: 'Utama 2', budgetMonthUsd: 5 } });
    expect(await body(r)).toMatchObject({ label: 'Utama 2', budgetMonthUsd: 5, status: 'valid' });
    const c = await s.api('/providers/connections', { method: 'POST', json: { provider: 'custom', label: 'x', secret: 'abcdefgh1234', baseUrl: 'https://llm.example' } });
    expect((await body<{ error: { code: string } }>(c)).error.code).toBe('EM-9004');
    const bad = await s.api('/providers/connections', { method: 'POST', json: { provider: 'openrouter', label: 'x', secret: 'abcdefgh1234', baseUrl: 'https://llm.example' } });
    expect(bad.status).toBe(400);
  });

  it('assignment validation: a model without JSON output is stored with a warning, unknown model refused, warnings for no tools and small context', async () => {
    const put = (b: unknown) => s.api('/providers/assignments', { method: 'PUT', json: b });
    const noJson = await put({ editor: { agent: 'editor', connectionId: connId, modelId: 'nojson/model' } });   // Operator decision 2026-10-25: allowed
    expect(noJson.status).toBe(200);
    const nj = await body<{ editor: { modelId: string }; warnings: Array<{ code: string; severity: string; message: string }> }>(noJson);
    expect(nj.editor.modelId).toBe('nojson/model');
    expect(nj.warnings).toEqual([expect.objectContaining({ code: 'EM-4005', severity: 'warn', message: expect.stringMatching(/does not confirm JSON output/) })]);
    expect((await body<{ editor: { modelId: string } }>(await s.api('/providers/assignments'))).editor.modelId).toBe('nojson/model');
    // the agent runtime still calls such a model (JSON-mode prompting, ADR-023); no extra provider call is added
    const before = calls.filter((c) => c.url.endsWith('/chat/completions')).length;
    const viaNoJson = await s.ctx.hooks.providerFor('editor', projectId).complete({ system: 'sys', messages: [{ role: 'user', content: 'hai' }], maxTokens: 50, temperature: 0 });
    expect(viaNoJson.text).toBe('halo');
    const chats = calls.filter((c) => c.url.endsWith('/chat/completions'));
    expect(chats.length).toBe(before + 1);
    expect((chats.at(-1)!.body as { model: string }).model).toBe('nojson/model');
    const unknown = await put({ editor: { agent: 'editor', connectionId: connId, modelId: 'gone/model' } });
    expect((await body<{ error: { code: string } }>(unknown)).error.code).toBe('EM-4004');
    const mismatch = await put({ editor: { agent: 'brainstorm', connectionId: connId, modelId: 'good/model' } });
    expect(mismatch.status).toBe(400);
    const small = await put({ brainstorm: { agent: 'brainstorm', connectionId: connId, modelId: 'small/model' } });
    const w = await body<{ warnings: Array<{ code: string }>; brainstorm: { modelId: string } }>(small);
    expect(w.warnings.map((x) => x.code).sort()).toEqual(['EM-4005', 'EM-4306']);
    const ok = await put({ editor: { agent: 'editor', connectionId: connId, modelId: 'good/model', settings: { temperature: 0.3 } }, brainstorm: { agent: 'brainstorm', connectionId: connId, modelId: 'good/model' } });
    expect(await body(ok)).toMatchObject({ editor: { modelId: 'good/model', settings: { temperature: 0.3 } }, brainstorm: { modelId: 'good/model' }, defaultConnectionId: connId, warnings: [] });
  });

  it('providerFor calls the model through egress and records the provider-reported cost', async () => {
    const p = s.ctx.hooks.providerFor('editor', projectId);
    const r = await p.complete({ system: 'sys', messages: [{ role: 'user', content: 'hai' }], maxTokens: 100, temperature: 0.5 });
    expect(r.text).toBe('halo');
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    const chat = calls.filter((c) => c.url.endsWith('/chat/completions')).at(-1)!;
    expect((chat.body as { temperature: number }).temperature).toBe(0.3);       // assignment setting wins
    const runId = s.ctx.newId();
    s.ctx.hooks.recordUsage(projectId, 'editor', runId, [r.usage, { model: 'good/model', inputTokens: 1_000_000, outputTokens: 0, costUsd: null, approximate: true }]);
    const rows = s.ctx.db.prepare('SELECT cost_usd c, approximate a FROM usage_records WHERE agent_run_id = ? ORDER BY id').all(runId) as Array<{ c: number | null; a: number }>;
    expect(rows[0]!.c).toBeCloseTo(r.usage.costUsd ?? 0.0042, 6);
    expect(rows[1]).toEqual({ c: 1, a: 1 });                                        // Capability Table price, approximate
    const u = await body<{ project: { costUsd: number; approximate: boolean; runs: number }; byAgent: { editor: { runs: number } } }>(await s.api(`/projects/${projectId}/usage`));
    expect(u.project.runs).toBe(1); expect(u.project.approximate).toBe(true); expect(u.byAgent.editor.runs).toBe(1);
  });

  it('budgets: per-project and monthly caps refuse new runs with EM-4201', async () => {
    expect(() => s.ctx.hooks.budgetCheck(projectId)).not.toThrow();
    const put = await s.api('/providers/budget', { method: 'PUT', json: { projects: [{ projectId, limitUsd: 0.5 }] } });
    const view = await body<{ projects: Array<{ projectId: string; limitUsd: number; spentUsd: number }>; connections: Array<{ spentMonthUsd: number }> }>(put);
    expect(view.projects[0]).toMatchObject({ projectId, limitUsd: 0.5 });
    expect(view.projects[0]!.spentUsd).toBeGreaterThan(1);
    let err: unknown; try { s.ctx.hooks.budgetCheck(projectId); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'EM-4201', details: { scope: 'project' } });
    await s.api('/providers/budget', { method: 'PUT', json: { projects: [{ projectId, limitUsd: null }], connections: [{ connectionId: connId, budgetMonthUsd: 0.01 }] } });
    try { s.ctx.hooks.budgetCheck(projectId); err = null; } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'EM-4201', details: { scope: 'month', connectionId: connId } });
    const u = await body<{ budget: { exceeded: boolean; warn80: boolean } }>(await s.api(`/projects/${projectId}/usage`));
    expect(u.budget).toMatchObject({ exceeded: true, warn80: true });
    await s.api('/providers/budget', { method: 'PUT', json: { connections: [{ connectionId: connId, budgetMonthUsd: null }] } });
    expect(() => s.ctx.hooks.budgetCheck(projectId)).not.toThrow();
  });

  it('budgets: a per-project cap per connection (FR-117) refuses runs with EM-4201 naming that connection', async () => {
    const put = await s.api('/providers/budget', { method: 'PUT', json: { projects: [{ projectId, connectionId: connId, limitUsd: 0.5 }] } });
    const view = await body<{ projects: Array<{ projectId: string; connectionId: string | null; limitUsd: number | null; spentUsd: number }> }>(put);
    const row = view.projects.find((p) => p.connectionId === connId)!;
    expect(row).toMatchObject({ projectId, limitUsd: 0.5 });
    expect(row.spentUsd).toBeGreaterThan(1);
    let err: unknown; try { s.ctx.hooks.budgetCheck(projectId); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'EM-4201', details: { scope: 'project', connectionId: connId, limitUsd: 0.5 } });
    expect((err as Error).message).toContain(' on ');
    const bad = await s.api('/providers/budget', { method: 'PUT', json: { projects: [{ projectId, connectionId: connId, limitUsd: 20_000 }] } });
    expect(bad.status).toBe(400);
    await s.api('/providers/budget', { method: 'PUT', json: { projects: [{ projectId, connectionId: connId, limitUsd: 0 }] } });   // 0 = unlimited
    expect(() => s.ctx.hooks.budgetCheck(projectId)).not.toThrow();
  });

  it('Private Mode blocks validation, model refresh and agents without any outbound call', async () => {
    await s.api('/settings', { method: 'PUT', json: { privateMode: true } });
    const before = calls.length;
    const v = await s.api(`/providers/connections/${connId}/validate`, { method: 'POST' });
    expect(v.status).toBe(423);
    expect((await body<{ error: { code: string } }>(v)).error.code).toBe('EM-8202');
    expect((await s.api(`/providers/connections/${connId}/models/refresh`, { method: 'POST' })).status).toBe(423);
    const add = await s.api('/providers/connections', { method: 'POST', json: { provider: 'openrouter', label: 'Offline', secret: GOOD } });
    expect(add.status).toBe(201);
    expect(await body(add)).toMatchObject({ status: 'unvalidated', notices: ['EM-8202'] });
    expect(() => s.ctx.hooks.providerFor('editor', projectId)).toThrow(expect.objectContaining({ code: 'EM-4401' }));
    expect(calls.length).toBe(before);
    await s.api('/settings', { method: 'PUT', json: { privateMode: false } });
  });

  it('turning Private Mode on aborts an in-flight provider call', async () => {
    let release!: () => void;
    chatReply = () => undefined as unknown as Response;
    const slow = (c: FakeCall) => (c.url.endsWith('/chat/completions') ? new Promise<Response>((res) => { release = () => res(json(500, {})); }) : undefined);
    fakeEgress(s, [slow, openrouter]);
    const p = s.ctx.hooks.providerFor('editor', projectId).complete({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, temperature: 0 });
    const settled = p.then(() => null, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    await s.api('/settings', { method: 'PUT', json: { privateMode: true } });
    expect(await settled).toMatchObject({ code: 'EM-8202' });
    release?.();
    await s.api('/settings', { method: 'PUT', json: { privateMode: false } });
    calls = fakeEgress(s, [openrouter]);
  });

  it('delete refuses while assigned unless forced', async () => {
    const r = await s.api(`/providers/connections/${connId}`, { method: 'DELETE' });
    expect(r.status).toBe(409);
    expect((await body<{ error: { code: string; details: { assignments: string[] } } }>(r)).error).toMatchObject({ code: 'EM-2309', details: { assignments: ['brainstorm', 'editor'] } });
    expect((await s.api(`/providers/connections/${connId}?force=true`, { method: 'DELETE' })).status).toBe(204);
    expect(await body(await s.api('/providers/assignments'))).toMatchObject({ brainstorm: null, editor: null });
    expect(() => s.ctx.hooks.providerFor('editor', projectId)).toThrow(expect.objectContaining({ code: 'EM-4007' }));
  });

  it('never writes a key to the logs', () => {
    const logs = fs.readdirSync(s.ctx.paths.logs).map((f) => fs.readFileSync(path.join(s.ctx.paths.logs, f), 'utf8')).join('');
    expect(logs).not.toContain(GOOD); expect(logs).not.toContain('a1b2c3d4a1b2');
  });
});

describe('fetch adapters (OpenAI, Anthropic, Gemini) and error mapping', () => {
  const mk = (handler: (c: { url: string; init: RequestInit }) => Response | Promise<Response>) => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (u: string, init: RequestInit = {}) => { const c = { url: String(u), init }; seen.push(c); return handler(c); }) as unknown as typeof fetch;
    return { f, seen };
  };
  const req = { system: 'sys', messages: [{ role: 'user' as const, content: 'hai' }, { role: 'assistant' as const, content: 'ya' }, { role: 'user' as const, content: 'lagi' }], maxTokens: 50, temperature: 1.5 };

  it('OpenAI: models filtered to chat models, chat completions mapped', async () => {
    const { f, seen } = mk((c) => (c.url.endsWith('/models') ? json(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }, { id: 'o3' }] })
      : json(200, { choices: [{ message: { content: '{"reply":"ok"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } })));
    expect((await listModels('openai', 'sk-test-openai-key-123456789', f)).map((m) => m.modelId)).toEqual(['gpt-4o-mini', 'o3']);
    const r = await chatProviderFor('openai', 'sk-test-openai-key-123456789', 'gpt-4o-mini', f).complete(req);
    expect(r).toMatchObject({ text: '{"reply":"ok"}', usage: { inputTokens: 12, outputTokens: 3, costUsd: null, approximate: true } });
    const b = JSON.parse(String(seen.at(-1)!.init.body)) as { messages: Array<{ role: string }> };
    expect(b.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect((seen.at(-1)!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test-openai-key-123456789');
  });
  it('Anthropic: x-api-key header, system separate, temperature clamped to 1', async () => {
    const { f, seen } = mk((c) => (c.url.includes('/models') ? json(200, { data: [{ id: 'claude-x', display_name: 'Claude X' }] })
      : json(200, { content: [{ type: 'text', text: 'halo' }], usage: { input_tokens: 9, output_tokens: 2 } })));
    await validateKey('anthropic', 'sk-ant-test-key-1234567890', f);
    expect((await listModels('anthropic', 'sk-ant-test-key-1234567890', f))[0]).toMatchObject({ modelId: 'claude-x', label: 'Claude X' });
    const r = await chatProviderFor('anthropic', 'sk-ant-test-key-1234567890', 'claude-x', f).complete(req);
    expect(r.text).toBe('halo');
    const last = seen.at(-1)!; const b = JSON.parse(String(last.init.body)) as { system: string; temperature: number; max_tokens: number };
    expect(b).toMatchObject({ system: 'sys', temperature: 1, max_tokens: 50 });
    expect((last.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test-key-1234567890');
  });
  it('Gemini: generateContent with roles user/model, key in header (never the URL)', async () => {
    const { f, seen } = mk((c) => (c.url.includes(':generateContent') ? json(200, { candidates: [{ content: { parts: [{ text: 'hai' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })
      : json(200, { models: [{ name: 'models/gemini-2.5-flash', displayName: 'Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] })));
    expect((await listModels('google', 'AIzaTESTKEY', f)).map((m) => m.modelId)).toEqual(['gemini-2.5-flash']);
    const r = await chatProviderFor('google', 'AIzaTESTKEY', 'gemini-2.5-flash', f).complete(req);
    expect(r.usage).toMatchObject({ inputTokens: 5, outputTokens: 1 });
    const last = seen.at(-1)!;
    expect(last.url).not.toContain('AIza');
    expect((JSON.parse(String(last.init.body)) as { contents: Array<{ role: string }> }).contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
  });
  it('maps 401/429/5xx/timeouts and refusals to EM codes', async () => {
    const status = (n: number) => mk(() => json(n, { error: 'x' })).f;
    await expect(validateKey('openai', 'k', status(401))).rejects.toMatchObject({ code: 'EM-4002' });
    await expect(chatProviderFor('openai', 'k', 'gpt-4o', status(429)).complete(req)).rejects.toMatchObject({ code: 'EM-4102' });
    await expect(chatProviderFor('anthropic', 'k', 'c', status(503)).complete(req)).rejects.toMatchObject({ code: 'EM-4103' });
    await expect(listModels('google', 'k', status(500))).rejects.toMatchObject({ code: 'EM-4006' });
    const hang = mk((c) => new Promise<Response>((_r, rej) => { c.init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))); })).f;
    await expect(chatProviderFor('openai', 'k', 'gpt-4o', hang).complete({ ...req, timeoutMs: 30 })).rejects.toMatchObject({ code: 'EM-4101' });
    const refusal = mk(() => json(200, { content: [], stop_reason: 'refusal' })).f;
    await expect(chatProviderFor('anthropic', 'k', 'c', refusal).complete(req)).rejects.toMatchObject({ code: 'EM-4104' });
    const offline = mk(() => { throw new TypeError('fetch failed'); }).f;
    await expect(validateKey('openrouter', 'k', offline)).rejects.toMatchObject({ code: 'EM-4003' });
  });
});
