/**
 * Renderer heartbeat watchdog (FR-198; QA 2026-10-27: a black window where nothing can be clicked, so in-app buttons are useless).
 * Pure module: no `electron` import, no dependencies (the sandboxed preload imports the constants and the payload shapes).
 *
 * The preload (not the Editor) sends, on the private channels IPC.heartbeat / IPC.rendererSignal (not part of window.expertmotion):
 *   - `first-paint` once the first animation frame after DOMContentLoaded ran (a frame was produced),
 *   - `editor-mounted` once the Editor layout (`[data-region="stage"]`) exists,
 *   - every HEARTBEAT_MS a beat `{seq, framed, visible}`: `framed` = the one requestAnimationFrame asked for after the previous
 *     beat has run (frames are still produced; a dead / hung GPU or compositor stops them while JS keeps running), `visible` =
 *     document.visibilityState (hidden / occluded pages produce no frames, so `framed` is ignored for them).
 * Main feeds the beats, the window facts (visible, minimized, focused) and a 1 s tick into this state machine and shows ONE native
 * dialog per episode ("Tampilan tidak merespons") when:
 *   - `no-heartbeat`: no beat for more than HEARTBEAT_STALL_MS while the window is visible and not minimized (JS thread hung),
 *   - `no-frames`: beats arrive but no frame for more than HEARTBEAT_STALL_MS while the page says it is visible (black window),
 *   - `no-first-paint`: no first paint within FIRST_PAINT_TIMEOUT_MS of the load start.
 * Hidden / minimized / unfocused-and-hidden time never counts (a grace window restarts when the window is shown again). After
 * "Tunggu" the same episode asks again after REASK_AFTER_MS; a beat with frames ends the episode (`recovered`).
 */

export const HEARTBEAT_MS = 2_000;
export const HEARTBEAT_STALL_MS = 10_000;
export const FIRST_PAINT_TIMEOUT_MS = 45_000;
export const REASK_AFTER_MS = 60_000;
export const WATCHDOG_TICK_MS = 1_000;
/** The Editor layout's region (apps/ui App.tsx); its presence is the `editor-mounted` signal. */
export const EDITOR_MOUNT_SELECTOR = '[data-region="stage"]';

export type StallKind = 'no-heartbeat' | 'no-frames' | 'no-first-paint';
export const RENDERER_SIGNALS = ['first-paint', 'editor-mounted'] as const;
export type RendererSignal = (typeof RENDERER_SIGNALS)[number];

export interface Beat { seq: number; framed: boolean; visible: boolean }
export interface SignalMsg { kind: RendererSignal; atMs?: number }

/** Validates a heartbeat payload (main; the sender is checked separately). */
export function parseBeat(raw: unknown): Beat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['seq'] !== 'number' || !Number.isInteger(r['seq']) || r['seq'] < 0 || typeof r['framed'] !== 'boolean' || typeof r['visible'] !== 'boolean') return null;
  return { seq: r['seq'], framed: r['framed'], visible: r['visible'] };
}
export function parseSignal(raw: unknown): SignalMsg | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!(RENDERER_SIGNALS as readonly unknown[]).includes(r['kind'])) return null;
  const at = r['atMs'];
  return { kind: r['kind'] as RendererSignal, ...(typeof at === 'number' && Number.isFinite(at) && at >= 0 && at < 3_600_000 ? { atMs: Math.round(at) } : {}) };
}

export interface WatchState {
  loadStartedAt: number | null;
  firstPaintAt: number | null;
  mountedAt: number | null;
  lastBeatAt: number | null;
  lastFramedAt: number | null;
  lastVisible: boolean;
  /** No stall is reported before this time (window just shown / restored / focused). */
  graceUntil: number;
  stalled: StallKind | null;
  stalledSince: number | null;
  askedAt: number | null;
}
export const initialWatchState: WatchState = {
  loadStartedAt: null, firstPaintAt: null, mountedAt: null, lastBeatAt: null, lastFramedAt: null, lastVisible: true, graceUntil: 0, stalled: null, stalledSince: null, askedAt: null,
};

/** A new document starts loading (first load or reload): everything about the old one is forgotten. */
export function onLoadStart(_s: WatchState, now: number): WatchState {
  return { ...initialWatchState, loadStartedAt: now, graceUntil: now };
}

export function onSignal(s: WatchState, sig: SignalMsg, now: number): WatchState {
  if (sig.kind === 'first-paint') return s.firstPaintAt !== null ? s : { ...s, firstPaintAt: now, lastBeatAt: now, lastFramedAt: now, lastVisible: true };
  return s.mountedAt !== null ? s : { ...s, mountedAt: now };
}

export function onBeat(s: WatchState, b: Beat, now: number): WatchState {
  // A hidden page produces no frames: no evidence either way, so the frame clock does not age while hidden.
  return { ...s, lastBeatAt: now, lastVisible: b.visible, lastFramedAt: b.framed || !b.visible ? now : s.lastFramedAt ?? now, firstPaintAt: s.firstPaintAt ?? now };
}

export interface WindowFacts { visible: boolean; minimized: boolean; focused: boolean; dialogOpen: boolean }
export type WatchDecision = { action: 'none' } | { action: 'ask'; kind: StallKind; stalledMs: number } | { action: 'recovered'; kind: StallKind; stalledMs: number };

/** The 1 s tick. Returns the new state and what main should do. */
export function onTick(s: WatchState, w: WindowFacts, now: number): { state: WatchState; decision: WatchDecision } {
  const none = { action: 'none' } as const;
  if (s.loadStartedAt === null) return { state: s, decision: none };
  // Hidden time never counts: minimized, not visible, or (page last said hidden and the window is not focused: occluded).
  if (!w.visible || w.minimized || (!s.lastVisible && !w.focused)) return { state: { ...s, graceUntil: now + HEARTBEAT_STALL_MS }, decision: none };
  let kind: StallKind | null = null;
  if (s.firstPaintAt === null) {
    if (now - s.loadStartedAt >= FIRST_PAINT_TIMEOUT_MS && now >= s.graceUntil) kind = 'no-first-paint';
  } else if (now >= s.graceUntil) {
    const sinceBeat = now - Math.max(s.lastBeatAt ?? s.firstPaintAt, s.graceUntil - HEARTBEAT_STALL_MS);
    const sinceFrame = now - Math.max(s.lastFramedAt ?? s.firstPaintAt, s.graceUntil - HEARTBEAT_STALL_MS);
    if (sinceBeat > HEARTBEAT_STALL_MS) kind = 'no-heartbeat';
    // QA 2026-10-30 (EM-8012 after 169 s, recovered 17 s later): a window behind another app stops painting without the page
    // reporting hidden; frames are only demanded while the window has focus (a black focused window is still caught).
    else if (s.lastVisible && w.focused && sinceFrame > HEARTBEAT_STALL_MS) kind = 'no-frames';
  }
  if (kind === null) {
    if (s.stalled === null) return { state: s, decision: none };
    const stalledMs = now - (s.stalledSince ?? now);
    return { state: { ...s, stalled: null, stalledSince: null, askedAt: null }, decision: { action: 'recovered', kind: s.stalled, stalledMs } };
  }
  const since = s.stalled === null ? now : s.stalledSince ?? now;
  const base: WatchState = { ...s, stalled: kind, stalledSince: since };
  if (w.dialogOpen) return { state: base, decision: none };                       // one dialog at a time (the hang dialog may be up)
  if (s.askedAt !== null && now - s.askedAt < REASK_AFTER_MS) return { state: base, decision: none };
  return { state: { ...base, askedAt: now }, decision: { action: 'ask', kind, stalledMs: now - since } };
}

// ---------------------------------------------------------------------------------------------
// Native dialog (EM-8012). Indonesian: the Creator's language. Index 0 is the default; Esc = Tunggu.
// ---------------------------------------------------------------------------------------------
const KIND_TEXT: Record<StallKind, string> = {
  'no-heartbeat': 'Jendela Expertmotion tidak merespons lebih dari 10 detik.',
  'no-frames': 'Jendela Expertmotion berhenti menggambar, jadi layar bisa terlihat hitam. Biasanya ini masalah kartu grafis (GPU).',
  'no-first-paint': 'Tampilan Expertmotion belum muncul setelah 45 detik.',
};
export const DISPLAY_STALL_BUTTONS = ['Muat ulang', 'Mode grafis aman', 'Buka folder log', 'Tunggu', 'Tutup'] as const;
export function displayStallDialog(kind: StallKind): { title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number } {
  return {
    title: 'Expertmotion',
    message: 'Tampilan tidak merespons',
    detail: `${KIND_TEXT[kind]} Proyek kamu tersimpan.\n\nMuat ulang: gambar ulang jendela.\nMode grafis aman: mulai ulang tanpa akselerasi GPU (pilih ini kalau layar sering hitam).\nBuka folder log: lihat catatan untuk dukungan.\nTutup: keluar dari Expertmotion.\n\nEM-8012`,
    buttons: [...DISPLAY_STALL_BUTTONS],
    defaultId: 0,
    cancelId: 3,
  };
}
export type StallChoice = 'reload' | 'safe-mode' | 'logs' | 'wait' | 'close';
export function stallChoice(response: number): StallChoice {
  return (['reload', 'safe-mode', 'logs', 'wait', 'close'] as const)[response] ?? 'wait';
}
