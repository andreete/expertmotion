// Local provider stub for end-to-end runs (dev only; process.md Entry 28). The Service, started with EM_DEV=1 and
// EM_DEV_PROVIDER_STUB=http://127.0.0.1:<port>, sends every provider call here (apps/service/src/s3/dev-provider-stub.ts):
//   /anthropic/v1/models (paginated: limit, after_id, before_id; has_more / first_id / last_id), /anthropic/v1/messages
//   (Entry 30: Claude's behaviour of QA 2026-10-27 — validated like the Messages API (tool_use ↔ tool_result pairing, thinking
//   block before tool_use, tool names, image blocks, no temperature, no prefill), native tool_use, SSE streaming per the
//   streaming docs (message_start, content_block_* with thinking / signature / text / input_json deltas, ping, message_delta,
//   message_stop, error events), Brainstorm proposals WITHOUT params, image input (a text-only model refuses images), and
//   `mode: 'xml'` = tool calls written as <invoke> markup in plain text), /openai/v1/models + /chat/completions, /gemini/v1beta/models + :generateContent,
//   /openrouter/api/v1/key + /models (450 rows, or E2E_OR_MODELS=<real list JSON>) + /chat/completions (JSON or SSE stream).
// Shapes mirror the real APIs as read by apps/service/src/s3/adapters.ts. Keys containing "bad" get 401. Faults are set per
// provider with POST /__stub/config {provider, fault: null|'401'|'429'|'529'|'500', delayMs, times, mode: 'native'|'xml', thinkMs};
// GET /__stub/log lists calls (Anthropic calls also record tools / images / tool results / stream / validation errors).
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
  ['claude-text-stub', 'Claude Text Stub (no images)', '2025-01-01T00:00:00Z', 200_000, 64_000],
].map(([id, display_name, created_at, max_input_tokens, max_tokens]) => ({
  type: 'model', id, display_name, created_at, max_input_tokens, max_tokens,
  capabilities: { thinking: { supported: true }, image_input: { supported: id !== 'claude-text-stub' }, pdf_input: { supported: true }, structured_outputs: { supported: !String(id).includes('haiku') } },
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

// ── Anthropic Messages API behaviour (validation + answers), mirrored from platform.claude.com/docs (messages, tool use, vision,
//    streaming). The QA of 2026-10-27 used Claude Sonnet 5.5 with a direct key. ──
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const blocksOf = (m) => (Array.isArray(m?.content) ? m.content : typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : []);
const anthropicImages = (body) => (body.messages ?? []).flatMap((m) => blocksOf(m).filter((b) => b.type === 'image').map((b) => ({ mediaType: b.source?.media_type, bytes: Math.floor(String(b.source?.data ?? '').length * 0.75) })));
const anthropicToolResults = (body) => (body.messages ?? []).flatMap((m) => blocksOf(m).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id));
/** The 400 reason the real API gives for a malformed request, or null. */
export function anthropicProblem(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : null;
  if (!msgs?.length) return 'messages: at least one message is required';
  if (!Number.isInteger(body.max_tokens)) return 'max_tokens: Field required';
  if (msgs[0].role !== 'user') return 'messages: first message must use the "user" role';
  if (msgs.at(-1).role !== 'user') return 'This model does not support assistant message prefill. The conversation must end with a user message.';
  const hasToolBlocks = msgs.some((m) => blocksOf(m).some((b) => b.type === 'tool_use' || b.type === 'tool_result'));
  if (hasToolBlocks && !(body.tools ?? []).length) return 'Requests which include `tool_use` or `tool_result` blocks must define tools.';
  for (const t of body.tools ?? []) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(t.name))) return `tools.${t.name}.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'`;
    if (t.input_schema?.type !== 'object') return `tools.${t.name}.input_schema.type: Input should be 'object'`;
  }
  for (let i = 0; i < msgs.length; i++) {
    const b = blocksOf(msgs[i]);
    if (msgs[i].role === 'assistant') {
      const uses = b.filter((x) => x.type === 'tool_use');
      if (uses.length && b[0]?.type !== 'thinking' && b[0]?.type !== 'redacted_thinking') return `messages.${i}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`${b[0]?.type}\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block.`;
      if (uses.some((u) => b.some((x) => x.type === 'thinking' && !x.signature))) return `messages.${i}.content: thinking block without signature`;
      if (uses.length) {
        const next = blocksOf(msgs[i + 1]); const ids = next.filter((x) => x.type === 'tool_result').map((x) => x.tool_use_id);
        if (msgs[i + 1]?.role !== 'user' || uses.some((u) => !ids.includes(u.id))) return `messages.${i + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${uses.map((u) => u.id).join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
        const firstNonResult = next.findIndex((x) => x.type !== 'tool_result');
        if (firstNonResult >= 0 && next.slice(firstNonResult).some((x) => x.type === 'tool_result')) return `messages.${i + 1}: tool_result blocks must come first`;
      }
    }
    for (const x of b) if (x.type === 'image') {
      if (x.source?.type !== 'base64' || !IMAGE_TYPES.includes(x.source?.media_type) || !/^[A-Za-z0-9+/]+=*$/.test(String(x.source?.data ?? ''))) return `messages.${i}.content: invalid image source`;
      if (body.model === 'claude-text-stub') return `messages.${i}.content: image input is not supported for this model`;
    }
  }
  return null;
}
const QA_INVOKE = '<invoke>\n<parameter name="input">{"query": "gradient", "category": "backgrounds"}</parameter>\n<parameter name="tool">catalogue.search</parameter>\n</invoke>';
/** Claude-like answers: Brainstorm calls catalogue_search first (native tool_use, or <invoke> markup in `xml` mode), then answers
 *  with a BrainstormTurn whose proposals have NO params (the shape that crashed the chat); the Editor reads the project first. */
export function anthropicAnswer(body, c = {}) {
  const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((x) => x.text ?? '').join('\n');
  const thinking = { type: 'thinking', thinking: '', signature: 'EqQBCgIYAhIMstub' + 'x'.repeat(48) };
  const msgs = body.messages ?? [];
  const results = msgs.some((m) => blocksOf(m).some((b) => b.type === 'tool_result' || (b.type === 'text' && String(b.text).includes('"toolResult"'))));
  const tools = (body.tools ?? []).map((t) => t.name);
  const lastImages = blocksOf(msgs.at(-1)).filter((b) => b.type === 'image');
  if (/connection test/i.test(system)) return [thinking, { type: 'text', text: '{"reply":"OK"}' }];
  if (/^You are the Editor Agent/.test(system)) {
    if (tools.includes('composition_get') && !results && body.tool_choice?.type !== 'none') return [thinking, { type: 'text', text: 'Saya baca proyeknya dulu.' }, { type: 'tool_use', id: `toolu_stub_${Date.now()}`, name: 'composition_get', input: {} }];
    return [thinking, { type: 'text', text: EDITOR_PLAN }];
  }
  if (!results && (c.mode === 'xml' || (!tools.length && /Read-only tools/.test(system)))) return [thinking, { type: 'text', text: `${QA_INVOKE}\n<invoke>\n<parameter name="name">catalogue.search</parameter>\n</invoke>` }];
  if (!results && tools.includes('catalogue_search') && body.tool_choice?.type !== 'none') return [thinking, { type: 'text', text: 'Saya cek katalog dulu.' }, { type: 'tool_use', id: `toolu_stub_${Date.now()}`, name: 'catalogue_search', input: { query: 'gradient', category: 'background' } }];
  const seen = msgs.flatMap((m) => blocksOf(m).filter((b) => b.type === 'image'));
  const img = lastImages[0] ?? seen.at(-1);
  const asked = [...msgs].reverse().flatMap((m) => (m.role === 'user' ? blocksOf(m).filter((b) => b.type === 'text' && !String(b.text).includes('"toolResult"')).map((b) => String(b.text)) : []))[0] ?? '';
  const topic = asked.replace(/\s+/g, ' ').trim().slice(0, 60);
  const reply = `Ide konten untuk "${topic}": hook "Data center Indonesia tumbuh pesat", 6 adegan dengan latar gradasi, CTA di akhir.${img ? ` Gambar diterima (${img.source.media_type}).` : ''}`;
  return [thinking, { type: 'text', text: JSON.stringify({ reply, suggestedNextStep: 'send-to-editor', proposedIntents: [
    { category: 'asset', needsInterpretation: true, instruction: 'Pakai gambar yang dilampirkan sebagai CTA di adegan terakhir', source: 'brainstorm' },
    { category: 'text', needsInterpretation: true, instruction: 'Teks CTA "Bangun Bersama Kami"', source: 'brainstorm' },
  ] }) }];
}
/** SSE per the Messages streaming docs; `thinkMs` keeps the thinking block open (with pings) like a long adaptive think. */
async function streamAnthropic(res, model, content, stop, outTokens, c) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'request-id': `req_stub_${Date.now()}` });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: `msg_stub_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } });
  for (const [i, b] of content.entries()) {
    if (b.type === 'thinking') {
      ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
      for (let t = 0; t < (c.thinkMs ?? 0); t += 500) { await sleep(Math.min(500, (c.thinkMs ?? 0) - t)); ev('ping', {}); }
      ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: '' } });
      ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'text') {
      ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      for (const ch of b.text.match(/[\s\S]{1,24}/g) ?? []) { ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: ch } }); await sleep(12); }
    } else if (b.type === 'tool_use') {
      ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: '' } });
      for (const ch of JSON.stringify(b.input).match(/[\s\S]{1,10}/g) ?? []) { ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: ch } }); await sleep(5); }
    }
    ev('content_block_stop', { index: i });
  }
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTokens } });
  ev('message_stop', {});
  res.end();
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
      if (p === '/config' && req.method === 'POST') { const b = await readBody(req); config[b.provider] = { fault: b.fault ?? null, delayMs: b.delayMs ?? 0, times: b.times ?? Infinity, mode: b.mode ?? 'native', thinkMs: b.thinkMs ?? 0 }; return send(res, 200, { ok: true, config }); }
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
        const problem = anthropicProblem(body);
        const rec = calls[calls.length - 1];
        Object.assign(rec, { tools: (body.tools ?? []).map((t) => t.name), toolChoice: body.tool_choice?.type ?? null, images: anthropicImages(body), toolResults: anthropicToolResults(body), maxTokens: body.max_tokens, problem });
        if (problem) return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: problem }, request_id: 'req_stub_400' });
        const content = anthropicAnswer(body, c ?? {});
        const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
        const outTokens = Math.ceil(JSON.stringify(content).length / 4);
        if (body.stream) return streamAnthropic(res, body.model, content, stop, outTokens, c ?? {});
        return send(res, 200, { id: `msg_stub_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, stop_details: null,
          usage: { input_tokens: usage.in, output_tokens: outTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' } });
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
    configure: (provider, c) => { config[provider] = { fault: c.fault ?? null, delayMs: c.delayMs ?? 0, times: c.times ?? Infinity, mode: c.mode ?? 'native', thinkMs: c.thinkMs ?? 0 }; } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 4140);
  if (port === 3000 || port === 4000) throw new Error('ports 3000/4000 belong to another tenant');
  const s = await startProviderStub(port);
  console.log(`provider stub on ${s.origin}`);
}
