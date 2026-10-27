// @vitest-environment jsdom
// FR-202 (QA 2026-10-27 #2 / #6 / #7): Start screen on launch, crash-loop guard, safe open, and the crash card's way out.
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { ErrorBoundary } from '../src/startup/ErrorBoundary.js';
import {
  BOOT_ACTION_KEY, CRASH_MEMORY_MS, CRASH_WINDOW_MS, GUARD_KEY, REOPEN_KEY, decideBoot, getSafeMode, loadGuard, noteEditorCrash, noteLogsDir,
  notePageHidden, noteProjectOpening, resetGuardForTests, type GuardState,
} from '../src/startup/session-guard.js';

const T0 = 1_800_000_000_000;
const none = { reopen: null, seed: null, lastProjectId: null, action: null, now: T0 };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); resetGuardForTests(); });
afterEach(() => { cleanup(); delete (window as { expertmotion?: unknown }).expertmotion; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('decideBoot (pure)', () => {
  it('a launch (no in-window reopen) opens nothing: the Start screen', () => {
    const { decision } = decideBoot({ crashes: {} }, { ...none, lastProjectId: 'p1' });
    expect(decision).toEqual({ open: null, notice: null, blocked: [], action: null });
  });
  it('an in-window Reload reopens a healthy project; the mock seed opens too', () => {
    expect(decideBoot({ crashes: {} }, { ...none, reopen: 'p1' }).decision.open).toBe('p1');
    expect(decideBoot({ crashes: {} }, { ...none, seed: 'p2' }).decision.open).toBe('p2');
  });
  it('an open that never settled (renderer died / killed) counts as a crash and is reported as an abnormal end', () => {
    const g: GuardState = { crashes: {}, open: { projectId: 'p1', at: T0 - 5000, settled: false } };
    const { decision, guard } = decideBoot(g, { ...none, lastProjectId: 'p1' });
    expect(guard.crashes['p1']).toHaveLength(1);
    expect(guard.open).toBeUndefined();
    expect(decision.notice).toEqual({ kind: 'abnormal', projectId: 'p1' });
    expect(decision.open).toBeNull();
  });
  it('two recent crashes block auto-open even on an in-window Reload, with the crash-loop notice', () => {
    const g: GuardState = { crashes: { p1: [T0 - 60_000] }, open: { projectId: 'p1', at: T0 - 3000, settled: false } };
    const { decision } = decideBoot(g, { ...none, reopen: 'p1' });
    expect(decision.open).toBeNull();
    expect(decision.blocked).toEqual(['p1']);
    expect(decision.notice).toEqual({ kind: 'crash-loop', projectId: 'p1' });
  });
  it('old crashes are forgotten; a settled open is not a crash', () => {
    const g: GuardState = { crashes: { p1: [T0 - CRASH_MEMORY_MS - 1, T0 - CRASH_MEMORY_MS - 2] }, open: { projectId: 'p1', at: T0 - 1000, settled: true } };
    const { decision, guard } = decideBoot(g, { ...none, reopen: 'p1' });
    expect(decision.open).toBe('p1');
    expect(guard.crashes).toEqual({});
  });
  it('"Proyek baru" / "Buka proyek lain" from the crash card: no reopen, the action is handed to the boot', () => {
    expect(decideBoot({ crashes: {} }, { ...none, reopen: 'p1', action: 'new' }).decision).toMatchObject({ open: null, action: 'new' });
    expect(decideBoot({ crashes: {} }, { ...none, reopen: 'p1', action: 'pick' }).decision).toMatchObject({ open: null, action: 'pick' });
  });
});

describe('guard bookkeeping in the window', () => {
  it('a crash inside the window counts; the open is then settled so the next boot does not count it twice', () => {
    noteProjectOpening('p1', Date.now());
    expect(sessionStorage.getItem(REOPEN_KEY)).toBe('p1');
    expect(noteEditorCrash(Date.now() + 1000)).toBe('p1');
    const g = loadGuard();
    expect(g.crashes['p1']).toHaveLength(1);
    expect(g.open?.settled).toBe(true);
  });
  it('a crash after the window does not count against the project', () => {
    const at = Date.now();
    noteProjectOpening('p1', at);
    expect(noteEditorCrash(at + CRASH_WINDOW_MS + 1)).toBeNull();
    expect(loadGuard().crashes['p1']).toBeUndefined();
  });
  it('a normal page hide (close / reload) settles the open: no abnormal end next time', () => {
    noteProjectOpening('p1');
    notePageHidden();
    expect(loadGuard().open?.settled).toBe(true);
  });
  it('the project that survives the window loses its crash count', () => {
    vi.useFakeTimers();
    localStorage.setItem(GUARD_KEY, JSON.stringify({ crashes: { p1: [Date.now() - 1000] } }));
    noteProjectOpening('p1');
    vi.advanceTimersByTime(CRASH_WINDOW_MS + 10);
    expect(loadGuard().crashes['p1']).toBeUndefined();
    expect(loadGuard().open?.settled).toBe(true);
  });
  it('storage that throws never breaks the guard', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => { noteProjectOpening('p1'); noteEditorCrash(); notePageHidden(); }).not.toThrow();
    expect(loadGuard()).toEqual({ crashes: {} });
  });
});

/** The App over the mock Service, but booting like the packaged (live) Editor: no seeded auto-open. */
async function renderLive(): Promise<{ runtime: Runtime; container: HTMLElement }> {
  const mock = createMockRuntime({ seed: 'sample', delays: false });
  const runtime: Runtime = { ...mock, mode: 'live', startScreen: true };
  const { container } = render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
  await waitFor(() => { if (!document.querySelector('[data-el="scr.start"]')) throw new Error('no start screen'); });
  return { runtime, container };
}
const q = (sel: string) => document.querySelector<HTMLElement>(sel);

describe('Start screen (scr.start)', () => {
  it('a launch shows the Start screen with recent projects instead of reopening the last one; a click opens it', async () => {
    await renderLive();
    expect(q('[data-region="stage"]')).toBeNull();
    await waitFor(() => expect(document.querySelectorAll('[data-el="scr.start.item"]').length).toBeGreaterThan(0));
    expect(q('[data-el="scr.start.new"]')).not.toBeNull();
    expect(q('[data-el="scr.start.open"]')).not.toBeNull();
    fireEvent.click(q('[data-el="scr.start.item.open"]')!);
    await waitFor(() => expect(q('[data-region="stage"]')).not.toBeNull());
    expect(q('[data-el="sys.safe.banner"]')).toBeNull();
    expect(sessionStorage.getItem(REOPEN_KEY)).toBeTruthy();
  });
  it('"Proyek baru" creates and opens a project', async () => {
    await renderLive();
    fireEvent.click(q('[data-el="scr.start.new"]')!);
    await waitFor(() => expect(q('[data-region="stage"]')).not.toBeNull());
  });
  it('a project blocked by the crash-loop guard: notice, "Gagal dibuka" row, safe open hides chat and preview until asked', async () => {
    const mock = createMockRuntime({ seed: 'sample', delays: false });
    const id = (await mock.api.listProjects({ limit: 1 })).items[0]!.id;
    localStorage.setItem(GUARD_KEY, JSON.stringify({ crashes: { [id]: [Date.now() - 20_000] }, open: { projectId: id, at: Date.now() - 5000, settled: false } }));
    render(<StoreProvider runtime={{ ...mock, mode: 'live', startScreen: true }} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => expect(q('[data-el="scr.start.notice"]')?.dataset['kind']).toBe('crash-loop'));
    await waitFor(() => expect(q('[data-el="scr.start.item.failed"]')).not.toBeNull());
    fireEvent.click(q('[data-el="scr.start.notice.safe"]')!);
    await waitFor(() => expect(q('[data-el="sys.safe.banner"]')).not.toBeNull());
    expect(getSafeMode()).toMatchObject({ on: true, projectId: id });
    expect(q('[data-el="sys.safe.chat"]')).not.toBeNull();
    expect(q('[data-el="sys.safe.preview"]')).not.toBeNull();
    expect(q('[data-el="agent.chat"]')).toBeNull();
    fireEvent.click(q('[data-el="sys.safe.preview.show"]')!);
    await waitFor(() => expect(q('[data-el="sys.safe.preview"]')).toBeNull());
    fireEvent.click(q('[data-el="sys.safe.exit"]')!);
    await waitFor(() => expect(q('[data-el="sys.safe.banner"]')).toBeNull());
    expect(q('[data-el="sys.safe.chat"]')).toBeNull();
  });
});

describe('crash card (sys.crash) offers a way out', () => {
  function Boom(): never { throw new TypeError("Cannot read properties of undefined (reading '__output')"); }
  it('Reload / Open another project / New project / Open log folder; each choice is handed to the next boot', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const openFolder = vi.fn(); const logError = vi.fn();
    (window as { expertmotion?: unknown }).expertmotion = { openFolder, logError };
    noteLogsDir('/home/u/.config/Expertmotion/logs');
    noteProjectOpening('p1');
    const onReload = vi.fn();
    render(<ErrorBoundary onReload={onReload}><Boom /></ErrorBoundary>);
    for (const id of ['sys.crash.reload', 'sys.crash.pick', 'sys.crash.new', 'sys.crash.logs']) expect(q(`[data-el="${id}"]`), id).not.toBeNull();
    expect(loadGuard().crashes['p1']).toHaveLength(1);                         // counted against the project just opened
    fireEvent.click(q('[data-el="sys.crash.logs"]')!);
    expect(openFolder).toHaveBeenCalledWith('/home/u/.config/Expertmotion/logs');
    fireEvent.click(q('[data-el="sys.crash.new"]')!);
    expect(sessionStorage.getItem(BOOT_ACTION_KEY)).toBe('new');
    expect(sessionStorage.getItem(REOPEN_KEY)).toBeNull();
    fireEvent.click(q('[data-el="sys.crash.pick"]')!);
    expect(sessionStorage.getItem(BOOT_ACTION_KEY)).toBe('pick');
    expect(onReload).toHaveBeenCalledTimes(2);
  });
  it('the second crash right after reopening blocks the project on the next boot', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    noteProjectOpening('p1'); noteEditorCrash();
    noteProjectOpening('p1'); noteEditorCrash();
    const { decision } = decideBoot(loadGuard(), { reopen: sessionStorage.getItem(REOPEN_KEY), seed: null, lastProjectId: 'p1', action: null, now: Date.now() });
    expect(decision.open).toBeNull();
    expect(decision.notice).toEqual({ kind: 'crash-loop', projectId: 'p1' });
  });
});
