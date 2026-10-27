// Runtime wiring: live (Local Service via bootstrap) or mock (VITE_EM_MOCK=1, in-memory fake API).
import { ApiClient, ServiceStatePush, bootstrapFromPush, resolveBootstrap, type ServiceStatePushT, type ShellBridge, type StartupPhase } from '../api/client.js';
import type { EventSourceLike } from '../api/events.js';
import { createMockServer, type MockOptions } from '../mock/server.js';
import { MockEventSource } from '../mock/MockEventSource.js';

/** What the Editor knows about the Local Service from the Desktop Shell (FR-171). `epoch` increases on every new endpoint. */
export interface ServiceStatus {
  status: ServiceStatePushT['status']; code?: string; logsDir?: string; epoch: number;
  /** FR-184: startup step while `starting`, its progress (0…1) and the time since the Shell started. */
  phase?: StartupPhase; progress?: number; sinceMs?: number;
}

export interface ServiceChannel {
  current(): ServiceStatus;
  subscribe(cb: (s: ServiceStatus) => void): () => void;
}

export interface Runtime {
  mode: 'live' | 'mock';
  api: ApiClient;
  createSource?: (url: string) => EventSourceLike;
  healthCheck: () => Promise<{ seq?: number } | null>;
  /** Mock only: id of the seeded project so the Editor can open it on first launch. */
  seededProjectId?: string | null;
  /** Live inside the Desktop Shell: service state pushes (offline / ready with a new port+token / failed EM-8002, EM-6001). */
  service?: ServiceChannel;
  /** FR-202: a launch shows the Start screen and the crash-loop guard decides what reopens (the real live runtime); without it
   *  (mock, tests) the most recent / seeded project opens at once as before. */
  startScreen?: boolean;
}

export function createMockRuntime(opts: MockOptions = {}): Runtime {
  const server = createMockServer(opts);
  const api = new ApiClient({ baseUrl: server.baseUrl, token: server.token, fetch: server.fetch, mediaResolver: server.mediaResolver });
  return {
    mode: 'mock', api,
    createSource: () => new MockEventSource(server.bus),
    healthCheck: async () => { try { const h = await api.health(); return { ...(h.seq === undefined ? {} : { seq: h.seq }) }; } catch { return null; } },
    seededProjectId: server.firstProjectId(),
  };
}

/**
 * Subscribes to the Shell's `onServiceState` (FR-171). A `ready` push with a bootstrap re-points the ApiClient (base URL + token)
 * and bumps `epoch` so the store reconnects SSE and refetches; `offline` / `failed` are forwarded as they are.
 */
export function createServiceChannel(bridge: Pick<ShellBridge, 'onServiceState'>, api: ApiClient, initial: ServiceStatus): ServiceChannel & { ready(timeoutMs: number): Promise<ServiceStatus> } {
  let state = initial;
  const listeners = new Set<(s: ServiceStatus) => void>();
  const set = (s: ServiceStatus) => { state = s; for (const l of [...listeners]) l(s); };
  bridge.onServiceState?.((raw) => {
    const p = ServiceStatePush.safeParse(raw);
    if (!p.success) return;
    const push = p.data;
    let epoch = state.epoch;
    if (push.status === 'ready' && push.bootstrap) {
      const b = bootstrapFromPush(push.bootstrap);
      if (b.baseUrl !== api.baseUrl || b.token !== api.serviceToken) { api.setEndpoint(b.baseUrl, b.token); epoch += 1; }
    }
    set({
      status: push.status, epoch, ...(push.code ? { code: push.code } : {}), ...(push.logsDir ? { logsDir: push.logsDir } : {}),
      ...(push.phase ? { phase: push.phase } : {}), ...(push.progress === undefined ? {} : { progress: push.progress }), ...(push.sinceMs === undefined ? {} : { sinceMs: push.sinceMs }),
    });
  });
  return {
    current: () => state,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    /** Resolves on the first `ready` or `failed`, or after `timeoutMs` with whatever is current. */
    ready(timeoutMs) {
      if (state.status === 'ready' || state.status === 'failed') return Promise.resolve(state);
      return new Promise((resolve) => {
        const t = setTimeout(() => { listeners.delete(on); resolve(state); }, timeoutMs);
        const on = (s: ServiceStatus) => { if (s.status === 'ready' || s.status === 'failed') { clearTimeout(t); listeners.delete(on); resolve(s); } };
        listeners.add(on);
      });
    },
  };
}

/** How long the Editor waits for the Shell's first `ready` (READY_TIMEOUT_MS of the Shell is 60 s; migrations may run). */
export const FIRST_READY_WAIT_MS = 65_000;

/** `onService` (FR-184): every service state from the moment the channel exists, so the splash can show the startup phase. */
export async function createLiveRuntime(bridge: ShellBridge | undefined = typeof window !== 'undefined' ? window.expertmotion : undefined,
  opts: { onService?: (s: ServiceStatus) => void } = {}): Promise<Runtime | null> {
  let boot = await resolveBootstrap(undefined, bridge);
  let service: ReturnType<typeof createServiceChannel> | undefined;
  let api: ApiClient;
  if (bridge?.onServiceState) {
    // Inside the Shell: the window can load before the Service is ready, so wait for the first push instead of giving up.
    api = new ApiClient({ baseUrl: boot?.baseUrl ?? 'http://127.0.0.1:1', token: boot?.token ?? 'pending-bootstrap' });
    service = createServiceChannel(bridge, api, { status: boot ? 'ready' : 'starting', epoch: 0 });
    if (opts.onService) { opts.onService(service.current()); service.subscribe(opts.onService); }
    if (!boot) {
      const s = await service.ready(FIRST_READY_WAIT_MS);
      if (s.status !== 'ready') {
        boot = await resolveBootstrap(undefined, bridge);         // a push may have been missed before subscribing
        if (boot) api.setEndpoint(boot.baseUrl, boot.token);
      }
    }
  } else {
    if (!boot) return null;
    api = new ApiClient({ baseUrl: boot.baseUrl, token: boot.token });
  }
  return {
    mode: 'live', api, startScreen: true,
    ...(service ? { service } : {}),
    healthCheck: async () => {
      try {
        const res = await fetch(`${api.baseUrl}/api/v1/health`);
        if (!res.ok) return null;
        const json = (await res.json()) as { status?: string; seq?: number };
        return json.status === 'ok' ? { ...(typeof json.seq === 'number' ? { seq: json.seq } : {}) } : null;
      } catch { return null; }
    },
  };
}

/**
 * FR-184: the Shell re-sends its last service state when the page finishes loading, which can be before the async startup
 * code subscribes. `withReplay` subscribes once, right away (main.tsx calls it at module start), keeps the latest push and
 * hands it to every later subscriber first, so the splash never misses the current phase.
 */
export function withReplay(bridge: ShellBridge | undefined): ShellBridge | undefined {
  if (!bridge?.onServiceState) return bridge;
  let last: { raw: unknown } | null = null;
  const listeners = new Set<(s: unknown) => void>();
  bridge.onServiceState((raw) => { last = { raw }; for (const l of [...listeners]) l(raw); });
  return {
    ...bridge,
    onServiceState: (cb) => {
      listeners.add(cb);
      if (last) cb(last.raw);
      return () => { listeners.delete(cb); };
    },
  };
}
