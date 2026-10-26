// Single egress module (ARCHITECTURE §9, SEC-080…088, MCP_AND_TOOLING §5.6): the ONLY place that may call fetch towards the
// internet. Every call names its purpose and is checked against that purpose's allow-list (SEC-082):
//   provider        openrouter.ai, api.openai.com, api.anthropic.com, generativelanguage.googleapis.com + the host of a saved
//                   custom (OpenRouter-compatible) base URL — https, a hostname, never an IP literal or localhost
//   model-download  the model hosts of the signed registry (LOCAL_AI_MODELS §3): exactly the Operator model CDN host when the
//                   build has one (services/model-cdn.ts, SEC-071), the built-in Hugging Face/GitHub list otherwise
//   licence         none in the MVP (activation is verified offline, LICENSE_OPERATIONS)
//   update          none in the Service (the Desktop Shell's electron-updater owns update checks, SEC-090)
// Private Mode refuses before any DNS lookup (EM-8202); a host off the purpose's list is EM-8203; HTTPS only. Redirects are never
// followed by the platform (`redirect: 'manual'`): provider calls follow at most 3 hops here, re-checking every hop against the
// same list; model downloads follow hops in packages/models (download.ts), each hop again through this module.
// SEC-084: provider bodies are capped while streaming (4 MB, model lists 8 MB, one stream line ≤ 64 KB) and aborted with EM-4103.
import { EmError } from '@expertmotion/shared';
import { modelCdnHost } from './model-cdn.js';

export const PROVIDER_HOSTS = ['openrouter.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'] as const;
export const MODEL_HOSTS = ['huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co', 'hf.co', 'github.com', 'objects.githubusercontent.com'] as const;   // hf.co: Hugging Face's regional download CDN (<x>.cdn.hf.co)
export const LICENCE_HOSTS = [] as const;
export const UPDATE_HOSTS = [] as const;

export type EgressPurpose = 'provider' | 'provider-models' | 'model-download' | 'licence' | 'update';

/** SEC-084 bounds. */
export const PROVIDER_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const PROVIDER_MODELS_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const PROVIDER_MAX_LINE_BYTES = 64 * 1024;
export const PROVIDER_TOTAL_TIMEOUT_MS = 120_000;
/** SEC-084 (Entry 25b): a streamed answer (text/event-stream) may take up to 6 min in total, but never 90 s without a chunk.
 *  Reasoning models (free tiers especially) think for minutes while the stream stays alive. */
export const PROVIDER_STREAM_TOTAL_TIMEOUT_MS = 360_000;
export const PROVIDER_STREAM_IDLE_TIMEOUT_MS = 90_000;
export const PROVIDER_MAX_REDIRECTS = 3;

export interface Egress {
  /** Provider calls (the purpose every adapter uses). */
  fetch: typeof fetch;
  /** A fetch bound to one purpose and its allow-list. */
  for(purpose: EgressPurpose): typeof fetch;
  isPrivate(): boolean;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** SEC-082: a custom provider base URL must be https:// with a DNS hostname (no IP literal, no localhost, no credentials, no port tricks). */
export function customBaseUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a URL'; }
  if (u.protocol !== 'https:') return 'only https:// is allowed';
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return 'a local host name is not allowed';
  if (IPV4.test(h) || h.startsWith('[') || h.includes(':')) return 'an IP address is not allowed; use a host name';
  if (!h.includes('.')) return 'a full host name is required';
  return null;
}
export const customBaseUrlHost = (raw: string): string | null => (customBaseUrlProblem(raw) === null ? new URL(raw).hostname.toLowerCase().replace(/\.$/, '') : null);

const hostOk = (host: string, list: readonly string[]): boolean => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Wraps a body so it errors (and the transfer is cancelled) once it exceeds `maxBytes`, or a single line exceeds `maxLine`. */
export function capBody(body: ReadableStream<Uint8Array>, maxBytes: number, maxLine: number | null, onChunk?: () => void): ReadableStream<Uint8Array> {
  let total = 0; let line = 0;
  const reader = body.getReader();
  const tooLarge = (what: string) => new EmError('EM-4103', 'The AI provider sent an answer that is too large.', { details: { limit: what } });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      onChunk?.();
      total += value.byteLength;
      if (total > maxBytes) { void reader.cancel().catch(() => undefined); controller.error(tooLarge(`${maxBytes} bytes`)); return; }
      if (maxLine !== null) {
        for (let i = 0; i < value.length; i++) { if (value[i] === 10) line = 0; else if (++line > maxLine) { void reader.cancel().catch(() => undefined); controller.error(tooLarge(`${maxLine} bytes per line`)); return; } }
      }
      controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export function createEgress(opts: {
  isPrivate: () => boolean;
  /** Hosts of saved custom provider base URLs (read at call time; each is re-validated here). */
  customProviderHosts?: () => string[];
  /** model-download allow-list (default: the build's model CDN host only, else MODEL_HOSTS). */
  modelHosts?: () => readonly string[];
  /** Tests only: extra hosts for every purpose. */
  extraHosts?: () => string[];
  impl?: typeof fetch;
}): Egress {
  const impl = opts.impl ?? globalThis.fetch;
  const listFor = (purpose: EgressPurpose): readonly string[] => {
    const extra = opts.extraHosts?.() ?? [];
    switch (purpose) {
      case 'provider': case 'provider-models': {
        const custom = (opts.customProviderHosts?.() ?? []).filter((h) => customBaseUrlProblem(`https://${h}/`) === null);
        return [...PROVIDER_HOSTS, ...custom, ...extra];
      }
      case 'model-download': { const cdn = modelCdnHost(); return [...(opts.modelHosts?.() ?? (cdn ? [cdn] : MODEL_HOSTS)), ...extra]; }
      case 'licence': return [...LICENCE_HOSTS, ...extra];
      case 'update': return [...UPDATE_HOSTS, ...extra];
    }
  };
  const check = (purpose: EgressPurpose, raw: string): URL => {
    if (opts.isPrivate()) throw new EmError('EM-8202', 'Private Mode is on, so Expertmotion is not connecting to the internet.');
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw new EmError('EM-8203', `Only HTTPS connections are allowed (${url.host}).`, { details: { purpose } });
    if (!hostOk(url.hostname.toLowerCase(), listFor(purpose))) throw new EmError('EM-8203', `Connections to ${url.hostname} are not allowed.`, { details: { purpose, host: url.hostname } });
    return url;
  };
  const forPurpose = (purpose: EgressPurpose): typeof fetch => async (input, init) => {
    const first = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    check(purpose, first);
    if (purpose === 'model-download' || purpose === 'licence' || purpose === 'update') {
      return impl(input, { ...(init ?? {}), redirect: 'manual' });           // the caller follows hops (each through here)
    }
    // provider: total timeout, manual redirects re-checked per hop, capped body
    // Until the headers arrive: 120 s. A streamed answer then gets the stream bounds (total 6 min, 90 s idle) instead.
    const limit = new AbortController();
    const timeoutErr = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    let timer = setTimeout(() => limit.abort(timeoutErr()), PROVIDER_TOTAL_TIMEOUT_MS); timer.unref?.();
    const signal = init?.signal ? AbortSignal.any([init.signal, limit.signal]) : limit.signal;
    let url = first; let res: Response;
    for (let hop = 0; ; hop++) {
      res = await impl(hop === 0 ? input : url, { ...(init ?? {}), redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const loc = res.headers.get('location');
      if (!loc || hop + 1 > PROVIDER_MAX_REDIRECTS) throw new EmError('EM-8203', 'The AI provider redirected the request too often or without a target.', { details: { purpose, status: res.status } });
      if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new EmError('EM-8203', 'The AI provider redirected a request that cannot be sent again.', { details: { purpose } });
      url = new URL(loc, url).toString();
      check(purpose, url);                                                     // every hop is on the same allow-list
    }
    if (!res.body) { clearTimeout(timer); return res; }
    const max = purpose === 'provider-models' ? PROVIDER_MODELS_MAX_BODY_BYTES : PROVIDER_MAX_BODY_BYTES;
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) { void res.body.cancel().catch(() => undefined); throw new EmError('EM-4103', 'The AI provider sent an answer that is too large.', { details: { limit: `${max} bytes` } }); }
    const streaming = (res.headers.get('content-type') ?? '').includes('text/event-stream');
    let onChunk: (() => void) | undefined;
    if (streaming) {
      clearTimeout(timer);
      const total = setTimeout(() => limit.abort(timeoutErr()), PROVIDER_STREAM_TOTAL_TIMEOUT_MS); total.unref?.();
      const idle = () => { clearTimeout(timer); timer = setTimeout(() => limit.abort(timeoutErr()), PROVIDER_STREAM_IDLE_TIMEOUT_MS); timer.unref?.(); };
      idle(); onChunk = idle;
      limit.signal.addEventListener('abort', () => { clearTimeout(total); clearTimeout(timer); }, { once: true });
      init?.signal?.addEventListener('abort', () => { clearTimeout(total); clearTimeout(timer); }, { once: true });
    }
    const body = capBody(res.body, max, streaming ? PROVIDER_MAX_LINE_BYTES : null, onChunk);
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return { fetch: forPurpose('provider'), for: forPurpose, isPrivate: opts.isPrivate };
}
