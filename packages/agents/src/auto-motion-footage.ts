// FR-261 (Operator 2026-10-29: "buat video dari footage ini dengan teks dan grafik yang sesuai"): the Creator's own footage as
// the base of an automatic edit. Pure helpers of the scene composer (auto-motion.ts) for the footage roles:
//   footage        — full-frame footage; overlays (kinetic title, lower-third, stat / list callouts, note) only in the top or
//                    bottom third, each for a few seconds, never over the centre / the subject for long;
//   footage-split  — footage on one half (portrait: top half; landscape: left / right half, by crop + frame offset) and the
//                    scene's texts / stats on the other half;
//   footage-pip    — the footage in a window (scaled clip) over the designed background, texts beside / below it.
// The footage clip is an ordinary op:clip.insert (trim = the scene's window of the source; sound kept, ducked to 0.2 under a
// voice-over; crop / frame position for split / pip). Anchors can name a source moment ({footageMs}) or a spoken phrase
// ({say}) from the asset's transcript (AssetFacts.transcript, source time).
import type { AssetFacts } from '@expertmotion/composition-model';
import { FOOTAGE_ROLES, type SceneRole, type SpecSceneT } from './auto-motion-spec.js';

export interface FootageWindow {
  assetId: string; name: string; trimBeforeMs: number; availMs: number; hasAudio: boolean;
  focus: 'center' | 'left' | 'right' | 'top' | 'bottom'; fit: 'cover' | 'contain'; volume?: number; muted?: boolean;
  words: Array<{ text: string; fromMs: number; toMs: number }>;
}
type Risk = { code: string; message: string; severity: 'info' | 'warn' };
export const isFootageRole = (r: SceneRole): boolean => FOOTAGE_ROLES.includes(r);
/** Shortest footage scene (ms); shorter windows are refused with a risk. */
export const FOOTAGE_MIN_MS = 1200;
/** Without a requested length, a footage scene without voice clips plays the whole window, at most this long. */
export const FOOTAGE_DEFAULT_MAX_MS = 60_000;

/**
 * The source window of a footage scene: footage.assetId (or the scene's assetId when it names a video), clamped to the asset.
 * null (+ a risk) when the asset is missing, not a ready video or the window is too short.
 */
export function footageWindow(s: SpecSceneT, i: number, assets: readonly AssetFacts[], id: boolean, risks: Risk[]): FootageWindow | null {
  const ref = s.footage?.assetId ?? s.assetId;
  const n = i + 1;
  if (!ref) { risks.push({ code: 'footage-missing', severity: 'warn', message: id ? `Adegan ${n} (footage) tidak menyebut video; adegan dibuat tanpa footage.` : `Scene ${n} (footage) names no video; it was made without footage.` }); return null; }
  const a = assets.find((x) => x.id === ref);
  if (!a || a.kind !== 'video' || a.status !== 'ready') {
    risks.push({ code: 'footage-missing', severity: 'warn', message: id ? `Adegan ${n}: video ${a?.name ?? ref} tidak ada atau belum siap; adegan dibuat tanpa footage.` : `Scene ${n}: video ${a?.name ?? ref} is missing or not ready; it was made without footage.` });
    return null;
  }
  const dur = a.durationMs ?? 0;
  const from = Math.max(0, Math.min(s.footage?.fromMs ?? 0, Math.max(0, dur - FOOTAGE_MIN_MS)));
  const to = Math.max(from, Math.min(s.footage?.toMs ?? dur, dur));
  if (s.footage?.fromMs !== undefined && s.footage.fromMs !== from || s.footage?.toMs !== undefined && s.footage.toMs > dur)
    risks.push({ code: 'footage-trim', severity: 'info', message: id ? `Adegan ${n}: potongan ${a.name ?? ref} disesuaikan ke panjang video (${(dur / 1000).toFixed(1).replace('.', ',')} dtk).` : `Scene ${n}: the cut of ${a.name ?? ref} was fitted to the video (${(dur / 1000).toFixed(1)} s).` });
  if (to - from < FOOTAGE_MIN_MS) { risks.push({ code: 'footage-short', severity: 'warn', message: id ? `Adegan ${n}: potongan video terlalu pendek (< 1,2 dtk).` : `Scene ${n}: the footage cut is too short (< 1.2 s).` }); return null; }
  const fw: FootageWindow = { assetId: a.id, name: a.name ?? a.id, trimBeforeMs: from, availMs: to - from, hasAudio: a.hasAudio === true, focus: s.footage?.focus ?? 'center', fit: s.footage?.fit ?? 'cover', words: a.transcript?.words ?? segmentWords(a.transcript?.segments ?? []) };
  if (s.footage?.volume !== undefined) fw.volume = s.footage.volume;
  if (s.footage?.muted !== undefined) fw.muted = s.footage.muted;
  return fw;
}
/** Segment-level transcripts (whisper pages) spread over their words (approximate; used only for {say} anchors). */
function segmentWords(segs: ReadonlyArray<{ text: string; fromMs: number; toMs: number }>): FootageWindow['words'] {
  const out: FootageWindow['words'] = [];
  for (const g of segs) {
    const w = g.text.trim().split(/\s+/).filter(Boolean);
    const step = w.length ? (g.toMs - g.fromMs) / w.length : 0;
    w.forEach((text, k) => out.push({ text, fromMs: Math.round(g.fromMs + k * step), toMs: Math.round(g.fromMs + (k + 1) * step) }));
  }
  return out;
}
export const normWord = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
/** Levenshtein distance of two short strings (words). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
/** Normalised word similarity 1 − levenshtein / longer length (1 = same word, 0 = nothing in common). */
export function wordSimilarity(a: string, b: string): number {
  const x = normWord(a), y = normWord(b);
  const n = Math.max(x.length, y.length);
  return n ? 1 - levenshtein(x, y) / n : 1;
}
/** ADR-039: a fuzzy word match: ≥ `minSim` (0.75) per word; words of ≤ 3 letters must match exactly (no "di" ≈ "ke"). */
export const DEFAULT_SAY_MIN_SIM = 0.75;
export function wordMatches(heard: string, want: string, minSim = DEFAULT_SAY_MIN_SIM): boolean {
  const h = normWord(heard), w = normWord(want);
  if (h === w) return true;
  if (w.length <= 3 || h.length <= 3) return false;
  return wordSimilarity(h, w) >= minSim;
}
/**
 * Source time (ms) where `phrase` is said inside [from, from + len) of the transcript; null when not found. Exact word matches win;
 * otherwise the best fuzzy match (every word ≥ `minSim` similar, ADR-039: whisper spells "SMR" as "smr", "AI" as "ai" or "a i",
 * "24" as "dua puluh empat" is NOT matched — the composer falls back to an explicit `fallbackMs`).
 */
export function findSaid(words: FootageWindow['words'], phrase: string, from: number, len: number, edge: 'start' | 'end' = 'start', opts: { minSim?: number } = {}): number | null {
  const hit = findSaidIndex(words, phrase, from, len, opts);
  if (!hit) return null;
  return edge === 'end' ? words[hit.index + hit.length - 1]!.toMs : words[hit.index]!.fromMs;
}
/** The matched word run (index + length in `words`) and its mean similarity; null when nothing matches. */
export function findSaidIndex(words: ReadonlyArray<{ text: string; fromMs: number; toMs: number }>, phrase: string, from: number, len: number, opts: { minSim?: number } = {}): { index: number; length: number; similarity: number } | null {
  const want = normWord(phrase).split(/\s+/).filter(Boolean);
  if (!want.length) return null;
  const minSim = opts.minSim ?? DEFAULT_SAY_MIN_SIM;
  let best: { index: number; length: number; similarity: number } | null = null;
  for (let k = 0; k + want.length <= words.length; k++) {
    if (words[k]!.fromMs < from || words[k]!.fromMs >= from + len) continue;
    if (want.every((w, j) => normWord(words[k + j]!.text) === w)) return { index: k, length: want.length, similarity: 1 };
    if (!want.every((w, j) => wordMatches(words[k + j]!.text, w, minSim))) continue;
    const sim = want.reduce((a, w, j) => a + wordSimilarity(words[k + j]!.text, w), 0) / want.length;
    if (!best || sim > best.similarity) best = { index: k, length: want.length, similarity: sim };
  }
  return best;
}
/** ADR-039: the words of one cut of a footage analysis (recording time), [] when the cut is unknown. */
export function cutWordsFor(cuts: ReadonlyArray<{ id: string; words: ReadonlyArray<{ text: string; fromMs: number; toMs: number }> }>, cutId: string): Array<{ text: string; fromMs: number; toMs: number }> {
  return (cuts.find((c) => c.id === cutId)?.words ?? []).map((w) => ({ text: w.text, fromMs: w.fromMs, toMs: w.toMs }));
}

/** Scene length of a footage scene: its window, the voice / requested length if shorter, always leaving the outgoing transition room. */
export function footageSceneMs(w: FootageWindow, want: number | null, reserveMs: number): number {
  const room = Math.max(FOOTAGE_MIN_MS - reserveMs, w.availMs - reserveMs);
  return Math.max(500, Math.round(Math.min(room, want ?? Math.min(w.availMs, FOOTAGE_DEFAULT_MAX_MS))));
}

export interface PipBox { x0: number; y0: number; x1: number; y1: number; scale: number }
/** The footage window of footage-pip (u): portrait → top-right of the content area; landscape → right, centred vertically. */
export function pipBox(f: { w: number; h: number }, safe: { top: number; right: number; bottom: number; left: number }, portrait: boolean, side: string | undefined): PipBox {
  const scale = portrait ? 0.42 : 0.45;
  const w = f.w * scale, h = f.h * scale;
  const right = side !== 'left';
  const x0 = right ? f.w - safe.right - w : safe.left;
  const y0 = portrait ? safe.top + 40 : Math.max(safe.top, safe.top + (f.h - safe.top - safe.bottom - h) / 2);
  return { x0, y0, x1: x0 + w, y1: y0 + h, scale };
}
/** Which half footage-split uses: portrait top / bottom, landscape left / right. */
export function splitSide(portrait: boolean, side: string | undefined): 'top' | 'bottom' | 'left' | 'right' {
  if (portrait) return side === 'bottom' ? 'bottom' : 'top';
  return side === 'right' ? 'right' : 'left';
}

/** op:clip.insert args for a footage scene (crop + frame offset for split, scaled window for pip). */
export function footageClipArgs(role: SceneRole, w: FootageWindow, clipDurMs: number, f: { w: number; h: number }, safe: { top: number; right: number; bottom: number; left: number }, portrait: boolean, side: string | undefined,
  opts: { underVoice: boolean; last: boolean }): Record<string, unknown> {
  const volume = w.muted ? 0 : w.volume ?? (opts.underVoice ? 0.2 : 1);
  const args: Record<string, unknown> = { assetId: w.assetId, trimBeforeMs: w.trimBeforeMs, durationMs: Math.max(100, Math.min(clipDurMs, w.availMs)), volume, objectFit: w.fit };
  if (w.muted) args['muted'] = true;
  if (opts.last && w.hasAudio && volume > 0) args['fadeOutMs'] = Math.min(600, Math.floor(clipDurMs / 3));
  if (role === 'footage-split') {
    const half = splitSide(portrait, side);
    args['objectFit'] = 'cover';
    if (half === 'top' || half === 'bottom') { args['crop'] = { left: 0, right: 0, top: 0.25, bottom: 0.25 }; args['transform'] = { y: half === 'top' ? -0.25 : 0.25 }; }
    else { args['crop'] = { left: 0.25, right: 0.25, top: 0, bottom: 0 }; args['transform'] = { x: half === 'left' ? -0.25 : 0.25 }; }
  } else if (role === 'footage-pip') {
    const b = pipBox(f, safe, portrait, side);
    args['objectFit'] = 'cover';
    args['transform'] = { scale: b.scale, x: Math.round((((b.x0 + b.x1) / 2 - f.w / 2) / f.w) * 10_000) / 10_000, y: Math.round((((b.y0 + b.y1) / 2 - f.h / 2) / f.h) * 10_000) / 10_000 };
  }
  return args;
}
