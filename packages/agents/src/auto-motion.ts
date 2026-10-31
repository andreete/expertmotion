// Deterministic scene composer (ADR-034, FR-230 … FR-238): VideoSpec (auto-motion-spec.ts) → ordinary Composition Model
// operations. Layout templates per scene role, non-overlapping positions computed from the frame size and the safe area with the
// shared text estimator (composition-model textGeometry, the same one the Engine renders with), a type hierarchy in layout units,
// shapes placed relative to text bounds, staggered / audio-anchored timing, narration-aware scene lengths, transitions chosen by
// mood (varied, seeded by scene index) or the explicit crossfade-rise of an editorial spec, then the quality gate (qualityCheck +
// autoFixOps). No LLM, no randomness, no invented figures: numbers and sources are rendered only when the spec contains them.
import { getPreset, validateParams } from '@expertmotion/catalogue';
import { applyOperations, autoFixOps, textWidthEm, deriveFrameTiming, framesOf, frameInUnits, qualityCheck, qualityChecklist, safeAreaU, textGeometry, type AssetFacts, type BoxU, type CompositionModelT, type OperationT, type QualityIssue, type Ratio, type TextLayerT, type Tier } from '@expertmotion/composition-model';
import { normalizeVideoSpec, VideoSpec, type SceneRole, type SfxKind, type SpecAnchorT, type SpecBarT, type SpecEasingT, type SpecSceneT, type SpecStatT, type SpecTextT, type VideoSpecT } from './auto-motion-spec.js';

import { findSaid, footageClipArgs, footageSceneMs, footageWindow, isFootageRole, pipBox, splitSide, type FootageWindow } from './auto-motion-footage.js';
import { ANNOTATION_RED, annotationMark, aspectOf, chipBox, chipColours, PHONE_RADIUS_U, PICTURE_RADIUS_U, pictureBoxes, unionBox } from './auto-motion-image.js';
import { composeReels, type ReelsSummary } from './auto-motion-reels.js';
import type { FootageAnalysisLike, SfxAssets } from './reels-types.js';

export * from './auto-motion-spec.js';
export * from './auto-motion-footage.js';
export * from './auto-motion-image.js';
export * from './auto-motion-reels.js';
export * from './reels-types.js';

export interface ComposeContext {
  model: CompositionModelT; assets: readonly AssetFacts[]; tier?: Tier; lockedKeys?: readonly string[]; language?: 'id' | 'en';
  /** ADR-039: the project's footage analysis (cuts with timed words) and the SFX asset ids, for the talking-head mode. */
  footageAnalysis?: FootageAnalysisLike; sfxAssets?: SfxAssets;
}
export interface ComposedElement {
  key: string; scene: number; kind: 'text' | 'shape' | 'image'; box: BoxU; fromMs: number; toMs: number; hasEntrance: boolean;
  /** Set for a shape that intentionally holds / frames another element (bar under its value, ring around a number). */
  holds?: string;
}
export interface ComposedScene { role: SceneRole; startMs: number; durationMs: number; clipDurationMs: number; narrationMs: number; transitionIn?: string }
export interface VoicePlacement { clipId: string; text: string; atMs: number; durationMs: number; assetId?: string; measured: boolean }
export interface ComposeRisk { code: string; message: string; severity: 'info' | 'warn' }
export interface ComposeOk {
  ok: true; spec: VideoSpecT; ops: OperationT[]; scenes: ComposedScene[]; elements: ComposedElement[]; voice: VoicePlacement[];
  totalMs: number; narrationEstimateMs: number; frame: { w: number; h: number }; safeArea: Safe; risks: ComposeRisk[];
  quality: { fixed: number; remaining: QualityIssue[] }; fixes: string[];
  /** FR-261: the footage clips placed (scene index, asset, whether it carries sound, the clip volume) — for captions / ducking steps. */
  footage: Array<{ scene: number; assetId: string; hasAudio: boolean; volume: number }>;
  /** ADR-039: set by the talking-head composer (audio source, SFX placements, caption pages, the music plan, the cover). */
  reels?: ReelsSummary;
}
export type ComposeResult = ComposeOk | { ok: false; problem: string; fixes: string[] };
type Safe = { top: number; right: number; bottom: number; left: number };

export const WORDS_PER_MINUTE_ID = 150;
/** op:scene.add durationMs range and the op:transition.set maximum (operations.ts); the composer stays inside them (C5 / C6). */
const SCENE_MIN_MS = 500, SCENE_MAX_MS = 120_000, TRANSITION_MAX_MS = 2000;
const words = (s: string | undefined) => (s ?? '').trim().split(/\s+/).filter(Boolean).length;
/** Spoken length of a text at ~150 words / minute (Indonesian voice-over), in ms. */
export const narrationMs = (text: string | undefined, wpm = WORDS_PER_MINUTE_ID) => Math.round((words(text) / wpm) * 60_000);

// ───────────── style ─────────────
const PALETTE_BY_MOOD: Record<string, string> = {
  editorial: 'preset:palette.editorial-teal', energetic: 'preset:palette.neon-tech', calm: 'preset:palette.pastel-friendly', serious: 'preset:palette.corporate-blue',
  playful: 'preset:palette.pastel-friendly', tech: 'preset:palette.neon-tech', luxury: 'preset:palette.editorial-dark', friendly: 'preset:palette.paper-light', dramatic: 'preset:palette.high-contrast',
  viral: 'preset:palette.high-contrast',
};
/** ADR-041 mood `viral` (the reference Reels): near-black, yellow accent, white text, red marks, Poppins headings + Inter. */
export const VIRAL = Object.freeze({ bg: '#0E0E10', accent: '#FFD400', accent2: '#E53935', text: '#FFFFFF', muted: '#C9C9CF', positive: '#2E7D32', negative: '#E53935', warning: '#F59E0B', neutral: '#374151', pill: '#FFD400',
  font: 'Poppins', fontPreset: 'preset:font.poppins', fontPair: 'preset:fontpair.poppins-inter', captionStyle: 'preset:caption.editorial', sfxLevel: 0.55, watermarkWidthU: 220, watermarkOpacity: 0.9 });
const DATA_ROLES: readonly SceneRole[] = ['stat', 'stat-compare', 'bar-chart', 'hbar-compare'];
const TRANSITIONS_BY_MOOD: Record<string, string[]> = {
  viral: ['preset:transition.push-cut', 'preset:transition.fade', 'preset:transition.slide', 'preset:transition.zoom-in-out'],
  energetic: ['preset:transition.slide', 'preset:transition.push-cut', 'preset:transition.wipe', 'preset:transition.zoom-in-out'],
  playful: ['preset:transition.slide', 'preset:transition.clock-wipe', 'preset:transition.iris', 'preset:transition.zoom-in-out'],
  tech: ['preset:transition.wipe', 'preset:transition.slide', 'preset:transition.push-cut', 'preset:transition.iris'],
  dramatic: ['preset:transition.iris', 'preset:transition.fade', 'preset:transition.wipe', 'preset:transition.slide'],
  calm: ['preset:transition.fade', 'preset:transition.wipe', 'preset:transition.iris', 'preset:transition.slide'],
  serious: ['preset:transition.fade', 'preset:transition.wipe', 'preset:transition.slide', 'preset:transition.push-cut'],
  luxury: ['preset:transition.fade', 'preset:transition.iris', 'preset:transition.wipe', 'preset:transition.fade'],
  friendly: ['preset:transition.slide', 'preset:transition.fade', 'preset:transition.wipe', 'preset:transition.iris'],
};
const BACKGROUND_BY_ROLE: Partial<Record<SceneRole, string>> = {
  hook: 'preset:background.moving-gradient', title: 'preset:background.moving-gradient', body: 'preset:background.gradient', list: 'preset:background.dots', stat: 'preset:background.spotlight',
  'stat-compare': 'preset:background.grid', 'bar-chart': 'preset:background.grid', 'hbar-compare': 'preset:background.grid', question: 'preset:background.noise-clouds',
  quote: 'preset:background.noise-clouds', cta: 'preset:background.moving-gradient', 'cta-handle': 'preset:background.moving-gradient', split: 'preset:background.gradient',
};
const DIRS = ['from-right', 'from-left', 'from-bottom', 'from-top'] as const;
/** FNV-1a: a stable small hash for seeded choices (never Math.random). */
function hash(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
const hex6 = (c: string | undefined): string | undefined => {
  if (!c) return undefined;
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(c.trim()); if (!m) return undefined;
  const v = m[1]!.length === 3 ? m[1]!.split('').map((x) => x + x).join('') : m[1]!;
  return `#${v.toUpperCase()}`;
};
/** Default content padding (u): TikTok / Reels guidance for 9:16 (left 88, right 160, top 120, bottom 440); others the ratio safe area + 24. */
export function defaultSafeArea(ratio: Ratio): Safe {
  if (ratio === '9:16') return { left: 88, right: 160, top: 120, bottom: 440 };
  const s = safeAreaU(ratio);
  return { top: s.top + 24, right: s.right + 24, bottom: s.bottom + 24, left: s.left + 24 };
}

interface Style {
  mood: string; editorial: boolean; align: 'left' | 'center'; palette: string; font: string; bg: string;
  c: { text: string; muted: string; positive: string; negative: string; warning: string; neutral: string; accent: string; accent2: string; pill: string };
  safe: Safe; sourceBottom: number; transition: { type: string; ms: number; rise: number; easing: Ease }; k: number;
  /** ADR-041: mood viral and the hook / title headline look (boxed words = solid boxes behind the keywords). */
  viral: boolean; titleStyle: 'boxed' | 'highlight' | 'plain';
}
type Ease = { easingId?: string; bezier?: number[] };
function easeOf(e: SpecEasingT | undefined, fallback: Ease): Ease {
  if (e === undefined) return fallback;
  if (Array.isArray(e)) return { bezier: [...e] };
  const id: Record<string, string> = { 'out-cubic': 'out-cubic', 'in-out-cubic': 'in-out-cubic', 'out-quad': 'out-quad', 'in-quad': 'in-quad', linear: 'linear', back: 'back', spring: 'spring-light', 'spring-soft': 'spring-soft', 'spring-bouncy': 'spring-bouncy' };
  return { easingId: `preset:easing.${id[e] ?? 'out-cubic'}` };
}

// ───────────── the composer ─────────────
export function composeScenes(raw: unknown, ctx: ComposeContext): ComposeResult {
  const n = normalizeVideoSpec(raw);
  const parsed = VideoSpec.safeParse(n.value);
  if (!parsed.success) {
    const list = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, fixes: n.fixes, problem: `scene.compose args are not a valid VideoSpec: ${list}.` };
  }
  return compose(parsed.data, ctx, n.fixes);
}

function compose(spec: VideoSpecT, ctx: ComposeContext, fixes: string[]): ComposeOk {
  if (spec.talkingHead) return composeReels(spec, ctx, fixes);                      // ADR-039: the Reels talking-head mode
  const base = ctx.model, risks: ComposeRisk[] = [];
  const lang = ctx.language ?? spec.language ?? base.settings.language;
  const id = lang !== 'en';
  const locked = new Set(ctx.lockedKeys ?? []);
  const ratio: Ratio = spec.ratio ?? base.settings.ratio;
  const fps = spec.fps ?? base.settings.fps;
  const toMs = (frames: number) => Math.round((frames * 1000) / fps);
  const f = frameInUnits(ratio, base.settings.customRatio);
  const portrait = f.h > f.w * 1.05;
  const ops: OperationT[] = [];
  const add = (op: string, args: Record<string, unknown>, target?: OperationT['target']) => { ops.push({ op, args, ...(target ? { target } : {}) }); };

  // style
  const hasData = spec.scenes.some((s) => DATA_ROLES.includes(s.role));
  const mood = spec.mood ?? (hasData || spec.style?.background ? 'editorial' : 'energetic');
  const editorial = mood === 'editorial', viral = mood === 'viral';
  const palette = PALETTE_BY_MOOD[mood] ?? 'preset:palette.editorial-teal';
  // ADR-041: the viral look overrides the high-contrast palette's data (yellow #FFD400, red marks, near-black)
  const pd = { ...((getPreset(palette)?.data ?? {}) as Record<string, string>), ...(viral ? { bg: VIRAL.bg, accent: VIRAL.accent, accent2: VIRAL.accent2, text: VIRAL.text, muted: VIRAL.muted, positive: VIRAL.positive, negative: VIRAL.negative, warning: VIRAL.warning, neutral: VIRAL.neutral, pill: VIRAL.pill } : {}) };
  const sc = spec.style?.colors ?? {};
  const c = {
    text: hex6(sc.text) ?? pd['text'] ?? '#FFFFFF', muted: hex6(sc.muted) ?? pd['muted'] ?? pd['text'] ?? '#FFFFFF', positive: hex6(sc.positive) ?? pd['positive'] ?? pd['accent'] ?? '#5DCAA5',
    negative: hex6(sc.negative) ?? pd['negative'] ?? pd['accent2'] ?? '#F0997B', warning: hex6(sc.warning) ?? pd['warning'] ?? pd['accent2'] ?? '#EF9F27', neutral: hex6(sc.neutral) ?? pd['neutral'] ?? '#888780',
    accent: hex6(sc.accent) ?? pd['accent'] ?? '#5DCAA5', accent2: pd['accent2'] ?? '#EF9F27', pill: hex6(sc.pill) ?? pd['pill'] ?? pd['accent'] ?? '#1D9E75',
  };
  const mutedOpacity = pd['muted'] || sc.muted ? undefined : 0.72;
  const viralFont = viral && !spec.style?.fontFamily && getPreset(VIRAL.fontPreset) ? VIRAL.font : null;
  const ds = defaultSafeArea(ratio), ss = spec.style?.safeArea ?? {};
  const safe: Safe = { left: ss.left ?? ds.left, right: ss.right ?? ds.right, top: ss.top ?? ds.top, bottom: ss.bottom ?? ds.bottom };
  const tr = spec.style?.transition ?? {};
  const trType = tr.type ?? 'auto';
  const crossfade = trType === 'crossfade-rise' || (trType === 'auto' && editorial);
  const style: Style = {
    mood, editorial, align: spec.style?.align ?? (editorial ? 'left' : 'center'), palette,
    font: spec.style?.fontFamily ?? viralFont ?? (editorial ? 'Inter' : String(getPreset(String(getPreset(base.theme.fontPairId)?.data?.['heading']))?.data?.['family'] ?? 'Plus Jakarta Sans')),
    bg: hex6(spec.style?.background) ?? pd['bg'] ?? '#0F1A1F', c, safe, sourceBottom: spec.style?.sourceBottomPx ?? safe.bottom,
    transition: { type: crossfade ? 'crossfade-rise' : trType, ms: tr.ms ?? (tr.frames !== undefined ? toMs(tr.frames) : crossfade ? toMs(14) : 600), rise: tr.risePx ?? (crossfade ? 56 : 40), easing: easeOf(tr.easing, { easingId: 'preset:easing.out-cubic' }) },
    k: portrait ? 1 : f.h / f.w < 0.7 ? 0.8 : 0.9,
    viral, titleStyle: spec.titleStyle ?? (viral ? 'boxed' : 'highlight'),
  };
  const W = f.w - safe.left - safe.right;                  // content width (u)
  const X0 = safe.left;

  // project settings (skipped when the Creator locked them)
  if (spec.ratio && spec.ratio !== base.settings.ratio && !locked.has('project.ratio')) add('op:output.setRatio', { ratio: spec.ratio }, { kind: 'project' });
  if (spec.fps && spec.fps !== base.settings.fps && !locked.has('project.fps')) add('op:project.setFps', { fps: spec.fps }, { kind: 'project' });
  const themeArgs: Record<string, unknown> = {};
  if (!locked.has('theme.paletteId') && base.theme.paletteId !== palette) themeArgs['paletteId'] = palette;
  if (editorial && style.font === 'Inter' && !locked.has('theme.fontPairId') && base.theme.fontPairId !== 'preset:fontpair.inter-inter') themeArgs['fontPairId'] = 'preset:fontpair.inter-inter';
  if (viralFont && getPreset(VIRAL.fontPair) && !locked.has('theme.fontPairId') && base.theme.fontPairId !== VIRAL.fontPair) themeArgs['fontPairId'] = VIRAL.fontPair;
  if (Object.keys(themeArgs).length) add('op:theme.set', themeArgs, { kind: 'project' });
  if (!locked.has('project.background')) add('op:background.set', { presetId: 'preset:background.solid', params: { colourA: style.bg } }, { kind: 'project' });
  // ADR-041: sound effects in the viral look (whoosh per scene, pop per annotation) when the Service registered the SFX assets
  const sfxOn = spec.sfx?.enabled ?? viral, sfxLevel = spec.sfx?.level ?? VIRAL.sfxLevel, sfxAssets: SfxAssets = ctx.sfxAssets ?? {};
  const missingSfx = new Set<string>();
  const sfx = (kind: SfxKind, atMs: number) => { if (!sfxOn) return; const a = sfxAssets[kind]; if (!a) { missingSfx.add(kind); return; } add('op:audio.addLayer', { assetId: a, atMs: Math.max(0, atMs), volume: sfxLevel, role: 'sfx' }); };

  // ───── timing: voice clips → scene lengths ─────
  const clipFacts = new Map<string, { text: string; durationMs: number; assetId?: string; measured: boolean }>();
  for (const v of spec.voice?.clips ?? []) {
    const asset = v.assetId ? ctx.assets.find((a) => a.id === v.assetId && a.kind === 'audio') : undefined;
    if (v.assetId && !asset) risks.push({ code: 'voice-asset-missing', severity: 'warn', message: id ? `Klip suara ${v.id}: file ${v.assetId} tidak ada di proyek; durasinya diperkirakan.` : `Voice clip ${v.id}: asset ${v.assetId} is not in the project; its length is estimated.` });
    const measured = asset?.durationMs ?? v.durationMs;
    clipFacts.set(v.id, { text: v.text, durationMs: measured ?? Math.max(800, narrationMs(v.text) + 250), ...(asset ? { assetId: asset.id } : {}), measured: measured !== undefined });
  }
  if ([...clipFacts.values()].some((x) => !x.measured)) risks.push({ code: 'timing-estimated', severity: 'info', message: id ? 'Durasi adegan diperkirakan dari naskah (±150 kata/menit); setelah suara dibuat, susun ulang agar pas dengan durasi klip.' : 'Scene lengths are estimated from the script (~150 words / minute); compose again once the voice clips exist.' });
  const gapMs = spec.voice?.gapMs ?? 300, tailMs = spec.voice?.tailMs ?? 500;
  const onScreenWords = (s: SpecSceneT) => [s.kicker, s.headline, s.sub, s.note, s.quote, s.attribution, s.handle, s.action, s.button, ...(s.bullets ?? [])].reduce((a, t) => a + words(textOf(t)), 0)
    + (s.stats ?? []).reduce((a, x) => a + 1 + words(textOf(x.label)) + words(textOf(x.note)), 0) + (s.bars ?? []).reduce((a, b) => a + 1 + words(b.label), 0);
  const last = spec.scenes.length - 1;
  // FR-261: footage scenes play a window of a video asset; their length follows that window (and the voice, when shorter)
  const footageWins: Array<FootageWindow | null> = spec.scenes.map((s, i) => (isFootageRole(s.role) ? footageWindow(s, i, ctx.assets, id, risks) : null));
  const underVoice = (spec.voice?.clips.length ?? 0) > 0;
  const sceneTiming = spec.scenes.map((s, i) => {
    const clips = (s.clips ?? []).filter((cid) => { if (clipFacts.has(cid)) return true; risks.push({ code: 'unknown-clip', severity: 'warn', message: id ? `Adegan ${i + 1}: klip suara "${cid}" tidak ada di voice.clips.` : `Scene ${i + 1}: voice clip "${cid}" is not in voice.clips.` }); return false; });
    const offsets: Record<string, { at: number; dur: number }> = {};
    let cursor = 0;
    clips.forEach((cid, k) => { const d = clipFacts.get(cid)!.durationMs; offsets[cid] = { at: cursor, dur: d }; cursor += d + (k < clips.length - 1 ? s.gapMs ?? gapMs : 0); });
    const narr = clips.length ? cursor : narrationMs(s.narration);
    const reading = 1500 + 260 * onScreenWords(s);
    const tail = s.tailMs ?? (i === last && clips.length ? Math.max(tailMs, 1000) : tailMs);
    const raw = clips.length ? cursor + tail + (s.holdMs ?? 0)
      : Math.max(2500, s.durationMs ?? 0, narr ? narr + tail : 0, s.durationMs ? 0 : reading) + (s.holdMs ?? 0);
    // C6 (review 2026-10-29): a scene clip is op:scene.add durationMs 500…120 000 ms including its outgoing transition (≤ 2000 ms)
    const fwin = footageWins[i];
    if (fwin) {
      const want = clips.length ? Math.round(raw) : s.durationMs ?? (narr ? narr + tail : null);
      const reserve = i < last && trType !== 'cut' ? Math.min(TRANSITION_MAX_MS, style.transition.ms) : 0;
      const flen = footageSceneMs(fwin, want, reserve);
      if (want !== null && want > flen + 200) risks.push({ code: 'footage-shorter', severity: 'warn', message: id ? `Adegan ${i + 1}: footage ${fwin.name} hanya ${(flen / 1000).toFixed(1).replace('.', ',')} dtk, lebih pendek dari narasinya; tambahkan footage atau bagi narasinya.` : `Scene ${i + 1}: footage ${fwin.name} is only ${(flen / 1000).toFixed(1)} s, shorter than its narration; add footage or split the narration.` });
      return { clips, offsets, len: flen, narr };
    }
    const len = Math.max(SCENE_MIN_MS, Math.min(SCENE_MAX_MS - TRANSITION_MAX_MS, Math.round(raw)));
    if (raw > SCENE_MAX_MS - TRANSITION_MAX_MS) risks.push({ code: 'scene-too-long', severity: 'warn', message: id ? `Adegan ${i + 1} lebih dari 2 menit; dipotong menjadi ${(len / 1000).toFixed(0)} dtk. Bagi narasinya ke beberapa adegan.` : `Scene ${i + 1} is longer than 2 minutes; cut to ${(len / 1000).toFixed(0)} s. Split its narration over several scenes.` });
    return { clips, offsets, len, narr };
  });
  const narrationEstimateMs = sceneTiming.reduce((a, t) => a + t.narr, 0);
  // Round 2 (QA nikel: voice −130 … +83 ms off its scene start): the Engine rounds every clip and transition to frames one by
  // one (deriveFrameTiming), so scene lengths, overlaps and starts are whole frames here and the voice / text times are placed
  // from exactly those frame starts (footage rounds down so a clip never runs past its window).
  const fr = (ms: number) => framesOf(ms, fps);
  sceneTiming.forEach((t, i) => { t.len = toMs(Math.max(1, footageWins[i] ? Math.floor((t.len * fps) / 1000) : fr(t.len))); });

  // ───── scene clips + transitions ─────
  const existing = base.tracks.video.length;
  if (!existing && (base.tracks.text.length || base.tracks.overlay.length)) risks.push({ code: 'existing-content', severity: 'warn', message: id ? 'Proyek sudah berisi teks / bentuk tanpa klip; adegan baru dimulai dari awal dan bisa menumpuk dengannya.' : 'The project already has texts / shapes without clips; the new scenes start at 0 and may overlap them.' });
  const T = Math.max(0, Math.min(TRANSITION_MAX_MS, style.transition.ms));
  // C5 (review 2026-10-29): ONE length per cut, used for the transition op AND the clip overlap: min(T, 2000, half of each
  // neighbour); under 100 ms (the op:transition.set minimum) the cut is a hard cut without overlap.
  const prevExistingMs = existing ? base.tracks.video[existing - 1]!.durationMs : 0;
  const cutMsIn = (i: number): number => {
    const prev = i > 0 ? sceneTiming[i - 1]!.len : existing ? prevExistingMs : 0;
    if (!prev) return 0;
    const v = Math.min(T, Math.floor(prev / 2), Math.floor(sceneTiming[i]!.len / 2));
    return v >= 100 ? toMs(Math.max(1, framesOf(v, fps))) : 0;    // round 2: a whole number of frames, as the Engine plays it
  };
  const pool = TRANSITIONS_BY_MOOD[mood] ?? TRANSITIONS_BY_MOOD['calm']!;
  const gpuOk = (p: string) => ctx.tier !== 'T0' || !getPreset(p)?.flags.includes('gpu');
  const seed = hash(spec.title ?? spec.scenes.map((s) => textOf(s.headline) ?? s.role).join('|'));
  const transitionFor = (i: number, prev: string | undefined): { presetId: string; params: Record<string, unknown> } | null => {
    if (trType === 'cut') return null;
    if (style.transition.type === 'crossfade-rise') return { presetId: 'preset:transition.fade', params: style.transition.easing.easingId ? { easingId: style.transition.easing.easingId } : {} };
    if (trType.startsWith('preset:')) return { presetId: trType, params: {} };
    const choices = pool.filter((p) => gpuOk(p) && p !== prev);
    const presetId = choices[(seed + i * 7) % choices.length] ?? 'preset:transition.fade';
    const dirs = portrait ? ['from-bottom', 'from-right', 'from-left'] : DIRS;
    return { presetId, params: getPreset(presetId)?.defaults && 'direction' in (getPreset(presetId)!.defaults as object) ? { direction: dirs[(seed + i) % dirs.length] } : {} };
  };
  const scenes: ComposedScene[] = [];
  const baseFt = existing ? deriveFrameTiming(base) : null;
  const startBaseF = baseFt ? baseFt.clipStartFrames[existing - 1]! + baseFt.clipFrames[existing - 1]! : 0;
  const startBase = toMs(startBaseF);
  let cursorF = startBaseF;
  let prevTr: string | undefined;
  const transitions: Array<{ cut: number; presetId: string; params: Record<string, unknown>; ms: number }> = [];
  const footagePlaced: ComposeOk['footage'] = [];
  spec.scenes.forEach((s, i) => {
    const t = sceneTiming[i]!;
    const hasIn = i > 0 || existing > 0, hasOut = i < last;
    const cutIn = hasIn ? cutMsIn(i) : 0;
    const trIn = cutIn ? transitionFor(i, prevTr) : null;
    const tIn = trIn ? cutIn : 0;
    if (trIn) { transitions.push({ cut: existing + i - 1, presetId: trIn.presetId, params: trIn.params, ms: tIn }); prevTr = trIn.presetId; }
    if (i === 0 && existing && trIn) cursorF -= fr(tIn);      // the first scene overlaps the existing last clip by its transition
    const tOut = hasOut && trType !== 'cut' ? cutMsIn(i + 1) : 0;
    const clipDur = toMs(fr(t.len) + fr(tOut));
    let bgId = editorial || viral ? 'preset:background.solid' : (BACKGROUND_BY_ROLE[s.role] ?? 'preset:background.gradient');
    let bgParams: Record<string, unknown> = editorial || viral ? { colourA: style.bg } : { colourA: style.bg, colourB: i % 2 ? c.accent2 : c.accent, intensity: 0.55, ...(bgId === 'preset:background.gradient' ? { angle: 140 + ((seed + i * 40) % 80), animate: true } : {}) };
    if (viral && DATA_ROLES.includes(s.role)) { bgId = 'preset:background.spotlight'; bgParams = { colourA: style.bg, colourB: c.accent, intensity: 0.35 }; }
    if (s.role === 'image') {                                                   // ADR-041: the picture's own blurred copy, paper, or a solid
      const firstImg = (s.images ?? []).map((im) => ctx.assets.find((a) => a.id === im.assetId && a.kind === 'image' && a.status === 'ready')).find(Boolean);
      const bg = s.bg ?? 'blur';
      if (bg === 'blur' && firstImg) { bgId = 'preset:background.blurred-image'; bgParams = { assetId: firstImg.id, blurPx: 48, dim: 0.45, zoom: 1.25 }; }
      else if (bg === 'paper') { bgId = 'preset:background.paper'; bgParams = { grain: 0.35, warm: 0.5 }; }
      else { bgId = 'preset:background.solid'; bgParams = { colourA: bg === 'white' ? '#FFFFFF' : bg === 'dark' ? '#0E0E10' : style.bg }; }
    }
    const fwin = footageWins[i];
    if (fwin) {                                                                 // FR-261: the Creator's footage is the base of this scene
      const args = footageClipArgs(s.role, fwin, clipDur, f, safe, portrait, s.side, { underVoice, last: i === last });
      const fx = gradeEffects(s.footage?.grade);                                 // ADR-041: dark-grain = dim 0.5 (a full-frame shape in the layout) + vignette + film grain 0.3; ≤ 2 gpu effects (T0 rule)
      if (fx.length) args['effects'] = fx;
      add('op:clip.insert', args, { kind: 'sequence' });
      footagePlaced.push({ scene: i, assetId: fwin.assetId, hasAudio: fwin.hasAudio, volume: Number(args['volume']) });
    } else add('op:scene.add', { durationMs: clipDur, background: bgId, backgroundParams: bgParams }, { kind: 'sequence' });
    scenes.push({ role: s.role, startMs: toMs(cursorF), durationMs: t.len, clipDurationMs: clipDur, narrationMs: t.narr, ...(trIn ? { transitionIn: trIn.presetId } : {}) });
    sfx('whoosh', toMs(cursorF));
    cursorF += fr(t.len);
  });
  for (const x of transitions) add('op:transition.set', { presetId: x.presetId, durationMs: x.ms, timing: 'linear', params: x.params }, { kind: 'cut', index: x.cut });
  const totalMs = toMs(cursorF);
  if (spec.maxDurationMs && totalMs - startBase > spec.maxDurationMs) risks.push({ code: 'too-long', severity: 'warn', message: id ? `Video ${(totalMs - startBase) / 1000} dtk, lebih dari batas ${spec.maxDurationMs / 1000} dtk; percepat suara sedikit (jangan potong narasi).` : `The video is ${(totalMs - startBase) / 1000} s, over the ${spec.maxDurationMs / 1000} s limit; speed the voice up slightly (do not cut the narration).` });

  // ───── voice layers ─────
  const voice: VoicePlacement[] = [];
  spec.scenes.forEach((s, i) => {
    const t = sceneTiming[i]!;
    for (const cid of t.clips) {
      const cf = clipFacts.get(cid)!, at = scenes[i]!.startMs + t.offsets[cid]!.at;
      voice.push({ clipId: cid, text: cf.text, atMs: at, durationMs: cf.durationMs, ...(cf.assetId ? { assetId: cf.assetId } : {}), measured: cf.measured });
      if (cf.assetId) add('op:audio.addLayer', { assetId: cf.assetId, atMs: at, volume: 1, role: 'voice' });
    }
  });

  // ───── layouts ─────
  const elements: ComposedElement[] = [];
  // ADR-041 (E2E run 6 frames): a top watermark must not sit on the pictures / headlines — layouts start below it (+24 u);
  // the quality gate keeps the real safe area.
  const wmBottomU = (() => {
    const wm = spec.watermark; if (!wm) return 0;
    const pos = wm.position ?? 'top-center'; if (pos === 'bottom-right') return 0;
    const img = ctx.assets.find((a) => a.id === wm.assetId && a.kind === 'image' && a.status === 'ready'); if (!img) return 0;
    const w = wm.widthU ?? VIRAL.watermarkWidthU, h = w / aspectOf(img), pad = 24;
    return Math.max(pad + h / 2, safe.top * 0.6) + h / 2;
  })();
  const layoutStyle: Style = wmBottomU ? { ...style, safe: { ...style.safe, top: Math.max(style.safe.top, wmBottomU + 24) } } : style;
  const captionsOn = spec.captions === true || (typeof spec.captions === 'object' && spec.captions !== null);
  spec.scenes.forEach((s, i) => {
    const sc = scenes[i]!, t = sceneTiming[i]!;
    const tOut = scenes[i]!.clipDurationMs - scenes[i]!.durationMs;          // the same overlap the clip got (C5)
    const exitMs = style.transition.type === 'crossfade-rise' ? tOut : Math.min(350, tOut || 350);
    const end = i < last ? sc.startMs + sc.durationMs + (style.transition.type === 'crossfade-rise' ? tOut : Math.round(tOut * 0.5)) : sc.startMs + sc.durationMs;
    const enterDelay = style.transition.type === 'crossfade-rise' || i === 0 ? 0 : Math.round(T * 0.5);
    const L = new SceneLayout({ i, scene: s, start: sc.startMs + enterDelay, end, exitMs: i < last ? exitMs : 0, style: layoutStyle, frame: f, W, X0, toMs, offsets: t.offsets, risks, id, ops, elements, mutedOpacity, portrait, seed, footage: footageWins[i] ?? null, clipStart: sc.startMs, captions: captionsOn, assets: ctx.assets, sfx });
    // lay the scene out; when the content runs into the source line / safe bottom, lay it out again smaller (max 5 tries)
    const ops0 = ops.length, els0 = elements.length, risks0 = risks.length;
    for (let attempt = 0; ; attempt++) {
      L.build(false);
      const over = L.overflow();
      if (over <= 0 || attempt >= 5) { if (over > 0) risks.push({ code: 'scene-tight', severity: 'warn', message: id ? `Adegan ${i + 1} terlalu padat untuk rasio ini; kurangi teksnya.` : `Scene ${i + 1} is too dense for this ratio; shorten its texts.` }); break; }
      ops.length = ops0; elements.length = els0; risks.length = risks0;
      L.reset(); L.scale *= 0.9;
    }
    L.finish();
  });

  // ───── ADR-041: watermark (the channel logo over the whole video) and the caption look of the viral mood ─────
  let outSpec = spec;
  if (spec.watermark) {
    const wm = spec.watermark, img = ctx.assets.find((a) => a.id === wm.assetId && a.kind === 'image' && a.status === 'ready');
    if (!img) risks.push({ code: 'watermark-missing', severity: 'warn', message: id ? `Watermark: gambar ${wm.assetId} tidak ada di proyek; dilewati.` : `Watermark: image ${wm.assetId} is not in the project; skipped.` });
    else {
      const w = wm.widthU ?? VIRAL.watermarkWidthU, h = w / aspectOf(img), pad = 24;
      const pos = wm.position ?? 'top-center';
      const cx = pos === 'top-left' ? safe.left + w / 2 : pos === 'top-right' || pos === 'bottom-right' ? f.w - safe.right - w / 2 : f.w / 2;
      const cy = pos === 'bottom-right' ? f.h - safe.bottom - h / 2 : Math.max(pad + h / 2, safe.top * 0.6);      // in the top band above the content, never under the status bar
      const at = startBase;
      add('op:overlay.addImage', { assetId: img.id, atMs: at, durationMs: Math.max(100, totalMs - at), position: { x: round1(cx - f.w / 2), y: round1(cy - f.h / 2) }, size: Math.round(w), objectFit: 'contain', opacity: wm.opacity ?? VIRAL.watermarkOpacity, layer: 900, motion: { presetId: 'preset:motion.fade-in', durationMs: 400, exit: false } });
      elements.push({ key: 'watermark', scene: -1, kind: 'image', box: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }, fromMs: at, toMs: totalMs, hasEntrance: true });
    }
  }
  if (captionsOn && (viral || spec.captionStyle)) {
    // the caption look travels with the plan's captions.generate step (presetId) and as an op (params): white on a dark box in
    // the lower third (editorial), or the Satu-Persen emphasis — centred upper-case words, the scene keywords large italic serif
    const styleId = spec.captionStyle ?? VIRAL.captionStyle;
    const kwWords = [...new Set([...(typeof spec.captions === 'object' ? (spec.captions.keywords ?? []).flatMap((k) => k.words) : []), ...spec.scenes.flatMap((s) => s.keywords ?? [])])];
    const kwColour = typeof spec.captions === 'object' && spec.captions.keywords?.[0]?.colour ? spec.captions.keywords[0].colour : c.accent;
    const want: Record<string, unknown> = { position: 'bottom', fontSize: 56, fontFamily: style.font, weight: 800, ...(kwWords.length ? { keywords: [{ words: kwWords.slice(0, 40), colour: kwColour }] } : {}),
      ...(styleId === 'preset:caption.emphasis' ? { emphasisColour: c.accent } : {}) };
    const v = validateParams(styleId, want);
    if (!v.ok) risks.push({ code: 'preset-missing', severity: 'info', message: id ? `Gaya caption ${styleId}: ${v.issues[0]?.message ?? 'parameter'}; parameter bawaan dipakai.` : `Caption style ${styleId}: ${v.issues[0]?.message ?? 'params'}; defaults used.` });
    if (!locked.has('project.captionStyle')) add('op:caption.setStyle', { presetId: styleId, params: v.ok ? want : { position: 'bottom', fontSize: 56 } }, { kind: 'project' });
    outSpec = { ...spec, captionStyle: styleId };
  }
  if (missingSfx.size) risks.push({ code: 'sfx-unavailable', severity: 'info', message: id ? `Efek suara ${[...missingSfx].join(', ')} belum tersedia di proyek; video dibuat tanpanya.` : `Sound effects ${[...missingSfx].join(', ')} are not available in the project; the video is made without them.` });

  // ───── quality gate: dry run, check, auto-fix, check again ─────
  let n = 0;
  const dry = (list: OperationT[]) => applyOperations(base, list, { assets: ctx.assets, tier: ctx.tier ?? 'T1', newId: () => `qa${++n}` });
  let fixed = 0, remaining: QualityIssue[] = [];
  const r1 = dry(ops);
  if (r1.ok) {
    const before = qualityCheck(r1.value.model, { safeArea: safe });
    const fixOps = autoFixOps(r1.value.model, before, { safeArea: safe });
    if (fixOps.length) {
      // the fix ops target the dry-run ids; ids are assigned in op order, so they are the same when Execute applies the plan with
      // its own id source — translate them by position into stable "nth new element" references is not possible across id sources,
      // so instead re-apply the geometry change to the composed ops themselves.
      const changed = applyFixesToOps(ops, r1.value.model, fixOps, base);
      fixed = changed;
      const r2 = dry(ops);
      remaining = r2.ok ? qualityCheck(r2.value.model, { safeArea: safe }) : before;
    } else remaining = before;
  } else risks.push({ code: 'compose-invalid', severity: 'warn', message: r1.issues.map((x) => x.message).join('; ').slice(0, 300) });
  for (const line of qualityChecklist(remaining.filter((q) => q.severity === 'warn'), lang === 'en' ? 'en' : 'id')) risks.push({ code: 'quality', severity: 'warn', message: line });
  for (const s of spec.scenes) if (DATA_ROLES.includes(s.role) && !s.source) { risks.push({ code: 'no-source', severity: 'warn', message: id ? `Adegan data "${textOf(s.headline) ?? textOf(s.kicker) ?? s.role}" belum punya sumber.` : `Data scene "${textOf(s.headline) ?? textOf(s.kicker) ?? s.role}" has no source.` }); break; }
  for (const [i, sc] of spec.scenes.entries()) if (isFootageRole(sc.role) && (sc.stats ?? []).length && !sc.source) { risks.push({ code: 'no-source', severity: 'warn', message: id ? `Angka di adegan footage ${i + 1} belum punya sumber.` : `The figure in footage scene ${i + 1} has no source.` }); break; }
  return { ok: true, spec: outSpec, ops, scenes, elements, voice, totalMs, narrationEstimateMs, frame: f, safeArea: safe, risks, quality: { fixed, remaining }, fixes, footage: footagePlaced };
}

/**
 * ADR-041 footage grades as clip effects (≤ 2, both gpu-flagged, so a T0 machine stays inside its two-effects rule):
 * dark-grain = vignette 0.55 + film grain 0.3 (the 0.5 dim is a full-frame shape added by the layout, because the clip has no id
 * yet and `preset:background.video-dim` needs op:scene.setBackground on one); warm / cold = a colour grade + vignette.
 */
export function gradeEffects(grade: string | undefined): Array<{ presetId: string; params: Record<string, unknown> }> {
  switch (grade) {
    case 'dark-grain': return [{ presetId: 'preset:effect.vignette', params: { intensity: 0.55 } }, { presetId: 'preset:effect.film-grain', params: { intensity: 0.3 } }];
    case 'warm': return [{ presetId: 'preset:effect.colour-grade', params: { saturation: 0.2, contrast: 0.05, brightness: 0.02 } }, { presetId: 'preset:effect.vignette', params: { intensity: 0.35 } }];
    case 'cold': return [{ presetId: 'preset:effect.colour-grade', params: { saturation: -0.3, contrast: 0.08, brightness: -0.04 } }, { presetId: 'preset:effect.vignette', params: { intensity: 0.35 } }];
    default: return [];
  }
}

/**
 * Applies quality-gate fixes to the composed ops (not to ids that only exist in the dry run): the k-th text added by the ops is the
 * k-th new text in the dry-run model, so its position / style args are rewritten in place. Returns the number of ops changed.
 */
function applyFixesToOps(ops: OperationT[], dryModel: CompositionModelT, fixOps: OperationT[], base: CompositionModelT): number {
  const baseIds = new Set([...base.tracks.text.map((t) => t.id), ...base.tracks.overlay.map((o) => o.id)]);
  const newTexts = dryModel.tracks.text.filter((t) => !baseIds.has(t.id));
  const newShapes = dryModel.tracks.overlay.filter((o) => !baseIds.has(o.id));
  const textOps = ops.filter((o) => o.op === 'op:text.add'), shapeOps = ops.filter((o) => o.op === 'op:shape.add' || o.op === 'op:overlay.addImage');
  const f = frameInUnits(dryModel.settings.ratio, dryModel.settings.customRatio);
  let changed = 0;
  for (const fx of fixOps) {
    const tid = fx.target?.id;
    const ti = newTexts.findIndex((t) => t.id === tid), si = newShapes.findIndex((o) => o.id === tid);
    const op = ti >= 0 ? textOps[ti] : si >= 0 ? shapeOps[si] : undefined;
    if (!op) continue;
    const a = op.args as Record<string, unknown>, x = fx.args as Record<string, number | string>;
    if (fx.op === 'op:element.setTransform') {
      const pos = (a['position'] ?? { x: 0, y: 0 }) as { x: number; y: number };
      a['position'] = { x: x['x'] === undefined ? pos.x : Math.round(Number(x['x']) * f.w * 10) / 10, y: x['y'] === undefined ? pos.y : Math.round(Number(x['y']) * f.h * 10) / 10 };
      changed++;
    } else if (fx.op === 'op:text.setStyle') { a['styleOverrides'] = { ...((a['styleOverrides'] as object | undefined) ?? {}), ...x }; changed++; }
  }
  return changed;
}

const textOf = (t: SpecTextT | undefined): string | undefined => (t === undefined ? undefined : typeof t === 'string' ? t : t.text);
const asObj = (t: SpecTextT) => (typeof t === 'string' ? { text: t } : t);

interface LayoutInput {
  i: number; scene: SpecSceneT; start: number; end: number; exitMs: number; style: Style; frame: { w: number; h: number }; W: number; X0: number;
  toMs: (frames: number) => number; offsets: Record<string, { at: number; dur: number }>; risks: ComposeRisk[]; id: boolean; ops: OperationT[]; elements: ComposedElement[];
  mutedOpacity: number | undefined; portrait: boolean; seed: number;
  /** FR-261: the scene's footage window (footage roles), where its clip starts, and whether captions will be on screen. */
  footage?: FootageWindow | null; clipStart?: number; captions?: boolean;
  /** ADR-041: the project's assets (picture sizes of image scenes) and the sound-effect hook (pop on annotations). */
  assets?: readonly AssetFacts[]; sfx?: (kind: SfxKind, atMs: number) => void;
}
type TextDefaults = { size: number; weight: number; color: string; lineHeight?: number; opacity?: number; align?: 'left' | 'center' | 'right'; variant?: string; box?: { colour: string; padX: number; padY: number; radius: number } };
type Entrance = { presetId?: string; ms?: number; rise?: number; ease?: Ease; params?: Record<string, unknown> };

/** One scene's layout: a vertical flow of blocks from the content top, each element its own op (and lane), all inside the scene. */
class SceneLayout {
  private y: number;
  private n = 0;
  constructor(private readonly p: LayoutInput) {
    const { style, frame } = p;
    this.y = style.safe.top + (p.scene.topPx ?? (p.portrait ? 160 : 90));
    if (p.scene.role === 'cta' || p.scene.role === 'cta-handle') this.y = p.scene.topPx !== undefined ? style.safe.top + p.scene.topPx : style.safe.top + (p.portrait ? 400 : 200);
    if (p.scene.role === 'bar-chart') this.y = style.safe.top + (p.scene.topPx ?? 0);
    void frame;
    this.y0 = this.y; this.X0 = p.X0; this.W0 = p.W;
  }
  private readonly y0: number; private readonly X0: number; private readonly W0: number;
  reset(): void { this.y = this.y0; this.p.X0 = this.X0; this.p.W = this.W0; this.n = 0; }
  private get s() { return this.p.scene; }
  private get st() { return this.p.style; }
  /** Scene fit factor (< 1 when the content did not fit and the scene was laid out again smaller). */
  scale = 1;
  private sz(px: number) { return Math.round(px * this.st.k * this.scale); }
  /** An explicit px value of the spec, adapted to the ratio and the fit factor (exact on 9:16 when everything fits). */
  private ex(px: number) { return Math.round(px * this.st.k * this.scale); }
  /** Bottom of the content so far and where it must end (above the source line / the safe bottom). */
  overflow(): number {
    const f = this.p.frame, st = this.st;
    let limit = Math.min(f.h - st.safe.bottom, this.limitY ?? Infinity);
    if (this.s.source) {
      const o = asObj(this.s.source), size = Math.max(34, o.sizePx !== undefined ? this.ex(o.sizePx) : this.sz(44));
      const g = textGeometry({ text: o.text, variantId: 'preset:text.subtitle', position: { x: 0, y: 0 }, maxWidth: this.p.W, valign: 'top', style: { fontSize: size, weight: o.weight ?? 400, lineHeight: o.lineHeight } as TextLayerT['style'] }, ratioOf(f), { fontSize: 64, weight: 400, colour: st.c.muted, align: 'left', opacity: 1 }, f);
      limit = Math.min(limit, f.h - st.sourceBottom) - (g.box.y1 - g.box.y0) - this.sz(24);
    }
    return this.y - limit;
  }
  /** Absolute ms of an anchor inside this scene (start when absent). */
  private at(a: SpecAnchorT | undefined, fallback = this.p.start): number {
    if (!a) return fallback;
    if ('ms' in a) return this.p.start + a.ms;
    if ('frames' in a) return this.p.start + this.p.toMs(a.frames);
    if ('footageMs' in a || 'say' in a) return this.footageAt(a, fallback);
    const o = this.p.offsets[a.clip];
    if (!o) { this.p.risks.push({ code: 'unknown-anchor', severity: 'warn', message: this.p.id ? `Adegan ${this.p.i + 1}: jangkar "${a.clip}" bukan klip adegan ini.` : `Scene ${this.p.i + 1}: anchor "${a.clip}" is not a clip of this scene.` }); return fallback; }
    const t = this.p.start + o.at + (a.edge === 'end' ? o.dur : 0) + Math.round((a.pct ?? 0) * o.dur) + (a.offsetMs ?? 0);
    return Math.max(this.p.start, Math.min(t, this.p.end - 400));
  }
  private motion(e: Entrance): Record<string, unknown> {
    const st = this.st, tr = st.transition;
    const ease = e.ease ?? tr.easing;
    const presetId = e.presetId ?? 'preset:motion.rise';
    const params: Record<string, unknown> = { ...(e.params ?? {}), exitStyle: 'fade', exitMs: this.p.exitMs, ...(ease.bezier ? { bezier: ease.bezier } : {}) };
    if (presetId === 'preset:motion.rise') params['distanceU'] = e.rise ?? tr.rise;
    return { presetId, durationMs: Math.max(100, e.ms ?? tr.ms), ...(ease.easingId ? { easingId: ease.easingId } : {}), exit: this.p.exitMs > 0, params };
  }
  private entranceOf(t: SpecTextT | SpecStatT | undefined): Entrance {
    if (!t || typeof t === 'string') return {};
    const ms = t.fadeMs ?? (t.fadeFrames !== undefined ? this.p.toMs(t.fadeFrames) : undefined);
    return { ...(ms !== undefined ? { ms } : {}), ...(t.risePx !== undefined ? { rise: t.risePx } : {}) };
  }
  /** Adds a text at (x0, top) with width w; returns its painted box. */
  text(t: SpecTextT, d: TextDefaults, x0: number, top: number, w: number, from: number, e: Entrance = {}, effect?: Record<string, unknown>, key = 'text'): BoxU {
    const o = asObj(t), st = this.st, f = this.p.frame;
    const size = o.sizePx !== undefined ? this.ex(o.sizePx) : d.size, weight = o.weight ?? d.weight, colour = hex6(o.color) ?? d.color, align = o.align ?? d.align ?? st.align;
    const lineHeight = o.lineHeight ?? d.lineHeight;
    const style: Record<string, unknown> = { fontSize: Math.round(size), weight, colour, align, fontFamily: st.font, ...(lineHeight ? { lineHeight } : {}), ...(d.opacity !== undefined && !o.color ? { opacity: d.opacity } : {}), ...(d.box ? { box: d.box } : {}) };
    const fx = effect ? { presetId: String(effect['presetId']), params: (effect['params'] ?? {}) as Record<string, unknown> } : null;
    const geo = (posX: number) => textGeometry({ text: o.text, variantId: d.variant ?? 'preset:text.subtitle', position: { x: posX, y: top - f.h / 2 }, maxWidth: w, valign: 'top', style: style as TextLayerT['style'], effect: fx }, ratioOf(f), { fontSize: 64, weight: 700, colour, align: 'center', opacity: 1 }, f);
    let g = geo(x0 + w / 2 - f.w / 2);
    // a box narrower than asked (engine safe-area clamp) is re-centred so its left edge stays where the layout wants it
    if (align === 'left' && Math.abs(g.box.x0 - x0) > 1) g = geo(x0 + g.boxW / 2 - f.w / 2);
    const startMs = this.at(o.at, from);
    this.p.ops.push({ op: 'op:text.add', args: { text: o.text, variant: d.variant ?? 'preset:text.subtitle', atMs: startMs, durationMs: Math.max(100, this.p.end - startMs), position: { x: round1(g.anchor.x - f.w / 2), y: round1(top - f.h / 2) },
      maxWidth: Math.round(w), valign: 'top', styleOverrides: style, motion: this.motion({ ...e, ...this.entranceOf(t) }), ...(effect ? { effect } : {}) } });
    this.p.elements.push({ key: `${this.p.i}:${key}:${this.n++}`, scene: this.p.i, kind: 'text', box: g.box, fromMs: startMs, toMs: this.p.end, hasEntrance: true });
    return g.box;
  }
  shape(presetId: string, cx: number, cy: number, w: number, h: number, fill: string, from: number, e: Entrance, extra: Record<string, unknown> = {}, holds?: string): BoxU {
    const f = this.p.frame, box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
    this.p.ops.push({ op: 'op:shape.add', args: { presetId, atMs: from, durationMs: Math.max(100, this.p.end - from), position: { x: round1(cx - f.w / 2), y: round1(cy - f.h / 2) }, size: Math.max(10, Math.round(w)), height: Math.max(1, Math.round(h)), fill, motion: this.motion(e), ...extra } });
    this.p.elements.push({ key: `${this.p.i}:shape:${this.n++}`, scene: this.p.i, kind: 'shape', box, fromMs: from, toMs: this.p.end, hasEntrance: true, ...(holds ? { holds } : {}) });
    return box;
  }
  private muted(size: number, weight = 400): TextDefaults { return { size, weight, color: this.st.c.muted, ...(this.p.mutedOpacity !== undefined ? { opacity: this.p.mutedOpacity } : {}) }; }
  private body(size: number, weight = 400): TextDefaults { return { size, weight, color: this.st.c.text }; }
  private toneColour(tone: string | undefined, value?: string): string {
    const c = this.st.c;
    switch (tone) { case 'positive': return c.positive; case 'negative': return c.negative; case 'warning': return c.warning; case 'neutral': return c.neutral; case 'muted': return c.muted; case 'text': return c.text; case 'accent': return c.accent; default: break; }
    if (value && /^\s*[−–-]/.test(value)) return c.negative;
    return c.positive;
  }
  private kicker(): void {
    if (!this.s.kicker) return;
    const b = this.text(this.s.kicker, this.muted(this.sz(52)), this.p.X0, this.y, this.p.W, this.p.start, {}, undefined, 'kicker');
    this.y = b.y1 + this.sz(28);
  }
  private headline(size: number, weight: number, gap: number, lineHeight?: number): BoxU | null {
    if (!this.s.headline) return null;
    const st = this.st, words = this.s.keywords ?? [];
    // ADR-041 titleStyle: boxed (solid accent boxes behind the keywords on hook / title / image headlines; the viral default),
    // highlight (keyword colour), plain (nothing)
    const boxedRole = ['hook', 'title', 'image', 'question'].includes(this.s.role);
    const kw = !words.length || st.titleStyle === 'plain' ? undefined
      : st.titleStyle === 'boxed' && boxedRole ? { presetId: 'preset:texteffect.boxed', params: { words, boxColour: st.c.accent, textColour: st.viral ? '#111111' : st.bg, padU: 14, radiusU: 8 } }
      : { presetId: 'preset:texteffect.keyword', params: { words, colour: st.c.accent } };
    const e: Entrance = st.editorial ? {} : { presetId: 'preset:motion.word-stagger', params: { staggerFrames: 4 } };
    const b = this.text(this.s.headline, { size: this.sz(size), weight, color: st.c.text, variant: 'preset:text.title', ...(lineHeight ? { lineHeight } : {}) }, this.p.X0, this.y, this.p.W, this.p.start, e, kw, 'headline');
    if (!st.editorial) {
      // accent line under the headline (draws on after the words arrive), aligned with the text's first edge
      const lw = Math.min(b.x1 - b.x0, this.sz(220)), lh = this.sz(12), cx = st.align === 'left' ? b.x0 + lw / 2 : (b.x0 + b.x1) / 2;
      this.shape('preset:shape.line', cx, b.y1 + this.sz(26), lw, lh, st.c.accent, this.p.start + 450, { presetId: 'preset:motion.wipe-reveal', ms: 600, params: { direction: 'from-left', loop: 'float' } });
      this.y = b.y1 + this.sz(26) + lh + gap;
    } else this.y = b.y1 + gap;
    return b;
  }
  private sub(size = 60, gap = 48): void {
    if (!this.s.sub) return;
    const b = this.text(this.s.sub, this.muted(this.sz(size)), this.p.X0, this.y, this.p.W, this.p.start + (this.st.editorial ? 0 : 250), this.st.editorial ? {} : { presetId: 'preset:motion.blur-in' }, undefined, 'sub');
    this.y = b.y1 + gap;
  }
  private source(): void {
    if (!this.s.source || this.sourceDone) return;
    // C9 (review 2026-10-29): the source line spans the whole content width, also after a split layout narrowed p.X0 / p.W
    const st = this.st, f = this.p.frame, size = this.sz(44);
    const o = asObj(this.s.source);
    // estimate the height first (bottom edge sits sourceBottom above the frame bottom), then place; never smaller than 34 u
    const g = textGeometry({ text: o.text, variantId: 'preset:text.subtitle', position: { x: 0, y: 0 }, maxWidth: this.W0, valign: 'top', style: { fontSize: Math.max(34, o.sizePx !== undefined ? this.ex(o.sizePx) : size), weight: o.weight ?? 400, lineHeight: o.lineHeight } as TextLayerT['style'] }, ratioOf(f), { fontSize: 64, weight: 400, colour: st.c.muted, align: 'left', opacity: 1 }, f);
    const h = g.box.y1 - g.box.y0;
    const top = Math.max(this.y + this.sz(24), f.h - st.sourceBottom - h);
    const { sizePx: _sp, ...rest } = o; void _sp;
    this.text(rest, { ...this.muted(Math.max(34, o.sizePx !== undefined ? this.ex(o.sizePx) : size)), align: st.editorial ? 'left' : st.align }, this.X0, top, this.W0, this.p.start, {}, undefined, 'source');
  }
  private stat(x: SpecStatT, idx: number): void {
    const st = this.st, from = this.at(x.at, this.p.start);
    const hero = this.sz(idx === 0 ? 240 : 176), size = x.sizePx !== undefined ? this.ex(x.sizePx) : hero;
    const colour = hex6(x.color) ?? this.toneColour(x.tone, x.value);
    const counting = x.count !== false && /\d/.test(x.value);
    const fromVal = x.from ? parseLoose(x.from) : 0;
    const countMs = x.countMs ?? (x.countFrames !== undefined ? this.p.toMs(x.countFrames) : idx === 0 ? 1400 : 1000);
    const ease = easeOf(x.easing, { easingId: 'preset:easing.out-cubic' });
    const effect = counting ? { presetId: 'preset:texteffect.counter', params: { from: fromVal ?? 0, durationMs: Math.max(100, countMs), ...(ease.bezier ? { bezier: ease.bezier } : { easingId: ease.easingId }) } } : undefined;
    const e = { ...this.entranceOf(x) };
    let x0 = this.p.X0;
    const top = this.y;
    if (x.prefix) {
      const po = asObj(x.prefix), ps = po.sizePx !== undefined ? this.ex(po.sizePx) : this.sz(80);
      const pw = textWidthEm(po.text, po.weight ?? 400, st.font) * ps;
      // align the prefix baseline with the number baseline (Inter: baseline ≈ (lineHeight / 2 + 0.363) × size below the box top)
      const ptop = top + size * (1.15 / 2 + 0.363) - ps * (1.15 / 2 + 0.363);
      this.text(x.prefix, this.body(ps, po.weight ?? 400), x0, ptop, Math.min(this.p.W * 0.4, pw + 8), from, e, undefined, 'prefix');
      x0 += pw + this.sz(22);
    }
    const nb = this.text({ text: x.value, ...(x.weight ? { weight: x.weight } : {}) }, { size, weight: x.weight ?? 500, color: colour, variant: 'preset:text.title' }, x0, top, this.p.X0 + this.p.W - x0, from, e, effect, 'stat');
    this.y = nb.y1;
    if (x.unit) { const b = this.text(x.unit, this.body(this.sz(88)), this.p.X0, this.y, this.p.W, from, e, undefined, 'unit'); this.y = b.y1 + this.sz(4); }
    if (x.label) { const b = this.text(x.label, this.body(this.sz(72)), this.p.X0, this.y, this.p.W, from, e, undefined, 'label'); this.y = b.y1; }
    if (x.note) { this.y += this.sz(36); const b = this.text(x.note, this.muted(this.sz(60)), this.p.X0, this.y, this.p.W, this.at(asObj(x.note).at, from + 600), {}, undefined, 'note'); this.y = b.y1; }
    if (!st.editorial && idx === 0 && st.align === 'center') void 0;
  }
  private bars(): void {
    const s = this.s, st = this.st, bars = s.bars ?? [], f = this.p.frame;
    if (!bars.length) return;
    // C9 (review 2026-10-29): the gaps take at most half the width, so a large barGapPx never gives a negative bar width
    const gap0 = s.barGapPx !== undefined ? this.ex(s.barGapPx) : this.sz(56);
    const gap = bars.length > 1 ? Math.max(0, Math.min(gap0, (this.p.W * 0.5) / (bars.length - 1))) : gap0;
    const bw = Math.max(1, s.barWidthPx !== undefined ? this.ex(s.barWidthPx) : Math.min(this.sz(300), (this.p.W - gap * (bars.length - 1)) / bars.length));
    const valueSize = this.sz(52), labelSize = this.sz(52);
    // label rows below the baseline: tallest wrapped label
    const labelH = Math.max(...bars.map((b) => textGeometry({ text: b.label, variantId: 'preset:text.subtitle', position: { x: 0, y: 0 }, maxWidth: bw + gap * 0.6, valign: 'top', style: { fontSize: labelSize, weight: 400, align: 'center' } as TextLayerT['style'] }, ratioOf(f), { fontSize: 64, weight: 400, colour: '#FFFFFF', align: 'center', opacity: 1 }, f)).map((g) => g.box.y1 - g.box.y0));
    const srcH = s.source ? textGeometry({ text: textOf(s.source)!, variantId: 'preset:text.subtitle', position: { x: 0, y: 0 }, maxWidth: this.p.W, valign: 'top', style: { fontSize: Math.max(34, this.sz(44)), weight: 400 } as TextLayerT['style'] }, ratioOf(f), { fontSize: 64, weight: 400, colour: '#FFFFFF', align: 'left', opacity: 1 }, f) : null;
    const sourceTop = f.h - st.sourceBottom - (srcH ? srcH.box.y1 - srcH.box.y0 : 0);
    const baseline = sourceTop - this.sz(56) - labelH - this.sz(16);
    const room = Math.max(0, baseline - (this.y + valueSize * 1.15 + this.sz(12)));      // C9: never negative (no NaN / negative heights)
    const maxV = Math.max(...bars.map((b) => b.value ?? 0), 0);
    let heights = bars.map((b) => (b.heightPx !== undefined ? this.ex(b.heightPx) : undefined) ?? (maxV > 0 && b.value !== undefined ? (b.value / maxV) * room : room * 0.5));
    const tallest = Math.max(...heights);
    if (tallest > room && tallest > 0) {
      heights = heights.map((h) => (h * room) / tallest);
      this.p.risks.push({ code: 'bars-scaled', severity: 'info', message: this.p.id ? `Adegan ${this.p.i + 1}: tinggi batang diperkecil ke ${Math.round((100 * room) / tallest)} % agar muat di area aman.` : `Scene ${this.p.i + 1}: bars scaled to ${Math.round((100 * room) / tallest)} % to fit the safe area.` });
    }
    const totalW = bw * bars.length + gap * (bars.length - 1);
    const left = st.align === 'center' ? this.p.X0 + (this.p.W - totalW) / 2 : this.p.X0;
    bars.forEach((b, k) => {
      const cx = left + k * (bw + gap) + bw / 2, h = Math.max(1, heights[k]!);
      const from = this.at(b.at, this.p.start);
      const dashed = b.style === 'dashed';
      const colour = hex6(b.color) ?? (b.tone ? this.toneColour(b.tone) : dashed ? st.c.warning : k === bars.length - 1 ? st.c.positive : st.c.neutral);
      const growMs = b.growMs ?? (b.growFrames !== undefined ? this.p.toMs(b.growFrames) : 1200);
      const ease = easeOf(b.easing, { bezier: [0.2, 0.8, 0.2, 1] });
      const bar = this.shape('preset:shape.rect', cx, baseline - h / 2, bw, h, colour, from, { presetId: 'preset:motion.grow', ms: growMs, ease, params: { direction: 'up' } },
        { params: dashed ? { cornerRadius: 0, outline: true, dashU: 24 } : { cornerRadius: 0 }, ...(dashed ? { stroke: colour, strokeWidth: b.borderPx ?? 8 } : {}) }, 'value');
      const display = b.display ?? (b.value !== undefined ? formatIdNumber(b.value) : undefined);
      if (display) {
        const vTop = bar.y0 - this.sz(12) - valueSize * 1.15;
        this.text({ text: display }, { size: valueSize, weight: 500, color: hex6(b.valueColor) ?? (dashed ? colour : st.c.text), align: 'center' }, cx - (bw + gap * 0.6) / 2, vTop, bw + gap * 0.6, from,
          { presetId: 'preset:motion.rise', ms: growMs, ease, rise: Math.round(h) }, undefined, 'bar-value');
      }
      this.text({ text: b.label }, { ...this.muted(labelSize), align: 'center' }, cx - (bw + gap * 0.6) / 2, baseline + this.sz(16), bw + gap * 0.6, this.p.start, {}, undefined, 'bar-label');
    });
    this.y = baseline + this.sz(16) + labelH;
  }
  private hbars(): void {
    const s = this.s, st = this.st, bars = s.bars ?? [];
    const barH = s.barHeightPx !== undefined ? this.ex(s.barHeightPx) : this.sz(56);
    bars.forEach((b, k) => {
      const from = this.at(b.at, this.p.start);
      const lb = this.text({ text: b.label }, this.body(this.sz(52)), this.p.X0, this.y, this.p.W, this.p.start, {}, undefined, 'hbar-label');
      const top = lb.y1 + this.sz(14);
      const maxV = Math.max(...bars.map((x) => x.value ?? 0), 0);
      const pct = b.widthPct ?? (maxV > 0 && b.value !== undefined ? b.value / maxV : 0.5);
      const w = Math.max(4, pct * this.p.W);
      const colour = hex6(b.color) ?? (b.tone ? this.toneColour(b.tone) : k === bars.length - 1 ? st.c.warning : st.c.positive);
      const ease = easeOf(b.easing, { bezier: [0.2, 0.8, 0.2, 1] });
      const growMs = b.growMs ?? (b.growFrames !== undefined ? this.p.toMs(b.growFrames) : 1200);
      this.shape('preset:shape.rect', this.p.X0 + w / 2, top + barH / 2, w, barH, colour, from, { presetId: 'preset:motion.grow', ms: growMs, ease, params: { direction: 'right' } }, { params: { cornerRadius: 0 } });
      this.y = top + barH + this.sz(14);
      if (b.caption) { const cb = this.text(b.caption, this.muted(this.sz(52)), this.p.X0, this.y, this.p.W, from, {}, undefined, 'hbar-caption'); this.y = cb.y1; }
      this.y += this.sz(48);
    });
  }
  private note(): void {
    if (!this.s.note) return;
    const o = asObj(this.s.note);
    const colour = this.toneColour(this.s.noteTone ?? 'negative');
    this.y += this.sz(24);
    const b = this.text(this.s.note, { size: this.sz(64), weight: 400, color: colour }, this.p.X0, this.y, this.p.W, this.at(o.at, this.p.start + 800), {}, undefined, 'note');
    this.y = b.y1 + this.sz(40);
  }
  private bullets(): void {
    const st = this.st, list = this.s.bullets ?? [];
    const size = this.sz(60), indent = this.sz(st.editorial ? 52 : 76);
    // centred layouts: the list is a left-aligned column centred under the headline
    const X0 = this.p.X0, W = this.p.W;
    if (st.align === 'center') {
      const widest = Math.max(...list.map((t) => textWidthEm(asObj(t).text, 400, st.font) * size));
      const colW = Math.min(W, widest + indent + this.sz(24));
      this.p.X0 = X0 + (W - colW) / 2; this.p.W = colW;
    }
    list.forEach((t, k) => {
      const from = this.at(asObj(t).at, this.p.start + 350 + k * 380);
      const b = this.text(t, { ...this.body(size), align: 'left' }, this.p.X0 + indent, this.y, this.p.W - indent, from, st.editorial ? {} : { presetId: 'preset:motion.rise', rise: this.sz(28), ms: 500 }, undefined, 'bullet');
      const cy = b.y0 + size * 1.15 / 2;
      if (st.editorial) this.shape('preset:shape.line', this.p.X0 + this.sz(14), cy, this.sz(28), this.sz(8), st.c.accent, from, { presetId: 'preset:motion.wipe-reveal', ms: 400 });
      else this.shape('preset:shape.chevron', this.p.X0 + this.sz(30), cy, this.sz(46), this.sz(46), k % 2 ? st.c.accent2 : st.c.accent, from, { presetId: 'preset:motion.draw-on', ms: 500, params: { loop: 'float' } });
      this.y = b.y1 + this.sz(36);
    });
    this.p.X0 = X0; this.p.W = W;
  }
  private cta(): void {
    const s = this.s, st = this.st;
    if (s.kicker) { const b = this.text(s.kicker, this.muted(this.sz(64)), this.p.X0, this.y, this.p.W, this.p.start, {}, undefined, 'cta-kicker'); this.y = b.y1 + this.sz(32); }
    else if (s.headline) { const b = this.text(s.headline, this.body(this.sz(88), 500), this.p.X0, this.y, this.p.W, this.p.start, {}, undefined, 'cta-headline'); this.y = b.y1 + this.sz(40); }
    const pillText = s.handle ?? s.button;
    if (pillText) {
      const po = asObj(pillText), pill = s.pill ?? {};
      const padY = pill.padYPx !== undefined ? this.ex(pill.padYPx) : this.sz(40), padX = pill.padXPx !== undefined ? this.ex(pill.padXPx) : this.sz(72);
      const from = this.at(po.at, this.p.start);
      const b = this.text(pillText, { size: this.sz(76), weight: 500, color: st.c.text, variant: 'preset:text.title', box: { colour: hex6(pill.color) ?? st.c.pill, padX, padY, radius: pill.radiusPx ?? 999 } }, this.p.X0, this.y, this.p.W, from,
        { presetId: 'preset:motion.pop', ms: 600, params: { damping: 14, ...(st.editorial ? {} : { loop: 'pulse' }) } }, undefined, 'pill');
      this.y = b.y1 + this.sz(36);
      if (!st.editorial && b.x1 + this.sz(150) <= this.p.X0 + this.p.W) this.shape('preset:shape.arrow', Math.min(b.x1 + this.sz(70), this.p.X0 + this.p.W - this.sz(40)), (b.y0 + b.y1) / 2, this.sz(80), this.sz(80), st.c.accent2, from + 400, { presetId: 'preset:motion.slide-in', params: { direction: 'from-left', loop: 'sway' }, ms: 500 });
    }
    if (s.action) { const b = this.text(s.action, this.body(this.sz(80), 500), this.p.X0, this.y, this.p.W, this.at(asObj(s.action).at, this.p.start), {}, undefined, 'cta-action'); this.y = b.y1; }
    else if (s.headline && s.kicker) { const b = this.text(s.headline, this.body(this.sz(80), 500), this.p.X0, this.y, this.p.W, this.p.start, {}, undefined, 'cta-headline'); this.y = b.y1; }
  }
  private split(): void {
    const s = this.s, st = this.st, f = this.p.frame;
    const asset = s.assetId;
    if (!asset) { this.headline(96, 500, 40); this.sub(); return; }
    const imgW = this.p.portrait ? this.p.W : this.p.W * 0.45;
    const imgH = this.p.portrait ? Math.min(this.p.W * 0.75, 700) : (f.h - st.safe.top - st.safe.bottom) * 0.8;
    const cx = this.p.X0 + imgW / 2, cy = this.y + imgH / 2;
    this.p.ops.push({ op: 'op:overlay.addImage', args: { assetId: asset, atMs: this.p.start, durationMs: Math.max(100, this.p.end - this.p.start), position: { x: round1(cx - f.w / 2), y: round1(cy - f.h / 2) }, size: Math.round(imgW), objectFit: 'contain', motion: this.motion({ presetId: 'preset:motion.scale-in', ms: 700 }) } });
    this.p.elements.push({ key: `${this.p.i}:image`, scene: this.p.i, kind: 'image', box: { x0: cx - imgW / 2, y0: cy - imgH / 2, x1: cx + imgW / 2, y1: cy + imgH / 2 }, fromMs: this.p.start, toMs: this.p.end, hasEntrance: true });
    if (this.p.portrait) this.y += imgH + this.sz(48);
    else { this.p.X0 += imgW + this.sz(64); this.p.W -= imgW + this.sz(64); }
    this.headline(84, 500, 36); this.sub(56);
  }

  // ───────────── FR-261: footage scenes ─────────────
  /** Set by a footage layout: the content must end above this y (split with the footage below), the source line is placed already. */
  private limitY: number | null = null;
  private sourceDone = false;
  /** Runs `fn` with a shorter element window (overlays over footage stay a few seconds) and their own exit fade. */
  private within<T>(end: number, exitMs: number, fn: () => T): T {
    const e = this.p.end, x = this.p.exitMs;
    this.p.end = Math.max(this.p.start + 200, Math.min(e, end)); this.p.exitMs = exitMs;
    try { return fn(); } finally { this.p.end = e; this.p.exitMs = x; }
  }
  private measure(text: string, size: number, weight: number, maxW: number, variant = 'preset:text.subtitle'): { w: number; h: number } {
    const f = this.p.frame;
    const g = textGeometry({ text, variantId: variant, position: { x: 0, y: 0 }, maxWidth: maxW, valign: 'top', style: { fontSize: size, weight, fontFamily: this.st.font } as TextLayerT['style'] }, ratioOf(f), { fontSize: 64, weight, colour: '#FFFFFF', align: 'left', opacity: 1 }, f);
    return { w: g.box.x1 - g.box.x0, h: g.box.y1 - g.box.y0 };
  }
  /** {footageMs} / {say} anchors: source time of the scene's footage → timeline time. */
  private footageAt(a: SpecAnchorT, fallback: number): number {
    const fw = this.p.footage, n = this.p.i + 1;
    if (!fw) { this.p.risks.push({ code: 'footage-anchor', severity: 'warn', message: this.p.id ? `Adegan ${n}: jangkar footage tanpa footage di adegan ini.` : `Scene ${n}: a footage anchor in a scene without footage.` }); return fallback; }
    const clip0 = this.p.clipStart ?? this.p.start;
    let src: number | null = null;
    if ('footageMs' in a) src = a.footageMs;
    else if ('say' in a) {
      src = findSaid(fw.words, a.say, fw.trimBeforeMs, fw.availMs, a.edge ?? 'start');
      if (src === null) { this.p.risks.push({ code: 'say-not-found', severity: 'info', message: this.p.id ? `Adegan ${n}: "${a.say}" tidak ditemukan di ${fw.words.length ? 'transkrip' : 'footage (belum ada transkrip)'}; teks muncul di awal adegan.` : `Scene ${n}: "${a.say}" was not found in the ${fw.words.length ? 'transcript' : 'footage (no transcript yet)'}; the text appears at the scene start.` }); return fallback; }
    }
    const off = 'offsetMs' in a && typeof a.offsetMs === 'number' ? a.offsetMs : 0;
    const t = clip0 + (src! - fw.trimBeforeMs) + off;
    return Math.max(this.p.start, Math.min(Math.round(t), this.p.end - 400));
  }
  private footageScene(): void {
    const s = this.s, fw = this.p.footage, f = this.p.frame;
    this.limitY = null; this.sourceDone = false;
    if (!fw) { this.kicker(); this.headline(96, 800, 40); this.sub(); return; }       // no usable footage: a plain title scene (risk already given)
    // ADR-041 dark-grain: the 0.5 dim of the footage (the vignette + grain ride on the clip insert as effects) — a full-frame
    // black shape at 0.5 behind every text of the scene; it starts with the clip and has no entrance
    if (s.footage?.grade === 'dark-grain') {
      const from = this.p.clipStart ?? this.p.start;
      this.p.ops.push({ op: 'op:shape.add', args: { presetId: 'preset:shape.rect', atMs: from, durationMs: Math.max(100, this.p.end - from), position: { x: 0, y: 0 }, size: f.w, height: f.h, fill: '#000000', opacity: 0.5, motion: { presetId: 'preset:motion.none' }, params: { cornerRadius: 0 } } });
      this.p.elements.push({ key: `${this.p.i}:dim`, scene: this.p.i, kind: 'shape', box: { x0: 0, y0: 0, x1: f.w, y1: f.h }, fromMs: from, toMs: this.p.end, hasEntrance: false, holds: 'footage' });
    }
    if (s.role === 'footage-split') { this.footageSplit(); return; }
    if (s.role === 'footage-pip') { this.footagePip(); return; }
    this.footageOverlays();
  }
  /** The scene's own content (kicker, headline, sub, stats, bullets, note) in the area set up by split / pip. */
  private flow(): void {
    const st = this.st, s = this.s;
    this.kicker();
    if (s.headline) this.headline(this.p.portrait ? 84 : 72, st.editorial ? 600 : 800, 36);
    this.sub(52, 36);
    (s.stats ?? []).forEach((x, k) => { if (k) this.y += this.sz(56); this.stat(x, Math.min(k, 1) + (this.p.portrait ? 0 : 1)); });
    this.bullets();
    this.note();
  }
  /** Landscape split / pip: the text block is centred vertically in the content height (shifts every op it added). */
  private centreSince(o0: number, e0: number, y0: number): void {
    const st = this.st, f = this.p.frame, h = this.y - y0;
    const dy = Math.max(st.safe.top, st.safe.top + (f.h - st.safe.top - st.safe.bottom - h) / 2) - y0;
    if (Math.abs(dy) <= 1) return;
    for (const op of this.p.ops.slice(o0)) { const a = op.args as Record<string, { x: number; y: number }>; if (a['position']) a['position'] = { x: a['position'].x, y: round1(a['position'].y + dy) }; }
    for (const el of this.p.elements.slice(e0)) el.box = { ...el.box, y0: el.box.y0 + dy, y1: el.box.y1 + dy };
    this.y += dy;
  }
  private footageSplit(): void {
    const f = this.p.frame, st = this.st, half = splitSide(this.p.portrait, this.s.side);
    const o0 = this.p.ops.length, e0 = this.p.elements.length;
    if (half === 'top') this.y = f.h / 2 + this.sz(56);
    else if (half === 'bottom') { this.y = st.safe.top + this.sz(24); this.limitY = f.h / 2 - this.sz(40); }
    else if (half === 'left') { this.p.X0 = f.w / 2 + this.sz(64); this.p.W = f.w - st.safe.right - this.p.X0; this.y = st.safe.top; }
    else { this.p.W = f.w / 2 - this.sz(64) - this.p.X0; this.y = st.safe.top; }
    const y0 = this.y;
    this.flow();
    if (half === 'left' || half === 'right') this.centreSince(o0, e0, y0);
  }
  private footagePip(): void {
    const f = this.p.frame, st = this.st, b = pipBox(f, st.safe, this.p.portrait, this.s.side);
    const o0 = this.p.ops.length, e0 = this.p.elements.length;
    // a thin accent frame around the footage window (an outline: never covers the picture)
    const fw = this.sz(10);
    this.shape('preset:shape.rect', (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.x1 - b.x0 + fw, b.y1 - b.y0 + fw, st.c.accent, this.p.start, { presetId: 'preset:motion.draw-on', ms: 700 },
      { params: { cornerRadius: 0, outline: true }, stroke: st.c.accent, strokeWidth: 6 }, 'footage');
    if (this.p.portrait) this.y = b.y1 + this.sz(64);
    else if (this.s.side === 'left') { this.p.X0 = b.x1 + this.sz(64); this.p.W = f.w - st.safe.right - this.p.X0; this.y = st.safe.top; }
    else { this.p.W = b.x0 - this.sz(64) - this.p.X0; this.y = st.safe.top; }
    const y0 = this.y;
    this.flow();
    if (!this.p.portrait) this.centreSince(o0 + 1, e0 + 1, y0);
  }
  /**
   * Full-frame footage: a few overlays, one after the other, each only a few seconds and only in the top / bottom third on the side
   * away from the subject (footage.focus): kinetic title → lower-third → stat callouts → list callouts → note. With captions on (they
   * sit at the bottom), the lower-third moves to the top third.
   */
  private footageOverlays(): void {
    const s = this.s, st = this.st, f = this.p.frame, fw = this.p.footage!;
    const mode = s.overlay ?? 'auto';
    const y0 = this.y;
    this.y = st.safe.top;                                                          // nothing flows: overflow() stays negative
    if (mode === 'none') return;
    const topY = st.safe.top + this.sz(24), bottomY = f.h - st.safe.bottom;
    const subjectTop = fw.focus === 'top';
    const lowerAtTop = (this.p.captions === true || mode === 'top') && !subjectTop;
    const right = fw.focus === 'left';
    const maxW = Math.min(this.p.W, f.w * (this.p.portrait ? 0.86 : 0.52));
    const x0 = right ? this.p.X0 + this.p.W - maxW : this.p.X0;
    const align: 'left' | 'right' = right ? 'right' : 'left';
    const sceneEnd = this.p.end, exit = 300;
    let t = this.p.start + 250;
    const slot = (at: SpecAnchorT | undefined, ms: number) => { const from = this.at(at, t); const to = Math.min(sceneEnd, from + ms); t = Math.max(t, to + 250); return { from, to }; };
    const panel = (px0: number, top: number, w: number, h: number, from: number, key: string) => this.shape('preset:shape.rect', px0 + w / 2, top + h / 2, w, h, '#000000', from,
      { presetId: 'preset:motion.wipe-reveal', ms: 450, params: { direction: right ? 'from-right' : 'from-left' } }, { opacity: 0.62, params: { cornerRadius: this.sz(12) } }, key);
    const room = () => t < sceneEnd - 1200;
    // overlays that show at the same time never share space: a later one stacks under (top third) / over (bottom third) the earlier
    const placed: Array<{ from: number; to: number; y0: number; y1: number }> = [];
    const gapY = this.sz(20);
    const fit = (pref: number, h: number, from: number, to: number, down: boolean): number => {
      let top = pref;
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find((q) => q.from < to && from < q.to && top < q.y1 + gapY && q.y0 < top + h + gapY);
        if (!hit) break;
        top = down ? hit.y1 + gapY : hit.y0 - gapY - h;
      }
      placed.push({ from, to, y0: top, y1: top + h });
      return top;
    };
    // 1. kinetic title (boxed words, word by word) in the top third — or the bottom third when the subject is at the top
    if (s.headline && mode !== 'callout') {
      const o = asObj(s.headline), size = o.sizePx !== undefined ? this.ex(o.sizePx) : this.sz(this.p.portrait ? 84 : 72);
      const m = this.measure(o.text, size, 800, maxW, 'preset:text.title');
      const { from, to } = slot(o.at, Math.max(2600, 1200 + 320 * words(o.text)));
      const bh = m.h + this.sz(12) * 2;
      const top = fit(subjectTop ? bottomY - bh - this.sz(40) : topY, bh, from, to, !subjectTop) + this.sz(12);
      const kw = s.keywords?.length ? { presetId: 'preset:texteffect.keyword', params: { words: s.keywords, colour: st.c.accent } } : undefined;
      this.within(to, exit, () => this.text(s.headline!, { size, weight: 800, color: '#FFFFFF', variant: 'preset:text.title', align, box: { colour: '#111111', padX: this.sz(26), padY: this.sz(12), radius: this.sz(14) } },
        x0, top, maxW, from, { presetId: 'preset:motion.word-stagger', params: { staggerFrames: 3 } }, kw, 'footage-title'));
    }
    // 2. lower-third: name (+ role / place) on a dark panel with an accent bar
    const lt = s.lowerThird ?? (s.kicker && !s.headline ? { name: s.kicker, ...(s.sub ? { title: s.sub } : {}) } : undefined);
    // an anchored lower-third keeps its moment (it stacks with the title when both show); without an anchor it needs room after the title
    const ltRoom = lt ? (lt.at ? this.at(lt.at, t) < sceneEnd - 1000 : room()) : false;
    if (lt && !ltRoom) this.p.risks.push({ code: 'footage-dense', severity: 'info', message: this.p.id ? `Adegan ${this.p.i + 1}: footage terlalu pendek untuk lower-third; tidak ditampilkan.` : `Scene ${this.p.i + 1}: the footage is too short for the lower-third; it was left out.` });
    if (lt && ltRoom && (mode === 'auto' || mode === 'lower-third' || mode === 'top')) {
      const pad = this.sz(26), bar = this.sz(10), gap = this.sz(6);
      const name = asObj(lt.name), title = lt.title ? asObj(lt.title) : null;
      const ns = name.sizePx !== undefined ? this.ex(name.sizePx) : this.sz(60), ts = title?.sizePx !== undefined ? this.ex(title.sizePx) : this.sz(42);
      const inner = maxW - pad * 2 - bar;
      const mn = this.measure(name.text, ns, 700, inner), mt = title ? this.measure(title.text, ts, 400, inner) : { w: 0, h: 0 };
      const pw = Math.min(maxW, Math.max(mn.w, mt.w) + pad * 2 + bar + this.sz(6)), ph = mn.h + (title ? gap + mt.h : 0) + pad * 2;
      const px0 = right ? this.p.X0 + this.p.W - pw : this.p.X0;
      const { from, to } = slot(lt.at, lt.ms ?? 4000);
      const top = fit(lowerAtTop ? topY : bottomY - ph, ph, from, to, lowerAtTop);
      this.within(to, exit, () => {
        panel(px0, top, pw, ph, from, 'lower-third');
        this.shape('preset:shape.rect', right ? px0 + pw - bar / 2 : px0 + bar / 2, top + ph / 2, bar, ph, st.c.accent, from + 150, { presetId: 'preset:motion.grow', ms: 400, params: { direction: 'up' } }, { params: { cornerRadius: 0 } }, 'lower-third');
        const tx = right ? px0 + pad : px0 + bar + pad;
        this.text({ ...name, align }, { size: ns, weight: 700, color: '#FFFFFF' }, tx, top + pad, pw - pad * 2 - bar, from + 200, { presetId: 'preset:motion.rise', rise: this.sz(18), ms: 450 }, undefined, 'lower-third-name');
        if (title) this.text({ ...title, align }, { size: ts, weight: 400, color: '#E6E6E6' }, tx, top + pad + mn.h + gap, pw - pad * 2 - bar, from + 350, { presetId: 'preset:motion.rise', rise: this.sz(14), ms: 450 }, undefined, 'lower-third-title');
      });
    }
    // 3. stat callouts (counting number + label on a panel), top third, with the source under the panel while it shows
    for (const x of s.stats ?? []) {
      if (!room()) { this.p.risks.push({ code: 'footage-dense', severity: 'info', message: this.p.id ? `Adegan ${this.p.i + 1}: footage terlalu pendek untuk semua teks; sebagian tidak ditampilkan.` : `Scene ${this.p.i + 1}: the footage is too short for every text; some were left out.` }); break; }
      const pad = this.sz(28), vs = x.sizePx !== undefined ? this.ex(x.sizePx) : this.sz(this.p.portrait ? 140 : 120), ls = this.sz(44);
      const label = [x.prefix ? textOf(x.prefix) : '', x.unit ? textOf(x.unit) : '', x.label ? textOf(x.label) : ''].filter(Boolean).join(' · ');
      const mv = this.measure(x.value, vs, 800, maxW - pad * 2, 'preset:text.title'), ml = label ? this.measure(label, ls, 400, maxW - pad * 2) : { w: 0, h: 0 };
      const pw = Math.min(maxW, Math.max(mv.w, ml.w) + pad * 2), ph = mv.h + (label ? this.sz(8) + ml.h : 0) + pad * 2;
      const px0 = right ? this.p.X0 + this.p.W - pw : this.p.X0;
      const { from, to } = slot(x.at, 3600);
      const srcH = s.source ? this.measure(textOf(s.source)!, Math.max(34, this.sz(36)), 400, maxW).h + this.sz(14) : 0;
      const top = fit(subjectTop ? bottomY - ph - srcH : topY, ph + srcH, from, to, !subjectTop);
      const counting = x.count !== false && /\d/.test(x.value);
      const ease = easeOf(x.easing, { easingId: 'preset:easing.out-cubic' });
      const effect = counting ? { presetId: 'preset:texteffect.counter', params: { from: (x.from ? parseLoose(x.from) : 0) ?? 0, durationMs: Math.max(100, x.countMs ?? 1200), ...(ease.bezier ? { bezier: ease.bezier } : { easingId: ease.easingId }) } } : undefined;
      this.within(to, exit, () => {
        panel(px0, top, pw, ph, from, 'callout');
        this.text({ text: x.value, align }, { size: vs, weight: 800, color: hex6(x.color) ?? this.toneColour(x.tone, x.value), variant: 'preset:text.title' }, px0 + pad, top + pad, pw - pad * 2, from + 150, { presetId: 'preset:motion.pop', ms: 500 }, effect, 'callout-value');
        if (label) this.text({ text: label, align }, { size: ls, weight: 400, color: '#E6E6E6' }, px0 + pad, top + pad + mv.h + this.sz(8), pw - pad * 2, from + 300, {}, undefined, 'callout-label');
        if (s.source) { const so = asObj(s.source); this.text({ ...so, align }, { size: Math.max(34, this.sz(36)), weight: 400, color: '#E6E6E6' }, x0, top + ph + this.sz(14), maxW, from, {}, undefined, 'source'); }
      });
      if (s.source) this.sourceDone = true;
    }
    // 4. list callouts: one boxed line at a time
    for (const b of s.bullets ?? []) {
      if (!room()) break;
      const o = asObj(b), size = this.sz(56);
      const { from, to } = slot(o.at, Math.max(2200, 900 + 300 * words(o.text)));
      const bh = this.measure(o.text, size, 600, maxW).h + this.sz(10) * 2;
      const top = fit(subjectTop ? bottomY - bh - this.sz(40) : topY, bh, from, to, !subjectTop) + this.sz(10);
      this.within(to, exit, () => this.text({ ...o, align }, { size, weight: 600, color: '#FFFFFF', box: { colour: '#111111', padX: this.sz(22), padY: this.sz(10), radius: this.sz(12) } }, x0, top, maxW, from, { presetId: 'preset:motion.rise', rise: this.sz(24), ms: 450 }, undefined, 'callout-bullet'));
    }
    // 5. note (a short remark), boxed in the tone colour
    if (s.note && room()) {
      const o = asObj(s.note), size = this.sz(52);
      const { from, to } = slot(o.at, 3000);
      const bh = this.measure(o.text, size, 600, maxW).h + this.sz(10) * 2;
      const top = fit(subjectTop ? bottomY - bh - this.sz(40) : topY, bh, from, to, !subjectTop) + this.sz(10);
      this.within(to, exit, () => this.text({ ...o, align }, { size, weight: 600, color: '#FFFFFF', box: { colour: hex6(this.toneColour(s.noteTone ?? 'accent')) ?? '#111111', padX: this.sz(22), padY: this.sz(10), radius: this.sz(12) } }, x0, top, maxW, from, {}, undefined, 'note'));
    }
    if (s.source && !this.sourceDone && !(s.stats ?? []).length) void 0;          // a source without a figure: shown by finish() as usual
    void y0;
  }
  // ───────────── ADR-041: image scenes (internet pictures with marks) ─────────────
  /**
   * One picture or a stack from the Library on its blurred copy / paper / a solid: kicker + headline on top (boxed keywords),
   * the pictures in the upper 60 % of the remaining area (rounded 24 u, shadow, tilted when stacked, a slow zoom / drift),
   * annotation marks inside the picture box at their anchors, chips in the corners, a one-line caption above the caption band
   * (only when captions are off) and the source tag at the bottom. Everything stays inside the safe area; marks never leave the
   * picture (clamped, reported as an info risk).
   */
  private imageScene(): void {
    const s = this.s, st = this.st, f = this.p.frame;
    const imgs = s.images ?? [];
    const assets = this.p.assets ?? [];
    this.limitY = null; this.sourceDone = false;
    this.y = st.safe.top + (s.topPx ?? this.sz(32));
    this.kicker();
    if (s.headline) this.headline(this.p.portrait ? 76 : 64, 800, this.sz(28));
    if (s.sub) this.sub(48, this.sz(24));
    // the area under the texts, above the caption line / source tag / caption band
    const bottomLimit = f.h - st.safe.bottom;
    const cap = !this.p.captions && s.caption ? asObj(s.caption) : null;
    const capSize = cap?.sizePx !== undefined ? this.ex(cap.sizePx) : this.sz(48), capPad = this.sz(12);
    const capH = cap ? this.measure(cap.text, capSize, 700, this.p.W - this.sz(48)).h + capPad * 2 : 0;
    const srcText = textOf(s.source) ?? textOf(imgs[0]?.source);
    const srcH = srcText ? this.sz(52) : 0;
    const area: BoxU = { x0: this.p.X0, y0: this.y, x1: this.p.X0 + this.p.W, y1: bottomLimit - (srcH ? srcH + this.sz(16) : 0) - (capH ? capH + this.sz(24) : 0) };
    const found = imgs.map((im) => assets.find((a) => a.id === im.assetId && a.kind === 'image' && a.status === 'ready'));
    found.forEach((a, k) => { if (!a) this.p.risks.push({ code: 'image-missing', severity: 'warn', message: this.p.id ? `Adegan ${this.p.i + 1}: gambar ${imgs[k]!.assetId} tidak ada atau belum siap di proyek; dilewati.` : `Scene ${this.p.i + 1}: image ${imgs[k]!.assetId} is missing or not ready in the project; skipped.` }); });
    const shown = imgs.map((im, k) => ({ im, a: found[k] })).filter((x): x is { im: typeof imgs[number]; a: AssetFacts } => !!x.a);
    if (!shown.length) { this.y = area.y0; return; }
    const boxes = pictureBoxes(s.layout, shown.map((x) => aspectOf(x.a)), area, f.w);
    const pic = unionBox(boxes.map((b) => b.box));
    const from = this.p.start, len = Math.max(1000, this.p.end - from);
    const stack = boxes.length > 1 && (s.layout ?? 'stack') === 'stack';
    const pan = s.pan ?? 'zoom-in';
    const panMotion = (): Entrance => {
      const ms = Math.min(10_000, len);
      if (stack) return { presetId: 'preset:motion.scale-in', ms: 500, params: { fromScale: 0.85 } };
      switch (pan) {
        case 'none': return { presetId: 'preset:motion.scale-in', ms: 600, params: { fromScale: 0.92 } };
        case 'zoom-out': return { presetId: 'preset:motion.scale-in', ms, params: { fromScale: 1.1 }, ease: { easingId: 'preset:easing.linear' } };
        case 'left': case 'right': return { presetId: 'preset:motion.zoom-drift', ms, params: { toScale: 1.06 }, ease: { easingId: 'preset:easing.linear' } };
        default: return { presetId: 'preset:motion.zoom-drift', ms, params: { toScale: 1.08 }, ease: { easingId: 'preset:easing.linear' } };
      }
    };
    boxes.forEach((pb, k) => {
      const { im, a } = shown[k]!, b = pb.box;
      const w = b.x1 - b.x0, h = b.y1 - b.y0;
      // left / right pans: no transform keyframes in the Composition Model today — the picture starts offset toward the other side so the drift reads as a pan
      const dx = !stack && pan === 'left' ? w * 0.03 : !stack && pan === 'right' ? -w * 0.03 : 0;
      const cx = (b.x0 + b.x1) / 2 + dx, cy = (b.y0 + b.y1) / 2;
      const rotation = im.rotationDeg ?? pb.rotation;
      const at = from + k * 180;
      this.p.ops.push({ op: 'op:overlay.addImage', args: { assetId: a.id, atMs: at, durationMs: Math.max(100, this.p.end - at), position: { x: round1(cx - f.w / 2), y: round1(cy - f.h / 2) }, size: Math.round(w), objectFit: 'contain',
        radius: s.layout === 'phone' ? PHONE_RADIUS_U : PICTURE_RADIUS_U, shadow: true, ...(rotation ? { rotation } : {}), motion: this.motion(panMotion()) } });
      this.p.elements.push({ key: `${this.p.i}:image:${k}`, scene: this.p.i, kind: 'image', box: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }, fromMs: at, toMs: this.p.end, hasEntrance: true });
      // the picture's own label (a small white pill at its bottom-left, e.g. an account name)
      if (im.label) {
        const lo = asObj(im.label), ls = this.sz(32), m = this.measure(lo.text, ls, 700, w - this.sz(40));
        const pw = Math.min(w - this.sz(40), m.w + this.sz(28) + PILL_SLACK), ph = m.h + this.sz(14);
        this.text(im.label, { size: ls, weight: 700, color: '#FFFFFF', align: 'center', box: { colour: '#111111', padX: this.sz(14), padY: this.sz(7), radius: 999 } }, b.x0 + this.sz(20), b.y1 - this.sz(20) - ph, pw, at + 300, { presetId: 'preset:motion.rise', rise: this.sz(16), ms: 400 }, undefined, 'image-label');
      }
    });
    // annotations: arrows point at (x, y) from the nearest free side; boxes / rings / X marks centred; labels as pills — all inside the picture
    let clamped = 0;
    (s.annotations ?? []).forEach((an, k) => {
      const at = this.at(an.at, from + 500 + k * 400);
      const labelText = an.text ? asObj(an.text) : null;
      const ls = this.sz(36), lm = labelText ? this.measure(labelText.text, ls, 800, pic.x1 - pic.x0 - this.sz(40)) : null;
      const labelSize = lm ? { w: Math.min(pic.x1 - pic.x0, lm.w + this.sz(32) + PILL_SLACK), h: lm.h + this.sz(16) } : undefined;
      const m = annotationMark(an, pic, ANNOTATION_RED, labelSize);
      if (m.clamped) clamped++;
      const e: Entrance = m.motion === 'draw-on' ? { presetId: 'preset:motion.draw-on', ms: 500 } : { presetId: 'preset:motion.pop', ms: 450, params: { damping: 12 } };
      if (m.kind === 'label') {
        this.text(labelText ?? { text: '•' }, { size: ls, weight: 800, color: '#FFFFFF', align: 'center', box: { colour: m.colour, padX: this.sz(16), padY: this.sz(8), radius: 999 } }, m.cx - m.w / 2, m.cy - m.h / 2, m.w, at, e, undefined, 'annotation-label');
      } else {
        const outline = m.kind === 'box' || m.kind === 'circle';
        this.shape(m.presetId, m.cx, m.cy, m.w, m.h, m.colour, at, e, { params: m.params, ...(m.rotation ? { rotation: m.rotation } : {}), ...(outline ? { stroke: m.colour, strokeWidth: m.kind === 'box' ? 8 : 10 } : {}) }, 'picture');
        // a text on an arrow / box / X: a pill just under the mark, inside the picture
        if (labelText && labelSize) {
          const ly = Math.min(pic.y1 - labelSize.h, m.cy + m.h / 2 + this.sz(8)), lx = Math.min(Math.max(m.cx - labelSize.w / 2, pic.x0), pic.x1 - labelSize.w);
          this.text(labelText, { size: ls, weight: 800, color: '#FFFFFF', align: 'center', box: { colour: m.colour, padX: this.sz(16), padY: this.sz(8), radius: 999 } }, lx, ly, labelSize.w, at + 150, { presetId: 'preset:motion.pop', ms: 400 }, undefined, 'annotation-label');
        }
      }
      this.p.sfx?.('pop', at);
    });
    if (clamped) this.p.risks.push({ code: 'annotation-clamped', severity: 'info', message: this.p.id ? `Adegan ${this.p.i + 1}: ${clamped} tanda digeser agar tetap di dalam gambar.` : `Scene ${this.p.i + 1}: ${clamped} mark(s) moved to stay inside the picture.` });
    // chips in the picture corners (BEFORE green, AFTER red, warning amber)
    const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
    (s.chips ?? []).forEach((ch, k) => {
      // a chip is one line: the text shrinks (≥ 26 u) until it fits 60 % of the picture width, the pill gets a little slack
      const o = asObj(ch.text), padX = this.sz(18), padY = this.sz(9), avail = (pic.x1 - pic.x0) * 0.6;
      let size = this.sz(34), m = this.measure(o.text.toUpperCase(), size, 800, avail * 2);
      if (m.w + padX * 2 + PILL_SLACK > avail) { size = Math.max(26, Math.floor((size * (avail - padX * 2 - PILL_SLACK)) / m.w)); m = this.measure(o.text.toUpperCase(), size, 800, avail * 2); }
      const w = Math.min(avail, m.w + padX * 2 + PILL_SLACK), h = m.h + padY * 2;
      const b = chipBox(ch.position ?? corners[k % 4], boxes.length === 2 && s.layout === 'side-by-side' ? boxes[String(ch.position ?? corners[k % 4] ?? 'top-left').endsWith('right') ? 1 : 0]!.box : pic, w, h, this.sz(20));
      const col = chipColours(ch.tone, o.text);
      this.text({ ...o, text: o.text.toUpperCase() }, { size, weight: 800, color: col.text, align: 'center', box: { colour: col.fill, padX, padY, radius: this.sz(10) } }, b.x0, b.y0, w, this.at(o.at, from + 350 + k * 250), { presetId: 'preset:motion.pop', ms: 400, params: { damping: 12 } }, undefined, 'chip');
    });
    // caption line (white on a dark box) above the caption band, then the source tag
    let y = area.y1;
    if (cap) {
      y = bottomLimit - (srcH ? srcH + this.sz(16) : 0) - capH;
      this.text(cap, { size: capSize, weight: 700, color: '#FFFFFF', align: 'center', box: { colour: '#111111', padX: this.sz(24), padY: capPad, radius: this.sz(14) } }, this.p.X0, y + capPad, this.p.W, this.at(cap.at, from + 300), { presetId: 'preset:motion.rise', rise: this.sz(20), ms: 450 }, undefined, 'caption');
    }
    if (srcText) {
      const sp = getPreset('preset:shape.source-tag') ? 'preset:shape.source-tag' : 'preset:shape.rect';
      const m = this.measure(srcText, 32, 500, this.p.W - 40), w = Math.min(this.p.W, m.w + 44);
      this.shape(sp, this.p.X0 + w / 2, bottomLimit - srcH / 2, w, srcH, st.viral ? '#1A1A1E' : st.bg, from + 200, { presetId: 'preset:motion.fade-in', ms: 300 }, { opacity: 0.92, params: sp === 'preset:shape.source-tag' ? { text: srcText.slice(0, 200) } : { cornerRadius: 24 } }, 'source');
      this.sourceDone = true;
    }
    void y;
    this.y = area.y0;                                                             // nothing flows: everything above was placed inside the area (overflow() stays negative)
  }

  build(withSource = true): void {
    const s = this.s, st = this.st, f = this.p.frame;
    const centreVertically = !st.editorial && ['hook', 'title', 'question', 'quote', 'stat', 'body', 'list', 'cta', 'split'].includes(s.role) && s.topPx === undefined;
    const startOps = this.p.ops.length, startEls = this.p.elements.length, y0 = this.y;
    switch (s.role) {
      case 'hook': case 'title': this.kicker(); this.headline(s.role === 'hook' ? (st.editorial ? 104 : 116) : 110, st.editorial ? 500 : 800, 44); this.sub(); break;
      case 'body': this.kicker(); this.headline(st.editorial ? 84 : 92, st.editorial ? 500 : 800, 40); this.sub(56); this.bullets(); break;
      case 'list': this.kicker(); this.headline(st.editorial ? 80 : 88, st.editorial ? 500 : 800, 56); this.bullets(); break;
      case 'stat': case 'stat-compare': {
        this.kicker();
        if (s.headline) this.headline(72, 500, 32);
        const stats = s.stats ?? [];
        if (!this.p.portrait && stats.length === 2) {
          // landscape: the two figures side by side in two columns
          const gap = this.sz(96), colW = (this.p.W - gap) / 2, top = this.y, X0 = this.p.X0, W = this.p.W;
          let bottom = top;
          // baselines aligned: a smaller figure starts lower by the difference of the baseline offsets (Inter ≈ 0.938 × size)
          const sizeOf = (x: SpecStatT) => (x.sizePx !== undefined ? this.ex(x.sizePx) : this.sz(240));
          const big = Math.max(...stats.map(sizeOf));
          stats.forEach((x, k) => { this.p.X0 = X0 + k * (colW + gap); this.p.W = colW; this.y = top + (big - sizeOf(x)) * 0.938; this.stat(x, 0); bottom = Math.max(bottom, this.y); });
          this.p.X0 = X0; this.p.W = W; this.y = bottom;
        } else stats.forEach((x, k) => { if (k) this.y += this.sz(84); this.stat(x, k); });
        if (!(s.stats ?? []).length) this.p.risks.push({ code: 'no-figure', severity: 'warn', message: this.p.id ? `Adegan ${this.p.i + 1} (angka) tidak punya angka; tidak ada yang dikarang.` : `Scene ${this.p.i + 1} (stat) has no figure; nothing was invented.` });
        this.note();
        break;
      }
      case 'bar-chart': this.headline(64, 500, 40); this.bars(); break;
      case 'hbar-compare': this.kicker(); this.headline(80, 500, 56); this.hbars(); this.note(); break;
      case 'question': this.headline(104, 500, 40, 1.3); this.sub(); break;
      case 'quote': {
        if (s.quote ?? s.headline) { const b = this.text((s.quote ?? s.headline)!, { size: this.sz(76), weight: 500, color: st.c.text, variant: 'preset:text.quote', lineHeight: 1.25 }, this.p.X0, this.y, this.p.W, this.p.start, st.editorial ? {} : { presetId: 'preset:motion.blur-in', ms: 800 }, undefined, 'quote'); this.y = b.y1 + this.sz(40); }
        if (s.attribution) { this.shape('preset:shape.line', st.align === 'center' ? this.p.X0 + this.p.W / 2 : this.p.X0 + this.sz(40), this.y + this.sz(4), this.sz(80), this.sz(6), st.c.accent, this.p.start + 500, { presetId: 'preset:motion.wipe-reveal', ms: 500 }); this.y += this.sz(32); const b = this.text(s.attribution, this.muted(this.sz(52)), this.p.X0, this.y, this.p.W, this.p.start + 600, {}, undefined, 'attribution'); this.y = b.y1; }
        break;
      }
      case 'cta': case 'cta-handle': this.cta(); break;
      case 'split': this.split(); break;
      case 'footage': case 'footage-split': case 'footage-pip': this.footageScene(); break;
      case 'image': this.imageScene(); break;
    }
    if (centreVertically) {
      // centre the whole block in the content area: shift every op of this scene by the same dy
      const top = st.safe.top, bottom = f.h - st.safe.bottom, h = this.y - y0;
      const dy = Math.max(top, top + (bottom - top - h) / 2 - this.sz(40)) - y0;
      if (Math.abs(dy) > 1) {
        for (const op of this.p.ops.slice(startOps)) { const a = op.args as Record<string, { x: number; y: number }>; if (a['position']) a['position'] = { x: a['position'].x, y: round1(a['position'].y + dy) }; }
        for (const el of this.p.elements.slice(startEls)) el.box = { ...el.box, y0: el.box.y0 + dy, y1: el.box.y1 + dy };
        this.y += dy;
      }
    }
    if (withSource) this.source();
  }
  finish(): void { this.source(); }
}
const round1 = (v: number) => Math.round(v * 10) / 10;
/** ADR-041: extra width (u) of a pill text over its measured label, so the estimator never wraps / overflows inside its own box. */
const PILL_SLACK = 20;
function ratioOf(f: { w: number; h: number }): Ratio {
  const a = f.w / f.h;
  return Math.abs(a - 9 / 16) < 0.01 ? '9:16' : Math.abs(a - 16 / 9) < 0.01 ? '16:9' : Math.abs(a - 1) < 0.01 ? '1:1' : Math.abs(a - 0.8) < 0.01 ? '4:5' : 'custom';
}
/** "+0,0%" → 0, "1.200" → 1200, "25,96" → 25.96 (Indonesian reading; see engine format-number.ts). */
export function parseLoose(s: string): number | undefined {
  const m = /([+\-−–]?)(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)/.exec(s);
  if (!m) return undefined;
  const sign = m[1] && m[1] !== '+' ? -1 : 1, body = m[2]!;
  const v = /^\d{1,3}(\.\d{3})+/.test(body) ? Number(body.replace(/\./g, '').replace(',', '.')) : Number(body.replace(',', '.'));
  return sign * v;
}
/** 25.96 → "25,96", 1200 → "1.200" (Indonesian, as many decimals as the number has, at most 2). */
export function formatIdNumber(v: number): string {
  const d = Math.min(2, (String(v).split('.')[1] ?? '').length);
  const [i, fr] = Math.abs(v).toFixed(d).split('.');
  return `${v < 0 ? '−' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${fr ? `,${fr}` : ''}`;
}
