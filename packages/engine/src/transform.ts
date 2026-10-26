// ADR-028: the picture transform as CSS, one pure function shared by the Player preview and the render (parity). A clip's
// media fills its frame with objectFit first, then moves (x / y fractions of the frame), rotates and zooms around its centre;
// the clip frame clips it (overflow hidden). Images and shapes keep their centred box and add rotate + scale.
import type React from 'react';
import type { ClipTransformT, OverlayElementT } from '@expertmotion/composition-model';

const n = (v: number) => Math.round(v * 1000) / 1000;
/** CSS for a Clip's media inside a frame of width × height px; {} for the identity (no transform stored). */
export function clipTransformStyle(t: ClipTransformT | undefined, width: number, height: number): React.CSSProperties {
  if (!t || (t.x === 0 && t.y === 0 && t.scale === 1 && t.rotation === 0)) return {};
  return { transform: `translate(${n(t.x * width)}px, ${n(t.y * height)}px) rotate(${n(t.rotation)}deg) scale(${n(t.scale)})`, transformOrigin: '50% 50%' };
}
/** CSS transform of an overlay box centred on its position: translate(-50%, -50%) plus the stored rotation and scale. */
export function overlayTransform(o: Pick<OverlayElementT, 'scale' | 'rotation'>): string {
  const r = o.rotation ?? 0, s = o.scale ?? 1;
  return `translate(-50%, -50%)${r ? ` rotate(${n(r)}deg)` : ''}${s !== 1 ? ` scale(${n(s)})` : ''}`;
}
