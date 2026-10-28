import { describe, expect, it } from 'vitest';
import {
  alignWords, buildTranscript, cuesFromSubtitles, cuesToCaptionPages, idNumberWords, parseSrt, pickVoice, rankTracks, rankVoices, spokenFormId, timeWordsFromTokens,
  transcriptToSrt, wordsFromCharAlignment, BUILTIN_VOICES, MUSIC_LIBRARY, parseVoiceId, estimateVoiceCostUsd, elevenLabsVoices,
} from '../src/index.js';

const SCRIPT = 'Indonesia punya energi bersih melimpah. Tapi kenapa belum terasa?';
// what whisper heard on the QA laptop ("besi"), with word times
const HEARD = [
  { text: ' Indonesia', fromMs: 120, toMs: 700 }, { text: ' punya', fromMs: 700, toMs: 1000 }, { text: ' energi', fromMs: 1000, toMs: 1450 }, { text: ' besi', fromMs: 1450, toMs: 1800 },
  { text: ' melimpah.', fromMs: 1800, toMs: 2500 }, { text: ' Tapi', fromMs: 2900, toMs: 3100 }, { text: ' kenapa', fromMs: 3100, toMs: 3500 }, { text: ' belum', fromMs: 3500, toMs: 3800 }, { text: ' terasa?', fromMs: 3800, toMs: 4400 },
];

describe('timed transcript from the known script (FR-249)', () => {
  it('captions read exactly the script; whisper only gives the times (QA #11 "energi besi")', () => {
    const t = buildTranscript({ spoken: SCRIPT, durationMs: 4600, tokens: HEARD });
    expect(t.method).toBe('aligned');
    expect(t.words.map((w) => w.text).join(' ')).toBe(SCRIPT);
    expect(t.cues.map((c) => c.written).join(' ')).toBe(SCRIPT);
    expect(t.cues.some((c) => c.written.includes('bersih'))).toBe(true);
    expect(JSON.stringify(t.cues)).not.toContain('besi ');
    const bersih = t.words.find((w) => w.text === 'bersih')!;
    expect([bersih.fromMs, bersih.toMs]).toEqual([1450, 1800]);                 // the misheard token lends its time
    expect(t.stats.matched).toBe(9);
  });

  it('missing / extra recognised words: script words are interpolated, never dropped or reordered', () => {
    const heard = HEARD.filter((x) => !/punya|kenapa/.test(x.text)).concat([{ text: ' eh', fromMs: 4450, toMs: 4500 }]);
    const t = buildTranscript({ spoken: SCRIPT, durationMs: 4600, tokens: heard });
    expect(t.words.map((w) => w.text).join(' ')).toBe(SCRIPT);
    const punya = t.words[1]!;
    expect(punya.timed).toBe('interpolated');
    expect(punya.fromMs).toBeGreaterThanOrEqual(700); expect(punya.toMs).toBeLessThanOrEqual(1000);
    for (let i = 1; i < t.words.length; i++) expect(t.words[i]!.fromMs).toBeGreaterThanOrEqual(t.words[i - 1]!.toMs);
  });

  it('no tokens: proportional inside the speech window, sentence pause after "melimpah."', () => {
    const t = buildTranscript({ spoken: SCRIPT, durationMs: 5000, speech: { fromMs: 200, toMs: 4800 } });
    expect(t.method).toBe('proportional');
    expect(t.words[0]!.fromMs).toBe(200);
    expect(t.words.at(-1)!.toMs).toBeLessThanOrEqual(4800);
    const gap = t.words[5]!.fromMs - t.words[4]!.toMs;
    expect(gap).toBeGreaterThan(100);
  });

  it('written ≠ spoken: display "+17,2%" is timed over "tujuh belas koma dua persen"', () => {
    expect(spokenFormId('17,2%')).toEqual(['tujuh', 'belas', 'koma', 'dua', 'persen']);
    expect(idNumberWords(2026)).toEqual(['dua', 'ribu', 'dua', 'puluh', 'enam']);
    expect(spokenFormId('Rp472')).toEqual(['rupiah', 'empat', 'ratus', 'tujuh', 'puluh', 'dua']);
    const spoken = 'Ekspor nikel naik tujuh belas koma dua persen.';
    const tokens = spoken.split(' ').map((w, i) => ({ text: ` ${w}`, fromMs: i * 400, toMs: i * 400 + 380 }));
    const t = buildTranscript({ spoken, written: 'Ekspor nikel naik 17,2%.', durationMs: 3500, tokens });
    expect(t.cues[0]!.written).toBe('Ekspor nikel naik 17,2%.');
    expect(t.cues[0]!.text).toBe(spoken);
    const pct = t.cues[0]!.words.at(-1)!;
    expect(pct.text).toBe('17,2%.');
    expect([pct.fromMs, pct.toMs]).toEqual([1200, 3180]);
  });

  it('engine character alignment (ElevenLabs with-timestamps) → word tokens', () => {
    const text = 'Halo dunia';
    const chars = [...text];
    const toks = wordsFromCharAlignment(text, { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) });
    expect(toks).toEqual([{ text: 'Halo', fromMs: 0, toMs: 400 }, { text: 'dunia', fromMs: 500, toMs: 1000 }]);
    const t = buildTranscript({ spoken: text, durationMs: 1100, tokens: toks, method: 'engine' });
    expect(t.method).toBe('engine');
    expect(t.words.every((w) => w.timed === 'engine')).toBe(true);
  });

  it('SRT round trip keeps text and times; captions follow the clip position', () => {
    const t = buildTranscript({ spoken: SCRIPT, durationMs: 4600, tokens: HEARD });
    const srt = transcriptToSrt(t.cues);
    const back = cuesFromSubtitles(parseSrt(srt));
    expect(back.map((c) => c.written)).toEqual(t.cues.map((c) => c.written));
    expect(back.map((c) => [c.fromMs, c.toMs])).toEqual(t.cues.map((c) => [c.fromMs, c.toMs]));
    const at0 = cuesToCaptionPages(t.cues, 0); const at5 = cuesToCaptionPages(t.cues, 5000);
    expect(at5.map((p) => p.startMs - 5000)).toEqual(at0.map((p) => p.startMs));
    expect(at5[0]!.text.trim()).toBe(t.cues[0]!.written);
    expect(transcriptToSrt(t.cues, 5000)).toContain('00:00:05,120 -->');
  });

  it('alignWords is monotonic and tolerant', () => {
    expect(alignWords(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([0, -1, 2]);
    expect(alignWords(['energi', 'bersih'], ['energi', 'besi'])).toEqual([0, 1]);
    const r = timeWordsFromTokens(['satu', 'dua'], [], { fromMs: 0, toMs: 1000 });
    expect(r.matched).toBe(0);
  });
});

describe('voices and the music library (FR-246, FR-247)', () => {
  it('catalogue ids parse; description picks a matching voice; unavailable voices lose', () => {
    expect(BUILTIN_VOICES.filter((v) => v.provider === 'gemini')).toHaveLength(30);
    expect(BUILTIN_VOICES.filter((v) => v.provider === 'openai')).toHaveLength(13);
    for (const v of BUILTIN_VOICES) expect(parseVoiceId(v.id)).not.toBeNull();
    expect(parseVoiceId('bogus')).toBeNull();
    const warmF = pickVoice('suara perempuan hangat', BUILTIN_VOICES)!;
    expect(warmF.gender).toBe('female');
    expect([...warmF.traits.id, ...warmF.traits.en]).toContain('hangat');
    const localOnly = pickVoice('natural, hangat, jelas, percaya diri', BUILTIN_VOICES, { available: (v) => !v.cloud })!;
    expect(localOnly.provider).toBe('local');
    expect(rankVoices('x', BUILTIN_VOICES, { allowCloud: false }).every((r) => !r.voice.cloud)).toBe(true);
    expect(estimateVoiceCostUsd({ cloud: true, usdPer1kChars: 0.08 }, 'a'.repeat(2000))).toBe(0.16);
    expect(elevenLabsVoices({ voices: [{ voice_id: 'abcDEF123456', name: 'Sari', labels: { gender: 'female', description: 'warm' } }, { voice_id: '../x', name: 'bad' }] })).toHaveLength(1);
  });

  it('every library track is pinned (commit, sha256, size) on the allow-listed host; ranking by mood words', () => {
    expect(MUSIC_LIBRARY.length).toBeGreaterThanOrEqual(25);
    for (const t of MUSIC_LIBRARY) {
      expect(t.url).toMatch(/^https:\/\/huggingface\.co\/datasets\/Youmiel\/FreePD-Data\/resolve\/da6aa61dca495ab3b52c30023874e34600d10194\/music\//);
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(t.bytes).toBeGreaterThan(100_000);
      expect(t.credit).toContain('CC0');
    }
    expect(new Set(MUSIC_LIBRARY.map((t) => t.id)).size).toBe(MUSIC_LIBRARY.length);
    expect(rankTracks('musik santai tenang')[0]!.mood).toBe('calm');
    expect(rankTracks('dramatis tegang')[0]!.mood).toBe('dramatic');
  });
});
