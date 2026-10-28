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

export const SCENE_ROLES = ['hook', 'title', 'body', 'list', 'stat', 'stat-compare', 'bar-chart', 'hbar-compare', 'question', 'quote', 'cta', 'cta-handle', 'split'] as const;
export type SceneRole = (typeof SCENE_ROLES)[number];
export const MOODS = ['editorial', 'energetic', 'calm', 'serious', 'playful', 'tech', 'luxury', 'friendly', 'dramatic'] as const;

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
  /** Source line of a data scene, visible for the whole scene ("Sumber: …"). Required in spirit for every figure. */
  source: SpecText.optional(),
  /** Explicit top of the content block in px from the safe-area top (e.g. 280 for "sekitar 280px dari atas area aman"). */
  topPx: px(0, 3000).optional(),
}).strict();
export type SpecSceneT = z.infer<typeof SpecScene>;

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
    clips: z.array(SpecVoiceClip).max(40),
    /** Pause between clips inside a scene and after the last clip of a scene (defaults 300 / 500 ms). */
    gapMs: ms.optional(), tailMs: ms.optional(),
    /** Voice-over steps for clips without an asset (default true): one tts.generate step per clip. */
    generate: z.boolean().optional(), voiceId: z.string().min(1).max(64).optional(), speed: z.number().min(0.8).max(1.2).optional(),
  }).strict().optional(),
  /** Captions from the voice-over (default false: on-screen texts are already there). */
  captions: z.boolean().optional(),
  scenes: z.array(SpecScene).min(1).max(20),
}).strict();
export type VideoSpecT = z.infer<typeof VideoSpec>;
/** Alias used in AI_WORKFLOW §8 and the prompts. */
export const SceneSpec = VideoSpec;
export type SceneSpecT = VideoSpecT;

/** Compact signature shown to the Editor Agent (capabilities.stepTools['scene.compose']). Keep in sync with the schema above. */
export const SCENE_COMPOSE_SIGNATURE =
  'args = VideoSpec {title?, ratio?, mood?: editorial|energetic|calm|serious|playful|tech|luxury|friendly|dramatic, style?: {background?: #hex, fontFamily?: Inter|…, colors?: {text, muted, positive, negative, warning, neutral, accent, pill}, safeArea?: {left, right, top, bottom} px, sourceBottomPx?, transition?: {type: auto|crossfade-rise|cut|preset id, ms|frames, risePx, easing}}, ' +
  'voice?: {clips: [{id, text (spoken words), assetId?, durationMs?}], gapMs?, tailMs?}, scenes: [{role: hook|title|body|list|stat|stat-compare|bar-chart|hbar-compare|question|quote|cta|cta-handle|split, clips?: [clip ids], durationMs?, holdMs?, narration?, ' +
  'kicker?, headline?, sub?, bullets?: [], stats?: [{value: "+17,2%", from?: "+0,0%", countMs|countFrames?, easing?, prefix?: "US$", unit?: "miliar", label?, note?, tone?: positive|negative|warning|neutral, sizePx?, weight?, color?, at?}], ' +
  'bars?: [{label, value?, display?: "25,96", heightPx? (vertical) | widthPct? (horizontal 0..1), style?: solid|dashed, tone?|color?, caption?, at?, growMs|growFrames?, easing?}], barGapPx?, note?, noteTone?, quote?, attribution?, handle?, action?, button?, keywords?, assetId?, source?, topPx?}]}. ' +
  'A text is "string" or {text, sizePx?, weight?, color?, lineHeight?, at?, fadeMs|fadeFrames?, risePx?}; at = {clip: "v2", edge?: start|end, pct?: 0..1, offsetMs?} | {ms} | {frames}; easing = name or [x1,y1,x2,y2]. Never invent numbers or sources.';

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
    intro: 'hook', opening: 'hook', closing: 'cta', outro: 'cta', handle: 'cta-handle', follow: 'cta-handle', bullet: 'list', bullets: 'list', tips: 'list', text: 'body', content: 'body', 'image-text': 'split', image: 'split' };
  const numKeys = /^(sizePx|weight|lineHeight|fadeMs|fadeFrames|risePx|countMs|countFrames|heightPx|widthPct|borderPx|growMs|growFrames|durationMs|holdMs|gapMs|tailMs|barGapPx|barWidthPx|barHeightPx|topPx|ms|frames|offsetMs|pct|value|left|right|top|bottom|sourceBottomPx|padXPx|padYPx|radiusPx|fps|speed|maxDurationMs)$/;
  const walk = (v: unknown, path: string, key: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, key));
    if (isObj(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        let kk = k;
        if (k === 'durationFrames' && path.endsWith('transition')) kk = 'frames';
        if (k === 'colour') kk = 'color';
        if (kk !== k) fixes.push(`${path}.${k} → ${kk}`);
        out[kk] = walk(x, `${path}.${kk}`, kk);
      }
      if (typeof out['role'] === 'string') {
        const r = out['role'].trim().toLowerCase().replace(/[\s_]+/g, '-');
        const to = roleAlias[r] ?? r;
        if (to !== out['role']) { fixes.push(`${path}.role ${String(out['role'])} → ${to}`); out['role'] = to; }
      }
      return out;
    }
    if (typeof v === 'string') {
      if (numKeys.test(key) && key !== 'value' && /^-?\d+(\.\d+)?$/.test(v.trim())) { fixes.push(`${path}: "${v}" → ${Number(v)}`); return Number(v); }
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
