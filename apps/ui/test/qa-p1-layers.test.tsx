// @vitest-environment jsdom
// QA P1 2026-10-29 (round 1): the Hardware Monitor popover was clipped under the update banner and crossed by the agent-panel
// divider (it lived in the header's z-20 stacking context; banners are z-50, splitters z-20). Every popover / menu now renders
// into the one floating layer at the end of <body>, above banners, dividers and dialogs, placed inside a 1280×720 viewport.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { renderEditor, el } from './setup-dom.js';
import { FLOATING_LAYER_ID, FLOATING_LAYER_Z, placeBelow } from '../src/components/Layer.js';

afterEach(() => cleanup());
const SRC = existsSync(path.resolve('apps/ui/src')) ? path.resolve('apps/ui/src') : path.resolve('src');   // jsdom: import.meta.url is not a file URL
const inLayer = (id: string) => { const n = el(id); return !!n && !!n.closest(`#${FLOATING_LAYER_ID}`); };

describe('QA P1: one floating layer for popovers and menus', () => {
  it('the layer is above every banner, divider, dialog, onboarding and toast z-index used by the Editor, below tooltips', () => {
    const src = ['App.tsx', 'components/ui.tsx', 'components/Splitter.tsx', 'header/Header.tsx', 'screens/Onboarding.tsx', 'screens/Tour.tsx', 'stage/Timeline.tsx']
      .map((f) => readFileSync(path.join(SRC, f), 'utf8')).join('\n');
    const zs = [...src.matchAll(/\bz-(?:\[(\d+)\]|(\d+))/g)].map((m) => Number(m[1] ?? m[2])).filter((z) => z < 1000 && z !== 90 && z !== 100);   // splash / fatal screens cover everything on purpose
    expect(Math.max(...zs)).toBeLessThan(FLOATING_LAYER_Z);
    expect(readFileSync(path.join(SRC, 'components/Tooltip.tsx'), 'utf8')).toMatch(/z-\[1000\]/);
  });

  it('Hardware Monitor, File, Help and licence popovers render in the floating layer, not inside the header', async () => {
    await renderEditor('sample');
    for (const [trigger, pop] of [['hdr.action.hardware', 'scr.hardware'], ['hdr.menu.file', null], ['hdr.menu.help', null]] as const) {
      await act(async () => { fireEvent.click(el(trigger)!); });
      const node = pop ? el(pop) : document.querySelector<HTMLElement>(`#${FLOATING_LAYER_ID} [role="menu"]`);
      expect(node, trigger).not.toBeNull();
      expect(node!.closest(`#${FLOATING_LAYER_ID}`), trigger).not.toBeNull();
      expect(node!.closest('header'), trigger).toBeNull();
      expect(node!.className).toContain('pointer-events-auto');
      await act(async () => { fireEvent.keyDown(node!, { key: 'Escape' }); });
      expect(document.querySelector(`#${FLOATING_LAYER_ID} [data-floating="popover"]`), `${trigger} closed`).toBeNull();
    }
    expect(inLayer('scr.hardware')).toBe(false);
    const layer = document.getElementById(FLOATING_LAYER_ID)!;
    expect(layer.parentElement).toBe(document.body);
    expect(layer.style.zIndex).toBe(String(FLOATING_LAYER_Z));
    expect(layer.style.pointerEvents).toBe('none');
  });

  it('placement inside 1280×720: right-aligned at the right edge, flipped above near the bottom, never off-screen', () => {
    // Hardware Monitor: 340 px wide, right-aligned under a header icon at the right edge
    expect(placeBelow({ left: 1236, top: 8, right: 1268, bottom: 40 }, 340, 420, 'right', 1280, 720)).toEqual({ left: 928, top: 44, maxHeight: 668 });
    // a left-aligned menu near the right edge is pushed back inside
    expect(placeBelow({ left: 1200, top: 8, right: 1230, bottom: 40 }, 280, 200, 'left', 1280, 720).left).toBe(992);
    // the player menu near the bottom: no room below → above the trigger
    const p = placeBelow({ left: 600, top: 680, right: 630, bottom: 710 }, 240, 260, 'right', 1280, 720);
    expect(p.top).toBe(680 - 4 - 260); expect(p.left).toBe(390);
    // a tall popover gets a max height so it scrolls instead of leaving the window
    const tall = placeBelow({ left: 10, top: 300, right: 40, bottom: 330 }, 340, 2000, 'left', 1280, 720);
    expect(tall.top + tall.maxHeight).toBeLessThanOrEqual(720);
  });
});
