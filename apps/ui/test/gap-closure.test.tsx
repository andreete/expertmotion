// @vitest-environment jsdom
// FR gap closure in the Editor (mock Local Service): immediate cards for the packaged path import and EM-1006 without a card
// (FR-014/041/050), per-stage labels and EM-1201 "Import again" (FR-042), select all (FR-045), Locate/Remove in the Timeline
// inspector (FR-048), Insert at the playhead recorded in the Intent Queue (FR-049), banner actions (FR-053), Home Ratio/Video Size
// popovers (FR-031), selected card per target (FR-039), held picks (FR-037), Save always available + UI state (FR-012).
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { renderEditor, el, els } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { selectedPresetIds } from '../src/library/Catalogue.js';
import { initialState, reducer } from '../src/state/reducer.js';
import type { AssetDto, EditIntent } from '../src/api/types.js';

afterEach(() => { cleanup(); delete (window as { expertmotion?: unknown }).expertmotion; vi.restoreAllMocks(); });
const until = (fn: () => unknown, msg = 'condition') => waitFor(() => { if (!fn()) throw new Error(`waiting for ${msg}`); });
const importBtn = () => document.querySelector<HTMLElement>('[data-el="lib.assets.panel"] button[aria-label="Import files"]')!;
const toasts = () => els('sys.toast').map((x) => x.textContent ?? '');
const live = (runtime: Runtime) => { (runtime as { mode: Runtime['mode'] }).mode = 'live'; };
const ingesting = (projectId: string, id: string, name: string): AssetDto => ({
  id, projectId, kind: 'video', name, bytes: 10, sha256: '', status: 'ingesting', progress: 0, errorCode: null, durationMs: null, width: null, height: null, fps: null, hasAudio: null,
  sequenceBadge: null, media: { original: true, playable: false, proxy: false, thumb: false, filmstrip: false, waveform: false }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

describe('Asset Panel import (FR-014, FR-041, FR-042, FR-050)', () => {
  it('the packaged picker shows ingesting cards at once with a stage label; a duplicate by path is a toast, not a card', async () => {
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    live(runtime);                                                   // packaged app: Shell bridge + path import
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, nudgesDismissed: [] }}><App /></StoreProvider>);
    await until(() => els('lib.assets.card').length === 3, 'sample cards');
    const pid = runtime.seededProjectId!;
    const before = els('lib.assets.card').length;
    const existing = (await runtime.api.listAssets(pid)).items[0]!;
    const spy = vi.spyOn(runtime.api, 'importAssetPaths')
      .mockResolvedValueOnce({ items: [ingesting(pid, '01JAZM0000000000000000000A', 'a.mp4'), ingesting(pid, '01JAZM0000000000000000000B', 'b.mp4'), ingesting(pid, '01JAZM0000000000000000000C', 'c.mp4')], notices: [] })
      .mockResolvedValueOnce({ items: [], notices: [{ code: 'EM-1006', assetId: existing.id }] });
    (window as { expertmotion?: unknown }).expertmotion = { pickFiles: async () => ['/home/me/a.mp4', '/home/me/b.mp4', '/home/me/c.mp4'] };
    await act(async () => { fireEvent.click(importBtn()); });
    await until(() => els('lib.assets.card.state.ingesting').length === 3, 'three ingesting cards');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(els('lib.assets.card').length).toBe(before + 3);
    expect(els('lib.assets.card.state.ingesting')[0]!.textContent).toContain('Waiting');
    // the same file again → EM-1006 toast with "Show it", and no new card
    await act(async () => { fireEvent.click(importBtn()); });
    await until(() => toasts().some((x) => x.includes('Already imported')), 'EM-1006 toast');
    expect(els('lib.assets.card').length).toBe(before + 3);
  });

  it('FR-018 a restore that became a renamed copy keeps EM-6303 and the name on the job (restore dialog notice)', () => {
    const s0 = { ...initialState, backupJob: { jobId: 'J', percent: 80, done: false, mode: 'restore' as const } };
    const s = reducer(s0, { type: 'event', event: { name: 'service.notice', data: { kind: 'restore', jobId: 'J', done: true, projectId: 'P2', code: 'EM-6303', name: 'Kopi (restored)', at: '' } } as never });
    expect(s.backupJob).toMatchObject({ done: true, projectId: 'P2', code: 'EM-6303', name: 'Kopi (restored)' });
  });

  it('reducer: ingest progress moves the card through stages; EM-1006 after hashing drops the card; other failures stay as cards', () => {
    const a = ingesting('p', 'A1', 'x.mp4');
    let s = reducer({ ...initialState, assets: [a] }, { type: 'event', event: { name: 'ingest.progress', data: { assetId: 'A1', stage: 'paused', progress: 0.2, at: '' } } as never });
    expect(s.ingestStage['A1']).toBe('paused');
    s = reducer(s, { type: 'event', event: { name: 'ingest.failed', data: { assetId: 'A1', code: 'EM-1006', name: 'x.mp4', existingAssetId: 'B', at: '' } } as never });
    expect(s.assets).toHaveLength(0);
    s = reducer({ ...initialState, assets: [a] }, { type: 'event', event: { name: 'ingest.failed', data: { assetId: 'A1', code: 'EM-1003', name: 'x.mp4', at: '' } } as never });
    expect(s.assets[0]).toMatchObject({ status: 'failed', errorCode: 'EM-1003' });
  });

  it('an interrupted card (EM-1201) offers Import again: the card goes and the picker opens', async () => {
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    const list = runtime.api.listAssets.bind(runtime.api);
    const failedId = '01JAZM00000000000000000F01';
    let gone = false;
    vi.spyOn(runtime.api, 'listAssets').mockImplementation(async (...args) => { const p = await list(...args); return gone ? p : { ...p, items: [...p.items, { ...ingesting(args[0], failedId, 'kopi.mov'), status: 'failed', errorCode: 'EM-1201' }] }; });
    const del = vi.spyOn(runtime.api, 'deleteAsset').mockImplementation(async () => { gone = true; return undefined; });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, nudgesDismissed: [] }}><App /></StoreProvider>);
    await until(() => el('lib.assets.card.action.importagain'), 'Import again');
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const clicked = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    await act(async () => { fireEvent.click(el('lib.assets.card.action.importagain')!); });
    expect(del).toHaveBeenCalledWith(runtime.seededProjectId, failedId, false);
    await until(() => clicked.mock.calls.length > 0, 'picker opened');
    expect(input.accept).toBe('.mov');
    await until(() => !document.querySelector(`[data-asset-id="${failedId}"]`), 'card removed');
  });
});

describe('Asset Panel selection, banner, inspector (FR-045, FR-053, FR-048)', () => {
  it('FR-045 select all marks every ready asset with badges 1…n; Ctrl+A on the panel toggles it off again', async () => {
    await renderEditor('sample');
    const badges = () => els('lib.assets.card.badge.sequence').map((b) => b.textContent);
    await act(async () => { fireEvent.click(el('lib.assets.selectall')!); });
    await waitFor(() => expect(badges()).toEqual(['1', '2', '3']));
    expect((els('lib.assets.card.select') as HTMLInputElement[]).every((b) => b.checked)).toBe(true);
    await act(async () => { fireEvent.keyDown(els('lib.assets.card')[0]!, { key: 'a', ctrlKey: true }); });
    await waitFor(() => expect(badges()).toEqual(['+', '+', '+']));
  });

  it('FR-053 EM-6401 offers Try again and Open Diagnostics; EM-1401 uses the catalogue action', async () => {
    await renderEditor('sample');
    await act(async () => { window.dispatchEvent(new CustomEvent('em:import-error', { detail: { code: 'EM-6401' } })); });
    expect(el('lib.assets.error.diagnostics')).not.toBeNull();
    await act(async () => { fireEvent.click(el('lib.assets.error.diagnostics')!); });
    await until(() => el('scr.diagnostics'), 'diagnostics');
    await act(async () => { window.dispatchEvent(new CustomEvent('em:import-error', { detail: { code: 'EM-1401' } })); });
    expect(el('lib.assets.error')!.textContent).toContain('A project can hold up to 200 assets');
    expect(el('lib.assets.error.action')!.textContent).toBe('OK');
  });

  it('FR-048 the Timeline inspector of an element whose file is missing offers Locate and Remove', async () => {
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    const list = runtime.api.listAssets.bind(runtime.api);
    vi.spyOn(runtime.api, 'listAssets').mockImplementation(async (...args) => { const p = await list(...args); return { ...p, items: p.items.map((x, i) => (i === 0 ? { ...x, missing: true } : x)) }; });
    const remove = vi.spyOn(runtime.api, 'deleteAsset');
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, nudgesDismissed: [] }}><App /></StoreProvider>);
    await until(() => el('stage.timeline.element.missing'), 'missing marker');
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.element"][data-missing="true"]')!); });
    await until(() => el('stage.timeline.inspector.missing'), 'inspector missing box');
    expect(el('stage.timeline.inspector.locate')).not.toBeNull();
    await act(async () => { fireEvent.click(el('stage.timeline.inspector.remove')!); });
    expect(remove).toHaveBeenCalled();
  });
});

describe('Insert, Home shortcuts, catalogue state (FR-049, FR-031, FR-039)', () => {
  it('FR-049 Insert sends the playhead (audio starts there) and the queue shows one "Insert N clips" item applied directly', async () => {
    const { runtime } = await renderEditor('sample');
    const ins = vi.spyOn(runtime.api, 'insertAssets');
    await act(async () => { fireEvent.click((els('lib.assets.card.select') as HTMLInputElement[])[0]!); });
    await act(async () => { fireEvent.click((els('lib.assets.card.select') as HTMLInputElement[])[1]!); });
    await act(async () => { fireEvent.click(el('lib.assets.insert')!); });
    expect(ins.mock.calls[0]![1]).toMatchObject({ playheadMs: 0 });
    await until(() => els('agent.editor.intentqueue.item').some((x) => /Insert 2 clips/.test(x.textContent ?? '') && /Applied directly|applied directly/i.test(x.textContent ?? '')), 'insert queue item');
  });

  it('FR-031 Home ▸ Ratio and Video Size pick directly through the Output intents', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.menu.home')!);
    await act(async () => { fireEvent.click(el('lib.text.ratio')!); });
    expect(el('lib.text.ratio.menu')).not.toBeNull();
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.text.ratio.option"][data-value="1:1"]')!); });
    await until(() => el('agent.output.ratio.1x1')?.getAttribute('aria-checked') === 'true', '1:1 active');
    await act(async () => { fireEvent.click(el('lib.text.videosize')!); });
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.text.videosize.option"][data-value="720p"]')!); });
    await until(() => el('agent.output.resolution.720p')?.getAttribute('aria-checked') === 'true', '720p active');
    expect(els('agent.editor.intentqueue.item').some((x) => /1:1/.test(x.textContent ?? ''))).toBe(true);
  });

  it('FR-039 a card is selected only for the current target', () => {
    const it = (id: string, presetId: string, targets: EditIntent['resolvedTargets'], extra: Partial<EditIntent> = {}): EditIntent => ({
      id, projectId: 'p', source: 'ui', createdAt: '', category: 'transition', presetId, params: {}, target: { kind: 'selection' }, resolvedTargets: targets, propertyKey: `cut:${targets[0]?.index ?? 0}.transition`,
      propertyClass: 'exclusive-group', needsInterpretation: false, status: 'executed', supersedes: [], baseVersion: '', ...extra,
    });
    const clips = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    const items = [it('f', 'preset:transition.fade', [{ kind: 'cut', index: 0 }]), it('s', 'preset:transition.slide', [{ kind: 'cut', index: 1 }]), it('x', 'preset:transition.wipe', [{ kind: 'cut', index: 1 }], { status: 'superseded' })];
    expect([...selectedPresetIds(items, [{ kind: 'cut', index: 0 }], clips)]).toEqual(['preset:transition.fade']);
    expect([...selectedPresetIds(items, [{ kind: 'clip', id: 'c2' }], clips)]).toEqual(['preset:transition.slide']);      // clip 2 → the cut after it
    expect([...selectedPresetIds(items, [], clips)].sort()).toEqual(['preset:transition.fade', 'preset:transition.slide']);   // default target: picks made without an element
    expect([...selectedPresetIds([it('e', 'preset:transition.fade', [{ kind: 'cut', index: 0 }], { target: { kind: 'cut', index: 0 } })], [], clips)]).toEqual([]);
  });
});

describe('Held picks and Save (FR-037, FR-012)', () => {
  it('FR-037 a pick that needs a missing model is held (EM-2104) and applies after the model is installed', async () => {
    sessionStorage.clear(); localStorage.clear();
    const runtime = createMockRuntime({ seed: 'sample', delays: false, modelFlagOf: (id) => (id === 'preset:transition.fade' ? 'model:whisper' : undefined) });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, nudgesDismissed: [] }}><App /></StoreProvider>);
    await until(() => document.querySelector('[data-el="lib.catalogue.tab"][data-category="transition"]'), 'catalogue');
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.catalogue.tab"][data-category="transition"]')!);
    await until(() => document.querySelector('[data-preset-id="preset:transition.fade"]'), 'fade card');
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-preset-id="preset:transition.fade"]')!); });
    await until(() => document.querySelector('[data-el="agent.editor.intentqueue.item"][data-status="held"]'), 'held queue item');
    expect(toasts().some((x) => x.includes('Needs a model'))).toBe(true);
    const pid = runtime.seededProjectId!;
    expect((await runtime.api.getComposition(pid)).head.model!.transitions).toHaveLength(0);
    await act(async () => { await runtime.api.installModel('whisper-small'); });
    await waitFor(async () => { if (!(await runtime.api.getComposition(pid)).head.model!.transitions.length) throw new Error('not applied'); });
    await until(() => !document.querySelector('[data-el="agent.editor.intentqueue.item"][data-status="held"]'), 'no longer held');
  });

  it('FR-012 the header Save is available without changes and stores the UI state, restored on open', async () => {
    const { runtime } = await renderEditor('sample');
    const patch = vi.spyOn(runtime.api, 'patchProject');
    expect(el('hdr.action.save')!.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(el('hdr.menu.home')!);
    await act(async () => { fireEvent.click(el('hdr.action.save')!); });
    await until(() => patch.mock.calls.length > 0, 'patch');
    expect(patch.mock.calls[0]![1]).toMatchObject({ uiState: { libMode: 'home', playheadMs: 0 } });
    const p = await runtime.api.getProject(runtime.seededProjectId!);
    expect(p.uiState).toMatchObject({ libMode: 'home' });
    // opening the project again restores Library mode, playhead and selection from that UI state
    const open = await runtime.api.openProject(p.id);
    const s = reducer({ ...initialState, libMode: 'design' }, { type: 'projectOpened', open: { ...open, project: { ...open.project, uiState: { libMode: 'tools', playheadMs: 2500, selection: [{ kind: 'clip', id: 'c9' }] } } }, assets: [] });
    expect([s.libMode, s.playheadMs, s.selection]).toEqual(['tools', 2500, [{ kind: 'clip', id: 'c9' }]]);
  });
});
