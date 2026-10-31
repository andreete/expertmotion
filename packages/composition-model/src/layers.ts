// Layers and lanes (ADR-027; DATABASE_SCHEMA.md §4.4 CM-012). Every text, image and shape sits on one visual `layer`
// (higher = more in front; the Timeline View draws one lane per layer, the top row is the front-most); audio layers sit on
// audio `lane`s under the video Track. Items on one lane never overlap in time: an add or a move that would overlap goes to
// the lane above, or to a new lane inserted there. Lanes are kept dense (0…n-1; an emptied lane disappears, like CapCut).
// Pure helpers shared by applyOperations, migrateModel, validate, the Engine render order and the Timeline View.
import type { AudioLayerT, CompositionModelT, OverlayElementT, TextLayerT } from './schema.js';

export type VisualItem = TextLayerT | OverlayElementT;
export type VisualKind = 'text' | 'image' | 'shape' | 'video';   // `video` = a video overlay (ADR-039), not a Clip
export type LayerMove = 'up' | 'down' | 'front' | 'back';
export interface Span { fromMs: number; toMs: number }

export const visualKindOf = (x: VisualItem): VisualKind => ('kind' in x ? x.kind : 'text');
export const visualSpan = (x: { timing: { atMs: number; durationMs: number } }): Span => ({ fromMs: x.timing.atMs, toMs: x.timing.atMs + x.timing.durationMs });
/** Audio without an explicit length runs to the end of the video: an open span. */
export const audioSpan = (a: Pick<AudioLayerT, 'atMs' | 'durationMs'>): Span => ({ fromMs: a.atMs, toMs: a.durationMs === undefined ? Infinity : a.atMs + a.durationMs });
export const spansOverlap = (a: Span, b: Span): boolean => a.fromMs < b.toMs && b.fromMs < a.toMs;

/** Visual items in storage order (overlays, then texts): the tie-break of the render order. */
export const visualItems = (m: CompositionModelT): VisualItem[] => [...m.tracks.overlay, ...m.tracks.text];

/** Render order back → front: by layer, stable (equal layers share a lane and never overlap). Captions render above all of them. */
export function visualStack(m: CompositionModelT): VisualItem[] {
  return visualItems(m).map((item, i) => ({ item, i })).sort((a, b) => a.item.layer - b.item.layer || a.i - b.i).map((x) => x.item);
}
/** The front-most visual item (optionally of some kinds) playing at `ms`. */
export function topmostAt(m: CompositionModelT, ms: number, kinds?: readonly VisualKind[]): VisualItem | undefined {
  let best: VisualItem | undefined;
  for (const x of visualItems(m)) {
    if (kinds && !kinds.includes(visualKindOf(x))) continue;
    const s = visualSpan(x);
    if (ms >= s.fromMs && ms < s.toMs && (!best || x.layer > best.layer)) best = x;
  }
  return best;
}

// ───────────── lane mechanics (generic over the visual `layer` and the audio `lane`) ─────────────
interface Acc<T> { span: (x: T) => Span; get: (x: T) => number; set: (x: T, n: number) => void }
const V: Acc<VisualItem> = { span: visualSpan, get: (x) => x.layer, set: (x, n) => { x.layer = n; } };
const A: Acc<AudioLayerT> = { span: audioSpan, get: (x) => x.lane, set: (x, n) => { x.lane = n; } };
function fits<T>(acc: Acc<T>, items: readonly T[], self: T, lane: number): boolean {
  const s = acc.span(self);
  return !items.some((o) => o !== self && acc.get(o) === lane && spansOverlap(acc.span(o), s));
}
/** Inserts an empty lane at `at` (every other item on `at` or above moves up one) and puts `self` on it. */
function openLane<T>(acc: Acc<T>, items: readonly T[], self: T, at: number): void {
  for (const o of items) if (o !== self && acc.get(o) >= at) acc.set(o, acc.get(o) + 1);
  acc.set(self, at);
}
const maxOther = <T>(acc: Acc<T>, items: readonly T[], self: T) => items.reduce((mx, o) => (o === self ? mx : Math.max(mx, acc.get(o))), -1);
function densify<T>(acc: Acc<T>, items: readonly T[]): void {
  const used = [...new Set(items.map(acc.get))].sort((a, b) => a - b);
  const to = new Map(used.map((v, i) => [v, i]));
  for (const x of items) acc.set(x, to.get(acc.get(x))!);
}

// ───────────── visual layers ─────────────
/** Layer for a new item: just in front of every item it overlaps in time; 0 when it overlaps nothing. Always a free lane. */
export function frontLayerFor(items: readonly VisualItem[], span: Span, self?: VisualItem): number {
  let top = -1;
  for (const o of items) if (o !== self && spansOverlap(visualSpan(o), span)) top = Math.max(top, o.layer);
  return top + 1;
}
/** `self` goes on lane `desired` (clamped to 0 … top+1) when free there; else on the lane above when free; else on a new lane inserted above `desired`. */
export function placeVisual(items: readonly VisualItem[], self: VisualItem, desired: number): void {
  const d = Math.max(0, Math.min(desired, maxOther(V, items, self) + 1));
  if (fits(V, items, self, d)) { self.layer = d; return; }
  if (fits(V, items, self, d + 1)) { self.layer = d + 1; return; }
  openLane(V, items, self, d + 1);
}
/**
 * Layer moves (op:element.setLayer): `up` / `down` = one lane up or down on screen; when that lane is busy at this time the item
 * passes the item there (it lands directly above it, resp. below it). `front` / `back` = in front of / behind every item it
 * overlaps in time. Moves that cannot go further (front-most, bottom lane) leave the item where it is.
 */
export function moveVisual(items: readonly VisualItem[], self: VisualItem, move: LayerMove): void {
  const cur = self.layer, span = visualSpan(self);
  const over = items.filter((o) => o !== self && spansOverlap(visualSpan(o), span));
  if (move === 'up') { placeVisual(items, self, cur + 1); return; }
  if (move === 'down') {
    if (cur === 0) return;
    if (fits(V, items, self, cur - 1)) self.layer = cur - 1; else openLane(V, items, self, cur - 1);
    return;
  }
  if (move === 'front') { if (over.some((o) => o.layer > cur)) self.layer = Math.max(...over.map((o) => o.layer)) + 1; return; }
  if (!over.some((o) => o.layer < cur)) return;
  const b = Math.min(...over.map((o) => o.layer));
  if (b > 0) self.layer = b - 1; else openLane(V, items, self, 0);
}

// ───────────── audio lanes ─────────────
/** First audio lane from `from` on where `self` fits (a new lane at the bottom when none does). */
export function freeAudioLane(audio: readonly AudioLayerT[], self: AudioLayerT, from = 0): number {
  let l = Math.max(0, from);
  while (!fits(A, audio, self, l)) l += 1;
  return l;
}
/** `self` goes on audio lane `desired` (clamped to 0 … last+1) when free there; else on the next free lane below it. */
export function placeAudio(audio: readonly AudioLayerT[], self: AudioLayerT, desired: number): void {
  const d = Math.max(0, Math.min(desired, maxOther(A, audio, self) + 1));
  self.lane = fits(A, audio, self, d) ? d : freeAudioLane(audio, self, d + 1);
}

/** Dense numbering (0…n-1, order kept) for visual layers and audio lanes; empty lanes disappear. */
export function normalizeLanes(m: CompositionModelT): void {
  densify(V, visualItems(m));
  densify(A, m.tracks.audio);
}

/** CM-012: pairs of items on one lane that overlap in time (apply never produces them; hand-made JSON can). */
export function laneConflicts(m: CompositionModelT): Array<{ a: string; b: string; lane: number; track: 'layer' | 'audio' }> {
  const out: Array<{ a: string; b: string; lane: number; track: 'layer' | 'audio' }> = [];
  const scan = <T extends { id: string }>(acc: Acc<T>, items: readonly T[], track: 'layer' | 'audio') => {
    items.forEach((x, i) => { for (const y of items.slice(i + 1)) if (acc.get(x) === acc.get(y) && spansOverlap(acc.span(x), acc.span(y))) out.push({ a: x.id, b: y.id, lane: acc.get(x), track }); });
  };
  scan(V, visualItems(m), 'layer');
  scan(A, m.tracks.audio, 'audio');
  return out;
}

/**
 * Schema v1 → v2 lanes (DATABASE_SCHEMA.md §5): the v1 render order was overlays (array order) under texts (array order), so each
 * visual item gets the lowest layer above every earlier item it overlaps — the picture stays identical and lanes stay dense.
 * Audio layers get the first free lane in array order; v1 looping layers ran to the end whatever their durationMs, so that
 * field is dropped from them (v2 honours durationMs on looping layers).
 */
export function assignLanesV1(json: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(json);
  const tracks = out['tracks'] as Record<string, unknown> | undefined;
  if (!tracks || typeof tracks !== 'object') return out;
  const arr = (k: string) => (Array.isArray(tracks[k]) ? (tracks[k] as Array<Record<string, unknown>>) : []);
  const span = (x: Record<string, unknown>): Span => { const t = (x['timing'] ?? {}) as Record<string, unknown>; const at = Number(t['atMs'] ?? 0); return { fromMs: at, toMs: at + Number(t['durationMs'] ?? 0) }; };
  const placed: Array<{ s: Span; layer: number }> = [];
  for (const x of [...arr('overlay'), ...arr('text')]) {
    const s = span(x);
    const layer = placed.reduce((mx, p) => (spansOverlap(p.s, s) ? Math.max(mx, p.layer + 1) : mx), 0);
    x['layer'] = layer; placed.push({ s, layer });
  }
  const lanes: Array<{ s: Span; lane: number }> = [];
  for (const a of arr('audio')) {
    if (a['loop'] === true) delete a['durationMs'];
    const at = Number(a['atMs'] ?? 0), d = a['durationMs'];
    const s: Span = { fromMs: at, toMs: typeof d === 'number' ? at + d : Infinity };
    let lane = 0;
    while (lanes.some((l) => l.lane === lane && spansOverlap(l.s, s))) lane += 1;
    a['lane'] = lane; lanes.push({ s, lane });
  }
  return out;
}
