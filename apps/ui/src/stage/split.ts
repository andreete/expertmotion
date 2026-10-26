// ADR-028 / FR-179 / IX-28: what the scissors button and S split. The selected clips, texts, images, shapes and audio layers that
// play at the playhead (≥ 100 ms from both edges); with nothing splittable selected, the clip under the playhead. Pure (tested
// without the DOM); the Editor sends the result as ONE splitEdit pick (one Composition Version, undoable at once).
import { deriveTiming, type CompositionModelT, type ElementRefT } from '@expertmotion/composition-model';
import type { SplitEdit } from '../api/types.js';
import { playerBus } from './playerBus.js';

type SplitItem = SplitEdit['items'][number];
const SPLITTABLE = new Set(['clip', 'text', 'image', 'shape', 'audio']);
export const SPLIT_MARGIN_MS = 100;

function windowOf(model: CompositionModelT, ref: SplitItem): { fromMs: number; toMs: number } | undefined {
  const t = deriveTiming(model);
  if (ref.kind === 'clip') return model.tracks.video.some((c) => c.id === ref.id) ? t.elementWindows[ref.id] : undefined;
  if (ref.kind === 'audio') { const a = model.tracks.audio.find((x) => x.id === ref.id); return a ? { fromMs: a.atMs, toMs: a.durationMs === undefined ? t.durationMs : a.atMs + a.durationMs } : undefined; }
  const x = ref.kind === 'text' ? model.tracks.text.find((y) => y.id === ref.id) : model.tracks.overlay.find((o) => o.id === ref.id && o.kind === ref.kind);
  return x ? { fromMs: x.timing.atMs, toMs: x.timing.atMs + x.timing.durationMs } : undefined;
}
const inside = (w: { fromMs: number; toMs: number } | undefined, ms: number) => !!w && ms >= w.fromMs + SPLIT_MARGIN_MS && ms <= w.toMs - SPLIT_MARGIN_MS;

/** The split pick for the playhead, or why there is nothing to split ('outside': the selection does not play there; 'nothing': no clip there). */
export function splitTargets(model: CompositionModelT, selection: readonly ElementRefT[], atMs: number): { edit: SplitEdit } | { reason: 'outside' | 'nothing' } {
  const at = Math.round(atMs);
  const sel = selection.filter((s): s is ElementRefT & SplitItem => SPLITTABLE.has(s.kind) && typeof s.id === 'string').map((s) => ({ kind: s.kind, id: s.id }));
  if (sel.length) {
    const items = sel.filter((s, i) => inside(windowOf(model, s), at) && sel.findIndex((x) => x.kind === s.kind && x.id === s.id) === i);
    return items.length ? { edit: { atMs: at, items } } : { reason: 'outside' };
  }
  const clip = model.tracks.video.find((c) => inside(windowOf(model, { kind: 'clip', id: c.id }), at));
  return clip ? { edit: { atMs: at, items: [{ kind: 'clip', id: clip.id }] } } : { reason: 'nothing' };
}

/** The playhead to split at: the live Player position while playing, else the settled playhead. */
export function splitPlayheadMs(settledMs: number): number {
  const p = playerBus.get();
  return p?.isPlaying() ? p.currentMs() : settledMs;
}

/** Runs a split for the scissors button and the S shortcut (one pick), or tells the Creator why nothing was split. */
export function runSplit(o: { model: CompositionModelT | undefined; selection: readonly ElementRefT[]; playheadMs: number; fps: number;
  splitEdit: (edit: SplitEdit, label: string) => Promise<void>; toast: (kind: 'info', key: string) => void; t: (k: string, v?: Record<string, string | number>) => string; time: (ms: number) => string }): void {
  if (!o.model) return;
  const r = splitTargets(o.model, o.selection, splitPlayheadMs(o.playheadMs));
  if ('reason' in r) { o.toast('info', r.reason === 'outside' ? 'ui.stage.timeline.split.outside' : 'ui.stage.timeline.split.nothing'); return; }
  void o.splitEdit(r.edit, o.t('ui.stage.timeline.split.done', { count: r.edit.items.length, time: o.time(r.edit.atMs) }));
}
