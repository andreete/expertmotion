// Local provider stub for end-to-end runs (dev only; process.md Entry 28). The Service, started with EM_DEV=1 and
// EM_DEV_PROVIDER_STUB=http://127.0.0.1:<port>, sends every provider call here (apps/service/src/s3/dev-provider-stub.ts):
//   /anthropic/v1/models (paginated: limit, after_id, before_id; has_more / first_id / last_id), /anthropic/v1/messages
//   (thinking + text blocks), /openai/v1/models + /chat/completions, /gemini/v1beta/models + :generateContent,
//   /openrouter/api/v1/key + /models (450 rows, or E2E_OR_MODELS=<real list JSON>) + /chat/completions (JSON or SSE stream).
// Shapes mirror the real APIs as read by apps/service/src/s3/adapters.ts. Keys containing "bad" get 401. Faults are set per
// provider with POST /__stub/config {provider, fault: null|'401'|'429'|'529'|'500', delayMs, times}; GET /__stub/log lists calls.
// Usage: import { startProviderStub } from './provider-stub.mjs'; const stub = await startProviderStub(4140);
//        or standalone: node poc/e2e/provider-stub.mjs 4140
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = new URL('../../', import.meta.url).pathname;

/** Current Anthropic models (Models API shape: type, id, display_name, created_at, max_input_tokens, max_tokens, capabilities). */
export const ANTHROPIC_MODELS = [
  ['claude-fable-5-1', 'Claude Fable 5.1', '2026-09-10T00:00:00Z', 1_000_000, 128_000],
  ['claude-opus-5-5', 'Claude Opus 5.5', '2026-09-01T00:00:00Z', 1_000_000, 128_000],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', '2026-08-20T00:00:00Z', 1_000_000, 128_000],
  ['claude-fable-5', 'Claude Fable 5', '2026-06-15T00:00:00Z', 1_000_000, 128_000],
  ['claude-opus-5', 'Claude Opus 5', '2026-05-20T00:00:00Z', 1_000_000, 128_000],
  ['claude-sonnet-5', 'Claude Sonnet 5', '2026-04-15T00:00:00Z', 1_000_000, 128_000],
  ['claude-opus-4-8', 'Claude Opus 4.8', '2026-03-10T00:00:00Z', 1_000_000, 128_000],
  ['claude-opus-4-7', 'Claude Opus 4.7', '2026-01-20T00:00:00Z', 1_000_000, 128_000],
  ['claude-opus-4-6', 'Claude Opus 4.6', '2025-11-24T00:00:00Z', 1_000_000, 128_000],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6', '2025-11-24T00:00:00Z', 1_000_000, 64_000],
  ['claude-haiku-4-5', 'Claude Haiku 4.5', '2025-10-15T00:00:00Z', 200_000, 64_000],
  ['claude-opus-4-5-20251101', 'Claude Opus 4.5', '2025-11-01T00:00:00Z', 200_000, 64_000],
].map(([id, display_name, created_at, max_input_tokens, max_tokens]) => ({
  type: 'model', id, display_name, created_at, max_input_tokens, max_tokens,
  capabilities: { thinking: { supported: true }, image_input: { supported: true }, pdf_input: { supported: true }, structured_outputs: { supported: !String(id).includes('haiku') } },
}));

/** 450 OpenRouter-shaped rows (or the real list from E2E_OR_MODELS). */
export function openRouterModels(file = process.env.E2E_OR_MODELS) {
  if (file && fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : j.data; }
  const vendors = ['anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'qwen', 'deepseek', 'nvidia', 'x-ai', 'cohere', 'microsoft', 'moonshotai', 'z-ai', 'amazon', 'perplexity'];
  const out = [];
  for (let i = 0; out.length < 450; i++) {
    const v = vendors[i % vendors.length]; const n = Math.floor(i / vendors.length);
    const free = i % 7 === 0; const img = i % 3 === 0;
    const id = `${v}/model-${n}${['', '-mini', '-pro', '-flash', '-large'][n % 5]}${free ? ':free' : ''}`;
    out.push({ id, canonical_slug: id, name: `${v[0].toUpperCase()}${v.slice(1)}: Model ${n}${n % 2 ? ' Instruct' : ''} ${'X'.repeat(n % 4)}`.trim(), created: 1_790_000_000 - i * 86_400,
      description: 'Stub model for end-to-end tests.', context_length: [32_768, 131_072, 200_000, 1_048_576][i % 4],
      architecture: { modality: img ? 'text+image->text' : 'text->text', input_modalities: img ? ['text', 'image'] : ['text'], output_modalities: i % 41 === 0 ? ['image'] : ['text'], tokenizer: 'Other', instruct_type: null },
      pricing: free ? { prompt: '0', completion: '0' } : { prompt: String((1 + (i % 9)) / 1e6), completion: String((4 + (i % 13)) / 1e6) },
      top_provider: { context_length: 131_072, max_completion_tokens: 16_384, is_moderated: false }, per_request_limits: null,
      supported_parameters: i % 5 === 0 ? ['max_tokens', 'temperature'] : ['max_tokens', 'temperature', 'tools', 'tool_choice', 'response_format', 'structured_outputs'] });
  }
  return out;
}

/** Canned agent answers chosen from the system prompt: the provider Test probe, the Editor Agent (a valid plan), else Brainstorm. */
const EDITOR_PLAN = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'packages/agents/test/golden/fixtures/live-nemotron-ultra-faceless.json'), 'utf8')).content; } catch { return null; }
})() ?? JSON.stringify({ goal: 'Tambah judul', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, background: 'preset:background.gradient', title: 'Halo', titleVariant: 'preset:text.title' } }] }], risks: [] });
export function answerFor(system = '') {
  if (/connection test/i.test(system)) return '{"reply":"OK"}';
  if (/^You are the Editor Agent/.test(system)) return EDITOR_PLAN;
  return JSON.stringify({ reply: 'Ide video: 3 tips hemat listrik — matikan lampu, cabut charger, pakai AC 25 °C. Mau saya buatkan di video?', suggestedNextStep: 'send-to-editor' });
}

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'request-id': `req_stub_${Date.now()}`, ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Provider-specific error bodies. */
function errorBody(provider, status) {
  const msg = status === 401 ? 'invalid x-api-key' : status === 429 ? 'Rate limit exceeded' : status === 529 ? 'Overloaded' : 'Internal server error';
  if (provider === 'anthropic') return { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 529 ? 'overloaded_error' : 'api_error', message: msg }, request_id: `req_stub_${status}` };
  if (provider === 'gemini') return { error: { code: status, message: msg, status: status === 401 ? 'UNAUTHENTICATED' : status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE' } };
  return { error: { message: msg, code: status, type: status === 401 ? 'invalid_api_key' : 'rate_limit_exceeded' } };
}

export async function startProviderStub(port = 4140, { host = '127.0.0.1' } = {}) {
  const config = {};                        // provider → { fault, delayMs, times }
  const calls = [];
  const orModels = openRouterModels();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', `http://${host}`);
    const [, provider, ...rest] = u.pathname.split('/');
    const p = `/${rest.join('/')}`;
    if (provider === '__stub') {
      if (p === '/config' && req.method === 'POST') { const b = await readBody(req); config[b.provider] = { fault: b.fault ?? null, delayMs: b.delayMs ?? 0, times: b.times ?? Infinity }; return send(res, 200, { ok: true, config }); }
      if (p === '/log') return send(res, 200, { calls });
      return send(res, 404, {});
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const key = String(req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    calls.push({ at: Date.now(), provider, method: req.method, path: p, query: u.search, model: body.model ?? null, stream: body.stream === true });
    const c = config[provider];
    if (c?.delayMs) await sleep(c.delayMs);
    if (/bad/i.test(key)) return send(res, 401, errorBody(provider, 401));
    if (c?.fault && c.times > 0) { c.times -= 1; const st = Number(c.fault); return send(res, st, errorBody(provider, st), st === 429 ? { 'retry-after': '1' } : {}); }
    const text = answerFor(typeof body.system === 'string' ? body.system : body.messages?.find?.((m) => m.role === 'system')?.content ?? body.systemInstruction?.parts?.[0]?.text ?? '');
    const usage = { in: 1200, out: Math.ceil(text.length / 4) };

    if (provider === 'anthropic') {
      if (p === '/v1/models') {
        const limit = Math.min(1000, Math.max(1, Number(u.searchParams.get('limit') ?? 20)));
        let list = ANTHROPIC_MODELS;
        const after = u.searchParams.get('after_id'); const before = u.searchParams.get('before_id');
        if (after) list = list.slice(list.findIndex((m) => m.id === after) + 1);
        if (before) list = list.slice(0, Math.max(0, list.findIndex((m) => m.id === before)));
        const page = list.slice(0, limit);
        return send(res, 200, { data: page, has_more: list.length > page.length, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null });
      }
      if (p === '/v1/messages') {
        if (!ANTHROPIC_MODELS.some((m) => m.id === body.model)) return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: `model: ${body.model}` }, request_id: 'req_stub_404' });
        if ('temperature' in body && /opus-5|sonnet-5|fable/.test(body.model)) return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature is not supported for this model' }, request_id: 'req_stub_400' });
        return send(res, 200, { id: `msg_stub_${Date.now()}`, type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'thinking', thinking: '', signature: 'EqQBCgIYAhIM' + 'x'.repeat(64) }, { type: 'text', text }],
          stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
          usage: { input_tokens: usage.in, output_tokens: usage.out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' } });
      }
    }
    if (provider === 'openai') {
      if (p === '/v1/models') return send(res, 200, { object: 'list', data: ['gpt-6', 'gpt-6-mini', 'gpt-5.5', 'o5-mini', 'text-embedding-3-large', 'gpt-image-2', 'whisper-1'].map((id) => ({ id, object: 'model', created: 1_780_000_000, owned_by: 'openai' })) });
      if (p === '/v1/chat/completions') return send(res, 200, { id: 'chatcmpl-stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out } });
    }
    if (provider === 'gemini') {
      if (p === '/v1beta/models') return send(res, 200, { models: ['gemini-3.5-pro', 'gemini-3.5-flash', 'gemini-3-flash-lite', 'text-embedding-005'].map((id) => ({ name: `models/${id}`, displayName: id.replace(/-/g, ' '), inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: id.includes('embedding') ? ['embedContent'] : ['generateContent', 'countTokens'] })) });
      if (/^\/v1beta\/models\/[^/]+:generateContent$/.test(p)) return send(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: usage.in, candidatesTokenCount: usage.out } });
    }
    if (provider === 'openrouter') {
      if (p === '/api/v1/key') return send(res, 200, { data: { label: 'sk-or-v1-stu...', usage: 0.12, limit: null, is_free_tier: false, rate_limit: { requests: 20, interval: '10s' } } });
      if (p === '/api/v1/models') return send(res, 200, { data: orModels });
      if (p === '/api/v1/chat/completions') {
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const id = 'gen-stub'; const chunks = text.match(/[\s\S]{1,200}/g) ?? [''];
          for (const ch of chunks) { res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: ch }, finish_reason: null }] })}\n\n`); await sleep(5); }
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out, cost: 0.0004 } })}\n\n`);
          res.write('data: [DONE]\n\n'); return res.end();
        }
        return send(res, 200, { id: 'gen-stub', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out, cost: 0.0004 } });
      }
    }
    return send(res, 404, errorBody(provider, 404));
  });
  await new Promise((r) => server.listen(port, host, r));
  return { origin: `http://${host}:${port}`, calls, close: () => new Promise((r) => server.close(() => r())),
    configure: (provider, c) => { config[provider] = { fault: c.fault ?? null, delayMs: c.delayMs ?? 0, times: c.times ?? Infinity }; } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 4140);
  if (port === 3000 || port === 4000) throw new Error('ports 3000/4000 belong to another tenant');
  const s = await startProviderStub(port);
  console.log(`provider stub on ${s.origin}`);
}
