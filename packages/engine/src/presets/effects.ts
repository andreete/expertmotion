// preset:effect.* → @remotion/effects descriptors (applied via the `effects` prop of <Video>/<Img>). Catalogue params are
// normalised (0–1); the mapping to each effect's own units lives only here. `motion` in/out ramps the effect over 0.5 s.
import type { EffectDescriptor } from 'remotion';
import { interpolate } from 'remotion';
import { blur } from '@remotion/effects/blur';
import { vignette } from '@remotion/effects/vignette';
import { noise } from '@remotion/effects/noise';
import { glow } from '@remotion/effects/glow';
import { colorCorrection } from '@remotion/effects/color-correction';
import { colorKey } from '@remotion/effects/color-key';
import { pixelate } from '@remotion/effects/pixelate';
import { halftone } from '@remotion/effects/halftone';
import { chromaticAberration } from '@remotion/effects/chromatic-aberration';
import { wave } from '@remotion/effects/wave';
import { thermalVision } from '@remotion/effects/thermal-vision';
import { duotone } from '@remotion/effects/duotone';
import { lightLeak } from '@remotion/effects/light-leak';
import { scanlines } from '@remotion/effects/scanlines';
import { pixelDissolve } from '@remotion/effects/pixel-dissolve';
import type { EffectInstanceT } from '@expertmotion/composition-model';

type Make = (p: Record<string, number | string>, k: number, ctx: { frame: number; durationInFrames: number }) => EffectDescriptor<unknown>;
const n = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
export const EFFECTS: Record<string, Make> = {
  'preset:effect.blur': (p, k) => blur({ radius: n(p['radiusPx'], 8) * k }),
  'preset:effect.vignette': (p, k) => vignette({ amount: n(p['intensity'], 0.4) * k }),
  'preset:effect.film-grain': (p, k, c) => noise({ amount: n(p['intensity'], 0.3) * 0.5 * k, seed: c.frame }),   // pinned Remotion has no "film-grain"; animated noise is the equivalent
  'preset:effect.glow': (p, k) => glow({ intensity: n(p['intensity'], 0.5) * 2 * k, radius: 20 }),
  'preset:effect.colour-grade': (p, k) => colorCorrection({ exposure: n(p['brightness'], 0) * 2 * k, contrast: 1 + n(p['contrast'], 0) * k, saturation: 1 + n(p['saturation'], 0) * k }),
  'preset:effect.greenscreen': (p) => colorKey({ keyColor: String(p['colour'] ?? '#00FF00'), similarity: n(p['similarity'], 0.45) }),
  'preset:effect.pixelate': (p, k) => pixelate({ blockSize: Math.max(1, n(p['blockPx'], 16) * k) }),
  'preset:effect.halftone': (p) => halftone({ dotSize: n(p['dotPx'], 8) }),
  'preset:effect.chromatic': (p, k) => chromaticAberration({ amount: n(p['offsetPx'], 4) * k }),
  'preset:effect.wave': (p, k, c) => wave({ amplitude: n(p['amplitude'], 0.2) * 40 * k, wavelength: 1080 / n(p['frequency'], 4), phase: c.frame / 10 }),
  'preset:effect.thermal': (_p, k) => thermalVision({ amount: k }),
  'preset:effect.duotone': (p) => duotone({ darkColor: String(p['colourA'] ?? '#14120F'), lightColor: String(p['colourB'] ?? '#E8913A') }),
  'preset:effect.light-leak': (p, k, c) => lightLeak({ progress: interpolate(c.frame, [0, c.durationInFrames], [0, 1]) * n(p['intensity'], 0.5) * k * 2 }),
  'preset:effect.scanlines': (p, k) => scanlines({ amount: n(p['intensity'], 0.4) * k }),
  'preset:effect.glitch-blocks': (p, k, c) => pixelDissolve({ progress: n(p['intensity'], 0.5) * k * interpolate(c.frame % 30, [0, 29], [0, 1]) }),
};
/** WebGPU effects listed in DESIGN_CATALOGUE (P2) that the pinned Remotion 4.0.535 does not export. */
export const EFFECTS_NOT_IN_PINNED_REMOTION = ['preset:effect.cylinder', 'preset:effect.sphere', 'preset:effect.page-turn'] as const;

export function effectsFor(list: readonly EffectInstanceT[], frame: number, durationInFrames: number, fps: number): EffectDescriptor<unknown>[] {
  const ramp = Math.max(1, Math.round(0.5 * fps));
  return list.flatMap((e) => {
    const make = EFFECTS[e.presetId];
    if (!make) return [];
    const k = e.motion === 'in' ? interpolate(frame, [0, ramp], [0, 1], { extrapolateRight: 'clamp' }) : e.motion === 'out' ? interpolate(frame, [durationInFrames - ramp, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
    return [make(e.params as Record<string, number | string>, k, { frame, durationInFrames })];
  });
}
