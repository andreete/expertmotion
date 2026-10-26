// @vitest-environment jsdom
// ADR-028: the picture transform is one pure CSS function used by the same ExpertmotionTimeline in the Player and the render
// (parity). Checks the computed style strings and that the real timeline puts them on the DOM (Remotion Thumbnail, jsdom).
import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Thumbnail } from '@remotion/player';
import { applyOperations, createEmptyModel, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { ExpertmotionTimeline, EMPTY_INPUT, clipTransformStyle, overlayTransform, type EngineInputProps } from '../src/index.js';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
function model(ops: (ids: { clip: string; image: string }) => OperationT[]): CompositionModelT {
  let n = 0;
  const assets = [{ id: 'img', kind: 'image' as const, status: 'ready' as const, width: 1000, height: 1000 }];
  const c = { assets, tier: 'T1' as const, newId: () => `e${++n}` };
  const r0 = applyOperations(createEmptyModel('p', { autoRatio: false, ratio: '16:9' }), [{ op: 'op:clip.insert', args: { assetId: 'img', durationMs: 3000 } }, { op: 'op:overlay.addImage', args: { assetId: 'img', atMs: 0, durationMs: 3000 } }], c);
  if (!r0.ok) throw new Error(JSON.stringify(r0.issues));
  const r = applyOperations(r0.value.model, ops({ clip: r0.value.model.tracks.video[0]!.id, image: r0.value.model.tracks.overlay[0]!.id }), c);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
function render(m: CompositionModelT): HTMLElement {
  const host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  const props: EngineInputProps = { ...EMPTY_INPUT, model: m, assets: { img: { kind: 'image', playable: PNG, width: 1000, height: 1000 } } };
  act(() => root!.render(<Thumbnail component={ExpertmotionTimeline} inputProps={props} compositionWidth={1920} compositionHeight={1080} durationInFrames={90} fps={30} frameToDisplay={15} />));
  return host;
}

describe('ADR-028 transform CSS (preview = render)', () => {
  it('clipTransformStyle: identity → no style; otherwise translate by frame fractions, rotate, scale around the centre', () => {
    expect(clipTransformStyle(undefined, 1920, 1080)).toEqual({});
    expect(clipTransformStyle({ x: 0, y: 0, scale: 1, rotation: 0 }, 1920, 1080)).toEqual({});
    expect(clipTransformStyle({ x: -0.1, y: 0.25, scale: 1.2, rotation: 90 }, 1920, 1080)).toEqual({ transform: 'translate(-192px, 270px) rotate(90deg) scale(1.2)', transformOrigin: '50% 50%' });
    expect(overlayTransform({})).toBe('translate(-50%, -50%)');
    expect(overlayTransform({ scale: 0.5, rotation: 30 })).toBe('translate(-50%, -50%) rotate(30deg) scale(0.5)');
  });
  it('the timeline puts exactly that style on the clip media wrapper, inside a frame that clips it', () => {
    const m = model(({ clip }) => [{ op: 'op:element.setTransform', target: { kind: 'clip', id: clip }, args: { x: -0.1, y: 0.25, scale: 1.2, rotation: 90 } }]);
    const host = render(m);
    const wrap = host.querySelector<HTMLElement>('[data-em-transform="clip"]');
    expect(wrap).not.toBeNull();
    expect(wrap!.style.transform).toBe('translate(-192px, 270px) rotate(90deg) scale(1.2)');
    expect(wrap!.parentElement!.style.overflow).toBe('hidden');
    expect(wrap!.querySelector('img')).not.toBeNull();
  });
  it('no transform stored → no transform on the media (the picture before ADR-028)', () => {
    const host = render(model(() => []));
    expect(host.querySelector('[data-em-transform]')).toBeNull();
  });
  it('image overlays get rotate + scale after the centring translate', () => {
    const m = model(({ image }) => [{ op: 'op:element.setTransform', target: { kind: 'image', id: image }, args: { scale: 0.5, rotation: 30 } }]);
    const host = render(m);
    const boxes = [...host.querySelectorAll<HTMLElement>('div')].filter((d) => d.style.transform.startsWith('translate(-50%, -50%)'));
    expect(boxes.map((b) => b.style.transform)).toEqual(['translate(-50%, -50%) rotate(30deg) scale(0.5)']);
  });
});
