// Entry: choose the runtime (mock with VITE_EM_MOCK=1, otherwise the Local Service via the Shell bootstrap or
// VITE_EM_API/VITE_EM_TOKEN), then mount the Editor.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';
import { StoreProvider } from './state/store.js';
import { createLiveRuntime, createMockRuntime, type Runtime } from './state/runtime.js';
import { ApiClient } from './api/client.js';

async function start() {
  const env = import.meta.env as Record<string, string | undefined>;
  let runtime: Runtime | null = env['VITE_EM_MOCK'] === '1' ? createMockRuntime({ seed: 'sample', delays: true }) : await createLiveRuntime();
  // No bootstrap and no mock: mount anyway so the Editor can show the "service not reachable" screen.
  runtime ??= { mode: 'live', api: new ApiClient({ baseUrl: 'http://127.0.0.1:4110', token: 'missing-token' }), healthCheck: async () => null };
  const root = document.getElementById('root');
  if (!root) return;
  createRoot(root).render(<StrictMode><StoreProvider runtime={runtime}><App /></StoreProvider></StrictMode>);
}
void start();
