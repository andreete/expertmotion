// @vitest-environment jsdom
// Windows QA 2026-10-30 (Entry 37 follow-up): (1) the Player time carried over between projects and could sit beyond the duration;
// (2) a generated voice running past the last clip leaves a background-only end — an info toast names the gap and offers the Editor;
// (3) the Export folder field was empty with no placeholder while the hint spoke of "the folder shown".
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createEmptyModel, type CompositionModelT } from '@expertmotion/composition-model';
import { el, els } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider, useStore, type Store } from '../src/state/store.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { playerBus } from '../src/stage/playerBus.js';
import { voiceGap } from '../src/screens/Generate.js';
import { exportFolderDefault } from '../src/screens/Export.js';
import { translate } from '../src/i18n/index.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as { expertmotion?: unknown }).expertmotion; });
const until = (fn: () => unknown, msg = 'condition', timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${msg}`); }, { timeout });
/** Player time `mm:ss.d` → ms. */
const timeMs = () => { const m = /(\d+):(\d+)\.(\d+)/.exec(el('stage.player.controls.time')!.textContent ?? '')!; return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]) * 100; };
const toasts = () => els('sys.toast').map((x) => x.textContent ?? '').join(' | ');

async function editorWithStore(seed: 'sample' | 'empty' = 'sample') {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  const runtime = createMockRuntime({ seed, delays: false });
  let store: Store | null = null;
  const Probe = () => { const s = useStore(); useEffect(() => { store = s; }); return null; };
  render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, outputCollapsed: false }}><App /><Probe /></StoreProvider>);
  await until(() => document.querySelector('[data-el="stage.timeline"]') && el('hdr.title')?.textContent?.trim(), 'booted');
  return { runtime, store: () => store! };
}

describe('1. the Player and the Timeline playhead follow the project', () => {
  it('New Project resets the Player time to 0 (it kept 00:03.4); the playhead never sits beyond the duration', async () => {
    const { store } = await editorWithStore('sample');
    await until(() => (store().state.head?.model?.tracks.video.length ?? 0) > 0 && playerBus.get() && playerBus.get()!.durationMs() > 4000, 'sample player ready');
    const sampleId = store().state.project!.id;
    await act(async () => { playerBus.get()!.seekMs(3400); });
    expect(timeMs()).toBe(3400);
    expect(store().state.playheadMs).toBe(3400);

    await act(async () => { await store().actions.newProject(); });
    await until(() => store().state.project?.id !== sampleId && store().state.head?.model, 'new project open');
    expect(store().state.playheadMs).toBe(0);
    await until(() => timeMs() === 0, 'Player time reset');
    const head = el('stage.timeline.head');
    if (head) expect(Number(head.getAttribute('aria-valuenow'))).toBe(0);

    // Back to the sample (never saved → no stored playhead): 0 in the store, the Player and the Timeline.
    await act(async () => { await store().actions.openProject(sampleId); });
    await until(() => store().state.project?.id === sampleId && playerBus.get() && playerBus.get()!.durationMs() > 4000, 'sample reopened');
    await until(() => timeMs() === 0, 'Player time follows the store');
    expect(Number(el('stage.timeline.head')!.getAttribute('aria-valuenow'))).toBe(store().state.playheadMs);

    // A settled playhead past the end (e.g. the duration shrank) is clamped to the last frame in the store and the Player.
    const dur = playerBus.get()!.durationMs();
    await act(async () => { store().actions.seek(dur + 5000); });
    await until(() => store().state.playheadMs < dur, 'store clamped');
    expect(Math.abs(timeMs() - store().state.playheadMs)).toBeLessThan(100);
    expect(Number(el('stage.timeline.head')!.getAttribute('aria-valuenow'))).toBe(store().state.playheadMs);
  }, 30_000);
});

/** One 4 s clip and a voice layer that ends at 11.2 s (the QA case). */
function fourSecondsAndVoice(base: CompositionModelT, voiceMs = 11_200): CompositionModelT {
  const m = structuredClone(base);
  m.tracks.video = [{ ...m.tracks.video[0]!, durationMs: 4000 }];
  m.transitions = [];
  const voice = m.tracks.audio.find((a) => a.role === 'voice');
  if (voice) { voice.atMs = 0; voice.durationMs = voiceMs; delete (voice as { loop?: boolean }).loop; }
  return m;
}

describe('2. a voice longer than the video', () => {
  it('voiceGap names the voice end, the video end and the gap; nothing without clips or under half a second', () => {
    const empty = createEmptyModel('p1');
    expect(voiceGap(empty)).toBeNull();
    const m = structuredClone(empty);
    m.tracks.video = [{ id: 'c1', assetId: 'a1', durationMs: 4000, trimBeforeMs: 0 } as CompositionModelT['tracks']['video'][number]];
    m.tracks.audio = [{ id: 'v1', assetId: 'a2', role: 'voice', atMs: 0, durationMs: 11_200 } as CompositionModelT['tracks']['audio'][number]];
    expect(voiceGap(m)).toEqual({ voiceS: 11, videoS: 4, gapS: 7 });
    m.tracks.audio[0]!.durationMs = 4300;
    expect(voiceGap(m)).toBeNull();
    expect(translate('id', 'ui.scr.generate.voicegap', { voiceS: 11, videoS: 4, gapS: 7 })).toBe('Suara 11 dtk, video 4 dtk — 7 dtk terakhir hanya latar + caption. Tambah klip, atau minta Editor mengisinya.');
    expect(translate('en', 'ui.scr.generate.voicegap', { voiceS: 11, videoS: 4, gapS: 7 })).toMatch(/^Voice 11 s, video 4 s — the last 7 s are only background \+ captions/);
  });

  it('Generate ▸ Insert into video shows the info toast with an "Ask the Editor" action that opens the Editor chat', async () => {
    const { runtime } = await editorWithStore('sample');
    await runtime.api.installModel('piper-id-news');
    await until(async () => (await runtime.api.getModel('piper-id-news')).status === 'installed', 'voice model');
    const real = runtime.api.getComposition.bind(runtime.api);
    vi.spyOn(runtime.api, 'getComposition').mockImplementation(async (id, model) => {
      const c = await real(id, model);
      return c.head.model && c.head.model.tracks.audio.some((a) => a.role === 'voice') ? { ...c, head: { ...c.head, model: fourSecondsAndVoice(c.head.model) } } : c;
    });
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.voice')!); });
    await until(() => el('scr.generate.voice'), 'voice sheet');
    fireEvent.change(el('scr.generate.voice.input')!, { target: { value: 'Selamat datang di Kafe Senja' } });
    await act(async () => { fireEvent.click(el('scr.generate.voice.run')!); });
    await until(() => el('scr.generate.voice.insert'), 'voice done', 5000);
    await act(async () => { fireEvent.click(el('scr.generate.voice.insert')!); });
    await until(() => /Voice 11 s, video 4 s — the last 7 s/.test(toasts()), `gap toast (${toasts()})`);
    const toast = els('sys.toast').find((x) => /the last 7 s/.test(x.textContent ?? ''))!;
    expect(toast.getAttribute('data-kind')).toBe('info');
    const focus = vi.fn();
    window.addEventListener('em:focus-composer', focus as EventListener);
    const action = toast.querySelector<HTMLElement>('[data-el="sys.toast.action"]')!;
    expect(action.textContent).toBe('Ask the Editor');
    await act(async () => { fireEvent.click(action); });
    window.removeEventListener('em:focus-composer', focus as EventListener);
    expect(focus).toHaveBeenCalledTimes(1);
    expect((focus.mock.calls[0]![0] as CustomEvent).detail).toEqual({ agent: 'editor' });
  }, 30_000);
});

describe('3. the Export folder field shows where an empty field saves', () => {
  it('exportFolderDefault: project folder > app setting > Shell default; nothing known → no placeholder', () => {
    expect(exportFolderDefault({ projectFolder: 'D:\\Klien\\Senja', settingsFolder: 'C:\\Users\\U\\Videos\\Expertmotion', shell: true })).toEqual({ placeholder: 'D:\\Klien\\Senja', shellDefault: false });
    expect(exportFolderDefault({ projectFolder: null, settingsFolder: 'C:\\Users\\U\\Videos\\Expertmotion', shell: false })).toEqual({ placeholder: 'C:\\Users\\U\\Videos\\Expertmotion', shellDefault: false });
    expect(exportFolderDefault({ projectFolder: null, settingsFolder: '', shell: true })).toEqual({ placeholder: null, shellDefault: true });
    expect(exportFolderDefault({ projectFolder: null, settingsFolder: undefined, shell: false })).toEqual({ placeholder: null, shellDefault: false });
    expect(translate('id', 'ui.scr.export.folder.default.unknown')).not.toMatch(/yang tampil/);
  });

  const openExport = async () => {
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await until(() => el('scr.export.folder'), 'export dialog');
  };

  it('the app setting folder is the placeholder (the field stays empty, so the project folder is never overridden)', async () => {
    await editorWithStore('sample');
    await openExport();
    const input = el('scr.export.folder') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('C:\\Users\\User\\Videos\\Expertmotion');
    expect(document.body.textContent).toContain('Leave empty to save in the folder shown');
  });

  it("the project's own folder (R-017) wins as the placeholder", async () => {
    const { runtime } = await editorWithStore('sample');
    const real = runtime.api.getProjectSettings.bind(runtime.api);
    vi.spyOn(runtime.api, 'getProjectSettings').mockImplementation(async (id) => ({ ...(await real(id)), outputFolder: 'C:\\Users\\User\\Klien\\Senja' }) as Awaited<ReturnType<typeof real>>);
    await openExport();
    await until(() => (el('scr.export.folder') as HTMLInputElement).placeholder === 'C:\\Users\\User\\Klien\\Senja', 'project folder placeholder');
  });

  it('no folder known: the Shell default label under the desktop app, else no placeholder and a hint without "the folder shown"', async () => {
    const { store } = await editorWithStore('sample');
    await act(async () => { store().dispatch({ type: 'settings', settings: { ...store().state.settings!, outputFolder: '' } }); });
    await until(() => !store().state.settings?.outputFolder, 'setting cleared');
    await openExport();
    const input = el('scr.export.folder') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('');
    expect(document.body.textContent).toContain("Leave empty to save in the project's default export folder");
    expect(document.body.textContent).not.toContain('folder shown');
    cleanup();

    (window as { expertmotion?: unknown }).expertmotion = { pickFolder: async () => null };
    const again = await editorWithStore('sample');
    await act(async () => { again.store().dispatch({ type: 'settings', settings: { ...again.store().state.settings!, outputFolder: '' } }); });
    await until(() => !again.store().state.settings?.outputFolder, 'setting cleared');
    await openExport();
    expect((el('scr.export.folder') as HTMLInputElement).placeholder).toBe('Videos\\Expertmotion (default)');
  }, 20_000);
});
