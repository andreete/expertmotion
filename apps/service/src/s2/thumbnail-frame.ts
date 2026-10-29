// QA P1 2026-10-29 (round 1, thumbnail follow-up): the cover was grabbed mid-counter ("US$ 24,64" instead of the final 25,96) and
// mid-entrance. The capture time moves to where every element of the frame's scene has finished its entrance motion, its
// counter and its typewriter — and is still before any of them starts its exit. Pure; the Engine timings it mirrors are in
// packages/engine (motion.ts entrance = delayMs + durationMs, exit = params.exitMs ?? durationMs; text.tsx counter = delayMs +
// durationMs (default 1200 ms); preset:motion.typewriter 20 characters / s after its delay).
import { deriveTiming, type CompositionModelT } from '@expertmotion/composition-model';

interface Timed { id: string; timing: { atMs: number; durationMs: number }; motion?: { presetId: string; durationMs: number; delayMs: number; exit: boolean; params: Record<string, unknown> } | null; effect?: { presetId: string; params: Record<string, unknown> } | null; text?: string }
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** When an element is fully "in": entrance motion, counter and typewriter done (ms, timeline time). */
export function settledAtMs(e: Timed): number {
  let end = e.timing.atMs;
  if (e.motion) end = Math.max(end, e.timing.atMs + e.motion.delayMs + e.motion.durationMs);
  const fx = e.effect?.presetId;
  if (fx === 'preset:texteffect.counter') end = Math.max(end, e.timing.atMs + num(e.effect!.params['delayMs'], 0) + num(e.effect!.params['durationMs'], 1200));
  if (e.motion?.presetId === 'preset:motion.typewriter') end = Math.max(end, e.timing.atMs + e.motion.delayMs + Math.ceil(((e.text ?? '').length / 20) * 1000));
  return end;
}
/** When an element starts to leave (its exit motion), or its end without one. */
export function leavesAtMs(e: Timed): number {
  const end = e.timing.atMs + e.timing.durationMs;
  if (!e.motion || !e.motion.exit) return end;
  return end - Math.max(0, num(e.motion.params['exitMs'], e.motion.durationMs));
}

/**
 * The capture time for a still asked at `atMs`: inside the scene (video clip) holding `atMs` (else the whole Sequence), after
 * every element that appears in that scene has settled, before any of them leaves; never outside the Sequence. `frameMs` is
 * one frame (the margin past the last settle).
 */
export function settledCaptureMs(model: CompositionModelT, atMs: number): number {
  const t = deriveTiming(model); const frameMs = 1000 / model.settings.fps;
  const last = Math.max(0, t.durationMs - frameMs);
  let lo = 0, hi = t.durationMs;
  const i = t.clipStartMs.findIndex((s, k) => atMs >= s && atMs < s + model.tracks.video[k]!.durationMs);
  if (i >= 0) { lo = t.clipStartMs[i]!; hi = lo + model.tracks.video[i]!.durationMs; }
  const els = [...model.tracks.text, ...model.tracks.overlay] as unknown as Timed[];
  // the elements of this scene: they start inside it (a full-length cover title starts before it and counts as already settled)
  const inScene = els.filter((e) => e.timing.atMs < hi && e.timing.atMs + e.timing.durationMs > lo && (e.timing.atMs >= lo || e.timing.atMs + e.timing.durationMs > atMs));
  if (!inScene.length) return Math.min(atMs, last);
  let want = atMs;
  for (const e of inScene) if (e.timing.atMs >= lo) want = Math.max(want, settledAtMs(e) + frameMs);
  // before anything visible at that time starts to leave (and before the scene ends)
  let limit = Math.min(hi, t.durationMs) - frameMs;
  for (const e of inScene) if (e.timing.atMs <= want) limit = Math.min(limit, leavesAtMs(e) - frameMs);
  return Math.max(0, Math.min(Math.max(atMs, Math.min(want, limit)), last));
}
