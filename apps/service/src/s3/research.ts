// Internet research for the agents (FR-216 … FR-218, SEC-140 … SEC-143, AI_WORKFLOW §8.2, ADR-033).
//  - availability: setting "Izinkan riset internet" (`webResearch`, default on), Private Mode (blocks everything), provider;
//  - Anthropic: provider-native web_search / web_fetch server tools (adapters.ts), nothing runs here;
//  - OpenAI / Gemini / OpenRouter: the client tool web.search runs one search request on the SAME connection's search feature
//    (OpenAI gpt-5-search-api with web_search_options, Gemini google_search grounding, OpenRouter's web plugin), so no extra
//    account is needed; web.fetch reads a page through the egress module (purpose research: public https hosts only, private
//    addresses refused, 4 MB, 20 s), HTML → text, PDF → text (doc-extract), ≤ 20 000 characters, only URLs the Creator wrote
//    or research returned (exfiltration guard, like Anthropic's web fetch);
//  - web.images: openly licensed pictures (Openverse, Wikimedia Commons; CC0 / PDM / CC BY / CC BY-SA), metadata only — the
//    Creator confirms an import (R-089), which downloads through the egress module and stores the attribution with the asset;
//    ADR-041 (FR-300 … FR-304): source 'stock' = Pexels photos + videos with the Creator's own key, source 'page' = the pictures of
//    a page the allow-list admits (owner's copyright, labelled as quotation / commentary);
//  - web.screenshot (FR-305): a PNG of a page's top through the bundled Chrome (s3/screenshot.ts), imported as an image asset.
import { createHash } from 'node:crypto';
import { EmError, errorMessage } from '@expertmotion/shared';
import { mapProviderError, mergeSources, urlsIn, type ResearchConfig, type ToolHandlers, type WebSource } from '@expertmotion/agents';
import type { ProviderKindT } from './dto.js';
import { extractDocumentText } from './doc-extract.js';
import { researchUrlProblem } from '../services/egress.js';

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

/** The raw body of one research fetch (page / PDF / HTML for the picture extractor): decoded text, type, final URL. */
export async function fetchRaw(fetchFn: typeof fetch, raw: string): Promise<{ url: string; type: string; text: string; pdf: Buffer | null }> {
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
  if (type.includes('pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') return { url: finalUrl, type: 'application/pdf', text: '', pdf: buf };
  if (!/text\/|html|xml|json/.test(type) && type) throw new EmError('EM-4407', `This file type (${type.split(';')[0]}) cannot be read as a page.`, { details: { url } });
  const charset = /charset=([\w-]+)/.exec(type)?.[1]?.toLowerCase();
  const text = new TextDecoder(charset && ['utf-8', 'utf8', 'iso-8859-1', 'latin1', 'windows-1252'].includes(charset) ? charset : 'utf-8').decode(buf);
  return { url: finalUrl, type, text, pdf: null };
}
/** web.fetch: one page / PDF through the egress module (purpose research). Errors → EM-4407 with the reason. */
export async function fetchPage(fetchFn: typeof fetch, raw: string): Promise<{ url: string; title: string; text: string; truncated: boolean; contentType: string }> {
  const p = await fetchRaw(fetchFn, raw);
  if (p.pdf) {
    const d = await extractDocumentText(p.pdf, p.url.split('/').pop() || 'page.pdf', { maxChars: FETCH_MAX_CHARS });
    return { url: p.url, title: p.url.split('/').pop() ?? '', text: d.text, truncated: d.truncated, contentType: 'application/pdf' };
  }
  const { title, text } = p.type.includes('html') || /<html|<body/i.test(p.text.slice(0, 2000)) ? htmlToText(p.text) : { title: '', text: p.text };
  if (!text.trim()) throw new EmError('EM-4407', 'No readable text was found on the page (it may need JavaScript).', { details: { url: p.url } });
  const c = clip(text, FETCH_MAX_CHARS);
  return { url: p.url, title, text: c.text, truncated: c.truncated, contentType: p.type.split(';')[0] ?? '' };
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

// ── Pictures and clips from the internet (FR-217 open catalogues; FR-300 … FR-304 Pexels stock and page pictures, ADR-041) ──
export type ImageSource = 'openverse' | 'wikimedia' | 'pexels' | 'pexels-video' | 'page';
/** `pexels` = Pexels License (free use, no attribution required, no resale); `owner` = the page owner's copyright (quotation / commentary only). */
export type ImageLicence = 'cc0' | 'pdm' | 'by' | 'by-sa' | 'pexels' | 'owner';
export interface ImageCandidate {
  source: ImageSource; id: string;
  /** Absent on candidates stored before ADR-041 = image. */
  kind?: 'image' | 'video';
  title: string; creator: string | null; license: ImageLicence; licenseVersion: string | null; licenseUrl: string | null; landingUrl: string | null; width: number | null; height: number | null; provider: string | null;
  /** Human licence text for the card ("Pexels License", "Hak cipta pemilik — kutipan/komentar"); the UI derives it for CC codes. */
  licence?: string;
  thumbUrl?: string | null;
  /** `page` only: the picture's address on the page. There is no catalogue to resolve the id again, so it is kept on the message and re-validated on import (never taken from the model or the Editor). */
  url?: string;
  durationS?: number | null;
}
export const ALLOWED_LICENCES: readonly ImageLicence[] = ['cc0', 'pdm', 'by', 'by-sa'];
export const PEXELS_LICENCE_TEXT = 'Pexels License';
export const OWNER_LICENCE_TEXT = 'Hak cipta pemilik — kutipan/komentar';
export const SCREENSHOT_LICENCE_TEXT = 'Hak cipta pemilik — kutipan';
/** Attribution line stored with the asset and shown in the Library ("Foto: <title> oleh <creator>, CC BY 4.0, via Openverse"). */
export function attributionText(c: Pick<ImageCandidate, 'title' | 'creator' | 'license' | 'licenseVersion' | 'source'> & { landingUrl?: string | null }): string {
  if (c.source === 'pexels' || c.source === 'pexels-video') return `${c.source === 'pexels' ? 'Photo' : 'Video'}${c.creator ? ` by ${c.creator}` : ''} on Pexels (${PEXELS_LICENCE_TEXT})${c.landingUrl ? ` — ${c.landingUrl}` : ''}`;
  if (c.source === 'page') return `"${c.title}" — ${c.landingUrl ? hostOf(c.landingUrl) : 'web page'} (${OWNER_LICENCE_TEXT})${c.landingUrl ? ` — ${c.landingUrl}` : ''}`;
  const lic = c.license === 'cc0' ? 'CC0' : c.license === 'pdm' ? 'Public Domain' : `CC ${c.license.toUpperCase()}${c.licenseVersion ? ` ${c.licenseVersion}` : ''}`;
  return `"${c.title}"${c.creator ? ` by ${c.creator}` : ''}, ${lic}, via ${c.source === 'openverse' ? 'Openverse' : 'Wikimedia Commons'}`;
}
/** The licence text of a candidate (what the card shows and what the asset's `licence` stores). */
export function licenceText(c: Pick<ImageCandidate, 'license' | 'licenseVersion' | 'licence'>): string {
  if (c.licence) return c.licence;
  if (c.license === 'pexels') return PEXELS_LICENCE_TEXT;
  if (c.license === 'owner') return OWNER_LICENCE_TEXT;
  return c.license === 'cc0' ? 'CC0' : c.license === 'pdm' ? 'Public Domain' : `CC ${c.license.toUpperCase()}${c.licenseVersion ? ` ${c.licenseVersion}` : ''}`;
}
/** The `credit` stored on the imported asset (author / site / URL), FR-303. */
export function creditText(c: Pick<ImageCandidate, 'source' | 'title' | 'creator' | 'landingUrl'>): string {
  if (c.source === 'pexels' || c.source === 'pexels-video') return `${c.creator ?? 'Pexels'} / Pexels${c.landingUrl ? ` — ${c.landingUrl}` : ''}`;
  if (c.source === 'page') return c.landingUrl ? `${hostOf(c.landingUrl)} — ${c.landingUrl}` : c.title;
  return `${c.title}${c.creator ? ` by ${c.creator}` : ''}, via ${c.source === 'openverse' ? 'Openverse' : 'Wikimedia Commons'}${c.landingUrl ? ` — ${c.landingUrl}` : ''}`;
}
export const hostOf = (u: string): string => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
type OvRow = { id?: unknown; title?: unknown; creator?: unknown; license?: unknown; license_version?: unknown; license_url?: unknown; foreign_landing_url?: unknown; width?: unknown; height?: unknown; provider?: unknown; source?: unknown; url?: unknown; thumbnail?: unknown };
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const httpsUrl = (v: unknown): string | null => { const x = s(v); return x && /^https:\/\//i.test(x) ? x.slice(0, 2000) : null; };
function ovCandidate(r: OvRow): ImageCandidate | null {
  const lic = String(r.license ?? '').toLowerCase() as ImageLicence;
  if (typeof r.id !== 'string' || !ALLOWED_LICENCES.includes(lic)) return null;
  return { source: 'openverse', id: r.id, kind: 'image', title: s(r.title) ?? 'Untitled', creator: s(r.creator), license: lic, licenseVersion: s(r.license_version), licenseUrl: s(r.license_url), landingUrl: s(r.foreign_landing_url), width: n(r.width), height: n(r.height), provider: s(r.provider) ?? s(r.source), thumbUrl: httpsUrl(r.thumbnail) };
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
type WmPage = { pageid?: unknown; title?: unknown; imageinfo?: Array<{ url?: unknown; thumburl?: unknown; width?: unknown; height?: unknown; descriptionurl?: unknown; extmetadata?: Record<string, { value?: unknown } | undefined> }> };
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
  return { source: 'wikimedia', id: String(p.pageid), kind: 'image', title: (s(p.title) ?? 'File').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''), creator: stripTags(meta['Artist']?.value), license: lic.license, licenseVersion: lic.version, licenseUrl: s(meta['LicenseUrl']?.value), landingUrl: s(ii.descriptionurl), width: n(ii.width), height: n(ii.height), provider: 'wikimedia', thumbUrl: httpsUrl(ii.thumburl) };
}
const WM_PARAMS = 'action=query&format=json&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600';
export async function wikimediaSearch(fetchApi: typeof fetch, query: string): Promise<ImageCandidate[]> {
  const res = await fetchApi(`https://commons.wikimedia.org/w/api.php?${WM_PARAMS}&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(`${query.slice(0, 200)} filetype:bitmap`)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new EmError('EM-4407', `The picture catalogues could not be reached (HTTP ${res.status}).`);
  const j = await res.json() as { query?: { pages?: Record<string, WmPage> } };
  return Object.values(j.query?.pages ?? {}).map(wmCandidate).filter((x): x is ImageCandidate => !!x);
}

// ── Pexels (FR-301): photos + videos with the Creator's own key; https://www.pexels.com/api/documentation/ (read 2026-10-31) ──
export const PEXELS_API = 'https://api.pexels.com';
export const PEXELS_FILE_HOSTS = ['images.pexels.com', 'videos.pexels.com'] as const;
/** FR-302: a Pexels clip is downloaded at most this large (the API gives no file size; the egress cap stops a bigger file). */
export const PEXELS_VIDEO_MAX_BYTES = 60 * 1024 * 1024;
type PxPhoto = { id?: unknown; width?: unknown; height?: unknown; url?: unknown; photographer?: unknown; photographer_url?: unknown; alt?: unknown; src?: Record<string, unknown> };
type PxVideoFile = { id?: unknown; quality?: unknown; file_type?: unknown; width?: unknown; height?: unknown; link?: unknown };
type PxVideo = { id?: unknown; width?: unknown; height?: unknown; duration?: unknown; url?: unknown; image?: unknown; user?: { name?: unknown; url?: unknown }; video_files?: PxVideoFile[] };
const pexelsHostOk = (u: string | null): u is string => !!u && (PEXELS_FILE_HOSTS as readonly string[]).includes(new URL(u).hostname.toLowerCase());
export function pexelsPhotoCandidate(p: PxPhoto): ImageCandidate | null {
  if (typeof p.id !== 'number' && typeof p.id !== 'string') return null;
  const title = s(p.alt) || `Pexels photo ${String(p.id)}`;
  return { source: 'pexels', id: String(p.id), kind: 'image', title, creator: s(p.photographer), license: 'pexels', licence: PEXELS_LICENCE_TEXT, licenseVersion: null, licenseUrl: 'https://www.pexels.com/license/', landingUrl: httpsUrl(p.url), width: n(p.width), height: n(p.height), provider: 'pexels', thumbUrl: httpsUrl(p.src?.['medium']) ?? httpsUrl(p.src?.['small']) };
}
export function pexelsVideoCandidate(v: PxVideo): ImageCandidate | null {
  if (typeof v.id !== 'number' && typeof v.id !== 'string') return null;
  if (!pexelsVideoFile(v)) return null;
  const d = n(v.duration);
  return { source: 'pexels-video', id: String(v.id), kind: 'video', title: `Pexels video ${String(v.id)}${d ? ` (${Math.round(d)} s)` : ''}`, creator: s(v.user?.name), license: 'pexels', licence: PEXELS_LICENCE_TEXT, licenseVersion: null, licenseUrl: 'https://www.pexels.com/license/', landingUrl: httpsUrl(v.url), width: n(v.width), height: n(v.height), provider: 'pexels', thumbUrl: httpsUrl(v.image), durationS: d };
}
/** FR-302: the mp4 to import — the largest HD / SD file whose short side is ≤ 1080 px (UHD files run past 60 MB and the Engine downsizes anyway). */
export function pexelsVideoFile(v: PxVideo): { link: string; width: number | null; height: number | null; quality: string } | null {
  const files = (v.video_files ?? []).filter((f) => /mp4/i.test(String(f.file_type ?? '')) && pexelsHostOk(httpsUrl(f.link)) && ['hd', 'sd'].includes(String(f.quality ?? '').toLowerCase()))
    .map((f) => ({ link: String(f.link), width: n(f.width), height: n(f.height), quality: String(f.quality).toLowerCase() }))
    .filter((f) => Math.min(f.width ?? 0, f.height ?? 0) <= 1080);
  files.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  return files[0] ?? null;
}
const pexelsHeaders = (key: string) => ({ Authorization: key, Accept: 'application/json' });
async function pexelsJson(fetchApi: typeof fetch, key: string, url: string): Promise<Record<string, unknown>> {
  const res = await fetchApi(url, { headers: pexelsHeaders(key) });
  if (res.status === 401 || res.status === 403) { void res.body?.cancel().catch(() => undefined); throw new EmError('EM-4410', 'Pexels did not accept the API key. Check it in Settings ▸ Riset internet.', { status: 422, details: { status: res.status } }); }
  if (res.status === 429) { void res.body?.cancel().catch(() => undefined); throw new EmError('EM-4407', 'Pexels is rate limiting this key (200 requests per hour on the free plan). Try again later.', { details: { status: 429 } }); }
  if (!res.ok) { void res.body?.cancel().catch(() => undefined); throw new EmError('EM-4407', `Pexels answered HTTP ${res.status}.`, { details: { status: res.status } }); }
  return await res.json() as Record<string, unknown>;
}
/** Pexels search: up to 8 photos + 4 videos (portrait first — Reels), metadata only; the file is downloaded on import. */
export async function pexelsSearch(fetchApi: typeof fetch, key: string, query: string): Promise<ImageCandidate[]> {
  const q = encodeURIComponent(query.slice(0, 200));
  const [photos, videos] = await Promise.all([
    pexelsJson(fetchApi, key, `${PEXELS_API}/v1/search?query=${q}&per_page=12&orientation=portrait`),
    pexelsJson(fetchApi, key, `${PEXELS_API}/videos/search?query=${q}&per_page=12&orientation=portrait`).catch(() => ({} as Record<string, unknown>)),
  ]);
  const p = ((photos['photos'] as PxPhoto[] | undefined) ?? []).map(pexelsPhotoCandidate).filter((x): x is ImageCandidate => !!x).slice(0, 8);
  const v = ((videos['videos'] as PxVideo[] | undefined) ?? []).map(pexelsVideoCandidate).filter((x): x is ImageCandidate => !!x).slice(0, 4);
  return [...p, ...v];
}
/** R-089: the Pexels record again by id → candidate + the file to download (photo: large2x / original; video: pexelsVideoFile). */
export async function resolvePexels(fetchApi: typeof fetch, key: string, source: 'pexels' | 'pexels-video', id: string): Promise<{ candidate: ImageCandidate; downloadUrl: string }> {
  if (!/^\d{1,12}$/.test(id)) throw new EmError('EM-9002', 'Invalid picture id.', { status: 400, path: 'body.id' });
  if (source === 'pexels') {
    const p = await pexelsJson(fetchApi, key, `${PEXELS_API}/v1/photos/${id}`) as PxPhoto;
    const c = pexelsPhotoCandidate(p); const url = httpsUrl(p.src?.['large2x']) ?? httpsUrl(p.src?.['large']) ?? httpsUrl(p.src?.['original']);
    if (!c || !pexelsHostOk(url)) throw new EmError('EM-4407', 'The Pexels photo has no downloadable file.', { details: { source, id } });
    return { candidate: c, downloadUrl: url };
  }
  const v = await pexelsJson(fetchApi, key, `${PEXELS_API}/videos/videos/${id}`) as PxVideo;
  const c = pexelsVideoCandidate(v); const f = pexelsVideoFile(v);
  if (!c || !f) throw new EmError('EM-4407', 'The Pexels video has no HD / SD mp4 file on a Pexels host.', { details: { source, id } });
  return { candidate: { ...c, width: f.width ?? c.width, height: f.height ?? c.height }, downloadUrl: f.link };
}

// ── Pictures of a web page (FR-304): og:image / twitter:image / link[rel=image_src] + the largest <img> candidates ──
export const PAGE_IMAGES_MAX = 12;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/** Attributes of one tag (lower-cased names, entity-decoded values). */
export function tagAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<[a-zA-Z][^\s/>]*/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(ATTR_RE)) { const k = m[1]!.toLowerCase(); if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''); }
  return out;
}
const TRACKING_RE = /(^|[/._-])(pixel|1x1|spacer|blank|beacon|tracking|tracker|counter|stat|badge|icon|logo|avatar|emoji|sprite|loading|placeholder)([/._-]|$)/i;
const SKIP_EXT_RE = /\.(svg|ico|bmp|tiff?)(\?|#|$)/i;
/** The largest URL of a srcset ("a.jpg 400w, b.jpg 1200w" or "a.jpg 1x, b.jpg 2x"). */
export function largestOfSrcset(srcset: string): { url: string; width: number | null } | null {
  let best: { url: string; score: number; width: number | null } | null = null;
  for (const part of srcset.split(',')) {
    const [u, d] = part.trim().split(/\s+/); if (!u) continue;
    const m = /^(\d+(?:\.\d+)?)([wx])$/.exec(d ?? '');
    const score = m ? (m[2] === 'w' ? Number(m[1]) : Number(m[1]) * 1000) : 1;
    if (!best || score > best.score) best = { url: u, score, width: m && m[2] === 'w' ? Number(m[1]) : null };
  }
  return best ? { url: best.url, width: best.width } : null;
}
export function pageImageId(url: string): string { return `pg-${createHash('sha1').update(url).digest('hex').slice(0, 16)}`; }
/**
 * The picture candidates of one HTML page, best first: social-card images (og:image, twitter:image, link[rel=image_src]) then
 * `<img>` elements with width / height ≥ 400 (or an unsized img with a srcset), largest first, then unsized ones. data: URIs,
 * SVG, icons / tracking pixels and non-https addresses are skipped; relative addresses resolve against the page; ≤ 12.
 */
export function pageImages(html: string, pageUrl: string, max = PAGE_IMAGES_MAX): ImageCandidate[] {
  const h = html.length > HTML_MAX_CHARS ? html.slice(0, HTML_MAX_CHARS) : html;
  const base = (() => { const m = /<base\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(h.slice(0, 20_000)); try { return m ? new URL(m[1]!, pageUrl).href : pageUrl; } catch { return pageUrl; } })();
  const pageTitle = (() => { const m = /<title[^>]*>([^<]{1,300})/i.exec(h); const og = /<meta\s[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(h) ?? /<meta\s[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i.exec(h); return decodeEntities((og?.[1] ?? m?.[1] ?? '').trim()).replace(/\s+/g, ' ').slice(0, 200); })();
  const abs = (u: string): string | null => {
    const t = decodeEntities(u.trim()); if (!t || /^(data|blob|javascript):/i.test(t)) return null;
    let url: URL; try { url = new URL(t, base); } catch { return null; }
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    const href = url.href; if (href.length > 2000 || SKIP_EXT_RE.test(url.pathname)) return null;
    return href;
  };
  type Row = { url: string; title: string; width: number | null; height: number | null; rank: number };
  const rows: Row[] = []; const seen = new Set<string>();
  const push = (u: string | null, title: string, width: number | null, height: number | null, rank: number) => {
    if (!u || seen.has(u)) return; seen.add(u);
    rows.push({ url: u, title: (title || pageTitle || hostOf(pageUrl)).slice(0, 200), width, height, rank });
  };
  // 1. social-card images
  const head = h.slice(0, Math.min(h.length, 300_000));
  for (const m of head.matchAll(/<meta\s[^>]*>/gi)) {
    const a = tagAttrs(m[0]); const key = (a['property'] ?? a['name'] ?? '').toLowerCase();
    if (!/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/.test(key) || !a['content']) continue;
    push(abs(a['content']), a['alt'] ?? '', null, null, 0);
  }
  for (const m of head.matchAll(/<link\s[^>]*>/gi)) { const a = tagAttrs(m[0]); if (/\bimage_src\b/i.test(a['rel'] ?? '') && a['href']) push(abs(a['href']), '', null, null, 0); }
  // 2. <img> elements
  const imgs: Row[] = [];
  for (const m of h.matchAll(/<img\s[^>]*>/gi)) {
    const a = tagAttrs(m[0]);
    const w = a['width'] ? parseInt(a['width'], 10) : NaN, hh = a['height'] ? parseInt(a['height'], 10) : NaN;
    const sized = Number.isFinite(w) && Number.isFinite(hh);
    if (sized && (Math.max(w, hh) < 400 || Math.min(w, hh) < 200)) continue;        // icons, thumbnails, pixels
    if ((Number.isFinite(w) && w <= 2) || (Number.isFinite(hh) && hh <= 2)) continue;  // 1×1 pixels with one attribute
    const set = a['srcset'] ?? a['data-srcset'];
    const best = set ? largestOfSrcset(set) : null;
    const raw = best?.url ?? a['src'] ?? a['data-src'] ?? a['data-lazy-src'] ?? a['data-original'];
    if (!raw) continue;
    const u = abs(raw); if (!u) continue;
    if (TRACKING_RE.test(new URL(u).pathname) && !sized) continue;
    const width = sized ? w : best?.width ?? null, height = sized ? hh : null;
    if (seen.has(u)) continue;
    imgs.push({ url: u, title: (a['alt'] ?? a['title'] ?? '').trim().slice(0, 200), width, height, rank: sized ? 1 : best ? 1.5 : 2 });   // sized (area) → srcset-only (width) → unsized
  }
  imgs.sort((x, y) => x.rank - y.rank || (y.width ?? 0) * (y.height ?? y.width ?? 1) - (x.width ?? 0) * (x.height ?? x.width ?? 1));
  for (const r of imgs) push(r.url, r.title, r.width, r.height, r.rank);
  const host = hostOf(pageUrl);
  return rows.slice(0, max).map((r) => ({ source: 'page' as const, id: pageImageId(r.url), kind: 'image' as const, title: r.title, creator: host, license: 'owner' as const, licence: OWNER_LICENCE_TEXT, licenseVersion: null, licenseUrl: null, landingUrl: pageUrl, width: r.width, height: r.height, provider: host, thumbUrl: r.url, url: r.url }));
}
/** FR-304: the pictures of one page through the research fetch (same bounds as web.fetch; EM-4411 when none is usable). */
export async function pageImageCandidates(fetchFn: typeof fetch, raw: string): Promise<{ url: string; title: string; candidates: ImageCandidate[] }> {
  const p = await fetchRaw(fetchFn, raw);
  if (p.pdf || !(p.type.includes('html') || /<html|<body|<img|<meta/i.test(p.text.slice(0, 4000)))) throw new EmError('EM-4411', 'This address is not a web page with pictures.', { details: { url: p.url, type: p.type } });
  const candidates = pageImages(p.text, p.url);
  if (!candidates.length) throw new EmError('EM-4411', 'No usable picture was found on the page (it may load its pictures with JavaScript — try web.screenshot).', { details: { url: p.url } });
  return { url: p.url, title: htmlToText(p.text.slice(0, 20_000)).title, candidates };
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
/** R-089 for a `page` candidate: the stored candidate's own address, re-validated (public https, no credentials) — never a URL from the request body. */
export function resolvePageImage(stored: ImageCandidate): { candidate: ImageCandidate; downloadUrl: string } {
  const url = stored.url ?? '';
  const why = researchUrlProblem(url);
  if (!url || why || pageImageId(url) !== stored.id) throw new EmError('EM-4407', `The picture address cannot be used${why ? ` (${why})` : ''}.`, { details: { source: 'page', id: stored.id } });
  return { candidate: stored, downloadUrl: url };
}

export type ScreenshotViewport = 'phone' | 'desktop';
export interface ScreenshotOutcome { assetId: string; title: string; host: string; width: number; height: number }
/**
 * The web.* handlers of one run. `allowedUrls`: the URLs in the Creator's messages; URLs research returns during the run are added.
 * `search` is absent in native mode (the provider searches itself). `pexelsKey` (FR-301): the Creator's key, read at call time.
 * `screenshot` (FR-305): takes and imports the PNG (agents module), only for URLs the same rule as web.fetch admits.
 */
export function researchHandlers(o: { cfg: ResearchConfig; fetchPage: typeof fetch; fetchApi: typeof fetch; allowedUrls: () => string[];
  search?: (query: string) => Promise<SearchResult>; onImages?: (c: ImageCandidate[]) => void; pexelsKey?: () => string | null;
  screenshot?: (url: string, viewport: ScreenshotViewport) => Promise<ScreenshotOutcome> }): ToolHandlers {
  if (!o.cfg.available) return {};
  const seen = new Set<string>();
  const allowed = (u: string) => { const k = u.replace(/^http:/i, 'https:').replace(/\/$/, ''); return [...o.allowedUrls(), ...seen].some((x) => x.replace(/^http:/i, 'https:').replace(/\/$/, '') === k); };
  const NOT_ALLOWED = { error: { code: 'EM-4406', message: 'Only pages whose URL the Creator wrote in the chat or a web.search returned can be read. Ask the Creator for the link, or search first.' } };
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
      if (!allowed(url)) return NOT_ALLOWED;
      const p = await fetchPage(o.fetchPage, url);
      return { url: p.url, title: p.title, text: p.text, truncated: p.truncated };
    };
  }
  const forModel = (x: ImageCandidate) => ({ source: x.source, id: x.id, kind: x.kind ?? 'image', title: x.title, author: x.creator, licence: licenceText(x), width: x.width, height: x.height, ...(x.durationS ? { durationS: Math.round(x.durationS) } : {}), ...(x.source === 'page' && x.landingUrl ? { pageUrl: x.landingUrl } : {}) });
  const NOTE = 'The Creator sees these as cards and decides which to import into the Library. Describe them briefly; do not paste links.';
  if (o.cfg.images) h['web.images'] = async (i) => {
    const source = i['source'] === 'stock' || i['source'] === 'page' ? i['source'] : 'open';
    let c: ImageCandidate[];
    if (source === 'stock') {
      const key = o.pexelsKey?.() ?? null;
      if (!key) return { error: { code: 'EM-4410', message: 'Stock photos / videos need the Creator\'s own Pexels API key (Settings ▸ Riset internet ▸ Kunci API Pexels). Use source "open" (Openverse / Wikimedia) or "page" meanwhile.' } };
      c = (await pexelsSearch(o.fetchApi, key, String(i['query'] ?? ''))).slice(0, PAGE_IMAGES_MAX);
    } else if (source === 'page') {
      const url = String(i['url'] ?? '').trim();
      if (!url) return { error: { code: 'EM-4503', message: 'source "page" needs the page `url`.' } };
      if (!allowed(url)) return NOT_ALLOWED;
      const p = await pageImageCandidates(o.fetchPage, url);
      c = p.candidates;
    } else c = (await searchImages(o.fetchApi, String(i['query'] ?? ''))).slice(0, 8);
    o.onImages?.(c);
    return { source, candidates: c.map(forModel), note: source === 'page' ? `${NOTE} Page pictures are the owner's copyright: usable as quotation / commentary with the source named; the card says so.` : NOTE };
  };
  // `web.screenshot` is declared in packages/agents tools.ts by the composer agent (same name); until it lands the registry refuses the call (EM-4501) and this handler is simply never reached.
  if (o.screenshot && (o.cfg.images || o.cfg.mode === 'tools')) (h as Record<string, (input: Record<string, unknown>) => unknown>)['web.screenshot'] = async (i) => {
    const url = String(i['url'] ?? '').trim();
    if (!url) return { error: { code: 'EM-4503', message: 'web.screenshot needs the page `url`.' } };
    if (!allowed(url)) return NOT_ALLOWED;
    const viewport: ScreenshotViewport = i['viewport'] === 'desktop' ? 'desktop' : 'phone';
    try { const r = await o.screenshot!(url, viewport); return { ...r, licence: SCREENSHOT_LICENCE_TEXT, note: 'The screenshot is in the Library as an image asset (credit = the URL). It is the page owner\'s copyright: use it as a quotation / commentary and name the source.' }; }
    catch (e) { return { error: { code: e instanceof EmError ? e.code : 'EM-4409', message: errorMessage(e).slice(0, 300) } }; }
  };
  return h;
}

/** The URLs the Creator wrote in this conversation (web.fetch may read only these and what research returned). */
export const creatorUrls = (texts: readonly string[]): string[] => urlsIn(texts.join('\n'));
