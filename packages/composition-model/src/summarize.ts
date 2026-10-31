// Compact composition block for the Rewrite envelope (AI_WORKFLOW.md §7): ids, durations, preset ids, text contents.
// Never file paths. Budget is approximate (4 characters ≈ 1 token); lists are truncated with a marker when over budget.
import type { AssetFacts, CompositionModelT } from './schema.js';
import { deriveTiming } from './timing.js';
import { frameInUnits } from './units.js';

export interface CompactComposition {
  settings: { fps: number; ratio: string; resolution: string; language: string };
  durationMs: number;
  /** `transform` (ADR-028) only when the picture was moved, zoomed or rotated: x / y fractions of the frame, scale 1 = fit result, degrees. */
  video: Array<{ id: string; asset: string | null; scene?: string; durationMs: number; trimBeforeMs: number; effects: string[]; motion: string | null; transform?: { x: number; y: number; scale: number; rotation: number } }>;
  cuts: Array<{ index: number; transition: string | null; durationMs: number | null }>;
  /** `layer`: stacking order shared by texts and overlays, higher = in front (ADR-027). */
  text: Array<{ id: string; variant: string; text: string; atMs: number; durationMs: number; layer: number }>;
  /** `x` / `y`: centre as a fraction of the frame (0 = centre, ADR-028 units); `scale` / `rotation` only when set. */
  overlay: Array<{ id: string; kind: string; preset: string | null; asset: string | null; atMs: number; durationMs: number; layer: number; x: number; y: number; scale?: number; rotation?: number;
    /** ADR-041 picture look, only when set: corner radius (u), a drop shadow, a border (colour, u). */ radius?: number; shadow?: true; border?: { colour: string; widthU: number } }>;
  /** ADR-033: `list` = the caption pages (i = 0-based pageIndex, start / end ms, text ≤ 80 chars) so one page can be fixed
   *  with op:caption.replaceText / op:caption.editPage; at most CAPTION_LIST_MAX pages, halved first when over budget. */
  captions: { style: string | null; pages: number; list: Array<{ i: number; startMs: number; endMs: number; text: string }> };
  audio: Array<{ id: string; role: string; asset: string; atMs: number; durationMs: number | null; lane: number }>;
  background: string | null;
  theme: { palette: string; fontPair: string; easing: string };
  truncated: boolean;
}

/** ADR-033: caption pages listed in the envelope (a 3-minute talking video has ~150). */
export const CAPTION_LIST_MAX = 200;

export function summarizeForAgent(model: CompositionModelT, assets: readonly AssetFacts[], maxTokens = 4000): CompactComposition {
  const names = new Map(assets.map((a) => [a.id, a.name ?? a.id]));
  const t = deriveTiming(model);
  const f = frameInUnits(model.settings.ratio, model.settings.customRatio);
  const frac = (v: number, of: number) => Math.round((v / of) * 1000) / 1000;
  const out: CompactComposition = {
    settings: { fps: model.settings.fps, ratio: model.settings.ratio, resolution: model.settings.resolution, language: model.settings.language },
    durationMs: t.durationMs,
    video: model.tracks.video.map((c) => ({ id: c.id, asset: c.assetId === undefined ? null : names.get(c.assetId) ?? c.assetId, ...(c.scene ? { scene: c.scene.presetId } : {}), durationMs: c.durationMs, trimBeforeMs: c.trimBeforeMs, effects: c.effects.map((e) => e.presetId), motion: c.motion?.presetId ?? null, ...(c.transform ? { transform: c.transform } : {}) })),
    cuts: model.tracks.video.slice(1).map((_, i) => { const tr = model.transitions.find((x) => x.cutIndex === i); return { index: i, transition: tr?.presetId ?? null, durationMs: tr?.durationMs ?? null }; }),
    text: model.tracks.text.map((x) => ({ id: x.id, variant: x.variantId, text: x.text.length > 120 ? `${x.text.slice(0, 117)}…` : x.text, atMs: x.timing.atMs, durationMs: x.timing.durationMs, layer: x.layer })),
    overlay: model.tracks.overlay.map((o) => ({ id: o.id, kind: o.kind, preset: o.kind === 'shape' ? o.presetId : null, asset: o.kind === 'image' || o.kind === 'video' ? names.get(o.assetId) ?? o.assetId : null, atMs: o.timing.atMs, durationMs: o.timing.durationMs, layer: o.layer,
      x: frac(o.position.x, f.w), y: frac(o.position.y, f.h), ...(o.scale !== undefined ? { scale: o.scale } : {}), ...(o.rotation !== undefined ? { rotation: o.rotation } : {}),
      ...(o.kind === 'image' && o.radius !== undefined ? { radius: o.radius } : {}), ...(o.kind === 'image' && o.shadow ? { shadow: true as const } : {}), ...(o.kind === 'image' && o.border ? { border: o.border } : {}) })),
    captions: { style: model.tracks.caption.styleId, pages: model.tracks.caption.pages.length,
      list: model.tracks.caption.pages.slice(0, CAPTION_LIST_MAX).map((p, i) => { const x = p.text.trim(); return { i, startMs: p.startMs, endMs: p.startMs + p.durationMs, text: x.length > 80 ? `${x.slice(0, 79)}…` : x }; }) },
    audio: model.tracks.audio.map((a) => ({ id: a.id, role: a.role, asset: names.get(a.assetId) ?? a.assetId, atMs: a.atMs, durationMs: a.durationMs ?? null, lane: a.lane })),
    background: model.background?.presetId ?? null,
    theme: { palette: model.theme.paletteId, fontPair: model.theme.fontPairId, easing: model.theme.defaultEasingId },
    truncated: false,
  };
  const budget = maxTokens * 4;
  const lists = ['text', 'overlay', 'audio', 'video'] as const;
  if (out.captions.list.length < out.captions.pages) out.truncated = true;
  // Caption pages go first (they are the longest list and only needed for caption fixes), down to 20.
  while (JSON.stringify(out).length > budget && out.captions.list.length > 20) { out.captions.list.splice(Math.ceil(out.captions.list.length / 2)); out.truncated = true; }
  while (JSON.stringify(out).length > budget && lists.some((k) => out[k].length > 3)) {
    const k = lists.find((l) => out[l].length > 3)!;
    (out[k] as unknown[]).splice(Math.ceil(out[k].length / 2));
    out.truncated = true;
  }
  return out;
}
