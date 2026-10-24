// SEC-024: the production Content Security Policy mirrored as <meta http-equiv="Content-Security-Policy"> in the built Editor.
// The app:// protocol handler sends the same policy as a response header (apps/desktop/src/lib/csp.ts is the single source of
// the directives). Build only (`apply: 'build'`): the Vite dev server needs its inline React-refresh preamble and HMR socket,
// which the Shell's development CSP header allows instead (SEC-014). `frame-ancestors` is dropped from the meta form only,
// because browsers ignore it there (the header carries it).
import { buildCsp } from '../desktop/src/lib/csp.js';

export const META_CSP = buildCsp({ devOrigin: null }).split('; ').filter((d) => !d.startsWith('frame-ancestors ')).join('; ');

export function injectCspMeta(html: string, csp: string = META_CSP): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  const tag = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}" />`;
  return html.replace(/<meta charset="UTF-8"\s*\/?>/i, (m) => `${m}\n    ${tag}`);
}

export const cspMetaPlugin = {
  name: 'expertmotion-csp-meta',
  apply: 'build' as const,
  transformIndexHtml: (html: string) => injectCspMeta(html),
};
