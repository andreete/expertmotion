import React from 'react';
import { makeArrow, makeCallout, makeCircle, makeEllipse, makeHeart, makePie, makePolygon, makeRect, makeSpark, makeStar, makeTriangle } from '@remotion/shapes';
import { evolvePath } from '@remotion/paths';

/**
 * Shape props: `w` × `h` is the bounding box in px; `draw` (0…1, ADR-034 preset:motion.draw-on) strokes the outline on with
 * evolvePath and fades the fill in at the end; `u` is the layout unit (px per u) for params given in u (dashU, cornerRadius).
 */
export type ShapeProps = { w: number; h: number; u: number; fill: string; stroke?: string | undefined; strokeWidth?: number | undefined; params: Record<string, unknown>; draw?: number | undefined };
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
type Geo = { path: string; width: number; height: number };

/** One SVG for every shape: the geometry path centred in a w × h box, filled and / or stroked, optionally drawn on. */
const PathShape: React.FC<ShapeProps & { geo: Geo; strokeOnly?: boolean; dash?: number; linecap?: 'round' | 'butt' }> = ({ geo, w, h, fill, stroke, strokeWidth, draw, strokeOnly, dash, linecap }) => {
  const sw = strokeOnly ? Math.max(1, strokeWidth ?? Math.min(w, h) * 0.08) : strokeWidth ?? 0;
  const pad = sw / 2;
  const drawing = draw !== undefined && draw < 1;
  const evo = drawing ? evolvePath(Math.max(0, draw), geo.path) : null;
  const outline = strokeOnly ? fill : stroke ?? fill;
  const drawW = strokeOnly ? sw : Math.max(sw, Math.min(w, h) * 0.03);
  const fillOpacity = strokeOnly ? 0 : drawing ? Math.max(0, (draw - 0.65) / 0.35) : 1;
  const stroked = drawing || strokeOnly || (stroke !== undefined && sw > 0);
  return (
    <svg width={w} height={h} viewBox={`${-pad} ${-pad} ${geo.width + sw} ${geo.height + sw}`} preserveAspectRatio="xMidYMid meet" style={{ overflow: 'visible', display: 'block' }}>
      <path d={geo.path} fill={strokeOnly ? 'none' : fill} fillOpacity={fillOpacity}
        stroke={stroked ? outline : 'none'} strokeWidth={drawing ? drawW : sw} strokeLinecap={linecap ?? 'round'} strokeLinejoin="round"
        {...(evo ? { strokeDasharray: evo.strokeDasharray, strokeDashoffset: evo.strokeDashoffset } : dash ? { strokeDasharray: `${dash} ${dash * 0.7}` } : {})} />
    </svg>
  );
};
const checkPath = (s: number): Geo => ({ path: `M ${0.1 * s} ${0.52 * s} L ${0.38 * s} ${0.8 * s} L ${0.9 * s} ${0.2 * s}`, width: s, height: s });
const chevronPath = (s: number): Geo => ({ path: `M ${0.3 * s} ${0.12 * s} L ${0.72 * s} ${0.5 * s} L ${0.3 * s} ${0.88 * s}`, width: s, height: s });

/** preset:shape.* → geometry from @remotion/shapes make* (DESIGN_CATALOGUE §6), drawn by one SVG path renderer. */
export const SHAPES: Record<string, React.FC<ShapeProps>> = {
  'preset:shape.circle': (p) => <PathShape {...p} geo={makeCircle({ radius: Math.min(p.w, p.h) / 2 })} />,
  'preset:shape.rect': (p) => {
    // ADR-034: a w × h rectangle; outline = border only (in the stroke colour, else the fill colour); dashU = dashed border.
    const outline = p.params['outline'] === true, sw = outline ? (p.strokeWidth ?? 8 * p.u) : (p.strokeWidth ?? 0);
    const iw = Math.max(1, p.w - sw), ih = Math.max(1, p.h - sw);
    const geo = makeRect({ width: iw, height: ih, cornerRadius: Math.min(num(p.params['cornerRadius'], 24) * p.u, ih / 2, iw / 2) });
    const dash = typeof p.params['dashU'] === 'number' && p.params['dashU'] > 0 ? p.params['dashU'] * p.u : undefined;
    return outline
      ? <PathShape {...p} fill={p.stroke ?? p.fill} strokeWidth={sw} geo={geo} strokeOnly linecap="butt" {...(dash ? { dash } : {})} />
      : <PathShape {...p} geo={geo} {...(dash ? { dash } : {})} />;
  },
  'preset:shape.star': (p) => { const r = Math.min(p.w, p.h) / 2; return <PathShape {...p} geo={makeStar({ points: num(p.params['points'], 5), outerRadius: r, innerRadius: r * num(p.params['innerRadius'], 0.44) })} />; },
  'preset:shape.arrow': (p) => { const s = Math.min(p.w, p.h); return <PathShape {...p} geo={makeArrow({ length: s, headWidth: s * 0.6, headLength: s * 0.4, shaftWidth: s * 0.25, direction: (p.params['direction'] as 'right') ?? 'right' })} />; },
  'preset:shape.triangle': (p) => <PathShape {...p} geo={makeTriangle({ length: Math.min(p.w, p.h), direction: 'up' })} />,
  'preset:shape.heart': (p) => <PathShape {...p} geo={makeHeart({ height: Math.min(p.w, p.h) * 0.9 })} />,
  'preset:shape.pie': (p) => <PathShape {...p} geo={makePie({ radius: Math.min(p.w, p.h) / 2, progress: num(p.params['progress'], 0.75) })} />,
  'preset:shape.polygon': (p) => <PathShape {...p} geo={makePolygon({ points: num(p.params['points'], 6), radius: Math.min(p.w, p.h) / 2 })} />,
  'preset:shape.callout': (p) => <PathShape {...p} geo={makeCallout({ width: p.w, height: p.h * 0.6 })} />,
  'preset:shape.spark': (p) => <PathShape {...p} geo={makeSpark({ width: Math.min(p.w, p.h), height: Math.min(p.w, p.h) })} />,
  'preset:shape.ellipse': (p) => <PathShape {...p} geo={makeEllipse({ rx: p.w / 2, ry: (p.w === p.h ? p.h / 1.5 : p.h) / 2 })} />,
  // ADR-034 accents: line (bar / underline, w × h, round ends), ring (outline circle), pill (CTA / badge), check and chevron (strokes)
  'preset:shape.line': (p) => <PathShape {...p} geo={makeRect({ width: p.w, height: p.h, cornerRadius: num(p.params['cornerRadius'], p.h / 2 / p.u) * p.u })} />,
  'preset:shape.ring': (p) => <PathShape {...p} strokeWidth={p.strokeWidth ?? Math.min(p.w, p.h) * 0.06} geo={makeCircle({ radius: Math.min(p.w, p.h) / 2 })} strokeOnly />,
  'preset:shape.pill': (p) => <PathShape {...p} geo={makeRect({ width: p.w, height: p.h, cornerRadius: Math.min(p.w, p.h) / 2 })} />,
  'preset:shape.check': (p) => <PathShape {...p} strokeWidth={p.strokeWidth ?? Math.min(p.w, p.h) * 0.13} geo={checkPath(Math.min(p.w, p.h))} strokeOnly />,
  'preset:shape.chevron': (p) => <PathShape {...p} strokeWidth={p.strokeWidth ?? Math.min(p.w, p.h) * 0.14} geo={chevronPath(Math.min(p.w, p.h))} strokeOnly />,
};
