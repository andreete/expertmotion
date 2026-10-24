import { describe, expect, it } from 'vitest';
import { RENDER_RUNNING_DIALOG, choiceFromButton, parseShutdownResponse, remainingMs } from '../src/lib/close-flow.js';
import { SHUTDOWN_KILL_AFTER_MS } from '../src/lib/constants.js';

// FR-002: the Shell no longer ignores R-002's 409 EM-8304; it asks "Keep rendering / Cancel render and close" and retries with force.
describe('close flow (FR-002)', () => {
  it('classifies R-002 answers', () => {
    expect(parseShutdownResponse(202, '{"acceptedAt":"x"}')).toEqual({ kind: 'accepted' });
    expect(parseShutdownResponse(409, JSON.stringify({ error: { code: 'EM-8304', message: 'A render is still running.', details: { rendering: 1 } } }))).toEqual({ kind: 'render-running', rendering: 1 });
    expect(parseShutdownResponse(409, JSON.stringify({ error: { code: 'EM-2309', message: 'x' } }))).toEqual({ kind: 'failed', status: 409 });
    expect(parseShutdownResponse(409, 'not json')).toEqual({ kind: 'failed', status: 409 });
    expect(parseShutdownResponse(403, '')).toEqual({ kind: 'failed', status: 403 });
  });
  it('keeps rendering by default; only the second button cancels and closes', () => {
    expect(RENDER_RUNNING_DIALOG.buttons).toHaveLength(2);
    expect(RENDER_RUNNING_DIALOG.defaultId).toBe(0);
    expect(RENDER_RUNNING_DIALOG.cancelId).toBe(0);
    expect(choiceFromButton(0)).toBe('keep');
    expect(choiceFromButton(1)).toBe('cancel-and-close');
    expect(choiceFromButton(-1)).toBe('keep');
    expect(RENDER_RUNNING_DIALOG.detail).toContain('EM-8304');
  });
  it('bounds the whole stop by one 5 s deadline (kill fallback)', () => {
    expect(SHUTDOWN_KILL_AFTER_MS).toBeLessThanOrEqual(5_000);
    const deadline = 1_000 + SHUTDOWN_KILL_AFTER_MS;
    expect(remainingMs(deadline, 1_000)).toBe(SHUTDOWN_KILL_AFTER_MS);
    expect(remainingMs(deadline, 4_000)).toBe(SHUTDOWN_KILL_AFTER_MS - 3_000);
    expect(remainingMs(deadline, 99_000)).toBe(0);
  });
});
