// validate(model): invariants CM-001 … CM-011 (DATABASE_SCHEMA.md §4.4). Pure; never mutates.
import { getPreset, validateParams, type Category } from '@expertmotion/catalogue';
import { fitText, issue, type Issue } from '@expertmotion/shared';
import type { AssetFacts, CompositionModelT, Tier } from './schema.js';
import { contentEndWithoutClips, deriveTiming, MAX_DURATION_MS, MIN_DURATION_MS } from './timing.js';
import { frameInUnits, SAFE_MARGIN_U } from './units.js';
import { laneConflicts } from './layers.js';

export interface ValidateContext { assets: readonly AssetFacts[]; tier: Tier }
const MIN_TEXT_U = 34;                                              // book §4.5 "small ≥ 34"

export function validate(model: CompositionModelT, ctx: ValidateContext): Issue[] {
  const out: Issue[] = [];
  const assets = new Map(ctx.assets.map((a) => [a.id, a]));
  const v = model.tracks.video;
  const presetCheck = (id: string | null | undefined, category: Category, params: unknown, path: string) => {
    if (!id) return;
    const p = getPreset(id);
    if (!p || p.category !== category) { out.push(issue('CM-007', `${id} is not a ${category} preset.`, 'block', path)); return; }
    if (p.flags.includes('webgpu') && ctx.tier !== 'T2') out.push(issue('CM-007', `${id} needs WebGPU (Hardware Tier T2).`, 'block', path));
    else if (p.flags.includes('gpu') && ctx.tier === 'T0') out.push(issue('CM-007', `${id} renders slowly without a GPU.`, 'warn', path));
    if (params !== undefined) { const r = validateParams(id, params); if (!r.ok) out.push(issue('CM-007', `${id}: ${r.issues[0]!.message}`, 'block', `${path}.params`)); }
  };

  // CM-001 / CM-002 assets present, ready, long enough
  const assetRef = (id: string, path: string) => {
    const a = assets.get(id);
    if (!a || a.status !== 'ready') { out.push(issue('CM-001', `Asset ${id} is missing or not ready.`, 'block', path)); return undefined; }
    return a;
  };
  v.forEach((c, i) => {
    // ADR-030: a clip shows media (assetId) or is a scene clip (scene background), never both or neither.
    if ((c.assetId === undefined) === (c.scene === undefined)) { out.push(issue('CM-001', `Clip ${c.id} needs exactly one of a media asset or a scene background.`, 'block', `tracks.video[${i}]`)); return; }
    if (c.scene) { presetCheck(c.scene.presetId, 'background', c.scene.params, `tracks.video[${i}].scene`); return; }
    const a = assetRef(c.assetId!, `tracks.video[${i}].assetId`);
    if (a?.kind === 'video' && a.durationMs !== undefined && c.trimBeforeMs + c.durationMs * c.playbackRate > a.durationMs + 1)
      out.push(issue('CM-002', `Clip ${c.id} needs more source media than ${a.durationMs} ms.`, 'block', `tracks.video[${i}]`));
  });
  model.tracks.audio.forEach((l, i) => {
    const a = assetRef(l.assetId, `tracks.audio[${i}].assetId`);
    if (a?.durationMs !== undefined && !l.loop && l.durationMs !== undefined && l.trimBeforeMs + l.durationMs > a.durationMs + 1)
      out.push(issue('CM-002', `Audio ${l.id} needs more source media than ${a.durationMs} ms.`, 'block', `tracks.audio[${i}]`));
  });
  model.tracks.overlay.forEach((o, i) => { if (o.kind === 'image') assetRef(o.assetId, `tracks.overlay[${i}].assetId`); });

  // CM-003 / CM-004 transitions
  const seen = new Set<number>();
  model.transitions.forEach((t, i) => {
    const path = `transitions[${i}]`;
    if (t.cutIndex >= v.length - 1) out.push(issue('CM-003', `Transition on cut ${t.cutIndex + 1} has no cut (only ${Math.max(0, v.length - 1)}).`, 'block', path));
    if (seen.has(t.cutIndex)) out.push(issue('CM-003', `Two transitions on cut ${t.cutIndex + 1}.`, 'block', path));
    seen.add(t.cutIndex);
    const a = v[t.cutIndex], b = v[t.cutIndex + 1];
    if (a && b) {
      const half = 0.5 * Math.min(a.durationMs, b.durationMs);
      if (half < 100) out.push(issue('CM-004', `Clips around cut ${t.cutIndex + 1} are too short for a transition.`, 'block', path));
      else if (t.durationMs > half) out.push(issue('CM-004', `Transition on cut ${t.cutIndex + 1} is longer than half the shorter clip; it will be shortened to ${Math.floor(half)} ms.`, 'warn', path));
    }
    presetCheck(t.presetId, 'transition', { ...t.params, durationMs: t.durationMs, timing: t.timing }, path);
  });

  // CM-005 duration
  const timing = deriveTiming(model);
  const content = v.length ? timing.clipStartMs[v.length - 1]! + v[v.length - 1]!.durationMs : contentEndWithoutClips(model);
  const total = model.durationPolicy === 'fixed' && model.fixedDurationMs ? model.fixedDurationMs : content;
  if (total < MIN_DURATION_MS || total > MAX_DURATION_MS) out.push(issue('CM-005', `Total duration ${total} ms is outside 1 s … 30 min.`, 'block', 'durationMs'));
  out.push(...timing.warnings);

  // CM-006 effect count, CM-007 presets everywhere
  const maxFx = ctx.tier === 'T0' ? 2 : 3;
  v.forEach((c, i) => {
    if (c.effects.length > maxFx) out.push(issue('CM-006', `Clip ${c.id} has ${c.effects.length} effects; at most ${maxFx} on this computer.`, 'block', `tracks.video[${i}].effects`));
    c.effects.forEach((e, j) => presetCheck(e.presetId, 'effect', { ...e.params, motion: e.motion }, `tracks.video[${i}].effects[${j}]`));
    if (c.motion) presetCheck(c.motion.presetId, 'motion', undefined, `tracks.video[${i}].motion`);
  });
  model.tracks.text.forEach((t, i) => {
    presetCheck(t.variantId, 'text', undefined, `tracks.text[${i}].variantId`);
    if (t.effect) presetCheck(t.effect.presetId, 'texteffect', t.effect.params, `tracks.text[${i}].effect`);
    if (t.motion) presetCheck(t.motion.presetId, 'motion', undefined, `tracks.text[${i}].motion`);
  });
  model.tracks.overlay.forEach((o, i) => {
    if (o.kind === 'shape') presetCheck(o.presetId, 'shape', undefined, `tracks.overlay[${i}].presetId`);
    else { if (o.effects.length > maxFx) out.push(issue('CM-006', `Image ${o.id} has too many effects.`, 'block', `tracks.overlay[${i}].effects`)); o.effects.forEach((e, j) => presetCheck(e.presetId, 'effect', { ...e.params, motion: e.motion }, `tracks.overlay[${i}].effects[${j}]`)); }
  });
  model.tracks.audio.forEach((l, i) => { if (l.ducking) presetCheck(l.ducking.presetId, 'audio', l.ducking.params, `tracks.audio[${i}].ducking`); });
  if (model.tracks.caption.styleId) presetCheck(model.tracks.caption.styleId, 'caption', model.tracks.caption.params, 'tracks.caption.styleId');
  if (model.background) presetCheck(model.background.presetId, 'background', model.background.params, 'background');
  presetCheck(model.theme.paletteId, 'palette', undefined, 'theme.paletteId');
  presetCheck(model.theme.fontPairId, 'fontpair', undefined, 'theme.fontPairId');
  presetCheck(model.theme.defaultEasingId, 'easing', undefined, 'theme.defaultEasingId');

  // CM-008 text fits at the current ratio
  const frame = frameInUnits(model.settings.ratio, model.settings.customRatio);
  model.tracks.text.forEach((t, i) => {
    const variant = getPreset(t.variantId);
    const size = t.style.fontSize ?? Number(variant?.data?.['fontSize'] ?? model.theme.textDefaults.fontSize);
    const width = Math.min(t.maxWidth ?? Infinity, frame.w - 2 * SAFE_MARGIN_U);
    const r = fitText(t.text, { width, height: frame.h * 0.5, maxSize: size, minSize: MIN_TEXT_U, maxLines: 6 });
    if (r.overflow) out.push(issue('CM-008', `Text ${t.id} does not fit at this ratio even at ${MIN_TEXT_U} u; shorten it or change the ratio.`, 'warn', `tracks.text[${i}].text`));
  });

  // CM-009 captions ordered, non-overlapping, within duration
  const pages = model.tracks.caption.pages;
  pages.forEach((p, i) => {
    const prev = pages[i - 1];
    if (prev && p.startMs < prev.startMs + prev.durationMs) out.push(issue('CM-009', `Caption page ${i + 1} overlaps the previous page.`, 'warn', `tracks.caption.pages[${i}]`));
    if (p.startMs + p.durationMs > timing.durationMs) out.push(issue('CM-009', `Caption page ${i + 1} runs past the end and will be trimmed.`, 'warn', `tracks.caption.pages[${i}]`));
  });

  // CM-010 resolution vs tier
  if (ctx.tier === 'T0' && (model.settings.resolution === '2k' || model.settings.resolution === '2160p'))
    out.push(issue('CM-010', `${model.settings.resolution} is not available on this computer; export will offer 1080p (EM-3105).`, 'warn', 'settings.resolution'));

  // CM-012 (ADR-027) items on one lane do not overlap in time; apply never produces this, hand-made JSON can (render order stays defined)
  for (const c of laneConflicts(model)) out.push(issue('CM-012', `${c.a} and ${c.b} overlap in time on ${c.track === 'audio' ? 'audio lane' : 'layer'} ${c.lane}.`, 'warn', c.track === 'audio' ? 'tracks.audio' : 'tracks'));

  // CM-011 unique ids
  const ids = [...v.map((c) => c.id), ...model.tracks.text.map((t) => t.id), ...model.tracks.overlay.map((o) => o.id), ...model.tracks.audio.map((a) => a.id)];
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of new Set(dup)) out.push(issue('CM-011', `Element id ${id} is used more than once.`, 'block', 'tracks'));
  return out;
}
