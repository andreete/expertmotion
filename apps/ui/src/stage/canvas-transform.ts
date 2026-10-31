// ADR-028 / FR-180 / IX-27: geometry of the Player's canvas handles, pure so it is tested without layout. Everything is in frame
// units (u, frameInUnits: the short side is 1080 u); x / y of a transform are fractions of the frame, so the same numbers drive the
// Player overlay (screen px = u × screen width / frame width), the Inspector fields and op:element.setTransform.
import { deriveTiming, frameInUnits, type CompositionModelT, type ElementRefT } from '@expertmotion/composition-model';
import type { TransformEdit } from '../api/types.js';

export type TransformKind = TransformEdit['kind'];
export interface Xf { x: number; y: number; scale: number; rotation: number }
export const IDENTITY: Xf = Object.freeze({ x: 0, y: 0, scale: 1, rotation: 0 });
export interface Pt { x: number; y: number }
export interface CanvasItem {
  kind: TransformKind; id: string; xf: Xf;
  /** Width / height in u at scale 1 (clip: the objectFit result of the media; image / shape: the stored size). */
  baseW: number; baseH: number;
  frame: { w: number; h: number }; fromMs: number; toMs: number;
  scaleMin: number; scaleMax: number;
}
export const isTransformKind = (k: string): k is TransformKind => k === 'clip' || k === 'image' || k === 'shape';

/** The selected clip / image / shape as a canvas item, or null (other kinds, gone). `dims` gives an Asset's pixel size when known. */
export function canvasItemOf(model: CompositionModelT, ref: ElementRefT | undefined, dims: (assetId: string) => { width: number | null; height: number | null } | null): CanvasItem | null {
  if (!ref?.id || !isTransformKind(ref.kind)) return null;
  const f = frameInUnits(model.settings.ratio, model.settings.customRatio);
  if (ref.kind === 'clip') {
    const c = model.tracks.video.find((x) => x.id === ref.id);
    if (!c) return null;
    const d = c.assetId === undefined ? null : dims(c.assetId), aw = d?.width ?? null, ah = d?.height ?? null;
    let baseW = f.w, baseH = f.h;
    if (aw && ah) { const k = c.objectFit === 'cover' ? Math.max(f.w / aw, f.h / ah) : Math.min(f.w / aw, f.h / ah); baseW = aw * k; baseH = ah * k; }
    const w = deriveTiming(model).elementWindows[c.id]!;
    return { kind: 'clip', id: c.id, xf: { ...(c.transform ?? IDENTITY) }, baseW, baseH, frame: f, fromMs: w.fromMs, toMs: w.toMs, scaleMin: 0.1, scaleMax: 10 };
  }
  const o = model.tracks.overlay.find((x) => x.id === ref.id && x.kind === ref.kind);
  if (!o || o.kind === 'video') return null;                                       // FR-28x OverlayVideo: no Player handles yet
  return { kind: o.kind, id: o.id, xf: { x: o.position.x / f.w, y: o.position.y / f.h, scale: o.scale ?? 1, rotation: o.rotation ?? 0 }, baseW: o.size.w, baseH: o.size.h, frame: f,
    fromMs: o.timing.atMs, toMs: o.timing.atMs + o.timing.durationMs, scaleMin: 0.05, scaleMax: 20 };
}

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Centre (u from the frame's top-left), size and corners (nw, ne, se, sw) of the transformed box. */
export function boxOf(item: Pick<CanvasItem, 'baseW' | 'baseH' | 'frame'>, xf: Xf): { c: Pt; w: number; h: number; corners: [Pt, Pt, Pt, Pt]; half: Pt } {
  const c = { x: item.frame.w / 2 + xf.x * item.frame.w, y: item.frame.h / 2 + xf.y * item.frame.h };
  const w = item.baseW * xf.scale, h = item.baseH * xf.scale;
  const cos = Math.cos(rad(xf.rotation)), sin = Math.sin(rad(xf.rotation));
  const at = (dx: number, dy: number): Pt => ({ x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos });
  const corners: [Pt, Pt, Pt, Pt] = [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)];
  // Half extents of the axis-aligned bounding box (for edge snapping and alignment).
  const half = { x: Math.abs((w / 2) * cos) + Math.abs((h / 2) * sin), y: Math.abs((w / 2) * sin) + Math.abs((h / 2) * cos) };
  return { c, w, h, corners, half };
}

export interface Guide { axis: 'x' | 'y'; at: number }
/**
 * Drag to move: the centre follows the pointer delta (u). Unless `snap` is false (Alt), the centre snaps to the frame centre lines
 * and the bounding box edges to the frame edges within `threshold` u; the guides that snapped are returned for drawing.
 */
export function moveXf(item: CanvasItem, start: Xf, du: Pt, snap: boolean, threshold: number): { xf: Xf; guides: Guide[] } {
  const { w: W, h: H } = item.frame;
  const half = boxOf(item, start).half;
  let cx = W / 2 + start.x * W + du.x, cy = H / 2 + start.y * H + du.y;
  const guides: Guide[] = [];
  if (snap) {
    const pick = (v: number, cands: Array<{ to: number; line: number }>): { v: number; line: number } | null => {
      let best: { v: number; line: number; d: number } | null = null;
      for (const k of cands) { const d = Math.abs(v - k.to); if (d <= threshold && (!best || d < best.d)) best = { v: k.to, line: k.line, d }; }
      return best;
    };
    const sx = pick(cx, [{ to: W / 2, line: W / 2 }, { to: half.x, line: 0 }, { to: W - half.x, line: W }]);
    const sy = pick(cy, [{ to: H / 2, line: H / 2 }, { to: half.y, line: 0 }, { to: H - half.y, line: H }]);
    if (sx) { cx = sx.v; guides.push({ axis: 'x', at: sx.line }); }
    if (sy) { cy = sy.v; guides.push({ axis: 'y', at: sy.line }); }
  }
  return { xf: { ...start, x: (cx - W / 2) / W, y: (cy - H / 2) / H }, guides };
}

export type Corner = 'nw' | 'ne' | 'se' | 'sw';
const CORNER_INDEX: Record<Corner, number> = { nw: 0, ne: 1, se: 2, sw: 3 };
/**
 * Corner drag to scale. Without `keepCentre` the opposite corner stays where it is; with it (Shift) the centre stays. The factor is
 * the pointer's projection on the anchor → grabbed-corner diagonal, so it works at any rotation. Scale is clamped to the item's range.
 */
export function scaleXf(item: CanvasItem, start: Xf, corner: Corner, pointer: Pt, keepCentre: boolean): Xf {
  const b = boxOf(item, start);
  const grabbed = b.corners[CORNER_INDEX[corner]]!;
  const anchor = keepCentre ? b.c : b.corners[(CORNER_INDEX[corner] + 2) % 4]!;
  const d0 = { x: grabbed.x - anchor.x, y: grabbed.y - anchor.y };
  const len2 = d0.x * d0.x + d0.y * d0.y;
  if (len2 < 1e-9) return start;
  const k = ((pointer.x - anchor.x) * d0.x + (pointer.y - anchor.y) * d0.y) / len2;
  const scale = Math.max(item.scaleMin, Math.min(item.scaleMax, start.scale * k));
  const kk = scale / start.scale;
  const { w: W, h: H } = item.frame;
  const c = keepCentre ? b.c : { x: anchor.x + (b.c.x - anchor.x) * kk, y: anchor.y + (b.c.y - anchor.y) * kk };
  return { ...start, scale, x: (c.x - W / 2) / W, y: (c.y - H / 2) / H };
}

/** Normalised to [0, 360). */
export const norm360 = (r: number): number => { const x = ((r % 360) + 360) % 360; return x >= 359.995 ? 0 : x; };
/** Rotation handle: the angle the pointer turned around the centre since `from`; Shift snaps to 0 / 90 / 180 / 270. */
export function rotateXf(item: CanvasItem, start: Xf, from: Pt, pointer: Pt, snap90: boolean): Xf {
  const c = boxOf(item, start).c;
  const a = (p: Pt) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
  let r = norm360(start.rotation + a(pointer) - a(from));
  if (snap90) r = norm360(Math.round(r / 90) * 90);
  return { ...start, rotation: Math.round(r * 100) / 100 };
}

/** Inspector buttons: Fit (the whole picture inside the frame), Fill (no empty frame), both centred; rotation kept. */
export function fitXf(item: CanvasItem, mode: 'fit' | 'fill', start: Xf): Xf {
  const quarter = Math.round(norm360(start.rotation) / 90) % 2 === 1;      // a 90° / 270° turn swaps width and height
  const w = quarter ? item.baseH : item.baseW, h = quarter ? item.baseW : item.baseH;
  const k = mode === 'fit' ? Math.min(item.frame.w / w, item.frame.h / h) : Math.max(item.frame.w / w, item.frame.h / h);
  return { ...start, x: 0, y: 0, scale: Math.max(item.scaleMin, Math.min(item.scaleMax, k)) };
}
export type Align = 'center' | 'top' | 'bottom' | 'left' | 'right';
/** Quick align: centre both axes, or move the bounding box against one frame edge (the other axis is kept). */
export function alignXf(item: CanvasItem, a: Align, start: Xf): Xf {
  const { half } = boxOf(item, start); const { w: W, h: H } = item.frame;
  switch (a) {
    case 'center': return { ...start, x: 0, y: 0 };
    case 'left': return { ...start, x: (half.x - W / 2) / W };
    case 'right': return { ...start, x: (W / 2 - half.x) / W };
    case 'top': return { ...start, y: (half.y - H / 2) / H };
    case 'bottom': return { ...start, y: (H / 2 - half.y) / H };
  }
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
/** The pick a gesture or field compiles to: all four values (newest full state wins on supersession), rounded, within the op's ranges. */
export function transformEditOf(item: Pick<CanvasItem, 'kind' | 'id' | 'scaleMin' | 'scaleMax'>, xf: Xf): TransformEdit {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return { kind: item.kind, id: item.id, x: r4(clamp(xf.x, -2, 2)) + 0, y: r4(clamp(xf.y, -2, 2)) + 0, scale: r4(clamp(xf.scale, item.scaleMin, item.scaleMax)), rotation: Math.round(norm360(xf.rotation) * 100) / 100 };
}
export const sameXf = (a: Xf, b: Xf): boolean => Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.scale - b.scale) < 1e-4 && Math.abs(norm360(a.rotation) - norm360(b.rotation)) < 0.01;

/** The model the Player shows while a gesture is live (optimistic, never sent): the item with `xf` applied, without validation. */
export function withLiveTransform(model: CompositionModelT, item: Pick<CanvasItem, 'kind' | 'id' | 'frame'>, xf: Xf): CompositionModelT {
  const tracks = { ...model.tracks };
  if (item.kind === 'clip') tracks.video = model.tracks.video.map((c) => (c.id === item.id ? { ...c, transform: { x: xf.x, y: xf.y, scale: xf.scale, rotation: xf.rotation } } : c));
  else tracks.overlay = model.tracks.overlay.map((o) => (o.id === item.id && o.kind === item.kind ? { ...o, position: { x: xf.x * item.frame.w, y: xf.y * item.frame.h }, scale: xf.scale, rotation: xf.rotation } : o));
  return { ...model, tracks };
}
