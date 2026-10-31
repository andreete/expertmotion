// The "listen" step helpers (FR-282): the phrases of a recording are joined with silence gaps into one short WAV so the
// recogniser hears only speech (one whisper run, no long silences to hallucinate on); its word times are then mapped back
// to recording time. Also the names-only recognition prompt (capitalised words and acronyms of the script, never the script).
import { splitWords } from '../transcript.js';
import type { TimedWord } from './types.js';

export interface JoinPiece { index: number; recFromMs: number; recToMs: number; joinedFromMs: number; joinedToMs: number }
export interface JoinPlan { pieces: JoinPiece[]; totalMs: number; gapMs: number; padMs: number }

/** Where every phrase (padded by `padMs`, clamped to the recording) lands in the joined audio: `gapMs` of silence before each and after the last. */
export function joinPlan(phrases: ReadonlyArray<{ fromMs: number; toMs: number }>, o: { gapMs?: number; padMs?: number; durationMs?: number } = {}): JoinPlan {
  const gapMs = o.gapMs ?? 2000, padMs = o.padMs ?? 150;
  const pieces: JoinPiece[] = []; let cursor = gapMs;
  phrases.forEach((p, index) => {
    const recFromMs = Math.max(0, p.fromMs - padMs); const recToMs = o.durationMs === undefined ? p.toMs + padMs : Math.min(o.durationMs, p.toMs + padMs);
    const len = Math.max(0, recToMs - recFromMs);
    pieces.push({ index, recFromMs, recToMs, joinedFromMs: cursor, joinedToMs: cursor + len });
    cursor += len + gapMs;
  });
  return { pieces, totalMs: cursor, gapMs, padMs };
}

/** The joined mono PCM of a plan (silence = zeros). */
export function joinPcm(pcm: Int16Array, sr: number, plan: JoinPlan): Int16Array {
  const at = (ms: number): number => Math.round((ms / 1000) * sr);
  const out = new Int16Array(at(plan.totalMs));
  for (const p of plan.pieces) {
    const a = Math.min(pcm.length, at(p.recFromMs)), b = Math.min(pcm.length, at(p.recToMs));
    out.set(pcm.subarray(a, b), Math.min(out.length - (b - a), at(p.joinedFromMs)));
  }
  return out;
}

/** The piece whose joined window is nearest to `ms` (inside = distance 0); null without pieces. */
export function nearestPiece(ms: number, pieces: readonly JoinPiece[]): JoinPiece | null {
  let best: JoinPiece | null = null, bestD = Infinity;
  for (const p of pieces) {
    const d = ms < p.joinedFromMs ? p.joinedFromMs - ms : ms > p.joinedToMs ? ms - p.joinedToMs : 0;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
/** Joined time → recording time through the nearest piece (clamped to that piece's recording window). */
export function joinedToRecordingMs(ms: number, pieces: readonly JoinPiece[]): number | null {
  const p = nearestPiece(ms, pieces); if (!p) return null;
  return Math.round(Math.min(p.recToMs, Math.max(p.recFromMs, p.recFromMs + (ms - p.joinedFromMs))));
}

/**
 * Recognised words of the joined audio → one word list per piece, in recording time. A word belongs to the piece nearest to
 * its midpoint (recognisers place the first word of a window at the window start, so edges are soft); times are clamped to
 * the piece. Empty / non-speech tokens are dropped.
 */
export function mapJoinedWords(words: readonly TimedWord[], plan: JoinPlan): TimedWord[][] {
  const out: TimedWord[][] = plan.pieces.map(() => []);
  const clean = words.filter((w) => { const t = w.text.trim(); return t && /[\p{L}\p{N}]/u.test(t) && !NON_SPEECH.test(t); });
  // "stuck" runs: several words sharing one start time were all stamped with the window start; their real time is where the
  // run ends (the first later timestamp), so the whole run is placed by that time, never by the stale start
  const ref = new Array<number>(clean.length);
  for (let i = 0; i < clean.length;) {
    let j = i; while (j + 1 < clean.length && clean[j + 1]!.fromMs === clean[i]!.fromMs) j++;
    const last = clean[j]!; const next = clean[j + 1];
    const t = j > i ? (last.toMs > last.fromMs ? last.toMs : next ? next.fromMs : last.fromMs) : (last.fromMs + last.toMs) / 2;
    for (let k = i; k <= j; k++) ref[k] = t;
    i = j + 1;
  }
  let prevIndex = 0;
  clean.forEach((w, k) => {
    let p = nearestPiece(ref[k]!, plan.pieces); if (!p) return;
    if (p.index < prevIndex) p = plan.pieces[prevIndex]!;                      // monotonic: words never go back to an earlier piece
    prevIndex = p.index;
    const fromMs = joinedToRecordingMs(w.fromMs, [p])!, toMs = Math.max(fromMs, joinedToRecordingMs(w.toMs, [p])!);
    out[p.index]!.push({ text: w.text.trim(), fromMs, toMs, ...(w.conf === undefined ? {} : { conf: w.conf }) });
  });
  return out;
}

/** Non-speech annotations a recogniser emits as words ([BLANK_AUDIO], [Musik], (tertawa), ♪). */
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|[♪♫\s]+)\s*$/;
const SENTENCE_START = /^[^\p{L}]*$/u;
/**
 * Recognition prompt from a script: proper names, brand names and acronyms (capitalised words that do not start a sentence,
 * all-caps tokens, runs of capitalised words kept together), deduplicated, as a comma list. The prompt never contains the
 * script itself, so the recogniser cannot "read" the script instead of listening.
 */
export function namesPrompt(script: string, o: { max?: number } = {}): string {
  const max = o.max ?? 24;
  const words = splitWords(script.replace(/[\[\(][^\]\)]*[\]\)]/g, ' ').replace(/[—–]/g, ' — '));
  const names: string[] = []; const seen = new Set<string>();
  let run: string[] = []; let prevEnd = true;
  const flush = (): void => { if (run.length) { const n = run.join(' '); const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); names.push(n); } } run = []; };
  for (const raw of words) {
    const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const endsSentence = /[.!?…:]["')\]]*$/.test(raw) || /[—–]$/.test(raw);
    if (!w || SENTENCE_START.test(w)) { flush(); prevEnd = prevEnd || endsSentence; continue; }
    const label = /^[A-Z][A-Z0-9]*:$/.test(raw);                               // "HOOK:" — a stage label, not a name
    const caps = /^[A-Z][A-Z0-9]+$/.test(w) && w.length <= 6 && !label;
    const capitalised = /^\p{Lu}[\p{Ll}\p{N}-]+$/u.test(w) && !label;
    if (caps || (capitalised && !prevEnd)) run.push(w); else flush();
    prevEnd = endsSentence;
  }
  flush();
  return names.slice(0, max).join(', ') + (names.length ? '.' : '');
}
