// @vitest-environment jsdom
// FR-203 (QA 2026-10-27): bundled fonts load through FontFace url() sources (CSP font-src), never fetch() (CSP connect-src
// blocks app:// in the packaged Editor → "TypeError: Failed to fetch" at fetchFontData); a failing font is reported once and
// skipped, the load never rejects (no unhandled rejection) and always releases the render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledFontFiles, ensureFontsLoaded, loadFontFace, resetFontsForTests } from '../src/fonts.js';

type FakeFace = { family: string; source: string; desc: Record<string, unknown>; load: () => Promise<FakeFace> };
let added: FakeFace[] = []; let failFamily: string | null = null; let made: FakeFace[] = [];
beforeEach(() => {
  added = []; made = []; failFamily = null; resetFontsForTests();
  (globalThis as Record<string, unknown>)['FontFace'] = class {
    family: string; source: string; desc: Record<string, unknown>;
    constructor(family: string, source: string, desc: Record<string, unknown>) { this.family = family; this.source = source; this.desc = desc; made.push(this as unknown as FakeFace); }
    load() { return failFamily === this.family ? Promise.reject(new DOMException('A network error occurred.', 'NetworkError')) : Promise.resolve(this); }
  };
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add: (f: FakeFace) => { added.push(f); } } });
});
afterEach(() => { delete (globalThis as Record<string, unknown>)['FontFace']; vi.restoreAllMocks(); });

describe('bundled fonts (FR-203)', () => {
  it('every catalogue font file is a woff2 under fonts/, loaded from a url() source without fetch()', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    const files = bundledFontFiles((p) => `app://expertmotion/${p}`);
    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(files.every((f) => /^app:\/\/expertmotion\/fonts\/[a-z0-9-]+-\d00-(normal|italic)\.woff2$/.test(f.url))).toBe(true);
    const r = await ensureFontsLoaded();
    expect(r.failed).toEqual([]);
    expect(r.loaded).toBe(files.length);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(made[0]!.source).toMatch(/^url\(".+\.woff2"\) format\("woff2"\)$/);
    expect(added.length).toBe(files.length);
    vi.unstubAllGlobals();
  });
  it('a font that cannot load is skipped with one EM-8014 warning; the promise resolves (no unhandled rejection)', async () => {
    failFamily = 'Inter';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await ensureFontsLoaded();
    expect(r.failed.length).toBe(10);                                          // Inter: 5 weights × 2 styles
    expect(r.failed.every((f) => f.startsWith('Inter '))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('EM-8014');
    expect(await ensureFontsLoaded()).toBe(r);                                 // once per page
  });
  it('without the Font Loading API (jsdom, old engines) nothing throws and nothing is fetched', async () => {
    delete (globalThis as Record<string, unknown>)['FontFace'];
    expect(await loadFontFace({ family: 'Inter', url: '/fonts/x.woff2', weight: '400', style: 'normal' })).toBe(false);
    const r = await ensureFontsLoaded();
    expect(r.loaded).toBe(0);
  });
  it('a font load that hangs times out instead of holding the render', async () => {
    (globalThis as Record<string, unknown>)['FontFace'] = class { load() { return new Promise(() => undefined); } };
    expect(await loadFontFace({ family: 'Inter', url: '/fonts/x.woff2', weight: '400', style: 'normal' }, 30)).toBe(false);
  });
});
