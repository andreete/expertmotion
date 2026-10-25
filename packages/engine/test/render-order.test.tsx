// @vitest-environment jsdom
// ADR-027: the Engine paints texts, images and shapes back → front by layer (DOM order = stacking order, captions on top),
// through the same ExpertmotionTimeline the renderer uses (preview/render parity). Rendered with Remotion's Thumbnail at a frame.
import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Thumbnail } from '@remotion/player';
import { applyOperations, createEmptyModel, visualStack, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { ExpertmotionTimeline, EMPTY_INPUT, type EngineInputProps } from '../src/index.js';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
let root: Root | null = null;
// jsdom has no font files: ensureFontsLoaded's fetches stay pending instead of rejecting (fonts do not affect DOM order).
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

function model(ops: OperationT[]): CompositionModelT {
  let n = 0;
  const r = applyOperations(createEmptyModel('p', { autoRatio: false, ratio: '9:16' }), ops, { assets: [{ id: 'img', kind: 'image', status: 'ready', width: 100, height: 100 }], tier: 'T1', newId: () => `e${++n}` });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
/** Texts and shapes painted at frame 15, in DOM order (back → front). */
function painted(m: CompositionModelT): string[] {
  const host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  const props: EngineInputProps = { ...EMPTY_INPUT, model: m };
  act(() => root!.render(<Thumbnail component={ExpertmotionTimeline} inputProps={props} compositionWidth={1080} compositionHeight={1920} durationInFrames={90} fps={30} frameToDisplay={15} />));
  return [...host.querySelectorAll('span, svg')].flatMap((n) => {
    if (n.tagName.toLowerCase() === 'svg') return n.closest('svg svg') ? [] : ['shape'];
    const t = n.textContent ?? '';
    return t && !n.querySelector('span') ? [t] : [];
  });
}

describe('Engine render order follows layers (preview = render)', () => {
  const ops: OperationT[] = [
    { op: 'op:text.add', args: { text: 'Judul', variant: 'preset:text.title', atMs: 0, durationMs: 3000 } },
    { op: 'op:shape.add', args: { presetId: 'preset:shape.circle', atMs: 0, durationMs: 3000 } },        // in front of the title
    { op: 'op:text.add', args: { text: 'Paling atas', variant: 'preset:text.subtitle', atMs: 0, durationMs: 3000 } },
  ];
  it('later layers are painted after (in front of) earlier ones, whatever the track', () => {
    const m = model(ops);
    expect(visualStack(m).map((x) => x.layer)).toEqual([0, 1, 2]);
    expect(painted(m)).toEqual(['Judul', 'shape', 'Paling atas']);
  });
  it('op:element.setLayer front moves the title in front of the shape and the other text', () => {
    const m0 = model(ops);
    const m = model([...ops, { op: 'op:element.setLayer', target: { kind: 'text', id: m0.tracks.text[0]!.id }, args: { move: 'front' } }]);
    expect(painted(m)).toEqual(['shape', 'Paling atas', 'Judul']);
  });
});
