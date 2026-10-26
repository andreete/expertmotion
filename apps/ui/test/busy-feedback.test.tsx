// @vitest-environment jsdom
// FR-186 in-place busy feedback: the Asset Panel says "Importing 2/5…" while a batch is prepared, a generator says what it
// makes and how far ("Making the voice… 45 %"), and the Open dialog marks the project being opened until it is loaded.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';
import { emptyBatch, nextImportBatch } from '../src/library/import-batch.js';

afterEach(() => cleanup());

describe('import batch (FR-186)', () => {
  it('counts the batch while anything is ingesting and resets when it is done', () => {
    let b = nextImportBatch(emptyBatch, [{ id: 'old', status: 'ready' }, { id: 'a', status: 'ingesting' }, { id: 'b', status: 'ingesting' }]);
    expect([b.done, b.total]).toEqual([0, 2]);
    b = nextImportBatch(b, [{ id: 'a', status: 'ready' }, { id: 'b', status: 'ingesting' }, { id: 'c', status: 'ingesting' }]);
    expect([b.done, b.total]).toEqual([1, 3]);
    b = nextImportBatch(b, [{ id: 'a', status: 'ready' }, { id: 'c', status: 'ingesting' }]);       // b removed: leaves the batch
    expect([b.done, b.total]).toEqual([1, 2]);
    expect(nextImportBatch(b, [{ id: 'a', status: 'ready' }, { id: 'c', status: 'failed' }])).toBe(emptyBatch);
  });
});

describe('busy feedback in the Editor (FR-186)', () => {
  it('a running generator names what it makes and its percent', async () => {
    const { runtime } = await renderEditor('sample');
    await runtime.api.installModel('piper-id-news');
    await waitFor(async () => { if ((await runtime.api.getModel('piper-id-news')).status !== 'installed') throw new Error('installing'); }, { timeout: 5000 });
    const orig = runtime.api.createGeneratorJob.bind(runtime.api);
    let running: Awaited<ReturnType<typeof orig>> | null = null;
    vi.spyOn(runtime.api, 'createGeneratorJob').mockImplementation(async (...a: Parameters<typeof orig>) => { running = { ...(await orig(...a)), status: 'running', progress: 0.45 }; return running; });
    vi.spyOn(runtime.api, 'getGeneratorJob').mockImplementation(async () => running!);
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.voice')!); });
    await waitFor(() => { if (!el('scr.generate.voice')) throw new Error('no sheet'); });
    fireEvent.change(el('scr.generate.voice.input')!, { target: { value: 'Selamat datang' } });
    await act(async () => { fireEvent.click(el('scr.generate.voice.run')!); });
    await waitFor(() => { if (el('scr.generate.voice.progress.status')?.textContent !== 'Making the voice… 45 %') throw new Error(el('scr.generate.voice.progress.status')?.textContent ?? 'none'); });
    expect(el('scr.generate.voice.progress')?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('45');
  });

  it('the Open dialog shows "Opening project…" on the chosen row until it is loaded', async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { await runtime.api.createProject({ name: 'Proyek Dua' }); });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = runtime.api.openProject.bind(runtime.api);
    vi.spyOn(runtime.api, 'openProject').mockImplementation(async (id: string) => { await gate; return orig(id); });
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.open')!);
    await waitFor(() => { if (!el('scr.project.open.list')?.textContent?.includes('Proyek Dua')) throw new Error('no list'); });
    const row = [...el('scr.project.open.list')!.querySelectorAll('li')].find((li) => li.textContent?.includes('Proyek Dua'))!;
    await act(async () => { fireEvent.click(row.querySelector('button')!); });
    expect(el('scr.project.open.opening')?.textContent).toBe('Opening project…');
    expect(el('scr.project.open')).not.toBeNull();
    await act(async () => { release(); });
    await waitFor(() => { if (el('scr.project.open')) throw new Error('dialog still open'); });
    await waitFor(() => { if (el('hdr.title')?.textContent?.includes('Proyek Dua') !== true) throw new Error(el('hdr.title')?.textContent ?? ''); });
  });
});
