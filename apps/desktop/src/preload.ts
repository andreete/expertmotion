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
 *   getPathsForFiles(files)    → string[]   (paths of files dropped on the Editor; Electron webUtils, no IPC)
 *   onServiceState(cb)         → unsubscribe (service up/down + re-bootstrap token push)
 *   onUpdateState(cb)          → unsubscribe (FR-152 updater state push)
 *   getUpdateState()           → UpdateState
 *   updateAction(action)       → void       (download | restart | later | check; Creator consent, checked in main)
 *   openPath(path)             → void       (play a rendered Output with the system player; media files only)
 *   copyText(text)             → boolean    (system clipboard via main; true when it holds the text)
 *   readClipboardText()        → string     (system clipboard text, ≤ 8 KB; used by the licence Paste button)
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
  // Drag-and-drop import: File.path was removed in Electron 32; webUtils returns the OS path of a dropped File ('' otherwise).
  getPathsForFiles: (files: readonly File[]): string[] => files.map((f) => webUtils.getPathForFile(f)).filter((p) => p.length > 0),
  onServiceState: (cb: (state: ServiceState) => void): (() => void) => {
    const listener = (_event: unknown, state: ServiceState): void => cb(state);
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
} as const;

contextBridge.exposeInMainWorld('expertmotion', Object.freeze(api));

export type ExpertmotionBridge = typeof api;
