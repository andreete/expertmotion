// Motion presets (DESIGN_CATALOGUE §5) as a pure function of the frame, shared by preview and render. Separate CSS properties
// translate / scale / rotate / opacity (book §5.3). ADR-034 adds blur-in, scale-in, wipe-reveal, draw-on and grow, explicit
// cubic-bezier easing, separate exit length / style and subtle deterministic idle loops (float / pulse / sway / spin via
// @remotion/noise and sine; never Math.random), so preview = render frame by frame.
import type React from 'react';
import { interpolate, spring } from 'remotion';
import { noise2D } from '@remotion/noise';
import type { MotionT } from '@expertmotion/composition-model';
import { easingFn, safeBezier, springDamping } from './easing.js';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export interface MotionFrame {
  opacity: number; tx: number; ty: number; scale: number; scaleX: number; scaleY: number; rotate: number; blur: number;
  /** clip-path inset in % (top, right, bottom, left) for wipe reveals. */
  clip: [number, number, number, number] | null;
  /** 0…1 progress of a draw-on stroke (shapes); undefined when the motion does not draw. */
  draw: number | undefined;
  origin: string;
}
const IDENTITY: MotionFrame = { opacity: 1, tx: 0, ty: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, blur: 0, clip: null, draw: undefined, origin: '50% 50%' };

/** Entrance progress 0…1 at `frame` (spring presets, explicit bezier or the easing preset). */
export function motionProgress(m: Pick<MotionT, 'durationMs' | 'delayMs' | 'easingId' | 'params'>, frame: number, fps: number, defaultEasingId: string): number {
  const enterFrames = Math.max(1, Math.round((m.durationMs / 1000) * fps));
  const delay = Math.round((m.delayMs / 1000) * fps);
  const bz = m.params['bezier'];
  if (Array.isArray(bz) && bz.length === 4) return interpolate(frame, [delay, delay + enterFrames], [0, 1], { ...clamp, easing: safeBezier(bz) });
  const easingId = m.easingId ?? defaultEasingId;
  const damping = springDamping(easingId);
  return damping === null
    ? interpolate(frame, [delay, delay + enterFrames], [0, 1], { ...clamp, easing: easingFn(easingId) })
    : spring({ frame: frame - delay, fps, config: { damping }, durationInFrames: enterFrames });
}

/** The motion of one element at a frame (frame 0 = element start). `seed` decorrelates idle loops of different elements. */
export function motionFrame(m: MotionT | null, frame: number, durationInFrames: number, fps: number, u: number, defaultEasingId: string, seed = 'x'): MotionFrame {
  if (!m) return IDENTITY;
  const enterFrames = Math.max(1, Math.round((m.durationMs / 1000) * fps));
  const delay = Math.round((m.delayMs / 1000) * fps);
  const p = motionProgress(m, frame, fps, defaultEasingId);
  const exitMs = typeof m.params['exitMs'] === 'number' ? m.params['exitMs'] : m.durationMs;
  const exitFrames = Math.max(1, Math.round((exitMs / 1000) * fps));
  const exit = m.exit && exitMs > 0 ? 1 - interpolate(frame, [durationInFrames - exitFrames, durationInFrames], [0, 1], { ...clamp, easing: easingFn('preset:easing.in-quad') }) : 1;
  const fadeExit = m.params['exitStyle'] === 'fade';
  const k = fadeExit ? p : Math.min(p, exit);              // transform progress (a mirror exit runs the entrance backwards)
  const o = (x: number) => Math.min(x, exit);               // opacity always follows the exit
  const dir = String(m.params['direction'] ?? 'from-left');
  const out: MotionFrame = { ...IDENTITY };
  switch (m.presetId) {
    case 'preset:motion.fade-in': out.opacity = o(p); break;
    case 'preset:motion.rise': out.opacity = o(p); out.ty = (1 - k) * Number(m.params['distanceU'] ?? 40) * u; break;
    case 'preset:motion.pop': {
      const s = spring({ frame: frame - delay, fps, config: { damping: Number(m.params['damping'] ?? 12) } });
      out.scale = fadeExit ? s : Math.min(s, exit); out.opacity = Math.min(1, s * 2, exit); break;
    }
    case 'preset:motion.slide-in': {
      const d = (1 - k) * 300 * u; out.opacity = o(p);
      if (dir === 'from-right') out.tx = d; else if (dir === 'from-top') out.ty = -d; else if (dir === 'from-bottom') out.ty = d; else out.tx = -d;
      break;
    }
    case 'preset:motion.zoom-drift': out.scale = interpolate(frame, [0, Math.max(1, durationInFrames)], [1, Number(m.params['toScale'] ?? 1.08)], clamp); break;
    case 'preset:motion.spin-in': out.opacity = o(p); out.rotate = (1 - k) * -20; out.scale = 0.8 + 0.2 * k; break;
    case 'preset:motion.bounce': out.opacity = o(Math.min(1, p * 2)); out.ty = (1 - interpolate(frame, [delay, delay + enterFrames], [0, 1], { ...clamp, easing: easingFn('preset:easing.bounce') })) * -120 * u; break;
    case 'preset:motion.blur-in': out.opacity = o(p); out.blur = (1 - k) * Number(m.params['blurU'] ?? 16) * u; out.scale = 0.96 + 0.04 * k; break;
    case 'preset:motion.scale-in': { const f = Number(m.params['fromScale'] ?? 0.7); out.opacity = o(Math.min(1, p * 2)); out.scale = f + (1 - f) * k; break; }
    case 'preset:motion.draw-on': out.draw = k; out.opacity = o(1); break;
    case 'preset:motion.wipe-reveal': {
      const r = (1 - k) * 100; out.opacity = o(1);
      out.clip = dir === 'from-right' ? [0, 0, 0, r] : dir === 'from-top' ? [0, 0, r, 0] : dir === 'from-bottom' ? [r, 0, 0, 0] : [0, r, 0, 0];
      break;
    }
    case 'preset:motion.grow': {
      const g = String(m.params['direction'] ?? 'up'); out.opacity = o(Math.min(1, p * 6));
      if (g === 'left' || g === 'right') { out.scaleX = k; out.origin = g === 'right' ? '0% 50%' : '100% 50%'; }
      else { out.scaleY = k; out.origin = g === 'up' ? '50% 100%' : '50% 0%'; }
      break;
    }
    default: out.opacity = o(p);                            // typewriter / word-stagger are handled inside the text renderer
  }
  // Idle loops start once the entrance is done and stay subtle (ADR-034): float ±6 u, pulse ±3 %, sway ±2°, spin 45°/s.
  const loop = m.params['loop'];
  if (typeof loop === 'string' && loop !== 'none') {
    const t = Math.max(0, frame - delay - enterFrames) / fps;
    const ramp = Math.min(1, t / 0.6);
    if (loop === 'float') { out.ty += noise2D(`${seed}-y`, t * 0.35, 0) * 6 * u * ramp; out.tx += noise2D(`${seed}-x`, t * 0.3, 1) * 4 * u * ramp; }
    if (loop === 'pulse') out.scale *= 1 + 0.03 * Math.sin(t * Math.PI * 1.25) * ramp;
    if (loop === 'sway') out.rotate += 2 * Math.sin(t * Math.PI * 0.8) * ramp;
    if (loop === 'spin') out.rotate += 45 * t;
  }
  return out;
}

const round = (v: number, d = 2) => { const k = 10 ** d; return Math.round(v * k) / k; };
/** CSS for a motion frame (separate translate / scale / rotate properties; filter and clip-path only when used). */
export function motionCss(f: MotionFrame): React.CSSProperties {
  const css: React.CSSProperties = {};
  if (f.opacity !== 1) css.opacity = f.opacity;
  if (f.tx !== 0 || f.ty !== 0) css.translate = `${round(f.tx)}px ${round(f.ty)}px`;
  const sx = f.scale * f.scaleX, sy = f.scale * f.scaleY;
  if (sx !== 1 || sy !== 1) css.scale = sx === sy ? `${round(sx, 4)}` : `${round(sx, 4)} ${round(sy, 4)}`;
  if (f.rotate !== 0) css.rotate = `${round(f.rotate, 3)}deg`;
  if (f.blur > 0.05) css.filter = `blur(${round(f.blur, 2)}px)`;
  if (f.clip) css.clipPath = `inset(${f.clip.map((v) => `${round(v, 3)}%`).join(' ')})`;
  if (f.origin !== '50% 50%') css.transformOrigin = f.origin;
  return css;
}

/** Backwards-compatible entry point (clips, older callers): the CSS of motionFrame. */
export function motionStyle(m: MotionT | null, frame: number, durationInFrames: number, fps: number, u: number, defaultEasingId: string, seed?: string): React.CSSProperties {
  return motionCss(motionFrame(m, frame, durationInFrames, fps, u, defaultEasingId, seed));
}
