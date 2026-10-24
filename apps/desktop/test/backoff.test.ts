import { describe, expect, it } from 'vitest';
import { initialRestartState, onFailure, onReady } from '../src/lib/backoff.js';
import { RESTART_BACKOFF_MS } from '../src/lib/constants.js';

describe('restart backoff (SEC-033, ARCHITECTURE §5)', () => {
  it('schedules 1 s, 3 s, 9 s then gives up', () => {
    let state = initialRestartState;
    const d1 = onFailure(state, 1000); expect(d1).toMatchObject({ action: 'restart', delayMs: 1000, attempt: 1 });
    state = (d1 as { state: typeof state }).state;
    const d2 = onFailure(state, 2000); expect(d2).toMatchObject({ action: 'restart', delayMs: 3000, attempt: 2 });
    state = (d2 as { state: typeof state }).state;
    const d3 = onFailure(state, 3000); expect(d3).toMatchObject({ action: 'restart', delayMs: 9000, attempt: 3 });
    state = (d3 as { state: typeof state }).state;
    const d4 = onFailure(state, 4000); expect(d4).toEqual({ action: 'give-up', attempts: 3 });
  });

  it('matches the documented schedule constant', () => {
    expect([...RESTART_BACKOFF_MS]).toEqual([1000, 3000, 9000]);
  });

  it('resets the budget after a long healthy run', () => {
    let state = onReady(initialRestartState, 0);
    state = (onFailure(state, 1000) as { state: typeof state }).state; // burned attempt 1 quickly
    // Service ran healthy for > 5 min since lastReadyAt, then fails: fresh budget.
    const healthy = onReady(state, 1_000_000);
    const decision = onFailure(healthy, 1_000_000 + 6 * 60 * 1000);
    expect(decision).toMatchObject({ action: 'restart', attempt: 1, delayMs: 1000 });
  });
});
