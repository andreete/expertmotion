// applyOperations: the only function that changes a Composition Model (BLUEPRINT.md §3.2). Pure: clones its input,
// stops at the first blocking Issue, never touches files. Issue paths are `ops[i]…`; callers prefix the plan step.
import { getPreset, validateParams, type Category } from '@expertmotion/catalogue';
import { fail, issue, ok, type Issue, type Result } from '@expertmotion/shared';
import { OPERATIONS, isOpName, type OperationT } from './operations.js';
import { CompositionModel, IDENTITY_TRANSFORM, type AssetFacts, type AudioLayerT, type CaptionPageT, type ClipT, type ClipTransformT, type CompositionModelT, type MotionT, type OverlayElementT, type PositionT, type TextLayerT, type Tier } from './schema.js';
import { deriveTiming } from './timing.js';
import { frameInUnits } from './units.js';
import { detectRatio } from './ratio.js';
import { diffModels, type ElementDiff } from './diff.js';
import { freeAudioLane, frontLayerFor, moveVisual, normalizeLanes, placeAudio, placeVisual, visualItems, visualSpan, type VisualItem } from './layers.js';
import { CLIP_TIMING_OPS, followSceneAnchors, sceneAnchors } from './items.js';
import { AUDIO_TIMING_OPS, followVoiceAnchors, voiceAnchors } from './voice-anchors.js';
import { boxesOverlap, textGeometry } from './text-box.js';
import { pageHas, pagesNear, replaceInPage, retextPage } from './caption-text.js';

export interface GeneratedResult { kind: 'voice' | 'music' | 'thumbnail' | 'captions'; assetId?: string; pages?: CaptionPageT[] }
export interface ApplyContext { assets: readonly AssetFacts[]; tier: Tier; newId: () => string; jobs?: Readonly<Record<string, GeneratedResult>> }

const IMAGE_DEFAULT_MS = 5000;                                   // ASSET_INGESTION.md: images default to 5 s
const MAX_EFFECTS = (tier: Tier) => (tier === 'T0' ? 2 : 3);     // CM-006

class Stop extends Error { constructor(readonly issue: Issue) { super(issue.message); } }
const stop = (code: string, message: string, path: string): never => { throw new Stop(issue(code, message, 'block', path)); };

export function applyOperations(model: CompositionModelT, ops: readonly OperationT[], ctx: ApplyContext): Result<{ model: CompositionModelT; diff: ElementDiff[] }> {
  const m: CompositionModelT = structuredClone(model);
  const warnings: Issue[] = [];
  try {
    ops.forEach((op, i) => {
      const firstBefore = m.tracks.video[0]?.assetId;
      const anchors = CLIP_TIMING_OPS.has(op.op) ? sceneAnchors(m) : [];          // ADR-031: scene texts move with their scene clip
      const voiceAnch = AUDIO_TIMING_OPS.has(op.op) && op.target?.kind === 'audio' ? voiceAnchors(m, ctx.assets) : [];   // FR-250: captions follow their voice clip
      applyOne(m, op, ctx, `ops[${i}]`, warnings);
      followSceneAnchors(m, anchors);
      followVoiceAnchors(m, voiceAnch, ctx.assets);
      normalizeLanes(m);                                                             // ADR-027: lanes stay dense after every op
      if (m.tracks.video[0]?.assetId !== firstBefore) followFirstClip(m, ctx);      // FR-088: Auto re-checks when the first Clip changes
    });
  } catch (e) {
    if (e instanceof Stop) return fail([e.issue, ...warnings.filter((w) => w.severity === 'block')]);
    throw e;
  }
  const parsed = CompositionModel.safeParse(m);
  if (!parsed.success) return fail(parsed.error.issues.map((i) => issue('EM-2001', `Result is not a valid Composition Model: ${i.message}`, 'block', i.path.join('.'))));
  return ok({ model: parsed.data, diff: diffModels(model, parsed.data) }, warnings);
}

// ───────────────────────────── helpers ─────────────────────────────
/** FR-088: while Auto is on, the ratio is the nearest supported ratio of the first Clip's probe (unchanged when unknown). */
function followFirstClip(m: CompositionModelT, ctx: ApplyContext): void {
  if (!m.settings.autoRatio) return;
  const first = m.tracks.video[0];
  const as = first ? ctx.assets.find((x) => x.id === first.assetId) : undefined;
  if (!as?.width || !as.height) return;
  m.settings.ratio = detectRatio(as.width, as.height); delete m.settings.customRatio;
}
function preset(id: string, category: Category, params: unknown, ctx: ApplyContext, path: string, warnings: Issue[]): Record<string, unknown> {
  const p = getPreset(id);
  if (!p || p.category !== category) stop('EM-2101', `${id} is not a ${category} preset in the Design Catalogue.`, `${path}.args.presetId`);
  if (p!.flags.includes('licence:paid')) stop('EM-2101', `${id} is not available.`, `${path}.args.presetId`);
  if (p!.flags.includes('webgpu') && ctx.tier !== 'T2') stop('EM-2103', `${id} needs a graphics card with WebGPU (Hardware Tier T2).`, `${path}.args.presetId`);
  if (p!.flags.includes('gpu') && ctx.tier === 'T0') warnings.push(issue('EM-2103', `${id} renders slowly without a GPU.`, 'warn', `${path}.args.presetId`));
  const v = validateParams(id, params ?? {});
  if (!v.ok) { const first = v.issues[0]!; stop(first.code, first.message, `${path}.args.${first.path}`); }
  return (v as { value: Record<string, unknown> }).value;
}
function asset(ctx: ApplyContext, id: string, kinds: AssetFacts['kind'][], path: string): AssetFacts {
  const a = ctx.assets.find((x) => x.id === id);
  if (!a) stop('EM-1301', `Asset ${id} is not in this project.`, `${path}.args.assetId`);
  if (a!.status !== 'ready') stop('EM-1301', `Asset ${id} is not ready yet.`, `${path}.args.assetId`);
  if (!kinds.includes(a!.kind)) stop('EM-2102', `Asset ${id} is a ${a!.kind}; expected ${kinds.join(' or ')}.`, `${path}.args.assetId`);
  return a!;
}
/** ADR-027: a new visual item goes in front of everything it overlaps (or on the asked lane, by the lane rule). */
function addVisual(m: CompositionModelT, item: VisualItem, layer: number | undefined): void {
  item.layer = frontLayerFor(visualItems(m), visualSpan(item), item);
  if ('kind' in item) m.tracks.overlay.push(item); else m.tracks.text.push(item);
  if (layer !== undefined) placeVisual(visualItems(m), item, layer);
}
function addAudio(m: CompositionModelT, layer: AudioLayerT): void {
  m.tracks.audio.push(layer);
  layer.lane = freeAudioLane(m.tracks.audio, layer);
}
/** The text, image or shape a target names (EM-2203 when gone). */
function visualTarget(m: CompositionModelT, op: OperationT, path: string): VisualItem {
  const t = needTarget(op, path);
  const el = t.kind === 'text' ? m.tracks.text.find((x) => x.id === t.id) : m.tracks.overlay.find((o) => o.id === t.id && o.kind === t.kind);
  if (!el) stop('EM-2203', `The ${t.kind} ${t.id ?? '(none)'} no longer exists.`, `${path}.target`);
  return el!;
}
function needTarget(op: OperationT, path: string) {
  if (!op.target) stop('EM-2102', `${op.op} needs a target.`, `${path}.target`);
  return op.target!;
}
const findIndex = <T extends { id: string }>(arr: T[], id: string | undefined, kind: string, path: string): number => {
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) stop('EM-2203', `The ${kind} ${id ?? '(none)'} no longer exists.`, `${path}.target`);
  return i;
};
function checkSource(clip: Pick<ClipT, 'trimBeforeMs' | 'durationMs' | 'playbackRate'>, a: AssetFacts, path: string) {
  if (a.kind !== 'video' || a.durationMs === undefined) return;
  const used = clip.trimBeforeMs + clip.durationMs * clip.playbackRate;              // CM-002 (corrected formula)
  if (used > a.durationMs + 1) stop('EM-2306', `The clip needs ${Math.round(used)} ms of ${a.durationMs} ms source media.`, path);
}
function namedPosition(m: CompositionModelT, name: string): PositionT {
  const f = frameInUnits(m.settings.ratio, m.settings.customRatio); const hw = f.w / 2, hh = f.h / 2;
  const map: Record<string, PositionT> = { center: { x: 0, y: 0 }, 'top-left': { x: -hw / 2, y: -hh / 2 }, 'top-right': { x: hw / 2, y: -hh / 2 }, 'bottom-left': { x: -hw / 2, y: hh / 2 }, 'bottom-right': { x: hw / 2, y: hh / 2 } };
  return map[name] ?? { x: 0, y: 0 };
}
function variantPosition(m: CompositionModelT, variant: string): PositionT {
  const f = frameInUnits(m.settings.ratio, m.settings.customRatio); const hw = f.w / 2, hh = f.h / 2;
  switch (variant) {
    case 'preset:text.title': return { x: 0, y: Math.round(-hh * 0.25) };
    case 'preset:text.subtitle': return { x: 0, y: Math.round(hh * 0.15) };
    case 'preset:text.lower-third': return { x: Math.round(-hw * 0.35), y: Math.round(hh * 0.6) };
    default: return { x: 0, y: 0 };
  }
}
function motionFrom(presetId: string, values: Record<string, unknown>): MotionT | null {
  if (presetId === 'preset:motion.none') return null;
  const { durationMs, delayMs, easingId, exit, ...rest } = values;
  return { presetId, durationMs: Number(durationMs), delayMs: Number(delayMs ?? 0), ...(typeof easingId === 'string' ? { easingId } : {}), exit: exit !== false, params: rest };
}
/** ADR-034: automatic entrance + exit for shapes and images when the op names none (preset:motion.none = static). */
export const DEFAULT_SHAPE_MOTION: Readonly<Record<string, string>> = Object.freeze({ 'preset:shape.line': 'preset:motion.wipe-reveal', 'preset:shape.ring': 'preset:motion.draw-on', 'preset:shape.check': 'preset:motion.draw-on', 'preset:shape.chevron': 'preset:motion.draw-on' });
export const DEFAULT_SHAPE_MOTION_ID = 'preset:motion.pop', DEFAULT_IMAGE_MOTION_ID = 'preset:motion.scale-in';
type MotionArgT = { presetId: string; durationMs?: number; delayMs?: number; easingId?: string; exit?: boolean; params?: Record<string, unknown> };
/** A motion from an op's `motion` object (validated against the motion preset) or the fallback preset id with its defaults. */
function motionOf(arg: MotionArgT | undefined, fallbackId: string | undefined, ctx: ApplyContext, path: string, warnings: Issue[]): MotionT | null {
  if (arg) {
    if (arg.presetId === 'preset:motion.none') return null;
    const { presetId, params, ...top } = arg;
    return motionFrom(presetId, preset(presetId, 'motion', { ...(params ?? {}), ...Object.fromEntries(Object.entries(top).filter(([, v]) => v !== undefined)) }, ctx, `${path}.args.motion`, warnings));
  }
  if (!fallbackId || fallbackId === 'preset:motion.none') return null;
  return motionFrom(fallbackId, preset(fallbackId, 'motion', {}, ctx, path, warnings));
}
/**
 * ADR-034 (QA 2026-10-28 #19 "words stacked in one place"): a text added without a position goes to its variant position unless
 * another text playing at the same time is painted there; then it is stacked below the lowest such text (or above the highest
 * when there is no room below), inside the safe area.
 */
function freeTextPosition(m: CompositionModelT, layer: TextLayerT): PositionT {
  const geo = (t: TextLayerT) => textGeometry(t, m.settings.ratio, m.theme.textDefaults, m.settings.customRatio).box;
  const span = { from: layer.timing.atMs, to: layer.timing.atMs + layer.timing.durationMs };
  const others = m.tracks.text.filter((t) => t !== layer && t.timing.atMs < span.to && span.from < t.timing.atMs + t.timing.durationMs).map(geo);
  const mine = geo(layer);
  if (!others.some((b) => boxesOverlap(b, mine, 24))) return layer.position;
  const f = frameInUnits(m.settings.ratio, m.settings.customRatio), h = mine.y1 - mine.y0, gap = 32;
  const below = Math.max(...others.map((b) => b.y1)) + gap, above = Math.min(...others.map((b) => b.y0)) - gap - h;
  const bottomLimit = f.h - 72, topLimit = 72;
  const top = below + h <= bottomLimit ? below : above >= topLimit ? above : below;
  return { x: layer.position.x, y: Math.round(top + h / 2 - f.h / 2) };
}
/** Cut bookkeeping when a Clip is inserted at index i: cuts ≥ i shift by +1 (the cut before i keeps its transition). */
function shiftCutsForInsert(m: CompositionModelT, i: number) { for (const t of m.transitions) if (t.cutIndex >= i) t.cutIndex += 1; }
/** When Clip i is removed, cuts i-1 and i merge into cut i-1 (keeping the first existing transition); later cuts shift -1. */
function shiftCutsForRemove(m: CompositionModelT, i: number, clipCountBefore: number, warnings: Issue[], path: string) {
  const before = m.transitions.find((t) => t.cutIndex === i - 1), after = m.transitions.find((t) => t.cutIndex === i);
  const merged = i > 0 && i < clipCountBefore - 1 ? (before ?? after) : undefined;
  const dropped = [before, after].filter((t) => t && t !== merged).length;
  m.transitions = m.transitions.filter((t) => t.cutIndex !== i - 1 && t.cutIndex !== i);
  for (const t of m.transitions) if (t.cutIndex > i) t.cutIndex -= 1;
  if (merged) m.transitions.push({ ...merged, cutIndex: i - 1 });
  if (dropped) warnings.push(issue('EM-2203', `${dropped} transition(s) next to the removed clip were removed.`, 'info', path));
  m.transitions.sort((a, b) => a.cutIndex - b.cutIndex);
}

/** ADR-028: a transition next to a split clip is kept at most half the shorter neighbour; it is removed when that is < 100 ms. */
function reclampCut(m: CompositionModelT, cutIndex: number, warnings: Issue[], path: string) {
  const tr = m.transitions.find((x) => x.cutIndex === cutIndex);
  const a = m.tracks.video[cutIndex], b = m.tracks.video[cutIndex + 1];
  if (!tr || !a || !b) return;
  const half = Math.floor(Math.min(a.durationMs, b.durationMs) * 0.5);
  if (tr.durationMs <= half) return;
  if (half < 100) { m.transitions = m.transitions.filter((x) => x !== tr); warnings.push(issue('EM-2305', `The transition on cut ${cutIndex + 1} was removed: the clips next to it are too short now.`, 'warn', path)); return; }
  tr.durationMs = half;
  warnings.push(issue('EM-2305', `Transition on cut ${cutIndex + 1} shortened to ${half} ms (half the shorter clip).`, 'warn', path));
}
/** ADR-028: the part after a split starts mid-way, so an enter motion stays on the first part only (without its exit). */
function splitMotion(motion: MotionT | null): MotionT | null { return motion ? { ...motion, exit: false } : null; }
const round = (v: number, digits: number) => { const f = 10 ** digits; return Math.round(v * f) / f; };
/** Rotation stored in [0, 360) degrees, 0.01° steps. */
export const normaliseRotation = (r: number): number => { const x = round(((r % 360) + 360) % 360, 2); return x >= 360 ? 0 : x; };
const isIdentity = (t: ClipTransformT) => t.x === 0 && t.y === 0 && t.scale === 1 && t.rotation === 0;

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const quote = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}…` : s);
/** ADR-033: op:caption.replaceText / op:caption.editPage. Changes the text (and its tokens) of the addressed page(s) only. */
function captionText(m: CompositionModelT, name: string, a: Record<string, any>, path: string, warnings: Issue[]): void {   // eslint-disable-line @typescript-eslint/no-explicit-any -- validated by the op schema
  const pages = m.tracks.caption.pages;
  if (pages.length === 0) stop('EM-2102', 'This video has no captions yet.', `${path}.args`);
  if (a.atMs !== undefined && a.pageIndex !== undefined) stop('EM-2102', `${name}: give atMs or pageIndex, not both.`, `${path}.args.pageIndex`);
  if (a.pageIndex !== undefined && a.pageIndex >= pages.length) stop('EM-2102', `Caption page ${a.pageIndex} does not exist; pages are 0…${pages.length - 1}.`, `${path}.args.pageIndex`);
  const near = a.atMs !== undefined ? pagesNear(pages, a.atMs) : [];
  if (a.atMs !== undefined && near.length === 0) stop('EM-2102', `No caption page at ${sec(a.atMs)} (or within 1.5 s).`, `${path}.args.atMs`);
  if (name === 'op:caption.editPage') {
    if (a.atMs === undefined && a.pageIndex === undefined) stop('EM-2102', 'op:caption.editPage needs atMs or pageIndex.', `${path}.args`);
    if (a.text.trim() === '') stop('EM-2102', 'op:caption.editPage: text is empty (use op:caption.replaceText with replace "" to drop words).', `${path}.args.text`);
    const i: number = a.pageIndex ?? near[0]!;
    pages[i] = retextPage(pages[i]!, a.text);
    return;
  }
  const opts = { all: a.all === true, caseSensitive: a.caseSensitive === true };
  const where: number[] = a.pageIndex !== undefined ? [a.pageIndex]
    : a.atMs !== undefined ? near.filter((i) => pageHas(pages[i]!, a.find, opts.caseSensitive)).slice(0, 1)
    : pages.map((_, i) => i).filter((i) => pageHas(pages[i]!, a.find, opts.caseSensitive)).slice(0, opts.all ? undefined : 1);
  let count = 0;
  for (const i of where) { const r = replaceInPage(pages[i]!, a.find, a.replace, opts); if (r) { pages[i] = r.page; count += r.count; } }
  if (count === 0) {
    const shown = a.pageIndex !== undefined ? [a.pageIndex as number] : near.length ? near.slice(0, 2) : [];
    const hint = shown.map((i) => `page ${i} (${sec(pages[i]!.startMs)}–${sec(pages[i]!.startMs + pages[i]!.durationMs)}): ${quote(pages[i]!.text)}`).join('; ');
    stop('EM-2102', `${quote(a.find)} is not in the captions${hint ? ` there; ${hint}` : ''}.`, `${path}.args.find`);
  }
  const before = pages.length;
  m.tracks.caption.pages = pages.filter((p) => p.text.trim() !== '');                       // a page left without words is dropped
  if (m.tracks.caption.pages.length < before) warnings.push(issue('EM-2203', `${before - m.tracks.caption.pages.length} caption page(s) had no words left and were removed.`, 'info', path));
}

// ───────────────────────────── the operations ─────────────────────────────
function applyOne(m: CompositionModelT, op: OperationT, ctx: ApplyContext, path: string, warnings: Issue[]): void {
  if (!isOpName(op.op)) stop('EM-2303', `${op.op} is not an Expertmotion operation.`, `${path}.op`);
  const def = OPERATIONS[op.op as keyof typeof OPERATIONS];
  const parsed = def.args.safeParse(op.args);
  if (!parsed.success) { const i = parsed.error.issues[0]!; stop('EM-2102', `${op.op}: ${i.message}`, [`${path}.args`, ...i.path.map(String)].join('.')); }
  const a = parsed.data as Record<string, any>;                // eslint-disable-line @typescript-eslint/no-explicit-any -- validated by the op schema above
  if (def.targets && op.target && !def.targets.includes(op.target.kind)) stop('EM-2102', `${op.op} cannot target a ${op.target.kind}.`, `${path}.target.kind`);
  const v = m.tracks.video;

  switch (op.op) {
    case 'op:clip.insert': {
      const as = asset(ctx, a.assetId, ['video', 'image'], path);
      const trimBeforeMs = as.kind === 'image' ? 0 : (a.trimBeforeMs ?? 0);
      const durationMs = a.durationMs ?? (as.kind === 'image' ? IMAGE_DEFAULT_MS : Math.max(100, (as.durationMs ?? IMAGE_DEFAULT_MS) - trimBeforeMs));
      const clip: ClipT = { id: ctx.newId(), assetId: as.id, trimBeforeMs, durationMs, playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, objectFit: 'cover', motion: null, effects: [] };
      checkSource(clip, as, `${path}.args`);
      const at = a.atIndex ?? v.length;
      if (at > v.length) stop('EM-2102', `atIndex ${at} is beyond the end (${v.length}).`, `${path}.args.atIndex`);
      shiftCutsForInsert(m, at);
      v.splice(at, 0, clip);
      return;
    }
    case 'op:clip.remove': {
      const i = findIndex(v, needTarget(op, path).id, 'clip', path);
      shiftCutsForRemove(m, i, v.length, warnings, path);
      v.splice(i, 1);
      return;
    }
    case 'op:clip.move': {
      const i = findIndex(v, needTarget(op, path).id, 'clip', path);
      if (a.toIndex >= v.length) stop('EM-2102', `toIndex ${a.toIndex} is beyond the last clip.`, `${path}.args.toIndex`);
      if (a.toIndex === i) return;
      const [clip] = v.splice(i, 1);
      v.splice(a.toIndex, 0, clip!);                         // FR-068: the cut count is unchanged, so transitions stay on their cut positions (re-attached to the new neighbours)
      return;
    }
    case 'op:clip.setTrim': case 'op:clip.setPlaybackRate': case 'op:clip.setVolume': case 'op:clip.setFit': {
      const c = v[findIndex(v, needTarget(op, path).id, 'clip', path)]!;
      // ADR-030: a scene clip has no source media: a trim only sets its length, a rate changes nothing that needs checking.
      if (op.op === 'op:clip.setTrim') { c.trimBeforeMs = c.scene ? 0 : a.trimBeforeMs; c.durationMs = a.durationMs; if (c.assetId) checkSource(c, asset(ctx, c.assetId, ['video', 'image'], path), `${path}.args`); }
      if (op.op === 'op:clip.setPlaybackRate') { c.playbackRate = a.rate; if (c.assetId) checkSource(c, asset(ctx, c.assetId, ['video', 'image'], path), `${path}.args.rate`); }
      if (op.op === 'op:clip.setVolume') { c.volume = a.volume; if (a.fadeInMs !== undefined) c.fadeInMs = a.fadeInMs; if (a.fadeOutMs !== undefined) c.fadeOutMs = a.fadeOutMs; }
      if (op.op === 'op:clip.setFit') { c.objectFit = a.objectFit; if (a.crop) c.crop = a.crop; else delete c.crop; }
      return;
    }
    case 'op:transition.set': case 'op:transition.clear': {
      const t = needTarget(op, path);
      const idx = t.index;
      if (idx === undefined || idx < 0 || idx >= v.length - 1) stop('EM-2102', `Cut ${idx === undefined ? '(none)' : idx + 1} does not exist; this sequence has ${Math.max(0, v.length - 1)} cut(s).`, `${path}.target.index`);
      m.transitions = m.transitions.filter((x) => x.cutIndex !== idx);
      if (op.op === 'op:transition.clear' || a.presetId === 'preset:transition.none') return;
      const values = preset(a.presetId, 'transition', { ...(a.params ?? {}), durationMs: a.durationMs, timing: a.timing }, ctx, path, warnings);
      const { durationMs, timing, ...rest } = values;
      const shorter = Math.min(v[idx!]!.durationMs, v[idx! + 1]!.durationMs);
      let d = Number(durationMs);
      if (d > shorter * 0.5) {
        d = Math.floor(shorter * 0.5);
        if (d < 100) stop('EM-2305', `Cut ${idx! + 1} is between clips too short for a transition.`, `${path}.args.durationMs`);
        warnings.push(issue('EM-2305', `Transition on cut ${idx! + 1} shortened to ${d} ms (half the shorter clip).`, 'warn', `${path}.args.durationMs`));
      }
      m.transitions.push({ cutIndex: idx!, presetId: a.presetId, durationMs: d, timing: timing as 'linear' | 'spring', params: rest });
      m.transitions.sort((x, y) => x.cutIndex - y.cutIndex);
      return;
    }
    case 'op:text.add': {
      const vp = getPreset(a.variant);
      if (!vp || vp.category !== 'text') stop('EM-2101', `${a.variant} is not a text variant.`, `${path}.args.variant`);
      const position: PositionT = a.position === undefined ? variantPosition(m, a.variant) : typeof a.position === 'string' ? namedPosition(m, a.position) : a.position;
      const motionId = vp!.data?.['motionId'];
      const motion = motionOf(a.motion, typeof motionId === 'string' ? motionId : undefined, ctx, path, warnings);
      const effect = a.effect ? { presetId: a.effect.presetId, params: preset(a.effect.presetId, 'texteffect', a.effect.params, ctx, `${path}.args.effect`, warnings) } : null;
      const layer: TextLayerT = { id: ctx.newId(), variantId: a.variant, text: a.text, timing: { atMs: a.atMs, durationMs: a.durationMs }, layer: 0, position,
        ...(a.maxWidth !== undefined ? { maxWidth: a.maxWidth } : {}), ...(a.valign === 'top' ? { valign: 'top' as const } : {}), style: { ...(a.styleOverrides ?? {}) }, effect, motion };
      if (a.position === undefined) layer.position = freeTextPosition(m, layer);
      addVisual(m, layer, a.layer);
      return;
    }
    case 'op:scene.add': {
      // ADR-030: a scene of a video without media = a scene clip on the video Track (its background preset for durationMs) plus
      // its title / body text over it, and optionally the transition from the previous scene. Cuts, transitions, Undo, Timeline
      // and render treat it like any clip. Appended at the end unless atIndex is given.
      const bg = a.background ?? 'preset:background.gradient';
      const params = preset(bg, 'background', a.backgroundParams, ctx, `${path}`, warnings);
      const at: number = a.atIndex ?? v.length;
      if (at > v.length) stop('EM-2102', `atIndex ${at} is beyond the end (${v.length}).`, `${path}.args.atIndex`);
      const clip: ClipT = { id: ctx.newId(), scene: { presetId: bg, params }, trimBeforeMs: 0, durationMs: a.durationMs, playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, objectFit: 'cover', motion: null, effects: [] };
      shiftCutsForInsert(m, at);
      v.splice(at, 0, clip);
      let tIn = 0;
      if (a.transition !== undefined && at > 0 && a.transition !== 'preset:transition.none') {
        applyOne(m, { op: 'op:transition.set', target: { kind: 'cut', index: at - 1 }, args: { presetId: a.transition, durationMs: a.transitionMs ?? 500, timing: 'linear' } }, ctx, path, warnings);
        tIn = m.transitions.find((x) => x.cutIndex === at - 1)?.durationMs ?? 0;
      }
      const start = deriveTiming(m).clipStartMs[at]! + tIn;
      const len = Math.max(100, a.durationMs - tIn);
      const parts: Array<[string, string, 'titleVariant' | 'textVariant']> = [];
      if (a.title !== undefined) parts.push([a.title, a.titleVariant ?? 'preset:text.title', 'titleVariant']);
      if (a.text !== undefined) parts.push([a.text, a.textVariant ?? (a.title === undefined ? 'preset:text.title' : 'preset:text.subtitle'), 'textVariant']);
      for (const [text, variant, field] of parts) {
        const vp = getPreset(variant);
        if (!vp || vp.category !== 'text') stop('EM-2101', `${variant} is not a text variant.`, `${path}.args.${field}`);
        const motionId = a.motionId ?? vp!.data?.['motionId'];
        const motion = typeof motionId === 'string' ? motionFrom(motionId, preset(motionId, 'motion', {}, ctx, `${path}.args.motionId`, warnings)) : null;
        addVisual(m, { id: ctx.newId(), variantId: variant, text, timing: { atMs: start, durationMs: len }, layer: 0, position: variantPosition(m, variant), style: {}, effect: null, motion }, undefined);
      }
      return;
    }
    case 'op:scene.setBackground': {
      const c = v[findIndex(v, needTarget(op, path).id, 'clip', path)]!;
      if (!c.scene) stop('EM-2102', 'This clip shows media; only scene clips have a scene background (use op:background.set for the project background).', `${path}.target`);
      c.scene = { presetId: a.presetId, params: preset(a.presetId, 'background', a.params, ctx, path, warnings) };
      return;
    }
    case 'op:text.setContent': case 'op:text.setStyle': case 'op:text.setEffect': case 'op:text.setTiming': case 'op:text.remove': {
      const i = findIndex(m.tracks.text, needTarget(op, path).id, 'text', path);
      const t = m.tracks.text[i]!;
      if (op.op === 'op:text.setContent') t.text = a.text;
      if (op.op === 'op:text.setStyle') {
        const { variant, ...style } = a as { variant?: string } & Record<string, unknown>;
        if (variant !== undefined) {
          // FR-025: re-apply a variant: its position and its size/weight/align replace the layer's overrides.
          const vp = getPreset(variant);
          if (!vp || vp.category !== 'text') stop('EM-2101', `${variant} is not a text variant.`, `${path}.args.variant`);
          t.variantId = variant; t.position = variantPosition(m, variant);
          const { fontSize: _s, weight: _w, align: _a, ...keep } = t.style; void _s; void _w; void _a;
          t.style = keep;
        }
        t.style = { ...t.style, ...style };
      }
      if (op.op === 'op:text.setEffect') t.effect = { presetId: a.presetId, params: preset(a.presetId, 'texteffect', a.params, ctx, path, warnings) };
      if (op.op === 'op:text.setTiming') { t.timing = { atMs: a.atMs, durationMs: a.durationMs }; placeVisual(visualItems(m), t, t.layer); }   // ADR-027 lane rule
      if (op.op === 'op:text.remove') m.tracks.text.splice(i, 1);
      return;
    }
    case 'op:caption.importSrt': {
      const as = asset(ctx, a.assetId, ['subtitle'], path);
      if (!as.captionPages || as.captionPages.length === 0) stop('EM-1009', `The subtitle file ${as.name ?? as.id} has no readable captions.`, `${path}.args.assetId`);
      m.tracks.caption.pages = structuredClone(as.captionPages!);
      m.tracks.caption.sourceAssetId = as.id;
      if (m.tracks.caption.styleId === null) {
        m.tracks.caption.styleId = 'preset:caption.editorial';
        warnings.push(issue('EM-2403', 'Captions use the Editorial style until you pick another.', 'info', path));
      }
      return;
    }
    case 'op:caption.setStyle': {
      m.tracks.caption.params = preset(a.presetId, 'caption', a.params, ctx, path, warnings);
      m.tracks.caption.styleId = a.presetId;
      return;
    }
    case 'op:caption.setPages': m.tracks.caption.pages = [...a.pages].sort((x: CaptionPageT, y: CaptionPageT) => x.startMs - y.startMs); return;
    case 'op:caption.clear': { m.tracks.caption = { styleId: null, params: {}, pages: [] }; return; }
    case 'op:caption.replaceText': case 'op:caption.editPage': { captionText(m, op.op, a, path, warnings); return; }
    case 'op:background.set': m.background = { presetId: a.presetId, params: preset(a.presetId, 'background', a.params, ctx, path, warnings) }; return;
    case 'op:background.clear': m.background = null; return;
    case 'op:motion.set': case 'op:motion.clear': {
      const t = needTarget(op, path);
      const motion = op.op === 'op:motion.clear' ? null : motionFrom(a.presetId, preset(a.presetId, 'motion', a.params, ctx, path, warnings));
      if (t.kind === 'clip') v[findIndex(v, t.id, 'clip', path)]!.motion = motion;
      else if (t.kind === 'text') m.tracks.text[findIndex(m.tracks.text, t.id, 'text', path)]!.motion = motion;
      else { const o = m.tracks.overlay[findIndex(m.tracks.overlay, t.id, 'shape', path)]!; o.motion = motion; }
      return;
    }
    case 'op:easing.setDefault': preset(a.easingId, 'easing', {}, ctx, path, warnings); m.theme.defaultEasingId = a.easingId; return;
    case 'op:effect.add': case 'op:effect.remove': case 'op:effect.setParams': {
      const c = v[findIndex(v, needTarget(op, path).id, 'clip', path)]!;
      if (op.op === 'op:effect.remove') { c.effects = c.effects.filter((e) => e.presetId !== a.presetId); return; }
      const params = preset(a.presetId, 'effect', a.params, ctx, path, warnings);
      const { motion, ...rest } = params;
      const existing = c.effects.find((e) => e.presetId === a.presetId);
      if (op.op === 'op:effect.setParams') { if (!existing) stop('EM-2203', `The clip has no ${a.presetId} effect.`, `${path}.args.presetId`); existing!.params = rest; existing!.motion = motion as 'static'; return; }
      if (existing) { existing.params = rest; existing.motion = motion as 'static'; return; }   // list class: dedupe by presetId, newest params win
      if (c.effects.length >= MAX_EFFECTS(ctx.tier)) stop('EM-2105', `A clip can have at most ${MAX_EFFECTS(ctx.tier)} effects on this computer.`, `${path}.args.presetId`);
      c.effects.push({ presetId: a.presetId, params: rest, motion: motion as 'static' });
      return;
    }
    case 'op:shape.add': {
      const values = preset(a.presetId, 'shape', { ...(a.params ?? {}), ...(a.size === undefined ? {} : { size: a.size }), ...(a.fill === undefined ? {} : { fill: a.fill }), ...(a.stroke === undefined ? {} : { stroke: a.stroke }), ...(a.strokeWidth === undefined ? {} : { strokeWidth: a.strokeWidth }), ...(a.motionId === undefined ? {} : { motionId: a.motionId }) }, ctx, path, warnings);
      const { size, fill, stroke, strokeWidth, position: _p, motionId, ...rest } = values;
      const accent = String(getPreset(m.theme.paletteId)?.data?.['accent'] ?? '#E8913A');
      const pos: PositionT = a.position === undefined ? { x: 0, y: 0 } : typeof a.position === 'string' ? namedPosition(m, a.position) : a.position;
      const motion = motionOf(a.motion, typeof motionId === 'string' ? motionId : DEFAULT_SHAPE_MOTION[a.presetId] ?? DEFAULT_SHAPE_MOTION_ID, ctx, path, warnings);
      addVisual(m, { kind: 'shape', id: ctx.newId(), presetId: a.presetId, timing: { atMs: a.atMs, durationMs: a.durationMs }, layer: 0, position: pos, size: { w: Number(size), h: a.height ?? Number(size) }, fill: typeof fill === 'string' ? fill : accent, ...(typeof stroke === 'string' ? { stroke } : {}), ...(Number(strokeWidth) > 0 ? { strokeWidth: Number(strokeWidth) } : {}), ...(a.opacity !== undefined ? { opacity: a.opacity } : {}), params: rest, motion }, a.layer);
      return;
    }
    case 'op:shape.remove': m.tracks.overlay.splice(findIndex(m.tracks.overlay, needTarget(op, path).id, 'shape', path), 1); return;
    case 'op:overlay.addImage': {
      const as = asset(ctx, a.assetId, ['image'], path);
      const w = Number(a.size ?? 480);
      const h = as.width && as.height ? Math.round((w * as.height) / as.width) : w;
      const pos: PositionT = a.position === undefined ? { x: 0, y: 0 } : typeof a.position === 'string' ? namedPosition(m, a.position) : a.position;
      addVisual(m, { kind: 'image', id: ctx.newId(), assetId: as.id, timing: { atMs: a.atMs, durationMs: a.durationMs ?? IMAGE_DEFAULT_MS }, layer: 0, position: pos, size: { w, h }, objectFit: a.objectFit ?? 'contain', opacity: a.opacity ?? 1, motion: motionOf(a.motion, DEFAULT_IMAGE_MOTION_ID, ctx, path, warnings), effects: [] }, a.layer);
      return;
    }
    case 'op:overlay.remove': {
      const id = needTarget(op, path).id;
      const i = m.tracks.overlay.findIndex((o) => o.kind === 'image' && o.id === id);
      if (i < 0) stop('EM-2203', `The image ${id ?? '(none)'} no longer exists.`, `${path}.target`);
      m.tracks.overlay.splice(i, 1); return;
    }
    case 'op:overlay.setOpacity': {
      const tg = needTarget(op, path);
      const el = m.tracks.overlay.find((o) => o.id === tg.id && o.kind === (tg.kind === 'shape' ? 'shape' : 'image'));
      if (!el) stop('EM-2203', `The ${tg.kind} ${tg.id ?? '(none)'} no longer exists.`, `${path}.target`);
      el!.opacity = a.opacity; return;
    }
    case 'op:element.setTiming': {
      // ADR-027: a Timeline move / trim. The item keeps its lane when it is free at the new time, else goes to the lane above
      // (or a new lane there); `layer` asks for a lane at once (drag across lanes) by the same rule.
      const t = needTarget(op, path);
      if (t.kind === 'audio') {
        const l = m.tracks.audio[findIndex(m.tracks.audio, t.id, 'audio', path)]!;
        const durationMs: number = a.durationMs;
        l.atMs = a.atMs; l.durationMs = durationMs;
        if (a.trimBeforeMs !== undefined) l.trimBeforeMs = a.trimBeforeMs;
        const src = ctx.assets.find((x) => x.id === l.assetId)?.durationMs;
        if (!l.loop && src !== undefined && l.trimBeforeMs + durationMs > src + 1) stop('EM-2306', `The audio layer needs ${l.trimBeforeMs + durationMs} ms of ${src} ms source audio.`, `${path}.args`);
        for (const f of ['fadeInMs', 'fadeOutMs'] as const) l[f] = Math.min(l[f], Math.floor(durationMs / 2));   // fades never exceed half the layer
        placeAudio(m.tracks.audio, l, a.layer ?? l.lane);
        return;
      }
      if (a.trimBeforeMs !== undefined) stop('EM-2102', 'trimBeforeMs applies to audio layers only.', `${path}.args.trimBeforeMs`);
      const el = visualTarget(m, op, path);
      el.timing = { atMs: a.atMs, durationMs: a.durationMs };
      placeVisual(visualItems(m), el, a.layer ?? el.layer);
      return;
    }
    case 'op:element.setLayer': {
      if ((a.layer === undefined) === (a.move === undefined)) stop('EM-2102', 'op:element.setLayer needs exactly one of layer or move.', `${path}.args`);
      const t = needTarget(op, path);
      if (t.kind === 'audio') {
        // Audio lanes have no stacking order: a lane number, or one row up (towards the video Track) / down.
        if (a.move === 'front' || a.move === 'back') stop('EM-2102', 'Audio layers have no front or back; use up, down or a lane number.', `${path}.args.move`);
        const l = m.tracks.audio[findIndex(m.tracks.audio, t.id, 'audio', path)]!;
        placeAudio(m.tracks.audio, l, a.layer ?? (a.move === 'up' ? Math.max(0, l.lane - 1) : l.lane + 1));
        return;
      }
      const el = visualTarget(m, op, path);
      if (a.layer !== undefined) placeVisual(visualItems(m), el, a.layer); else moveVisual(visualItems(m), el, a.move);
      return;
    }
    case 'op:element.split': {
      // ADR-028: two adjacent parts, each ≥ 100 ms; the second gets a new id, continues the source and takes the fade-out,
      // the first keeps the fade-in and the motion (without exit). A clip's following transition moves to the second part.
      const t = needTarget(op, path);
      const at: number = a.atMs;
      const check = (from: number, len: number) => {
        const d = Math.round(at - from);
        if (d < 100 || len - d < 100) stop('EM-2102', `The split point ${at} ms is not inside the ${t.kind} (${Math.round(from)}–${Math.round(from + len)} ms) with at least 100 ms on each side.`, `${path}.args.atMs`);
        return d;
      };
      if (t.kind === 'clip') {
        const i = findIndex(v, t.id, 'clip', path), c = v[i]!;
        const d = check(deriveTiming(m).clipStartMs[i]!, c.durationMs);
        const image = !!c.scene || ctx.assets.find((x) => x.id === c.assetId)?.kind === 'image';
        const second: ClipT = { ...structuredClone(c), id: ctx.newId(), trimBeforeMs: image ? c.trimBeforeMs : Math.round(c.trimBeforeMs + d * c.playbackRate), durationMs: c.durationMs - d,
          fadeInMs: 0, fadeOutMs: Math.min(c.fadeOutMs, c.durationMs - d), motion: null };
        c.durationMs = d; c.fadeOutMs = 0; c.fadeInMs = Math.min(c.fadeInMs, d); c.motion = splitMotion(c.motion);
        shiftCutsForInsert(m, i);                                  // cut i (after the clip) becomes cut i + 1: its transition follows the second part
        v.splice(i + 1, 0, second);
        reclampCut(m, i - 1, warnings, `${path}.args.atMs`); reclampCut(m, i + 1, warnings, `${path}.args.atMs`);
        return;
      }
      if (t.kind === 'audio') {
        const k = findIndex(m.tracks.audio, t.id, 'audio', path), l = m.tracks.audio[k]!;
        const len = l.durationMs ?? Math.max(0, deriveTiming(m).durationMs - l.atMs);
        const d = check(l.atMs, len);
        const src = ctx.assets.find((x) => x.id === l.assetId)?.durationMs;
        const tb = l.trimBeforeMs + d;
        const { durationMs: _open, ...rest } = structuredClone(l); void _open;
        const second: AudioLayerT = { ...rest, id: ctx.newId(), atMs: at, ...(l.durationMs === undefined ? {} : { durationMs: l.durationMs - d }),
          trimBeforeMs: l.loop && src ? tb % src : tb, fadeInMs: 0, fadeOutMs: Math.min(l.fadeOutMs, len - d) };
        l.durationMs = d; l.fadeOutMs = 0; l.fadeInMs = Math.min(l.fadeInMs, d);
        m.tracks.audio.splice(k + 1, 0, second);                    // same lane: the parts touch, they do not overlap
        return;
      }
      const el = visualTarget(m, op, path);
      const d = check(el.timing.atMs, el.timing.durationMs);
      const second = { ...structuredClone(el), id: ctx.newId(), timing: { atMs: el.timing.atMs + d, durationMs: el.timing.durationMs - d }, motion: null } as typeof el;
      el.timing = { atMs: el.timing.atMs, durationMs: d }; el.motion = splitMotion(el.motion);
      if ('kind' in second) m.tracks.overlay.splice(m.tracks.overlay.indexOf(el as OverlayElementT) + 1, 0, second);
      else m.tracks.text.splice(m.tracks.text.indexOf(el as TextLayerT) + 1, 0, second);
      return;
    }
    case 'op:element.setTransform': {
      // ADR-028: absolute values; omitted fields keep theirs. Clips store `transform` (removed again at identity); images and
      // shapes keep x / y in `position` (u) and add `scale` / `rotation` (removed again at 1 / 0).
      if (a.x === undefined && a.y === undefined && a.scale === undefined && a.rotation === undefined) stop('EM-2102', 'op:element.setTransform needs at least one of x, y, scale or rotation.', `${path}.args`);
      const t = needTarget(op, path);
      if (t.kind === 'clip') {
        const c = v[findIndex(v, t.id, 'clip', path)]!;
        if (a.scale !== undefined && (a.scale < 0.1 || a.scale > 10)) stop('EM-2102', 'A clip can be zoomed from 10 % to 1000 %.', `${path}.args.scale`);
        const cur = c.transform ?? IDENTITY_TRANSFORM;
        const next: ClipTransformT = { x: round(a.x ?? cur.x, 4), y: round(a.y ?? cur.y, 4), scale: round(a.scale ?? cur.scale, 4), rotation: normaliseRotation(a.rotation ?? cur.rotation) };
        if (isIdentity(next)) delete c.transform; else c.transform = next;
        return;
      }
      if (t.kind === 'text') {
        if (a.scale !== undefined || a.rotation !== undefined) stop('EM-2102', 'A text can only be moved (x / y); use op:text.setStyle for its size.', `${path}.args`);
        const tx = visualTarget(m, op, path) as TextLayerT, fr = frameInUnits(m.settings.ratio, m.settings.customRatio);
        tx.position = { x: a.x === undefined ? tx.position.x : round(a.x * fr.w, 1), y: a.y === undefined ? tx.position.y : round(a.y * fr.h, 1) };
        return;
      }
      const el = visualTarget(m, op, path) as OverlayElementT;
      const f = frameInUnits(m.settings.ratio, m.settings.customRatio);
      el.position = { x: a.x === undefined ? el.position.x : round(a.x * f.w, 1), y: a.y === undefined ? el.position.y : round(a.y * f.h, 1) };
      if (a.scale !== undefined) { const s = round(a.scale, 4); if (s === 1) delete el.scale; else el.scale = s; }
      if (a.rotation !== undefined) { const r = normaliseRotation(a.rotation); if (r === 0) delete el.rotation; else el.rotation = r; }
      return;
    }
    case 'op:audio.addBed': case 'op:audio.addLayer': {
      const as = asset(ctx, a.assetId, ['audio'], path);
      const layer: AudioLayerT = op.op === 'op:audio.addBed'
        ? { id: ctx.newId(), assetId: as.id, role: 'bed', atMs: 0, lane: 0, trimBeforeMs: 0, volume: a.volume, loop: a.loop, fadeInMs: a.fadeInMs ?? 0, fadeOutMs: a.fadeOutMs ?? 0, ducking: a.duckingPresetId ? { presetId: a.duckingPresetId, params: preset(a.duckingPresetId, 'audio', {}, ctx, path, warnings) } : null }
        : { id: ctx.newId(), assetId: as.id, role: a.role, atMs: a.atMs, ...(as.durationMs ? { durationMs: as.durationMs } : {}), lane: 0, trimBeforeMs: 0, volume: a.volume, loop: false, fadeInMs: a.fadeInMs ?? 0, fadeOutMs: a.fadeOutMs ?? 0, ducking: null };
      addAudio(m, layer);
      return;
    }
    case 'op:audio.setDucking': case 'op:audio.setFades': case 'op:audio.remove': {
      const i = findIndex(m.tracks.audio, needTarget(op, path).id, 'audio', path);
      const l = m.tracks.audio[i]!;
      if (op.op === 'op:audio.remove') { m.tracks.audio.splice(i, 1); return; }
      if (op.op === 'op:audio.setDucking') { if (a.presetId !== 'preset:audio.duck-voice') stop('EM-2101', `${a.presetId} is not a ducking preset.`, `${path}.args.presetId`); l.ducking = { presetId: a.presetId, params: preset(a.presetId, 'audio', a.params, ctx, path, warnings) }; return; }
      const span = l.durationMs ?? Infinity;
      for (const f of ['fadeInMs', 'fadeOutMs'] as const) if (a[f] !== undefined) { if (a[f] > span / 2) stop('EM-2102', `${f} is longer than half the audio layer.`, `${path}.args.${f}`); l[f] = a[f]; }
      return;
    }
    case 'op:theme.set': {
      if (a.paletteId) {
        preset(a.paletteId, 'palette', {}, ctx, path, warnings);
        const oldText = getPreset(m.theme.paletteId)?.data?.['text'], newText = getPreset(a.paletteId)!.data?.['text'];
        if (typeof oldText === 'string' && typeof newText === 'string' && m.theme.textDefaults.colour.toUpperCase() === oldText.toUpperCase()) m.theme.textDefaults.colour = newText;   // follow the palette unless the Creator chose a colour
        m.theme.paletteId = a.paletteId;
      }
      if (a.fontPairId) { preset(a.fontPairId, 'fontpair', {}, ctx, path, warnings); m.theme.fontPairId = a.fontPairId; }
      if (a.defaultEasingId) { preset(a.defaultEasingId, 'easing', {}, ctx, path, warnings); m.theme.defaultEasingId = a.defaultEasingId; }
      return;
    }
    case 'op:theme.setTextDefaults': m.theme.textDefaults = { ...m.theme.textDefaults, ...a }; return;
    case 'op:output.setRatio': {
      if (a.ratio === 'custom' && !a.customRatio) stop('EM-2402', 'A custom ratio needs a width and a height.', `${path}.args.customRatio`);
      if (a.ratio === 'custom') { const r = a.customRatio.w / a.customRatio.h; if (r > 3 || r < 1 / 3) stop('EM-2402', 'Custom ratios must be between 1:3 and 3:1.', `${path}.args.customRatio`); m.settings.customRatio = a.customRatio; }
      else delete m.settings.customRatio;
      m.settings.ratio = a.ratio; m.settings.autoRatio = false;           // a manual ratio pick turns Auto off (ELEMENT_IDS agent.output.ratio.auto)
      return;
    }
    case 'op:output.setAutoRatio': m.settings.autoRatio = a.on; followFirstClip(m, ctx); return;
    case 'op:output.setResolution': {
      if (ctx.tier === 'T0' && (a.preset === '2k' || a.preset === '2160p')) warnings.push(issue('EM-3105', `${a.preset} needs a graphics card with at least 4 GB on this computer; export will offer 1080p.`, 'info', `${path}.args.preset`));
      m.settings.resolution = a.preset; return;
    }
    case 'op:project.setFps': m.settings.fps = a.fps; return;
    case 'op:project.setDurationPolicy': {
      if (a.policy === 'fixed' && a.fixedMs === undefined) stop('EM-2102', 'A fixed duration needs fixedMs.', `${path}.args.fixedMs`);
      m.durationPolicy = a.policy; if (a.policy === 'fixed') m.fixedDurationMs = a.fixedMs; else delete m.fixedDurationMs;
      return;
    }
    case 'op:generated.insert': {
      const job = ctx.jobs?.[a.jobId];
      if (!job || job.kind !== a.kind) stop('EM-9003', `Generated result ${a.jobId} was not found.`, `${path}.args.jobId`);
      if (a.kind === 'captions') { m.tracks.caption.pages = structuredClone(job!.pages ?? []); return; }
      if (a.kind === 'thumbnail') {
        // FR-103: Insert as overlay — the chosen candidate becomes an image overlay at atMs (same defaults as op:overlay.addImage).
        const img = asset(ctx, job!.assetId ?? '', ['image'], path);
        const w = 480, h = img.width && img.height ? Math.round((w * img.height) / img.width) : w;
        addVisual(m, { kind: 'image', id: ctx.newId(), assetId: img.id, timing: { atMs: a.atMs ?? 0, durationMs: IMAGE_DEFAULT_MS }, layer: 0, position: { x: 0, y: 0 }, size: { w, h }, objectFit: 'contain', opacity: 1, motion: null, effects: [] }, undefined);
        return;
      }
      const as = asset(ctx, job!.assetId ?? '', ['audio'], path);
      addAudio(m, a.kind === 'music'
        ? { id: ctx.newId(), assetId: as.id, role: 'bed', atMs: 0, lane: 0, trimBeforeMs: 0, volume: 0.2, loop: true, fadeInMs: 1000, fadeOutMs: 1000, ducking: null }
        : { id: ctx.newId(), assetId: as.id, role: 'voice', atMs: a.atMs ?? 0, ...(as.durationMs ? { durationMs: as.durationMs } : {}), lane: 0, trimBeforeMs: 0, volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0, ducking: null });
      return;
    }
  }
}
