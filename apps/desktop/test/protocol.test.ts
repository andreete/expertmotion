import { describe, expect, it } from 'vitest';
import { resolveAppUrl } from '../src/lib/protocol.js';

const root = '/app/dist/ui';

describe('app:// path resolution (SEC-025)', () => {
  it('serves index.html for the root', () => {
    const r = resolveAppUrl({ root, url: 'app://expertmotion/' });
    expect(r).toEqual({ ok: true, absolutePath: '/app/dist/ui/index.html', relativePath: 'index.html' });
  });

  it('resolves a hashed asset', () => {
    const r = resolveAppUrl({ root, url: 'app://expertmotion/assets/app-ab12.js' });
    expect(r.ok && r.relativePath).toBe('assets/app-ab12.js');
  });

  it('falls back to index.html for extensionless (SPA) routes', () => {
    const r = resolveAppUrl({ root, url: 'app://expertmotion/projects/123' });
    expect(r.ok && r.relativePath).toBe('index.html');
  });

  it('never lets a traversal payload escape the Editor root (SEC-025 containment)', () => {
    // The URL parser + posix-normalize collapse `..` so the result either is rejected or stays
    // inside `root`; the prefix check is the real guard. Escaping the root must be impossible.
    for (const url of [
      'app://expertmotion/../main.cjs',
      'app://expertmotion/..%2f..%2fmain.cjs',
      'app://expertmotion/assets/..%2f..%2f..%2fetc%2fpasswd',
      'app://expertmotion/%2e%2e/secrets',
    ]) {
      const r = resolveAppUrl({ root, url });
      if (r.ok) expect(r.absolutePath.startsWith(`${root}/`), url).toBe(true);
    }
  });

  it('rejects a NUL byte and malformed percent-encoding', () => {
    expect(resolveAppUrl({ root, url: 'app://expertmotion/a%00b' }).ok).toBe(false);
    expect(resolveAppUrl({ root, url: 'app://expertmotion/%zz' }).ok).toBe(false);
  });

  it('rejects backslash smuggling', () => {
    const r = resolveAppUrl({ root, url: 'app://expertmotion/..\\..\\main.cjs' });
    expect(r.ok).toBe(false);
  });

  it('rejects a foreign host and non-app scheme', () => {
    expect(resolveAppUrl({ root, url: 'app://evil/index.html' }).ok).toBe(false);
    expect(resolveAppUrl({ root, url: 'http://expertmotion/index.html' }).ok).toBe(false);
  });

  it('joins with the Windows separator when asked', () => {
    const r = resolveAppUrl({ root: 'C:\\app\\dist\\ui', url: 'app://expertmotion/assets/x.css', sep: '\\' });
    expect(r.ok && r.absolutePath).toBe('C:\\app\\dist\\ui\\assets\\x.css');
  });
});
