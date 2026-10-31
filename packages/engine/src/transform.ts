// ADR-028: the picture transform as CSS, one pure function shared by the Player preview and the render (parity). A clip's
// media fills its frame with objectFit first, then moves (x / y fractions of the frame), rotates and zooms around its centre;
// the clip frame clips it (overflow hidden). Images and shapes keep their centred box and add rotate + scale.
// ADR-039 adds the pure zoom keyframes of a clip (`clipZoomScale`) and the focus transform of a video overlay (`focusTransform`).
import type React from 'react';
import { spring } from 'remotion';
import type { ClipTransformT, ClipZoomT, OverlayElementT, OverlayVideoT } from '@expertmotion/composition-model';

const n = (v: number) => Math.round(v * 1000) / 1000;
/**
 * CSS for a Clip's media inside a frame of width × height px; {} for the identity (no transform stored and no zoom).
 * `zoomScale` (ADR-039, from clipZoomScale) multiplies the stored scale, so a punch-in and a canvas zoom compose.
 */
export function clipTransformStyle(t: ClipTransformT | undefined, width: number, height: number, zoomScale = 1): React.CSSProperties {
  const z = Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1;
  if ((!t || (t.x === 0 && t.y === 0 && t.scale === 1 && t.rotation === 0)) && z === 1) return {};
  const x = t?.x ?? 0, y = t?.y ?? 0, r = t?.rotation ?? 0, s = (t?.scale ?? 1) * z;
  return { transform: `translate(${n(x * width)}px, ${n(y * height)}px) rotate(${n(r)}deg) scale(${n(s)})`, transformOrigin: '50% 50%' };
}
/** CSS transform of an overlay box centred on its position: translate(-50%, -50%) plus the stored rotation and scale. */
export function overlayTransform(o: Pick<OverlayElementT, 'scale' | 'rotation'>): string {
  const r = o.rotation ?? 0, s = o.scale ?? 1;
  return `translate(-50%, -50%)${r ? ` rotate(${n(r)}deg)` : ''}${s !== 1 ? ` scale(${n(s)})` : ''}`;
}

export const DEFAULT_POP_MS = 450;
/**
 * ADR-039 (Reels punch-ins): the zoom factor of a clip at `frame` (0 = clip start) over `totalFrames`: linear from `from` to
 * `to` across the clip, plus every pop (`atMs` clip-relative) as an instant push of `+amount` that settles back to 0 with a
 * critically damped spring over `durationMs` (default 450). Pure (no hooks), so the Player, the render and tests agree; 1 without a zoom.
 */
export function clipZoomScale(zoom: ClipZoomT | undefined, frame: number, totalFrames: number, fps: number): number {
  if (!zoom) return 1;
  const span = Math.max(1, totalFrames - 1);
  const k = Math.min(1, Math.max(0, frame / span));
  let scale = zoom.from + (zoom.to - zoom.from) * k;
  for (const p of zoom.pops ?? []) {
    const start = Math.round((p.atMs / 1000) * fps);
    if (frame < start) continue;
    const dur = Math.max(1, Math.round(((p.durationMs ?? DEFAULT_POP_MS) / 1000) * fps));
    if (frame - start >= dur) continue;                                             // settled: no residue past the pop's length
    const settled = spring({ frame: frame - start, fps, config: { damping: 200 }, durationInFrames: dur, durationRestThreshold: 0.001 });
    scale += p.amount * (1 - settled);
  }
  return Math.round(scale * 10_000) / 10_000;
}

/**
 * ADR-039 (face bubble): the CSS transform of a cover-fitted video inside a `boxW` × `boxH` px box so that the SOURCE point
 * `focus.x / y` (fractions of the source frame) lands at the box centre, zoomed by `focus.zoom` around that point. With the
 * source size known the cover fit is reproduced exactly; without it the box aspect stands in for the source aspect.
 * The order `scale(z) translate(tx, ty)` (CSS applies the right-most first) moves the focus to the centre and zooms there.
 */
export function focusTransform(focus: OverlayVideoT['focus'], boxW: number, boxH: number, srcW?: number, srcH?: number): string {
  if (!focus) return '';
  let px: number, py: number;
  if (srcW && srcH && boxW > 0 && boxH > 0) {
    const s = Math.max(boxW / srcW, boxH / srcH);                   // objectFit: cover
    const w = srcW * s, h = srcH * s;
    px = focus.x * w - (w - boxW) / 2; py = focus.y * h - (h - boxH) / 2;
  } else { px = focus.x * boxW; py = focus.y * boxH; }
  const tx = boxW / 2 - px, ty = boxH / 2 - py;
  const z = focus.zoom;
  if (z === 1 && Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5) return '';
  return `scale(${n(z)}) translate(${n(tx)}px, ${n(ty)}px)`;
}
