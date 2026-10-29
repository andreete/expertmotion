// QA P1 2026-10-29 (caption paging, nikel run): proportional pages broke 170 ms (max 710 ms) away from the speech pauses, split
// numbers ("empat puluh | lima miliar", "dua ribu | dua puluh enam") and left orphans ("naik?"). Sentences of the nikel v3 / v5 / v8 clips.
import { describe, expect, it } from 'vitest';
import { buildTranscript, gluedNumber, groupCues, pageBreaks, proportionalTimes, silences, splitWords, type TranscriptWord } from '../src/index.js';

const V3 = 'Januari sampai Agustus dua ribu dua puluh enam, nilainya hampir dua puluh enam miliar dolar.';
const V5 = 'Target tahun ini: empat puluh lima miliar.';
const V8 = 'Pertanyaannya: ini benar-benar nilai tambah, atau sekadar harga naik?';
const pages = (text: string, o: Parameters<typeof groupCues>[2] = {}, ms = 6000) => groupCues(proportionalTimes(splitWords(text), 0, ms), [], o).map((c) => c.written);
/** A WAV-like energy envelope (10 ms frames): voiced everywhere except the given pauses. */
const frames = (ms: number, quiet: Array<[number, number]>) => Array.from({ length: ms / 10 }, (_, k) => ({ fromMs: k * 10, rms: quiet.some(([a, b]) => k * 10 >= a && k * 10 < b) ? 0.001 : 0.3 }));

describe('QA P1: caption pages', () => {
  it('number phrases and their units are one unit (spelled out or digits, currency signs)', () => {
    expect(gluedNumber('dua', 'ribu')).toBe(true); expect(gluedNumber('ribu', 'dua')).toBe(true); expect(gluedNumber('puluh', 'lima')).toBe(true);
    expect(gluedNumber('lima', 'miliar.')).toBe(true); expect(gluedNumber('enam', 'miliar')).toBe(true); expect(gluedNumber('miliar', 'dolar.')).toBe(true);
    expect(gluedNumber('tujuh', 'belas')).toBe(true); expect(gluedNumber('belas', 'persen.')).toBe(true); expect(gluedNumber('17,2', 'persen')).toBe(true);
    expect(gluedNumber('Rp', '472')).toBe(true); expect(gluedNumber('US$', '25,96')).toBe(true); expect(gluedNumber('472', 'triliun')).toBe(true);
    expect(gluedNumber('enam,', 'nilainya')).toBe(false);                                // a comma ends the phrase
    expect(gluedNumber('Agustus', 'dua')).toBe(false); expect(gluedNumber('hampir', 'dua')).toBe(false); expect(gluedNumber('satu', 'hal')).toBe(false);
  });

  it('v3: "dua ribu dua puluh enam," and "dua puluh enam miliar dolar." are never split; ≤ 32 characters per page', () => {
    const p = pages(V3);
    expect(p.join(' ')).toBe(V3);
    expect(p.some((x) => x.includes('dua ribu dua puluh enam,'))).toBe(true);
    expect(p.some((x) => x.includes('dua puluh enam miliar dolar.'))).toBe(true);
    for (const x of p) expect(x.length, x).toBeLessThanOrEqual(32);
  });

  it('v5: "empat puluh lima miliar." stays on one page', () => {
    const p = pages(V5);
    expect(p.join(' ')).toBe(V5);
    expect(p.some((x) => x.includes('empat puluh lima miliar.'))).toBe(true);
  });

  it('v8: no orphan page ("naik?" alone), every page ≤ 32 characters', () => {
    const p = pages(V8);
    expect(p.join(' ')).toBe(V8);
    for (const x of p) { expect(x.split(' ').length > 1 || x.length > 6, `orphan "${x}"`).toBe(true); expect(x.length).toBeLessThanOrEqual(32); }
  });

  it('no page boundary ever lands inside a number in any nikel sentence (also with 3-word pages)', () => {
    for (const s of [V3, V5, V8, 'Ekspor nikel Indonesia naik tujuh belas persen.', 'Tapi volumenya justru turun tiga koma delapan persen.', 'Dulu, sebelum hilirisasi, cuma tiga koma tiga miliar.'])
      for (const maxWords of [3, 5]) {
        const w = proportionalTimes(splitWords(s), 0, 5000);
        for (const i of pageBreaks(w, { maxWords })) expect(gluedNumber(w[i]!.text, w[i + 1]!.text), `${s} @ ${w[i]!.text}|${w[i + 1]!.text}`).toBe(false);
      }
  });

  it('with the real pauses: v3 breaks at the pause after "enam," and the page edges sit exactly on the silence (proportional drift removed)', () => {
    const ms = 6200;
    // speech pauses measured from the envelope: after "Agustus" (short), after "enam," (long); the proportional guess is off by ~170 ms
    const quiet: Array<[number, number]> = [[1450, 1600], [3050, 3400]];
    const pauses = silences(frames(ms, quiet));
    expect(pauses).toEqual([{ fromMs: 1450, toMs: 1600 }, { fromMs: 3050, toMs: 3400 }]);
    const t = buildTranscript({ spoken: V3, durationMs: ms, cues: { pauses } });
    expect(t.method).toBe('proportional');
    const cues = t.cues;
    const i = cues.findIndex((c) => c.written.endsWith('enam,'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(cues[i]!.words.at(-1)!.toMs).toBe(3050);                                     // page ends where the speech stops
    expect(cues[i + 1]!.fromMs).toBe(3400);                                             // next page starts where it resumes
    for (const c of cues) expect(c.written).not.toMatch(/^(ribu|puluh|enam|miliar|dolar)\b/);
    // every break that has a pause near it sits on the pause
    for (let k = 0; k < cues.length - 1; k++) {
      const end = cues[k]!.words.at(-1)!.toMs;
      const near = pauses.find((p) => Math.abs(p.fromMs - end) < 800);
      if (near) expect(end).toBe(near.fromMs);
    }
  });

  it('words, order and text never change; times stay monotonic', () => {
    const w = proportionalTimes(splitWords(V3), 0, 6000);
    const cues = groupCues(w, [], { pauses: [{ fromMs: 2900, toMs: 3300 }] });
    const flat: TranscriptWord[] = cues.flatMap((c) => c.words);
    expect(flat.map((x) => x.text)).toEqual(splitWords(V3));
    for (let k = 1; k < flat.length; k++) { expect(flat[k]!.fromMs).toBeGreaterThanOrEqual(flat[k - 1]!.toMs); expect(flat[k]!.toMs).toBeGreaterThanOrEqual(flat[k]!.fromMs); }
  });
});
