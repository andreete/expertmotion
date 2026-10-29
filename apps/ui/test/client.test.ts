import { describe, expect, it, vi } from 'vitest';
import { EmError } from '@expertmotion/shared';
import { ApiClient, resolveBootstrap } from '../src/api/client.js';
import type { MediaGrantDto } from '../src/api/types.js';

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => handler(url, init));
  const call = (i: number): [string, RequestInit] => { const c = fetch.mock.calls[i]!; return [c[0], c[1] ?? {}]; };
  return { api: new ApiClient({ baseUrl: 'http://127.0.0.1:4110/', token: 'tok-123456', fetch }), fetch, call };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('ApiClient', () => {
  it('sends the Bearer token and builds /api/v1 URLs with query strings', async () => {
    const { api, call } = client(() => json(200, { items: [], nextCursor: null }));
    await api.listProjects({ limit: 5 });
    const [url, init] = call(0);
    expect(url).toBe('http://127.0.0.1:4110/api/v1/projects?limit=5');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-123456');
    expect(init.method).toBe('GET');
  });

  it('serialises JSON bodies for POST/PUT/PATCH', async () => {
    const { api, call } = client(() => json(201, { intent: {}, queue: {}, superseded: [], appliedVersion: null, planId: null, notices: [] }));
    await api.createIntent('P1', { source: 'ui', category: 'transition', presetId: 'preset:transition.fade', target: { kind: 'selection' }, baseVersion: 'abc' });
    const [url, init] = call(0);
    expect(url).toBe('http://127.0.0.1:4110/api/v1/projects/P1/intents');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toContain('application/json');
    expect(JSON.parse(String(init.body))).toMatchObject({ presetId: 'preset:transition.fade', baseVersion: 'abc' });
  });

  it('throws EmError with code, status and details from the error envelope', async () => {
    const { api } = client(() => json(409, { error: { code: 'EM-2301', message: 'changed', details: { baseVersion: 'a' }, path: 'body.baseVersion' } }));
    const err = await api.executePlan('PL').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmError);
    expect(err).toMatchObject({ code: 'EM-2301', status: 409, details: { baseVersion: 'a' }, path: 'body.baseVersion' });
  });

  it('maps a non-envelope 401 to EM-8004 and a network failure to EM-8001', async () => {
    const a = client(() => new Response('nope', { status: 401 }));
    await expect(a.api.getSettings()).rejects.toMatchObject({ code: 'EM-8004', status: 401 });
    const b = client(() => { throw new TypeError('connection refused'); });
    await expect(b.api.getSettings()).rejects.toMatchObject({ code: 'EM-8001' });
  });

  it('returns undefined for 204 and sends Idempotency-Key on execute and renders', async () => {
    const { api, call } = client((url) => (url.includes('/media-grants/') ? new Response(null, { status: 204 }) : json(200, { planId: 'PL', ok: true, fromVersion: 'a', appliedOps: 1, diff: [], durationMs: 1 })));
    await expect(api.revokeMediaGrant('g')).resolves.toBeUndefined();
    await api.executePlan('PL', { idempotencyKey: 'k-1' });
    const init = call(1)[1];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('k-1');
    expect(JSON.parse(String(init.body))).toEqual({ confirmDestructive: false });
    await api.createRender({ projectId: 'P', outputProfile: { ratio: '9:16', resolution: '1080p', fps: 30, format: 'mp4' }, performanceProfile: 'standard' });
    expect((call(2)[1].headers as Record<string, string>)['Idempotency-Key']).toMatch(/^export-P-/);
  });

  it('marks Shell-only routes with the caller header', async () => {
    const { api, call } = client(() => json(202, { items: [], notices: [] }));
    await api.importAssetPaths('P', ['C:\\a.mp4']);
    expect((call(0)[1].headers as Record<string, string>)['X-Expertmotion-Caller']).toBe('shell');
  });

  it('builds media and SSE URLs (grant in the path; SSE URLs never carry the token, SEC-016)', () => {
    const { api } = client(() => json(200, {}));
    const grant: MediaGrantDto = { grant: 'G'.repeat(43), projectId: 'P', kind: 'preview', expiresAt: '', baseUrl: 'http://127.0.0.1:4110/media/' + 'G'.repeat(43) };
    expect(api.mediaUrl(grant, 'A1', 'proxy')).toBe(`http://127.0.0.1:4110/media/${'G'.repeat(43)}/A1/proxy`);
    expect(api.outputMediaUrl(grant, 'O1', 'file')).toBe(`http://127.0.0.1:4110/media/${'G'.repeat(43)}/outputs/O1/file`);
    expect(api.eventsUrl({ projectId: 'P', hardware: true })).toBe('http://127.0.0.1:4110/api/v1/events?projectId=P&hardware=1');
    expect(api.eventsUrl()).toBe('http://127.0.0.1:4110/api/v1/events');
    expect(api.renderEventsUrl('J')).toBe('http://127.0.0.1:4110/api/v1/renders/J/events');
  });

  it('resolves the bootstrap from VITE_EM_API / VITE_EM_TOKEN in development', async () => {
    await expect(resolveBootstrap({ VITE_EM_API: 'http://127.0.0.1:4110/api/v1', VITE_EM_TOKEN: 'devtoken-123' })).resolves.toEqual({ baseUrl: 'http://127.0.0.1:4110', token: 'devtoken-123' });
    await expect(resolveBootstrap({})).resolves.toBeNull();
  });
});
