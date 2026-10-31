import { describe, expect, it } from 'vitest';
import { analysis as A } from '../../src/index.js';

const sine = (sr: number, ms: number, hz: number, amp = 0.5): Int16Array => { const n = Math.round((sr * ms) / 1000); const out = new Int16Array(n); for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * amp * 32767); return out; };

describe('analysis/pcm', () => {
  it('rmsEnvelopeDb: silence is the floor, a full-scale sine is about −3 dBFS, one value per hop', () => {
    const silent = A.rmsEnvelopeDb(new Int16Array(16000), 16000, 10);
    expect(silent.length).toBe(100);
    expect(silent[0]).toBe(A.DB_FLOOR);
    const loud = A.rmsEnvelopeDb(sine(16000, 1000, 440, 1), 16000, 10);
    expect(loud[50]).toBeGreaterThan(-3.3); expect(loud[50]).toBeLessThan(-2.7);
    const half = A.rmsEnvelopeDb(sine(16000, 1000, 440, 0.5), 16000, 20);
    expect(half.length).toBe(50); expect(half[10]).toBeGreaterThan(-9.3); expect(half[10]).toBeLessThan(-8.7);
  });
  it('zscore, percentile, median', () => {
    const z = A.zscore([1, 2, 3, 4, 5]);
    expect(z[2]).toBeCloseTo(0, 9); expect(z[4]).toBeCloseTo(Math.SQRT2, 6);
    expect(Array.from(A.zscore([3, 3, 3]))).toEqual([0, 0, 0]);
    expect(A.percentile([5, 1, 4, 2, 3], 0)).toBe(1); expect(A.percentile([5, 1, 4, 2, 3], 1)).toBe(5); expect(A.percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(A.median([9, 1, 5])).toBe(5); expect(Number.isNaN(A.percentile([], 0.5))).toBe(true);
  });
  it('writeWav16 / readWav16 round-trip, pcmFromS16le odd offset, peakDb', () => {
    const pcm = sine(8000, 100, 1000, 0.25);
    const wav = A.writeWav16(pcm, 8000);
    expect(wav.byteLength).toBe(44 + pcm.length * 2);
    const back = A.readWav16(wav);
    expect(back.sampleRate).toBe(8000); expect(Array.from(back.pcm)).toEqual(Array.from(pcm));
    const bytes = new Uint8Array(7); bytes.set([0, 1, 2, 3, 4, 5], 1);                 // odd byte offset view → copied
    const view = A.pcmFromS16le(bytes.subarray(1));
    expect(view.length).toBe(3); expect(view[0]).toBe(0x0100);
    expect(A.peakDb(new Int16Array(10))).toBe(A.DB_FLOOR);
    expect(A.peakDb(Int16Array.from([0, 16384, -100]))).toBeCloseTo(-6.02, 1);
  });
});
