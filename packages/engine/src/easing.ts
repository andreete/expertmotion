import { Easing } from 'remotion';
import { getPreset } from '@expertmotion/catalogue';
const DEFAULT_BEZIER = [0.2, 0.8, 0.2, 1] as const;
/**
 * C4 (review 2026-10-29): a cubic-bezier easing that never throws. Remotion's Easing.bezier throws for x outside 0..1 on every
 * frame (preview and render), so x1 / x2 are clamped into 0..1 and y1 / y2 into -2..3; a non-number falls back to the default.
 * The catalogue rejects such values for new ops; this keeps a project stored before that check playable.
 */
export function safeBezier(v: unknown): (t: number) => number {
  const a = Array.isArray(v) && v.length === 4 ? v.map(Number) : [...DEFAULT_BEZIER];
  const ok = a.every((n) => Number.isFinite(n));
  const [x1, y1, x2, y2] = ok ? a : [...DEFAULT_BEZIER];
  const cx = (n: number) => Math.max(0, Math.min(1, n)), cy = (n: number) => Math.max(-2, Math.min(3, n));
  return Easing.bezier(cx(x1!), cy(y1!), cx(x2!), cy(y2!));
}
/** preset:easing.* → easing function (DESIGN_CATALOGUE §7). Spring easings are handled by callers (they need fps). */
export function easingFn(id: string | undefined): (t: number) => number {
  const d = id ? getPreset(id)?.data : undefined;
  if (!d) return Easing.out(Easing.cubic);
  const base = (name: unknown, arg?: unknown): ((t: number) => number) => {
    switch (name) { case 'quad': return Easing.quad; case 'cubic': return Easing.cubic; case 'back': return Easing.back(Number(arg ?? 1.7)); default: return Easing.linear; }
  };
  switch (d['fn']) {
    case 'out': return Easing.out(base(d['base'], d['arg']));
    case 'in': return Easing.in(base(d['base'], d['arg']));
    case 'inOut': return Easing.inOut(base(d['base'], d['arg']));
    case 'bounce': return Easing.bounce;
    case 'bezier': return safeBezier(d['args'] ?? DEFAULT_BEZIER);   // ADR-034 preset:easing.snappy
    case 'linear': return Easing.linear;
    default: return Easing.out(Easing.cubic);
  }
}
export const springDamping = (id: string | undefined): number | null => {
  const d = id ? getPreset(id)?.data : undefined;
  return d?.['fn'] === 'spring' ? Number(d['damping']) : null;
};
