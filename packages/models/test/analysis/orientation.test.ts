import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analysis as A } from '../../src/index.js';
import { RAW_VIDEO, decodeGrayFrame, kitReady } from './kit.js';

/** A synthetic upright room: bright ceiling fading to a dark floor, a few horizontal shelf lines, one vertical door edge. */
function room(w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 200 - (120 * y) / h;                                              // lit from above
    if ([0.35, 0.5, 0.65, 0.8].some((f) => Math.abs(y - f * h) < 1.5)) v -= 90; // shelves / desk / floor line
    if (Math.abs(x - 0.2 * w) < 1.5 && y > 0.1 * h && y < 0.7 * h) v -= 60;   // a door frame
    v += ((x * 7 + y * 13) % 11) - 5;                                         // mild texture
    g[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return g;
}

describe('analysis/orientation (synthetic)', () => {
  const up = room(160, 90);
  it('an upright landscape room needs no rotation', () => {
    const r = A.suggestRotation(up, 160, 90);
    expect(r.rotation).toBe(0); expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });
  it('the same room stored sideways is detected with the right direction (90 cw vs 270)', () => {
    const cw = A.rotateGray(up, 160, 90, 270);                                 // stored after a 270° turn → needs 90° cw to come back
    const r90 = A.suggestRotation(cw.gray, cw.w, cw.h);
    expect(r90.rotation).toBe(90); expect(r90.confidence).toBeGreaterThanOrEqual(0.7);
    const ccw = A.rotateGray(up, 160, 90, 90);
    const r270 = A.suggestRotation(ccw.gray, ccw.w, ccw.h);
    expect(r270.rotation).toBe(270); expect(r270.confidence).toBeGreaterThanOrEqual(0.7);
  });
  it('rotateGray is exact and reversible; tiny frames give no confidence', () => {
    const g = Uint8Array.from([1, 2, 3, 4, 5, 6]);                              // 3×2
    const r = A.rotateGray(g, 3, 2, 90);
    expect(r).toEqual({ gray: Uint8Array.from([4, 1, 5, 2, 6, 3]), w: 2, h: 3 });
    const back = A.rotateGray(r.gray, r.w, r.h, 270);
    expect(Array.from(back.gray)).toEqual(Array.from(g));
    expect(Array.from(A.rotateGray(g, 3, 2, 180).gray)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(A.suggestRotation(new Uint8Array(16), 4, 4).confidence).toBe(0);
  });
});

describe.skipIf(!kitReady() || !existsSync(RAW_VIDEO))('analysis/orientation (Reels 42 kit)', () => {
  it('the sideways camera file (no rotation flag) is recognised as needing a 90° clockwise turn on sampled frames', () => {
    const votes: Record<string, number> = {}; const guesses: string[] = [];
    for (const at of [20, 50, 80, 110]) {
      const f = decodeGrayFrame(RAW_VIDEO, at, 160);
      const r = A.suggestRotation(f.gray, f.w, f.h);
      guesses.push(`${at}s → ${r.rotation} (conf ${r.confidence}, edges ${r.edgeRatio}, slope ${r.brightnessSlope})`);
      votes[r.rotation] = (votes[r.rotation] ?? 0) + r.confidence;
    }
    // eslint-disable-next-line no-console
    console.log(`[kit] rotation guesses: ${guesses.join('; ')}`);
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]!;
    expect(best[0]).toBe('90');
  });
});
