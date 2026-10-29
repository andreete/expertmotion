// QA P1 2026-10-29 (thumbnail follow-up): the nikel cover read "US$ 24,64" — the still was grabbed mid-counter (final 25,96).
// The capture time is after every entrance motion and counter of that scene and before any exit. Nikel scene 2 ("ANGKA UTAMA").
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, deriveTiming, type CompositionModelT } from '@expertmotion/composition-model';
import { leavesAtMs, settledAtMs, settledCaptureMs } from '../../src/s2/thumbnail-frame.js';

let n = 0;
const newId = () => `01ARZ3NDEKTSV4RRFFQ69J${String(++n).padStart(4, '0')}`;
/** Scene 1 (4 s) + nikel scene 2 (7 s): "US$" rises in, the counter 0,00 → 25,96 over 54 frames (1800 ms) after a 300 ms delay,
 *  "miliar" pops in, and near 60 % "setara Rp472 triliun" fades in; every text exits at the end of the scene. */
function nikel(): { model: CompositionModelT; scene2: number } {
  const base = createEmptyModel('Nikel', { autoRatio: false, ratio: '9:16', resolution: '1080p', fps: 30 });
  const S2 = 4000;
  const r = applyOperations(base, [
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 4000 } },
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 7000 } },
    { op: 'op:text.add', args: { text: 'US$', variant: 'preset:text.subtitle', atMs: S2, durationMs: 7000, motion: { presetId: 'preset:motion.rise', durationMs: 500 } } },
    { op: 'op:text.add', args: { text: '25,96', variant: 'preset:text.title', atMs: S2 + 200, durationMs: 6800, motion: { presetId: 'preset:motion.fade-in', durationMs: 300 },
      effect: { presetId: 'preset:texteffect.counter', params: { from: 0, durationMs: 1800, delayMs: 300 } } } },
    { op: 'op:text.add', args: { text: 'miliar', variant: 'preset:text.subtitle', atMs: S2 + 400, durationMs: 6600, motion: { presetId: 'preset:motion.pop', durationMs: 400 } } },
    { op: 'op:text.add', args: { text: 'setara Rp472 triliun', variant: 'preset:text.subtitle', atMs: S2 + 4200, durationMs: 2800, motion: { presetId: 'preset:motion.fade-in', durationMs: 600 } } },
  ] as never, { assets: [], tier: 'T0', newId });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return { model: r.value.model, scene2: S2 };
}

describe('QA P1: thumbnail capture after counters and entrances', () => {
  it('nikel scene 2 asked at its first frame: captured after the counter reached 25,96 and every entrance, before any exit', () => {
    const { model, scene2 } = nikel();
    const counter = model.tracks.text.find((t) => t.text === '25,96')!;
    expect(counter.effect?.presetId).toBe('preset:texteffect.counter');
    const at = settledCaptureMs(model, scene2);
    expect(at).toBeGreaterThanOrEqual(scene2 + 200 + 300 + 1800);                         // counter: start + delay + duration
    for (const t of model.tracks.text) {
      expect(at, t.text).toBeGreaterThanOrEqual(settledAtMs(t as never));                 // "setara Rp472 triliun" (fade-in at 60 %) included
      expect(at, t.text).toBeLessThan(leavesAtMs(t as never));                            // nothing has started to leave
    }
    expect(at).toBeLessThan(scene2 + 7000);
    // the counter's own progress at the captured frame is complete (frame inside the layer ≥ delay + duration in frames)
    const fps = model.settings.fps; const f = Math.round(((at - counter.timing.atMs) / 1000) * fps);
    expect(f).toBeGreaterThanOrEqual(Math.round((300 / 1000) * fps) + Math.round((1800 / 1000) * fps));
  });

  it('a frame asked mid-counter moves forward; a frame already settled stays; an empty scene keeps the asked time', () => {
    const { model, scene2 } = nikel();
    expect(settledCaptureMs(model, scene2 + 1000)).toBe(settledCaptureMs(model, scene2));
    const late = scene2 + 5500;
    expect(settledCaptureMs(model, late)).toBe(late);
    expect(settledCaptureMs(model, 1000)).toBe(1000);                                     // scene 1 has no elements
    expect(settledCaptureMs(model, 1e9)).toBeLessThan(deriveTiming(model).durationMs);
  });
});
