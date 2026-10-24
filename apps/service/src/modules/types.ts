// A service module owns a set of routes, tables (its migration range) and optionally installs cross-module hooks.
import type { Router } from 'express';
import type { ServiceContext } from '../context.js';

export interface ServiceModule {
  name: string;
  /** Register routes on the /api/v1 router. Called once, after every module's `start`. */
  register(router: Router, ctx: ServiceContext): void;
  /** Install hooks, start timers, recover interrupted work. Called before any `register`. */
  start?(ctx: ServiceContext): void | Promise<void>;
  /** Graceful shutdown (cancel jobs, flush). */
  stop?(ctx: ServiceContext): void | Promise<void>;
}
