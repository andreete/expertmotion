// Word timing from syllables (FR-283): the caption words of a cut get their times from the AUDIO, not from the recogniser —
// inside every voiced range (between pauses ≥ 120 ms) the words are spread in proportion to their syllable counts; the
// recogniser's words serve only as a soft guide for which words fall into which range. Indonesian is close to syllable-timed,
// so this lands within ~0.1 s of forced alignment for read speech.
import { alignWords, gluedNumber, normWord, spokenFormId } from '../transcript.js';
import { bandpassPcm, median, percentile, rmsEnvelopeDbF } from './pcm.js';
import type { TimedWord, VoicedRange } from './types.js';

/** Words a speaker tends to pause BEFORE: coordinating conjunctions and subordinators (Indonesian + a few English). Prepositions
 *  and relative markers ("yang", "tanpa", "dengan") are NOT here: measured on read speech the pause falls as often after them. */
const PAUSE_BEFORE = new Set(['atau', 'dan', 'tapi', 'tetapi', 'namun', 'karena', 'sebab', 'kalau', 'jika', 'bila', 'agar', 'supaya', 'sehingga', 'lalu', 'kemudian', 'serta',
  'meski', 'walau', 'yaitu', 'yakni', 'sementara', 'ketika', 'and', 'or', 'but', 'because', 'then']);
const NUMBER_START = /^(\d|nol\b|satu\b|dua\b|tiga\b|empat\b|lima\b|enam\b|tujuh\b|delapan\b|sembilan\b|sepuluh\b|sebelas\b|seratus\b|seribu\b|setengah\b)/i;
/**
 * Cost change (syllable units) for putting a pause between `prev` and `next`: cheaper after punctuation and before a
 * conjunction / preposition / number (where read speech breathes), impossible inside a number phrase ("dua puluh | empat").
 */
export function pauseBoundaryCost(prev: string, next: string): number {
  if (gluedNumber(prev, next)) return 2.5;
  let c = 0;
  if (/[,;:.!?…—–]["')\]]*$/.test(prev)) c -= 1;
  const n = normWord(next);
  if (PAUSE_BEFORE.has(n) || NUMBER_START.test(next.replace(/^[^\p{L}\p{N}]+/u, ''))) c -= 0.8;
  return c;
}

/** Vowel pairs spoken as one syllable only at the END of a word (pakai, kalau, atau, sepoi); elsewhere they are two (ya-i-tu, la-ut, du-a). */
const FINAL_DIPHTHONGS = new Set(['ai', 'au', 'oi']);
const isVowel = (c: string): boolean => 'aeiou'.includes(c);

/** Syllables of one spoken word: Indonesian vowel groups with hiatus (cu-a-ca 3, re-ak-tor 3, re-a-lis-tis 4, ya-i-tu 3),
 *  digits spoken in Indonesian (24 → dua puluh empat → 6), acronyms in capitals spelled letter by letter (AI 2, SMR 3, DM 2). */
export function syllableCount(word: string, lang = 'id'): number {
  const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!bare) return 0;
  if (/\d/.test(bare)) return Math.max(1, spokenFormId(word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, '')).reduce((s, w) => s + (/\d/.test(w) ? 1 : syllableCount(w, lang)), 0));   // "17,2%" keeps its percent
  if (/^[A-Z][A-Z0-9]{1,3}$/.test(bare)) return bare.length;                       // AI, SMR, DM, QR, CPU
  if (bare.includes('-')) return bare.split('-').reduce((s, p) => s + syllableCount(p, lang), 0);
  const w = normWord(bare, lang); let n = 0;
  for (let i = 0; i < w.length; i++) {
    if (!isVowel(w[i]!)) continue;
    const prev = w[i - 1];
    if (prev !== undefined && isVowel(prev)) {
      const pair = prev + w[i]!;
      if (FINAL_DIPHTHONGS.has(pair) && i === w.length - 1 && n > 0) continue;   // one group with the previous vowel
      if (lang !== 'id' && n > 0) continue;                                      // other languages: plain vowel groups
    }
    n++;
  }
  return Math.max(1, n);
}

/**
 * Acoustic syllable nuclei: energy peaks of the vowel band (1.5 kHz band-pass, 5 ms RMS in dB, 15 ms smoothing) that rise
 * ≥ `promDb` above the valley since the previous peak and sit ≥ `minDistMs` apart. Measured on read Indonesian speech: ±1.5
 * syllables per voiced range (undercounts fast speech, overcounts slow foreign words), so it is evidence, not a count.
 */
export interface NucleiEnvelope { db: Float64Array; hopMs: number; floorDb: number }
export function nucleiEnvelope(pcm: Int16Array, sr: number): NucleiEnvelope {
  const db = rmsEnvelopeDbF(bandpassPcm(pcm, sr, 1500, 0.7), sr, 5);
  const p10 = percentile(db, 0.1), p97 = percentile(db, 0.97);
  return { db, hopMs: 5, floorDb: p10 + 0.35 * (p97 - p10) };
}
export function syllableNuclei(ne: NucleiEnvelope, range: VoicedRange, o: { promDb?: number; minDistMs?: number; smoothFrames?: number } = {}): number[] {
  const prom = o.promDb ?? 3, minDist = Math.round((o.minDistMs ?? 70) / ne.hopMs), half = Math.floor((o.smoothFrames ?? 3) / 2);
  const a = Math.max(0, Math.floor(range.fromMs / ne.hopMs)), b = Math.min(ne.db.length, Math.ceil(range.toMs / ne.hopMs));
  const sm = new Float64Array(Math.max(0, b - a));
  for (let i = a; i < b; i++) { let s = 0, n = 0; for (let k = -half; k <= half; k++) { const v = ne.db[i + k]; if (v !== undefined && i + k >= a && i + k < b) { s += v; n++; } } sm[i - a] = s / Math.max(1, n); }
  const peaks: number[] = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (!(sm[i]! > sm[i - 1]! && sm[i]! >= sm[i + 1]!) || sm[i]! < ne.floorDb) continue;
    const prev = peaks.length ? peaks[peaks.length - 1]! : 0;
    let valley = Infinity; for (let k = prev; k <= i; k++) valley = Math.min(valley, sm[k]!);
    const okProm = sm[i]! - valley >= prom, okDist = !peaks.length || i - prev >= minDist;
    if (okProm && okDist) peaks.push(i);
    else if (peaks.length && !okDist && sm[i]! > sm[prev]!) peaks[peaks.length - 1] = i;      // a higher peak within the distance replaces it
  }
  return peaks.map((i) => (a + i) * ne.hopMs);
}

/** Range index whose window is nearest to `ms` (inside = 0). */
const nearestRange = (ms: number, ranges: readonly VoicedRange[]): number => {
  let best = 0, bestD = Infinity;
  ranges.forEach((r, k) => { const d = ms < r.fromMs ? r.fromMs - ms : ms > r.toMs ? ms - r.toMs : 0; if (d < bestD) { bestD = d; best = k; } });
  return best;
};

/**
 * Which voiced range every word belongs to (monotonic). A dynamic programme spreads the words so each range's duration
 * matches its syllables at the overall speaking rate; recognised words (`guide`, recording time) pull their matched script
 * words towards the range they were heard in. Ranges may stay empty (a breath, a cough).
 */
export interface AssignOptions {
  /** cost per word placed in another range than the recogniser heard it (syllable units); 2 when the recogniser saw the ranges one by one, lower for coarse guides */
  guideWeight?: number;
  /** weight of the even-speaking-rate model (0.25: speakers slow down for numbers and foreign words) */
  durationWeight?: number;
  /** acoustic syllable nuclei per range (syllableNuclei); weight `nucleiWeight` (1) */
  nuclei?: readonly number[]; nucleiWeight?: number;
  /** weight of the pause-position prior (pauseBoundaryCost), 1 */
  pauseWeight?: number;
  /** the guide is ignored when the median gap between its word times and an even reading of the ranges exceeds this (800 ms:
   *  measured on whisper small, usable guides deviate 250–720 ms, shifted ones 940–1500 ms) */
  guideMaxDevMs?: number;
}

/** How self-consistent a recogniser guide is: median |guide midpoint − even-rate midpoint| over the matched words (ms). */
export function guideReliability(words: readonly string[], guide: readonly TimedWord[], ranges: readonly VoicedRange[]): { medianDevMs: number; matched: number; map: number[] } {
  const map = alignWords(words, guide.map((t) => t.text), { minSim: 0.6 });
  const syl = words.map((w) => Math.max(1, syllableCount(w))); const total = syl.reduce((a, b) => a + b, 0) || 1;
  const voiced = ranges.reduce((a, r) => a + Math.max(0, r.toMs - r.fromMs), 0);
  // even reading: walk the syllables through the ranges in order (pauses skipped)
  const mids: number[] = []; let acc = 0;
  for (let i = 0; i < words.length; i++) {
    const centre = ((acc + syl[i]! / 2) / total) * voiced; acc += syl[i]!;
    let left = centre, ms = ranges[ranges.length - 1]?.toMs ?? 0;
    for (const r of ranges) { const d = r.toMs - r.fromMs; if (left <= d) { ms = r.fromMs + left; break; } left -= d; }
    mids.push(ms);
  }
  const devs: number[] = [];
  map.forEach((j, i) => { if (j >= 0) devs.push(Math.abs((guide[j]!.fromMs + guide[j]!.toMs) / 2 - mids[i]!)); });
  return { medianDevMs: devs.length ? median(devs) : Infinity, matched: devs.length, map };
}
export function assignWordsToRanges(words: readonly string[], guide: readonly TimedWord[] | null | undefined, ranges: readonly VoicedRange[], o: AssignOptions = {}): number[] {
  const N = words.length, M = ranges.length;
  if (!N) return []; if (M <= 1) return new Array<number>(N).fill(0);
  const syl = words.map((w) => Math.max(1, syllableCount(w)));
  const cum = new Float64Array(N + 1); for (let i = 0; i < N; i++) cum[i + 1] = cum[i]! + syl[i]!;
  const dur = ranges.map((r) => Math.max(1, r.toMs - r.fromMs)); const totalDur = dur.reduce((a, b) => a + b, 0);
  const unit = totalDur / cum[N]!;                                                  // ms per syllable
  // guide: script word i → range index (or -1); dropped altogether when the recogniser's times are not self-consistent
  const g = new Array<number>(N).fill(-1);
  const rel = guide?.length ? guideReliability(words, guide, ranges) : null;
  if (guide?.length && rel && rel.medianDevMs <= (o.guideMaxDevMs ?? 800)) rel.map.forEach((j, i) => { if (j >= 0) g[i] = nearestRange((guide[j]!.fromMs + guide[j]!.toMs) / 2, ranges); });
  // nuclei counts scaled so their total equals the syllables (the detector under-counts fast speech systematically)
  const nuc = o.nuclei && o.nuclei.length === M ? o.nuclei : null;
  const nucScale = nuc ? cum[N]! / Math.max(1, nuc.reduce((a, b) => a + b, 0)) : 1;
  const lambda = o.guideWeight ?? 2, wd = o.durationWeight ?? 0.25, wn = o.nucleiWeight ?? 1, wp = o.pauseWeight ?? 1;
  const cost = (a: number, b: number, k: number): number => {                       // words a..b-1 in range k, in syllable units
    const s = cum[b]! - cum[a]!;
    let c = (wd * Math.abs(s * unit - dur[k]!)) / unit;
    if (nuc) c += wn * Math.abs(s - nuc[k]! * nucScale);
    if (b > a && a > 0) c += wp * pauseBoundaryCost(words[a - 1]!, words[a]!);
    for (let i = a; i < b; i++) if (g[i]! >= 0 && g[i] !== k) c += lambda * Math.abs(g[i]! - k);
    return c;
  };
  const INF = Infinity;
  let prev = new Float64Array(N + 1).fill(INF); prev[0] = 0;                         // best[k][i]: first i words in ranges 0..k-1
  const choice: Int32Array[] = [];
  for (let k = 0; k < M; k++) {
    const cur = new Float64Array(N + 1).fill(INF); const from = new Int32Array(N + 1).fill(-1);
    for (let i = 0; i <= N; i++) {
      for (let a = 0; a <= i; a++) {
        if (prev[a] === INF) continue;
        const v = prev[a]! + cost(a, i, k);
        if (v < cur[i]!) { cur[i] = v; from[i] = a; }
      }
    }
    choice.push(from); prev = cur;
  }
  const out = new Array<number>(N).fill(M - 1);
  let i = N;
  for (let k = M - 1; k >= 0; k--) { const a = choice[k]![i]!; for (let x = a; x < i; x++) out[x] = k; i = a; }
  return out;
}

/**
 * Times for `words` inside the voiced ranges: words assigned to ranges (assignWordsToRanges), then spread by syllables
 * inside each range. Words of an empty assignment never happen; a range without words is simply silence. With no ranges the
 * words are spread over `fallback` (or left at 0).
 */
export function timeWordsBySyllables(words: readonly string[], voiced: readonly VoicedRange[], o: AssignOptions & { guide?: readonly TimedWord[] | null; fallback?: VoicedRange } = {}): TimedWord[] {
  if (!words.length) return [];
  const ranges = voiced.length ? voiced : [o.fallback ?? { fromMs: 0, toMs: 0 }];
  const { guide, fallback: _f, ...assignOpts } = o; void _f;
  const assign = assignWordsToRanges(words, guide, ranges, assignOpts);
  const out: TimedWord[] = [];
  for (let k = 0; k < ranges.length; k++) {
    const idx: number[] = []; assign.forEach((r, i) => { if (r === k) idx.push(i); });
    if (!idx.length) continue;
    const r = ranges[k]!; const span = Math.max(0, r.toMs - r.fromMs);
    const syl = idx.map((i) => Math.max(1, syllableCount(words[i]!))); const total = syl.reduce((a, b) => a + b, 0);
    let at = r.fromMs;
    idx.forEach((i, n) => { const d = (syl[n]! / total) * span; out.push({ text: words[i]!, fromMs: Math.round(at), toMs: Math.round(at + d) }); at += d; });
  }
  for (let k = 1; k < out.length; k++) if (out[k]!.fromMs < out[k - 1]!.toMs) out[k]!.fromMs = out[k - 1]!.toMs;
  return out;
}
