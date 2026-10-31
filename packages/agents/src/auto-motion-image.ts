// ADR-041 (viral explainer Reels from internet assets): pure geometry of picture scenes and cutaways, shared by the scene
// composer (auto-motion.ts, role `image`) and the talking-head composer (auto-motion-reels.ts, cutaway blocks `image` / `video`).
//   pictureBoxes    — where 1–4 Library pictures sit for a layout (single 86 % wide in the upper 60 %; stack cascaded and tilted
//                     −6° / +5° / −3° / +4°; phone 46 % of the frame width, tall; side-by-side two 45 % columns), all inside the area;
//   annotationMark  — an arrow pointing at (x, y) from the nearest free side, a highlight box, a ring, an X mark or a label pill,
//                     in fractions of the PICTURE box, clamped inside it (the quality gate of the contract: marks never leave the picture);
//   chipBox         — a pill in a picture corner (BEFORE green / AFTER red / warning amber).
// No LLM, no randomness: the same spec gives the same boxes.
import type { BoxU } from '@expertmotion/composition-model';
import type { SpecAnnotationT } from './auto-motion-spec.js';

/** The default annotation colour of the references (red arrows, red X, red boxes). */
export const ANNOTATION_RED = '#E53935';
/** Chip pill colours by tone (text is white on all of them except accent, which takes the near-black text). */
export const CHIP_COLOURS: Readonly<Record<string, string>> = Object.freeze({ before: '#2E7D32', after: '#C62828', warning: '#F59E0B', neutral: '#374151', accent: '#FFD400' });
/** Corner radius of a picture (u); a phone screenshot is rounder. */
export const PICTURE_RADIUS_U = 24, PHONE_RADIUS_U = 40;
/** Tilt of the k-th picture of a stack (degrees), alternating sides. */
export const STACK_ROTATIONS: readonly number[] = Object.freeze([-6, 5, -3, 4]);
export type ImageLayout = 'single' | 'stack' | 'phone' | 'side-by-side';

export interface PictureBox { box: BoxU; rotation: number }
const clampBox = (b: BoxU, area: BoxU): BoxU => {
  const w = Math.min(b.x1 - b.x0, area.x1 - area.x0), h = Math.min(b.y1 - b.y0, area.y1 - area.y0);
  const x0 = Math.min(Math.max(b.x0, area.x0), area.x1 - w), y0 = Math.min(Math.max(b.y0, area.y0), area.y1 - h);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
};
/** A box of width w with aspect `aspect` (w / h), shrunk when taller than maxH, centred at cx with its top at `top`. */
const fitBox = (w: number, aspect: number, maxH: number, cx: number, top: number): BoxU => {
  let bw = w, bh = w / aspect;
  if (bh > maxH) { bh = maxH; bw = bh * aspect; }
  return { x0: cx - bw / 2, y0: top, x1: cx + bw / 2, y1: top + bh };
};

/**
 * Picture boxes (u) for `layout` inside `area` (the content area above the caption band). `aspects` = width / height of each
 * picture (1 when unknown). The default layout follows the count: 1 picture = single, 2–4 = stack.
 */
export function pictureBoxes(layout: ImageLayout | undefined, aspects: readonly number[], area: BoxU, frameW: number): PictureBox[] {
  const n = Math.max(1, Math.min(4, aspects.length));
  const lay: ImageLayout = layout ?? (n === 1 ? 'single' : 'stack');
  const aw = area.x1 - area.x0, ah = area.y1 - area.y0, cx = (area.x0 + area.x1) / 2;
  const asp = (k: number) => Math.max(0.3, Math.min(3.5, aspects[k] ?? 1));
  const upper = ah * 0.6;                                                              // the pictures live in the upper 60 % of the area …
  if (lay === 'single' || (lay === 'side-by-side' && n === 1)) {
    // … a single picture keeps its 86 % width as long as it is not taller than 72 % of the area (a portrait picture then starts at the top)
    const b = fitBox(aw * 0.86, asp(0), ah * 0.72, cx, area.y0);
    const top = area.y0 + Math.max(0, (upper - (b.y1 - b.y0)) / 2);
    return [{ box: clampBox({ ...b, y0: top, y1: top + (b.y1 - b.y0) }, area), rotation: 0 }];
  }
  if (lay === 'phone') {
    // a tall screenshot: 46 % of the frame width, as tall as its aspect says, never taller than the area
    const b = fitBox(frameW * 0.46, Math.min(asp(0), 0.75), ah * 0.96, cx, area.y0 + ah * 0.02);
    return [{ box: clampBox(b, area), rotation: 0 }];
  }
  if (lay === 'side-by-side') {
    const colW = aw * 0.45, gap = aw * 0.1;
    const boxes = [0, 1].map((k) => fitBox(colW, asp(k), upper, area.x0 + colW / 2 + k * (colW + gap), area.y0));
    const h = Math.max(...boxes.map((b) => b.y1 - b.y0));
    const top = area.y0 + Math.max(0, (upper - h) / 2);
    return boxes.map((b) => ({ box: clampBox({ ...b, y0: top + (h - (b.y1 - b.y0)) / 2, y1: top + (h + (b.y1 - b.y0)) / 2 }, area), rotation: 0 }));
  }
  // stack: cascaded from the top-left, each picture 72 % wide, tilted alternately, later pictures in front
  const w = aw * 0.72, stepX = aw * 0.1, stepY = ah * 0.14;
  const out: PictureBox[] = [];
  for (let k = 0; k < n; k++) {
    const b = fitBox(w, asp(k), ah * 0.5, cx + (k - (n - 1) / 2) * stepX, area.y0 + ah * 0.04 + k * stepY);
    out.push({ box: clampBox(b, area), rotation: STACK_ROTATIONS[k % STACK_ROTATIONS.length]! });
  }
  return out;
}
/** The box all pictures of a scene fit in (annotations and chips of a stack are placed relative to it). */
export function unionBox(boxes: readonly BoxU[]): BoxU {
  return boxes.reduce((u, b) => ({ x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
}

export interface Mark {
  kind: 'arrow' | 'box' | 'circle' | 'x' | 'label';
  /** Centre and size (u) of the shape / label pill, already inside the picture box. */
  cx: number; cy: number; w: number; h: number;
  presetId: string; params: Record<string, unknown>; rotation: number; colour: string;
  /** The preferred entrance: a drawn stroke for arrows / boxes / rings, a pop for the X and the label. */
  motion: 'draw-on' | 'pop';
  /** true when the requested position had to be pulled inside the picture (reported as an info risk). */
  clamped: boolean;
}
/** Keeps a w × h box centred at (cx, cy) inside `pic` (moving it, never shrinking below `pic`). */
function insidePic(cx: number, cy: number, w: number, h: number, pic: BoxU): { cx: number; cy: number; clamped: boolean } {
  const pw = pic.x1 - pic.x0, ph = pic.y1 - pic.y0;
  const ww = Math.min(w, pw), hh = Math.min(h, ph);
  const x = Math.min(Math.max(cx, pic.x0 + ww / 2), pic.x1 - ww / 2), y = Math.min(Math.max(cy, pic.y0 + hh / 2), pic.y1 - hh / 2);
  return { cx: x, cy: y, clamped: Math.abs(x - cx) > 0.5 || Math.abs(y - cy) > 0.5 };
}
/**
 * The mark of one annotation over the picture box `pic`. An arrow sits between its target (x, y) and the nearest picture side and
 * points at the target (direction by that side; a diagonal tilt of ±35° when the target is near a corner); a box / ring / X is
 * centred on (x, y) with w / h (defaults 0.3 × 0.2, ring 0.25, X 0.5 of the picture); a label is a pill whose size the caller
 * measured (`labelSize`).
 */
export function annotationMark(a: SpecAnnotationT, pic: BoxU, colour = ANNOTATION_RED, labelSize?: { w: number; h: number }): Mark {
  const pw = pic.x1 - pic.x0, ph = pic.y1 - pic.y0;
  const tx = pic.x0 + a.x * pw, ty = pic.y0 + a.y * ph;
  const c = a.color ?? colour;
  switch (a.kind) {
    case 'arrow': {
      const s = Math.max(90, Math.min(220, pw * 0.22));
      // the nearest FREE side: a side with room for the whole arrow between the target and the picture edge (else the roomiest);
      // the arrow sits on that side of the target, its head 0.25 s short of the point, so it never covers what it points at
      const room = { left: tx - pic.x0, right: pic.x1 - tx, top: ty - pic.y0, bottom: pic.y1 - ty } as const;
      type Side = keyof typeof room;
      const sides = Object.keys(room) as Side[];
      const free = sides.filter((k) => room[k] >= s * 0.95);
      const side: Side = (free.length ? free.sort((a, b) => room[a] - room[b]) : sides.sort((a, b) => room[b] - room[a]))[0]!;
      const direction = side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'down' : 'up';
      let cx = tx, cy = ty, rotation = 0;
      if (side === 'left' || side === 'right') cx = tx + (side === 'left' ? -1 : 1) * s * 0.75; else cy = ty + (side === 'top' ? -1 : 1) * s * 0.75;
      // a target near a corner: the arrow comes in diagonally from that corner (tilted 35°, its tail shifted toward the corner)
      const perp = side === 'left' || side === 'right' ? (room.top < room.bottom ? 'top' : 'bottom') : (room.left < room.right ? 'left' : 'right');
      if (room[perp] < Math.min(pw, ph) * 0.35) {
        const away = perp === 'top' || perp === 'left' ? 1 : -1;                        // the tail moves away from the near edge
        if (side === 'left' || side === 'right') { cy = ty + away * s * 0.4; rotation = (side === 'left' ? -1 : 1) * away * 35; }
        else { cx = tx + away * s * 0.4; rotation = (side === 'top' ? 1 : -1) * away * 35; }
      }
      const p = insidePic(cx, cy, s, s * 0.75, pic);
      return { kind: 'arrow', cx: p.cx, cy: p.cy, w: s, h: s * 0.75, presetId: 'preset:shape.arrow', params: { direction }, rotation, colour: c, motion: 'draw-on', clamped: p.clamped };
    }
    case 'box': {
      const w = Math.max(40, (a.w ?? 0.3) * pw), h = Math.max(40, (a.h ?? 0.2) * ph);
      const p = insidePic(tx, ty, w, h, pic);
      return { kind: 'box', cx: p.cx, cy: p.cy, w: Math.min(w, pw), h: Math.min(h, ph), presetId: 'preset:shape.highlight-box', params: { strokeU: 8, radiusU: 12, pulse: true }, rotation: 0, colour: c, motion: 'draw-on', clamped: p.clamped };
    }
    case 'circle': {
      const d = Math.max(60, Math.min(Math.min(pw, ph), Math.max((a.w ?? 0.25) * pw, (a.h ?? 0) * ph)));
      const p = insidePic(tx, ty, d, d, pic);
      return { kind: 'circle', cx: p.cx, cy: p.cy, w: d, h: d, presetId: 'preset:shape.ring', params: {}, rotation: 0, colour: c, motion: 'draw-on', clamped: p.clamped };
    }
    case 'x': {
      const d = Math.max(80, Math.min(Math.min(pw, ph) * 0.9, (a.w ?? 0.5) * pw));
      const p = insidePic(tx, ty, d, d, pic);
      return { kind: 'x', cx: p.cx, cy: p.cy, w: d, h: d, presetId: 'preset:shape.x-mark', params: { strokeU: 18 }, rotation: 0, colour: c, motion: 'pop', clamped: p.clamped };
    }
    case 'label': default: {
      const w = Math.min(pw, labelSize?.w ?? pw * 0.4), h = Math.min(ph, labelSize?.h ?? 64);
      const p = insidePic(tx, ty, w, h, pic);
      return { kind: 'label', cx: p.cx, cy: p.cy, w, h, presetId: 'preset:shape.rect', params: { cornerRadius: 999 }, rotation: 0, colour: c, motion: 'pop', clamped: p.clamped };
    }
  }
}

/** The top-left of a w × h chip pill in a picture corner, `pad` u inside it. */
export function chipBox(position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | undefined, pic: BoxU, w: number, h: number, pad = 20): BoxU {
  const pos = position ?? 'top-left';
  const x0 = pos.endsWith('left') ? pic.x0 + pad : pic.x1 - pad - w;
  const y0 = pos.startsWith('top') ? pic.y0 + pad : pic.y1 - pad - h;
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}
/** Pill colour and text colour of a chip tone (default neutral); a BEFORE / AFTER text without a tone gets green / red. */
export function chipColours(tone: string | undefined, text: string): { fill: string; text: string } {
  const t = tone ?? (/^\s*(before|sebelum|dulu)\b/i.test(text) ? 'before' : /^\s*(after|sesudah|sekarang|kini)\b/i.test(text) ? 'after' : 'neutral');
  const fill = CHIP_COLOURS[t] ?? CHIP_COLOURS['neutral']!;
  return { fill, text: t === 'accent' ? '#111111' : '#FFFFFF' };
}
/** Width / height of a Library picture (aspect 1 when the asset facts have no size). */
export function aspectOf(a: { width?: number; height?: number } | undefined): number { return a?.width && a.height ? a.width / a.height : 1; }
