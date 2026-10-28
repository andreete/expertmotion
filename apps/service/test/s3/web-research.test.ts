// FR-216 … FR-218 internet research (QA 2026-10-28 #1: "Agent discussion belum bisa melakukan research, mengambil gambar, dan
// sumber dari internet"; Claude answered that it cannot connect). Anthropic web_search / web_fetch server tools (citations,
// pause_turn, account / model refusals), the other providers' search on the same connection, web.fetch through the egress
// module (public https only, private addresses refused), openly licensed pictures. The provider stub (poc/e2e/provider-stub.mjs)
// mirrors the Messages API shapes of platform.claude.com/docs (web search / web fetch tool, checked 2026-10-28).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapProviderError, researchPromptBlock, runBrainstorm, fakeProvider, type ChatActivity, type ChatRequest } from '@expertmotion/agents';
import { anthropicWebTools, chatProviderFor, initialWebLevel, webOffNotice } from '../../src/s3/adapters.js';
import { createEgress, isPrivateAddress, researchUrlProblem } from '../../src/services/egress.js';
import { fetchPage, htmlToText, providerSearch, researchConfigFor, researchHandlers, resolveImage, searchImages, attributionText } from '../../src/s3/research.js';
import { stubUrl } from '../../src/s3/dev-provider-stub.js';
// @ts-expect-error -- plain ESM helper of the end-to-end suite (no types)
import { startProviderStub } from '../../../../poc/e2e/provider-stub.mjs';

const PORT = 4171;
let stub: { origin: string; calls: Array<Record<string, unknown>>; close: () => Promise<void>; configure: (p: string, c: Record<string, unknown>) => void };
const viaStub: typeof fetch = (input, init) => globalThis.fetch(stubUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, stub.origin), init);
beforeAll(async () => { stub = await startProviderStub(PORT); });
afterAll(async () => { await stub.close(); });
const lastCalls = (n: number) => stub.calls.slice(-n);
const req = (text: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({ system: 'You are the Brainstorming Agent', messages: [{ role: 'user', content: text }], maxTokens: 4000, temperature: 0.4,
  webResearch: { search: true, fetch: true, maxSearches: 5, maxFetches: 3 }, ...extra });

describe('Anthropic web search server tool (FR-216)', () => {
  it('sends web_search_20260209 / web_fetch_20260209 (direct callers) for Claude 4.6+ and the basic versions for older models', () => {
    expect(initialWebLevel('claude-sonnet-5-5')).toBe('v2');
    expect(initialWebLevel('claude-opus-4-6')).toBe('v2');
    expect(initialWebLevel('claude-sonnet-4-5-20250929')).toBe('v1');
    expect(initialWebLevel('claude-haiku-4-5')).toBe('v1');
    expect(anthropicWebTools('v2', { search: true, fetch: true, maxSearches: 4 })).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 4, allowed_callers: ['direct'] },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3, allowed_callers: ['direct'], citations: { enabled: true }, max_content_tokens: 20_000 }]);
    expect(anthropicWebTools('v1', { search: true, fetch: false })).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
  });

  it('streams a search: the query reaches progress, citations and results come back as sources, text has no tool markup', async () => {
    stub.configure('anthropic', {});
    const p = chatProviderFor('anthropic', 'sk-ant-good', 'claude-sonnet-5-5', viaStub);
    expect(p.nativeWebResearch).toBe(true);
    const acts: ChatActivity[] = []; let shown = '';
    const r = await p.stream!(req('tolong riset data terbaru ekspor nikel', { onActivity: (a) => acts.push(a) }), (d) => { shown += d; });
    const call = lastCalls(1)[0]!;
    expect(call['webTools']).toEqual(['web_search_20260209', 'web_fetch_20260209']);
    expect(call['problem']).toBeNull();
    expect(acts).toContainEqual({ type: 'web', kind: 'search', query: 'ekspor nikel Indonesia Januari Agustus 2026 ESDM' });
    expect(r.webQueries).toEqual(['ekspor nikel Indonesia Januari Agustus 2026 ESDM']);
    expect(r.citations?.[0]).toMatchObject({ url: 'https://www.antaranews.com/berita/ekspor-nikel-25-96-miliar', cited: true });
    expect(r.citations?.[0]?.citedText).toContain('25,96');
    expect(r.citations?.some((c) => c.url.includes('esdm.go.id'))).toBe(true);
    expect(r.text).toContain('US$25,96 miliar');
    expect(shown).toContain('17,2%');
    expect(r.webNotice).toBeUndefined();
  });

  it('continues a pause_turn by sending the paused content back unchanged (one answer, two requests)', async () => {
    stub.configure('anthropic', { pauseOnce: true });
    const p = chatProviderFor('anthropic', 'sk-ant-good', 'claude-sonnet-5-5', viaStub);
    const before = stub.calls.length;
    const r = await p.complete(req('riset sumber terbaru nikel'));
    const calls = stub.calls.slice(before);
    expect(calls.map((c) => c['stop'])).toEqual(['pause_turn', 'end_turn']);
    expect(calls.every((c) => c['problem'] === null)).toBe(true);                         // encrypted_content replayed unchanged
    expect(r.text).toContain('Saya cari data terbarunya dulu.');
    expect(r.text).toContain('US$25,96 miliar');
    expect(r.citations?.[0]?.cited).toBe(true);
  });

  it('an account with web search turned off: EM-4403 notice, the answer comes without web tools and the model is told why', async () => {
    stub.configure('anthropic', { web: 'disabled' });
    const p = chatProviderFor('anthropic', 'sk-ant-good', 'claude-opus-5', viaStub);
    const before = stub.calls.length;
    const r = await p.complete(req('riset internet dong'));
    const calls = stub.calls.slice(before);
    expect(calls).toHaveLength(2);
    expect(calls[1]!['webTools']).toEqual([]);
    expect(r.webNotice?.code).toBe('EM-4403');
    expect(webOffNotice('anthropic', 'claude-opus-5')?.code).toBe('EM-4403');
    expect(researchConfigFor({ privateMode: false, setting: true, provider: 'anthropic', nativeOff: webOffNotice('anthropic', 'claude-opus-5') })).toMatchObject({ available: false, reason: 'org-disabled' });
    stub.configure('anthropic', {});
  });

  it('a model without the dynamic-filtering versions steps down to web_search_20250305', async () => {
    stub.configure('anthropic', { web: 'v1only' });
    const p = chatProviderFor('anthropic', 'sk-ant-good', 'claude-opus-4-8', viaStub);
    const before = stub.calls.length;
    const r = await p.complete(req('riset terbaru'));
    const calls = stub.calls.slice(before);
    expect(calls.map((c) => c['webTools'])).toEqual([['web_search_20260209', 'web_fetch_20260209'], ['web_search_20250305', 'web_fetch_20250910']]);
    expect(r.webQueries?.length).toBe(1);
    stub.configure('anthropic', {});
  });
});

describe('provider refusals are not "key not accepted" (QA 2026-10-28, EM-4002)', () => {
  const err = (status: number, message: string) => Object.assign(new Error(`provider HTTP ${status}: ${JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'permission_error', message } })}`), { statusCode: status });
  it('401 invalid x-api-key → EM-4002 with the reason; 403 about a feature → EM-4105; 403 about the key → EM-4002', () => {
    expect(mapProviderError(err(401, 'invalid x-api-key'))).toMatchObject({ code: 'EM-4002', details: { status: 401, reason: 'invalid x-api-key' } });
    expect(mapProviderError(err(403, 'Web search is not enabled for this organization'))).toMatchObject({ code: 'EM-4105', details: { status: 403 } });
    expect(mapProviderError(err(403, 'Your API key does not have permission to use the specified resource.'))).toMatchObject({ code: 'EM-4002' });
  });
});

describe('search on the same connection for OpenAI / Gemini / OpenRouter (web.search)', () => {
  it.each([['openai', 'gpt-6'], ['google', 'gemini-3.5-flash'], ['openrouter', 'anthropic/model-0']] as const)('%s returns a summary and its source links', async (p, model) => {
    const r = await providerSearch(p, 'sk-good', model, viaStub, 'ekspor nikel 2026');
    expect(r.summary).toMatch(/nikel/i);
    expect(r.sources[0]?.url).toMatch(/^https:\/\/www\.(esdm|antaranews)/);
  });
});

describe('web.fetch through the egress module (SEC-140 / SEC-141)', () => {
  const egress = (addr = '93.184.216.34') => createEgress({ isPrivate: () => false, impl: viaStub, lookup: async () => [addr] });
  it('reads a public page as text: scripts and navigation dropped, entities decoded, title kept, http upgraded to https', async () => {
    const p = await fetchPage(egress().for('research'), 'http://news.stub-research.test/nikel');
    expect(p.title).toBe('Ekspor Nikel 2026 — Stub News');
    expect(p.text).toContain('Januari–Agustus 2026 mencapai US$25,96 miliar');
    expect(p.text).not.toMatch(/alert|menu/);
    expect(p.url.startsWith('https://')).toBe(true);
  });
  it('refuses private addresses, IP literals, localhost and non-https ports before any request', async () => {
    await expect(fetchPage(egress('10.0.0.5').for('research'), 'https://news.stub-research.test/x')).rejects.toMatchObject({ code: 'EM-8203' });
    for (const u of ['https://127.0.0.1/', 'https://localhost/a', 'https://router.local/', 'https://example.com:8443/']) expect(researchUrlProblem(u)).not.toBeNull();
    expect(['10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1'].every(isPrivateAddress)).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });
  it('Private Mode blocks research before any lookup', async () => {
    const e = createEgress({ isPrivate: () => true, impl: viaStub, lookup: async () => { throw new Error('no lookup expected'); } });
    await expect(fetchPage(e.for('research'), 'https://news.stub-research.test/x')).rejects.toMatchObject({ code: 'EM-8202' });
  });
  it('the handler reads only URLs the Creator wrote or research returned (EM-4406), and search results unlock their URLs', async () => {
    const h = researchHandlers({ cfg: { available: true, mode: 'tools', images: true }, fetchPage: egress().for('research'), fetchApi: egress().for('research-api'), allowedUrls: () => ['https://news.stub-research.test/nikel'],
      search: async () => ({ summary: 's', sources: [{ url: 'https://news.stub-research.test/other', title: 'Other' }] }) });
    expect(await h['web.fetch']!({ url: 'https://news.stub-research.test/secret' })).toMatchObject({ error: { code: 'EM-4406' } });
    expect(await h['web.fetch']!({ url: 'https://news.stub-research.test/nikel' })).toMatchObject({ title: 'Ekspor Nikel 2026 — Stub News' });
    await h['web.search']!({ query: 'nikel' });
    expect(await h['web.fetch']!({ url: 'https://news.stub-research.test/other' })).toMatchObject({ url: 'https://news.stub-research.test/other' });
  });
  it('htmlToText keeps paragraphs and list items', () => {
    expect(htmlToText('<title>T &amp; U</title><p>a</p><ul><li>b</li></ul>')).toEqual({ title: 'T & U', text: 'a\n\n• b' });
  });
});

describe('openly licensed pictures (FR-217)', () => {
  const api = createEgress({ isPrivate: () => false, impl: viaStub }).for('research-api');
  it('lists only CC0 / PDM / CC BY / CC BY-SA candidates and re-resolves an import by id', async () => {
    const c = await searchImages(api, 'nickel');
    expect(c.map((x) => x.license)).toEqual(['by']);                                    // the by-nc result is dropped
    const r = await resolveImage(api, 'openverse', c[0]!.id);
    expect(r.downloadUrl).toBe('https://upload.wikimedia.org/stub/nickel.png');
    expect(attributionText(r.candidate)).toBe('"Nickel ore" by Stub Photographer, CC BY 4.0, via Openverse');
    await expect(resolveImage(api, 'openverse', 'not-an-id')).rejects.toMatchObject({ code: 'EM-9002' });
  });
});

describe('research availability and the prompt block (the model never says it cannot browse)', () => {
  it('config per setting / Private Mode / provider', () => {
    expect(researchConfigFor({ privateMode: true, setting: true, provider: 'anthropic' })).toMatchObject({ available: false, reason: 'private' });
    expect(researchConfigFor({ privateMode: false, setting: false, provider: 'anthropic' })).toMatchObject({ available: false, reason: 'setting' });
    expect(researchConfigFor({ privateMode: false, setting: true, provider: 'anthropic' })).toMatchObject({ available: true, mode: 'native' });
    expect(researchConfigFor({ privateMode: false, setting: true, provider: 'openai' })).toMatchObject({ available: true, mode: 'tools' });
  });
  it('available → "You CAN research"; unavailable → the exact reason and how to change it', () => {
    expect(researchPromptBlock({ available: true, mode: 'native', images: true }, 'brainstorm')).toMatch(/You CAN research the internet[\s\S]*Never say that you cannot access the internet/);
    expect(researchPromptBlock({ available: false, reason: 'setting' }, 'brainstorm')).toMatch(/NOT available[\s\S]*Izinkan riset internet[\s\S]*Never pretend you searched/);
    expect(researchPromptBlock({ available: true, mode: 'tools', images: false }, 'editor')).toMatch(/EditPlan JSON only/);
  });
  it('a Brainstorm turn carries the provider citations as sources and passes webResearch only to native providers', async () => {
    const p = fakeProvider([{ text: 'Ekspor naik 17,2%.', citations: [{ url: 'https://www.esdm.go.id/a', title: 'ESDM', cited: true }], webQueries: ['nikel 2026'] }], 'fake', { nativeWebResearch: true });
    const r = await runBrainstorm([{ role: 'user', content: 'riset nikel' }], {}, 'id', p, { research: { available: true, mode: 'native', images: false } });
    expect(r.ok && r.sources).toEqual([{ url: 'https://www.esdm.go.id/a', title: 'ESDM', cited: true }]);
    expect(r.ok && r.webQueries).toEqual(['nikel 2026']);
    expect(p.calls[0]!.webResearch).toMatchObject({ search: true, fetch: true });
    expect(p.calls[0]!.system).toMatch(/You CAN research the internet/);
  });
});
