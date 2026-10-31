// FR-196 … FR-199 (QA 2026-10-27: black window on a T0 laptop, nothing clickable): safe graphics mode + GPU-crash counting,
// the crash-loop guard, the heartbeat watchdog, recovery keys / tray, renderer console capture and the diagnostic report.
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ABNORMAL_SESSIONS_FOR_SAFE_MODE, cleanMarker, decideStartup, defaultGraphicsState, disableSafeMode, enableSafeMode, GPU_CRASH_WINDOW_MS, initialGpuCrashState,
  onChildProcessGone, parseGraphicsState, parseSessionMarker, runningMarker, SAFE_GRAPHICS_SWITCH, SAFE_MODE_MS, safeModeChoice, safeModeDialog, type GraphicsState,
} from '../src/lib/graphics-mode.js';
import {
  displayStallDialog, FIRST_PAINT_TIMEOUT_MS, HEARTBEAT_STALL_MS, initialWatchState, onBeat, onLoadStart, onSignal, onTick, parseBeat, parseSignal, REASK_AFTER_MS, stallChoice,
  type WatchState, type WindowFacts,
} from '../src/lib/heartbeat.js';
import {
  buildReportEntries, crc32, createZip, gpuLogFields, MAX_CRASH_FILES, reportDays, reportFileName, scrubReportText, selectReportFiles, summarizeGpuInfo,
} from '../src/lib/diagnostic-report.js';
import { createDebounce, recoveryKey, trayItems, type KeyInput } from '../src/lib/escape-hatches.js';
import { consoleLogEntry, createCountingLimiter } from '../src/lib/renderer-log.js';
import { createPhaseTimer } from '../src/lib/startup.js';
import { appMenuTemplate } from '../src/lib/window-chrome.js';
import { EM, IPC, BRIDGE_KEYS } from '../src/lib/constants.js';

const MIN = 60_000;
const DAY = 86_400_000;

describe('safe graphics mode and the crash-loop guard (FR-196, FR-197)', () => {
  const t0 = Date.parse('2026-10-27T08:00:00Z');
  const run = (graphics: GraphicsState, previous: ReturnType<typeof parseSessionMarker>, now = t0, argv: string[] = []) => decideStartup({ graphics, previous, now, argv });

  it('first launch and clean previous sessions stay on hardware acceleration and reset the streak', () => {
    expect(run(defaultGraphicsState, null)).toMatchObject({ safe: false, reason: null, events: [], notify: false });
    const d = run({ mode: 'hardware', abnormalStreak: 1 }, { state: 'clean', startedAt: t0 - DAY, version: '0.0.0', safeGraphics: false });
    expect(d.next.abnormalStreak).toBe(0);
    expect(d.safe).toBe(false);
  });

  it('one abnormal end is counted, two in a row switch safe graphics mode on (crash-loop) and notify once', () => {
    const crashed = runningMarker(t0 - MIN, '0.0.0', false);
    const one = run(defaultGraphicsState, crashed);
    expect(one).toMatchObject({ safe: false, events: ['previous-abnormal'] });
    expect(one.next.abnormalStreak).toBe(1);
    const two = run(one.next, crashed);
    expect(ABNORMAL_SESSIONS_FOR_SAFE_MODE).toBe(2);
    expect(two).toMatchObject({ safe: true, reason: 'crash-loop', notify: true, events: ['previous-abnormal', 'crash-loop-safe-mode'] });
    expect(two.next).toEqual({ mode: 'safe', reason: 'crash-loop', since: t0, abnormalStreak: 0 });
    // the notice is shown once per activation
    expect(run({ ...two.next, notified: true }, cleanMarker(crashed)).notify).toBe(false);
  });

  it('safe mode persists across launches and expires after 7 days (the GPU is tried again)', () => {
    const safe = enableSafeMode(defaultGraphicsState, 'gpu-crash', t0);
    expect(run(safe, null, t0 + SAFE_MODE_MS - 1)).toMatchObject({ safe: true, reason: 'gpu-crash' });
    const expired = run(safe, null, t0 + SAFE_MODE_MS);
    expect(expired).toMatchObject({ safe: false, events: ['safe-mode-expired'] });
    expect(expired.next).toEqual({ mode: 'hardware', abnormalStreak: 0 });
    // undated or future-dated safe mode cannot be trusted: expires now
    expect(run({ mode: 'safe', reason: 'user', abnormalStreak: 0 }, null).safe).toBe(false);
    expect(run({ mode: 'safe', reason: 'user', since: t0 + DAY, abnormalStreak: 0 }, null).safe).toBe(false);
    expect(disableSafeMode()).toEqual({ mode: 'hardware', abnormalStreak: 0 });
  });

  it('--safe-graphics forces one launch without persisting', () => {
    const d = run(defaultGraphicsState, null, t0, ['--safe-graphics']);
    expect(SAFE_GRAPHICS_SWITCH).toBe('--safe-graphics');
    expect(d).toMatchObject({ safe: true, reason: 'user', notify: false, events: ['forced-by-switch'] });
    expect(d.next.mode).toBe('hardware');
  });

  it('parses the state files defensively', () => {
    for (const bad of [null, 'x', 42, [], { mode: 'turbo' }]) expect(parseGraphicsState(bad).mode).toBe('hardware');
    expect(parseGraphicsState({ mode: 'safe', reason: 'nope', since: 5, abnormalStreak: -3, notified: true })).toEqual({ mode: 'safe', reason: 'user', since: 5, notified: true, abnormalStreak: 0 });
    expect(parseGraphicsState({ mode: 'hardware', abnormalStreak: 2.7, reason: 'gpu-crash' })).toEqual({ mode: 'hardware', abnormalStreak: 2 });
    for (const bad of [null, {}, { state: 'weird' }]) expect(parseSessionMarker(bad)).toBeNull();
    expect(parseSessionMarker({ state: 'running', startedAt: 'x', version: 'v'.repeat(99), safeGraphics: 1 })).toEqual({ state: 'running', startedAt: 0, version: 'v'.repeat(40), safeGraphics: false });
  });

  it('GPU crashes: first → reload, second within 10 min → safe mode; older crashes and other processes do not count', () => {
    const ctx = { shuttingDown: false, safeMode: false };
    const gpu = (reason = 'crashed') => ({ type: 'GPU', reason, exitCode: -1073741819 });
    let d = onChildProcessGone(initialGpuCrashState, gpu(), t0, ctx);
    expect(d).toMatchObject({ action: 'reload', crashesInWindow: 1 });
    const late = onChildProcessGone(d.state, gpu(), t0 + GPU_CRASH_WINDOW_MS + 1, ctx);
    expect(late).toMatchObject({ action: 'reload', crashesInWindow: 1 });
    d = onChildProcessGone(d.state, gpu('oom'), t0 + 3 * MIN, ctx);
    expect(d).toMatchObject({ action: 'safe-mode', crashesInWindow: 2 });
    expect(d.state.crashes).toEqual([]);
    expect(onChildProcessGone(initialGpuCrashState, gpu('clean-exit'), t0, ctx).action).toBe('ignore');
    expect(onChildProcessGone(initialGpuCrashState, { type: 'Utility', reason: 'crashed', exitCode: 1, serviceName: 'Expertmotion Helper' }, t0, ctx).action).toBe('log');
    expect(onChildProcessGone(initialGpuCrashState, gpu(), t0, { shuttingDown: true, safeMode: false }).action).toBe('ignore');
    // already in safe mode: reload only, never a relaunch loop
    const s1 = onChildProcessGone(initialGpuCrashState, gpu(), t0, { shuttingDown: false, safeMode: true });
    expect(onChildProcessGone(s1.state, gpu(), t0 + MIN, { shuttingDown: false, safeMode: true }).action).toBe('reload');
  });

  it('the notice is Indonesian, names the reason and the way back, and carries EM-8011', () => {
    const c = safeModeDialog('gpu-crash');
    expect(c.message).toBe('Mode grafis aman aktif');
    expect(c.detail).toContain('GPU');
    expect(c.detail).toContain('7 hari');
    expect(c.detail).toContain('EM-8011');
    expect(c.buttons).toEqual(['Oke', 'Kembali ke mode normal']);
    expect(safeModeChoice(1)).toBe('disable');
    expect(safeModeChoice(0)).toBe('keep');
    expect(EM.safeGraphics).toBe('EM-8011');
  });
});

describe('heartbeat watchdog (FR-198)', () => {
  const shown: WindowFacts = { visible: true, minimized: false, focused: true, dialogOpen: false };
  /** Advance with ticks every second, beating every 2 s with the given frame flag (or not beating). */
  function drive(s: WatchState, from: number, to: number, opts: { beat?: boolean; framed?: boolean; visible?: boolean; facts?: WindowFacts } = {}) {
    const decisions: Array<{ at: number; d: ReturnType<typeof onTick>['decision'] }> = [];
    for (let t = from; t <= to; t += 1000) {
      if (opts.beat !== false && (t - from) % 2000 === 0) s = onBeat(s, { seq: t, framed: opts.framed ?? true, visible: opts.visible ?? true }, t);
      const r = onTick(s, opts.facts ?? shown, t);
      s = r.state;
      if (r.decision.action !== 'none') decisions.push({ at: t, d: r.decision });
    }
    return { s, decisions };
  }
  const painted = (t: number) => onSignal(onLoadStart(initialWatchState, t), { kind: 'first-paint' }, t + 500);

  it('healthy beats with frames never ask', () => {
    expect(drive(painted(0), 1000, 120_000).decisions).toEqual([]);
  });

  it('no heartbeat for > 10 s while visible → one ask, re-ask after 60 s, recovered when beats return', () => {
    let { s } = drive(painted(0), 1000, 10_000);
    const r = drive(s, 11_000, 40_000, { beat: false });
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]!.d).toMatchObject({ action: 'ask', kind: 'no-heartbeat' });
    const lastBeat = 9_000;                                                // beats at 1 s, 3 s, … 9 s
    expect(r.decisions[0]!.at - lastBeat).toBeGreaterThan(HEARTBEAT_STALL_MS);
    expect(r.decisions[0]!.at - lastBeat).toBeLessThanOrEqual(HEARTBEAT_STALL_MS + 1000);
    const again = drive(r.s, 41_000, 41_000 + REASK_AFTER_MS, { beat: false });
    expect(again.decisions.map((x) => x.d.action)).toEqual(['ask']);
    s = again.s;
    const back = drive(s, 200_000, 204_000);
    expect(back.decisions[0]!.d).toMatchObject({ action: 'recovered', kind: 'no-heartbeat' });
    expect(back.s.stalled).toBeNull();
  });

  it('beats without frames while the page is visible (black window, GPU) → no-frames', () => {
    const r = drive(painted(0), 1000, 30_000, { framed: false });
    expect(r.decisions[0]!.d).toMatchObject({ action: 'ask', kind: 'no-frames' });
  });

  it('hidden, minimized or occluded time never counts; a grace window follows showing again', () => {
    const p = painted(0);
    expect(drive(p, 1000, 300_000, { beat: false, facts: { ...shown, minimized: true } }).decisions).toEqual([]);
    expect(drive(p, 1000, 300_000, { beat: false, facts: { ...shown, visible: false } }).decisions).toEqual([]);
    // page said hidden (occluded) and the window is not focused: throttled timers are not a hang
    let occluded = onBeat(p, { seq: 1, framed: false, visible: false }, 1000);
    expect(drive(occluded, 2000, 300_000, { beat: false, facts: { ...shown, focused: false } }).decisions).toEqual([]);
    // hidden page frames are not evidence of a black window
    expect(drive(p, 1000, 120_000, { framed: false, visible: false }).decisions).toEqual([]);
    // QA 2026-10-30: the page says visible but the window sits behind another app (no focus) and stops painting — not a hang
    expect(drive(p, 1000, 300_000, { framed: false, facts: { ...shown, focused: false } }).decisions).toEqual([]);
    // after a long minimised period, the window gets the full 10 s again before any ask
    const min = drive(p, 1000, 600_000, { beat: false, facts: { ...shown, minimized: true } });
    occluded = min.s;
    const after = drive(occluded, 601_000, 640_000, { beat: false });
    expect(after.decisions[0]!.at).toBeGreaterThan(601_000 + HEARTBEAT_STALL_MS - 1000);
  });

  it('no first paint within 45 s of the load start → no-first-paint; a reload starts a new clock', () => {
    const s = onLoadStart(initialWatchState, 0);
    const r = drive(s, 1000, 60_000, { beat: false });
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]).toMatchObject({ at: FIRST_PAINT_TIMEOUT_MS, d: { action: 'ask', kind: 'no-first-paint' } });
    const reloaded = onLoadStart(r.s, 61_000);
    expect(reloaded.stalled).toBeNull();
    expect(drive(reloaded, 62_000, 100_000, { beat: false }).decisions).toEqual([]);
    // the first paint ends the episode
    const fp = onSignal(r.s, { kind: 'first-paint' }, 61_000);
    expect(onTick(fp, shown, 61_500).decision).toMatchObject({ action: 'recovered', kind: 'no-first-paint' });
  });

  it('never asks while another recovery dialog is open (dedupe with the unresponsive dialog)', () => {
    const r = drive(painted(0), 1000, 60_000, { beat: false, facts: { ...shown, dialogOpen: true } });
    expect(r.decisions).toEqual([]);
    expect(r.s.stalled).toBe('no-heartbeat');
    expect(onTick(r.s, shown, 61_000).decision.action).toBe('ask');
  });

  it('before any load nothing is watched; signals are idempotent', () => {
    expect(onTick(initialWatchState, shown, 1e9).decision.action).toBe('none');
    const a = onSignal(onLoadStart(initialWatchState, 0), { kind: 'editor-mounted' }, 5);
    expect(onSignal(a, { kind: 'editor-mounted' }, 99).mountedAt).toBe(5);
  });

  it('validates the preload payloads', () => {
    expect(parseBeat({ seq: 3, framed: true, visible: false, extra: 1 })).toEqual({ seq: 3, framed: true, visible: false });
    for (const bad of [null, {}, { seq: -1, framed: true, visible: true }, { seq: 1.5, framed: true, visible: true }, { seq: 1, framed: 'yes', visible: true }]) expect(parseBeat(bad)).toBeNull();
    expect(parseSignal({ kind: 'first-paint', atMs: 812.4 })).toEqual({ kind: 'first-paint', atMs: 812 });
    expect(parseSignal({ kind: 'editor-mounted', atMs: -1 })).toEqual({ kind: 'editor-mounted' });
    expect(parseSignal({ kind: 'eval' })).toBeNull();
    // private channels, not on the bridge
    expect(IPC.heartbeat).toBe('em:heartbeat');
    expect(BRIDGE_KEYS as readonly string[]).not.toContain('heartbeat');
  });

  it('the dialog is Indonesian with Muat ulang / Mode grafis aman / Buka folder log / Tunggu / Tutup; Esc = Tunggu', () => {
    const d = displayStallDialog('no-frames');
    expect(d.message).toBe('Tampilan tidak merespons');
    expect(d.buttons).toEqual(['Muat ulang', 'Mode grafis aman', 'Buka folder log', 'Tunggu', 'Tutup']);
    expect(d.detail).toContain('EM-8012');
    expect(d.defaultId).toBe(0);
    expect(stallChoice(d.cancelId)).toBe('wait');
    expect([0, 1, 2, 3, 4, 9].map(stallChoice)).toEqual(['reload', 'safe-mode', 'logs', 'wait', 'close', 'wait']);
  });

  it('the preload sends the heartbeat without a continuous animation-frame loop', () => {
    const src = readFileSync(new URL('../src/preload.ts', import.meta.url), 'utf8');
    expect(src).toContain('IPC.heartbeat');
    expect(src).toContain('if (pending) return;');
    expect(src).not.toMatch(/exposeInMainWorld\([^)]*heartbeat/);
  });
});

describe('escape hatches (FR-199)', () => {
  const key = (k: Partial<KeyInput>): KeyInput => ({ type: 'keyDown', key: 'r', control: false, meta: false, shift: false, alt: false, isAutoRepeat: false, ...k });
  it('Ctrl+R / F5 reload, Ctrl+Shift+L opens the log folder; nothing else, no auto-repeat', () => {
    expect(recoveryKey(key({ control: true }), 'win32')).toBe('reload');
    expect(recoveryKey(key({ control: true, key: 'R' }), 'win32')).toBe('reload');
    expect(recoveryKey(key({ key: 'F5' }), 'win32')).toBe('reload');
    expect(recoveryKey(key({ control: true, shift: true, key: 'L' }), 'win32')).toBe('open-logs');
    expect(recoveryKey(key({ meta: true }), 'darwin')).toBe('reload');
    for (const k of [key({}), key({ key: 'l' }), key({ control: true, shift: true }), key({ control: true, key: 'l' }), key({ control: true, isAutoRepeat: true }), key({ control: true, type: 'keyUp' }), key({ control: true, alt: true }), key({ key: 'F5', control: true }), key({ meta: true })])
      expect(recoveryKey(k, 'win32')).toBeNull();
  });
  it('does not collide with the Editor shortcuts (apps/ui/src/shortcuts.ts)', () => {
    const src = readFileSync(new URL('../../ui/src/shortcuts.ts', import.meta.url), 'utf8');
    const ctrlBlock = src.slice(src.indexOf('if (ctrl) {'), src.indexOf('if (e.altKey'));
    expect(ctrlBlock).not.toMatch(/l === 'r'|l === 'l'/);
    expect(src).not.toContain("'F5'");
  });
  it('debounces one action per second', () => {
    const ok = createDebounce(1000);
    expect([ok('reload', 0), ok('reload', 500), ok('open-logs', 600), ok('reload', 1000)]).toEqual([true, false, true, true]);
  });
  it('tray menu: reload, safe-graphics restart or the way back, logs, report, quit', () => {
    const labels = (safe: boolean) => trayItems(safe).map((i) => (i === null ? '-' : i.label));
    expect(labels(false)).toEqual(['Tampilkan Expertmotion', 'Muat ulang tampilan', 'Mulai ulang dalam mode grafis aman', '-', 'Buka folder log', 'Simpan laporan diagnostik ke Desktop', '-', 'Keluar']);
    expect(trayItems(true)[2]).toMatchObject({ action: 'safe-graphics-off' });
  });
  it('the hidden recovery menu carries the accelerators and calls the Shell reload, not the default role', () => {
    const calls: string[] = [];
    const t = appMenuTemplate('win32', { reload: () => calls.push('reload'), openLogs: () => calls.push('logs') });
    expect(t.map((m) => m.label)).toEqual(['Edit', 'Pemulihan']);
    const items = t[1]!.submenu as Array<{ accelerator?: string; role?: string; click?: () => void }>;
    expect(items.map((i) => i.accelerator)).toEqual(['CmdOrCtrl+R', 'F5', 'CmdOrCtrl+Shift+L']);
    expect(items.some((i) => i.role !== undefined)).toBe(false);
    for (const i of items) i.click!();
    expect(calls).toEqual(['reload', 'reload', 'logs']);
  });
});

describe('renderer console capture (FR-198)', () => {
  it('keeps every warning / error (string and numeric levels), strips queries and e-mails, caps', () => {
    expect(consoleLogEntry('error', 'Uncaught TypeError: x is undefined', 'app://expertmotion/assets/index-abc.js?v=1', 12)).toEqual({
      level: 'error', msg: 'renderer console', fields: { message: 'Uncaught TypeError: x is undefined', source: 'app://expertmotion/assets/index-abc.js', line: 12 },
    });
    expect(consoleLogEntry(2, 'deprecated')?.level).toBe('warn');
    expect(consoleLogEntry('warning', 'mail a@b.co about http://h/x?token=1')!.fields['message']).toBe('mail [email] about http://h/x');
    expect(consoleLogEntry('info', 'x')).toBeNull();
    expect(consoleLogEntry('debug', 'x')).toBeNull();
    expect(consoleLogEntry('error', 5)).toBeNull();
    expect((consoleLogEntry('error', 'a'.repeat(5000))!.fields['message'] as string).length).toBe(500);
  });
  it('rate-limits and reports what was dropped', () => {
    const gate = createCountingLimiter(2, 1000);
    expect([gate(0), gate(1), gate(2), gate(3), gate(1000)]).toEqual([{ ok: true, dropped: 0 }, { ok: true, dropped: 0 }, { ok: false, dropped: 1 }, { ok: false, dropped: 2 }, { ok: true, dropped: 2 }]);
  });
  it('main.ts captures console-message, preload-error, child-process-gone, gpu-info-update and unhandled rejections', () => {
    const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    for (const s of ["'console-message'", "'preload-error'", "'child-process-gone'", "'gpu-info-update'", "'unhandledRejection'", "'before-input-event'", "'did-start-navigation'", 'app.disableHardwareAcceleration()', 'runDiagnosticsMode()'])
      expect(src, s).toContain(s);
    // diagnostics mode is decided before the single-instance lock
    expect(src.indexOf('runDiagnosticsMode(); return;')).toBeLessThan(src.indexOf('requestSingleInstanceLock()'));
  });
});

describe('startup timings (FR-196)', () => {
  it('first mark wins, sorted by time', () => {
    const p = createPhaseTimer(1000);
    expect(p.mark('app-ready', 1200)).toBe(true);
    p.mark('first-paint', 4000); p.mark('window-created', 1300);
    expect(p.mark('app-ready', 9000)).toBe(false);
    expect(p.summary()).toEqual({ 'app-ready': 200, 'window-created': 300, 'first-paint': 3000 });
    expect(Object.keys(p.summary())).toEqual(['app-ready', 'window-created', 'first-paint']);
  });
});

describe('diagnostic report (FR-199, SEC-105)', () => {
  const now = Date.parse('2026-10-27T10:00:00Z');
  it('selects only today\'s + yesterday\'s logs and recent crash files', () => {
    const f = (name: string, ageMs = 0) => ({ name, mtimeMs: now - ageMs, size: 10 });
    const sel = selectReportFiles([
      f('shell-2026-10-27.log'), f('shell-2026-10-27.log.old'), f('service-2026-10-26.log'), f('engine-2026-10-27.log'), f('service-2026-10-25.log'),
      f('crash-shell-20261027-090000.txt'), f('crash-service-20261010-090000.txt', 17 * DAY), f('diagnostics-2026.zip'), f('settings.json'), f('expertmotion.db'), f('keyring.bin'),
    ], now);
    expect(reportDays(now)).toEqual(['2026-10-27', '2026-10-26']);
    expect(sel.logs).toEqual(['engine-2026-10-27.log', 'service-2026-10-26.log', 'shell-2026-10-27.log', 'shell-2026-10-27.log.old']);
    expect(sel.crashes).toEqual(['crash-shell-20261027-090000.txt']);
    const many = Array.from({ length: 30 }, (_, i) => f(`crash-shell-20261027-0900${String(i).padStart(2, '0')}.txt`, i * 1000));
    expect(selectReportFiles(many, now).crashes).toHaveLength(MAX_CRASH_FILES);
    expect(selectReportFiles(many, now).crashes).toContain('crash-shell-20261027-090000.txt');
  });

  it('redacts keys, tokens, hex keys and the user folder again', () => {
    const home = 'C:\\Users\\Andre';
    const line = JSON.stringify({ msg: 'x', key: 'sk-ant-api03-abcdefghijklmnop', auth: 'Bearer abcdefghijklmnopqrstuvwxyz', path: 'C:\\Users\\Andre\\AppData\\Roaming\\Expertmotion', token: 'tok-123456', dbKeyHex: 'a'.repeat(64) });
    const out = scrubReportText(`${line}\nopenrouter sk-or-v1-0123456789abcdef GET /api/events?token=secret123 ${'b'.repeat(64)}`, home);
    for (const leak of ['sk-ant-api03', 'abcdefghijklmnopqrstuvwxyz', 'Andre', 'tok-123456', 'a'.repeat(64), 'sk-or-v1-0123', 'secret123', 'b'.repeat(64)]) expect(out, leak).not.toContain(leak);
    expect(out).toContain('[REDACTED]');
  });

  it('summarises GPU info to ids, names and driver only', () => {
    const s = summarizeGpuInfo({ gpuDevice: [{ active: true, vendorId: 0x8086, deviceId: 0x46a8, driverVendor: 'Intel', driverVersion: '31.0.101.4502', deviceString: 'Intel(R) Iris(R) Xe Graphics', serial: 'X1', luid: 99 }], auxAttributes: { a: 1 }, machineModelName: 'secret-model' });
    expect(s).toEqual({ devices: [{ active: true, vendorId: '0x8086', deviceId: '0x46a8', driverVendor: 'Intel', driverVersion: '31.0.101.4502', deviceString: 'Intel(R) Iris(R) Xe Graphics' }], driverVersion: '31.0.101.4502' });
    expect(summarizeGpuInfo(null)).toBeNull();
    expect(gpuLogFields(s, { gpu_compositing: 'enabled', webgl: 'enabled', other: 1 })).toEqual({ gpu: '0x8086/0x46a8', gpuName: 'Intel(R) Iris(R) Xe Graphics', driverVendor: 'Intel', driverVersion: '31.0.101.4502', featureStatus: { gpu_compositing: 'enabled', webgl: 'enabled' } });
    expect(gpuLogFields(null, null)).toEqual({ gpu: 'unknown', featureStatus: {} });
  });

  it('builds a valid zip with README, logs, crash files and system.json; nothing else from the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'em-diag-'));
    writeFileSync(join(dir, 'shell-2026-10-27.log'), '{"msg":"provider key sk-ant-abcdefghijklmnop"}\n');
    writeFileSync(join(dir, 'service-2026-10-26.log'), '{"msg":"ok","path":"/home/andre/x"}\n');
    writeFileSync(join(dir, 'service-2026-10-20.log'), 'old\n');
    writeFileSync(join(dir, 'crash-shell-20261027-095900.txt'), 'renderer gone: crashed\n');
    writeFileSync(join(dir, 'settings.json'), '{"secret":"do-not-ship"}');
    writeFileSync(join(dir, 'keyring.bin'), 'KEY');
    const old = join(dir, 'crash-shell-20261001-000000.txt'); writeFileSync(old, 'old crash'); utimesSync(old, new Date(now - 20 * DAY), new Date(now - 20 * DAY));
    const entries = buildReportEntries({ logsDir: dir, homeDir: '/home/andre', now, system: { app: { version: '0.0.0' }, note: 'C:\\Users\\Andre\\x' } });
    expect(entries.map((e) => e.name)).toEqual(['README.txt', 'logs/service-2026-10-26.log', 'logs/shell-2026-10-27.log', 'crash/crash-shell-20261027-095900.txt', 'system.json']);
    const zip = createZip(entries, new Date(now));
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(entries.map((e) => e.name));
    const all = [...files.values()].map((b) => b.toString('utf8')).join('\n');
    for (const leak of ['sk-ant-abcdefghijklmnop', 'do-not-ship', 'KEY\n', 'andre', 'Andre', 'old crash']) expect(all, leak).not.toContain(leak);
    expect(files.get('system.json')!.toString('utf8')).toContain('"reportFiles"');
    expect(files.get('README.txt')!.toString('utf8')).toContain('Tidak termasuk');
    // CRC check against an independent table implementation
    const raw = Buffer.from('Expertmotion');
    let c = 0xffffffff; for (const b of raw) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    expect(crc32(raw)).toBe((c ^ 0xffffffff) >>> 0);
  });

  it('names the file for the Desktop', () => {
    expect(reportFileName(new Date(2026, 9, 27, 9, 5, 7))).toBe('Expertmotion-diagnostik-20261027-090507.zip');
  });
});

/** Minimal reader for archives written by createZip (verifies offsets, sizes and CRCs). */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(endAt + 10); let p = buf.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16), compSize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24), nameLen = buf.readUInt16LE(p + 28), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const lName = buf.readUInt16LE(local + 26);
    const data = zlib.inflateRawSync(buf.subarray(local + 30 + lName, local + 30 + lName + compSize));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

describe('installer: "Expertmotion – Diagnostik" Start-menu shortcut (FR-199)', () => {
  const nsi = readFileSync(new URL('../installer/expertmotion.nsi', import.meta.url), 'utf8');
  it('creates the shortcut with --diagnostics and removes it on uninstall', () => {
    expect(nsi).toContain('!define DIAG_LNK "${APP_NAME} – Diagnostik.lnk"');
    expect(nsi).toMatch(/CreateShortCut "\$SMPROGRAMS\\\$\{DIAG_LNK\}" "\$INSTDIR\\\$\{APP_EXE\}" "--diagnostics"/);
    const uninstall = nsi.slice(nsi.indexOf('Section "Uninstall"'));
    expect(uninstall).toContain('Delete "$SMPROGRAMS\\${DIAG_LNK}"');
  });
});
