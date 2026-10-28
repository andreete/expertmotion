// ADR-034: counters keep the text's own sign, Indonesian separators and decimals at every frame (ported AnimatedNumber logic).
import { describe, expect, it } from 'vitest';
import { formatId, formatValue, parseNumberIn, withNumber } from '../src/format-number.js';
import { motionFrame } from '../src/motion.js';

describe('format-number', () => {
  it('formats the Indonesian way (ported)', () => {
    expect(formatId(1234567.891, 2)).toBe('1.234.567,89');
    expect(formatValue(1.2e12, 1.2e12, { decimals: 1, compact: true })).toBe('1,2 triliun');
    expect(formatValue(17.2, 17.2, { decimals: 1, unit: '%' })).toBe('17,2%');
  });
  it('reads the number inside a text', () => {
    expect(parseNumberIn('+17,2%')).toMatchObject({ value: 17.2, decimals: 1, sign: '+', dec: ',', before: '', after: '%' });
    expect(parseNumberIn('US$ 25,96 miliar')).toMatchObject({ value: 25.96, decimals: 2, before: 'US$ ', after: ' miliar' });
    expect(parseNumberIn('1.200 MW')).toMatchObject({ value: 1200, decimals: 0, group: '.' });
    expect(parseNumberIn('−3,8%')).toMatchObject({ value: -3.8, sign: '−' });
    expect(parseNumberIn('Rp472 triliun')).toMatchObject({ value: 472, before: 'Rp' });
    expect(parseNumberIn('tanpa angka')).toBeNull();
  });
  it('writes intermediate values like the final text', () => {
    expect(withNumber(parseNumberIn('+17,2%')!, 8.94)).toBe('+8,9%');
    expect(withNumber(parseNumberIn('+17,2%')!, 0)).toBe('+0,0%');
    expect(withNumber(parseNumberIn('US$ 25,96')!, 20.04)).toBe('US$ 20,04');
    expect(withNumber(parseNumberIn('1.200 MW')!, 600)).toBe('600 MW');
    expect(withNumber(parseNumberIn('25.960.000')!, 12_980_000)).toBe('12.980.000');
  });
});

describe('ADR-034 motions', () => {
  const m = (presetId: string, params: Record<string, unknown> = {}) => ({ presetId, durationMs: 1000, delayMs: 0, exit: true, params });
  it('grow scales one axis from the base; wipe-reveal clips; draw-on reports draw progress; exitStyle fade keeps the transform', () => {
    const g = motionFrame(m('preset:motion.grow', { direction: 'up' }), 15, 300, 30, 1, 'preset:easing.out-cubic');
    expect(g.scaleY).toBeGreaterThan(0); expect(g.scaleY).toBeLessThan(1); expect(g.origin).toBe('50% 100%');
    expect(motionFrame(m('preset:motion.wipe-reveal'), 0, 300, 30, 1, 'preset:easing.linear').clip).toEqual([0, 100, 0, 0]);
    expect(motionFrame(m('preset:motion.draw-on'), 30, 300, 30, 1, 'preset:easing.linear').draw).toBe(1);
    const r = motionFrame(m('preset:motion.rise', { distanceU: 56, exitStyle: 'fade', exitMs: 467 }), 295, 300, 30, 1, 'preset:easing.out-cubic');
    expect(r.ty).toBe(0); expect(r.opacity).toBeLessThan(1);
  });
  it('bezier easing and loops are deterministic', () => {
    const a = motionFrame(m('preset:motion.pop', { loop: 'float' }), 120, 300, 30, 1, 'preset:easing.out-cubic', 'el1');
    const b = motionFrame(m('preset:motion.pop', { loop: 'float' }), 120, 300, 30, 1, 'preset:easing.out-cubic', 'el1');
    expect(a).toEqual(b); expect(a.ty).not.toBe(0);
    const bz = motionFrame(m('preset:motion.fade-in', { bezier: [0.2, 0.8, 0.2, 1] }), 10, 300, 30, 1, 'preset:easing.linear');
    expect(bz.opacity).toBeGreaterThan(0.75);
  });
});
