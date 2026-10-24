import { describe, expect, it } from 'vitest';
import { buildCsp, isStrictScriptPolicy, PRODUCTION_CSP_DIRECTIVES } from '../src/lib/csp.js';

describe('CSP (SEC-024)', () => {
  const prod = buildCsp();

  it('is the documented directive set in production', () => {
    expect(prod).toContain("default-src 'none'");
    expect(prod).toContain("script-src 'self'");
    expect(prod).toContain("style-src 'self' 'unsafe-inline'");
    expect(prod).toContain('connect-src http://127.0.0.1:*');
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("base-uri 'none'");
  });

  it('never allows unsafe-inline or unsafe-eval in script-src (production)', () => {
    expect(isStrictScriptPolicy(prod)).toBe(true);
    const script = PRODUCTION_CSP_DIRECTIVES.find(([n]) => n === 'script-src')![1];
    expect(script).not.toContain('unsafe');
  });

  it('adds the dev origin and ws only in development', () => {
    const dev = buildCsp({ devOrigin: 'http://127.0.0.1:4120' });
    expect(dev).toContain('http://127.0.0.1:4120');
    expect(dev).toContain('ws://127.0.0.1:4120');
    expect(dev).toContain('connect-src http://127.0.0.1:* http://127.0.0.1:4120 ws://127.0.0.1:4120');
    // dev relaxation intentionally allows inline script for Vite HMR; production must not.
    expect(isStrictScriptPolicy(dev)).toBe(false);
  });
});
