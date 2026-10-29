// SEC-016 (round 2, QA 2026-10-29): the SSE stream is read with fetch() and the Service Token in the Authorization header, never
// in the URL. A browser EventSource cannot send headers, so the old `?token=` query put the token into every console line,
// network error and DevTools entry that names the URL. This reader implements the small EventSourceLike surface events.ts uses:
// text/event-stream parsing (event / data / id / retry, `:` comments), automatic reconnect after `retry` ms with Last-Event-ID,
// and close(). The token is read on every (re)connect, so a token rotated after a Service restart is used at once (FR-171).
import type { EventSourceLike, MessageLike } from './events.js';

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; cache?: 'no-store' }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
export interface FetchEventSourceOptions {
  /** Current Service Token (read on every connect). */
  token: () => string;
  fetch?: FetchLike;
  /** First reconnect delay; the Service's `retry:` field overrides it (2000 ms by default, §7.4). */
  retryMs?: number;
}

export class FetchEventSource implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private readonly listeners = new Map<string, Set<(ev: MessageLike) => void>>();
  private readonly fetchImpl: FetchLike;
  private ac: AbortController | null = null;
  private closed = false;
  private lastId = '';
  private retryMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string, private readonly opts: FetchEventSourceOptions) {
    this.fetchImpl = opts.fetch ?? ((u, init) => globalThis.fetch(u, init) as unknown as ReturnType<FetchLike>);
    this.retryMs = opts.retryMs ?? 2000;
    queueMicrotask(() => { void this.connect(); });
  }
  addEventListener(type: string, listener: (ev: MessageLike) => void): void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(listener);
  }
  close(): void {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.ac?.abort(); } catch { /* already aborted */ }
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const ac = new AbortController(); this.ac = ac;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.token()}`, Accept: 'text/event-stream' };
    if (this.lastId) headers['Last-Event-ID'] = this.lastId;
    try {
      const res = await this.fetchImpl(this.url, { headers, signal: ac.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);      // never the URL or headers in the message
      if (this.closed) return;
      this.onopen?.({});
      await this.read(res.body);
    } catch { /* network error, abort or HTTP error: reconnect below */ }
    if (this.closed) return;
    this.onerror?.({});
    this.timer = setTimeout(() => { this.timer = null; void this.connect(); }, this.retryMs);
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader(); const dec = new TextDecoder();
    let buf = '', event = '', data: string[] = [], id: string | null = null;
    const dispatch = () => {
      if (id !== null) this.lastId = id;
      if (data.length) {
        const msg: MessageLike = { data: data.join('\n'), lastEventId: this.lastId };
        for (const l of [...(this.listeners.get(event || 'message') ?? [])]) l(msg);
      }
      event = ''; data = []; id = null;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done || this.closed) return;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
        if (line === '') { dispatch(); continue; }
        if (line.startsWith(':')) continue;                                    // `: ping` heartbeat comment
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        const val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
        else if (field === 'id') { if (!val.includes('\0')) id = val; }
        else if (field === 'retry') { const n = Number(val); if (/^\d+$/.test(val) && n > 0) this.retryMs = n; }
      }
    }
  }
}
