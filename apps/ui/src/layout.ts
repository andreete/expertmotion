// Panel sizing rules (EDITOR_INTERACTION_MODEL.md §9–§10, FR-099, FR-155). Pure: no React, unit-testable.
import type { PanelSizes, SizeBucket } from './prefs.js';

export const LAYOUT = {
  lib: { min: 240, max: 420, collapseBelow: 200 },
  agent: { min: 320, max: 900 },
  /** Brainstorming / Editor Chat split inside the Agent Panel (FR-099): ratio = Brainstorming share of the chat area. */
  chat: { min: 140, editorMin: 200, defaultSplit: 0.4, fallbackHeight: 600 },
  timeline: { min: 220 },
  stageMin: 640,
  rail: 48,
  divider: 6,
  keyStep: 16,
} as const;

export function bucketFor(width: number): SizeBucket { return width < 1280 ? 'narrow' : width < 1600 ? 'standard' : 'wide'; }

export function defaultSizes(bucket: SizeBucket): Required<PanelSizes> {
  return { lib: 300, agent: bucket === 'narrow' ? 360 : bucket === 'wide' ? 480 : 420, timeline: 240 };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Effective column widths for a window width (FR-099): side panels shrink toward their minimums first (Library before Agent),
 * then collapse to a rail in the order Library → Agent, so the Stage never gets narrower than 640 px.
 */
export function resolveColumns(o: { width: number; lib: number; agent: number; libOpen: boolean; agentOpen: boolean }): { lib: number; agent: number; libMax: number; agentMax: number; libOpen: boolean; agentOpen: boolean } {
  const space = (libOn: boolean, agentOn: boolean) => o.width - LAYOUT.stageMin - (libOn ? LAYOUT.divider : LAYOUT.rail) - (agentOn ? LAYOUT.divider : LAYOUT.rail);
  let libOpen = o.libOpen, agentOpen = o.agentOpen;
  if (libOpen && space(true, agentOpen) < LAYOUT.lib.min + (agentOpen ? LAYOUT.agent.min : 0)) libOpen = false;
  if (agentOpen && space(libOpen, true) < LAYOUT.agent.min + (libOpen ? LAYOUT.lib.min : 0)) agentOpen = false;
  const room = space(libOpen, agentOpen);
  let lib = clamp(o.lib, LAYOUT.lib.min, LAYOUT.lib.max), agent = clamp(o.agent, LAYOUT.agent.min, LAYOUT.agent.max);
  let over = (libOpen ? lib : 0) + (agentOpen ? agent : 0) - room;
  if (over > 0 && libOpen) { const d = Math.min(over, lib - LAYOUT.lib.min); lib -= d; over -= d; }
  if (over > 0 && agentOpen) { const d = Math.min(over, agent - LAYOUT.agent.min); agent -= d; }
  const libMax = Math.max(LAYOUT.lib.min, Math.min(LAYOUT.lib.max, room - (agentOpen ? agent : 0)));
  const agentMax = Math.max(LAYOUT.agent.min, Math.min(LAYOUT.agent.max, room - (libOpen ? lib : 0)));
  return { lib, agent, libMax, agentMax, libOpen, agentOpen };
}

/**
 * Chat split (FR-099): the Brainstorming Chat's height in px for a chat area of `height` px (divider excluded) and a stored ratio,
 * plus the divider range so both chats keep their minimums (Brainstorming 140 px, Editor 200 px: it also holds the Intent Queue).
 * Unknown height (jsdom, first paint) → a nominal 600 px so keyboard steps still work.
 */
export function resolveChatSplit(height: number, ratio: number | undefined): { size: number; min: number; max: number; area: number } {
  const area = Math.max(height > 0 ? height - LAYOUT.divider : LAYOUT.chat.fallbackHeight, LAYOUT.chat.min + LAYOUT.chat.editorMin);
  const min = LAYOUT.chat.min, max = area - LAYOUT.chat.editorMin;
  const r = Number.isFinite(ratio) ? (ratio as number) : LAYOUT.chat.defaultSplit;
  return { size: clamp(Math.round(r * area), min, max), min, max, area };
}
/** Brainstorming Chat height in px → stored ratio (3 decimals), clamped to the minimums of both chats. */
export function chatRatioFor(size: number, height: number): number {
  const { min, max, area } = resolveChatSplit(height, undefined);
  return Math.round((clamp(size, min, max) / area) * 1000) / 1000;
}

/** Timeline View height: 220 px minimum, at most half the Stage height (unknown height → generous cap). */
export function timelineMax(stageHeight: number): number {
  return stageHeight > 0 ? Math.max(LAYOUT.timeline.min, Math.floor(stageHeight * 0.5)) : 640;
}
