// @vitest-environment jsdom
// Panel resize (FR-099, FR-155; EDITOR_INTERACTION_MODEL.md §9): keyboard-accessible separators, min sizes, persistence in
// prefs (expertmotion.prefs.v1), double-click reset, Ctrl+B collapse still working.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';
import { bucketFor, resolveColumns } from '../src/layout.js';

afterEach(() => cleanup());
const now = (id: string) => Number(el(id)!.getAttribute('aria-valuenow'));
const stored = () => JSON.parse(localStorage.getItem('expertmotion.prefs.v1') ?? '{}') as { panelSizes?: Record<string, Record<string, number>> };

describe('layout rules', () => {
  it('keeps the Stage at least 560 px and every column in range at 1280×720', () => {
    const c = resolveColumns({ width: 1280, lib: 420, agent: 520, libOpen: true, agentOpen: true });
    expect(c.agent).toBeGreaterThanOrEqual(320);
    expect(1280 - c.lib - c.agent - 18).toBeGreaterThanOrEqual(540);
    expect(resolveColumns({ width: 1440, lib: 100, agent: 100, libOpen: true, agentOpen: true })).toMatchObject({ lib: 240, agent: 320 });
    expect(bucketFor(1279)).toBe('narrow'); expect(bucketFor(1440)).toBe('standard'); expect(bucketFor(1600)).toBe('wide');
  });
});

describe('panel dividers', () => {
  it('resize with the keyboard, clamp to the minimums, persist, and reset on double-click', async () => {
    await renderEditor('sample');
    const lib = el('lib.divider')!, agent = el('agent.divider')!, tl = el('stage.divider')!;
    for (const d of [lib, agent, tl]) { expect(d.getAttribute('role')).toBe('separator'); expect(d.tabIndex).toBe(0); }
    expect(lib.getAttribute('aria-orientation')).toBe('vertical');
    expect(tl.getAttribute('aria-orientation')).toBe('horizontal');
    expect(now('lib.divider')).toBe(300); expect(now('agent.divider')).toBe(360); expect(now('stage.divider')).toBe(240);
    fireEvent.keyDown(lib, { key: 'ArrowRight' });
    expect(now('lib.divider')).toBe(316);
    expect(stored().panelSizes?.['standard']?.['lib']).toBe(316);
    for (let i = 0; i < 20; i++) fireEvent.keyDown(lib, { key: 'ArrowLeft' });
    expect(now('lib.divider')).toBe(240);                                         // Library minimum
    for (let i = 0; i < 20; i++) fireEvent.keyDown(agent, { key: 'ArrowRight' });  // the agent divider grows leftwards
    expect(now('agent.divider')).toBe(320);                                       // Agent Panel minimum 320 px
    fireEvent.keyDown(agent, { key: 'ArrowLeft' });
    expect(now('agent.divider')).toBe(336);
    fireEvent.keyDown(tl, { key: 'ArrowUp' });
    expect(now('stage.divider')).toBe(256);
    for (let i = 0; i < 5; i++) fireEvent.keyDown(tl, { key: 'ArrowDown' });
    expect(now('stage.divider')).toBe(220);                                       // Timeline View minimum
    expect((el('stage.timeline')!.style.height)).toBe('220px');
    fireEvent.doubleClick(lib);
    expect(now('lib.divider')).toBe(300);
    expect(stored().panelSizes?.['standard']?.['lib']).toBeUndefined();
  });

  it('restores persisted sizes after a reload, and Ctrl+B still collapses the Library', async () => {
    await renderEditor('sample');
    fireEvent.keyDown(el('agent.divider')!, { key: 'ArrowLeft' });
    fireEvent.keyDown(el('agent.divider')!, { key: 'ArrowLeft' });
    expect(now('agent.divider')).toBe(392);
    cleanup();
    await renderEditor('sample', { keepStorage: true });
    expect(now('agent.divider')).toBe(392);
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => { if (el('lib.divider')) throw new Error('still expanded'); });
    expect(el('lib.search.input')).toBeNull();
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => { if (!el('lib.divider')) throw new Error('not expanded'); });
  });

  it('dragging the Library divider resizes it and dragging far left collapses it to the rail', async () => {
    await renderEditor('sample');
    const lib = el('lib.divider')!;
    fireEvent.mouseDown(lib, { clientX: 300, button: 0 });
    fireEvent.mouseMove(window, { clientX: 350 });
    expect(now('lib.divider')).toBe(350);
    fireEvent.mouseUp(window);
    expect(stored().panelSizes?.['standard']?.['lib']).toBe(350);
    fireEvent.mouseDown(el('lib.divider')!, { clientX: 350, button: 0 });
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window);
    await waitFor(() => { if (el('lib.divider')) throw new Error('not collapsed'); });
  });
});
