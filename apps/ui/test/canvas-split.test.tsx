// @vitest-environment jsdom
// ADR-028 / FR-179 / FR-180 / IX-27 / IX-28: canvas handles on the Player (move with snap guides, corner scale, rotate, double-click
// reset, Esc cancel; one op:element.setTransform pick per gesture), Inspector transform fields, and the split at the playhead
// (scissors button and S; one op:element.split pick for every item at once). jsdom has no layout: the Player overlay's rect is at
// the origin and its size follows the Player fit, so pointer positions are computed from the same pure geometry the UI uses.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { applyOperations, createEmptyModel, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { renderEditor, el } from './setup-dom.js';
import { alignXf, boxOf, canvasItemOf, fitXf, IDENTITY, moveXf, rotateXf, scaleXf, transformEditOf, withLiveTransform, type CanvasItem } from '../src/stage/canvas-transform.js';
import { splitTargets } from '../src/stage/split.js';
import { playerBus } from '../src/stage/playerBus.js';
import type { Runtime } from '../src/state/runtime.js';

afterEach(() => cleanup());
if (typeof window !== 'undefined' && !('PointerEvent' in window)) (window as unknown as Record<string, unknown>)['PointerEvent'] = MouseEvent;

const ASSETS = [{ id: 'sq', kind: 'video' as const, status: 'ready' as const, durationMs: 20_000, width: 1000, height: 1000 }, { id: 'img', kind: 'image' as const, status: 'ready' as const, width: 400, height: 200 },
  { id: 'vo', kind: 'audio' as const, status: 'ready' as const, durationMs: 4000 }];
function model(extra: OperationT[] = [], ratio: '16:9' | '9:16' = '16:9'): CompositionModelT {
  let n = 0;
  const r = applyOperations(createEmptyModel('p', { autoRatio: false, ratio }), [{ op: 'op:clip.insert', args: { assetId: 'sq', durationMs: 6000 } }, { op: 'op:clip.insert', args: { assetId: 'sq', durationMs: 4000 } },
    { op: 'op:overlay.addImage', args: { assetId: 'img', atMs: 1000, durationMs: 3000, size: 400 } }, { op: 'op:text.add', args: { text: 'Judul', variant: 'preset:text.title', atMs: 0, durationMs: 2000 } },
    { op: 'op:audio.addLayer', args: { assetId: 'vo', atMs: 500, volume: 1 } }, ...extra], { assets: ASSETS, tier: 'T1', newId: () => `e${++n}` });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
const dims = (id: string): { width: number | null; height: number | null } | null => { const a = ASSETS.find((x) => x.id === id); return a && 'width' in a ? { width: a.width ?? null, height: a.height ?? null } : null; };

describe('canvas geometry (pure)', () => {
  it('a 1:1 video in a 16:9 frame: cover fills the width (1920 u), contain fits the height (1080 u); overlays use their size', () => {
    const m = model();
    const c = canvasItemOf(m, { kind: 'clip', id: m.tracks.video[0]!.id }, dims)!;
    expect([c.frame, c.baseW, c.baseH, c.xf, c.fromMs, c.toMs]).toEqual([{ w: 1920, h: 1080 }, 1920, 1920, IDENTITY, 0, 6000]);
    const contain = structuredClone(m); contain.tracks.video[0]!.objectFit = 'contain';
    expect(canvasItemOf(contain, { kind: 'clip', id: m.tracks.video[0]!.id }, dims)!.baseW).toBe(1080);
    const img = canvasItemOf(m, { kind: 'image', id: m.tracks.overlay[0]!.id }, dims)!;
    expect([img.baseW, img.baseH, img.scaleMin, img.scaleMax]).toEqual([400, 200, 0.05, 20]);
    expect(canvasItemOf(m, { kind: 'text', id: m.tracks.text[0]!.id }, dims)).toBeNull();
  });
  it('move: frame-fraction offsets; snaps the centre to the frame centre and the box edges to the frame edges; Alt off', () => {
    const m = model(); const img = canvasItemOf(m, { kind: 'image', id: m.tracks.overlay[0]!.id }, dims)!;
    expect(moveXf(img, IDENTITY, { x: 480, y: 0 }, false, 10).xf).toEqual({ ...IDENTITY, x: 0.25, y: 0 });
    const near = moveXf(img, IDENTITY, { x: 6, y: -4 }, true, 10);                         // close to the centre lines
    expect([near.xf.x, near.xf.y, near.guides]).toEqual([0, 0, [{ axis: 'x', at: 960 }, { axis: 'y', at: 540 }]]);
    const edge = moveXf(img, IDENTITY, { x: -756, y: 0 }, true, 10);                       // left edge 960 − 200 − 756 = 4 u → snaps to 0
    expect([edge.xf.x, edge.guides]).toEqual([(200 - 960) / 1920, [{ axis: 'x', at: 0 }, { axis: 'y', at: 540 }]]);
    expect(moveXf(img, IDENTITY, { x: 6, y: -4 }, false, 10).guides).toEqual([]);
  });
  it('corner scale: the opposite corner stays (any rotation); Shift keeps the centre; clamped to the range', () => {
    const m = model(); const img = canvasItemOf(m, { kind: 'image', id: m.tracks.overlay[0]!.id }, dims)!;
    const b = boxOf(img, IDENTITY);                                                        // 400 × 200 u at the centre (760…1160, 440…640)
    const s = scaleXf(img, IDENTITY, 'se', { x: b.corners[0].x + 800, y: b.corners[0].y + 400 }, false);
    expect(s.scale).toBeCloseTo(2);
    expect(boxOf(img, s).corners[0].x).toBeCloseTo(b.corners[0].x); expect(boxOf(img, s).corners[0].y).toBeCloseTo(b.corners[0].y);
    const shift = scaleXf(img, IDENTITY, 'se', { x: 960 + 400, y: 540 + 200 }, true);
    expect([shift.scale, shift.x, shift.y]).toEqual([2, 0, 0]);
    const rot = { ...IDENTITY, rotation: 90 };
    const r = scaleXf(img, rot, 'nw', boxOf(img, rot).corners[0], false);                  // pointer on the grabbed corner = no change
    expect(r.scale).toBeCloseTo(1);
    expect(scaleXf(img, IDENTITY, 'se', { x: -9999, y: -9999 }, false).scale).toBe(0.05);
  });
  it('rotate: the angle turned around the centre; Shift snaps to 0 / 90 / 180 / 270; stored in [0, 360)', () => {
    const m = model(); const img = canvasItemOf(m, { kind: 'image', id: m.tracks.overlay[0]!.id }, dims)!;
    const top = { x: 960, y: 300 }, right = { x: 1400, y: 560 };                            // ≈ +92.6°
    expect(rotateXf(img, IDENTITY, top, right, false).rotation).toBeCloseTo(92.6, 0);
    expect(rotateXf(img, IDENTITY, top, right, true).rotation).toBe(90);
    expect(rotateXf(img, IDENTITY, top, { x: 700, y: 540 }, true).rotation).toBe(270);
  });
  it('Fit / Fill / align use the bounding box (rotation swaps width and height); edits are rounded and complete', () => {
    const m = model(); const c = canvasItemOf(m, { kind: 'clip', id: m.tracks.video[0]!.id }, dims)!;
    expect(fitXf(c, 'fit', { ...IDENTITY, x: 0.3 })).toEqual({ ...IDENTITY, scale: 1080 / 1920 });   // the whole square inside the frame
    expect(fitXf(c, 'fill', IDENTITY).scale).toBe(1);
    const half = { ...IDENTITY, scale: 0.5 };                                                 // 960 u square
    expect(alignXf(c, 'left', half).x).toBeCloseTo((480 - 960) / 1920);
    expect(alignXf(c, 'bottom', half).y).toBeCloseTo((540 - 480) / 1080);
    expect(alignXf(c, 'center', { ...half, x: 0.2, y: -0.1 })).toEqual(half);
    expect(transformEditOf(c, { x: 0.123456, y: -0.00001, scale: 1.23456, rotation: -90 })).toEqual({ kind: 'clip', id: c.id, x: 0.1235, y: 0, scale: 1.2346, rotation: 270 });
    const live = withLiveTransform(m, c, { x: 0.1, y: 0, scale: 2, rotation: 0 });
    expect(live.tracks.video[0]!.transform).toEqual({ x: 0.1, y: 0, scale: 2, rotation: 0 });
    expect(m.tracks.video[0]!.transform).toBeUndefined();                                   // the head model is never changed
  });
});

describe('splitTargets (pure)', () => {
  it('selected items that play at the playhead (≥ 100 ms from their edges); nothing selected → the clip there', () => {
    const m = model(); const [c1, c2] = m.tracks.video; const img = m.tracks.overlay[0]!, t = m.tracks.text[0]!, a = m.tracks.audio[0]!;
    expect(splitTargets(m, [], 1500)).toEqual({ edit: { atMs: 1500, items: [{ kind: 'clip', id: c1!.id }] } });
    expect(splitTargets(m, [], 7000)).toEqual({ edit: { atMs: 7000, items: [{ kind: 'clip', id: c2!.id }] } });
    expect(splitTargets(m, [], 6050)).toEqual({ reason: 'nothing' });                        // 50 ms after the cut: too close to both edges
    expect(splitTargets(m, [{ kind: 'text', id: t.id }, { kind: 'image', id: img.id }, { kind: 'audio', id: a.id }, { kind: 'text', id: t.id }], 1500.4))
      .toEqual({ edit: { atMs: 1500, items: [{ kind: 'text', id: t.id }, { kind: 'image', id: img.id }, { kind: 'audio', id: a.id }] } });
    expect(splitTargets(m, [{ kind: 'text', id: t.id }], 5000)).toEqual({ reason: 'outside' });
    expect(splitTargets(m, [{ kind: 'cut', index: 0 }], 1500)).toEqual({ edit: { atMs: 1500, items: [{ kind: 'clip', id: c1!.id }] } });   // not splittable → as if nothing selected
  });
});

describe('canvas handles and split in the Editor (mock Local Service)', () => {
  async function setup(): Promise<{ runtime: Runtime; pid: string; head: () => Promise<CompositionModelT> }> {
    const { runtime } = await renderEditor('sample');                                       // 9:16; three 1080×1920 image clips of 5 s
    const pid = runtime.seededProjectId!;
    const head = async () => (await runtime.api.getComposition(pid)).head.model!;
    return { runtime, pid, head };
  }
  const selectClip = async (i = 0) => { await act(async () => { fireEvent.click(document.querySelectorAll<HTMLElement>('[data-el="stage.timeline.element"][data-kind="clip"]')[i]!); }); await waitFor(() => { if (!el('stage.player.canvas.box')) throw new Error('no box'); }); };
  /** Screen px per frame unit: the Player fits 1080 × 1920 into the default 640 × 360 box minus 32 px (no ResizeObserver size in jsdom). */
  const K = Math.floor(1080 * Math.min(608 / 1080, 328 / 1920)) / 1080;
  const transformPicks = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => (c as unknown as [string, { transformEdit?: unknown }])[1].transformEdit).filter(Boolean);

  it('drag inside the box moves the picture live, then one pick on release; undo restores it', async () => {
    const { runtime, pid, head } = await setup();
    await selectClip();
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const box = el('stage.player.canvas.box')!;
    expect(box.getAttribute('data-kind')).toBe('clip');
    await act(async () => {
      fireEvent.pointerDown(box, { clientX: 92, clientY: 160, button: 0 });
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 92 + 270 * K, clientY: 160 }));
    });
    expect(el('stage.player.canvas.box')!.getAttribute('data-x')).toBe('0.2500');            // live (optimistic) preview
    expect(el('stage.player.canvas.box')!.getAttribute('data-gesture')).toBe('move');
    expect(transformPicks(spy)).toEqual([]);                                                  // nothing sent while dragging
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 92 + 270 * K, clientY: 160 })); });
    await waitFor(async () => { if (!(await head()).tracks.video[0]!.transform) throw new Error('not applied'); });
    expect(transformPicks(spy)).toEqual([{ kind: 'clip', id: box.getAttribute('data-element-id'), x: 0.25, y: 0, scale: 1, rotation: 0 }]);
    expect((await head()).tracks.video[0]!.transform).toEqual({ x: 0.25, y: 0, scale: 1, rotation: 0 });
    await act(async () => { await runtime.api.undo(pid); });
    await waitFor(async () => { if ((await head()).tracks.video[0]!.transform) throw new Error('not undone'); });
  }, 20_000);

  it('a drag near the centre shows a snap guide; Esc cancels the gesture without a pick and keeps the selection', async () => {
    const { runtime } = await setup();
    await selectClip();
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const box = el('stage.player.canvas.box')!;
    await act(async () => {
      fireEvent.pointerDown(box, { clientX: 92, clientY: 160, button: 0 });
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 92 + 4, clientY: 160 + 60 }));   // x within 6 px of the centre line
    });
    expect([...document.querySelectorAll('[data-el="stage.player.canvas.guide"]')].map((g) => [g.getAttribute('data-axis'), g.getAttribute('data-at')])).toContainEqual(['x', '540']);
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(el('stage.player.canvas.guide')).toBeNull();
    expect(el('stage.player.canvas.box')!.getAttribute('data-y')).toBe('0.0000');
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 100, clientY: 220 })); });
    expect(transformPicks(spy)).toEqual([]);
    expect(el('stage.timeline.inspector')).not.toBeNull();                                    // the global Esc did not clear the selection
  }, 20_000);

  it('corner handle scales from the opposite corner (Shift: from the centre); rotation handle with Shift snaps to 90°; double-click resets', async () => {
    const { runtime, head } = await setup();
    await selectClip();
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const handle = (h: string) => document.querySelector<HTMLElement>(`[data-el="stage.player.canvas.handle"][data-handle="${h}"]`)!;
    const se = { x: 1080 * K, y: 1920 * K };
    await act(async () => {
      fireEvent.pointerDown(handle('se'), { clientX: se.x, clientY: se.y, button: 0 });
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: se.x / 2, clientY: se.y / 2 }));    // half the diagonal from nw
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: se.x / 2, clientY: se.y / 2 }));
    });
    await waitFor(async () => { if (!(await head()).tracks.video[0]!.transform) throw new Error('no scale'); });
    expect(transformPicks(spy).at(-1)).toMatchObject({ scale: 0.5, x: -0.25, y: -0.25, rotation: 0 });
    await waitFor(() => { if (el('stage.player.canvas.box')!.getAttribute('data-scale') !== '0.5000') throw new Error('box not updated'); });
    const c = { x: 270 * K, y: 480 * K };                                                       // the centre now
    await act(async () => {
      fireEvent.pointerDown(handle('rotate'), { clientX: c.x, clientY: c.y - 100, button: 0 });
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: c.x + 100, clientY: c.y + 8, shiftKey: true }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: c.x + 100, clientY: c.y + 8, shiftKey: true }));
    });
    await waitFor(async () => { if ((await head()).tracks.video[0]!.transform?.rotation !== 90) throw new Error('no rotation'); });
    await act(async () => { fireEvent.doubleClick(el('stage.player.canvas.box')!); });
    await waitFor(async () => { if ((await head()).tracks.video[0]!.transform) throw new Error('not reset'); });
    expect(transformPicks(spy).at(-1)).toMatchObject({ x: 0, y: 0, scale: 1, rotation: 0 });
    expect(document.querySelector('[data-el="agent.editor.intentqueue"]')?.textContent).toContain('Position, zoom or rotation');
  }, 20_000);

  it('Inspector fields: X % applies on Enter, align left and Reset are one pick each', async () => {
    const { runtime, head } = await setup();
    await selectClip();
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const scale = el('stage.timeline.inspector.transform.scale') as HTMLInputElement;
    await act(async () => { fireEvent.change(scale, { target: { value: '50' } }); fireEvent.keyDown(scale, { key: 'Enter' }); });
    await waitFor(async () => { if ((await head()).tracks.video[0]!.transform?.scale !== 0.5) throw new Error('no scale'); });
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.inspector.transform.align"][data-align="left"]')!); });
    await waitFor(async () => { if ((await head()).tracks.video[0]!.transform?.x !== -0.25) throw new Error('not aligned'); });
    const x = el('stage.timeline.inspector.transform.x') as HTMLInputElement;
    await waitFor(() => { if (x.value !== '-25') throw new Error(`field ${x.value}`); });
    await act(async () => { fireEvent.change(x, { target: { value: '10' } }); fireEvent.keyDown(x, { key: 'Escape' }); });
    expect(x.value).toBe('-25');                                                                 // Esc reverts the field
    await act(async () => { fireEvent.click(el('stage.timeline.inspector.transform.reset')!); });
    await waitFor(async () => { if ((await head()).tracks.video[0]!.transform) throw new Error('not reset'); });
    expect(transformPicks(spy)).toEqual([expect.objectContaining({ scale: 0.5, x: 0 }), expect.objectContaining({ scale: 0.5, x: -0.25 }), { kind: 'clip', id: expect.any(String), x: 0, y: 0, scale: 1, rotation: 0 }]);
  }, 20_000);

  it('S splits the clip under the playhead; the scissors split every selected item there in ONE pick (one undo)', async () => {
    const { runtime, pid, head } = await setup();
    const spy = vi.spyOn(runtime.api, 'createIntent');
    await act(async () => { fireEvent.keyDown(document.body, { key: 's' }); });               // playhead at 0: nothing to split
    expect(spy).not.toHaveBeenCalled();
    await act(async () => { playerBus.get()!.seekMs(2000); });
    await act(async () => { fireEvent.keyDown(document.body, { key: 's' }); });
    await waitFor(async () => { if ((await head()).tracks.video.length !== 4) throw new Error('not split'); });
    const m = await head();
    expect(m.tracks.video.map((c) => [c.durationMs, c.trimBeforeMs])).toEqual([[2000, 0], [3000, 0], [5000, 0], [5000, 0]]);
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ splitEdit: { atMs: 2000, items: [{ kind: 'clip', id: m.tracks.video[0]!.id }] } });
    await act(async () => { await runtime.api.undo(pid); });
    await waitFor(async () => { if ((await head()).tracks.video.length !== 3) throw new Error('not undone'); });
    // A title 0–3 s and clip 1 selected (Ctrl+click): one scissors press splits both at 2 s.
    const base = async () => (await runtime.api.getComposition(pid)).head.hash;
    await act(async () => { await runtime.api.createIntent(pid, { source: 'ui', category: 'text', presetId: 'preset:text.title', text: 'Judul', target: { kind: 'playhead' }, playheadMs: 0, baseVersion: await base(), plan: 'auto' }); });
    await waitFor(() => { if (!document.querySelector('[data-el="stage.timeline.element"][data-kind="text"]')) throw new Error('no text'); });
    await act(async () => { playerBus.get()!.seekMs(2000); });
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.element"][data-kind="text"]')!); });
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.element"][data-kind="clip"]')!, { ctrlKey: true }); });
    const before = await base();
    await act(async () => { fireEvent.click(el('stage.timeline.split')!); });
    await waitFor(async () => { const h = await head(); if (h.tracks.text.length !== 2 || h.tracks.video.length !== 4) throw new Error('not both'); });
    expect(spy.mock.calls.at(-1)![1].splitEdit!.items.map((x) => x.kind)).toEqual(['text', 'clip']);
    expect((await head()).tracks.text.map((x) => [x.timing.atMs, x.timing.durationMs])).toEqual([[0, 2000], [2000, 1000]]);
    await act(async () => { await runtime.api.undo(pid); });
    await waitFor(async () => { if ((await base()) !== before) throw new Error('one undo does not restore both'); });
  }, 30_000);
});
