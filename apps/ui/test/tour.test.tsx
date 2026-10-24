// @vitest-environment jsdom
// In-app tour (ONBOARDING_TOUR.md §3) in mock mode: R-025 sample project created and marked in the title, steps advance on
// their real trigger (TOUR-1 click on Design, TOUR-3 a pick), Next/Back, Esc asks before ending, re-run from Help.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';
import { advanced } from '../src/screens/Tour.js';

afterEach(() => cleanup());
const card = () => el('sys.tour');
const stepNo = () => card()?.getAttribute('data-step');
async function waitStep(n: number) { await waitFor(() => { if (stepNo() !== String(n)) throw new Error(`step ${stepNo()} phase ${card()?.getAttribute('data-phase')}`); }); }

describe('tour', () => {
  it('advanced(): numbers must grow, strings must change to a non-null value', () => {
    expect(advanced(0, 1)).toBe(true); expect(advanced(2, 1)).toBe(false); expect(advanced('a', 'b')).toBe(true); expect(advanced('a', null)).toBe(false); expect(advanced(null, null)).toBe(false);
  });

  it('creates the sample project (R-025), marks it in the title and advances on real actions', async () => {
    const { runtime } = await renderEditor('sample', { prefs: { onboardingLang: 'id' } });
    const spy = vi.spyOn(runtime.api, 'createSampleProject');
    await act(async () => { window.dispatchEvent(new CustomEvent('em:tour', { detail: { source: 'onboarding' } })); });
    await waitStep(1);
    expect(spy).toHaveBeenCalledWith({ language: 'id' });
    // sample is open, ready and visibly marked
    expect(el('hdr.title.sample')?.textContent).toBe('Contoh');
    expect(el('hdr.title')?.textContent).toBe('Contoh · Kafe Senja');
    await waitFor(() => { if (document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length !== 3) throw new Error('clips'); });
    expect(document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="caption"]').length).toBeGreaterThan(0);
    expect(card()!.textContent).toContain('Tiga tempat bekerja');                       // tour copy follows the onboarding language
    // TOUR-1 trigger: click Design
    fireEvent.click(el('hdr.menu.design')!);
    await waitStep(2);
    fireEvent.click(el('sys.tour.next')!);
    await waitStep(3);
    // TOUR-3 trigger: a pick that is applied directly
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-preset-id="preset:transition.fade"]')!); });
    await waitStep(4);
    // TOUR-4 trigger: a second transition supersedes the first
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-preset-id="preset:transition.slide"]')!); });
    await waitStep(5);
    fireEvent.click(el('sys.tour.back')!);
    await waitStep(4);
    fireEvent.click(el('sys.tour.next')!);
    await waitStep(5);
    // TOUR-5 trigger: select a timeline element
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.element"][data-kind="clip"]')!);
    await waitStep(6);
    fireEvent.click(el('sys.tour.next')!);
    await waitStep(7);
    // TOUR-7 without a provider shows the prepared sample plan
    expect(el('sys.tour.sampleplan')?.textContent).toContain("Kafe Senja");
    fireEvent.click(el('sys.tour.next')!);
    await waitStep(8);
    // TOUR-8 trigger: a ratio pick
    await act(async () => { fireEvent.click(el('agent.output.ratio.1x1')!); });
    await waitStep(9);
    fireEvent.click(el('sys.tour.next')!);
    await waitStep(10);
    // TOUR-10 trigger: opening Export ends with the closing card beside the dialog
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await waitFor(() => { if (card()?.getAttribute('data-phase') !== 'done') throw new Error('not done'); });
    expect(el('scr.export')).not.toBeNull();
    fireEvent.click(el('sys.tour.done.keep')!);
    expect(card()).toBeNull();
    expect(JSON.parse(localStorage.getItem('expertmotion.prefs.v1')!).tourDone).toBe(true);
  }, 30_000);

  it('Esc asks before ending, End tour skips; Help re-runs it (choice on a project with clips, direct on the sample)', async () => {
    const { runtime } = await renderEditor('sample');
    const spy = vi.spyOn(runtime.api, 'createSampleProject');
    // Help ▸ Tour on an ordinary project with clips → choice
    fireEvent.click(el('hdr.menu.help')!);
    await act(async () => { fireEvent.click(el('hdr.menu.help.tour')!); });
    await waitFor(() => { if (!el('sys.tour.choice.current')) throw new Error('no choice'); });
    fireEvent.click(el('sys.tour.choice.current')!);
    await waitStep(1);
    expect(spy).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(card()!.textContent).toContain('End the tour? You can re-run it from Help.');
    fireEvent.click(el('sys.tour.end')!);
    expect(card()).toBeNull();
    // re-run, this time on the sample
    fireEvent.click(el('hdr.menu.help')!);
    await act(async () => { fireEvent.click(el('hdr.menu.help.tour')!); });
    await waitFor(() => { if (!el('sys.tour.choice.sample')) throw new Error('no choice'); });
    await act(async () => { fireEvent.click(el('sys.tour.choice.sample')!); });
    await waitStep(1);
    expect(spy).toHaveBeenCalledWith({ language: 'en' });
    expect(el('hdr.title')?.textContent).toBe('Sample · Kafe Senja');
    fireEvent.click(el('sys.tour.end')!);                                               // skip
    expect(card()).toBeNull();
    // on the sample itself Help starts directly, and R-025 is not called again
    fireEvent.click(el('hdr.menu.help')!);
    await act(async () => { fireEvent.click(el('hdr.menu.help.tour')!); });
    await waitStep(1);
    expect(spy).toHaveBeenCalledTimes(1);
    // a second R-025 call returns the existing sample (200)
    const again = await runtime.api.createSampleProject({ language: 'en' });
    expect(again.isSample).toBe(true);
    expect(again.name).toBe('Sample · Kafe Senja');
  }, 30_000);
});
