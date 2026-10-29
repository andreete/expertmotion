/**
 * Desktop Shell main process (ARCHITECTURE.md §3, §5; SECURITY.md SEC-001…033, SEC-040, SEC-090…104).
 *
 * Responsibilities (all orchestration; no business logic — that is the Local Service's job):
 *   - single-instance lock (DEPLOYMENT §8 task 1)
 *   - Database Key keyring: generate 32 random bytes on first run, wrap with safeStorage (DPAPI / Keychain / Secret Service)
 *     into data/keyring.bin, unwrap on start; refuse with EM-6001 if unavailable or, on Linux, basic_text (SEC-040)
 *   - per-launch 256-bit Service Token (SEC-001)
 *   - free loopback port 42300–42399 (SEC-008)
 *   - start the Local Service with utilityProcess.fork and postMessage bootstrap (SEC-002)
 *   - supervise with restart backoff 1/3/9 s, max 3 (SEC-033)
 *   - graceful close via POST /service/shutdown then {type:'shutdown'} then kill (SEC §5 step 5)
 *   - hardened BrowserWindow + app:// protocol + CSP + navigation/permission locks (SEC-020…031)
 *   - native dialogs over IPC with sender validation (SEC-030)
 *   - crash/diagnostic logs with secret redaction (SEC-100…104)
 *   - electron-updater wiring, disabled in Private Mode (SEC-090…096)
 *   - startup phases for the Editor splash (FR-184) and Editor window recovery: crash / hang / failed load (FR-185)
 *   - black-window defences that need no working renderer (FR-196…FR-199): GPU-crash handling + safe graphics mode, the
 *     crash-loop guard (clean-shutdown marker), the heartbeat watchdog with its native dialog, renderer console capture,
 *     Ctrl+R / F5 / Ctrl+Shift+L, the tray recovery menu, the native diagnostic report (`--diagnostics`), GPU info + timings
 *
 * The decision logic is in ./lib/* (pure, unit-tested on Linux). This file wires Electron to it.
 * Electron cannot run on the Linux dev server, so this file is typecheck-only here; see README.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, powerMonitor, protocol, safeStorage, screen, session, shell, Tray, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { autoUpdater } from 'electron-updater';
import { randomBytes, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { redact, redactLiterals } from '@expertmotion/shared';
import {
  APP_HOST, APP_ORIGIN, APP_SCHEME, EM, IPC, isAllowedExternal, isPlayableOutput, READY_TIMEOUT_MS, type UpdateAction, SHELL_CALLER_HEADER, SHELL_CALLER_VALUE,
  SHELL_METRICS_MS, SHUTDOWN_KILL_AFTER_MS, SHUTDOWN_REQUEST_WAIT_MS,
} from './lib/constants.js';
import { pickPort } from './lib/port.js';
import { MIN_HEIGHT, MIN_WIDTH, restoreBounds, settingsWithWindow, windowStateFromSettings, type WindowState } from './lib/window-state.js';
import { initialRestartState, onFailure, onReady, type RestartState } from './lib/backoff.js';
import { buildCsp } from './lib/csp.js';
import { resolveAppUrl } from './lib/protocol.js';
import { isTrustedSender } from './lib/ipc.js';
import { appMenuTemplate, showMenuBar } from './lib/window-chrome.js';
import { buildServiceEnv } from './lib/child-env.js';
import { IpcPath, OpenUrlArg, parseIpc, PickFilesArgs, PickFolderArgs, PickSaveArgs, UpdateActionArg } from './lib/ipc-schemas.js';
import { decideOpenSource, OPEN_SOURCE_REFUSED, type OpenSourceResult } from './lib/open-source.js';
import { crashFileName, dataLayout, directoriesToCreate, type DataLayout } from './lib/data-dir.js';
import { createRotatingLog, pruneOldLogs, type RotatingLog } from './lib/log-file.js';
import { editorEntryUrl, resolveDevRules, type DevRules } from './lib/dev-mode.js';
import { buildBootstrap, buildMetrics, parseServiceMessage, shutdownMessage } from './lib/bootstrap.js';
import { evaluateKeyring, keyringRefusalMessage, quarantineTargets, storageLockedDialog, unwrapDbKey } from './lib/keyring.js';
import { DOWNLOAD_RETRY_MS, downloadDecision, installDecision, nextUpdateState, parsePendingUpdate, pausedBannerAllowed, pendingUpdateOutcome, planUpdateCheck, updaterConfig, UPDATE_TICK_MS, type PrivateModeState, type UpdateEvent, type UpdateState } from './lib/updater-policy.js';
import { RENDER_RUNNING_DIALOG, choiceFromButton, parseShutdownResponse, remainingMs, type ShutdownAnswer } from './lib/close-flow.js';
import { verifyManifest, type SignedManifest } from './lib/integrity.js';
import { allowPermission, originOf } from './lib/permissions.js';
import { createPhaseTimer, shouldPushProgress, startingPush, type ServiceStatePush } from './lib/startup.js';
import { hashManifestFiles, sha256File as streamSha256 } from './lib/integrity-hash.js';
import {
  didFailLoadEntry, goneChoice, initialCrashState, onRendererGone, RENDERER_GONE_DIALOG, UNRESPONSIVE_DIALOG, unresponsiveChoice, type CrashState,
} from './lib/renderer-recovery.js';
import { consoleLogEntry, createCountingLimiter, createRateLimiter, rendererLogFields } from './lib/renderer-log.js';
import {
  cleanMarker, decideStartup, defaultGraphicsState, disableSafeMode, enableSafeMode, initialGpuCrashState, onChildProcessGone, parseGraphicsState,
  parseSessionMarker, runningMarker, safeModeChoice, safeModeDialog, type GpuCrashState, type GraphicsState, type SafeModeReason, type SessionMarker, type StartupDecision,
} from './lib/graphics-mode.js';
import {
  displayStallDialog, initialWatchState, onBeat, onLoadStart, onSignal, onTick, parseBeat, parseSignal, stallChoice, WATCHDOG_TICK_MS, type StallKind, type WatchState,
} from './lib/heartbeat.js';
import { buildReportEntries, createZip, DIAGNOSTICS_SWITCH, gpuLogFields, readSmallJson, reportFileName, summarizeGpuInfo } from './lib/diagnostic-report.js';
import { createDebounce, recoveryKey, reportFailedDialog, reportSavedDialog, trayItems, type RecoveryAction, type TrayAction } from './lib/escape-hatches.js';

/** Build-time constants injected by esbuild `define` (see scripts/build-main.mjs). */
declare const __EM_FEED_URL__: string;
declare const __EM_ENGINE_PUBLIC_KEY_B64__: string;
declare const __EM_PROMPT_HALF_B__: string;
const PROMPT_HALF_B = typeof __EM_PROMPT_HALF_B__ === 'string' ? __EM_PROMPT_HALF_B__ : '';

const FEED_URL = typeof __EM_FEED_URL__ === 'string' ? __EM_FEED_URL__ : 'https://updates.expertmotion.invalid/win';

// ---------------------------------------------------------------------------------------------
// Logging with redaction (SEC-100). Every line passes through `redact` before it touches disk.
// ---------------------------------------------------------------------------------------------
let shellLog: RotatingLog | null = null;    // logs/shell-YYYY-MM-DD.log, 20 MB cap, 7 days (SEC-101)
let liveServiceToken: string | null = null;  // SEC-016 (round 2): redacted literally from every Shell log line
function logLine(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  const line = redactLiterals(redact(JSON.stringify({ ts: new Date().toISOString(), level, component: 'shell', msg, ...extra })), [liveServiceToken]);
  if (level === 'error') console.error(line);
  else console.log(line);
  shellLog?.write(line);
}

function timestamp(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------------------------
// App-wide state.
// ---------------------------------------------------------------------------------------------
interface Endpoint { port: number; token: string }

let layout: DataLayout;
let devRules: DevRules;
let endpoint: Endpoint | null = null;
let dbKeyHex: string | null = null;
let serviceProc: UtilityProcess | null = null;
let metricsTimer: NodeJS.Timeout | null = null;
let restartState: RestartState = initialRestartState;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastUpdateCheckAt: number | null = null;
let updateState: UpdateState = { status: 'idle' };
let updateStage: 'check' | 'download' | 'install' = 'check';
let updateTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
/** Shell start time: the splash's elapsed seconds count from here (FR-184). */
const shellStartedAt = Date.now();
let crashState: CrashState = initialCrashState;
/** FR-185: at most 20 Editor error lines per minute reach the Shell log. */
const rendererLogAllowed = createRateLimiter(20, 60_000);
/** FR-198: at most 30 renderer console warnings / errors per minute; the next allowed line says how many were dropped. */
const consoleLogAllowed = createCountingLimiter(30, 60_000);
/** FR-196 / FR-197: graphics mode of this launch, decided in boot() before app ready. */
let graphicsState: GraphicsState = { ...defaultGraphicsState };
let startupDecision: StartupDecision | null = null;
let gpuCrashState: GpuCrashState = initialGpuCrashState;
let sessionMarker: SessionMarker | null = null;
/** FR-198 heartbeat watchdog state of the Editor window. */
let watch: WatchState = initialWatchState;
/** One recovery dialog at a time (renderer gone, hang, display stall): the open one, abortable. */
let recoveryDialog: { kind: 'gone' | 'unresponsive' | 'display'; ctl: AbortController } | null = null;
/** A renderer killed on purpose (recovery reload) must not count as a crash. */
let expectRendererGone = false;
/** Startup phase timings (FR-196), logged once. */
const phases = createPhaseTimer(shellStartedAt);
let phasesLogged = false;
const keyDebounce = createDebounce();
const triedPorts = new Set<number>();
const stderrTail: string[] = [];

// ---------------------------------------------------------------------------------------------
// Keyring: unwrap or create the Database Key (SEC-040).
// ---------------------------------------------------------------------------------------------
function createDbKey(): string {
  const key = randomBytes(32).toString('hex');
  writeFileSync(layout.keyring, safeStorage.encryptString(key), { mode: 0o600 });
  logLine('info', 'created new Database Key keyring');
  return key;
}

/**
 * Unwraps (or creates) the Database Key. A `decryptString` failure — the data folder was copied from another Windows account,
 * or DPAPI lost its master key (FR-176) — is EM-6001: the Editor shows `sys.fatal` and the native dialog offers Restore backup,
 * which moves the locked files aside (never deletes them) and starts with empty storage so a backup zip can be restored.
 * Resolves null when the Creator chose Quit.
 */
async function acquireDbKey(): Promise<{ keyHex: string; restoreBackup: boolean } | null> {
  const facts = {
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
    platform: process.platform,
  };
  const gate = evaluateKeyring(facts);
  if (!gate.ok) {
    logLine('error', 'keyring unavailable', { code: gate.code, reason: gate.reason, backend: facts.backend });
    pushServiceState({ status: 'failed', code: gate.code, logsDir: layout.logs });
    fatalDialog(gate.code, keyringRefusalMessage(gate, facts));
    exitApp(1);
    return null;
  }
  if (!existsSync(layout.keyring)) return { keyHex: createDbKey(), restoreBackup: false };
  const unwrapped = unwrapDbKey(readFileSync(layout.keyring), (b) => safeStorage.decryptString(Buffer.from(b)));
  if (unwrapped.ok) return { keyHex: unwrapped.keyHex, restoreBackup: false };
  logLine('error', 'keyring unwrap failed', { code: unwrapped.code, reason: unwrapped.reason });
  pushServiceState({ status: 'failed', code: unwrapped.code, logsDir: layout.logs });
  const locked = storageLockedDialog(process.platform);
  const opts = { type: 'error' as const, ...locked, buttons: [...locked.buttons] };
  const { response } = mainWindow !== null ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts);
  if (response !== 0) { app.quit(); return null; }
  const ts = timestamp();
  for (const { from, to } of quarantineTargets({ keyring: layout.keyring, db: join(layout.data, 'expertmotion.db') }, ts)) {
    try { if (existsSync(from)) renameSync(from, to); } catch (err) { logLine('error', 'quarantine failed', { code: unwrapped.code, error: (err as Error).message }); }
  }
  logLine('warn', 'locked storage moved aside; starting empty storage for Restore backup', { code: unwrapped.code, suffix: `unreadable-${ts}` });
  return { keyHex: createDbKey(), restoreBackup: true };
}

function fatalDialog(code: string, detail: string): void {
  dialog.showErrorBox('Expertmotion', `${code}\n\n${detail}`);
}

// ---------------------------------------------------------------------------------------------
// Local Service supervision (SEC-002, SEC-008, SEC-033).
// ---------------------------------------------------------------------------------------------
function serviceModulePath(): string {
  // Packaged: resources/app.asar/dist/service/service.cjs (loader for service.jsc when hardened).
  // Dev: built file under the repo. process.resourcesPath points at the install resources dir.
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar', 'dist', 'service', 'service.cjs')
    : join(app.getAppPath(), 'dist', 'service', 'service.cjs');
}

/** Scrubbed environment for the utility process (SEC-065): system-only PATH, no EM_* leakage, no proxies (lib/child-env.ts). */
function serviceEnv(): NodeJS.ProcessEnv {
  return buildServiceEnv(process.env, { platform: process.platform, packaged: app.isPackaged });
}

async function startService(): Promise<void> {
  if (dbKeyHex === null) throw new Error('Database Key not loaded');
  const port = await pickPort({ exclude: triedPorts });
  const token = randomBytes(32).toString('base64url');
  endpoint = { port, token }; liveServiceToken = token;

  const proc = utilityProcess.fork(serviceModulePath(), [], {
    serviceName: 'Expertmotion Helper',
    env: serviceEnv(),
    stdio: 'pipe',
  });
  serviceProc = proc;

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = redact(chunk.toString('utf8'));
    for (const l of text.split('\n')) if (l.trim() !== '') { stderrTail.push(l); if (stderrTail.length > 200) stderrTail.shift(); }
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ready timeout')), READY_TIMEOUT_MS);
    proc.on('message', (raw: unknown) => {
      const msg = parseServiceMessage(raw);
      if (msg === null) return;
      if (msg.type === 'ready') { clearTimeout(timer); resolve(); }
      else if (msg.type === 'fatal') { clearTimeout(timer); reject(new Error(`service fatal ${msg.code}`)); }
    });
  });

  proc.postMessage(buildBootstrap({ token, port, dataDir: layout.root, dbKeyHex, promptKeyHalf: PROMPT_HALF_B, videosDir: videosFolder() }));
  proc.on('exit', (code) => onServiceExit(code));

  try {
    await ready;
    restartState = onReady(restartState, Date.now());
    logLine('info', 'service ready', { port });
    phases.mark('service-ready', Date.now());
    maybeLogPhases();
    pushServiceState({ status: 'ready', bootstrap: { port, token }, logsDir: layout.logs });   // FR-202: the crash card's "Buka folder log"
    startMetrics(proc);
  } catch (err) {
    logLine('error', 'service failed to become ready', { error: (err as Error).message });
    triedPorts.add(port);
    scheduleRestart();
  }
}

/** FR-127: push the Shell's process memory to the Service every 30 s (app.getAppMetrics is in-process; no spawn). */
function startMetrics(proc: UtilityProcess): void {
  if (metricsTimer) clearInterval(metricsTimer);
  const push = () => { try { if (serviceProc === proc) proc.postMessage(buildMetrics(app.getAppMetrics(), proc.pid)); } catch { /* service gone */ } };
  push();
  metricsTimer = setInterval(push, SHELL_METRICS_MS);
  metricsTimer.unref();
}

function onServiceExit(code: number): void {
  if (shuttingDown) return;
  logLine('warn', 'service exited', { code });
  pushServiceState({ status: 'offline', code: EM.serviceRestarting });
  scheduleRestart();
}

function scheduleRestart(): void {
  const decision = onFailure(restartState, Date.now());
  if (decision.action === 'give-up') {
    logLine('error', 'service gave up after retries', { attempts: decision.attempts, exitTail: stderrTail.slice(-5) });
    writeCrashFile('service', `service failed to start ${decision.attempts} times\n${stderrTail.join('\n')}`);
    pushServiceState({ status: 'failed', code: EM.serviceFailed, logsDir: layout.logs });
    // FR-171: the Editor shows EM-8002 with Open Diagnostics (sys.fatal); the native box is only the fallback without a window.
    if (mainWindow === null) fatalDialog(EM.serviceFailed, 'The background service failed to start. Open Diagnostics or restart your computer.');
    return;
  }
  restartState = decision.state;
  logLine('info', 'scheduling service restart', { attempt: decision.attempt, delayMs: decision.delayMs });
  setTimeout(() => { void startService(); }, decision.delayMs);
}

// ---------------------------------------------------------------------------------------------
// Graceful shutdown (ARCHITECTURE.md §5 step 5).
// ---------------------------------------------------------------------------------------------
async function shutdownService(reason: 'window-closed' | 'update' | 'uninstall'): Promise<'stopped' | 'kept'> {
  shuttingDown = true;
  const proc = serviceProc;
  if (proc === null || endpoint === null) return 'stopped';
  let deadline = Date.now() + SHUTDOWN_KILL_AFTER_MS;
  try {
    let answer = await requestServiceShutdown(reason, false);
    // FR-002: a render is running (409 EM-8304): ask, then retry with force, or keep the Service and reopen the Editor.
    if (answer.kind === 'render-running') {
      const { response } = await dialog.showMessageBox({ type: 'warning', ...RENDER_RUNNING_DIALOG, buttons: [...RENDER_RUNNING_DIALOG.buttons] });
      if (choiceFromButton(response) === 'keep') {
        shuttingDown = false;
        logLine('info', 'close cancelled: keep rendering');
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        return 'kept';
      }
      deadline = Date.now() + SHUTDOWN_KILL_AFTER_MS;          // FR-002: "Cancel and close" exits within 5 s of the choice
      answer = await requestServiceShutdown(reason, true, remainingMs(deadline, Date.now()));
    }
    if (answer.kind === 'failed') logLine('warn', 'shutdown request refused', { status: answer.status });
  } catch (err) {
    logLine('warn', 'shutdown request failed', { error: (err as Error).message });
  }
  proc.postMessage(shutdownMessage);
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => { proc.kill(); resolve(); }, remainingMs(deadline, Date.now()));
    proc.once('exit', () => { clearTimeout(killTimer); resolve(); });
  });
  serviceProc = null;
  return 'stopped';
}

/** Asks the Service to checkpoint and stop (POST /service/shutdown, trusted-caller header); `force` cancels a running render. */
function requestServiceShutdown(reason: string, force: boolean, waitMs: number = SHUTDOWN_REQUEST_WAIT_MS): Promise<ShutdownAnswer> {
  if (endpoint === null) return Promise.resolve({ kind: 'accepted' });
  const { port, token } = endpoint;
  return new Promise<ShutdownAnswer>((resolve, reject) => {
    const request = net.request({ method: 'POST', url: `http://127.0.0.1:${port}/api/v1/service/shutdown`, useSessionCookies: false });
    request.setHeader('Authorization', `Bearer ${token}`);
    request.setHeader(SHELL_CALLER_HEADER, SHELL_CALLER_VALUE);
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Origin', APP_ORIGIN);
    const timer = setTimeout(() => { request.abort(); reject(new Error('shutdown timeout')); }, Math.max(1, waitMs));
    request.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { if (chunks.length < 16) chunks.push(c); });
      res.on('end', () => { clearTimeout(timer); resolve(parseShutdownResponse(res.statusCode, Buffer.concat(chunks).toString('utf8'))); });
    });
    request.on('error', (e) => { clearTimeout(timer); reject(e); });
    request.end(JSON.stringify({ reason, timeoutMs: Math.max(1000, waitMs), ...(force ? { force: true } : {}) }));
  });
}

// ---------------------------------------------------------------------------------------------
// app:// protocol (SEC-025) with path-traversal protection.
// ---------------------------------------------------------------------------------------------
function registerAppProtocol(): void {
  const root = join(app.getAppPath(), 'dist', 'ui');
  protocol.handle(APP_SCHEME, async (request) => {
    const resolved = resolveAppUrl({ root, url: request.url, sep: process.platform === 'win32' ? '\\' : '/' });
    if (!resolved.ok) return new Response('Not found', { status: 404 });
    try {
      const data = readFileSync(resolved.absolutePath);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': contentType(resolved.relativePath),
          'Content-Security-Policy': buildCsp({ devOrigin: null }),
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------------------------
// BrowserWindow hardening (SEC-020…027, SEC-029).
// ---------------------------------------------------------------------------------------------
// FR-155: bounds live in settings.json (`window` key, ARCHITECTURE §8); the pre-FR-155 data/window-state.json is a read fallback.
function readJson(file: string): unknown { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } }
function readWindowState(): WindowState {
  return windowStateFromSettings(readJson(layout.settings), readJson(join(layout.data, 'window-state.json')));
}
function writeWindowState(win: BrowserWindow): void {
  try {
    const next = settingsWithWindow(readJson(layout.settings), { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    const tmp = `${layout.settings}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, layout.settings);                       // atomic replace: a crash never leaves a half-written settings.json
  } catch { /* best effort */ }
}

function createWindow(): void {
  const saved = readWindowState();
  const win = new BrowserWindow({
    ...restoreBounds(saved, screen.getAllDisplays().map((d) => d.workArea)),
    minWidth: MIN_WIDTH,     // FR-155: 1280×720 minimum
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#0b0b0f',
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });
  mainWindow = win;
  phases.mark('window-created', Date.now());
  // QA 2026-10-25: no native menu bar inside the window on Windows / Linux (the Editor header is the menu). The Edit-roles
  // menu stays attached (Menu.setApplicationMenu in whenReady), so its accelerators keep working while hidden.
  if (!showMenuBar(process.platform)) win.setMenuBarVisibility(false);
  // FR-198: every renderer console warning / error reaches the Shell log (rate-limited, query strings / e-mails removed, redacted).
  win.webContents.on('console-message', (e) => {
    const entry = consoleLogEntry(e.level, e.message, e.sourceId, e.lineNumber);
    if (entry === null) return;
    const gate = consoleLogAllowed(Date.now());
    if (gate.ok) logLine(entry.level, entry.msg, gate.dropped > 0 ? { ...entry.fields, dropped: gate.dropped } : entry.fields);
  });
  win.webContents.on('preload-error', (_e, _path, error) => {
    logLine('error', 'preload error', { code: EM.editorError, error: error.message.slice(0, 500), stack: (error.stack ?? '').split('\n').slice(0, 10).join('\n') });
  });
  // FR-199: recovery keys are read here, in the browser process, before the page sees them: they work on a black window.
  win.webContents.on('before-input-event', (e, input) => {
    const action = recoveryKey(input, process.platform);
    if (action === null) return;
    e.preventDefault();
    runRecovery(action, 'key');
  });

  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${APP_ORIGIN}/`) && !devRules.devOrigins.some((o) => url.startsWith(o))) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  let shown = false;
  const showNow = (why: 'ready-to-show' | 'fallback') => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    phases.mark('window-shown', Date.now());
    if (why === 'fallback') logLine('warn', 'window shown before its first paint', { afterMs: Date.now() - shellStartedAt });
    if (saved.maximized) win.maximize();
    win.show();
    scheduleUpdateCheck();
    maybeNotifySafeMode(win);
  };
  win.once('ready-to-show', () => showNow('ready-to-show'));
  // FR-198: `ready-to-show` needs a first paint; a dead GPU never paints, and a window that never appears looks like
  // "nothing happens" (the Creator starts it again and gets the same). Show it anyway after 10 s; the watchdog then asks.
  const showFallback = setTimeout(() => showNow('fallback'), 10_000);
  showFallback.unref();
  let saveTimer: NodeJS.Timeout | undefined;
  const saveSoon = () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => writeWindowState(win), 500); };
  win.on('resize', saveSoon); win.on('move', saveSoon); win.on('maximize', saveSoon); win.on('unmaximize', saveSoon);
  win.on('close', () => { if (saveTimer) clearTimeout(saveTimer); writeWindowState(win); });
  win.on('closed', () => { clearTimeout(showFallback); if (mainWindow === win) mainWindow = null; });
  // Windows log-off / shutdown with the window open is not a crash (FR-197).
  win.on('session-end', () => { logLine('info', 'windows session ends'); markSessionClean(); });
  win.webContents.on('did-finish-load', () => { phases.mark('did-finish-load', Date.now()); win.webContents.send(IPC.serviceState, lastServiceState); });
  watchRenderer(win);

  watch = onLoadStart(watch, Date.now());
  void win.loadURL(editorEntryUrl(app.isPackaged, process.env));
}

/**
 * FR-185: a crashed, hung or failed Editor never leaves a silent black window. The Local Service keeps running; a reloaded
 * Editor reconnects through getBootstrap and the re-sent service state. Decisions in lib/renderer-recovery.ts.
 * FR-198: the heartbeat watchdog (lib/heartbeat.ts) covers what Electron does not report: a window that is alive but paints
 * nothing (GPU / compositor), a JS thread that stopped beating before `unresponsive`, and no first paint at all.
 * One recovery dialog at a time (`recoveryDialog`); the hang dialog and the display dialog never stack.
 */
function watchRenderer(win: BrowserWindow): void {
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    const entry = didFailLoadEntry(errorCode, errorDescription, validatedURL, isMainFrame);
    if (entry) logLine(entry.level, entry.msg, entry.fields);
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) watch = onLoadStart(watch, Date.now());
  });
  wc.on('render-process-gone', (_e, details) => {
    if (expectRendererGone) { expectRendererGone = false; logLine('info', 'editor renderer restarted for a recovery reload'); return; }
    const decision = onRendererGone(crashState, { reason: details.reason, exitCode: details.exitCode }, Date.now(), shuttingDown);
    if (decision.action === 'ignore') return;
    crashState = decision.state;
    logLine('error', 'editor renderer gone', { code: EM.rendererCrashed, reason: details.reason, exitCode: details.exitCode, action: decision.action });
    writeCrashFile('shell', `renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (win.isDestroyed()) return;
    closeRecoveryDialog();                                                // a stall dialog for a renderer that is gone is moot
    if (decision.action === 'reload') { wc.reload(); return; }
    void askRecovery(win, 'gone', { type: 'error', ...RENDERER_GONE_DIALOG, buttons: [...RENDERER_GONE_DIALOG.buttons] }).then((response) => {
      if (response === null || win.isDestroyed()) return;
      if (goneChoice(response) === 'reload') wc.reload(); else void quitGracefully('renderer-gone-close');
    });
  });
  win.on('unresponsive', () => {
    if (win.isDestroyed()) return;
    logLine('warn', 'editor unresponsive', { code: EM.rendererCrashed });
    if (recoveryDialog !== null) return;                                  // one dialog per episode, never two at once
    void askRecovery(win, 'unresponsive', { type: 'warning', ...UNRESPONSIVE_DIALOG, buttons: [...UNRESPONSIVE_DIALOG.buttons] }).then((response) => {
      if (response === null || win.isDestroyed()) return;
      const choice = unresponsiveChoice(response);
      logLine('info', 'editor unresponsive choice', { choice });
      if (choice === 'reload') reloadWindow('unresponsive-dialog', true); else if (choice === 'close') void quitGracefully('unresponsive-close');
    });
  });
  win.on('responsive', () => {
    if (recoveryDialog?.kind !== 'unresponsive') return;
    logLine('info', 'editor responsive again');
    closeRecoveryDialog();
  });
  const tick = setInterval(() => {
    if (win.isDestroyed() || shuttingDown || quitting || relaunching) return;   // no stall dialogs while Expertmotion closes
    const r = onTick(watch, { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), dialogOpen: recoveryDialog !== null }, Date.now());
    watch = r.state;
    if (r.decision.action === 'recovered') {
      logLine('info', 'display responsive again', { kind: r.decision.kind, stalledMs: r.decision.stalledMs });
      if (recoveryDialog?.kind === 'display') closeRecoveryDialog();
    } else if (r.decision.action === 'ask') {
      onDisplayStall(win, r.decision.kind, r.decision.stalledMs);
    }
  }, WATCHDOG_TICK_MS);
  tick.unref();
  win.on('closed', () => clearInterval(tick));
}

/** Shows one recovery dialog; resolves the button index, or null when it was dismissed because the cause went away. */
async function askRecovery(win: BrowserWindow, kind: 'gone' | 'unresponsive' | 'display', opts: Electron.MessageBoxOptions): Promise<number | null> {
  closeRecoveryDialog();
  const ctl = new AbortController();
  const entry = { kind, ctl };
  recoveryDialog = entry;
  try {
    const { response } = await dialog.showMessageBox(win, { ...opts, signal: ctl.signal });
    return ctl.signal.aborted ? null : response;
  } catch { return null; } finally { if (recoveryDialog === entry) recoveryDialog = null; }
}
function closeRecoveryDialog(): void {
  const d = recoveryDialog;
  recoveryDialog = null;
  d?.ctl.abort();
}

/** FR-198: the watchdog found a stalled display. Log it (with the window facts), then ask once per episode. */
function onDisplayStall(win: BrowserWindow, kind: StallKind, stalledMs: number): void {
  logLine('error', 'display not responding', {
    code: EM.displayStalled, kind, stalledMs, sinceLoadMs: watch.loadStartedAt === null ? null : Date.now() - watch.loadStartedAt,
    firstPaint: watch.firstPaintAt !== null, mounted: watch.mountedAt !== null, safeGraphics: startupDecision?.safe ?? false,
  });
  writeCrashFile('shell', `display not responding: ${kind} (${stalledMs} ms)`);
  void askRecovery(win, 'display', { type: 'warning', ...displayStallDialog(kind) }).then((response) => {
    if (response === null || win.isDestroyed()) return;
    const choice = stallChoice(response);
    logLine('info', 'display stall choice', { kind, choice });
    if (choice === 'reload') reloadWindow('display-stall', kind === 'no-heartbeat');
    else if (choice === 'safe-mode') void restartWithGraphics(true, 'display-stall');
    else if (choice === 'logs') openLogFolder();
    else if (choice === 'close') void quitGracefully('display-stall-close');
  });
}

/**
 * Recovery reload (keys, tray, dialogs). A hung renderer is killed first (`forcefullyCrashRenderer`, not counted as a crash),
 * otherwise a plain reload; no window at all → a new one. The Local Service is untouched.
 */
function reloadWindow(reason: string, hung?: boolean): void {
  const win = mainWindow;
  if (win === null || win.isDestroyed()) { logLine('info', 'recovery: new window', { reason }); if (app.isReady()) createWindow(); return; }
  const wc = win.webContents;
  const isHung = hung ?? (watch.stalled === 'no-heartbeat' || recoveryDialog?.kind === 'unresponsive');
  logLine('info', 'recovery reload', { reason, hung: isHung, crashed: wc.isCrashed() });
  closeRecoveryDialog();
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  if (isHung && !wc.isCrashed()) { expectRendererGone = true; wc.forcefullyCrashRenderer(); }
  wc.reload();
}

function openLogFolder(): void {
  void shell.openPath(layout.logs).then((err) => { if (err) logLine('warn', 'open log folder failed', { code: EM.openFolderFailed, error: err }); });
}

function runRecovery(action: RecoveryAction, via: 'key' | 'menu'): void {
  if (!keyDebounce(action, Date.now())) return;
  logLine('info', 'recovery action', { action, via });
  if (action === 'reload') reloadWindow(`${via}-reload`); else openLogFolder();
}

function hardenSession(): void {
  const ses = session.defaultSession;
  // SEC-029: everything denied except Local Network Access for the Editor's own origin (it calls the Service on 127.0.0.1).
  const devOrigins = devRules.devOrigins;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const allowed = allowPermission(permission, details.requestingUrl ?? wc.getURL(), { devOrigins });
    if (!allowed) logLine('info', 'permission denied', { permission, origin: originOf(details.requestingUrl ?? wc.getURL()) });
    cb(allowed);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowPermission(permission, requestingOrigin, { devOrigins }));
  ses.setDevicePermissionHandler(() => false);
}

// ---------------------------------------------------------------------------------------------
// IPC handlers (SEC-030, SEC-031). Sender validated; a foreign frame is ignored.
// ---------------------------------------------------------------------------------------------
function senderOk(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const frame = event.senderFrame;
  if (frame === null) return false;
  return isTrustedSender({ url: frame.url, isMainFrame: frame.parent === null }, { devOrigins: devRules.devOrigins });
}

function registerIpc(): void {
  ipcMain.handle(IPC.getBootstrap, (event) => {
    if (!senderOk(event)) return null;
    return endpoint === null ? null : { port: endpoint.port, token: endpoint.token };
  });

  ipcMain.handle(IPC.pickFiles, async (event, raw: unknown) => {
    const options = parseIpc(PickFilesArgs, raw);                       // SEC-030: Zod-validated arguments
    if (!senderOk(event) || mainWindow === null || options === null) return [];
    const dialogOptions: Electron.OpenDialogOptions = {
      properties: options.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
    };
    if (options.filters !== undefined) dialogOptions.filters = options.filters;
    const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(IPC.pickFolder, async (event, raw: unknown) => {
    const options = parseIpc(PickFolderArgs, raw);
    if (!senderOk(event) || mainWindow === null || options === null) return null;
    const dialogOptions: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    if (options.defaultPath !== undefined) dialogOptions.defaultPath = options.defaultPath;
    const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
  });

  ipcMain.handle(IPC.pickSavePath, async (event, raw: unknown) => {
    const options = parseIpc(PickSaveArgs, raw);
    if (!senderOk(event) || mainWindow === null || options === null) return null;
    const dialogOptions: Electron.SaveDialogOptions = {};
    if (options.defaultPath !== undefined) dialogOptions.defaultPath = options.defaultPath;
    if (options.filters !== undefined) dialogOptions.filters = options.filters;
    const result = await dialog.showSaveDialog(mainWindow, dialogOptions);
    return result.canceled || result.filePath === undefined ? null : result.filePath;
  });

  ipcMain.handle(IPC.openFolder, (event, raw: unknown) => {
    const targetPath = IpcPath.safeParse(raw).data;
    if (!senderOk(event) || targetPath === undefined) return;
    shell.showItemInFolder(targetPath);
  });

  ipcMain.handle(IPC.openExternal, async (event, raw: unknown) => {
    const url = OpenUrlArg.safeParse(raw).data;
    if (!senderOk(event) || url === undefined || !isAllowedExternal(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.openSource, async (event, raw: unknown): Promise<OpenSourceResult> => {   // R1: research sources
    if (!senderOk(event)) return { ok: false, code: 'EM-8203', message: OPEN_SOURCE_REFUSED.invalid };
    const d = await decideOpenSource(raw, privateModeOn);
    if (!d.ok) { logLine('info', 'source link refused', { code: d.code }); return d; }
    await shell.openExternal(d.url);
    return { ok: true };
  });

  ipcMain.handle(IPC.openPath, async (event, raw: unknown) => {          // FR-146 Play: rendered media only
    const targetPath = IpcPath.safeParse(raw).data;
    if (!senderOk(event) || targetPath === undefined || !isPlayableOutput(targetPath) || !existsSync(targetPath)) return;
    const err = await shell.openPath(targetPath);
    if (err) logLine('warn', 'open path failed', { code: EM.openFolderFailed });
  });

  // Clipboard (Machine Code, licence key, paths, chat text). Text only, size-capped; reading is limited to licence-key size.
  ipcMain.handle(IPC.copyText, async (event, raw: unknown) => {
    if (!senderOk(event) || typeof raw !== 'string' || raw.length > 65_536) return false;
    await Promise.resolve(clipboard.writeText(raw));                       // Electron 45 clipboard calls may be async
    return (await Promise.resolve(clipboard.readText())) === raw;
  });
  ipcMain.handle(IPC.readClipboardText, async (event) => {
    if (!senderOk(event)) return '';
    const text = await Promise.resolve(clipboard.readText());
    return text.length <= 8_192 ? text : '';
  });

  // FR-185: Editor errors reach the Shell log (validated, rate-limited, capped; logLine redacts secrets and profile paths).
  ipcMain.handle(IPC.logError, (event, raw: unknown) => {
    if (!senderOk(event) || !rendererLogAllowed(Date.now())) return;
    const entry = rendererLogFields(raw);
    if (entry) logLine(entry.level, entry.msg, entry.fields);
  });
  // FR-184: "Coba lagi" after EM-8002 (the supervisor gave up): one more start with a fresh restart budget. Anything else: no-op.
  ipcMain.handle(IPC.retryStartup, (event) => {
    if (!senderOk(event) || lastServiceState.status !== 'failed' || lastServiceState.code !== EM.serviceFailed || dbKeyHex === null) return false;
    logLine('info', 'service start retried by the Creator');
    restartState = initialRestartState;
    triedPorts.clear();
    stderrTail.length = 0;
    pushServiceState(startingPush('service', shellStartedAt, Date.now()));
    void startService();
    return true;
  });

  // FR-198: preload liveness (send-only channels; the sender is checked like every handler, the payload validated).
  ipcMain.on(IPC.heartbeat, (event, raw: unknown) => {
    if (!senderOk(event) || event.sender !== mainWindow?.webContents) return;
    const beat = parseBeat(raw);
    if (beat !== null) watch = onBeat(watch, beat, Date.now());
  });
  ipcMain.on(IPC.rendererSignal, (event, raw: unknown) => {
    if (!senderOk(event) || event.sender !== mainWindow?.webContents) return;
    const sig = parseSignal(raw);
    if (sig === null) return;
    const now = Date.now();
    watch = onSignal(watch, sig, now);
    if (phases.mark(sig.kind, now)) logLine('info', `editor ${sig.kind}`, { sinceStartMs: now - shellStartedAt, ...(sig.atMs !== undefined ? { pageMs: sig.atMs } : {}) });
    maybeLogPhases();
  });

  ipcMain.handle(IPC.getUpdateState, (event) => (senderOk(event) ? updateState : null));
  ipcMain.handle(IPC.updateAction, async (event, raw: unknown) => {
    const action = UpdateActionArg.safeParse(raw).data;
    if (!senderOk(event) || action === undefined) return;
    await onUpdateAction(action);
  });
}

/** Last pushed state, re-sent when the Editor (re)loads so a push before the renderer subscribed is never lost (FR-171). */
let lastServiceState: ServiceStatePush = { status: 'starting' };
/** Set when the Creator chose Restore backup for EM-6001: the next `ready` carries the code so the Editor opens Restore. */
let restoreBackupPending = false;
/** FR-205: the OS Videos folder (Known Folder on Windows, so a OneDrive / D:\\ redirection is followed); undefined when unknown. */
function videosFolder(): string | undefined { try { return app.getPath('videos') || undefined; } catch { return undefined; } }

function pushServiceState(state: ServiceStatePush): void {
  const out = state.status === 'ready' && restoreBackupPending ? { ...state, code: EM.storageUnavailable } : state;
  if (state.status === 'ready') restoreBackupPending = false;
  lastServiceState = out;
  mainWindow?.webContents.send(IPC.serviceState, out);
}

// ---------------------------------------------------------------------------------------------
// Updater (SEC-090…096). Disabled in Private Mode, read from the Local Service settings.
// ---------------------------------------------------------------------------------------------
function setUpdate(e: UpdateEvent): void {
  updateState = nextUpdateState(updateState, e);
  mainWindow?.webContents.send(IPC.updateState, updateState);
}

function configureUpdater(): void {
  // electron-updater reads resources/app-update.yml, which only an electron-builder NSIS publish writes. Test builds and
  // builds without a release feed have none: skip update checks quietly instead of logging EM-8101 every time.
  if (app.isPackaged && !existsSync(join(process.resourcesPath, 'app-update.yml'))) { logLine('info', 'updates disabled: no update feed in this build'); return; }
  updatesEnabled = true;                                 // QA P1 2026-10-29: without a feed nothing about updates is shown
  const cfg = updaterConfig(FEED_URL);
  autoUpdater.autoDownload = cfg.autoDownload;           // FR-152: the Shell starts the background download itself (downloadDecision)
  autoUpdater.allowDowngrade = cfg.allowDowngrade;
  autoUpdater.autoInstallOnAppQuit = false;              // never install behind a running render; restart goes through onUpdateAction
  autoUpdater.channel = cfg.channel;
  autoUpdater.on('checking-for-update', () => setUpdate({ type: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdate({ type: 'none' }));
  autoUpdater.on('error', (err) => { logLine('warn', 'updater error', { code: EM.updateCheckFailed, stage: updateStage, error: err.message }); setUpdate({ type: 'error', message: err.message, stage: updateStage }); });
  autoUpdater.on('update-available', (info) => { logLine('info', 'update available', { code: EM.updateAvailable, version: info.version }); setUpdate({ type: 'available', version: info.version }); void backgroundDownload(); });
  autoUpdater.on('download-progress', (p) => setUpdate({ type: 'progress', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => { logLine('info', 'update downloaded', { code: EM.updateAvailable, version: info.version }); setUpdate({ type: 'downloaded', version: info.version }); });
  // FR-152: check after the Editor is interactive and then every 24 h (the hourly tick lets the policy decide)
  updateTimer = setInterval(scheduleUpdateCheck, UPDATE_TICK_MS);
  updateTimer.unref();
  checkPendingUpdate();
}

// FR-152 / EM-8104: marker written right before quitAndInstall; read once at the next launch.
function pendingUpdateFile(): string { return join(layout.data, 'update-pending.json'); }
function checkPendingUpdate(): void {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(pendingUpdateFile(), 'utf8')); } catch { return; }
  const p = parsePendingUpdate(raw);
  const outcome = pendingUpdateOutcome(p, app.getVersion(), Date.now());
  if (outcome === 'interrupted' && p) {
    logLine('error', 'update was interrupted; previous version kept', { code: EM.updateInterrupted, fromVersion: p.fromVersion, toVersion: p.toVersion });
    setUpdate({ type: 'interrupted', fromVersion: p.fromVersion, toVersion: p.toVersion });
  } else if (outcome === 'applied' && p) logLine('info', 'update applied', { fromVersion: p.fromVersion, version: app.getVersion() });
  try { rmSync(pendingUpdateFile(), { force: true }); } catch { /* best effort */ }
}

/** FR-152: download in the background when allowed (not Private Mode, not metered, no Render Job); otherwise retry later. */
let downloadRetry: NodeJS.Timeout | null = null;
async function backgroundDownload(): Promise<void> {
  if (!app.isPackaged || !updatesEnabled) return;
  if (downloadRetry) { clearTimeout(downloadRetry); downloadRetry = null; }
  const pm = await privateModeState();
  const d = downloadDecision({ privateMode: pm !== 'off', metered: null /* no Electron API; unknown does not block */, renderActive: await renderActive(), status: updateState.status });
  if (d.download) {
    updateStage = 'download';
    try { await autoUpdater.downloadUpdate(); } catch (err) { setUpdate({ type: 'error', message: (err as Error).message, stage: 'download' }); }
    return;
  }
  logLine('info', 'background update download waits', { reason: d.reason });
  if (d.reason === 'private-mode' && pausedBannerAllowed(pm)) { setUpdate({ type: 'paused' }); return; }
  if (d.reason === 'rendering' || d.reason === 'metered' || d.reason === 'private-mode') {   // private-mode here = unknown: ask again later
    downloadRetry = setTimeout(() => { void backgroundDownload(); }, DOWNLOAD_RETRY_MS); downloadRetry.unref();
  }
}

async function renderActive(): Promise<boolean> {
  if (endpoint === null) return false;
  try {
    const [r, q] = await Promise.all([
      getJson<{ total: number }>(`http://127.0.0.1:${endpoint.port}/api/v1/renders?status=rendering&limit=1`),
      getJson<{ total: number }>(`http://127.0.0.1:${endpoint.port}/api/v1/renders?status=queued&limit=1`),
    ]);
    return r.total + q.total > 0;
  } catch { return true; }    // unknown → do not install
}

async function onUpdateAction(action: UpdateAction): Promise<void> {
  if (!app.isPackaged || !updatesEnabled) return;
  if (action === 'check') { lastUpdateCheckAt = null; scheduleUpdateCheck(); return; }
  if (action === 'later') { logLine('info', 'update postponed', { version: updateState.version ?? null }); return; }
  if (action === 'download') {
    const pm = await privateModeState();
    if (pm !== 'off') { if (pausedBannerAllowed(pm)) setUpdate({ type: 'paused' }); return; }
    updateStage = 'download';
    try { await autoUpdater.downloadUpdate(); } catch (err) { setUpdate({ type: 'error', message: (err as Error).message, stage: 'download' }); }
    return;
  }
  // restart: never while a Render Job runs (FR-152); poll until the queue is empty
  const decision = installDecision({ renderActive: await renderActive(), downloaded: updateState.status === 'downloaded' || updateState.status === 'deferred' });
  if (decision === 'nothing') return;
  if (decision === 'defer') {
    setUpdate({ type: 'deferred' });
    const h = setInterval(() => { void renderActive().then((busy) => { if (!busy) { clearInterval(h); setUpdate({ type: 'resumed' }); void onUpdateAction('restart'); } }); }, 15_000);
    h.unref();
    return;
  }
  updateStage = 'install';
  try { writeFileSync(pendingUpdateFile(), JSON.stringify({ fromVersion: app.getVersion(), toVersion: updateState.version ?? '', at: Date.now() })); } catch { /* best effort */ }
  await shutdownService('update').catch(() => undefined);
  markSessionClean();
  autoUpdater.quitAndInstall(false, true);
}

/** Private Mode as far as the Shell knows: `unknown` before the Service is ready or when its settings cannot be read. */
async function privateModeState(): Promise<PrivateModeState> {
  if (endpoint === null || lastServiceState.status !== 'ready') return 'unknown';
  try {
    const settings = await getJson<{ privateMode: boolean }>(`http://127.0.0.1:${endpoint.port}/api/v1/settings`);
    return settings.privateMode === true ? 'on' : 'off';
  } catch {
    return 'unknown';
  }
}
/** Outbound gate (fail closed): anything but a confirmed "off" blocks. Never used to tell the Creator Private Mode is on. */
async function privateModeOn(): Promise<boolean> { return (await privateModeState()) !== 'off'; }

function getJson<T>(url: string): Promise<T> {
  if (endpoint === null) return Promise.reject(new Error('no endpoint'));
  const token = endpoint.token;
  return new Promise<T>((resolve, reject) => {
    const req = net.request({ method: 'GET', url });
    req.setHeader('Authorization', `Bearer ${token}`);
    req.setHeader('Origin', APP_ORIGIN);
    let body = '';
    req.on('response', (res) => { res.on('data', (c: Buffer) => { body += c.toString('utf8'); }); res.on('end', () => { try { resolve(JSON.parse(body) as T); } catch (e) { reject(e as Error); } }); });
    req.on('error', reject);
    req.end();
  });
}

/** false until configureUpdater found an update feed (app-update.yml); a retry timer while Private Mode is still unknown. */
let updatesEnabled = false;
let updateCheckRetry: NodeJS.Timeout | null = null;
function scheduleUpdateCheck(): void {
  if (!app.isPackaged || !updatesEnabled) return;     // QA P1 2026-10-29: no feed → no check, no banner
  void (async () => {
    const decision = planUpdateCheck({ feed: updatesEnabled, privateMode: await privateModeState(), lastCheckAt: lastUpdateCheckAt, editorInteractive: true, now: Date.now() });
    if (!decision.check) {
      logLine('info', 'update check skipped', { reason: decision.reason });
      if (decision.banner === 'paused') setUpdate({ type: 'paused' });
      if (decision.retryMs !== undefined && !updateCheckRetry) { updateCheckRetry = setTimeout(() => { updateCheckRetry = null; scheduleUpdateCheck(); }, decision.retryMs); updateCheckRetry.unref(); }
      return;
    }
    lastUpdateCheckAt = Date.now();
    updateStage = 'check';
    try { await autoUpdater.checkForUpdates(); } catch (err) { logLine('warn', 'update check failed', { code: EM.updateCheckFailed, error: (err as Error).message }); }
  })();
}

// ---------------------------------------------------------------------------------------------
// Tray (ARCHITECTURE.md §3: tray icon menu).
// ---------------------------------------------------------------------------------------------
function createTray(): void {
  try {
    tray = new Tray(join(app.getAppPath(), 'build', 'tray.png'));
    tray.setToolTip(startupDecision?.safe ? 'Expertmotion (mode grafis aman)' : 'Expertmotion');
    // FR-199: the tray menu works while the window is black or hung (it is drawn by the OS, not the renderer).
    const run = (action: TrayAction) => () => onTrayAction(action);
    tray.setContextMenu(Menu.buildFromTemplate(trayItems(startupDecision?.safe ?? false).map((i) => (i === null ? { type: 'separator' as const } : { label: i.label, click: run(i.action) }))));
    tray.on('click', () => onTrayAction('show'));
  } catch (err) {
    logLine('warn', 'tray unavailable', { error: (err as Error).message });
  }
}

function onTrayAction(action: TrayAction): void {
  if (action !== 'show') logLine('info', 'tray action', { action });
  switch (action) {
    case 'show':
      if (mainWindow === null || mainWindow.isDestroyed()) { if (app.isReady()) createWindow(); return; }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
      return;
    case 'reload': reloadWindow('tray'); return;
    case 'safe-graphics-on': void restartWithGraphics(true, 'user'); return;
    case 'safe-graphics-off': void restartWithGraphics(false, 'user'); return;
    case 'open-logs': openLogFolder(); return;
    case 'diagnostics': void saveDiagnosticReport('tray'); return;
    case 'quit': void quitGracefully('tray-quit'); return;
  }
}

// ---------------------------------------------------------------------------------------------
// Crash files (SEC-104): written locally, never uploaded.
// ---------------------------------------------------------------------------------------------
function writeCrashFile(proc: 'shell' | 'service', detail: string): void {
  try {
    const file = join(layout.logs, crashFileName(proc, timestamp()));
    writeFileSync(file, redact(`${new Date().toISOString()}\n${detail}\n`), { mode: 0o600 });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------------------------
// Safe graphics mode, clean-shutdown marker, GPU crashes (FR-196, FR-197; lib/graphics-mode.ts).
// ---------------------------------------------------------------------------------------------
const graphicsFile = (): string => join(layout.data, 'graphics.json');
const sessionFile = (): string => join(layout.data, 'session.json');
const gpuInfoFile = (): string => join(layout.data, 'gpu-info.json');

/** Atomic small JSON write (tmp + rename); never throws. */
function writeJsonAtomic(file: string, value: unknown): void {
  try { const tmp = `${file}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(tmp, file); } catch (err) { logLine('warn', 'state file write failed', { file: file.split(/[\\/]/).pop(), error: (err as Error).message }); }
}

/** Runs in boot() before app ready: reads the marker + graphics state, decides, persists, disables the GPU when needed. */
function decideGraphicsMode(): void {
  const previous = parseSessionMarker(readJson(sessionFile()));
  const decision = decideStartup({ graphics: parseGraphicsState(readJson(graphicsFile())), previous, now: Date.now(), argv: process.argv });
  startupDecision = decision;
  graphicsState = decision.next;
  writeJsonAtomic(graphicsFile(), graphicsState);
  sessionMarker = runningMarker(Date.now(), app.getVersion(), decision.safe);
  writeJsonAtomic(sessionFile(), sessionMarker);
  if (decision.events.includes('previous-abnormal')) logLine('warn', 'previous session did not shut down cleanly', { previousStartedAt: previous ? new Date(previous.startedAt).toISOString() : null, previousVersion: previous?.version ?? null, previousSafeGraphics: previous?.safeGraphics ?? false, streak: decision.next.abnormalStreak });
  if (decision.events.includes('safe-mode-expired')) logLine('info', 'safe graphics mode expired; trying hardware acceleration again');
  if (decision.safe) {
    app.disableHardwareAcceleration();
    logLine('warn', 'safe graphics mode on (hardware acceleration disabled)', { code: EM.safeGraphics, reason: decision.reason, since: graphicsState.since ? new Date(graphicsState.since).toISOString() : null, events: decision.events });
  } else logLine('info', 'graphics mode', { mode: 'hardware' });
}

function markSessionClean(): void {
  if (sessionMarker === null || sessionMarker.state === 'clean') return;
  sessionMarker = cleanMarker(sessionMarker);
  writeJsonAtomic(sessionFile(), sessionMarker);
}

/** Every deliberate exit goes through here so it is never counted as a crash (FR-197). */
function exitApp(code: number): void {
  markSessionClean();
  app.exit(code);
}

/** Persists the graphics mode and restarts Expertmotion (the Service is stopped gracefully first). */
async function restartWithGraphics(safe: boolean, reason: SafeModeReason): Promise<void> {
  graphicsState = safe ? enableSafeMode(graphicsState, reason, Date.now()) : disableSafeMode();
  writeJsonAtomic(graphicsFile(), graphicsState);
  logLine('warn', safe ? 'restarting in safe graphics mode' : 'restarting with hardware acceleration', { code: EM.safeGraphics, reason });
  await relaunch();
}

let relaunching = false;
async function relaunch(): Promise<void> {
  if (relaunching) return;
  relaunching = true;
  closeRecoveryDialog();
  const hard = setTimeout(() => { app.relaunch({ args: relaunchArgs() }); exitApp(0); }, 15_000);
  hard.unref();
  if (mainWindow !== null && !mainWindow.isDestroyed()) writeWindowState(mainWindow);
  const r = await shutdownService('window-closed').catch(() => 'stopped' as const);
  if (r === 'kept') { relaunching = false; clearTimeout(hard); return; }   // a render is running and the Creator kept it
  clearTimeout(hard);
  app.relaunch({ args: relaunchArgs() });
  exitApp(0);
}
const relaunchArgs = (): string[] => process.argv.slice(1).filter((a) => a !== '--safe-graphics' && a !== DIAGNOSTICS_SWITCH);

/** Quit that works with a hung renderer: stop the Service gracefully, then exit (no `beforeunload` round trip). */
let quitting = false;
async function quitGracefully(reason: string): Promise<void> {
  if (quitting) return;
  quitting = true;
  logLine('info', 'quit', { reason });
  closeRecoveryDialog();
  const hard = setTimeout(() => { logLine('warn', 'shutdown stalled; exiting'); exitApp(0); }, 20_000);
  if (mainWindow !== null && !mainWindow.isDestroyed()) writeWindowState(mainWindow);
  const r = await shutdownService('window-closed').catch(() => 'stopped' as const);
  if (r === 'kept') { quitting = false; clearTimeout(hard); return; }
  clearTimeout(hard);
  exitApp(0);
}

/** FR-196 rule 1: GPU process crashes (and every other child process that is gone, logged). */
function onChildGone(details: Electron.Details): void {
  const d = { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name, serviceName: details.serviceName };
  const decision = onChildProcessGone(gpuCrashState, d, Date.now(), { shuttingDown: shuttingDown || quitting || relaunching, safeMode: startupDecision?.safe ?? false });
  gpuCrashState = decision.state;
  if (decision.action === 'ignore') return;
  const fields = { type: d.type, reason: d.reason, exitCode: d.exitCode, ...(d.name ? { name: d.name } : {}), ...(d.serviceName ? { serviceName: d.serviceName } : {}) };
  if (decision.action === 'log') { logLine('warn', 'child process gone', fields); return; }
  logLine('error', 'gpu process gone', { code: EM.gpuCrashed, ...fields, crashesIn10Min: decision.crashesInWindow, action: decision.action, safeGraphics: startupDecision?.safe ?? false });
  writeCrashFile('shell', `gpu process gone: ${d.reason} (exit ${d.exitCode}); crashes in 10 min: ${decision.crashesInWindow}; action: ${decision.action}`);
  if (decision.action === 'safe-mode') { void restartWithGraphics(true, 'gpu-crash'); return; }
  // A GPU crash leaves a black but "alive" window: give Chromium a moment to start the new GPU process, then redraw.
  setTimeout(() => reloadWindow('gpu-crash'), 1_500).unref();
}

/** First window in safe graphics mode: say so once (native dialog, Indonesian), offer the way back. */
function maybeNotifySafeMode(win: BrowserWindow): void {
  if (!startupDecision?.notify || graphicsState.mode !== 'safe') return;
  graphicsState = { ...graphicsState, notified: true };
  writeJsonAtomic(graphicsFile(), graphicsState);
  const copy = safeModeDialog(graphicsState.reason ?? 'user');
  void dialog.showMessageBox(win, { type: 'info', ...copy }).then(({ response }) => {
    const choice = safeModeChoice(response);
    logLine('info', 'safe graphics notice', { choice });
    if (choice === 'disable') void restartWithGraphics(false, 'user');
  }).catch(() => undefined);
}

/** FR-196: GPU facts in the Shell log at startup (and gpu-info.json for the `--diagnostics` run, which has no GPU). */
let lastFeatureStatus = '';
let gpuUpdates = 0;
async function logGpuInfo(): Promise<void> {
  let featureStatus: unknown = null;
  try { featureStatus = app.getGPUFeatureStatus(); } catch { /* not available */ }
  let info: unknown = null;
  try {
    info = await Promise.race([app.getGPUInfo('basic'), new Promise((resolve) => { setTimeout(() => resolve(null), 5_000).unref(); })]);
  } catch (err) { logLine('warn', 'gpu info unavailable', { error: (err as Error).message }); }
  const summary = summarizeGpuInfo(info);
  lastFeatureStatus = JSON.stringify(featureStatus);
  logLine('info', 'gpu info', { ...gpuLogFields(summary, featureStatus), safeGraphics: startupDecision?.safe ?? false });
  writeJsonAtomic(gpuInfoFile(), { at: new Date().toISOString(), safeGraphics: startupDecision?.safe ?? false, featureStatus, summary });
}
function onGpuInfoUpdate(): void {
  let fs: unknown = null;
  try { fs = app.getGPUFeatureStatus(); } catch { return; }
  const text = JSON.stringify(fs);
  if (text === lastFeatureStatus || gpuUpdates >= 20) return;               // the event is frequent; log changes only
  lastFeatureStatus = text;
  gpuUpdates += 1;
  logLine('info', 'gpu feature status changed', gpuLogFields(null, fs));
}

function maybeLogPhases(force = false): void {
  if (phasesLogged) return;
  if (!force && !(phases.has('editor-mounted') && phases.has('service-ready'))) return;
  phasesLogged = true;
  logLine('info', 'startup timings', { ms: phases.summary(), safeGraphics: startupDecision?.safe ?? false, complete: !force });
}

// ---------------------------------------------------------------------------------------------
// Native diagnostic report (FR-199, SEC-105; lib/diagnostic-report.ts). Works without the Editor and without the Service.
// ---------------------------------------------------------------------------------------------
async function systemFacts(live: boolean): Promise<Record<string, unknown>> {
  let featureStatus: unknown = null;
  let gpu: unknown = null;
  if (live) {
    try { featureStatus = app.getGPUFeatureStatus(); } catch { /* none */ }
    try { gpu = summarizeGpuInfo(await Promise.race([app.getGPUInfo('basic'), new Promise((resolve) => { setTimeout(() => resolve(null), 3_000).unref(); })])); } catch { /* none */ }
  }
  const c = cpus();
  return {
    createdAt: new Date().toISOString(),
    app: { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    os: { platform: process.platform, arch: arch(), release: release(), locale: app.getLocale() },
    cpu: { model: c[0]?.model ?? null, count: c.length },
    ramTotalMb: Math.round(totalmem() / 1048576),
    enginesPlatform: app.isPackaged ? readSmallJson(join(process.resourcesPath, 'engines', 'PLATFORM.json')) : null,
    graphics: { ...graphicsState, safeThisLaunch: startupDecision?.safe ?? null, events: startupDecision?.events ?? [] },
    session: readSmallJson(sessionFile()),
    gpuLive: live ? { featureStatus, summary: gpu } : null,
    gpuLastStartup: readSmallJson(gpuInfoFile()),
    display: live ? { firstPaint: watch.firstPaintAt !== null, mounted: watch.mountedAt !== null, stalled: watch.stalled, lastBeatAgoMs: watch.lastBeatAt === null ? null : Date.now() - watch.lastBeatAt } : null,
    startupMs: phases.summary(),
  };
}

/** Writes the report to the Desktop (fallback: the logs folder) and reveals it in Explorer. Returns the path or null. */
async function writeDiagnosticReport(live: boolean): Promise<string> {
  const now = new Date();
  const entries = buildReportEntries({ logsDir: layout.logs, homeDir: homedir(), now: now.getTime(), system: await systemFacts(live) });
  const zip = createZip(entries, now);
  const name = reportFileName(now);
  const targets = [(() => { try { return app.getPath('desktop'); } catch { return null; } })(), layout.logs].filter((d): d is string => d !== null);
  let lastErr: Error | null = null;
  for (const dir of targets) {
    try { const file = join(dir, name); writeFileSync(file, zip, { mode: 0o600 }); logLine('info', 'diagnostic report written', { files: entries.length, bytes: zip.length, toDesktop: dir !== layout.logs }); return file; } catch (err) { lastErr = err as Error; }
  }
  throw lastErr ?? new Error('no folder to write to');
}

async function saveDiagnosticReport(via: 'tray'): Promise<void> {
  try {
    const file = await writeDiagnosticReport(true);
    shell.showItemInFolder(file);
    const box = { type: 'info' as const, ...reportSavedDialog(file.split(/[\\/]/).pop() ?? file) };
    void (mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, box) : dialog.showMessageBox(box)).catch(() => undefined);
  } catch (err) {
    logLine('error', 'diagnostic report failed', { code: EM.diagnosticReportFailed, via, error: (err as Error).message });
    void dialog.showMessageBox({ type: 'error', ...reportFailedDialog((err as Error).message) }).catch(() => undefined);
  }
}

/**
 * `Expertmotion.exe --diagnostics` (Start menu "Expertmotion – Diagnostik"): no single-instance lock (a black, running copy
 * must not swallow it), no window, no Service, no GPU (hardware acceleration off, own temporary userData). Writes the report,
 * opens Explorer on it, exits.
 */
function runDiagnosticsMode(): void {
  try { app.setPath('userData', join(app.getPath('temp'), 'Expertmotion-diagnostics')); } catch { /* keep default */ }
  app.disableHardwareAcceleration();
  layout = dataLayout(app.getPath('appData'), process.platform === 'win32' ? '\\' : '/');
  try { mkdirSync(layout.logs, { recursive: true }); } catch { /* reported below */ }
  shellLog = createRotatingLog(layout.logs, 'shell');
  logLine('info', 'diagnostics mode');
  app.on('window-all-closed', () => undefined);
  void app.whenReady().then(async () => {
    try {
      const file = await writeDiagnosticReport(false);
      shell.showItemInFolder(file);
      setTimeout(() => app.exit(0), 1_500);                                // let Explorer start before the process goes
    } catch (err) {
      logLine('error', 'diagnostic report failed', { code: EM.diagnosticReportFailed, via: 'shortcut', error: (err as Error).message });
      await dialog.showMessageBox({ type: 'error', ...reportFailedDialog((err as Error).message) }).catch(() => undefined);
      app.exit(1);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Boot sequence (DEPLOYMENT §8).
// ---------------------------------------------------------------------------------------------
function boot(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  ]);
  app.enableSandbox();
  // FR-199: the Start-menu "Diagnostik" shortcut. Before the single-instance lock: it must work while a black copy runs.
  if (process.argv.includes(DIAGNOSTICS_SWITCH)) { runDiagnosticsMode(); return; }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }
  // Opening Expertmotion again always shows a window: restore/focus the existing one, or create it when the first instance
  // has none (closed window still shutting down, or a hidden window) — otherwise the second launch looks like "nothing happens".
  app.on('second-instance', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) { if (app.isReady()) createWindow(); return; }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  });

  layout = dataLayout(app.getPath('appData'), process.platform === 'win32' ? '\\' : '/');
  for (const dir of directoriesToCreate(layout)) mkdirSync(dir, { recursive: true });
  shellLog = createRotatingLog(layout.logs, 'shell');
  pruneOldLogs(layout.logs);
  devRules = resolveDevRules(app.isPackaged, process.env);
  logLine('info', 'shell start', { version: app.getVersion(), platform: process.platform, arch: arch(), os: release(), ramMb: Math.round(totalmem() / 1048576), argv: process.argv.slice(1).filter((a) => a.startsWith('--')).slice(0, 10) });
  decideGraphicsMode();                                                     // FR-196 / FR-197: before app ready

  process.on('uncaughtException', (err) => { logLine('error', 'uncaughtException', { error: err.message }); writeCrashFile('shell', err.stack ?? err.message); });
  process.on('unhandledRejection', (reason) => { const err = reason instanceof Error ? reason : new Error(String(reason)); logLine('error', 'unhandledRejection', { error: err.message.slice(0, 500), stack: (err.stack ?? '').split('\n').slice(0, 10).join('\n') }); });
  app.on('child-process-gone', (_e, details) => onChildGone(details));
  app.on('gpu-info-update', () => onGpuInfoUpdate());
  app.on('will-quit', () => markSessionClean());


  void app.whenReady().then(() => {
    phases.mark('app-ready', Date.now());
    // Edit roles + the hidden recovery menu (window-chrome.ts; FR-199 Ctrl+R / F5 / Ctrl+Shift+L)
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, { reload: () => runRecovery('reload', 'menu'), openLogs: () => runRecovery('open-logs', 'menu') })));
    powerMonitor.on('shutdown', () => { logLine('info', 'system shutdown'); markSessionClean(); });   // Linux / macOS (Windows: session-end)
    setTimeout(() => maybeLogPhases(true), 90_000).unref();
    void logGpuInfo();
    hardenSession();
    registerAppProtocol();
    registerIpc();
    configureUpdater();
    createWindow();
    createTray();
    // FR-184: every step is pushed to the Editor splash (the window already shows it; nothing here blocks painting).
    pushServiceState(startingPush('integrity', shellStartedAt, Date.now()));
    void checkIntegrity().then(async (ok) => {
      phases.mark('integrity-done', Date.now());
      if (ok) {
        pushServiceState(startingPush('keyring', shellStartedAt, Date.now()));
        const key = await acquireDbKey();                    // after the window exists: EM-6001 is shown in the Editor too
        phases.mark('keyring-done', Date.now());
        if (key === null) return;
        dbKeyHex = key.keyHex;
        restoreBackupPending = key.restoreBackup;
        pushServiceState(startingPush('service', shellStartedAt, Date.now()));
        void startService();
        return;
      }
      pushServiceState({ status: 'failed', code: EM.integrityFailed, logsDir: layout.logs });
      fatalDialog(EM.integrityFailed, 'Some Expertmotion program files are missing or were changed. Reinstall Expertmotion from the original installer; your projects are kept.');
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    // Never linger without a window: if the graceful path stalls, exit anyway (the Service is killed by its own deadline).
    const hardExit = setTimeout(() => { logLine('warn', 'shutdown stalled; exiting'); exitApp(0); }, 20_000);
    void (async () => {
      const r = await shutdownService('window-closed').catch(() => 'stopped' as const);
      if (r === 'stopped') app.quit(); else clearTimeout(hardExit);
    })();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

boot();

// Exported for completeness; the streaming sha256 used by the integrity verifier at startup (lib/integrity-hash.ts).
export const sha256File = streamSha256;

/**
 * Startup integrity check (SEC-061, SEC-133): verifies the signed manifest written by
 * scripts/harden.mjs against the installed files. Packaged builds with an embedded release key
 * refuse to start on any mismatch (EM-8007); dev runs and builds without a key skip it.
 */
async function checkIntegrity(): Promise<boolean> {
  const keyB64 = typeof __EM_ENGINE_PUBLIC_KEY_B64__ === 'string' ? __EM_ENGINE_PUBLIC_KEY_B64__ : '';
  if (!app.isPackaged || keyB64 === '') { logLine('info', 'integrity check skipped', { packaged: app.isPackaged }); return true; }
  try {
    const signed = JSON.parse(readFileSync(join(process.resourcesPath, 'integrity-manifest.json'), 'utf8')) as SignedManifest;
    const fileFor = (logical: string) => logical.startsWith('dist/')
      ? join(process.resourcesPath, 'app.asar', ...logical.split('/'))
      : join(process.resourcesPath, ...logical.split('/'));
    // Every listed file is hashed in full (SEC-133); streamed, a few files at a time, with progress for the splash (FR-184).
    const started = Date.now();
    let lastPush: number | null = null;
    const digests = await hashManifestFiles(signed.manifest.entries, fileFor, {
      onProgress: (p) => {
        const now = Date.now();
        if (!shouldPushProgress(lastPush, now, p.files, p.totalFiles)) return;
        lastPush = now;
        pushServiceState(startingPush('integrity', shellStartedAt, now, p.totalBytes > 0 ? p.bytes / p.totalBytes : p.files / Math.max(1, p.totalFiles)));
      },
    });
    const publicKey = createPublicKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'spki' });
    const result = verifyManifest(signed, new Uint8Array(0), digests, (msg, sig) => nodeVerify(null, msg, publicKey, Buffer.from(sig, 'base64')));
    const bytes = signed.manifest.entries.reduce((n, e) => n + e.bytes, 0);
    logLine(result.ok ? 'info' : 'error', `integrity check done in ${Date.now() - started} ms`, { files: signed.manifest.entries.length, mb: Math.round(bytes / 1048576), ok: result.ok });
    if (!result.ok) logLine('error', 'integrity check failed', { code: result.code, path: result.path });
    return result.ok;
  } catch (err) {
    logLine('error', 'integrity check failed', { error: (err as Error).message });
    return false;
  }
}
