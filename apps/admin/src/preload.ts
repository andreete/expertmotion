/**
 * Preload bridge for Expertmotion License Admin. Runs in the sandboxed renderer and exposes exactly
 * two functions on `window.emAdmin`: request(channel, args) for the closed channel list in
 * core/channels.ts (unknown channels are refused here and again in main) and onLocked(cb). No Node,
 * no Electron objects and no ipcRenderer reach the page.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL_NAMES, EVENTS } from './core/channels.js';

const allowed = new Set<string>(CHANNEL_NAMES);

contextBridge.exposeInMainWorld('emAdmin', {
  request(channel: string, args?: Record<string, unknown>): Promise<unknown> {
    if (typeof channel !== 'string' || !allowed.has(channel)) return Promise.resolve({ ok: false, error: { code: 'EINVAL', message: 'Unknown request.' } });
    return ipcRenderer.invoke(channel, args ?? {});
  },
  onLocked(cb: (reason: string) => void): () => void {
    const listener = (_e: unknown, reason: unknown): void => cb(typeof reason === 'string' ? reason : 'idle');
    ipcRenderer.on(EVENTS.locked, listener);
    return () => ipcRenderer.removeListener(EVENTS.locked, listener);
  },
});
