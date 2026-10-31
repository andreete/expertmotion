import { describe, expect, it } from 'vitest';
import { analysis as A } from '../../src/index.js';
import { RAW_AUDIO, decodePcm16k, kitReady } from './kit.js';

/** Envelope (10 ms hops) that is `quietDb` except for the given loud windows (ms). */
const envOf = (totalMs: number, loud: Array<[number, number]>, loudDb = -20, quietDb = -60): A.EnvelopeDb => {
  const db = new Float64Array(totalMs / 10).fill(quietDb);
  for (const [a, b] of loud) for (let k = a / 10; k < b / 10; k++) db[k] = loudDb;
  return { db, hopMs: 10 };
};

describe('analysis/phrases (synthetic)', () => {
  it('phraseThreshold sits 35 % of the way from p10 to p97', () => {
    const e = envOf(10000, [[2000, 3000]]);
    expect(A.phraseThreshold(e.db)).toBeCloseTo(-60 + 0.35 * 40, 6);
  });
  it('findPhrases merges gaps < 250 ms, drops stretches < 500 ms, indexes in order', () => {
    const e = envOf(20000, [[1000, 2000], [2200, 3500], [5000, 5300], [8000, 9000], [9300, 10000]]);
    const ph = A.findPhrases(e);
    expect(ph.map((p) => [p.fromMs, p.toMs])).toEqual([[1000, 3500], [8000, 9000], [9300, 10000]]);
    expect(ph.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(ph[0]!.durationMs).toBe(2500);
    expect(A.findPhrases(e, { mergeGapMs: 400 }).map((p) => [p.fromMs, p.toMs])).toEqual([[1000, 3500], [8000, 10000]]);
    expect(A.findPhrases(e, { minMs: 200 })).toHaveLength(4);
    expect(A.findPhrases({ db: new Float64Array(100).fill(-60), hopMs: 10 })).toEqual([]);
  });
  it('silenceDbAt is the loudest frame of the window; isQuietAround and quietestFrame', () => {
    const e = envOf(5000, [[1000, 2000]], -20, -50);
    e.db[250] = -70;
    expect(A.silenceDbAt(e, 2050, 100)).toBe(-50);
    expect(A.silenceDbAt(e, 1990, 100)).toBe(-20);                       // the window reaches into the voice
    expect(A.isQuietAround(e, 3000, { maxDb: -43 })).toBe(true);
    expect(A.isQuietAround(e, 1500)).toBe(false);
    expect(A.quietestFrame(e, 2000, 3000)).toEqual({ ms: 2500, db: -70 });
  });
  it('voicedRanges splits at pauses ≥ minPauseMs only and drops blips', () => {
    const e = envOf(6000, [[1000, 2000], [2080, 3000], [3150, 4000], [4500, 4520]]);
    expect(A.voicedRanges(e, { thrDb: -40 })).toEqual([{ fromMs: 1000, toMs: 3000 }, { fromMs: 3150, toMs: 4000 }]);
    expect(A.voicedRanges(e, { thrDb: -40, minPauseMs: 60 })).toHaveLength(3);
    expect(A.voicedRanges(e, { thrDb: -40, fromMs: 3100, toMs: 5000 })).toEqual([{ fromMs: 3150, toMs: 4000 }]);
  });
});

describe.skipIf(!kitReady())('analysis/phrases (Reels 42 kit)', () => {
  it('finds 22 ± 2 phrases between 8 s and 121 s, each ≥ 500 ms', () => {
    const env = A.makeEnvelope(decodePcm16k(RAW_AUDIO), 16000, 10);
    const ph = A.findPhrases(env);
    // eslint-disable-next-line no-console
    console.log(`[kit] ${ph.length} phrases, threshold ${A.phraseThreshold(env.db).toFixed(1)} dB: ${ph.map((p) => `${(p.fromMs / 1000).toFixed(2)}-${(p.toMs / 1000).toFixed(2)}`).join(' ')}`);
    expect(Math.abs(ph.length - 22)).toBeLessThanOrEqual(2);
    expect(ph[0]!.fromMs).toBeGreaterThanOrEqual(8000);
    expect(ph.at(-1)!.toMs).toBeLessThanOrEqual(121500);
    for (const p of ph) expect(p.durationMs).toBeGreaterThanOrEqual(500);
    // the kept hook (8.14–14.54) starts at the first phrase; the gaps before the key's kept takes hold a quiet frame (≤ −43 dB)
    expect(Math.abs(ph[0]!.fromMs - 8260)).toBeLessThanOrEqual(50);
    for (const ms of [8140, 48720, 68720, 77990, 91470, 100440, 110250, 116340]) expect(A.quietestFrame(env, ms - 150, ms + 100).db, String(ms)).toBeLessThanOrEqual(-43);
  });
});
