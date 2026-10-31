// VideoSpec: the high-level scene description the Editor Agent (or a draft from the Brainstorming Agent) produces for "make a
// video" requests. The deterministic scene composer (auto-motion.ts) turns it into ordinary Composition Model operations, so even a
// weak model gets a professional layout (ADR-034, FR-230 … FR-244, AI_WORKFLOW §8 `scene.compose`).
//
// Two modes in ONE schema: AUTO (only roles + texts given; the composer picks sizes, colours, timing, motion, shapes and
// transitions) and EXPLICIT (the Creator dictated px sizes, weights, hex colours, safe-zone paddings, counters, bar heights,
// easings, frame counts, audio anchors): every explicit value wins, the auto defaults only fill what is left out.
// Sizes in px are px at a 1080-px short side (= layout units u); times in ms or frames (frames use `fps`).
// The composer NEVER invents a figure: numbers, values and sources are rendered only when they are in the spec.
import { z } from 'zod';

const hexRe = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** #RGB or #RRGGBB, any case (normalised to #RRGGBB upper case by the composer). */
export const SpecHex = z.string().regex(hexRe);
const px = (min = 1, max = 2000) => z.number().min(min).max(max);
const ms = z.number().int().min(0).max(600_000);
const frames = z.number().int().min(0).max(18_000);

/** An easing: a name, or cubic-bezier control points [x1, y1, x2, y2] ("bezier(0.2, 0.8, 0.2, 1)" → [0.2, 0.8, 0.2, 1]). */
export const SpecEasing = z.union([
  z.enum(['out-cubic', 'in-out-cubic', 'out-quad', 'in-quad', 'linear', 'back', 'spring', 'spring-soft', 'spring-bouncy']),
  z.tuple([z.number().min(0).max(1), z.number().min(-2).max(3), z.number().min(0).max(1), z.number().min(-2).max(3)]),
]);
export type SpecEasingT = z.infer<typeof SpecEasing>;

/**
 * When something appears, relative to its scene: `{ms}` after the scene starts, or anchored to a voice clip of the scene
 * ("saat v2 mulai" = {clip:"v2"}, "60% durasi v3" = {clip:"v3", pct:0.6}, "setelah v1 selesai" = {clip:"v1", edge:"end"}).
 */
export const SpecAnchor = z.union([
  z.object({ clip: z.string().min(1).max(40), edge: z.enum(['start', 'end']).optional(), pct: z.number().min(0).max(1).optional(), offsetMs: z.number().int().min(-60_000).max(60_000).optional() }).strict(),
  z.object({ ms }).strict(),
  z.object({ frames }).strict(),
  /** FR-261: a moment of the scene's own footage, in SOURCE time ("di detik 12 video" = {footageMs: 12000}). */
  z.object({ footageMs: ms, offsetMs: z.number().int().min(-60_000).max(60_000).optional() }).strict(),
  /** FR-261: when a phrase is spoken in the scene's footage (its transcript; first match inside the scene's window). */
  z.object({ say: z.string().min(1).max(80), edge: z.enum(['start', 'end']).optional(), offsetMs: z.number().int().min(-60_000).max(60_000).optional() }).strict(),
]);
export type SpecAnchorT = z.infer<typeof SpecAnchor>;

const textStyle = {
  sizePx: px(12, 600).optional(), weight: z.number().int().min(100).max(900).optional(), color: SpecHex.optional(), lineHeight: z.number().min(0.8).max(2.5).optional(),
  align: z.enum(['left', 'center', 'right']).optional(), at: SpecAnchor.optional(),
  /** Entrance length and rise distance (px below the final position); 0 rise = fade only. */
  fadeMs: ms.optional(), fadeFrames: frames.optional(), risePx: px(0, 600).optional(),
};
/** A text on screen: a plain string, or the string with explicit style / timing. */
export const SpecText = z.union([z.string().min(1).max(500), z.object({ text: z.string().min(1).max(500), ...textStyle }).strict()]);
export type SpecTextT = z.infer<typeof SpecText>;

export const SpecTone = z.enum(['positive', 'negative', 'warning', 'neutral', 'accent', 'muted', 'text']);
/** A (counting) number. `value` is the FINAL text exactly as shown ("+17,2%", "25,96", "Rp472 triliun"); `from` the start text. */
export const SpecStat = z.object({
  value: z.string().min(1).max(40), from: z.string().min(1).max(40).optional(),
  /** false = no count-up (the number just appears). */
  count: z.boolean().optional(), countMs: ms.optional(), countFrames: frames.optional(), easing: SpecEasing.optional(),
  sizePx: px(12, 600).optional(), weight: z.number().int().min(100).max(900).optional(), color: SpecHex.optional(), tone: SpecTone.optional(),
  /** Small text before the number on the same line ("US$"), the line under it ("miliar"), the label under that ("nilai ekspor naik"). */
  prefix: SpecText.optional(), unit: SpecText.optional(), label: SpecText.optional(),
  /** A later line under the stat ("setara Rp472 triliun"), usually anchored (pct of a clip). */
  note: SpecText.optional(),
  at: SpecAnchor.optional(), fadeMs: ms.optional(), fadeFrames: frames.optional(), risePx: px(0, 600).optional(),
}).strict();
export type SpecStatT = z.infer<typeof SpecStat>;

/** One bar of a bar chart (vertical: heightPx) or of a horizontal comparison (widthPct of the safe width). */
export const SpecBar = z.object({
  label: z.string().min(1).max(80), value: z.number().optional(), display: z.string().min(1).max(40).optional(),
  heightPx: px(0, 1800).optional(), widthPct: z.number().min(0).max(1).optional(),
  color: SpecHex.optional(), tone: SpecTone.optional(), style: z.enum(['solid', 'dashed']).optional(), borderPx: px(1, 40).optional(),
  valueColor: SpecHex.optional(), caption: SpecText.optional(),
  at: SpecAnchor.optional(), growMs: ms.optional(), growFrames: frames.optional(), easing: SpecEasing.optional(),
}).strict();
export type SpecBarT = z.infer<typeof SpecBar>;

export const SCENE_ROLES = ['hook', 'title', 'body', 'list', 'stat', 'stat-compare', 'bar-chart', 'hbar-compare', 'question', 'quote', 'cta', 'cta-handle', 'split',
  /** FR-261 (the Creator's own footage): full-frame footage with overlays in the thirds; footage on one half + text; footage window + text. */
  'footage', 'footage-split', 'footage-pip',
  /** ADR-039 (Reels talking-head mode, needs `talkingHead`): on-camera cut full screen; designed graphics + speaker bubble; silent card; silent hold; poster end card. */
  'talk', 'explain', 'card', 'hold', 'poster',
  /** ADR-041 (viral explainer from internet assets): one picture or a tilted stack from the Library with arrows / boxes / X marks / chips. */
  'image'] as const;
export type SceneRole = (typeof SCENE_ROLES)[number];
export const FOOTAGE_ROLES: readonly SceneRole[] = ['footage', 'footage-split', 'footage-pip'];
/** ADR-039: roles of the talking-head mode (auto-motion-reels.ts); `talk` / `explain` / `hold` need `talkingHead` cuts. */
export const TALKING_HEAD_ROLES: readonly SceneRole[] = ['talk', 'explain', 'card', 'hold', 'poster'];
export const SPEECH_ROLES: readonly SceneRole[] = ['talk', 'explain'];

/** ADR-039: procedural sound effects (packages/models analysis/sfx.ts `synthSfx`); the Service registers them as audio assets (`ctx.sfxAssets`). */
export const SFX_KINDS = ['whoosh', 'pop', 'click', 'tick', 'ding', 'rise'] as const;
export type SfxKind = (typeof SFX_KINDS)[number];
export const BLOCK_KINDS = ['heading', 'chip', 'tag', 'source', 'icon', 'rows', 'bars', 'day-strip', 'browser-card', 'typing-box', 'note', 'stat', 'text',
  /** ADR-041: full-frame cutaways over the speaker (a Library picture with annotations; a muted video clip). */
  'image', 'video'] as const;
/** ADR-041: blocks that become a full-frame cutaway over the speaker (the bubble is not placed while one is on). */
export const CUTAWAY_KINDS: readonly string[] = ['image', 'video'];
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const ICON_NAMES = ['reactor', 'chip-ai', 'bolt', 'atom', 'data-center', 'shield', 'check', 'sun', 'cloud', 'moon', 'solar-panel', 'factory', 'card-ace', 'qr', 'play', 'globe', 'chat', 'money', 'clock', 'warning'] as const;
export const TAG_TONES = ['info', 'warn', 'opinion', 'illustration'] as const;
const short = (max: number) => z.string().min(1).max(max);
const frac = z.number().min(0).max(1);
/** ADR-041: the annotation kinds drawn over a picture (red #E53935 by default; `label` = a small pill text). */
export const ANNOTATION_KINDS = ['arrow', 'box', 'circle', 'x', 'label'] as const;
/**
 * ADR-041: one mark over a picture. x / y (fractions of the PICTURE box) = the point an arrow points at, the centre of a box /
 * circle / X / label; w / h = the box size (fractions of the picture; default 0.3 × 0.2). `at` = when it appears (scene anchor).
 */
export const SpecAnnotation = z.object({
  kind: z.enum(ANNOTATION_KINDS), x: frac, y: frac, w: frac.optional(), h: frac.optional(),
  text: SpecText.optional(), color: SpecHex.optional(), at: SpecAnchor.optional(),
}).strict();
export type SpecAnnotationT = z.infer<typeof SpecAnnotation>;
export const CHIP_TONES = ['before', 'after', 'warning', 'neutral', 'accent'] as const;
export const CHIP_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
/** ADR-041: a pill in a picture corner ("BEFORE" green, "AFTER" red, a warning amber). */
export const SpecChip = z.object({ text: SpecText, tone: z.enum(CHIP_TONES).optional(), position: z.enum(CHIP_POSITIONS).optional() }).strict();
export type SpecChipT = z.infer<typeof SpecChip>;
/** ADR-041: one picture of an `image` scene (a Library image asset, usually imported from the internet). */
export const SpecImage = z.object({ assetId: z.string().min(1).max(80), label: SpecText.optional(), rotationDeg: z.number().min(-15).max(15).optional(), source: SpecText.optional() }).strict();
export type SpecImageT = z.infer<typeof SpecImage>;
export const IMAGE_LAYOUTS = ['single', 'stack', 'phone', 'side-by-side'] as const;
export const IMAGE_BGS = ['blur', 'paper', 'dark', 'white', 'theme'] as const;
export const IMAGE_PANS = ['zoom-in', 'zoom-out', 'left', 'right', 'none'] as const;
export const FOOTAGE_GRADES = ['none', 'dark-grain', 'warm', 'cold'] as const;
/**
 * ADR-039: one graphic of a talking-head scene. `at` = when it appears ({say: "spoken words"} resolved fuzzily inside the scene's
 * cut, {ms} / {frames} scene-relative); without `at` the block appears at `fallbackMs` or its index × 600 ms. `sfx` overrides the
 * kind's default sound (chip / icon pop, rows rise + pops, progress / typing ticks + ding, tag click).
 */
export const SpecBlock = z.object({
  kind: z.enum(BLOCK_KINDS),
  text: short(300).optional(), sub: short(200).optional(), tone: z.enum([...SpecTone.options, ...TAG_TONES]).optional(),
  at: SpecAnchor.optional(), fallbackMs: ms.optional(), sfx: z.enum(SFX_KINDS).optional(),
  /** icon / chip: an icon name (preset:shape.icon params.icon); accent colour for 2-colour icons. */
  icon: z.enum(ICON_NAMES).optional(), accent: SpecHex.optional(), color: SpecHex.optional(),
  /** rows: panel rows with a letter badge; bars: horizontal bars; day-strip: a 24 h strip with coloured bars. */
  rows: z.array(z.object({ badge: short(3).optional(), title: short(80), sub: short(80).optional(), right: short(24).optional(), rightSub: short(40).optional(), tone: z.enum([...SpecTone.options, ...TAG_TONES]).optional() }).strict()).min(1).max(6).optional(),
  bars: z.array(z.object({ label: short(40), value: z.number().min(0), unit: short(12).optional(), tone: SpecTone.optional() }).strict()).min(1).max(8).optional(),
  hours: z.array(z.number().min(0).max(24)).max(9).optional(),
  strip: z.array(z.object({ label: short(40), fromH: z.number().min(0).max(24), toH: z.number().min(0).max(24), color: SpecHex.optional(), icon: z.enum(ICON_NAMES).optional() }).strict()).min(1).max(8).optional(),
  note: short(160).optional(),
  /** browser-card: a drawn "source clip" card (never claims to be real footage); typing-box: a DM / comment box that types itself. */
  urlText: short(80).optional(), title: short(120).optional(), fromLabel: short(40).optional(), toLabel: short(40).optional(), progress: z.number().min(0).max(1).optional(), caption: short(120).optional(),
  inner: z.enum(['reactor-datacenter', 'none']).optional(), prefixBadge: short(6).optional(), typing: z.boolean().optional(), sendAt: ms.optional(),
  /** stat: the figure as shown ("24 jam"), its label and unit. */
  value: short(40).optional(), label: short(80).optional(), unit: short(30).optional(),
  /** ADR-041 image / video cutaway: the Library asset, marks over a picture, its background / slow pan, the clip's source trim; `ms` = how long (default: until the next block or the cut end). */
  assetId: z.string().min(1).max(80).optional(), annotations: z.array(SpecAnnotation).max(8).optional(), bg: z.enum(IMAGE_BGS).optional(), pan: z.enum(IMAGE_PANS).optional(),
  fromMs: ms.optional(), toMs: ms.optional(), ms: z.number().int().min(300).max(60_000).optional(),
}).strict().superRefine((b, c) => {
  const need = (k: keyof typeof b, when: readonly string[]) => { if (when.includes(b.kind) && b[k] === undefined) c.addIssue({ code: 'custom', message: `${b.kind} block needs ${String(k)}`, path: [k] }); };
  need('text', ['heading', 'chip', 'tag', 'source', 'note', 'text', 'typing-box']);
  need('icon', ['icon']); need('rows', ['rows']); need('bars', ['bars']); need('strip', ['day-strip']); need('value', ['stat']);
  need('assetId', ['image', 'video']);
});
export type SpecBlockT = z.infer<typeof SpecBlock>;
/** ADR-039: a cut of the footage analysis (recording time = master time, ms); the Service fills `talkingHead.cuts` or the composer reads PlanContext. */
export const SpecCut = z.object({
  id: short(40), lineIndex: z.number().int().min(0).optional(), startMs: ms, endMs: ms, text: z.string().max(2000),
  words: z.array(z.object({ text: short(80), fromMs: ms, toMs: ms, conf: z.number().optional() }).strict()).max(400).default([]),
}).strict();
export type SpecCutT = z.infer<typeof SpecCut>;
/** ADR-039: the cover still (POST /projects/:id/cover via plan step `cover.render`): hook word, kicker, line, pills, icons, source, handle. */
export const SpecCover = z.object({
  cutId: short(40).optional(), atMs: ms.optional(),
  /** Which frame of the cut: 'end-of-line' (default; the middle of the last word — the speaker still faces the camera), 'start' (600 ms in), or a master time in ms. */
  frame: z.union([z.enum(['end-of-line', 'start']), ms]).optional(), hookWord: short(40), kicker: short(60).optional(), line: short(120), subline: short(160).optional(),
  pills: z.array(z.object({ text: short(40), tone: z.enum([...SpecTone.options, ...TAG_TONES]).optional() }).strict()).max(5).optional(),
  icons: z.array(z.enum(ICON_NAMES)).max(5).optional(), source: short(160).optional(), handle: short(60),
}).strict();
export type SpecCoverT = z.infer<typeof SpecCover>;
/**
 * FR-261: which part of a video asset a footage scene plays. fromMs / toMs are SOURCE times (the trim); absent = from the start /
 * to the end (the composer keeps the scene inside the asset). volume: the clip's own sound (default 1, 0.2 under a voice-over).
 * focus: where the person / subject is, so overlays keep to the other thirds.
 */
export const SpecFootage = z.object({
  assetId: z.string().min(1).max(80), fromMs: ms.optional(), toMs: ms.optional(),
  volume: z.number().min(0).max(1).optional(), muted: z.boolean().optional(), fit: z.enum(['cover', 'contain']).optional(),
  focus: z.enum(['center', 'left', 'right', 'top', 'bottom']).optional(),
  /** ADR-041: the look of the footage — dark-grain = dimmed 0.5 + vignette + film grain 0.3 (the Satu-Persen look); warm / cold = a colour grade. */
  grade: z.enum(FOOTAGE_GRADES).optional(),
}).strict();
export type SpecFootageT = z.infer<typeof SpecFootage>;
/** FR-261: a lower-third (name + role / place) over footage, shown for `ms` (default 4 s) from `at`. */
export const SpecLowerThird = z.object({ name: SpecText, title: SpecText.optional(), at: SpecAnchor.optional(), ms: z.number().int().min(1000).max(12_000).optional() }).strict();
/** ADR-041 `viral`: near-black, yellow #FFD400 accent, white text, Poppins + Inter, white captions with a dark box in the lower third, sfx on. */
export const MOODS = ['editorial', 'energetic', 'calm', 'serious', 'playful', 'tech', 'luxury', 'friendly', 'dramatic', 'viral'] as const;

export const SpecScene = z.object({
  role: z.enum(SCENE_ROLES),
  /** Voice clip ids played in this scene, in order (see VideoSpec.voice.clips). */
  clips: z.array(z.string().min(1).max(40)).max(12).optional(),
  /** Length hint without clips; with clips the length follows them (Σ clips + gaps + tail + holdMs). */
  durationMs: z.number().int().min(800).max(120_000).optional(),
  holdMs: ms.optional(), gapMs: ms.optional(), tailMs: ms.optional(),
  /** Spoken text of this scene when there are no clips (estimated at ~150 words / minute for the scene length). */
  narration: z.string().max(2000).optional(),
  kicker: SpecText.optional(), headline: SpecText.optional(), sub: SpecText.optional(),
  bullets: z.array(SpecText).max(6).optional(),
  stats: z.array(SpecStat).max(3).optional(),
  bars: z.array(SpecBar).max(8).optional(), barGapPx: px(0, 400).optional(), barWidthPx: px(8, 1600).optional(), barHeightPx: px(8, 400).optional(),
  note: SpecText.optional(), noteTone: SpecTone.optional(),
  quote: SpecText.optional(), attribution: SpecText.optional(),
  handle: SpecText.optional(), action: SpecText.optional(), button: SpecText.optional(),
  pill: z.object({ color: SpecHex.optional(), padXPx: px(0, 300).optional(), padYPx: px(0, 300).optional(), radiusPx: px(0, 999).optional() }).strict().optional(),
  keywords: z.array(z.string().min(1).max(40)).max(6).optional(),
  mood: z.enum(MOODS).optional(),
  /** An image asset id for the split layout (only ids from the project's assets). */
  assetId: z.string().min(1).max(80).optional(),
  /** FR-261: footage roles — the video asset and its trim; `overlay` = where texts go over full-frame footage; `side` = footage half / window side. */
  footage: SpecFootage.optional(), lowerThird: SpecLowerThird.optional(),
  overlay: z.enum(['auto', 'lower-third', 'top', 'callout', 'none']).optional(), side: z.enum(['left', 'right', 'top', 'bottom']).optional(),
  /** Source line of a data scene, visible for the whole scene ("Sumber: …"). Required in spirit for every figure. */
  source: SpecText.optional(),
  /** Explicit top of the content block in px from the safe-area top (e.g. 280 for "sekitar 280px dari atas area aman"). */
  topPx: px(0, 3000).optional(),
  /** ADR-039 talking-head roles: the cut id (talk / explain), punch-in zoom and spoken-word pops (talk), the speaker bubble (explain), graphics blocks. */
  cut: z.string().min(1).max(40).optional(),
  zoom: z.object({ from: z.number().min(1).max(3), to: z.number().min(1).max(3) }).strict().optional(),
  pops: z.array(z.object({ say: z.string().min(1).max(80), amount: z.number().min(0).max(1).optional() }).strict()).max(8).optional(),
  bubble: z.object({ sizeU: px(120, 600).optional(), ringColour: SpecHex.optional(), ringWidthU: px(0, 40).optional(), topU: px(0, 1900).optional(), focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), zoom: z.number().min(0.2).max(3) }).strict().optional() }).strict().optional(),
  heading: SpecText.optional(), blocks: z.array(SpecBlock).max(10).optional(),
  /** card: music lift over the silent card (default music.liftOverSilent); tag under the card ("ilustrasi · bukan cuplikan asli"). */
  musicLift: z.number().min(1).max(3).optional(), tag: SpecText.optional(),
  /** poster: the Creator's image asset shown unchanged at `scale` of the frame width with `handle` under it. */
  imageAssetId: z.string().min(1).max(80).optional(), scale: z.number().min(0.3).max(1).optional(),
  /** ADR-041 `image` role: 1 picture (single / phone) or 2–4 (stack / side-by-side), its background, slow pan, marks, corner chips and a one-line caption (shown only when captions are off). */
  images: z.array(SpecImage).min(1).max(4).optional(), layout: z.enum(IMAGE_LAYOUTS).optional(), bg: z.enum(IMAGE_BGS).optional(), pan: z.enum(IMAGE_PANS).optional(),
  annotations: z.array(SpecAnnotation).max(8).optional(), chips: z.array(SpecChip).max(4).optional(), caption: SpecText.optional(),
}).strict().superRefine((s, c) => {
  if (s.role === 'image' && !s.images?.length) c.addIssue({ code: 'custom', message: 'image scene needs images: [{assetId}] (1–4 Library pictures)', path: ['images'] });
});
export type SpecSceneT = z.infer<typeof SpecScene>;
/** ADR-041: a channel logo over the whole video (default top-center, 220 u wide, opacity 0.9). */
export const SpecWatermark = z.object({ assetId: z.string().min(1).max(80), position: z.enum(['top-center', 'top-left', 'top-right', 'bottom-right']).optional(), widthU: z.number().min(120).max(600).optional(), opacity: z.number().min(0.3).max(1).optional() }).strict();
export type SpecWatermarkT = z.infer<typeof SpecWatermark>;
export const TITLE_STYLES = ['boxed', 'highlight', 'plain'] as const;
/** ADR-039: the footage source of the talking-head mode; the composer also reads the analysis from its context (`footageAnalysis`). */
export const SpecTalkingHead = z.object({
  masterAssetId: z.string().min(1).max(80).optional(), voiceAssetId: z.string().min(1).max(80).optional(), analysisId: z.string().min(1).max(80).optional(),
  offsetMs: z.number().int().min(-600_000).max(600_000).optional(), cuts: z.array(SpecCut).max(60).optional(),
}).strict();

export const SpecVoiceClip = z.object({
  id: z.string().min(1).max(40),
  /** Exactly what is spoken (numbers as words); it may differ from the on-screen text. */
  text: z.string().min(1).max(2000),
  /** A ready audio asset of this clip (then its real duration is used), or a measured duration. */
  assetId: z.string().min(1).max(80).optional(), durationMs: z.number().int().min(100).max(120_000).optional(),
}).strict();

export const VideoSpec = z.object({
  title: z.string().max(200).optional(),
  ratio: z.enum(['16:9', '9:16', '1:1', '4:5']).optional(),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
  language: z.enum(['id', 'en']).optional(),
  mood: z.enum(MOODS).optional(),
  pace: z.enum(['slow', 'medium', 'fast']).optional(),
  maxDurationMs: z.number().int().min(1000).max(1_800_000).optional(),
  style: z.object({
    background: SpecHex.optional(),
    fontFamily: z.enum(['Inter', 'Plus Jakarta Sans', 'Archivo', 'JetBrains Mono']).optional(),
    weights: z.array(z.number().int().min(100).max(900)).max(4).optional(),
    align: z.enum(['left', 'center']).optional(),
    colors: z.object({ text: SpecHex.optional(), muted: SpecHex.optional(), positive: SpecHex.optional(), negative: SpecHex.optional(), warning: SpecHex.optional(), neutral: SpecHex.optional(), accent: SpecHex.optional(), pill: SpecHex.optional() }).strict().optional(),
    /** Content padding in px; the bottom band stays completely empty (platform caption / buttons). */
    safeArea: z.object({ left: px(0, 800).optional(), right: px(0, 800).optional(), top: px(0, 1200).optional(), bottom: px(0, 1200).optional() }).strict().optional(),
    /** Where the source line sits: its bottom edge this many px above the frame bottom (default: the safe bottom). */
    sourceBottomPx: px(0, 1600).optional(),
    transition: z.object({
      /** crossfade-rise = every scene fades in rising from risePx below while the previous one fades out on the same frames. */
      type: z.union([z.enum(['auto', 'crossfade-rise', 'cut']), z.string().regex(/^preset:transition\.[a-z0-9-]+$/)]).optional(),
      ms: ms.optional(), frames: frames.optional(), risePx: px(0, 600).optional(), easing: SpecEasing.optional(),
    }).strict().optional(),
  }).strict().optional(),
  voice: z.object({
    // A7 (review 2026-10-29): clip ids are keys (scene clips, anchors, the voice-first Execute map); a duplicate would drop audio
    clips: z.array(SpecVoiceClip).max(40).superRefine((cs, c) => { const seen = new Set<string>(); cs.forEach((x, i) => { if (seen.has(x.id)) c.addIssue({ code: 'custom', message: `voice clip id "${x.id}" is used twice; give every clip its own id`, path: [i, 'id'] }); seen.add(x.id); }); }),
    /** Pause between clips inside a scene and after the last clip of a scene (defaults 300 / 500 ms). */
    gapMs: ms.optional(), tailMs: ms.optional(),
    /** Voice-over steps for clips without an asset (default true): one tts.generate step per clip. */
    generate: z.boolean().optional(), voiceId: z.string().min(1).max(64).optional(), speed: z.number().min(0.8).max(1.2).optional(),
  }).strict().optional(),
  /** Captions from the voice-over (default false: on-screen texts are already there). ADR-039: an object = karaoke pages from the analysis words. */
  captions: z.union([z.boolean(), z.object({
    from: z.literal('analysis').optional(), keywords: z.array(z.object({ words: z.array(z.string().min(1).max(40)).min(1).max(20), colour: SpecHex }).strict()).max(8).optional(),
    yU: px(0, 1900).optional(), fontSizeU: px(34, 140).optional(), maxWords: z.number().int().min(1).max(6).optional(),
  }).strict()]).optional(),
  /** FR-261: caption look for those captions (default preset:caption.karaoke on footage). */
  captionStyle: z.string().regex(/^preset:caption\.[a-z0-9-]+$/).optional(),
  /** FR-266: a background music bed from the CC0 library, best fit for the mood / words, ducked under speech. ADR-039: `trackId` / `assetId`, lift over silent scenes, fades. */
  music: z.object({ mood: z.string().min(1).max(40).optional(), prompt: z.string().min(1).max(200).optional(), volume: z.number().min(0.02).max(1).optional(),
    trackId: z.string().min(1).max(80).optional(), assetId: z.string().min(1).max(80).optional(), liftOverSilent: z.number().min(1).max(3).optional(), fadeInMs: ms.optional(), fadeOutMs: ms.optional() }).strict().optional(),
  /** ADR-039 talking-head mode: the footage, the cover still, the sound effects and where the source tags sit; `credits` lines go to the render's CREDITS.txt. */
  talkingHead: SpecTalkingHead.optional(),
  cover: SpecCover.optional(),
  sfx: z.object({ enabled: z.boolean().optional(), level: z.number().min(0).max(1).optional() }).strict().optional(),
  sourceTagYU: px(0, 1900).optional(),
  credits: z.array(z.string().min(1).max(300)).max(40).optional(),
  /** ADR-041: a channel logo over the whole video; the look of hook / title headlines (boxed = solid boxes behind the scene keywords, the default for mood viral). */
  watermark: SpecWatermark.optional(), titleStyle: z.enum(TITLE_STYLES).optional(),
  scenes: z.array(SpecScene).min(1).max(20),
}).strict().superRefine((s, c) => {
  if (!s.talkingHead) s.scenes.forEach((x, i) => { if (SPEECH_ROLES.includes(x.role) || x.role === 'hold') c.addIssue({ code: 'custom', message: `role ${x.role} needs talkingHead (the footage analysis) at the spec top`, path: ['scenes', i, 'role'] }); });
  else s.scenes.forEach((x, i) => { if (SPEECH_ROLES.includes(x.role) && !x.cut) c.addIssue({ code: 'custom', message: `${x.role} scene needs cut (a cut id of the analysis)`, path: ['scenes', i, 'cut'] }); });
});
export type VideoSpecT = z.infer<typeof VideoSpec>;
/** Alias used in AI_WORKFLOW §8 and the prompts. */
export const SceneSpec = VideoSpec;
export type SceneSpecT = VideoSpecT;

/** Compact signature shown to the Editor Agent (capabilities.stepTools['scene.compose']). Keep in sync with the schema above. */
export const SCENE_COMPOSE_SIGNATURE =
  'args = VideoSpec {title?, ratio?, mood?: editorial|energetic|calm|serious|playful|tech|luxury|friendly|dramatic|viral, titleStyle?: boxed|highlight|plain, style?: {background?: #hex, fontFamily?: Inter|…, colors?: {text, muted, positive, negative, warning, neutral, accent, pill}, safeArea?: {left, right, top, bottom} px, sourceBottomPx?, transition?: {type: auto|crossfade-rise|cut|preset id, ms|frames, risePx, easing}}, ' +
  'voice?: {clips: [{id, text (spoken words), assetId?, durationMs?}], gapMs?, tailMs?}, captions?: bool, captionStyle?: preset:caption.* (preset:caption.emphasis = centred kinetic words, the scene keywords large italic serif), music?: {mood?: calm|upbeat|corporate|cinematic|…, prompt?, volume?}, watermark?: {assetId (an IMAGE asset, the channel logo), position?: top-center|top-left|top-right|bottom-right, widthU?: 120..600, opacity?}, ' +
  'scenes: [{role: hook|title|body|list|stat|stat-compare|bar-chart|hbar-compare|question|quote|cta|cta-handle|split|footage|footage-split|footage-pip|image, clips?: [clip ids], durationMs?, holdMs?, narration?, ' +
  'footage?: {assetId (a VIDEO asset), fromMs?, toMs? (source trim), volume?, muted?, fit?: cover|contain, focus?: center|left|right|top|bottom, grade?: none|dark-grain|warm|cold} (roles footage|footage-split|footage-pip), lowerThird?: {name, title?, at?, ms?}, overlay?: auto|lower-third|top|callout|none, side?: left|right|top|bottom, ' +
  'images?: [{assetId (an IMAGE asset from the Library), label?, rotationDeg?: -15..15, source?}] (role image: 1 = single, 2–4 = stack), layout?: single|stack|phone|side-by-side, bg?: blur|paper|dark|white|theme, pan?: zoom-in|zoom-out|left|right|none, ' +
  'annotations?: [{kind: arrow|box|circle|x|label, x, y (0..1 fractions of the picture box; an arrow points at x,y), w?, h?, text?, color?: #hex (default red), at?}], chips?: [{text, tone?: before|after|warning|neutral|accent, position?: top-left|top-right|bottom-left|bottom-right}], caption? (one white line under the picture, shown when captions are off), ' +
  'kicker?, headline?, sub?, bullets?: [], stats?: [{value: "+17,2%", from?: "+0,0%", countMs|countFrames?, easing?, prefix?: "US$", unit?: "miliar", label?, note?, tone?: positive|negative|warning|neutral, sizePx?, weight?, color?, at?}], ' +
  'bars?: [{label, value?, display?: "25,96", heightPx? (vertical) | widthPct? (horizontal 0..1), style?: solid|dashed, tone?|color?, caption?, at?, growMs|growFrames?, easing?}], barGapPx?, note?, noteTone?, quote?, attribution?, handle?, action?, button?, keywords?, assetId?, source?, topPx?}]}. ' +
  'A text is "string" or {text, sizePx?, weight?, color?, lineHeight?, at?, fadeMs|fadeFrames?, risePx?}; at = {clip: "v2", edge?: start|end, pct?: 0..1, offsetMs?} | {ms} | {frames} | {footageMs} (source time of the scene footage) | {say: "phrase"} (when the footage speaker says it); easing = name or [x1,y1,x2,y2]. Never invent numbers or sources.';

/** ADR-039: appended to `capabilities.sceneCompose` when the project has a footage analysis (talking-head Reels mode). */
export const TALKING_HEAD_SIGNATURE =
  'TALKING-HEAD MODE (the project has a footage analysis: envelope.footageAnalysis lists the cuts): set talkingHead: {} (the app fills the master and the cuts) and use ONE scene per cut, in cut order, with roles ' +
  'talk {cut: "<cut id>", zoom?: {from, to}, pops?: [{say, amount?}], blocks?} (the speaker full screen with a slow punch-in; chips pop on spoken words), ' +
  'explain {cut, heading, blocks: Block[], source?, bubble?: {sizeU, ringColour, ringWidthU, topU, focus}} (full-page graphics, the speaker in a round bubble at the bottom), ' +
  'card {durationMs: 3000, heading?, blocks, tag?: "ilustrasi · bukan cuplikan asli", musicLift?} (silent drawn card for a source clip you do not have), hold {durationMs: 1200} (silent continuation of the previous graphics), ' +
  'poster {imageAssetId, scale?: 0.78, handle, durationMs: 3500} (last). Block = {kind: heading|chip|tag|source|icon|rows|bars|day-strip|browser-card|typing-box|note|stat|text|image|video, text?, icon?, tone?, rows?: [{badge?, title, sub?, right?, rightSub?, tone?}], bars?: [{label, value, display?, unit?}], strip?: [{label, fromH, toH}], hours?, urlText?, title?, progress?, caption?, prefixBadge?, sendAt?, value?, label?, unit?, at?: {say: "words of the cut"} | {ms}, sfx?: whoosh|pop|click|tick|ding|rise}. ' +
  'CUTAWAYS (ADR-041): a block {kind: "image", assetId (a Library picture, e.g. an imported article picture or screenshot), annotations?: [{kind: arrow|box|circle|x|label, x, y, w?, h?, text?}], bg?: blur|paper|dark, pan?, at, ms?} or {kind: "video", assetId (a Library clip), fromMs?, toMs?, at, ms?} covers the whole frame over the speaker from its anchor for ms (default: until the next block or the cut end); the speaker keeps talking, the bubble is hidden under it. ' +
  'Also: cover {cutId, frame?: "end-of-line" (default: inside the last word, eyes still on the camera) | "start" | ms, hookWord, kicker?, line, subline?, pills?: [{text, tone}], icons?, source?, handle}, captions: {from: "analysis", keywords: [{words, colour}], yU?: 1455, fontSizeU?: 68, maxWords?: 3}, music: {trackId?, volume?: 0.3, liftOverSilent?: 1.5, fadeInMs?: 500, fadeOutMs?: 2500}, sfx: {enabled: true, level: 0.55}, sourceTagYU?: 1285, credits?: ["source lines for CREDITS.txt"]. ' +
  'Facts, figures and sources only from the approved PRD; every number carries a source block or scene.source.';

/**
 * Deterministic repair of unambiguous slips a model makes in a VideoSpec (numbers sent as strings, "frames" spelled as
 * "durationFrames", colours without "#", bezier written as a string, a single scene object instead of a list, role aliases).
 * Everything else is left for validation, whose message goes back to the model.
 */
export function normalizeVideoSpec(raw: unknown): { value: unknown; fixes: string[] } {
  const fixes: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(raw)) return { value: raw, fixes };
  const roleAlias: Record<string, string> = { 'stat-counter': 'stat', counter: 'stat', number: 'stat', 'big-number': 'stat', stats: 'stat-compare', compare: 'stat-compare', 'stat-comparison': 'stat-compare',
    chart: 'bar-chart', bars: 'bar-chart', 'bar': 'bar-chart', 'vertical-bars': 'bar-chart', 'hbar': 'hbar-compare', 'horizontal-bars': 'hbar-compare', 'bar-compare': 'hbar-compare',
    video: 'footage', broll: 'footage', 'b-roll': 'footage', 'talking-head': 'footage', clip: 'footage', 'full-footage': 'footage', 'footage-full': 'footage', 'footage-overlay': 'footage',
    pip: 'footage-pip', 'picture-in-picture': 'footage-pip', 'footage-window': 'footage-pip', 'split-footage': 'footage-split', 'footage-text': 'footage-split', 'video-split': 'footage-split',
    intro: 'hook', opening: 'hook', closing: 'cta', outro: 'cta', handle: 'cta-handle', follow: 'cta-handle', bullet: 'list', bullets: 'list', tips: 'list', text: 'body', content: 'body', 'image-text': 'split',
    // ADR-041: `image` is its own role now (a picture / stack with annotations); a picture WITH texts beside it is still `split`
    picture: 'image', pictures: 'image', photo: 'image', foto: 'image', gambar: 'image', screenshot: 'image', 'tangkapan-layar': 'image', collage: 'image', stack: 'image', images: 'image', 'image-stack': 'image' };
  // ADR-041: annotation kinds, chip tones, layouts, backgrounds, pans, grades and watermark positions a model is likely to spell differently
  const kindAlias: Record<string, string> = { arrow: 'arrow', pointer: 'arrow', panah: 'arrow', box: 'box', rect: 'box', rectangle: 'box', frame: 'box', highlight: 'box', 'highlight-box': 'box', kotak: 'box', circle: 'circle', ring: 'circle', oval: 'circle', lingkaran: 'circle', x: 'x', 'x-mark': 'x', cross: 'x', wrong: 'x', cancel: 'x', silang: 'x', label: 'label', text: 'label', pill: 'label', tag: 'label', chip: 'label' };
  const toneAlias: Record<string, string> = { before: 'before', sebelum: 'before', dulu: 'before', green: 'before', positive: 'before', after: 'after', sesudah: 'after', sekarang: 'after', red: 'after', negative: 'after', warning: 'warning', warn: 'warning', amber: 'warning', yellow: 'warning', peringatan: 'warning', neutral: 'neutral', grey: 'neutral', gray: 'neutral', muted: 'neutral', accent: 'accent', opinion: 'accent', info: 'neutral' };
  const layoutAlias: Record<string, string> = { single: 'single', one: 'single', satu: 'single', stack: 'stack', stacked: 'stack', collage: 'stack', tilted: 'stack', pile: 'stack', tumpuk: 'stack', phone: 'phone', mobile: 'phone', screenshot: 'phone', hp: 'phone', 'side-by-side': 'side-by-side', 'side by side': 'side-by-side', two: 'side-by-side', pair: 'side-by-side', columns: 'side-by-side', 'two-columns': 'side-by-side', berdampingan: 'side-by-side' };
  const bgAlias: Record<string, string> = { blur: 'blur', blurred: 'blur', 'blurred-image': 'blur', 'blur-image': 'blur', buram: 'blur', paper: 'paper', kertas: 'paper', crumpled: 'paper', dark: 'dark', black: 'dark', gelap: 'dark', hitam: 'dark', white: 'white', light: 'white', putih: 'white', theme: 'theme', tema: 'theme', solid: 'theme' };
  const panAlias: Record<string, string> = { 'zoom-in': 'zoom-in', zoomin: 'zoom-in', zoom: 'zoom-in', in: 'zoom-in', 'ken-burns': 'zoom-in', 'zoom-out': 'zoom-out', zoomout: 'zoom-out', out: 'zoom-out', left: 'left', 'pan-left': 'left', kiri: 'left', right: 'right', 'pan-right': 'right', kanan: 'right', none: 'none', static: 'none', still: 'none', diam: 'none' };
  const gradeAlias: Record<string, string> = { none: 'none', 'dark-grain': 'dark-grain', dark: 'dark-grain', grain: 'dark-grain', darkgrain: 'dark-grain', 'dark-grainy': 'dark-grain', gelap: 'dark-grain', cinematic: 'dark-grain', warm: 'warm', hangat: 'warm', cold: 'cold', cool: 'cold', dingin: 'cold' };
  const wmAlias: Record<string, string> = { 'top-center': 'top-center', 'top-centre': 'top-center', top: 'top-center', 'center-top': 'top-center', 'top-left': 'top-left', 'top-right': 'top-right', 'bottom-right': 'bottom-right', 'bottom-left': 'bottom-right', bottom: 'bottom-right' };
  const enumFix = (out: Record<string, unknown>, key: string, map: Record<string, string>, path: string) => {
    const v = out[key]; if (typeof v !== 'string') return;
    const n = v.trim().toLowerCase().replace(/[\s_]+/g, '-'), to = map[n] ?? map[n.replace(/-/g, ' ')];
    if (to && to !== v) { fixes.push(`${path}.${key} ${v} → ${to}`); out[key] = to; }
  };
  const numKeys = /^(sizePx|weight|lineHeight|fadeMs|fadeFrames|risePx|countMs|countFrames|heightPx|widthPct|borderPx|growMs|growFrames|durationMs|holdMs|gapMs|tailMs|barGapPx|barWidthPx|barHeightPx|topPx|ms|frames|offsetMs|pct|value|left|right|top|bottom|sourceBottomPx|padXPx|padYPx|radiusPx|fps|speed|maxDurationMs|fromMs|toMs|footageMs|volume|sizeU|ringWidthU|topU|yU|fontSizeU|maxWords|liftOverSilent|scale|musicLift|amount|progress|sendAt|fromH|toH|startMs|endMs|level|lineIndex|sourceTagYU|fallbackMs|rotationDeg|x|y|w|h|widthU|opacity)$/;
  const walk = (v: unknown, path: string, key: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, key));
    if (isObj(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        let kk = k;
        if (k === 'durationFrames' && path.endsWith('transition')) kk = 'frames';
        if (k === 'colour' && !path.includes('.keywords[')) kk = 'color';            // ADR-039: caption keyword groups keep `colour` (the caption preset's param name)
        if (/\.(annotations)\[\d+\]$/.test(path) && (k === 'type' || k === 'shape')) kk = 'kind';   // ADR-041: {type: "arrow"} → {kind: "arrow"}
        if (/\.(images)\[\d+\]$/.test(path) && (k === 'rotation' || k === 'rotate' || k === 'tilt')) kk = 'rotationDeg';
        if (/\.(images)\[\d+\]$/.test(path) && (k === 'id' || k === 'asset' || k === 'imageAssetId')) kk = 'assetId';
        if (kk !== k) fixes.push(`${path}.${k} → ${kk}`);
        out[kk] = walk(x, `${path}.${kk}`, kk);
      }
      if (typeof out['role'] === 'string') {
        const r = out['role'].trim().toLowerCase().replace(/[\s_]+/g, '-');
        const to = roleAlias[r] ?? r;
        if (to !== out['role']) { fixes.push(`${path}.role ${String(out['role'])} → ${to}`); out['role'] = to; }
      }
      // ADR-041: an image scene written with one assetId (or images as a list of ids) instead of images: [{assetId}]
      if (out['role'] === 'image') {
        if (Array.isArray(out['images'])) { const list = out['images'] as unknown[]; const imgs = list.map((x) => (typeof x === 'string' ? { assetId: x } : x)); if (imgs.some((x, i) => x !== list[i])) fixes.push(`${path}.images: ids → [{assetId}]`); out['images'] = imgs; }
        else if (typeof out['assetId'] === 'string' || typeof out['imageAssetId'] === 'string') { out['images'] = [{ assetId: out['assetId'] ?? out['imageAssetId'] }]; delete out['assetId']; delete out['imageAssetId']; fixes.push(`${path}.assetId → images[0].assetId`); }
        enumFix(out, 'layout', layoutAlias, path); enumFix(out, 'bg', bgAlias, path); enumFix(out, 'pan', panAlias, path);
      }
      if (/\.annotations\[\d+\]$/.test(path)) {
        enumFix(out, 'kind', kindAlias, path);
        // fractions written as percentages ("45" / "45%") → 0.45
        for (const k of ['x', 'y', 'w', 'h']) { const n = out[k]; if (typeof n === 'number' && n > 1 && n <= 100) { fixes.push(`${path}.${k}: ${n} → ${n / 100}`); out[k] = n / 100; } }
      }
      if (/\.chips\[\d+\]$/.test(path)) {
        enumFix(out, 'tone', toneAlias, path);
        if (out['tone'] === undefined) { const t = typeof out['text'] === 'string' ? out['text'] : isObj(out['text']) ? String(out['text']['text'] ?? '') : ''; const g = /^\s*(before|sebelum|dulu)\b/i.test(t) ? 'before' : /^\s*(after|sesudah|sekarang|kini)\b/i.test(t) ? 'after' : /^\s*(awas|hati-hati|warning|peringatan|hoaks|hoax)\b/i.test(t) ? 'warning' : null; if (g) { fixes.push(`${path}.tone (missing) → ${g}`); out['tone'] = g; } }
      }
      if (path.endsWith('.footage')) enumFix(out, 'grade', gradeAlias, path);
      if (path.endsWith('.watermark')) enumFix(out, 'position', wmAlias, path);
      if (/\.blocks\[\d+\]$/.test(path) && (out['kind'] === 'image' || out['kind'] === 'video')) { enumFix(out, 'bg', bgAlias, path); enumFix(out, 'pan', panAlias, path); if (typeof out['imageAssetId'] === 'string' && out['assetId'] === undefined) { out['assetId'] = out['imageAssetId']; delete out['imageAssetId']; fixes.push(`${path}.imageAssetId → assetId`); } }
      return out;
    }
    if (typeof v === 'string') {
      // ADR-039: inside a rows block `right` is a label ("2030"), not the crop fraction — never coerce text fields of rows / pills
      // ADR-041: the same for images (label, source), chips (text) and annotations (text): "2026" stays a label
      const labelField = /\.(rows|pills|strip|bars|images|chips|annotations)\[\d+\]$/.test(path.slice(0, path.length - key.length - 1)) && /^(right|rightSub|badge|title|sub|label|text|unit|source)$/.test(key);
      if (numKeys.test(key) && key !== 'value' && !labelField && /^-?\d+(\.\d+)?%?$/.test(v.trim())) { const pct = v.trim().endsWith('%'); const n = Number(v.trim().replace('%', '')); const val = pct ? n / 100 : n; fixes.push(`${path}: "${v}" → ${val}`); return val; }
      if (key === 'value' && path.includes('.bars[') && /^-?\d+([.,]\d+)?$/.test(v.trim())) { const n = Number(v.replace(',', '.')); fixes.push(`${path}: "${v}" → ${n}`); return n; }
      if (/(^|\.)(color|background|accent|pill|text|muted|positive|negative|warning|neutral)$/.test(path) && /^[0-9a-fA-F]{6}$/.test(v)) { fixes.push(`${path}: ${v} → #${v}`); return `#${v}`; }
      if (key === 'easing') {
        const m = /^\s*(?:cubic-)?bezier\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*$/i.exec(v);
        if (m) { fixes.push(`${path}: ${v} → [${m.slice(1).join(', ')}]`); return m.slice(1).map(Number); }
        const e = v.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^ease-?/, '').replace(/^easing-?/, '');
        const map: Record<string, string> = { 'out-cubic': 'out-cubic', 'cubic-out': 'out-cubic', 'outcubic': 'out-cubic', 'in-out-cubic': 'in-out-cubic', 'out-quad': 'out-quad', linear: 'linear', spring: 'spring', 'spring-bouncy': 'spring-bouncy', bounce: 'spring-bouncy', 'spring-soft': 'spring-soft', back: 'back', overshoot: 'back' };
        if (map[e] && map[e] !== v) { fixes.push(`${path}: ${v} → ${map[e]}`); return map[e]; }
      }
    }
    return v;
  };
  const value = walk(raw, 'spec', '') as Record<string, unknown>;
  if (isObj(value['scenes'])) { value['scenes'] = [value['scenes']]; fixes.push('spec.scenes: one scene object → list'); }
  return { value, fixes };
}
