// @vitest-environment jsdom
// Panel resize (FR-099, FR-155; EDITOR_INTERACTION_MODEL.md §9): keyboard-accessible separators, min sizes, persistence in
// prefs (expertmotion.prefs.v1), double-click reset, Ctrl+B collapse still working.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';
import { LAYOUT, bucketFor, chatRatioFor, defaultSizes, resolveChatSplit, resolveColumns } from '../src/layout.js';
import { loadPrefs } from '../src/prefs.js';

afterEach(() => cleanup());
const now = (id: string) => Number(el(id)!.getAttribute('aria-valuenow'));
const stored = () => JSON.parse(localStorage.getItem('expertmotion.prefs.v1') ?? '{}') as { panelSizes?: Record<string, Record<string, number>>; chatSplit?: number; chatMaximized?: string | null; outputCollapsed?: boolean };

describe('layout rules', () => {
  it('FR-099: at 1280×720 all three columns stay visible with the Stage ≥ 640 px; panels shrink, then collapse Library → Agent', () => {
    const c = resolveColumns({ width: 1280, lib: 420, agent: 520, libOpen: true, agentOpen: true });
    expect(c).toMatchObject({ libOpen: true, agentOpen: true });
    expect(c.agent).toBeGreaterThanOrEqual(320);
    expect(1280 - c.lib - c.agent - 12).toBeGreaterThanOrEqual(640);
    const d = resolveColumns({ width: 1280, lib: 300, agent: 360, libOpen: true, agentOpen: true });
    expect(d).toMatchObject({ libOpen: true, agentOpen: true });
    expect(1280 - d.lib - d.agent - 12).toBeGreaterThanOrEqual(640);
    const e = resolveColumns({ width: 1150, lib: 300, agent: 360, libOpen: true, agentOpen: true });   // Library goes first
    expect(e).toMatchObject({ libOpen: false, agentOpen: true });
    expect(1150 - 48 - e.agent - 6).toBeGreaterThanOrEqual(640);
    const f = resolveColumns({ width: 1000, lib: 300, agent: 360, libOpen: true, agentOpen: true });   // then the Agent Panel
    expect(f).toMatchObject({ libOpen: false, agentOpen: false });
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
    expect(now('lib.divider')).toBe(300); expect(now('agent.divider')).toBe(420); expect(now('stage.divider')).toBe(240);
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
    expect(now('agent.divider')).toBe(452);
    cleanup();
    await renderEditor('sample', { keepStorage: true });
    expect(now('agent.divider')).toBe(452);
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

describe('FR-099 layout persisted in the Local Service Settings', () => {
  it('saves panel sizes and the collapsed Output Settings to Settings.layout (settings.json state)', async () => {
    const { runtime } = await renderEditor('sample');
    fireEvent.keyDown(el('agent.divider')!, { key: 'ArrowLeft' });
    fireEvent.click(el('agent.output.toggle')!);
    await waitFor(async () => {
      const l = (await runtime.api.getSettings()).layout;
      if (l?.panelSizes['standard']?.agent !== 436 || !l.outputCollapsed) throw new Error(JSON.stringify(l));
    }, { timeout: 3000 });
  });
});

describe('FR-099 (2026-10-25): larger, resizable agent chats', () => {
  it('the Agent Panel defaults to 360 / 420 / 480 px per bucket and may grow to 900 px while the Stage keeps 640 px', () => {
    expect([defaultSizes('narrow').agent, defaultSizes('standard').agent, defaultSizes('wide').agent]).toEqual([360, 420, 480]);
    expect(LAYOUT.agent.max).toBe(900);
    const wide = resolveColumns({ width: 1920, lib: 300, agent: 900, libOpen: true, agentOpen: true });
    expect(wide).toMatchObject({ lib: 300, agent: 900, agentMax: 900 });
    const std = resolveColumns({ width: 1440, lib: 300, agent: 900, libOpen: true, agentOpen: true });   // Library shrinks first, then the Agent stops
    expect(std.lib).toBe(240);
    expect(1440 - std.lib - std.agent - 12).toBeGreaterThanOrEqual(640);
    expect(std.agentMax).toBe(std.agent);
    const huge = resolveColumns({ width: 2560, lib: 300, agent: 2000, libOpen: true, agentOpen: true });
    expect(huge.agent).toBe(900);
    const narrow = resolveColumns({ width: 1280, lib: 300, agent: 360, libOpen: true, agentOpen: true });
    expect(narrow).toMatchObject({ libOpen: true, agentOpen: true });
    expect(1280 - narrow.lib - narrow.agent - 12).toBeGreaterThanOrEqual(640);
  });

  it('chat split: ratio → px keeps 140 px (Brainstorming) and 200 px (Editor); px → ratio is clamped', () => {
    expect(resolveChatSplit(606, 0.4)).toEqual({ size: 240, min: 140, max: 400, area: 600 });
    expect(resolveChatSplit(606, 0.01).size).toBe(140);
    expect(resolveChatSplit(606, 0.99).size).toBe(400);
    expect(resolveChatSplit(0, undefined).area).toBe(600);                         // unmeasured → nominal height
    expect(resolveChatSplit(200, 0.5)).toMatchObject({ min: 140, max: 140, area: 340 });   // tiny panel: minimums win
    expect(chatRatioFor(300, 606)).toBe(0.5);
    expect(chatRatioFor(10, 606)).toBe(0.233);
    expect(chatRatioFor(5000, 606)).toBe(0.667);
  });

  it('the chat divider resizes with the keyboard, persists the ratio (prefs + Settings.layout), survives a reload and resets', async () => {
    const { runtime } = await renderEditor('sample');
    const d = el('agent.chat.divider')!;
    expect(d.getAttribute('role')).toBe('separator');
    expect(d.getAttribute('aria-orientation')).toBe('horizontal');
    expect(d.tabIndex).toBe(0);
    expect(now('agent.chat.divider')).toBe(240);                                    // 0.4 × 600 (nominal height in jsdom)
    fireEvent.keyDown(d, { key: 'ArrowDown' });
    expect(now('agent.chat.divider')).toBe(256);
    expect(stored().chatSplit).toBe(0.427);
    await waitFor(async () => { if ((await runtime.api.getSettings()).layout?.chatSplit !== 0.427) throw new Error('not saved'); }, { timeout: 3000 });
    fireEvent.keyDown(d, { key: 'Home' });
    expect(now('agent.chat.divider')).toBe(140);
    fireEvent.keyDown(d, { key: 'End' });
    expect(now('agent.chat.divider')).toBe(400);
    expect(el('agent.brainstorm.panel')!.style.flex).toMatch(/^0\.66+7? 1 0/);
    cleanup();
    await renderEditor('sample', { keepStorage: true });
    expect(now('agent.chat.divider')).toBe(400);
    fireEvent.doubleClick(el('agent.chat.divider')!);
    expect(now('agent.chat.divider')).toBe(240);
    expect(stored().chatSplit).toBe(0.4);
  });

  it('dragging the chat divider changes the split and commits on release', async () => {
    await renderEditor('sample');
    fireEvent.mouseDown(el('agent.chat.divider')!, { clientY: 300, button: 0 });
    fireEvent.mouseMove(window, { clientY: 360 });
    expect(now('agent.chat.divider')).toBe(300);
    expect(stored().chatSplit).toBeUndefined();                                     // live only while dragging
    fireEvent.mouseUp(window);
    expect(stored().chatSplit).toBe(0.5);
  });

  it('maximize gives one chat the panel; the other keeps its header bar, which restores the split; persisted', async () => {
    await renderEditor('sample');
    const max = el('agent.editor.maximize')!;
    expect(max.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(max);
    expect(el('agent.editor.panel')!.getAttribute('data-view')).toBe('max');
    expect(el('agent.brainstorm.panel')!.getAttribute('data-view')).toBe('min');
    expect(el('agent.editor.maximize')!.getAttribute('aria-pressed')).toBe('true');
    expect(el('agent.chat.divider')).toBeNull();
    expect(el('agent.brainstorm.composer')!.closest('.hidden')).not.toBeNull();     // kept mounted (draft survives), not shown
    expect(el('agent.editor.composer')!.closest('.hidden')).toBeNull();
    expect(stored().chatMaximized).toBe('editor');
    cleanup();
    await renderEditor('sample', { keepStorage: true });
    expect(el('agent.brainstorm.panel')!.getAttribute('data-view')).toBe('min');
    fireEvent.click(el('agent.brainstorm.header')!.querySelector('button')!);       // the collapsed header bar restores
    expect(el('agent.brainstorm.panel')!.getAttribute('data-view')).toBe('split');
    expect(el('agent.editor.panel')!.getAttribute('data-view')).toBe('split');
    expect(el('agent.chat.divider')).not.toBeNull();
    expect(stored().chatMaximized).toBeNull();
    fireEvent.click(el('agent.brainstorm.maximize')!);
    expect(el('agent.editor.panel')!.getAttribute('data-view')).toBe('min');
    fireEvent.click(el('agent.brainstorm.maximize')!);                               // the same toggle restores
    expect(el('agent.brainstorm.panel')!.getAttribute('data-view')).toBe('split');
  });

  it('Output Settings is collapsed by default with "ratio · resolution · fps · profile" in its header; the toggle opens it and persists', async () => {
    localStorage.clear();
    expect(loadPrefs().outputCollapsed).toBe(true);
    await renderEditor('sample', { prefs: { outputCollapsed: true } });
    const toggle = el('agent.output.toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el('agent.output.ratio.9x16')).toBeNull();
    expect(el('agent.output.summary')!.textContent).toBe('9:16 · 1080p · 30 fps · Standard');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el('agent.output.ratio.9x16')).not.toBeNull();
    expect(el('agent.output.summary')).toBeNull();
    expect(stored().outputCollapsed).toBe(false);
    fireEvent.click(toggle);
    expect(stored().outputCollapsed).toBe(true);
  });
});
