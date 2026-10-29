// Regression tests for the 2026-10-29 review findings in packages/models (R4 R5 R6 R7 R9 is in download.test.ts).
import { describe, expect, it } from 'vitest';
import { alignWords, cuesToCaptionPages, encodeWav, energyFrames, peakRms, refineWordTimes, speechWindow, type EnergyFrame, type TranscriptCue } from '../src/index.js';
import { makeWav } from './helpers.js';

describe('R4: long voices (no Math.max spread over every 10 ms frame)', () => {
  const MIN25 = 25 * 60 * 1000;
  it('speechWindow handles 25 min of audio (150 000 frames)', () => {
    const wav = makeWav(MIN25, 1000, 2000);   // 1 kHz keeps the buffer at 3 MB; 10 samples per 10 ms frame
    const fr = energyFrames(wav)!;
    expect(fr.length).toBe(150_000);
    expect(peakRms(fr)).toBeGreaterThan(0);
    expect(speechWindow(wav)).toEqual({ fromMs: 0, toMs: MIN25 });
  });
  it('refineWordTimes handles 150 000 frames', () => {
    const frames: EnergyFrame[] = Array.from({ length: 150_000 }, (_, k) => ({ fromMs: k * 10, rms: k % 50 < 5 ? 0 : 0.5 }));
    const words = Array.from({ length: 3000 }, (_, k) => ({ fromMs: k * 500, toMs: k * 500 + 450 }));
    const out = refineWordTimes(words, frames);
    expect(out).toHaveLength(3000);
    for (let k = 1; k < out.length; k++) expect(out[k]!.fromMs).toBeGreaterThanOrEqual(out[k - 1]!.fromMs);
  });
  it('peakRms of an empty list is 0', () => { expect(peakRms([])).toBe(0); });
});

describe('R5: energyFrames rejects malformed WAV headers instead of looping or throwing', () => {
  const data = new Uint8Array(2000);
  it('blockAlign 0 returns null (was an endless loop)', () => {
    expect(energyFrames(encodeWav({ audioFormat: 1, channels: 1, sampleRate: 16000, blockAlign: 0, bitsPerSample: 16 }, data))).toBeNull();
  });
  it('blockAlign shorter than channels × 2 returns null (was a RangeError)', () => {
    expect(energyFrames(encodeWav({ audioFormat: 1, channels: 2, sampleRate: 16000, blockAlign: 2, bitsPerSample: 16 }, data))).toBeNull();
  });
  it('channels 0 returns null', () => {
    expect(energyFrames(encodeWav({ audioFormat: 1, channels: 0, sampleRate: 16000, blockAlign: 2, bitsPerSample: 16 }, data))).toBeNull();
  });
  it('a valid stereo header still works', () => {
    expect(energyFrames(encodeWav({ audioFormat: 1, channels: 2, sampleRate: 16000, blockAlign: 4, bitsPerSample: 16 }, data))!.length).toBe(4);
  });
});

describe('R6: caption tokens of a trimmed voice clip never invert', () => {
  it('words after untilMs get a zero-length range at the cut (fromMs <= toMs)', () => {
    const cue: TranscriptCue = { index: 0, text: 'satu dua tiga empat', written: 'satu dua tiga empat', fromMs: 0, toMs: 4000,
      words: ['satu', 'dua', 'tiga', 'empat'].map((t, k) => ({ text: t, fromMs: k * 1000, toMs: k * 1000 + 900, timed: 'aligned' as const })) };
    const pages = cuesToCaptionPages([cue], 10_000, { untilMs: 11_500 });
    expect(pages).toHaveLength(1);
    const end = pages[0]!.startMs + pages[0]!.durationMs;
    for (const t of pages[0]!.tokens) { expect(t.fromMs).toBeLessThanOrEqual(t.toMs); expect(t.toMs).toBeLessThanOrEqual(end); expect(t.fromMs).toBeGreaterThanOrEqual(pages[0]!.startMs); }
    expect(pages[0]!.tokens[3]).toMatchObject({ fromMs: 11_500, toMs: 11_500 });
  });
});

describe('R7: script alignment is bounded (band around the diagonal)', () => {
  const vocab = ['energi', 'bersih', 'indonesia', 'punya', 'melimpah', 'tapi', 'kenapa', 'belum', 'terasa', 'listrik', 'surya', 'angin', 'air', 'panas', 'bumi'];
  const words = (n: number, seed: number) => Array.from({ length: n }, (_, k) => vocab[(k * 7 + seed + Math.floor(k / 13)) % vocab.length]!);
  it('banded and full alignment agree on a near-diagonal input', () => {
    const a = words(400, 0); const b = a.map((w, k) => (k % 17 === 0 ? `${w}x` : w)).filter((_, k) => k % 31 !== 5);
    expect(alignWords(a, b, { band: 60 })).toEqual(alignWords(a, b));
  });
  it('3 000 × 3 500 words align in well under 2 s and every match is monotonic', () => {
    const a = words(3000, 1); const b = [...a.slice(0, 1500), ...words(500, 3), ...a.slice(1500)];
    const t0 = performance.now(); const map = alignWords(a, b); const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    let last = -1; for (const j of map) if (j >= 0) { expect(j).toBeGreaterThan(last); last = j; }
    expect(map.filter((j) => j >= 0).length).toBeGreaterThan(2500);
  });
  it('empty inputs return no matches', () => { expect(alignWords([], ['a'])).toEqual([]); expect(alignWords(['a'], [])).toEqual([-1]); });
});
