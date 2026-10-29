// The closed operation vocabulary of docs/AI_WORKFLOW.md §5 in code (53 ops: ADR-020 additions, ADR-027 element timing/layer,
// ADR-028 split and canvas transform, ADR-030 scenes for videos without media, ADR-033 caption text fixes).
// test/operations.test.ts fails if this table and the document disagree.
import { z } from 'zod';
import { CaptionPage, Hex, PresetId, Position, RATIOS, RESOLUTIONS } from './schema.js';

export const TARGET_KINDS = ['sequence', 'clip', 'cut', 'text', 'caption', 'audio', 'shape', 'image', 'background', 'effect', 'project', 'selection', 'playhead'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const ElementRef = z.object({ kind: z.enum(TARGET_KINDS), id: z.string().optional(), index: z.number().int().min(0).optional() }).strict();
export type ElementRefT = z.infer<typeof ElementRef>;

export const Operation = z.object({
  op: z.string().regex(/^op:[a-z]+\.[a-zA-Z]+$/),
  target: ElementRef.optional(),
  args: z.record(z.string(), z.unknown()),
  intentId: z.string().optional(),
}).strict();
export type OperationT = z.infer<typeof Operation>;

const Params = z.record(z.string(), z.unknown());
const ms = z.number().int().min(0);
const dur = z.number().int().min(100);
const lane = z.number().int().min(0).max(999);                  // ADR-027 layer / audio lane
const NamedPosition = z.enum(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
const TextStyle = z.object({
  fontFamily: z.string().min(1).max(100).optional(), fontSize: z.number().min(16).max(600).optional(), weight: z.number().int().min(100).max(900).optional(),
  italic: z.boolean().optional(), colour: Hex.optional(), align: z.enum(['left', 'center', 'right']).optional(), opacity: z.number().min(0).max(1).optional(),
  lineHeight: z.number().min(0.8).max(2.5).optional(), box: z.object({ colour: Hex, padX: z.number().min(0).max(400), padY: z.number().min(0).max(400), radius: z.number().min(0).max(2000) }).strict().optional(),
}).strict();
/** ADR-034: a motion given with the add op (absent = the automatic default for the element; presetId preset:motion.none = static). */
const MotionArg = z.object({ presetId: PresetId, durationMs: z.number().int().min(100).max(10_000).optional(), delayMs: z.number().int().min(0).max(60_000).optional(),
  easingId: PresetId.optional(), exit: z.boolean().optional(), params: Params.optional() }).strict();
/** ADR-028 overlay zoom / rotation given with an add op (Duplicate / Paste copy them; absent = 1 / 0). */
const OverlayScaleArg = z.number().min(0.05).max(20), RotationArg = z.number().min(-360).max(360);
const EffectArg = z.object({ presetId: PresetId, params: Params.optional() }).strict();
/** Round 2 (QA 2026-10-29: Duplicate / Paste of a video clip lost its look): what a clip copy carries besides media and length.
 *  Absent = the defaults before (volume 1, not muted, no fades, cover, no crop, identity transform, rate 1, no motion, no effects). */
const ClipCrop = z.object({ left: z.number().min(0).max(0.9), right: z.number().min(0).max(0.9), top: z.number().min(0).max(0.9), bottom: z.number().min(0).max(0.9) }).strict();
const ClipLookArgs = {
  volume: z.number().min(0).max(1).optional(), muted: z.boolean().optional(), fadeInMs: z.number().int().min(0).optional(), fadeOutMs: z.number().int().min(0).optional(),
  objectFit: z.enum(['cover', 'contain']).optional(), crop: ClipCrop.optional(),
  transform: z.object({ x: z.number().min(-2).max(2).optional(), y: z.number().min(-2).max(2).optional(), scale: z.number().min(0.1).max(10).optional(), rotation: z.number().min(-360).max(360).optional() }).strict().optional(),
  playbackRate: z.number().min(0.25).max(4).optional(), motion: MotionArg.optional(), effects: z.array(EffectArg).max(3).optional(),
};

export type PropertyClass = 'scalar' | 'list' | 'exclusive-group';
export interface OpDef { args: z.ZodType; targets: readonly TargetKind[] | null; propertyClass: PropertyClass | null; destructive: boolean }
const def = (args: z.ZodRawShape, targets: readonly TargetKind[] | null, propertyClass: PropertyClass | null, destructive = false): OpDef =>
  ({ args: z.object(args).strict(), targets, propertyClass, destructive });

export const OPERATIONS = {
  // FR-261 (footage + auto motion): the clip's sound, fit / crop and frame position can be given at insert (the composer cannot
  // target a clip id it has not created yet); absent = the defaults before (volume 1, cover, no crop, identity transform).
  'op:clip.insert': def({ assetId: z.string(), atIndex: z.number().int().min(0).optional(), trimBeforeMs: ms.optional(), durationMs: dur.optional(), ...ClipLookArgs }, ['sequence'], 'list'),
  'op:clip.remove': def({}, ['clip'], null, true),
  'op:clip.move': def({ toIndex: z.number().int().min(0) }, ['clip'], null),
  'op:clip.setTrim': def({ trimBeforeMs: ms, durationMs: dur }, ['clip'], 'scalar'),
  'op:clip.setPlaybackRate': def({ rate: z.number().min(0.25).max(4) }, ['clip'], 'scalar'),
  'op:clip.setVolume': def({ volume: z.number().min(0).max(1), fadeInMs: ms.optional(), fadeOutMs: ms.optional() }, ['clip'], 'scalar'),
  'op:clip.setFit': def({ objectFit: z.enum(['cover', 'contain']), crop: z.object({ left: z.number().min(0).max(1), right: z.number().min(0).max(1), top: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }).strict().optional() }, ['clip'], 'scalar'),
  'op:transition.set': def({ presetId: PresetId, durationMs: z.number().int().min(100).max(2000), timing: z.enum(['linear', 'spring']).default('linear'), params: Params.optional() }, ['cut'], 'exclusive-group'),
  'op:transition.clear': def({}, ['cut'], null),
  // ADR-034: maxWidth (u), valign (position.y = centre | top), motion and effect at once; without position the text is placed
  // where it overlaps no other text playing at the same time (auto stacking); without motion it gets the variant's default.
  'op:text.add': def({ text: z.string().min(1).max(500), variant: PresetId, atMs: ms, durationMs: dur, position: z.union([Position, NamedPosition]).optional(), styleOverrides: TextStyle.optional(), layer: lane.optional(),
    maxWidth: z.number().min(50).max(4000).optional(), valign: z.enum(['center', 'top']).optional(), motion: MotionArg.optional(), effect: EffectArg.optional() }, null, 'list'),
  // ADR-030 (faceless videos): one scene of a video without media — a title and/or body text for `durationMs`, starting at
  // `atMs` or right after the latest text / image / shape (so consecutive scene ops line up). The project background shows behind.
  // ADR-030 (videos without media): a scene clip (background preset for durationMs) on the video Track with its title / text and
  // the transition from the previous scene; appended unless atIndex is given.
  'op:scene.add': def({ durationMs: z.number().int().min(500).max(120_000), background: PresetId.optional(), backgroundParams: Params.optional(), atIndex: z.number().int().min(0).optional(),
    title: z.string().min(1).max(200).optional(), text: z.string().min(1).max(500).optional(), titleVariant: PresetId.optional(), textVariant: PresetId.optional(), motionId: PresetId.optional(),
    transition: PresetId.optional(), transitionMs: z.number().int().min(100).max(2000).optional(), ...ClipLookArgs }, ['sequence'], 'list'),
  'op:scene.setBackground': def({ presetId: PresetId, params: Params.optional() }, ['clip'], 'scalar'),
  'op:text.setContent': def({ text: z.string().min(1).max(500) }, ['text'], 'scalar'),
  // FR-025: `variant` re-applies a text variant to an existing layer (variantId, variant position; size/weight/align follow the variant).
  'op:text.setStyle': def({ ...TextStyle.shape, variant: PresetId.optional() }, ['text'], 'scalar'),
  'op:text.setEffect': def({ presetId: PresetId, params: Params.optional() }, ['text'], 'exclusive-group'),
  'op:text.setTiming': def({ atMs: ms, durationMs: dur }, ['text'], 'scalar'),
  'op:text.remove': def({}, ['text'], null, true),
  'op:caption.importSrt': def({ assetId: z.string() }, ['project'], null),
  'op:caption.setStyle': def({ presetId: PresetId, params: Params.optional() }, ['project'], 'exclusive-group'),
  'op:caption.setPages': def({ pages: z.array(CaptionPage).max(5000) }, ['project'], 'scalar'),
  'op:caption.clear': def({}, ['project'], null, true),
  // ADR-033 (QA 2026-10-28): fix one caption word without rewriting the track. Address a page with `atMs` (the page whose
  // [startMs, endMs) holds it, else the nearest page within 1500 ms that contains `find`) or `pageIndex` (0-based, the `i` of
  // composition.captions.list in the envelope); neither = first page that contains it. One occurrence unless `all` (all = every occurrence in
  // the addressed page, or in every page without an address). Only the tokens holding the text are re-split over their own span.
  'op:caption.replaceText': def({ find: z.string().min(1).max(200), replace: z.string().max(200), atMs: ms.optional(), pageIndex: z.number().int().min(0).optional(), all: z.boolean().default(false), caseSensitive: z.boolean().default(false) }, ['project'], 'scalar'),
  // ADR-033: the whole text of one page (atMs or pageIndex, exactly one); same start / duration, tokens re-timed over the page.
  'op:caption.editPage': def({ text: z.string().min(1).max(500), atMs: ms.optional(), pageIndex: z.number().int().min(0).optional() }, ['project'], 'scalar'),
  'op:background.set': def({ presetId: PresetId, params: Params.optional() }, ['project'], 'exclusive-group'),
  'op:background.clear': def({}, ['project'], null),
  'op:motion.set': def({ presetId: PresetId, params: Params.optional() }, ['clip', 'text', 'shape'], 'exclusive-group'),
  'op:motion.clear': def({}, ['clip', 'text', 'shape'], null),
  'op:easing.setDefault': def({ easingId: PresetId }, ['project'], 'scalar'),
  'op:effect.add': def({ presetId: PresetId, params: Params.optional() }, ['clip'], 'list'),
  'op:effect.remove': def({ presetId: PresetId }, ['clip'], null),
  'op:effect.setParams': def({ presetId: PresetId, params: Params }, ['clip'], 'scalar'),
  'op:shape.add': def({ presetId: PresetId, atMs: ms, durationMs: dur, position: z.union([Position, NamedPosition]).optional(), size: z.number().min(10).max(4000).optional(), fill: Hex.optional(), stroke: Hex.optional(), strokeWidth: z.number().min(0).max(100).optional(), motionId: PresetId.optional(), params: Params.optional(), layer: lane.optional(),
    height: z.number().min(1).max(4000).optional(), opacity: z.number().min(0).max(1).optional(), motion: MotionArg.optional(), scale: OverlayScaleArg.optional(), rotation: RotationArg.optional() }, null, 'list'),   // ADR-034: height (u) = a w × h box; motion object; scale / rotation as op:element.setTransform (Duplicate / Paste keep them)
  'op:shape.remove': def({}, ['shape'], null, true),
  // ADR-020 addition (Stage 3): image overlays (FR-029 "Insert Image", logo/product photo). size = width in u; height follows the image aspect.
  'op:overlay.addImage': def({ assetId: z.string(), atMs: ms, durationMs: dur.optional(), position: z.union([Position, NamedPosition]).optional(), size: z.number().min(10).max(4000).optional(), objectFit: z.enum(['cover', 'contain']).optional(), opacity: z.number().min(0).max(1).optional(), layer: lane.optional(), motion: MotionArg.optional(), scale: OverlayScaleArg.optional(), rotation: RotationArg.optional() }, null, 'list'),
  'op:overlay.remove': def({}, ['image'], null, true),
  // FR-028 addition (Stage 3): opacity of an overlay image or a Shape on the overlay Track.
  'op:overlay.setOpacity': def({ opacity: z.number().min(0).max(1) }, ['image', 'shape'], 'scalar'),
  // ADR-027 (Timeline drag/trim/lanes): start and length of any text, image, shape or audio layer; optionally its lane at once
  // (one op per Timeline gesture). `trimBeforeMs` (audio only) moves the source offset with a left-edge trim.
  'op:element.setTiming': def({ atMs: ms, durationMs: dur, trimBeforeMs: ms.optional(), layer: lane.optional() }, ['text', 'image', 'shape', 'audio'], 'scalar'),
  // ADR-027: stacking order. Exactly one of `layer` (absolute lane) or `move`; audio has lanes but no stacking (`layer` or up/down only).
  'op:element.setLayer': def({ layer: lane.optional(), move: z.enum(['up', 'down', 'front', 'back']).optional() }, ['text', 'image', 'shape', 'audio'], 'scalar'),
  // ADR-028 (FR-179 cut / split): splits a clip, text, image, shape or audio layer at `atMs` (composition time, ms) into two
  // adjacent parts; the second part gets a new id and continues the source (clip trimBeforeMs + d × playbackRate, audio + d).
  'op:element.split': def({ atMs: ms }, ['clip', 'text', 'image', 'shape', 'audio'], null),
  // ADR-028 (FR-180 canvas transform): picture position / zoom / rotation. x, y = centre offset as a fraction of the frame width /
  // height; scale 1 = the objectFit result (clip, 0.1…10) or the stored size (image / shape, 0.05…20); rotation in degrees.
  'op:element.setTransform': def({ x: z.number().min(-2).max(2).optional(), y: z.number().min(-2).max(2).optional(), scale: z.number().min(0.05).max(20).optional(), rotation: z.number().min(-360).max(360).optional() }, ['clip', 'image', 'shape', 'text'], 'scalar'),   // ADR-034: a text takes x / y only (quality-gate re-flow)
  'op:audio.addBed': def({ assetId: z.string(), volume: z.number().min(0).max(1).default(0.2), loop: z.boolean().default(true), duckingPresetId: PresetId.optional(), duckingParams: Params.optional(), fadeInMs: ms.optional(), fadeOutMs: ms.optional() }, ['project'], 'list'),   // FR-266: duckingParams (e.g. volume / duckTo of preset:audio.duck-voice)
  // Round 2: trimBeforeMs / durationMs / loop / ducking let Duplicate and Paste rebuild a voice / sfx layer exactly (absent = as before).
  'op:audio.addLayer': def({ assetId: z.string(), atMs: ms, volume: z.number().min(0).max(1), role: z.enum(['voice', 'sfx']).default('voice'), fadeInMs: ms.optional(), fadeOutMs: ms.optional(),
    trimBeforeMs: ms.optional(), durationMs: dur.optional(), loop: z.boolean().optional(), ducking: z.object({ presetId: PresetId, params: Params.optional() }).strict().optional() }, null, 'list'),
  'op:audio.setDucking': def({ presetId: PresetId, params: Params.optional() }, ['audio'], 'exclusive-group'),
  'op:audio.setFades': def({ fadeInMs: ms.optional(), fadeOutMs: ms.optional() }, ['audio'], 'scalar'),
  'op:audio.remove': def({}, ['audio'], null, true),
  'op:theme.set': def({ paletteId: PresetId.optional(), fontPairId: PresetId.optional(), defaultEasingId: PresetId.optional() }, ['project'], 'scalar'),
  'op:theme.setTextDefaults': def(TextStyle.shape, ['project'], 'scalar'),
  'op:output.setRatio': def({ ratio: z.enum(RATIOS), customRatio: z.object({ w: z.number().int().min(1), h: z.number().int().min(1) }).strict().optional() }, ['project'], 'scalar'),
  'op:output.setResolution': def({ preset: z.enum(RESOLUTIONS) }, ['project'], 'scalar'),
  // FR-088: Auto ratio on/off as a Composition Version (on = ratio follows the first Clip's probe; a manual setRatio turns it off).
  'op:output.setAutoRatio': def({ on: z.boolean() }, ['project'], 'scalar'),
  'op:project.setFps': def({ fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]) }, ['project'], 'scalar'),
  'op:project.setDurationPolicy': def({ policy: z.enum(['fit-content', 'fixed']), fixedMs: z.number().int().min(1000).max(1_800_000).optional() }, ['project'], 'scalar'),
  'op:generated.insert': def({ kind: z.enum(['voice', 'music', 'thumbnail', 'captions']), jobId: z.string(), atMs: ms.optional() }, ['project'], 'list'),
} as const satisfies Record<string, OpDef>;

export type OpName = keyof typeof OPERATIONS;
export const OP_NAMES = Object.keys(OPERATIONS) as OpName[];
export const isOpName = (v: string): v is OpName => Object.prototype.hasOwnProperty.call(OPERATIONS, v);

/** Property keys an operation writes (AI_WORKFLOW §2/§6). Structural ops return the element key itself. */
export function propertyKeysOf(op: OperationT): string[] {
  const t = op.target, a = op.args as Record<string, unknown>;
  const el = t?.id !== undefined ? `${t.kind}:${t.id}` : t?.index !== undefined ? `${t.kind}:${t.index}` : '';
  const fields = (names: readonly string[]) => names.filter((n) => a[n] !== undefined);
  switch (op.op) {
    case 'op:clip.remove': case 'op:clip.move': return [el, 'sequence.order'];
    case 'op:clip.insert': case 'op:scene.add': return a['atIndex'] === undefined ? [] : ['sequence.order'];   // appending shifts no existing cut index
    case 'op:scene.setBackground': return [`${el}.scene`];
    case 'op:clip.setTrim': return [`${el}.trim`];
    case 'op:clip.setPlaybackRate': return [`${el}.playbackRate`];
    case 'op:clip.setVolume': return [`${el}.volume`, ...fields(['fadeInMs', 'fadeOutMs']).map((f) => `${el}.${f}`)];
    case 'op:clip.setFit': return [`${el}.fit`];
    case 'op:transition.set': case 'op:transition.clear': return [`cut:${t?.index ?? ''}.transition`];
    case 'op:text.setContent': return [`${el}.content`];
    case 'op:text.setStyle': return fields(['fontFamily', 'fontSize', 'weight', 'italic', 'colour', 'align', 'opacity', 'lineHeight', 'box', 'variant']).map((f) => `${el}.${f}`);
    case 'op:text.setEffect': return [`${el}.effect`];
    case 'op:text.setTiming': return [`${el}.timing`];
    case 'op:text.remove': case 'op:shape.remove': case 'op:audio.remove': case 'op:overlay.remove': return [el];
    case 'op:caption.importSrt': case 'op:caption.setPages': return ['project.captionPages'];
    case 'op:caption.setStyle': return ['project.captionStyle'];
    case 'op:caption.clear': return ['project.captionStyle', 'project.captionPages'];
    // ADR-033: only the text of the addressed page (`@<ms>` when addressed by time; `project.captionPages.text` = any page's text).
    case 'op:caption.replaceText': case 'op:caption.editPage':
      return [a['pageIndex'] !== undefined ? `project.captionPages.${Number(a['pageIndex'])}.text` : a['atMs'] !== undefined ? `project.captionPages.@${Number(a['atMs'])}.text` : 'project.captionPages.text'];
    case 'op:background.set': case 'op:background.clear': return ['project.background'];
    case 'op:motion.set': case 'op:motion.clear': return [`${el}.motion`];
    case 'op:easing.setDefault': return ['theme.defaultEasingId'];
    case 'op:effect.add': case 'op:effect.remove': case 'op:effect.setParams': return [`${el}.effects.${String(a['presetId'])}`];
    case 'op:audio.setDucking': return [`${el}.ducking`];
    case 'op:audio.setFades': return fields(['fadeInMs', 'fadeOutMs']).map((f) => `${el}.${f}`);
    case 'op:overlay.setOpacity': return [`${el}.opacity`];
    case 'op:element.setTiming': return [`${el}.timing`, ...(a['layer'] === undefined ? [] : [`${el}.layer`])];
    case 'op:element.setLayer': return [`${el}.layer`];
    // A clip split changes its trim and adds a cut (cut indexes after it shift); other splits change the item's timing.
    case 'op:element.split': return t?.kind === 'clip' ? [`${el}.trim`, 'sequence.order'] : [`${el}.timing`];
    case 'op:element.setTransform': return [`${el}.transform`];
    case 'op:theme.set': return fields(['paletteId', 'fontPairId', 'defaultEasingId']).map((f) => `theme.${f}`);
    case 'op:theme.setTextDefaults': return fields(['fontFamily', 'fontSize', 'weight', 'italic', 'colour', 'align', 'opacity']).map((f) => `theme.textDefaults.${f}`);
    case 'op:output.setRatio': return ['project.ratio'];
    case 'op:output.setResolution': return ['project.resolution'];
    case 'op:output.setAutoRatio': return ['project.ratioAuto'];
    case 'op:project.setFps': return ['project.fps'];
    case 'op:project.setDurationPolicy': return ['project.durationPolicy'];
    default: return [];                                         // list additions (text.add, scene.add, shape.add, audio.add*, generated.insert) touch no existing key
  }
}
export function lockedKeysOf(ops: readonly OperationT[]): string[] {
  return [...new Set(ops.flatMap(propertyKeysOf))];
}
/** A key conflicts with a Locked Key when equal or when one is a prefix path of the other ("text:t1" vs "text:t1.fontSize"). */
export function conflictsWithLocked(keys: readonly string[], locked: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const k of keys) for (const l of locked) if (k === l || l.startsWith(`${k}.`) || k.startsWith(`${l}.`)) hits.add(l);
  // Structural sequence changes shift cut indexes, so they conflict with every locked cut key.
  if (keys.includes('sequence.order')) for (const l of locked) if (l.startsWith('cut:')) hits.add(l);
  return [...hits];
}
