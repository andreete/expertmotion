/**
 * Supervisor restart policy for the Local Service (ARCHITECTURE.md §5 step 6, SEC-033,
 * DEPLOYMENT_AND_PACKAGING.md §14): restart after 1 s, 3 s, 9 s; a fourth failure is EM-8002.
 * Port collisions (EADDRINUSE) are retried separately against the port budget (SEC-008).
 */
import { RESTART_BACKOFF_MS, RESTART_BUDGET_RESET_MS } from './constants.js';

export interface RestartState {
  /** Restarts already scheduled in the current budget window. */
  readonly restarts: number;
  /** Epoch ms of the last successful `ready`, or null when the Service never became ready. */
  readonly lastReadyAt: number | null;
}

export const initialRestartState: RestartState = { restarts: 0, lastReadyAt: null };

export type RestartDecision = { action: 'restart'; delayMs: number; attempt: number; state: RestartState } | { action: 'give-up'; attempts: number };

/** Records a successful `ready`. */
export function onReady(state: RestartState, now: number): RestartState {
  return { ...state, lastReadyAt: now };
}

/**
 * Decides what to do after the Service exited unexpectedly or failed to start.
 * A Service that ran for at least `resetAfterMs` since its last `ready` gets a fresh budget,
 * so a crash once a day never accumulates into EM-8002.
 */
export function onFailure(
  state: RestartState,
  now: number,
  schedule: readonly number[] = RESTART_BACKOFF_MS,
  resetAfterMs: number = RESTART_BUDGET_RESET_MS,
): RestartDecision {
  const healthy = state.lastReadyAt !== null && now - state.lastReadyAt >= resetAfterMs;
  const restarts = healthy ? 0 : state.restarts;
  const delayMs = schedule[restarts];
  if (delayMs === undefined) return { action: 'give-up', attempts: restarts };
  return { action: 'restart', delayMs, attempt: restarts + 1, state: { restarts: restarts + 1, lastReadyAt: state.lastReadyAt } };
}
