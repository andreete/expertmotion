// Per-Service S2 state shared by the assets, media, renders, generators and models modules (one instance per ServiceContext,
// so tests can boot several services in one process). Services are created lazily by their `…Of(ctx)` accessors.
import { EventEmitter } from 'node:events';
import type { ServiceContext } from '../context.js';
import { Mutex } from './common.js';
import type { IngestService } from './ingest.js';
import type { ModelsService } from './models-service.js';

export interface S2State {
  /** One heavy child process (FFmpeg, Chrome Headless Shell, Engine Binary) at a time (shared-server memory policy, PERFORMANCE §2 "paused"). */
  heavy: Mutex;
  /** Local notifications: 'render.final' (jobId), 'generator.final' (jobId). */
  events: EventEmitter;
  ingest?: IngestService;
  models?: ModelsService;
  /** Model keys used by queued/running generator jobs (EM-7104 on delete). */
  modelsInUse: Map<string, number>;
}
const states = new WeakMap<ServiceContext, S2State>();
export function s2(ctx: ServiceContext): S2State {
  let s = states.get(ctx);
  if (!s) { s = { heavy: new Mutex(), events: new EventEmitter(), modelsInUse: new Map() }; s.events.setMaxListeners(100); states.set(ctx, s); }
  return s;
}
export const useModel = (ctx: ServiceContext, key: string, delta: 1 | -1): void => {
  const m = s2(ctx).modelsInUse; const n = (m.get(key) ?? 0) + delta;
  if (n <= 0) m.delete(key); else m.set(key, n);
};
