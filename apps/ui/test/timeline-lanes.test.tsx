// @vitest-environment jsdom
// ADR-027 / FR-068 / IX-26: CapCut-style Timeline lanes. Top row = front-most layer; texts, images, shapes and audio bars drag in
// time and across lanes, trim at their edges, snap to the playhead and other edges (Alt disables), show a live ghost, have keyboard
// alternatives, and every gesture is one undoable Compile pick (op:element.setTiming / op:element.setLayer).
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { applyOperations, createEmptyModel, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { renderEditor, el } from './setup-dom.js';
import { buildBars, elementDragEdit, laneRows, ROW_PX, type ElementDragOptions } from '../src/stage/Timeline.js';
import type { Runtime } from '../src/state/runtime.js';

afterEach(() => cleanup());
if (typeof window !== 'undefined' && !('PointerEvent' in window)) (window as unknown as Record<string, unknown>)['PointerEvent'] = MouseEvent;

const ASSETS = [{ id: 'v', kind: 'video' as const, status: 'ready' as const, durationMs: 20_000 }, { id: 'img', kind: 'image' as const, status: 'ready' as const, width: 10, height: 10 }, { id: 'vo', kind: 'audio' as const, status: 'ready' as const, durationMs: 4000 }];
function model(extra: OperationT[] = []): CompositionModelT {
  let n = 0;
  const r = applyOperations(createEmptyModel('p', { autoRatio: false, fps: 30 }), [{ op: 'op:clip.insert', args: { assetId: 'v', durationMs: 10_000 } },
    { op: 'op:text.add', args: { text: 'Judul', variant: 'preset:text.title', atMs: 0, durationMs: 3000 } }, { op: 'op:overlay.addImage', args: { assetId: 'img', atMs: 0, durationMs: 5000 } },
    { op: 'op:audio.addLayer', args: { assetId: 'vo', atMs: 1000, volume: 1 } }, ...extra], { assets: ASSETS, tier: 'T1', newId: () => `e${++n}` });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
const PX = 0.1;                                                         // 100 px per second
const opts = (m: CompositionModelT, over: Partial<ElementDragOptions> = {}): ElementDragOptions => ({ pxPerMs: PX, playheadMs: 0, snap: true, assetOf: (id) => ({ durationMs: ASSETS.find((a) => a.id === id)?.durationMs ?? null }),
  edges: [0, 10_000, ...buildBars(m, (x) => x, 'en').flatMap((b) => [b.fromMs, b.toMs])], ...over });
const bar = (m: CompositionModelT, id: string) => buildBars(m, (x) => x, 'en').find((b) => b.id === id)!;

describe('lane rows and bars (pure)', () => {
  it('rows top → bottom: captions, a new-layer lane, layers front → back, video, audio lanes, a new audio lane', () => {
    const m = model();
    expect(laneRows(m).map((r) => r.key)).toEqual(['caption', 'layer:2', 'layer:1', 'layer:0', 'video', 'audio:0', 'audio:1']);
    expect(laneRows(m).filter((r) => r.isNew).map((r) => r.key)).toEqual(['layer:2', 'audio:1']);
    const bars = buildBars(m, (x) => x, 'en');
    expect(bars.find((b) => b.kind === 'image')).toMatchObject({ row: 'layer:1', lane: 1, ref: { kind: 'image' } });   // the image went in front of the title
    expect(bars.find((b) => b.kind === 'text')).toMatchObject({ row: 'layer:0' });
    expect(laneRows(createEmptyModel('x')).map((r) => r.key)).toEqual(['caption', 'layer:0', 'video', 'audio:0']);
  });
});

describe('elementDragEdit (pure)', () => {
  it('move: frame grid, snapping to other edges and the playhead within 8 px, Alt off', () => {
    const m = model(); const t = m.tracks.text[0]!;
    expect(elementDragEdit(m, bar(m, t.id), 'move', 123, 0, opts(m, { edges: [] }))?.edit).toEqual({ kind: 'text', id: t.id, atMs: 1233, durationMs: 3000 });   // 1230 ms → frame 37 (1233 ms)
    const snapEnd = elementDragEdit(m, bar(m, t.id), 'move', 196, 0, opts(m));                  // end 4960 → image end 5000
    expect([snapEnd?.edit?.atMs, snapEnd?.snapMs]).toEqual([2000, 5000]);
    const head = elementDragEdit(m, bar(m, t.id), 'move', 705, 0, opts(m, { playheadMs: 7000 }));  // start 7050 → playhead 7000
    expect([head?.edit?.atMs, head?.snapMs]).toEqual([7000, 7000]);
    const alt = elementDragEdit(m, bar(m, t.id), 'move', 705, 0, opts(m, { playheadMs: 7000, snap: false }));
    expect([alt?.edit?.atMs, alt?.snapMs]).toEqual([7033, null]);                            // 7050 ms → frame 211 (7033 ms)
    expect(elementDragEdit(m, bar(m, t.id), 'move', -500, 0, opts(m))?.edit).toBeNull();     // cannot go before 0
  });
  it('move across lanes: one row up per ROW_PX; the new lane above the top opens a lane; clamped to the layer rows', () => {
    const m = model(); const t = m.tracks.text[0]!;
    expect(elementDragEdit(m, bar(m, t.id), 'move', 0, -1, opts(m))).toMatchObject({ edit: { kind: 'text', id: t.id, layer: 1 }, row: 'layer:1' });
    expect(elementDragEdit(m, bar(m, t.id), 'move', 0, -2, opts(m))?.edit).toEqual({ kind: 'text', id: t.id, layer: 2 });
    expect(elementDragEdit(m, bar(m, t.id), 'move', 0, -9, opts(m))?.row).toBe('layer:2');
    expect(elementDragEdit(m, bar(m, t.id), 'move', 0, 3, opts(m))?.edit).toBeNull();        // the video row is not a layer: stays on layer 0
    expect(elementDragEdit(m, bar(m, t.id), 'move', 600, -1, opts(m, { edges: [] }))?.edit).toEqual({ kind: 'text', id: t.id, atMs: 6000, durationMs: 3000, layer: 1 });
    expect(ROW_PX).toBe(36);
  });
  it('trims: right and left edges with the 100 ms minimum; audio left trims move the source offset and stay inside the source', () => {
    const m = model(); const t = m.tracks.text[0]!, a = m.tracks.audio[0]!;
    expect(elementDragEdit(m, bar(m, t.id), 'end', -100, 0, opts(m, { edges: [] }))?.edit).toEqual({ kind: 'text', id: t.id, atMs: 0, durationMs: 2000 });
    expect(elementDragEdit(m, bar(m, t.id), 'end', -900, 0, opts(m, { edges: [] }))?.edit).toEqual({ kind: 'text', id: t.id, atMs: 0, durationMs: 100 });
    expect(elementDragEdit(m, bar(m, t.id), 'start', 100, -3, opts(m, { edges: [] }))?.edit).toEqual({ kind: 'text', id: t.id, atMs: 1000, durationMs: 2000 });   // trims never change lanes
    expect(elementDragEdit(m, bar(m, a.id), 'start', 50, 0, opts(m, { edges: [] }))?.edit).toEqual({ kind: 'audio', id: a.id, atMs: 1500, durationMs: 3500, trimBeforeMs: 500 });
    expect(elementDragEdit(m, bar(m, a.id), 'start', -50, 0, opts(m, { edges: [] }))?.edit).toBeNull();                        // nothing before the source start
    expect(elementDragEdit(m, bar(m, a.id), 'end', 300, 0, opts(m, { edges: [] }))?.edit).toBeNull();                          // nothing after the source end
  });
  it('audio moves stay on audio lanes', () => {
    const m = model(); const a = m.tracks.audio[0]!;
    expect(elementDragEdit(m, bar(m, a.id), 'move', 0, 1, opts(m))?.edit).toEqual({ kind: 'audio', id: a.id, layer: 1 });
    expect(elementDragEdit(m, bar(m, a.id), 'move', 0, -5, opts(m))?.edit).toBeNull();
  });
});

describe('Timeline lanes in the Editor (mock Local Service)', () => {
  async function setup(): Promise<{ runtime: Runtime; pid: string; head: () => Promise<CompositionModelT> }> {
    const { runtime } = await renderEditor('sample');
    const pid = runtime.seededProjectId!;
    const head = async () => (await runtime.api.getComposition(pid)).head.model!;
    const base = async () => (await runtime.api.getComposition(pid)).head.hash;
    await act(async () => { await runtime.api.createIntent(pid, { source: 'ui', category: 'text', presetId: 'preset:text.title', text: 'Judul', target: { kind: 'playhead' }, playheadMs: 0, baseVersion: await base(), plan: 'auto' }); });
    const img = (await runtime.api.listAssets(pid)).items[0]!.id;
    await act(async () => { await runtime.api.insertAssets(pid, { assetIds: [img], asOverlay: true, atMs: 0 }); });
    await waitFor(() => { if (document.querySelectorAll('[data-el="stage.timeline.lane.layer"]').length !== 2) throw new Error('no lanes'); });
    return { runtime, pid, head };
  }
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-el="stage.timeline"] [role="row"][data-row]')].map((r) => r.getAttribute('data-row'));
  const textBar = () => document.querySelector<HTMLElement>('[data-el="stage.timeline.element"][data-kind="text"]')!;
  const box = (n: HTMLElement) => { n.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 28, width: 100, height: 28, x: 0, y: 0, toJSON: () => ({}) }); return n; };

  it('draws the front-most layer on top, images and texts on their own lanes, a new lane and the video and audio rows', async () => {
    await setup();
    expect(rows()).toEqual(['caption', 'layer:2', 'layer:1', 'layer:0', 'video', 'audio:0']);
    expect(document.querySelector('[data-row="layer:1"] [data-kind="image"]')).not.toBeNull();
    expect(textBar().closest('[data-row]')?.getAttribute('data-row')).toBe('layer:0');
    expect(el('stage.timeline.lane.new')?.getAttribute('data-layer')).toBe('2');
    expect(textBar().getAttribute('aria-keyshortcuts')).toContain('Alt+ArrowUp');
    expect(document.querySelectorAll('[data-el="stage.timeline.element.handle"]').length).toBeGreaterThan(0);
  }, 20_000);

  it('a drag shows a live ghost and snap line, and the drop is one pick: time + lane in one op, lane rule applied, undoable', async () => {
    const { runtime, pid, head } = await setup();
    const pxPerMs = (600 - 8) / 15 / 1000;                             // fit zoom: 15 s sample in 600 px (jsdom has no ResizeObserver size)
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const b = box(textBar());
    const dx = Math.round(2000 * pxPerMs);                            // start ≈ 2 s; its end (≈ 5 s) snaps to the image end
    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 50, clientY: 100, button: 0 });
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 50 + dx, clientY: 100 - ROW_PX }));
    });
    const ghost = el('stage.timeline.ghost')!;
    expect(ghost.getAttribute('data-row')).toBe('layer:1');
    expect(ghost.getAttribute('data-from-ms')).toBe('2000');
    expect(el('stage.timeline.snap')?.getAttribute('data-ms')).toBe('5000');
    expect(b.getAttribute('data-dragging')).toBe('move');
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 50 + dx, clientY: 100 - ROW_PX })); });
    await waitFor(async () => { const t = (await head()).tracks.text[0]!; if (t.timing.atMs !== 2000) throw new Error(`not moved ${JSON.stringify(t.timing)}`); });
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ elementEdit: { kind: 'text', atMs: 2000, durationMs: 3000, layer: 1 } });
    const m = await head();
    expect([m.tracks.text[0]!.layer, m.tracks.overlay[0]!.layer]).toEqual([1, 0]);   // image busy on layer 1 → the title goes above it (then lanes are renumbered densely)
    expect(m.tracks.text[0]!.layer).toBeGreaterThan(m.tracks.overlay[0]!.layer);
    await waitFor(() => { if (textBar().closest('[data-row]')?.getAttribute('data-row') !== 'layer:1') throw new Error(`row ${rows().join(',')}`); });
    expect(el('stage.timeline.ghost')).toBeNull();
    await act(async () => { await runtime.api.undo(pid); });
    await waitFor(async () => { if ((await head()).tracks.text[0]!.timing.atMs !== 0) throw new Error('not undone'); });
  }, 20_000);

  it('Alt while dragging turns snapping off (frame grid only)', async () => {
    const { runtime } = await setup();
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const b = box(textBar());
    const dx = Math.round(1900 * ((600 - 8) / 15 / 1000));             // with snapping its end would snap to the image end (start 2000)
    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 50, clientY: 100, button: 0 });
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 50 + dx, clientY: 100, altKey: true }));
    });
    expect(el('stage.timeline.snap')).toBeNull();
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 50 + dx, clientY: 100, altKey: true })); });
    await waitFor(() => { if (!spy.mock.calls.some((c) => c[1].elementEdit)) throw new Error('no pick'); });
    const e = spy.mock.calls.find((c) => c[1].elementEdit)![1].elementEdit!;
    expect(e.atMs).not.toBe(2000);
    expect(Math.abs(e.atMs! - 1900)).toBeLessThan(40);
    expect(e.atMs! % 1).toBe(0);
    expect(e.layer).toBeUndefined();
  }, 20_000);

  it('edge drag trims; keyboard: → nudges one frame, Shift+← one second, Alt+↑/↓ change the lane (focus stays on the bar)', async () => {
    const { runtime, head } = await setup();
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const b = box(textBar());
    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 98, clientY: 100, button: 0 });                     // right edge
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 98 - 20, clientY: 140 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 98 - 20, clientY: 140 }));
    });
    await waitFor(() => { if (!spy.mock.calls.length) throw new Error('no trim'); });
    expect(spy.mock.calls.at(-1)![1].elementEdit).toMatchObject({ kind: 'text', atMs: 0 });
    expect(spy.mock.calls.at(-1)![1].elementEdit!.durationMs).toBeLessThan(3000);
    expect(spy.mock.calls.at(-1)![1].elementEdit!.layer).toBeUndefined();
    await waitFor(async () => { if ((await head()).tracks.text[0]!.timing.durationMs >= 3000) throw new Error('not trimmed'); });
    textBar().focus();
    await act(async () => { fireEvent.keyDown(textBar(), { key: 'ArrowRight' }); });
    await waitFor(async () => { if ((await head()).tracks.text[0]!.timing.atMs !== 33) throw new Error('no nudge'); });
    await act(async () => { fireEvent.keyDown(textBar(), { key: 'ArrowLeft', shiftKey: true }); });
    await waitFor(async () => { if ((await head()).tracks.text[0]!.timing.atMs !== 0) throw new Error('no shift nudge'); });
    await act(async () => { fireEvent.keyDown(textBar(), { key: 'ArrowUp', altKey: true }); });
    await waitFor(async () => { const m = await head(); if (!(m.tracks.text[0]!.layer > m.tracks.overlay[0]!.layer)) throw new Error('not up'); });
    expect(spy.mock.calls.at(-1)![1].elementEdit).toEqual({ kind: 'text', id: textBar().getAttribute('data-element-id'), move: 'up' });
    await waitFor(() => { if (document.activeElement !== textBar()) throw new Error('focus lost'); });
    await act(async () => { fireEvent.keyDown(textBar(), { key: 'ArrowDown', altKey: true }); });
    await waitFor(async () => { const m = await head(); if (!(m.tracks.text[0]!.layer < m.tracks.overlay[0]!.layer)) throw new Error('not down'); });
    expect(document.querySelector('[data-el="agent.editor.intentqueue"]')?.textContent).toContain('One layer down');
  }, 20_000);
});
