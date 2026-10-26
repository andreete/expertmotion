// FR-184 startup phases (Shell → splash push, validated in the preload) and FR-185 Editor window recovery + log bridge.
import { describe, expect, it } from 'vitest';
import { parseServiceStatePush, shouldPushProgress, startingPush } from '../src/lib/startup.js';
import {
  AUTO_RELOAD_WINDOW_MS, didFailLoadEntry, goneChoice, initialCrashState, onRendererGone, RENDERER_GONE_DIALOG, stripQuery, UNRESPONSIVE_DIALOG, unresponsiveChoice,
} from '../src/lib/renderer-recovery.js';
import { createRateLimiter, MAX_MESSAGE_CHARS, MAX_STACK_LINES, rendererLogFields } from '../src/lib/renderer-log.js';
import { BRIDGE_KEYS, EM, IPC } from '../src/lib/constants.js';

describe('startup push (FR-184)', () => {
  it('builds a starting push with phase, elapsed time and clamped progress', () => {
    expect(startingPush('integrity', 1000, 4500, 0.25)).toEqual({ status: 'starting', phase: 'integrity', sinceMs: 3500, progress: 0.25 });
    expect(startingPush('service', 1000, 900)).toEqual({ status: 'starting', phase: 'service', sinceMs: 0 });
    expect(startingPush('keyring', 0, 10, 7).progress).toBe(1);
  });
  it('accepts every push main sends and drops unknown keys', () => {
    expect(parseServiceStatePush({ status: 'starting', phase: 'keyring', sinceMs: 1200, extra: 'x' })).toEqual({ status: 'starting', phase: 'keyring', sinceMs: 1200 });
    expect(parseServiceStatePush({ status: 'ready', bootstrap: { port: 42301, token: 'A'.repeat(43) } })).toEqual({ status: 'ready', bootstrap: { port: 42301, token: 'A'.repeat(43) } });
    expect(parseServiceStatePush({ status: 'failed', code: 'EM-8002', logsDir: 'C:\\Users\\a\\AppData\\Roaming\\Expertmotion\\logs' })?.code).toBe('EM-8002');
    expect(parseServiceStatePush({ status: 'starting', phase: 'integrity', progress: 1.5 })?.progress).toBe(1);
  });
  it('rejects malformed pushes (preload never forwards them)', () => {
    for (const bad of [null, 'ready', {}, { status: 'up' }, { status: 'starting', phase: 'boot' }, { status: 'failed', code: 'boom' },
      { status: 'ready', bootstrap: { port: 0, token: 'A'.repeat(43) } }, { status: 'ready', bootstrap: { port: 42301, token: 'short' } },
      { status: 'starting', sinceMs: -1 }, { status: 'starting', sinceMs: 1e12 }, { status: 'starting', progress: Number.NaN }, { status: 'failed', logsDir: 'a\0b' }]) {
      expect(parseServiceStatePush(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('throttles integrity progress pushes but always sends the first and the last', () => {
    expect(shouldPushProgress(null, 0, 1, 80)).toBe(true);
    expect(shouldPushProgress(0, 100, 2, 80)).toBe(false);
    expect(shouldPushProgress(0, 260, 3, 80)).toBe(true);
    expect(shouldPushProgress(250, 260, 80, 80)).toBe(true);
  });
});

describe('Editor window recovery (FR-185)', () => {
  const gone = { reason: 'crashed', exitCode: 5 };
  it('reloads once automatically, then asks; a later crash outside the window reloads again', () => {
    const a = onRendererGone(initialCrashState, gone, 1000, false);
    expect(a.action).toBe('reload');
    if (a.action === 'ignore') throw new Error('unexpected');
    const b = onRendererGone(a.state, { reason: 'oom', exitCode: 0 }, 2000, false);
    expect(b.action).toBe('ask');
    if (b.action === 'ignore') throw new Error('unexpected');
    expect(onRendererGone(b.state, gone, 2000 + AUTO_RELOAD_WINDOW_MS + 1, false).action).toBe('reload');
  });
  it('ignores a clean exit and anything while the Shell shuts down', () => {
    expect(onRendererGone(initialCrashState, { reason: 'clean-exit', exitCode: 0 }, 0, false).action).toBe('ignore');
    expect(onRendererGone(initialCrashState, gone, 0, true).action).toBe('ignore');
  });
  it('maps dialog buttons (index 0 is the safe default) and carries EM-8008', () => {
    expect(RENDERER_GONE_DIALOG.buttons[RENDERER_GONE_DIALOG.defaultId]).toMatch(/Reload/);
    expect(goneChoice(0)).toBe('reload'); expect(goneChoice(1)).toBe('close');
    expect(unresponsiveChoice(0)).toBe('wait'); expect(unresponsiveChoice(1)).toBe('reload'); expect(unresponsiveChoice(2)).toBe('close');
    expect(UNRESPONSIVE_DIALOG.buttons).toHaveLength(3);
    for (const d of [RENDERER_GONE_DIALOG, UNRESPONSIVE_DIALOG]) expect(d.detail).toContain(EM.rendererCrashed);
  });
  it('logs did-fail-load without the query string; ERR_ABORTED is not a failure', () => {
    expect(didFailLoadEntry(-3, 'ERR_ABORTED', 'app://expertmotion/index.html', true)).toBeNull();
    const e = didFailLoadEntry(-6, 'ERR_FILE_NOT_FOUND', 'app://expertmotion/index.html?token=secret#x', true);
    expect(e).toMatchObject({ level: 'error', msg: 'editor load failed', fields: { errorCode: -6, url: 'app://expertmotion/index.html', mainFrame: true } });
    expect(didFailLoadEntry(-105, 'x', 'http://127.0.0.1:1/a', false)?.level).toBe('warn');
    expect(stripQuery('a'.repeat(400)).length).toBe(300);
  });
});

describe('Editor → Shell log bridge (FR-185, SEC-031)', () => {
  it('is part of the closed bridge and IPC lists', () => {
    expect(BRIDGE_KEYS).toContain('logError'); expect(BRIDGE_KEYS).toContain('retryStartup');
    expect(IPC.logError).toBe('em:log-error'); expect(IPC.retryStartup).toBe('em:retry-startup');
  });
  it('validates, caps and scrubs an error-boundary entry', () => {
    const stack = Array.from({ length: 60 }, (_, i) => `at f${i} (app://expertmotion/assets/index.js?v=abc:1:${i})`).join('\n');
    const r = rendererLogFields({ level: 'error', code: 'EM-8009', source: 'error-boundary', message: `TypeError: x for ana@example.com ${'y'.repeat(900)}`, stack });
    expect(r?.level).toBe('error');
    expect(r?.fields['code']).toBe('EM-8009');
    const msg = String(r?.fields['message']);
    expect(msg.length).toBe(MAX_MESSAGE_CHARS);
    expect(msg).toContain('[email]'); expect(msg).not.toContain('ana@example.com');
    const s = String(r?.fields['stack']);
    expect(s.split('\n')).toHaveLength(MAX_STACK_LINES);
    expect(s).not.toContain('?v=abc');
  });
  it('rejects anything outside the schema', () => {
    for (const bad of [null, 'boom', { level: 'info', message: 'x', source: 'window-error' }, { level: 'error', message: 'x', source: 'other' },
      { level: 'error', message: 'x', source: 'window-error', code: 'nope' }, { level: 'error', message: 'x'.repeat(5000), source: 'window-error' },
      { level: 'error', message: 'x', source: 'window-error', extra: 1 }]) expect(rendererLogFields(bad), JSON.stringify(bad)).toBeNull();
  });
  it('rate-limits a throwing render loop', () => {
    const allow = createRateLimiter(3, 1000);
    expect([allow(0), allow(1), allow(2), allow(3)]).toEqual([true, true, true, false]);
    expect(allow(1000)).toBe(true);
  });
});
