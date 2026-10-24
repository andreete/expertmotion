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
 *   onServiceState(cb)         → unsubscribe (service up/down + re-bootstrap token push)
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './lib/constants.js';

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

export interface ServiceState {
  status: 'starting' | 'ready' | 'offline' | 'failed';
  /** A fresh endpoint after a Service restart re-issued the token (API_SPECIFICATION §2.1 rotation). */
  bootstrap?: Bootstrap;
  /** EM-8xxx code when status is 'failed'. */
  code?: string;
}

const api = {
  getBootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke(IPC.getBootstrap) as Promise<Bootstrap>,
  pickFiles: (options?: PickFilesOptions): Promise<string[]> => ipcRenderer.invoke(IPC.pickFiles, options ?? {}) as Promise<string[]>,
  pickFolder: (options?: PickFolderOptions): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder, options ?? {}) as Promise<string | null>,
  pickSavePath: (options?: PickSaveOptions): Promise<string | null> => ipcRenderer.invoke(IPC.pickSavePath, options ?? {}) as Promise<string | null>,
  openFolder: (targetPath: string): Promise<void> => ipcRenderer.invoke(IPC.openFolder, targetPath) as Promise<void>,
  onServiceState: (cb: (state: ServiceState) => void): (() => void) => {
    const listener = (_event: unknown, state: ServiceState): void => cb(state);
    ipcRenderer.on(IPC.serviceState, listener);
    return () => ipcRenderer.removeListener(IPC.serviceState, listener);
  },
} as const;

contextBridge.exposeInMainWorld('expertmotion', Object.freeze(api));

export type ExpertmotionBridge = typeof api;
