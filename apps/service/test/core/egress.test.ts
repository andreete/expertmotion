// SEC-080…084, FR-158: per-purpose allow-lists, custom provider host, manual redirects re-checked per hop, bounded bodies.
import { describe, expect, it } from 'vitest';
import { createEgress, customBaseUrlProblem, PROVIDER_MAX_BODY_BYTES } from '../../src/services/egress.js';

type Call = { url: string; redirect: string | undefined };
function fake(responder: (url: string) => Response) {
  const calls: Call[] = [];
  const impl = (async (u: string | URL | Request, init?: RequestInit) => { const url = String(u); calls.push({ url, redirect: init?.redirect }); return responder(url); }) as typeof fetch;
  return { calls, impl };
}

describe('egress purposes (SEC-080, SEC-082)', () => {
  it('provider and model-download lists are separate', async () => {
    const f = fake(() => new Response('ok'));
    const e = createEgress({ isPrivate: () => false, impl: f.impl });
    await expect(e.for('model-download')('https://openrouter.ai/api/v1/models')).rejects.toMatchObject({ code: 'EM-8203' });
    await expect(e.for('provider')('https://huggingface.co/x')).rejects.toMatchObject({ code: 'EM-8203' });
    await expect(e.for('licence')('https://openrouter.ai/x')).rejects.toMatchObject({ code: 'EM-8203' });
    await expect(e.for('update')('https://huggingface.co/x')).rejects.toMatchObject({ code: 'EM-8203' });
    expect((await e.for('model-download')('https://huggingface.co/x')).ok).toBe(true);
    expect((await e.fetch('https://api.anthropic.com/v1/models')).ok).toBe(true);
    expect(f.calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it('a saved custom base URL host joins the provider list only; IP literals and localhost never do', async () => {
    const f = fake(() => new Response('ok'));
    const e = createEgress({ isPrivate: () => false, impl: f.impl, customProviderHosts: () => ['llm.example.com', '127.0.0.1', 'localhost'] });
    expect((await e.fetch('https://llm.example.com/v1/chat/completions', { method: 'POST', body: '{}' })).ok).toBe(true);
    await expect(e.for('model-download')('https://llm.example.com/x')).rejects.toMatchObject({ code: 'EM-8203' });
    await expect(e.fetch('https://127.0.0.1/v1')).rejects.toMatchObject({ code: 'EM-8203' });
    await expect(e.fetch('https://localhost/v1')).rejects.toMatchObject({ code: 'EM-8203' });
  });

  it('customBaseUrlProblem refuses http, IP literals, localhost and credentials', () => {
    expect(customBaseUrlProblem('https://llm.example.com/api/v1')).toBeNull();
    for (const bad of ['http://llm.example.com', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://localhost:8080', 'https://box.local', 'https://user:pw@llm.example.com', 'https://intranet', 'nonsense'])
      expect(customBaseUrlProblem(bad), bad).not.toBeNull();
  });

  it('Private Mode refuses before any call', async () => {
    const f = fake(() => new Response('ok'));
    const e = createEgress({ isPrivate: () => true, impl: f.impl });
    await expect(e.for('model-download')('https://huggingface.co/x')).rejects.toMatchObject({ code: 'EM-8202' });
    await expect(e.fetch('https://openrouter.ai/x')).rejects.toMatchObject({ code: 'EM-8202' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('provider redirects (SEC-082)', () => {
  it('re-checks every hop and refuses a hop off the allow-list', async () => {
    const f = fake((u) => (u.includes('/start') ? new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }) : new Response('ok')));
    const e = createEgress({ isPrivate: () => false, impl: f.impl });
    await expect(e.fetch('https://openrouter.ai/start')).rejects.toMatchObject({ code: 'EM-8203' });
    expect(f.calls.map((c) => c.url)).toEqual(['https://openrouter.ai/start']);
  });
  it('follows an allowed hop and stops after 3', async () => {
    const ok = fake((u) => (u.endsWith('/a') ? new Response(null, { status: 307, headers: { location: '/b' } }) : new Response('done')));
    expect(await (await createEgress({ isPrivate: () => false, impl: ok.impl }).fetch('https://openrouter.ai/a')).text()).toBe('done');
    const loop = fake(() => new Response(null, { status: 302, headers: { location: 'https://openrouter.ai/again' } }));
    await expect(createEgress({ isPrivate: () => false, impl: loop.impl }).fetch('https://openrouter.ai/x')).rejects.toMatchObject({ code: 'EM-8203' });
    expect(loop.calls.length).toBe(4);
  });
});

describe('provider body bounds (SEC-084)', () => {
  const chunked = (total: number, chunk = 256 * 1024, type = 'application/json') => () => {
    let sent = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (sent >= total) { c.close(); return; } const n = Math.min(chunk, total - sent); sent += n; c.enqueue(new Uint8Array(n).fill(97)); } }), { headers: { 'content-type': type } });
  };
  it('aborts a body over 4 MB while streaming (EM-4103)', async () => {
    const e = createEgress({ isPrivate: () => false, impl: fake(chunked(PROVIDER_MAX_BODY_BYTES + 1)).impl });
    const res = await e.fetch('https://openrouter.ai/api/v1/chat/completions');
    await expect(res.text()).rejects.toMatchObject({ code: 'EM-4103' });
  });
  it('model lists may be up to 8 MB; a declared oversize body is refused up front', async () => {
    const e = createEgress({ isPrivate: () => false, impl: fake(chunked(6 * 1024 * 1024)).impl });
    expect((await (await e.for('provider-models')('https://openrouter.ai/api/v1/models')).text()).length).toBe(6 * 1024 * 1024);
    const big = createEgress({ isPrivate: () => false, impl: fake(() => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } })).impl });
    await expect(big.for('provider-models')('https://openrouter.ai/api/v1/models')).rejects.toMatchObject({ code: 'EM-4103' });
  });
  it('a single stream line over 64 KB aborts the stream', async () => {
    const e = createEgress({ isPrivate: () => false, impl: fake(chunked(70 * 1024, 8 * 1024, 'text/event-stream')).impl });
    await expect((await e.fetch('https://openrouter.ai/api/v1/chat/completions')).text()).rejects.toMatchObject({ code: 'EM-4103' });
    const fine = createEgress({ isPrivate: () => false, impl: fake(() => new Response('data: {"a":1}\n\n'.repeat(5000), { headers: { 'content-type': 'text/event-stream' } })).impl });
    expect((await (await fine.fetch('https://openrouter.ai/x')).text()).length).toBeGreaterThan(64 * 1024);
  });
});
