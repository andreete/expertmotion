// @vitest-environment jsdom
// FR gap closure: toasts (FR-154), Export dialog (FR-136…FR-147, FR-163), licence states and buy link (FR-132…FR-135),
// offline Help (FR-148), Diagnostics/About (FR-150, FR-151), update banner (FR-152, FR-162), Private Mode queue (FR-160), Generator Cards (FR-100…FR-108).
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { renderEditor, el, els } from './setup-dom.js';
import { App, toastDismissMs } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import { recoveryFor, QUALITY_CRF } from '../src/screens/Export.js';
import { licenceView } from '../src/screens/License.js';
import { generatedList, retimePage } from '../src/screens/Generate.js';
import { renderQueue } from '../src/state/workload.js';
import { hasWaitingIntents } from '../src/state/store.js';
import { BUNDLED_NOTICES, HELP_SECTIONS } from '../src/screens/Misc.js';
import { DOCS_URL, STORE_URL } from '../src/api/client.js';
import type { EditIntent, GeneratorJobDto, LicenseDto, RenderJobDto } from '../src/api/types.js';

import en from '../src/i18n/en.json';
const COMING_SOON = (en as Record<string, string>)['ui.lib.catalogue.comingsoon']!;
afterEach(() => { cleanup(); delete (window as { expertmotion?: unknown }).expertmotion; });
const shell = (over: Record<string, unknown> = {}) => {
  const s = { openExternal: vi.fn(), openFolder: vi.fn(), openPath: vi.fn(), pickFolder: vi.fn(async () => null), updateAction: vi.fn(), ...over };
  (window as unknown as { expertmotion: unknown }).expertmotion = s; return s as typeof s & { updateAction: ReturnType<typeof vi.fn> };
};

describe('pure rules', () => {
  it('FR-154: info auto-dismisses after 6 s, warn and error stay', () => {
    expect(toastDismissMs({ kind: 'info', textKey: 'x', sticky: false })).toBe(6000);
    expect(toastDismissMs({ kind: 'success', textKey: 'x', sticky: false })).toBe(6000);
    expect(toastDismissMs({ kind: 'warn', textKey: 'x', sticky: false })).toBeNull();
    expect(toastDismissMs({ kind: 'danger', textKey: 'x', sticky: false })).toBeNull();
    expect(toastDismissMs({ kind: 'info', textKey: 'x', sticky: true })).toBeNull();
    expect(toastDismissMs({ kind: 'success', textKey: 'ui.sys.toast.saved', sticky: false })).toBe(1500);
  });
  it('FR-139: every preflight code has its recovery button', () => {
    expect(recoveryFor({ check: 'disk', ok: false, code: 'EM-3102' }, 'standard')).toBe('folder');
    expect(recoveryFor({ check: 'folder', ok: false, code: 'EM-3206' }, 'standard')).toBe('folder');
    expect(recoveryFor({ check: 'memory', ok: false, code: 'EM-3101' }, 'turbo')).toBe('standard');
    expect(recoveryFor({ check: 'memory', ok: false, code: 'EM-3101' }, 'standard')).toBe('recheck');
    expect(recoveryFor({ check: 'dimensions', ok: false, code: 'EM-3103' }, 'standard')).toBe('settings');
    expect(recoveryFor({ check: 'assets', ok: false, code: 'EM-1301' }, 'standard')).toBe('assets');
    expect(recoveryFor({ check: 'engine', ok: false, code: 'EM-3003' }, 'standard')).toBe('diagnostics');
    expect(recoveryFor({ check: 'licence', ok: true, code: 'EM-5001' }, 'standard')).toBe('license');
    expect(recoveryFor({ check: 'disk', ok: true }, 'standard')).toBeNull();
    expect(QUALITY_CRF).toEqual({ standard: 18, smaller: 23 });
  });
  it('FR-134: licence states, name/tier/date, clock-changed badge', () => {
    const base: LicenseDto = { status: 'active', tier: 'standard', licenseeHash: 'h', licenseeName: 'Septi', updatesUntil: '2027-10-01T00:00:00.000Z', updatesEligible: true, machineCode: 'MC', limits: { watermark: false, maxResolution: '2160p' } };
    expect(licenceView(base)).toMatchObject({ status: 'active', tone: 'success', vars: { name: 'Septi', tier: 'standard', date: '2027-10-01' }, clock: false });
    expect(licenceView({ ...base, status: 'updates-expired' })).toMatchObject({ code: 'EM-5005' });
    expect(licenceView({ ...base, status: 'revoked' })).toMatchObject({ code: 'EM-5004', tone: 'danger' });
    expect(licenceView({ ...base, clockAnomaly: true }).clock).toBe(true);
    expect(licenceView(null).status).toBe('trial');
  });
  it('FR-104 edited caption text keeps timing; FR-108 Generated list keeps 7 days of uninserted results', () => {
    const p = { text: 'halo dunia', startMs: 1000, durationMs: 1000, tokens: [] };
    expect(retimePage(p, 'Halo, dunia kita').tokens).toEqual([{ text: 'Halo,', fromMs: 1000, toMs: 1333 }, { text: 'dunia', fromMs: 1333, toMs: 1667 }, { text: 'kita', fromMs: 1667, toMs: 2000 }]);
    expect(retimePage(p, 'halo dunia')).toBe(p);
    const now = Date.parse('2026-10-24T12:00:00Z');
    const j = (id: string, ageDays: number, extra: Partial<GeneratorJobDto> = {}): GeneratorJobDto => ({ id, projectId: 'p', kind: 'voice', status: 'done', progress: 1, modelKey: null, resultAssetId: null, result: {}, errorCode: null, createdAt: new Date(now - ageDays * 86_400_000).toISOString(), startedAt: null, finishedAt: null, ...extra });
    expect(generatedList([j('a', 1), j('b', 8), j('c', 2, { result: { versionId: 'v' } }), j('d', 1, { status: 'failed' })], now).map((x) => x.id)).toEqual(['a']);
  });
  it('FR-142 queue view and FR-160 waiting intents', () => {
    const r = (id: string, status: RenderJobDto['status'], createdAt: string) => ({ id, status, createdAt }) as RenderJobDto;
    const q = renderQueue([r('c', 'queued', '3'), r('a', 'rendering', '1'), r('b', 'queued', '2'), r('d', 'done', '0')]);
    expect(q.active?.id).toBe('a'); expect(q.queued.map((x) => x.id)).toEqual(['b', 'c']); expect(q.size).toBe(3);
    const intent = (over: Partial<EditIntent>) => ({ status: 'queued', needsInterpretation: false, ...over }) as EditIntent;
    expect(hasWaitingIntents({ queue: { projectId: 'p', headHash: '', lockedKeys: [], items: [intent({})] } })).toBe(false);
    expect(hasWaitingIntents({ queue: { projectId: 'p', headHash: '', lockedKeys: [], items: [intent({ needsInterpretation: true })] } })).toBe(true);
  });
  it('FR-151 notices list every Engine Binary and the fonts; FR-148 offline help has its sections', () => {
    const names = BUNDLED_NOTICES.map((n) => n.name).join('\n');
    for (const n of ['Chrome Headless Shell', 'FFmpeg n7.1', 'FFmpeg for import', 'whisper.cpp', 'sherpa-onnx', 'espeak-ng', 'stable-diffusion.cpp', 'fonts', 'Remotion']) expect(names).toContain(n);
    expect(BUNDLED_NOTICES.filter((n) => n.gpl).length).toBe(2);
    expect(HELP_SECTIONS).toContain('private');
  });
});

describe('Editor screens (mock mode)', () => {
  it('FR-148: Documentation opens the offline help; online link opens the browser, or shows EM-8202 with a copyable URL in Private Mode', async () => {
    const s = shell();
    const { runtime } = await renderEditor('sample');
    fireEvent.click(el('hdr.menu.help')!);
    fireEvent.click(el('hdr.menu.help.docs')!);
    await waitFor(() => { if (!el('scr.help')) throw new Error('no help'); });
    expect(document.querySelectorAll('[data-help-section]').length).toBe(HELP_SECTIONS.length);
    fireEvent.click(el('scr.help.online')!);
    expect(s.openExternal).toHaveBeenCalledWith(DOCS_URL);
    await act(async () => { await runtime.api.putSettings({ privateMode: true }); });
    await waitFor(() => { if (!el('sys.privatemode.banner')) throw new Error('not private'); });
    fireEvent.click(el('scr.help.online')!);
    expect(s.openExternal).toHaveBeenCalledTimes(1);
    expect(el('scr.help.online.blocked')?.textContent).toContain(DOCS_URL);
    expect(el('scr.help.online.blocked')?.textContent).toContain('Blocked by Private Mode');
  });

  it('FR-132/FR-135: buy link is blocked in Private Mode with the URL; after Deactivate the re-bind steps appear', async () => {
    const s = shell();
    const { runtime } = await renderEditor('sample');
    await act(async () => { await runtime.api.putSettings({ privateMode: true }); });
    await act(async () => { fireEvent.click(el('hdr.action.purchase')!); });
    await waitFor(() => { if (!el('scr.license')) throw new Error('no licence'); });
    fireEvent.click(el('scr.license.buy')!);
    expect(s.openExternal).not.toHaveBeenCalled();
    expect(el('scr.license.buy.blocked')?.textContent).toContain(STORE_URL);
    await act(async () => { await runtime.api.putSettings({ privateMode: false }); });
    fireEvent.change(el('scr.license.input')!, { target: { value: `EM1.${'A'.repeat(60)}` } });
    await act(async () => { fireEvent.click(el('scr.license.activate')!); });
    await act(async () => { fireEvent.click(el('hdr.action.license')!); });
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-licence-status] button')!); });
    await waitFor(() => { if (el('scr.license.status')?.getAttribute('data-status') !== 'active') throw new Error('not active'); });
    expect(el('scr.license.status')?.textContent).toContain('Septianus Angga');
    fireEvent.click(el('scr.license.remove')!);
    await act(async () => { fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('[data-el="scr.license"] button')].find((b) => b.textContent === 'Confirm')!); });
    await waitFor(() => { if (!el('scr.license.rebind')) throw new Error('no rebind'); });
    expect(el('scr.license.rebind')!.querySelectorAll('li').length).toBe(3);
    expect(el('scr.license.status')?.getAttribute('data-status')).toBe('trial');
  });

  it('FR-136…FR-147: default filename, quality labels, PNG frame time, Private Mode row, recovery buttons, done with Play/Copy path', async () => {
    const s = shell();
    const { runtime } = await renderEditor('sample');
    await act(async () => { await runtime.api.putSettings({ privateMode: true }); });
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await waitFor(() => { if (!el('scr.export.private')) throw new Error('no estimate'); });
    expect((el('scr.export.filename') as HTMLInputElement).value).toMatch(/-\d{8}-\d{4}$/);
    expect([...(el('scr.export.quality') as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Standard (CRF 18)', 'Smaller file (CRF 23)']);
    expect(el('scr.export.profile.summary')!.textContent).toMatch(/720p \(trial\)/);
    expect(els('scr.export.preflight.fix').some((b) => b.textContent === 'Enter licence key')).toBe(true);
    fireEvent.click(el('scr.export.codec.png')!);
    await waitFor(() => { if (!el('scr.export.still.time')) throw new Error('no still time'); });
    const est = vi.spyOn(runtime.api, 'estimateRender');
    fireEvent.change(el('scr.export.still.time')!, { target: { value: '2.5' } });
    await waitFor(() => { if (!est.mock.calls.some((c) => c[0].outputProfile.stillAtMs === 2500)) throw new Error('no stillAtMs'); });
    fireEvent.click(el('scr.export.codec.mp4')!);
    await waitFor(() => { if (!el('scr.export.start') || el('scr.export.start')!.hasAttribute('disabled')) throw new Error('start disabled'); });
    await act(async () => { fireEvent.click(el('scr.export.start')!); });
    await waitFor(() => { if (!el('scr.export.done')) throw new Error('not done'); }, { timeout: 8000 });
    await act(async () => { fireEvent.click(el('scr.export.done.play')!); });
    await waitFor(() => { if (!s.openPath.mock.calls.length) throw new Error('no play'); });
    expect(String(s.openPath.mock.calls[0]![0])).toMatch(/\.mp4$/);
  });

  it('FR-143: the failure dialog names the EM code, the percent and the frame the render stopped at, with Try again and Diagnostics', async () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    const bus = new MockBus();
    const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
    const real = runtime.api.createRender.bind(runtime.api);
    let jobId = '';
    vi.spyOn(runtime.api, 'createRender').mockImplementation(async (b) => { const j = await real(b); jobId = j.id; await runtime.api.cancelRender(j.id); bus.emit('render.failed', { projectId: j.projectId, jobId: j.id, code: 'EM-3201', percent: 40, frame: 120 }); return { ...j, status: 'failed', errorCode: 'EM-3201', progress: 0.4, failedFrame: 120 }; });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => { if (!el('agent.output.ratio.9x16')?.hasAttribute('aria-checked')) throw new Error('boot'); });
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await waitFor(() => { if (!el('scr.export.start') || el('scr.export.start')!.hasAttribute('disabled')) throw new Error('start disabled'); });
    await act(async () => { fireEvent.click(el('scr.export.start')!); });
    await waitFor(() => { if (!el('scr.export.failed.frame')) throw new Error('no failure frame'); });
    expect(jobId).not.toBe('');
    expect(el('scr.export.failed.frame')!.textContent).toMatch(/^Stopped at frame 120 of \d+ \(0:04\)$/);
    expect(el('scr.export')!.textContent).toContain('Rendering stopped at 40 %');
    expect(el('scr.export.diagnostics')).not.toBeNull();
  });

  it('FR-100: Generator Cards follow R-135 (priority, model, installed state; Coming soon only for kinds the service disables)', async () => {
    await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    await waitFor(() => { if (el('lib.generator.card.music')?.getAttribute('data-enabled') !== 'false') throw new Error('cards not loaded'); });
    expect(el('lib.generator.card.music')!.textContent).toContain(COMING_SOON);
    expect(el('lib.generator.card.voice')!.getAttribute('data-enabled')).toBe('true');
    expect(el('lib.generator.card.voice')!.textContent).toMatch(/P1/);
    expect(el('lib.generator.card.voice')!.textContent).toMatch(/Piper Indonesian voice · 63/);
    expect(el('lib.generator.card.voice')!.getAttribute('data-installed')).toBe('false');
  });

  it('FR-152/FR-162: the update banner offers consent download, then Restart now / Later; Private Mode shows "Updates paused"', async () => {
    let push: (s: unknown) => void = () => {};
    const s = shell({ onUpdateState: (cb: (s: unknown) => void) => { push = cb; return () => {}; }, getUpdateState: async () => ({ status: 'available', version: '1.1.0' }) });
    const { runtime } = await renderEditor('sample');
    await waitFor(() => { if (!el('sys.update.download')) throw new Error('no banner'); });
    fireEvent.click(el('sys.update.download')!);
    expect(s.updateAction).toHaveBeenCalledWith('download');
    await act(async () => { push({ status: 'downloaded', version: '1.1.0', code: 'EM-8105' }); });
    expect(el('sys.update')!.textContent).toContain('1.1.0');
    fireEvent.click(el('sys.update.restart')!);
    expect(s.updateAction).toHaveBeenCalledWith('restart');
    await act(async () => { await runtime.api.putSettings({ privateMode: true }); });
    await waitFor(() => { if (el('sys.update')?.getAttribute('data-status') !== 'paused') throw new Error('not paused'); });
    expect(el('sys.update')!.textContent).toContain('Updates paused by Private Mode');
  });

  it('FR-131: dropping a .emlicense file fills the key and activates; a non-licence file shows EM-5006', async () => {
    const { runtime } = await renderEditor('sample');
    const spy = vi.spyOn(runtime.api, 'activateLicense');
    await act(async () => { fireEvent.click(el('hdr.action.purchase')!); });
    await waitFor(() => { if (!el('scr.license')) throw new Error('no licence'); });
    const zone = el('scr.license.input')!.parentElement!;
    const bad = new File(['hello'], 'notes.pdf', { type: 'application/pdf' });
    await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [bad], types: ['Files'] } }); });
    await waitFor(() => { if (!el('scr.license.error')?.textContent?.includes('EM-5006')) throw new Error('no EM-5006'); });
    expect(spy).not.toHaveBeenCalled();
    const key = `EM1.${'B'.repeat(60)}`;
    const file = new File([`\uFEFF${key}\n`], 'lic-01.emlicense', { type: '' });
    await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } }); });
    await waitFor(() => { if (!spy.mock.calls.length) throw new Error('not activated'); });
    expect(spy).toHaveBeenCalledWith(key);
    await waitFor(() => { if (el('scr.license')) throw new Error('still open'); });                    // activated → screen closes, Trial limits gone
  });

  it('FR-133: EM-5001 is shown once at first launch in Trial Mode, with "Enter licence key"', async () => {
    await renderEditor('sample', { prefs: { nudgesDismissed: [] } });
    await waitFor(() => { if (!els('sys.toast').some((x) => x.textContent?.includes('EM-5001'))) throw new Error('no EM-5001'); });
    expect(JSON.parse(localStorage.getItem('expertmotion.prefs.v1')!).nudgesDismissed).toContain('lic:EM-5001');
    cleanup();
    await renderEditor('sample', { prefs: { nudgesDismissed: ['lic:EM-5001'] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(els('sys.toast').some((x) => x.textContent?.includes('EM-5001'))).toBe(false);
  });

  it('FR-154: toasts are announced through sys.live and are not live regions themselves', async () => {
    await renderEditor('sample', { prefs: { nudgesDismissed: [] } });
    await waitFor(() => { if (!el('sys.live')?.textContent?.includes('EM-5001')) throw new Error(`live: ${el('sys.live')?.textContent}`); });
    for (const t of els('sys.toast')) { expect(t.getAttribute('role')).toBeNull(); expect(t.getAttribute('aria-live')).toBeNull(); }
  });

  it('FR-138: WebM (transparent) is offered, disabled with a reason while the background is opaque', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.menu.design')!);
    await waitFor(() => { if (!document.querySelector('[data-el="lib.catalogue.tab"][data-category="background"]')) throw new Error('no tabs'); });
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.catalogue.tab"][data-category="background"]')!);
    await waitFor(() => { if (!document.querySelector('[data-preset-id="preset:background.gradient"]')) throw new Error('no gradient card'); });
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-preset-id="preset:background.gradient"]')!); });
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await waitFor(() => { if (el('scr.export.codec.webm')?.getAttribute('aria-disabled') !== 'true') throw new Error('webm not disabled'); });
    expect(el('scr.export.codec.webm.reason')?.textContent).toContain('background');
    fireEvent.click(el('scr.export.codec.webm')!);
    expect(el('scr.export.codec.mp4')!.getAttribute('aria-checked')).toBe('true');
  });

  it('FR-152: an interrupted update (EM-8104) offers Try again', async () => {
    const s = shell({ onUpdateState: () => () => {}, getUpdateState: async () => ({ status: 'error', version: '1.1.0', code: 'EM-8104' }) });
    await renderEditor('sample');
    await waitFor(() => { if (!el('sys.update.retry')) throw new Error('no retry'); });
    expect(el('sys.update')!.textContent).toContain('EM-8104');
    fireEvent.click(el('sys.update.retry')!);
    expect(s.updateAction).toHaveBeenCalledWith('check');
  });
});
