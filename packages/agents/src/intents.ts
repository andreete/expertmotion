// Edit-intent pipeline steps 2–7 (docs/AI_WORKFLOW.md §2, §4, §6, §7): typed intents from Design Picks, Target Resolution,
// multi-target expansion, the Intent Queue reducer (supersede / restore / remove) and the deterministic Compile path.
import { compileDefaults, getPreset, type Category } from '@expertmotion/catalogue';
import { deriveTiming, duplicationSteps, propertyKeysOf, removalSteps, stepFor, topmostAt, type CompositionModelT, type ElementRefT, type ItemRef, type LayerMove, type OperationT } from '@expertmotion/composition-model';
import { fail, issue, ok, type Result } from '@expertmotion/shared';
import type { EditIntentT, IntentCategory } from './schemas.js';

/** Text Panel fields (FR-020…FR-028). `content` edits the selected layer's text (op:text.setContent, FR-027); `opacity` also applies to Shapes and overlay images (FR-028). */
export type TextField = 'fontFamily' | 'fontSize' | 'weight' | 'italic' | 'colour' | 'align' | 'opacity' | 'content';
/** What the Editor sends when the Creator picks something (a Catalogue Card, a Text Panel value, an Output Setting, or a chat request). */
export interface DesignPick {
  projectId: string;
  source: EditIntentT['source'];
  presetId?: string;                         // catalogue card
  field?: TextField; value?: unknown;        // Text Panel value (deterministic)
  output?: { kind: 'ratio' | 'resolution' | 'fps' | 'autoRatio' | 'durationPolicy' | SettingsOutputKind; value: unknown; customRatio?: { w: number; h: number }; fixedMs?: number };
  category?: IntentCategory;                 // required for instruction-only picks (chat / brainstorm)
  params?: Record<string, unknown>;
  instruction?: string;
  selection?: ElementRefT[];                 // selected Timeline Elements (clip, cut, text, audio, shape)
  playheadMs?: number;
  assetId?: string;                          // music bed / sfx asset
  text?: string;                             // content for a text variant
  /** FR-068 (P1): Timeline drag on the video Track — reorder (toIndex) or trim (trimBeforeMs + durationMs, frame-snapped by the Editor). */
  clipEdit?: { clipId: string; toIndex?: number; trimBeforeMs?: number; durationMs?: number };
  /**
   * ADR-027 / FR-068: Timeline drag, trim, lane change or layer key on a text, image, shape or audio layer. Timing (atMs + durationMs,
   * audio `trimBeforeMs` for a left-edge trim) and an optional `layer` → op:element.setTiming; `move` alone (or `layer` alone) →
   * op:element.setLayer. One gesture = one pick = one op.
   */
  elementEdit?: ElementEdit;
  /**
   * ADR-028 / FR-179: cut at the playhead. Each listed item that contains `atMs` → op:element.split (one child intent per item, one
   * Composition Version). An empty list means the clip under the playhead.
   */
  splitEdit?: SplitEdit;
  /** ADR-028 / FR-180: Player handles / Inspector fields → op:element.setTransform on one clip, image or shape (one gesture = one pick). */
  transformEdit?: TransformEdit;
  /**
   * ADR-031 / FR-192 / FR-193: Delete or Duplicate the listed Timeline items (Delete key, context menu, inspector). Each item that
   * still exists → one child intent with one op (removalSteps / duplicationSteps), all in ONE Composition Version (one Undo).
   */
  itemsEdit?: ItemsEdit;
}
export interface ItemsEdit { action: 'remove' | 'duplicate'; items: ItemRef[] }
export type SplitKind = 'clip' | 'text' | 'image' | 'shape' | 'audio';
export interface SplitEdit { atMs: number; items: Array<{ kind: SplitKind; id: string }> }
export interface TransformEdit { kind: 'clip' | 'image' | 'shape'; id: string; x?: number; y?: number; scale?: number; rotation?: number }
export interface ElementEdit { kind: 'text' | 'image' | 'shape' | 'audio'; id: string; atMs?: number; durationMs?: number; trimBeforeMs?: number; layer?: number; move?: LayerMove }
/**
 * FR-090 / FR-097: Output Settings that live outside the Composition Model (Project Settings, not an op). They are recorded in the
 * Intent Queue like any Output pick (visible, supersedable, restorable) but compile to zero operations: the Local Service applies
 * them to settings and records the intent as executed (AI_WORKFLOW §4 "output (profile)").
 */
export type SettingsOutputKind = 'performanceProfile';
export const PERFORMANCE_PROFILES = ['standard', 'accelerated', 'turbo'] as const;
export type PerformanceProfileT = (typeof PERFORMANCE_PROFILES)[number];
export const PERFORMANCE_PROFILE_KEY = 'project.performanceProfile';
/** The settings patch a zero-op settings intent stands for, or null for every other intent. */
export function settingsPatchOf(i: Pick<EditIntentT, 'params'>): { performanceProfile: PerformanceProfileT } | null {
  const o = i.params?.['__output'] as { kind?: string; value?: unknown } | undefined;
  if (o?.kind !== 'performanceProfile' || !(PERFORMANCE_PROFILES as readonly unknown[]).includes(o.value)) return null;
  return { performanceProfile: o.value as PerformanceProfileT };
}
export interface IntentContext { model: CompositionModelT; baseVersion: string; newId: () => string; now?: () => string }

const CATEGORY_OF: Record<Category, IntentCategory> = {
  transition: 'transition', caption: 'caption', background: 'background', motion: 'motion', shape: 'shape', easing: 'easing', effect: 'effect',
  audio: 'audio', text: 'text', texteffect: 'text', font: 'text', palette: 'layout', fontpair: 'layout',
};

function elementsAt(model: CompositionModelT, ms: number) {
  const t = deriveTiming(model);
  const clipIdx = model.tracks.video.findIndex((c) => { const w = t.elementWindows[c.id]!; return ms >= w.fromMs && ms < w.toMs; });
  const text = topmostAt(model, ms, ['text']);                       // ADR-027: the front-most text when several play at once
  return { clip: clipIdx >= 0 ? model.tracks.video[clipIdx] : undefined, text };
}

/** Builds the operation an intent stands for on one resolved target (used both for Compile and for the property key). */
function opFor(pick: DesignPick, target: ElementRefT | undefined, model: CompositionModelT): { op: OperationT; complete: boolean } | null {
  if (pick.itemsEdit) { const st = stepFor(itemSteps(model, pick.itemsEdit), target); return st ? { op: st.op, complete: true } : null; }
  if (pick.splitEdit) return target ? { op: { op: 'op:element.split', target, args: { atMs: Math.round(pick.splitEdit.atMs) } }, complete: true } : null;
  if (pick.transformEdit) {
    const e = pick.transformEdit;
    const args = Object.fromEntries((['x', 'y', 'scale', 'rotation'] as const).filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
    return { op: { op: 'op:element.setTransform', target: { kind: e.kind, id: e.id }, args }, complete: true };
  }
  if (pick.elementEdit) {
    const e = pick.elementEdit, el: ElementRefT = { kind: e.kind, id: e.id };
    if (e.atMs !== undefined || e.durationMs !== undefined) {
      const cur = elementTiming(model, e);
      return { op: { op: 'op:element.setTiming', target: el, args: { atMs: e.atMs ?? cur?.atMs ?? 0, durationMs: e.durationMs ?? cur?.durationMs ?? 100,
        ...(e.trimBeforeMs !== undefined ? { trimBeforeMs: e.trimBeforeMs } : {}), ...(e.layer !== undefined ? { layer: e.layer } : {}) } }, complete: true };
    }
    return { op: { op: 'op:element.setLayer', target: el, args: e.move !== undefined ? { move: e.move } : { layer: e.layer ?? 0 } }, complete: true };
  }
  if (pick.clipEdit) {
    const e = pick.clipEdit, clip = { kind: 'clip' as const, id: e.clipId };
    if (e.toIndex !== undefined) return { op: { op: 'op:clip.move', target: clip, args: { toIndex: e.toIndex } }, complete: true };
    const c = model.tracks.video.find((x) => x.id === e.clipId);
    return { op: { op: 'op:clip.setTrim', target: clip, args: { trimBeforeMs: e.trimBeforeMs ?? c?.trimBeforeMs ?? 0, durationMs: e.durationMs ?? c?.durationMs ?? 100 } }, complete: true };
  }
  if (pick.output) {
    const o = pick.output;
    if (o.kind === 'ratio') return { op: { op: 'op:output.setRatio', target: { kind: 'project' }, args: { ratio: o.value, ...(o.customRatio ? { customRatio: o.customRatio } : {}) } }, complete: true };
    if (o.kind === 'autoRatio') return { op: { op: 'op:output.setAutoRatio', target: { kind: 'project' }, args: { on: o.value === true } }, complete: true };
    if (o.kind === 'resolution') return { op: { op: 'op:output.setResolution', target: { kind: 'project' }, args: { preset: o.value } }, complete: true };
    // FR-015: output / project.durationPolicy / scalar → op:project.setDurationPolicy (fixedMs only with 'fixed').
    if (o.kind === 'durationPolicy') return { op: { op: 'op:project.setDurationPolicy', target: { kind: 'project' }, args: { policy: o.value, ...(o.value === 'fixed' && o.fixedMs !== undefined ? { fixedMs: o.fixedMs } : {}) } }, complete: true };
    return { op: { op: 'op:project.setFps', target: { kind: 'project' }, args: { fps: o.value } }, complete: true };
  }
  if (pick.field) {
    if (pick.field === 'content') return target?.kind === 'text' ? { op: { op: 'op:text.setContent', target, args: { text: pick.value } }, complete: true } : null;
    if (pick.field === 'opacity' && (target?.kind === 'shape' || target?.kind === 'image')) return { op: { op: 'op:overlay.setOpacity', target, args: { opacity: pick.value } }, complete: true };
    if (target?.kind === 'text') return { op: { op: 'op:text.setStyle', target, args: { [pick.field]: pick.value } }, complete: true };
    return { op: { op: 'op:theme.setTextDefaults', target: { kind: 'project' }, args: { [pick.field]: pick.value } }, complete: true };
  }
  if (!pick.presetId) return null;
  const d = compileDefaults(pick.presetId); const p = getPreset(pick.presetId);
  if (!d || !p) return null;
  const params = { ...(pick.params ?? {}) };
  let args: Record<string, unknown> = { ...d.args };
  if ('params' in args) {
    // Keys the Compile rule lifts to the top level (transition durationMs / timing, FR-098) stay there; the rest go to args.params.
    const top = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'params' && k in args));
    const rest = Object.fromEntries(Object.entries(params).filter(([k]) => !(k in args)));
    args = { ...args, ...top, params: { ...(args['params'] as object), ...rest } };
  } else args = { ...args, ...params };
  if (p.category === 'text') {
    // FR-025: a variant pick on a selected Text Layer re-applies the variant; otherwise FR-027 Add Text at the playhead,
    // default 3000 ms clamped to the Sequence end.
    if (target?.kind === 'text') return { op: { op: 'op:text.setStyle', target, args: { variant: p.id } }, complete: true };
    // ADR-031: without clips (fit-content) the text itself sets the length of the video, so it keeps its 3000 ms.
    const atMs = Math.round(pick.playheadMs ?? 0), end = deriveTiming(model).durationMs;
    const bounded = model.tracks.video.length > 0 || model.durationPolicy === 'fixed';
    const want = typeof args['durationMs'] === 'number' ? (args['durationMs'] as number) : 3000;
    args = { ...args, text: pick.text, atMs, durationMs: bounded && end > atMs ? Math.max(100, Math.min(want, end - atMs)) : want };
  }
  if (p.category === 'shape') {
    // size/fill/stroke/strokeWidth are first-class op:shape.add args; everything else stays in params.
    const { size, fill, stroke, strokeWidth, ...rest } = (args['params'] ?? {}) as Record<string, unknown>;
    args = { ...args, ...(size !== undefined ? { size } : {}), ...(fill !== undefined ? { fill } : {}), ...(stroke !== undefined ? { stroke } : {}), ...(strokeWidth !== undefined ? { strokeWidth } : {}), params: rest, atMs: Math.round(pick.playheadMs ?? 0) };
  }
  if (p.category === 'font' && target?.kind === 'text') return { op: { op: 'op:text.setStyle', target, args: { fontFamily: args['fontFamily'] } }, complete: true };
  if (pick.assetId) args['assetId'] = pick.assetId;
  if (p.id === 'preset:audio.sfx-hit') args['atMs'] = Math.round(pick.playheadMs ?? 0);
  const missing = d.requires.filter((r) => (r === 'target' ? !target : args[r] === undefined || args[r] === ''));
  const op: OperationT = { op: d.op, args, ...(target ? { target } : d.op.startsWith('op:theme') || d.op.startsWith('op:caption') || d.op.startsWith('op:background') || d.op.startsWith('op:easing') || d.op === 'op:audio.addBed' ? { target: { kind: 'project' as const } } : {}) };
  void model;
  return { op, complete: missing.length === 0 };
}

/** Current start/length of an element edit's target (audio without a length runs to the end of the video). */
function elementTiming(model: CompositionModelT, e: ElementEdit): { atMs: number; durationMs: number } | undefined {
  if (e.kind === 'audio') { const a = model.tracks.audio.find((x) => x.id === e.id); return a ? { atMs: a.atMs, durationMs: a.durationMs ?? Math.max(100, deriveTiming(model).durationMs - a.atMs) } : undefined; }
  const x = e.kind === 'text' ? model.tracks.text.find((y) => y.id === e.id) : model.tracks.overlay.find((o) => o.id === e.id && o.kind === e.kind);
  return x?.timing;
}

/** ADR-028: the composition-time window of a splittable item (undefined when it no longer exists). */
function splitWindow(model: CompositionModelT, kind: SplitKind, id: string): { fromMs: number; toMs: number } | undefined {
  if (kind === 'clip') return model.tracks.video.some((c) => c.id === id) ? deriveTiming(model).elementWindows[id] : undefined;
  if (kind === 'audio') { const a = model.tracks.audio.find((x) => x.id === id); return a ? { fromMs: a.atMs, toMs: a.durationMs === undefined ? deriveTiming(model).durationMs : a.atMs + a.durationMs } : undefined; }
  const x = kind === 'text' ? model.tracks.text.find((y) => y.id === id) : model.tracks.overlay.find((o) => o.id === id && o.kind === kind);
  return x ? { fromMs: x.timing.atMs, toMs: x.timing.atMs + x.timing.durationMs } : undefined;
}
const categoryOfKind = (kind: string): IntentCategory => (kind === 'audio' ? 'audio' : kind === 'text' ? 'text' : kind === 'shape' ? 'shape' : 'asset');
/** ADR-031: the ops of a Delete / Duplicate pick on `model` (one per resolved target). */
const itemSteps = (model: CompositionModelT, e: ItemsEdit) => (e.action === 'remove' ? removalSteps(model, e.items) : duplicationSteps(model, e.items));
const ITEM_CATEGORY: Record<string, IntentCategory> = { cut: 'transition', effect: 'effect', background: 'background', caption: 'caption' };
const categoryOfItems = (items: readonly ItemRef[]): IntentCategory => {
  const cats = [...new Set(items.map((x) => ITEM_CATEGORY[x.kind] ?? categoryOfKind(x.kind)))];
  return cats.length === 1 ? cats[0]! : 'asset';
};

/** Target Resolution table (AI_WORKFLOW §4). Returns the concrete targets, or an EM issue when the pick cannot be placed. */
export function resolveTargets(pick: DesignPick, model: CompositionModelT): Result<{ targets: Array<ElementRefT | undefined>; label: string }> {
  const sel = pick.selection ?? [];
  const p = pick.presetId ? getPreset(pick.presetId) : undefined;
  const cat: Category | 'field' | 'output' | 'clip' | 'element' | 'split' | 'transform' | 'items' | 'instruction' = pick.itemsEdit ? 'items' : pick.splitEdit ? 'split' : pick.transformEdit ? 'transform' : pick.elementEdit ? 'element' : pick.clipEdit ? 'clip' : pick.output ? 'output' : pick.field ? 'field' : p ? p.category : 'instruction';
  const v = model.tracks.video;
  const at = elementsAt(model, pick.playheadMs ?? 0);
  switch (cat) {
    case 'clip': {
      const id = pick.clipEdit!.clipId;
      const i = v.findIndex((c) => c.id === id);
      if (i < 0) return fail([issue('EM-2203', 'That clip no longer exists.', 'block', 'clipEdit.clipId')]);
      return ok({ targets: [{ kind: 'clip' as const, id }], label: `clip ${i + 1}` });
    }
    case 'items': {
      // ADR-031: Delete / Duplicate — the listed items that still exist (a deleted scene clip takes its own texts with it).
      const e = pick.itemsEdit!;
      if (!e.items.length) return fail([issue('EM-2201', 'Select something on the Timeline first.', 'block', 'itemsEdit.items')]);
      const steps = itemSteps(model, e);
      if (!steps.length) return fail([issue(e.action === 'duplicate' ? 'EM-2201' : 'EM-2203', e.action === 'duplicate' ? 'This item cannot be duplicated.' : 'That item no longer exists.', 'block', 'itemsEdit.items')]);
      return ok({ targets: steps.map((s) => s.target), label: `${e.action === 'remove' ? 'delete' : 'duplicate'} ${steps.length === 1 ? steps[0]!.target.kind : `${steps.length} items`}` });
    }
    case 'split': {
      // ADR-028: the listed items that contain the split point with ≥ 100 ms on each side; none listed → the clip at the split point.
      const { atMs, items } = pick.splitEdit!;
      const under = items.length ? undefined : elementsAt(model, atMs).clip;
      const list = items.length ? items : under ? [{ kind: 'clip' as const, id: under.id }] : [];
      if (!list.length) return fail([issue('EM-2201', 'Select a clip or move the playhead onto one.', 'block', 'splitEdit')]);
      const known = list.filter((x) => splitWindow(model, x.kind, x.id));
      if (!known.length) return fail([issue('EM-2203', 'That item no longer exists.', 'block', 'splitEdit.items')]);
      const inside = known.filter((x) => { const w = splitWindow(model, x.kind, x.id)!; return atMs >= w.fromMs + 100 && atMs <= w.toMs - 100; });
      if (!inside.length) return fail([issue('EM-2201', 'Move the playhead inside the item you want to split (at least 0.1 s from its edges).', 'block', 'splitEdit.atMs')]);
      const unique = inside.filter((x, i) => inside.findIndex((y) => y.kind === x.kind && y.id === x.id) === i);
      return ok({ targets: unique.map((x) => ({ kind: x.kind, id: x.id })), label: unique.length === 1 ? `split ${unique[0]!.kind}` : `split ${unique.length} items` });
    }
    case 'transform': {
      const e = pick.transformEdit!;
      const exists = e.kind === 'clip' ? v.some((c) => c.id === e.id) : model.tracks.overlay.some((o) => o.id === e.id && o.kind === e.kind);
      if (!exists) return fail([issue('EM-2203', `That ${e.kind} no longer exists.`, 'block', 'transformEdit.id')]);
      if (e.x === undefined && e.y === undefined && e.scale === undefined && e.rotation === undefined) return fail([issue('EM-2102', 'Nothing to change.', 'block', 'transformEdit')]);
      return ok({ targets: [{ kind: e.kind, id: e.id }], label: `${e.kind} position` });
    }
    case 'element': {
      const e = pick.elementEdit!;
      if (!elementTiming(model, e)) return fail([issue('EM-2203', `That ${e.kind} no longer exists.`, 'block', 'elementEdit.id')]);
      if (e.atMs === undefined && e.durationMs === undefined && e.layer === undefined && e.move === undefined) return fail([issue('EM-2102', 'Nothing to change.', 'block', 'elementEdit')]);
      const what = e.atMs !== undefined || e.durationMs !== undefined ? (e.layer !== undefined ? 'timing and layer' : 'timing') : e.move ? `layer ${e.move}` : `layer ${(e.layer ?? 0) + 1}`;
      return ok({ targets: [{ kind: e.kind, id: e.id }], label: `${e.kind} ${what}` });
    }
    case 'transition': {
      if (v.length < 2) return fail([issue('EM-2202', 'Add at least two clips before choosing a transition.', 'block', 'target')]);
      const cuts = sel.flatMap((s) => (s.kind === 'cut' && s.index !== undefined ? [s.index] : s.kind === 'clip' ? (() => { const i = v.findIndex((c) => c.id === s.id); return i >= 0 && i < v.length - 1 ? [i] : []; })() : []));
      const list = cuts.length ? [...new Set(cuts)].sort((a, b) => a - b) : v.slice(0, -1).map((_, i) => i);
      return ok({ targets: list.map((index) => ({ kind: 'cut' as const, index })), label: cuts.length ? list.map((i) => `cut ${i + 1}`).join(', ') : `all ${list.length} cut${list.length === 1 ? '' : 's'}` });
    }
    case 'motion': case 'effect': case 'texteffect': {
      const kinds = cat === 'effect' ? ['clip'] : cat === 'texteffect' ? ['text'] : ['clip', 'text', 'shape'];
      const chosen = sel.filter((s) => kinds.includes(s.kind) && s.id);
      if (chosen.length) return ok({ targets: chosen.map((s) => ({ kind: s.kind, id: s.id! })), label: chosen.length === 1 ? `selected ${chosen[0]!.kind}` : `${chosen.length} selected elements` });
      // FR-026: a text effect without a selected Text Layer is queued for the Editor Agent (placement is creative).
      if (cat === 'texteffect') return ok({ targets: [undefined], label: 'needs the Editor Agent' });
      const under = at.clip ? { kind: 'clip' as const, id: at.clip.id } : cat === 'motion' && at.text ? { kind: 'text' as const, id: at.text.id } : undefined;
      if (!under) return fail([issue('EM-2201', 'Select a clip or move the playhead onto one.', 'block', 'target')]);
      return ok({ targets: [under], label: `${under.kind} under the playhead` });
    }
    case 'field': case 'font': case 'text': {
      const texts = sel.filter((s) => s.kind === 'text' && s.id);
      if (cat === 'field' && pick.field === 'opacity') {
        const els = sel.filter((s) => (s.kind === 'text' || s.kind === 'shape' || s.kind === 'image') && s.id);
        if (!els.length) return fail([issue('EM-2201', 'Select an element first.', 'block', 'target')]);
        return ok({ targets: els.map((s) => ({ kind: s.kind, id: s.id! })), label: els.length === 1 ? `selected ${els[0]!.kind}` : `${els.length} elements` });
      }
      if (cat === 'field' && pick.field === 'content' && !texts.length) return fail([issue('EM-2201', 'Select a text first.', 'block', 'target')]);
      if (cat === 'text' && pick.text === undefined && texts.length) return ok({ targets: texts.map((s) => ({ kind: 'text' as const, id: s.id! })), label: texts.length === 1 ? 'selected text' : `${texts.length} texts` });
      if (cat !== 'text' && texts.length) return ok({ targets: texts.map((s) => ({ kind: 'text' as const, id: s.id! })), label: texts.length === 1 ? 'selected text' : `${texts.length} texts` });
      return ok({ targets: [undefined], label: cat === 'text' ? 'new text at the playhead' : 'new text (theme default)' });
    }
    case 'audio': {
      if (p?.id === 'preset:audio.bed-soft' || p?.id === 'preset:audio.sfx-hit') return ok({ targets: [undefined], label: 'project audio' });
      const layers = sel.filter((s) => s.kind === 'audio' && s.id);
      if (layers.length) return ok({ targets: layers.map((s) => ({ kind: 'audio' as const, id: s.id! })), label: `${layers.length} audio layer(s)` });
      const bed = model.tracks.audio.find((a) => a.role === 'bed');
      if (!bed) return fail([issue('EM-2201', 'Add music first, then choose how it behaves under voice.', 'block', 'target')]);
      return ok({ targets: [{ kind: 'audio', id: bed.id }], label: 'music bed' });
    }
    default: return ok({ targets: [undefined], label: cat === 'shape' ? 'new shape at the playhead' : 'whole project' });
  }
}

/**
 * Step 2–6: one parent intent per pick plus one child per resolved target when there is more than one (expansion rule, §6).
 * Children carry the concrete propertyKey used for supersession and Locked Keys.
 */
export function createIntents(pick: DesignPick, ctx: IntentContext): Result<EditIntentT[]> {
  const now = ctx.now ?? (() => new Date().toISOString());
  const p = pick.presetId ? getPreset(pick.presetId) : undefined;
  if (pick.presetId && !p) return fail([issue('EM-2101', `Unknown design preset ${pick.presetId}.`, 'block', 'presetId')]);
  const category: IntentCategory = pick.itemsEdit ? categoryOfItems(pick.itemsEdit.items) : pick.splitEdit ? (pick.splitEdit.items.length && pick.splitEdit.items.every((x) => x.kind === pick.splitEdit!.items[0]!.kind) ? categoryOfKind(pick.splitEdit.items[0]!.kind) : 'asset')
    : pick.transformEdit ? categoryOfKind(pick.transformEdit.kind) : pick.elementEdit ? (pick.elementEdit.kind === 'audio' ? 'audio' : pick.elementEdit.kind === 'text' ? 'text' : pick.elementEdit.kind === 'shape' ? 'shape' : 'asset') : pick.clipEdit ? 'asset' : pick.output ? 'layout' : pick.field ? 'text' : p ? CATEGORY_OF[p.category] : (pick.category ?? 'layout');
  const instructionOnly = !p && !pick.field && !pick.output && !pick.clipEdit && !pick.elementEdit && !pick.splitEdit && !pick.transformEdit && !pick.itemsEdit;
  // Persisted intents must be recompilable without the original pick: stash its deterministic inputs under `__` keys.
  const stash: Record<string, unknown> = { ...(pick.params ?? {}),
    ...(pick.field ? { __field: pick.field, __value: pick.value } : {}), ...(pick.output ? { __output: pick.output } : {}), ...(pick.clipEdit ? { __clipEdit: pick.clipEdit } : {}), ...(pick.elementEdit ? { __elementEdit: pick.elementEdit } : {}),
    ...(pick.splitEdit ? { __splitEdit: pick.splitEdit } : {}), ...(pick.transformEdit ? { __transformEdit: pick.transformEdit } : {}), ...(pick.itemsEdit ? { __itemsEdit: pick.itemsEdit } : {}),
    ...(pick.text !== undefined ? { __text: pick.text } : {}), ...(pick.assetId ? { __assetId: pick.assetId } : {}), ...(pick.playheadMs !== undefined ? { __playheadMs: pick.playheadMs } : {}) };
  const base = (over: Partial<EditIntentT>): EditIntentT => ({
    id: ctx.newId(), projectId: pick.projectId, source: pick.source, createdAt: now(), category,
    ...(pick.presetId ? { presetId: pick.presetId } : {}), params: stash,
    target: pick.selection?.[0] ?? (pick.playheadMs !== undefined ? { kind: 'playhead' } : { kind: 'project' }),
    resolvedTargets: [], propertyKey: '', propertyClass: pick.splitEdit || pick.itemsEdit ? 'list' : p?.propertyClass ?? 'scalar', needsInterpretation: false,
    ...(pick.instruction ? { instruction: pick.instruction } : {}), status: 'queued', supersedes: [], baseVersion: ctx.baseVersion, ...over,
  });
  if (instructionOnly) return ok([base({ propertyKey: `instruction:${ctx.newId()}`, propertyClass: 'list', needsInterpretation: true })]);
  if (pick.output?.kind === 'performanceProfile') {
    if (!(PERFORMANCE_PROFILES as readonly unknown[]).includes(pick.output.value)) return fail([issue('EM-9002', 'Unknown performance profile.', 'block', 'output.value')]);
    return ok([base({ category: 'output', target: { kind: 'project' }, resolvedTargets: [{ kind: 'project' }], propertyKey: PERFORMANCE_PROFILE_KEY, propertyClass: 'scalar', needsInterpretation: false, params: { ...stash, targetLabel: String(pick.output.value) } })]);
  }
  const r = resolveTargets(pick, ctx.model);
  if (!r.ok) return r;
  const { targets, label } = r.value;
  const built = targets.map((t) => ({ t, o: opFor(pick, t, ctx.model) }));
  const keyOf = (o: OperationT | undefined, t: ElementRefT | undefined) => {
    if (o?.op === 'op:clip.move') return `clip:${o.target?.id ?? ''}.order`;       // FR-068: lock the order of this clip, not every key of it
    // ADR-028: a split is an event, not a value: it never supersedes another pick and is not a Locked Key.
    if (o?.op === 'op:element.split') return `list:split:${o.target?.kind ?? ''}:${o.target?.id ?? ''}:${String(o.args['atMs'])}:${ctx.newId()}`;
    // ADR-031: a Delete / Duplicate is an event too (never supersedes, never a Locked Key).
    if (pick.itemsEdit) return `list:${pick.itemsEdit.action}:${t?.kind ?? ''}:${t?.id ?? t?.index ?? ''}:${ctx.newId()}`;
    const keys = o ? propertyKeysOf(o) : [];
    if (keys.length) return keys.join('|');
    return `list:${category}:${pick.presetId ?? pick.field ?? 'x'}:${t ? `${t.kind}:${t.id ?? t.index}` : 'project'}`;
  };
  const interpret = !!pick.instruction || built.some((b) => !b.o || !b.o.complete);
  if (built.length === 1) {
    const b = built[0]!;
    return ok([base({ resolvedTargets: b.t ? [b.t] : [], propertyKey: keyOf(b.o?.op, b.t), needsInterpretation: interpret, params: { ...stash, targetLabel: label } })]);
  }
  const parent = base({ resolvedTargets: built.flatMap((b) => (b.t ? [b.t] : [])), propertyKey: `group:${category}:${pick.presetId ?? ''}`, needsInterpretation: interpret, params: { ...stash, targetLabel: label } });
  const children = built.map((b) => base({ parentIntentId: parent.id, resolvedTargets: b.t ? [b.t] : [], propertyKey: keyOf(b.o?.op, b.t), needsInterpretation: interpret }));
  return ok([parent, ...children]);
}

const ACTIVE = new Set(['queued', 'compiled', 'planned', 'executed']);
/** Intent Queue reducer (§6): newest pick wins for scalar / exclusive-group keys and for duplicate list entries; nothing is deleted. */
export function enqueue(queue: readonly EditIntentT[], incoming: readonly EditIntentT[]): EditIntentT[] {
  const q = queue.map((i) => ({ ...i }));
  for (const n of incoming) {
    const add = { ...n, supersedes: [...n.supersedes] };
    if (!n.propertyKey.startsWith('group:') && !n.propertyKey.startsWith('instruction:')) {
      for (const old of q) if (old.propertyKey === n.propertyKey && ACTIVE.has(old.status) && old.id !== n.id) { old.status = 'superseded'; add.supersedes.push(old.id); }
    }
    q.push(add);
  }
  return settleParents(q);
}
function settleParents(q: EditIntentT[]): EditIntentT[] {
  for (const parent of q.filter((i) => i.propertyKey.startsWith('group:'))) {
    const kids = q.filter((c) => c.parentIntentId === parent.id);
    if (kids.length && kids.every((c) => c.status === 'superseded' || c.status === 'removed')) parent.status = kids.every((c) => c.status === 'removed') ? 'removed' : 'superseded';
    else if (kids.length && parent.status === 'superseded') parent.status = 'queued';
  }
  return q;
}
/** Restore a superseded intent: it becomes queued again (restoredAt stamped) and the intent that replaced it is superseded in turn. */
export function restore(queue: readonly EditIntentT[], id: string, now: () => string = () => new Date().toISOString()): Result<EditIntentT[]> {
  const q = queue.map((i) => ({ ...i }));
  const target = q.find((i) => i.id === id);
  if (!target || target.status !== 'superseded') return fail([issue('EM-9003', 'Only a replaced pick can be restored.', 'block', 'id')]);
  const ids = target.parentIntentId === undefined && target.propertyKey.startsWith('group:') ? q.filter((c) => c.parentIntentId === target.id).map((c) => c.id) : [target.id];
  for (const kidId of ids) {
    const kid = q.find((i) => i.id === kidId)!;
    for (const other of q) if (other.propertyKey === kid.propertyKey && other.id !== kid.id && ACTIVE.has(other.status)) { other.status = 'superseded'; }
    kid.status = 'queued'; kid.restoredAt = now();
  }
  target.status = 'queued'; target.restoredAt = now();
  return ok(settleParents(q));
}
export function remove(queue: readonly EditIntentT[], id: string): Result<EditIntentT[]> {
  const q = queue.map((i) => ({ ...i }));
  const t = q.find((i) => i.id === id);
  if (!t) return fail([issue('EM-9003', 'Pick not found.', 'block', 'id')]);
  // FR-079: any non-executed item (queued, superseded, rejected, planned, compiled) can be removed; executed items stay in history.
  if (t.status === 'executed' || t.status === 'removed') return fail([issue('EM-2203', 'Applied picks stay in history; use Undo to revert them.', 'block', 'id')]);
  for (const i of q) if (i.id === id || i.parentIntentId === id) if (i.status !== 'executed') i.status = 'removed';
  return ok(settleParents(q));
}
export function clearQueue(queue: readonly EditIntentT[]): EditIntentT[] {
  return queue.map((i) => (i.status === 'queued' || i.status === 'superseded' ? { ...i, status: 'removed' as const } : { ...i }));
}

/** Locked Keys: keys decided by deterministic picks (compiled or executed UI intents that are still current). */
export function lockedKeysFromQueue(queue: readonly EditIntentT[]): string[] {
  return [...new Set(queue.filter((i) => i.source === 'ui' && (i.status === 'compiled' || i.status === 'executed') && !i.needsInterpretation && !i.propertyKey.startsWith('group:') && !i.propertyKey.startsWith('list:'))
    .flatMap((i) => i.propertyKey.split('|')))];
}

/** Compile (§7): the operations for intents that need no interpretation. Children are compiled; parents are skipped. */
export function compileIntents(intents: readonly EditIntentT[], pickOf: (i: EditIntentT) => DesignPick, model: CompositionModelT): Result<OperationT[]> {
  const ops: OperationT[] = [];
  for (const i of intents) {
    if (i.propertyKey.startsWith('group:') || settingsPatchOf(i)) continue;   // settings intents compile to zero ops
    if (i.needsInterpretation) return fail([issue('EM-2303', `Intent ${i.id} needs the Editor Agent.`, 'block', i.id)]);
    const b = opFor(pickOf(i), i.resolvedTargets[0], model);
    if (!b || !b.complete) return fail([issue('EM-2303', `Intent ${i.id} cannot be compiled.`, 'block', i.id)]);
    ops.push({ ...b.op, intentId: i.id });
  }
  return ok(ops);
}
/** Rebuilds the pick an intent came from (intents are persisted; picks are not). */
export function pickFromIntent(i: EditIntentT, extra: Partial<DesignPick> = {}): DesignPick {
  const p = { ...(i.params ?? {}) } as Record<string, unknown>; delete p['targetLabel'];
  const field = p['__field'] as TextField | undefined; const value = p['__value'];
  const output = p['__output'] as DesignPick['output'] | undefined;
  const clipEdit = p['__clipEdit'] as DesignPick['clipEdit'] | undefined;
  const elementEdit = p['__elementEdit'] as DesignPick['elementEdit'] | undefined;
  const splitEdit = p['__splitEdit'] as DesignPick['splitEdit'] | undefined;
  const transformEdit = p['__transformEdit'] as DesignPick['transformEdit'] | undefined;
  const itemsEdit = p['__itemsEdit'] as DesignPick['itemsEdit'] | undefined;
  const text = p['__text'] as string | undefined; const assetId = p['__assetId'] as string | undefined; const playheadMs = p['__playheadMs'] as number | undefined;
  for (const k of Object.keys(p)) if (k.startsWith('__')) delete p[k];
  return { projectId: i.projectId, source: i.source, ...(i.presetId ? { presetId: i.presetId } : {}), ...(field ? { field, value } : {}), ...(output ? { output } : {}), ...(clipEdit ? { clipEdit } : {}), ...(elementEdit ? { elementEdit } : {}),
    ...(splitEdit ? { splitEdit } : {}), ...(transformEdit ? { transformEdit } : {}), ...(itemsEdit ? { itemsEdit } : {}),
    ...(Object.keys(p).length ? { params: p } : {}), ...(text !== undefined ? { text } : {}), ...(assetId ? { assetId } : {}), ...(playheadMs !== undefined ? { playheadMs } : {}), ...extra };
}

/**
 * FR-080: an Editor Chat message as an Edit Intent (source chat, propertyKey `chat:<messageId>`, needsInterpretation true).
 * FR-067: `target` is the element the inspector's "Ask Editor Agent" referenced; otherwise the current selection.
 */
export function chatIntent(input: { projectId: string; messageId: string; text: string; target?: ElementRefT | undefined; selection?: readonly ElementRefT[] | undefined; category?: IntentCategory; baseVersion: string; newId: () => string; now: () => string }): EditIntentT {
  const sel = input.target ? [input.target] : [...(input.selection ?? [])].slice(0, 50);
  return {
    id: input.newId(), projectId: input.projectId, source: 'chat', createdAt: input.now(), category: input.category ?? 'layout', params: {},
    target: input.target ?? (sel.length ? { kind: 'selection' } : { kind: 'project' }), resolvedTargets: sel, propertyKey: `chat:${input.messageId}`,
    propertyClass: 'scalar', needsInterpretation: true, instruction: input.text.slice(0, 2000), status: 'queued', supersedes: [], baseVersion: input.baseVersion,
  };
}
