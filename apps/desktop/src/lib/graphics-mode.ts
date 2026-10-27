/**
 * Safe graphics mode, GPU-crash counting and the crash-loop guard (FR-196, FR-197; QA 2026-10-27: the window goes completely
 * black on a T0 laptop with a ~1 GB-VRAM iGPU, at startup and after connecting a provider, and nothing can be clicked).
 * Pure module: no `electron` import (unit-tested on Linux); main.ts reads / writes the two small JSON files and wires the events.
 *
 * Files (both under `%APPDATA%\Expertmotion\data`, written atomically, no secrets, no project content):
 *   - `graphics.json` {mode, reason?, since?, notified?, abnormalStreak} — persisted across launches.
 *   - `session.json`  {state: 'running' | 'clean', startedAt, version, safeGraphics} — the clean-shutdown marker.
 *
 * Rules:
 *   1. GPU process gone (app `child-process-gone`, type GPU, not a clean exit): the first crash reloads the Editor window
 *      (a GPU crash leaves a black but "alive" window); a second crash within GPU_CRASH_WINDOW_MS persists
 *      `{mode:'safe', reason:'gpu-crash'}` and relaunches; the next launch calls `app.disableHardwareAcceleration()`.
 *   2. Crash loop: when the previous session has no clean-shutdown marker it ended abnormally (killed in Task Manager because
 *      the window was black, a Chromium "GPU process isn't usable" abort, power loss). Two such sessions in a row start the
 *      next one in safe graphics mode (`reason:'crash-loop'`). A clean exit resets the streak.
 *   3. Way back: safe graphics mode ends by itself after SAFE_MODE_DAYS (the next launch tries the GPU again; a new crash
 *      pair switches it back on), or at once from the tray ("Mulai ulang dengan akselerasi GPU") or the dialog shown at the
 *      first safe launch ("Kembali ke mode normal"). `--safe-graphics` forces it for one launch without persisting.
 */

export const GPU_CRASH_WINDOW_MS = 10 * 60 * 1000;
export const GPU_CRASHES_FOR_SAFE_MODE = 2;
export const ABNORMAL_SESSIONS_FOR_SAFE_MODE = 2;
export const SAFE_MODE_DAYS = 7;
export const SAFE_MODE_MS = SAFE_MODE_DAYS * 24 * 60 * 60 * 1000;
/** One-launch switch (not persisted). */
export const SAFE_GRAPHICS_SWITCH = '--safe-graphics';

export const SAFE_MODE_REASONS = ['gpu-crash', 'crash-loop', 'user', 'display-stall'] as const;
export type SafeModeReason = (typeof SAFE_MODE_REASONS)[number];

export interface GraphicsState {
  mode: 'hardware' | 'safe';
  reason?: SafeModeReason;
  /** When safe mode was switched on (ms since epoch). */
  since?: number;
  /** Whether the "Mode grafis aman aktif" dialog was shown for this activation. */
  notified?: boolean;
  /** Abnormal session ends in a row (rule 2). */
  abnormalStreak: number;
}
export const defaultGraphicsState: GraphicsState = { mode: 'hardware', abnormalStreak: 0 };

export interface SessionMarker { state: 'running' | 'clean'; startedAt: number; version: string; safeGraphics: boolean }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Defensive parse of graphics.json: anything unreadable is the default (hardware, streak 0). */
export function parseGraphicsState(raw: unknown): GraphicsState {
  if (typeof raw !== 'object' || raw === null) return { ...defaultGraphicsState };
  const r = raw as Record<string, unknown>;
  const out: GraphicsState = { mode: r['mode'] === 'safe' ? 'safe' : 'hardware', abnormalStreak: isNum(r['abnormalStreak']) ? Math.max(0, Math.min(100, Math.floor(r['abnormalStreak']))) : 0 };
  if (out.mode === 'safe') {
    out.reason = (SAFE_MODE_REASONS as readonly unknown[]).includes(r['reason']) ? (r['reason'] as SafeModeReason) : 'user';
    if (isNum(r['since'])) out.since = r['since'];
    if (r['notified'] === true) out.notified = true;
  }
  return out;
}

/** Defensive parse of session.json; null when absent / unreadable (first launch, or a deleted file: not counted). */
export function parseSessionMarker(raw: unknown): SessionMarker | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['state'] !== 'running' && r['state'] !== 'clean') return null;
  return { state: r['state'], startedAt: isNum(r['startedAt']) ? r['startedAt'] : 0, version: typeof r['version'] === 'string' ? r['version'].slice(0, 40) : '', safeGraphics: r['safeGraphics'] === true };
}

export interface StartupFacts {
  graphics: GraphicsState;
  previous: SessionMarker | null;
  now: number;
  argv: readonly string[];
}
export type StartupEvent = 'previous-abnormal' | 'crash-loop-safe-mode' | 'safe-mode-expired' | 'forced-by-switch';
export interface StartupDecision {
  /** Call app.disableHardwareAcceleration() before ready. */
  safe: boolean;
  reason: SafeModeReason | null;
  /** State to persist now (streak updated, expiry applied). */
  next: GraphicsState;
  events: StartupEvent[];
  /** Show the "Mode grafis aman aktif" dialog once the window is visible. */
  notify: boolean;
}

/** Decides the graphics mode of this launch (rules 2 and 3). Call before `app.whenReady()`. */
export function decideStartup(f: StartupFacts): StartupDecision {
  const events: StartupEvent[] = [];
  let next: GraphicsState = { ...f.graphics };
  const abnormal = f.previous?.state === 'running';
  if (abnormal) { events.push('previous-abnormal'); next.abnormalStreak = next.abnormalStreak + 1; }
  else if (f.previous?.state === 'clean') next.abnormalStreak = 0;
  // rule 3: expiry (a safe mode without a start time expires now: it cannot be dated)
  if (next.mode === 'safe' && (next.since === undefined || f.now - next.since >= SAFE_MODE_MS || next.since > f.now + 60_000)) {
    events.push('safe-mode-expired');
    next = { mode: 'hardware', abnormalStreak: 0 };
  }
  // rule 2: crash loop (only switches on; a running safe mode keeps its reason)
  if (next.mode === 'hardware' && next.abnormalStreak >= ABNORMAL_SESSIONS_FOR_SAFE_MODE) {
    events.push('crash-loop-safe-mode');
    next = { mode: 'safe', reason: 'crash-loop', since: f.now, abnormalStreak: 0 };
  }
  const forced = f.argv.includes(SAFE_GRAPHICS_SWITCH);
  if (forced && next.mode !== 'safe') events.push('forced-by-switch');
  const safe = next.mode === 'safe' || forced;
  const notify = next.mode === 'safe' && next.notified !== true;
  return { safe, reason: next.mode === 'safe' ? (next.reason ?? 'user') : forced ? 'user' : null, next, events, notify };
}

/** The persisted state when safe mode is switched on now (rule 1, a dialog choice or the tray). */
export function enableSafeMode(state: GraphicsState, reason: SafeModeReason, now: number): GraphicsState {
  return { mode: 'safe', reason, since: now, abnormalStreak: state.abnormalStreak };
}
/** The persisted state when the Creator turns safe mode off (tray / dialog). */
export function disableSafeMode(): GraphicsState {
  return { mode: 'hardware', abnormalStreak: 0 };
}

export function runningMarker(now: number, version: string, safeGraphics: boolean): SessionMarker { return { state: 'running', startedAt: now, version, safeGraphics }; }
export function cleanMarker(m: SessionMarker): SessionMarker { return { ...m, state: 'clean' }; }

// ---------------------------------------------------------------------------------------------
// Rule 1: GPU process crashes.
// ---------------------------------------------------------------------------------------------
export interface GpuCrashState { crashes: number[] }
export const initialGpuCrashState: GpuCrashState = { crashes: [] };
export interface ChildGoneDetails { type: string; reason: string; exitCode: number; name?: string | undefined; serviceName?: string | undefined }
export type GpuDecision =
  | { action: 'ignore'; state: GpuCrashState }
  | { action: 'log'; state: GpuCrashState }
  | { action: 'reload'; state: GpuCrashState; crashesInWindow: number }
  | { action: 'safe-mode'; state: GpuCrashState; crashesInWindow: number };

/**
 * What to do when a child process is gone. GPU crashes are counted within GPU_CRASH_WINDOW_MS; other child types are only
 * logged (the Local Service has its own supervisor). Already in safe mode, a GPU crash only reloads (nothing safer exists).
 */
export function onChildProcessGone(state: GpuCrashState, d: ChildGoneDetails, now: number, ctx: { shuttingDown: boolean; safeMode: boolean }): GpuDecision {
  if (ctx.shuttingDown) return { action: 'ignore', state };
  if (d.type !== 'GPU') return { action: d.reason === 'clean-exit' ? 'ignore' : 'log', state };
  if (d.reason === 'clean-exit') return { action: 'ignore', state };
  const crashes = [...state.crashes.filter((t) => now - t <= GPU_CRASH_WINDOW_MS && t <= now), now].slice(-10);
  const next = { crashes };
  if (!ctx.safeMode && crashes.length >= GPU_CRASHES_FOR_SAFE_MODE) return { action: 'safe-mode', state: { crashes: [] }, crashesInWindow: crashes.length };
  return { action: 'reload', state: next, crashesInWindow: crashes.length };
}

// ---------------------------------------------------------------------------------------------
// Native copy (Indonesian first: the Creator's language; ERROR_CATALOGUE EM-8010, EM-8011).
// ---------------------------------------------------------------------------------------------
const REASON_ID: Record<SafeModeReason, string> = {
  'gpu-crash': 'Kartu grafis (GPU) berhenti dua kali dalam 10 menit.',
  'crash-loop': 'Expertmotion tidak tertutup dengan normal dua kali berturut-turut.',
  user: 'Kamu memilih mode ini.',
  'display-stall': 'Tampilan berhenti merespons.',
};

/** Dialog shown once at the first launch in safe graphics mode. Index 0 = Oke, 1 = back to normal (relaunch with the GPU). */
export function safeModeDialog(reason: SafeModeReason): { title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number } {
  return {
    title: 'Expertmotion',
    message: 'Mode grafis aman aktif',
    detail: `${REASON_ID[reason]} Expertmotion sekarang menggambar tampilan tanpa akselerasi GPU supaya layar tidak hitam. Pratinjau bisa sedikit lebih lambat; hasil render video tidak berubah.\n\nMode ini berakhir sendiri setelah ${SAFE_MODE_DAYS} hari, atau matikan lewat ikon Expertmotion di area notifikasi (tray).\n\nEM-8011`,
    buttons: ['Oke', 'Kembali ke mode normal'],
    defaultId: 0,
    cancelId: 0,
  };
}
export const safeModeChoice = (response: number): 'keep' | 'disable' => (response === 1 ? 'disable' : 'keep');
