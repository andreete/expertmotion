// Compact composition block for the Rewrite envelope (AI_WORKFLOW.md §7): ids, durations, preset ids, text contents.
// Never file paths. Budget is approximate (4 characters ≈ 1 token); lists are truncated with a marker when over budget.
import type { AssetFacts, CompositionModelT } from './schema.js';
import { deriveTiming } from './timing.js';

export interface CompactComposition {
  settings: { fps: number; ratio: string; resolution: string; language: string };
  durationMs: number;
  video: Array<{ id: string; asset: string; durationMs: number; trimBeforeMs: number; effects: string[]; motion: string | null }>;
  cuts: Array<{ index: number; transition: string | null; durationMs: number | null }>;
  text: Array<{ id: string; variant: string; text: string; atMs: number; durationMs: number }>;
  overlay: Array<{ id: string; kind: string; preset: string | null; atMs: number }>;
  captions: { style: string | null; pages: number };
  audio: Array<{ id: string; role: string; asset: string; atMs: number }>;
  background: string | null;
  theme: { palette: string; fontPair: string; easing: string };
  truncated: boolean;
}

export function summarizeForAgent(model: CompositionModelT, assets: readonly AssetFacts[], maxTokens = 4000): CompactComposition {
  const names = new Map(assets.map((a) => [a.id, a.name ?? a.id]));
  const t = deriveTiming(model);
  const out: CompactComposition = {
    settings: { fps: model.settings.fps, ratio: model.settings.ratio, resolution: model.settings.resolution, language: model.settings.language },
    durationMs: t.durationMs,
    video: model.tracks.video.map((c) => ({ id: c.id, asset: names.get(c.assetId) ?? c.assetId, durationMs: c.durationMs, trimBeforeMs: c.trimBeforeMs, effects: c.effects.map((e) => e.presetId), motion: c.motion?.presetId ?? null })),
    cuts: model.tracks.video.slice(1).map((_, i) => { const tr = model.transitions.find((x) => x.cutIndex === i); return { index: i, transition: tr?.presetId ?? null, durationMs: tr?.durationMs ?? null }; }),
    text: model.tracks.text.map((x) => ({ id: x.id, variant: x.variantId, text: x.text.length > 120 ? `${x.text.slice(0, 117)}…` : x.text, atMs: x.timing.atMs, durationMs: x.timing.durationMs })),
    overlay: model.tracks.overlay.map((o) => ({ id: o.id, kind: o.kind, preset: o.kind === 'shape' ? o.presetId : null, atMs: o.timing.atMs })),
    captions: { style: model.tracks.caption.styleId, pages: model.tracks.caption.pages.length },
    audio: model.tracks.audio.map((a) => ({ id: a.id, role: a.role, asset: names.get(a.assetId) ?? a.assetId, atMs: a.atMs })),
    background: model.background?.presetId ?? null,
    theme: { palette: model.theme.paletteId, fontPair: model.theme.fontPairId, easing: model.theme.defaultEasingId },
    truncated: false,
  };
  const budget = maxTokens * 4;
  const lists = ['text', 'overlay', 'audio', 'video'] as const;
  while (JSON.stringify(out).length > budget && lists.some((k) => out[k].length > 3)) {
    const k = lists.find((l) => out[l].length > 3)!;
    (out[k] as unknown[]).splice(Math.ceil(out[k].length / 2));
    out.truncated = true;
  }
  return out;
}
