/**
 * electron-updater policy (SECURITY.md SEC-090…096, FRD FR-152). The feed host is a build constant (SEC-096);
 * no check or download runs in Private Mode (SEC-094); after a check finds an update the Shell downloads it in the
 * background when `downloadDecision` allows (not Private Mode, not metered, no Render Job) — electron-updater's own
 * `autoDownload` stays false so this policy is the only path; downgrades are off (SEC-095). EM-8104 after an
 * interrupted install is detected from the pending-update marker (`pendingUpdateOutcome`). Private Mode is a setting the Local Service exposes in
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

/** Private Mode as the Shell can know it: `unknown` while the Local Service is not ready or its settings cannot be read. */
export type PrivateModeState = 'on' | 'off' | 'unknown';
export interface CheckPlanContext extends Omit<CheckContext, 'privateMode'> {
  /** false when this build has no update feed (no app-update.yml): nothing about updates is ever shown. */
  feed: boolean;
  privateMode: PrivateModeState;
}
export type CheckPlan = { check: true }
  | { check: false; reason: 'no-feed' | 'service-not-ready' | 'private-mode' | 'not-interactive' | 'too-soon'; banner: 'paused' | null; retryMs?: number };
/** Re-try delay when Private Mode is unknown (the Service is still starting): no banner, no check, ask again shortly. */
export const UNKNOWN_PRIVATE_MODE_RETRY_MS = 30_000;
/**
 * QA P1 2026-10-29: the update check ran before the Service was ready, read "unknown" as Private Mode and showed "Updates paused
 * by Private Mode" on every launch — also in builds without any update feed. The "paused" banner now needs Private Mode really
 * on; unknown skips the check silently and retries; no feed means no check and no banner at all.
 */
export function planUpdateCheck(ctx: CheckPlanContext, intervalMs: number = UPDATE_CHECK_INTERVAL_MS): CheckPlan {
  if (!ctx.feed) return { check: false, reason: 'no-feed', banner: null };
  if (ctx.privateMode === 'unknown') return { check: false, reason: 'service-not-ready', banner: null, retryMs: UNKNOWN_PRIVATE_MODE_RETRY_MS };
  const d = shouldCheckForUpdates({ ...ctx, privateMode: ctx.privateMode === 'on' }, intervalMs);
  if (d.check) return d;
  return { check: false, reason: d.reason, banner: d.reason === 'private-mode' ? 'paused' : null };
}
/** The update banner may say "paused by Private Mode" only when Private Mode is actually on (never for unknown). */
export const pausedBannerAllowed = (privateMode: PrivateModeState): boolean => privateMode === 'on';

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
  | { type: 'paused' } | { type: 'deferred' } | { type: 'resumed' } | { type: 'interrupted'; fromVersion: string; toVersion: string };

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
    case 'interrupted': return { status: 'error', version: e.toVersion, code: 'EM-8104' };
  }
}

/**
 * FR-152 background download: only when Private Mode is off, the connection is not reported metered (null = the OS gave no
 * answer; Electron has no metered API, so unknown does not block) and no Render Job runs. Otherwise wait and re-evaluate.
 */
export type DownloadDecision = { download: true } | { download: false; reason: 'private-mode' | 'metered' | 'rendering' | 'not-available' };
export function downloadDecision(ctx: { privateMode: boolean; metered: boolean | null; renderActive: boolean; status: UpdateState['status'] }): DownloadDecision {
  if (ctx.status !== 'available') return { download: false, reason: 'not-available' };
  if (ctx.privateMode) return { download: false, reason: 'private-mode' };
  if (ctx.metered === true) return { download: false, reason: 'metered' };
  if (ctx.renderActive) return { download: false, reason: 'rendering' };
  return { download: true };
}
/** How often a waiting background download is re-evaluated (render finished, Private Mode off, …). */
export const DOWNLOAD_RETRY_MS = 5 * 60 * 1000;

/**
 * EM-8104 rollback detection. Before `quitAndInstall` the Shell writes `<data>/update-pending.json` {fromVersion, toVersion,
 * at}. On the next launch: running `toVersion` → applied (marker removed); still running `fromVersion` → the install was
 * interrupted and NSIS left the previous version in place (that file-level rollback is the installer's job, SEC-093) → EM-8104
 * with "Try again"; anything else (a newer/manual install) → applied. A marker older than 7 days is stale and ignored.
 */
export interface PendingUpdate { fromVersion: string; toVersion: string; at: number }
export function parsePendingUpdate(raw: unknown): PendingUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  return typeof v.fromVersion === 'string' && typeof v.toVersion === 'string' && typeof v.at === 'number' && Number.isFinite(v.at)
    ? { fromVersion: v.fromVersion, toVersion: v.toVersion, at: v.at } : null;
}
export function pendingUpdateOutcome(p: PendingUpdate | null, currentVersion: string, now: number): 'none' | 'applied' | 'interrupted' {
  if (!p) return 'none';
  if (now - p.at > 7 * 24 * 60 * 60 * 1000) return 'none';
  if (currentVersion === p.fromVersion && p.fromVersion !== p.toVersion) return 'interrupted';
  return 'applied';
}

/** FR-152: never apply an update while a Render Job runs; the install waits for the queue to empty. */
export function installDecision(ctx: { renderActive: boolean; downloaded: boolean }): 'install' | 'defer' | 'nothing' {
  if (!ctx.downloaded) return 'nothing';
  return ctx.renderActive ? 'defer' : 'install';
}
