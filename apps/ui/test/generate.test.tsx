// @vitest-environment jsdom
// Generator Insert is deterministic (no Editor Agent plan): R-134 applies a finished job's proposed ops without re-running it.
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
  it('voice: inserts the finished result with R-134, never asks the Editor Agent', async () => {
    const { runtime } = await renderEditor('sample');
    await install(runtime, 'piper-id-news');
    const plan = vi.spyOn(runtime.api, 'createPlan'), ins = vi.spyOn(runtime.api, 'insertGeneratorResult');
    await act(async () => { fireEvent.click(el('hdr.menu.design')!); fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.voice')!); });
    await waitFor(() => { if (!el('scr.generate.voice')) throw new Error('no sheet'); });
    fireEvent.change(el('scr.generate.voice.input')!, { target: { value: 'Selamat datang di Kafe Senja' } });
    await act(async () => { fireEvent.click(el('scr.generate.voice.run')!); });
    await waitFor(() => { if (!el('scr.generate.voice.insert')) throw new Error('not done'); }, { timeout: 5000 });
    await act(async () => { fireEvent.click(el('scr.generate.voice.insert')!); });
    expect(plan).not.toHaveBeenCalled();
    expect(ins).toHaveBeenCalledTimes(1);
    await waitFor(() => { if (!document.querySelector('[data-el="stage.timeline.element"][data-kind="audio"]')) throw new Error('no audio'); });
  });

  it('captions: inserts the finished pages with R-134 without transcribing again', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    await install(runtime, 'whisper-small');
    const gen = vi.spyOn(runtime.api, 'createGeneratorJob'), plan = vi.spyOn(runtime.api, 'createPlan'), ins = vi.spyOn(runtime.api, 'insertGeneratorResult');
    await act(async () => { fireEvent.click(el('lib.generator.card.captions')!); });
    await act(async () => { fireEvent.click(el('scr.generate.captions.run')!); });
    await waitFor(() => { if (!el('scr.generate.captions.insert')) throw new Error(`not done: ${el('scr.generate.captions')?.textContent}`); }, { timeout: 5000 });
    await act(async () => { fireEvent.click(el('scr.generate.captions.insert')!); });
    await waitFor(() => { if (el('scr.generate.captions')) throw new Error(`sheet still open: ${el('scr.generate.captions')?.textContent}`); }, { timeout: 5000 });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0]![2]).toMatchObject({ source: 'sequence' });            // FR-104: the Sequence audio by default
    expect(ins).toHaveBeenCalledTimes(1);
    expect(plan).not.toHaveBeenCalled();
    await waitFor(async () => { const c = await runtime.api.getComposition(runtime.seededProjectId!); if (!c.head.model?.tracks.caption.pages.some((p) => p.text.includes('Kafe Senja'))) throw new Error('no pages'); });
    const c = await runtime.api.getComposition(runtime.seededProjectId!);
    expect(c.head.model?.tracks.caption.styleId).toBeTruthy();                       // FR-104: a caption style is set on Insert
  });

  it('FR-104 asset source, FR-105 tone and FR-106 id/en toggle are sent with the job', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true }); });
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    const gen = vi.spyOn(runtime.api, 'createGeneratorJob');
    await act(async () => { fireEvent.click(el('lib.generator.card.hashtags')!); });
    await waitFor(() => { if (!el('scr.generate.hashtags')) throw new Error('no sheet'); });
    const radios = () => [...el('scr.generate.hashtags.language')!.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios().map((r) => r.textContent)).toEqual(['Indonesia', 'English']);
    const lang = (await runtime.api.getComposition(runtime.seededProjectId!)).head.model?.settings.language ?? 'id';
    expect(radios().find((r) => r.getAttribute('aria-checked') === 'true')?.getAttribute('data-value')).toBe(lang);
    fireEvent.click(radios()[1]!);
    fireEvent.change(el('scr.generate.hashtags.tone')!, { target: { value: 'energetic' } });
    await act(async () => { fireEvent.click(el('scr.generate.hashtags.run')!); });
    await waitFor(() => { if (!gen.mock.calls.length) throw new Error('not sent'); });
    expect(gen.mock.calls[0]![2]).toMatchObject({ language: 'en', tone: 'energetic', platform: 'tiktok' });
    cleanup();
    const second = await renderEditor('sample');
    const file = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { fireEvent.change(file, { target: { files: [new File(['x'.repeat(2000)], 'wawancara.mp3', { type: 'audio/mpeg' })] } }); });
    await waitFor(() => { if (!document.querySelector('[data-el="lib.assets.card"][data-kind="audio"], [data-el="lib.assets.card"]')) throw new Error('no asset'); });
    await new Promise((r) => setTimeout(r, 1500));
    await install(second.runtime, 'whisper-small');
    await act(async () => { fireEvent.click(el('lib.generator.card.captions')!); });
    await waitFor(() => { if (!el('scr.generate.captions.source')) throw new Error('no source'); });
    const src = el('scr.generate.captions.source') as HTMLSelectElement;
    expect(src.value).toBe('sequence');
    expect(src.options.length).toBeGreaterThan(1);                                    // assets with audio are offered too
    const g2 = vi.spyOn(second.runtime.api, 'createGeneratorJob');
    fireEvent.change(src, { target: { value: src.options[1]!.value } });
    await act(async () => { fireEvent.click(el('scr.generate.captions.run')!); });
    await waitFor(() => { if (!g2.mock.calls.length) throw new Error('not sent'); });
    expect(g2.mock.calls[0]![2]).toMatchObject({ source: 'asset', assetId: src.options[1]!.value });
  });

  it('QA 14: the thumbnail picker shows and selects "Thumbnail from a Frame" when no image model is installed; a not-installed model blocks Generate', { timeout: 20_000 }, async () => {
    await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.thumbnail')!); });
    await waitFor(() => { if (!el('scr.generate.thumbnail')) throw new Error('no sheet'); });
    const pick = await waitFor(() => { const s = document.getElementById('em-gen-model') as HTMLSelectElement | null; if (!s || s.value !== 'frame-composite') throw new Error(`picker ${s?.value}`); return s; });
    expect(pick.selectedOptions[0]!.textContent).toBe('Thumbnail from a Frame');
    expect(el('scr.generate.thumbnail.prompt')).toBeNull();                           // no diffusion prompt for a frame still
    cleanup();
    await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.voice')!); });
    await waitFor(() => { if (!el('scr.generate.voice')) throw new Error('no sheet'); });
    fireEvent.change(el('scr.generate.voice.input')!, { target: { value: 'Halo' } });
    const run = el('scr.generate.voice.run')!;
    expect(run.getAttribute('aria-disabled')).toBe('true');
    expect(run.getAttribute('title')).toBe('Install the model first');
  });
});
