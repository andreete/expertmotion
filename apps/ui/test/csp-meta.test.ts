// SEC-024: built index.html carries the production CSP as a <meta>; script-src has no 'unsafe-inline'/'unsafe-eval'.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { META_CSP, cspMetaPlugin, injectCspMeta } from '../csp-meta.js';
import { buildCsp, isStrictScriptPolicy } from '../../desktop/src/lib/csp.js';

describe('CSP meta (SEC-024)', () => {
  it('mirrors the production header policy (minus frame-ancestors, ignored in meta)', () => {
    const header = buildCsp({ devOrigin: null });
    expect(META_CSP).toBe(header.replace("; frame-ancestors 'none'", ''));
    expect(isStrictScriptPolicy(META_CSP)).toBe(true);
    expect(META_CSP).toContain("default-src 'none'");
    expect(META_CSP).toContain('connect-src http://127.0.0.1:*');
  });
  it('injects once into index.html right after the charset', () => {
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const out = injectCspMeta(html);
    expect(out).toMatch(/<meta charset="UTF-8" \/>\n\s+<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self';/);
    expect(injectCspMeta(out)).toBe(out);
  });
  it('paints a dark placeholder with the app mark and "Memulai…" before any script runs, with no inline script (FR-184)', () => {
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toContain('data-el="sys.splash.placeholder"');
    expect(html).toContain('Memulai…');
    expect(html).toMatch(/<body style="[^"]*background:#0E0F12/);
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script type="module" src="/src/main.tsx">']);   // external module only
    expect(html).not.toMatch(/\son[a-z]+=/i);                                                          // no inline handlers
  });
  it('runs only for production builds (dev server keeps working)', () => {
    expect(cspMetaPlugin.apply).toBe('build');
  });
});
