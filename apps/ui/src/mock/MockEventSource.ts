// In-memory EventSource used in mock mode: the fake API publishes events on a bus, and the real events.ts client
// consumes them through this adapter, so dedupe/dispatch logic is the same code path as with the Local Service.
import type { EventSourceLike, MessageLike } from '../api/events.js';

export class MockBus {
  private seq = 0;
  private readonly sources = new Set<MockEventSource>();
  attach(s: MockEventSource): void { this.sources.add(s); queueMicrotask(() => s.onopen?.({})); }
  detach(s: MockEventSource): void { this.sources.delete(s); }
  currentSeq(): number { return this.seq; }
  emit(name: string, payload: Record<string, unknown>): void {
    this.seq += 1;
    const data = JSON.stringify({ seq: this.seq, at: new Date().toISOString(), ...payload });
    for (const s of this.sources) s.deliver(name, { data, lastEventId: String(this.seq) });
  }
}

export class MockEventSource implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private readonly listeners = new Map<string, Array<(ev: MessageLike) => void>>();
  constructor(private readonly bus: MockBus) { bus.attach(this); }
  addEventListener(type: string, listener: (ev: MessageLike) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  deliver(type: string, ev: MessageLike): void { for (const l of this.listeners.get(type) ?? []) l(ev); }
  close(): void { this.bus.detach(this); }
}
