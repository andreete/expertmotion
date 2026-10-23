// Composition Model v1: verbatim transcription of docs/DATABASE_SCHEMA.md §4 (the owner). Zod 4 requires a key schema
// for records, so `z.record(z.unknown())` in the doc is written `z.record(z.string(), z.unknown())` here.
import { z } from 'zod';

export const PresetId = z.string().regex(/^preset:[a-z]+\.[a-z0-9-]+$/);
export const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const Params = z.record(z.string(), z.unknown());

export const RATIOS = ['16:9', '9:16', '1:1', '4:5', '5:4', '4:3', '3:4', 'custom'] as const;
export const RESOLUTIONS = ['720p', '1080p', '2k', '2160p'] as const;
export const FPS_VALUES = [24, 25, 30, 50, 60] as const;

export const ProjectSettings = z.object({
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]),
  ratio: z.enum(RATIOS),
  customRatio: z.object({ w: z.number().int().min(1), h: z.number().int().min(1) }).optional(),
  resolution: z.enum(RESOLUTIONS),
  autoRatio: z.boolean(),
  language: z.enum(['id', 'en']),
});

export const Theme = z.object({
  paletteId: PresetId,
  fontPairId: PresetId,
  defaultEasingId: PresetId,
  textDefaults: z.object({
    fontFamily: z.string().optional(), fontSize: z.number(), weight: z.number(), colour: Hex,
    align: z.enum(['left', 'center', 'right']), opacity: z.number().min(0).max(1),
  }),
});

export const Position = z.object({ x: z.number(), y: z.number() });   // u, origin = frame centre
export const Size = z.object({ w: z.number(), h: z.number() });       // u
export const Timing = z.object({ atMs: z.number().int().min(0), durationMs: z.number().int().min(100) });

export const Motion = z.object({
  presetId: PresetId, durationMs: z.number().int(), delayMs: z.number().int().default(0),
  easingId: PresetId.optional(), exit: z.boolean().default(true), params: Params.default({}),
});
export const EffectInstance = z.object({ presetId: PresetId, params: Params.default({}), motion: z.enum(['static', 'in', 'out']).default('static') });

export const Clip = z.object({
  id: z.string(), assetId: z.string(),
  trimBeforeMs: z.number().int().min(0), durationMs: z.number().int().min(100),
  playbackRate: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(1).default(1), muted: z.boolean().default(false),
  fadeInMs: z.number().int().min(0).default(0), fadeOutMs: z.number().int().min(0).default(0),
  objectFit: z.enum(['cover', 'contain']).default('cover'),
  crop: z.object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() }).optional(),
  motion: Motion.nullable(),
  effects: z.array(EffectInstance).max(3),
});

export const Transition = z.object({
  cutIndex: z.number().int().min(0), presetId: PresetId, durationMs: z.number().int().min(100).max(2000),
  timing: z.enum(['linear', 'spring']), params: Params.default({}),
});

export const TextLayer = z.object({
  id: z.string(), variantId: PresetId,
  text: z.string().min(1).max(500),
  timing: Timing, position: Position, maxWidth: z.number().optional(),
  style: z.object({
    fontFamily: z.string().optional(), fontSize: z.number().optional(), weight: z.number().optional(), colour: Hex.optional(),
    align: z.enum(['left', 'center', 'right']).optional(), opacity: z.number().optional(),
  }),
  effect: z.object({ presetId: PresetId, params: Params.default({}) }).nullable(),
  motion: Motion.nullable(),
});

export const OverlayImage = z.object({
  kind: z.literal('image'), id: z.string(), assetId: z.string(), timing: Timing, position: Position, size: Size,
  objectFit: z.enum(['cover', 'contain']), opacity: z.number(), motion: Motion.nullable(), effects: z.array(EffectInstance).max(3),
});
export const OverlayShape = z.object({
  kind: z.literal('shape'), id: z.string(), presetId: PresetId, timing: Timing, position: Position, size: Size,
  fill: Hex, stroke: Hex.optional(), strokeWidth: z.number().optional(), params: Params.default({}), motion: Motion.nullable(),
});
export const OverlayElement = z.discriminatedUnion('kind', [OverlayImage, OverlayShape]);

export const CaptionToken = z.object({ text: z.string(), fromMs: z.number().int(), toMs: z.number().int() });
export const CaptionPage = z.object({ text: z.string(), startMs: z.number().int(), durationMs: z.number().int(), tokens: z.array(CaptionToken) });
export const CaptionTrack = z.object({
  styleId: PresetId.nullable(), params: Params.default({}), pages: z.array(CaptionPage),
  sourceAssetId: z.string().optional(), language: z.enum(['id', 'en']).optional(),
});

export const AudioLayer = z.object({
  id: z.string(), assetId: z.string(), role: z.enum(['bed', 'voice', 'sfx']),
  atMs: z.number().int().min(0), durationMs: z.number().int().min(100).optional(),
  trimBeforeMs: z.number().int().min(0).default(0), volume: z.number().min(0).max(1), loop: z.boolean().default(false),
  fadeInMs: z.number().int().default(0), fadeOutMs: z.number().int().default(0),
  ducking: z.object({ presetId: PresetId, params: Params.default({}) }).nullable(),
});

export const Background = z.object({ presetId: PresetId, params: Params.default({}) });

export const CompositionModel = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string(),
  settings: ProjectSettings,
  theme: Theme,
  tracks: z.object({
    video: z.array(Clip),
    overlay: z.array(OverlayElement),
    text: z.array(TextLayer),
    caption: CaptionTrack,
    audio: z.array(AudioLayer),
  }),
  transitions: z.array(Transition),
  background: Background.nullable(),
  durationPolicy: z.enum(['fit-content', 'fixed']),
  fixedDurationMs: z.number().int().positive().optional(),
});

export type CompositionModelT = z.infer<typeof CompositionModel>;
export type ProjectSettingsT = z.infer<typeof ProjectSettings>;
export type ThemeT = z.infer<typeof Theme>;
export type ClipT = z.infer<typeof Clip>;
export type TransitionT = z.infer<typeof Transition>;
export type TextLayerT = z.infer<typeof TextLayer>;
export type OverlayElementT = z.infer<typeof OverlayElement>;
export type CaptionPageT = z.infer<typeof CaptionPage>;
export type AudioLayerT = z.infer<typeof AudioLayer>;
export type MotionT = z.infer<typeof Motion>;
export type EffectInstanceT = z.infer<typeof EffectInstance>;
export type PositionT = z.infer<typeof Position>;
export type Ratio = (typeof RATIOS)[number];
export type Resolution = (typeof RESOLUTIONS)[number];

/** Facts about an Asset that pure functions need (no file access). Supplied by apps/service from the `assets` table. */
export interface AssetFacts {
  id: string; kind: 'video' | 'image' | 'audio' | 'subtitle'; status: 'ingesting' | 'ready' | 'failed';
  durationMs?: number; width?: number; height?: number; hasAudio?: boolean; name?: string;
  /** For subtitle assets: pages parsed at ingest (parseSrt/parseVtt + createTikTokStyleCaptions), used by op:caption.importSrt. */
  captionPages?: CaptionPageT[];
}
export type Tier = 'T0' | 'T1' | 'T2';
