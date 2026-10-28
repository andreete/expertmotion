// Text Layer box + font fitting, shared by the renderer (presets/text.tsx) and the Editor (FR-021 overflow warning), so the
// warning reports exactly what the render will do. ADR-034: computed in layout units by composition-model textGeometry (the
// same function the scene composer and the quality gate use), then scaled to px. Pure: no React, no Remotion context.
import { MIN_FIT_U, textGeometry, type TextLayerT, type ThemeT } from '@expertmotion/composition-model';
import type { FitResult } from '@expertmotion/shared';
import type { Layout } from './layout.js';

export { MIN_FIT_U };
export interface TextLayerFit {
  weight: number; wantU: number; boxW: number; boxLeft: number; anchor: { left: number; top: number }; fit: FitResult;
  /** Font size actually used, in u (smaller than `wantU` when the text was shrunk to stay inside the safe area). */
  fontSizeU: number; lineHeight: number;
}
export function textLayerFit(layer: TextLayerT, layout: Layout, textDefaults: ThemeT['textDefaults']): TextLayerFit {
  const g = textGeometry(layer, layout.ratio, textDefaults, { w: layout.width, h: layout.height });
  const u = layout.u;
  return { weight: g.weight, wantU: g.wantU, boxW: g.boxW * u, boxLeft: g.boxCx * u, anchor: { left: g.anchor.x * u, top: g.anchor.y * u },
    fit: { ...g.fit, fontSize: g.fit.fontSize * u }, fontSizeU: Math.round(g.fontSizeU), lineHeight: g.lineHeight };
}
