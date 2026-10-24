// @vitest-environment jsdom
// Generator Insert is deterministic (no Editor Agent plan): a generated Asset goes in with R-035; captions re-run R-130 with insert:true.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';

afterEach(() => cleanup());
async function install(runtime: Awaited<ReturnType<typeof renderEditor>>['runtime'], key: string) {
  await runtime.api.installModel(key);
  await waitFor(async () => { if ((await runtime.api.getModel(key)).status !== 'installed') throw new Error('installing'); }, { timeout: 5000 });
  await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
}

describe('generator Insert', () => {
  it('voice: inserts the generated asset with R-035, never asks the Editor Agent', async () => {
    const { runtime } = await renderEditor('sample');
    await install(runtime, 'piper-id-news');
    const plan = vi.spyOn(runtime.api, 'createPlan'), ins = vi.spyOn(runtime.api, 'insertAssets');
    await act(async () => { fireEvent.click(el('hdr.menu.design')!); fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.voice')!); });
    await waitFor(() => { if (!el('scr.generate.voice')) throw new Error('no sheet'); });
    fireEvent.change(el('scr.generate.voice.input')!, { target: { value: 'Selamat datang di Kafe Senja' } });
    await act(async () => { fireEvent.click(el('scr.generate.voice.run')!); });
    await waitFor(() => { if (!el('scr.generate.voice.insert')) throw new Error('not done'); }, { timeout: 5000 });
    await act(async () => { fireEvent.click(el('scr.generate.voice.insert')!); });
    expect(plan).not.toHaveBeenCalled();
    expect(ins).toHaveBeenCalledTimes(1);
    expect(ins.mock.calls[0]![1].assetIds).toHaveLength(1);
    await waitFor(() => { if (!document.querySelector('[data-el="stage.timeline.element"][data-kind="audio"]')) throw new Error('no audio'); });
  });

  it('captions: re-runs R-130 with insert:true and applies the pages', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    await install(runtime, 'whisper-small');
    const gen = vi.spyOn(runtime.api, 'createGeneratorJob'), plan = vi.spyOn(runtime.api, 'createPlan');
    await act(async () => { fireEvent.click(el('lib.generator.card.captions')!); });
    await act(async () => { fireEvent.click(el('scr.generate.captions.run')!); });
    await waitFor(() => { if (!el('scr.generate.captions.insert')) throw new Error(`not done: ${el('scr.generate.captions')?.textContent}`); }, { timeout: 5000 });
    await act(async () => { fireEvent.click(el('scr.generate.captions.insert')!); });
    await waitFor(() => { if (el('scr.generate.captions')) throw new Error(`sheet still open: ${el('scr.generate.captions')?.textContent}`); }, { timeout: 5000 });
    expect(gen).toHaveBeenCalledTimes(2);
    expect(gen.mock.calls[1]![2]).toMatchObject({ insert: true });
    expect(plan).not.toHaveBeenCalled();
    await waitFor(async () => { const c = await runtime.api.getComposition(runtime.seededProjectId!); if (!c.head.model?.tracks.caption.pages.some((p) => p.text.includes('Kafe Senja'))) throw new Error('no pages'); });
  });
});
