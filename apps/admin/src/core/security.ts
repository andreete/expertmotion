/**
 * Window hardening constants shared by main.ts and the tests. The page is served by main as app://admin/ and loads
 * nothing remote: every request that is not a file inside the bundled renderer folder is cancelled.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  spellcheck: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
} as const;

export const ADMIN_SCHEME = 'app';
export const ADMIN_ORIGIN = 'app://admin';

/** True when `url` is a page or asset of the bundled renderer (app://admin/…, no traversal) or DevTools. */
export function isAllowedUrl(url: string): boolean {
  if (url.startsWith('devtools://')) return true;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== `${ADMIN_SCHEME}:` || u.host !== 'admin') return false;
  return !decodeURIComponent(u.pathname).split('/').some((seg) => seg === '..');
}

/** Maps app://admin/<path> to a file inside `rendererDir`, or null (unknown host, traversal, missing file name). */
export function resolveRendererFile(rendererDir: string, url: string): string | null {
  if (!isAllowedUrl(url) || url.startsWith('devtools://')) return null;
  const rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '') || 'index.html';
  if (!/^[A-Za-z0-9._/-]+$/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return [rendererDir, ...parts].join(rendererDir.includes('\\') ? '\\' : '/');
}

export function contentTypeOf(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
