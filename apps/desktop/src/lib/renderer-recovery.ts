/**
 * Editor window recovery (FR-185; QA 2026-10-26 "sering blackscreen"). Pure module: no `electron` import (unit-tested on
 * Linux); main.ts wires `render-process-gone`, `unresponsive` / `responsive` and `did-fail-load` to these decisions.
 *
 *   - renderer gone (crash, OOM, killed): log + crash file, reload automatically once; a second crash within
 *     AUTO_RELOAD_WINDOW_MS asks with a native dialog (Reload / Close). A clean exit or a gone renderer while the Shell is
 *     shutting down is ignored.
 *   - renderer unresponsive: log, ask once per episode (Wait / Reload / Close); `responsive` dismisses the dialog.
 *   - did-fail-load: logged (ERR_ABORTED from a reload or a cancelled navigation is not a failure).
 * The Local Service keeps running in every case; a reloaded Editor reconnects through getBootstrap.
 */

export const RENDERER_CRASH_CODE = 'EM-8008';
export const AUTO_RELOAD_WINDOW_MS = 5 * 60 * 1000;
export const MAX_AUTO_RELOADS = 1;

export interface CrashState { autoReloads: number; windowStart: number | null }
export const initialCrashState: CrashState = { autoReloads: 0, windowStart: null };

export interface GoneDetails { reason: string; exitCode: number }
export type GoneDecision = { action: 'ignore' } | { action: 'reload'; state: CrashState } | { action: 'ask'; state: CrashState };

/** What to do when the renderer process is gone. */
export function onRendererGone(state: CrashState, details: GoneDetails, now: number, shuttingDown: boolean): GoneDecision {
  if (shuttingDown || details.reason === 'clean-exit') return { action: 'ignore' };
  const fresh = state.windowStart === null || now - state.windowStart > AUTO_RELOAD_WINDOW_MS;
  const base: CrashState = fresh ? { autoReloads: 0, windowStart: now } : state;
  if (base.autoReloads < MAX_AUTO_RELOADS) return { action: 'reload', state: { ...base, autoReloads: base.autoReloads + 1 } };
  return { action: 'ask', state: base };
}

/** Native dialog copy (EM-8008, ERROR_CATALOGUE §6.8). Index 0 is the default. */
export const RENDERER_GONE_DIALOG = {
  title: 'Expertmotion',
  message: 'The editor window stopped / Jendela editor berhenti',
  detail: 'Your project is saved. Reload to continue. / Proyek kamu tersimpan. Muat ulang untuk melanjutkan.\n\nEM-8008',
  buttons: ['Reload / Muat ulang', 'Close / Tutup'],
  defaultId: 0,
  cancelId: 1,
} as const;

export const UNRESPONSIVE_DIALOG = {
  title: 'Expertmotion',
  message: 'Expertmotion is not responding / Expertmotion tidak merespons',
  detail: 'It may still be working. Wait, or reload the window; your project is saved. / Mungkin masih bekerja. Tunggu, atau muat ulang jendela; proyek kamu tersimpan.\n\nEM-8008',
  buttons: ['Wait / Tunggu', 'Reload / Muat ulang', 'Close / Tutup'],
  defaultId: 0,
  cancelId: 0,
} as const;

export type RecoveryChoice = 'reload' | 'close' | 'wait';
export function goneChoice(response: number): RecoveryChoice { return response === 1 ? 'close' : 'reload'; }
export function unresponsiveChoice(response: number): RecoveryChoice { return response === 1 ? 'reload' : response === 2 ? 'close' : 'wait'; }

/** Chromium net error -3 (ERR_ABORTED): a reload or a superseded navigation, not a failed load. */
const ERR_ABORTED = -3;
/** Log entry for `did-fail-load`, or null when it is not worth logging. The URL keeps only origin + path (no query). */
export function didFailLoadEntry(errorCode: number, errorDescription: string, url: string, isMainFrame: boolean): { level: 'error' | 'warn'; msg: string; fields: Record<string, unknown> } | null {
  if (errorCode === ERR_ABORTED) return null;
  return { level: isMainFrame ? 'error' : 'warn', msg: 'editor load failed', fields: { errorCode, error: errorDescription.slice(0, 200), url: stripQuery(url), mainFrame: isMainFrame } };
}

export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return (cut < 0 ? url : url.slice(0, cut)).slice(0, 300);
}
