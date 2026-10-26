// @vitest-environment jsdom
// GS-23 / ADR-030: a video built from scene clips only (no media at all) renders through the same ExpertmotionTimeline the
// renderer uses: every scene paints its background preset and its title, transitions sit between them (Thumbnail at a frame).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Thumbnail } from '@remotion/player';
import { applyOperations, createEmptyModel, deriveFrameTiming, deriveTiming, validate, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { ExpertmotionTimeline, EMPTY_INPUT, type EngineInputProps } from '../src/index.js';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

// The recorded Editor Agent reply of GS-23 (packages/agents/test/golden/fixtures): its composition step, applied as Execute does.
const reply = JSON.parse(fs.readFileSync(path.resolve(process.cwd().endsWith('engine') ? '../..' : '.', 'packages/agents/test/golden/fixtures/gs-23-editor-reply.json'), 'utf8')) as { steps: Array<{ tool: string; ops: OperationT[] }> };
function facelessModel(): CompositionModelT {
  let n = 0;
  const ops = reply.steps.filter((s) => s.tool === 'composition.applyOps').flatMap((s) => s.ops);
  const r = applyOperations(createEmptyModel('p', { autoRatio: false, ratio: '9:16' }), ops, { assets: [], tier: 'T1', newId: () => `e${++n}` });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
function frameAt(m: CompositionModelT, frame: number): HTMLElement {
  const host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  const props: EngineInputProps = { ...EMPTY_INPUT, model: m };
  act(() => root!.render(<Thumbnail component={ExpertmotionTimeline} inputProps={props} compositionWidth={1080} compositionHeight={1920} durationInFrames={deriveFrameTiming(m).durationInFrames} fps={30} frameToDisplay={frame} />));
  return host;
}

describe('GS-23 faceless video renders without any media', () => {
  it('the composition is valid with ≥ 3 scene clips, transitions and a non-zero duration', () => {
    const m = facelessModel();
    expect(m.tracks.video.length).toBeGreaterThanOrEqual(3);
    expect(m.transitions.length).toBe(m.tracks.video.length - 1);
    expect(deriveFrameTiming(m).durationInFrames).toBeGreaterThan(0);
    expect(validate(m, { assets: [], tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
  });
  it('each scene paints its background preset and its title at a frame in its middle', () => {
    const m = facelessModel();
    const t = deriveTiming(m); const fps = m.settings.fps;
    m.tracks.video.forEach((c, i) => {
      const mid = Math.round(((t.clipStartMs[i]! + c.durationMs / 2) / 1000) * fps);
      const host = frameAt(m, mid);
      expect(host.querySelector(`[data-em-scene="${c.scene!.presetId}"]`)).not.toBeNull();
      const title = m.tracks.text.find((x) => x.timing.atMs <= t.clipStartMs[i]! + c.durationMs / 2 && x.timing.atMs + x.timing.durationMs > t.clipStartMs[i]! + c.durationMs / 2)!;
      expect(host.textContent).toContain(title.text.split(' ')[0]);
      act(() => root?.unmount()); root = null; document.body.innerHTML = '';
    });
  });
  it('during a transition both neighbouring scenes are on screen', () => {
    const m = facelessModel();
    const t = deriveTiming(m); const fps = m.settings.fps;
    const cut = t.cutStartMs[0]!;                                         // scene 2 starts here, overlapping scene 1 by the transition
    const host = frameAt(m, Math.round(((cut + 150) / 1000) * fps));
    expect(host.querySelectorAll('[data-em-scene]').length).toBe(2);
  });
});
