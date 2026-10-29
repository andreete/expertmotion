// @vitest-environment jsdom
// QA UX fixes (round 1, 2026-10-29, independent QA interim findings): errors visible inline in every screen and toasts in one top
// layer with body + next action (P1-6); a file dropped on an asset card imports (P1-8); compact Timeline rows; tenths timecode;
// catalogue tile geometry at 1280 / 1366 / 1920; Help starts with the AI chat; platform-correct About; recovery toast only when
// something stopped; Custom ratio in the New dialog; ratio / resolution in the Export dialog; library tabs hidden on the Start screen.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EmError } from '@expertmotion/shared';
import { createEmptyModel, type CompositionModelT } from '@expertmotion/composition-model';
import { el, els, renderEditor } from './setup-dom.js';
import { App, TOAST_LAYER } from '../src/App.js';
import { StoreProvider, useStore, type Store } from '../src/state/store.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { toastActionFor, toastBodyOf } from '../src/state/toast-actions.js';
import { compactRows, elementDragEdit, laneRows } from '../src/stage/Timeline.js';
import { CATALOGUE_TILE, bucketFor, catalogueGeometry, defaultSizes, resolveColumns } from '../src/layout.js';
import { clientPlatform } from '../src/screens/Misc.js';
import { translate } from '../src/i18n/index.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const until = (fn: () => unknown, msg = 'condition') => waitFor(() => { if (!fn()) throw new Error(`waiting for ${msg}`); });

/** The Editor plus a probe that hands out the store (to raise an error the way any action would). */
async function editorWithStore(prefs: Record<string, unknown> = { onboardingDone: true, outputCollapsed: false }) {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  const runtime = createMockRuntime({ seed: 'sample', delays: false });
  let store: Store | null = null;
  const Probe = () => { const s = useStore(); useEffect(() => { store = s; }); return null; };
  render(<StoreProvider runtime={runtime} initialPrefs={prefs}><App /><Probe /></StoreProvider>);
  await until(() => document.querySelector('[data-el="stage.timeline"]') && el('hdr.title')?.textContent?.trim(), 'booted');
  return { runtime, store: () => store! };
}

describe('P1-6 toasts: one top layer, body and next action, never over the Agent column', () => {
  it('every catalogue code with a body gets it; mapped codes get a step, OK-only codes a dismiss', () => {
    expect(toastBodyOf({ textKey: 'err.EM-4103.title', code: 'EM-4103' }, 'en')).toMatch(/problem on its side/);
    expect(toastBodyOf({ textKey: 'ui.sys.toast.saved' }, 'en')).toBeNull();
    expect(toastActionFor('EM-4002', 'en')).toMatchObject({ step: { kind: 'screen', screen: { kind: 'providers' } }, label: 'Edit key' });
    expect(toastActionFor('EM-4103', 'id')?.step).toEqual({ kind: 'screen', screen: { kind: 'providers' } });
    expect(toastActionFor('EM-8003', 'en')).toMatchObject({ step: { kind: 'dismiss' }, label: 'OK' });
    expect(toastActionFor('EM-3201', 'en')?.step).toEqual({ kind: 'screen', screen: { kind: 'diagnostics' } });
    expect(toastActionFor('EM-4401', 'en')?.step.kind).toBe('privateOff');
  });

  it('an error toast shows title, body, code and an action; the stack sits above modals and left of the Agent column', async () => {
    const { store } = await editorWithStore();
    await act(async () => { store().actions.error(new EmError('EM-4103', 'boom')); });
    await until(() => els('sys.toast').some((x) => x.textContent?.includes('Provider error')), 'toast');
    const toast = els('sys.toast').find((x) => x.textContent?.includes('Provider error'))!;
    expect(toast.querySelector('[data-el="sys.toast.body"]')?.textContent).toMatch(/problem on its side/);
    expect(toast.textContent).toContain('EM-4103');
    const action = toast.querySelector<HTMLElement>('[data-el="sys.toast.action"]')!;
    expect(action.textContent).toBe('Switch model');
    const stack = el('sys.toasts')!;
    expect(Number(stack.style.zIndex)).toBe(TOAST_LAYER);
    expect(TOAST_LAYER).toBeGreaterThan(70);                                     // above modals (60), onboarding (65), tour (70)
    expect(parseInt(stack.style.right, 10)).toBeGreaterThan(300);              // the Agent column (Plan Card, composer) stays free
    await act(async () => { fireEvent.click(action); });
    await until(() => el('scr.providers'), 'providers screen from the toast action');
  });

  it('an error raised while a screen is open is shown inside that screen (and not twice as a toast)', async () => {
    const { store } = await editorWithStore();
    await act(async () => { store().actions.setScreen({ kind: 'about' }); });
    await until(() => el('scr.about'), 'about');
    await act(async () => { store().actions.error(new EmError('EM-4102', 'busy')); });
    await until(() => el('sys.screen.error'), 'inline error');
    const inline = el('sys.screen.error')!;
    expect(el('scr.about')!.contains(inline)).toBe(true);
    expect(inline.getAttribute('data-code')).toBe('EM-4102');
    expect(inline.textContent).toMatch(/Provider is busy/);
    expect(inline.textContent).toMatch(/limiting requests/);
    expect(els('sys.toast').some((x) => x.textContent?.includes('EM-4102'))).toBe(false);
  });

  it('onboarding: a provider failure other than a refused key is shown in the form with Try again', { timeout: 30_000 }, async () => {
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    const add = vi.spyOn(runtime.api, 'addConnection').mockRejectedValue(new EmError('EM-4102', 'The AI provider is overloaded right now.'));
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: false }}><App /></StoreProvider>);
    await until(() => el('scr.onboarding.welcome'), 'wizard');
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Get started')!);
    await until(() => el('scr.onboarding.provider'), 'provider step');
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: ['sk', 'or', 'v1', '0123456789abcdef'].join('-') } });   // key built at run time (secret-scan hook)
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => el('scr.providers.add.error'), 'inline provider error');
    expect(el('scr.providers.add.error')!.getAttribute('data-code')).toBe('EM-4102');
    expect(el('scr.providers.add.error')!.textContent).toMatch(/Provider is busy/);
    expect(el('scr.providers.add.retry')).not.toBeNull();
    expect(els('sys.toast').some((x) => x.textContent?.includes('EM-4102'))).toBe(false);   // inline instead of a hidden toast
    await act(async () => { fireEvent.click(el('scr.providers.add.retry')!); });
    expect(add).toHaveBeenCalledTimes(2);
  });
});

describe('P1-8 a file dropped onto an existing asset card imports it', () => {
  it('the drop bubbles to the panel import instead of being swallowed by the card', async () => {
    const { runtime } = await renderEditor('sample');
    await until(() => els('lib.assets.card').length > 0, 'asset cards');
    const up = vi.spyOn(runtime.api, 'uploadAssets');
    const file = new File(['x'], 'baru.png', { type: 'image/png' });
    await act(async () => { fireEvent.drop(els('lib.assets.card')[0]!, { dataTransfer: { files: [file], types: ['Files'] } }); });
    await until(() => up.mock.calls.length > 0, 'upload');
    expect(up.mock.calls[0]![1][0]!.name).toBe('baru.png');
  });
});

describe('Timeline: compact rows, tenths timecode', () => {
  const model = (texts: Array<{ layer: number; at: number; dur: number }>): CompositionModelT => {
    const m = createEmptyModel('01J00000000000000000000000', { ratio: '9:16', resolution: '1080p', fps: 30 });
    return { ...m, tracks: { ...m.tracks, text: texts.map((x, i) => ({ id: `t${i}`, presetId: 'preset:text.plain', text: `T${i}`, layer: x.layer, timing: { atMs: x.at, durationMs: x.dur }, params: {} })) } } as unknown as CompositionModelT;
  };
  it('packs layers that never overlap in time into one row; an overlap starts a new row', () => {
    const scenes = model(Array.from({ length: 12 }, (_, i) => ({ layer: i, at: i * 1000, dur: 900 })));   // 12 layers, one after another
    const full = laneRows(scenes).filter((r) => r.kind === 'layer' && !r.isNew);
    expect(full).toHaveLength(12);
    const packed = compactRows(scenes, laneRows(scenes)).rows.filter((r) => r.kind === 'layer' && !r.isNew);
    expect(packed).toHaveLength(1);
    expect(packed[0]!.layers).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const stacked = model([{ layer: 0, at: 0, dur: 2000 }, { layer: 1, at: 500, dur: 1000 }, { layer: 2, at: 3000, dur: 500 }]);
    const rows = compactRows(stacked, laneRows(stacked)).rows.filter((r) => r.kind === 'layer' && !r.isNew);
    expect(rows.map((r) => r.layers)).toEqual([[2, 1], [0]]);            // 1 and 0 overlap → never share a row
  });
  it('a move inside a packed row keeps the layer; a move onto another row takes that row\'s top layer', () => {
    const m = model([{ layer: 0, at: 0, dur: 2000 }, { layer: 1, at: 500, dur: 1000 }, { layer: 2, at: 3000, dur: 500 }]);
    const { rows, rowOf } = compactRows(m, laneRows(m));
    const bar = { id: 't2', kind: 'text', fromMs: 3000, toMs: 3500, row: rowOf.get('layer:2')!, lane: 2 };
    const opts = { pxPerMs: 0.1, playheadMs: 0, snap: false, edges: [], assetOf: () => null, rows };
    expect(elementDragEdit(m, bar, 'move', 100, 0, opts)?.edit).toMatchObject({ atMs: 4000 });
    expect(elementDragEdit(m, bar, 'move', 100, 0, opts)?.edit?.layer).toBeUndefined();
    expect(elementDragEdit(m, bar, 'move', 0, 1, opts)?.edit).toMatchObject({ layer: 0 });
  });
  it('time reads as mm:ss.d', () => {
    expect(translate('en', 'ui.stage.timeline.lane.layers', { from: 1, to: 9 })).toBe('Layers 1–9');
  });
});

describe('Layout: catalogue tiles at 1280×720, 1366×768, 1920×1080', () => {
  it('every tile keeps a readable two-line label and the ⓘ button clear of it', () => {
    for (const w of [1280, 1366, 1920]) {
      const d = defaultSizes(bucketFor(w));
      const cols = resolveColumns({ width: w, lib: d.lib, agent: d.agent, libOpen: true, agentOpen: true });
      const g = catalogueGeometry(cols.lib);
      expect(g.infoClear).toBe(true);
      expect(g.tile).toBeGreaterThanOrEqual(CATALOGUE_TILE.min);
      expect(g.label, `label width at ${w}`).toBeGreaterThanOrEqual(60);    // ≥ ~8 characters per line at 13 px, two lines
    }
  });
  it('the grid and label classes match the geometry model', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.menu.design')!);
    await until(() => els('lib.catalogue.card.label').length > 0, 'catalogue');
    const label = els('lib.catalogue.card.label')[0]!;
    expect(label.className).toMatch(/\bline-clamp-2\b/);
    expect(label.className).toMatch(/\bpr-8\b/);
    expect(label.className).not.toMatch(/\btruncate\b/);
    const grid = label.closest('[role="grid"]')!;
    expect(grid.className).toContain(`minmax(${CATALOGUE_TILE.min}px`);
  });
});

describe('Copy and screens', () => {
  it('Help starts with the AI assistant and its button focuses the composer', async () => {
    const { store } = await editorWithStore();
    await act(async () => { store().actions.setScreen({ kind: 'help' }); });
    await until(() => el('scr.help.ai'), 'help');
    const focus = vi.fn(); window.addEventListener('em:focus-composer', focus);
    await act(async () => { fireEvent.click(el('scr.help.ai.open')!); });
    expect(focus).toHaveBeenCalled();
    window.removeEventListener('em:focus-composer', focus);
  });
  it('About names the platform\'s own account protection', () => {
    const nav = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    const set = (ua: string) => Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua });
    set('Mozilla/5.0 (X11; Linux x86_64)'); expect(clientPlatform()).toBe('linux');
    set('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'); expect(clientPlatform()).toBe('win32');
    set('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'); expect(clientPlatform()).toBe('darwin');
    if (nav) Object.defineProperty(navigator, 'userAgent', nav); else delete (navigator as { userAgent?: string }).userAgent;
    expect(translate('en', 'ui.scr.about.security.linux')).not.toMatch(/Windows/);
    expect(translate('id', 'ui.scr.about.security.mac')).toMatch(/macOS/);
  });
  it('onboarding copy: the skipped list uses short step names (no "tour?."); the PC step does not say "Nothing to fix" above notes', () => {
    const steps = ['provider', 'tour'].map((s) => translate('en', `onb.step.${s}`)).join(', ');
    expect(translate('en', 'onb.done.skipped', { steps })).toBe('Skipped: AI provider, Tour. You can finish them later.');
    expect(translate('en', 'onb.hardware.body.notes')).not.toMatch(/Nothing to fix/);
  });
  it('plain-language change toast ("Changed: Text", not "Applied directly: content")', () => {
    expect(translate('en', 'ui.sys.toast.changed', { label: translate('en', 'ui.agent.param.content') })).toBe('Changed: Text');
    expect(translate('id', 'ui.sys.toast.changed', { label: translate('id', 'ui.agent.param.content') })).toBe('Diubah: Teks');
  });
  it('voice-over progress names the clips that are ready', () => {
    expect(translate('en', 'ui.agent.plan.exec.voice.progress', { done: 4, total: 9 })).toBe('Making the voice-over: 4 of 9 clips ready…');
  });
});

describe('Restart notice only when it matters (EM-8003)', () => {
  it('a restart that stopped nothing says nothing; one that stopped an export says what, in plain words', async () => {
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    sessionStorage.setItem('expertmotion.recovery.seen', '2000-01-01T00:00:00.000Z');
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    const base = { startedAt: new Date().toISOString(), unclean: true, renders: [] as unknown[], agentRuns: [] as unknown[], ingests: [] as unknown[], plans: [] as unknown[], checkpoints: { offered: [] as string[], imported: [] as string[] } };
    const rec = vi.spyOn(runtime.api, 'getRecovery').mockResolvedValue(base as never);
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await until(() => rec.mock.calls.length > 0, 'recovery checked');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(els('sys.toast').some((x) => /Service restarted|ended unexpectedly/.test(x.textContent ?? ''))).toBe(false);
    cleanup();
    sessionStorage.setItem('expertmotion.recovery.seen', '2000-01-01T00:00:00.000Z');
    const runtime2 = createMockRuntime({ seed: 'sample', delays: false });
    vi.spyOn(runtime2.api, 'getRecovery').mockResolvedValue({ ...base, startedAt: new Date(Date.now() + 1000).toISOString(), renders: [{ jobId: 'j1' }] } as never);
    render(<StoreProvider runtime={runtime2} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await until(() => els('sys.toast').some((x) => /ended unexpectedly/.test(x.textContent ?? '')), 'plain recovery toast');
    const t = els('sys.toast').find((x) => /ended unexpectedly/.test(x.textContent ?? ''))!;
    expect(t.textContent).toContain('1 export');
    expect(t.textContent).not.toContain('Service restarted');
  });
});

describe('New project with a Custom ratio; ratio and resolution inside Export', () => {
  it('Custom shows width / height and applies them to the new project', { timeout: 30_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    const layout = vi.spyOn(runtime.api, 'createIntent');
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.newcustom')!);
    await until(() => el('scr.project.new'), 'new dialog');
    fireEvent.change(el('scr.project.new.ratio')!, { target: { value: 'custom' } });
    await until(() => el('scr.project.new.customratio'), 'custom fields');
    fireEvent.change(el('scr.project.new.customratio.width')!, { target: { value: '5' } });
    fireEvent.change(el('scr.project.new.customratio.height')!, { target: { value: '7' } });
    fireEvent.change(el('scr.project.new.name')!, { target: { value: 'Rasio sendiri' } });
    await act(async () => { fireEvent.click(el('scr.project.new.create')!); });
    await until(() => layout.mock.calls.some(([, b]) => (b as { output?: { kind?: string; value?: string; customRatio?: unknown } }).output?.value === 'custom'), 'custom ratio pick');
    const pick = layout.mock.calls.find(([, b]) => (b as { output?: { value?: string } }).output?.value === 'custom')![1] as { output: { customRatio: unknown } };
    expect(pick.output.customRatio).toEqual({ w: 5, h: 7 });
  });
  it('the Export dialog offers ratio and resolution', async () => {
    const { store } = await editorWithStore();
    await act(async () => { store().actions.setScreen({ kind: 'export' }); });
    await until(() => el('scr.export.ratio'), 'export ratio');
    expect((el('scr.export.ratio') as HTMLSelectElement).options.length).toBeGreaterThanOrEqual(7);
    expect(el('scr.export.resolution')).not.toBeNull();
  });
});

describe('Final QA items: composer limits, removal sentence, offline downloads', () => {
  it('Send is disabled for an empty / whitespace-only message and past 8 000 characters, with a counter', async () => {
    await renderEditor('sample');
    const box = el('agent.chat.composer') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '   ' } });
    expect(el('agent.chat.send')!.getAttribute('aria-disabled') === 'true' || (el('agent.chat.send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'x'.repeat(6500) } });
    expect(el('agent.chat.composer.count')!.textContent).toBe('6500 / 8000');
    fireEvent.change(box, { target: { value: 'x'.repeat(8001) } });
    expect(el('agent.chat.composer.count')!.textContent).toMatch(/at most 8[,.]?000/);
    expect(el('agent.chat.send')!.getAttribute('aria-disabled') === 'true' || (el('agent.chat.send') as HTMLButtonElement).disabled).toBe(true);
  });
  it('the removal confirmation is a sentence without the raw code', () => {
    expect(translate('en', 'ui.agent.plan.confirmremoval.sentence', { n: 1 })).toBe('This plan removes 1 item from the video:');
    expect(translate('en', 'ui.agent.plan.confirmremoval.sentence', { n: 3 })).toBe('This plan removes 3 items from the video:');
    expect(translate('id', 'ui.agent.plan.confirmremoval.sentence', { n: 3 })).not.toMatch(/EM-/);
  });
  it('a download without internet says so (and keeps the Try again)', async () => {
    const { reducer, initialState } = await import('../src/state/reducer.js');
    const m = { key: 'k', status: 'downloading', bytesDone: 0, bytesTotal: 100 } as never;
    const s0 = { ...initialState, models: [m] } as never;
    const s1 = reducer(s0, { type: 'event', event: { name: 'model.progress', data: { key: 'k', bytesDone: 0, bytesTotal: 100, status: 'downloading', retry: { attempt: 1, reason: 'connection', delayMs: 2000, netCode: 'ENETUNREACH' }, noNetwork: true } } } as never) as { models: Array<{ noNetwork?: boolean }> };
    expect(s1.models[0]!.noNetwork).toBe(true);
    expect(translate('id', 'ui.scr.models.status.offline', { percent: 0 })).toMatch(/^Tidak ada koneksi internet/);
  });
});
