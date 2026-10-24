import { describe, expect, it, vi } from 'vitest';
import { createEventStream, type EventSourceLike, type MessageLike } from '../src/api/events.js';
import type { ServiceEvent } from '../src/api/types.js';

class FakeSource implements EventSourceLike {
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  listeners = new Map<string, (e: MessageLike) => void>();
  addEventListener(t: string, l: (e: MessageLike) => void) { this.listeners.set(t, l); }
  close() { this.closed = true; }
  send(name: string, data: Record<string, unknown>) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
}

function setup() {
  const sources: FakeSource[] = [];
  const events: ServiceEvent[] = [];
  const statuses: string[] = [];
  let now = 0;
  const intervals: Array<() => void> = [];
  const onResync = vi.fn();
  let healthy: { seq?: number } | null = null;
  const stream = createEventStream({
    url: 'x', createSource: () => { const s = new FakeSource(); sources.push(s); return s; }, onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s), onResync,
    healthCheck: async () => healthy, timers: { setInterval: (fn) => { intervals.push(fn); return intervals.length - 1; }, clearInterval: () => undefined, now: () => now },
  });
  return { stream, sources, events, statuses, onResync, tick: (ms: number) => { now += ms; }, runIntervals: () => intervals.forEach((f) => f()), setHealthy: (h: { seq?: number } | null) => { healthy = h; } };
}

describe('event stream', () => {
  it('drops events with seq ≤ lastSeq (dedupe) and ignores unknown or malformed events', () => {
    const t = setup();
    const s = t.sources[0]!;
    s.onopen?.({});
    s.send('intent.updated', { seq: 5, at: '', queue: {}, changed: [], reason: 'created' });
    s.send('intent.updated', { seq: 5, at: '', queue: {}, changed: [], reason: 'created' });
    s.send('intent.updated', { seq: 4, at: '', queue: {}, changed: [], reason: 'created' });
    s.send('composition.updated', { seq: 6, at: '' });
    s.listeners.get('plan.ready')?.({ data: '{not json' });
    s.send('plan.ready', { at: '' });
    expect(t.events.map((e) => e.data.seq)).toEqual([5, 6]);
    expect(t.stream.lastSeq()).toBe(6);
    expect(t.statuses).toContain('open');
  });

  it('calls onResync on service.notice {kind:"resync"}', () => {
    const t = setup();
    t.sources[0]!.send('service.notice', { seq: 1, at: '', kind: 'resync', from: 1, to: 900 });
    expect(t.onResync).toHaveBeenCalledTimes(1);
  });

  it('goes offline after three failures within 30 s, polls /health, then reconnects and resyncs', async () => {
    const t = setup();
    const s = t.sources[0]!;
    s.onerror?.({}); t.tick(1000); s.onerror?.({});
    expect(t.stream.status()).toBe('reconnecting');
    t.tick(1000); s.onerror?.({});
    expect(t.stream.status()).toBe('offline');
    expect(s.closed).toBe(true);
    t.runIntervals();
    await Promise.resolve();
    expect(t.stream.status()).toBe('offline');
    t.setHealthy({ seq: 3 });
    t.runIntervals();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.stream.status()).toBe('connecting');
    expect(t.sources).toHaveLength(2);
    expect(t.onResync).toHaveBeenCalled();
  });

  it('resets lastSeq when the Service restarted (health.seq < lastSeq)', async () => {
    const t = setup();
    t.sources[0]!.send('render.progress', { seq: 50, at: '' });
    for (let i = 0; i < 3; i++) t.sources[0]!.onerror?.({});
    t.setHealthy({ seq: 2 });
    t.runIntervals();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.stream.lastSeq()).toBe(0);
    t.sources[1]!.send('render.progress', { seq: 3, at: '' });
    expect(t.events.at(-1)?.data.seq).toBe(3);
  });
});
