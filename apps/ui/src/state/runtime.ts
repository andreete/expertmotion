// Runtime wiring: live (Local Service via bootstrap) or mock (VITE_EM_MOCK=1, in-memory fake API).
import { ApiClient, resolveBootstrap } from '../api/client.js';
import type { EventSourceLike } from '../api/events.js';
import { createMockServer, type MockOptions } from '../mock/server.js';
import { MockEventSource } from '../mock/MockEventSource.js';

export interface Runtime {
  mode: 'live' | 'mock';
  api: ApiClient;
  createSource?: (url: string) => EventSourceLike;
  healthCheck: () => Promise<{ seq?: number } | null>;
  /** Mock only: id of the seeded project so the Editor can open it on first launch. */
  seededProjectId?: string | null;
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

export async function createLiveRuntime(): Promise<Runtime | null> {
  const boot = await resolveBootstrap();
  if (!boot) return null;
  const api = new ApiClient({ baseUrl: boot.baseUrl, token: boot.token });
  return {
    mode: 'live', api,
    healthCheck: async () => {
      try {
        const res = await fetch(`${boot.baseUrl}/api/v1/health`);
        if (!res.ok) return null;
        const json = (await res.json()) as { status?: string; seq?: number };
        return json.status === 'ok' ? { ...(typeof json.seq === 'number' ? { seq: json.seq } : {}) } : null;
      } catch { return null; }
    },
  };
}
