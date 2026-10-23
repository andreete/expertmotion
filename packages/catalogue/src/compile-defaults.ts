// Compile table (AI_WORKFLOW.md §7): which Operation a fully specified Design Pick becomes, per category.
// `requires` lists arguments the pick must supply (asset, text, target); without them the intent needs interpretation.
import type { Category, PresetDef } from './types.js';

export interface CompileRule { op: string; requires: readonly string[]; argsFrom: (p: PresetDef) => Record<string, unknown> }

const params = (p: PresetDef) => ({ ...p.defaults });
export const COMPILE_RULES: Readonly<Record<Category, CompileRule>> = Object.freeze({
  transition: { op: 'op:transition.set', requires: [], argsFrom: (p) => { const { durationMs, timing, easingId, ...rest } = p.defaults as Record<string, unknown>; return { presetId: p.id, durationMs, timing, ...(easingId === undefined ? {} : { easingId }), params: rest }; } },
  caption: { op: 'op:caption.setStyle', requires: [], argsFrom: (p) => ({ presetId: p.id, params: params(p) }) },
  background: { op: 'op:background.set', requires: [], argsFrom: (p) => ({ presetId: p.id, params: params(p) }) },
  motion: { op: 'op:motion.set', requires: ['target'], argsFrom: (p) => ({ presetId: p.id, params: params(p) }) },
  shape: { op: 'op:shape.add', requires: ['atMs'], argsFrom: (p) => ({ presetId: p.id, durationMs: 2000, ...params(p) }) },
  easing: { op: 'op:easing.setDefault', requires: [], argsFrom: (p) => ({ easingId: p.id }) },
  effect: { op: 'op:effect.add', requires: ['target'], argsFrom: (p) => ({ presetId: p.id, params: params(p) }) },
  audio: { op: 'op:audio.setDucking', requires: ['target'], argsFrom: (p) => ({ presetId: p.id, params: params(p) }) },
  text: { op: 'op:text.add', requires: ['text', 'atMs'], argsFrom: (p) => ({ variant: p.id, durationMs: 3000, styleOverrides: params(p) }) },
  texteffect: { op: 'op:text.setEffect', requires: ['target'], argsFrom: (p) => ({ presetId: p.id, params: params(p) }) },
  font: { op: 'op:theme.setTextDefaults', requires: [], argsFrom: (p) => ({ fontFamily: String(p.data?.['family'] ?? '') }) },
  palette: { op: 'op:theme.set', requires: [], argsFrom: (p) => ({ paletteId: p.id }) },
  fontpair: { op: 'op:theme.set', requires: [], argsFrom: (p) => ({ fontPairId: p.id }) },
});

/** Audio presets differ by row: a music bed needs an asset; ducking and fades target an existing Audio Layer. */
export const AUDIO_RULES: Readonly<Record<string, CompileRule>> = Object.freeze({
  'preset:audio.bed-soft': { op: 'op:audio.addBed', requires: ['assetId'], argsFrom: (p) => ({ volume: p.defaults['volume'], loop: true, fadeInMs: p.defaults['fadeMs'], fadeOutMs: p.defaults['fadeMs'] }) },
  'preset:audio.duck-voice': { op: 'op:audio.setDucking', requires: ['target'], argsFrom: (p) => ({ presetId: p.id, params: params(p) }) },
  'preset:audio.fade-in-out': { op: 'op:audio.setFades', requires: ['target'], argsFrom: (p) => ({ fadeInMs: p.defaults['fadeInMs'], fadeOutMs: p.defaults['fadeOutMs'] }) },
  'preset:audio.sfx-hit': { op: 'op:audio.addLayer', requires: ['assetId', 'atMs'], argsFrom: () => ({ volume: 0.8 }) },
  // preset:audio.visualizer-bars (P2) has no Compile rule yet: no operation places a visualizer (added with its P2 op).
});
