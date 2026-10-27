// Start screen + crash-loop guard + safe open (FR-202; QA 2026-10-27 #2 / #6 / #7). The Editor used to reopen the most recent
// project on every launch and on every Reload; when that project's view crashed, the window showed the crash card again and
// again ("setelah error tidak bisa dibuka sama sekali, reload tidak berhasil"), and a new launch "still read the previous
// project". Now:
//   • every launch shows the Start screen (Recent projects, "Proyek baru", "Buka…"); only an in-window Reload of a healthy
//     project reopens it (sessionStorage survives a reload of the same window, not a new launch);
//   • the guard remembers which project was being opened. A crash of the whole Editor (top-level boundary) within
//     CRASH_WINDOW_MS after opening it, or an open that never settled because the renderer died (no clean page hide), counts
//     as one crash of that project; CRASH_LIMIT crashes within CRASH_MEMORY_MS block auto-open, and the Start screen says
//     "Proyek terakhir gagal dibuka" with "Buka dalam mode aman" / "Proyek baru";
//   • safe open renders the project without the assistant chat thread and without the live preview (both behind one click),
//     so a bad message or element cannot take the Editor down again.
// Window-local state in localStorage / sessionStorage (no Service change); every access is guarded (storage may be blocked).
import { useSyncExternalStore } from 'react';

export const GUARD_KEY = 'expertmotion.sessionGuard.v1';
export const REOPEN_KEY = 'expertmotion.reopen';
export const BOOT_ACTION_KEY = 'expertmotion.bootAction';
/** A crash this soon after opening a project counts against it. */
export const CRASH_WINDOW_MS = 60_000;
/** Crashes older than this are forgotten. */
export const CRASH_MEMORY_MS = 30 * 60_000;
/** This many recent crashes of one project stop it from opening automatically. */
export const CRASH_LIMIT = 2;

export interface GuardState {
  /** The project being opened and whether it survived CRASH_WINDOW_MS (or the page was hidden cleanly before). */
  open?: { projectId: string; at: number; settled: boolean } | undefined;
  /** Crash times per project (ms since epoch), newest last. */
  crashes: Record<string, number[]>;
}
export type BootAction = 'new' | 'pick';
export type StartNotice = { kind: 'crash-loop'; projectId: string } | { kind: 'abnormal'; projectId: string } | null;
export interface BootDecision {
  /** Project to open right away (in-window Reload of a healthy project, or the mock runtime's seed); null = Start screen. */
  open: string | null;
  notice: StartNotice;
  /** Projects that crashed CRASH_LIMIT times recently (the Start screen marks them and offers safe open). */
  blocked: string[];
  /** "Proyek baru" from the crash card: create a new project right after boot. */
  action: BootAction | null;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const local = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const session = (): Store | null => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };
const read = (s: Store | null, k: string): string | null => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const write = (s: Store | null, k: string, v: string | null): void => { try { if (v === null) s?.removeItem(k); else s?.setItem(k, v); } catch { /* storage blocked */ } };

export function loadGuard(): GuardState {
  try {
    const raw = JSON.parse(read(local(), GUARD_KEY) ?? 'null') as Partial<GuardState> | null;
    const crashes: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(raw?.crashes ?? {})) if (Array.isArray(v)) crashes[k] = v.filter((n): n is number => typeof n === 'number').slice(-10);
    const o = raw?.open;
    const open = o && typeof o.projectId === 'string' && typeof o.at === 'number' ? { projectId: o.projectId, at: o.at, settled: o.settled === true } : undefined;
    return { crashes, ...(open ? { open } : {}) };
  } catch { return { crashes: {} }; }
}
function saveGuard(g: GuardState): void { write(local(), GUARD_KEY, JSON.stringify(g)); }

const recent = (g: GuardState, id: string, now: number) => (g.crashes[id] ?? []).filter((t) => now - t <= CRASH_MEMORY_MS);
export function isBlocked(g: GuardState, id: string, now = Date.now()): boolean { return recent(g, id, now).length >= CRASH_LIMIT; }

/**
 * Pure boot decision. `reopen`: the project an in-window Reload asked for; `seed`: the mock runtime's project (tests / demo,
 * which keep the old auto-open); `lastProjectId`: the most recent project (for the notice). Also returns the guard with the
 * previous unsettled open counted as a crash (renderer died, or the window was killed, before the project settled).
 */
export function decideBoot(g: GuardState, input: { reopen: string | null; seed: string | null; lastProjectId: string | null; action: string | null; now: number }): { decision: BootDecision; guard: GuardState } {
  const now = input.now;
  const guard: GuardState = { crashes: { ...g.crashes }, ...(g.open ? { open: g.open } : {}) };
  let abnormal: string | null = null;
  if (guard.open && !guard.open.settled) {
    abnormal = guard.open.projectId;
    guard.crashes[abnormal] = [...(guard.crashes[abnormal] ?? []), guard.open.at].slice(-10);
  }
  delete guard.open;
  for (const k of Object.keys(guard.crashes)) { const r = recent(guard, k, now); if (r.length) guard.crashes[k] = r; else delete guard.crashes[k]; }
  const blocked = Object.keys(guard.crashes).filter((k) => isBlocked(guard, k, now));
  const action: BootAction | null = input.action === 'new' || input.action === 'pick' ? input.action : null;
  const want = action ? null : input.reopen ?? input.seed;
  const open = want && !blocked.includes(want) ? want : null;
  const focus = want ?? abnormal ?? input.lastProjectId;
  const notice: StartNotice = open ? null
    : focus && blocked.includes(focus) ? { kind: 'crash-loop', projectId: focus }
      : abnormal ? { kind: 'abnormal', projectId: abnormal } : null;
  return { decision: { open, notice, blocked, action }, guard };
}

// ── runtime side (one Editor window) ──
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let currentDecision: BootDecision | null = null;

/** Called once by the store's boot: applies the decision to the stored guard and clears the one-shot keys. */
export function bootDecision(input: { seed: string | null; lastProjectId: string | null; now?: number }): BootDecision {
  const g = loadGuard();
  // A second boot in the same page (licence activated, Service restarted) is not a new launch: the open project is alive.
  const base = currentDecision !== null && g.open ? { ...g, open: { ...g.open, settled: true } } : g;
  const { decision, guard } = decideBoot(base, { reopen: read(session(), REOPEN_KEY), seed: input.seed, lastProjectId: input.lastProjectId, action: read(session(), BOOT_ACTION_KEY), now: input.now ?? Date.now() });
  saveGuard(guard);
  write(session(), BOOT_ACTION_KEY, null);
  currentDecision = decision;
  return decision;
}
export function lastBootDecision(): BootDecision | null { return currentDecision; }

/** A project is being opened: remember it until it survived CRASH_WINDOW_MS (then its crash count is cleared). */
export function noteProjectOpening(projectId: string, now = Date.now()): void {
  if (safe.on && safe.projectId !== projectId) setSafeMode(false);
  const g = loadGuard();
  saveGuard({ ...g, open: { projectId, at: now, settled: false } });
  write(session(), REOPEN_KEY, projectId);
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    const cur = loadGuard();
    if (cur.open?.projectId !== projectId) return;
    const crashes = { ...cur.crashes }; delete crashes[projectId];
    saveGuard({ crashes, open: { ...cur.open, settled: true } });
  }, CRASH_WINDOW_MS);
}
/** No project open any more (closed / deleted / Start screen). */
export function noteProjectClosed(): void {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  const g = loadGuard(); delete g.open; saveGuard(g);
  write(session(), REOPEN_KEY, null);
}
/** The whole Editor crashed (top-level boundary). Counts against the open project when it happened inside the window. */
export function noteEditorCrash(now = Date.now()): string | null {
  const g = loadGuard();
  const o = g.open;
  if (!o) return null;
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  const counts = !o.settled && now - o.at <= CRASH_WINDOW_MS;
  const crashes = { ...g.crashes };
  if (counts) crashes[o.projectId] = [...(crashes[o.projectId] ?? []), now].slice(-10);
  // settled: true — the crash is already counted here; the next boot must not count the same open again as "abnormal".
  saveGuard({ crashes, open: { ...o, settled: true } });
  return counts ? o.projectId : null;
}
/** The page is being hidden normally (close, quit, navigation): an unsettled open is not an abnormal end. */
export function notePageHidden(): void {
  const g = loadGuard();
  if (g.open && !g.open.settled) saveGuard({ ...g, open: { ...g.open, settled: true } });
}
/** Crash-card actions: what the next boot (after the reload) should do. */
export function requestBootAction(action: 'reload' | 'pick' | 'new'): void {
  if (action === 'reload') return;                                   // keeps REOPEN_KEY: the guard decides whether it reopens
  write(session(), REOPEN_KEY, null);
  write(session(), BOOT_ACTION_KEY, action);
}
/** Tests only. */
export function resetGuardForTests(): void {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  currentDecision = null;
  write(local(), GUARD_KEY, null); write(session(), REOPEN_KEY, null); write(session(), BOOT_ACTION_KEY, null);
  setSafeMode(false); logsDir = null;
}

// ── safe mode (this window only): chat thread and live preview stay hidden until the Creator shows them ──
export interface SafeMode { on: boolean; chat: boolean; preview: boolean; projectId?: string }
let safe: SafeMode = { on: false, chat: false, preview: false };
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };
/** Safe mode for one project; opening any other project ends it (noteProjectOpening). */
export function setSafeMode(on: boolean, projectId?: string): void { safe = { on, chat: false, preview: false, ...(on && projectId ? { projectId } : {}) }; emit(); }
/** "Tampilkan chat" / "Tampilkan pratinjau" inside safe mode. */
export function revealInSafeMode(part: 'chat' | 'preview'): void { if (safe.on) { safe = { ...safe, [part]: true }; emit(); } }
export function getSafeMode(): SafeMode { return safe; }
export function useSafeMode(): SafeMode {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, getSafeMode, getSafeMode);
}

// ── the log folder for the crash card ("Buka folder log"); the Shell sends it with every service state ──
let logsDir: string | null = null;
export function noteLogsDir(dir: string | undefined): void { if (dir) logsDir = dir; }
export function getLogsDir(): string | null { return logsDir; }
