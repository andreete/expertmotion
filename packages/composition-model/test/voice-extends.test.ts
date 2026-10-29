// A voice-over is never cut: with Clips, fit-content runs to the later of the Clip sequence and the last voice layer.
import { describe, expect, it } from 'vitest';
import { createEmptyModel, deriveFrameTiming, deriveTiming, validate } from '../src/index.js';
import { ASSETS, must, op } from './helpers.js';

const twoSecondClip = () => must(createEmptyModel('p1', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v1', durationMs: 2000 })]);

describe('voice-over extends a Clip project', () => {
  it('runs to the end of a voice longer than the Clips, in ms and frames, without a cut warning', () => {
    const m = must(twoSecondClip(), [op('op:audio.addLayer', { assetId: 'vo', atMs: 500, volume: 1, role: 'voice' })]);
    const t = deriveTiming(m);
    expect(t.durationMs).toBe(4500);
    expect(t.warnings.filter((w) => w.code === 'CM-005')).toEqual([]);
    expect(deriveFrameTiming(m).durationInFrames).toBe(Math.round(4.5 * m.settings.fps));
    expect(validate(m, { assets: ASSETS, tier: 'T1' }).filter((i) => i.code === 'CM-005')).toEqual([]);
  });
  it('keeps the Clip length when the voice is shorter, and a music bed never extends it', () => {
    const m = must(twoSecondClip(), [op('op:audio.addBed', { assetId: 'mus', volume: 0.3, loop: true })]);
    expect(deriveTiming(m).durationMs).toBe(2000);
    const short = must(createEmptyModel('p2', { autoRatio: false }), [op('op:clip.insert', { assetId: 'v1', durationMs: 6000 }), op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1, role: 'voice' })]);
    expect(deriveTiming(short).durationMs).toBe(6000);
  });
});
