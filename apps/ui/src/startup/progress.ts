// Startup splash logic (FR-184): phase → overall progress, the elapsed-time clock, and the language before Settings load.
// Pure functions (no React), unit-tested.
import type { StartupPhase } from '../api/client.js';
import type { Lang } from '../i18n/index.js';

/** The splash shows elapsed seconds after 5 s and a "still working" line after 20 s. */
export const SPLASH_ELAPSED_AFTER_MS = 5_000;
export const SPLASH_SLOW_AFTER_MS = 20_000;

/** Share of the bar per phase: [start, end]. Integrity and service dominate on a slow laptop (QA 2026-10-26). */
const SEGMENTS: Record<StartupPhase, readonly [number, number]> = {
  integrity: [0, 0.3], keyring: [0.3, 0.35], service: [0.35, 0.85], project: [0.85, 0.98],
};

/**
 * Overall bar value 0…1. With a reported progress (integrity) the segment fills by it; otherwise it eases toward 90 % of the
 * segment over time (never reaches the end, so a long wait never looks finished). Unknown phase → 0.02 (just started).
 */
export function splashProgress(phase: StartupPhase | undefined, progress: number | undefined, msInPhase: number): number {
  if (!phase) return 0.02;
  const [a, b] = SEGMENTS[phase];
  const f = progress !== undefined ? Math.min(1, Math.max(0, progress)) : 0.9 * (1 - Math.exp(-Math.max(0, msInPhase) / 12_000));
  return a + (b - a) * f;
}

// ── elapsed clock: counts from the Shell's start when it reported `sinceMs`, else from the page load ──
const pageStart = Date.now() - (typeof performance !== 'undefined' ? performance.now() : 0);
let shellStart: number | null = null;
export function noteShellSince(sinceMs: number | undefined, now = Date.now()): void { if (sinceMs !== undefined) shellStart = now - sinceMs; }
export function startupElapsedMs(now = Date.now()): number { return Math.max(0, now - (shellStart ?? pageStart)); }
/** Tests only. */
export function resetStartupClock(): void { shellStart = null; }

// ── language: Settings are not loaded yet, so the splash uses the last language the Editor showed ──
export const LANG_KEY = 'expertmotion.lang';
export function startupLang(): Lang {
  try { const v = globalThis.localStorage?.getItem(LANG_KEY); if (v === 'en' || v === 'id') return v; } catch { /* storage blocked */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  return /^(id|in)\b/i.test(nav) ? 'id' : 'en';
}
export function rememberLang(lang: Lang): void { try { globalThis.localStorage?.setItem(LANG_KEY, lang); } catch { /* storage blocked */ } }
