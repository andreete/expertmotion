// @vitest-environment jsdom
// Catalogue Card ⓘ Details (CMP-04, UI_UX_SPECIFICATION.md §11.1): parameters with defaults, edit before the pick, the pick
// carries `params` (R-060), focus trap, Esc closes and returns focus to ⓘ.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el, els } from './setup-dom.js';
import { getPreset } from '@expertmotion/catalogue';
import { presetFields } from '../src/library/PresetParams.js';

afterEach(() => cleanup());
const info = (presetId: string) => document.querySelector<HTMLElement>(`[data-preset-id="${presetId}"]`)!.parentElement!.querySelector<HTMLElement>('[data-el="lib.catalogue.card.details"]')!;
const field = (name: string) => document.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-el="lib.catalogue.params.field"][data-param="${name}"]`)!;

describe('preset parameter popover', () => {
  it('derives fields from the catalogue schema', () => {
    const f = presetFields(getPreset('preset:transition.slide')!);
    expect(f.map((x) => [x.name, x.kind])).toEqual([['durationMs', 'integer'], ['timing', 'enum'], ['easingId', 'preset'], ['direction', 'enum']]);
  });

  it('shows defaults, sends the edited params with the pick, and applies them', async () => {
    const { runtime } = await renderEditor('sample');
    const spy = vi.spyOn(runtime.api, 'createIntent');
    fireEvent.click(info('preset:transition.slide'));
    const pop = el('lib.catalogue.params')!;
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(field('durationMs').value).toBe('500');
    expect(field('direction').value).toBe('from-right');
    expect(document.activeElement).toBe(field('durationMs'));
    fireEvent.change(field('durationMs'), { target: { value: '900' } });
    fireEvent.change(field('direction'), { target: { value: 'from-left' } });
    await act(async () => { fireEvent.click(el('lib.catalogue.params.apply')!); });
    expect(el('lib.catalogue.params')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toMatchObject({ presetId: 'preset:transition.slide', params: { durationMs: 900, direction: 'from-left', timing: 'linear' } });
    await waitFor(() => { if (!els('agent.editor.intentqueue.item').some((i) => i.textContent?.includes('Slide'))) throw new Error('no item'); });
    await waitFor(() => { if (document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="transition"]').length !== 2) throw new Error('no transitions'); });
    const head = await runtime.api.getComposition(runtime.seededProjectId!);
    expect(head.head.model?.transitions[0]).toMatchObject({ presetId: 'preset:transition.slide', durationMs: 900, params: { direction: 'from-left' } });
  });

  it('rejects out-of-range values inline and does not pick', async () => {
    const { runtime } = await renderEditor('sample');
    const spy = vi.spyOn(runtime.api, 'createIntent');
    fireEvent.click(info('preset:transition.fade'));
    fireEvent.change(field('durationMs'), { target: { value: '50' } });
    fireEvent.click(el('lib.catalogue.params.apply')!);
    expect(spy).not.toHaveBeenCalled();
    expect(field('durationMs').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(el('lib.catalogue.params.reset')!);
    expect(field('durationMs').value).toBe('500');
  });

  it('traps focus, closes on Escape and returns focus to ⓘ; Space on a card opens it', async () => {
    await renderEditor('sample');
    const btn = info('preset:transition.fade');
    btn.focus();
    fireEvent.click(btn);
    const pop = el('lib.catalogue.params')!;
    const focusables = [...pop.querySelectorAll<HTMLElement>('button, input, select')];
    focusables.at(-1)!.focus();
    fireEvent.keyDown(focusables.at(-1)!, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(focusables[0]!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusables.at(-1));
    fireEvent.keyDown(pop, { key: 'Escape' });
    expect(el('lib.catalogue.params')).toBeNull();
    expect(document.activeElement).toBe(btn);
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-preset-id="preset:transition.wipe"]')!, { key: ' ' });
    expect(el('lib.catalogue.params')?.getAttribute('aria-label')).toBe('Wipe · Details');
  });
});
