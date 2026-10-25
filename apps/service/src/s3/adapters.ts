// Provider adapters (R-094 validate, R-096 models, chat). OpenRouter chat uses the AI SDK provider from @expertmotion/agents;
// OpenAI, Anthropic and Gemini are plain JSON fetch adapters (ADR-023: JSON-mode prompting, no tool calling, no streaming).
// Every request goes through the injected `fetch`, which is the egress module (Private Mode → EM-8202, allow-list → EM-8203).
import { EmError } from '@expertmotion/shared';
import { mapProviderError, openRouterProvider, type ChatMessage, type ChatProvider, type ChatRequest } from '@expertmotion/agents';
import type { CapabilityRowT, ProviderKindT } from './dto.js';

const OPENROUTER = 'https://openrouter.ai/api/v1';
const OPENAI = 'https://api.openai.com/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_BODY = 8 * 1024 * 1024;                     // SEC-084: the egress module aborts larger bodies while streaming (4 MB; lists 8 MB)
export const VALIDATE_TIMEOUT_MS = 15_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

const notYet = (p: string): never => { throw new EmError('EM-9004', `"${p} connections" is not available in this version of Expertmotion yet.`, { status: 422 }); };

function httpError(status: number, body: string): Error {
  return Object.assign(new Error(`provider HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`), { statusCode: status });
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
  if (!res.ok) throw mapProviderError(httpError(res.status, text));
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
/** OpenAI, Anthropic and Gemini model lists report no capability facts: unknown (null), never guessed (FR-114). These adapters
 *  do not stream (ADR-023), so streaming is a known `false`. */
const UNREPORTED = { toolCalling: null, structuredOutput: null, streaming: false, imageInput: null, pricePerMInput: null, pricePerMOutput: null } as const;

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
      const j = await getJson(fetchFn, `${ANTHROPIC}/models?limit=1000`, authHeaders(p, key), { timeoutMs: 30_000 }) as { data?: Array<{ id?: unknown; display_name?: unknown }> };
      if (!Array.isArray(j?.data)) throw new Error('bad shape');
      return j.data.flatMap((m) => (typeof m.id === 'string' ? [{ modelId: m.id, label: str(m.display_name, m.id), ...UNREPORTED, contextLength: null }] : []));
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

/** Chat adapter for a Model Assignment. The key is passed per provider instance and never logged. */
/** Floor for Anthropic max_tokens (room for model-default thinking before the text answer). */
export const ANTHROPIC_MIN_MAX_TOKENS = 1024;
/** Models that refused sampling settings this session (`provider:model`); their requests omit temperature. */
const NO_SAMPLING = new Set<string>();
/** An EM-4105 refusal whose provider reason names a sampling parameter (temperature / top_p / top_k). */
export function isSamplingRefusal(e: unknown): boolean {
  const x = e as { code?: unknown; details?: { reason?: unknown } };
  return x?.code === 'EM-4105' && /temperature|top[_ ]?p|top[_ ]?k|sampling/i.test(String(x.details?.reason ?? ''));
}

export function chatProviderFor(p: ProviderKindT, key: string, model: string, fetchFn: typeof fetch): ChatProvider {
  if (p === 'openrouter') return openRouterProvider({ apiKey: key, model, fetch: fetchFn });
  const call = async (req: ChatRequest, url: string, body: unknown): Promise<unknown> =>
    getJson(fetchFn, url, authHeaders(p, key), { method: 'POST', body, timeoutMs: req.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, ...(req.signal ? { signal: req.signal } : {}) });
  const msgs = (m: ChatMessage[]) => m.map((x) => ({ role: x.role, content: x.content }));
  // Sampling temperature only when the caller set a real number: `Math.min(1, undefined)` is NaN and was sent as
  // "temperature": null, which Anthropic rejects with HTTP 400 (shown as EM-4003 before). Omitted = provider default.
  const temp = (t: number | undefined, max: number): { temperature?: number } => (typeof t === 'number' && Number.isFinite(t) ? { temperature: Math.min(max, Math.max(0, t)) } : {});
  // Some models refuse sampling settings (newest Claude models, OpenAI reasoning models): HTTP 400 naming the parameter.
  // Retry that request once without temperature and remember the model, so later calls omit it from the start.
  const key2 = `${p}:${model}`;
  const send = async (req: ChatRequest, url: string, build: (withTemp: boolean) => unknown): Promise<unknown> => {
    const withTemp = !NO_SAMPLING.has(key2);
    try { return await call(req, url, build(withTemp)); } catch (e) {
      if (withTemp && isSamplingRefusal(e)) { NO_SAMPLING.add(key2); return call(req, url, build(false)); }
      throw e;
    }
  };
  switch (p) {
    case 'openai': return { id: 'openai', model, async complete(req) {
      const j = await send(req, `${OPENAI}/chat/completions`, (w) => ({ model, messages: [{ role: 'system', content: req.system }, ...msgs(req.messages)], max_completion_tokens: req.maxTokens, ...(w ? temp(req.temperature, 2) : {}) })) as
        { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      const c = j.choices?.[0];
      if (c?.finish_reason === 'content_filter') throw new EmError('EM-4104', 'The provider declined to answer this request.');
      return { text: str(c?.message?.content), usage: usageOf(model, j.usage?.prompt_tokens, j.usage?.completion_tokens) };
    } };
    case 'anthropic': return { id: 'anthropic', model, async complete(req) {
      // Messages API (platform.claude.com/docs/en/api/.../messages/create, checked 2026-10-26): `temperature` is not a documented
      // parameter for current models, so it is never sent; thinking tokens count toward max_tokens and thinking behaviour when
      // `thinking` is omitted depends on the model, so max_tokens has a floor that leaves room for it (only text blocks are read).
      const j = await call(req, `${ANTHROPIC}/messages`, { model, system: req.system, messages: msgs(req.messages), max_tokens: Math.max(req.maxTokens, ANTHROPIC_MIN_MAX_TOKENS) }) as
        { content?: Array<{ type?: unknown; text?: unknown }>; stop_reason?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
      if (j.stop_reason === 'refusal') throw new EmError('EM-4104', 'The provider declined to answer this request.');
      const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => str(b.text)).join('');
      return { text, usage: usageOf(model, j.usage?.input_tokens, j.usage?.output_tokens) };
    } };
    case 'google': return { id: 'google', model, async complete(req) {
      const id = model.replace(/^models\//, '');
      if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new EmError('EM-4004', 'This model is not available from the provider.');
      const j = await send(req, `${GEMINI}/models/${id}:generateContent`, (w) => ({ systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: req.maxTokens, ...(w ? temp(req.temperature, 2) : {}) } })) as
        { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: unknown }>; promptFeedback?: { blockReason?: unknown }; usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown } };
      if (j.promptFeedback?.blockReason || j.candidates?.[0]?.finishReason === 'SAFETY') throw new EmError('EM-4104', 'The provider declined to answer this request.');
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((x) => str(x.text)).join('');
      return { text, usage: usageOf(model, j.usageMetadata?.promptTokenCount, j.usageMetadata?.candidatesTokenCount) };
    } };
    default: return notYet(p);
  }
}
