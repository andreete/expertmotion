// @vitest-environment jsdom
// FR-263 / FR-264 / FR-265 (Operator 2026-10-29): tooltips on every icon-only button and key control (hover + keyboard), the
// empty project pushes the automatic path, and the empty chat has a first-run hint and example prompts as chips.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { el, els, renderEditor } from './setup-dom.js';
import { placeTip, tipOf, TIP_DELAY_MS } from '../src/components/Tooltip.js';
import en from '../src/i18n/en.json';
import id from '../src/i18n/id.json';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const RAW_KEY = /^(ui|a11y|err)\.[a-z0-9.]+$/i;

describe('tooltips (FR-264)', () => {
  it('every icon-only button of the Editor has a tooltip text (never a raw i18n key); en / id parity is the i18n test', async () => {
    await renderEditor('sample');
    const iconOnly = [...document.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"], [role="switch"]')].filter((b) => !(b.textContent ?? '').trim());
    expect(iconOnly.length).toBeGreaterThan(10);
    const missing = iconOnly.filter((b) => { const tip = tipOf(b); return !tip || RAW_KEY.test(tip); }).map((b) => b.getAttribute('data-el') ?? b.outerHTML.slice(0, 80));
    expect(missing).toEqual([]);
  });
  it('keyboard focus shows the tooltip at once (role=tooltip, inside the window, not over the control); Escape hides it', async () => {
    await renderEditor('sample');
    const btn = el('stage.player.menu')!;
    act(() => { btn.focus(); fireEvent.focusIn(btn); });
    await waitFor(() => expect(el('sys.tooltip')).not.toBeNull());
    expect(el('sys.tooltip')!.getAttribute('role')).toBe('tooltip');
    expect(el('sys.tooltip')!.textContent).toBe(btn.getAttribute('aria-label'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(el('sys.tooltip')).toBeNull());
  });
  it('hover shows it after the delay for a control without a native title (one with a title keeps the browser tooltip); leaving hides it', async () => {
    await renderEditor('empty');
    await waitFor(() => expect(el('agent.chat.start.hint.dismiss')).not.toBeNull());
    vi.useFakeTimers();
    fireEvent.pointerOver(el('stage.player.menu')!, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS + 10); });
    expect(el('sys.tooltip')).toBeNull();
    const btn = el('agent.chat.start.hint.dismiss')!;
    fireEvent.pointerOver(btn, { pointerType: 'mouse' });
    expect(el('sys.tooltip')).toBeNull();
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS + 10); });
    expect(el('sys.tooltip')).not.toBeNull();
    fireEvent.pointerOut(btn, { pointerType: 'mouse', relatedTarget: document.body });
    expect(el('sys.tooltip')).toBeNull();
  });
  it('placement: below the control, above when there is no room, always 8 px inside a 1280×720 window', () => {
    expect(placeTip({ left: 100, top: 40, width: 32, height: 32 }, { w: 120, h: 24 }, 1280, 720)).toEqual({ left: 56, top: 78, side: 'below' });
    const low = placeTip({ left: 600, top: 690, width: 32, height: 24 }, { w: 200, h: 24 }, 1280, 720);
    expect(low.side).toBe('above'); expect(low.top + 24).toBeLessThanOrEqual(690);
    const edge = placeTip({ left: 1270, top: 10, width: 10, height: 10 }, { w: 280, h: 40 }, 1280, 720);
    expect(edge.left + 280).toBeLessThanOrEqual(1272); expect(edge.left).toBeGreaterThanOrEqual(8);
  });
  it('the new copy exists in English and Indonesian', () => {
    for (const k of ['ui.agent.chat.start.hint', 'ui.agent.chat.example.data.text', 'ui.stage.player.empty.write.tip', 'ui.stage.recent.title', 'ui.launch.notice.loop', 'ui.scr.generate.voice.recommended', 'ui.scr.generate.voice.azure.note']) {
      expect((en as Record<string, string>)[k], k).toBeTruthy();
      expect((id as Record<string, string>)[k], k).toBeTruthy();
    }
    expect((id as Record<string, string>)['ui.agent.chat.start.hint']).toBe('Tulis ide atau tempel prompt lengkap — Expertmotion membuat videonya otomatis');
  });
});

describe('automatic path first (FR-263, FR-265)', () => {
  it('the empty chat shows the hint and example chips; a chip fills the EDITOR composer without sending; the hint can be hidden for good', async () => {
    const r = await renderEditor('empty');
    await waitFor(() => expect(el('agent.chat.start.hint')).not.toBeNull());
    const chips = els('agent.chat.example');
    expect(chips.map((c) => c.getAttribute('data-key'))).toEqual(['ui.agent.chat.example.faceless', 'ui.agent.chat.example.data', 'ui.agent.chat.example.music']);   // no footage chip without a video
    const sent = vi.spyOn(r.runtime.api, 'sendMessage');
    fireEvent.click(chips[1]!);
    await waitFor(() => expect(el('agent.chat.tab.editor')?.getAttribute('aria-selected')).toBe('true'));
    expect((el('agent.chat.composer') as HTMLTextAreaElement).value).toMatch(/video data 9:16|data video/i);
    expect(sent).not.toHaveBeenCalled();
    fireEvent.click(el('agent.chat.start.hint.dismiss')!);
    await waitFor(() => expect(el('agent.chat.start.hint')).toBeNull());
    cleanup();
    await renderEditor('empty', { keepStorage: true });
    await waitFor(() => expect(el('agent.chat.examples')).not.toBeNull());
    expect(el('agent.chat.start.hint')).toBeNull();
  });
  it('the empty project leads with "Tulis ide" (focuses the Editor composer) before "Impor footage"', async () => {
    await renderEditor('empty');
    await waitFor(() => expect(el('stage.player.state.empty')).not.toBeNull());
    const buttons = el('stage.player.state.empty')!.querySelectorAll('button');
    expect(buttons[0]!.getAttribute('data-el')).toBe('stage.player.state.empty.write');
    expect(buttons[1]!.getAttribute('data-el')).toBe('stage.player.state.empty.import');
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(document.activeElement).toBe(el('agent.chat.composer')));
    expect(el('agent.chat.tab.editor')?.getAttribute('aria-selected')).toBe('true');
  });
});
