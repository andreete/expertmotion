// @vitest-environment jsdom
// Plan Card behaviour (UI_UX_SPECIFICATION.md §11.2, IX-14…IX-16): agent plan → Execute (button and Ctrl+Enter),
// stale plan after undo → Execute disabled with reason + Re-plan, Private Mode disables the composers, export progress chip.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderEditor, el, chatComposer, openProvidersFromChat } from './setup-dom.js';
import type { Runtime } from '../src/state/runtime.js';

afterEach(() => cleanup());

async function connect(runtime: Runtime) {
  await act(async () => {
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
    await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} } });
  });
  await openProvidersFromChat();
  await waitFor(() => { if (!el('scr.providers')?.textContent?.includes('OpenRouter')) throw new Error('providers'); });
  fireEvent.keyDown(el('scr.providers')!, { key: 'Escape' });
  await waitFor(() => { if (chatComposer('editor')?.hasAttribute('readonly')) throw new Error('composer disabled'); });
}
async function askPlan() {
  fireEvent.change(chatComposer('editor'), { target: { value: 'buat judul pembuka yang kuat' } });
  await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
  await waitFor(() => { if (el('agent.editor.plancard')?.getAttribute('data-status') !== 'valid') throw new Error(String(el('agent.editor.plancard')?.getAttribute('data-status'))); });
}

describe('Plan Card', () => {
  it('shows goal, steps, risks, notes and executes the plan', async () => {
    const { runtime } = await renderEditor('sample');
    expect(el('agent.editor.execute')).toBeNull();                                  // Execute lives on the inline Plan Card only (2026-10-26)
    await connect(runtime);
    await askPlan();
    const card = el('agent.editor.plancard')!;
    expect(within(card).getByText(/Proposed · nothing applied yet/)).toBeTruthy();
    expect(card.querySelector('[data-el="agent.editor.plancard.goal"]')?.textContent).toContain('buat judul pembuka yang kuat');
    expect(card.querySelectorAll('[data-el="agent.editor.plancard.step"]').length).toBeGreaterThan(0);
    expect(card.querySelector('[data-el="agent.editor.plancard.step.tool"]')?.textContent).toBe('composition.applyOps');
    expect(card.querySelector('[data-el="agent.editor.plancard.risk"]')).not.toBeNull();
    expect(card.querySelector('[data-el="agent.editor.plancard.notes"]')).not.toBeNull();
    expect(card.querySelector('[data-el="agent.editor.plancard.baseversion"]')).not.toBeNull();
    const exec = within(card).getByRole('button', { name: /Execute plan/ });
    expect(exec.getAttribute('aria-disabled')).toBeNull();
    const textsBefore = document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="text"]').length;
    await act(async () => { fireEvent.click(exec); });
    await waitFor(() => { if (el('agent.editor.plancard')?.getAttribute('data-status') !== 'executed') throw new Error('not executed'); });
    await waitFor(() => { if (document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="text"]').length !== textsBefore + 1) throw new Error('no text layer'); });
    expect(document.querySelector('[data-el="sys.toast"]')?.textContent).toMatch(/Applied: 1 change/);
    // 2026-10-26: the executed plan is a one-line summary with Undo right away
    expect(el('agent.editor.plancard')?.getAttribute('data-collapsed')).toBe('true');
    expect(el('agent.editor.plancard.result')?.textContent).toMatch(/1 added/);
    await act(async () => { fireEvent.click(el('agent.editor.plancard.undo')!); });
    await waitFor(() => { if (document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="text"]').length !== textsBefore) throw new Error('not undone'); });
    await waitFor(() => { if (el('agent.editor.plancard.undo')) throw new Error('undo still offered'); });   // the plan's version is no longer the head
  }, 20_000);

  it('executes with Ctrl+Enter', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    await askPlan();
    await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
    await waitFor(() => { if (el('agent.editor.plancard')?.getAttribute('data-status') !== 'executed') throw new Error('not executed'); });
  }, 20_000);

  it('turns stale when the composition changes: Execute disabled with reason, Re-plan offered', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    await askPlan();
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-preset-id="preset:transition.fade"]')!); });
    await waitFor(() => { if (el('agent.editor.plancard')?.getAttribute('data-status') !== 'stale') throw new Error(String(el('agent.editor.plancard')?.getAttribute('data-status'))); });
    expect(el('agent.editor.plancard.baseversion.stale')).not.toBeNull();
    expect(el('agent.editor.plancard.replan')).not.toBeNull();
    const exec = el('agent.editor.execute')!;
    expect(exec.getAttribute('aria-disabled')).toBe('true');
    expect(exec.getAttribute('title')).toBe('Composition changed; re-plan');
    await act(async () => { fireEvent.click(el('agent.editor.plancard.replan')!); });
    const last = () => [...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1);   // the new plan comes last in the thread
    await waitFor(() => { if (last()?.getAttribute('data-status') !== 'valid') throw new Error(`not re-planned ${last()?.getAttribute('data-status')} ${[...document.querySelectorAll('[data-el="sys.toast"]')].map((x) => x.textContent).join('|')}`); });
  }, 20_000);

  it('disables both composers in Private Mode and shows the banner', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    await act(async () => { fireEvent.click(el('agent.output.private')!); });
    await waitFor(() => { if (!el('sys.privatemode.banner')) throw new Error('no banner'); });
    expect(chatComposer('brainstorm')?.hasAttribute('readonly')).toBe(true);
    expect(el('agent.chat.send')?.getAttribute('aria-disabled')).toBe('true');
  }, 20_000);

  it('runs an export from preflight to done with Open folder', async () => {
    await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await waitFor(() => { if (el('scr.export.start')?.getAttribute('aria-disabled')) throw new Error('blocked'); });
    await act(async () => { fireEvent.click(el('scr.export.start')!); });
    await waitFor(() => { if (!el('scr.export.done')) throw new Error('not done'); });
    expect(el('scr.export.open.folder')).not.toBeNull();
  }, 20_000);
});
