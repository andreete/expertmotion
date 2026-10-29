/**
 * Preload bridge (SECURITY.md SEC-003, SEC-031). Exposes exactly the documented surface on
 * `window.expertmotion` and nothing else: no generic `invoke`, no Node, no Electron. Runs in a
 * sandboxed renderer (SEC-022), so it uses only `contextBridge` + `ipcRenderer`.
 *
 * Bridge surface (closed set, BLUEPRINT.md §3.8 + the Desktop Shell brief's save dialog):
 *   getBootstrap(): {port, token}
 *   pickFiles(options?)        → string[]   (paths for import; sets X-Expertmotion-Caller in the Service call)
 *   pickFolder(options?)       → string | null
 *   pickSavePath(options?)     → string | null
 *   openFolder(path)           → void       (reveal a folder/file in the OS file manager)
 *   openExternal(url)          → void       (system browser; HTTPS on EXTERNAL_HOSTS only, checked in main)
 *   openSource(url)            → {ok} | {ok:false, code, message} (research source page: public https, refused in Private Mode)
 *   getPathsForFiles(files)    → string[]   (paths of files dropped on the Editor; Electron webUtils, no IPC)
 *   onServiceState(cb)         → unsubscribe (service up/down + re-bootstrap token push)
 *   onUpdateState(cb)          → unsubscribe (FR-152 updater state push)
 *   getUpdateState()           → UpdateState
 *   updateAction(action)       → void       (download | restart | later | check; Creator consent, checked in main)
 *   openPath(path)             → void       (play a rendered Output with the system player; media files only)
 *   copyText(text)             → boolean    (system clipboard via main; true when it holds the text)
 *   readClipboardText()        → string     (system clipboard text, ≤ 8 KB; used by the licence Paste button)
 *   logError(entry)            → void       (FR-185: Editor error → Shell log; validated, rate-limited and size-capped in main)
 *   retryStartup()             → boolean    (FR-184: splash "Coba lagi" after EM-8002; main restarts the Service once more)
 *
 * Not on the bridge (FR-198): the preload itself sends liveness to main on IPC.heartbeat / IPC.rendererSignal (send only, no
 * reply, nothing from the Editor goes through them) — see lib/heartbeat.ts for the watchdog that reads them.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from './lib/constants.js';
import type { OpenSourceResult } from './lib/open-source.js';
import { parseServiceStatePush, type ServiceStatePush } from './lib/startup.js';
import { EDITOR_MOUNT_SELECTOR, HEARTBEAT_MS } from './lib/heartbeat.js';

export interface Bootstrap {
  port: number;
  token: string;
}

export interface PickFilesOptions {
  filters?: { name: string; extensions: string[] }[];
  multiple?: boolean;
}

export interface PickFolderOptions {
  defaultPath?: string;
}

export interface PickSaveOptions {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/** Service state push (FR-171) with the startup phase for the splash (FR-184); validated here before it reaches the Editor. */
export type ServiceState = ServiceStatePush;

export interface RendererLogEntry {
  level: 'warn' | 'error';
  code?: string;
  message: string;
  stack?: string;
  source: 'error-boundary' | 'window-error' | 'unhandled-rejection';
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'deferred' | 'paused' | 'error';
  version?: string; percent?: number; code?: string;
}

const api = {
  getBootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke(IPC.getBootstrap) as Promise<Bootstrap>,
  pickFiles: (options?: PickFilesOptions): Promise<string[]> => ipcRenderer.invoke(IPC.pickFiles, options ?? {}) as Promise<string[]>,
  pickFolder: (options?: PickFolderOptions): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder, options ?? {}) as Promise<string | null>,
  pickSavePath: (options?: PickSaveOptions): Promise<string | null> => ipcRenderer.invoke(IPC.pickSavePath, options ?? {}) as Promise<string | null>,
  openFolder: (targetPath: string): Promise<void> => ipcRenderer.invoke(IPC.openFolder, targetPath) as Promise<void>,
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  openSource: (url: string): Promise<OpenSourceResult> => ipcRenderer.invoke(IPC.openSource, url) as Promise<OpenSourceResult>,
  // Drag-and-drop import: File.path was removed in Electron 32; webUtils returns the OS path of a dropped File ('' otherwise).
  getPathsForFiles: (files: readonly File[]): string[] => files.map((f) => webUtils.getPathForFile(f)).filter((p) => p.length > 0),
  onServiceState: (cb: (state: ServiceState) => void): (() => void) => {
    const listener = (_event: unknown, raw: unknown): void => { const state = parseServiceStatePush(raw); if (state !== null) cb(state); };
    ipcRenderer.on(IPC.serviceState, listener);
    return () => ipcRenderer.removeListener(IPC.serviceState, listener);
  },
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: unknown, state: UpdateState): void => cb(state);
    ipcRenderer.on(IPC.updateState, listener);
    return () => ipcRenderer.removeListener(IPC.updateState, listener);
  },
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.getUpdateState) as Promise<UpdateState>,
  updateAction: (action: 'download' | 'restart' | 'later' | 'check'): Promise<void> => ipcRenderer.invoke(IPC.updateAction, action) as Promise<void>,
  openPath: (targetPath: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, targetPath) as Promise<void>,
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.copyText, text) as Promise<boolean>,
  readClipboardText: (): Promise<string> => ipcRenderer.invoke(IPC.readClipboardText) as Promise<string>,
  logError: (entry: RendererLogEntry): Promise<void> => ipcRenderer.invoke(IPC.logError, entry) as Promise<void>,
  retryStartup: (): Promise<boolean> => ipcRenderer.invoke(IPC.retryStartup) as Promise<boolean>,
} as const;

contextBridge.exposeInMainWorld('expertmotion', Object.freeze(api));

export type ExpertmotionBridge = typeof api;

/**
 * FR-198 liveness: after DOMContentLoaded, ask for ONE animation frame; when it runs, the first frame was produced
 * (`first-paint`). Then every HEARTBEAT_MS send `{seq, framed, visible}` and ask for the next single frame — never a
 * continuous requestAnimationFrame loop (that would keep the GPU busy on a low-end laptop). A hung JS thread stops the beats;
 * a dead / hung GPU or compositor stops the frames while the beats continue. Errors here never reach the Editor.
 */
function startLiveness(): void {
  let painted = false, framed = false, pending = false, mounted = false, seq = 0;
  const send = (channel: string, payload: unknown): void => { try { ipcRenderer.send(channel, payload); } catch { /* main gone */ } };
  const askFrame = (): void => {
    if (pending) return;
    pending = true;
    try {
      requestAnimationFrame(() => {
        pending = false; framed = true;
        if (!painted) { painted = true; send(IPC.rendererSignal, { kind: 'first-paint', atMs: performance.now() }); }
      });
    } catch { pending = false; }
  };
  const beat = (): void => {
    if (!mounted && document.querySelector(EDITOR_MOUNT_SELECTOR) !== null) { mounted = true; send(IPC.rendererSignal, { kind: 'editor-mounted', atMs: performance.now() }); }
    if (painted) { seq += 1; send(IPC.heartbeat, { seq, framed, visible: document.visibilityState === 'visible' }); }
    framed = false;
    askFrame();
  };
  const start = (): void => { askFrame(); setInterval(beat, HEARTBEAT_MS); };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true }); else start();
}
try { startLiveness(); } catch { /* never break the bridge */ }
