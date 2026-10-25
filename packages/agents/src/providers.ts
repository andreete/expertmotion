// Provider layer (MCP_AND_TOOLING §5): one interface; OpenRouter first (PRD-010) through Vercel AI SDK v6.
// All network access goes through an injected `fetch` — the Local Service's single egress module with the Private Mode gate.
import { generateText, streamText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { EmError } from '@expertmotion/shared';

/** FR-072: an image attached by the Creator, sent as an image part only to models with image input (Capability Table). */
export interface ChatImage { mediaType: string; /** base64, no data: prefix */ data: string; name?: string }
export interface ChatMessage { role: 'user' | 'assistant'; content: string; images?: ChatImage[] }
export interface ChatRequest { system: string; messages: ChatMessage[]; maxTokens: number; temperature: number; signal?: AbortSignal; timeoutMs?: number }
export interface ChatUsage { model: string; inputTokens: number; outputTokens: number; costUsd: number | null; approximate: boolean }
export interface ChatResult { text: string; usage: ChatUsage }
export interface ChatProvider {
  readonly id: string; readonly model: string; complete(req: ChatRequest): Promise<ChatResult>;
  /** FR-075: same as complete, but text deltas are reported as they arrive (provider stream). Optional: callers fall back to complete. */
  stream?(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResult>;
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
  const err = e as { name?: string; statusCode?: number; message?: string; cause?: unknown };
  const msg = String(err?.message ?? e);
  if (err?.name === 'AbortError' || /aborted|timeout|timed out/i.test(msg)) return new EmError('EM-4101', 'The AI provider took too long to answer.', { cause: e });
  switch (err?.statusCode) {
    case 401: case 403: return new EmError('EM-4002', 'The AI provider rejected the key.', { cause: e });
    case 402: return new EmError('EM-4201', 'The provider account has no credit left.', { cause: e });
    case 404: return new EmError('EM-4004', 'This model is not available from the provider.', { cause: e });
    case 400: case 413: case 422: {
      // The provider understood the call and refused it: show its own reason (from the error body) instead of "cannot be reached".
      const body = /provider HTTP \d+: ([\s\S]*)$/.exec(msg)?.[1] ?? '';
      let reason = '';
      try { const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }; reason = String((typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message ?? ''); } catch { reason = body; }
      reason = reason.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…').slice(0, 300);
      return new EmError('EM-4105', `The AI provider refused the request${reason ? `: ${reason}` : '.'}`, { cause: e, details: { status: err.statusCode, ...(reason ? { reason } : {}) } });
    }
    case 429: return new EmError('EM-4102', 'The AI provider is rate limiting requests.', { cause: e });
    default: break;
  }
  if (typeof err?.statusCode === 'number' && err.statusCode >= 500) return new EmError('EM-4103', 'The AI provider had an error.', { cause: e });
  return new EmError('EM-4003', 'Could not reach the AI provider.', { cause: e });
}

/** AI SDK message list: a user message with images becomes text + image parts; everything else stays a plain string. */
export function toSdkMessages(messages: readonly ChatMessage[]) {
  return messages.map((m) => (m.role === 'user' && m.images?.length
    ? { role: 'user' as const, content: [{ type: 'text' as const, text: m.content }, ...m.images.map((i) => ({ type: 'image' as const, image: i.data, mediaType: i.mediaType }))] }
    : m.role === 'assistant' ? { role: 'assistant' as const, content: m.content } : { role: 'user' as const, content: m.content }));
}

export function openRouterProvider(opts: { apiKey: string; model: string; fetch: typeof fetch; baseURL?: string; appName?: string }): ChatProvider {
  const or = createOpenRouter({ apiKey: opts.apiKey, fetch: opts.fetch, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), appName: opts.appName ?? 'Expertmotion' });
  return {
    id: 'openrouter', model: opts.model,
    async complete(req) {
      try {
        const r = await generateText({ model: or.chat(opts.model), system: req.system, messages: toSdkMessages(req.messages), maxOutputTokens: req.maxTokens, temperature: req.temperature, maxRetries: 0,
          ...(req.signal ? { abortSignal: req.signal } : {}), ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}) });
        const meta = (r.providerMetadata?.['openrouter'] ?? {}) as { usage?: { cost?: number } };
        const cost = typeof meta.usage?.cost === 'number' ? meta.usage.cost : null;
        return { text: r.text, usage: { model: opts.model, inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0, costUsd: cost, approximate: cost === null } };
      } catch (e) { throw mapProviderError(e); }
    },
    async stream(req, onDelta) {
      try {
        const r = streamText({ model: or.chat(opts.model), system: req.system, messages: toSdkMessages(req.messages), maxOutputTokens: req.maxTokens, temperature: req.temperature, maxRetries: 0,
          ...(req.signal ? { abortSignal: req.signal } : {}), ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}) });
        let text = '';
        for await (const part of r.fullStream) {
          if (part.type === 'text-delta') { text += part.text; onDelta(part.text); }
          else if (part.type === 'error') throw part.error;
        }
        const [usage, metaAll] = await Promise.all([r.usage, r.providerMetadata]);
        const meta = (metaAll?.['openrouter'] ?? {}) as { usage?: { cost?: number } };
        const cost = typeof meta.usage?.cost === 'number' ? meta.usage.cost : null;
        return { text, usage: { model: opts.model, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, costUsd: cost, approximate: cost === null } };
      } catch (e) { throw mapProviderError(e); }
    },
  };
}

/** Scripted provider for tests and golden-scenario replay (GOLDEN_SCENARIOS §4b). */
export function fakeProvider(replies: Array<string | ((req: ChatRequest, attempt: number) => string) | Error>, model = 'fake/model'): ChatProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const complete = async (req: ChatRequest): Promise<ChatResult> => {
    const i = calls.length; calls.push(req);
    const r = replies[Math.min(i, replies.length - 1)];
    if (r instanceof Error) throw mapProviderError(r);
    const text = typeof r === 'function' ? r(req, i) : String(r);
    return { text, usage: { model, inputTokens: Math.ceil(JSON.stringify(req).length / 4), outputTokens: Math.ceil(text.length / 4), costUsd: 0, approximate: false } };
  };
  // Streams the scripted reply in 8-character chunks so streaming consumers can be tested without a network.
  return { id: 'fake', model, calls, complete, async stream(req, onDelta) {
    const res = await complete(req);
    for (let k = 0; k < res.text.length; k += 8) { if (req.signal?.aborted) throw new EmError('EM-4303', 'Cancelled.'); onDelta(res.text.slice(k, k + 8)); }
    return res;
  } };
}
