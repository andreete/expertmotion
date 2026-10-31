import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analysis as A } from '../../src/index.js';
import { RAW_AUDIO, RAW_VIDEO, decodePcm16k, kitReady } from './kit.js';

const SR = 16000;
/** Speech-like signal: bursts of noise with an amplitude pattern, deterministic. */
function speechLike(ms: number, seed = 7): Int16Array {
  const n = Math.round((SR * ms) / 1000); const out = new Int16Array(n); let s = seed >>> 0;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1; };
  let at = 0;
  while (at < n) {
    const burst = Math.round(SR * (0.15 + 0.4 * Math.abs(rnd()))), gap = Math.round(SR * (0.1 + 0.5 * Math.abs(rnd()))); const amp = 0.2 + 0.6 * Math.abs(rnd());
    for (let i = 0; i < burst && at + i < n; i++) out[at + i] = Math.round(rnd() * amp * 32767 * Math.sin((Math.PI * i) / burst));
    at += burst + gap;
  }
  return out;
}
const concat = (...parts: Int16Array[]): Int16Array => { const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const noise = (ms: number, amp: number, seed: number): Int16Array => { const n = Math.round((SR * ms) / 1000); const out = new Int16Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = Math.round((s / 2147483648 - 1) * amp * 32767); } return out; };

describe('analysis/sync (synthetic)', () => {
  const ref = speechLike(30000);
  it('finds a positive offset when the other recording started earlier (± 2 ms) with room noise on both', () => {
    const other = concat(noise(3529, 0.01, 3), ref.map((v, i) => Math.round(v * 0.6 + noise(1, 0.02, i)[0]! * 0)));
    const r = A.syncOffset(ref, other, SR);
    expect(Math.abs(r.offsetMs - 3529)).toBeLessThanOrEqual(2);
    expect(r.points.length).toBeGreaterThanOrEqual(3);
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.driftMs).toBeLessThanOrEqual(5);
  });
  it('finds a negative offset when the other recording started later', () => {
    const other = ref.subarray(Math.round(SR * 1.2));
    const r = A.syncOffset(ref, other, SR);
    expect(Math.abs(r.offsetMs + 1200)).toBeLessThanOrEqual(2);
  });
  it('reports low confidence for unrelated signals and zero for empty input', () => {
    const r = A.syncOffset(ref, speechLike(30000, 99), SR);
    expect(r.confidence).toBeLessThan(0.5);
    expect(A.syncOffset(new Int16Array(10), ref, SR)).toMatchObject({ offsetMs: 0, confidence: 0 });
  });
  it('xcorrBest returns the lag where a[i] ≈ b[i + lag]', () => {
    const a = new Float64Array(40), b = new Float64Array(40); a[10] = 1; a[20] = 1; b[13] = 1; b[23] = 1;
    expect(A.xcorrBest(A.zscore(a), A.zscore(b), 8).lag).toBe(3);
    expect(A.xcorrBest(A.zscore(b), A.zscore(a), 8).lag).toBe(-3);
  });
});

describe.skipIf(!kitReady() || !existsSync(RAW_VIDEO))('analysis/sync (Reels 42 kit)', () => {
  it('camera started 3.536 s ± 10 ms before the recorder, refined at ≥ 3 points, confidence ≥ 0.5', () => {
    const audio = decodePcm16k(RAW_AUDIO), video = decodePcm16k(RAW_VIDEO);
    const t0 = Date.now();
    const r = A.syncOffset(audio, video, SR);
    // eslint-disable-next-line no-console
    console.log(`[kit] sync offset ${r.offsetMs} ms, coarse ${r.coarse.offsetMs} (r ${r.coarse.r}), points ${JSON.stringify(r.points)}, drift ${r.driftMs} ms, confidence ${r.confidence}, ${Date.now() - t0} ms`);
    expect(Math.abs(r.offsetMs - 3536)).toBeLessThanOrEqual(10);
    expect(r.points.length).toBeGreaterThanOrEqual(3);
    expect(r.driftMs).toBeLessThanOrEqual(20);
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });
});
