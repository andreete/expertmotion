// Take picking (FR-282, ADR-039): which phrases of the recording are the Creator's final take of every script line.
//
//   script ──splitScriptLines──▶ lines
//   lines × phrase transcripts ──DP alignment (alignWords / wordSimilarity)──▶ candidates per line (runs of 1–4 consecutive
//   phrases whose words cover ≥ 80 % of the line; shortest run anchored at its last phrase)
//   pickTakes: the LAST candidate per line with a clean end (quiet within 100 ms after it); earlier full candidates →
//   'retake'; partial attempts → 'false-start'; words matching no line → 'adlib' before the last script line, an `extra`
//   line after it (the Creator's own sign-off / call to action is kept); over the length budget the extras go first, the
//   final extra last. Cuts get a pad before / after and snap to the quietest frame nearby.
//
// The recogniser's text is used only to recognise WHICH line was said; times come from the energy-based phrases.
import { alignWords, normWord, proportionalTimes, splitWords, wordSimilarity } from '../transcript.js';
import { isQuietAround, silenceDbAt, type EnvelopeDb } from './phrases.js';
import type { Cut, DropReason, Dropped, Phrase, ScriptLine, TakeCandidate, TakeGroup, TimedWord } from './types.js';

// ───────────────────────────── script → lines ─────────────────────────────
/** Abbreviations whose full stop never ends a sentence (Indonesian script conventions). */
const ABBREV_END = /(^|[\s(])(rp|dll|dsb|dst|jl|no|tgl|hal|dr|prof|bpk|sdr|yth|s\.d|a\.n|u\.p)\.$/i;
/**
 * Sentences of a script as the Creator pastes it (QA 2026-10-31: brief text with "[00:00 - 00:05] HOOK (Kamu bicara…):" headers
 * and stray ": " fragments). Removed first: bracketed timecodes / directions, parentheticals (a single lowercase word stays),
 * ALL-CAPS label tokens before a colon, quotes and emoji. Then a break at every line break, at . ! ? … followed by whitespace
 * (decimals "1.5", thousands "2.000" and abbreviations "Rp." "dll." stay), at a colon followed by whitespace, and at dashes used
 * as a break (— – or a spaced hyphen). Each line loses leading / trailing punctuation and colons; headings (≤ 2 words ending in a
 * colon) and lines under 2 words are dropped. Commas never split, so "SMR atau Small Modular Reactor" stays one line.
 */
export function splitScriptLines(script: string): string[] {
  const clean = script
    .replace(/\[[^\]]*\]/g, ' ')                                                          // [00:00 - 00:05], [durasi 3-4 detik]
    .replace(/\([^)]*\)/gu, (m) => (/^\(\p{Ll}+\)$/u.test(m) ? m : ' '))                   // (CUT KE VIDEO EBS — …), (Kamu Bicara ke Kamera)
    .replace(/(^|[\s:])[A-Z][A-Z0-9 ]{1,24}:/g, '$1 ')                                    // HOOK: / PENJELASAN :
    .replace(/[“”"«»]/g, ' ').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/\r/g, '');
  const parts: string[] = [];
  for (const para of clean.split('\n')) {
    const marked = para
      .replace(/[.!?…]+(?=\s|$)/g, (m, off: number, s: string) => (ABBREV_END.test(s.slice(0, off + m.length)) ? m : `${m}\u0000`))   // sentence end
      .replace(/:(?=\s|$)/g, ':\u0000')                                                   // "Naskah Video:" / "Link :" headings
      .replace(/\s*[—–]\s*|\s+-\s+/g, '\u0000');                                          // dash breaks
    for (const s of marked.split('\u0000')) {
      const heading = /:\s*$/.test(s);
      const t = s.replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/[\s:;,\-–—]+$/u, '');
      const n = splitWords(t).length;
      if (!/\p{L}/u.test(t) || n < 2 || (heading && n <= 2)) continue;
      parts.push(t);
    }
  }
  return parts;
}
export const toScriptLines = (lines: ReadonlyArray<string | ScriptLine>): ScriptLine[] =>
  lines.map((l, index) => (typeof l === 'string' ? { index, text: l, source: 'script' as const } : { ...l, index }));

// ───────────────────────────── coverage ─────────────────────────────
export interface GroupOptions {
  minCoverage?: number; fallbackCoverage?: number; minSim?: number;
  /** a take may span up to this many CONSECUTIVE phrases (4) whose gaps are ≤ `maxJoinGapMs` (700 — a breath inside a sentence; a restart pauses longer) */
  maxRun?: number; maxJoinGapMs?: number;
  /** an earlier phrase that mostly belongs to another line / an ad-lib may still open a take when it is short (< 1500 ms: a word lost to the previous piece) and adds coverage */
  shortLeadMs?: number;
  phrases?: readonly Phrase[];
}
/** Lenient word match for weak recognition (QA run 5: "terlomba" for "berlomba"): similarity ≥ `minSim`, or a shared prefix of ≥ 4 letters. */
export function lenientWordMatch(script: string, spoken: string, minSim = 0.5): boolean {
  if (wordSimilarity(script, spoken) >= minSim) return true;
  const a = normWord(script), b = normWord(spoken); let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= 4;
}
/** Line word i → spoken index (or −1) by the monotonic alignment, kept only for lenient matches (the alignment itself pairs down to similarity 0.35). */
const matchedMap = (line: readonly string[], spoken: readonly string[], minSim: number): number[] =>
  alignWords(line, spoken, { minSim: Math.min(0.35, minSim) }).map((j, i) => (j >= 0 && lenientWordMatch(line[i]!, spoken[j]!, minSim) ? j : -1));
const matchedCount = (line: readonly string[], spoken: readonly string[], minSim: number): number => matchedMap(line, spoken, minSim).filter((j) => j >= 0).length;
/**
 * Does a take reach the line's ENDING (QA run 6: "Ya, ya, solusi … Small Modular" stopped before "Reactor" and was redone — a
 * false start despite 91 % coverage)? Complete = the last matched line word is the final word, or the second-to-last with at
 * least one more spoken word after it (the ending was said but garbled); and the first matched word lies within the first two
 * words (first 30 % on lines over six words: a garbled opening such as "Pangerialistisa" for "paling realistis").
 */
export function candidateCompleteness(map: readonly number[], spokenCount: number): { firstMatched: number; lastMatched: number; complete: boolean } {
  const n = map.length; let first = -1, last = -1;
  map.forEach((j, i) => { if (j >= 0) { if (first < 0) first = i; last = i; } });
  if (first < 0) return { firstMatched: -1, lastMatched: -1, complete: false };
  const endOk = last === n - 1 || (last === n - 2 && map[last]! < spokenCount - 1);
  const startOk = first <= Math.max(1, Math.floor(0.3 * n));
  return { firstMatched: first, lastMatched: last, complete: endOk && startOk };
}
const spanOf = (words: ReadonlyArray<readonly TimedWord[]>, i: number, j: number, phrases?: readonly Phrase[]): { startMs: number; endMs: number } => {
  if (phrases) return { startMs: phrases[i]!.fromMs, endMs: phrases[j]!.toMs };
  let s = Infinity, e = -Infinity;
  for (let k = i; k <= j; k++) for (const w of words[k]!) { s = Math.min(s, w.fromMs); e = Math.max(e, w.toMs); }
  return Number.isFinite(s) ? { startMs: s, endMs: e } : { startMs: 0, endMs: 0 };
};

/**
 * Candidate takes per script line. For every end phrase j the shortest run i..j (≤ `maxRun` phrases, gaps ≤ `maxJoinGapMs`)
 * whose words cover ≥ `minCoverage` of the line is a candidate; when no run reaches it, the best run ≥ `fallbackCoverage`
 * is kept as a low-confidence candidate. Coverage = matched line words / line words; precision = matched / spoken words.
 */
export function groupTakes(lines: ReadonlyArray<string | ScriptLine>, phraseWords: ReadonlyArray<readonly TimedWord[]>, o: GroupOptions = {}): TakeGroup[] {
  const minCov = o.minCoverage ?? 0.8, fallback = o.fallbackCoverage ?? 0.6, minSim = o.minSim ?? 0.5, maxRun = o.maxRun ?? 4, maxGap = o.maxJoinGapMs ?? 700, shortLead = o.shortLeadMs ?? 1500;
  const scriptLines = toScriptLines(lines);
  const texts = phraseWords.map((ws) => ws.map((w) => w.text));
  const P = phraseWords.length;
  return scriptLines.filter((l) => l.source === 'script').map((line) => {
    const lw = splitWords(line.text); const candidates: TakeCandidate[] = [];
    if (!lw.length) return { lineIndex: line.index, line, candidates };
    // a run may start or end only with a phrase that mostly belongs to this line (≥ 50 % of its words match), so a neighbouring
    // ad-lib or another line's phrase is never glued onto a take
    const own = texts.map((t) => (t.length ? matchedCount(lw, t, minSim) / t.length : 0));
    for (let j = 0; j < P; j++) {
      if (!texts[j]!.length || own[j]! < 0.5) continue;
      let best: TakeCandidate | null = null; let prevMatched = -1; let run: string[] = [];
      for (let i = j; i >= 0 && j - i < maxRun; i--) {
        if (i < j) {
          const here = spanOf(phraseWords, i, i, o.phrases);
          const gap = spanOf(phraseWords, i + 1, i + 1, o.phrases).startMs - here.endMs;
          // a phrase that mostly belongs elsewhere opens the take only when it is short (a word lost to the previous piece), never a long ad-lib
          if (gap > maxGap || (own[i]! < 0.5 && here.endMs - here.startMs >= shortLead)) break;
        }
        run = [...texts[i]!, ...run];
        const map = matchedMap(lw, run, minSim); const m = map.filter((v) => v >= 0).length;
        if (i < j && m <= prevMatched) break;                          // the added phrase contributed nothing
        prevMatched = m;
        const coverage = m / lw.length, precision = run.length ? m / run.length : 0;
        if (coverage >= minCov || !best || coverage > best.coverage) {
          const span = spanOf(phraseWords, i, j, o.phrases);
          best = { phraseFrom: i, phraseTo: j, ...span, coverage: round3(coverage), precision: round3(precision), ...candidateCompleteness(map, run.length), words: phraseWords.slice(i, j + 1).flat() };
        }
        if (coverage >= minCov) break;                                 // shortest run that covers the line
      }
      if (best && best.coverage >= fallback) candidates.push(best);
    }
    candidates.sort((a, b) => a.endMs - b.endMs);
    return { lineIndex: line.index, line, candidates };
  });
}
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Share of a phrase's words that belong to some line (best line), for the false-start / ad-lib decision. */
export function phraseMatchRatio(words: readonly string[], lines: readonly ScriptLine[], minSim = 0.5): number {
  if (!words.length) return 0;
  let best = 0;
  for (const l of lines) { const m = matchedCount(splitWords(l.text), words, minSim); if (m / words.length > best) best = m / words.length; }
  return best;
}

// ───────────────────────────── caption words from the script ─────────────────────────────
/** Indonesian function words a speaker adds ad lib ("Data center AI itu butuh…"); kept between matched words from conf ≥ 0.6. */
export const ADLIB_FUNCTION_WORDS: ReadonlySet<string> = new Set(['itu', 'ini', 'kita', 'oleh', 'ya', 'yang', 'nih', 'sih', 'dong', 'juga', 'kan', 'kok', 'lho', 'tuh', 'deh', 'aja', 'saja', 'gitu', 'nah', 'terus', 'kalau', 'jadi']);
/** Distinct words of the script lines (and extra names, e.g. a recognition prompt) for spelling snaps; order = first appearance. */
export function scriptVocabulary(lines: ReadonlyArray<string | ScriptLine>, extra: readonly string[] = []): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const raw of [...lines.map((l) => (typeof l === 'string' ? l : l.text)), ...extra]) for (const w of splitWords(raw.replace(/[—–]/g, ' '))) {
    const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); const k = normWord(core);
    if (k.length >= 2 && !seen.has(k)) { seen.add(k); out.push(core); }
  }
  return out;
}
/**
 * The vocabulary spelling of a heard word (E2E run 1: "senter" → "center" in the CTA line): the best vocabulary word with
 * wordSimilarity ≥ `minSim` (0.6); null when nothing is close enough or two different vocabulary words tie. Punctuation around
 * the heard word is kept ("senter," → "center,").
 */
export function snapToVocabulary(word: string, vocabulary: readonly string[], minSim = 0.6): string | null {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(word); if (!m) return null;
  const [, pre, core, post] = m as unknown as [string, string, string, string];
  if (!normWord(core)) return null;
  let best: string | null = null, bestSim = 0, tie = false;
  for (const v of vocabulary) {
    const s = wordSimilarity(core, v);
    if (s > bestSim + 1e-9) { best = v; bestSim = s; tie = false; } else if (best && Math.abs(s - bestSim) <= 1e-9 && normWord(v) !== normWord(best)) tie = true;
  }
  if (!best || bestSim < minSim || tie) return null;
  return normWord(best) === normWord(core) ? pre + core + post : pre + best + post;
}
/** Snap for a HEARD word: a word the recogniser was sure about (conf ≥ `sureConf` 0.8) is left alone unless the spelling is nearly
 *  the same (≥ 0.8: "senter" → "center"); an unsure word snaps from 0.6 ("senteri"). Keeps "kalian" (0.67 to "kalau") as said. */
export function snapHeardWord(w: TimedWord, vocabulary: readonly string[], o: { minSim?: number; sureConf?: number; sureMinSim?: number } = {}): TimedWord {
  if (ADLIB_FUNCTION_WORDS.has(normWord(w.text))) return w;                   // "itu" is a word, not a misspelling of "yaitu"
  const sure = w.conf === undefined || w.conf >= (o.sureConf ?? 0.8);          // no probability at all → treat as sure (conservative)
  const v = snapToVocabulary(w.text, vocabulary, sure ? (o.sureMinSim ?? 0.8) : (o.minSim ?? 0.6));
  return v && v !== w.text ? { ...w, text: v } : w;
}
export interface AlignedCutWords { words: TimedWord[]; text: string; extras: number; droppedLeading: TimedWord[]; droppedTrailing: TimedWord[]; matched: number }
/**
 * The viewer reads the SCRIPT, timed by what was heard (QA 2026-10-31 run 3: raw recognition "ke tenang kayu yang nuklir",
 * "persih", "karpon" reached the captions). The spoken words are DP-aligned to the line's words (wordSimilarity ≥ 0.5): a matched
 * line word takes the script spelling with the spoken time; a line word nobody heard keeps its place with a time interpolated
 * between its timed neighbours; a spoken word matching nothing survives only BETWEEN two matched words with `conf ≥ minConf`
 * (a real extra word such as "itu"); leading / trailing unmatched words (a neighbouring line's word caught by the window, a
 * breath transcribed as a word) are dropped. `span` bounds the interpolation (the take's voice start / end).
 */
export function alignCutWords(spoken: readonly TimedWord[], line: string, o: { span?: { fromMs: number; toMs: number }; minConf?: number; minSim?: number; /** spelling snap for kept extra words (scriptVocabulary) */ vocabulary?: readonly string[]; /** conf for whitelisted ad-lib function words between matched words, 0.6 */ minFunctionConf?: number } = {}): AlignedCutWords {
  const lw = splitWords(line); const minConf = o.minConf ?? 0.85, minFn = o.minFunctionConf ?? 0.6;
  const keepExtra = (s: TimedWord): boolean => (s.conf ?? 0) >= minConf || (ADLIB_FUNCTION_WORDS.has(normWord(s.text)) && (s.conf ?? 0) >= minFn);
  const spell = (s: TimedWord): TimedWord => (o.vocabulary ? snapHeardWord(s, o.vocabulary) : s);
  const span = o.span ?? { fromMs: spoken[0]?.fromMs ?? 0, toMs: spoken[spoken.length - 1]?.toMs ?? 0 };
  if (!lw.length) return { words: [], text: '', extras: 0, droppedLeading: [...spoken], droppedTrailing: [], matched: 0 };
  const map = alignWords(lw, spoken.map((w) => w.text), { minSim: o.minSim ?? 0.5 });
  const matchedIdx = map.filter((j) => j >= 0);
  const firstJ = matchedIdx.length ? Math.min(...matchedIdx) : spoken.length, lastJ = matchedIdx.length ? Math.max(...matchedIdx) : -1;
  const out: Array<TimedWord & { timed: boolean }> = []; let extras = 0;
  let pushedUpTo = firstJ - 1;                                                       // spoken index up to which the gap's extras were emitted
  const pushExtras = (uptoJ: number): void => {                                     // heard extra words of a gap go right after the preceding matched word
    for (let k = pushedUpTo + 1; k < uptoJ; k++) { const s = spoken[k]!; if (keepExtra(s)) { out.push({ ...spell(s), timed: true }); extras++; } }
    pushedUpTo = Math.max(pushedUpTo, uptoJ - 1);
  };
  lw.forEach((text, i) => {
    const j = map[i]!;
    if (j >= 0) {
      pushExtras(j);
      out.push({ text, fromMs: spoken[j]!.fromMs, toMs: spoken[j]!.toMs, ...(spoken[j]!.conf === undefined ? {} : { conf: spoken[j]!.conf }), timed: true });
      pushedUpTo = j;
    } else {
      const nextJ = map.slice(i + 1).find((v) => v >= 0);                           // the gap this unheard word sits in
      if (nextJ !== undefined) pushExtras(nextJ);
      out.push({ text, fromMs: -1, toMs: -1, timed: false });
    }
  });
  // interpolate the unheard script words between their timed neighbours
  let i = 0;
  while (i < out.length) {
    if (out[i]!.timed) { i++; continue; }
    let j = i; while (j < out.length && !out[j]!.timed) j++;
    const left = i > 0 ? out[i - 1]!.toMs : span.fromMs, right = j < out.length ? out[j]!.fromMs : Math.max(span.toMs, left);
    const run = proportionalTimes(out.slice(i, j).map((w) => w.text), left, Math.max(left, right));
    for (let k = i; k < j; k++) out[k] = { text: run[k - i]!.text, fromMs: run[k - i]!.fromMs, toMs: run[k - i]!.toMs, timed: true };
    i = j;
  }
  for (let k = 1; k < out.length; k++) { if (out[k]!.fromMs < out[k - 1]!.toMs) out[k]!.fromMs = out[k - 1]!.toMs; if (out[k]!.toMs < out[k]!.fromMs) out[k]!.toMs = out[k]!.fromMs; }
  const words: TimedWord[] = out.map(({ timed: _t, ...w }) => { void _t; return w; });
  return { words, text: words.map((w) => w.text).join(' '), extras, droppedLeading: spoken.slice(0, firstJ), droppedTrailing: spoken.slice(lastJ + 1), matched: matchedIdx.length };
}

// ───────────────────────────── picking ─────────────────────────────
export interface PickOptions {
  maxTotalMs?: number; padBeforeMs?: number; padAfterMs?: number; env?: EnvelopeDb;
  /** edges must have their outside 100 ms window ≤ quietDb (−43; a warning otherwise); each edge may move ± snapMs (200) to the quietest position */
  quietDb?: number; quietWindowMs?: number; snapMs?: number; minCoverage?: number;
  /** All phrase transcripts (same order as given to groupTakes) so unused phrases can be classified and extras found. */
  phraseWords?: ReadonlyArray<readonly TimedWord[]>; phrases?: readonly Phrase[];
  minFalseStartRatio?: number;
  /** confidence an extra spoken word needs to enter the captions (alignCutWords), 0.85 */
  minExtraConf?: number;
  /** extra words for the spelling snap (e.g. the names of the recognition prompt); the script lines' words are always included */
  vocabulary?: readonly string[];
  /** second pass for lines without a candidate: best run inside the script-order window with coverage ≥ weakCoverage (0.4) → `weak`; runs join phrases ≤ maxJoinGapMs (700) apart */
  weakCoverage?: number; maxJoinGapMs?: number; maxRun?: number; minSim?: number;
}
export interface PickResult { cuts: Cut[]; dropped: Dropped[]; lines: ScriptLine[]; warnings: string[]; totalMs: number }
interface Chosen { lineIndices: number[]; phraseFrom: number; phraseTo: number; startMs: number; endMs: number; words: TimedWord[]; coverage: number; confidence: Cut['confidence']; source: 'script' | 'extra' }

export function pickTakes(groups: readonly TakeGroup[], o: PickOptions = {}): PickResult {
  const padBefore = o.padBeforeMs ?? 120, padAfter = o.padAfterMs ?? 150, quietDb = o.quietDb ?? -43, quietWin = o.quietWindowMs ?? 100, snap = o.snapMs ?? 200, minCov = o.minCoverage ?? 0.8;
  const env = o.env; const warnings: string[] = []; const dropped: Dropped[] = [];
  const lines: ScriptLine[] = groups.map((g) => g.line).sort((a, b) => a.index - b.index);
  // clean end: somewhere between the voice end and the padded cut point (+ snap room) a whole quiet window exists
  const cleanEnd = (ms: number): boolean => {
    if (!env) return true;
    for (let t = ms + quietWin / 2; t <= ms + padAfter + snap; t += env.hopMs) if (isQuietAround(env, t, { maxDb: quietDb, windowMs: quietWin })) return true;
    return false;
  };
  const chosen: Chosen[] = [];
  const overlaps = (c: TakeCandidate): Chosen | 'partial' | null => {
    for (const x of chosen) {
      if (c.phraseFrom === x.phraseFrom && c.phraseTo === x.phraseTo) return x;
      if (c.phraseFrom <= x.phraseTo && c.phraseTo >= x.phraseFrom) return 'partial';
    }
    return null;
  };
  // 1. the last clean candidate per line (script order; the recording follows the script, so a take never precedes the
  //    previous line's chosen take), falling back to the last passing one, then the best low one
  const sorted = [...groups].sort((a, b) => a.lineIndex - b.lineIndex);
  const unfound: TakeGroup[] = [];
  let prevEnd = -Infinity;
  for (const g of sorted) {
    let pick: TakeCandidate | null = null; const notes: string[] = [];
    const free = g.candidates.filter((c) => { const ov = overlaps(c); return ov !== 'partial' && (ov !== null || c.startMs >= prevEnd); });   // a span shared with the previous line stays eligible
    // QA run 6: the speaker's LAST COMPLETE take wins (the line's ending was reached), even when an earlier, abandoned try was
    // recognised better ("Ya, ya, solusi … Small Modular" 91 % vs the real take 73 %). Coverage decides only among incomplete tries.
    const complete = free.filter((c) => c.complete && c.coverage >= 0.5);
    let retakes: TakeCandidate[] = [];
    if (complete.length) {
      pick = [...complete].reverse().find((c) => cleanEnd(c.endMs)) ?? complete[complete.length - 1]!;
      if (!cleanEnd(pick.endMs)) notes.push(`line ${g.lineIndex + 1}: no take ends in silence (≤ ${quietDb} dB); using the last one`);
      if (pick.coverage < minCov) notes.push(`line ${g.lineIndex + 1}: last complete take covers only ${Math.round(pick.coverage * 100)} % of the words`);
      retakes = complete;
    } else {
      const passing = free.filter((c) => c.coverage >= minCov);
      const lastClean = [...passing].reverse().find((c) => cleanEnd(c.endMs));
      if (lastClean) pick = lastClean;
      else if (passing.length) { pick = passing[passing.length - 1]!; notes.push(`line ${g.lineIndex + 1}: no take ends in silence (≤ ${quietDb} dB); using the last one`); }
      else if (free.length) { pick = free.reduce((a, b) => (b.coverage > a.coverage ? b : a)); notes.push(`line ${g.lineIndex + 1}: best take covers only ${Math.round(pick.coverage * 100)} % of the words`); }
      if (pick) notes.push(`line ${g.lineIndex + 1}: no take reaches the line's ending; using the best try`);
      retakes = passing;
    }
    if (!pick) { unfound.push(g); continue; }
    warnings.push(...notes);
    prevEnd = pick.endMs;
    const same = overlaps(pick);
    if (same && same !== 'partial') { same.lineIndices.push(g.lineIndex); continue; }   // two lines said in one breath share the cut
    chosen.push({ lineIndices: [g.lineIndex], phraseFrom: pick.phraseFrom, phraseTo: pick.phraseTo, startMs: pick.startMs, endMs: pick.endMs, words: [...pick.words], coverage: pick.coverage, confidence: pick.coverage >= minCov ? 'ok' : 'low', source: 'script' });
    // other complete takes of this line are retakes; incomplete tries fall through to the phrase pass as false starts
    for (const c of retakes) if (c !== pick && overlaps(c) !== 'partial') dropped.push({ startMs: c.startMs, endMs: c.endMs, text: joinText(c.words), reason: 'retake', lineIndex: g.lineIndex });
  }
  const pw = o.phraseWords;
  // 1b. QA run 5 (hook heard as "Kenapa raksasa terlalu hidup di dunia, tiba-tiba terlomba untuk memakai listrik"): a line without
  //     a candidate is searched again INSIDE the time window between its neighbours' chosen takes — the best run of ≤ maxRun
  //     consecutive unused phrases (gaps ≤ maxJoinGapMs) with coverage ≥ weakCoverage becomes a `weak` take, to be checked by ear.
  const usedBy = (k: number): boolean => chosen.some((c) => k >= c.phraseFrom && k <= c.phraseTo);
  if (pw) {
    const weakCov = o.weakCoverage ?? 0.4, maxGap = o.maxJoinGapMs ?? 700, maxRun = o.maxRun ?? 4, minSim = o.minSim ?? 0.5;
    for (const g of unfound) {
      const before = chosen.filter((c) => c.source === 'script' && c.lineIndices[0]! < g.lineIndex).reduce((m, c) => Math.max(m, c.endMs), -Infinity);
      const after = chosen.filter((c) => c.source === 'script' && c.lineIndices[0]! > g.lineIndex).reduce((m, c) => Math.min(m, c.startMs), Infinity);
      const lw = splitWords(g.line.text);
      let best: TakeCandidate | null = null;
      for (let j = 0; j < pw.length; j++) {
        const sj = spanOf(pw, j, j, o.phrases);
        if (usedBy(j) || !pw[j]!.length || sj.startMs < before || sj.endMs > after) continue;
        let run: string[] = [];
        for (let i = j; i >= 0 && j - i < maxRun; i--) {
          const si = spanOf(pw, i, i, o.phrases);
          if (usedBy(i) || si.startMs < before || (i < j && spanOf(pw, i + 1, i + 1, o.phrases).startMs - si.endMs > maxGap)) break;
          run = [...pw[i]!.map((w) => w.text), ...run];
          const map = matchedMap(lw, run, minSim); const m = map.filter((v) => v >= 0).length; const coverage = m / lw.length, precision = run.length ? m / run.length : 0;
          if (coverage >= weakCov && (!best || coverage > best.coverage || (coverage === best.coverage && precision > best.precision)))
            best = { phraseFrom: i, phraseTo: j, ...spanOf(pw, i, j, o.phrases), coverage: round3(coverage), precision: round3(precision), ...candidateCompleteness(map, run.length), words: pw.slice(i, j + 1).flat() };
        }
      }
      if (!best) { warnings.push(`line ${g.lineIndex + 1} was not found in the recording`); continue; }
      warnings.push(`line ${g.lineIndex + 1}: weak match (${Math.round(best.coverage * 100)} %) — check by ear`);
      chosen.push({ lineIndices: [g.lineIndex], phraseFrom: best.phraseFrom, phraseTo: best.phraseTo, startMs: best.startMs, endMs: best.endMs, words: [...best.words], coverage: best.coverage, confidence: 'weak', source: 'script' });
    }
  } else for (const g of unfound) warnings.push(`line ${g.lineIndex + 1} was not found in the recording`);
  // 2. the remaining phrases: retake (inside some full candidate), false start, ad-lib, or an extra line after the last script take
  if (pw) {
    const used = new Set<number>(); for (const c of chosen) for (let k = c.phraseFrom; k <= c.phraseTo; k++) used.add(k);
    for (const d of dropped) if (d.reason === 'retake') for (const g of groups) for (const c of g.candidates) if (c.startMs === d.startMs && c.endMs === d.endMs) for (let k = c.phraseFrom; k <= c.phraseTo; k++) used.add(k);
    const lastScriptEnd = chosen.reduce((m, c) => Math.max(m, c.endMs), -Infinity);
    const minRatio = o.minFalseStartRatio ?? 0.6;
    // QA 2026-10-31 run 3: extra phrases are NEVER joined (a 270 ms gap glued "Tulis pendapat…" to the CTA, so the budget rule
    // could not drop it); every unmatched phrase after the last script take is its own extra line = exactly that phrase
    for (let k = 0; k < pw.length; k++) {
      if (used.has(k)) continue;
      const words = pw[k]!; const span = spanOf(pw, k, k, o.phrases);
      if (!words.length) continue;                                          // nothing recognised: silence, breath, noise
      const texts = words.map((w) => w.text);
      const inFull = groups.some((g) => g.candidates.some((c) => c.complete && c.coverage >= 0.5 && k >= c.phraseFrom && k <= c.phraseTo));   // inside a complete take of some line
      let reason: DropReason | 'extra';
      if (inFull) reason = 'retake';
      else if (phraseMatchRatio(texts, lines) >= minRatio) reason = 'false-start';
      else reason = span.startMs > lastScriptEnd ? 'extra' : 'adlib';
      if (reason !== 'extra') { dropped.push({ startMs: span.startMs, endMs: span.endMs, text: texts.join(' '), reason }); continue; }
      const line: ScriptLine = { index: lines.length, text: joinText(words), source: 'extra' }; lines.push(line);
      chosen.push({ lineIndices: [line.index], phraseFrom: k, phraseTo: k, ...span, words: [...words], coverage: 1, confidence: 'ok', source: 'extra' });
    }
  }
  // 3. cuts in line order. Each edge = voice edge ± pad, moved within ± snapMs to the position whose OUTSIDE 100 ms window
  //    (before the start / after the end) has the lowest peak; that peak is reported (QA measures it on the raw recorder audio).
  chosen.sort((a, b) => a.lineIndices[0]! - b.lineIndices[0]!);
  const outside = (pos: number, dir: -1 | 1): number => (env ? silenceDbAt(env, pos + (dir * quietWin) / 2, quietWin) : -120);
  const edge = (voiceEdge: number, dir: -1 | 1): { ms: number; db: number } => {
    const anchor = voiceEdge + dir * (dir < 0 ? padBefore : padAfter);
    if (!env) return { ms: Math.max(0, anchor), db: -120 };
    const lo = dir < 0 ? Math.max(0, anchor - snap) : Math.max(anchor - snap, voiceEdge + 4 * env.hopMs);
    const hi = dir < 0 ? Math.min(anchor + snap, voiceEdge - 4 * env.hopMs) : anchor + snap;
    let best = { ms: Math.max(0, anchor), db: outside(anchor, dir) };
    for (let pos = Math.ceil(lo / env.hopMs) * env.hopMs; pos <= hi; pos += env.hopMs) {
      const db = outside(pos, dir);
      if (db < best.db - 0.05 || (Math.abs(db - best.db) <= 0.05 && Math.abs(pos - anchor) < Math.abs(best.ms - anchor))) best = { ms: pos, db };
    }
    return { ms: best.ms, db: Math.round(best.db * 10) / 10 };
  };
  const vocabulary = scriptVocabulary(lines.filter((l) => l.source === 'script'), o.vocabulary ?? []);
  let cuts: Cut[] = chosen.map((c, n) => {
    const s = edge(c.startMs, -1), e = edge(c.endMs, 1);
    const spoken = c.words.map((w) => ({ ...w }));
    let text: string, words: TimedWord[];
    if (c.source === 'extra') {                                                   // spoken text, spelled with the script's vocabulary ("senter" → "center")
      words = spoken.map((w) => ({ ...snapHeardWord(w, vocabulary) }));
      text = joinText(words); lines[c.lineIndices[0]!]!.text = text;
    } else {
      const a = alignCutWords(spoken, c.lineIndices.map((i) => lines[i]!.text).join(' '), { span: { fromMs: c.startMs, toMs: c.endMs }, vocabulary, ...(o.minExtraConf === undefined ? {} : { minConf: o.minExtraConf }) });
      text = a.text; words = a.words;
    }
    const id = `cut-${n + 1}`;
    if (env && s.db > quietDb) warnings.push(`${id}: ${s.db} dB in the 100 ms before the cut (target ≤ ${quietDb})`);
    if (env && e.db > quietDb) warnings.push(`${id}: ${e.db} dB in the 100 ms after the cut (target ≤ ${quietDb})`);
    return { id, lineIndex: c.lineIndices[0]!, startMs: s.ms, endMs: e.ms, text, words, spoken, quietStartDb: s.db, quietEndDb: e.db, coverage: c.coverage, confidence: c.confidence };
  });
  // 4. the length budget: extras go, earliest first; the final extra (the Creator's sign-off / CTA) and the script lines never
  const total = (): number => cuts.reduce((a, c) => a + c.endMs - c.startMs, 0);
  if (o.maxTotalMs !== undefined) {
    const extras = cuts.filter((c) => lines[c.lineIndex]!.source === 'extra');
    for (const x of extras.slice(0, -1)) {
      if (total() <= o.maxTotalMs) break;
      cuts = cuts.filter((c) => c !== x);
      dropped.push({ startMs: x.startMs, endMs: x.endMs, text: x.text, reason: 'length', lineIndex: x.lineIndex });
    }
    if (total() > o.maxTotalMs) warnings.push(`the script lines and the sign-off run ${Math.round(total() / 100) / 10} s, over the ${Math.round(o.maxTotalMs / 100) / 10} s budget`);
  }
  cuts.forEach((c, n) => { c.id = `cut-${n + 1}`; });
  dropped.sort((a, b) => a.startMs - b.startMs);
  return { cuts, dropped, lines, warnings, totalMs: total() };
}
const joinText = (words: readonly TimedWord[]): string => words.map((w) => w.text).join(' ');

/** splitScriptLines + groupTakes + pickTakes in one call. */
export function analyzeTakes(script: string, phraseWords: ReadonlyArray<readonly TimedWord[]>, o: GroupOptions & PickOptions = {}): PickResult & { groups: TakeGroup[] } {
  const lines = toScriptLines(splitScriptLines(script));
  const groups = groupTakes(lines, phraseWords, o);
  return { groups, ...pickTakes(groups, { ...o, phraseWords }) };
}
