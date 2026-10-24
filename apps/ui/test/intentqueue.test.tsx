// @vitest-environment jsdom
// Intent Queue behaviour (UI_UX_SPECIFICATION.md §11.3, IX-02, IX-17): parent/child expansion, supersede + Restore,
// Remove, Clear with confirmation. Picks go through the mock Local Service, which applies real Operations.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderEditor, el, els } from './setup-dom.js';

afterEach(() => cleanup());
const card = (id: string) => document.querySelector<HTMLElement>(`[data-preset-id="${id}"]`)!;
const items = () => els('agent.editor.intentqueue.item');
const superseded = () => els('agent.editor.intentqueue.item.superseded');

async function pick(id: string) {
  await act(async () => { fireEvent.click(card(id)); });
}

describe('Intent Queue', () => {
  it('shows a multi-target pick as one parent item "Fade → all 2 cuts", applied directly', async () => {
    await renderEditor('sample');
    await pick('preset:transition.fade');
    await waitFor(() => { if (!items().some((i) => i.textContent?.includes('Transition · Fade → all 2 cuts'))) throw new Error(items().map((i) => i.textContent).join('|')); });
    const item = items().find((i) => i.textContent?.includes('Fade'))!;
    expect(item.getAttribute('data-status')).toBe('executed');
    expect(item.textContent).toContain('applied directly');
    expect(card('preset:transition.fade').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="transition"]')).toHaveLength(2);
  });

  it('strikes through a superseded pick with an always-visible Restore, and Restore brings it back', async () => {
    await renderEditor('sample');
    await pick('preset:transition.fade');
    await waitFor(() => { if (!items().length) throw new Error('none'); });
    await pick('preset:transition.slide');
    await waitFor(() => { if (!superseded().length) throw new Error('not superseded'); });
    const old = superseded()[0]!;
    expect(old.textContent).toContain('Fade');
    expect(old.textContent).toContain('replaced by Slide');
    expect(old.querySelector('button')!.className).toContain('line-through');
    expect(old.getAttribute('aria-label')).toMatch(/replaced by Slide; Restore available/);
    const restore = within(old).getByText('Restore');
    expect(restore.closest('[data-el="agent.editor.intentqueue.item.restore"]')).not.toBeNull();
    await act(async () => { fireEvent.click(restore); });
    await waitFor(() => {
      const s = superseded();
      if (!s.length || !s[0]!.textContent?.includes('Slide')) throw new Error(s.map((x) => x.textContent).join('|'));
    });
    expect(items().find((i) => i.textContent?.includes('Fade'))?.getAttribute('data-status')).toBe('executed');
  });

  it('supersedes only the child when a later pick targets one cut', async () => {
    await renderEditor('sample');
    await pick('preset:transition.fade');
    await waitFor(() => { if (!items().length) throw new Error('none'); });
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.element"][data-element-id="cut:1"]')!);
    await pick('preset:transition.wipe');
    await waitFor(() => { if (!superseded().length) throw new Error('child not superseded'); });
    const parent = items().find((i) => i.textContent?.includes('Fade → all 2 cuts'));
    expect(parent).toBeDefined();
    expect(superseded()[0]!.textContent).toContain('cut 2');
    expect(superseded()[0]!.textContent).toContain('replaced by Wipe');
  });

  it('rejects a motion pick without a target clip only when no clip exists, and Remove takes it out', async () => {
    await renderEditor('empty');
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.catalogue.tab"][data-category="motion"]')!);
    await pick('preset:motion.pop');
    await waitFor(() => { if (!items().some((i) => i.getAttribute('data-status') === 'rejected')) throw new Error('not rejected'); });
    const rejected = items().find((i) => i.getAttribute('data-status') === 'rejected')!;
    expect(rejected.textContent).toContain('EM-2202');
    await act(async () => { fireEvent.click(within(rejected).getByRole('button', { name: /^Remove/ })); });
    await waitFor(() => { if (items().length) throw new Error('still there'); });
  });

  it('clears queued picks after a confirmation that names the count', async () => {
    await renderEditor('sample');
    await pick('preset:transition.fade');
    await pick('preset:transition.slide');
    await waitFor(() => { if (!superseded().length) throw new Error('none'); });
    await act(async () => { fireEvent.click(el('agent.editor.intentqueue.clear')!); });
    const dialog = el('scr.confirm')!;
    expect(dialog.textContent).toContain('Clear 1 queued picks?');
    await act(async () => { fireEvent.click(within(dialog).getAllByRole('button', { name: 'Clear' }).at(-1)!); });
    await waitFor(() => { if (superseded().length) throw new Error('not cleared'); });
    expect(items().some((i) => i.textContent?.includes('Slide'))).toBe(true);   // applied changes stay
  });
});

describe('Intent Queue grouping', () => {
  it('collapses executed items of an older version under "Applied in v… (n)", expandable', async () => {
    await renderEditor('sample');
    await pick('preset:transition.fade');
    await waitFor(() => { if (!items().some((i) => i.getAttribute('data-status') === 'executed')) throw new Error('none'); });
    expect(el('agent.editor.intentqueue.group')).toBeNull();                     // the newest version stays expanded
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.catalogue.tab"][data-category="background"]')!);
    const bg = document.querySelector<HTMLElement>('[data-el="lib.catalogue.card"][data-preset-id^="preset:background."]')!;
    await act(async () => { fireEvent.click(bg); });
    await waitFor(() => { if (!el('agent.editor.intentqueue.group')) throw new Error('no group'); });
    const group = el('agent.editor.intentqueue.group')!;
    expect(group.textContent).toMatch(/Applied in v\d+ \(1\)/);
    expect(group.getAttribute('aria-expanded')).toBe('false');
    const fade = items().find((i) => i.textContent?.includes('Fade'))!;
    expect(fade.closest('ul[hidden]')).not.toBeNull();                              // collapsed by default
    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(fade.closest('ul[hidden]')).toBeNull();
    expect(items().find((i) => i.textContent?.includes('Fade'))?.closest('ul[hidden]')).toBeNull();
  });
});
