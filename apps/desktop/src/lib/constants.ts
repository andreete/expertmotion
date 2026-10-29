/**
 * Constants of the Desktop Shell. Pure module: no `electron` import (unit-tested on Linux).
 * Every value cites the document that owns it; change the document first (AGENTS.md §3.1).
 */

/** Custom scheme and host serving the built Editor (SECURITY.md SEC-025). */
export const APP_SCHEME = 'app';
export const APP_HOST = 'expertmotion';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}` as const;

/** Loopback port range and retry budget for the Local Service (SEC-008, TRD TR-003). */
export const PORT_RANGE = { min: 42300, max: 42399 } as const;
export const PORT_MAX_ATTEMPTS = 10;

/** Supervisor restart backoff: 1 s, 3 s, 9 s, then EM-8002 (ARCHITECTURE.md §5 step 6, DEPLOYMENT §14). */
export const RESTART_BACKOFF_MS = [1000, 3000, 9000] as const;
/** A Service that stayed up this long is considered healthy again and the restart budget resets. */
export const RESTART_BUDGET_RESET_MS = 5 * 60 * 1000;
/** How long the Shell waits for `{type:'ready'}` after the fork. Migrations may run here. */
export const READY_TIMEOUT_MS = 60_000;

/** FR-127: cadence of the Shell → Service memory report (PERFORMANCE §6: no per-tick sampling of other processes). */
export const SHELL_METRICS_MS = 30_000;

/** Close flow (ARCHITECTURE.md §5 step 5). */
export const SHUTDOWN_REQUEST_WAIT_MS = 5_000;
/** FR-002: the whole stop (forced shutdown request + exit) is bounded by this deadline; then the utility process is killed. */
export const SHUTDOWN_KILL_AFTER_MS = 5_000;

/** Development Editor (SEC-014, TRD §4 `EM_UI_PORT`). */
export const DEV_UI_PORT_DEFAULT = 4120;

/** Data directory name under %APPDATA% (ARCHITECTURE.md §8, DEPLOYMENT §5). */
export const DATA_DIR_NAME = 'Expertmotion';

/** Logs (SEC-101): daily rotation, 7 days, 20 MB per file. */
export const LOG_RETENTION_DAYS = 7;
export const LOG_MAX_BYTES = 20 * 1024 * 1024;
/** Lines of Service stderr kept for a crash file (DEPLOYMENT §14 uses 200 for engine tails). */
export const STDERR_TAIL_LINES = 200;

/** Updates (SEC-094): one check after the Editor is interactive, then at most once per 24 h. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Header that labels trusted Shell calls (API_SPECIFICATION.md §2.3). */
export const SHELL_CALLER_HEADER = 'X-Expertmotion-Caller';
export const SHELL_CALLER_VALUE = 'shell';

/** IPC channel names. The list is closed (SEC-030); the preload uses exactly these. */
export const IPC = {
  getBootstrap: 'em:get-bootstrap',
  pickFiles: 'em:pick-files',
  pickFolder: 'em:pick-folder',
  pickSavePath: 'em:pick-save-path',
  openFolder: 'em:open-folder',
  openExternal: 'em:open-external',
  /** R1 (FR-216): open a research citation / picture source page (any public https host; refused in Private Mode). */
  openSource: 'em:open-source',
  serviceState: 'em:service-state',
  /** FR-152 updater: state push, current state, Creator consent (download / restart / later / check). */
  updateState: 'em:update-state',
  getUpdateState: 'em:get-update-state',
  updateAction: 'em:update-action',
  /** FR-146 Play: open a rendered Output with the system player (media extensions only). */
  openPath: 'em:open-path',
  /** Clipboard through main (renderer clipboard permissions stay denied, SEC-029): write any short text; read only on a click. */
  copyText: 'em:copy-text',
  readClipboardText: 'em:read-clipboard-text',
  /** FR-185: the Editor's error boundary / window error handlers log to the Shell log (validated, rate-limited, size-capped). */
  logError: 'em:log-error',
  /** FR-184: "Coba lagi" on the startup splash after EM-8002 restarts the Local Service with a fresh restart budget. */
  retryStartup: 'em:retry-startup',
  /** FR-198: preload-only liveness channels (ipcRenderer.send, not on window.expertmotion): beats every 2 s and one-off signals. */
  heartbeat: 'em:heartbeat',
  rendererSignal: 'em:renderer-signal',
} as const;
export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/**
 * The complete key set of `window.expertmotion` (SEC-003, SEC-031). A test enumerates it.
 * `pickSavePath` is the save dialog required by the Desktop Shell brief; see README "Bridge surface".
 */
export const BRIDGE_KEYS = ['getBootstrap', 'pickFiles', 'pickFolder', 'pickSavePath', 'openFolder', 'openExternal', 'openSource', 'getPathsForFiles', 'onServiceState',
  'onUpdateState', 'getUpdateState', 'updateAction', 'openPath', 'copyText', 'readClipboardText', 'logError', 'retryStartup'] as const;
/** Update actions the Editor may request (FR-152); anything else is ignored by main. */
export const UPDATE_ACTIONS = ['download', 'restart', 'later', 'check'] as const;
export type UpdateAction = (typeof UPDATE_ACTIONS)[number];
/** `openPath` opens only rendered media (FR-146 Play), never executables or documents. */
export const PLAYABLE_EXTENSIONS: readonly string[] = ['.mp4', '.webm', '.gif', '.png', '.wav'];
export function isPlayableOutput(p: string): boolean {
  const lower = p.toLowerCase();
  return !lower.includes('\0') && !/^[a-z]+:\/\//.test(lower) && PLAYABLE_EXTENSIONS.some((e) => lower.endsWith(e));
}

/**
 * Hosts `openExternal` may open in the system browser (Purchase / licence help). HTTPS only; everything else is refused.
 * The Operator sets the real storefront host before release (LICENSE_OPERATIONS §11); `expertmotion.app` is a placeholder.
 */
export const EXTERNAL_HOSTS: readonly string[] = ['expertmotion.app'];
export function isAllowedExternal(url: string, hosts: readonly string[] = EXTERNAL_HOSTS): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)); } catch { return false; }
}
export type BridgeKey = (typeof BRIDGE_KEYS)[number];

/** Error codes used by the Shell (ERROR_CATALOGUE.md §6.6, §6.8). */
export const EM = {
  storageUnavailable: 'EM-6001',
  serviceRestarting: 'EM-8001',
  serviceFailed: 'EM-8002',
  serviceRestarted: 'EM-8003',
  integrityFailed: 'EM-8007',
  rendererCrashed: 'EM-8008',
  editorError: 'EM-8009',
  gpuCrashed: 'EM-8010',
  safeGraphics: 'EM-8011',
  displayStalled: 'EM-8012',
  diagnosticReportFailed: 'EM-8013',
  updateCheckFailed: 'EM-8101',
  updateDownloadFailed: 'EM-8102',
  updateNotTrusted: 'EM-8103',
  updateInterrupted: 'EM-8104',
  updateAvailable: 'EM-8105',
  alreadyRunning: 'EM-8301',
  folderNotAllowed: 'EM-8302',
  openFolderFailed: 'EM-8303',
  renderRunning: 'EM-8304',
} as const;
export type ShellErrorCode = (typeof EM)[keyof typeof EM];
