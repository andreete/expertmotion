// SEC-016 (round 2, QA 2026-10-29: the Service Token was in /events?token=… and therefore in console logs). The Editor reads SSE
// with FetchEventSource: Bearer header, no token in any URL, reconnect with Last-Event-ID, and no console line carries the token.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchEventSource } from '../src/api/sse-fetch.js';
import { createEventStream } from '../src/api/events.js';
import { ApiClient } from '../src/api/client.js';

const TOKEN = 'tok-SECRET-0123456789abcdef';
const enc = new TextEncoder();
function streamOf(chunks: string[], keepOpen = false): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); if (!keepOpen) c.close(); } });
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

afterEach(() => { vi.restoreAllMocks(); });

describe('FetchEventSource', () => {
  it('sends the token as a Bearer header, parses events (CRLF, comments, multi-line data) and never puts the token in the URL', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, body: streamOf(['retry: 2000\n\n: ping\n\n', 'id: 4\r\nevent: project.changed\r\ndata: {"seq":4,', '"a":1}\r\n\r\n', 'id: 5\nevent: x.y\ndata: one\ndata: two\n\n'], true) };
    });
    const src = new FetchEventSource('http://127.0.0.1:4110/api/v1/events?projectId=P', { token: () => TOKEN, fetch });
    const got: Array<[string, string, string | undefined]> = [];
    src.addEventListener('project.changed', (e) => got.push(['project.changed', e.data, e.lastEventId]));
    src.addEventListener('x.y', (e) => got.push(['x.y', e.data, e.lastEventId]));
    let opened = 0; src.onopen = () => { opened++; };
    await tick(20);
    expect(opened).toBe(1);
    expect(got).toEqual([['project.changed', '{"seq":4,"a":1}', '4'], ['x.y', 'one\ntwo', '5']]);
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.url).not.toMatch(/token=/);
    expect(calls[0]!.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    src.close();
  });

  it('reconnects after `retry` ms with Last-Event-ID and the CURRENT token (rotation after a Service restart)', async () => {
    let token = TOKEN; const calls: Array<Record<string, string>> = [];
    let n = 0;
    const fetch = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers); n++;
      if (n === 1) return { ok: true, status: 200, body: streamOf(['retry: 10\nid: 7\nevent: a\ndata: {"seq":7}\n\n']) };   // stream ends → reconnect
      if (n === 2) return { ok: false, status: 401, body: null };                                                           // HTTP error → reconnect
      return { ok: true, status: 200, body: streamOf([], true) };
    });
    const src = new FetchEventSource('http://x/api/v1/events', { token: () => token, fetch });
    let errors = 0; src.onerror = () => { errors++; token = 'tok-ROTATED-9876543210'; };
    await tick(80);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(errors).toBe(2);
    expect(calls[1]!['Last-Event-ID']).toBe('7');
    expect(calls[2]!['Authorization']).toBe('Bearer tok-ROTATED-9876543210');
    src.close();
    const before = n; await tick(40); expect(n).toBe(before);                 // closed: no more reconnects
  });

  it('createEventStream + ApiClient: the events URL has no token, the stream uses the header, and no console line contains the token', async () => {
    const lines: string[] = [];
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const api = new ApiClient({ baseUrl: 'http://127.0.0.1:4110', token: TOKEN, fetch: async () => new Response('{}') });
    const urls: string[] = []; const auths: string[] = [];
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => { urls.push(url); auths.push(init.headers['Authorization']!); throw new TypeError(`Failed to fetch ${url}`); });
    const stream = createEventStream({ url: api.eventsUrl({ projectId: 'P' }), createSource: (u) => new FetchEventSource(u, { token: () => api.serviceToken, fetch, retryMs: 5 }), onEvent: () => undefined, healthCheck: async () => null });
    await tick(40);
    stream.close();
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toBe('http://127.0.0.1:4110/api/v1/events?projectId=P');
    expect(auths.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    expect(api.renderEventsUrl('J')).not.toContain(TOKEN);
    expect(lines.filter((l) => l.includes(TOKEN))).toEqual([]);
  });

  it('createEventStream picks FetchEventSource by default when given a token', async () => {
    const g = globalThis as unknown as { fetch: unknown };
    const orig = g.fetch; const seen: Array<{ url: string; auth: string }> = [];
    g.fetch = async (url: string, init: { headers: Record<string, string> }) => { seen.push({ url, auth: init.headers['Authorization']! }); return { ok: true, status: 200, body: streamOf([], true) }; };
    try {
      const s = createEventStream({ url: 'http://127.0.0.1:4110/api/v1/events', token: () => TOKEN, onEvent: () => undefined });
      await tick(10); s.close();
      expect(seen[0]).toEqual({ url: 'http://127.0.0.1:4110/api/v1/events', auth: `Bearer ${TOKEN}` });
    } finally { g.fetch = orig; }
  });
});
