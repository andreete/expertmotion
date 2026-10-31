import { describe, expect, it } from 'vitest';
import { analysis as A } from '../../src/index.js';

describe('analysis/sfx', () => {
  it('every kind has the documented length, a −6 dBFS peak, sound in it and is deterministic', () => {
    for (const kind of A.SFX_KINDS) {
      const meta = A.SFX_LIBRARY[kind];
      expect(meta.kind).toBe(kind); expect(meta.licence).toBe('self-made, CC0'); expect(meta.description.length).toBeGreaterThan(5);
      const a = A.synthSfx(kind), b = A.synthSfx(kind);
      expect(a.length).toBe(Math.round((48000 * meta.durationMs) / 1000));
      expect(A.peakDb(a)).toBeCloseTo(-6, 1);
      expect(Array.from(a.subarray(0, 2000))).toEqual(Array.from(b.subarray(0, 2000)));
      const rms = Math.sqrt(a.reduce((s, v) => s + (v / 32768) ** 2, 0) / a.length);
      expect(rms).toBeGreaterThan(0.02);
      expect(a[0]).toBeLessThanOrEqual(2000); expect(Math.abs(a[a.length - 1]!)).toBeLessThan(3000);    // starts and ends softly (no click)
    }
    expect(A.synthSfx('pop', 16000).length).toBe(1920);
    expect(A.SFX_LIBRARY.whoosh.durationMs).toBe(350); expect(A.SFX_LIBRARY.ding.durationMs).toBe(600); expect(A.SFX_LIBRARY.click.durationMs).toBe(120); expect(A.SFX_LIBRARY.click.soundMs).toBe(15);
  });
  it('a pop falls in pitch and a rise climbs (zero-crossing rate of the first vs last quarter)', () => {
    const zcr = (x: Int16Array): number => { let z = 0; for (let i = 1; i < x.length; i++) if ((x[i]! >= 0) !== (x[i - 1]! >= 0)) z++; return z / x.length; };
    const pop = A.synthSfx('pop'); const q = Math.floor(pop.length / 4);
    expect(zcr(pop.subarray(0, q))).toBeGreaterThan(zcr(pop.subarray(3 * q)));
    const rise = A.synthSfx('rise'); const r = Math.floor(rise.length / 4);
    expect(zcr(rise.subarray(3 * r))).toBeGreaterThan(zcr(rise.subarray(0, r)) * 2);
  });
  it('writes as a valid 48 kHz WAV', () => {
    const wav = A.writeWav16(A.synthSfx('tick'), 48000);
    const back = A.readWav16(wav);
    expect(back.sampleRate).toBe(48000); expect(back.pcm.length).toBe(5760);   // 120 ms file (25 ms tick + silence)
  });
});
