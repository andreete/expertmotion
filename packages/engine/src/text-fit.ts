// Text Layer box + font fitting, shared by the renderer (presets/text.tsx) and the Editor (FR-021 overflow warning), so the
// warning reports exactly what the render will do. Pure: no React, no Remotion context.
import { getPreset } from '@expertmotion/catalogue';
import type { TextLayerT, ThemeT } from '@expertmotion/composition-model';
import { fitText, type FitResult } from '@expertmotion/shared';
import type { Layout } from './layout.js';

const charWidthFor = (weight: number) => (weight >= 700 ? 0.6 : weight >= 600 ? 0.57 : 0.54);
/** Smallest size (in u) the renderer shrinks a Text Layer to before it reports overflow. */
export const MIN_FIT_U = 34;

export interface TextLayerFit {
  weight: number; wantU: number; boxW: number; boxLeft: number; anchor: { left: number; top: number }; fit: FitResult;
  /** Font size actually used, in u (smaller than `wantU` when the text was shrunk to stay inside the safe area). */
  fontSizeU: number;
}
export function textLayerFit(layer: TextLayerT, layout: Layout, textDefaults: ThemeT['textDefaults']): TextLayerFit {
  const v = (getPreset(layer.variantId)?.data ?? {}) as Record<string, unknown>;
  const weight = layer.style.weight ?? Number(v['weight'] ?? textDefaults.weight);
  const wantU = layer.style.fontSize ?? Number(v['fontSize'] ?? textDefaults.fontSize);
  // The box is centred on its anchor. Keep it inside the safe area wherever the anchor is (lower thirds, corner callouts):
  // its width is limited to twice the room between the anchor and the nearer safe edge; when that room is very small
  // (anchor close to an edge) a minimum width is kept and the box is shifted inward instead.
  const anchor = layout.toPx(layer.position.x, layer.position.y);
  const room = 2 * Math.max(0, Math.min(anchor.left - layout.safe.left, layout.width - layout.safe.right - anchor.left));
  const minW = 0.3 * layout.contentW;
  const boxW = Math.max(minW, Math.min((layer.maxWidth ?? Infinity) * layout.u, layout.contentW, room));
  const boxLeft = Math.min(Math.max(anchor.left, layout.safe.left + boxW / 2), layout.width - layout.safe.right - boxW / 2);
  const fit = fitText(layer.text, { width: boxW, height: layout.contentH * 0.5, maxSize: wantU * layout.u, minSize: Math.min(MIN_FIT_U, wantU) * layout.u, charWidth: charWidthFor(weight), maxLines: 6 });
  return { weight, wantU, boxW, boxLeft, anchor, fit, fontSizeU: Math.round(fit.fontSize / layout.u) };
}
