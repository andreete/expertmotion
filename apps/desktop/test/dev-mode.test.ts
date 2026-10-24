import { describe, expect, it } from 'vitest';
import { editorEntryUrl, resolveDevRules } from '../src/lib/dev-mode.js';

describe('dev-mode rules (SEC-014)', () => {
  it('a packaged build ignores every EM_* relaxation', () => {
    const rules = resolveDevRules(true, { EM_TOKEN: 'devtoken', EM_UI_ORIGIN: 'http://127.0.0.1:4120' });
    expect(rules).toEqual({ allowDevOrigin: false, devOrigins: [], devToken: null, writeDevTokenFile: false });
  });

  it('a packaged build always loads the app:// scheme', () => {
    expect(editorEntryUrl(true, { EM_UI_PORT: '4120' })).toBe('app://expertmotion/index.html');
  });

  it('development exposes the Vite origins and generates a token when EM_TOKEN is absent', () => {
    const rules = resolveDevRules(false, {});
    expect(rules.allowDevOrigin).toBe(true);
    expect(rules.devOrigins).toEqual(['http://127.0.0.1:4120', 'http://localhost:4120']);
    expect(rules.devToken).toBeNull();
    expect(rules.writeDevTokenFile).toBe(true);
  });

  it('development honours an explicit EM_TOKEN and EM_UI_ORIGIN', () => {
    const rules = resolveDevRules(false, { EM_TOKEN: 'fixed', EM_UI_ORIGIN: 'http://127.0.0.1:9999' });
    expect(rules.devToken).toBe('fixed');
    expect(rules.writeDevTokenFile).toBe(false);
    expect(rules.devOrigins).toEqual(['http://127.0.0.1:9999']);
  });

  it('development loads the Vite dev server URL', () => {
    expect(editorEntryUrl(false, { EM_UI_PORT: '4120' })).toBe('http://127.0.0.1:4120/');
  });
});
