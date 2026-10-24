/**
 * Content Security Policy of the Editor (SECURITY.md SEC-024). The production string is
 * exactly the documented directive list. The development variant (SEC-014, `!app.isPackaged`
 * only) additionally allows the Vite dev server origin and its HMR websocket.
 */
export const PRODUCTION_CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ['default-src', "'none'"],
  ['script-src', "'self'"],
  ['style-src', "'self' 'unsafe-inline'"],
  ['img-src', "'self' blob: data: http://127.0.0.1:*"],
  ['media-src', "'self' blob: http://127.0.0.1:*"],
  ['font-src', "'self'"],
  ['connect-src', 'http://127.0.0.1:*'],
  ['worker-src', "'self' blob:"],
  ['frame-src', "'none'"],
  ['object-src', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
  ['frame-ancestors', "'none'"],
];

export interface CspOptions {
  /** Vite dev origin, e.g. `http://127.0.0.1:4120`; only set in development (SEC-014). */
  devOrigin?: string | null;
}

export function buildCsp(opts: CspOptions = {}): string {
  const dev = opts.devOrigin ?? null;
  return PRODUCTION_CSP_DIRECTIVES.map(([name, value]) => {
    if (dev === null) return `${name} ${value}`;
    const ws = dev.replace(/^http/, 'ws');
    switch (name) {
      // Vite's React plugin injects an inline refresh preamble; development only.
      case 'script-src': return `${name} ${value} ${dev} 'unsafe-inline'`;
      case 'style-src': case 'img-src': case 'media-src': case 'font-src': case 'worker-src':
        return `${name} ${value} ${dev}`;
      case 'connect-src': return `${name} ${value} ${dev} ${ws}`;
      default: return `${name} ${value}`;
    }
  }).join('; ');
}

/** Invariant checked by tests and at Shell start: production never allows inline or eval scripts. */
export function isStrictScriptPolicy(csp: string): boolean {
  const script = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src '));
  return script !== undefined && !script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'");
}
