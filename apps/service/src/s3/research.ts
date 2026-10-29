// Internet research for the agents (FR-216 … FR-218, SEC-140 … SEC-143, AI_WORKFLOW §8.2, ADR-033).
//  - availability: setting "Izinkan riset internet" (`webResearch`, default on), Private Mode (blocks everything), provider;
//  - Anthropic: provider-native web_search / web_fetch server tools (adapters.ts), nothing runs here;
//  - OpenAI / Gemini / OpenRouter: the client tool web.search runs one search request on the SAME connection's search feature
//    (OpenAI gpt-5-search-api with web_search_options, Gemini google_search grounding, OpenRouter's web plugin), so no extra
//    account is needed; web.fetch reads a page through the egress module (purpose research: public https hosts only, private
//    addresses refused, 4 MB, 20 s), HTML → text, PDF → text (doc-extract), ≤ 20 000 characters, only URLs the Creator wrote
//    or research returned (exfiltration guard, like Anthropic's web fetch);
//  - web.images: openly licensed pictures (Openverse, Wikimedia Commons; CC0 / PDM / CC BY / CC BY-SA), metadata only — the
//    Creator confirms an import (R-089), which downloads through the egress module and stores the attribution with the asset.
import { EmError, errorMessage } from '@expertmotion/shared';
import { mapProviderError, mergeSources, urlsIn, type ResearchConfig, type ToolHandlers, type WebSource } from '@expertmotion/agents';
import type { ProviderKindT } from './dto.js';
import { extractDocumentText } from './doc-extract.js';

export const FETCH_MAX_CHARS = 20_000;
export const SEARCH_SUMMARY_MAX_CHARS = 6_000;
const OPENAI_SEARCH_MODEL = 'gpt-5-search-api';

/** FR-216: whether the agents may research, and how, for a provider. */
export function researchConfigFor(opts: { privateMode: boolean; setting: boolean; provider: ProviderKindT | null; nativeOff?: { code: string } | null }): ResearchConfig {
  const provider = opts.provider as string;
  if (opts.privateMode) return { available: false, reason: 'private', ...(provider ? { provider } : {}) };
  if (!opts.setting) return { available: false, reason: 'setting', ...(provider ? { provider } : {}) };
  if (!opts.provider || opts.provider === 'custom') return { available: false, reason: 'provider', ...(provider ? { provider } : {}) };
  if (opts.provider === 'anthropic') {
    if (opts.nativeOff?.code === 'EM-4403') return { available: false, reason: 'org-disabled', provider };
    return { available: true, mode: 'native', images: true, provider };
  }
  return { available: true, mode: 'tools', images: true, provider };
}

// ── HTML → text ──
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', deg: '°', euro: '€' };
const ENTITY_RE = /^(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,12});/i;
/** HTML character references → characters. R2: an indexOf scan (a global `replace` with hundreds of thousands of matches was measured at seconds). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  const out: string[] = []; let from = 0;
  for (let k = s.indexOf('&'); k >= 0; k = s.indexOf('&', k + 1)) {
    const m = ENTITY_RE.exec(s.slice(k + 1, k + 16)); if (!m) continue;
    const e = m[1]!; let rep: string | undefined;
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); if (Number.isFinite(n) && n > 0 && n < 0x110000) rep = String.fromCodePoint(n); }
    else rep = ENTITIES[e.toLowerCase()];
    if (rep === undefined) continue;
    out.push(s.slice(from, k), rep); from = k + 1 + m[0].length; k = from - 1;
  }
  out.push(s.slice(from));
  return out.join('');
}
/** Spaces / tabs / nbsp runs → one space, no spaces around line breaks, at most one empty line, trimmed. One char pass (R2). */
function normaliseWhitespace(s: string): string {
  const out: string[] = []; let run = -1; let space = false; let newlines = 0; let any = false;
  const flush = (k: number) => { if (run >= 0) { out.push(s.slice(run, k)); run = -1; } };
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 0xa0) { flush(k); space = true; continue; }
    if (c === 10) { flush(k); newlines++; space = false; continue; }
    if (run < 0) {
      if (any && newlines > 0) out.push(newlines > 1 ? '\n\n' : '\n'); else if (any && space) out.push(' ');
      newlines = 0; space = false; run = k; any = true;
    }
  }
  flush(s.length);
  return out.join('').trim();
}
/** R2: HTML beyond this is not read (a 4 MB page of markup has far less text than this; the text is clipped to 20 000 anyway). */
export const HTML_MAX_CHARS = 1_000_000;
const SKIP_BLOCKS = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'form', 'iframe', 'template', 'aside', 'button', 'select', 'title', 'head']);
const LINE_AFTER = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article', 'blockquote', 'pre', 'table', 'ul', 'ol', 'dd', 'dt', 'figcaption']);
const isNameChar = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;   // a-z 0-9 - : _
/** ASCII-only lower case: same length as the input (String#toLowerCase can change the length, e.g. "İ"), so indexes match. */
const asciiLower = (s: string): string => {
  const l = s.toLowerCase(); if (l.length === s.length) return l;   // only an expansion (e.g. "İ" → "i̇") changes the length
  const out: string[] = []; for (let k = 0; k < s.length; k += 4096) { const part = s.slice(k, k + 4096); out.push(part.replace(/[A-Z]/g, (m) => m.toLowerCase())); }
  return out.join('');
};
/** Index of `<name` followed by a non-name character (a real tag of that name), at or after `from`; -1 if none. Linear. */
function findTag(lower: string, name: string, from: number): number {
  const needle = `<${name}`;
  for (let k = lower.indexOf(needle, from); k >= 0; k = lower.indexOf(needle, k + 1)) if (!isNameChar(lower.charCodeAt(k + needle.length))) return k;
  return -1;
}
/**
 * Readable text of an HTML page: title + main text (scripts, styles, navigation, forms dropped; blocks → lines). R2: one linear
 * pass with indexOf (no backtracking regexes): every closing-tag search is memoised per tag name, so a page with thousands of
 * unclosed `<nav>` tags costs O(length), and input beyond HTML_MAX_CHARS is ignored.
 */
export function htmlToText(html: string): { title: string; text: string } {
  let h = html.length > HTML_MAX_CHARS ? html.slice(0, HTML_MAX_CHARS) : html;
  let lower = asciiLower(h);
  // title: the first <title>…</title>
  let title = '';
  const t0 = findTag(lower, 'title', 0);
  if (t0 >= 0) { const gt = lower.indexOf('>', t0); const t1 = gt < 0 ? -1 : lower.indexOf('</title', gt); if (t1 > gt) title = decodeEntities(h.slice(gt + 1, Math.min(t1, gt + 1 + 2000))).replace(/\s+/g, ' ').trim().slice(0, 200); }
  // comments out (an unclosed comment drops the rest, as a browser does)
  if (lower.includes('<!--')) {
    const parts: string[] = []; let at = 0;
    for (;;) { const c0 = h.indexOf('<!--', at); if (c0 < 0) { parts.push(h.slice(at)); break; } parts.push(h.slice(at, c0), ' '); const c1 = h.indexOf('-->', c0 + 4); if (c1 < 0) break; at = c1 + 3; }
    h = parts.join(''); lower = asciiLower(h);
  }
  // the first <main>/<article> block when it holds real content
  const m0 = [findTag(lower, 'main', 0), findTag(lower, 'article', 0)].filter((k) => k >= 0).sort((a, b) => a - b)[0];
  if (m0 !== undefined) {
    const name = lower.startsWith('<main', m0) && !isNameChar(lower.charCodeAt(m0 + 5)) ? 'main' : 'article';
    const close = lower.indexOf(`</${name}`, m0); const end = close < 0 ? -1 : lower.indexOf('>', close);
    if (end > 0 && end + 1 - m0 > 500) { h = h.slice(m0, end + 1); lower = lower.slice(m0, end + 1); }
  }
  const closeAt = new Map<string, number>();   // name → index of the next `</name` at or after the last search (-1: none left)
  const nextClose = (name: string, from: number): number => {
    const c = closeAt.get(name);
    if (c !== undefined && (c === -1 || c >= from)) return c;
    const k = lower.indexOf(`</${name}`, from); closeAt.set(name, k); return k;
  };
  const out: string[] = []; let pos = 0; let textFrom = 0; const n = h.length;
  const nameRe = /<(\/?)([a-z][a-z0-9:_-]*)/y;
  while (pos < n) {
    const lt = h.indexOf('<', pos);
    if (lt < 0) break;
    nameRe.lastIndex = lt; const mm = nameRe.exec(lower);
    if (!mm) {   // "<" that does not start a tag ("a < b", "<!doctype", "<?xml"): markup up to ">" goes, a bare "<" stays text
      if (lower[lt + 1] === '!' || lower[lt + 1] === '?') { const gt = h.indexOf('>', lt); out.push(h.slice(textFrom, lt), ' '); pos = textFrom = gt < 0 ? n : gt + 1; }
      else pos = lt + 1;
      continue;
    }
    const gt = h.indexOf('>', lt + mm[0].length);
    if (gt < 0) { out.push(h.slice(textFrom, lt)); textFrom = pos = n; break; }   // an unterminated tag at the end: nothing readable follows
    out.push(h.slice(textFrom, lt));
    const closing = mm[1] === '/'; const name = mm[2]!;
    pos = textFrom = gt + 1;
    if (!closing && SKIP_BLOCKS.has(name)) {
      const c = nextClose(name, pos);
      if (c >= 0) { const e = h.indexOf('>', c); pos = textFrom = e < 0 ? n : e + 1; }   // unclosed: only the opening tag is dropped
      out.push(' '); continue;
    }
    if (name === 'br' || name === 'hr') out.push('\n');
    else if (closing && LINE_AFTER.has(name)) out.push('\n');
    else if (!closing && name === 'li') out.push('\n• ');
    else if (!closing && (name === 'td' || name === 'th')) out.push(' \t');
    else out.push(' ');
  }
  if (textFrom < n) out.push(h.slice(textFrom));
  const text = normaliseWhitespace(decodeEntities(out.join('')));
  return { title, text };
}
const clip = (s: string, n: number): { text: string; truncated: boolean } => {
  if (s.length <= n) return { text: s, truncated: false };
  const cut = s.lastIndexOf('\n', n); const at = cut > n * 0.6 ? cut : n;
  return { text: `${s.slice(0, at)}\n…(truncated)`, truncated: true };
};

/** web.fetch: one page / PDF through the egress module (purpose research). Errors → EM-4407 with the reason. */
export async function fetchPage(fetchFn: typeof fetch, raw: string): Promise<{ url: string; title: string; text: string; truncated: boolean; contentType: string }> {
  let url = raw.trim();
  if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;                       // SEC-140: https only; most sites serve it
  let res: Response;
  try { res = await fetchFn(url, { headers: { Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'id,en;q=0.8' } }); }
  catch (e) { if (e instanceof EmError && e.code !== 'EM-4103') throw e; throw new EmError('EM-4407', e instanceof EmError ? 'The page is too large to read.' : `The page could not be reached (${errorMessage(e).slice(0, 120)}).`, { details: { url } }); }
  if (!res.ok) { void res.body?.cancel().catch(() => undefined); throw new EmError('EM-4407', `The page answered HTTP ${res.status}.`, { details: { url, status: res.status } }); }
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  let buf: Buffer;
  try { buf = Buffer.from(await res.arrayBuffer()); } catch { throw new EmError('EM-4407', 'The page is too large to read.', { details: { url } }); }
  const finalUrl = (res as Response & { url?: string }).url || url;
  if (type.includes('pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    const d = await extractDocumentText(buf, finalUrl.split('/').pop() || 'page.pdf', { maxChars: FETCH_MAX_CHARS });
    return { url: finalUrl, title: finalUrl.split('/').pop() ?? '', text: d.text, truncated: d.truncated, contentType: 'application/pdf' };
  }
  if (!/text\/|html|xml|json/.test(type) && type) throw new EmError('EM-4407', `This file type (${type.split(';')[0]}) cannot be read as a page.`, { details: { url } });
  const charset = /charset=([\w-]+)/.exec(type)?.[1]?.toLowerCase();
  const raw2 = new TextDecoder(charset && ['utf-8', 'utf8', 'iso-8859-1', 'latin1', 'windows-1252'].includes(charset) ? charset : 'utf-8').decode(buf);
  const { title, text } = type.includes('html') || /<html|<body/i.test(raw2.slice(0, 2000)) ? htmlToText(raw2) : { title: '', text: raw2 };
  if (!text.trim()) throw new EmError('EM-4407', 'No readable text was found on the page (it may need JavaScript).', { details: { url } });
  const c = clip(text, FETCH_MAX_CHARS);
  return { url: finalUrl, title, text: c.text, truncated: c.truncated, contentType: type.split(';')[0] ?? '' };
}

// ── Provider-side search for web.search (tools mode) ──
const SEARCH_INSTRUCTION = 'Search the web for the query and report the key facts with numbers, dates and the publisher of each fact. Be concise (at most 12 bullet points). Query: ';
type SearchResult = { summary: string; sources: WebSource[]; queries?: string[] };
async function postJson(fetchFn: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let res: Response;
  try { res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) }); }
  catch (e) { throw mapProviderError(e); }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw mapProviderError(Object.assign(new Error(`provider HTTP ${res.status}: ${text.slice(0, 400)}`), { statusCode: res.status }));
  try { return JSON.parse(text) as Record<string, unknown>; } catch (e) { throw new EmError('EM-4103', 'The AI provider sent an answer Expertmotion could not read.', { cause: e }); }
}
const annotationsOf = (msg: unknown): WebSource[] => {
  const a = (msg as { annotations?: Array<{ type?: unknown; url_citation?: { url?: unknown; title?: unknown } }> } | undefined)?.annotations ?? [];
  return a.flatMap((x) => (x?.type === 'url_citation' && typeof x.url_citation?.url === 'string' ? [{ url: x.url_citation.url, ...(typeof x.url_citation.title === 'string' ? { title: x.url_citation.title } : {}), cited: true }] : []));
};
/** One search on the connection's own search feature (no extra account). Errors keep their EM code (EM-4004: no search model). */
export async function providerSearch(p: ProviderKindT, key: string, model: string, fetchFn: typeof fetch, query: string, signal?: AbortSignal): Promise<SearchResult> {
  const prompt = `${SEARCH_INSTRUCTION}${query}`;
  switch (p) {
    case 'openai': {        // developers.openai.com/api/docs/guides/tools-web-search: Chat Completions search = specialised search model only
      const j = await postJson(fetchFn, 'https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${key}` }, { model: OPENAI_SEARCH_MODEL, web_search_options: {}, messages: [{ role: 'user', content: prompt }] }, signal);
      const msg = (j['choices'] as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message;
      return { summary: String(msg?.content ?? ''), sources: annotationsOf(msg) };
    }
    case 'openrouter': {    // openrouter.ai/docs web search plugin: plugins [{id:'web'}], citations as url_citation annotations
      const j = await postJson(fetchFn, 'https://openrouter.ai/api/v1/chat/completions', { Authorization: `Bearer ${key}`, 'X-Title': 'Expertmotion' }, { model, plugins: [{ id: 'web', max_results: 5 }], messages: [{ role: 'user', content: prompt }] }, signal);
      const msg = (j['choices'] as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message;
      return { summary: String(msg?.content ?? ''), sources: annotationsOf(msg) };
    }
    case 'google': {        // ai.google.dev grounding with Google Search: tools [{google_search:{}}], groundingMetadata.groundingChunks[].web
      const id = model.replace(/^models\//, '');
      if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new EmError('EM-4004', 'This model is not available from the provider.');
      const j = await postJson(fetchFn, `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, { 'x-goog-api-key': key }, { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }, signal);
      const c = (j['candidates'] as Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> }; groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>; webSearchQueries?: unknown } }> | undefined)?.[0];
      const summary = (c?.content?.parts ?? []).filter((x) => x.thought !== true && typeof x.text === 'string').map((x) => String(x.text)).join('');
      const sources = (c?.groundingMetadata?.groundingChunks ?? []).flatMap((g) => (typeof g.web?.uri === 'string' ? [{ url: g.web.uri, ...(typeof g.web.title === 'string' ? { title: g.web.title } : {}), cited: true }] : []));
      const queries = Array.isArray(c?.groundingMetadata?.webSearchQueries) ? (c!.groundingMetadata!.webSearchQueries as unknown[]).map(String) : undefined;
      return { summary, sources, ...(queries ? { queries } : {}) };
    }
    default: throw new EmError('EM-4404', 'This AI provider offers no web search.');
  }
}

// ── Openly licensed pictures ──
export type ImageLicence = 'cc0' | 'pdm' | 'by' | 'by-sa';
export interface ImageCandidate { source: 'openverse' | 'wikimedia'; id: string; title: string; creator: string | null; license: ImageLicence; licenseVersion: string | null; licenseUrl: string | null; landingUrl: string | null; width: number | null; height: number | null; provider: string | null }
export const ALLOWED_LICENCES: readonly ImageLicence[] = ['cc0', 'pdm', 'by', 'by-sa'];
/** Attribution line stored with the asset and shown in the Library ("Foto: <title> oleh <creator>, CC BY 4.0, via Openverse"). */
export function attributionText(c: Pick<ImageCandidate, 'title' | 'creator' | 'license' | 'licenseVersion' | 'source'>): string {
  const lic = c.license === 'cc0' ? 'CC0' : c.license === 'pdm' ? 'Public Domain' : `CC ${c.license.toUpperCase()}${c.licenseVersion ? ` ${c.licenseVersion}` : ''}`;
  return `"${c.title}"${c.creator ? ` by ${c.creator}` : ''}, ${lic}, via ${c.source === 'openverse' ? 'Openverse' : 'Wikimedia Commons'}`;
}
type OvRow = { id?: unknown; title?: unknown; creator?: unknown; license?: unknown; license_version?: unknown; license_url?: unknown; foreign_landing_url?: unknown; width?: unknown; height?: unknown; provider?: unknown; source?: unknown; url?: unknown };
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function ovCandidate(r: OvRow): ImageCandidate | null {
  const lic = String(r.license ?? '').toLowerCase() as ImageLicence;
  if (typeof r.id !== 'string' || !ALLOWED_LICENCES.includes(lic)) return null;
  return { source: 'openverse', id: r.id, title: s(r.title) ?? 'Untitled', creator: s(r.creator), license: lic, licenseVersion: s(r.license_version), licenseUrl: s(r.license_url), landingUrl: s(r.foreign_landing_url), width: n(r.width), height: n(r.height), provider: s(r.provider) ?? s(r.source) };
}
/** Openverse search (api.openverse.org/v1/images, anonymous, rate limited): commercial-use licences, no mature results. */
export async function searchImages(fetchApi: typeof fetch, query: string): Promise<ImageCandidate[]> {
  const q = encodeURIComponent(query.slice(0, 200));
  try {
    const res = await fetchApi(`https://api.openverse.org/v1/images/?q=${q}&license=cc0,pdm,by,by-sa&mature=false&page_size=8`, { headers: { Accept: 'application/json' } });
    if (res.ok) { const j = await res.json() as { results?: OvRow[] }; const out = (j.results ?? []).map(ovCandidate).filter((x): x is ImageCandidate => !!x); if (out.length) return out; }
  } catch { /* Openverse down or rate limited: Wikimedia Commons below */ }
  return wikimediaSearch(fetchApi, query);
}
type WmPage = { pageid?: unknown; title?: unknown; imageinfo?: Array<{ url?: unknown; width?: unknown; height?: unknown; descriptionurl?: unknown; extmetadata?: Record<string, { value?: unknown } | undefined> }> };
const stripTags = (v: unknown): string | null => s(typeof v === 'string' ? decodeEntities(v.replace(/<[^>]+>/g, '')) : null);
function wmLicence(short: string | null): { license: ImageLicence; version: string | null } | null {
  const x = (short ?? '').toLowerCase();
  if (/^cc0/.test(x)) return { license: 'cc0', version: null };
  if (/public domain|^pd\b|^pd-/.test(x)) return { license: 'pdm', version: null };
  const m = /^cc[ -]by(-sa)?[ -]?(\d\.\d)?/.exec(x);
  if (m) return { license: m[1] ? 'by-sa' : 'by', version: m[2] ?? null };
  return null;
}
function wmCandidate(p: WmPage): ImageCandidate | null {
  const ii = p.imageinfo?.[0]; if (!ii || typeof p.pageid !== 'number') return null;
  const meta = ii.extmetadata ?? {};
  const lic = wmLicence(s(meta['LicenseShortName']?.value));
  if (!lic) return null;
  return { source: 'wikimedia', id: String(p.pageid), title: (s(p.title) ?? 'File').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''), creator: stripTags(meta['Artist']?.value), license: lic.license, licenseVersion: lic.version, licenseUrl: s(meta['LicenseUrl']?.value), landingUrl: s(ii.descriptionurl), width: n(ii.width), height: n(ii.height), provider: 'wikimedia' };
}
const WM_PARAMS = 'action=query&format=json&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600';
export async function wikimediaSearch(fetchApi: typeof fetch, query: string): Promise<ImageCandidate[]> {
  const res = await fetchApi(`https://commons.wikimedia.org/w/api.php?${WM_PARAMS}&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(`${query.slice(0, 200)} filetype:bitmap`)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new EmError('EM-4407', `The picture catalogues could not be reached (HTTP ${res.status}).`);
  const j = await res.json() as { query?: { pages?: Record<string, WmPage> } };
  return Object.values(j.query?.pages ?? {}).map(wmCandidate).filter((x): x is ImageCandidate => !!x);
}
/**
 * R-089: the picture to import, looked up again by its catalogue id (the URL never comes from the model or the Editor), with the
 * download URL. Refuses a licence outside CC0 / PDM / CC BY / CC BY-SA (EM-4408).
 */
export async function resolveImage(fetchApi: typeof fetch, source: 'openverse' | 'wikimedia', id: string): Promise<{ candidate: ImageCandidate; downloadUrl: string }> {
  if (source === 'openverse') {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new EmError('EM-9002', 'Invalid picture id.', { status: 400, path: 'body.id' });
    const res = await fetchApi(`https://api.openverse.org/v1/images/${id}/`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new EmError('EM-4407', `The picture is no longer available (HTTP ${res.status}).`);
    const r = await res.json() as OvRow;
    const c = ovCandidate(r); const url = s(r.url);
    if (!c || !url) throw new EmError('EM-4408', 'This picture is not openly licensed for reuse, so it was not imported.');
    return { candidate: c, downloadUrl: url };
  }
  if (!/^\d{1,12}$/.test(id)) throw new EmError('EM-9002', 'Invalid picture id.', { status: 400, path: 'body.id' });
  const res = await fetchApi(`https://commons.wikimedia.org/w/api.php?${WM_PARAMS}&pageids=${id}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new EmError('EM-4407', `The picture is no longer available (HTTP ${res.status}).`);
  const j = await res.json() as { query?: { pages?: Record<string, WmPage> } };
  const p = Object.values(j.query?.pages ?? {})[0]; const c = p ? wmCandidate(p) : null;
  const ii = p?.imageinfo?.[0] as { thumburl?: unknown; url?: unknown } | undefined;
  const url = s(ii?.thumburl) ?? s(ii?.url);
  if (!c || !url) throw new EmError('EM-4408', 'This picture is not openly licensed for reuse, so it was not imported.');
  return { candidate: c, downloadUrl: url };
}

/**
 * The web.* handlers of one run. `allowedUrls`: the URLs in the Creator's messages; URLs research returns during the run are added.
 * `search` is absent in native mode (the provider searches itself).
 */
export function researchHandlers(o: { cfg: ResearchConfig; fetchPage: typeof fetch; fetchApi: typeof fetch; allowedUrls: () => string[];
  search?: (query: string) => Promise<SearchResult>; onImages?: (c: ImageCandidate[]) => void }): ToolHandlers {
  if (!o.cfg.available) return {};
  const seen = new Set<string>();
  const allowed = (u: string) => { const k = u.replace(/^http:/i, 'https:').replace(/\/$/, ''); return [...o.allowedUrls(), ...seen].some((x) => x.replace(/^http:/i, 'https:').replace(/\/$/, '') === k); };
  const h: ToolHandlers = {};
  if (o.cfg.mode === 'tools') {
    if (o.search) h['web.search'] = async (i) => {
      const r = await o.search!(String(i['query']));
      for (const x of r.sources) seen.add(x.url);
      const c = clip(r.summary, SEARCH_SUMMARY_MAX_CHARS);
      return { summary: c.text, sources: mergeSources([r.sources], 10).map((x) => ({ url: x.url, ...(x.title ? { title: x.title } : {}) })), ...(r.queries ? { queries: r.queries.slice(0, 5) } : {}) };
    };
    h['web.fetch'] = async (i) => {
      const url = String(i['url']);
      if (!allowed(url)) return { error: { code: 'EM-4406', message: 'Only pages whose URL the Creator wrote in the chat or a web.search returned can be read. Ask the Creator for the link, or search first.' } };
      const p = await fetchPage(o.fetchPage, url);
      return { url: p.url, title: p.title, text: p.text, truncated: p.truncated };
    };
  }
  if (o.cfg.images) h['web.images'] = async (i) => {
    const c = (await searchImages(o.fetchApi, String(i['query']))).slice(0, 8);
    o.onImages?.(c);
    return { candidates: c.map((x) => ({ source: x.source, id: x.id, title: x.title, creator: x.creator, license: x.license, width: x.width, height: x.height })),
      note: 'The Creator sees these as cards and decides which to import into the Library. Describe them briefly; do not paste links.' };
  };
  return h;
}

/** The URLs the Creator wrote in this conversation (web.fetch may read only these and what research returned). */
export const creatorUrls = (texts: readonly string[]): string[] => urlsIn(texts.join('\n'));
