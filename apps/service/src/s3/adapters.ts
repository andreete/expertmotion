// Provider adapters (R-094 validate, R-096 models, chat). OpenRouter chat uses the AI SDK provider from @expertmotion/agents;
// OpenAI, Anthropic and Gemini are plain fetch adapters following each provider's REST docs: JSON replies (ADR-023), SSE
// streaming (FR-210) and native tool calling for the read-only agent tools (AI_WORKFLOW §8.1, FR-211; JSON mode stays the fallback).
// Every request goes through the injected `fetch`, which is the egress module (Private Mode → EM-8202, allow-list → EM-8203).
import { EmError } from '@expertmotion/shared';
import { mapProviderError, mergeSources, openRouterProvider, STREAM_TOTAL_FACTOR, withRateLimitRetry, type ChatMessage, type ChatProvider, type ChatRequest, type ChatResult, type RateLimitRetry, type ToolCall, type WebSource } from '@expertmotion/agents';
import type { CapabilityRowT, ProviderKindT } from './dto.js';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const OPENAI = 'https://api.openai.com/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_BODY = 8 * 1024 * 1024;                     // SEC-084: the egress module aborts larger bodies while streaming (4 MB; lists 8 MB)
export const VALIDATE_TIMEOUT_MS = 15_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

const notYet = (p: string): never => { throw new EmError('EM-9004', `"${p} connections" is not available in this version of Expertmotion yet.`, { status: 422 }); };

function httpError(status: number, body: string, headers?: Headers): Error {
  const ra = headers?.get('retry-after');
  return Object.assign(new Error(`provider HTTP ${status}${body ? `: ${body.slice(0, 1000)}` : ''}`), { statusCode: status, ...(ra ? { responseHeaders: { 'retry-after': ra } } : {}) });
}

function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, t]) : t;
}

async function getJson(fetchFn: typeof fetch, url: string, headers: Record<string, string>, init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: init.method ?? 'GET', headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), signal: timeoutSignal(init.timeoutMs ?? VALIDATE_TIMEOUT_MS, init.signal) });
  } catch (e) { throw mapProviderError(e); }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw mapProviderError(httpError(res.status, text, res.headers));
  if (text.length > MAX_BODY) throw new EmError('EM-4103', 'The AI provider sent an answer that is too large.');
  try { return JSON.parse(text); } catch (e) { throw new EmError('EM-4103', 'The AI provider sent an answer Expertmotion could not read.', { cause: e }); }
}

const authHeaders = (p: ProviderKindT, key: string): Record<string, string> => {
  switch (p) {
    case 'anthropic': return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    case 'google': return { 'x-goog-api-key': key };
    default: return { Authorization: `Bearer ${key}` };
  }
};

/** Cheap call that proves the key works. Throws EM-4002 on 401/403, EM-4003/4101/4103 on transport problems. */
export async function validateKey(p: ProviderKindT, key: string, fetchFn: typeof fetch): Promise<void> {
  switch (p) {
    case 'openrouter': await getJson(fetchFn, `${OPENROUTER}/key`, authHeaders(p, key)); return;
    case 'openai': await getJson(fetchFn, `${OPENAI}/models`, authHeaders(p, key)); return;
    case 'anthropic': await getJson(fetchFn, `${ANTHROPIC}/models?limit=1`, authHeaders(p, key)); return;
    case 'google': await getJson(fetchFn, `${GEMINI}/models?pageSize=1`, authHeaders(p, key)); return;
    default: notYet(p);
  }
}

const num = (v: unknown): number | null => { const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN; return Number.isFinite(n) ? n : null; };
const perM = (v: unknown): number | null => { const n = num(v); return n === null || n < 0 ? null : Math.round(n * 1e6 * 1e6) / 1e6; };
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
/** OpenAI and Gemini model lists report no capability facts: unknown (null), never guessed (FR-114). These adapters stream (FR-210),
 *  so streaming is a known `true`. Anthropic reports its facts per model (`capabilities`, `max_input_tokens`). */
const UNREPORTED = { toolCalling: null, structuredOutput: null, streaming: true, imageInput: null, pricePerMInput: null, pricePerMOutput: null } as const;
/** `capabilities.<name>.supported` of an Anthropic Models API row (docs: every leaf has `supported: true/false`); null when absent. */
const anthropicCap = (caps: unknown, name: string): boolean | null => {
  const v = (caps as Record<string, { supported?: unknown } | undefined> | undefined)?.[name]?.supported;
  return typeof v === 'boolean' ? v : null;
};

/** Fetches the provider's model list and maps it to Capability Table rows (GLOSSARY). */
export async function listModels(p: ProviderKindT, key: string, fetchFn: typeof fetch): Promise<CapabilityRowT[]> {
  const wrap = async (fn: () => Promise<CapabilityRowT[]>) => {
    try { return await fn(); } catch (e) {
      const em = e instanceof EmError ? e : mapProviderError(e);
      if (['EM-8202', 'EM-8203', 'EM-4002', 'EM-4003', 'EM-4101'].includes(em.code)) throw em;
      throw new EmError('EM-4006', 'The model list could not be loaded.', { cause: e });
    }
  };
  switch (p) {
    case 'openrouter': return wrap(async () => {
      const j = await getJson(fetchFn, `${OPENROUTER}/models`, authHeaders(p, key), { timeoutMs: 30_000 }) as { data?: unknown[] };
      if (!Array.isArray(j?.data)) throw new Error('bad shape');
      return j.data.flatMap((m) => {
        const r = m as { id?: unknown; name?: unknown; created?: unknown; context_length?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; supported_parameters?: unknown; architecture?: { input_modalities?: unknown; output_modalities?: unknown } };
        if (typeof r.id !== 'string') return [];
        // The agents need text answers: image/audio-generating models are not usable as chat models, so they are not listed.
        const outMods = Array.isArray(r.architecture?.output_modalities) ? r.architecture!.output_modalities.map(String) : null;
        if (outMods && !(outMods.length === 1 && outMods[0] === 'text')) return [];
        // Unknown stays unknown (FR-114): no `supported_parameters` / `input_modalities` in the response → null, never a guess.
        const sp = Array.isArray(r.supported_parameters) ? r.supported_parameters.map(String) : null;
        const mods = Array.isArray(r.architecture?.input_modalities) ? r.architecture!.input_modalities.map(String) : null;
        const ctxLen = num(r.context_length);
        return [{ modelId: r.id, label: str(r.name, r.id), contextLength: ctxLen === null ? null : Math.trunc(ctxLen), toolCalling: sp ? sp.includes('tools') : null,
          structuredOutput: sp ? sp.includes('response_format') || sp.includes('structured_outputs') : null, streaming: true, imageInput: mods ? mods.includes('image') : null,
          pricePerMInput: perM(r.pricing?.prompt), pricePerMOutput: perM(r.pricing?.completion), created: num(r.created) === null ? null : Math.trunc(num(r.created)!) }];
      });
    });
    case 'openai': return wrap(async () => {
      const j = await getJson(fetchFn, `${OPENAI}/models`, authHeaders(p, key), { timeoutMs: 30_000 }) as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(j?.data)) throw new Error('bad shape');
      return j.data.flatMap((m) => {
        const id = str(m.id);
        if (!/^(gpt-|o[1-9]|chatgpt-)/.test(id) || /(embed|audio|realtime|tts|transcribe|image|search|moderation|instruct)/.test(id)) return [];
        return [{ modelId: id, label: id, ...UNREPORTED, contextLength: null }];
      });
    });
    case 'anthropic': return wrap(async () => {
      // Models API (platform.claude.com/docs/en/api/models/list, checked 2026-10-27): paginated (limit ≤ 1000, after_id / has_more);
      // each row has max_input_tokens (context window) and a capabilities tree (image_input, structured_outputs, …). Every Claude model
      // supports client tools and SSE streaming on the Messages API.
      const rows: CapabilityRowT[] = []; let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const j = await getJson(fetchFn, `${ANTHROPIC}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, authHeaders(p, key), { timeoutMs: 30_000 }) as
          { data?: Array<{ id?: unknown; display_name?: unknown; max_input_tokens?: unknown; capabilities?: unknown; created_at?: unknown }>; has_more?: unknown; last_id?: unknown };
        if (!Array.isArray(j?.data)) throw new Error('bad shape');
        for (const m of j.data) {
          if (typeof m.id !== 'string') continue;
          const ctxLen = num(m.max_input_tokens); const created = typeof m.created_at === 'string' ? Date.parse(m.created_at) : NaN;
          rows.push({ modelId: m.id, label: str(m.display_name, m.id), contextLength: ctxLen === null ? null : Math.trunc(ctxLen), toolCalling: true, structuredOutput: anthropicCap(m.capabilities, 'structured_outputs'),
            streaming: true, imageInput: anthropicCap(m.capabilities, 'image_input'), pricePerMInput: null, pricePerMOutput: null, ...(Number.isFinite(created) ? { created: Math.trunc(created / 1000) } : {}) });
        }
        if (j.has_more !== true || typeof j.last_id !== 'string') break;
        after = j.last_id;
      }
      return rows;
    });
    case 'google': return wrap(async () => {
      const j = await getJson(fetchFn, `${GEMINI}/models?pageSize=1000`, authHeaders(p, key), { timeoutMs: 30_000 }) as { models?: Array<{ name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; supportedGenerationMethods?: unknown }> };
      if (!Array.isArray(j?.models)) throw new Error('bad shape');
      return j.models.flatMap((m) => {
        const id = str(m.name).replace(/^models\//, '');
        const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods.map(String) : [];
        if (!id || !methods.includes('generateContent')) return [];
        const ctxLen = num(m.inputTokenLimit);
        return [{ modelId: id, label: str(m.displayName, id), ...UNREPORTED, contextLength: ctxLen === null ? null : Math.trunc(ctxLen) }];
      });
    });
    default: return notYet(p);
  }
}

const usageOf = (model: string, inputTokens: unknown, outputTokens: unknown) => ({ model, inputTokens: Math.max(0, Math.trunc(num(inputTokens) ?? 0)), outputTokens: Math.max(0, Math.trunc(num(outputTokens) ?? 0)), costUsd: null, approximate: true });

/** OpenAI reasoning models (o1/o3/o4…, GPT-5 family and later): no temperature, reasoning counts toward max_completion_tokens. */
export const OPENAI_REASONING = /^(o\d|gpt-(5|6|7|8|9)|gpt-oss)/i;
export const REASONING_MIN_MAX_TOKENS = 2048;
/** Floor for Gemini maxOutputTokens (thinking tokens count toward it). */
export const GEMINI_MIN_MAX_TOKENS = 2048;
/** Floor for Anthropic max_tokens (room for model-default thinking before the text answer). */
export const ANTHROPIC_MIN_MAX_TOKENS = 1024;
/**
 * FR-210: floor of the output budget for streamed agent calls. Thinking counts toward it (Claude adaptive thinking, Gemini thinking,
 * OpenAI reasoning models only) and a streamed call has no HTTP timeout problem, so a long thought never truncates the JSON answer.
 * A model whose output limit is lower refuses it once (HTTP 400) and gets the caller's budget from then on.
 */
export const STREAM_MIN_MAX_TOKENS = 16_000;
/** Models that refused sampling settings this session (`provider:model`); their requests omit temperature. */
const NO_SAMPLING = new Set<string>();
/** Models that refused the streamed output floor (their output limit is lower); their calls use the caller's budget. */
const NO_FLOOR = new Set<string>();
/** An EM-4105 refusal whose provider reason names the output budget (max_tokens / max_completion_tokens / maxOutputTokens). */
export function isMaxTokensRefusal(e: unknown): boolean {
  const x = e as { code?: unknown; details?: { reason?: unknown } };
  return x?.code === 'EM-4105' && /max_?(completion_)?tokens|maxOutputTokens|max output tokens|output token/i.test(String(x.details?.reason ?? ''));
}
/** Models that refused the tools parameter this session (`provider:model`); their calls fall back to the JSON-mode protocol. */
const NO_TOOLS = new Set<string>();
/** True when this model refused native tools earlier in this session (AI_WORKFLOW §8.1 fallback to JSON mode). */
export const toolsRefused = (p: ProviderKindT, model: string): boolean => NO_TOOLS.has(`${p}:${model}`);
/** An EM-4105 refusal whose provider reason names a sampling parameter (temperature / top_p / top_k). */
export function isSamplingRefusal(e: unknown): boolean {
  const x = e as { code?: unknown; details?: { reason?: unknown } };
  return x?.code === 'EM-4105' && /temperature|top[_ ]?p|top[_ ]?k|sampling/i.test(String(x.details?.reason ?? ''));
}
/** An EM-4105 refusal whose provider reason names tools / function calling. */
export function isToolsRefusal(e: unknown): boolean {
  const x = e as { code?: unknown; details?: { reason?: unknown } };
  return x?.code === 'EM-4105' && /\btools?\b|tool_choice|function[ _]?call|functionDeclarations/i.test(String(x.details?.reason ?? ''));
}

/**
 * Chat adapter with the AI_WORKFLOW §12 rate-limit retry: HTTP 429 (EM-4102, e.g. a free model "rate-limited upstream") is retried
 * up to 2 times within 20 s, honouring Retry-After. Used by agent runs and the provider test alike. `nativeTools` (OpenRouter only:
 * the Capability Table says the model supports tools) — Anthropic, OpenAI and Gemini always offer their tools API.
 */
export function chatProviderFor(p: ProviderKindT, key: string, model: string, fetchFn: typeof fetch, retry?: RateLimitRetry, opts: { nativeTools?: boolean } = {}): ChatProvider {
  return withRateLimitRetry(rawChatProviderFor(p, key, model, fetchFn, opts), retry);
}

// ── SSE (text/event-stream) reading, shared by the three fetch adapters ──
/** Server-sent events of a response body: one {event, data} per blank-line separated record (data lines joined with \n). */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader(); const dec = new TextDecoder();
  let buf = '';
  const parse = (rec: string) => {
    let event = 'message'; const data: string[] = [];
    for (const line of rec.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':'); const field = i < 0 ? line : line.slice(0, i); const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value; else if (field === 'data') data.push(value);
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { buf += dec.decode(); break; }
      buf += dec.decode(value, { stream: true });
      for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) {
        const rec = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
        const e = parse(rec); if (e) yield e;
      }
    }
    const e = parse(buf); if (e) yield e;
  } finally { reader.releaseLock(); }
}
const parseData = (d: string): Record<string, unknown> | null => { try { const v = JSON.parse(d) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; } };
/** Accumulated tool input JSON → object ({} when empty or unreadable; runTool validates it with Zod). */
const toolInput = (json: string): unknown => { if (!json.trim()) return {}; try { return JSON.parse(json) as unknown; } catch { return {}; } };

/** POSTs a streaming request through the egress module; the stream bounds (SEC-084: 6 min total, 90 s idle) apply there. */
async function postStream(fetchFn: typeof fetch, url: string, headers: Record<string, string>, body: unknown, req: ChatRequest): Promise<Response> {
  let res: Response;
  const total = (req.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) * STREAM_TOTAL_FACTOR;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: timeoutSignal(total, req.signal) });
  } catch (e) { throw mapProviderError(e); }
  if (!res.ok) { const text = await res.text().catch(() => ''); throw mapProviderError(httpError(res.status, text, res.headers)); }
  if (!res.body) throw new EmError('EM-4103', 'The AI provider sent an empty answer.');
  return res;
}
/** A JSON answer where a stream was asked for (a proxy that does not stream): read it with the non-streamed parser. */
const isJsonAnswer = (res: Response) => !(res.headers.get('content-type') ?? '').includes('event-stream') && (res.headers.get('content-type') ?? '').includes('json');
/** Runs the SSE loop; any transport error mid-stream maps to its EM code (timeouts → EM-4101). */
async function readStream(res: Response, onEvent: (ev: { event: string; data: string }) => void): Promise<void> {
  try { for await (const ev of sseEvents(res.body!)) onEvent(ev); } catch (e) { throw e instanceof EmError ? e : mapProviderError(e); }
}
const STREAM_ERROR_STATUS: Record<string, number> = { overloaded_error: 529, rate_limit_error: 429, api_error: 500, authentication_error: 401, permission_error: 403, not_found_error: 404, invalid_request_error: 400, request_too_large: 413 };

// ── Anthropic Messages API (platform.claude.com/docs: messages, streaming, tool use, vision; checked 2026-10-27) ──
type AnthropicBlock = { type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; input?: unknown; [k: string]: unknown };
/** Our messages as Messages API messages: images (base64) before the text, tool results first in a user turn, assistant turns that
 *  called tools replayed with their own content blocks (thinking blocks with signatures must come back unchanged). */
export function anthropicMessages(messages: readonly ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      if (Array.isArray(m.providerRaw) && m.providerRaw.length) return { role: 'assistant' as const, content: m.providerRaw };
      if (m.toolCalls?.length) return { role: 'assistant' as const, content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} }))] };
      return { role: 'assistant' as const, content: m.content || '…' };
    }
    const parts: unknown[] = [
      ...(m.toolResults ?? []).map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      ...(m.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
    ];
    if (!parts.length) return { role: 'user' as const, content: '…' };
    return { role: 'user' as const, content: parts.length === 1 && m.content && !m.images?.length && !m.toolResults?.length ? m.content : parts };
  });
}
type AnthropicUsage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown; server_tool_use?: { web_search_requests?: unknown; web_fetch_requests?: unknown } };
/**
 * FR-216: the web research of an answer (platform.claude.com/docs web search / web fetch tool, checked 2026-10-28): the queries
 * (`server_tool_use` web_search input), every result (`web_search_tool_result` content list; an error is one object with
 * `error_code`), the fetched pages (`web_fetch_tool_result`), and the citations on text blocks (`web_search_result_location`).
 */
export function anthropicWeb(blocks: readonly AnthropicBlock[]): { queries: string[]; fetches: string[]; sources: WebSource[]; errors: string[] } {
  const queries: string[] = []; const fetches: string[] = []; const results: WebSource[] = []; const cited: WebSource[] = []; const errors: string[] = [];
  for (const b of blocks) {
    if (b.type === 'server_tool_use') {
      const inp = (b.input ?? {}) as { query?: unknown; url?: unknown };
      if (b.name === 'web_search' && typeof inp.query === 'string') queries.push(inp.query);
      if (b.name === 'web_fetch' && typeof inp.url === 'string') fetches.push(inp.url);
    } else if (b.type === 'web_search_tool_result') {
      const c = b['content'];
      if (Array.isArray(c)) for (const r of c as Array<{ type?: unknown; url?: unknown; title?: unknown; page_age?: unknown }>) { if (r?.type === 'web_search_result' && typeof r.url === 'string') results.push({ url: r.url, ...(typeof r.title === 'string' ? { title: r.title } : {}), ...(typeof r.page_age === 'string' ? { pageAge: r.page_age } : {}) }); }
      else if (c && typeof c === 'object' && typeof (c as { error_code?: unknown }).error_code === 'string') errors.push((c as { error_code: string }).error_code);
    } else if (b.type === 'web_fetch_tool_result') {
      const c = b['content'] as { type?: unknown; url?: unknown; content?: { title?: unknown }; error_code?: unknown } | undefined;
      if (c?.type === 'web_fetch_result' && typeof c.url === 'string') cited.push({ url: c.url, ...(typeof c.content?.title === 'string' ? { title: c.content.title } : {}), cited: true });
      else if (typeof c?.error_code === 'string') errors.push(c.error_code);
    } else if (b.type === 'text' && Array.isArray(b['citations'])) {
      for (const x of b['citations'] as Array<{ type?: unknown; url?: unknown; title?: unknown; cited_text?: unknown }>) if (x?.type === 'web_search_result_location' && typeof x.url === 'string') cited.push({ url: x.url, ...(typeof x.title === 'string' ? { title: x.title } : {}), ...(typeof x.cited_text === 'string' ? { citedText: x.cited_text } : {}), cited: true });
    }
  }
  return { queries, fetches, sources: mergeSources([cited, results.slice(0, 8)]), errors };
}
function anthropicResult(model: string, blocks: AnthropicBlock[], stop: unknown, usage: AnthropicUsage | undefined, webNotice?: { code: string; reason: string }): ChatResult {
  if (stop === 'refusal') throw new EmError('EM-4104', 'The provider declined to answer this request.');
  const text = blocks.filter((b) => b.type === 'text').map((b) => str(b.text)).join('');
  const calls: ToolCall[] = blocks.filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string').map((b) => ({ id: b.id!, name: b.name!, input: b.input ?? {} }));
  const input = (num(usage?.input_tokens) ?? 0) + (num(usage?.cache_read_input_tokens) ?? 0) + (num(usage?.cache_creation_input_tokens) ?? 0);
  const web = blocks.some((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') ? anthropicWeb(blocks) : null;
  return { text, usage: usageOf(model, input, usage?.output_tokens), finishReason: stop === 'max_tokens' ? 'length' : stop === 'tool_use' ? 'tool-calls' : String(stop ?? 'stop'),
    ...(calls.length ? { toolCalls: calls, providerRaw: blocks } : {}),
    ...(web?.sources.length ? { citations: web.sources } : {}), ...(web?.queries.length ? { webQueries: web.queries } : {}), ...(web?.fetches.length ? { webFetches: web.fetches.length } : {}), ...(webNotice ? { webNotice } : {}) };
}

/** FR-216: server tool versions per model. `v2` = web_search_20260209 / web_fetch_20260209 (Claude 4.6 and later), `v1` = the basic
 *  web_search_20250305 / web_fetch_20250910, `off` = refused (the account disabled web search, or the model has none). */
export type WebLevel = 'v2' | 'v1' | 'off';
const WEB_LEVEL = new Map<string, WebLevel>();
const WEB_OFF_NOTICE = new Map<string, { code: string; reason: string }>();
/** FR-216: why native web research is off for this connection's model this session (null = it works or was not tried). */
export const webOffNotice = (p: ProviderKindT, model: string): { code: string; reason: string } | null => WEB_OFF_NOTICE.get(`${p}:${model}`) ?? null;
/** The level a model starts at: the dynamic-filtering versions exist for Claude 4.6 and later (Opus / Sonnet / Fable 5.x included). */
export function initialWebLevel(model: string): WebLevel {
  const m = /claude-(?:[a-z]+-)?(\d+)(?:[-.](\d{1,2}))?(?![\d])/.exec(model);
  if (!m) return 'v1';
  const major = Number(m[1]); const minor = m[2] ? Number(m[2]) : 0;
  if (/haiku/.test(model)) return 'v1';
  return major > 4 || (major === 4 && minor >= 6) ? 'v2' : 'v1';
}
/** The server tool definitions for a level (allowed_callers direct: plain search results, no code-execution blocks to replay). */
export function anthropicWebTools(level: WebLevel, w: NonNullable<ChatRequest['webResearch']>): unknown[] {
  if (level === 'off') return [];
  const out: unknown[] = [];
  if (w.search) out.push(level === 'v2' ? { type: 'web_search_20260209', name: 'web_search', max_uses: w.maxSearches ?? 5, allowed_callers: ['direct'] } : { type: 'web_search_20250305', name: 'web_search', max_uses: w.maxSearches ?? 5 });
  if (w.fetch) out.push(level === 'v2' ? { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: w.maxFetches ?? 3, allowed_callers: ['direct'], citations: { enabled: true }, max_content_tokens: 20_000 }
    : { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: w.maxFetches ?? 3, citations: { enabled: true }, max_content_tokens: 20_000 });
  return out;
}
/** A refusal naming the web tools (HTTP 400 invalid_request_error, or a 403 permission refusal, whose message mentions web search / fetch). */
export function isWebToolRefusal(e: unknown): boolean {
  const x = e as { code?: unknown; details?: { reason?: unknown } };
  return x?.code === 'EM-4105' && /web[ _-]?(search|fetch)|allowed_callers|server[ _]tool|dynamic filtering/i.test(String(x.details?.reason ?? ''));
}
/** The account turned the tool off (Console > Settings > Capabilities): no lower version will help. */
export const isWebDisabled = (e: unknown): boolean => isWebToolRefusal(e) && /not enabled|disabled|turned off|not allowed|organi[sz]ation/i.test(String((e as { details?: { reason?: unknown } }).details?.reason ?? ''));

/** Reads one streamed Anthropic answer (content_block_* events; server tool blocks and citation deltas included, FR-216). */
async function readAnthropicStream(res: Response, req: ChatRequest, onDelta: (d: string) => void): Promise<{ blocks: AnthropicBlock[]; stop: unknown; usage: AnthropicUsage }> {
  const blocks: AnthropicBlock[] = []; const json: string[] = []; let stop: unknown; const usage: Record<string, unknown> = {};
  await readStream(res, (ev) => {
    const d = parseData(ev.data); if (!d) return;
    switch (d['type']) {
      case 'message_start': Object.assign(usage, ((d['message'] as { usage?: object } | undefined)?.usage) ?? {}); break;
      case 'content_block_start': {
        const i = Number(d['index']); const b = { ...(d['content_block'] as AnthropicBlock) };
        blocks[i] = b; json[i] = '';
        if (b.type === 'thinking' || b.type === 'redacted_thinking') req.onActivity?.({ type: 'thinking' });
        else if (b.type === 'tool_use') req.onActivity?.({ type: 'tool', name: str(b.name) });
        else if (b.type === 'server_tool_use') req.onActivity?.({ type: 'web', kind: b.name === 'web_fetch' ? 'fetch' : 'search' });
        else if (b.type === 'text') { req.onActivity?.({ type: 'text' }); if (b.text) onDelta(b.text); }
        break;
      }
      case 'content_block_delta': {
        const i = Number(d['index']); const b = blocks[i]; const x = d['delta'] as { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; citation?: unknown } | undefined;
        if (!b || !x) break;
        if (x.type === 'text_delta' && x.text) { b.text = (b.text ?? '') + x.text; onDelta(x.text); }
        else if (x.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + (x.thinking ?? '');
        else if (x.type === 'signature_delta') b.signature = (b.signature ?? '') + (x.signature ?? '');
        else if (x.type === 'input_json_delta') json[i] = (json[i] ?? '') + (x.partial_json ?? '');
        else if (x.type === 'citations_delta' && x.citation) b['citations'] = [...(Array.isArray(b['citations']) ? b['citations'] as unknown[] : []), x.citation];
        break;
      }
      case 'content_block_stop': {
        const i = Number(d['index']); const b = blocks[i];
        if (b?.type === 'tool_use' || b?.type === 'server_tool_use') b.input = json[i] ? toolInput(json[i]!) : (b.input ?? {});
        if (b?.type === 'server_tool_use') { const inp = (b.input ?? {}) as { query?: unknown; url?: unknown }; req.onActivity?.({ type: 'web', kind: b.name === 'web_fetch' ? 'fetch' : 'search', ...(typeof inp.query === 'string' ? { query: inp.query } : {}), ...(typeof inp.url === 'string' ? { url: inp.url } : {}) }); }
        break;
      }
      case 'message_delta': stop = (d['delta'] as { stop_reason?: unknown } | undefined)?.stop_reason ?? stop; Object.assign(usage, (d['usage'] as object | undefined) ?? {}); break;
      case 'error': {
        const er = (d['error'] ?? {}) as { type?: string };
        throw mapProviderError(httpError(STREAM_ERROR_STATUS[str(er.type)] ?? 500, JSON.stringify(d)));
      }
      default: break;                                                                  // ping, message_stop
    }
  });
  return { blocks: blocks.filter(Boolean), stop, usage: usage as AnthropicUsage };
}
/** Sums the usage of the calls of one paused / continued turn. */
function addUsage(acc: AnthropicUsage, u: AnthropicUsage | undefined) {
  if (!u) return;
  const a = acc as Record<string, unknown>;
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) a[k] = (num(a[k]) ?? 0) + (num(u[k]) ?? 0);
  const s0 = acc.server_tool_use ?? {}; const s1 = u.server_tool_use ?? {};
  acc.server_tool_use = { web_search_requests: (num(s0.web_search_requests) ?? 0) + (num(s1.web_search_requests) ?? 0), web_fetch_requests: (num(s0.web_fetch_requests) ?? 0) + (num(s1.web_fetch_requests) ?? 0) };
}

// ── OpenAI Chat Completions (platform.openai.com/docs/api-reference/chat; streaming, function calling, vision) ──
export function openAiMessages(system: string, messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push(m.toolCalls?.length ? { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
        : { role: 'assistant', content: m.content });
      continue;
    }
    for (const r of m.toolResults ?? []) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    if (m.images?.length) out.push({ role: 'user', content: [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))] });
    else if (m.content || !m.toolResults?.length) out.push({ role: 'user', content: m.content });
  }
  return out;
}

// ── Gemini generateContent / streamGenerateContent (ai.google.dev/api: SSE with alt=sse, function calling, inline images) ──
type GeminiPart = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: unknown; id?: string }; [k: string]: unknown };
export function geminiContents(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      if (Array.isArray(m.providerRaw) && m.providerRaw.length) return { role: 'model', parts: m.providerRaw };
      const parts = [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.input ?? {} } }))];
      return { role: 'model', parts: parts.length ? parts : [{ text: '…' }] };
    }
    const parts: unknown[] = [
      ...(m.toolResults ?? []).map((r) => { let result: unknown = r.content; try { result = JSON.parse(r.content); } catch { /* text */ } return { functionResponse: { name: r.name, ...(r.id && !r.id.startsWith('call_') ? { id: r.id } : {}), response: r.isError ? { error: result } : { result } } }; }),
      ...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.data } })),
      ...(m.content ? [{ text: m.content }] : []),
    ];
    return { role: 'user', parts: parts.length ? parts : [{ text: '…' }] };
  });
}
/** Appends a streamed Gemini part to the turn's parts: text fragments of the same kind are merged; signatures are kept. */
function pushGeminiPart(parts: GeminiPart[], p: GeminiPart) {
  const last = parts[parts.length - 1];
  if (typeof p.text === 'string' && !p.functionCall && last && typeof last.text === 'string' && !last.functionCall && Boolean(last.thought) === Boolean(p.thought) && !last.thoughtSignature) {
    last.text += p.text; if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature; return;
  }
  parts.push({ ...p });
}
function geminiResult(model: string, parts: GeminiPart[], finish: unknown, blocked: boolean, usage: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown } | undefined): ChatResult {
  if (blocked || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') throw new EmError('EM-4104', 'The provider declined to answer this request.');
  const text = parts.filter((x) => x.thought !== true && typeof x.text === 'string').map((x) => x.text).join('');
  const calls: ToolCall[] = parts.flatMap((x, i) => (x.functionCall?.name ? [{ id: x.functionCall.id ?? `call_${i}`, name: x.functionCall.name, input: x.functionCall.args ?? {} }] : []));
  const rt = num(usage?.thoughtsTokenCount);
  return { text, usage: usageOf(model, usage?.promptTokenCount, (num(usage?.candidatesTokenCount) ?? 0) + (rt ?? 0)), finishReason: finish === 'MAX_TOKENS' ? 'length' : calls.length ? 'tool-calls' : String(finish ?? 'STOP').toLowerCase(),
    ...(rt !== null ? { reasoningTokens: rt } : {}), ...(calls.length ? { toolCalls: calls, providerRaw: parts } : {}) };
}

function rawChatProviderFor(p: ProviderKindT, key: string, model: string, fetchFn: typeof fetch, opts: { nativeTools?: boolean } = {}): ChatProvider {
  if (p === 'openrouter') return openRouterProvider({ apiKey: key, model, fetch: fetchFn, ...(opts.nativeTools && !toolsRefused(p, model) ? { nativeTools: true } : {}) });
  const call = async (req: ChatRequest, url: string, body: unknown): Promise<unknown> =>
    getJson(fetchFn, url, authHeaders(p, key), { method: 'POST', body, timeoutMs: req.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, ...(req.signal ? { signal: req.signal } : {}) });
  // Sampling temperature only when the caller set a real number: `Math.min(1, undefined)` is NaN and was sent as
  // "temperature": null, which Anthropic rejects with HTTP 400 (shown as EM-4003 before). Omitted = provider default.
  const temp = (t: number | undefined, max: number): { temperature?: number } => (typeof t === 'number' && Number.isFinite(t) ? { temperature: Math.min(max, Math.max(0, t)) } : {});
  // Some models refuse sampling settings (newest Claude models, OpenAI reasoning models): HTTP 400 naming the parameter.
  // Retry that request once without temperature and remember the model, so later calls omit it from the start. A model that
  // refuses the tools parameter is retried once without tools (JSON-mode prompt rules still apply) and remembered too.
  const key2 = `${p}:${model}`;
  const wantTools = (req: ChatRequest) => !!req.tools?.length && !NO_TOOLS.has(key2);
  // An older model whose output limit is below the streamed floor refuses the budget (HTTP 400 naming max tokens): the request is
  // sent again with the caller's own budget, and the model is remembered.
  const send = async <T>(req: ChatRequest, post: (body: unknown) => Promise<T>, build: (withTemp: boolean, withTools: boolean, withFloor: boolean) => unknown): Promise<T> => {
    let withTemp = !NO_SAMPLING.has(key2); let withTools = wantTools(req); let withFloor = !NO_FLOOR.has(key2);
    for (let i = 0; ; i++) {
      try { return await post(build(withTemp, withTools, withFloor)); } catch (e) {
        if (i < 3 && withTemp && isSamplingRefusal(e)) { NO_SAMPLING.add(key2); withTemp = false; continue; }
        if (i < 3 && withTools && isToolsRefusal(e) && !req.messages.some((m) => m.toolCalls?.length || m.toolResults?.length)) { NO_TOOLS.add(key2); withTools = false; continue; }
        if (i < 3 && withFloor && isMaxTokensRefusal(e)) { NO_FLOOR.add(key2); withFloor = false; continue; }
        throw e;
      }
    }
  };
  switch (p) {
    case 'openai': {
      // Chat Completions: reasoning models (o-series, GPT-5 family) take max_completion_tokens, which also counts reasoning tokens,
      // and reject temperature/top_p; other models keep the caller's temperature (retry-without on refusal).
      const reasoning = OPENAI_REASONING.test(model);
      const body = (req: ChatRequest, streamed: boolean) => (w: boolean, tools: boolean, floor: boolean) => ({ model, messages: openAiMessages(req.system, req.messages),
        max_completion_tokens: Math.max(req.maxTokens, reasoning ? REASONING_MIN_MAX_TOKENS : 0, streamed && floor && reasoning ? STREAM_MIN_MAX_TOKENS : 0), ...(w && !reasoning ? temp(req.temperature, 2) : {}),
        ...(tools ? { tools: req.tools!.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: req.toolChoice ?? 'auto' } : {}),
        ...(streamed ? { stream: true, stream_options: { include_usage: true } } : {}) });
      type Choice = { message?: { content?: unknown; tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }> }; finish_reason?: unknown };
      const result = (c: Choice | undefined, u: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } } | undefined): ChatResult => {
        if (c?.finish_reason === 'content_filter') throw new EmError('EM-4104', 'The provider declined to answer this request.');
        const calls: ToolCall[] = (c?.message?.tool_calls ?? []).flatMap((t, i) => (typeof t.function?.name === 'string' ? [{ id: str(t.id, `call_${i}`), name: t.function.name, input: toolInput(str(t.function.arguments)) }] : []));
        const rt = num(u?.completion_tokens_details?.reasoning_tokens);
        return { text: str(c?.message?.content), usage: usageOf(model, u?.prompt_tokens, u?.completion_tokens), finishReason: c?.finish_reason === 'length' ? 'length' : calls.length ? 'tool-calls' : String(c?.finish_reason ?? 'stop'),
          ...(rt !== null ? { reasoningTokens: rt } : {}), ...(calls.length ? { toolCalls: calls } : {}) };
      };
      return { id: 'openai', model, nativeTools: !NO_TOOLS.has(key2), async complete(req) {
        const j = await send(req, (b) => call(req, `${OPENAI}/chat/completions`, b), body(req, false)) as { choices?: Choice[]; usage?: Parameters<typeof result>[1] };
        return result(j.choices?.[0], j.usage);
      }, async stream(req, onDelta) {
        const res = await send(req, (b) => postStream(fetchFn, `${OPENAI}/chat/completions`, authHeaders(p, key), b, req), body(req, true));
        if (isJsonAnswer(res)) { const j = JSON.parse(await res.text()) as { choices?: Choice[]; usage?: Parameters<typeof result>[1] }; const r = result(j.choices?.[0], j.usage); if (r.text) onDelta(r.text); return r; }
        let text = ''; let finish: unknown; let usage: Parameters<typeof result>[1]; const tc: Array<{ id: string; name: string; args: string }> = [];
        await readStream(res, (ev) => {
          if (ev.data === '[DONE]') return;
          const d = parseData(ev.data); if (!d) return;
          if (d['error']) throw mapProviderError(httpError(500, JSON.stringify(d)));
          if (d['usage']) usage = d['usage'] as typeof usage;
          const ch = (d['choices'] as Array<{ delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: unknown }> | undefined)?.[0];
          if (!ch) return;
          if (typeof ch.delta?.content === 'string' && ch.delta.content) { if (!text) req.onActivity?.({ type: 'text' }); text += ch.delta.content; onDelta(ch.delta.content); }
          if (typeof ch.delta?.reasoning_content === 'string' && ch.delta.reasoning_content) req.onActivity?.({ type: 'thinking' });
          for (const t of ch.delta?.tool_calls ?? []) {
            const i = typeof t.index === 'number' ? t.index : tc.length;
            const cur = tc[i] ?? (tc[i] = { id: '', name: '', args: '' });
            if (t.id) cur.id = t.id;
            if (t.function?.name) { cur.name += t.function.name; req.onActivity?.({ type: 'tool', name: cur.name }); }
            if (t.function?.arguments) cur.args += t.function.arguments;
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        });
        return result({ message: { content: text, tool_calls: tc.filter(Boolean).map((t, i) => ({ id: t.id || `call_${i}`, function: { name: t.name, arguments: t.args } })) }, finish_reason: finish }, usage);
      } };
    }
    case 'anthropic': {
      // Messages API (platform.claude.com/docs/en/api/messages, checked 2026-10-27): `temperature` is not sent (current models reject
      // non-default sampling); thinking tokens count toward max_tokens and thinking behaviour when `thinking` is omitted depends on
      // the model, so max_tokens has a floor (higher for streamed agent calls). Native tools: `tools` + tool_choice auto / none;
      // tool_use blocks come back with the turn's thinking blocks, which are replayed unchanged with the tool_result blocks.
      // FR-216: `req.webResearch` adds the web_search / web_fetch server tools (the API runs them; results and citations come back
      // in the same answer). A long server-side loop ends with stop_reason pause_turn: the paused content is sent back unchanged
      // (at most PAUSE_LIMIT times). A refusal naming the web tools steps down to the basic versions, then answers without them
      // (EM-4403 account disabled / EM-4404 model) and the model is told so in the system prompt.
      const PAUSE_LIMIT = 4;
      const webLevel = (): WebLevel => WEB_LEVEL.get(key2) ?? initialWebLevel(model);
      const body = (req: ChatRequest, streamed: boolean, cont: unknown[], level: WebLevel, note: string) => (_w: boolean, tools: boolean, floor: boolean) => {
        const server = req.webResearch ? anthropicWebTools(level, req.webResearch) : [];
        const client = tools ? req.tools!.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) : [];
        const all = [...client, ...server];
        return { model, system: note ? `${req.system}\n\n${note}` : req.system, messages: [...anthropicMessages(req.messages), ...cont],
          max_tokens: Math.max(req.maxTokens, ANTHROPIC_MIN_MAX_TOKENS, streamed && floor ? STREAM_MIN_MAX_TOKENS : 0),
          ...(all.length ? { tools: all, tool_choice: { type: req.toolChoice === 'none' ? 'none' : 'auto' } } : {}),
          ...(streamed ? { stream: true } : {}) };
      };
      type Msg = { content?: AnthropicBlock[]; stop_reason?: unknown; usage?: AnthropicUsage };
      type Notice = { code: string; reason: string };
      /** One Messages call with the web-tool fallback ladder; `notice` says why the answer has no web research. */
      const withWeb = async <T>(req: ChatRequest, cont: unknown[], post: (build: ReturnType<typeof body>) => Promise<T>, streamed: boolean): Promise<{ v: T; notice?: Notice }> => {
        let level: WebLevel = req.webResearch ? webLevel() : 'off';
        let notice: Notice | undefined = req.webResearch && level === 'off' ? WEB_OFF_NOTICE.get(key2) : undefined;
        for (let i = 0; ; i++) {
          const note = notice ? `Internet research failed for this answer: ${notice.reason} Tell the Creator this in their language, and that this answer was not checked online.` : '';
          try { const v = await post(body(req, streamed, cont, level, note)); return notice ? { v, notice } : { v }; } catch (e) {
            if (i < 3 && level !== 'off' && isWebToolRefusal(e) && !cont.length) {
              const disabled = isWebDisabled(e);
              const reason = String((e as { details?: { reason?: unknown } }).details?.reason ?? '').slice(0, 300);
              level = disabled || level === 'v1' ? 'off' : 'v1';
              WEB_LEVEL.set(key2, level);
              if (level === 'off') {
                notice = disabled ? { code: 'EM-4403', reason: `Web search is turned off for this Anthropic account (${reason}). An admin can turn it on at console.anthropic.com > Settings > Capabilities.` }
                  : { code: 'EM-4404', reason: `This model refused the web search tool (${reason}).` };
                WEB_OFF_NOTICE.set(key2, notice);
              }
              continue;
            }
            throw e;
          }
        }
      };
      return { id: 'anthropic', model, nativeTools: !NO_TOOLS.has(key2), nativeWebResearch: true, async complete(req) {
        const all: AnthropicBlock[] = []; const cont: unknown[] = []; const usage: AnthropicUsage = {}; let notice: Notice | undefined;
        for (let n = 0; ; n++) {
          const { v: j, notice: nt } = await withWeb(req, cont, (b) => send(req, (x) => call(req, `${ANTHROPIC}/messages`, x), b) as Promise<Msg>, false);
          notice ??= nt; addUsage(usage, j.usage);
          all.push(...(j.content ?? []));
          if (j.stop_reason !== 'pause_turn' || n >= PAUSE_LIMIT) return anthropicResult(model, all, j.stop_reason === 'pause_turn' ? 'end_turn' : j.stop_reason, usage, notice);
          cont.push({ role: 'assistant', content: j.content ?? [] });
        }
      }, async stream(req, onDelta) {
        const all: AnthropicBlock[] = []; const cont: unknown[] = []; const usageAll: AnthropicUsage = {}; let notice: Notice | undefined;
        for (let n = 0; ; n++) {
          const { v: res, notice: nt } = await withWeb(req, cont, (b) => send(req, (x) => postStream(fetchFn, `${ANTHROPIC}/messages`, authHeaders(p, key), x, req), b), true);
          notice ??= nt;
          let blocks: AnthropicBlock[]; let stop: unknown; let usage: AnthropicUsage;
          if (isJsonAnswer(res)) { const j = JSON.parse(await res.text()) as Msg; blocks = j.content ?? []; stop = j.stop_reason; usage = j.usage ?? {}; const tx = blocks.filter((b) => b.type === 'text').map((b) => str(b.text)).join(''); if (tx) onDelta(tx); }
          else ({ blocks, stop, usage } = await readAnthropicStream(res, req, onDelta));
          addUsage(usageAll, usage);
          all.push(...blocks);
          if (stop !== 'pause_turn' || n >= PAUSE_LIMIT) return anthropicResult(model, all, stop === 'pause_turn' ? 'end_turn' : stop, usageAll, notice);
          cont.push({ role: 'assistant', content: blocks });
        }
      } };
    }
    case 'google': {
      const id = model.replace(/^models\//, '');
      const okId = /^[A-Za-z0-9._-]+$/.test(id);
      // Gemini: maxOutputTokens includes thinking tokens and many models think by default (some cannot turn it off), so the budget has
      // a floor; temperature is left at the model default (newer models are tuned for it); thought parts are never shown. Function
      // calls come back with thought signatures on their parts, so the model's parts are replayed unchanged.
      const body = (req: ChatRequest, streamed: boolean) => (_w: boolean, tools: boolean, floor: boolean) => ({ systemInstruction: { parts: [{ text: req.system }] }, contents: geminiContents(req.messages),
        generationConfig: { maxOutputTokens: Math.max(req.maxTokens, GEMINI_MIN_MAX_TOKENS, streamed && floor ? STREAM_MIN_MAX_TOKENS : 0) },
        ...(tools ? { tools: [{ functionDeclarations: req.tools!.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }], toolConfig: { functionCallingConfig: { mode: req.toolChoice === 'none' ? 'NONE' : 'AUTO' } } } : {}) });
      type Resp = { candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: unknown }>; promptFeedback?: { blockReason?: unknown }; usageMetadata?: Parameters<typeof geminiResult>[4] };
      return { id: 'google', model, nativeTools: !NO_TOOLS.has(key2), async complete(req) {
        if (!okId) throw new EmError('EM-4004', 'This model is not available from the provider.');
        const j = await send(req, (b) => call(req, `${GEMINI}/models/${id}:generateContent`, b), body(req, false)) as Resp;
        return geminiResult(model, j.candidates?.[0]?.content?.parts ?? [], j.candidates?.[0]?.finishReason, !!j.promptFeedback?.blockReason, j.usageMetadata);
      }, async stream(req, onDelta) {
        if (!okId) throw new EmError('EM-4004', 'This model is not available from the provider.');
        const res = await send(req, (b) => postStream(fetchFn, `${GEMINI}/models/${id}:streamGenerateContent?alt=sse`, authHeaders(p, key), b, req), body(req, true));
        if (isJsonAnswer(res)) { const j = JSON.parse(await res.text()) as Resp | Resp[]; const one = Array.isArray(j) ? j : [j]; const parts: GeminiPart[] = []; for (const x of one) for (const q of x.candidates?.[0]?.content?.parts ?? []) pushGeminiPart(parts, q); const last = one[one.length - 1]; const r = geminiResult(model, parts, last?.candidates?.[0]?.finishReason, one.some((x) => !!x.promptFeedback?.blockReason), last?.usageMetadata); if (r.text) onDelta(r.text); return r; }
        const parts: GeminiPart[] = []; let finish: unknown; let blocked = false; let usage: Parameters<typeof geminiResult>[4]; let wrote = false;
        await readStream(res, (ev) => {
          const d = parseData(ev.data) as Resp & { error?: { code?: number } } | null; if (!d) return;
          if (d.error) throw mapProviderError(httpError(typeof d.error.code === 'number' ? d.error.code : 500, JSON.stringify(d)));
          if (d.promptFeedback?.blockReason) blocked = true;
          if (d.usageMetadata) usage = d.usageMetadata;
          const c = d.candidates?.[0]; if (!c) return;
          if (c.finishReason) finish = c.finishReason;
          for (const part of c.content?.parts ?? []) {
            pushGeminiPart(parts, part);
            if (part.thought === true) req.onActivity?.({ type: 'thinking' });
            else if (part.functionCall?.name) req.onActivity?.({ type: 'tool', name: part.functionCall.name });
            else if (typeof part.text === 'string' && part.text) { if (!wrote) { wrote = true; req.onActivity?.({ type: 'text' }); } onDelta(part.text); }
          }
        });
        return geminiResult(model, parts, finish, blocked, usage);
      } };
    }
    default: return notYet(p);
  }
}
