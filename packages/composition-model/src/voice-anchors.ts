// FR-250 (ADR-035): captions follow their voice-over. Caption pages that lie inside a voice layer's heard window belong to that
// voice clip; when an operation moves or trims the voice layer, those pages move with it (same delta on the Sequence), and pages
// whose words now fall outside the clip's window are dropped. No schema change: membership is derived from times, exactly like
// the scene anchoring of ADR-031. Applied by applyOperations around every op that can change an audio layer's timing.
import type { AssetFacts, CompositionModelT } from './schema.js';

export const AUDIO_TIMING_OPS: ReadonlySet<string> = new Set(['op:element.setTiming', 'op:element.setLayer']);
export interface VoiceAnchor { layerId: string; origin: number; fromMs: number; toMs: number; pages: number[] }

const lengthOf = (a: CompositionModelT['tracks']['audio'][number], assets: readonly AssetFacts[]): number | null => {
  const src = assets.find((x) => x.id === a.assetId)?.durationMs;
  return a.durationMs ?? (typeof src === 'number' ? Math.max(0, src - a.trimBeforeMs) : null);
};
const windowOf = (m: CompositionModelT, a: CompositionModelT['tracks']['audio'][number], assets: readonly AssetFacts[]): { fromMs: number; toMs: number } => {
  const src = assets.find((x) => x.id === a.assetId)?.durationMs;
  const len = a.durationMs ?? (typeof src === 'number' ? Math.max(0, src - a.trimBeforeMs) : null);
  const next = m.tracks.audio.filter((b) => b.role === 'voice' && b.id !== a.id && b.atMs > a.atMs).map((b) => b.atMs).sort((x, y) => x - y)[0];
  return { fromMs: a.atMs, toMs: len !== null ? a.atMs + len : next ?? Number.MAX_SAFE_INTEGER };
};
/** Pages fully inside each voice layer's window (a page belongs to the latest-starting voice layer that holds it). */
export function voiceAnchors(m: CompositionModelT, assets: readonly AssetFacts[] = []): VoiceAnchor[] {
  const voices = m.tracks.audio.filter((a) => a.role === 'voice');
  if (!voices.length || !m.tracks.caption.pages.length) return [];
  const out = voices.map((a) => ({ layerId: a.id, origin: a.atMs - a.trimBeforeMs, ...windowOf(m, a, assets), pages: [] as number[] }));
  m.tracks.caption.pages.forEach((p, i) => {
    const end = p.startMs + p.durationMs;
    const holder = out.filter((v) => p.startMs >= v.fromMs && end <= v.toMs + 50).sort((x, y) => y.fromMs - x.fromMs)[0];
    holder?.pages.push(i);
  });
  return out.filter((v) => v.pages.length);
}
/** After an op: anchored pages shift by the change of their layer's source origin (atMs − trimBeforeMs) and are clipped to its new window. */
export function followVoiceAnchors(m: CompositionModelT, before: readonly VoiceAnchor[], assets: readonly AssetFacts[] = []): void {
  if (!before.length) return;
  const drop = new Set<number>();
  for (const a of before) {
    const layer = m.tracks.audio.find((x) => x.id === a.layerId);
    if (!layer) continue;                                         // a deleted voice keeps its captions (the Creator removes them)
    const delta = layer.atMs - layer.trimBeforeMs - a.origin;
    // C9 (review 2026-10-29): a voice of unknown length keeps its own window (moved by its own delta); another voice moving
    // earlier must not shorten it and drop its caption pages
    const w = lengthOf(layer, assets) === null ? { fromMs: layer.atMs, toMs: a.toMs === Number.MAX_SAFE_INTEGER ? a.toMs : a.toMs + delta } : windowOf(m, layer, assets);
    if (delta === 0 && w.fromMs === a.fromMs && w.toMs === a.toMs) continue;
    for (const i of a.pages) {
      const p = m.tracks.caption.pages[i]!;
      const s = p.startMs + delta, e = p.startMs + p.durationMs + delta;
      if (e <= w.fromMs || s >= w.toMs || s < 0) { drop.add(i); continue; }
      const s0 = Math.max(w.fromMs, s), e0 = Math.min(w.toMs, e);
      m.tracks.caption.pages[i] = { ...p, startMs: s0, durationMs: Math.max(1, e0 - s0),
        tokens: p.tokens.map((t) => ({ ...t, fromMs: Math.max(s0, Math.min(e0, t.fromMs + delta)), toMs: Math.max(s0, Math.min(e0, t.toMs + delta)) })) };
    }
  }
  if (drop.size) m.tracks.caption.pages = m.tracks.caption.pages.filter((_, i) => !drop.has(i));
  m.tracks.caption.pages.sort((x, y) => x.startMs - y.startMs);
}
