// @vitest-environment jsdom
// FR-253 … FR-256 (QA 2026-10-28 #5 / #6, ADR-035): the playhead can be dragged along its whole height, a press on the ruler or on
// empty track space seeks, a click on an item still selects it (Alt+click seeks without selecting), the ruler is sticky inside the
// one Timeline scroll container, ←/→ / Shift / Home / End move the playhead, and Copy / Cut / Paste work from the item menu and
// Ctrl+C / Ctrl+X / Ctrl+V as one undoable pick each, without stealing the keys from text fields.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el, els } from './setup-dom.js';
import { timelineClipboard } from '../src/stage/clipboard.js';
import { hasTextSelection } from '../src/shortcuts.js';
import { playerBus } from '../src/stage/playerBus.js';

afterEach(() => { cleanup(); timelineClipboard.clear(); });
const until = async (fn: () => unknown, what: string, timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${what}`); }, { timeout });
const bars = (kind: string) => [...document.querySelectorAll<HTMLElement>(`[data-el="stage.timeline.element"][data-kind="${kind}"]`)];
const toasts = () => els('sys.toast').map((x) => x.textContent ?? '').join(' | ');
/** Player time `mm:ss.ff` → ms (frames at 30 fps in the sample). */
const timeMs = () => { const m = /(\d+):(\d+)\.(\d+)/.exec(el('stage.player.controls.time')!.textContent ?? '')!; return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]) * 100; };   // mm:ss.d (tenths, QA UX round 1)
/** The Player registers its controller on playerBus once the composition is mounted. */
const ready = async () => { await renderEditor('sample'); await until(() => bars('clip').length === 3 && playerBus.get() && playerBus.get()!.durationMs() > 1000, 'player ready'); };
/** jsdom's PointerEvent drops the MouseEvent fields (clientX, button), so pointer events are dispatched as MouseEvents of that type. */
const ptr = (target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
const headMs = () => Number(el('stage.timeline.head')!.getAttribute('aria-valuenow'));

describe('FR-253 playhead from anywhere', () => {
  it('the playhead line is a slider you can drag (press seeks, moves scrub, release stops)', async () => {
    await ready();
    const head = el('stage.timeline.head')!;
    expect(head.getAttribute('role')).toBe('slider');
    expect(head.getAttribute('aria-hidden')).toBeNull();
    await act(async () => { ptr(head, 'pointerdown', { clientX: 80 }); });
    const atDown = timeMs();
    expect(atDown).toBeGreaterThan(0);
    expect(head.getAttribute('data-scrubbing')).toBe('true');
    await act(async () => { ptr(window, 'pointermove', { clientX: 260 }); });
    expect(timeMs()).toBeGreaterThan(atDown);
    await act(async () => { ptr(window, 'pointermove', { clientX: 300 }); ptr(window, 'pointerup', { clientX: 300 }); });
    const atUp = timeMs();
    await act(async () => { ptr(window, 'pointermove', { clientX: 10 }); await new Promise((r) => setTimeout(r, 40)); });
    expect(timeMs()).toBe(atUp);                                                       // the last position was applied; no more scrubbing
    expect(el('stage.timeline.head')!.hasAttribute('data-scrubbing')).toBe(false);
    expect(headMs()).toBeGreaterThan(atDown);
  }, 20_000);

  it('a press on empty track space seeks and clears the selection; Shift keeps it; a click on an item selects; Alt+click seeks without selecting', async () => {
    await ready();
    fireEvent.click(bars('clip')[0]!);
    await until(() => el('stage.timeline.inspector'), 'inspector');
    const row = el('stage.timeline.track.video')!;
    await act(async () => { ptr(row, 'pointerdown', { clientX: 120, shiftKey: true }); ptr(window, 'pointerup'); });
    expect(el('stage.timeline.inspector')).not.toBeNull();                              // Shift keeps the selection
    const t1 = timeMs(); expect(t1).toBeGreaterThan(0);
    await act(async () => { ptr(row, 'pointerdown', { clientX: 40 }); ptr(window, 'pointerup'); });
    await until(() => !el('stage.timeline.inspector'), 'selection cleared');
    expect(timeMs()).toBeLessThan(t1);
    // Alt+click on a bar: seek to the click point, selection unchanged (none)
    await act(async () => { fireEvent.click(bars('clip')[2]!, { altKey: true, clientX: 200 }); });
    expect(el('stage.timeline.inspector')).toBeNull();
    expect(Math.abs(timeMs() - headMs())).toBeLessThan(100);                             // the display shows tenths
    // a plain click selects it
    fireEvent.click(bars('clip')[1]!);
    await until(() => el('stage.timeline.inspector'), 'selected by click');
  }, 20_000);

  it('FR-254: one scroll container; ruler sticky at the top with the playhead marker; lane names sticky at the left', async () => {
    await ready();
    const scroll = el('stage.timeline.scroll')!;
    expect(scroll.className).toContain('overflow-auto');
    const ruler = el('stage.timeline.ruler')!;
    expect(ruler.getAttribute('data-sticky')).toBe('top');
    expect(ruler.className).toMatch(/\bsticky\b/); expect(ruler.className).toMatch(/\btop-0\b/);
    expect(ruler.querySelector('[data-el="stage.timeline.head.handle"]')).not.toBeNull();
    const grid = document.querySelector<HTMLElement>('[data-el="stage.timeline"] [role="grid"]')!;
    expect(grid.className).not.toMatch(/overflow-/);                                    // no nested scroller between the ruler and the scroll container
    expect(scroll.firstElementChild!.className).toMatch(/\bsticky\b.*\bleft-0\b|\bleft-0\b.*\bsticky\b/);
  }, 20_000);

  it('FR-254: ←/→ one frame, Shift+←/→ one second, Home / End — also with the playhead focused; not while typing', async () => {
    await ready();
    const head = el('stage.timeline.head')!;
    head.focus();
    await act(async () => { fireEvent.keyDown(head, { key: 'End' }); });
    const end = timeMs(); expect(end).toBeGreaterThan(1000);
    await act(async () => { fireEvent.keyDown(head, { key: 'Home' }); });
    expect(timeMs()).toBe(0);
    await act(async () => { fireEvent.keyDown(head, { key: 'ArrowRight', shiftKey: true }); });
    expect(timeMs()).toBe(1000);
    // one frame; not called through: the Player mock has no frame clock (getCurrentFrame() is always 0), so a real step would settle
    // the store at frame 0/1 and the Player time now follows the store (Windows QA 2026-10-30)
    const step = vi.spyOn(playerBus.get()!, 'stepFrames').mockImplementation(() => undefined);
    await act(async () => { fireEvent.keyDown(head, { key: 'ArrowRight' }); fireEvent.keyDown(head, { key: 'ArrowLeft' }); });
    expect(step.mock.calls).toEqual([[1], [-1]]);
    await act(async () => { fireEvent.keyDown(el('lib.search.input')!, { key: 'Home' }); });
    expect(timeMs()).toBe(1000);
  }, 20_000);
});

describe('FR-255 / FR-256 Copy, Cut, Paste', () => {
  it('menu has Copy / Cut / Paste; Paste is disabled until something is copied; Copy → Paste inserts a copy as ONE pick; Ctrl+Z removes it', async () => {
    await ready();
    fireEvent.contextMenu(bars('clip')[0]!, { clientX: 10, clientY: 10 });
    await until(() => el('stage.itemmenu'), 'menu');
    expect(el('stage.itemmenu.copy')).not.toBeNull(); expect(el('stage.itemmenu.cut')).not.toBeNull();
    expect(el('stage.itemmenu.paste')!.getAttribute('aria-disabled')).toBe('true');
    expect(el('stage.itemmenu.copy')!.getAttribute('aria-keyshortcuts')).toMatch(/C$/);
    await act(async () => { fireEvent.click(el('stage.itemmenu.copy')!); });
    expect(el('stage.itemmenu')).toBeNull();
    expect(timelineClipboard.get()?.entries).toHaveLength(1);
    await until(() => /Copied 1 item/.test(toasts()), 'copy toast');
    fireEvent.contextMenu(bars('clip')[2]!, { clientX: 10, clientY: 10 });
    await until(() => el('stage.itemmenu'), 'menu again');
    expect(el('stage.itemmenu.paste')!.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { fireEvent.click(el('stage.itemmenu.paste')!); });
    await until(() => bars('clip').length === 4, 'pasted clip');
    await until(() => /Pasted 1 item/.test(toasts()), 'paste toast');
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); });
    await until(() => bars('clip').length === 3, 'one undo removes the paste');
  }, 20_000);

  it('Ctrl+X cuts (one Delete pick), Ctrl+V pastes it back at the playhead; right-click on empty space offers Paste only', async () => {
    await ready();
    const first = bars('clip')[0]!.getAttribute('data-element-id');
    fireEvent.click(bars('clip')[0]!);
    await until(() => el('stage.timeline.inspector'), 'inspector');
    await act(async () => { fireEvent.keyDown(window, { key: 'x', ctrlKey: true }); });
    await until(() => bars('clip').length === 2, 'cut');
    expect(bars('clip').some((b) => b.getAttribute('data-element-id') === first)).toBe(false);
    fireEvent.contextMenu(el('stage.timeline.track.video')!, { clientX: 5, clientY: 5 });
    await until(() => el('stage.itemmenu'), 'empty-space menu');
    expect(el('stage.itemmenu.copy')!.getAttribute('aria-disabled')).toBe('true');
    expect(el('stage.itemmenu.delete')!.getAttribute('aria-disabled')).toBe('true');
    expect(el('stage.itemmenu.paste')!.getAttribute('aria-disabled')).toBeNull();
    fireEvent.keyDown(el('stage.itemmenu')!, { key: 'Escape' });
    await act(async () => { fireEvent.keyDown(window, { key: 'Home' }); });
    await act(async () => { fireEvent.keyDown(window, { key: 'v', ctrlKey: true }); });
    await until(() => bars('clip').length === 3, 'pasted back');
  }, 20_000);

  it('Ctrl+C / Ctrl+V are left to the browser in text fields and while page text is selected', async () => {
    await ready();
    fireEvent.click(bars('clip')[0]!);
    await until(() => el('stage.timeline.inspector'), 'inspector');
    const input = el('lib.search.input')!;
    const ev = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(timelineClipboard.get()).toBeNull();
    // selected page text → native copy
    const p = document.createElement('p'); p.textContent = 'Energi bersih'; document.body.appendChild(p);
    const range = document.createRange(); range.selectNodeContents(p); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    expect(hasTextSelection()).toBe(true);
    const ev2 = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(ev2); });
    expect(ev2.defaultPrevented).toBe(false);
    expect(timelineClipboard.get()).toBeNull();
    window.getSelection()!.removeAllRanges(); p.remove();
    // nothing on the clipboard → Ctrl+V does nothing and is not swallowed
    const ev3 = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(ev3); });
    expect(ev3.defaultPrevented).toBe(false);
    // with the selection and no text selected, Ctrl+C copies
    const ev4 = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(ev4); });
    expect(ev4.defaultPrevented).toBe(true);
    expect(timelineClipboard.get()?.entries).toHaveLength(1);
  }, 20_000);
});
