import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.json';
import id from '../src/i18n/id.json';
import { formatMessage, formatTimecode, translate } from '../src/i18n/index.js';

const EN = en as Record<string, string>, ID = id as Record<string, string>;
const args = (s: string) => new Set([...s.matchAll(/\{(\w+)(?:,|\})/g)].map((m) => m[1]));
/** Licence/legal texts may use the formal "Anda" (GLOSSARY "Words to avoid"; ERROR_CATALOGUE style guide: EM-5xxx). */
const LICENCE = (k: string) => k.startsWith('ui.scr.license.') || k.startsWith('err.EM-5') || k.startsWith('onb.license.');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(f) ? [p] : []; });
}

describe('locale files', () => {
  it('en.json and id.json have identical key sets', () => {
    expect(Object.keys(ID).sort()).toEqual(Object.keys(EN).sort());
  });
  it('have the same ICU arguments per key', () => {
    const mismatched = Object.keys(EN).filter((k) => { const a = args(EN[k]!), b = args(ID[k] ?? ''); return a.size !== b.size || [...a].some((x) => !b.has(x)); });
    expect(mismatched).toEqual([]);
  });
  it('never contain "Remason" and keep non-empty values', () => {
    for (const d of [EN, ID]) for (const [k, v] of Object.entries(d)) { expect(v, k).not.toMatch(/Remason/i); expect(v.trim().length, k).toBeGreaterThan(0); }
  });
  it('use the friendly "kamu" register: "Anda" only on licence/legal keys', () => {
    const offenders = Object.entries(ID).filter(([k, v]) => /\bAnda\b/.test(v) && !LICENCE(k)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });
  it('contain title/body/action copy for every EM- code referenced in the Editor source', () => {
    const src = sourceFiles(fileURLToPath(new NodeURL('../src', import.meta.url))).map((f) => readFileSync(f, 'utf8')).join('\n');
    const codes = new Set(src.match(/EM-\d{4}/g) ?? []);
    for (const c of codes) for (const part of ['title', 'body', 'action']) { expect(EN[`err.${c}.${part}`], `${c}.${part}`).toBeTruthy(); expect(ID[`err.${c}.${part}`], `${c}.${part}`).toBeTruthy(); }
  });
  it('define every statically referenced key (t("…"), textKey, labelKey, …)', () => {
    const src = sourceFiles(fileURLToPath(new NodeURL('../src', import.meta.url))).map((f) => readFileSync(f, 'utf8')).join('\n');
    const keys = new Set([...src.matchAll(/'((?:ui|a11y|onb|tour)\.[a-zA-Z0-9_.-]+)'/g)].map((m) => m[1]!));
    const missing = [...keys].filter((k) => !(k in EN) && !k.endsWith('.'));
    expect(missing).toEqual([]);
  });
});

describe('formatter', () => {
  it('substitutes named arguments and plurals', () => {
    expect(formatMessage('Hi {name}', { name: 'Septi' })).toBe('Hi Septi');
    expect(translate('en', 'ui.sys.toast.applied', { count: 1, version: 'ab12' })).toBe('Applied: 1 change · vab12');
    expect(translate('en', 'ui.sys.toast.applied', { count: 3, version: 'ab12' })).toBe('Applied: 3 changes · vab12');
    expect(translate('id', 'ui.sys.toast.applied', { count: 3, version: 'ab12' })).toBe('Diterapkan: 3 perubahan · vab12');
    expect(formatMessage('{missing} x')).toBe('… x');
  });
  it('falls back to English, then to the key itself', () => {
    expect(translate('id', 'no.such.key')).toBe('no.such.key');
  });
  it('formats timecodes as mm:ss.ff', () => {
    expect(formatTimecode(12_266, 30)).toBe('00:12.08');
    expect(formatTimecode(62_000, 25)).toBe('01:02.00');
  });
});
