/**
 * electron-updater policy (SECURITY.md SEC-090…096). The feed host is a build constant (SEC-096);
 * no check runs in Private Mode (SEC-094); downloads need Creator consent (`autoDownload:false`);
 * downgrades are off (SEC-095). Private Mode is a setting the Local Service exposes in
 * `/api/v1/settings` (SettingsDto.privateMode); the Shell reads it before every check.
 * Pure decision helpers; the AppUpdater wiring lives in main.ts.
 */
import { UPDATE_CHECK_INTERVAL_MS } from './constants.js';

export interface UpdaterConfig {
  readonly autoDownload: false;
  readonly allowDowngrade: false;
  readonly channel: 'latest';
  /** Pinned in the binary (SEC-096); never changeable in the UI. */
  readonly feedUrl: string;
  /** electron-builder NSIS verifies the Authenticode signature (SEC-091). */
  readonly verifyUpdateCodeSignature: true;
}

export function updaterConfig(feedUrl: string): UpdaterConfig {
  return { autoDownload: false, allowDowngrade: false, channel: 'latest', feedUrl, verifyUpdateCodeSignature: true };
}

export interface CheckContext {
  privateMode: boolean;
  /** Epoch ms of the last completed check, or null if none this launch. */
  lastCheckAt: number | null;
  /** Whether the Editor has become interactive (SEC-094: check only after that). */
  editorInteractive: boolean;
  now: number;
}

export type CheckDecision = { check: true } | { check: false; reason: 'private-mode' | 'not-interactive' | 'too-soon' };

/** Decides whether an update check may run now (SEC-094). */
export function shouldCheckForUpdates(ctx: CheckContext, intervalMs: number = UPDATE_CHECK_INTERVAL_MS): CheckDecision {
  if (ctx.privateMode) return { check: false, reason: 'private-mode' };
  if (!ctx.editorInteractive) return { check: false, reason: 'not-interactive' };
  if (ctx.lastCheckAt !== null && ctx.now - ctx.lastCheckAt < intervalMs) return { check: false, reason: 'too-soon' };
  return { check: true };
}

/** How often the Shell re-evaluates the 24 h rule (FR-152): an hourly tick; `shouldCheckForUpdates` decides. */
export const UPDATE_TICK_MS = 60 * 60 * 1000;

/** Updater state pushed to the Editor (`sys.update`, FR-152, FR-162). */
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'deferred' | 'paused' | 'error';
  version?: string;
  percent?: number;
  code?: string;
}
export type UpdateEvent =
  | { type: 'checking' } | { type: 'none' } | { type: 'available'; version: string } | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string } | { type: 'error'; message: string; stage: 'check' | 'download' | 'install' }
  | { type: 'paused' } | { type: 'deferred' } | { type: 'resumed' };

/** EM code of an updater failure (ERROR_CATALOGUE §6.8): signature/trust → EM-8103, download → EM-8102, install → EM-8104, else EM-8101. */
export function updateErrorCode(message: string, stage: 'check' | 'download' | 'install'): 'EM-8101' | 'EM-8102' | 'EM-8103' | 'EM-8104' {
  if (/signature|not signed|publisher|sha512|checksum/i.test(message)) return 'EM-8103';
  if (stage === 'install') return 'EM-8104';
  return stage === 'download' ? 'EM-8102' : 'EM-8101';
}

/** Pure state machine of the update banner. A finished download stays offered until the Creator restarts. */
export function nextUpdateState(s: UpdateState, e: UpdateEvent): UpdateState {
  switch (e.type) {
    case 'checking': return s.status === 'downloaded' || s.status === 'deferred' ? s : { status: 'checking' };
    case 'none': return s.status === 'checking' ? { status: 'idle' } : s;
    case 'available': return { status: 'available', version: e.version };
    case 'progress': return { status: 'downloading', ...(s.version ? { version: s.version } : {}), percent: Math.max(0, Math.min(100, Math.round(e.percent))) };
    case 'downloaded': return { status: 'downloaded', version: e.version, code: 'EM-8105' };
    case 'error': return { ...(s.version ? { version: s.version } : {}), status: 'error', code: updateErrorCode(e.message, e.stage) };
    case 'paused': return s.status === 'downloaded' || s.status === 'deferred' ? s : { status: 'paused' };
    case 'deferred': return { ...s, status: 'deferred' };
    case 'resumed': return s.status === 'deferred' ? { ...s, status: 'downloaded' } : s;
  }
}

/** FR-152: never apply an update while a Render Job runs; the install waits for the queue to empty. */
export function installDecision(ctx: { renderActive: boolean; downloaded: boolean }): 'install' | 'defer' | 'nothing' {
  if (!ctx.downloaded) return 'nothing';
  return ctx.renderActive ? 'defer' : 'install';
}
