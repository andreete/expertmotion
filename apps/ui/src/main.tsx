// Entry: paint the startup splash at once (FR-184), then choose the runtime (mock with VITE_EM_MOCK=1, otherwise the Local
// Service via the Shell bootstrap or VITE_EM_API/VITE_EM_TOKEN) behind it, and mount the Editor inside the top-level error
// boundary (FR-185). Nothing is awaited before the first render: the window is never a black rectangle while the Shell
// checks its files, opens storage and starts the Service.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';
import { StoreProvider } from './state/store.js';
import { createLiveRuntime, createMockRuntime, withReplay, type Runtime, type ServiceStatus } from './state/runtime.js';
import { ApiClient } from './api/client.js';
import { Boot } from './startup/Boot.js';
import { ErrorBoundary, logEditorError } from './startup/ErrorBoundary.js';
import { noteLogsDir, notePageHidden } from './startup/session-guard.js';

const env = import.meta.env as Record<string, string | undefined>;
// Subscribe to the Shell's service state before anything else, so the push sent when the page finished loading is kept.
const bridge = withReplay(typeof window !== 'undefined' ? window.expertmotion : undefined);

// Errors outside React (event handlers, promises) reach the Shell log too; a benign ResizeObserver notice is not an error.
window.addEventListener('error', (e) => { if (!/ResizeObserver loop/.test(e.message ?? '')) logEditorError(e.error ?? e.message, 'window-error'); });
window.addEventListener('unhandledrejection', (e) => logEditorError(e.reason, 'unhandled-rejection'));
// FR-202: a normal close / reload is not an abnormal end of the open project; the crash card's "Open log folder" needs the folder.
window.addEventListener('pagehide', () => notePageHidden());
bridge?.onServiceState?.((raw) => { const d = (raw as { logsDir?: unknown } | null)?.logsDir; if (typeof d === 'string') noteLogsDir(d); });

async function start(onService: (s: ServiceStatus) => void): Promise<Runtime> {
  if (env['VITE_EM_MOCK'] === '1') return createMockRuntime({ seed: 'sample', delays: true });
  const live = await createLiveRuntime(bridge, { onService });
  // No bootstrap and no mock: mount anyway so the Editor can show the "service not reachable" screen.
  return live ?? { mode: 'live', api: new ApiClient({ baseUrl: 'http://127.0.0.1:4110', token: 'missing-token' }), healthCheck: async () => null };
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <Boot start={start} bridge={bridge}>
          {(runtime) => <StoreProvider runtime={runtime}><App /></StoreProvider>}
        </Boot>
      </ErrorBoundary>
    </StrictMode>,
  );
}
