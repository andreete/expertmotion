/**
 * Expertmotion License Admin: main process. Operator-only tool, never shipped to Creators
 * (LICENSE_OPERATIONS.md §10.5). One window, local content only, no network use of its own.
 *
 * Hardening: sandboxed renderer with contextIsolation and no Node; strict CSP (meta tag in
 * renderer/index.html, plus response header where Electron applies it); every web request that is
 * not a file of the bundled renderer is cancelled; navigation, new windows, webviews and all
 * permission requests are refused; IPC only from our own top frame, arguments validated in core.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createAdmin, type Platform } from './core/admin.js';
import { CHANNEL_NAMES, EVENTS } from './core/channels.js';
import { ADMIN_ORIGIN, ADMIN_SCHEME, CSP, contentTypeOf, isAllowedUrl, resolveRendererFile, WEB_PREFERENCES } from './core/security.js';

const rendererDir = path.join(app.getAppPath(), 'dist', 'renderer');
let win: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // The page is served from app://admin/ (not file://): Windows paths (drive letter, spaces, app.asar) made the
  // file:// request filter cancel the page itself, leaving a blank window. Same pattern as the Editor (app://expertmotion).
  protocol.registerSchemesAsPrivileged([{ scheme: ADMIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  app.enableSandbox();
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

function log(msg: string, extra: Record<string, unknown> = {}): void {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'admin.log'), `${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`);
  } catch { /* logging must never break the app */ }
}

function start(): void {
  protocol.handle(ADMIN_SCHEME, (request) => {
    const file = resolveRendererFile(rendererDir, request.url);
    if (!file) { log('blocked request', { url: request.url }); return new Response('Not found', { status: 404 }); }
    try {
      return new Response(new Uint8Array(fs.readFileSync(file)), { status: 200, headers: { 'Content-Type': contentTypeOf(file), 'Content-Security-Policy': CSP } });
    } catch (e) { log('read failed', { url: request.url, error: (e as Error).message }); return new Response('Not found', { status: 404 }); }
  });
  process.on('uncaughtException', (e) => log('uncaughtException', { error: e.stack ?? e.message }));
  Menu.setApplicationMenu(null);
  const admin = createAdmin({
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    defaultWorkspace: path.join(app.getPath('documents'), 'Expertmotion License Admin'),
    onLock: (reason) => win?.webContents.send(EVENTS.locked, reason),
  });
  const idleTimer = setInterval(() => admin.session.checkIdle(), 15_000);
  app.on('before-quit', () => {
    clearInterval(idleTimer);
    admin.session.lock('quit');
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isAllowedUrl(details.url) }));
  ses.webRequest.onHeadersReceived((details, cb) => cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } }));

  const platform: Platform = {
    async pickFolder(purpose) {
      if (!win) return null;
      const title = purpose === 'keyFolder' ? 'Folder for the sealed signing key (outside any repository)' : purpose === 'workspace' ? 'Workspace folder (audit log, licence files)' : 'Folder for revoked.json';
      const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async pickKeyFile() {
      if (!win) return null;
      const r = await dialog.showOpenDialog(win, { title: 'Open sealed signing key', properties: ['openFile'], filters: [{ name: 'Signing key', extensions: ['json'] }] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    writeClipboard(text) {
      clipboard.writeText(text);
    },
    showInFolder(p) {
      shell.showItemInFolder(p);
    },
  };

  for (const channel of CHANNEL_NAMES) {
    ipcMain.handle(channel, (event, args: unknown) => {
      const frame = event.senderFrame;
      if (!win || event.sender !== win.webContents || !frame || frame !== win.webContents.mainFrame || !isAllowedUrl(frame.url)) {
        return { ok: false, error: { code: 'EINVAL', message: 'Request refused.' } };
      }
      return admin.invoke(channel, args, platform);
    });
  }

  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'Expertmotion License Admin',
    show: false,
    backgroundColor: '#f6f7f9',
    webPreferences: { ...WEB_PREFERENCES, preload: path.join(app.getAppPath(), 'dist', 'preload.cjs'), devTools: !app.isPackaged },
  });
  const wc = win.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  wc.on('did-fail-load', (_e, code, desc, url) => log('page failed to load', { code, desc, url }));
  wc.on('render-process-gone', (_e, d) => log('renderer gone', { reason: d.reason }));
  wc.on('console-message', (e) => { const m = e as unknown as { level?: string | number; message?: string }; if (m.level === 'error' || m.level === 3) log('renderer error', { message: m.message }); });
  log('start', { version: app.getVersion() });
  void win.loadURL(`${ADMIN_ORIGIN}/index.html`);
}
