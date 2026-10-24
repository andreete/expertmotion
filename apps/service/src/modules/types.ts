// A service module owns a set of routes, tables (its migration range) and optionally installs cross-module hooks.
import type { Router } from 'express';
import type { ServiceContext } from '../context.js';

export interface ServiceModule {
  name: string;
  /** Register routes on the /api/v1 router. Called once, after every module's `start`. */
  register(router: Router, ctx: ServiceContext): void;
  /** Routes outside /api/v1 (only the media routes R-040/R-041, `/media/...`). Mounted at the root, after the guards. */
  registerRoot?(router: Router, ctx: ServiceContext): void;
  /** Install hooks, start timers, recover interrupted work. Called before any `register`. */
  start?(ctx: ServiceContext): void | Promise<void>;
  /** Graceful shutdown (cancel jobs, flush). */
  stop?(ctx: ServiceContext): void | Promise<void>;
}
