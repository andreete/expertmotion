// ADR-031: manual Timeline edits on whole items (Delete, Duplicate) and scene-anchored texts. Pure helpers shared by the
// agents Compile path (`itemsEdit` picks), the Editor's mock server and applyOperations.
//
// Scene anchoring: a text, image or shape that lies completely inside the window of a scene clip (ADR-030, a clip without
// media) belongs to that scene. When an operation moves the scene clip in time (a clip before it is removed, inserted, moved,
// trimmed, or a transition before it changes), its items move by the same amount, so a scene keeps its title. Items that are
// not fully inside one scene clip (a logo over the whole video, a text across a cut) keep their absolute times. Media clips
// never anchor anything (CapCut behaviour: overlays stay where they are).
import { deriveTiming } from './timing.js';
import type { ElementRefT, OperationT } from './operations.js';
import type { CompositionModelT } from './schema.js';
import { placeVisual, visualItems, visualSpan, type VisualItem } from './layers.js';

/** What a manual item edit may name: a Timeline Element ref as the Timeline selects it. */
export type ItemKind = 'clip' | 'text' | 'image' | 'shape' | 'video' | 'audio' | 'cut' | 'effect' | 'background' | 'caption';
export const ITEM_KINDS: readonly ItemKind[] = ['clip', 'text', 'image', 'shape', 'video', 'audio', 'cut', 'effect', 'background', 'caption'];
export interface ItemRef { kind: ItemKind; id?: string; index?: number }
/** One resolved target and the operation it compiles to (one child intent each). */
export interface ItemStep { target: ElementRefT; op: OperationT }

const sameRef = (a: { kind: string; id?: string | undefined; index?: number | undefined }, b: { kind: string; id?: string | undefined; index?: number | undefined }) =>
  a.kind === b.kind && (a.id ?? null) === (b.id ?? null) && (a.index ?? null) === (b.index ?? null);
const refOf = (x: VisualItem): ElementRefT => ({ kind: 'kind' in x ? x.kind : 'text', id: x.id });

// ───────────────────────────── scene anchors ─────────────────────────────
export interface SceneAnchor { item: VisualItem; clipId: string; fromMs: number }
/** Every visual item fully inside a scene clip's window, with that clip (the latest-starting one when windows overlap at a transition). */
export function sceneAnchors(model: CompositionModelT): SceneAnchor[] {
  const scenes = model.tracks.video.filter((c) => c.assetId === undefined);
  if (!scenes.length) return [];
  const w = deriveTiming(model).elementWindows;
  const out: SceneAnchor[] = [];
  for (const item of visualItems(model)) {
    const s = visualSpan(item);
    let best: { id: string; fromMs: number } | null = null;
    for (const c of scenes) {
      const cw = w[c.id];
      if (cw && s.fromMs >= cw.fromMs && s.toMs <= cw.toMs && (!best || cw.fromMs > best.fromMs)) best = { id: c.id, fromMs: cw.fromMs };
    }
    if (best) out.push({ item, clipId: best.id, fromMs: best.fromMs });
  }
  return out;
}
/** The texts, images and shapes that belong to scene clip `clipId` (empty for a media clip). */
export function sceneItemsOf(model: CompositionModelT, clipId: string): ElementRefT[] {
  return sceneAnchors(model).filter((a) => a.clipId === clipId).map((a) => refOf(a.item));
}
/**
 * After an operation: items anchored to a scene clip that still exists move by the change of that clip's start (lane rule
 * applied, earliest first). Items of a removed clip stay where they are (a Delete removes them explicitly, see removalSteps).
 */
export function followSceneAnchors(m: CompositionModelT, before: readonly SceneAnchor[]): void {
  if (!before.length) return;
  const w = deriveTiming(m).elementWindows;
  const moved: VisualItem[] = [];
  for (const a of before) {
    const now = m.tracks.video.some((c) => c.id === a.clipId) ? w[a.clipId] : undefined;
    if (!now || now.fromMs === a.fromMs) continue;
    const live = visualItems(m).find((x) => x.id === a.item.id && ('kind' in x ? x.kind : 'text') === ('kind' in a.item ? a.item.kind : 'text'));
    if (!live) continue;
    live.timing = { ...live.timing, atMs: Math.max(0, Math.round(live.timing.atMs + now.fromMs - a.fromMs)) };
    moved.push(live);
  }
  for (const x of moved.sort((p, q) => p.timing.atMs - q.timing.atMs)) placeVisual(visualItems(m), x, x.layer);
}
/** Ops that can change where clips start (only these need the anchor bookkeeping). */
export const CLIP_TIMING_OPS: ReadonlySet<string> = new Set(['op:clip.insert', 'op:clip.remove', 'op:clip.move', 'op:clip.setTrim', 'op:clip.setPlaybackRate', 'op:scene.add', 'op:transition.set', 'op:transition.clear', 'op:element.split']);

// ───────────────────────────── existence ─────────────────────────────
function exists(model: CompositionModelT, r: ItemRef): boolean {
  const v = model.tracks.video;
  switch (r.kind) {
    case 'clip': return v.some((c) => c.id === r.id);
    case 'text': return model.tracks.text.some((x) => x.id === r.id);
    case 'image': case 'shape': case 'video': return model.tracks.overlay.some((o) => o.kind === r.kind && o.id === r.id);
    case 'audio': return model.tracks.audio.some((a) => a.id === r.id);
    case 'cut': return r.index !== undefined && model.transitions.some((t) => t.cutIndex === r.index);
    case 'effect': { const [clipId, presetId] = (r.id ?? '').split('|'); return !!v.find((c) => c.id === clipId)?.effects.some((e) => e.presetId === presetId); }
    case 'background': return model.background !== null;
    case 'caption': return r.index !== undefined && r.index < model.tracks.caption.pages.length;
    default: return false;
  }
}
function unique(model: CompositionModelT, items: readonly ItemRef[]): ItemRef[] {
  const out: ItemRef[] = [];
  for (const r of items) if (exists(model, r) && !out.some((x) => sameRef(x, r))) out.push({ kind: r.kind, ...(r.id !== undefined ? { id: r.id } : {}), ...(r.index !== undefined ? { index: r.index } : {}) });
  return out;
}

// ───────────────────────────── Delete ─────────────────────────────
const REMOVE_ORDER: Record<ItemKind, number> = { cut: 0, effect: 1, background: 2, caption: 3, text: 4, image: 4, shape: 4, video: 4, audio: 5, clip: 6 };
/**
 * The ops that delete `items` (those that still exist), in a safe order: transitions and effects first (cut indexes are still
 * valid), then the project background, caption pages (ONE op:caption.setPages without them), texts / images / shapes, audio,
 * and clips last. A scene clip takes its own texts, images and shapes with it (sceneItemsOf); effects of a deleted clip are
 * dropped with the clip. Later scenes and their items close the gap (op:clip.remove + scene anchoring).
 */
export function removalSteps(model: CompositionModelT, items: readonly ItemRef[]): ItemStep[] {
  const list = unique(model, items);
  const clipIds = new Set(list.filter((r) => r.kind === 'clip').map((r) => r.id!));
  for (const id of clipIds) for (const x of sceneItemsOf(model, id)) if (!list.some((r) => sameRef(r, x))) list.push(x as ItemRef);
  const kept = list.filter((r) => !(r.kind === 'effect' && clipIds.has((r.id ?? '').split('|')[0]!)));
  const steps: ItemStep[] = [];
  const captions = kept.filter((r) => r.kind === 'caption').map((r) => r.index!).sort((a, b) => a - b);
  for (const r of [...kept].sort((a, b) => REMOVE_ORDER[a.kind] - REMOVE_ORDER[b.kind] || (a.index ?? 0) - (b.index ?? 0))) {
    switch (r.kind) {
      case 'clip': steps.push({ target: { kind: 'clip', id: r.id! }, op: { op: 'op:clip.remove', target: { kind: 'clip', id: r.id! }, args: {} } }); break;
      case 'text': steps.push({ target: { kind: 'text', id: r.id! }, op: { op: 'op:text.remove', target: { kind: 'text', id: r.id! }, args: {} } }); break;
      case 'image': case 'video': steps.push({ target: { kind: r.kind, id: r.id! }, op: { op: 'op:overlay.remove', target: { kind: r.kind, id: r.id! }, args: {} } }); break;
      case 'shape': steps.push({ target: { kind: 'shape', id: r.id! }, op: { op: 'op:shape.remove', target: { kind: 'shape', id: r.id! }, args: {} } }); break;
      case 'audio': steps.push({ target: { kind: 'audio', id: r.id! }, op: { op: 'op:audio.remove', target: { kind: 'audio', id: r.id! }, args: {} } }); break;
      case 'cut': steps.push({ target: { kind: 'cut', index: r.index! }, op: { op: 'op:transition.clear', target: { kind: 'cut', index: r.index! }, args: {} } }); break;
      case 'effect': { const [clipId, presetId] = r.id!.split('|'); steps.push({ target: { kind: 'effect', id: r.id! }, op: { op: 'op:effect.remove', target: { kind: 'clip', id: clipId! }, args: { presetId } } }); break; }
      case 'background': steps.push({ target: { kind: 'background' }, op: { op: 'op:background.clear', target: { kind: 'project' }, args: {} } }); break;
      case 'caption':
        if (r.index !== captions[0]) break;                          // all selected pages go in one op (on the first page's target)
        steps.push({ target: { kind: 'caption', index: captions[0]! }, op: { op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages: model.tracks.caption.pages.filter((_, i) => !captions.includes(i)) } } });
        break;
    }
  }
  return steps;
}

// ───────────────────────────── Duplicate ─────────────────────────────
/** Kinds Duplicate supports (the add ops rebuild them with every field); captions, transitions, effects, the background and audio beds are not duplicated. */
export const DUPLICABLE_KINDS: ReadonlySet<ItemKind> = new Set(['clip', 'text', 'image', 'shape', 'video', 'audio']);
type TextT = CompositionModelT['tracks']['text'][number];
type ImageT = Extract<CompositionModelT['tracks']['overlay'][number], { kind: 'image' }>;
type ShapeT = Extract<CompositionModelT['tracks']['overlay'][number], { kind: 'shape' }>;
type VideoT = Extract<CompositionModelT['tracks']['overlay'][number], { kind: 'video' }>;
type MotionT = TextT['motion'];
type Args = Record<string, unknown>;
const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
/** A stored motion as the add ops' `motion` arg (every field; null = preset:motion.none so no default entrance is added). */
const motionArg = (mo: MotionT): Args => ({ motion: mo
  ? { presetId: mo.presetId, durationMs: clampInt(mo.durationMs, 100, 10_000), delayMs: clampInt(mo.delayMs ?? 0, 0, 60_000), ...(mo.easingId !== undefined ? { easingId: mo.easingId } : {}), exit: mo.exit !== false, params: structuredClone(mo.params ?? {}) }
  : { presetId: 'preset:motion.none' } });
const defined = (o: object): Args => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const opt = (k: string, v: unknown): Args => (v === undefined ? {} : { [k]: structuredClone(v) });
const sizeArg = (w: number) => Math.max(10, Math.min(4000, Math.round(w)));
/**
 * C1 (review 2026-10-29): Duplicate / Copy copy EVERY field of the source element. One translator per field of the element type
 * (`Record<keyof …>`: a field added to the schema later does not compile until it is mapped here); only `id`, `timing` and
 * `layer` are new (fresh id, the copy's time, the lane rule). test/items.test.ts checks duplicate(x) equals x except those.
 */
type Fields<T> = { [K in Exclude<keyof T, 'id' | 'timing' | 'layer'>]-?: (v: T[K], x: T) => Args };
const TEXT_FIELDS: Fields<TextT> = {
  variantId: (v) => ({ variant: v }), text: (v) => ({ text: v }), position: (v) => ({ position: { x: v.x, y: v.y } }),
  maxWidth: (v) => opt('maxWidth', v), valign: (v) => (v === 'top' ? { valign: 'top' } : {}),
  style: (v) => { const st = defined(v); return Object.keys(st).length ? { styleOverrides: structuredClone(st) } : {}; },
  effect: (v) => (v ? { effect: { presetId: v.presetId, params: structuredClone(v.params ?? {}) } } : {}),
  motion: (v) => motionArg(v),
};
const IMAGE_FIELDS: Fields<ImageT> = {
  kind: () => ({}), assetId: (v) => ({ assetId: v }), position: (v) => ({ position: { x: v.x, y: v.y } }),
  size: (v) => ({ size: sizeArg(v.w) }),                       // the height follows the image aspect (op:overlay.addImage)
  objectFit: (v) => ({ objectFit: v }), opacity: (v) => ({ opacity: v }), scale: (v) => opt('scale', v), rotation: (v) => opt('rotation', v),
  motion: (v) => motionArg(v),
  effects: () => ({}),                                         // no op adds effects to an image: always [] (op:overlay.addImage)
  radius: (v) => opt('radius', v), shadow: (v) => opt('shadow', v), border: (v) => opt('border', v),   // ADR-041 look
};
const SHAPE_FIELDS: Fields<ShapeT> = {
  kind: () => ({}), presetId: (v) => ({ presetId: v }), position: (v) => ({ position: { x: v.x, y: v.y } }),
  size: (v) => ({ size: sizeArg(v.w), height: Math.max(1, Math.min(4000, Math.round(v.h))) }),
  fill: (v) => ({ fill: v }), stroke: (v) => opt('stroke', v), strokeWidth: (v) => opt('strokeWidth', v), opacity: (v) => opt('opacity', v),
  scale: (v) => opt('scale', v), rotation: (v) => opt('rotation', v), params: (v) => ({ params: structuredClone(v ?? {}) }), motion: (v) => motionArg(v),
};
/** ADR-039: a video overlay copy keeps its trim, mask, ring, focus, sound and look (op:overlay.addVideo carries every field). */
const VIDEO_FIELDS: Fields<VideoT> = {
  kind: () => ({}), assetId: (v) => ({ assetId: v }), position: (v) => ({ position: { x: v.x, y: v.y } }),
  size: (v, x) => ({ size: sizeArg(v.w), ...(x.shape === 'circle' ? {} : { height: Math.max(1, Math.min(4000, Math.round(v.h))) }) }),
  trimBeforeMs: (v) => ({ trimBeforeMs: v }), muted: (v) => ({ muted: v }), shape: (v) => ({ shape: v }), radius: (v) => opt('radius', v),
  ring: (v) => opt('ring', v), focus: (v) => opt('focus', v), opacity: (v) => opt('opacity', v), scale: (v) => opt('scale', v), rotation: (v) => opt('rotation', v),
  motion: (v) => motionArg(v),
};
type ClipT = CompositionModelT['tracks']['video'][number];
type AudioT = CompositionModelT['tracks']['audio'][number];
/** Round 2 (QA 2026-10-29): a clip copy keeps its sound, fades, fit / crop, frame transform, rate, motion and effects. Media clips
 *  rebuild with op:clip.insert, scene clips with op:scene.add (assetId / scene name the op); durationMs is clamped for scene.add. */
const CLIP_FIELDS: { [K in Exclude<keyof ClipT, 'id'>]-?: (v: ClipT[K], x: ClipT) => Args } = {
  assetId: (v) => (v === undefined ? {} : { assetId: v }),
  scene: (v) => (v ? { background: v.presetId, backgroundParams: structuredClone(v.params ?? {}) } : {}),
  trimBeforeMs: (v, x) => (x.assetId !== undefined ? { trimBeforeMs: v } : {}),
  durationMs: (v, x) => ({ durationMs: x.assetId !== undefined ? v : Math.max(500, Math.min(120_000, v)) }),
  playbackRate: (v) => (v !== 1 ? { playbackRate: v } : {}), volume: (v) => ({ volume: v }), muted: (v) => ({ muted: v }),
  fadeInMs: (v) => ({ fadeInMs: v }), fadeOutMs: (v) => ({ fadeOutMs: v }), objectFit: (v) => ({ objectFit: v }),
  crop: (v) => opt('crop', v), transform: (v) => opt('transform', v),
  motion: (v) => (v ? motionArg(v) : {}),
  effects: (v) => (v.length ? { effects: v.map((e) => ({ presetId: e.presetId, params: { ...structuredClone(e.params ?? {}), motion: e.motion } })) } : {}),
  zoom: (v) => opt('zoom', v),                                  // ADR-039
};
/** Round 2: a voice / sfx copy keeps its trim, length, volume, loop, fades and ducking (lane: the lane rule; atMs: the copy's time). */
const AUDIO_FIELDS: { [K in Exclude<keyof AudioT, 'id' | 'atMs' | 'lane'>]-?: (v: AudioT[K], x: AudioT) => Args } = {
  assetId: (v) => ({ assetId: v }), role: (v) => ({ role: v }), durationMs: (v) => opt('durationMs', v), trimBeforeMs: (v) => ({ trimBeforeMs: v }),
  volume: (v) => ({ volume: v }), loop: (v) => ({ loop: v }), fadeInMs: (v) => ({ fadeInMs: v }), fadeOutMs: (v) => ({ fadeOutMs: v }),
  ducking: (v) => (v ? { ducking: { presetId: v.presetId, params: structuredClone(v.params ?? {}) } } : {}),
  gain: (v) => opt('gain', v),                                  // ADR-039
};
const clipCopy = (c: ClipT, atIndex?: number): OperationT => ({ op: c.assetId !== undefined ? 'op:clip.insert' : 'op:scene.add', target: { kind: 'sequence' },
  args: { ...argsOf(c, CLIP_FIELDS), ...(atIndex === undefined ? {} : { atIndex }) } });
/** null for a bed (op:audio.addLayer takes voice / sfx only; a project has one bed). */
const audioCopy = (a: AudioT, atMs: number): OperationT | null => (a.role === 'bed' ? null : { op: 'op:audio.addLayer', args: { ...argsOf(a, AUDIO_FIELDS), atMs } });
/** Heard length of an audio layer (its own length, else the asset's rest is unknown here: 0). */
const audioLen = (a: AudioT): number => a.durationMs ?? 0;
function argsOf<T extends object>(x: T, fields: { [k: string]: (v: never, x: T) => Args }): Args {
  const out: Args = {};
  for (const k of Object.keys(fields)) Object.assign(out, (fields[k] as unknown as (v: unknown, x: T) => Args)((x as Record<PropertyKey, unknown>)[k], x));
  return out;
}
const textCopy = (x: TextT, atMs: number): OperationT => ({ op: 'op:text.add', args: { ...argsOf(x, TEXT_FIELDS), atMs, durationMs: x.timing.durationMs } });
const overlayCopy = (o: CompositionModelT['tracks']['overlay'][number], atMs: number): OperationT => o.kind === 'image'
  ? { op: 'op:overlay.addImage', args: { ...argsOf(o, IMAGE_FIELDS), atMs, durationMs: o.timing.durationMs } }
  : o.kind === 'video' ? { op: 'op:overlay.addVideo', args: { ...argsOf(o, VIDEO_FIELDS), atMs, durationMs: o.timing.durationMs } }
  : { op: 'op:shape.add', args: { ...argsOf(o, SHAPE_FIELDS), atMs, durationMs: o.timing.durationMs } };
/**
 * The ops that duplicate `items` right after themselves (CapCut): a text / image / shape copy starts where the original ends (the
 * lane rule puts it on a free lane); a clip copy is inserted right after the clip with the same media, trim and length; a scene
 * clip copy (op:scene.add) brings copies of its own texts / images / shapes at the same offsets. Clips are processed from the
 * last to the first so every insert index and time is computed on the model it is applied to. Texts / images / shapes keep every
 * field (TEXT_FIELDS / IMAGE_FIELDS / SHAPE_FIELDS); clips keep every field too (CLIP_FIELDS, round 2), and a voice / sfx layer
 * copy (AUDIO_FIELDS) starts where the original ends, on a free audio lane. Audio beds are not duplicated.
 */
export function duplicationSteps(model: CompositionModelT, items: readonly ItemRef[]): ItemStep[] {
  const list = unique(model, items).filter((r) => DUPLICABLE_KINDS.has(r.kind));
  const v = model.tracks.video;
  const timing = deriveTiming(model);
  const clips = list.filter((r) => r.kind === 'clip').map((r) => ({ r, i: v.findIndex((c) => c.id === r.id) })).sort((a, b) => b.i - a.i);
  const covered = new Set(clips.flatMap(({ r }) => sceneItemsOf(model, r.id!).map((x) => `${x.kind}:${x.id}`)));
  const steps: ItemStep[] = [];
  // Texts / images / shapes first (their times are still the original ones), then the clips from the last to the first.
  for (const r of list.filter((x) => x.kind !== 'clip')) {
    if (covered.has(`${r.kind}:${r.id}`)) continue;                  // copied with its scene below
    if (r.kind === 'audio') {
      const a = model.tracks.audio.find((y) => y.id === r.id);
      const op = a ? audioCopy(a, a.atMs + audioLen(a)) : null;
      if (op && audioLen(a!) > 0) steps.push({ target: { kind: 'audio', id: r.id! }, op });
      continue;
    }
    const x = r.kind === 'text' ? model.tracks.text.find((y) => y.id === r.id) : model.tracks.overlay.find((y) => y.id === r.id && y.kind === r.kind);
    if (!x) continue;
    steps.push({ target: { kind: r.kind, id: r.id! }, op: 'kind' in x ? overlayCopy(x, x.timing.atMs + x.timing.durationMs) : textCopy(x, x.timing.atMs + x.timing.durationMs) });
  }
  for (const { i } of clips) {
    const c = v[i]!;
    const at = i + 1;
    steps.push({ target: { kind: 'clip', id: c.id }, op: clipCopy(c, at) });
    if (c.assetId !== undefined) continue;
    // The copy starts where the next clip started (the transition on cut i stays between the original and the copy).
    const copyStart = i < v.length - 1 ? timing.cutStartMs[i]! : timing.clipStartMs[i]! + c.durationMs;
    const from = timing.elementWindows[c.id]!.fromMs;
    for (const ref of sceneItemsOf(model, c.id)) {
      const x = ref.kind === 'text' ? model.tracks.text.find((y) => y.id === ref.id) : model.tracks.overlay.find((y) => y.id === ref.id);
      if (!x) continue;
      const atMs = copyStart + (x.timing.atMs - from);
      steps.push({ target: ref, op: 'kind' in x ? overlayCopy(x, atMs) : textCopy(x, atMs) });
    }
  }
  return steps;
}
/** The step of `steps` for one resolved target (Compile looks its op up by target). */
export const stepFor = (steps: readonly ItemStep[], target: ElementRefT | undefined): ItemStep | undefined => (target ? steps.find((s) => sameRef(s.target, target)) : undefined);

// ───────────────────────────── Copy / Cut / Paste (FR-255, FR-256) ─────────────────────────────
/**
 * One item on the Editor's in-app clipboard: a snapshot taken at Copy time, so Paste still works after Cut or after the original
 * changed. `op` is the add operation that rebuilds the item (the same copies Duplicate uses) with its time made relative:
 * `offsetMs` is the item's start minus the start of the earliest copied item. Clips (`clip` = media clip, `scene` = scene clip)
 * are inserted into the video Track at Paste time; everything else is placed at the paste time + offset (the lane rule picks a
 * free lane). Audio voice / sfx layers paste as op:audio.addLayer with every field (round 2: trim, length, loop, ducking; beds are skipped);
 * captions, transitions, effects and the background are not copied.
 */
export type ClipboardKind = 'clip' | 'scene' | 'text' | 'image' | 'shape' | 'video' | 'audio';
/**
 * `clip` (C8, review 2026-10-29): a text / image / shape that belongs to a copied scene clip (scene anchoring) names that clip by
 * its ordinal among the clip entries and keeps its offset from that clip's start, so non-adjacent scenes pasted back to back keep
 * their titles on them. Absent = placed by `offsetMs` from the first clip (or from the paste time).
 */
export interface ClipboardEntry { kind: ClipboardKind; offsetMs: number; durationMs: number; op: OperationT; clip?: { index: number; offsetMs: number } }
/** The add operations a clipboard entry may carry (the Local Service refuses anything else; applyOperations validates the args). */
export const PASTE_OPS: Readonly<Record<ClipboardKind, string>> = Object.freeze({ clip: 'op:clip.insert', scene: 'op:scene.add', text: 'op:text.add', image: 'op:overlay.addImage', shape: 'op:shape.add', video: 'op:overlay.addVideo', audio: 'op:audio.addLayer' });
export const CLIPBOARD_MAX_ENTRIES = 50;
/** Kinds Copy / Cut can put on the clipboard. */
export const COPYABLE_KINDS: ReadonlySet<ItemKind> = new Set(['clip', 'text', 'image', 'shape', 'video', 'audio']);

/**
 * Copy: snapshots of the listed items (those that still exist and can be rebuilt), a selected scene clip with its own texts /
 * images / shapes (like Duplicate), ordered by start time. `skipped` counts listed items that cannot be copied (captions,
 * transitions, effects, the background, audio beds).
 */
export function copySnapshot(model: CompositionModelT, items: readonly ItemRef[]): { entries: ClipboardEntry[]; skipped: number } {
  const all = unique(model, items);
  const list = all.filter((r) => COPYABLE_KINDS.has(r.kind));
  let skipped = all.length - list.length;
  const timing = deriveTiming(model);
  for (const r of list.filter((x) => x.kind === 'clip')) for (const x of sceneItemsOf(model, r.id!)) if (!list.some((y) => sameRef(y, x))) list.push(x as ItemRef);
  const raw: Array<Omit<ClipboardEntry, 'offsetMs' | 'clip'> & { fromMs: number; order: number; anchor?: string }> = [];
  const copiedClips = new Set(list.filter((r) => r.kind === 'clip').map((r) => r.id!));
  const anchorOf = new Map(sceneAnchors(model).filter((a) => copiedClips.has(a.clipId)).map((a) => [`${'kind' in a.item ? a.item.kind : 'text'}:${a.item.id}`, a.clipId]));
  for (const r of list) {
    if (r.kind === 'clip') {
      const i = model.tracks.video.findIndex((c) => c.id === r.id); const c = model.tracks.video[i]!;
      const w = timing.elementWindows[c.id]!;
      raw.push({ kind: c.assetId !== undefined ? 'clip' : 'scene', anchor: c.id, fromMs: w.fromMs, order: i, durationMs: c.durationMs, op: clipCopy(c) });
    } else if (r.kind === 'audio') {
      const a = model.tracks.audio.find((x) => x.id === r.id)!;
      const op = audioCopy(a, 0);
      if (!op) { skipped++; continue; }
      raw.push({ kind: 'audio', fromMs: a.atMs, order: 1e6, durationMs: a.durationMs ?? 0, op });
    } else {
      const x = r.kind === 'text' ? model.tracks.text.find((y) => y.id === r.id) : model.tracks.overlay.find((y) => y.id === r.id && y.kind === r.kind);
      if (!x) continue;
      const anchor = anchorOf.get(`${r.kind}:${r.id}`);
      raw.push({ kind: r.kind as 'text' | 'image' | 'shape' | 'video', fromMs: x.timing.atMs, order: 1e6, durationMs: x.timing.durationMs, op: 'kind' in x ? overlayCopy(x, 0) : textCopy(x, 0), ...(anchor ? { anchor } : {}) });
    }
  }
  raw.sort((p, q) => p.fromMs - q.fromMs || p.order - q.order);
  const t0 = raw.length ? raw[0]!.fromMs : 0;
  const kept = raw.slice(0, CLIPBOARD_MAX_ENTRIES);
  const clipEntries = kept.filter((e) => e.kind === 'clip' || e.kind === 'scene');
  const clipStart = new Map(clipEntries.map((e, k) => [e.anchor!, { index: k, fromMs: e.fromMs }]));
  return { entries: kept.map(({ fromMs, order: _o, anchor, ...e }) => {
    const own = e.kind !== 'clip' && e.kind !== 'scene' && anchor ? clipStart.get(anchor) : undefined;
    return { ...e, offsetMs: Math.max(0, Math.round(fromMs - t0)), ...(own ? { clip: { index: own.index, offsetMs: Math.max(0, Math.round(fromMs - own.fromMs)) } } : {}) };
  }), skipped };
}

/**
 * Where pasted clips go: the cut at or after `atMs` (inside a clip → after it), and the time the first pasted clip starts. A clip
 * inserted at index k starts where clip k started (the transition on the cut before k stays in front of it, C8 review 2026-10-29),
 * or at the end of the video when k is past the last clip.
 */
export function pasteSlot(model: CompositionModelT, atMs: number): { index: number; startMs: number } {
  const v = model.tracks.video; const timing = deriveTiming(model); const w = timing.elementWindows;
  const startOf = (k: number) => (k < v.length ? w[v[k]!.id]!.fromMs : v.length ? timing.durationMs : 0);
  for (let i = 0; i < v.length; i++) {
    const cw = w[v[i]!.id]!;
    if (atMs <= cw.fromMs) return { index: i, startMs: cw.fromMs };
    if (atMs < cw.toMs) return { index: i + 1, startMs: startOf(i + 1) };
  }
  return { index: v.length, startMs: startOf(v.length) };
}

/**
 * Paste: the ops that rebuild the clipboard `entries` at `atMs`, in order (clips first, then texts / images / shapes / audio), one
 * step per entry with a synthetic target `{kind: 'project', index: n}` (the originals may be gone after Cut). With clips on the
 * clipboard, they are inserted one after the other at pasteSlot() and every other item keeps its offset from the first clip, so a
 * scene keeps its title; without clips, items start at `atMs` + offset. Entries whose op is not the add op of their kind are dropped.
 */
export function pasteSteps(model: CompositionModelT, entries: readonly ClipboardEntry[], atMs: number): ItemStep[] {
  const ok = entries.slice(0, CLIPBOARD_MAX_ENTRIES).filter((e) => e && PASTE_OPS[e.kind] === e.op?.op && e.op.args && typeof e.op.args === 'object');
  const clips = ok.filter((e) => e.kind === 'clip' || e.kind === 'scene');
  const slot = pasteSlot(model, Math.max(0, Math.round(atMs)));
  const base = clips.length ? slot.startMs - clips[0]!.offsetMs : Math.max(0, Math.round(atMs));
  const steps: ItemStep[] = []; let n = 0;
  // Pasted clips go back to back (no transition between them): clip k starts at the slot + the lengths of the clips before it.
  const starts: number[] = []; let at = slot.startMs;
  for (const e of clips) { starts.push(at); at += Math.max(0, Math.round(Number(e.op.args['durationMs'] ?? e.durationMs) || 0)); }
  clips.forEach((e, k) => {
    const args: Record<string, unknown> = { ...e.op.args, atIndex: slot.index + k };
    steps.push({ target: { kind: 'project', index: n++ }, op: { op: e.op.op, target: { kind: 'sequence' }, args } });
  });
  for (const e of ok) {
    if (e.kind === 'clip' || e.kind === 'scene') continue;
    const { target: _t, intentId: _i, ...rest } = e.op;
    const own = e.clip && Number.isInteger(e.clip.index) && starts[e.clip.index] !== undefined ? starts[e.clip.index]! + Math.max(0, e.clip.offsetMs) : undefined;
    steps.push({ target: { kind: 'project', index: n++ }, op: { ...rest, args: { ...e.op.args, atMs: Math.max(0, Math.round(own ?? base + Math.max(0, e.offsetMs))) } } });
  }
  return steps;
}
