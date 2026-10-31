import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analysis as A } from '../../src/index.js';
import { KEY_CUTS, LISTEN_JSON, MAX_SPEECH_MS, RAW_AUDIO, SCRIPT, decodePcm16k, kitReady, overlapRatio, readKeyWords, readListenWords } from './kit.js';

/** Phrase transcripts from "<text> @ <fromS>-<toS>" strings, words spread evenly. */
const phrase = (s: string): { words: A.TimedWord[]; phrase: { fromMs: number; toMs: number } } => {
  const [text, span] = s.split(' @ ') as [string, string]; const [a, b] = span.split('-').map((v) => Math.round(Number(v) * 1000)) as [number, number];
  const ws = text.split(' '); const d = (b - a) / ws.length;
  return { words: ws.map((w, i) => ({ text: w, fromMs: Math.round(a + i * d), toMs: Math.round(a + (i + 1) * d) })), phrase: { fromMs: a, toMs: b } };
};
const build = (specs: string[]): { pw: A.TimedWord[][]; phrases: A.Phrase[] } => {
  const ps = specs.map(phrase);
  return { pw: ps.map((p) => p.words), phrases: ps.map((p, index) => ({ index, ...p.phrase, durationMs: p.phrase.toMs - p.phrase.fromMs })) };
};
/** Envelope: −60 dB everywhere except −20 dB inside the phrases (10 ms hops). */
const envFor = (phrases: A.Phrase[], totalMs: number): A.EnvelopeDb => { const db = new Float64Array(totalMs / 10).fill(-60); for (const p of phrases) for (let k = p.fromMs / 10; k < p.toMs / 10; k++) db[k] = -20; return { db, hopMs: 10 }; };

describe('analysis/takes: splitScriptLines', () => {
  it('splits at sentence marks and dashes, keeps "atau" clauses, decimals and abbreviations intact, drops stage directions', () => {
    const lines = A.splitScriptLines('[00:00 - 00:05] HOOK: "Kenapa raksasa berlomba?" 🎬 Harga naik 1.5 persen—yaitu Rp. 2.000 per kg. SMR atau Small Modular Reactor, bukan PLTN! Setuju gak?');
    expect(lines).toEqual(['Kenapa raksasa berlomba?', 'Harga naik 1.5 persen', 'yaitu Rp. 2.000 per kg.', 'SMR atau Small Modular Reactor, bukan PLTN!', 'Setuju gak?']);
    expect(A.splitScriptLines('PENJELASAN (Kamu Bicara ke Kamera): Data center butuh listrik. Pakai dll. lalu selesai. Ya.')).toEqual(['Data center butuh listrik.', 'Pakai dll. lalu selesai.']);   // "Ya." < 2 words
    expect(A.splitScriptLines('Baris satu\nBaris dua - masih satu baris. Tiga empat')).toEqual(['Baris satu', 'Baris dua', 'masih satu baris.', 'Tiga empat']);
    expect(A.splitScriptLines('   ')).toEqual([]);
  });
  it('QA 2026-10-31: the pasted brief (timecodes, "HOOK (…):" headers, stray colons, emoji) gives the seven spoken lines', () => {
    const brief = 'Naskah Video:[00:00 - 00:05] HOOK (Kamu Bicara Langsung ke Kamera):"Kenapa raksasa teknologi dunia tiba-tiba berlomba borong pembangkit listrik nuklir mini buat AI?"🎬 (CUT KE VIDEO EBS — Menit 03:40 s.d. 03:48 [durasi 3-4 detik])[00:09 - Selesai] PENJELASAN (Kamu Bicara Langsung ke Kamera):"Data center AI butuh pasokan listrik raksasa yang stabil 24 jam nonstop tanpa tergantung cuaca seperti panel surya. Solusi paling realistis saat ini adalah SMR atau Small Modular Reactor—yaitu reaktor nuklir skala kecil yang aman dan bisa dibangun dekat lokasi data center. Pembangkit nuklir mini ini mampu menghasilkan energi bersih tanpa emisi karbon dalam jumlah raksasa. Inilah alasan kenapa nuklir mini jadi kartu truf utama raksasa teknologi! Kamu setuju gak kalau AI masa depan ditenagai nuklir?"Link : https://www.youtube.com/watch?v=wnAQCXJYTP8';
    const lines = A.splitScriptLines(brief);
    expect(lines).toEqual([
      'Kenapa raksasa teknologi dunia tiba-tiba berlomba borong pembangkit listrik nuklir mini buat AI?',
      'Data center AI butuh pasokan listrik raksasa yang stabil 24 jam nonstop tanpa tergantung cuaca seperti panel surya.',
      'Solusi paling realistis saat ini adalah SMR atau Small Modular Reactor',
      'yaitu reaktor nuklir skala kecil yang aman dan bisa dibangun dekat lokasi data center.',
      'Pembangkit nuklir mini ini mampu menghasilkan energi bersih tanpa emisi karbon dalam jumlah raksasa.',
      'Inilah alasan kenapa nuklir mini jadi kartu truf utama raksasa teknologi!',
      'Kamu setuju gak kalau AI masa depan ditenagai nuklir?',
    ]);
    // the Service's earlier flattening: stray ": " fragments and no capital after the mark
    expect(A.splitScriptLines(': Kenapa raksasa berlomba buat AI? : data center AI butuh listrik.\nsolusi paling realistis')).toEqual(['Kenapa raksasa berlomba buat AI?', 'data center AI butuh listrik.', 'solusi paling realistis']);
  });
});

describe('analysis/takes: groupTakes / pickTakes (synthetic)', () => {
  const script = 'Halo semua apa kabar hari ini. Kita bicara soal reaktor nuklir kecil untuk data center. Setuju gak?';
  // phrases: false start, full take A, ad-lib, retake of A, line 2 split in two phrases, line 3, two extras
  const { pw, phrases } = build([
    'Halo semua apa @ 1-2', 'Halo semua apa kabar hari ini @ 3-6', 'eh sebentar ya @ 7-8', 'Halo semua apa kabar hari ini @ 10-13',
    'Kita bicara soal reaktor @ 15-17', 'nuklir kecil untuk data center @ 17.3-20', 'Setuju gak @ 22-23', 'Tulis di komentar ya. @ 24-25.5', 'Kalau butuh bantuan DM aku @ 26-28',
  ]);
  const env = envFor(phrases, 30000);
  it('groupTakes: candidates per line with coverage / precision, runs of consecutive phrases, shortest run that covers', () => {
    const groups = A.groupTakes(A.splitScriptLines(script), pw, { phrases });
    expect(groups).toHaveLength(3);
    expect(groups[0]!.candidates.map((c) => [c.phraseFrom, c.phraseTo, c.coverage])).toEqual([[1, 1, 1], [3, 3, 1]]);   // the false start (3/6) is below the fallback
    expect(groups[1]!.candidates.map((c) => [c.phraseFrom, c.phraseTo])).toEqual([[4, 5]]);
    expect(groups[1]!.candidates[0]).toMatchObject({ coverage: 1, precision: 1, startMs: 15000, endMs: 20000 });
    expect(groups[2]!.candidates.map((c) => [c.phraseFrom, c.phraseTo, c.coverage])).toEqual([[6, 6, 1]]);
  });
  it('QA 2026-10-31: a take split in two phrases (250 ms breath) is found as one candidate; a short lead phrase may open a take, a long ad-lib may not', () => {
    const hook = 'Kenapa raksasa teknologi dunia tiba-tiba berlomba borong pembangkit listrik nuklir mini buat AI?';
    const line2 = 'Data center AI butuh pasokan listrik raksasa yang stabil 24 jam nonstop tanpa tergantung cuaca seperti panel surya.';
    // what the Service's whisper run heard: the hook in two pieces missing "buat AI", then "Nah alasannya data" with the line's first word, then the take
    const { pw, phrases } = build([
      'Kenapa raksasa terkini meluki dunia, @ 8.26-10.26', 'tiba-tiba perlomba untuk memanggil listrik nuklir ini @ 10.51-14.41',
      'alasannya data @ 47.19-48.31', 'senteri AI itu butuh pasokan listrik raksasa yang stabil 24 jam non-stop tergantung juaca seperti panel surya. @ 48.84-58.42',
    ]);
    const groups = A.groupTakes([hook, line2], pw, { phrases });
    expect(groups[0]!.candidates.map((c) => [c.phraseFrom, c.phraseTo])).toEqual([[0, 1]]);
    expect(groups[0]!.candidates[0]!.coverage).toBeGreaterThanOrEqual(0.6);
    expect(groups[0]!.candidates[0]).toMatchObject({ startMs: 8260, endMs: 14410 });
    expect(groups[1]!.candidates.map((c) => [c.phraseFrom, c.phraseTo])).toEqual([[3, 3]]);          // the single phrase already covers ≥ 0.8: the ad-lib stays out
    const r = A.pickTakes(groups, { phraseWords: pw, phrases });
    expect(r.cuts.map((c) => [c.lineIndex, c.confidence])).toEqual([[0, 'low'], [1, 'ok']]);
    expect(r.dropped.find((d) => d.startMs === 47190)).toMatchObject({ reason: 'adlib' });
    // the same with a weaker take (first two words lost to the short lead): the lead opens the take because it is short
    // (14 of 18 line words in the phrase alone = 0.78; with the lead's "data center" 0.89)
    const weak = build(['alasannya data center @ 47.19-48.31', 'AI itu butuh pasokan listrik raksasa yang stabil 24 jam non-stop tergantung juaca panel surya. @ 48.84-58.42']);
    expect(A.groupTakes([line2], weak.pw, { phrases: weak.phrases })[0]!.candidates.map((c) => [c.phraseFrom, c.phraseTo, c.coverage])).toEqual([[0, 1, 0.889]]);
    // a long ad-lib (≥ 1.5 s) never opens a take, even when it holds stray line words: the take stays alone (low)
    const long = build(['nah alasannya begini sebentar ya data center @ 44-48.31', 'AI itu butuh pasokan listrik raksasa yang stabil 24 jam non-stop tergantung juaca panel surya. @ 48.84-58.42']);
    expect(A.groupTakes([line2], long.pw, { phrases: long.phrases })[0]!.candidates.map((c) => [c.phraseFrom, c.phraseTo, c.coverage])).toEqual([[1, 1, 0.778]]);
    // a gap above 700 ms separates a restart from the take
    const far = build(['Kenapa raksasa terkini meluki dunia, @ 8.26-10.26', 'tiba-tiba perlomba untuk memanggil listrik nuklir ini @ 11.1-14.41']);
    expect(A.groupTakes([hook], far.pw, { phrases: far.phrases })[0]!.candidates.map((c) => [c.phraseFrom, c.phraseTo])).not.toContainEqual([0, 1]);
  });
  it('QA run 5: a badly heard only take is still picked as `weak` inside the script-order window; lenient matching', () => {
    expect(A.lenientWordMatch('berlomba', 'terlomba')).toBe(true);         // similarity 0.875
    expect(A.lenientWordMatch('pembangkit', 'memanggil')).toBe(true);      // 0.6
    expect(A.lenientWordMatch('listrik', 'listening')).toBe(true);         // similarity 0.44, but a shared prefix ≥ 4 letters
    expect(A.lenientWordMatch('pembangkit', 'memakai')).toBe(false);
    expect(A.lenientWordMatch('teknologi', 'terlalu')).toBe(false);        // prefix "te" only
    const hook = 'Kenapa raksasa teknologi dunia tiba-tiba berlomba borong pembangkit listrik nuklir mini buat AI?';
    const line2 = 'Data center AI butuh pasokan listrik raksasa yang stabil 24 jam nonstop tanpa tergantung cuaca seperti panel surya.';
    const { pw, phrases } = build([
      'Kenapa raksasa terlalu hidup di dunia, @ 8.26-10.26', 'tiba-tiba terlomba untuk memakai listrik @ 10.51-14.41',
      'nuklir ini buat AI? Nah alasannya data center AI itu butuh pasokan listrik. @ 19.38-23', 'alasannya data @ 47.19-48.31',
      'senteri AI itu butuh pasokan listrik raksasa yang stabil 24 jam non-stop tergantung juaca seperti panel surya. @ 48.84-58.42',
    ]);
    const groups = A.groupTakes([hook, line2], pw, { phrases });
    expect(groups[0]!.candidates).toEqual([]);                              // 6 of 13 words: below the 60 % fallback
    const r = A.pickTakes(groups, { phraseWords: pw, phrases });
    expect(r.cuts.map((c) => [c.lineIndex, c.confidence, c.startMs, c.endMs, c.coverage])).toEqual([[0, 'weak', 8140, 14560, 0.462], [1, 'ok', 48720, 58570, 0.889]]);
    expect(r.warnings).toContain('line 1: weak match (46 %) — check by ear');
    expect(r.cuts[0]!.text).toBe(hook);                                     // the viewer still reads the script
    expect(r.dropped.map((d) => [d.reason, d.startMs])).toEqual([['adlib', 19380], ['adlib', 47190]]);   // the mixed piece (hook tail + line-2 start) belongs to no single line
    // the window matters: a stray phrase AFTER line 2's take that resembles the hook is not taken for line 1
    const late = build(['eh apa ya @ 8-9', 'senteri AI itu butuh pasokan listrik raksasa yang stabil 24 jam non-stop tergantung juaca seperti panel surya. @ 48.84-58.42', 'kenapa raksasa dunia tiba-tiba @ 60-62']);
    const r2 = A.pickTakes(A.groupTakes([hook, line2], late.pw, { phrases: late.phrases }), { phraseWords: late.pw, phrases: late.phrases });
    expect(r2.cuts.map((c) => c.lineIndex)).toEqual([1]);
    expect(r2.warnings).toContain('line 1 was not found in the recording');
    // script order in pass 1: a later line's candidate before the previous line's take is skipped
    const order = build(['Data center AI butuh pasokan listrik raksasa yang stabil 24 jam nonstop tanpa tergantung cuaca seperti panel surya @ 1-5', 'Kenapa raksasa teknologi dunia tiba-tiba berlomba borong pembangkit listrik nuklir mini buat AI @ 10-14', 'Data center AI butuh pasokan listrik raksasa yang stabil 24 jam nonstop tanpa tergantung cuaca seperti panel surya @ 20-25']);
    const r3 = A.pickTakes(A.groupTakes([hook, line2], order.pw, { phrases: order.phrases }), { phraseWords: order.pw, phrases: order.phrases });
    expect(r3.cuts.map((c) => [c.lineIndex, c.startMs])).toEqual([[0, 9880], [1, 19880]]);
    expect(r3.dropped.map((d) => [d.reason, d.startMs])).toEqual([['retake', 1000]]);
  });
  it('QA run 6: the LAST COMPLETE take wins over an earlier abandoned try with higher coverage; the try is a false start', () => {
    const line = 'Solusi paling realistis saat ini adalah SMR atau Small Modular Reactor';
    const { pw, phrases } = build([
      'Ya, ya, solusi paling realistis saat ini adalah SMR atau @ 60.6-64.8', 'Small Modular. @ 65.1-66.6',          // stopped before "Reactor", redone
      'Pangerialistisa saat ini adalah SMR atau Small Modular Reactor. @ 68.8-75.0',                                 // the real take, opening garbled
    ]);
    const groups = A.groupTakes([line], pw, { phrases });
    // "Pangerialistisa" still matches "realistis" (0.53): the real take covers 9/11, the abandoned try 10/11 — the ending decides
    expect(groups[0]!.candidates.map((c) => [c.phraseFrom, c.phraseTo, c.coverage, c.complete])).toEqual([[0, 0, 0.727, false], [0, 1, 0.909, false], [2, 2, 0.818, true]]);
    expect(groups[0]!.candidates[2]).toMatchObject({ firstMatched: 2, lastMatched: 10 });
    const r = A.pickTakes(groups, { phraseWords: pw, phrases });
    expect(r.cuts.map((c) => [c.startMs, c.endMs, c.coverage, c.confidence])).toEqual([[68680, 75150, 0.818, 'ok']]);
    expect(r.cuts[0]!.text).toBe(line);
    expect(r.warnings).toEqual([]);
    expect(r.dropped.map((d) => [d.reason, d.startMs, d.endMs])).toEqual([['false-start', 60600, 64800], ['false-start', 65100, 66600]]);
    // a garbled opening that matches nothing: 8/11, still complete (first match "saat" within the first 30 %) → chosen as low, with a warning
    const g2 = A.groupTakes([line], [pw[0]!, pw[1]!, pw[2]!.slice(1)], { phrases });
    expect(g2[0]!.candidates[2]).toMatchObject({ coverage: 0.727, complete: true, firstMatched: 3 });
    const rLow = A.pickTakes(g2, { phraseWords: [pw[0]!, pw[1]!, pw[2]!.slice(1)], phrases });
    expect(rLow.cuts.map((c) => [c.startMs, c.confidence])).toEqual([[68680, 'low']]);
    expect(rLow.warnings).toEqual(['line 1: last complete take covers only 73 % of the words']);
    // with no complete take at all the best try is still used, with a warning
    const r2 = A.pickTakes(A.groupTakes([line], pw.slice(0, 2), { phrases: phrases.slice(0, 2) }), { phraseWords: pw.slice(0, 2), phrases: phrases.slice(0, 2) });
    expect(r2.cuts.map((c) => [c.startMs, c.coverage])).toEqual([[60480, 0.909]]);
    expect(r2.warnings).toContain("line 1: no take reaches the line's ending; using the best try");
    // candidateCompleteness: final word matched, or the second-to-last with speech after it; start within 2 words (30 % on long lines)
    expect(A.candidateCompleteness([0, 1, 2, -1], 3).complete).toBe(false);          // stops before the last word, nothing after
    expect(A.candidateCompleteness([0, 1, 2, -1], 4).complete).toBe(true);           // one more spoken word after "Modular"
    expect(A.candidateCompleteness([-1, -1, 1, 2], 3).complete).toBe(false);         // 4-word line: first match at index 2
    expect(A.candidateCompleteness([-1, -1, -1, 3, 4, 5, 6, 7, 8, 9, 10], 11).complete).toBe(true);
    expect(A.candidateCompleteness([-1, -1, -1, -1], 2)).toEqual({ firstMatched: -1, lastMatched: -1, complete: false });
  });
  it('groupTakes tolerates misheard words (similarity ≥ 0.5) and reports lower coverage for missing ones', () => {
    const g = A.groupTakes(['Pembangkit nuklir mini ini mampu menghasilkan energi bersih'], build(['Pembantu klir mini ini mampu menghasilkan energi besih @ 1-4'] ).pw);
    expect(g[0]!.candidates[0]!.coverage).toBe(1);
    const g2 = A.groupTakes(['Pembangkit nuklir mini ini mampu menghasilkan energi bersih'], build(['mini ini mampu menghasilkan energi bersih @ 1-4']).pw);
    expect(g2[0]!.candidates[0]!.coverage).toBeCloseTo(0.75, 3);
  });
  it('pickTakes: last clean take per line, retakes / false starts / ad-libs dropped, extras after the last line kept', () => {
    const r = A.analyzeTakes(script, pw, { phrases, env });
    expect(r.cuts.map((c) => [c.lineIndex, c.startMs, c.endMs])).toEqual([[0, 9880, 13150], [1, 14880, 20150], [2, 21880, 23150], [3, 23880, 25650], [4, 25880, 28150]]);
    expect(r.cuts.map((c) => c.id)).toEqual(['cut-1', 'cut-2', 'cut-3', 'cut-4', 'cut-5']);
    expect(r.cuts[0]!.text).toBe('Halo semua apa kabar hari ini.');
    expect(r.cuts[0]!.words.map((w) => w.text)).toEqual(['Halo', 'semua', 'apa', 'kabar', 'hari', 'ini.']);
    expect(r.cuts[0]!.spoken.map((w) => w.text)).toEqual(['Halo', 'semua', 'apa', 'kabar', 'hari', 'ini']);
    expect(r.cuts[1]!.words.map((w) => w.fromMs)).toEqual(r.cuts[1]!.spoken.map((w) => w.fromMs));   // script spelling, spoken times
    expect(r.cuts[3]!.text).toBe('Tulis di komentar ya.'); expect(r.lines[3]).toMatchObject({ source: 'extra' });
    expect(r.cuts[0]!.quietStartDb).toBe(-60); expect(r.cuts[0]!.confidence).toBe('ok');
    expect(r.dropped.map((d) => [d.reason, d.startMs])).toEqual([['false-start', 1000], ['retake', 3000], ['adlib', 7000]]);
    expect(r.warnings).toEqual([]);
    expect(r.totalMs).toBe(r.cuts.reduce((a, c) => a + c.endMs - c.startMs, 0));
  });
  it('pickTakes: over the budget the earliest extra goes first and the final extra (the CTA) last; script lines never', () => {
    const r1 = A.analyzeTakes(script, pw, { phrases, env, maxTotalMs: 12500 });   // all five = 13.9 s; without the first extra 12.1 s
    expect(r1.cuts.map((c) => c.lineIndex)).toEqual([0, 1, 2, 4]);
    expect(r1.dropped.find((d) => d.reason === 'length')).toMatchObject({ text: 'Tulis di komentar ya.' });
    // the final extra (the Creator's sign-off / CTA) is never dropped: over budget → warning
    const r2 = A.analyzeTakes(script, pw, { phrases, env, maxTotalMs: 10000 });
    expect(r2.cuts.map((c) => c.lineIndex)).toEqual([0, 1, 2, 4]);
    expect(r2.dropped.filter((d) => d.reason === 'length')).toHaveLength(1);
    expect(r2.warnings.some((w) => /over the 10 s budget/.test(w))).toBe(true);
    // two extras 270 ms apart stay two lines (never joined), so the budget can drop the first alone
    const close = build(['Halo semua apa kabar hari ini @ 1-4', 'Tulis di komentar ya @ 6-7.5', 'Dan kalau butuh bantuan DM aku @ 7.77-10']);
    const r3 = A.analyzeTakes('Halo semua apa kabar hari ini.', close.pw, { phrases: close.phrases, maxTotalMs: 6000 });
    expect(r3.lines.map((l) => l.source)).toEqual(['script', 'extra', 'extra']);
    expect(r3.cuts.map((c) => c.text)).toEqual(['Halo semua apa kabar hari ini.', 'Dan kalau butuh bantuan DM aku']);
    expect(r3.dropped).toEqual([{ startMs: 5880, endMs: 7650, text: 'Tulis di komentar ya', reason: 'length', lineIndex: 1 }]);
  });
  it('alignCutWords: script spelling with spoken times, unheard words interpolated, confident extras kept, edge strays dropped', () => {
    const w = (text: string, fromMs: number, conf?: number): A.TimedWord => ({ text, fromMs, toMs: fromMs + 300, ...(conf === undefined ? {} : { conf }) });
    const spoken = [w('nuklir?', 0, 0.9), w('Kamu', 500, 0.95), w('setuju', 800, 0.9), w('gak', 1100, 0.7), w('kalau', 1400, 0.9), w('AI', 1700, 0.9), w('masa', 2000, 0.95), w('depan', 2300, 0.9), w('kita', 2600, 0.9), w('ke', 2900, 0.3), w('tenang', 3200, 0.4), w('kayu', 3500, 0.3), w('yang', 3800, 0.5), w('nuklir', 4100, 0.9), w('eh', 4400, 0.9)];
    const a = A.alignCutWords(spoken, 'Kamu setuju gak kalau AI masa depan ditenagai nuklir?', { span: { fromMs: 500, toMs: 4400 } });
    expect(a.words.map((x) => x.text)).toEqual(['Kamu', 'setuju', 'gak', 'kalau', 'AI', 'masa', 'depan', 'kita', 'ditenagai', 'nuklir?']);
    expect(a.text).toBe('Kamu setuju gak kalau AI masa depan kita ditenagai nuklir?');
    expect(a.words[0]).toMatchObject({ fromMs: 500, toMs: 800 });                     // spoken time, script spelling
    expect(a.words[7]).toMatchObject({ text: 'kita', fromMs: 2600, conf: 0.9 });       // a confident extra between matched words
    const dit = a.words[8]!; expect(dit.fromMs).toBeGreaterThanOrEqual(2900); expect(dit.toMs).toBeLessThanOrEqual(4100);   // unheard word: interpolated between neighbours
    expect(a.droppedLeading.map((x) => x.text)).toEqual(['nuklir?']); expect(a.droppedTrailing.map((x) => x.text)).toEqual(['eh']);
    expect(a.extras).toBe(1); expect(a.matched).toBe(8);
    for (let k = 1; k < a.words.length; k++) expect(a.words[k]!.fromMs).toBeGreaterThanOrEqual(a.words[k - 1]!.toMs);
    // low-confidence extras vanish; nothing heard → the whole line spread over the span
    expect(A.alignCutWords([w('Kamu', 0, 0.9), w('itu', 300, 0.5), w('setuju', 600, 0.9)], 'Kamu setuju').words.map((x) => x.text)).toEqual(['Kamu', 'setuju']);
    const none = A.alignCutWords([], 'Satu dua tiga', { span: { fromMs: 1000, toMs: 2500 } });
    expect(none.words.map((x) => [x.text, x.fromMs, x.toMs])).toEqual([['Satu', 1000, 1600], ['dua', 1600, 1900], ['tiga', 1900, 2500]]);   // syllable weights 2 : 1 : 2
  });
  it('E2E run 1: vocabulary snap ("senter" → "center") and ad-lib function words kept from conf 0.6', () => {
    const vocab = A.scriptVocabulary(['Data center AI butuh pasokan listrik.', 'Solusi paling realistis adalah SMR atau Small Modular Reactor—yaitu reaktor kecil.'], ['DM', 'Google']);
    expect(vocab).toEqual(['Data', 'center', 'AI', 'butuh', 'pasokan', 'listrik', 'Solusi', 'paling', 'realistis', 'adalah', 'SMR', 'atau', 'Small', 'Modular', 'Reactor', 'yaitu', 'reaktor', 'kecil', 'DM', 'Google']);
    expect(A.snapToVocabulary('senter', vocab)).toBe('center');
    expect(A.snapToVocabulary('senteri,', vocab)).toBe('center,');
    expect(A.snapToVocabulary('Senter', vocab)).toBe('center');
    expect(A.snapToVocabulary('center', vocab)).toBe('center');                     // already right: unchanged
    expect(A.snapToVocabulary('Pembantu', vocab)).toBeNull();                      // nothing within 0.6
    expect(A.snapToVocabulary('reakto', ['reaktor', 'reaktos'])).toBeNull();        // two vocabulary words tie (0.857 each) → no snap
    // heard words: a confident word is left alone unless the spelling is nearly the same; without a probability it counts as confident
    const tw = (text: string, conf?: number): A.TimedWord => ({ text, fromMs: 0, toMs: 300, ...(conf === undefined ? {} : { conf }) });
    expect(A.snapHeardWord(tw('kalian', 0.95), ['kalau']).text).toBe('kalian');      // 0.67 only
    expect(A.snapHeardWord(tw('kalian'), ['kalau']).text).toBe('kalian');
    expect(A.snapHeardWord(tw('senteri', 0.5), vocab).text).toBe('center');          // unsure: 0.71 is enough
    expect(A.snapHeardWord(tw('senter', 0.95), vocab).text).toBe('center');          // sure, but 0.83
    expect(A.snapToVocabulary('…', vocab)).toBeNull();
    const w = (text: string, fromMs: number, conf?: number): A.TimedWord => ({ text, fromMs, toMs: fromMs + 300, ...(conf === undefined ? {} : { conf }) });
    // "Data senter AI itu butuh": "itu" (function word) stays from conf 0.6; a content word needs 0.85; snapped spelling for kept extras
    const a = A.alignCutWords([w('Data', 0, 0.9), w('senter', 300, 0.7), w('AI', 600, 0.9), w('itu', 900, 0.65), w('butuh', 1200, 0.9), w('banget', 1500, 0.7), w('pasokan', 1800, 0.9), w('listriknya', 2100, 0.9)], 'Data center AI butuh pasokan listrik.', { vocabulary: vocab });
    expect(a.text).toBe('Data center AI itu butuh pasokan listrik.');
    expect(a.words[3]).toMatchObject({ text: 'itu', conf: 0.65 });
    expect(A.alignCutWords([w('Data', 0, 0.9), w('center', 300, 0.9), w('AI', 600, 0.9), w('itu', 900, 0.5), w('butuh', 1200, 0.9)], 'Data center AI butuh').text).toBe('Data center AI butuh');   // 0.5 < 0.6
    expect(A.alignCutWords([w('Data', 0, 0.9), w('center', 300, 0.9), w('AI', 600, 0.9), w('senteri', 900, 0.86), w('butuh', 1200, 0.9)], 'Data center AI butuh', { vocabulary: vocab }).text).toBe('Data center AI senteri butuh');   // kept (≥ 0.85) but confident → not snapped at 0.71
    expect(A.alignCutWords([w('Data', 0, 0.9), w('center', 300, 0.9), w('AI', 600, 0.9), w('senter', 900, 0.86), w('butuh', 1200, 0.9)], 'Data center AI butuh', { vocabulary: vocab }).text).toBe('Data center AI center butuh');     // nearly the same spelling (0.83) → snapped
    // an extra line keeps the spoken words, spelled with the script's vocabulary
    const { pw, phrases } = build(['Data center AI butuh pasokan listrik @ 1-4', 'Dan kalau butuh solusi data senter bisa DM aku ya @ 6-9']);
    const r = A.analyzeTakes('Data center AI butuh pasokan listrik.', pw, { phrases, vocabulary: ['DM'] });
    expect(r.cuts[1]!.text).toBe('Dan kalau butuh solusi data center bisa DM aku ya');
    expect(r.lines[1]!.text).toBe('Dan kalau butuh solusi data center bisa DM aku ya');
    expect(r.cuts[1]!.spoken.map((x) => x.text)).toContain('senter');
  });
  it('pickTakes: a take that does not end in silence is skipped for an earlier clean one, else kept with a warning', () => {
    const noisy = envFor(phrases, 30000); for (let k = 13000 / 10; k < 13600 / 10; k++) noisy.db[k] = -30;   // noise right after the retake of line 1
    const r = A.pickTakes(A.groupTakes(A.splitScriptLines(script), pw, { phrases }), { env: noisy, phraseWords: pw, phrases });
    expect(r.cuts[0]!.startMs).toBe(2880);                                   // the earlier clean take wins
    expect(r.dropped.find((d) => d.startMs === 10000)).toMatchObject({ reason: 'retake' });
    const onlyNoisy = envFor(phrases.slice(0, 2), 30000); for (let k = 6000 / 10; k < 7000 / 10; k++) onlyNoisy.db[k] = -30;
    const r2 = A.pickTakes(A.groupTakes(['Halo semua apa kabar hari ini.'], pw.slice(0, 2), { phrases: phrases.slice(0, 2) }), { env: onlyNoisy });
    expect(r2.cuts).toHaveLength(1); expect(r2.warnings[0]).toMatch(/no take ends in silence/);
  });
  it('pickTakes: a line that was never said is reported, a low-coverage take is marked low', () => {
    const r = A.analyzeTakes('Satu dua tiga empat lima. Kalimat yang tidak pernah diucapkan sama sekali.', build(['Satu dua tiga @ 1-2']).pw);
    expect(r.cuts).toHaveLength(1); expect(r.cuts[0]!.confidence).toBe('low'); expect(r.cuts[0]!.coverage).toBe(0.6);
    expect(r.warnings[0]).toMatch(/covers only 60 %/);
    expect(r.warnings).toContain('line 2 was not found in the recording');
  });
  it('pickTakes: two short lines said in one breath share one cut', () => {
    const r = A.analyzeTakes('Halo semua. Apa kabar?', build(['Halo semua apa kabar @ 1-3']).pw);
    expect(r.cuts).toHaveLength(1); expect(r.cuts[0]!.text).toBe('Halo semua. Apa kabar?');
  });
});

describe.skipIf(!kitReady() || !existsSync(LISTEN_JSON))('analysis/takes (Reels 42 kit)', () => {
  it('8 cuts each overlapping the key ≥ 90 %, CTA kept as an extra, "Tulis pendapat…" dropped for length, "Nah alasannya" ad-lib, false starts dropped', () => {
    const pcm = decodePcm16k(RAW_AUDIO); const env = A.makeEnvelope(pcm, 16000, 10);
    const phrases = A.findPhrases(env);
    const plan = A.joinPlan(phrases, { gapMs: 2000, padMs: 150, durationMs: (pcm.length / 16000) * 1000 });
    const pw = A.mapJoinedWords(readListenWords(), plan);
    const r = A.analyzeTakes(SCRIPT, pw, { phrases, env, maxTotalMs: MAX_SPEECH_MS });
    const overlaps = r.cuts.map((c) => Math.max(...KEY_CUTS.map(([a, b]) => overlapRatio(c.startMs, c.endMs, a * 1000, b * 1000))));
    // eslint-disable-next-line no-console
    console.log(`[kit] ${r.cuts.length} cuts, total ${r.totalMs} ms (budget ${MAX_SPEECH_MS}); overlaps ${overlaps.map((o) => (o * 100).toFixed(1) + '%').join(' ')}\n` + r.cuts.map((c) => `  ${c.id} line ${c.lineIndex} ${(c.startMs / 1000).toFixed(2)}-${(c.endMs / 1000).toFixed(2)} q ${c.quietStartDb}/${c.quietEndDb} cov ${c.coverage} ${c.confidence} "${c.text.slice(0, 50)}"`).join('\n') + '\n  dropped: ' + r.dropped.map((d) => `${d.reason} ${(d.startMs / 1000).toFixed(2)}-${(d.endMs / 1000).toFixed(2)} "${d.text.slice(0, 30)}"`).join('; ') + `\n  warnings: ${JSON.stringify(r.warnings)}`);
    expect(r.cuts).toHaveLength(8);
    expect(overlaps.filter((o) => o >= 0.9).length).toBeGreaterThanOrEqual(7);
    expect(r.totalMs).toBeLessThanOrEqual(MAX_SPEECH_MS);
    const cta = r.cuts[7]!;
    expect(r.lines[cta.lineIndex]!.source).toBe('extra'); expect(cta.text).toMatch(/solusi data center bisa DM aku/i);   // spoken text, script spelling
    expect(r.dropped.find((d) => d.reason === 'length')?.text).toMatch(/kolom komentar/i);
    expect(r.dropped.find((d) => d.startMs > 47000 && d.startMs < 47500)).toMatchObject({ reason: 'adlib' });
    expect(r.dropped.filter((d) => d.reason === 'false-start').length).toBeGreaterThanOrEqual(3);
    expect(r.dropped.find((d) => d.startMs > 60000 && d.startMs < 61000)).toMatchObject({ reason: 'false-start' });   // "Ya solusi … Small Modular" stopped before "Reactor"
    // edges: the 100 ms outside every cut edge on the raw recorder audio (QA measure); ≤ −43 dB is the target, a warning otherwise
    const edges = r.cuts.flatMap((c) => [c.quietStartDb, c.quietEndDb]);
    // eslint-disable-next-line no-console
    console.log(`[kit] edge peaks (dB) ${r.cuts.map((c) => `${c.quietStartDb}/${c.quietEndDb}`).join(' ')}`);
    expect(Math.max(...edges)).toBeLessThanOrEqual(-40);
    expect(edges.filter((d) => d <= -43).length).toBeGreaterThanOrEqual(14);
    // every cut starts just before its first word (pad 120 ms ± snap 200 ms) and ends just after the last
    for (const [k, c] of r.cuts.entries()) { const [a, b] = KEY_CUTS[k]!; expect(Math.abs(c.startMs - a * 1000)).toBeLessThanOrEqual(350); expect(Math.abs(c.endMs - b * 1000)).toBeLessThanOrEqual(350); }
    // caption words = the script aligned to what was heard: ≤ 3 word errors against the key's 109 words
    const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const mine = r.cuts.flatMap((c) => c.words.map((w) => norm(w.text))).filter(Boolean);
    const key = readKeyWords().map((w) => norm(w.text));
    const errors = wordEditDistance(mine, key);
    // eslint-disable-next-line no-console
    console.log(`[kit] caption words: ${mine.length} vs key ${key.length}, ${errors} word errors; cut texts:\n  ` + r.cuts.map((c) => c.text).join('\n  '));
    expect(errors).toBeLessThanOrEqual(3);
  });
});
/** Levenshtein distance on word lists. */
function wordEditDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length]!;
}
// (kit helpers above are only used by the kit describe)
