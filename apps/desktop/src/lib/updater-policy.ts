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
