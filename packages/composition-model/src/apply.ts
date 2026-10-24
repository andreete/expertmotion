// applyOperations: the only function that changes a Composition Model (BLUEPRINT.md §3.2). Pure: clones its input,
// stops at the first blocking Issue, never touches files. Issue paths are `ops[i]…`; callers prefix the plan step.
import { getPreset, validateParams, type Category } from '@expertmotion/catalogue';
import { fail, issue, ok, type Issue, type Result } from '@expertmotion/shared';
import { OPERATIONS, isOpName, type OperationT } from './operations.js';
import { CompositionModel, type AssetFacts, type AudioLayerT, type CaptionPageT, type ClipT, type CompositionModelT, type MotionT, type PositionT, type TextLayerT, type Tier } from './schema.js';
import { frameInUnits } from './units.js';
import { detectRatio } from './ratio.js';
import { diffModels, type ElementDiff } from './diff.js';

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
    ops.forEach((op, i) => applyOne(m, op, ctx, `ops[${i}]`, warnings));
  } catch (e) {
    if (e instanceof Stop) return fail([e.issue, ...warnings.filter((w) => w.severity === 'block')]);
    throw e;
  }
  const parsed = CompositionModel.safeParse(m);
  if (!parsed.success) return fail(parsed.error.issues.map((i) => issue('EM-2001', `Result is not a valid Composition Model: ${i.message}`, 'block', i.path.join('.'))));
  return ok({ model: parsed.data, diff: diffModels(model, parsed.data) }, warnings);
}

// ───────────────────────────── helpers ─────────────────────────────
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
      if (v.length === 0 && m.settings.autoRatio && as.width && as.height) m.settings.ratio = detectRatio(as.width, as.height);
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
      shiftCutsForRemove(m, i, v.length + 1, warnings, path);
      shiftCutsForInsert(m, a.toIndex);
      v.splice(a.toIndex, 0, clip!);
      return;
    }
    case 'op:clip.setTrim': case 'op:clip.setPlaybackRate': case 'op:clip.setVolume': case 'op:clip.setFit': {
      const c = v[findIndex(v, needTarget(op, path).id, 'clip', path)]!;
      if (op.op === 'op:clip.setTrim') { c.trimBeforeMs = a.trimBeforeMs; c.durationMs = a.durationMs; checkSource(c, asset(ctx, c.assetId, ['video', 'image'], path), `${path}.args`); }
      if (op.op === 'op:clip.setPlaybackRate') { c.playbackRate = a.rate; checkSource(c, asset(ctx, c.assetId, ['video', 'image'], path), `${path}.args.rate`); }
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
      const motion = typeof motionId === 'string' ? motionFrom(motionId, getPreset(motionId)!.defaults as Record<string, unknown>) : null;
      const layer: TextLayerT = { id: ctx.newId(), variantId: a.variant, text: a.text, timing: { atMs: a.atMs, durationMs: a.durationMs }, position, style: { ...(a.styleOverrides ?? {}) }, effect: null, motion };
      m.tracks.text.push(layer);
      return;
    }
    case 'op:text.setContent': case 'op:text.setStyle': case 'op:text.setEffect': case 'op:text.setTiming': case 'op:text.remove': {
      const i = findIndex(m.tracks.text, needTarget(op, path).id, 'text', path);
      const t = m.tracks.text[i]!;
      if (op.op === 'op:text.setContent') t.text = a.text;
      if (op.op === 'op:text.setStyle') t.style = { ...t.style, ...a };
      if (op.op === 'op:text.setEffect') t.effect = { presetId: a.presetId, params: preset(a.presetId, 'texteffect', a.params, ctx, path, warnings) };
      if (op.op === 'op:text.setTiming') t.timing = { atMs: a.atMs, durationMs: a.durationMs };
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
      const motion = typeof motionId === 'string' ? motionFrom(motionId, preset(motionId, 'motion', {}, ctx, path, warnings)) : null;
      m.tracks.overlay.push({ kind: 'shape', id: ctx.newId(), presetId: a.presetId, timing: { atMs: a.atMs, durationMs: a.durationMs }, position: pos, size: { w: Number(size), h: Number(size) }, fill: typeof fill === 'string' ? fill : accent, ...(typeof stroke === 'string' ? { stroke } : {}), ...(Number(strokeWidth) > 0 ? { strokeWidth: Number(strokeWidth) } : {}), params: rest, motion });
      return;
    }
    case 'op:shape.remove': m.tracks.overlay.splice(findIndex(m.tracks.overlay, needTarget(op, path).id, 'shape', path), 1); return;
    case 'op:overlay.addImage': {
      const as = asset(ctx, a.assetId, ['image'], path);
      const w = Number(a.size ?? 480);
      const h = as.width && as.height ? Math.round((w * as.height) / as.width) : w;
      const pos: PositionT = a.position === undefined ? { x: 0, y: 0 } : typeof a.position === 'string' ? namedPosition(m, a.position) : a.position;
      m.tracks.overlay.push({ kind: 'image', id: ctx.newId(), assetId: as.id, timing: { atMs: a.atMs, durationMs: a.durationMs ?? IMAGE_DEFAULT_MS }, position: pos, size: { w, h }, objectFit: a.objectFit ?? 'contain', opacity: a.opacity ?? 1, motion: null, effects: [] });
      return;
    }
    case 'op:overlay.remove': {
      const id = needTarget(op, path).id;
      const i = m.tracks.overlay.findIndex((o) => o.kind === 'image' && o.id === id);
      if (i < 0) stop('EM-2203', `The image ${id ?? '(none)'} no longer exists.`, `${path}.target`);
      m.tracks.overlay.splice(i, 1); return;
    }
    case 'op:audio.addBed': case 'op:audio.addLayer': {
      const as = asset(ctx, a.assetId, ['audio'], path);
      const layer: AudioLayerT = op.op === 'op:audio.addBed'
        ? { id: ctx.newId(), assetId: as.id, role: 'bed', atMs: 0, trimBeforeMs: 0, volume: a.volume, loop: a.loop, fadeInMs: a.fadeInMs ?? 0, fadeOutMs: a.fadeOutMs ?? 0, ducking: a.duckingPresetId ? { presetId: a.duckingPresetId, params: preset(a.duckingPresetId, 'audio', {}, ctx, path, warnings) } : null }
        : { id: ctx.newId(), assetId: as.id, role: a.role, atMs: a.atMs, ...(as.durationMs ? { durationMs: as.durationMs } : {}), trimBeforeMs: 0, volume: a.volume, loop: false, fadeInMs: a.fadeInMs ?? 0, fadeOutMs: a.fadeOutMs ?? 0, ducking: null };
      m.tracks.audio.push(layer);
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
      if (a.kind === 'thumbnail') stop('EM-9004', 'Thumbnails are saved as outputs, not added to the video.', `${path}.args.kind`);
      const as = asset(ctx, job!.assetId ?? '', ['audio'], path);
      m.tracks.audio.push(a.kind === 'music'
        ? { id: ctx.newId(), assetId: as.id, role: 'bed', atMs: 0, trimBeforeMs: 0, volume: 0.2, loop: true, fadeInMs: 1000, fadeOutMs: 1000, ducking: null }
        : { id: ctx.newId(), assetId: as.id, role: 'voice', atMs: a.atMs ?? 0, ...(as.durationMs ? { durationMs: as.durationMs } : {}), trimBeforeMs: 0, volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0, ducking: null });
      return;
    }
  }
}
