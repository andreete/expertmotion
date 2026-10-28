// Single egress module (ARCHITECTURE §9, SEC-080…088, MCP_AND_TOOLING §5.6): the ONLY place that may call fetch towards the
// internet. Every call names its purpose and is checked against that purpose's allow-list (SEC-082):
//   provider        openrouter.ai, api.openai.com, api.anthropic.com, generativelanguage.googleapis.com + the host of a saved
//                   custom (OpenRouter-compatible) base URL — https, a hostname, never an IP literal or localhost
//   model-download  the model hosts of the signed registry (LOCAL_AI_MODELS §3): exactly the Operator model CDN host when the
//                   build has one (services/model-cdn.ts, SEC-071), the built-in Hugging Face/GitHub list otherwise
//   tts             cloud voices of the Creator's own keys (FR-246): api.openai.com, generativelanguage.googleapis.com, api.elevenlabs.io
//                   — no redirects, 40 MB body cap, 120 s total (SEC-135)
//   licence         none in the MVP (activation is verified offline, LICENSE_OPERATIONS)
//   update          none in the Service (the Desktop Shell's electron-updater owns update checks, SEC-090)
//   research        FR-216 / SEC-140: web pages the agents read (web.fetch) and openly licensed pictures the Creator confirmed
//                   (web.images import): any public https host — never an IP literal, localhost / .local / .internal, and the
//                   host must not resolve to a private, loopback, link-local or CGNAT address (checked per hop); only when the
//                   setting "Izinkan riset internet" is on (the caller checks it) and never in Private Mode
//   research-api    the open-licence image catalogues (Openverse API, Wikimedia Commons API)
// Private Mode refuses before any DNS lookup (EM-8202); a host off the purpose's list is EM-8203; HTTPS only. Redirects are never
// followed by the platform (`redirect: 'manual'`): provider calls follow at most 3 hops here, re-checking every hop against the
// same list; model downloads follow hops in packages/models (download.ts), each hop again through this module.
// SEC-084: provider bodies are capped while streaming (4 MB, model lists 8 MB, one stream line ≤ 64 KB) and aborted with EM-4103.
import { EmError } from '@expertmotion/shared';
import { modelCdnHost } from './model-cdn.js';

export const PROVIDER_HOSTS = ['openrouter.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'] as const;
export const MODEL_HOSTS = ['huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co', 'hf.co', 'github.com', 'objects.githubusercontent.com'] as const;   // hf.co: Hugging Face's regional download CDN (<x>.cdn.hf.co)
export const LICENCE_HOSTS = [] as const;
/** SEC-135 (FR-246): cloud text-to-speech hosts. Audio answers are larger than chat answers, so they get their own cap. */
export const TTS_HOSTS = ['api.openai.com', 'generativelanguage.googleapis.com', 'api.elevenlabs.io'] as const;
export const TTS_MAX_BODY_BYTES = 40 * 1024 * 1024;
export const TTS_TOTAL_TIMEOUT_MS = 120_000;
export const UPDATE_HOSTS = [] as const;
export const RESEARCH_API_HOSTS = ['api.openverse.org', 'commons.wikimedia.org'] as const;
/** SEC-140 bounds of a research fetch: page / PDF 4 MB, picture 15 MB, 20 s, 5 redirect hops. */
export const RESEARCH_MAX_BYTES = 4 * 1024 * 1024;
export const RESEARCH_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const RESEARCH_TIMEOUT_MS = 20_000;
export const RESEARCH_MAX_REDIRECTS = 5;

export type EgressPurpose = 'provider' | 'provider-models' | 'model-download' | 'licence' | 'update' | 'research' | 'research-api' | 'tts';

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

/** SEC-140: an address no research fetch may reach (private, loopback, link-local, CGNAT, multicast, unspecified, ULA, mapped). */
export function isPrivateAddress(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
  }
  return a === '::' || a === '::1' || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('ff') || a.startsWith('::ffff:');
}
/** SEC-140: why a research URL is refused (scheme, credentials, host form), or null. DNS is checked separately. */
export function researchUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a URL'; }
  if (u.protocol !== 'https:') return 'only https:// pages can be read';
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  if (u.port && u.port !== '443') return 'only the standard https port is allowed';
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return 'a local host name is not allowed';
  if (IPV4.test(h) || h.startsWith('[') || h.includes(':')) return 'an IP address is not allowed';
  if (!h.includes('.')) return 'a full host name is required';
  return null;
}

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
  /** SEC-140: resolves a research host (tests inject one); default node:dns lookup of every address. */
  lookup?: (host: string) => Promise<string[]>;
}): Egress {
  const impl = opts.impl ?? globalThis.fetch;
  const lookup = opts.lookup ?? (async (host: string) => { const dns = await import('node:dns'); return (await dns.promises.lookup(host, { all: true, verbatim: true })).map((x) => x.address); });
  const listFor = (purpose: EgressPurpose): readonly string[] => {
    const extra = opts.extraHosts?.() ?? [];
    switch (purpose) {
      case 'provider': case 'provider-models': {
        const custom = (opts.customProviderHosts?.() ?? []).filter((h) => customBaseUrlProblem(`https://${h}/`) === null);
        return [...PROVIDER_HOSTS, ...custom, ...extra];
      }
      case 'model-download': { const cdn = modelCdnHost(); return [...(opts.modelHosts?.() ?? (cdn ? [cdn] : MODEL_HOSTS)), ...extra]; }
      case 'tts': return [...TTS_HOSTS, ...extra];
      case 'licence': return [...LICENCE_HOSTS, ...extra];
      case 'update': return [...UPDATE_HOSTS, ...extra];
      case 'research-api': return [...RESEARCH_API_HOSTS, ...extra];
      case 'research': return ['*'];
    }
  };
  const check = (purpose: EgressPurpose, raw: string): URL => {
    if (opts.isPrivate()) throw new EmError('EM-8202', 'Private Mode is on, so Expertmotion is not connecting to the internet.');
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw new EmError('EM-8203', `Only HTTPS connections are allowed (${url.host}).`, { details: { purpose } });
    if (purpose === 'research') {
      const why = researchUrlProblem(url.href);
      if (why && !(opts.extraHosts?.() ?? []).includes(url.hostname)) throw new EmError('EM-8203', `This address cannot be read (${why}).`, { details: { purpose, host: url.hostname } });
      return url;
    }
    if (!hostOk(url.hostname.toLowerCase(), listFor(purpose))) throw new EmError('EM-8203', `Connections to ${url.hostname} are not allowed.`, { details: { purpose, host: url.hostname } });
    return url;
  };
  /** SEC-140: the research host must not resolve to a private address (re-checked on every redirect hop). */
  const checkDns = async (url: URL) => {
    if ((opts.extraHosts?.() ?? []).includes(url.hostname)) return;                 // tests: the local stub host
    let addrs: string[];
    try { addrs = await lookup(url.hostname); } catch { throw new EmError('EM-4407', `${url.hostname} could not be found.`, { details: { host: url.hostname } }); }
    if (!addrs.length || addrs.some(isPrivateAddress)) throw new EmError('EM-8203', `This address cannot be read (it points into a private network).`, { details: { purpose: 'research', host: url.hostname } });
  };
  /** Research and catalogue fetches: GET only, 20 s, ≤ 5 hops re-checked, body capped at `maxBytes` (default 4 MB). */
  const researchFetch = (purpose: 'research' | 'research-api'): typeof fetch => async (input, init) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const max = Number((init?.headers as Record<string, string> | undefined)?.['x-em-max-bytes'] ?? RESEARCH_MAX_BYTES);
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) }; delete headers['x-em-max-bytes'];
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(RESEARCH_TIMEOUT_MS)]) : AbortSignal.timeout(RESEARCH_TIMEOUT_MS);
    let res: Response;
    for (let hop = 0; ; hop++) {
      const u = check(purpose, url);
      if (purpose === 'research') await checkDns(u);
      res = await impl(u.href, { method: 'GET', headers: { 'User-Agent': 'Expertmotion/1.0 (+local video editor; research)', ...headers }, redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const loc = res.headers.get('location');
      if (!loc || hop + 1 > RESEARCH_MAX_REDIRECTS) throw new EmError('EM-4407', 'The page redirected too often.', { details: { status: res.status } });
      url = new URL(loc, url).toString();
    }
    if (!res.body) return res;
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) { void res.body.cancel().catch(() => undefined); throw new EmError('EM-4407', 'The page or file is too large to read.', { details: { limit: max } }); }
    const capped = capBody(res.body, max, null);
    return Object.defineProperty(new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers }), 'url', { value: url });
  };
  const forPurpose = (purpose: EgressPurpose): typeof fetch => async (input, init) => {
    if (purpose === 'research' || purpose === 'research-api') return researchFetch(purpose)(input, init);
    const first = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    check(purpose, first);
    if (purpose === 'tts') {
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })), TTS_TOTAL_TIMEOUT_MS); timer.unref?.();
      const signal = init?.signal ? AbortSignal.any([init.signal, limit.signal]) : limit.signal;
      const res = await impl(input, { ...(init ?? {}), redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) { clearTimeout(timer); throw new EmError('EM-8203', 'The voice provider redirected the request; it was not followed.', { details: { purpose, status: res.status } }); }
      if (!res.body) { clearTimeout(timer); return res; }
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > TTS_MAX_BODY_BYTES) { clearTimeout(timer); void res.body.cancel().catch(() => undefined); throw new EmError('EM-4103', 'The voice provider sent an answer that is too large.', { details: { limit: `${TTS_MAX_BODY_BYTES} bytes` } }); }
      limit.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
      return new Response(capBody(res.body, TTS_MAX_BODY_BYTES, null), { status: res.status, statusText: res.statusText, headers: res.headers });
    }
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
