/**
 * Window hardening constants shared by main.ts and the tests. The page is local (file://) and loads
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

/** True when `url` is a file inside `rendererDir` (the only content the window may load). */
export function isAllowedUrl(url: string, rendererDirUrl: string): boolean {
  if (url.startsWith('devtools://')) return true;
  const base = rendererDirUrl.endsWith('/') ? rendererDirUrl : `${rendererDirUrl}/`;
  if (!url.startsWith(base)) return false;
  const rest = url.slice(base.length);
  return !rest.split(/[?#]/)[0]!.split('/').some((seg) => seg === '..' || seg.toLowerCase() === '%2e%2e');
}
