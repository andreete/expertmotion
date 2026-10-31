// Timed transcripts of generated voice-overs (FR-249, ADR-035). The caption TEXT always comes from the known script (never from
// speech recognition); recognition (whisper word timestamps) or the TTS engine (ElevenLabs character alignment) only provides
// TIMES. Pure functions, no I/O: the Local Service runs the engines and stores the result (JSON + SRT) on the voice Asset.
//
//   words ──(DP alignment, Levenshtein similarity)──▶ recognised tokens   → each matched script word takes the token's time
//   unmatched script words                                               → interpolated between their timed neighbours
//   no tokens at all                                                     → proportional (syllable weights, sentence pauses)
//   written display form ("17,2%") ──(DP alignment)──▶ spoken words ("tujuh belas koma dua persen") → display word times
//
// The text is never shifted or replaced: the output words are exactly the input words in order.

export type TimingMethod = 'engine' | 'aligned' | 'proportional' | 'srt';
export interface TranscriptWord { text: string; fromMs: number; toMs: number; timed: 'engine' | 'aligned' | 'interpolated' | 'proportional' | 'srt' }
/** One caption cue: what is shown (`written`) and what is spoken (`text`), with word times in the clip's own time (0 = clip start). */
export interface TranscriptCue { index: number; text: string; written: string; fromMs: number; toMs: number; words: TranscriptWord[] }
export interface Transcript {
  version: 1;
  language: string;
  durationMs: number;
  method: TimingMethod;
  /** The spoken script exactly as given to the voice engine. */
  spoken: string;
  /** The display form (captions); equals `spoken` when none was given. */
  written: string;
  /** Spoken words with times. */
  words: TranscriptWord[];
  /** Display cues (written words, grouped like TikTok captions) with times. */
  cues: TranscriptCue[];
  stats: { words: number; matched: number; interpolated: number };
}
export interface RecognisedToken { text: string; fromMs: number; toMs: number; /** mean token probability when the recogniser reports one (ADR-039 ad-lib word rule) */ conf?: number }

// ───────────────────────────── text helpers ─────────────────────────────
export const splitWords = (s: string): string[] => s.replace(/\s+/g, ' ').trim().split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w) || w.length > 0).filter(Boolean);
/** Comparison form: lower case, letters and digits only (Indonesian/English), digits spelled out in Indonesian. */
export function normWord(w: string, lang = 'id'): string {
  const s = w.toLocaleLowerCase(lang === 'id' ? 'id-ID' : 'en-US').normalize('NFKD').replace(/\p{M}+/gu, '');
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

const SATUAN = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan'];
function below1000(n: number): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100); const r = n % 100;
  if (h === 1) out.push('seratus'); else if (h > 1) out.push(SATUAN[h]!, 'ratus');
  if (r === 0) return out;
  if (r < 10) out.push(SATUAN[r]!);
  else if (r === 10) out.push('sepuluh');
  else if (r === 11) out.push('sebelas');
  else if (r < 20) out.push(SATUAN[r - 10]!, 'belas');
  else { out.push(SATUAN[Math.floor(r / 10)]!, 'puluh'); if (r % 10) out.push(SATUAN[r % 10]!); }
  return out;
}
/** Indonesian number words for a non-negative integer (≤ 999 triliun): 2026 → "dua ribu dua puluh enam". */
export function idNumberWords(n: number): string[] {
  if (!Number.isFinite(n) || n < 0 || n >= 1e15) return [String(n)];
  n = Math.floor(n);
  if (n === 0) return ['nol'];
  const scales: Array<[number, string]> = [[1e12, 'triliun'], [1e9, 'miliar'], [1e6, 'juta'], [1e3, 'ribu']];
  const out: string[] = [];
  for (const [v, name] of scales) {
    const q = Math.floor(n / v);
    if (!q) continue;
    if (v === 1e3 && q === 1) out.push('seribu'); else out.push(...below1000(q), name);
    n %= v;
  }
  out.push(...below1000(n));
  return out;
}
/**
 * The spoken form of one written token for alignment (FR-249): "17,2%" → tujuh belas koma dua persen; "Rp472" → rupiah empat
 * ratus tujuh puluh dua; "US$45" → dolar empat puluh lima ("US$" is read differently by different voices; alignment tolerates
 * gaps); "2026" → dua ribu dua puluh enam. Words without digits come back as they are. Indonesian number style (1.234,5).
 */
export function spokenFormId(token: string): string[] {
  const t = token.replace(/[“”"'()\[\]]/g, '');
  const m = /^([^\d]*?)(\d[\d.]*)(?:,(\d+))?(%|persen)?([^\d]*)$/u.exec(t);
  if (!m) return [token];
  const [, pre = '', int = '', dec, pct, post = ''] = m;
  const words: string[] = [];
  const p = pre.toLowerCase();
  if (/rp/.test(p)) words.push('rupiah'); else if (/\$|usd/.test(p)) words.push('dolar'); else if (/[+]/.test(p)) words.push('plus'); else if (/[−-]/.test(p)) words.push('minus');
  const digits = /^\d{1,3}(\.\d{3})+$/.test(int) ? int.replace(/\./g, '') : int.replace(/\./g, '');
  words.push(...idNumberWords(Number(digits)));
  if (dec) words.push('koma', ...[...dec].map((d) => SATUAN[Number(d)]!));
  if (pct) words.push('persen');
  const tail = post.replace(/[^\p{L}]+/gu, '');
  if (tail) words.push(tail);
  return words;
}

// ───────────────────────────── DP alignment ─────────────────────────────
let levRow = new Int32Array(64);
/** Levenshtein distance with one reused scratch row (it runs once per alignment cell: no allocation per call). */
function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  if (levRow.length < n + 1) levRow = new Int32Array(n + 1);
  const row = levRow;
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let diag = row[0]!; row[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const up = row[j]!;
      const v = Math.min(up + 1, row[j - 1]! + 1, diag + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      diag = up; row[j] = v;
    }
  }
  return row[n]!;
}
/** 1 = identical, 0 = nothing in common (normalised Levenshtein on the comparison forms). */
export const wordSimilarity = (a: string, b: string): number => { const x = normWord(a), y = normWord(b); if (!x && !y) return 1; return 1 - lev(x, y) / Math.max(x.length, y.length, 1); };

/**
 * Needleman–Wunsch alignment of two word lists (monotonic). Returns for every `a[i]` the index of its partner in `b` or -1.
 * Substitution costs 1 − similarity; a pair counts as matched only above `minSim` (0.5: "bersih" ~ "besi" 0.67 matches, so a
 * misheard word still lends its TIME; the text stays the script's). Gaps cost `gap`. O(n·m) up to ALIGN_FULL_CELLS, then O(n·band).
 */
/** Above this many cells the alignment runs in a band around the diagonal (R7: a 20 000-character script must not block for seconds). */
export const ALIGN_FULL_CELLS = 4_000_000;
export const ALIGN_BAND = 200;
export const ALIGN_MAX_CELLS = 8_000_000;
export function alignWords(a: readonly string[], b: readonly string[], o: { gap?: number; minSim?: number; band?: number } = {}): number[] {
  const gap = o.gap ?? 0.7; const minSim = o.minSim ?? 0.5;
  const n = a.length, m = b.length;
  const out = new Array<number>(n).fill(-1);
  if (n === 0 || m === 0) return out;
  // Row i covers columns lo[i]..hi[i]: everything when small, else a Sakoe–Chiba band of ±B around the scaled diagonal (the
  // band is at least the slope wide, so consecutive rows always overlap and the end cell stays reachable).
  const full = (n + 1) * (m + 1) <= ALIGN_FULL_CELLS && o.band === undefined;
  // ±(ALIGN_BAND + |m − n|) holds every path made of pure insertions / deletions; capped at ALIGN_MAX_CELLS (never below the slope)
  const B = full ? m : Math.max(Math.min(o.band ?? ALIGN_BAND + Math.abs(m - n), Math.floor(ALIGN_MAX_CELLS / (2 * (n + 1)))), Math.ceil(m / n) + 1, Math.ceil(n / m) + 1);
  const lo = new Int32Array(n + 1), hi = new Int32Array(n + 1), off = new Float64Array(n + 2);
  for (let i = 0; i <= n; i++) {
    const c = (i * m) / n;
    lo[i] = full ? 0 : Math.max(0, Math.floor(c) - B); hi[i] = full ? m : Math.min(m, Math.ceil(c) + B);
    off[i + 1] = off[i]! + (hi[i]! - lo[i]! + 1);
  }
  const move = new Uint8Array(off[n + 1]!);   // 1 diag, 2 up (a gap), 3 left (b gap); 0 = outside the band
  let prev = new Float64Array(m + 1).fill(Infinity), cur = new Float64Array(m + 1).fill(Infinity);
  for (let j = lo[0]!; j <= hi[0]!; j++) { prev[j] = j * gap; if (j > 0) move[off[0]! + j - lo[0]!] = 3; }
  const na = a.map((x) => normWord(x)); const nb = b.map((x) => normWord(x));
  for (let i = 1; i <= n; i++) {
    if (i >= 2) cur.fill(Infinity, lo[i - 2]!, hi[i - 2]! + 1);   // this buffer still holds row i-2; outside the band must read as Infinity
    const base = off[i]! - lo[i]!; const x = na[i - 1]!;
    for (let j = lo[i]!; j <= hi[i]!; j++) {
      if (j === 0) { cur[0] = i * gap; move[base] = 2; continue; }
      const y = nb[j - 1]!;
      const d = prev[j - 1]! === Infinity ? Infinity : prev[j - 1]! + (1 - (x === y ? 1 : 1 - lev(x, y) / Math.max(x.length, y.length, 1))) * 1.2;
      const u = prev[j]! + gap; const l = cur[j - 1]! + gap;
      if (d <= u && d <= l) { cur[j] = d; move[base + j] = 1; } else if (u <= l) { cur[j] = u; move[base + j] = 2; } else { cur[j] = l; move[base + j] = 3; }
    }
    const t = prev; prev = cur; cur = t;
  }
  const mv = (i: number, j: number): number => (j < lo[i]! || j > hi[i]! ? 0 : move[off[i]! + j - lo[i]!]!);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const k = mv(i, j);
    if (i > 0 && j > 0 && k === 1) { const sim = wordSimilarity(a[i - 1]!, b[j - 1]!); if (sim >= minSim) out[i - 1] = j - 1; i--; j--; }
    else if (i > 0 && (k === 2 || j === 0)) i--;
    else if (j > 0 && (k === 3 || i === 0)) j--;
    else { i--; j--; }   // unreachable for a connected band; never loops
  }
  return out;
}

/** Rough syllable weight (vowel groups) — Indonesian is close to syllable-timed, so it predicts word length better than letters. */
export const syllables = (w: string): number => Math.max(1, (normWord(w).match(/[aeiouy]+/g) ?? []).length + (/\d/.test(w) ? spokenFormId(w).length : 0));
const pauseAfter = (w: string): number => (/[.!?…]["')\]]*$/.test(w) ? 1.6 : /[,;:—–-]["')\]]*$/.test(w) ? 0.8 : 0);

/**
 * Proportional timing over [fromMs, toMs]: each word gets a share by syllables, sentence ends / commas get a pause share. Used when
 * no recognised tokens exist, and between anchors for unmatched runs.
 */
export function proportionalTimes(words: readonly string[], fromMs: number, toMs: number, timed: TranscriptWord['timed'] = 'proportional'): TranscriptWord[] {
  const span = Math.max(0, toMs - fromMs);
  const units = words.map((w, i) => ({ w: syllables(w), p: i < words.length - 1 ? pauseAfter(w) : 0 }));
  const total = units.reduce((s, u) => s + u.w + u.p, 0) || 1;
  let at = fromMs; const out: TranscriptWord[] = [];
  words.forEach((w, i) => {
    const d = (units[i]!.w / total) * span;
    out.push({ text: w, fromMs: Math.round(at), toMs: Math.round(at + d), timed });
    at += d + (units[i]!.p / total) * span;
  });
  return out;
}

/** Times for `words` from recognised tokens: matched words take the token time; runs between matches are spread proportionally. */
export function timeWordsFromTokens(words: readonly string[], tokens: readonly RecognisedToken[], bounds: { fromMs: number; toMs: number }): { words: TranscriptWord[]; matched: number } {
  const clean = tokens.filter((t) => normWord(t.text) !== '');
  if (!clean.length) return { words: proportionalTimes(words, bounds.fromMs, bounds.toMs), matched: 0 };
  // expand digits in recognised tokens ("17" → tujuh belas) into sub-tokens sharing the token's time span
  const exp: RecognisedToken[] = [];
  for (const t of clean) {
    const sf = /\d/.test(t.text) ? spokenFormId(t.text.trim()) : [t.text.trim()];
    const d = (t.toMs - t.fromMs) / sf.length;
    sf.forEach((w, k) => exp.push({ text: w, fromMs: Math.round(t.fromMs + k * d), toMs: Math.round(t.fromMs + (k + 1) * d) }));
  }
  const map = alignWords(words, exp.map((t) => t.text));
  const out: TranscriptWord[] = words.map((w, i) => (map[i]! >= 0 ? { text: w, fromMs: exp[map[i]!]!.fromMs, toMs: Math.max(exp[map[i]!]!.fromMs, exp[map[i]!]!.toMs), timed: 'aligned' as const } : { text: w, fromMs: -1, toMs: -1, timed: 'interpolated' as const }));
  const matched = out.filter((w) => w.timed === 'aligned').length;
  // fill gaps between anchors
  let i = 0;
  while (i < out.length) {
    if (out[i]!.timed === 'aligned') { i++; continue; }
    let j = i; while (j < out.length && out[j]!.timed !== 'aligned') j++;
    const left = i > 0 ? out[i - 1]!.toMs : Math.min(bounds.fromMs, exp[0]!.fromMs);
    const right = j < out.length ? out[j]!.fromMs : Math.max(bounds.toMs, left);
    const run = proportionalTimes(words.slice(i, j), left, Math.max(left, right), 'interpolated');
    for (let k = i; k < j; k++) out[k] = run[k - i]!;
    i = j;
  }
  // monotonic, non-overlapping
  for (let k = 1; k < out.length; k++) {
    if (out[k]!.fromMs < out[k - 1]!.toMs) out[k]!.fromMs = out[k - 1]!.toMs;
    if (out[k]!.toMs < out[k]!.fromMs) out[k]!.toMs = out[k]!.fromMs;
  }
  return { words: out, matched };
}

/** Word times from per-character engine timings (ElevenLabs `with-timestamps`): characters of `text`, times in seconds. */
export function wordsFromCharAlignment(text: string, a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): RecognisedToken[] {
  const out: RecognisedToken[] = []; let cur = ''; let from = -1; let to = -1;
  const flush = () => { if (cur.trim()) out.push({ text: cur.trim(), fromMs: Math.round(from * 1000), toMs: Math.round(to * 1000) }); cur = ''; from = -1; };
  a.characters.forEach((c, k) => {
    if (/\s/.test(c)) { flush(); return; }
    if (from < 0) from = a.character_start_times_seconds[k] ?? 0;
    to = a.character_end_times_seconds[k] ?? to; cur += c;
  });
  flush();
  void text;
  return out;
}

// ───────────────────────────── written ↔ spoken ─────────────────────────────
/** Display words with times taken from the spoken words (numbers/currency written as digits align through spokenFormId). */
export function timeWrittenWords(written: readonly string[], spoken: readonly TranscriptWord[]): TranscriptWord[] {
  if (!written.length) return [];
  if (!spoken.length) return written.map((w) => ({ text: w, fromMs: 0, toMs: 0, timed: 'interpolated' }));
  // expand every written word into its spoken sub-words, align those to the spoken words, then fold back
  const sub: Array<{ w: string; owner: number }> = [];
  written.forEach((w, i) => { const sf = /\d/.test(w) ? spokenFormId(w) : [w]; for (const s of sf) sub.push({ w: s, owner: i }); });
  const map = alignWords(sub.map((s) => s.w), spoken.map((s) => s.text), { minSim: 0.6 });
  const span = written.map(() => ({ from: Infinity, to: -Infinity }));
  sub.forEach((s, k) => { const j = map[k]!; if (j >= 0) { span[s.owner]!.from = Math.min(span[s.owner]!.from, spoken[j]!.fromMs); span[s.owner]!.to = Math.max(span[s.owner]!.to, spoken[j]!.toMs); } });
  const out: TranscriptWord[] = written.map((w, i) => (Number.isFinite(span[i]!.from) ? { text: w, fromMs: span[i]!.from, toMs: span[i]!.to, timed: spoken[0]!.timed } : { text: w, fromMs: -1, toMs: -1, timed: 'interpolated' }));
  let i = 0;
  const first = spoken[0]!.fromMs, last = spoken.at(-1)!.toMs;
  while (i < out.length) {
    if (out[i]!.fromMs >= 0) { i++; continue; }
    let j = i; while (j < out.length && out[j]!.fromMs < 0) j++;
    const left = i > 0 ? out[i - 1]!.toMs : first; const right = j < out.length ? out[j]!.fromMs : last;
    const run = proportionalTimes(written.slice(i, j), left, Math.max(left, right), 'interpolated');
    for (let k = i; k < j; k++) out[k] = run[k - i]!;
    i = j;
  }
  for (let k = 1; k < out.length; k++) { if (out[k]!.fromMs < out[k - 1]!.toMs) out[k]!.fromMs = out[k - 1]!.toMs; if (out[k]!.toMs < out[k]!.fromMs) out[k]!.toMs = out[k]!.fromMs; }
  return out;
}

// ───────────────────────────── cues ─────────────────────────────
export interface CueOptions { maxWords?: number; maxChars?: number; /** a cue lasts until the next one when the gap is shorter (ms) */ closeGapMs?: number;
  /** real pauses of the audio (clip time, `silences()` over the energy envelope): page breaks go there and snap to them */
  pauses?: ReadonlyArray<{ fromMs: number; toMs: number }> }

// QA P1 2026-10-29 (caption paging, nikel run): breaks were by word count only — on average 170 ms (max 710 ms) away from the
// speech pauses, numbers split across pages ("empat puluh | lima miliar", "dua ribu | dua puluh enam") and orphan words
// ("naik?") on their own page. Pages are now chosen by a small dynamic programme over the legal break positions.
const NUM_WORDS = new Set(['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas', 'seratus', 'seribu', 'sejuta',
  'semiliar', 'setriliun', 'belas', 'puluh', 'ratus', 'ribu', 'juta', 'miliar', 'milyar', 'triliun', 'koma', 'setengah', 'seperempat']);
const UNIT_WORDS = new Set(['persen', '%', 'ribu', 'juta', 'miliar', 'milyar', 'triliun', 'rupiah', 'dolar', 'dollar', 'usd', 'idr', 'ton', 'kg', 'kilogram', 'gram', 'km', 'kilometer',
  'meter', 'liter', 'barel', 'jam', 'menit', 'detik', 'derajat', 'kali', 'lipat', 'poin', 'basis']);
const CURRENCY_PREFIX = /^(rp\.?|us\$|\$|idr|usd|€|£)$/i;
const bare = (w: string): string => w.toLowerCase().replace(/^["'(\[]+|["')\].,;:!?…]+$/g, '');
const isNumber = (w: string): boolean => { const b = bare(w); return NUM_WORDS.has(b) || /^(rp|us\$|\$)?[\d][\d.,]*%?$/i.test(b) || /^ke-?\d/.test(b); };
const endsClause = (w: string): boolean => /[.,;:!?…—–]["')\]]*$/.test(w);
const endsSentence = (w: string): boolean => /[.!?…]["')\]]*$/.test(w);
/** A page may not break between a and b: inside a number phrase, between a number and its unit, after a currency sign. */
export function gluedNumber(a: string, b: string): boolean {
  if (endsClause(a)) return false;
  if (CURRENCY_PREFIX.test(bare(a)) && isNumber(b)) return true;
  return isNumber(a) && (isNumber(b) || UNIT_WORDS.has(bare(b)));
}
const visibleLen = (w: string): number => bare(w).length;

/** Page breaks (index of the last word of every page but the last) over display words with times. */
export function pageBreaks(words: readonly TranscriptWord[], o: CueOptions = {}): number[] {
  const n = words.length; if (n <= 1) return [];
  const maxWords = o.maxWords ?? 5, maxChars = o.maxChars ?? 32;
  const pauseAt = (i: number): number => {          // ms of silence between word i and i+1 (real pauses when given)
    const a = words[i]!, b = words[i + 1]!;
    if (o.pauses?.length) { const s = nearestPause(o.pauses, a, b); if (s) return s.toMs - s.fromMs; return 0; }
    return Math.max(0, b.fromMs - a.toMs);
  };
  const breakCost = (i: number): number => {
    if (gluedNumber(words[i]!.text, words[i + 1]!.text)) return Infinity;
    const w = words[i]!.text; const p = Math.min(600, pauseAt(i));
    return (endsSentence(w) ? 0 : endsClause(w) ? 15 : 60) - p / 8;
  };
  const pageCost = (a: number, b: number): number => {
    let chars = -1; for (let k = a; k <= b; k++) chars += words[k]!.text.length + 1;
    const cnt = b - a + 1;
    let c = 10 + Math.max(0, maxChars - chars) * 0.4;
    if (chars > maxChars && cnt > 1) c += 400 + (chars - maxChars) * 40;
    if (cnt > maxWords) c += 300 * (cnt - maxWords);
    if (cnt === 1 && n > 1 && visibleLen(words[a]!.text) <= 6) c += 250;                  // orphan: one short word alone
    for (let k = a; k < b; k++) if (endsSentence(words[k]!.text)) c += 90;                // a sentence end inside the page
    return c;
  };
  const bc = Array.from({ length: n - 1 }, (_, i) => breakCost(i));
  const best = new Array<number>(n).fill(Infinity); const from = new Array<number>(n).fill(-1);
  for (let j = 0; j < n; j++) {
    const tail = j === n - 1 ? 0 : bc[j]!;
    if (tail === Infinity) continue;
    for (let a = j; a >= 0; a--) {
      if (a > 0 && (bc[a - 1] === Infinity || best[a - 1] === Infinity)) continue;
      const v = (a > 0 ? best[a - 1]! : 0) + pageCost(a, j) + tail;
      if (v < best[j]!) { best[j] = v; from[j] = a; }
      if (j - a > maxWords * 3) break;                                                   // far beyond any useful page
    }
  }
  if (best[n - 1] === Infinity) return [];
  const out: number[] = []; let j = n - 1;
  while (j >= 0) { const a = from[j]!; if (a > 0) out.push(a - 1); j = a - 1; }
  return out.reverse();
}
/** The longest pause between the middle of word a and the middle of word b (where a break between them may sit). */
function nearestPause(pauses: ReadonlyArray<{ fromMs: number; toMs: number }>, a: TranscriptWord, b: TranscriptWord): { fromMs: number; toMs: number } | null {
  const lo = (a.fromMs + a.toMs) / 2, hi = Math.max(lo, (b.fromMs + b.toMs) / 2);
  let best: { fromMs: number; toMs: number } | null = null;
  for (const p of pauses) {
    const f = Math.max(lo, p.fromMs), t = Math.min(hi, p.toMs);
    if (t > f && (!best || t - f > best.toMs - best.fromMs)) best = { fromMs: f, toMs: t };
  }
  return best;
}

/** Groups display words into cues (TikTok style: ≤ 5 words / 32 characters), breaking at pauses and sentence ends, never inside
 *  a number phrase, without orphan words; with `pauses` the page edges snap to the real silence. */
export function groupCues(written: readonly TranscriptWord[], spoken: readonly TranscriptWord[], o: CueOptions = {}): TranscriptCue[] {
  const close = o.closeGapMs ?? 350;
  const words = written.map((w) => ({ ...w }));
  const breaks = pageBreaks(words, o);
  if (o.pauses?.length) {
    for (const i of breaks) {
      const s = nearestPause(o.pauses, words[i]!, words[i + 1]!); if (!s) continue;
      const a = words[i]!, b = words[i + 1]!;
      a.toMs = Math.max(a.fromMs, Math.round(s.fromMs));
      b.fromMs = Math.max(a.toMs, Math.round(s.toMs)); if (b.toMs < b.fromMs) b.toMs = b.fromMs;
    }
    for (let k = 1; k < words.length; k++) { if (words[k]!.fromMs < words[k - 1]!.toMs) words[k]!.fromMs = words[k - 1]!.toMs; if (words[k]!.toMs < words[k]!.fromMs) words[k]!.toMs = words[k]!.fromMs; }
  }
  const groups: TranscriptWord[][] = []; let at = 0;
  for (const i of [...breaks, words.length - 1]) { groups.push(words.slice(at, i + 1)); at = i + 1; }
  const cues = groups.filter((g) => g.length).map((g, index): TranscriptCue => {
    const fromMs = g[0]!.fromMs, toMs = Math.max(fromMs + 1, g.at(-1)!.toMs);
    const sp = spoken.filter((s) => s.fromMs < toMs && s.toMs > fromMs).map((s) => s.text);
    return { index, text: sp.join(' ') || g.map((x) => x.text).join(' '), written: g.map((x) => x.text).join(' '), fromMs, toMs, words: g };
  });
  for (let k = 0; k < cues.length - 1; k++) if (cues[k + 1]!.fromMs - cues[k]!.toMs < close) cues[k]!.toMs = Math.max(cues[k]!.toMs, cues[k + 1]!.fromMs);
  return cues;
}

/**
 * Builds the timed transcript of one voice clip. `tokens`: recognised (whisper) or engine word times in clip time; without
 * them the timing is proportional inside `speech` (the non-silent part of the clip, default the whole clip).
 */
export function buildTranscript(i: { spoken: string; written?: string; language?: string; durationMs: number; tokens?: readonly RecognisedToken[] | null; method?: 'engine' | 'aligned'; speech?: { fromMs: number; toMs: number };
  cues?: CueOptions; /** snaps recognised word edges to the audio (refineWordTimes over energy frames) */ refine?: <T extends { fromMs: number; toMs: number }>(w: readonly T[]) => T[] }): Transcript {
  const spokenWords = splitWords(i.spoken);
  const bounds = i.speech ?? { fromMs: 0, toMs: i.durationMs };
  const t = i.tokens?.length ? timeWordsFromTokens(spokenWords, i.tokens, bounds) : { words: proportionalTimes(spokenWords, bounds.fromMs, bounds.toMs), matched: 0 };
  if (i.refine && i.method !== 'engine') t.words = i.refine(t.words);
  if (i.tokens?.length && i.method === 'engine') for (const w of t.words) if (w.timed === 'aligned') w.timed = 'engine';
  const written = (i.written ?? '').trim() || i.spoken;
  const writtenWords = written === i.spoken ? t.words.map((w) => ({ ...w })) : timeWrittenWords(splitWords(written), t.words);
  const method: TimingMethod = !i.tokens?.length || t.matched === 0 ? 'proportional' : i.method === 'engine' ? 'engine' : 'aligned';
  return {
    version: 1, language: i.language ?? 'id', durationMs: Math.round(i.durationMs), method, spoken: i.spoken, written,
    words: t.words, cues: groupCues(writtenWords, t.words, i.cues), stats: { words: spokenWords.length, matched: t.matched, interpolated: t.words.filter((w) => w.timed === 'interpolated').length },
  };
}

/** The cues of a transcript as Composition Model caption pages, shifted to where the clip starts on the timeline. */
export function cuesToCaptionPages(cues: readonly TranscriptCue[], atMs: number, o: { trimBeforeMs?: number; untilMs?: number } = {}): Array<{ text: string; startMs: number; durationMs: number; tokens: Array<{ text: string; fromMs: number; toMs: number }> }> {
  const trim = o.trimBeforeMs ?? 0; const until = o.untilMs ?? Infinity;
  const out: Array<{ text: string; startMs: number; durationMs: number; tokens: Array<{ text: string; fromMs: number; toMs: number }> }> = [];
  for (const c of cues) {
    if (c.toMs <= trim) continue;
    const s = Math.round(atMs + Math.max(0, c.fromMs - trim)); const e = Math.min(until, Math.round(atMs + c.toMs - trim));
    if (e <= s) continue;
    out.push({ text: c.words.map((w) => ` ${w.text}`).join(''), startMs: s, durationMs: Math.max(1, e - s),
      tokens: c.words.map((w) => {   // R6: clamped to [s, e] on both ends, so words cut off by `untilMs` never get fromMs > toMs
        const fromMs = Math.min(e, Math.max(s, Math.round(atMs + w.fromMs - trim)));
        return { text: ` ${w.text}`, fromMs, toMs: Math.max(fromMs, Math.min(e, Math.round(atMs + w.toMs - trim))) };
      }) });
  }
  return out;
}

// ───────────────────────────── SRT ─────────────────────────────
const ts = (ms: number): string => { const v = Math.max(0, Math.round(ms)); const h = Math.floor(v / 3_600_000), m = Math.floor(v / 60_000) % 60, s = Math.floor(v / 1000) % 60, f = v % 1000; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(f).padStart(3, '0')}`; };
/** SubRip text of the display cues (offset = where the clip starts, 0 for the clip's own file). */
export function transcriptToSrt(cues: readonly TranscriptCue[], offsetMs = 0): string {
  return cues.map((c, k) => `${k + 1}\n${ts(c.fromMs + offsetMs)} --> ${ts(c.toMs + offsetMs)}\n${c.written}\n`).join('\n');
}
/** Cues from parsed SRT captions (startMs/endMs/text; e.g. parseSrt) with word times spread inside each cue. */
export function cuesFromSubtitles(caps: ReadonlyArray<{ text: string; startMs: number; endMs: number }>): TranscriptCue[] {
  return caps.map((c, index) => {
    const words = proportionalTimes(splitWords(c.text), c.startMs, c.endMs, 'srt');
    return { index, text: c.text.trim(), written: c.text.trim(), fromMs: c.startMs, toMs: c.endMs, words };
  });
}

/** Mean absolute per-word start-time error between two timings of the same words (ms). For the real-engine drift check. */
export function meanWordDriftMs(a: readonly TranscriptWord[], b: readonly { fromMs: number }[]): number {
  const n = Math.min(a.length, b.length); if (!n) return 0;
  let s = 0; for (let k = 0; k < n; k++) s += Math.abs(a[k]!.fromMs - b[k]!.fromMs);
  return s / n;
}
