import { Easing } from 'remotion';
import { getPreset } from '@expertmotion/catalogue';
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
    case 'bezier': { const a = (d['args'] as number[] | undefined) ?? [0.2, 0.8, 0.2, 1]; return Easing.bezier(a[0]!, a[1]!, a[2]!, a[3]!); }   // ADR-034 preset:easing.snappy
    case 'linear': return Easing.linear;
    default: return Easing.out(Easing.cubic);
  }
}
export const springDamping = (id: string | undefined): number | null => {
  const d = id ? getPreset(id)?.data : undefined;
  return d?.['fn'] === 'spring' ? Number(d['damping']) : null;
};
