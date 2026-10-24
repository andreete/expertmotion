// Small per-context runtime state shared by S3 modules (no globals, so every test service has its own; nothing large is kept).
import type { ServiceContext } from '../context.js';

export interface S3State {
  /** agent runs in flight: runId → controller (agents module). */
  runs: Map<string, { controller: AbortController; projectId: string; agent: 'brainstorm' | 'editor' }>;
  /** SSE clients that asked for `hardware.tick` (events module increments, hardware module reads). */
  hardwareSubscribers: number;
  onHardwareSubscribers: Set<(n: number) => void>;
  /** in-flight provider calls (providers module) — aborted when Private Mode turns on. */
  providerCalls: Set<AbortController>;
  /** background tasks (model refresh after add) awaited at stop. */
  background: Set<Promise<unknown>>;
}

const states = new WeakMap<ServiceContext, S3State>();
export function s3(ctx: ServiceContext): S3State {
  let s = states.get(ctx);
  if (!s) { s = { runs: new Map(), hardwareSubscribers: 0, onHardwareSubscribers: new Set(), providerCalls: new Set(), background: new Set() }; states.set(ctx, s); }
  return s;
}
export function track<T>(ctx: ServiceContext, p: Promise<T>): Promise<T> {
  const st = s3(ctx); const q = p.catch(() => undefined).finally(() => st.background.delete(q)); st.background.add(q); return p;
}
export function setHardwareSubscribers(ctx: ServiceContext, delta: number): void {
  const st = s3(ctx); st.hardwareSubscribers = Math.max(0, st.hardwareSubscribers + delta);
  for (const fn of st.onHardwareSubscribers) fn(st.hardwareSubscribers);
}
