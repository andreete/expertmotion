// FR-266: a ducked music bed keeps its own level between speech and dips by the duck-voice ratio under it.
import { describe, expect, it } from 'vitest';
import { duckedVolume } from '../src/audio-duck.js';

describe('duckedVolume (FR-266)', () => {
  it('the bed\'s own volume between speech; the preset ratio under speech (defaults 0.15 / 0.5 = 30 %)', () => {
    expect(duckedVolume(0.2, { volume: 0.5, duckTo: 0.15 }, 0)).toBeCloseTo(0.2);       // was 0.5 (the preset volume replaced the bed level)
    expect(duckedVolume(0.2, { volume: 0.5, duckTo: 0.15 }, 1)).toBeCloseTo(0.06);
    expect(duckedVolume(0.2, { volume: 0.5, duckTo: 0.15 }, 0.5)).toBeCloseTo(0.13);
  });
  it('the music step\'s duckingParams {volume: v, duckTo: 0.35 v} dip to 35 %; odd params stay inside 0…1', () => {
    expect(duckedVolume(0.25, { volume: 0.25, duckTo: 0.0875 }, 1)).toBeCloseTo(0.0875);
    expect(duckedVolume(0.8, { volume: 0, duckTo: 0.2 }, 1)).toBeCloseTo(0.24);
    expect(duckedVolume(1.4, { volume: 0.2, duckTo: 0.9 }, 1)).toBe(1);
    expect(duckedVolume(0.5, {}, 2)).toBeCloseTo(0.15);
  });
});
