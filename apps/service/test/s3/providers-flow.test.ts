// FR-111…FR-119 Providers screen flow on the service side: R-101 dry-run validate (nothing stored), R-102 Test probe,
// R-103 provider kinds (P0 gating, EM-9004), tri-state Capability Table, Remove reassigns agents (FR-119). No real network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { createProvidersModule, TEST_PROBE } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { body, fakeEgress, json, waitFor, type FakeCall } from './s3-helpers.js';

const KEY_A = `sk-or-v1-${'a1b2c3d4'.repeat(5)}AAAA`;
const KEY_B = `sk-or-v1-${'e5f6a7b8'.repeat(5)}BBBB`;
const MODELS = { data: [
  { id: 'good/model', name: 'Good', context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools', 'response_format'], architecture: { input_modalities: ['text', 'image'] } },
  { id: 'mystery/model', name: 'Mystery', context_length: 64000, pricing: { prompt: '0', completion: '0' } },     // no supported_parameters / modalities
] };
let offline = false;
let reply = '{"reply":"OK"}';
const openrouter = (c: FakeCall) => {
  if (!c.url.startsWith('https://openrouter.ai/')) return undefined;
  if (offline) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), { code: 'ENOTFOUND' }) });
  if (c.headers['authorization'] !== `Bearer ${KEY_A}` && c.headers['authorization'] !== `Bearer ${KEY_B}`) return json(401, { error: { message: 'No auth credentials found', code: 401 } });
  if (c.url.endsWith('/api/v1/key')) return json(200, { data: { label: 'x' } });
  if (c.url.endsWith('/api/v1/models')) return json(200, MODELS);
  if (c.url.endsWith('/chat/completions')) return json(200, { id: 'gen-1', object: 'chat.completion', created: 1, model: 'good/model',
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } });
  return undefined;
};

describe('Providers screen flow (R-101…R-103, FR-111…FR-119)', () => {
  let s: TestService; let calls: FakeCall[];
  const count = () => (s.ctx.db.prepare('SELECT count(*) n FROM provider_connections').get() as { n: number }).n;
  beforeAll(async () => { s = await startService({ modules: [health, settingsModule, createProvidersModule({ enabledProviders: ['openrouter'] }), usageModule] }); calls = fakeEgress(s, [openrouter]); });
  afterAll(async () => { await s.close(); });

  it('R-103 lists providers with terms, key shape and P0 gating; disabled ones answer EM-9004 (FR-111)', async () => {
    const k = await body<{ items: Array<{ provider: string; enabled: boolean; priority: string; termsUrl: string | null; keyPattern: string | null }> }>(await s.api('/providers/kinds'));
    expect(k.items.map((i) => [i.provider, i.enabled, i.priority])).toEqual([['openrouter', true, 'P0'], ['openai', false, 'P1'], ['anthropic', false, 'P1'], ['google', false, 'P1'], ['custom', false, 'P2']]);
    expect(new RegExp(k.items[0]!.keyPattern!).test(KEY_A)).toBe(true);
    expect(k.items[0]!.termsUrl).toMatch(/^https:\/\//);
    const add = await s.api('/providers/connections', { method: 'POST', json: { provider: 'openai', label: 'x', secret: 'sk-test-openai-key-123456789' } });
    expect([add.status, (await body<{ error: { code: string; details: { plannedPriority: string } } }>(add)).error]).toMatchObject([422, { code: 'EM-9004', details: { plannedPriority: 'P1' } }]);
    const dry = await s.api('/providers/validate', { method: 'POST', json: { provider: 'anthropic', secret: 'sk-ant-test-key-1234567890' } });
    expect((await body<{ error: { code: string } }>(dry)).error.code).toBe('EM-9004');
  });

  it('R-101 validates a key and returns its tri-state Capability Table without storing anything (FR-113, FR-114, FR-118)', async () => {
    const r = await s.api('/providers/validate', { method: 'POST', json: { provider: 'openrouter', secret: `  ${KEY_A}  ` } });
    const txt = await r.text();
    expect(r.status).toBe(200);
    expect(txt).not.toContain(KEY_A);
    const v = JSON.parse(txt) as { status: string; models: Array<{ modelId: string; toolCalling: boolean | null; structuredOutput: boolean | null; imageInput: boolean | null }> };
    expect(v.status).toBe('valid');
    expect(v.models.find((m) => m.modelId === 'mystery/model')).toMatchObject({ toolCalling: null, structuredOutput: null, imageInput: null });
    expect(v.models.find((m) => m.modelId === 'good/model')).toMatchObject({ toolCalling: true, structuredOutput: true, imageInput: true });
    expect(count()).toBe(0);
    const bad = await s.api('/providers/validate', { method: 'POST', json: { provider: 'openrouter', secret: `sk-or-v1-${'0'.repeat(40)}` } });
    expect([bad.status, (await body<{ error: { code: string } }>(bad)).error.code]).toEqual([422, 'EM-4002']);
    expect(count()).toBe(0);
  });

  it('R-102 Test with a draft runs the fixed probe per agent and reports latency, tokens, cost; nothing stored (FR-116)', async () => {
    const before = calls.length;
    const r = await body<{ items: Array<{ agent: string; ok: boolean; latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number | null }> }>(
      await s.api('/providers/test', { method: 'POST', json: { draft: { provider: 'openrouter', secret: KEY_A }, brainstorm: 'good/model', editor: 'mystery/model' } }));
    expect(r.items.map((i) => [i.agent, i.ok, i.inputTokens + i.outputTokens])).toEqual([['brainstorm', true, 38], ['editor', true, 38]]);
    expect(r.items.every((i) => i.latencyMs >= 0)).toBe(true);
    const chats = calls.slice(before).filter((c) => c.url.endsWith('/chat/completions'));
    expect(chats).toHaveLength(2);
    expect(JSON.stringify(chats[0]!.body)).toContain(TEST_PROBE.user.slice(0, 20));
    expect(count()).toBe(0);
  });

  it('a probe that does not answer OK reports EM-4301; offline reports EM-8201; Private Mode refuses with 423 (FR-116)', async () => {
    reply = 'Sure! Here you go.';
    const bad = await body<{ items: Array<{ ok: boolean; code?: string }> }>(await s.api('/providers/test', { method: 'POST', json: { draft: { provider: 'openrouter', secret: KEY_A }, editor: 'good/model', brainstorm: null } }));
    expect(bad.items).toEqual([expect.objectContaining({ ok: false, code: 'EM-4301' })]);
    reply = '{"reply":"OK"}';
    offline = true;
    const off = await body<{ items: Array<{ ok: boolean; code?: string }> }>(await s.api('/providers/test', { method: 'POST', json: { draft: { provider: 'openrouter', secret: KEY_A }, editor: 'good/model' } }));
    expect(off.items[0]).toMatchObject({ ok: false, code: 'EM-8201' });
    const dry = await s.api('/providers/validate', { method: 'POST', json: { provider: 'openrouter', secret: KEY_A } });
    expect((await body<{ error: { code: string } }>(dry)).error.code).toBe('EM-8201');
    offline = false;
    await s.api('/settings', { method: 'PUT', json: { privateMode: true } });
    const n = calls.length;
    const p = await s.api('/providers/test', { method: 'POST', json: { draft: { provider: 'openrouter', secret: KEY_A }, editor: 'good/model' } });
    expect([p.status, (await body<{ error: { code: string } }>(p)).error.code]).toEqual([423, 'EM-8202']);
    expect(calls.length).toBe(n);
    await s.api('/settings', { method: 'PUT', json: { privateMode: false } });
  });

  it('unknown capabilities: Editor assignment allowed with EM-4005; Test on a saved connection prices from the Capability Table (FR-115, FR-117)', async () => {
    const a = await body<{ id: string; modelCount: number | null }>(await s.api('/providers/connections', { method: 'POST', json: { provider: 'openrouter', label: 'A', secret: KEY_A } }));
    await waitFor(() => !!(s.ctx.db.prepare('SELECT models_fetched_at f FROM provider_connections WHERE id = ?').get(a.id) as { f: string | null }).f);
    const list = await body<{ items: Array<{ id: string; modelCount: number | null }> }>(await s.api('/providers/connections'));
    expect(list.items.find((c) => c.id === a.id)!.modelCount).toBe(2);
    const put = await body<{ warnings: Array<{ code: string }> }>(await s.api('/providers/assignments', { method: 'PUT', json: {
      editor: { agent: 'editor', connectionId: a.id, modelId: 'mystery/model' }, brainstorm: { agent: 'brainstorm', connectionId: a.id, modelId: 'good/model' } } }));
    expect(put.warnings.map((w) => w.code)).toEqual(['EM-4005']);
    const t = await body<{ items: Array<{ agent: string; modelId: string; costUsd: number | null; approximate: boolean }> }>(await s.api('/providers/test', { method: 'POST', json: {} }));
    const b = t.items.find((i) => i.agent === 'brainstorm')!;
    expect(b.modelId).toBe('good/model');
    expect(b.costUsd).toBeCloseTo((30 * 1 + 8 * 2) / 1_000_000, 10);
    expect(b.approximate).toBe(true);
  });

  it('Remove reassigns agents to another validated connection offering the model, else clears them; default moves (FR-119)', async () => {
    const conns = await body<{ items: Array<{ id: string }> }>(await s.api('/providers/connections'));
    const a = conns.items[0]!.id;
    const b = await body<{ id: string }>(await s.api('/providers/connections', { method: 'POST', json: { provider: 'openrouter', label: 'B', secret: KEY_B } }));
    await waitFor(() => !!(s.ctx.db.prepare('SELECT models_fetched_at f FROM provider_connections WHERE id = ?').get(b.id) as { f: string | null }).f);
    s.ctx.db.prepare('UPDATE provider_connections SET models_json = ? WHERE id = ?').run(JSON.stringify([{ modelId: 'good/model', label: 'Good', contextLength: 128000, toolCalling: true, structuredOutput: true, streaming: true, imageInput: true, pricePerMInput: 1, pricePerMOutput: 2 }]), b.id);
    expect((await s.api(`/providers/connections/${a}`, { method: 'DELETE' })).status).toBe(409);
    expect((await s.api(`/providers/connections/${a}?force=true`, { method: 'DELETE' })).status).toBe(204);
    const asg = await body<{ brainstorm: { connectionId: string } | null; editor: unknown; defaultConnectionId: string | null }>(await s.api('/providers/assignments'));
    expect(asg.brainstorm?.connectionId).toBe(b.id);       // same model offered by B
    expect(asg.editor).toBeNull();                         // mystery/model is not → none (EM-4007)
    expect(asg.defaultConnectionId).toBe(b.id);
  });
});
