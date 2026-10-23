// Motion presets (DESIGN_CATALOGUE §5) as a pure style function of the frame. Separate CSS props translate/scale/rotate/opacity
// (book §5.3) so preview and render compute identical values.
import type React from 'react';
import { interpolate, spring } from 'remotion';
import type { MotionT } from '@expertmotion/composition-model';
import { easingFn, springDamping } from './easing.js';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export function motionStyle(m: MotionT | null, frame: number, durationInFrames: number, fps: number, u: number, defaultEasingId: string): React.CSSProperties {
  if (!m) return {};
  const enterFrames = Math.max(1, Math.round((m.durationMs / 1000) * fps));
  const delay = Math.round((m.delayMs / 1000) * fps);
  const easingId = m.easingId ?? defaultEasingId;
  const damping = springDamping(easingId);
  const progressAt = (f: number) => (damping === null
    ? interpolate(f, [delay, delay + enterFrames], [0, 1], { ...clamp, easing: easingFn(easingId) })
    : spring({ frame: f - delay, fps, config: { damping }, durationInFrames: enterFrames }));
  const enter = progressAt(frame);
  const exit = m.exit ? 1 - interpolate(frame, [durationInFrames - enterFrames, durationInFrames], [0, 1], { ...clamp, easing: easingFn('preset:easing.in-quad') }) : 1;
  const p = Math.min(enter, exit);
  const dir = String(m.params['direction'] ?? 'from-left');
  switch (m.presetId) {
    case 'preset:motion.fade-in': return { opacity: p };
    case 'preset:motion.rise': return { opacity: p, translate: `0px ${(1 - p) * Number(m.params['distanceU'] ?? 40) * u}px` };
    case 'preset:motion.pop': {
      const s = spring({ frame: frame - delay, fps, config: { damping: Number(m.params['damping'] ?? 12) } });
      return { scale: Math.min(s, exit), opacity: Math.min(1, s * 2, exit) };
    }
    case 'preset:motion.slide-in': {
      const d = (1 - p) * 300 * u;
      const t = dir === 'from-right' ? `${d}px 0px` : dir === 'from-top' ? `0px ${-d}px` : dir === 'from-bottom' ? `0px ${d}px` : `${-d}px 0px`;
      return { opacity: p, translate: t };
    }
    case 'preset:motion.zoom-drift': return { scale: interpolate(frame, [0, Math.max(1, durationInFrames)], [1, Number(m.params['toScale'] ?? 1.08)], clamp) };
    case 'preset:motion.spin-in': return { opacity: p, rotate: `${(1 - p) * -20}deg`, scale: 0.8 + 0.2 * p };
    case 'preset:motion.bounce': return { opacity: Math.min(1, p * 2), translate: `0px ${(1 - interpolate(frame, [delay, delay + enterFrames], [0, 1], { ...clamp, easing: easingFn('preset:easing.bounce') })) * -120 * u}px` };
    default: return { opacity: p };                         // typewriter / word-stagger are handled inside the text renderer
  }
}
