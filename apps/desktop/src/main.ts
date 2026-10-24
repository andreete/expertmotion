/**
 * Desktop Shell main process (ARCHITECTURE.md §3, §5; SECURITY.md SEC-001…033, SEC-040, SEC-090…104).
 *
 * Responsibilities (all orchestration; no business logic — that is the Local Service's job):
 *   - single-instance lock (DEPLOYMENT §8 task 1)
 *   - Database Key keyring: generate 32 random bytes on first run, wrap with safeStorage (DPAPI)
 *     into data/keyring.bin, unwrap on start; refuse with EM-6001 if unavailable (SEC-040)
 *   - per-launch 256-bit Service Token (SEC-001)
 *   - free loopback port 47600–47699 (SEC-008)
 *   - start the Local Service with utilityProcess.fork and postMessage bootstrap (SEC-002)
 *   - supervise with restart backoff 1/3/9 s, max 3 (SEC-033)
 *   - graceful close via POST /service/shutdown then {type:'shutdown'} then kill (SEC §5 step 5)
 *   - hardened BrowserWindow + app:// protocol + CSP + navigation/permission locks (SEC-020…031)
 *   - native dialogs over IPC with sender validation (SEC-030)
 *   - crash/diagnostic logs with secret redaction (SEC-100…104)
 *   - electron-updater wiring, disabled in Private Mode (SEC-090…096)
 *
 * The decision logic is in ./lib/* (pure, unit-tested on Linux). This file wires Electron to it.
 * Electron cannot run on the Linux dev server, so this file is typecheck-only here; see README.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, screen, session, shell, Tray, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { autoUpdater } from 'electron-updater';
import { randomBytes, createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from '@expertmotion/shared';
import {
  APP_HOST, APP_ORIGIN, APP_SCHEME, EM, IPC, isAllowedExternal, isPlayableOutput, READY_TIMEOUT_MS, UPDATE_ACTIONS, type UpdateAction, SHELL_CALLER_HEADER, SHELL_CALLER_VALUE,
  SHUTDOWN_KILL_AFTER_MS, SHUTDOWN_REQUEST_WAIT_MS,
} from './lib/constants.js';
import { pickPort } from './lib/port.js';
import { MIN_HEIGHT, MIN_WIDTH, parseWindowState, restoreBounds, type WindowState } from './lib/window-state.js';
import { initialRestartState, onFailure, onReady, type RestartState } from './lib/backoff.js';
import { buildCsp } from './lib/csp.js';
import { resolveAppUrl } from './lib/protocol.js';
import { isTrustedSender } from './lib/ipc.js';
import { crashFileName, dataLayout, directoriesToCreate, logFiles, type DataLayout } from './lib/data-dir.js';
import { editorEntryUrl, resolveDevRules, type DevRules } from './lib/dev-mode.js';
import { buildBootstrap, parseServiceMessage, shutdownMessage } from './lib/bootstrap.js';
import { evaluateKeyring } from './lib/keyring.js';
import { installDecision, nextUpdateState, shouldCheckForUpdates, updaterConfig, UPDATE_TICK_MS, type UpdateEvent, type UpdateState } from './lib/updater-policy.js';
import { RENDER_RUNNING_DIALOG, choiceFromButton, parseShutdownResponse, type ShutdownAnswer } from './lib/close-flow.js';
import { verifyManifest, type SignedManifest } from './lib/integrity.js';

/** Build-time constants injected by esbuild `define` (see scripts/build-main.mjs). */
declare const __EM_FEED_URL__: string;
declare const __EM_ENGINE_PUBLIC_KEY_B64__: string;
declare const __EM_PROMPT_HALF_B__: string;
const PROMPT_HALF_B = typeof __EM_PROMPT_HALF_B__ === 'string' ? __EM_PROMPT_HALF_B__ : '';

const FEED_URL = typeof __EM_FEED_URL__ === 'string' ? __EM_FEED_URL__ : 'https://updates.expertmotion.invalid/win';

// ---------------------------------------------------------------------------------------------
// Logging with redaction (SEC-100). Every line passes through `redact` before it touches disk.
// ---------------------------------------------------------------------------------------------
let shellLogPath: string | null = null;
function logLine(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  const line = redact(JSON.stringify({ ts: new Date().toISOString(), level, component: 'shell', msg, ...extra }));
  if (level === 'error') console.error(line);
  else console.log(line);
  if (shellLogPath !== null) void appendFile(shellLogPath, `${line}\n`).catch(() => undefined);
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
let restartState: RestartState = initialRestartState;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastUpdateCheckAt: number | null = null;
let updateState: UpdateState = { status: 'idle' };
let updateStage: 'check' | 'download' | 'install' = 'check';
let updateTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
const triedPorts = new Set<number>();
const stderrTail: string[] = [];

// ---------------------------------------------------------------------------------------------
// Keyring: unwrap or create the Database Key (SEC-040).
// ---------------------------------------------------------------------------------------------
function loadOrCreateDbKey(): string {
  const gate = evaluateKeyring({
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
    platform: process.platform,
  });
  if (!gate.ok) {
    fatalDialog(gate.code, `Project storage cannot be opened: ${gate.reason}`);
    app.exit(1);
    throw new Error(gate.reason);
  }
  if (existsSync(layout.keyring)) {
    const wrapped = readFileSync(layout.keyring);
    return safeStorage.decryptString(wrapped);
  }
  const key = randomBytes(32).toString('hex');
  writeFileSync(layout.keyring, safeStorage.encryptString(key), { mode: 0o600 });
  logLine('info', 'created new Database Key keyring');
  return key;
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

/** Scrubbed environment for the utility process (SEC-065): no EM_* leakage, no proxies. */
function serviceEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of ['SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'PATH'] as const) {
    const v = process.env[key];
    if (v !== undefined) base[key] = v;
  }
  if (!app.isPackaged && process.env.EM_LOG_LEVEL !== undefined) base.EM_LOG_LEVEL = process.env.EM_LOG_LEVEL;
  return base;
}

async function startService(): Promise<void> {
  if (dbKeyHex === null) throw new Error('Database Key not loaded');
  const port = await pickPort({ exclude: triedPorts });
  const token = randomBytes(32).toString('base64url');
  endpoint = { port, token };

  const proc = utilityProcess.fork(serviceModulePath(), [], {
    serviceName: 'expertmotion-service',
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

  proc.postMessage(buildBootstrap({ token, port, dataDir: layout.root, dbKeyHex, promptKeyHalf: PROMPT_HALF_B }));
  proc.on('exit', (code) => onServiceExit(code));

  try {
    await ready;
    restartState = onReady(restartState, Date.now());
    logLine('info', 'service ready', { port });
    pushServiceState({ status: 'ready', bootstrap: { port, token } });
  } catch (err) {
    logLine('error', 'service failed to become ready', { error: (err as Error).message });
    triedPorts.add(port);
    scheduleRestart();
  }
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
    pushServiceState({ status: 'failed', code: EM.serviceFailed });
    fatalDialog(EM.serviceFailed, 'The background service failed to start. Open Diagnostics or restart your computer.');
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
      answer = await requestServiceShutdown(reason, true);
    }
    if (answer.kind === 'failed') logLine('warn', 'shutdown request refused', { status: answer.status });
  } catch (err) {
    logLine('warn', 'shutdown request failed', { error: (err as Error).message });
  }
  proc.postMessage(shutdownMessage);
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => { proc.kill(); resolve(); }, SHUTDOWN_KILL_AFTER_MS);
    proc.once('exit', () => { clearTimeout(killTimer); resolve(); });
  });
  serviceProc = null;
  return 'stopped';
}

/** Asks the Service to checkpoint and stop (POST /service/shutdown, trusted-caller header); `force` cancels a running render. */
function requestServiceShutdown(reason: string, force: boolean): Promise<ShutdownAnswer> {
  if (endpoint === null) return Promise.resolve({ kind: 'accepted' });
  const { port, token } = endpoint;
  return new Promise<ShutdownAnswer>((resolve, reject) => {
    const request = net.request({ method: 'POST', url: `http://127.0.0.1:${port}/api/v1/service/shutdown`, useSessionCookies: false });
    request.setHeader('Authorization', `Bearer ${token}`);
    request.setHeader(SHELL_CALLER_HEADER, SHELL_CALLER_VALUE);
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Origin', APP_ORIGIN);
    const timer = setTimeout(() => { request.abort(); reject(new Error('shutdown timeout')); }, SHUTDOWN_REQUEST_WAIT_MS);
    request.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { if (chunks.length < 16) chunks.push(c); });
      res.on('end', () => { clearTimeout(timer); resolve(parseShutdownResponse(res.statusCode, Buffer.concat(chunks).toString('utf8'))); });
    });
    request.on('error', (e) => { clearTimeout(timer); reject(e); });
    request.end(JSON.stringify({ reason, timeoutMs: SHUTDOWN_REQUEST_WAIT_MS, ...(force ? { force: true } : {}) }));
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
function windowStateFile(): string { return join(layout.data, 'window-state.json'); }
function readWindowState(): WindowState {
  try { return parseWindowState(JSON.parse(readFileSync(windowStateFile(), 'utf8'))); } catch { return { maximized: false }; }
}
function writeWindowState(win: BrowserWindow): void {
  try { writeFileSync(windowStateFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* best effort */ }
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

  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${APP_ORIGIN}/`) && !devRules.devOrigins.some((o) => url.startsWith(o))) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.once('ready-to-show', () => { if (saved.maximized) win.maximize(); win.show(); scheduleUpdateCheck(); });
  let saveTimer: NodeJS.Timeout | undefined;
  const saveSoon = () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => writeWindowState(win), 500); };
  win.on('resize', saveSoon); win.on('move', saveSoon);
  win.on('close', () => { if (saveTimer) clearTimeout(saveTimer); writeWindowState(win); });
  win.on('closed', () => { mainWindow = null; });

  void win.loadURL(editorEntryUrl(app.isPackaged, process.env));
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}

// ---------------------------------------------------------------------------------------------
// IPC handlers (SEC-030, SEC-031). Sender validated; a foreign frame is ignored.
// ---------------------------------------------------------------------------------------------
function senderOk(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (frame === null) return false;
  return isTrustedSender({ url: frame.url, isMainFrame: frame.parent === null }, { devOrigins: devRules.devOrigins });
}

function registerIpc(): void {
  ipcMain.handle(IPC.getBootstrap, (event) => {
    if (!senderOk(event)) return null;
    return endpoint === null ? null : { port: endpoint.port, token: endpoint.token };
  });

  ipcMain.handle(IPC.pickFiles, async (event, options: { filters?: Electron.FileFilter[]; multiple?: boolean }) => {
    if (!senderOk(event) || mainWindow === null) return [];
    const dialogOptions: Electron.OpenDialogOptions = {
      properties: options.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
    };
    if (options.filters !== undefined) dialogOptions.filters = options.filters;
    const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(IPC.pickFolder, async (event, options: { defaultPath?: string }) => {
    if (!senderOk(event) || mainWindow === null) return null;
    const dialogOptions: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    if (options.defaultPath !== undefined) dialogOptions.defaultPath = options.defaultPath;
    const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
  });

  ipcMain.handle(IPC.pickSavePath, async (event, options: { defaultPath?: string; filters?: Electron.FileFilter[] }) => {
    if (!senderOk(event) || mainWindow === null) return null;
    const dialogOptions: Electron.SaveDialogOptions = {};
    if (options.defaultPath !== undefined) dialogOptions.defaultPath = options.defaultPath;
    if (options.filters !== undefined) dialogOptions.filters = options.filters;
    const result = await dialog.showSaveDialog(mainWindow, dialogOptions);
    return result.canceled || result.filePath === undefined ? null : result.filePath;
  });

  ipcMain.handle(IPC.openFolder, (event, targetPath: unknown) => {
    if (!senderOk(event) || typeof targetPath !== 'string') return;
    shell.showItemInFolder(targetPath);
  });

  ipcMain.handle(IPC.openExternal, async (event, url: unknown) => {
    if (!senderOk(event) || typeof url !== 'string' || !isAllowedExternal(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.openPath, async (event, targetPath: unknown) => {          // FR-146 Play: rendered media only
    if (!senderOk(event) || typeof targetPath !== 'string' || !isPlayableOutput(targetPath) || !existsSync(targetPath)) return;
    const err = await shell.openPath(targetPath);
    if (err) logLine('warn', 'open path failed', { code: EM.openFolderFailed });
  });

  ipcMain.handle(IPC.getUpdateState, (event) => (senderOk(event) ? updateState : null));
  ipcMain.handle(IPC.updateAction, async (event, action: unknown) => {
    if (!senderOk(event) || typeof action !== 'string' || !(UPDATE_ACTIONS as readonly string[]).includes(action)) return;
    await onUpdateAction(action as UpdateAction);
  });
}

function pushServiceState(state: { status: 'starting' | 'ready' | 'offline' | 'failed'; bootstrap?: Endpoint; code?: string }): void {
  mainWindow?.webContents.send(IPC.serviceState, state);
}

// ---------------------------------------------------------------------------------------------
// Updater (SEC-090…096). Disabled in Private Mode, read from the Local Service settings.
// ---------------------------------------------------------------------------------------------
function setUpdate(e: UpdateEvent): void {
  updateState = nextUpdateState(updateState, e);
  mainWindow?.webContents.send(IPC.updateState, updateState);
}

function configureUpdater(): void {
  const cfg = updaterConfig(FEED_URL);
  autoUpdater.autoDownload = cfg.autoDownload;           // FR-152: download only after the Creator's consent
  autoUpdater.allowDowngrade = cfg.allowDowngrade;
  autoUpdater.autoInstallOnAppQuit = false;              // never install behind a running render; restart goes through onUpdateAction
  autoUpdater.channel = cfg.channel;
  autoUpdater.on('checking-for-update', () => setUpdate({ type: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdate({ type: 'none' }));
  autoUpdater.on('error', (err) => { logLine('warn', 'updater error', { code: EM.updateCheckFailed, stage: updateStage, error: err.message }); setUpdate({ type: 'error', message: err.message, stage: updateStage }); });
  autoUpdater.on('update-available', (info) => { logLine('info', 'update available', { code: EM.updateAvailable, version: info.version }); setUpdate({ type: 'available', version: info.version }); });
  autoUpdater.on('download-progress', (p) => setUpdate({ type: 'progress', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => { logLine('info', 'update downloaded', { code: EM.updateAvailable, version: info.version }); setUpdate({ type: 'downloaded', version: info.version }); });
  // FR-152: check after the Editor is interactive and then every 24 h (the hourly tick lets the policy decide)
  updateTimer = setInterval(scheduleUpdateCheck, UPDATE_TICK_MS);
  updateTimer.unref();
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
  if (!app.isPackaged) return;
  if (action === 'check') { lastUpdateCheckAt = null; scheduleUpdateCheck(); return; }
  if (action === 'later') { logLine('info', 'update postponed', { version: updateState.version ?? null }); return; }
  if (action === 'download') {
    if (await privateModeOn()) { setUpdate({ type: 'paused' }); return; }
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
  await shutdownService('update').catch(() => undefined);
  autoUpdater.quitAndInstall(false, true);
}

async function privateModeOn(): Promise<boolean> {
  if (endpoint === null) return true; // fail closed: no settings → no outbound.
  try {
    const settings = await getJson<{ privateMode: boolean }>(`http://127.0.0.1:${endpoint.port}/api/v1/settings`);
    return settings.privateMode === true;
  } catch {
    return true;
  }
}

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

function scheduleUpdateCheck(): void {
  if (!app.isPackaged) return;
  void (async () => {
    const decision = shouldCheckForUpdates({ privateMode: await privateModeOn(), lastCheckAt: lastUpdateCheckAt, editorInteractive: true, now: Date.now() });
    if (!decision.check) { logLine('info', 'update check skipped', { reason: decision.reason }); if (decision.reason === 'private-mode') setUpdate({ type: 'paused' }); return; }
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
    tray.setToolTip('Expertmotion');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Expertmotion', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  } catch (err) {
    logLine('warn', 'tray unavailable', { error: (err as Error).message });
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
// Boot sequence (DEPLOYMENT §8).
// ---------------------------------------------------------------------------------------------
function boot(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  ]);
  app.enableSandbox();

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }
  app.on('second-instance', () => { if (mainWindow !== null) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

  layout = dataLayout(app.getPath('appData'), process.platform === 'win32' ? '\\' : '/');
  for (const dir of directoriesToCreate(layout)) mkdirSync(dir, { recursive: true });
  shellLogPath = logFiles(layout).shell;
  devRules = resolveDevRules(app.isPackaged, process.env);

  process.on('uncaughtException', (err) => { logLine('error', 'uncaughtException', { error: err.message }); writeCrashFile('shell', err.stack ?? err.message); });

  dbKeyHex = loadOrCreateDbKey();

  void app.whenReady().then(() => {
    hardenSession();
    registerAppProtocol();
    registerIpc();
    configureUpdater();
    createWindow();
    createTray();
    pushServiceState({ status: 'starting' });
    void checkIntegrity().then((ok) => {
      if (ok) { void startService(); return; }
      fatalDialog('EM-8007', 'Some Expertmotion program files are missing or were changed. Reinstall Expertmotion from the original installer; your projects are kept.');
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    void (async () => { if ((await shutdownService('window-closed')) === 'stopped') app.quit(); })();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

boot();

// Exported for completeness; the sha256 used by the integrity verifier at startup.
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

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
    const digests = new Map<string, { sha256: string; bytes: number }>();
    for (const entry of signed.manifest.entries) {
      const file = fileFor(entry.path);
      if (!existsSync(file)) continue;
      digests.set(entry.path, { sha256: await sha256File(file), bytes: statSync(file).size });
    }
    const publicKey = createPublicKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'spki' });
    const result = verifyManifest(signed, new Uint8Array(0), digests, (msg, sig) => nodeVerify(null, msg, publicKey, Buffer.from(sig, 'base64')));
    if (!result.ok) logLine('error', 'integrity check failed', { code: result.code, path: result.path });
    return result.ok;
  } catch (err) {
    logLine('error', 'integrity check failed', { error: (err as Error).message });
    return false;
  }
}
