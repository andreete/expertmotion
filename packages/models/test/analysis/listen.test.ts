import { describe, expect, it } from 'vitest';
import { analysis as A } from '../../src/index.js';

describe('analysis/listen', () => {
  const phrases = [{ fromMs: 1000, toMs: 2000 }, { fromMs: 5000, toMs: 6500 }, { fromMs: 9900, toMs: 10000 }];
  it('joinPlan pads, clamps and spaces the pieces with gaps before each and after the last', () => {
    const plan = A.joinPlan(phrases, { gapMs: 2000, padMs: 150, durationMs: 10000 });
    expect(plan.pieces[0]).toEqual({ index: 0, recFromMs: 850, recToMs: 2150, joinedFromMs: 2000, joinedToMs: 3300 });
    expect(plan.pieces[1]).toEqual({ index: 1, recFromMs: 4850, recToMs: 6650, joinedFromMs: 5300, joinedToMs: 7100 });
    expect(plan.pieces[2]!.recToMs).toBe(10000);                              // clamped to the recording
    expect(plan.totalMs).toBe(7100 + 2000 + 250 + 2000);
    expect(A.joinPlan([{ fromMs: 50, toMs: 500 }]).pieces[0]!.recFromMs).toBe(0);
  });
  it('joinPcm places every piece at its joined position inside zeros', () => {
    const sr = 1000; const pcm = new Int16Array(10000); for (let i = 0; i < pcm.length; i++) pcm[i] = i % 32000;
    const plan = A.joinPlan(phrases, { gapMs: 100, padMs: 0, durationMs: 10000 });
    const out = A.joinPcm(pcm, sr, plan);
    expect(out.length).toBe(plan.totalMs);
    expect(out[50]).toBe(0);
    expect(out[plan.pieces[0]!.joinedFromMs + 10]).toBe(pcm[1010]);
    expect(out[plan.pieces[1]!.joinedFromMs]).toBe(pcm[5000]);
    expect(out[plan.pieces[1]!.joinedFromMs - 1]).toBe(0);
  });
  it('joinedToRecordingMs maps through the nearest piece and clamps into it', () => {
    const plan = A.joinPlan(phrases, { gapMs: 2000, padMs: 0 });
    expect(A.joinedToRecordingMs(2500, plan.pieces)).toBe(1500);
    expect(A.joinedToRecordingMs(3900, plan.pieces)).toBe(2000);              // in the gap, nearer to piece 0 → its end
    expect(A.joinedToRecordingMs(4800, plan.pieces)).toBe(5000);              // nearer to piece 1 → its start
    expect(A.joinedToRecordingMs(5, [])).toBeNull();
  });
  it('mapJoinedWords: words go to the nearest piece, stuck runs by their end time, never backwards; empties dropped', () => {
    const plan = A.joinPlan(phrases, { gapMs: 2000, padMs: 0 });     // pieces at 2000-3000, 5000-6500, 8500-8600
    const words: A.TimedWord[] = [
      { text: '', fromMs: 0, toMs: 0 }, { text: ' Satu', fromMs: 2100, toMs: 2400 }, { text: ' dua', fromMs: 2400, toMs: 2900 },
      // a run stamped with the window start 4000 (0.1 s before piece 1 would be nearer to piece 0 by midpoint) ends at 5600 → piece 1
      { text: ' tiga', fromMs: 3900, toMs: 3900 }, { text: ' empat', fromMs: 3900, toMs: 3900 }, { text: ' lima', fromMs: 3900, toMs: 5600 },
      { text: ' enam', fromMs: 6000, toMs: 6400 }, { text: ' [BLANK_AUDIO]', fromMs: 7000, toMs: 7000 },
      { text: ' tujuh', fromMs: 8500, toMs: 8600 }, { text: ' delapan', fromMs: 7900, toMs: 8000 },      // earlier time after a later piece: stays monotonic
    ];
    const out = A.mapJoinedWords(words, plan);
    expect(out.map((ws) => ws.map((w) => w.text))).toEqual([['Satu', 'dua'], ['tiga', 'empat', 'lima', 'enam'], ['tujuh', 'delapan']]);
    expect(out[0]![0]).toEqual({ text: 'Satu', fromMs: 1100, toMs: 1400 });
    expect(out[1]![0]!.fromMs).toBe(5000);                                    // clamped into the piece
    expect(out[1]![3]).toEqual({ text: 'enam', fromMs: 6000, toMs: 6400 });
    for (const ws of out) for (const w of ws) expect(w.toMs).toBeGreaterThanOrEqual(w.fromMs);
  });
  it('namesPrompt: capitalised non-initial words and acronyms, runs kept together, deduplicated, never the script', () => {
    const script = 'Kenapa raksasa teknologi dunia berlomba? Solusi paling realistis adalah SMR atau Small Modular Reactor—yaitu reaktor kecil. Google, Amazon dan Meta sudah teken kontrak. Bisa DM aku ya. SMR lagi.';
    const p = A.namesPrompt(script);
    expect(p).toBe('SMR, Small Modular Reactor, Amazon, Meta, DM.');             // "Google" opens a sentence: indistinguishable from a capitalised common word
    expect(p).not.toContain('raksasa'); expect(p).not.toContain('Kenapa');
    expect(A.namesPrompt('Kontrak dengan Google. Lalu Google lagi.')).toBe('Google.');
    expect(A.namesPrompt('tidak ada nama di sini.')).toBe('');
    expect(A.namesPrompt('[00:00] HOOK: Data center AI butuh listrik.')).toBe('AI.');
  });
});
