// @vitest-environment jsdom
// UI/UX QA 2026-10-30 (process.md Entry 36): Web chip without an AI connection, header mode switches as real buttons (Windows
// UIA Invoke), accessible names without a trailing "…", Model Manager names per row, onboarding language follows the UI,
// catalogue posters, the insert toast says what and where, toasts never over the Player controls.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { renderEditor, el, els } from './setup-dom.js';
import { Modal, Button } from '../src/components/ui.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { StoreProvider, PROGRESS_MIN_MS } from '../src/state/store.js';
import { App } from '../src/App.js';
import { plainLabel, noEllipsis } from '../src/components/ui.js';
import { posterOf } from '../src/library/Catalogue.js';
import { onboardingLangFor } from '../src/prefs.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

afterEach(() => cleanup());

describe('Entry 36 UI QA', () => {
  it('the Web chip is muted and explains itself while no AI provider is connected; on once one is', async () => {
    const { runtime } = await renderEditor('sample');
    const chip = el('agent.chat.research')!;
    expect(chip.getAttribute('aria-checked')).toBe('false');
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(chip.textContent).toBe('Web');
    expect(chip.getAttribute('title')).toMatch(/Connect an AI provider first/);
    const put = vi.spyOn(runtime.api, 'putSettings');
    fireEvent.click(chip);
    expect(put).not.toHaveBeenCalled();
  });

  it('header Library modes are plain buttons (UIA Invoke = click) with aria-pressed, and switch the Library', async () => {
    await renderEditor('sample');
    const design = el('hdr.menu.design')!;
    expect(design.getAttribute('role')).toBeNull();
    expect(design.tagName).toBe('BUTTON');
    fireEvent.click(design);
    await waitFor(() => { if (el('hdr.menu.design')!.getAttribute('aria-pressed') !== 'true') throw new Error('not pressed'); });
    expect(el('lib.catalogue')).not.toBeNull();
    expect(el('hdr.menu.home')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('accessible names drop the trailing ellipsis / arrow; other labels keep theirs', () => {
    expect(plainLabel('Import files…')).toBe('Import files');
    expect(plainLabel('All...')).toBe('All');
    expect(plainLabel(['Recent', ' ▸'])).toBe('Recent');
    expect(plainLabel('Save')).toBeNull();
    expect(plainLabel(['a', <b key="b" />])).toBeNull();
    expect(noEllipsis('Semua…')).toBe('Semua');
    expect(noEllipsis('Export')).toBe('Export');
  });

  it('File menu items and the Assets import button expose names without "…"', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.menu.file')!);
    await waitFor(() => { if (!el('hdr.menu.file.open')) throw new Error('menu'); });
    expect(el('hdr.menu.file.open')!.getAttribute('aria-label')).toBe('Open');
    expect(el('hdr.menu.file.open')!.getAttribute('aria-keyshortcuts')).toBe('Control+O');
    expect(el('hdr.menu.file.recent')!.getAttribute('aria-label')).toBe('Recent');
    for (const b of document.querySelectorAll('button[aria-label]')) expect(b.getAttribute('aria-label')).not.toMatch(/(…|\.\.\.)$/);
  });

  it('Model Manager: every row action names its model; one "Recommended" per purpose; the optional badge explains itself', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.action.models')!);
    await waitFor(() => { if (!els('scr.models.row').length) throw new Error('rows'); });
    const installs = els('scr.models.row.install');
    expect(installs.length).toBeGreaterThan(0);
    for (const b of installs) {
      const row = b.closest('[data-el="scr.models.row"]')!;
      const name = row.querySelector('[data-el="scr.models.row.name"]')!.textContent!;
      expect(b.getAttribute('aria-label')).toBe(`Install ${name}`);
    }
    for (const group of document.querySelectorAll('[data-purpose]')) expect(group.querySelectorAll('[data-el="scr.models.row.recommended"]').length).toBeLessThanOrEqual(1);
    for (const b of els('scr.models.row.optional')) expect(b.getAttribute('title')).toMatch(/Not needed/);
  });

  it('onboarding / tour language follows the UI language until the Creator picks one', () => {
    const base = { onboardingLang: 'en' as const };
    expect(onboardingLangFor(base as never, 'id')).toBe('id');
    expect(onboardingLangFor({ ...base, onboardingLangPicked: true } as never, 'id')).toBe('en');
    expect(onboardingLangFor({ onboardingLang: 'id' } as never, 'en')).toBe('id');
    expect(onboardingLangFor(base as never, undefined)).toBe('en');
  });

  it('catalogue cards use the loop poster and do not preload the video', async () => {
    expect(posterOf('http://x/catalogue/transition/fade.webm')).toBe('http://x/catalogue/transition/fade.jpg');
    // the mock catalogue has no loop URLs; the card markup is checked in the source (a live check: process.md Entry 36 shots)
    const src = readFileSync(path.resolve(__dirname, '../src/library/Catalogue.tsx'), 'utf8');
    expect(src).toContain('poster={posterOf(loopUrl)}');
    expect(src).toContain('preload="none"');
  });

  it('timeline lane names carry their full text as a tooltip', async () => {
    await renderEditor('sample');
    const col = el('stage.timeline.lanes.labels');
    if (!col) return;   // lanes appear with content; the sample has clips
    for (const s of col.querySelectorAll('span.truncate')) expect(s.getAttribute('title')).toBeTruthy();
  });

  it('the toast stack sits at the bottom (never over the Player controls) and in the window corner over a screen', async () => {
    const { container } = await renderEditor('sample');
    void container;
    const stack = el('sys.toasts')!;
    expect(stack.className).toContain('bottom-6');
    expect(stack.className).not.toContain('bottom-[260px]');
    fireEvent.click(el('hdr.action.models')!);
    await waitFor(() => { if (el('sys.toasts')!.style.right !== '16px') throw new Error(el('sys.toasts')!.style.right); });
  });

  it('a dialog focuses its data-autofocus button (Keep rendering / Save), not the first one', async () => {
    render(<Modal el="scr.close.render" title="t" onClose={() => undefined} footer={<><Button el="danger">Cancel render</Button><Button el="keep" data-autofocus="">Keep</Button></>}><p>x</p></Modal>);
    await waitFor(() => { if (document.activeElement !== el('keep')) throw new Error(String(document.activeElement?.getAttribute('data-el'))); });
  });

  it('render progress events are coalesced to one repaint per PROGRESS_MIN_MS (the last value wins)', async () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    const bus = new MockBus();
    const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, outputCollapsed: false }}><App /></StoreProvider>);
    await waitFor(() => { if (!el('stage.timeline') || !el('hdr.title')?.textContent?.trim()) throw new Error('boot'); });
    const pid = (await runtime.api.listProjects()).items[0]!.id;
    await act(async () => { bus.emit('render.queued', { projectId: pid, job: { id: 'j1', projectId: pid, status: 'queued', progress: 0, profile: {}, createdAt: 'x' } } as never); });
    await act(async () => { for (let i = 1; i <= 20; i++) bus.emit('render.progress', { projectId: pid, jobId: 'j1', progress: i / 100, renderedFrames: i, totalFrames: 100, etaMs: 1000, stage: 'rendering' } as never); });
    const chip = () => el('sys.render.progress');
    await waitFor(() => { if (!chip()) throw new Error('no chip'); });
    const first = chip()!.getAttribute('aria-label');
    await new Promise((r) => setTimeout(r, PROGRESS_MIN_MS + 100));
    await waitFor(() => { if (chip()!.getAttribute('aria-label') === first) throw new Error('no trailing flush'); });
    expect(chip()!.getAttribute('aria-label')).toMatch(/20/);
    expect(first).not.toMatch(/20/);   // the burst of 20 events painted once at the start, then once with the newest value
    // at most two toasts show; the rest sit behind "+N more"
    await act(async () => { for (const n of [1, 2, 3]) bus.emit('render.done', { projectId: pid, jobId: `d${n}`, output: { id: `o${n}`, projectId: pid, fileName: `video-${n}.mp4`, path: `/x/video-${n}.mp4`, kind: 'video', createdAt: 'x' } } as never); });
    await waitFor(() => { if (els('sys.toast').length !== 2) throw new Error(String(els('sys.toast').length)); });
    expect(el('sys.toasts.more')!.textContent).toBe('+1 more');
    fireEvent.click(el('sys.toasts.more')!);
    await waitFor(() => { if (els('sys.toast').length !== 3) throw new Error('not expanded'); });
  });

  it('a long draft sent from Diskusi is folded in the Editor chat', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/agent/AssistantChat.tsx'), 'utf8');
    expect(src).toContain('collapsible={Boolean(origin)}');
  });
});
