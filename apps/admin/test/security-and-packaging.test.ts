/** Window hardening and packaging shape of Expertmotion License Admin (static checks; Electron cannot run on the Linux server). */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentTypeOf, CSP, isAllowedUrl, resolveRendererFile, WEB_PREFERENCES } from '../src/core/security.js';

const root = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const require = createRequire(import.meta.url);

describe('window hardening', () => {
  it('web preferences: context isolation, sandbox, no Node, no webview', () => {
    expect(WEB_PREFERENCES).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false });
    const main = read('src/main.ts');
    expect(main).toContain('...WEB_PREFERENCES');
    expect(main).toContain('app.enableSandbox()');
    expect(main).toMatch(/setPermissionRequestHandler\(\(_wc, _permission, cb\) => cb\(false\)\)/);
    expect(main).toMatch(/onBeforeRequest\(\(details, cb\) => cb\(\{ cancel: !isAllowedUrl/);
    expect(main).toContain("wc.on('will-navigate', (e) => e.preventDefault())");
    expect(main).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))");
    expect(main).toMatch(/frame !== win\.webContents\.mainFrame/);
  });

  it('strict CSP: nothing remote, no inline script, no eval; the page meta tag matches the header policy', () => {
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    const html = read('src/renderer/index.html');
    const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    // frame-ancestors is ignored in a meta tag, so it is only sent as a header
    expect(meta).toBe(CSP.split('; ').filter((d) => !d.startsWith('frame-ancestors')).join('; '));
    expect(html).not.toMatch(/<script>|\son[a-z]+="/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('only the bundled renderer (app://admin/) may load; files resolve inside the renderer folder', () => {
    expect(isAllowedUrl('app://admin/index.html')).toBe(true);
    expect(isAllowedUrl('app://admin/app.js?x=1')).toBe(true);
    expect(isAllowedUrl('https://example.com/')).toBe(false);
    expect(isAllowedUrl(pathToFileURL('/etc/passwd').href)).toBe(false);
    expect(isAllowedUrl('app://other/index.html')).toBe(false);
    const win = 'C:\\Users\\Andre Tuwan\\Downloads\\Admin\\resources\\app.asar\\dist\\renderer';
    expect(resolveRendererFile(win, 'app://admin/index.html')).toBe(`${win}\\index.html`);
    expect(resolveRendererFile('/opt/a/dist/renderer', 'app://admin/')).toBe('/opt/a/dist/renderer/index.html');
    // the URL parser folds ../ and %2e%2e/ before we see the path: they can never leave the renderer folder
    expect(resolveRendererFile('/opt/a/dist/renderer', 'app://admin/../main.cjs')).toBe('/opt/a/dist/renderer/main.cjs');
    expect(resolveRendererFile('/opt/a/dist/renderer', 'app://admin/%2e%2e/%2e%2e/x')).toBe('/opt/a/dist/renderer/x');
    expect(resolveRendererFile('/opt/a/dist/renderer', 'app://admin/a%20b.js')).toBeNull();
    expect(contentTypeOf('x/app.js')).toMatch(/javascript/);
  });

  it('preload exposes only request + onLocked and no Electron/Node objects', () => {
    const preload = read('src/preload.ts');
    expect(preload.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(preload).toMatch(/request\(channel: string/);
    expect(preload).toMatch(/onLocked\(cb/);
    expect(preload).toContain('allowed.has(channel)');
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/);
  });

  it('renderer never uses innerHTML / eval', () => {
    const app = read('src/renderer/app.ts');
    expect(app).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML\(|\beval\(|new Function\(/);
  });
});

describe('packaging', () => {
  it('pins the same Electron version as apps/desktop and has no runtime dependencies', () => {
    const admin = JSON.parse(read('package.json')) as { dependencies?: object; devDependencies: Record<string, string> };
    const desktop = JSON.parse(readFileSync(path.join(root, '..', 'desktop', 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    expect(admin.devDependencies.electron).toBe(desktop.devDependencies.electron);
    expect(admin.dependencies).toBeUndefined();
    const cfg = require(path.join(root, 'electron-builder.config.cjs')) as Record<string, unknown> & { win: { target: { target: string; arch: string[] }[] } };
    expect(cfg.electronVersion).toBe(desktop.devDependencies.electron);
  });

  it('Windows portable ZIP only (no NSIS), named Expertmotion-License-Admin-<version>-win-x64.zip', () => {
    const cfg = require(path.join(root, 'electron-builder.config.cjs')) as { artifactName: string; win: { target: { target: string; arch: string[] }[] }; nsis?: unknown; files: string[] };
    expect(cfg.win.target).toEqual([{ target: 'zip', arch: ['x64'] }]);
    expect(cfg.nsis).toBeUndefined();
    expect(cfg.artifactName).toBe('Expertmotion-License-Admin-${version}-win-${arch}.${ext}');
    expect(cfg.files).toContain('dist/**');
    const rootPkg = JSON.parse(readFileSync(path.join(root, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(rootPkg.scripts['pack:admin:win']).toContain('@expertmotion/admin');
  });

  it('afterPack flips the same Electron fuses as apps/desktop (no RunAsNode / NODE_OPTIONS / inspect; asar only, integrity on)', () => {
    const { FUSE_CONFIG } = require(path.join(root, 'build', 'afterPack.cjs')) as { FUSE_CONFIG: Record<string, unknown> };
    const desktop = require(path.join(root, '..', 'desktop', 'build', 'fuses.cjs')) as { FUSE_CONFIG: Record<string, unknown> };
    expect(FUSE_CONFIG).toEqual(desktop.FUSE_CONFIG);
    const cfg = require(path.join(root, 'electron-builder.config.cjs')) as { afterPack: unknown };
    expect(typeof cfg.afterPack).toBe('function');
  });
});
