// ADR-039 (Reels production pipeline, FR-280 … FR-299): the talking-head composer. A VideoSpec with `talkingHead` (one scene per
// cut of the footage analysis, silent cards, a hold, a poster) becomes ordinary Composition Model operations:
//   talk     — the master clip trimmed to the cut, full screen and MUTED, with a slow punch-in (op:clip.setZoom) and chips that pop on
//              spoken words; explain — a designed navy scene, the speaker in a round bubble (op:overlay.addVideo, muted) under full-page
//              graphics that move on spoken words; card — a silent drawn card; hold — the previous graphics stay; poster — the
//              Creator's image unchanged at 78 % with the handle under it.
// AUDIO APPROACH (one, documented): every clip and bubble is muted; the speech of each talk / explain scene is ONE
// `op:audio.addLayer {role: 'voice'}` of the SAME source (talkingHead.voiceAssetId, else the master whose audio track is the cleaned,
// loudness-normalised voice) trimmed to the cut, with 2-frame fades (2000 / fps ms) at every cut. One source = one loudness for the
// whole Reel, the music ducking (preset:audio.duck-voice) sees every spoken range, captions / SFX anchors derive from the cut's words
// (scene-relative = word time − cut.startMs). The master is a VIDEO asset: `op:audio.addLayer` must accept its audio track.
// Captions: karaoke pages (≤ 3 words, split at pauses) only inside speech scenes — silent scenes have no pages. SFX: every effect of
// a speech scene is tied to a WORD (2 frames before its start): the whoosh before the first word, pops on chips / icons and on the
// words spoken while rows / bars / hour marks appear, ticks on the words while the box types / the progress runs, a ding on the word
// after, a rise on reveals; silent cards / the poster get only their whoosh; all at `sfx.level`. Music: a CC0 bed at 0.3, lifted 1.5× over silent scenes (gain segments), 0.5 s in / 2.5 s out.
// No LLM, no randomness, no invented figures: texts, numbers and sources come from the spec (the approved PRD) only.
import { getPreset, validateParams } from '@expertmotion/catalogue';
import { applyOperations, autoFixOps, createEmptyModel, frameInUnits, framesOf, qualityCheck, qualityChecklist, textGeometry, type AssetFacts, type BoxU, type CaptionPageT, type CompositionModelT, type OperationT, type QualityIssue, type Ratio, type TextLayerT } from '@expertmotion/composition-model';
import type { ComposeContext, ComposeOk, ComposedElement, ComposedScene, ComposeRisk, VoicePlacement } from './auto-motion.js';
import { findSaidIndex } from './auto-motion-footage.js';
import { ANNOTATION_RED, annotationMark, aspectOf, PICTURE_RADIUS_U } from './auto-motion-image.js';
import { CUTAWAY_KINDS, SPEECH_ROLES, type SceneRole, type SfxKind, type SpecAnchorT, type SpecBlockT, type SpecCoverT, type SpecSceneT, type SpecTextT, type VideoSpecT } from './auto-motion-spec.js';
import type { AnalysisCut, FootageAnalysisLike, SfxAssets, TimedWord } from './reels-types.js';

type Safe = { top: number; right: number; bottom: number; left: number };
/** Layout constants of the Reels talking-head mode (u = px at 1080 wide / 1920 high; generic, no production values). */
export const REELS = Object.freeze({
  ratio: '9:16' as Ratio, fps: 30,
  graphicsTopU: 110, graphicsBottomU: 1250, sourceTagYU: 1285, captionYU: 1455, captionFontU: 68, captionMaxWords: 3,
  bubbleSizeU: 260, bubbleTopU: 1640, ringColour: '#FFD43B', ringWidthU: 6,
  /** Where the face is in the SOURCE frame (fractions) and the CSS scale on the cover-fitted picture (1.6 ≈ 62 % of the frame fills the bubble). */
  focus: Object.freeze({ x: 0.5, y: 0.33, zoom: 1.6 }),
  sfxLevel: 0.55, sfxLeadFrames: 2, musicVolume: 0.3, musicLift: 1.5, musicFadeInMs: 500, musicFadeOutMs: 2500, musicRampMs: 300,
  cardMs: 3000, holdMs: 1200, posterMs: 3500, posterScale: 0.78,
  zoomA: Object.freeze([1.12, 1.2] as const), zoomB: Object.freeze([1.28, 1.36] as const), popAmount: 0.1, popMs: 400,
  pauseMs: 350, blockStepMs: 600,
  palette: 'preset:palette.reels-navy', fontPair: 'preset:fontpair.poppins-inter', headingFont: 'Poppins', headingFontPreset: 'preset:font.poppins',
  colours: Object.freeze({ bg: '#0B1526', bg2: '#121F38', text: '#F4F6FB', accent: '#FFD43B', accent2: '#4DD4C4', negative: '#FF5C5C', warning: '#FFA94D', muted: '#8A97B3' }),
});
/** The quality-gate safe area of the mode: graphics live in y 110 … 1250 (captions 1455 … 1640 and the bubble 1640 … 1900 are below it). */
export function reelsSafeArea(f: { w: number; h: number }): Safe { return { top: REELS.graphicsTopU, left: 88, right: 160, bottom: f.h - REELS.graphicsBottomU }; }

export interface SfxPlacement { kind: SfxKind; scene: number; atMs: number; anchorMs: number; what: string }
export interface GainSegment { atMs: number; durationMs: number; mul: number; rampMs: number }
/** What the `music.generate` step needs when the bed is picked at Execute (trackId); with `assetId` the composer adds the bed itself. */
export interface MusicPlan { prompt: string; volume: number; liftOverSilent: number; fadeInMs: number; fadeOutMs: number; gain: GainSegment[]; trackId?: string; assetId?: string }
export interface ReelsSummary {
  mode: 'talking-head'; audioAssetId: string | null; masterAssetId: string | null; cutIds: string[]; speechScenes: number; silentScenes: number;
  sfx: SfxPlacement[]; captionPages: number; music?: MusicPlan; cover?: SpecCoverT & { atMs: number }; credits: string[]; fadeMs: number;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const textOf = (t: SpecTextT | undefined): string | undefined => (t === undefined ? undefined : typeof t === 'string' ? t : t.text);
/** Spec tones → the tone enum of the tag / rows / bars shape presets (info | warn | opinion | illustration | positive | negative | neutral). */
const SHAPE_TONE: Record<string, string> = { info: 'info', warn: 'warn', warning: 'warn', opinion: 'opinion', accent: 'opinion', illustration: 'illustration', muted: 'illustration', positive: 'positive', negative: 'negative', neutral: 'neutral', text: 'neutral' };
const shapeTone = (t: string | undefined, fallback = 'info') => SHAPE_TONE[t ?? ''] ?? fallback;
const TAG_TONE: Record<string, keyof typeof REELS.colours> = { info: 'accent2', warn: 'warning', opinion: 'accent', illustration: 'muted', positive: 'accent2', negative: 'negative', warning: 'warning', neutral: 'muted', accent: 'accent', muted: 'muted', text: 'text' };

/** Karaoke caption pages from timed words (recording time): ≤ `maxWords` per page, a new page at a pause ≥ `pauseMs` or after . ! ? , ; : — tokens shifted by `shiftMs` and kept inside [fromMs, toMs]. */
export function captionPagesFromWords(words: ReadonlyArray<TimedWord>, o: { shiftMs: number; fromMs: number; toMs: number; maxWords?: number; pauseMs?: number }): CaptionPageT[] {
  const maxWords = o.maxWords ?? REELS.captionMaxWords, pause = o.pauseMs ?? REELS.pauseMs;
  const inside = words.map((w) => ({ text: w.text.trim(), fromMs: Math.max(o.fromMs, Math.min(o.toMs, Math.round(w.fromMs + o.shiftMs))), toMs: Math.max(o.fromMs, Math.min(o.toMs, Math.round(w.toMs + o.shiftMs))) }))
    .filter((w) => w.text && w.toMs > w.fromMs);
  const groups: typeof inside[] = [];
  let cur: typeof inside = [];
  inside.forEach((w, k) => {
    const prev = inside[k - 1];
    if (cur.length && (cur.length >= maxWords || (prev && w.fromMs - prev.toMs >= pause) || (prev && /[.!?,;:]$/.test(prev.text)))) { groups.push(cur); cur = []; }
    cur.push(w);
  });
  if (cur.length) groups.push(cur);
  return groups.map((g, gi) => {
    const start = g[0]!.fromMs, next = groups[gi + 1]?.[0]?.fromMs;
    const end = Math.min(g[g.length - 1]!.toMs, next ?? Infinity);
    return { text: g.map((w) => ` ${w.text}`).join(''), startMs: start, durationMs: Math.max(1, end - start), tokens: g.map((w) => ({ text: ` ${w.text}`, fromMs: w.fromMs, toMs: Math.min(w.toMs, end) })) };
  });
}

/** Render profiles of the three Creator actions (Preview = 720p, Final = 1080p), same ratio / fps as the spec. */
export function previewProfile(o: { ratio?: Ratio; fps?: number } = {}) { return { ratio: o.ratio ?? REELS.ratio, resolution: '720p' as const, fps: (o.fps ?? REELS.fps) as 24 | 25 | 30 | 50 | 60, format: 'mp4' as const, codec: 'h264' as const, alpha: false }; }
export function finalProfile(o: { ratio?: Ratio; fps?: number } = {}) { return { ...previewProfile(o), resolution: '1080p' as const }; }

// ───────────── the composer ─────────────
interface SceneBuild { i: number; s: SpecSceneT; role: SceneRole; startMs: number; lenMs: number; endMs: number; cut: AnalysisCut | null; words: TimedWord[]; speech: boolean; silent: boolean; graphics: number[] }
interface TextStyle { size: number; weight: number; colour: string; align?: 'left' | 'center' | 'right'; family?: string; lineHeight?: number; box?: { colour: string; padX: number; padY: number; radius: number }; opacity?: number }

export function composeReels(spec: VideoSpecT, ctx: ComposeContext, fixes: string[]): ComposeOk {
  const base = ctx.model, risks: ComposeRisk[] = [];
  const lang = ctx.language ?? spec.language ?? base.settings.language, id = lang !== 'en';
  const locked = new Set(ctx.lockedKeys ?? []);
  const ratio: Ratio = spec.ratio ?? REELS.ratio;
  const fps = spec.fps ?? base.settings.fps;
  const toMs = (frames: number) => Math.round((frames * 1000) / fps);
  const fadeMs = Math.round(2000 / fps);                                              // 2-frame audio fades at every cut
  const f = frameInUnits(ratio, base.settings.customRatio);
  const th = spec.talkingHead!, analysis: FootageAnalysisLike | undefined = ctx.footageAnalysis;
  const cuts: AnalysisCut[] = th.cuts?.length ? th.cuts.map((c) => ({ id: c.id, startMs: c.startMs, endMs: c.endMs, text: c.text, words: c.words.map((w) => ({ text: w.text, fromMs: w.fromMs, toMs: w.toMs })), ...(c.lineIndex !== undefined ? { lineIndex: c.lineIndex } : {}) })) : analysis?.cuts ?? [];
  const master = th.masterAssetId ?? analysis?.masterAssetId ?? null;
  const audioSrc = th.voiceAssetId ?? master ?? analysis?.voiceAssetId ?? null;
  if (!master) risks.push({ code: 'master-missing', severity: 'warn', message: id ? 'Rekaman master belum ada (jalankan Siapkan rekaman dulu); adegan bicara dibuat tanpa gambar.' : 'There is no master recording yet (run the footage prep first); speech scenes are made without picture.' });
  const masterFacts = master ? ctx.assets.find((a) => a.id === master) : undefined;
  if (master && (!masterFacts || masterFacts.kind !== 'video' || masterFacts.status !== 'ready')) risks.push({ code: 'master-missing', severity: 'warn', message: id ? `Aset master ${master} tidak ada atau belum siap di proyek.` : `The master asset ${master} is missing or not ready in the project.` });
  const sfxAssets: SfxAssets = ctx.sfxAssets ?? {};
  const sfxOn = spec.sfx?.enabled !== false, sfxLevel = spec.sfx?.level ?? REELS.sfxLevel, sfxLead = toMs(REELS.sfxLeadFrames);
  const missingSfx = new Set<string>();
  // colours / fonts: the Reels palette and Poppins when the catalogue has them, else the nearest bundled ones (risk)
  const pd = (getPreset(REELS.palette)?.data ?? {}) as Record<string, string>;
  const c = { ...REELS.colours, ...(pd['bg'] ? { bg: pd['bg'] } : {}), ...(pd['text'] ? { text: pd['text'] } : {}), ...(pd['accent'] ? { accent: pd['accent'] } : {}), ...(pd['accent2'] ? { accent2: pd['accent2'] } : {}), ...(pd['negative'] ? { negative: pd['negative'] } : {}), ...((pd['warn'] ?? pd['warning']) ? { warning: (pd['warn'] ?? pd['warning'])! } : {}), ...(pd['muted'] ? { muted: pd['muted'] } : {}), ...(pd['bg2'] ? { bg2: pd['bg2'] } : {}) };
  const sc = spec.style?.colors ?? {};
  if (sc.accent) c.accent = sc.accent.toUpperCase(); if (sc.text) c.text = sc.text.toUpperCase(); if (sc.muted) c.muted = sc.muted.toUpperCase();
  const bg = spec.style?.background?.toUpperCase() ?? c.bg;
  const themeFont = String(getPreset(String(getPreset(base.theme.fontPairId)?.data?.['heading']))?.data?.['family'] ?? 'Plus Jakarta Sans');
  const headingFont = getPreset(REELS.headingFontPreset) ? REELS.headingFont : themeFont;
  if (headingFont !== REELS.headingFont) risks.push({ code: 'font-fallback', severity: 'info', message: id ? `Font ${REELS.headingFont} belum ada di katalog; memakai ${headingFont}.` : `The ${REELS.headingFont} font is not in the catalogue yet; using ${headingFont}.` });
  const ds = reelsSafeArea(f), ss = spec.style?.safeArea ?? {};
  const safe: Safe = { left: ss.left ?? ds.left, right: ss.right ?? ds.right, top: ss.top ?? ds.top, bottom: ss.bottom ?? ds.bottom };
  const X0 = safe.left, W = f.w - safe.left - safe.right, GB = f.h - safe.bottom;      // graphics area: X0 … X0 + W, safe.top … GB
  const sourceTagY = spec.sourceTagYU ?? REELS.sourceTagYU;
  const ops: OperationT[] = [];
  const add = (op: string, args: Record<string, unknown>, target?: OperationT['target']) => { ops.push({ op, args, ...(target ? { target } : {}) }); return ops.length - 1; };
  const elements: ComposedElement[] = [];
  const sfx: SfxPlacement[] = [];
  const credits = new Set<string>(spec.credits ?? []);
  const missingPresets = new Set<string>();

  // ── project settings, theme, background ──
  if (ratio !== base.settings.ratio && !locked.has('project.ratio')) add('op:output.setRatio', { ratio }, { kind: 'project' });
  if (fps !== base.settings.fps && !locked.has('project.fps')) add('op:project.setFps', { fps }, { kind: 'project' });
  const theme: Record<string, unknown> = {};
  const paletteId = getPreset(REELS.palette) ? REELS.palette : null, fontPairId = getPreset(REELS.fontPair) ? REELS.fontPair : null;
  if (!paletteId || !fontPairId) risks.push({ code: 'preset-missing', severity: 'info', message: id ? `Palet / pasangan font Reels belum ada di katalog (${[!paletteId && REELS.palette, !fontPairId && REELS.fontPair].filter(Boolean).join(', ')}); tema proyek dipakai.` : `The Reels palette / font pair is not in the catalogue yet (${[!paletteId && REELS.palette, !fontPairId && REELS.fontPair].filter(Boolean).join(', ')}); the project theme is kept.` });
  if (paletteId && !locked.has('theme.paletteId') && base.theme.paletteId !== paletteId) theme['paletteId'] = paletteId;
  if (fontPairId && !locked.has('theme.fontPairId') && base.theme.fontPairId !== fontPairId) theme['fontPairId'] = fontPairId;
  if (Object.keys(theme).length) add('op:theme.set', theme, { kind: 'project' });
  if (!locked.has('project.background')) add('op:background.set', { presetId: 'preset:background.solid', params: { colourA: bg } }, { kind: 'project' });

  // ── scene timing: a speech scene is exactly its cut (whole frames, never past the source); silent scenes their durationMs ──
  const cutById = new Map(cuts.map((x) => [x.id, x]));
  let cursorMs = 0;                                                                   // scene starts = the sum of the frame-rounded scene lengths (deriveTiming adds durationMs the same way)
  const builds: SceneBuild[] = [];
  spec.scenes.forEach((s, i) => {
    const speech = SPEECH_ROLES.includes(s.role);
    let cut: AnalysisCut | null = null;
    if (speech) {
      cut = s.cut ? cutById.get(s.cut) ?? null : null;
      if (!cut) { risks.push({ code: 'unknown-cut', severity: 'warn', message: id ? `Adegan ${i + 1}: potongan "${s.cut ?? '(kosong)'}" tidak ada di analisis rekaman; adegan dilewati.` : `Scene ${i + 1}: cut "${s.cut ?? '(none)'}" is not in the footage analysis; the scene is skipped.` }); return; }
    }
    const wantMs = speech ? cut!.endMs - cut!.startMs : s.durationMs ?? (s.role === 'hold' ? REELS.holdMs : s.role === 'poster' ? REELS.posterMs : REELS.cardMs);
    const lenF = Math.max(framesOf(500, fps), speech ? Math.floor((wantMs * fps) / 1000) : framesOf(wantMs, fps));
    const startMs = cursorMs, lenMs = toMs(lenF);
    builds.push({ i, s, role: s.role, startMs, lenMs, endMs: startMs + lenMs, cut, words: cut?.words ?? [], speech, silent: !speech, graphics: [] });
    cursorMs += lenMs;
  });
  const totalMs = cursorMs;
  if (spec.maxDurationMs && totalMs > spec.maxDurationMs) risks.push({ code: 'too-long', severity: 'warn', message: id ? `Video ${(totalMs / 1000).toFixed(1).replace('.', ',')} dtk, lebih dari batas ${spec.maxDurationMs / 1000} dtk; buang satu potongan atau kartu.` : `The video is ${(totalMs / 1000).toFixed(1)} s, over the ${spec.maxDurationMs / 1000} s limit; drop a cut or a card.` });
  const scenes: ComposedScene[] = builds.map((b) => ({ role: b.role, startMs: b.startMs, durationMs: b.lenMs, clipDurationMs: b.lenMs, narrationMs: b.speech ? b.lenMs : 0 }));

  // ── helpers ──
  const tone = (t: string | undefined, fallback: keyof typeof REELS.colours = 'accent2') => c[TAG_TONE[t ?? ''] ?? fallback];
  const say = (b: SceneBuild, phrase: string, edge: 'start' | 'end' = 'start'): number | null => {
    if (!b.cut) return null;
    const hit = findSaidIndex(b.words, phrase, -Infinity, Infinity);
    if (!hit) return null;
    const w = edge === 'end' ? b.words[hit.index + hit.length - 1]!.toMs : b.words[hit.index]!.fromMs;
    return Math.max(0, w - b.cut.startMs);
  };
  /** Scene-relative ms of a block anchor (say → fuzzy inside the cut's words; ms / frames; footageMs = master time). */
  const anchorRel = (b: SceneBuild, a: SpecAnchorT | undefined, fallback: number, what: string): number => {
    const clamp = (v: number) => Math.max(0, Math.min(Math.round(v), Math.max(0, b.lenMs - 100)));
    if (!a) return clamp(fallback);
    if ('ms' in a) return clamp(a.ms);
    if ('frames' in a) return clamp(toMs(a.frames));
    if ('footageMs' in a) return clamp(a.footageMs - (b.cut?.startMs ?? 0) + (a.offsetMs ?? 0));
    if ('say' in a) {
      const t = say(b, a.say, a.edge ?? 'start');
      if (t === null) { risks.push({ code: 'say-not-found', severity: 'info', message: id ? `Adegan ${b.i + 1}: "${a.say}" tidak terdengar di potongan ini; ${what} muncul di ${(clamp(fallback) / 1000).toFixed(1).replace('.', ',')} dtk.` : `Scene ${b.i + 1}: "${a.say}" is not heard in this cut; ${what} appears at ${(clamp(fallback) / 1000).toFixed(1)} s.` }); return clamp(fallback); }
      return clamp(t + (a.offsetMs ?? 0));
    }
    risks.push({ code: 'unknown-anchor', severity: 'info', message: id ? `Adegan ${b.i + 1}: jangkar klip "${a.clip}" tidak dipakai di mode talking-head.` : `Scene ${b.i + 1}: clip anchor "${a.clip}" is not used in talking-head mode.` });
    return clamp(fallback);
  };
  /** Scene-relative starts of the cut's words that fall inside the scene. */
  const wordRels = (b: SceneBuild): number[] => (b.cut ? b.words.map((w) => w.fromMs - b.cut!.startMs).filter((v) => v >= 0 && v < b.lenMs) : []);
  /**
   * One sound effect. In a speech scene every SFX is tied to a WORD: it lands 2 frames before the first word that starts at or after
   * `relMs` (within `windowMs`, else no sound — a block on its own clock never gets a stray effect). Silent scenes (no words) place it
   * at `relMs` (the whoosh at the card / poster start). Returns the scene-relative anchor, or null when nothing was placed.
   */
  const playSfx = (b: SceneBuild, kind: SfxKind, relMs: number, what: string, windowMs = 600): number | null => {
    if (!sfxOn) return null;
    const asset = sfxAssets[kind];
    if (!asset) { missingSfx.add(kind); return null; }
    let rel = Math.max(0, Math.min(relMs, b.lenMs - 1));
    if (b.speech) { const w = wordRels(b).find((v) => v >= rel - 1); if (w === undefined || w - rel > windowMs) return null; rel = w; }
    else if (kind !== 'whoosh') return null;                                             // a silent card / poster has no words: only its whoosh
    const anchorMs = b.startMs + rel, atMs = Math.max(b.startMs, anchorMs - sfxLead);
    add('op:audio.addLayer', { assetId: asset, atMs, volume: sfxLevel, role: 'sfx' });
    sfx.push({ kind, scene: b.i, atMs, anchorMs, what });
    return rel;
  };
  /** The next `count` word starts strictly after `afterRel` (ticks / pops ride the words spoken during a block's animation, never a time grid). */
  const nextWords = (b: SceneBuild, afterRel: number, count: number): number[] => wordRels(b).filter((v) => v > afterRel).slice(0, count);
  const sfxOnNextWords = (b: SceneBuild, kind: SfxKind, afterRel: number, count: number, what: string): number[] => { const ws = nextWords(b, afterRel, count); ws.forEach((v, j) => playSfx(b, kind, v, `${what} ${j + 1}`)); return ws; };
  const shapeFor = (name: string, params: Record<string, unknown>): { presetId: string; params: Record<string, unknown> } => {
    const want = `preset:shape.${name}`;
    if (!getPreset(want)) { missingPresets.add(want); return { presetId: 'preset:shape.rect', params: { cornerRadius: 24 } }; }
    const v = validateParams(want, params);
    if (v.ok) return { presetId: want, params };
    missingPresets.add(`${want} (${v.issues[0]?.message ?? 'params'})`);
    return { presetId: want, params: {} };
  };
  const motion = (presetId: string, durationMs: number, params: Record<string, unknown> = {}) => ({ presetId, durationMs, easingId: 'preset:easing.out-cubic', exit: false, params });
  const rise = (ms = 420, dist = 40) => motion('preset:motion.rise', ms, { distanceU: dist });
  const pop = (ms = 450) => motion('preset:motion.pop', ms, { damping: 12 });
  const defaults = base.theme.textDefaults;
  const measure = (text: string, size: number, weight: number, maxW: number, family = headingFont): { w: number; h: number } => {
    const g = textGeometry({ text, variantId: 'preset:text.subtitle', position: { x: 0, y: 0 }, maxWidth: maxW, valign: 'top', style: { fontSize: size, weight, fontFamily: family } as TextLayerT['style'] }, ratio, defaults, f);
    return { w: g.box.x1 - g.box.x0, h: g.box.y1 - g.box.y0 };
  };
  const text = (b: SceneBuild, t: string, st: TextStyle, x0: number, top: number, w: number, relMs: number, mo: Record<string, unknown> = rise(), key = 'text', effect?: { presetId: string; params: Record<string, unknown> }, graphics = true): BoxU => {
    const style: Record<string, unknown> = { fontSize: Math.round(st.size), weight: st.weight, colour: st.colour, align: st.align ?? 'left', fontFamily: st.family ?? headingFont, ...(st.lineHeight ? { lineHeight: st.lineHeight } : {}), ...(st.box ? { box: st.box } : {}), ...(st.opacity !== undefined ? { opacity: st.opacity } : {}) };
    const geo = (posX: number) => textGeometry({ text: t, variantId: 'preset:text.subtitle', position: { x: posX, y: top - f.h / 2 }, maxWidth: w, valign: 'top', style: style as TextLayerT['style'], effect: effect ?? null }, ratio, defaults, f);
    let g = geo(x0 + w / 2 - f.w / 2);
    if ((st.align ?? 'left') === 'left' && Math.abs(g.box.x0 - x0) > 1) g = geo(x0 + g.boxW / 2 - f.w / 2);
    const atMs = b.startMs + relMs;
    const k = add('op:text.add', { text: t, variant: 'preset:text.subtitle', atMs, durationMs: Math.max(100, b.endMs - atMs), position: { x: round1(g.anchor.x - f.w / 2), y: round1(top - f.h / 2) }, maxWidth: Math.round(w), valign: 'top', styleOverrides: style, motion: mo, ...(effect ? { effect } : {}) });
    if (graphics) b.graphics.push(k);
    elements.push({ key: `${b.i}:${key}:${k}`, scene: b.i, kind: 'text', box: g.box, fromMs: atMs, toMs: b.endMs, hasEntrance: true });
    return g.box;
  };
  const shape = (b: SceneBuild, name: string, cx: number, cy: number, w: number, h: number, fill: string, relMs: number, mo: Record<string, unknown>, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, key = 'shape', holds?: string, graphics = true): BoxU => {
    const sp = shapeFor(name, params);
    const atMs = b.startMs + relMs, box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
    const k = add('op:shape.add', { presetId: sp.presetId, atMs, durationMs: Math.max(100, b.endMs - atMs), position: { x: round1(cx - f.w / 2), y: round1(cy - f.h / 2) }, size: Math.max(10, Math.round(w)), height: Math.max(1, Math.round(h)), fill, motion: mo, params: sp.params, ...extra });
    if (graphics) b.graphics.push(k);
    elements.push({ key: `${b.i}:${key}:${k}`, scene: b.i, kind: 'shape', box, fromMs: atMs, toMs: b.endMs, hasEntrance: true, ...(holds ? { holds } : {}) });
    return box;
  };
  const sourceTag = (b: SceneBuild, src: string) => {
    credits.add(src);
    const m = measure(src, 32, 500, W - 40, 'Inter');
    const w = Math.round(Math.min(W, m.w + 44)), h = Math.round(Math.max(52, m.h + 20));
    shape(b, 'source-tag', X0 + w / 2, sourceTagY + h / 2, w, h, c.bg2, 0, motion('preset:motion.fade-in', 300), { text: src.slice(0, 200) }, { opacity: 0.92 }, 'source');
  };

  /** A talk-scene heading over the bright video: a rounded dark pill (bg2, radius 28, padding 28 / 40 u), the scene's keywords in the accent colour, ≤ 2 lines in the top band. */
  const talkHeading = (b: SceneBuild, t: string, top: number, relMs: number): BoxU => {
    const kw = b.s.keywords?.length ? { presetId: 'preset:texteffect.keyword', params: { words: b.s.keywords, colour: c.accent } } : undefined;
    return text(b, t, { size: 64, weight: 800, colour: c.text, align: 'left', lineHeight: 1.12, box: { colour: c.bg2, padX: 40, padY: 28, radius: 28 } }, X0, top, W, relMs, motion('preset:motion.word-stagger', 500, { staggerFrames: 3 }), 'talk-heading', kw);
  };

  // ── block flow (explain / card / talk graphics) ──
  const blockSfxKind = (bk: SpecBlockT): SfxKind | null => bk.sfx ?? ({ chip: 'pop', icon: 'pop', rows: 'rise', bars: 'rise', 'day-strip': 'rise', 'browser-card': 'rise', 'typing-box': 'tick', tag: 'click', stat: 'rise', heading: null, text: null, note: null, source: null } as Record<string, SfxKind | null>)[bk.kind] ?? null;
  /** Lays the blocks out from `top`; returns the bottom. `k` is the fit factor (< 1 shrinks sizes). */
  const flowBlocks = (b: SceneBuild, blocks: readonly SpecBlockT[], top: number, k: number, maxBottom: number): number => {
    let y = top;
    const gap = 28 * k;
    const sz = (v: number) => Math.round(v * k);
    let idx = 0;
    const rel = (bk: SpecBlockT, what: string) => anchorRel(b, bk.at, bk.fallbackMs ?? idx * REELS.blockStepMs, what);
    for (let n = 0; n < blocks.length; n++) {
      const bk = blocks[n]!;
      if (bk.kind === 'source') { sourceTag(b, bk.text!); idx++; continue; }
      if (bk.kind === 'chip' || bk.kind === 'icon') {
        // a run of chips (wrapping pills) or icons (one row of tiles)
        let m = n; while (m + 1 < blocks.length && blocks[m + 1]!.kind === bk.kind) m++;
        const run = blocks.slice(n, m + 1);
        if (bk.kind === 'chip') {
          // a chip = pill + icon + label as ONE unit (the pill `holds` both for the quality gate); the label gets 12 u of slack so a
          // width measured at full width never wraps inside its own pill. Talk scenes: one chip per row, staggered left / centre /
          // right from the bottom of the graphics area upward (around the lower third, above the captions), never overlapping.
          const slack = 12, pad = sz(36), rowGap = sz(16);
          const stagger = b.role === 'talk';
          // the pill is sized from the label's REAL geometry at the width it will get (the text estimator balances long labels over
          // two lines even when one would fit): a label wider than the pill width shrinks (≥ 34 u) first, then the pill grows in height
          const metrics = run.map((ch) => {
            const iw = ch.icon ? sz(56) + sz(14) : 0, avail = W - iw - pad * 2;
            let size = sz(48), g = measure(ch.text!, size, 700, avail);
            if (g.w + slack > avail) { size = Math.max(34, Math.floor((size * avail) / (g.w + slack))); g = measure(ch.text!, size, 700, avail); }
            let textW = Math.min(avail, Math.ceil(g.w) + slack);
            let g2 = measure(ch.text!, size, 700, textW);
            if (g2.h > g.h + 1) { textW = avail; g2 = g; }                          // a narrower box would add a line: keep the full width
            return { iw, size, textW, pw: Math.min(W, textW + iw + pad * 2), h: Math.max(sz(92), Math.round(g2.h + pad)) };
          });
          let x = X0, rowTop = stagger ? maxBottom - 20 - metrics.reduce((a, m) => a + m.h, 0) - (run.length - 1) * rowGap : y, rowH = metrics[0]!.h;
          run.forEach((ch, j) => {
            const at = rel(ch, `chip "${ch.text}"`); idx++;
            const { iw, size, textW, pw, h } = metrics[j]!;
            if (stagger) { x = j % 3 === 0 ? X0 : j % 3 === 1 ? X0 + (W - pw) / 2 : X0 + W - pw; rowH = h; }
            else if (x + pw > X0 + W + 1) { x = X0; rowTop += rowH + rowGap; rowH = h; } else rowH = Math.max(rowH, h);
            const key = `chip:${ch.text}`;
            shape(b, 'rect', x + pw / 2, rowTop + h / 2, pw, h, c.bg2, at, pop(), { cornerRadius: Math.round(Math.min(h, sz(92)) / 2) }, { opacity: 0.96 }, 'chip', key);
            if (ch.icon) shape(b, 'icon', x + pad + sz(28), rowTop + h / 2, sz(56), sz(56), ch.color ?? c.accent, at, pop(), { icon: ch.icon, accent: ch.accent ?? c.accent2 }, {}, 'chip-icon', key);
            const lb = measure(ch.text!, size, 700, textW).h;
            text(b, ch.text!, { size, weight: 700, colour: ch.color ?? c.text, align: 'left' }, x + pad + iw, rowTop + (h - lb) / 2, textW, at, pop(), 'chip-text');
            playSfx(b, blockSfxKind(ch) ?? 'pop', at, `chip "${ch.text}"`);
            if (stagger) rowTop += h + rowGap; else x += pw + sz(20);
          });
          if (!stagger) y = rowTop + rowH + gap;
        } else {
          const cols = run.length, tile = Math.min(sz(260), W / cols), icon = Math.min(sz(150), tile * 0.6);
          const left = X0 + (W - tile * cols) / 2;
          let rowH = icon;
          run.forEach((ic, j) => {
            const at = rel(ic, `icon ${ic.icon}`); idx++;
            const cx = left + tile * j + tile / 2;
            shape(b, 'icon', cx, y + icon / 2, icon, icon, ic.color ?? c.accent, at, pop(500), { icon: ic.icon, accent: ic.accent ?? c.accent2 }, {}, 'icon');
            if (ic.text) { const bx = text(b, ic.text, { size: sz(44), weight: 600, colour: c.muted, align: 'center' }, cx - tile / 2, y + icon + sz(12), tile, at, rise(400, 24), 'icon-label'); rowH = Math.max(rowH, bx.y1 - y); }
            playSfx(b, blockSfxKind(ic) ?? 'pop', at, `icon ${ic.icon}`);
          });
          y += rowH + gap;
        }
        n = m; continue;
      }
      const at = rel(bk, `${bk.kind} block`); idx++;
      const kind = blockSfxKind(bk);
      switch (bk.kind) {
        case 'heading': {
          const bx = b.role === 'talk' ? talkHeading(b, bk.text!, y, at) : text(b, bk.text!, { size: sz(72), weight: 800, colour: bk.color ?? c.text }, X0, y, W, at, motion('preset:motion.word-stagger', 500, { staggerFrames: 3 }), 'heading');
          y = bx.y1 + gap; break;
        }
        case 'text': { const bx = text(b, bk.text!, { size: sz(56), weight: 500, colour: bk.color ?? c.text, lineHeight: 1.25 }, X0, y, W, at, rise(), 'text'); y = bx.y1 + gap; break; }
        case 'note': { const bx = text(b, bk.text!, { size: sz(50), weight: 500, colour: bk.color ?? tone(bk.tone, 'muted'), lineHeight: 1.25 }, X0 + sz(28), y, W - sz(28), at, rise(), 'note');
          shape(b, 'rect', X0 + sz(5), (bx.y0 + bx.y1) / 2, sz(8), bx.y1 - bx.y0, tone(bk.tone, 'accent'), at, motion('preset:motion.grow', 400, { direction: 'down' }), { cornerRadius: 4 }, {}, 'note-bar', `note:${bk.text}`); y = bx.y1 + gap; break; }
        case 'stat': {
          const value = bk.unit ? `${bk.value} ${bk.unit}` : bk.value!;
          const vb = text(b, value, { size: sz(170), weight: 900, colour: bk.color ?? tone(bk.tone, 'accent') }, X0, y, W, at, pop(600), 'stat');
          y = vb.y1;
          if (bk.label) { const lb = text(b, bk.label, { size: sz(56), weight: 500, colour: c.text }, X0, y + sz(4), W, at + 120, rise(), 'stat-label'); y = lb.y1; }
          y += gap; if (kind) playSfx(b, kind, at, `stat ${bk.value}`); break;
        }
        case 'tag': {
          const m = measure(bk.text!, sz(36), 700, W, 'Inter'), w = Math.min(W, m.w + sz(48)), h = sz(60);
          shape(b, 'tag', X0 + w / 2, y + h / 2, w, h, tone(bk.tone, 'accent'), at, pop(400), { text: bk.text!.slice(0, 120), tone: shapeTone(bk.tone) }, {}, 'tag');
          y += h + gap; if (kind) playSfx(b, kind, at, `tag "${bk.text}"`); break;
        }
        case 'rows': {
          const rows = bk.rows!, h = sz(36) + rows.length * sz(136);
          shape(b, 'rows', X0 + W / 2, y + h / 2, W, h, c.bg2, at, rise(500, 48), { rows: rows.map((r) => ({ ...(r.badge ? { badge: r.badge } : {}), title: r.title, ...(r.sub ? { sub: r.sub } : {}), ...(r.right ? { right: r.right } : {}), ...(r.rightSub ? { rightSub: r.rightSub } : {}), ...(r.tone ? { tone: shapeTone(r.tone) } : {}) })) }, {}, 'rows');
          if (kind) playSfx(b, kind, at, 'rows reveal');
          sfxOnNextWords(b, 'pop', at, rows.length, 'row');
          y += h + gap; break;
        }
        case 'bars': {
          const bars = bk.bars!, h = sz(24) + bars.length * sz(104);
          shape(b, 'bars-h', X0 + W / 2, y + h / 2, W, h, c.accent2, at, rise(500, 48), { bars: bars.map((x) => ({ label: x.label, value: x.value, ...(x.unit ? { unit: x.unit.slice(0, 12) } : {}), ...(x.tone ? { tone: shapeTone(x.tone, 'positive') } : {}) })) }, {}, 'bars');
          if (kind) playSfx(b, kind, at, 'bars reveal');
          sfxOnNextWords(b, 'pop', at, bars.length, 'bar');
          y += h + gap; break;
        }
        case 'day-strip': {
          const h = sz(320);
          shape(b, 'day-strip', X0 + W / 2, y + h / 2, W, h, c.bg2, at, rise(500, 48), { hours: bk.hours ?? [0, 6, 12, 18, 24], bars: bk.strip!.map((x) => ({ label: x.label, fromH: x.fromH, toH: x.toH, colour: x.color ?? c.accent, ...(x.icon ? { icon: x.icon } : {}) })), ...(bk.note ? { note: bk.note } : {}) }, {}, 'day-strip');
          if (kind) playSfx(b, kind, at, 'day strip reveal');
          sfxOnNextWords(b, 'pop', at, Math.min(4, bk.strip!.length), 'hour mark');
          y += h + gap; break;
        }
        case 'browser-card': {
          const h = sz(560);
          shape(b, 'browser-card', X0 + W / 2, y + h / 2, W, h, c.bg2, at, motion('preset:motion.scale-in', 500, { fromScale: 0.9 }), { urlText: (bk.urlText ?? '').slice(0, 80), title: (bk.title ?? bk.text ?? '').slice(0, 120), fromLabel: (bk.fromLabel ?? '').slice(0, 40), toLabel: (bk.toLabel ?? '').slice(0, 40), progress: bk.progress ?? 1, caption: (bk.caption ?? '').slice(0, 120), inner: bk.inner ?? 'none' }, {}, 'browser-card');
          if (kind) playSfx(b, kind, at, 'card reveal');
          // progress ticks on the next words, the completion ding on the word after them (a silent card gets only its whoosh)
          const ws = nextWords(b, at, 6), ticks = ws.slice(0, Math.max(0, Math.min(5, ws.length - 1)));
          ticks.forEach((v, j) => playSfx(b, 'tick', v, `progress tick ${j + 1}`));
          if (ws.length) playSfx(b, 'ding', ws[ticks.length]!, 'card complete');
          y += h + gap; break;
        }
        case 'typing-box': {
          const h = sz(230);
          // key ticks on the words spoken while the box types (≤ 6), the "sent" ding on the word after them; the box sends on that word
          const ws = nextWords(b, at, 7), ticks = ws.slice(0, Math.max(0, Math.min(6, ws.length - 1)));
          const sendAt = bk.sendAt ?? (ws.length ? ws[ticks.length]! : at + 900);
          shape(b, 'typing-box', X0 + W / 2, y + h / 2, W, h, c.bg2, at, rise(450, 40), { text: bk.text!.slice(0, 200), prefixBadge: (bk.prefixBadge ?? 'DM').slice(0, 8), typing: bk.typing ?? true, sendAt: Math.max(0, sendAt - at) }, {}, 'typing-box');
          ticks.forEach((v, j) => playSfx(b, kind ?? 'tick', v, `typing tick ${j + 1}`));
          playSfx(b, 'ding', sendAt, 'message sent');
          y += h + gap; break;
        }
        default: break;
      }
    }
    void maxBottom;
    return y - gap;
  };
  /** Lays a scene's blocks out; when they run past the graphics bottom the scene is laid out again smaller (≥ 55 %). */
  const flowFitted = (b: SceneBuild, blocks: readonly SpecBlockT[], top: number, maxBottom: number, head?: (k: number) => number) => {
    const ops0 = ops.length, els0 = elements.length, risks0 = risks.length, sfx0 = sfx.length, g0 = b.graphics.length;
    for (let k = 1, attempt = 0; ; attempt++) {
      const y0 = head ? head(k) : top;
      const bottom = flowBlocks(b, blocks, y0, k, maxBottom);
      if (bottom <= maxBottom || attempt >= 4) {
        if (bottom > maxBottom) risks.push({ code: 'scene-tight', severity: 'warn', message: id ? `Adegan ${b.i + 1} terlalu padat untuk area grafik (y ${safe.top}–${GB}); kurangi bloknya.` : `Scene ${b.i + 1} is too dense for the graphics area (y ${safe.top}–${GB}); use fewer blocks.` });
        return;
      }
      ops.length = ops0; elements.length = els0; risks.length = risks0; sfx.length = sfx0; b.graphics.length = g0;
      k = Math.max(0.55, Math.round(((maxBottom - top) / (bottom - top)) * k * 0.98 * 100) / 100);
    }
  };

  // ── ADR-041 cutaways: image / video blocks cover the whole frame over the speaker from their anchor until the next block or the cut end ──
  interface Cutaway { bk: SpecBlockT; fromRel: number; toRel: number }
  /** The cutaway windows of a scene's blocks (scene-relative ms, ≥ 300 ms each, in block order; overlapping windows are trimmed). */
  const cutawaysOf = (b: SceneBuild, blocks: readonly SpecBlockT[]): Cutaway[] => {
    const rels = blocks.map((bk, idx) => anchorRel(b, bk.at, bk.fallbackMs ?? idx * REELS.blockStepMs, `${bk.kind} block`));
    const out: Cutaway[] = [];
    blocks.forEach((bk, idx) => {
      if (!CUTAWAY_KINDS.includes(bk.kind)) return;
      const fromRel = rels[idx]!;
      const next = rels.slice(idx + 1).find((r) => r > fromRel + 300);
      let toRel = bk.ms !== undefined ? fromRel + bk.ms : next ?? b.lenMs;
      toRel = Math.min(b.lenMs, toRel);
      const prev = out[out.length - 1];
      if (prev && prev.toRel > fromRel) prev.toRel = fromRel;                          // two cutaways never overlap: the earlier one ends where the next starts
      if (toRel - fromRel >= 300) out.push({ bk, fromRel, toRel });
      else risks.push({ code: 'cutaway-short', severity: 'info', message: id ? `Adegan ${b.i + 1}: sisipan ${bk.kind} terlalu singkat (< 0,3 dtk); dilewati.` : `Scene ${b.i + 1}: the ${bk.kind} cutaway is shorter than 0.3 s; skipped.` });
    });
    return out;
  };
  /** The ops of one scene's cutaways: a full-frame backdrop + the picture (radius 24, shadow, annotations) or the muted clip (cover). */
  const cutawayOps = (b: SceneBuild, list: readonly Cutaway[]) => {
    for (const cw of list) {
      const bk = cw.bk, atMs = b.startMs + cw.fromRel, dur = Math.max(100, cw.toRel - cw.fromRel);
      const asset = ctx.assets.find((a) => a.id === bk.assetId && a.status === 'ready' && a.kind === (bk.kind === 'image' ? 'image' : 'video'));
      if (!asset) { risks.push({ code: 'cutaway-missing', severity: 'warn', message: id ? `Adegan ${b.i + 1}: aset sisipan ${bk.assetId ?? '(kosong)'} tidak ada / bukan ${bk.kind === 'image' ? 'gambar' : 'video'} yang siap; sisipan dilewati.` : `Scene ${b.i + 1}: cutaway asset ${bk.assetId ?? '(none)'} is missing or not a ready ${bk.kind}; the cutaway is skipped.` }); continue; }
      const fade = motion('preset:motion.fade-in', toMs(5));
      if (bk.kind === 'video') {
        const from = bk.fromMs ?? 0, avail = asset.durationMs !== undefined ? asset.durationMs - from : Infinity;
        if (avail < 100) { risks.push({ code: 'cutaway-missing', severity: 'warn', message: id ? `Adegan ${b.i + 1}: video sisipan ${asset.id} lebih pendek dari potongannya; dilewati.` : `Scene ${b.i + 1}: cutaway video ${asset.id} is shorter than its trim; skipped.` }); continue; }
        const d = Math.max(100, Math.min(dur, bk.toMs !== undefined ? bk.toMs - from : Infinity, avail));
        const k = add('op:overlay.addVideo', { assetId: asset.id, atMs, durationMs: Math.round(d), trimBeforeMs: from, muted: true, shape: 'rect', size: f.w, height: f.h, position: { x: 0, y: 0 }, motion: fade });
        elements.push({ key: `${b.i}:cutaway-video:${k}`, scene: b.i, kind: 'image', box: { x0: 0, y0: 0, x1: f.w, y1: f.h }, fromMs: atMs, toMs: atMs + Math.round(d), hasEntrance: true });
        playSfx(b, 'whoosh', cw.fromRel, `cutaway ${asset.id}`);
        continue;
      }
      // picture: a full-frame backdrop (dark / paper; a blurred copy needs the scene background, so `blur` falls back to dark here),
      // the picture as wide as the frame, contained, centred in the graphics area so its labels stay above the captions
      const bgCol = bk.bg === 'paper' ? '#EFE6D6' : bk.bg === 'white' ? '#FFFFFF' : c.bg;
      shape(b, 'rect', f.w / 2, f.h / 2, f.w, f.h, bgCol, cw.fromRel, fade, { cornerRadius: 0 }, { opacity: 1 }, 'cutaway-bg', undefined, false);
      const asp = aspectOf(asset), maxH = GB - safe.top;
      let w = f.w, h = w / asp;
      if (h > maxH) { h = maxH; w = h * asp; }
      const cx = f.w / 2, cy = safe.top + maxH / 2;
      const drift = bk.pan === 'none' ? motion('preset:motion.scale-in', 500, { fromScale: 0.94 }) : { presetId: 'preset:motion.zoom-drift', durationMs: Math.min(10_000, dur), easingId: 'preset:easing.linear', exit: false, params: { toScale: bk.pan === 'zoom-out' ? 1.02 : 1.08 } };
      const k = add('op:overlay.addImage', { assetId: asset.id, atMs, durationMs: dur, position: { x: 0, y: round1(cy - f.h / 2) }, size: Math.round(w), objectFit: 'contain', radius: PICTURE_RADIUS_U, shadow: true, motion: drift });
      const pic: BoxU = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
      elements.push({ key: `${b.i}:cutaway:${k}`, scene: b.i, kind: 'image', box: pic, fromMs: atMs, toMs: atMs + dur, hasEntrance: true });
      playSfx(b, 'whoosh', cw.fromRel, `cutaway ${asset.id}`);
      // annotations inside the picture, staggered after the picture appears (their own `at` wins), gone with the cutaway
      (bk.annotations ?? []).forEach((an, j) => {
        const rel = Math.min(cw.toRel - 100, an.at ? anchorRel(b, an.at, cw.fromRel + 400 + j * 350, 'annotation') : cw.fromRel + 400 + j * 350);
        const lt = an.text ? textOf(an.text)! : null, ls = 34, lm = lt ? measure(lt, ls, 800, pic.x1 - pic.x0 - 40, 'Inter') : null;
        const labelSize = lm ? { w: Math.min(pic.x1 - pic.x0, lm.w + 32 + 20), h: lm.h + 16 } : undefined;   // + 20 u slack so the pill never wraps its own label
        const m = annotationMark(an, pic, ANNOTATION_RED, labelSize);
        const end = atMs + dur, at2 = b.startMs + rel;
        const mo = m.motion === 'draw-on' ? motion('preset:motion.draw-on', 500) : pop(450);
        const pill = (x0: number, y0: number, w2: number, text: string, relMs: number) => {
          const kk = add('op:text.add', { text, variant: 'preset:text.subtitle', atMs: b.startMs + relMs, durationMs: Math.max(100, end - (b.startMs + relMs)), position: { x: round1(x0 + w2 / 2 - f.w / 2), y: round1(y0 - f.h / 2) }, maxWidth: Math.round(w2), valign: 'top',
            styleOverrides: { fontSize: ls, weight: 800, colour: '#FFFFFF', align: 'center', fontFamily: 'Inter', box: { colour: m.colour, padX: 16, padY: 8, radius: 999 } }, motion: pop(400) });
          elements.push({ key: `${b.i}:annotation-label:${kk}`, scene: b.i, kind: 'text', box: { x0, y0, x1: x0 + w2, y1: y0 + (labelSize?.h ?? 50) }, fromMs: b.startMs + relMs, toMs: end, hasEntrance: true });
        };
        if (m.kind === 'label') { pill(m.cx - m.w / 2, m.cy - m.h / 2, m.w, lt ?? '•', rel); }
        else {
          const outline = m.kind === 'box' || m.kind === 'circle';
          const kk = add('op:shape.add', { presetId: m.presetId, atMs: at2, durationMs: Math.max(100, end - at2), position: { x: round1(m.cx - f.w / 2), y: round1(m.cy - f.h / 2) }, size: Math.max(10, Math.round(m.w)), height: Math.max(1, Math.round(m.h)), fill: m.colour, motion: mo, params: m.params,
            ...(m.rotation ? { rotation: m.rotation } : {}), ...(outline ? { stroke: m.colour, strokeWidth: m.kind === 'box' ? 8 : 10 } : {}) });
          elements.push({ key: `${b.i}:annotation:${kk}`, scene: b.i, kind: 'shape', box: { x0: m.cx - m.w / 2, y0: m.cy - m.h / 2, x1: m.cx + m.w / 2, y1: m.cy + m.h / 2 }, fromMs: at2, toMs: end, hasEntrance: true, holds: 'picture' });
          if (lt && labelSize) pill(Math.min(Math.max(m.cx - labelSize.w / 2, pic.x0), pic.x1 - labelSize.w), Math.min(pic.y1 - labelSize.h, m.cy + m.h / 2 + 8), labelSize.w, lt, rel + 150);
        }
        playSfx(b, 'pop', rel, `annotation ${m.kind}`);
      });
    }
  };

  // ── scenes ──
  const voice: VoicePlacement[] = [];
  const footage: ComposeOk['footage'] = [];
  const bubbleOps: number[] = [];
  let talkN = 0, clipIndex = base.tracks.video.length;
  let prevExplain: SceneBuild | null = null;
  for (const b of builds) {
    const s = b.s;
    if (b.speech) {
      const cut = b.cut!;
      // the speech: one voice layer of the common source, trimmed to the cut, 2-frame fades at both ends
      if (audioSrc) { add('op:audio.addLayer', { assetId: audioSrc, atMs: b.startMs, volume: 1, role: 'voice', trimBeforeMs: cut.startMs, durationMs: b.lenMs, fadeInMs: fadeMs, fadeOutMs: fadeMs }); voice.push({ clipId: cut.id, text: cut.text, atMs: b.startMs, durationMs: b.lenMs, assetId: audioSrc, measured: true }); }
      if (s.role === 'talk') {
        if (master) {
          // the punch-in travels with the insert (`zoom` of op:clip.insert = the Clip.zoom op:clip.setZoom writes): the clip has no id yet
          const z = s.zoom ?? (talkN % 2 === 0 ? { from: REELS.zoomA[0], to: REELS.zoomA[1] } : { from: REELS.zoomB[0], to: REELS.zoomB[1] });
          const pops = (s.pops ?? []).map((p) => { const t = say(b, p.say); if (t === null) risks.push({ code: 'say-not-found', severity: 'info', message: id ? `Adegan ${b.i + 1}: "${p.say}" tidak terdengar; tanpa zoom kejut.` : `Scene ${b.i + 1}: "${p.say}" is not heard; no zoom pop.` }); return t === null ? null : { atMs: t, amount: p.amount ?? REELS.popAmount, durationMs: Number(REELS.popMs) }; }).filter((p): p is { atMs: number; amount: number; durationMs: number } => p !== null);
          add('op:clip.insert', { assetId: master, trimBeforeMs: cut.startMs, durationMs: b.lenMs, volume: 0, muted: true, objectFit: 'cover', zoom: { from: z.from, to: z.to, ...(pops.length ? { pops } : {}) } }, { kind: 'sequence' });
          footage.push({ scene: b.i, assetId: master, hasAudio: false, volume: 0 });
        } else add('op:scene.add', { durationMs: b.lenMs, background: 'preset:background.solid', backgroundParams: { colourA: bg } }, { kind: 'sequence' });
        clipIndex++; talkN++;
        playSfx(b, 'whoosh', 0, 'scene start', Infinity);                             // lands 2 frames before the first spoken word
        // chips in the top band (away from the face), a typing box at the bottom of the graphics area
        const blocks = s.blocks ?? [];
        const cutaways = cutawaysOf(b, blocks);                                        // ADR-041: full-frame cutaways over the speaker
        const bottomKinds = blocks.filter((x) => x.kind === 'typing-box'), chips = blocks.filter((x) => x.kind === 'chip'), topKinds = blocks.filter((x) => x.kind !== 'typing-box' && x.kind !== 'chip' && !CUTAWAY_KINDS.includes(x.kind));
        let topY = safe.top + 20;
        if (s.heading ?? s.headline) { const hb = talkHeading(b, textOf(s.heading ?? s.headline)!, topY, 0); topY = hb.y1 + 28; }
        if (topKinds.length) flowFitted(b, topKinds, topY, Math.min(GB, f.h * 0.42));
        if (chips.length) flowFitted(b, chips, topY, bottomKinds.length ? GB - 230 - 40 : GB);
        if (bottomKinds.length) flowFitted(b, bottomKinds, GB - 230 - 20, GB);
        if (cutaways.length) cutawayOps(b, cutaways);                                 // added last: in front of the chips / heading
        prevExplain = null;
      } else {
        // explain: a designed scene, the speaker in a round bubble at the bottom, graphics above
        add('op:scene.add', { durationMs: b.lenMs, background: 'preset:background.solid', backgroundParams: { colourA: bg } }, { kind: 'sequence' });
        clipIndex++;
        playSfx(b, 'whoosh', 0, 'scene start', Infinity);
        const cutaways = cutawaysOf(b, s.blocks ?? []);                                // ADR-041: the bubble is not placed while a cutaway is on
        if (master) {
          const bb = s.bubble ?? {}, size = bb.sizeU ?? REELS.bubbleSizeU, top = bb.topU ?? REELS.bubbleTopU;
          // the bubble scales in once; when explain scenes follow each other it stays put (the same speaker continues)
          let entrance = prevExplain === null;
          // the bubble's segments = the scene minus the cutaway windows (each ≥ 300 ms), every segment trimmed to its own moment of the cut
          const gaps: Array<[number, number]> = [];
          let cursor = 0;
          for (const cw of cutaways) { if (cw.fromRel - cursor >= 300) gaps.push([cursor, cw.fromRel]); cursor = Math.max(cursor, cw.toRel); }
          if (b.lenMs - cursor >= 300) gaps.push([cursor, b.lenMs]);
          for (const [g0, g1] of gaps) {
            bubbleOps.push(add('op:overlay.addVideo', { assetId: master, atMs: b.startMs + g0, durationMs: g1 - g0, trimBeforeMs: cut.startMs + g0, muted: true, shape: 'circle', size, position: { x: 0, y: round1(top + size / 2 - f.h / 2) },
              ring: { colour: (bb.ringColour ?? REELS.ringColour).toUpperCase(), widthU: bb.ringWidthU ?? REELS.ringWidthU }, focus: bb.focus ?? { ...REELS.focus },
              motion: entrance ? motion('preset:motion.scale-in', 450, { fromScale: 0.6 }) : { presetId: 'preset:motion.none' } }));
            entrance = false;
          }
        }
        const heading = textOf(s.heading ?? s.headline);
        flowFitted(b, (s.blocks ?? []).filter((x) => !CUTAWAY_KINDS.includes(x.kind)), safe.top + 20, GB, (k) => {
          if (!heading) return safe.top + 20;
          const bx = text(b, heading, { size: Math.round(84 * k), weight: 800, colour: c.text }, X0, safe.top + 20, W, 0, motion('preset:motion.word-stagger', 500, { staggerFrames: 3 }), 'heading');
          return bx.y1 + Math.round(36 * k);
        });
        if (s.source) sourceTag(b, textOf(s.source)!);
        if (cutaways.length) cutawayOps(b, cutaways);                                 // in front of the graphics
        prevExplain = b;
      }
    } else {
      add('op:scene.add', { durationMs: b.lenMs, background: 'preset:background.solid', backgroundParams: { colourA: bg } }, { kind: 'sequence' });
      clipIndex++;
      if (s.role === 'hold') {
        // the previous explain graphics stay on screen (the bubble ends with its cut: the speaker is silent)
        if (prevExplain) for (const k of prevExplain.graphics) { const a = ops[k]!.args as Record<string, number>; a['durationMs'] = (a['durationMs'] ?? 100) + b.lenMs; for (const e of elements) if (e.key.endsWith(`:${k}`)) e.toMs = b.endMs; }
        else risks.push({ code: 'hold-alone', severity: 'info', message: id ? `Adegan ${b.i + 1} (hold) tidak didahului adegan explain; layar kosong ${(b.lenMs / 1000).toFixed(1).replace('.', ',')} dtk.` : `Scene ${b.i + 1} (hold) does not follow an explain scene; the screen stays empty for ${(b.lenMs / 1000).toFixed(1)} s.` });
        continue;
      }
      prevExplain = null;
      playSfx(b, 'whoosh', 0, 'scene start');
      if (s.role === 'poster') {
        const img = s.imageAssetId ? ctx.assets.find((a) => a.id === s.imageAssetId && a.kind === 'image' && a.status === 'ready') : undefined;
        const scale = s.scale ?? REELS.posterScale, imgW = f.w * scale;
        const imgH = img?.width && img.height ? (imgW * img.height) / img.width : imgW * (f.h / f.w);
        const handle = textOf(s.handle);
        // the handle sits UNDER the poster with a 30 u gap and ends by y 1850; when that does not fit the poster moves up (never shrinks)
        const handleH = handle ? measure(handle, 40, 700, W).h : 0, gapH = handle ? 30 : 0;
        const top = Math.max(60, Math.min((f.h - imgH - handleH - gapH) / 2, 1850 - handleH - gapH - imgH));
        if (img) {
          const k = add('op:overlay.addImage', { assetId: img.id, atMs: b.startMs, durationMs: b.lenMs, position: { x: 0, y: round1(top + imgH / 2 - f.h / 2) }, size: Math.round(imgW), objectFit: 'contain', motion: motion('preset:motion.fade-in', toMs(8)) });   // no scale: the poster (QR) is readable from its first frame
          elements.push({ key: `${b.i}:poster:${k}`, scene: b.i, kind: 'image', box: { x0: (f.w - imgW) / 2, y0: top, x1: (f.w + imgW) / 2, y1: top + imgH }, fromMs: b.startMs, toMs: b.endMs, hasEntrance: true });
        } else risks.push({ code: 'poster-missing', severity: 'warn', message: id ? `Adegan ${b.i + 1} (poster): gambar ${s.imageAssetId ?? '(kosong)'} tidak ada di proyek; hanya pegangan yang tampil.` : `Scene ${b.i + 1} (poster): image ${s.imageAssetId ?? '(none)'} is not in the project; only the handle is shown.` });
        if (handle) text(b, handle, { size: 40, weight: 700, colour: c.text, align: 'center' }, X0, img ? top + imgH + gapH : f.h / 2 - 40, W, 200, rise(450, 30), 'handle', undefined, false);
        continue;
      }
      // card: a silent drawn card (heading, blocks, an honesty tag)
      const heading = textOf(s.heading ?? s.headline), tagText = textOf(s.tag);
      const blocks = s.blocks ?? [];
      flowFitted(b, blocks, safe.top + 120, GB - (tagText ? 100 : 0), (k) => {
        if (!heading) return safe.top + 120;
        const bx = text(b, heading, { size: Math.round(72 * k), weight: 800, colour: c.text }, X0, safe.top + 120, W, 0, motion('preset:motion.word-stagger', 450, { staggerFrames: 3 }), 'heading');
        return bx.y1 + Math.round(32 * k);
      });
      if (tagText) {
        const m = measure(tagText, 34, 700, W, 'Inter'), w = Math.min(W, m.w + 48), h = 60;
        const yTag = Math.min(GB - h, Math.max(...elements.filter((e) => e.scene === b.i).map((e) => e.box.y1), safe.top + 120) + 32);
        shape(b, 'tag', X0 + w / 2, yTag + h / 2, w, h, c.muted, 200, pop(400), { text: tagText.slice(0, 120), tone: 'illustration' }, {}, 'tag');
      }
      if (s.source) sourceTag(b, textOf(s.source)!);
    }
  }

  // ── captions: karaoke pages from the cuts' words, only inside speech scenes ──
  const capCfg = typeof spec.captions === 'object' ? spec.captions : spec.captions === false ? null : {};
  let captionPages = 0;
  if (capCfg && builds.some((b) => b.speech && b.words.length)) {
    const pages: CaptionPageT[] = [];
    for (const b of builds) if (b.speech && b.cut) pages.push(...captionPagesFromWords(b.words, { shiftMs: b.startMs - b.cut.startMs, fromMs: b.startMs, toMs: b.endMs, maxWords: capCfg.maxWords ?? REELS.captionMaxWords }));
    captionPages = pages.length;
    const fontU = capCfg.fontSizeU ?? REELS.captionFontU;
    const wantParams: Record<string, unknown> = { position: 'bottom', fontSize: Math.max(34, Math.min(140, fontU)), keywords: capCfg.keywords ?? [], yU: capCfg.yU ?? REELS.captionYU, fontSizeU: fontU, fontFamily: headingFont, weight: 800, maxWordsPerPage: capCfg.maxWords ?? REELS.captionMaxWords };
    const styleId = spec.captionStyle ?? 'preset:caption.karaoke';
    const v = validateParams(styleId, wantParams);
    const params = v.ok ? wantParams : (() => { missingPresets.add(`${styleId} params (${v.issues[0]?.message ?? 'params'})`); return { position: 'bottom', fontSize: Math.max(34, Math.min(140, fontU)) }; })();
    if (!locked.has('project.captionStyle')) add('op:caption.setStyle', { presetId: styleId, params }, { kind: 'project' });
    if (!locked.has('project.captionPages')) add('op:caption.setPages', { pages }, { kind: 'project' });
  } else if (capCfg && builds.some((b) => b.speech)) risks.push({ code: 'captions-nothing', severity: 'info', message: id ? 'Caption dilewati: analisis rekaman belum punya kata berwaktu.' : 'Captions skipped: the footage analysis has no timed words.' });

  // ── music: a ducked CC0 bed, lifted over the silent scenes (merged gain segments), 0.5 s in / 2.5 s out ──
  let music: MusicPlan | undefined;
  if (spec.music) {
    const m = spec.music, volume = m.volume ?? REELS.musicVolume, lift = m.liftOverSilent ?? REELS.musicLift;
    const gain: GainSegment[] = [];
    for (const b of builds) {
      if (!b.silent) continue;
      const mul = b.s.musicLift ?? lift, last = gain[gain.length - 1];
      if (last && last.atMs + last.durationMs === b.startMs && last.mul === mul) last.durationMs += b.lenMs;
      else gain.push({ atMs: b.startMs, durationMs: b.lenMs, mul, rampMs: REELS.musicRampMs });
    }
    // the bed is a `music.generate` step (auto-motion-plan.ts): the Service adds it at Execute as op:audio.addBed {volume, fades,
    // duck-voice} + op:audio.setGain {segments} on the new layer's id (an id this composer cannot know; `assetId` = a music asset
    // already in the project, `trackId` = a CC0 library track, neither = best fit for the prompt).
    music = { prompt: [m.mood, m.prompt].filter(Boolean).join(', ') || spec.mood || 'calm', volume, liftOverSilent: lift, fadeInMs: m.fadeInMs ?? REELS.musicFadeInMs, fadeOutMs: m.fadeOutMs ?? REELS.musicFadeOutMs, gain, ...(m.trackId ? { trackId: m.trackId } : {}), ...(m.assetId ? { assetId: m.assetId } : {}) };
  }
  if (missingSfx.size) risks.push({ code: 'sfx-unavailable', severity: 'warn', message: id ? `Efek suara ${[...missingSfx].join(', ')} belum tersedia di proyek (aset SFX belum dibuat); video dibuat tanpanya.` : `Sound effects ${[...missingSfx].join(', ')} are not available in the project (SFX assets not made yet); the video is made without them.` });
  if (missingPresets.size) risks.push({ code: 'preset-missing', severity: 'warn', message: id ? `Preset belum ada di katalog, diganti bentuk polos: ${[...missingPresets].join(', ')}.` : `Presets not in the catalogue yet, plain shapes used instead: ${[...missingPresets].join(', ')}.` });
  const cover = spec.cover ? { ...spec.cover, atMs: coverAtMs(spec.cover, cuts) } : undefined;
  if (spec.cover && cover!.atMs === null) risks.push({ code: 'cover-cut', severity: 'warn', message: id ? `Cover: potongan "${spec.cover.cutId ?? '(kosong)'}" tidak ada; cover diambil dari awal rekaman.` : `Cover: cut "${spec.cover.cutId ?? '(none)'}" is unknown; the cover frame is taken from the start of the recording.` });

  // ── quality gate: dry run, check against the graphics safe area, auto-fix texts, check again ──
  let n = 0;
  const createdBy = new Map<string, number>();
  const dry = (list: OperationT[], track: boolean) => { n = 0; return applyOperations(base, list, { assets: ctx.assets, tier: ctx.tier ?? 'T1', newId: () => `qr${++n}`, ...(track ? { onNewId: (eid: string, i: number) => { createdBy.set(eid, i); } } : {}) }); };
  let fixed = 0, remaining: QualityIssue[] = [];
  const bandTexts = new Set(elements.filter((e) => e.key.includes(':handle:')).map((e) => e.key));
  const r1 = dry(ops, true);
  if (r1.ok) {
    const bandIds = new Set([...createdBy.entries()].filter(([, at]) => elements.some((e) => bandTexts.has(e.key) && e.key.endsWith(`:${at}`))).map(([eid]) => eid));
    const filter = (list: QualityIssue[]) => list.filter((q) => !(q.code === 'outside-safe-area' && q.ids.every((x) => bandIds.has(x))));
    const before = filter(qualityCheck(r1.value.model, { safeArea: safe }));
    const fixOps = autoFixOps(r1.value.model, before, { safeArea: safe });
    if (fixOps.length) {
      fixed = applyFixesByOrigin(ops, fixOps, createdBy, r1.value.model, f);
      const r2 = dry(ops, false);
      remaining = r2.ok ? filter(qualityCheck(r2.value.model, { safeArea: safe })) : before;
    } else remaining = before;
  } else risks.push({ code: 'compose-invalid', severity: 'warn', message: r1.issues.map((x) => x.message).join('; ').slice(0, 400) });
  for (const line of qualityChecklist(remaining.filter((q) => q.severity === 'warn'), id ? 'id' : 'en')) risks.push({ code: 'quality', severity: 'warn', message: line });
  for (const b of builds) if (b.s.blocks?.some((x) => x.kind === 'stat' || x.kind === 'bars' || x.kind === 'rows') && !b.s.source && !b.s.blocks.some((x) => x.kind === 'source')) { risks.push({ code: 'no-source', severity: 'warn', message: id ? `Adegan ${b.i + 1} menampilkan angka tanpa sumber.` : `Scene ${b.i + 1} shows figures without a source.` }); break; }

  const summary: ReelsSummary = { mode: 'talking-head', audioAssetId: audioSrc, masterAssetId: master, cutIds: builds.filter((b) => b.cut).map((b) => b.cut!.id), speechScenes: builds.filter((b) => b.speech).length, silentScenes: builds.filter((b) => b.silent).length,
    sfx, captionPages, ...(music ? { music } : {}), ...(cover ? { cover: { ...cover, atMs: cover.atMs ?? 0 } } : {}), credits: [...credits], fadeMs };
  void bubbleOps;
  return { ok: true, spec, ops, scenes, elements, voice, totalMs, narrationEstimateMs: builds.reduce((a, b) => a + (b.speech ? b.lenMs : 0), 0), frame: f, safeArea: safe, risks, quality: { fixed, remaining }, fixes, footage, reels: summary };
}

/**
 * Source (master) time of the cover frame: `atMs` / a numeric `frame` win; `frame: 'start'` = 600 ms into the cut (past its leading
 * pad); the default 'end-of-line' = 150 ms after the cut's last word (the speaker has closed the mouth and looks at the camera at the
 * end of a line — a frame mid-word caught half-closed eyes, QA A22), clamped inside the cut; without words the cut end − 100 ms. null
 * when the cut is unknown.
 */
export function coverAtMs(cover: Pick<SpecCoverT, 'cutId' | 'atMs' | 'frame'>, cuts: ReadonlyArray<AnalysisCut>): number | null {
  if (cover.atMs !== undefined) return cover.atMs;
  if (typeof cover.frame === 'number') return cover.frame;
  const cut = cover.cutId ? cuts.find((x) => x.id === cover.cutId) : cuts[0];
  if (!cut) return null;
  if (cover.frame === 'start') return Math.min(cut.endMs, cut.startMs + 600);
  // 'end-of-line': the MIDDLE of the line's last word — the speaker still faces the camera while finishing the sentence and
  // drops the gaze right after it (the kit's chosen cover frame sits inside the hook's last word, not after it)
  const last = cut.words[cut.words.length - 1];
  return Math.max(cut.startMs, Math.min(cut.endMs, last ? Math.round((last.fromMs + last.toMs) / 2) : cut.endMs - 100));
}

/** Quality-gate fixes applied to the composed ops: `createdBy` (element id → op index, from the dry run) names the add op to rewrite. */
function applyFixesByOrigin(ops: OperationT[], fixOps: readonly OperationT[], createdBy: ReadonlyMap<string, number>, dryModel: CompositionModelT, f: { w: number; h: number }): number {
  let changed = 0;
  for (const fx of fixOps) {
    const tid = fx.target?.id ?? '', at = createdBy.get(tid);
    const op = at === undefined ? undefined : ops[at];
    if (!op || !(op.op === 'op:text.add' || op.op === 'op:shape.add' || op.op === 'op:overlay.addImage')) continue;
    const a = op.args as Record<string, unknown>, x = fx.args as Record<string, unknown>;
    if (fx.op === 'op:element.setTransform') {
      const el = dryModel.tracks.text.find((t) => t.id === tid) ?? dryModel.tracks.overlay.find((o) => o.id === tid);
      const pos = (typeof a['position'] === 'object' && a['position'] ? a['position'] : el?.position ?? { x: 0, y: 0 }) as { x: number; y: number };
      a['position'] = { x: x['x'] === undefined ? pos.x : Math.round(Number(x['x']) * f.w * 10) / 10, y: x['y'] === undefined ? pos.y : Math.round(Number(x['y']) * f.h * 10) / 10 };
      changed++;
    } else if (fx.op === 'op:text.setStyle' && op.op === 'op:text.add') { a['styleOverrides'] = { ...((a['styleOverrides'] as object | undefined) ?? {}), ...x }; changed++; }
  }
  return changed;
}

// ───────────── the cover still ─────────────
export interface CoverBuild { ops: OperationT[]; atMs: number; texts: Array<{ key: string; text: string; box: BoxU }>; frame: { w: number; h: number } }
/** Key content of the cover stays inside this band (u): under the status bar / title, above the caption / buttons. */
export const COVER_BAND = Object.freeze({ top: 285, bottom: 1635 });
/** The face band of the cover (u): the speaker's head centred and large between the text above and the pills / handle below. */
export const COVER_FACE = Object.freeze({ bandTop: 700, bandBottom: 1300, bandCentre: 1000, scale: 1.8, y: 0.33 });
/** Opacity of the two navy (bg2) text bands of the cover. */
export const COVER_BAND_OPACITY = 0.82;
/**
 * Operations of the cover still on an empty 9:16 project: the master's face frame full bleed (a muted clip at `atMs`) under a dark
 * gradient, kicker pill, line, the hook word (240 u, accent), subline, pills, icons, source tag and handle — all inside COVER_BAND.
 */
export function coverOps(cover: SpecCoverT, o: { cuts: ReadonlyArray<AnalysisCut>; masterAssetId: string; ratio?: Ratio; fps?: number; model?: CompositionModelT }): CoverBuild {
  const ratio = o.ratio ?? REELS.ratio, base = o.model ?? createEmptyModel('cover', { ratio, autoRatio: false, fps: (o.fps ?? REELS.fps) as 30, resolution: '1080p' });
  const f = frameInUnits(ratio, base.settings.customRatio);
  const pd = (getPreset(REELS.palette)?.data ?? {}) as Record<string, string>;
  const c = { ...REELS.colours, ...(pd['bg'] ? { bg: pd['bg'] } : {}), ...(pd['bg2'] ? { bg2: pd['bg2'] } : {}), ...(pd['accent'] ? { accent: pd['accent'] } : {}), ...(pd['accent2'] ? { accent2: pd['accent2'] } : {}), ...(pd['text'] ? { text: pd['text'] } : {}), ...(pd['muted'] ? { muted: pd['muted'] } : {}) };
  const font = getPreset(REELS.headingFontPreset) ? REELS.headingFont : String(getPreset(String(getPreset(base.theme.fontPairId)?.data?.['heading']))?.data?.['family'] ?? 'Plus Jakarta Sans');
  const atMs = coverAtMs(cover, o.cuts) ?? 0;
  const ops: OperationT[] = [], texts: CoverBuild['texts'] = [];
  const DUR = 1000;
  const add = (op: string, args: Record<string, unknown>, target?: OperationT['target']) => { ops.push({ op, args, ...(target ? { target } : {}) }); };
  if (base.settings.ratio !== ratio) add('op:output.setRatio', { ratio }, { kind: 'project' });
  const theme: Record<string, unknown> = {};
  if (getPreset(REELS.palette)) theme['paletteId'] = REELS.palette;
  if (getPreset(REELS.fontPair)) theme['fontPairId'] = REELS.fontPair;
  if (Object.keys(theme).length) add('op:theme.set', theme, { kind: 'project' });
  add('op:background.set', { presetId: 'preset:background.solid', params: { colourA: c.bg } }, { kind: 'project' });
  // the face centred and large: the cover-fitted master scaled by COVER_FACE.scale, shifted so the face (COVER_FACE.y of the source
  // frame) sits at the centre of the face band (y 700 … 1300); the head then fills roughly 45 % of the width
  const faceShiftU = (COVER_FACE.bandCentre - f.h / 2) - (COVER_FACE.y - 0.5) * f.h * COVER_FACE.scale;
  add('op:clip.insert', { assetId: o.masterAssetId, trimBeforeMs: atMs, durationMs: DUR, volume: 0, muted: true, objectFit: 'cover', transform: { x: 0, y: Math.round((faceShiftU / f.h) * 10_000) / 10_000, scale: COVER_FACE.scale } }, { kind: 'sequence' });
  // dark bands only behind the text (above and below the face band), never over the face
  const rectId = 'preset:shape.rect';
  // bg2 at 0.82: over a bright wall a lighter band rendered grey and cost the white / yellow text its contrast
  add('op:shape.add', { presetId: rectId, atMs: 0, durationMs: DUR, position: { x: 0, y: round1(COVER_FACE.bandTop / 2 - f.h / 2) }, size: f.w, height: COVER_FACE.bandTop, fill: c.bg2, opacity: COVER_BAND_OPACITY, motion: { presetId: 'preset:motion.none' }, params: { cornerRadius: 0 } });
  add('op:shape.add', { presetId: rectId, atMs: 0, durationMs: DUR, position: { x: 0, y: round1((COVER_FACE.bandBottom + f.h) / 2 - f.h / 2) }, size: f.w, height: f.h - COVER_FACE.bandBottom, fill: c.bg2, opacity: COVER_BAND_OPACITY, motion: { presetId: 'preset:motion.none' }, params: { cornerRadius: 0 } });
  const X0 = 88, W = f.w - 88 - 160;
  const defaults = base.theme.textDefaults;
  const text = (key: string, t: string, st: TextStyle, x0: number, top: number, w: number): BoxU => {
    const style: Record<string, unknown> = { fontSize: Math.round(st.size), weight: st.weight, colour: st.colour, align: st.align ?? 'left', fontFamily: st.family ?? font, ...(st.lineHeight ? { lineHeight: st.lineHeight } : {}), ...(st.box ? { box: st.box } : {}) };
    const geo = (posX: number) => textGeometry({ text: t, variantId: 'preset:text.subtitle', position: { x: posX, y: top - f.h / 2 }, maxWidth: w, valign: 'top', style: style as TextLayerT['style'] }, ratio, defaults, f);
    let g = geo(x0 + w / 2 - f.w / 2);
    if ((st.align ?? 'left') === 'left' && Math.abs(g.box.x0 - x0) > 1) g = geo(x0 + g.boxW / 2 - f.w / 2);
    add('op:text.add', { text: t, variant: 'preset:text.subtitle', atMs: 0, durationMs: DUR, position: { x: round1(g.anchor.x - f.w / 2), y: round1(top - f.h / 2) }, maxWidth: Math.round(w), valign: 'top', styleOverrides: style, motion: { presetId: 'preset:motion.none' } });
    texts.push({ key, text: t, box: g.box });
    return g.box;
  };
  const measure = (t: string, size: number, weight: number, maxW: number, family = font) => { const g = textGeometry({ text: t, variantId: 'preset:text.subtitle', position: { x: 0, y: 0 }, maxWidth: maxW, valign: 'top', style: { fontSize: size, weight, fontFamily: family } as TextLayerT['style'] }, ratio, defaults, f); return { w: g.box.x1 - g.box.x0, h: g.box.y1 - g.box.y0 }; };
  // above the face: kicker pill, line, hook word (the hook shrinks until the block ends above the face band)
  let y = COVER_BAND.top + 16;
  if (cover.kicker) { const b = text('kicker', cover.kicker, { size: 36, weight: 700, colour: c.bg, box: { colour: c.accent2, padX: 24, padY: 12, radius: 999 } }, X0, y, W); y = b.y1 + 20; }
  { const b = text('line', cover.line, { size: 64, weight: 700, colour: c.text, lineHeight: 1.1 }, X0, y, W); y = b.y1 + 16; }
  {
    let size = 170;
    let m = measure(cover.hookWord, size, 900, W);
    while (y + m.h > COVER_FACE.bandTop && size > 96) { size -= 10; m = measure(cover.hookWord, size, 900, W); }
    text('hook', cover.hookWord, { size, weight: 900, colour: c.accent, lineHeight: 1.0 }, X0, y, W);
  }
  // below the face: subline, pills, icons, source tag, handle — compact, inside the band
  y = COVER_FACE.bandBottom + 24;
  if (cover.subline) { const b = text('subline', cover.subline, { size: 40, weight: 500, colour: c.muted, lineHeight: 1.15 }, X0, y, W); y = b.y1 + 12; }
  if (cover.pills?.length) {
    let x = X0; const h = 56;
    for (const p of cover.pills) {
      const w = Math.min(W, Math.ceil(measure(p.text, 32, 700, W, 'Inter').w) + 12 + 44);
      if (x + w > X0 + W) break;
      text(`pill:${p.text}`, p.text, { size: 32, weight: 700, colour: c.bg, family: 'Inter', box: { colour: c[TAG_TONE[p.tone ?? ''] ?? 'accent'], padX: 22, padY: 9, radius: 999 } }, x, y, w);
      x += w + 14;
    }
    y += h + 12;
  }
  if (cover.icons?.length) {
    const sp = getPreset('preset:shape.icon') ? 'preset:shape.icon' : 'preset:shape.rect';
    const size = 64; let x = X0;
    for (const ic of cover.icons.slice(0, 5)) { add('op:shape.add', { presetId: sp, atMs: 0, durationMs: DUR, position: { x: round1(x + size / 2 - f.w / 2), y: round1(y + size / 2 - f.h / 2) }, size, height: size, fill: c.accent, motion: { presetId: 'preset:motion.none' }, params: sp === 'preset:shape.icon' ? { icon: ic, accent: c.accent2 } : { cornerRadius: 20 } }); x += size + 18; }
    y += size + 12;
  }
  if (cover.source) {
    const sp = getPreset('preset:shape.source-tag') ? 'preset:shape.source-tag' : 'preset:shape.rect';
    const m = measure(cover.source, 28, 500, W - 40, 'Inter'), w = Math.min(W, m.w + 40), h = Math.max(44, m.h + 16);
    add('op:shape.add', { presetId: sp, atMs: 0, durationMs: DUR, position: { x: round1(X0 + w / 2 - f.w / 2), y: round1(y + h / 2 - f.h / 2) }, size: Math.round(w), height: Math.round(h), fill: c.bg, opacity: 0.9, motion: { presetId: 'preset:motion.none' }, params: sp === 'preset:shape.source-tag' ? { text: cover.source.slice(0, 200) } : { cornerRadius: 24 } });
    y += h + 10;
  }
  { const b = text('handle', cover.handle, { size: 40, weight: 600, colour: c.text, family: 'Inter' }, X0, y, W); y = b.y1; }
  // the lower block must end inside the band: shift it up (never into the face band) when it overflows
  const lowerTop = COVER_FACE.bandBottom + 24, over = y - COVER_BAND.bottom;
  const dy = Math.min(Math.max(0, over), Math.max(0, lowerTop - (COVER_FACE.bandBottom + 8)));
  if (dy > 0) {
    const lowerTexts = texts.findIndex((t) => t.box.y0 >= lowerTop - 1), lowerOps = ops.findIndex((op) => { const a = op.args as Record<string, { y?: number }>; return (op.op === 'op:text.add' || op.op === 'op:shape.add') && (a['position']?.y ?? -1e9) + f.h / 2 >= lowerTop - 1; });
    for (const op of ops.slice(Math.max(0, lowerOps))) { const a = op.args as Record<string, { x: number; y: number }>; if (a['position'] && a['position'].y + f.h / 2 >= lowerTop - 1) a['position'] = { x: a['position'].x, y: round1(a['position'].y - dy) }; }
    for (const t of texts.slice(Math.max(0, lowerTexts))) t.box = { ...t.box, y0: t.box.y0 - dy, y1: t.box.y1 - dy };
  }
  return { ops, atMs, texts, frame: f };
}
/** The cover as a one-second Composition Model (the Service renders a 1080x1920 JPG still of its first frame). Throws when the ops do not apply. */
export function composeCover(cover: SpecCoverT, analysis: Pick<FootageAnalysisLike, 'cuts' | 'durationMs' | 'masterAssetId'>, masterAssetId: string, assets?: readonly AssetFacts[]): CompositionModelT {
  const model = createEmptyModel('cover', { ratio: REELS.ratio, autoRatio: false, fps: 30, resolution: '1080p' });
  const b = coverOps(cover, { cuts: analysis.cuts, masterAssetId, model });
  const facts: AssetFacts[] = assets ? [...assets] : [];
  if (!facts.some((a) => a.id === masterAssetId)) facts.push({ id: masterAssetId, kind: 'video', status: 'ready', hasAudio: true, ...(analysis.durationMs !== undefined ? { durationMs: analysis.durationMs } : {}) });
  let n = 0;
  const r = applyOperations(model, b.ops, { assets: facts, tier: 'T1', newId: () => `cv${++n}` });
  if (!r.ok) throw new Error(`cover: ${r.issues.map((i) => `${i.code} ${i.message}`).join('; ')}`);
  return r.value.model;
}
