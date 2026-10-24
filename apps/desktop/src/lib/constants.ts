/**
 * Constants of the Desktop Shell. Pure module: no `electron` import (unit-tested on Linux).
 * Every value cites the document that owns it; change the document first (AGENTS.md §3.1).
 */

/** Custom scheme and host serving the built Editor (SECURITY.md SEC-025). */
export const APP_SCHEME = 'app';
export const APP_HOST = 'expertmotion';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}` as const;

/** Loopback port range and retry budget for the Local Service (SEC-008, TRD TR-003). */
export const PORT_RANGE = { min: 47600, max: 47699 } as const;
export const PORT_MAX_ATTEMPTS = 10;

/** Supervisor restart backoff: 1 s, 3 s, 9 s, then EM-8002 (ARCHITECTURE.md §5 step 6, DEPLOYMENT §14). */
export const RESTART_BACKOFF_MS = [1000, 3000, 9000] as const;
/** A Service that stayed up this long is considered healthy again and the restart budget resets. */
export const RESTART_BUDGET_RESET_MS = 5 * 60 * 1000;
/** How long the Shell waits for `{type:'ready'}` after the fork. Migrations may run here. */
export const READY_TIMEOUT_MS = 60_000;

/** Close flow (ARCHITECTURE.md §5 step 5). */
export const SHUTDOWN_REQUEST_WAIT_MS = 5_000;
export const SHUTDOWN_KILL_AFTER_MS = 10_000;

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
  serviceState: 'em:service-state',
} as const;
export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/**
 * The complete key set of `window.expertmotion` (SEC-003, SEC-031). A test enumerates it.
 * `pickSavePath` is the save dialog required by the Desktop Shell brief; see README "Bridge surface".
 */
export const BRIDGE_KEYS = ['getBootstrap', 'pickFiles', 'pickFolder', 'pickSavePath', 'openFolder', 'onServiceState'] as const;
export type BridgeKey = (typeof BRIDGE_KEYS)[number];

/** Error codes used by the Shell (ERROR_CATALOGUE.md §6.6, §6.8). */
export const EM = {
  storageUnavailable: 'EM-6001',
  serviceRestarting: 'EM-8001',
  serviceFailed: 'EM-8002',
  serviceRestarted: 'EM-8003',
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
