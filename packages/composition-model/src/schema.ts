// Composition Model v2 (v1 + `layer` on visual items and `lane` on audio layers, ADR-027; optional Clip `transform` and overlay
// `scale` / `rotation`, ADR-028; ADR-039 optional Clip `zoom`, AudioLayer `gain` and the OverlayVideo kind, all without a version
// bump: absent = the picture before them): verbatim transcription of docs/DATABASE_SCHEMA.md §4 (the owner). Zod 4 requires a key schema
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
    align: z.enum(['left', 'center', 'right']), opacity: z.number().min(0).max(1), italic: z.boolean().optional(),
  }),
});

export const Position = z.object({ x: z.number(), y: z.number() });   // u, origin = frame centre
export const Size = z.object({ w: z.number(), h: z.number() });       // u
export const Timing = z.object({ atMs: z.number().int().min(0), durationMs: z.number().int().min(100) });
/** ADR-027: one Timeline lane per value; higher = more in front (texts, images, shapes); for audio the row under the video Track (0 = nearest). */
export const Lane = z.number().int().min(0);

export const Motion = z.object({
  presetId: PresetId, durationMs: z.number().int(), delayMs: z.number().int().default(0),
  easingId: PresetId.optional(), exit: z.boolean().default(true), params: Params.default({}),
});
/**
 * ADR-028: where a Clip's picture sits inside the frame. x / y = offset of its centre as a fraction of the frame width / height
 * (0 = centred, 0.5 = moved right / down by half the frame); scale 1 = the objectFit result; rotation in degrees, clockwise.
 * Absent = { x: 0, y: 0, scale: 1, rotation: 0 } (the picture before ADR-028); applyOps removes it again when reset to that.
 */
export const ClipTransform = z.object({ x: z.number().min(-2).max(2), y: z.number().min(-2).max(2), scale: z.number().min(0.1).max(10), rotation: z.number().min(-360).max(360) });
export const IDENTITY_TRANSFORM = Object.freeze({ x: 0, y: 0, scale: 1, rotation: 0 });
/**
 * ADR-039 (Reels punch-ins): a linear zoom of the clip's picture from `from` to `to` across the clip, plus spring pops of
 * `+amount` at `atMs` (clip-relative, ms) that settle back over `durationMs` (default 450). Multiplies `transform.scale`;
 * absent = no zoom (the picture before). applyOps removes it again at the identity (1 → 1 without pops).
 */
export const ZoomPop = z.object({ atMs: z.number().int().min(0), amount: z.number().min(-2).max(2), durationMs: z.number().int().min(50).max(5000).optional() });
export const ClipZoom = z.object({ from: z.number().min(0.1).max(10), to: z.number().min(0.1).max(10), pops: z.array(ZoomPop).max(200).optional() });
/** ADR-028: overlay zoom (1 = `size` as stored) and rotation in degrees; absent = 1 / 0. Position stays `position` (u). */
const OverlayScale = z.number().min(0.05).max(20).optional();
const OverlayRotation = z.number().min(-360).max(360).optional();
export const EffectInstance = z.object({ presetId: PresetId, params: Params.default({}), motion: z.enum(['static', 'in', 'out']).default('static') });

/**
 * ADR-030: a scene clip has no media; it shows a background preset (solid / gradient / animated) for its length on the video
 * Track, so faceless videos get cuts and transitions like any other video. Exactly one of `assetId` or `scene` (CM-001).
 */
export const SceneBackground = z.object({ presetId: PresetId, params: Params.default({}) });
export const Clip = z.object({
  id: z.string(), assetId: z.string().optional(), scene: SceneBackground.optional(),
  trimBeforeMs: z.number().int().min(0), durationMs: z.number().int().min(100),
  playbackRate: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(1).default(1), muted: z.boolean().default(false),
  fadeInMs: z.number().int().min(0).default(0), fadeOutMs: z.number().int().min(0).default(0),
  objectFit: z.enum(['cover', 'contain']).default('cover'),
  crop: z.object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() }).optional(),
  transform: ClipTransform.optional(),
  zoom: ClipZoom.optional(),
  motion: Motion.nullable(),
  effects: z.array(EffectInstance).max(3),
});

export const Transition = z.object({
  cutIndex: z.number().int().min(0), presetId: PresetId, durationMs: z.number().int().min(100).max(2000),
  timing: z.enum(['linear', 'spring']), params: Params.default({}),
});

/** ADR-034: a filled box drawn behind a text (CTA pill, label chip): colour, padding in u, corner radius in u (≥ half the height = pill). */
export const TextBox = z.object({ colour: Hex, padX: z.number().min(0).max(400), padY: z.number().min(0).max(400), radius: z.number().min(0).max(2000) });
export const TextLayer = z.object({
  id: z.string(), variantId: PresetId,
  text: z.string().min(1).max(500),
  timing: Timing, layer: Lane, position: Position, maxWidth: z.number().optional(),
  /** ADR-034: what `position.y` names — the centre of the text box (absent, the picture before) or its top edge. */
  valign: z.enum(['center', 'top']).optional(),
  style: z.object({
    fontFamily: z.string().optional(), fontSize: z.number().optional(), weight: z.number().optional(), colour: Hex.optional(),
    align: z.enum(['left', 'center', 'right']).optional(), opacity: z.number().optional(), italic: z.boolean().optional(),
    /** ADR-034 (optional, absent = before): line height (×font size, default 1.15) and a background box around the text (pill / label). */
    lineHeight: z.number().min(0.8).max(2.5).optional(), box: TextBox.optional(),
  }),
  effect: z.object({ presetId: PresetId, params: Params.default({}) }).nullable(),
  motion: Motion.nullable(),
});

export const OverlayImage = z.object({
  kind: z.literal('image'), id: z.string(), assetId: z.string(), timing: Timing, layer: Lane, position: Position, size: Size,
  objectFit: z.enum(['cover', 'contain']), opacity: z.number(), scale: OverlayScale, rotation: OverlayRotation, motion: Motion.nullable(), effects: z.array(EffectInstance).max(3),
});
export const OverlayShape = z.object({
  kind: z.literal('shape'), id: z.string(), presetId: PresetId, timing: Timing, layer: Lane, position: Position, size: Size,
  fill: Hex, stroke: Hex.optional(), strokeWidth: z.number().optional(), opacity: z.number().min(0).max(1).optional(), scale: OverlayScale, rotation: OverlayRotation, params: Params.default({}), motion: Motion.nullable(),
});
/**
 * ADR-039: a video overlay (face bubble, picture-in-picture still) — a muted (by default) `<Video>` inside a w × h box with a
 * rectangular (`radius` u corners) or circular (`shape: 'circle'`) mask, an optional ring drawn outside the mask (`widthU` u,
 * colour) and an optional `focus`: the SOURCE point (x, y as fractions 0..1 of the source frame) that lands at the box centre,
 * zoomed by `zoom`. `position` is the box centre in u from the frame centre, like every overlay. Absent focus = cover fit.
 */
export const OverlayFocus = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), zoom: z.number().min(0.1).max(10) });
export const OverlayRing = z.object({ colour: Hex, widthU: z.number().min(0).max(200) });
export const OverlayVideo = z.object({
  kind: z.literal('video'), id: z.string(), assetId: z.string(), timing: Timing, layer: Lane, position: Position, size: Size,
  trimBeforeMs: z.number().int().min(0).default(0), muted: z.boolean().default(true), shape: z.enum(['rect', 'circle']).default('rect'),
  radius: z.number().min(0).max(2000).optional(), ring: OverlayRing.optional(), focus: OverlayFocus.optional(),
  opacity: z.number().min(0).max(1).optional(), scale: OverlayScale, rotation: OverlayRotation, motion: Motion.nullable(),
});
export const OverlayElement = z.discriminatedUnion('kind', [OverlayImage, OverlayShape, OverlayVideo]);

export const CaptionToken = z.object({ text: z.string(), fromMs: z.number().int(), toMs: z.number().int() });
export const CaptionPage = z.object({ text: z.string(), startMs: z.number().int(), durationMs: z.number().int(), tokens: z.array(CaptionToken) });
export const CaptionTrack = z.object({
  styleId: PresetId.nullable(), params: Params.default({}), pages: z.array(CaptionPage),
  sourceAssetId: z.string().optional(), language: z.enum(['id', 'en']).optional(),
});

/**
 * ADR-039: a gain segment multiplies the layer's volume by `mul` from `atMs` (COMPOSITION time, ms: a lift "over the silent
 * card" names what is on screen) for `durationMs`, ramping in and out over `rampMs` (default 300). Overlapping segments
 * multiply. Absent / empty = the plain volume (the picture before).
 */
export const GainSegment = z.object({ atMs: z.number().int().min(0), durationMs: z.number().int().min(1), mul: z.number().min(0).max(4), rampMs: z.number().int().min(0).max(10_000).optional() });
export const AudioLayer = z.object({
  id: z.string(), assetId: z.string(), role: z.enum(['bed', 'voice', 'sfx']),
  atMs: z.number().int().min(0), durationMs: z.number().int().min(100).optional(), lane: Lane,
  trimBeforeMs: z.number().int().min(0).default(0), volume: z.number().min(0).max(1), loop: z.boolean().default(false),
  fadeInMs: z.number().int().default(0), fadeOutMs: z.number().int().default(0),
  ducking: z.object({ presetId: PresetId, params: Params.default({}) }).nullable(),
  gain: z.array(GainSegment).max(500).optional(),
});

export const Background = z.object({ presetId: PresetId, params: Params.default({}) });

export const CompositionModel = z.object({
  schemaVersion: z.literal(2),
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
export type SceneBackgroundT = z.infer<typeof SceneBackground>;
export type ClipTransformT = z.infer<typeof ClipTransform>;
export type ClipZoomT = z.infer<typeof ClipZoom>;
export type GainSegmentT = z.infer<typeof GainSegment>;
export type TransitionT = z.infer<typeof Transition>;
export type TextLayerT = z.infer<typeof TextLayer>;
export type OverlayElementT = z.infer<typeof OverlayElement>;
export type OverlayImageT = z.infer<typeof OverlayImage>;
export type OverlayShapeT = z.infer<typeof OverlayShape>;
export type OverlayVideoT = z.infer<typeof OverlayVideo>;
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
  /**
   * FR-261: what is said in a video / audio asset, in SOURCE time (from its last transcription, Generate Captions or the
   * footage read of an Editor run). The composer anchors {say} to it; the Editor envelope shows it so trims follow the story.
   */
  transcript?: { language?: 'id' | 'en'; segments: Array<{ text: string; fromMs: number; toMs: number }>; words?: Array<{ text: string; fromMs: number; toMs: number }> };
}
export type Tier = 'T0' | 'T1' | 'T2';
