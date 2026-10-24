// SSE client per docs/API_SPECIFICATION.md §7.4: EventSource on /api/v1/events?token=…, `seq` dedupe (drop seq ≤ lastSeq),
// heartbeat watchdog (35 s silence = dead), offline after 3 consecutive failures within 30 s with /health polling every 2 s,
// resync (R-016 + R-112) on `service.notice {kind:'resync'}` or when the Service restarted (health.seq < lastSeq).
import { EVENT_NAMES, type EventName, type ServiceEvent } from './types.js';

export interface MessageLike { data: string; lastEventId?: string }
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: MessageLike) => void): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'offline';

export interface EventStreamOptions {
  url: string;
  createSource?: (url: string) => EventSourceLike;
  onEvent: (ev: ServiceEvent) => void;
  onStatus?: (status: StreamStatus, attempt: number) => void;
  /** Called when state must be reloaded from REST (gap larger than the replay buffer, or Service restart). */
  onResync?: () => void;
  /** GET /health without token; resolves null when unreachable. */
  healthCheck?: () => Promise<{ seq?: number } | null>;
  storageKey?: string;
  timers?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void; now: () => number };
}

export interface EventStream { close(): void; lastSeq(): number; status(): StreamStatus; reconnectNow(): void }

const HEARTBEAT_DEAD_MS = 35_000, FAIL_WINDOW_MS = 30_000, HEALTH_POLL_MS = 2_000, MAX_FAILS = 3;

function readSeq(key: string | undefined): number {
  if (!key) return 0;
  try { const v = Number(globalThis.sessionStorage?.getItem(key)); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
}
function writeSeq(key: string | undefined, seq: number): void {
  if (!key) return;
  try { globalThis.sessionStorage?.setItem(key, String(seq)); } catch { /* storage may be unavailable */ }
}

export function parseEvent(name: string, raw: string): ServiceEvent | null {
  if (!(EVENT_NAMES as readonly string[]).includes(name)) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (typeof data !== 'object' || data === null) return null;
  const seq = (data as { seq?: unknown }).seq;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  return { name: name as EventName, data } as ServiceEvent;
}

export function createEventStream(opts: EventStreamOptions): EventStream {
  const timers = opts.timers ?? { setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms), clearInterval: (h: unknown) => globalThis.clearInterval(h as ReturnType<typeof setInterval>), now: () => Date.now() };
  const create = opts.createSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  let lastSeq = readSeq(opts.storageKey);
  let source: EventSourceLike | null = null;
  let status: StreamStatus = 'connecting';
  let failures: number[] = [];
  let lastActivity = timers.now();
  let closed = false;
  let healthTimer: unknown = null;
  let polling = false;

  const setStatus = (s: StreamStatus, attempt = failures.length) => { status = s; opts.onStatus?.(s, attempt); };

  const handle = (name: string, ev: MessageLike) => {
    lastActivity = timers.now();
    const parsed = parseEvent(name, ev.data);
    if (!parsed) return;
    if (parsed.data.seq <= lastSeq) return;                              // dedupe (§7.2)
    lastSeq = parsed.data.seq;
    writeSeq(opts.storageKey, lastSeq);
    if (parsed.name === 'service.notice' && parsed.data.kind === 'resync') opts.onResync?.();
    opts.onEvent(parsed);
  };

  const open = () => {
    if (closed) return;
    source?.close();
    const s = create(opts.url);
    source = s;
    for (const name of EVENT_NAMES) s.addEventListener(name, (ev) => handle(name, ev));
    s.onopen = () => { lastActivity = timers.now(); failures = []; setStatus('open', 0); };
    s.onerror = () => onFailure();
  };

  const onFailure = () => {
    if (closed || polling) return;
    const now = timers.now();
    failures = [...failures.filter((t) => now - t < FAIL_WINDOW_MS), now];
    if (failures.length >= MAX_FAILS) { goOffline(); return; }
    setStatus('reconnecting');                                           // the browser retries after `retry: 2000`
  };

  const goOffline = () => {
    source?.close(); source = null;
    setStatus('offline');
    polling = true;
    const poll = async () => {
      const h = await (opts.healthCheck?.() ?? Promise.resolve(null)).catch(() => null);
      if (!h || closed || !polling) return;
      polling = false;
      if (healthTimer !== null) { timers.clearInterval(healthTimer); healthTimer = null; }
      failures = [];
      const restarted = typeof h.seq === 'number' && h.seq < lastSeq;
      if (restarted) { lastSeq = 0; writeSeq(opts.storageKey, 0); }
      setStatus('connecting', 0);
      open();
      opts.onResync?.();                                                 // offline gap: always reload state (§7.4 step 4)
    };
    healthTimer = timers.setInterval(() => { void poll(); }, HEALTH_POLL_MS);
  };

  const watchdog = timers.setInterval(() => {
    if (closed || polling || !source) return;
    if (timers.now() - lastActivity <= HEARTBEAT_DEAD_MS) return;
    // `: ping` comments are not observable from EventSource, so silence alone cannot prove death: confirm with /health first.
    lastActivity = timers.now();
    void (opts.healthCheck?.() ?? Promise.resolve({})).catch(() => null).then((h) => { if (!h && !closed) { onFailure(); if (!polling) open(); } });
  }, 5_000);

  setStatus('connecting', 0);
  open();

  return {
    close() { closed = true; source?.close(); source = null; timers.clearInterval(watchdog); if (healthTimer !== null) timers.clearInterval(healthTimer); },
    lastSeq: () => lastSeq,
    status: () => status,
    reconnectNow() { if (closed) return; polling = false; if (healthTimer !== null) { timers.clearInterval(healthTimer); healthTimer = null; } failures = []; setStatus('connecting', 0); open(); },
  };
}
