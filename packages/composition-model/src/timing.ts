// Derived timing (DATABASE_SCHEMA.md §4.3). Milliseconds are the stored truth; frames are derived ONCE here so the Player
// (apps/ui) and the renderer (packages/engine calculateMetadata) can never disagree (ADR-001 "one code path").
import { issue, type Issue } from '@expertmotion/shared';
import type { CompositionModelT } from './schema.js';
import { framesOf } from './units.js';

export const MIN_DURATION_MS = 1000, MAX_DURATION_MS = 1_800_000;

export interface DerivedTiming {
  durationMs: number;
  /** cutStartMs[k] = start of clip k+1 = Σ_{i≤k} clip_i − Σ_{j≤k} transition_j */
  cutStartMs: number[];
  clipStartMs: number[];
  elementWindows: Record<string, { fromMs: number; toMs: number }>;
  warnings: Issue[];
}

export function deriveTiming(model: CompositionModelT): DerivedTiming {
  const v = model.tracks.video, warnings: Issue[] = [];
  const trans = new Map(model.transitions.map((t) => [t.cutIndex, t.durationMs]));
  const clipStartMs: number[] = [], cutStartMs: number[] = [];
  let cursor = 0;
  v.forEach((c, i) => {
    clipStartMs.push(cursor);
    cursor += c.durationMs;
    if (i < v.length - 1) { cursor -= trans.get(i) ?? 0; cutStartMs.push(cursor); }
  });
  const contentMs = cursor;
  let durationMs = model.durationPolicy === 'fixed' && model.fixedDurationMs ? model.fixedDurationMs : contentMs;
  if (durationMs < MIN_DURATION_MS) durationMs = MIN_DURATION_MS;
  const windows: DerivedTiming['elementWindows'] = {};
  v.forEach((c, i) => { windows[c.id] = { fromMs: clipStartMs[i]!, toMs: clipStartMs[i]! + c.durationMs }; });
  const add = (id: string, from: number, to: number, kind: string) => {
    windows[id] = { fromMs: from, toMs: Math.min(to, durationMs) };
    if (to > durationMs) warnings.push(issue('CM-005', `${kind} ${id} runs past the end and will be cut at ${durationMs} ms.`, 'warn', `tracks.${kind}`));
  };
  for (const t of model.tracks.text) add(t.id, t.timing.atMs, t.timing.atMs + t.timing.durationMs, 'text');
  for (const o of model.tracks.overlay) add(o.id, o.timing.atMs, o.timing.atMs + o.timing.durationMs, 'overlay');
  for (const a of model.tracks.audio) add(a.id, a.atMs, a.durationMs === undefined ? durationMs : a.atMs + a.durationMs, 'audio');   // v2: a looping layer with a length stops there (ADR-027)
  return { durationMs, cutStartMs, clipStartMs, elementWindows: windows, warnings };
}

export interface FrameTiming { fps: number; durationInFrames: number; clipFrames: number[]; transitionFrames: Record<number, number>; clipStartFrames: number[] }
/**
 * Frame counts per element, rounded individually, with the total computed from the rounded parts (Σ clips − Σ transitions)
 * so that <TransitionSeries> sums exactly to durationInFrames. Fixed-duration projects use the fixed length instead.
 */
export function deriveFrameTiming(model: CompositionModelT): FrameTiming {
  const fps = model.settings.fps;
  const clipFrames = model.tracks.video.map((c) => Math.max(1, framesOf(c.durationMs, fps)));
  const transitionFrames: Record<number, number> = {};
  for (const t of model.transitions) {
    const f = Math.max(1, framesOf(t.durationMs, fps));
    const limit = Math.min(clipFrames[t.cutIndex] ?? 0, clipFrames[t.cutIndex + 1] ?? 0) - 1;  // Remotion: a transition may not be as long as an adjacent sequence
    transitionFrames[t.cutIndex] = Math.max(1, Math.min(f, limit));
  }
  const clipStartFrames: number[] = [];
  let cursor = 0;
  clipFrames.forEach((f, i) => { clipStartFrames.push(cursor); cursor += f - (i < clipFrames.length - 1 ? (transitionFrames[i] ?? 0) : 0); });
  const content = cursor;
  const durationInFrames = model.durationPolicy === 'fixed' && model.fixedDurationMs ? framesOf(model.fixedDurationMs, fps) : Math.max(framesOf(MIN_DURATION_MS, fps), content);
  return { fps, durationInFrames, clipFrames, transitionFrames, clipStartFrames };
}
