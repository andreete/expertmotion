// Provider layer (MCP_AND_TOOLING §5): one interface; OpenRouter first (PRD-010) through Vercel AI SDK v6.
// All network access goes through an injected `fetch` — the Local Service's single egress module with the Private Mode gate.
import { generateText, jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { EmError } from '@expertmotion/shared';

/** FR-072: an image attached by the Creator, sent as an image part only to models with image input (Capability Table). */
export interface ChatImage { mediaType: string; /** base64, no data: prefix */ data: string; name?: string }
/**
 * AI_WORKFLOW §8.1 native tool calling: a read-only tool offered through the provider's own tools API. `name` is the wire name
 * (letters, digits, `_`, `-`: providers refuse dots), `inputSchema` a JSON Schema object (validation stays with Zod in runTool).
 */
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
/** A tool call the model made through the native tools API (`id` echoes back in the result). */
export interface ToolCall { id: string; name: string; input: unknown }
export interface ToolResultPart { id: string; name: string; /** JSON text of the result (≤ 16 KB) */ content: string; isError?: boolean }
export interface ChatMessage {
  role: 'user' | 'assistant'; content: string; images?: ChatImage[];
  /** assistant: the native tool calls of this turn. */
  toolCalls?: ToolCall[];
  /** user: the results of the previous turn's tool calls (one message carries all of them). */
  toolResults?: ToolResultPart[];
  /** assistant: the provider's own content of this turn (thinking blocks with signatures, tool_use …), replayed unchanged. */
  providerRaw?: unknown;
}
/** Progress the adapter sees on the wire (thinking started, a tool call being written); hints only. */
export type ChatActivity = { type: 'thinking' } | { type: 'tool'; name: string } | { type: 'text' };
export interface ChatRequest { system: string; messages: ChatMessage[]; maxTokens: number; temperature: number; signal?: AbortSignal; timeoutMs?: number;
  /** Called before a rate-limit retry waits (withRateLimitRetry): retry n of `of`, waiting `waitMs` (progress text only). */
  onRetry?: (r: { n: number; of: number; waitMs: number; code: string }) => void;
  /** Native tools (only for providers with `nativeTools`); `toolChoice: 'none'` = answer now, no further calls. */
  tools?: ToolSpec[]; toolChoice?: 'auto' | 'none';
  onActivity?: (a: ChatActivity) => void }
export interface ChatUsage { model: string; inputTokens: number; outputTokens: number; costUsd: number | null; approximate: boolean }
/**
 * `finishReason` / `reasoningTokens` are reported when the provider gives them ('length' = the reply hit maxTokens, so a JSON
 * reply is truncated); diagnostics only, never shown to the Creator. `toolCalls` / `providerRaw`: native tool calling.
 */
export interface ChatResult { text: string; usage: ChatUsage; finishReason?: string; reasoningTokens?: number; toolCalls?: ToolCall[]; providerRaw?: unknown }
export interface ChatProvider {
  readonly id: string; readonly model: string; complete(req: ChatRequest): Promise<ChatResult>;
  /** FR-075: same as complete, but text deltas are reported as they arrive (provider stream). Optional: callers fall back to complete. */
  stream?(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResult>;
  /** AI_WORKFLOW §8.1: the adapter sends `req.tools` through the provider's tools API and returns `toolCalls`. */
  readonly nativeTools?: boolean;
}

/** Price per million tokens (USD) for providers that do not report cost; values come from the Capability Table, labelled approximate. */
export type PriceTable = Record<string, { input: number; output: number }>;
export function estimateCost(model: string, inputTokens: number, outputTokens: number, prices?: PriceTable): { costUsd: number | null; approximate: boolean } {
  const p = prices?.[model];
  return p ? { costUsd: (inputTokens * p.input + outputTokens * p.output) / 1e6, approximate: true } : { costUsd: null, approximate: true };
}

/** Maps provider/transport failures to EM codes (AI_WORKFLOW §12, ERROR_CATALOGUE EM-4xxx). */
export function mapProviderError(e: unknown): EmError {
  if (e instanceof EmError) return e;
  const err = e as { name?: string; statusCode?: number; message?: string; cause?: unknown; responseBody?: unknown; responseHeaders?: unknown };
  const msg = String(err?.message ?? e);
  if (err?.name === 'AbortError' || /aborted|timeout|timed out/i.test(msg)) return new EmError('EM-4101', 'The AI provider took too long to answer.', { cause: e });
  // The provider's own reason from the error body (redacted, ≤ 300 chars): shown for refusals, logged for 401/403 (FR-191).
  const body = /provider HTTP \d+: ([\s\S]*)$/.exec(msg)?.[1] ?? (typeof err?.responseBody === 'string' ? err.responseBody.slice(0, 2000) : '');
  let reason = '';
  if (body) { try { const j = JSON.parse(body) as { error?: { message?: unknown; type?: unknown } | string; message?: unknown }; reason = String((typeof j.error === 'object' ? j.error?.message ?? j.error?.type : j.error) ?? j.message ?? ''); } catch { reason = body; } }
  reason = reason.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…').replace(/(AIza[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1…').slice(0, 300);
  const status = typeof err?.statusCode === 'number' ? err.statusCode : undefined;
  switch (err?.statusCode) {
    case 401: case 403: return new EmError('EM-4002', 'The AI provider rejected the key.', { cause: e, details: { status, ...(reason ? { reason } : {}) } });
    case 402: return new EmError('EM-4201', 'The provider account has no credit left.', { cause: e, details: { status } });
    case 404: return new EmError('EM-4004', 'This model is not available from the provider.', { cause: e, details: { status, ...(reason ? { reason } : {}) } });
    case 400: case 413: case 422:
      // The provider understood the call and refused it: show its own reason (from the error body) instead of "cannot be reached".
      return new EmError('EM-4105', `The AI provider refused the request${reason ? `: ${reason}` : '.'}`, { cause: e, details: { status: err.statusCode, ...(reason ? { reason } : {}) } });
    case 429: {
      // Free / shared models are often "rate-limited upstream" for a few seconds: keep the provider's wait hint for the retry.
      const retryAfterMs = retryAfterMsOf(err.responseHeaders, body);
      return new EmError('EM-4102', 'The AI provider is rate limiting requests.', { cause: e, details: { status, ...(reason ? { reason } : {}), ...(retryAfterMs !== null ? { retryAfterMs } : {}) } });
    }
    default: break;
  }
  if (typeof err?.statusCode === 'number' && err.statusCode >= 500) return new EmError('EM-4103', 'The AI provider had an error.', { cause: e });
  return new EmError('EM-4003', 'Could not reach the AI provider.', { cause: e });
}

/**
 * The wait a 429 asks for, in ms: the `Retry-After` header (seconds or an HTTP date), else OpenRouter's upstream
 * `X-RateLimit-Reset` (epoch ms, in the error body's metadata.headers). null when the provider gave no hint.
 */
export function retryAfterMsOf(headers: unknown, body = '', now = Date.now()): number | null {
  const h = (headers && typeof headers === 'object' ? headers : {}) as Record<string, unknown>;
  const get = (name: string) => { for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return String(v); return undefined; };
  const ra = get('retry-after');
  if (ra !== undefined) {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - now);
  }
  const reset = get('x-ratelimit-reset') ?? /"X-RateLimit-Reset"\s*:\s*"?(\d{10,})/i.exec(body)?.[1];
  if (reset !== undefined && /^\d+$/.test(reset)) { const n = Number(reset); const ms = n > 1e12 ? n - now : n * 1000 - now; return Math.max(0, Math.round(ms)); }
  return null;
}

/** AI_WORKFLOW §12: how a rate-limited (EM-4102) call is retried: at most `retries` more tries, waits ≤ `maxWaitMs` in total. */
export interface RateLimitRetry { retries?: number; maxWaitMs?: number; baseDelayMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }
const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new EmError('EM-4303', 'Cancelled.')); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new EmError('EM-4303', 'Cancelled.')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});
/**
 * Wraps a provider so a rate-limited answer (HTTP 429 → EM-4102) is retried with backoff: the provider's Retry-After when it
 * gives one (capped), else 3 s, then 6 s; never longer than `maxWaitMs` (20 s) in total, never after the caller's abort, never
 * for a stream that already showed text. The final EM-4102 carries `retries` in its details so callers do not retry again.
 */
export function withRateLimitRetry(p: ChatProvider, o: RateLimitRetry = {}): ChatProvider {
  const retries = o.retries ?? 2, maxWait = o.maxWaitMs ?? 20_000, base = o.baseDelayMs ?? 3000, sleep = o.sleep ?? abortableSleep;
  const run = async <T>(req: ChatRequest, fn: () => Promise<T>, streamed: () => boolean): Promise<T> => {
    let waited = 0;
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        const em = e instanceof EmError ? e : mapProviderError(e);
        if (em.code !== 'EM-4102' || streamed() || req.signal?.aborted) throw em;
        // A daily quota ("free-models-per-day") does not clear within seconds: no retry, flagged for the message.
        const daily = /per[- ]?day|daily/i.test(String((em.details as { reason?: unknown } | undefined)?.reason ?? ''));
        if (daily) throw new EmError('EM-4102', em.message, { cause: em.cause ?? em, details: { ...((em.details as Record<string, unknown> | undefined) ?? {}), retries: i, daily: true } });
        const hint = (em.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
        const want = typeof hint === 'number' ? Math.max(250, hint) : base * 2 ** i;
        const wait = Math.min(want, maxWait - waited);
        if (i >= retries || wait < 250 || (typeof hint === 'number' && hint > maxWait - waited)) {
          throw new EmError('EM-4102', em.message, { cause: em.cause ?? em, details: { ...((em.details as Record<string, unknown> | undefined) ?? {}), retries: i } });
        }
        try { req.onRetry?.({ n: i + 1, of: retries, waitMs: wait, code: em.code }); } catch { /* progress hint only */ }
        await sleep(wait, req.signal);
        waited += wait;
      }
    }
  };
  return {
    id: p.id, model: p.model, ...(p.nativeTools ? { nativeTools: true } : {}),
    complete: (req) => run(req, () => p.complete(req), () => false),
    ...(p.stream ? { stream: (req: ChatRequest, onDelta: (d: string) => void) => { let shown = false; return run(req, () => p.stream!(req, (d) => { shown = true; onDelta(d); }), () => shown); } } : {}),
  };
}

/**
 * AI SDK message list: a user message with images becomes text + image parts; native tool turns become tool-call parts (or the
 * provider's own response messages when kept) and `tool` messages with tool-result parts; everything else stays a plain string.
 */
export function toSdkMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  return messages.flatMap((m): ModelMessage[] => {
    if (m.role === 'assistant') {
      if (Array.isArray(m.providerRaw) && m.providerRaw.length) return m.providerRaw as ModelMessage[];
      if (m.toolCalls?.length) return [{ role: 'assistant', content: [...(m.content ? [{ type: 'text' as const, text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.input ?? {} }))] }];
      return [{ role: 'assistant', content: m.content }];
    }
    const out: ModelMessage[] = [];
    if (m.toolResults?.length) out.push({ role: 'tool', content: m.toolResults.map((r) => ({ type: 'tool-result' as const, toolCallId: r.id, toolName: r.name, output: r.isError ? { type: 'error-text' as const, value: r.content } : { type: 'text' as const, value: r.content } })) });
    if (m.images?.length) out.push({ role: 'user', content: [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image' as const, image: i.data, mediaType: i.mediaType }))] });
    else if (m.content || !m.toolResults?.length) out.push({ role: 'user', content: m.content });
    return out;
  });
}
/** AI SDK tool set for native tool calling (no `execute`: the runner runs the read-only tools itself). */
export function toSdkTools(tools: readonly ToolSpec[] | undefined) {
  if (!tools?.length) return undefined;
  return Object.fromEntries(tools.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema as Parameters<typeof jsonSchema>[0]) })])) as ToolSet;
}

/** Streamed calls: no chunk for this long = timeout (EM-4101); total limit = call timeout × factor. */
export const STREAM_CHUNK_MS = 90_000, STREAM_TOTAL_FACTOR = 3;

export function openRouterProvider(opts: { apiKey: string; model: string; fetch: typeof fetch; baseURL?: string; appName?: string; /** Capability Table `toolCalling === true` */ nativeTools?: boolean }): ChatProvider {
  const or = createOpenRouter({ apiKey: opts.apiKey, fetch: opts.fetch, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), appName: opts.appName ?? 'Expertmotion' });
  const toolOpts = (req: ChatRequest) => {
    const tools = opts.nativeTools ? toSdkTools(req.tools) : undefined;
    return tools ? { tools, toolChoice: req.toolChoice ?? 'auto' } : {};
  };
  const usageOf = (u: { inputTokens?: number | undefined; outputTokens?: number | undefined }, meta: unknown) => {
    const m = ((meta as Record<string, unknown> | undefined)?.['openrouter'] ?? {}) as { usage?: { cost?: number } };
    const cost = typeof m.usage?.cost === 'number' ? m.usage.cost : null;
    return { model: opts.model, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, costUsd: cost, approximate: cost === null };
  };
  return {
    id: 'openrouter', model: opts.model, ...(opts.nativeTools ? { nativeTools: true } : {}),
    async complete(req) {
      try {
        const r = await generateText({ model: or.chat(opts.model), system: req.system, messages: toSdkMessages(req.messages), maxOutputTokens: req.maxTokens, temperature: req.temperature, maxRetries: 0, ...toolOpts(req),
          ...(req.signal ? { abortSignal: req.signal } : {}), ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}) });
        const rt = r.usage.outputTokenDetails?.reasoningTokens ?? r.usage.reasoningTokens;
        const calls = r.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input }));
        return { text: r.text, usage: usageOf(r.usage, r.providerMetadata), finishReason: String(r.finishReason), ...(typeof rt === 'number' ? { reasoningTokens: rt } : {}),
          ...(calls.length ? { toolCalls: calls, providerRaw: r.response.messages } : {}) };
      } catch (e) { throw mapProviderError(e); }
    },
    async stream(req, onDelta) {
      try {
        // Streaming: reasoning models think for minutes before the first text; the stream stays alive (reasoning chunks), so
        // the limit is a silence of chunkMs, and the whole answer may take STREAM_TOTAL_FACTOR × the call timeout.
        const r = streamText({ model: or.chat(opts.model), system: req.system, messages: toSdkMessages(req.messages), maxOutputTokens: req.maxTokens, temperature: req.temperature, maxRetries: 0, ...toolOpts(req),
          ...(req.signal ? { abortSignal: req.signal } : {}), ...(req.timeoutMs ? { timeout: { totalMs: req.timeoutMs * STREAM_TOTAL_FACTOR, chunkMs: Math.min(req.timeoutMs, STREAM_CHUNK_MS) } } : {}) });
        let text = ''; const calls: ToolCall[] = [];
        for await (const part of r.fullStream) {
          if (part.type === 'text-delta') { text += part.text; onDelta(part.text); }
          else if (part.type === 'reasoning-start') req.onActivity?.({ type: 'thinking' });
          else if (part.type === 'tool-input-start') req.onActivity?.({ type: 'tool', name: part.toolName });
          else if (part.type === 'tool-call') calls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
          else if (part.type === 'error') throw part.error;
        }
        const [usage, metaAll, finish] = await Promise.all([r.usage, r.providerMetadata, r.finishReason]);
        const rt = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens;
        const raw = calls.length ? (await r.response).messages : undefined;
        return { text, usage: usageOf(usage, metaAll), finishReason: String(finish), ...(typeof rt === 'number' ? { reasoningTokens: rt } : {}), ...(calls.length ? { toolCalls: calls, providerRaw: raw } : {}) };
      } catch (e) { throw mapProviderError(e); }
    },
  };
}

/** A scripted reply: text, or (native tool calling) text plus tool calls. */
export type FakeReply = string | { text?: string; toolCalls?: ToolCall[] };
/** Scripted provider for tests and golden-scenario replay (GOLDEN_SCENARIOS §4b). `nativeTools` makes it a tools-capable provider. */
export function fakeProvider(replies: Array<FakeReply | ((req: ChatRequest, attempt: number) => FakeReply) | Error>, model = 'fake/model', opts: { nativeTools?: boolean } = {}): ChatProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const complete = async (req: ChatRequest): Promise<ChatResult> => {
    const i = calls.length; calls.push({ ...req, messages: [...req.messages] });
    const r = replies[Math.min(i, replies.length - 1)];
    if (r instanceof Error) throw mapProviderError(r);
    const v = typeof r === 'function' ? r(req, i) : r!;
    const text = typeof v === 'string' ? v : v.text ?? '';
    const toolCalls = typeof v === 'string' ? undefined : v.toolCalls;
    return { text, usage: { model, inputTokens: Math.ceil(JSON.stringify(req).length / 4), outputTokens: Math.ceil(text.length / 4), costUsd: 0, approximate: false },
      ...(toolCalls?.length ? { toolCalls, providerRaw: [{ fake: true, text, toolCalls }] } : {}) };
  };
  // Streams the scripted reply in 8-character chunks so streaming consumers can be tested without a network.
  return { id: 'fake', model, calls, complete, ...(opts.nativeTools ? { nativeTools: true } : {}), async stream(req, onDelta) {
    const res = await complete(req);
    for (let k = 0; k < res.text.length; k += 8) { if (req.signal?.aborted) throw new EmError('EM-4303', 'Cancelled.'); onDelta(res.text.slice(k, k + 8)); }
    return res;
  } };
}
