import { describe, expect, it } from 'vitest';
import { CaptionPage as CmCaptionPage } from '../../composition-model/src/schema.js';
import { captionsToPages, cleanCueText, createTikTokStyleCaptions, cuesToPages, parseSrt, parseSubtitles, parseTimestamp, parseVtt, toCaptionPages, type Caption } from '../src/index.js';
import { expectEm } from './helpers.js';

const SRT = `﻿1\r
00:00:01,000 --> 00:00:03,500\r
<i>Halo, apa kabar?</i>\r
\r
2\r
00:00:03,600 --> 00:00:06,000 X1:10 X2:20\r
Terima kasih sudah menonton —\r
jangan lupa <b>subscribe</b> & bagikan!\r
\r
3\r
00:00:06.100 --> 00:00:07.000\r
{\\an8}Sampai jumpa, ya.\r
\r
\r
4\r
00:00:08,000 --> 00:00:09,000\r
\r
`;

describe('parseSrt', () => {
  it('parses Indonesian cues with BOM, CRLF, tags, settings, dot separators', () => {
    const c = parseSrt(SRT);
    expect(c.map((x) => x.text)).toEqual(['Halo, apa kabar?', 'Terima kasih sudah menonton —\njangan lupa subscribe & bagikan!', 'Sampai jumpa, ya.']);
    expect(c[0]).toEqual({ text: 'Halo, apa kabar?', startMs: 1000, endMs: 3500, timestampMs: 2250, confidence: 1 });
    expect(c[2]!.startMs).toBe(6100);
  });
  it('tolerates a missing index, unsorted cues, short fractions and hours > 99', () => {
    const c = parseSrt('00:00:05,5 --> 00:00:06,000\nkedua\n\n1\n00:00:01,000 --> 00:00:02,000\npertama\n\n100:00:00,000 --> 100:00:01,000\nlama sekali');
    expect(c.map((x) => x.text)).toEqual(['pertama', 'kedua', 'lama sekali']);
    expect(c[1]!.startMs).toBe(5500);
    expect(c[2]!.startMs).toBe(360_000_000);
  });
  it('rejects broken files with EM-1009 and a line number', async () => {
    expect((await expectEm(Promise.resolve().then(() => parseSrt('1\n00:00:01,000 -> 00:00:02,000\nx')), 'EM-1009')).line).toBe(1);
    expect((await expectEm(Promise.resolve().then(() => parseSrt('1\n00:00:61,000 --> 00:00:62,000\nx')), 'EM-1009')).parseError).toBe('invalid timestamp');
    expect((await expectEm(Promise.resolve().then(() => parseSrt('1\n00:00:05,000 --> 00:00:02,000\nx')), 'EM-1009')).parseError).toMatch(/earlier/);
    await expectEm(Promise.resolve().then(() => parseSrt('')), 'EM-1009');
    await expectEm(Promise.resolve().then(() => parseSrt('hanya teks biasa\ntanpa waktu')), 'EM-1009');
    await expectEm(Promise.resolve().then(() => parseSrt('a\u0000b')), 'EM-1009');
  });
  it('enforces the 5 MB and cue-count caps (SEC-067)', async () => {
    expect((await expectEm(Promise.resolve().then(() => parseSrt('x'.repeat(100), { maxBytes: 50, fileName: 'a.srt' })), 'EM-1002')).fileName).toBe('a.srt');
    const many = Array.from({ length: 4 }, (_, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},500\nk${i}`).join('\n\n');
    expect((await expectEm(Promise.resolve().then(() => parseSrt(many, { maxCues: 3 })), 'EM-1009')).parseError).toMatch(/more than 3/);
    expect(parseSrt(many).length).toBe(4);
  });
  it('fuzz: random input never throws anything but an EmError', () => {
    let seed = 1;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const alphabet = '0123456789:,.-> \n\r<>{}\\WEBVTTabc&;#';
    for (let n = 0; n < 300; n++) {
      const s = Array.from({ length: Math.floor(rnd() * 200) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      for (const parse of [parseSrt, parseVtt]) {
        try { parse(s); } catch (e) { expect((e as { code?: string }).code).toMatch(/^EM-10(09|02)$/); }
      }
    }
  });
});

describe('parseVtt', () => {
  const VTT = `WEBVTT - Contoh
Kind: captions
Language: id

NOTE ini komentar
yang panjang

STYLE
::cue { color: yellow }

intro
00:01.000 --> 00:03.000 align:start position:10%
<v Budi>Selamat pagi, Indonesia!</v>

00:00:03.500 --> 00:00:05.000
Harga naik &amp; turun &lt;cepat&gt;&nbsp;sekali

00:00:05.000 --> 00:00:06.000
<c.yellow>Kata</c> <00:00:05.500>demi kata`;
  it('parses header, NOTE/STYLE blocks, identifiers, settings, voice/class/timestamp tags and entities', () => {
    const c = parseVtt(VTT);
    expect(c.map((x) => x.text)).toEqual(['Selamat pagi, Indonesia!', 'Harga naik & turun <cepat> sekali', 'Kata demi kata']);
    expect(c[0]!.startMs).toBe(1000);
    expect(c[1]).toMatchObject({ startMs: 3500, endMs: 5000 });
  });
  it('requires the WEBVTT signature', async () => {
    await expectEm(Promise.resolve().then(() => parseVtt('00:01.000 --> 00:02.000\nx')), 'EM-1009');
    await expectEm(Promise.resolve().then(() => parseVtt('WEBVTT\n\nid\nno timing here')), 'EM-1009');
  });
  it('parseSubtitles dispatches by extension or signature', () => {
    expect(parseSubtitles(VTT).length).toBe(3);
    expect(parseSubtitles(SRT, { fileName: 'x.SRT' }).length).toBe(3);
    expect(() => parseSubtitles(SRT, { fileName: 'x.vtt' })).toThrow();
  });
  it('helpers', () => {
    expect(parseTimestamp('01:02:03,004')).toBe(3_723_004);
    expect(parseTimestamp('02:03')).toBe(123_000);
    expect(parseTimestamp('1:2:3:4')).toBeNull();
    expect(cleanCueText('a&#65;&#x42;&bogus;  b\n\n c')).toBe('aAB&bogus; b\nc');
  });
});

const w = (text: string, startMs: number, endMs: number, extra: Partial<Caption> = {}): Caption => ({ text, startMs, endMs, timestampMs: (startMs + endMs) / 2, confidence: null, ...extra });
const WORDS: Caption[] = [w(' Ini', 0, 200), w(' adalah', 200, 500), w(' contoh', 500, 900), w(' kalimat', 900, 1400), w(' yang', 1400, 1600), w(' cukup', 1600, 2000), w(' panjang.', 2000, 2600),
  w(' Sesudah', 4000, 4400), w(' jeda', 4400, 4700), w('nya', 4700, 4900), w(' lanjut', 4900, 5300)];

describe('TikTok-style page grouping', () => {
  it('matches @remotion/captions createTikTokStyleCaptions exactly', async () => {
    type Ref = { createTikTokStyleCaptions: (o: { captions: Caption[]; combineTokensWithinMilliseconds: number; breakOnSilenceAfterMilliseconds?: number }) => { pages: unknown[] } };
    const remotion: Ref | null = await import('@remotion/captions').then((m) => m as unknown as Ref, () => null);
    expect(remotion, '@remotion/captions should be resolvable in this repo').not.toBeNull();
    if (!remotion) return; // reference implementation not installed: equivalence covered by the fixed expectations below
    const cases: [Caption[], number, number | undefined][] = [
      [WORDS, 1200, undefined], [WORDS, 300, undefined], [WORDS, 5000, 1000], [WORDS, 0, undefined], [[], 1200, undefined],
      [[w('Halo', 0, 100), w(' ', 100, 150), w(' dunia', 150, 400, { pageBreakAfter: true }), w(' lagi', 500, 800)], 1200, undefined],
      [[w('tanpa', 0, 100), w('spasi', 100, 2000), w('sama', 2000, 4000)], 100, 10],
    ];
    for (const [captions, combine, silence] of cases) {
      const ours = createTikTokStyleCaptions(captions, { combineTokensWithinMilliseconds: combine, ...(silence === undefined ? {} : { breakOnSilenceAfterMilliseconds: silence }) });
      const ref = remotion.createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: combine, ...(silence === undefined ? {} : { breakOnSilenceAfterMilliseconds: silence }) });
      expect(ours).toEqual(ref);
    }
  });
  it('groups words into pages by duration and silence', () => {
    expect(captionsToPages(WORDS).map((p) => p.text)).toEqual(['Ini adalah contoh kalimat', 'yang cukup panjang. Sesudah', 'jedanya lanjut']);
    const silence = captionsToPages(WORDS, { combineTokensWithinMilliseconds: 10_000, breakOnSilenceAfterMilliseconds: 1000 });
    expect(silence.map((p) => p.text)).toEqual(['Ini adalah contoh kalimat yang cukup panjang.', 'Sesudah jedanya lanjut']);
    expect(silence[0]).toMatchObject({ startMs: 0, durationMs: 4000 });
    expect(silence[1]).toMatchObject({ startMs: 4000, durationMs: 1300 });
    expect(silence[1]!.tokens.map((t) => t.text)).toEqual(['Sesudah', ' jeda', 'nya', ' lanjut']);
  });
  it('pageBreakAfter forces a new page; output validates against composition-model CaptionPage', () => {
    const pages = captionsToPages([w(' Satu', 0, 100, { pageBreakAfter: true }), w(' dua', 100, 200)]);
    expect(pages.map((p) => p.text)).toEqual(['Satu', 'dua']);
    for (const p of [...pages, ...captionsToPages(WORDS)]) expect(CmCaptionPage.safeParse(p).success).toBe(true);
  });
  it('rounds fractional ms and drops empty pages', () => {
    expect(toCaptionPages([{ text: ' ', startMs: 0, durationMs: 1, tokens: [] }, { text: 'a', startMs: 0.4, durationMs: 10.6, tokens: [{ text: 'a', fromMs: 0.4, toMs: 11 }] }]))
      .toEqual([{ text: 'a', startMs: 0, durationMs: 11, tokens: [{ text: 'a', fromMs: 0, toMs: 11 }] }]);
  });
  it('cuesToPages: one page per SRT cue, word tokens spread over the cue', () => {
    const pages = cuesToPages(parseSrt(SRT));
    expect(pages[0]).toEqual({ text: 'Halo, apa kabar?', startMs: 1000, durationMs: 2500, tokens: [
      { text: 'Halo,', fromMs: 1000, toMs: 1893 }, { text: ' apa', fromMs: 1893, toMs: 2429 }, { text: ' kabar?', fromMs: 2429, toMs: 3500 }] });
    expect(pages[1]!.text).toBe('Terima kasih sudah menonton — jangan lupa subscribe & bagikan!');
    for (const p of pages) { expect(CmCaptionPage.safeParse(p).success).toBe(true); expect(p.tokens.at(-1)!.toMs).toBe(p.startMs + p.durationMs); }
    expect(cuesToPages([w('   ', 0, 10)])).toEqual([]);
  });
});
