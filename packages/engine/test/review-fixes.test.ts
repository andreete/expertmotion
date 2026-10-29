// @vitest-environment jsdom
// Regression tests for the adversarial review of 2026-10-29 (engine part): C4 a stored bezier with x outside 0..1 never throws
// (Remotion's Easing.bezier would, on every frame of preview and render); C9 keyword highlight matches words, not substrings.
import { describe, expect, it } from 'vitest';
import { Easing } from 'remotion';
import { safeBezier } from '../src/easing.js';
import { motionProgress } from '../src/motion.js';
import { isKeywordWord } from '../src/presets/text.js';

describe('C4 safeBezier', () => {
  it('Remotion itself throws for x outside 0..1 (the crash this guards against)', () => {
    expect(() => Easing.bezier(1.2, 0, 0.5, 1)).toThrow();
  });
  it('clamps x into 0..1 and y into -2..3; junk falls back to the default curve', () => {
    for (const v of [[1.2, 0, 0.5, 1], [-0.5, 0, 2, 1], [0.2, -9, 0.8, 9], ['a', 0, 1, 1], [NaN, 0, 1, 1], null, [1, 2]]) {
      const fn = safeBezier(v);
      for (const t of [0, 0.25, 0.5, 1]) expect(Number.isFinite(fn(t))).toBe(true);
    }
    expect(safeBezier([0.2, 0.8, 0.2, 1])(0.5)).toBeCloseTo(Easing.bezier(0.2, 0.8, 0.2, 1)(0.5), 6);
  });
  it('motionProgress with an old out-of-range bezier renders every frame', () => {
    const m = { durationMs: 600, delayMs: 0, params: { bezier: [1.2, 0, -0.5, 1] } };
    for (let f = 0; f <= 30; f += 5) { const p = motionProgress(m, f, 30, 'preset:easing.out-cubic'); expect(Number.isFinite(p)).toBe(true); }
    expect(motionProgress(m, 30, 30, 'preset:easing.out-cubic')).toBeCloseTo(1, 5);
  });
});

describe('C9 keyword highlight', () => {
  it('a one-letter keyword colours only that word; a keyword of 4+ letters also matches its suffixed forms', () => {
    expect(isKeywordWord('harga', ['a'])).toBe(false);
    expect(isKeywordWord('a', ['a'])).toBe(true);
    expect(isKeywordWord('Harganya,', ['harga'])).toBe(true);
    expect(isKeywordWord('beras', ['harga beras'])).toBe(true);
    expect(isKeywordWord('bera', ['beras'])).toBe(false);
    expect(isKeywordWord('naik', ['ikan'])).toBe(false);
  });
});
