// Implementation coverage of the closed catalogue (BLUEPRINT §3.3: every catalogue id must have an implementation).
import { ALL_PRESETS } from '@expertmotion/catalogue';
import { TRANSITIONS } from './transitions.js';
import { EFFECTS, EFFECTS_NOT_IN_PINNED_REMOTION } from './effects.js';
import { SHAPES } from './shapes.js';

const handledInline: Record<string, readonly string[]> = {
  background: ['solid', 'gradient', 'spotlight', 'grid', 'dots', 'moving-gradient', 'noise-clouds', 'video-dim', 'none'],
  motion: ['fade-in', 'rise', 'pop', 'slide-in', 'zoom-drift', 'spin-in', 'bounce', 'typewriter', 'word-stagger', 'blur-in', 'scale-in', 'wipe-reveal', 'draw-on', 'grow', 'none'],
  caption: ['editorial', 'karaoke', 'box', 'pop', 'moving-pill', 'none'],
  text: ['title', 'subtitle', 'lower-third', 'callout', 'quote'],
  texteffect: ['highlight', 'underline', 'circle', 'kinetic', 'counter', 'keyword'],
  easing: ['out-quad', 'out-cubic', 'in-quad', 'in-out-cubic', 'back', 'bounce', 'linear', 'spring-soft', 'spring-bouncy', 'snappy', 'spring-light'],
  audio: ['bed-soft', 'duck-voice', 'fade-in-out', 'sfx-hit'],
};
/** Presets with a known reason for having no implementation yet (documented in process.md / REMOTION_CAPABILITY_MAP). */
export const NOT_IMPLEMENTED: Readonly<Record<string, string>> = {
  ...Object.fromEntries(EFFECTS_NOT_IN_PINNED_REMOTION.map((id) => [id, 'not exported by the pinned Remotion 4.0.535 (P2)'])),
  'preset:background.paper': 'P2: needs the @remotion/effects paper generator on a <Solid>; not wired yet',
  'preset:audio.visualizer-bars': 'P2: no operation places a visualizer yet (ADR-020)',
};
export function isImplemented(id: string): boolean {
  const [, rest] = id.split(':'); const [category, name] = (rest ?? '').split('.');
  if (category === 'transition') return id in TRANSITIONS;
  if (category === 'effect') return id in EFFECTS;
  if (category === 'shape') return id in SHAPES;
  if (category === 'font' || category === 'palette' || category === 'fontpair') return true;   // data-only presets
  return (handledInline[category ?? ''] ?? []).includes(name ?? '');
}
export const missingImplementations = (): string[] => ALL_PRESETS.map((p) => p.id).filter((id) => !isImplemented(id));
