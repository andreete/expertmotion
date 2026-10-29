// @vitest-environment jsdom
// FR-171: after a Local Service restart the Desktop Shell pushes a new port + token (onServiceState). The Editor re-points the
// ApiClient, reconnects SSE with the new token, refetches project/head, shows sys.offline while down, and EM-8002 / EM-6001 as
// sys.fatal with Open Diagnostics (not only a native box). FR-157 banner copy.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { el } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { ApiClient } from '../src/api/client.js';
import { createMockServer, MOCK_TOKEN } from '../src/mock/server.js';
import { MockEventSource } from '../src/mock/MockEventSource.js';
import { createServiceChannel, createLiveRuntime, type Runtime } from '../src/state/runtime.js';

afterEach(() => { cleanup(); });

function harness() {
  const server = createMockServer({ seed: 'sample', delays: false });
  const calls: Array<{ url: string; auth: string | null }> = [];
  const accepted = new Set([server.token]);
  // Forwards to the mock with its own token when the caller used any token the "Shell" issued (old or new).
  const fetch = (input: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers ?? {});
    calls.push({ url: input, auth: h.get('Authorization') });
    const tok = (h.get('Authorization') ?? '').replace(/^Bearer /, '');
    if (accepted.has(tok)) h.set('Authorization', `Bearer ${MOCK_TOKEN}`);
    return server.fetch(input.replace(/^http:\/\/127\.0\.0\.1:\d+/, server.baseUrl), { ...init, headers: h });
  };
  const api = new ApiClient({ baseUrl: 'http://127.0.0.1:42301', token: server.token, fetch, mediaResolver: server.mediaResolver });
  let push: ((s: unknown) => void) | null = null;
  const openFolder = vi.fn();
  const bridge = { onServiceState: (cb: (s: unknown) => void) => { push = cb; return () => { push = null; }; }, openFolder };
  const service = createServiceChannel(bridge, api, { status: 'ready', epoch: 0 });
  const sources: string[] = [];
  const runtime: Runtime = {
    mode: 'live', api, service,
    createSource: (url) => { sources.push(url); return new MockEventSource(server.bus); },
    healthCheck: async () => ({}),
    seededProjectId: server.firstProjectId(),
  };
  (window as { expertmotion?: unknown }).expertmotion = bridge;
  return { runtime, api, calls, sources, accepted, openFolder, push: (s: unknown) => act(async () => { push?.(s); }) };
}

async function boot(runtime: Runtime) {
  render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
  await waitFor(() => { if (!document.querySelector('[data-el="stage.timeline"]') || !el('hdr.title')?.textContent?.trim()) throw new Error('not booted'); });
}

describe('FR-171 Service restart in the Editor', () => {
  it('offline banner, then new port + token: API and SSE use them and the project is refetched', async () => {
    const h = harness();
    await boot(h.runtime);
    await waitFor(() => { if (!h.sources.length) throw new Error('no SSE'); });
    expect(h.sources[0]).not.toContain('token=');                      // SEC-016 round 2: the stream sends the token as a header
    expect(h.sources[0]).not.toContain(h.api.serviceToken);

    await h.push({ status: 'offline', code: 'EM-8001' });
    await waitFor(() => { if (!el('sys.offline')) throw new Error('no offline banner'); });

    const fresh = 'fresh-token-after-restart-0001';
    h.accepted.add(fresh);
    const before = h.calls.length, sourcesBefore = h.sources.length;
    await h.push({ status: 'ready', bootstrap: { port: 42322, token: fresh } });
    expect(h.api.baseUrl).toBe('http://127.0.0.1:42322');
    await waitFor(() => { if (h.sources.length <= sourcesBefore || !h.sources.at(-1)!.startsWith('http://127.0.0.1:42322/')) throw new Error('SSE not reconnected'); });
    expect(h.api.serviceToken).toBe(fresh);                              // FetchEventSource reads this token on (re)connect
    expect(h.sources.some((u) => u.includes(fresh))).toBe(false);
    await waitFor(() => { if (!h.calls.slice(before).some((c) => /\/projects\/[^/]+\/open$/.test(c.url))) throw new Error('project not refetched'); });
    const after = h.calls.slice(before);
    expect(after.every((c) => c.url.startsWith('http://127.0.0.1:42322/') && c.auth === `Bearer ${fresh}`)).toBe(true);
    await waitFor(() => { if (el('sys.offline')) throw new Error('still offline'); });
  });

  it('EM-8002 after three failed restarts is shown in the Editor with Open Diagnostics and Quit', async () => {
    const h = harness();
    await boot(h.runtime);
    await h.push({ status: 'failed', code: 'EM-8002', logsDir: 'C:\\Users\\x\\AppData\\Roaming\\Expertmotion\\logs' });
    await waitFor(() => { if (!el('sys.fatal')) throw new Error('no fatal'); });
    expect(el('sys.fatal')!.textContent).toContain('Expertmotion could not start');
    expect(el('sys.fatal.quit')).not.toBeNull();
    fireEvent.click(el('sys.fatal.diagnostics')!);
    expect(h.openFolder).toHaveBeenCalledWith('C:\\Users\\x\\AppData\\Roaming\\Expertmotion\\logs');
    expect(el('stage.timeline')).not.toBeNull();                       // the Editor stays mounted behind it (drafts kept)
  });

  it('EM-8002: Try again asks the Shell to start the Service again; the next pushes clear sys.fatal (FR-184)', async () => {
    const h = harness();
    const retryStartup = vi.fn(async () => true);
    (window as unknown as { expertmotion: Record<string, unknown> }).expertmotion['retryStartup'] = retryStartup;
    await boot(h.runtime);
    await h.push({ status: 'failed', code: 'EM-8002', logsDir: 'C:\\logs' });
    await waitFor(() => { if (!el('sys.fatal.retry')) throw new Error('no retry'); });
    fireEvent.click(el('sys.fatal.retry')!);
    expect(retryStartup).toHaveBeenCalledTimes(1);
    await h.push({ status: 'starting', phase: 'service', sinceMs: 40_000 });
    await waitFor(() => { if (el('sys.fatal')) throw new Error('fatal still shown'); });
  });

  it('EM-6001 storage locked: sys.fatal with the storage hint; a later ready with EM-6001 opens Restore', async () => {
    const h = harness();
    await boot(h.runtime);
    await h.push({ status: 'failed', code: 'EM-6001', logsDir: '/logs' });
    await waitFor(() => { if (!el('sys.fatal')) throw new Error('no fatal'); });
    expect(el('sys.fatal')!.textContent).toContain('Project storage cannot be opened');
    expect(el('sys.fatal')!.textContent).toContain('Restore backup');
    await h.push({ status: 'ready', bootstrap: { port: 42330, token: 'tok-empty-storage-0001' }, code: 'EM-6001' });
    await waitFor(() => { if (el('sys.fatal')) throw new Error('fatal still shown'); });
    await waitFor(() => { if (!document.querySelector('[data-el^="scr.backup.restore"]')) throw new Error('restore not opened'); });
  });

  it('the live runtime waits for the first ready push instead of giving up (window loads before the Service)', async () => {
    let push: ((s: unknown) => void) | null = null;
    const bridge = { getBootstrap: async () => null as unknown as { port: number; token: string }, onServiceState: (cb: (s: unknown) => void) => { push = cb; return () => undefined; } };
    const p = createLiveRuntime(bridge);
    await new Promise((r) => setTimeout(r, 10));
    push!({ status: 'ready', bootstrap: { port: 42340, token: 'first-token-000001' } });
    const rt = await p;
    expect(rt?.api.baseUrl).toBe('http://127.0.0.1:42340');
    expect(rt?.api.serviceToken).toBe('first-token-000001');
    expect(rt?.service?.current().status).toBe('ready');
  });
});

describe('FR-157 Private Mode banner copy', () => {
  it('says nothing leaves this computer', async () => {
    const h = harness();
    await boot(h.runtime);
    if (!el('agent.output.private')) await act(async () => { fireEvent.click(el('agent.output.toggle')!); });   // Output Settings start collapsed
    await act(async () => { fireEvent.click(el('agent.output.private')!); });
    await waitFor(() => { if (!el('sys.privatemode.banner')) throw new Error('no banner'); }, { timeout: 3000 });
    expect(el('sys.privatemode.banner')!.textContent).toContain('Private Mode: nothing leaves this computer');
  });
});

describe('FR-176 About: honest boundary statement', () => {
  it('states what the protection does and does not cover', async () => {
    const h = harness();
    await boot(h.runtime);
    fireEvent.click(el('hdr.menu.help')!);
    await act(async () => { fireEvent.click(el('hdr.menu.help.about')!); });
    await waitFor(() => { if (!el('scr.about.security')) throw new Error('no statement'); });
    const text = el('scr.about.security')!.textContent ?? '';
    expect(text).toContain('none of them protects against the owner or an administrator of this computer');
    expect(text).not.toMatch(/unbreakable|cannot be reverse-engineered|cannot read/i);
  });
});
