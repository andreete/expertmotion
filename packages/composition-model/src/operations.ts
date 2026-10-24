// The closed operation vocabulary of docs/AI_WORKFLOW.md §5 in code (41 ops incl. op:audio.setFades, ADR-020).
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
const NamedPosition = z.enum(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
const TextStyle = z.object({
  fontFamily: z.string().min(1).max(100).optional(), fontSize: z.number().min(34).max(400).optional(), weight: z.number().int().min(100).max(900).optional(),
  colour: Hex.optional(), align: z.enum(['left', 'center', 'right']).optional(), opacity: z.number().min(0).max(1).optional(),
}).strict();

export type PropertyClass = 'scalar' | 'list' | 'exclusive-group';
export interface OpDef { args: z.ZodType; targets: readonly TargetKind[] | null; propertyClass: PropertyClass | null; destructive: boolean }
const def = (args: z.ZodRawShape, targets: readonly TargetKind[] | null, propertyClass: PropertyClass | null, destructive = false): OpDef =>
  ({ args: z.object(args).strict(), targets, propertyClass, destructive });

export const OPERATIONS = {
  'op:clip.insert': def({ assetId: z.string(), atIndex: z.number().int().min(0).optional(), trimBeforeMs: ms.optional(), durationMs: dur.optional() }, ['sequence'], 'list'),
  'op:clip.remove': def({}, ['clip'], null, true),
  'op:clip.move': def({ toIndex: z.number().int().min(0) }, ['clip'], null),
  'op:clip.setTrim': def({ trimBeforeMs: ms, durationMs: dur }, ['clip'], 'scalar'),
  'op:clip.setPlaybackRate': def({ rate: z.number().min(0.25).max(4) }, ['clip'], 'scalar'),
  'op:clip.setVolume': def({ volume: z.number().min(0).max(1), fadeInMs: ms.optional(), fadeOutMs: ms.optional() }, ['clip'], 'scalar'),
  'op:clip.setFit': def({ objectFit: z.enum(['cover', 'contain']), crop: z.object({ left: z.number().min(0).max(1), right: z.number().min(0).max(1), top: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }).strict().optional() }, ['clip'], 'scalar'),
  'op:transition.set': def({ presetId: PresetId, durationMs: z.number().int().min(100).max(2000), timing: z.enum(['linear', 'spring']).default('linear'), params: Params.optional() }, ['cut'], 'exclusive-group'),
  'op:transition.clear': def({}, ['cut'], null),
  'op:text.add': def({ text: z.string().min(1).max(500), variant: PresetId, atMs: ms, durationMs: dur, position: z.union([Position, NamedPosition]).optional(), styleOverrides: TextStyle.optional() }, null, 'list'),
  'op:text.setContent': def({ text: z.string().min(1).max(500) }, ['text'], 'scalar'),
  'op:text.setStyle': def(TextStyle.shape, ['text'], 'scalar'),
  'op:text.setEffect': def({ presetId: PresetId, params: Params.optional() }, ['text'], 'exclusive-group'),
  'op:text.setTiming': def({ atMs: ms, durationMs: dur }, ['text'], 'scalar'),
  'op:text.remove': def({}, ['text'], null, true),
  'op:caption.importSrt': def({ assetId: z.string() }, ['project'], null),
  'op:caption.setStyle': def({ presetId: PresetId, params: Params.optional() }, ['project'], 'exclusive-group'),
  'op:caption.setPages': def({ pages: z.array(CaptionPage).max(5000) }, ['project'], 'scalar'),
  'op:caption.clear': def({}, ['project'], null, true),
  'op:background.set': def({ presetId: PresetId, params: Params.optional() }, ['project'], 'exclusive-group'),
  'op:background.clear': def({}, ['project'], null),
  'op:motion.set': def({ presetId: PresetId, params: Params.optional() }, ['clip', 'text', 'shape'], 'exclusive-group'),
  'op:motion.clear': def({}, ['clip', 'text', 'shape'], null),
  'op:easing.setDefault': def({ easingId: PresetId }, ['project'], 'scalar'),
  'op:effect.add': def({ presetId: PresetId, params: Params.optional() }, ['clip'], 'list'),
  'op:effect.remove': def({ presetId: PresetId }, ['clip'], null),
  'op:effect.setParams': def({ presetId: PresetId, params: Params }, ['clip'], 'scalar'),
  'op:shape.add': def({ presetId: PresetId, atMs: ms, durationMs: dur, position: z.union([Position, NamedPosition]).optional(), size: z.number().min(10).max(4000).optional(), fill: Hex.optional(), stroke: Hex.optional(), strokeWidth: z.number().min(0).max(100).optional(), motionId: PresetId.optional(), params: Params.optional() }, null, 'list'),
  'op:shape.remove': def({}, ['shape'], null, true),
  // ADR-020 addition (Stage 3): image overlays (FR-029 "Insert Image", logo/product photo). size = width in u; height follows the image aspect.
  'op:overlay.addImage': def({ assetId: z.string(), atMs: ms, durationMs: dur.optional(), position: z.union([Position, NamedPosition]).optional(), size: z.number().min(10).max(4000).optional(), objectFit: z.enum(['cover', 'contain']).optional(), opacity: z.number().min(0).max(1).optional() }, null, 'list'),
  'op:overlay.remove': def({}, ['image'], null, true),
  'op:audio.addBed': def({ assetId: z.string(), volume: z.number().min(0).max(1).default(0.2), loop: z.boolean().default(true), duckingPresetId: PresetId.optional(), fadeInMs: ms.optional(), fadeOutMs: ms.optional() }, ['project'], 'list'),
  'op:audio.addLayer': def({ assetId: z.string(), atMs: ms, volume: z.number().min(0).max(1), role: z.enum(['voice', 'sfx']).default('voice'), fadeInMs: ms.optional(), fadeOutMs: ms.optional() }, null, 'list'),
  'op:audio.setDucking': def({ presetId: PresetId, params: Params.optional() }, ['audio'], 'exclusive-group'),
  'op:audio.setFades': def({ fadeInMs: ms.optional(), fadeOutMs: ms.optional() }, ['audio'], 'scalar'),
  'op:audio.remove': def({}, ['audio'], null, true),
  'op:theme.set': def({ paletteId: PresetId.optional(), fontPairId: PresetId.optional(), defaultEasingId: PresetId.optional() }, ['project'], 'scalar'),
  'op:theme.setTextDefaults': def(TextStyle.shape, ['project'], 'scalar'),
  'op:output.setRatio': def({ ratio: z.enum(RATIOS), customRatio: z.object({ w: z.number().int().min(1), h: z.number().int().min(1) }).strict().optional() }, ['project'], 'scalar'),
  'op:output.setResolution': def({ preset: z.enum(RESOLUTIONS) }, ['project'], 'scalar'),
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
    case 'op:clip.insert': return a['atIndex'] === undefined ? [] : ['sequence.order'];   // appending shifts no existing cut index
    case 'op:clip.setTrim': return [`${el}.trim`];
    case 'op:clip.setPlaybackRate': return [`${el}.playbackRate`];
    case 'op:clip.setVolume': return [`${el}.volume`, ...fields(['fadeInMs', 'fadeOutMs']).map((f) => `${el}.${f}`)];
    case 'op:clip.setFit': return [`${el}.fit`];
    case 'op:transition.set': case 'op:transition.clear': return [`cut:${t?.index ?? ''}.transition`];
    case 'op:text.setContent': return [`${el}.content`];
    case 'op:text.setStyle': return fields(['fontFamily', 'fontSize', 'weight', 'colour', 'align', 'opacity']).map((f) => `${el}.${f}`);
    case 'op:text.setEffect': return [`${el}.effect`];
    case 'op:text.setTiming': return [`${el}.timing`];
    case 'op:text.remove': case 'op:shape.remove': case 'op:audio.remove': case 'op:overlay.remove': return [el];
    case 'op:caption.importSrt': case 'op:caption.setPages': return ['project.captionPages'];
    case 'op:caption.setStyle': return ['project.captionStyle'];
    case 'op:caption.clear': return ['project.captionStyle', 'project.captionPages'];
    case 'op:background.set': case 'op:background.clear': return ['project.background'];
    case 'op:motion.set': case 'op:motion.clear': return [`${el}.motion`];
    case 'op:easing.setDefault': return ['theme.defaultEasingId'];
    case 'op:effect.add': case 'op:effect.remove': case 'op:effect.setParams': return [`${el}.effects.${String(a['presetId'])}`];
    case 'op:audio.setDucking': return [`${el}.ducking`];
    case 'op:audio.setFades': return fields(['fadeInMs', 'fadeOutMs']).map((f) => `${el}.${f}`);
    case 'op:theme.set': return fields(['paletteId', 'fontPairId', 'defaultEasingId']).map((f) => `theme.${f}`);
    case 'op:theme.setTextDefaults': return fields(['fontFamily', 'fontSize', 'weight', 'colour', 'align', 'opacity']).map((f) => `theme.textDefaults.${f}`);
    case 'op:output.setRatio': return ['project.ratio'];
    case 'op:output.setResolution': return ['project.resolution'];
    case 'op:project.setFps': return ['project.fps'];
    case 'op:project.setDurationPolicy': return ['project.durationPolicy'];
    default: return [];                                         // list additions (text.add, shape.add, audio.add*, generated.insert) touch no existing key
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
