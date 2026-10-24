import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { resolveDimensions, safeAreaFor, calculateMetadata, missingImplementations, NOT_IMPLEMENTED, EMPTY_INPUT, layoutFor, textLayerFit, type EngineInputProps } from '../src/index.js';
import { applyOperations, createEmptyModel, type Ratio, type Resolution, type TextLayerT } from '@expertmotion/composition-model';

const perf = fs.readFileSync(new URL('../../../docs/PERFORMANCE.md', import.meta.url), 'utf8');
const rows = perf.split('## 3.')[1]!.split('Rules:')[0]!.split('\n').filter((l) => /^\| (16:9|9:16|1:1|4:5|5:4|4:3|3:4) \|/.test(l));
const RES: Resolution[] = ['720p', '1080p', '2k', '2160p'];

describe('resolveDimensions = docs/PERFORMANCE.md §3 table (the owner)', () => {
  it('has all 7 × 4 rows', () => expect(rows.length).toBe(7));
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    const ratio = cells[0] as Ratio;
    RES.forEach((res, i) => it(`${ratio} ${res} = ${cells[i + 1]}`, () => {
      const [w, h] = cells[i + 1]!.split('×').map(Number);
      expect(resolveDimensions(ratio, res)).toEqual({ width: w, height: h });
    }));
  }
  it('custom ratios: even sides, clamped 1:3…3:1, long side ≤ 4096', () => {
    expect(resolveDimensions('custom', '1080p', { w: 21, h: 9 })).toEqual({ width: 2520, height: 1080 });
    const big = resolveDimensions('custom', '2160p', { w: 3, h: 1 });
    expect(big.width).toBeLessThanOrEqual(4096); expect(big.width % 2 + big.height % 2).toBe(0);
    expect(resolveDimensions('custom', '720p', { w: 10, h: 1 })).toEqual({ width: 2160, height: 720 });
  });
  it('safe areas scale with the short side', () => {
    expect(safeAreaFor('9:16', 1080, 1920)).toEqual({ top: 190, right: 120, bottom: 340, left: 72 });
    expect(safeAreaFor('9:16', 720, 1280).top).toBe(127);
    expect(safeAreaFor('1:1', 1080, 1080)).toEqual({ top: 72, right: 72, bottom: 72, left: 72 });
  });
});

describe('calculateMetadata (one code path for Player and renderer)', () => {
  const model = () => {
    const r = applyOperations(createEmptyModel('p', { autoRatio: false, ratio: '16:9', fps: 30 }), [
      { op: 'op:clip.insert', args: { assetId: 'a', durationMs: 3000 } }, { op: 'op:clip.insert', args: { assetId: 'a', durationMs: 3000 } },
      { op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.fade', durationMs: 500 } },
    ], { assets: [{ id: 'a', kind: 'video', status: 'ready', durationMs: 10_000 }], tier: 'T1', newId: (() => { let i = 0; return () => `c${++i}`; })() });
    if (!r.ok) throw new Error('fixture'); return r.value.model;
  };
  it('full quality uses the project resolution; frames = Σ clips − Σ transitions', () => {
    const m = calculateMetadata({ props: { ...EMPTY_INPUT, model: model() } as EngineInputProps });
    expect(m).toMatchObject({ width: 1920, height: 1080, fps: 30, durationInFrames: 90 + 90 - 15 });
  });
  it('draft quality and Trial Mode use the 720p row', () => {
    expect(calculateMetadata({ props: { ...EMPTY_INPUT, model: model(), quality: 'draft' } })).toMatchObject({ width: 1280, height: 720 });
    expect(calculateMetadata({ props: { ...EMPTY_INPUT, model: model(), watermark: true } })).toMatchObject({ width: 1280, height: 720 });
  });
  it('an empty project still has 1 s', () => expect(calculateMetadata({ props: EMPTY_INPUT }).durationInFrames).toBe(30));
});

describe('preset implementation coverage (BLUEPRINT §3.3)', () => {
  it('every catalogue id is implemented except the documented exceptions', () => {
    expect(missingImplementations().sort()).toEqual(Object.keys(NOT_IMPLEMENTED).sort());
  });
  it('all exceptions are P2', async () => {
    const { getPreset } = await import('@expertmotion/catalogue');
    for (const id of Object.keys(NOT_IMPLEMENTED)) expect(getPreset(id)?.priority).toBe('p2');
  });
});

describe('every Design Pick compiles to op args the operation schema accepts', () => {
  it('catalogue defaults pass OPERATIONS[op].args', async () => {
    const { listPresets, compileDefaults } = await import('@expertmotion/catalogue');
    const { OPERATIONS } = await import('@expertmotion/composition-model');
    const bad: string[] = [];
    for (const p of listPresets({})) {
      const c = compileDefaults(p.id);
      if (!c) continue;
      const def = (OPERATIONS as Record<string, { args: { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } } }>)[c.op];
      if (!def) { bad.push(`${p.id}: unknown op ${c.op}`); continue; }
      const fill: Record<string, unknown> = { atMs: 0, text: 'Halo', assetId: 'a1', ...c.args };
      const r = def.args.safeParse(Object.fromEntries(Object.entries(fill).filter(([k]) => k in c.args || c.requires.includes(k))));
      if (!r.success) bad.push(`${p.id}: ${r.error?.message.slice(0, 160)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('textLayerFit (renderer + FR-021 Editor warning share it)', () => {
  const layer = (text: string, fontSize: number): TextLayerT => ({ id: 't1', variantId: 'preset:text.title', text, timing: { atMs: 0, durationMs: 3000 }, position: { x: 0, y: 0 }, style: { fontSize }, effect: null, motion: null });
  const defaults = createEmptyModel('p').theme.textDefaults;
  const vertical = layoutFor('9:16', 1080, 1920);
  it('keeps the asked size when the text fits', () => {
    const f = textLayerFit(layer('Promo kopi', 72), vertical, defaults);
    expect([f.fontSizeU, f.wantU, f.fit.overflow]).toEqual([72, 72, false]);
    expect(f.boxLeft - f.boxW / 2).toBeGreaterThanOrEqual(vertical.safe.left);
  });
  it('shrinks long text to stay in the safe area, and reports overflow when even 34 u does not fit', () => {
    const shrunk = textLayerFit(layer('Diskon besar untuk semua menu kopi susu setiap hari Jumat sore di semua cabang kami', 200), vertical, defaults);
    expect(shrunk.fit.overflow).toBe(false); expect(shrunk.fontSizeU).toBeLessThan(200);
    const over = textLayerFit(layer('kata '.repeat(100).trim(), 72), vertical, defaults);
    expect(over.fit.overflow).toBe(true); expect(over.fontSizeU).toBe(34);
    expect(layoutFor('9:16', 720, 1280).u).toBeCloseTo(720 / 1080);
  });
});
