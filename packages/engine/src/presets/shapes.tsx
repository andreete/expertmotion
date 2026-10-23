import React from 'react';
import { Arrow, Callout, Circle, Ellipse, Heart, Pie, Polygon, Rect, Spark, Star, Triangle } from '@remotion/shapes';

type ShapeProps = { size: number; fill: string; stroke?: string | undefined; strokeWidth?: number | undefined; params: Record<string, unknown> };
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
/** preset:shape.* → @remotion/shapes component (DESIGN_CATALOGUE §6). `size` is the bounding box in px. */
export const SHAPES: Record<string, React.FC<ShapeProps>> = {
  'preset:shape.circle': ({ size, fill, stroke, strokeWidth }) => <Circle radius={size / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.rect': ({ size, fill, stroke, strokeWidth, params }) => <Rect width={size} height={size} cornerRadius={num(params['cornerRadius'], 24)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.star': ({ size, fill, stroke, strokeWidth, params }) => <Star points={num(params['points'], 5)} outerRadius={size / 2} innerRadius={(size / 2) * num(params['innerRadius'], 0.44)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.arrow': ({ size, fill, stroke, strokeWidth, params }) => <Arrow length={size} headWidth={size * 0.6} headLength={size * 0.4} shaftWidth={size * 0.25} direction={(params['direction'] as 'right') ?? 'right'} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.triangle': ({ size, fill, stroke, strokeWidth }) => <Triangle length={size} direction="up" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.heart': ({ size, fill, stroke, strokeWidth }) => <Heart height={size} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.pie': ({ size, fill, stroke, strokeWidth, params }) => <Pie radius={size / 2} progress={num(params['progress'], 0.75)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.polygon': ({ size, fill, stroke, strokeWidth, params }) => <Polygon points={num(params['points'], 6)} radius={size / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.callout': ({ size, fill, stroke, strokeWidth }) => <Callout width={size} height={size * 0.6} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.spark': ({ size, fill, stroke, strokeWidth }) => <Spark width={size} height={size} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
  'preset:shape.ellipse': ({ size, fill, stroke, strokeWidth }) => <Ellipse rx={size / 2} ry={size / 3} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />,
};
