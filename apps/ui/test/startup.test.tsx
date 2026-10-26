// @vitest-environment jsdom
// FR-184 startup splash and FR-185 error boundary (QA 2026-10-26 "sering blackscreen"): the splash is on screen before the
// runtime exists, follows the Shell's pushed phases (integrity → keyring → service → project), shows elapsed seconds after
// 5 s and, on EM-8002 before the Editor mounted, the code with Try again / Open log folder. The error boundary replaces a
// crashed tree with "Something went wrong — Reload" and logs the error with its stack through the bridge.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { el } from './setup-dom.js';
import { Boot } from '../src/startup/Boot.js';
import { Splash } from '../src/startup/Splash.js';
import { ErrorBoundary } from '../src/startup/ErrorBoundary.js';
import { LANG_KEY, noteShellSince, resetStartupClock, splashProgress, startupElapsedMs, startupLang } from '../src/startup/progress.js';
import { createLiveRuntime, createMockRuntime, withReplay, type Runtime, type ServiceStatus } from '../src/state/runtime.js';
import type { ShellBridge } from '../src/api/client.js';

afterEach(() => { cleanup(); resetStartupClock(); try { localStorage.clear(); } catch { /* ignore */ } delete (window as { expertmotion?: unknown }).expertmotion; });

/** A fake Shell bridge: `push` delivers a raw service-state push like main's webContents.send. */
function shell(extra: Partial<ShellBridge> = {}) {
  let cb: ((s: unknown) => void) | null = null;
  const bridge: ShellBridge = { onServiceState: (c) => { cb = c; return () => { cb = null; }; }, getBootstrap: async () => null as never, ...extra };
  return { bridge, push: (s: unknown) => act(async () => { cb?.(s); }) };
}

describe('splash progress logic (FR-184)', () => {
  it('fills by phase, uses reported progress, eases without it and never reaches the end of a phase', () => {
    expect(splashProgress(undefined, undefined, 0)).toBeCloseTo(0.02);
    expect(splashProgress('integrity', 0.5, 0)).toBeCloseTo(0.15);
    expect(splashProgress('keyring', undefined, 0)).toBeCloseTo(0.3);
    const s1 = splashProgress('service', undefined, 5_000), s2 = splashProgress('service', undefined, 60_000);
    expect(s1).toBeGreaterThan(0.35); expect(s2).toBeGreaterThan(s1); expect(s2).toBeLessThan(0.85);
    expect(splashProgress('project', 1, 0)).toBeCloseTo(0.98);
  });
  it('counts elapsed time from the Shell start and remembers the language', () => {
    noteShellSince(7_000, 100_000);
    expect(startupElapsedMs(101_000)).toBe(8_000);
    localStorage.setItem(LANG_KEY, 'id');
    expect(startupLang()).toBe('id');
  });
});

describe('startup splash (FR-184)', () => {
  it('renders before the runtime exists and follows the pushed phases', async () => {
    localStorage.setItem(LANG_KEY, 'id');
    const s = shell();
    const replay = withReplay(s.bridge);
    // The push sent when the page finished loading arrives before Boot subscribes: withReplay keeps it.
    await s.push({ status: 'starting', phase: 'integrity', progress: 0.4, sinceMs: 1000 });
    let resolve!: (r: Runtime) => void;
    const runtime = new Promise<Runtime>((r) => { resolve = r; });
    const start = vi.fn(async (onService: (st: ServiceStatus) => void) => {
      const live = createLiveRuntime(replay, { onService });            // waits for `ready`; the splash shows meanwhile
      void live;
      return runtime;
    });
    render(<Boot start={start} bridge={replay}>{() => <div data-el="test.editor">editor</div>}</Boot>);
    expect(el('sys.splash')).toBeTruthy();
    await waitFor(() => { if (el('sys.splash.step')?.textContent !== 'Memeriksa file aplikasi…') throw new Error(el('sys.splash.step')?.textContent ?? 'no step'); });
    expect(el('sys.splash')?.getAttribute('data-phase')).toBe('integrity');
    expect(Number(el('sys.splash.progress')?.getAttribute('aria-valuenow'))).toBe(12);
    await s.push({ status: 'starting', phase: 'keyring', sinceMs: 2000 });
    expect(el('sys.splash.step')?.textContent).toBe('Membuka penyimpanan…');
    expect(el('sys.splash.elapsed')).toBeNull();                         // < 5 s
    await s.push({ status: 'starting', phase: 'service', sinceMs: 9000 });
    expect(el('sys.splash.step')?.textContent).toBe('Menyalakan layanan…');
    expect(el('sys.splash.elapsed')?.textContent).toMatch(/^9 dtk$/);
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(createMockRuntime({ seed: 'empty', delays: false })); });
    await waitFor(() => { if (!el('test.editor')) throw new Error('editor not mounted'); });
    expect(el('sys.splash')).toBeNull();
  });

  it('shows the failure with its code, Try again (Shell retry) and Open log folder before the Editor mounted', async () => {
    const retryStartup = vi.fn(async () => true);
    const openFolder = vi.fn();
    const s = shell({ retryStartup, openFolder });
    const replay = withReplay(s.bridge)!;
    const start = (onService: (st: ServiceStatus) => void) => createLiveRuntime(replay, { onService }).then((r) => r ?? createMockRuntime({ seed: 'empty', delays: false }));
    render(<Boot start={start} bridge={replay}>{() => <div data-el="test.editor">editor</div>}</Boot>);
    await s.push({ status: 'failed', code: 'EM-8002', logsDir: 'C:\\logs' });
    await waitFor(() => { if (!el('sys.splash.error')) throw new Error('no error'); });
    expect(el('sys.splash')?.getAttribute('data-phase')).toBe('failed');
    expect(el('sys.splash.code')?.textContent).toBe('EM-8002');
    expect(el('test.editor')).toBeNull();
    fireEvent.click(el('sys.splash.logs')!);
    expect(openFolder).toHaveBeenCalledWith('C:\\logs');
    fireEvent.click(el('sys.splash.retry')!);
    await waitFor(() => { if (!retryStartup.mock.calls.length) throw new Error('no retry'); });
    await s.push({ status: 'starting', phase: 'service', sinceMs: 30_000 });
    await waitFor(() => { if (!el('test.editor') && el('sys.splash.step')?.textContent !== 'Starting the service…') throw new Error('not back to starting'); });
  });

  it('covers the Editor with the "Loading project…" step until the first project is open', () => {
    render(<Splash overlay lang="en" phase="project" />);
    expect(el('sys.splash.step')?.textContent).toBe('Loading project…');
    expect(el('sys.splash')?.className).toContain('fixed');
  });
});

describe('error boundary (FR-185)', () => {
  function Bomb(): never { throw new TypeError('boom at render'); }
  it('replaces a crashed tree with Reload, shows EM-8009 and logs the error with its stack', async () => {
    const logError = vi.fn(async () => undefined);
    (window as { expertmotion?: unknown }).expertmotion = { logError };
    const onReload = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);   // React reports the caught error to the console
    render(<ErrorBoundary onReload={onReload}><Bomb /></ErrorBoundary>);
    spy.mockRestore();
    expect(el('sys.crash')).toBeTruthy();
    expect(el('sys.crash.code')?.textContent).toBe('EM-8009');
    expect(el('sys.crash.message')?.textContent).toContain('TypeError: boom at render');
    expect(document.body.textContent).toContain('Something went wrong');
    fireEvent.click(el('sys.crash.reload')!);
    expect(onReload).toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    const entry = (logError.mock.calls[0] as unknown as [Record<string, string>])[0];
    expect(entry).toMatchObject({ level: 'error', code: 'EM-8009', source: 'error-boundary', message: 'TypeError: boom at render' });
    expect(entry['stack']).toContain('component stack');
  });
  it('uses the remembered language', () => {
    localStorage.setItem(LANG_KEY, 'id');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary onReload={() => undefined}><Bomb /></ErrorBoundary>);
    spy.mockRestore();
    expect(document.body.textContent).toContain('Ada yang tidak beres');
    expect(el('sys.crash.reload')?.textContent).toContain('Muat ulang');
  });
});
