// i18n per docs/ACCESSIBILITY_AND_I18N.md §4–§6: flat dotted keys in en.json / id.json, `t(key, vars)` with named
// arguments and the ICU plural subset `{count, plural, one {…} other {…}}` (Indonesian uses `other`), Intl formatters
// with an explicit locale. No dependency on an ICU library (none is installed); the subset covers every string we ship.
import { createContext, useContext } from 'react';
import en from './en.json';
import id from './id.json';

export type Lang = 'en' | 'id';
export type Vars = Record<string, string | number>;
export const LOCALES: Record<Lang, Record<string, string>> = { en: en as Record<string, string>, id: id as Record<string, string> };

/** Minimal ICU: `{name}` substitution and `{n, plural, one {...} other {...}}` with `#`. Unknown args render as "…". */
export function formatMessage(template: string, vars: Vars = {}, lang: Lang = 'en'): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch !== '{') { out += ch; i += 1; continue; }
    const end = matchBrace(template, i);
    if (end < 0) { out += template.slice(i); break; }
    const inner = template.slice(i + 1, end);
    out += renderArg(inner, vars, lang);
    i = end + 1;
  }
  return out;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let j = start; j < s.length; j++) {
    if (s[j] === '{') depth += 1;
    else if (s[j] === '}') { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

function renderArg(inner: string, vars: Vars, lang: Lang): string {
  const parts = inner.split(',');
  const name = parts[0]!.trim();
  if (parts.length >= 3 && parts[1]!.trim() === 'plural') {
    const n = Number(vars[name] ?? 0);
    const body = parts.slice(2).join(',');
    const cases = new Map<string, string>();
    let k = 0;
    while (k < body.length) {
      const open = body.indexOf('{', k);
      if (open < 0) break;
      const sel = body.slice(k, open).trim();
      const close = matchBrace(body, open);
      if (close < 0) break;
      cases.set(sel, body.slice(open + 1, close));
      k = close + 1;
    }
    const rule = new Intl.PluralRules(lang === 'id' ? 'id-ID' : 'en-US').select(n);
    const chosen = cases.get(`=${n}`) ?? cases.get(rule) ?? cases.get('other') ?? '';
    return formatMessage(chosen.replace(/#/g, formatNumber(n, lang)), vars, lang);
  }
  const v = vars[name];
  if (v === undefined) return '…';
  return typeof v === 'number' ? formatNumber(v, lang) : v;
}

export function translate(lang: Lang, key: string, vars?: Vars): string {
  const s = LOCALES[lang][key] ?? LOCALES.en[key];
  if (s === undefined) return key;
  return formatMessage(s, vars, lang);
}
export const hasKey = (key: string): boolean => key in LOCALES.en;

// ── formatters (§6) ──
const loc = (lang: Lang) => (lang === 'id' ? 'id-ID' : 'en-US');
export function formatNumber(n: number, lang: Lang = 'en', maxFrac = 2): string { return new Intl.NumberFormat(loc(lang), { maximumFractionDigits: maxFrac }).format(n); }
export function formatBytes(bytes: number, lang: Lang = 'en'): string {
  if (bytes >= 1e9) return `${new Intl.NumberFormat(loc(lang), { maximumFractionDigits: 1 }).format(bytes / 1e9)} GB`;
  if (bytes >= 1e6) return `${new Intl.NumberFormat(loc(lang), { maximumFractionDigits: 0 }).format(bytes / 1e6)} MB`;
  return `${new Intl.NumberFormat(loc(lang), { maximumFractionDigits: 0 }).format(Math.max(0, bytes) / 1e3)} KB`;
}
export function formatTokens(n: number, lang: Lang = 'en'): string {
  return lang === 'id' ? new Intl.NumberFormat('id-ID').format(n) : new Intl.NumberFormat('en-US').format(n).replace(/,/g, ' ');
}
export function formatMoney(usd: number | null, approximate: boolean, lang: Lang = 'en'): string {
  if (usd === null) return 'n/a';
  const v = new Intl.NumberFormat(loc(lang), { minimumFractionDigits: usd < 0.01 ? 3 : 2, maximumFractionDigits: usd < 0.01 ? 4 : 2 }).format(usd);
  return `${approximate ? '≈ ' : ''}$${v}`;
}
/** Timecode mm:ss.ff (frames two digits) — §6. */
export function formatTimecode(ms: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round((ms / 1000) * fps));
  const f = totalFrames % fps;
  const s = Math.floor(totalFrames / fps);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}
/** Short duration m:ss or h:mm:ss. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export function formatDate(iso: string, lang: Lang = 'en'): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(loc(lang), { dateStyle: 'medium', timeStyle: 'short', hour12: lang === 'en' }).format(d);
}

export interface I18n { lang: Lang; t: (key: string, vars?: Vars) => string; setLang: (l: Lang) => void }
export const I18nContext = createContext<I18n>({ lang: 'en', t: (k, v) => translate('en', k, v), setLang: () => undefined });
export const useI18n = (): I18n => useContext(I18nContext);
export const useT = (): I18n['t'] => useContext(I18nContext).t;
