// Panel sizing rules (EDITOR_INTERACTION_MODEL.md §9–§10, FR-099, FR-155). Pure: no React, unit-testable.
import type { PanelSizes, SizeBucket } from './prefs.js';

export const LAYOUT = {
  lib: { min: 240, max: 420, collapseBelow: 200 },
  agent: { min: 320, max: 520 },
  timeline: { min: 220 },
  stageMin: 560,
  rail: 48,
  divider: 6,
  keyStep: 16,
} as const;

export function bucketFor(width: number): SizeBucket { return width < 1280 ? 'narrow' : width < 1600 ? 'standard' : 'wide'; }

export function defaultSizes(bucket: SizeBucket): Required<PanelSizes> {
  return { lib: 300, agent: bucket === 'narrow' ? 320 : 360, timeline: 240 };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Effective column widths for a window width: each side panel inside its range and the Stage never below 560 px. */
export function resolveColumns(o: { width: number; lib: number; agent: number; libOpen: boolean; agentOpen: boolean }): { lib: number; agent: number; libMax: number; agentMax: number } {
  const side = (open: boolean, w: number) => (open ? w + LAYOUT.divider : LAYOUT.rail);
  const agent0 = clamp(o.agent, LAYOUT.agent.min, LAYOUT.agent.max);
  const libMax = Math.min(LAYOUT.lib.max, o.width - LAYOUT.stageMin - side(o.agentOpen, agent0) - LAYOUT.divider);
  const lib = clamp(o.lib, LAYOUT.lib.min, libMax);
  const agentMax = Math.min(LAYOUT.agent.max, o.width - LAYOUT.stageMin - side(o.libOpen, lib) - LAYOUT.divider);
  return { lib, agent: clamp(agent0, LAYOUT.agent.min, agentMax), libMax: Math.max(LAYOUT.lib.min, libMax), agentMax: Math.max(LAYOUT.agent.min, agentMax) };
}

/** Timeline View height: 220 px minimum, at most half the Stage height (unknown height → generous cap). */
export function timelineMax(stageHeight: number): number {
  return stageHeight > 0 ? Math.max(LAYOUT.timeline.min, Math.floor(stageHeight * 0.5)) : 640;
}
