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
export type ItemKind = 'clip' | 'text' | 'image' | 'shape' | 'audio' | 'cut' | 'effect' | 'background' | 'caption';
export const ITEM_KINDS: readonly ItemKind[] = ['clip', 'text', 'image', 'shape', 'audio', 'cut', 'effect', 'background', 'caption'];
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
    case 'image': case 'shape': return model.tracks.overlay.some((o) => o.kind === r.kind && o.id === r.id);
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
const REMOVE_ORDER: Record<ItemKind, number> = { cut: 0, effect: 1, background: 2, caption: 3, text: 4, image: 4, shape: 4, audio: 5, clip: 6 };
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
      case 'image': steps.push({ target: { kind: 'image', id: r.id! }, op: { op: 'op:overlay.remove', target: { kind: 'image', id: r.id! }, args: {} } }); break;
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
/** Kinds Duplicate supports (existing add ops can rebuild them); audio, captions, transitions, effects and the background cannot be copied faithfully. */
export const DUPLICABLE_KINDS: ReadonlySet<ItemKind> = new Set(['clip', 'text', 'image', 'shape']);
const textCopy = (x: CompositionModelT['tracks']['text'][number], atMs: number): OperationT => {
  const style = Object.fromEntries(Object.entries(x.style).filter(([, v]) => v !== undefined));
  return { op: 'op:text.add', args: { text: x.text, variant: x.variantId, atMs, durationMs: x.timing.durationMs, position: { x: x.position.x, y: x.position.y }, ...(Object.keys(style).length ? { styleOverrides: style } : {}) } };
};
const overlayCopy = (o: CompositionModelT['tracks']['overlay'][number], atMs: number): OperationT => o.kind === 'image'
  ? { op: 'op:overlay.addImage', args: { assetId: o.assetId, atMs, durationMs: o.timing.durationMs, position: { x: o.position.x, y: o.position.y }, size: Math.max(10, Math.min(4000, Math.round(o.size.w))), objectFit: o.objectFit, opacity: o.opacity } }
  : { op: 'op:shape.add', args: { presetId: o.presetId, atMs, durationMs: o.timing.durationMs, position: { x: o.position.x, y: o.position.y }, size: Math.max(10, Math.min(4000, Math.round(o.size.w))), fill: o.fill,
    ...(o.stroke ? { stroke: o.stroke } : {}), ...(o.strokeWidth !== undefined ? { strokeWidth: o.strokeWidth } : {}), ...(o.motion ? { motionId: o.motion.presetId } : {}), params: o.params } };
/**
 * The ops that duplicate `items` right after themselves (CapCut): a text / image / shape copy starts where the original ends (the
 * lane rule puts it on a free lane); a clip copy is inserted right after the clip with the same media, trim and length; a scene
 * clip copy (op:scene.add) brings copies of its own texts / images / shapes at the same offsets. Clips are processed from the
 * last to the first so every insert index and time is computed on the model it is applied to. Not copied (no add op takes them):
 * clip volume / fades / motion / effects / framing, item zoom / rotation, text effects.
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
    const x = r.kind === 'text' ? model.tracks.text.find((y) => y.id === r.id) : model.tracks.overlay.find((y) => y.id === r.id && y.kind === r.kind);
    if (!x) continue;
    steps.push({ target: { kind: r.kind, id: r.id! }, op: 'kind' in x ? overlayCopy(x, x.timing.atMs + x.timing.durationMs) : textCopy(x, x.timing.atMs + x.timing.durationMs) });
  }
  for (const { i } of clips) {
    const c = v[i]!;
    const at = i + 1;
    if (c.assetId !== undefined) { steps.push({ target: { kind: 'clip', id: c.id }, op: { op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: c.assetId, atIndex: at, trimBeforeMs: c.trimBeforeMs, durationMs: c.durationMs } } }); continue; }
    steps.push({ target: { kind: 'clip', id: c.id }, op: { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: Math.max(500, Math.min(120_000, c.durationMs)), ...(c.scene ? { background: c.scene.presetId, backgroundParams: c.scene.params } : {}), atIndex: at } } });
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
 * free lane). Audio voice / sfx layers paste as op:audio.addLayer (their trim and length are not carried; beds are skipped);
 * captions, transitions, effects and the background are not copied.
 */
export type ClipboardKind = 'clip' | 'scene' | 'text' | 'image' | 'shape' | 'audio';
export interface ClipboardEntry { kind: ClipboardKind; offsetMs: number; durationMs: number; op: OperationT }
/** The add operations a clipboard entry may carry (the Local Service refuses anything else; applyOperations validates the args). */
export const PASTE_OPS: Readonly<Record<ClipboardKind, string>> = Object.freeze({ clip: 'op:clip.insert', scene: 'op:scene.add', text: 'op:text.add', image: 'op:overlay.addImage', shape: 'op:shape.add', audio: 'op:audio.addLayer' });
export const CLIPBOARD_MAX_ENTRIES = 50;
/** Kinds Copy / Cut can put on the clipboard. */
export const COPYABLE_KINDS: ReadonlySet<ItemKind> = new Set(['clip', 'text', 'image', 'shape', 'audio']);

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
  const raw: Array<Omit<ClipboardEntry, 'offsetMs'> & { fromMs: number; order: number }> = [];
  for (const r of list) {
    if (r.kind === 'clip') {
      const i = model.tracks.video.findIndex((c) => c.id === r.id); const c = model.tracks.video[i]!;
      const w = timing.elementWindows[c.id]!;
      if (c.assetId !== undefined) raw.push({ kind: 'clip', fromMs: w.fromMs, order: i, durationMs: c.durationMs, op: { op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: c.assetId, trimBeforeMs: c.trimBeforeMs, durationMs: c.durationMs } } });
      else raw.push({ kind: 'scene', fromMs: w.fromMs, order: i, durationMs: c.durationMs, op: { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: Math.max(500, Math.min(120_000, c.durationMs)), ...(c.scene ? { background: c.scene.presetId, backgroundParams: c.scene.params } : {}) } } });
    } else if (r.kind === 'audio') {
      const a = model.tracks.audio.find((x) => x.id === r.id)!;
      if (a.role === 'bed') { skipped++; continue; }
      raw.push({ kind: 'audio', fromMs: a.atMs, order: 1e6, durationMs: a.durationMs ?? 0, op: { op: 'op:audio.addLayer', args: { assetId: a.assetId, atMs: 0, volume: a.volume, role: a.role,
        ...(a.fadeInMs !== undefined ? { fadeInMs: a.fadeInMs } : {}), ...(a.fadeOutMs !== undefined ? { fadeOutMs: a.fadeOutMs } : {}) } } });
    } else {
      const x = r.kind === 'text' ? model.tracks.text.find((y) => y.id === r.id) : model.tracks.overlay.find((y) => y.id === r.id && y.kind === r.kind);
      if (!x) continue;
      raw.push({ kind: r.kind as 'text' | 'image' | 'shape', fromMs: x.timing.atMs, order: 1e6, durationMs: x.timing.durationMs, op: 'kind' in x ? overlayCopy(x, 0) : textCopy(x, 0) });
    }
  }
  raw.sort((p, q) => p.fromMs - q.fromMs || p.order - q.order);
  const t0 = raw.length ? raw[0]!.fromMs : 0;
  return { entries: raw.slice(0, CLIPBOARD_MAX_ENTRIES).map(({ fromMs, order: _o, ...e }) => ({ ...e, offsetMs: Math.max(0, Math.round(fromMs - t0)) })), skipped };
}

/** Where pasted clips go: the cut at or after `atMs` (inside a clip → after it), and the time the first pasted clip starts. */
export function pasteSlot(model: CompositionModelT, atMs: number): { index: number; startMs: number } {
  const v = model.tracks.video; const w = deriveTiming(model).elementWindows;
  for (let i = 0; i < v.length; i++) {
    const cw = w[v[i]!.id]!;
    if (atMs <= cw.fromMs) return { index: i, startMs: cw.fromMs };
    if (atMs < cw.toMs) return { index: i + 1, startMs: cw.toMs };
  }
  return { index: v.length, startMs: v.length ? deriveTiming(model).durationMs : 0 };
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
  clips.forEach((e, k) => {
    const args: Record<string, unknown> = { ...e.op.args, atIndex: slot.index + k };
    steps.push({ target: { kind: 'project', index: n++ }, op: { op: e.op.op, target: { kind: 'sequence' }, args } });
  });
  for (const e of ok) {
    if (e.kind === 'clip' || e.kind === 'scene') continue;
    const { target: _t, intentId: _i, ...rest } = e.op;
    steps.push({ target: { kind: 'project', index: n++ }, op: { ...rest, args: { ...e.op.args, atMs: Math.max(0, Math.round(base + Math.max(0, e.offsetMs))) } } });
  }
  return steps;
}
