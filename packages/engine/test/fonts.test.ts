// @vitest-environment jsdom
// FR-203 (QA 2026-10-27): bundled fonts load through FontFace url() sources (CSP font-src), never fetch() (CSP connect-src
// blocks app:// in the packaged Editor → "TypeError: Failed to fetch" at fetchFontData); a failing font is reported once and
// skipped, the load never rejects (no unhandled rejection) and always releases the render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
  it('every catalogue font file is a woff2 (or ADR-039 ttf) under fonts/, loaded from a url() source without fetch()', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    const files = bundledFontFiles((p) => `app://expertmotion/${p}`);
    expect(files.length).toBeGreaterThanOrEqual(45);
    expect(files.every((f) => /^app:\/\/expertmotion\/fonts\/[a-z0-9-]+-(\d00|var)-(normal|italic)\.(woff2|ttf)$/.test(f.url))).toBe(true);
    expect(files.filter((f) => f.family === 'Poppins').map((f) => `${f.weight}${f.style[0]}`)).toEqual(['500n', '600n', '700n', '800n', '900n']);   // Poppins: upright only, no italics
    expect(files.filter((f) => f.format === 'truetype').every((f) => f.url.endsWith('.ttf'))).toBe(true);
    // ADR-041: Playfair Display = two VARIABLE files, one FontFace per style with the weight RANGE (not one file per weight)
    expect(files.filter((f) => f.family === 'Playfair Display').map((f) => ({ w: f.weight, s: f.style, u: f.url.replace('app://expertmotion/', '') })))
      .toEqual([{ w: '400 900', s: 'normal', u: 'fonts/playfair-display-var-normal.ttf' }, { w: '400 900', s: 'italic', u: 'fonts/playfair-display-var-italic.ttf' }]);
    const r = await ensureFontsLoaded();
    expect(r.failed).toEqual([]);
    expect(r.loaded).toBe(files.length);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(made[0]!.source).toMatch(/^url\(".+\.woff2"\) format\("woff2"\)$/);
    expect(made.find((f) => f.family === 'Poppins')!.source).toMatch(/^url\(".*\/fonts\/poppins-500-normal\.ttf"\) format\("truetype"\)$/);
    expect(made.find((f) => f.family === 'Playfair Display')!.desc).toMatchObject({ weight: '400 900', style: 'normal' });
    expect(added.length).toBe(files.length);
    vi.unstubAllGlobals();
  });
  it('every declared font file exists in packages/engine/public/fonts with its licence beside it (offline rule)', () => {
    const pub = ['packages/engine/public', 'public'].map((d) => path.resolve(d)).find((d) => fs.existsSync(path.join(d, 'fonts')))!;   // jsdom: import.meta.url is http://, so resolve from the cwd (repo root or packages/engine)
    expect(pub).toBeDefined();
    for (const f of bundledFontFiles((p) => p)) expect(fs.existsSync(path.join(pub, f.url)), f.url).toBe(true);
    for (const lic of ['LICENSE-inter.txt', 'LICENSE-poppins.txt', 'LICENSE-playfair-display.txt']) expect(fs.existsSync(path.join(pub, 'fonts', lic)), lic).toBe(true);
    expect(fs.readFileSync(path.join(pub, 'fonts/LICENSE-playfair-display.txt'), 'utf8')).toContain('SIL Open Font License, Version 1.1');
    expect(fs.statSync(path.join(pub, 'fonts/playfair-display-var-italic.ttf')).size).toBeGreaterThan(100_000);
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
