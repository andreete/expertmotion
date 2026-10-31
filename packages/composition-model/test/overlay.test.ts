import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, propertyKeysOf, validate, type AssetFacts } from '../src/index.js';

const ASSETS: AssetFacts[] = [{ id: 'logo', kind: 'image', status: 'ready', width: 512, height: 256 }, { id: 'v', kind: 'video', status: 'ready', durationMs: 4000 }];
let n = 0; const newId = () => `o${++n}`;

describe('op:overlay.addImage / op:overlay.remove (ADR-020 addition)', () => {
  it('adds an image overlay with aspect-correct height, contain, 5 s default, and removes it', () => {
    const r = applyOperations(createEmptyModel('p'), [{ op: 'op:clip.insert', args: { assetId: 'v' } }, { op: 'op:overlay.addImage', args: { assetId: 'logo', atMs: 500, position: 'top-right', size: 200 } }], { assets: ASSETS, tier: 'T1', newId });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const o = r.value.model.tracks.overlay[0]!;
    expect(o).toMatchObject({ kind: 'image', assetId: 'logo', size: { w: 200, h: 100 }, objectFit: 'contain', opacity: 1, timing: { atMs: 500, durationMs: 5000 } });
    expect(validate(r.value.model, { assets: ASSETS, tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
    const rm = applyOperations(r.value.model, [{ op: 'op:overlay.remove', target: { kind: 'image', id: o.id }, args: {} }], { assets: ASSETS, tier: 'T1', newId });
    expect(rm.ok && rm.value.model.tracks.overlay).toEqual([]);
    expect(propertyKeysOf({ op: 'op:overlay.remove', target: { kind: 'image', id: o.id }, args: {} })).toEqual([`image:${o.id}`]);
  });
  it('ADR-041: radius / shadow / border are stored when given (radius clamped to half the shorter side, shadow false and a 0 u border dropped) and copied by duplicate', async () => {
    const { duplicationSteps } = await import('../src/index.js');
    const add = (args: Record<string, unknown>) => applyOperations(createEmptyModel('p'), [{ op: 'op:clip.insert', args: { assetId: 'v' } }, { op: 'op:overlay.addImage', args: { assetId: 'logo', atMs: 0, size: 400, ...args } }], { assets: ASSETS, tier: 'T1', newId });
    const r = add({ radius: 24, shadow: true, border: { colour: '#FFFFFF', widthU: 6 } });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const o = r.value.model.tracks.overlay[0]!;
    expect(o).toMatchObject({ kind: 'image', size: { w: 400, h: 200 }, radius: 24, shadow: true, border: { colour: '#FFFFFF', widthU: 6 } });
    expect(validate(r.value.model, { assets: ASSETS, tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
    const custom = add({ radius: 500, shadow: { blurU: 40, opacity: 0.6 }, border: { colour: '#000000', widthU: 0 } });
    expect(custom.ok && custom.value.model.tracks.overlay[0]).toMatchObject({ radius: 100, shadow: { blurU: 40, opacity: 0.6 } });   // 400 × 200 → radius ≤ 100
    expect(custom.ok && 'border' in custom.value.model.tracks.overlay[0]!).toBe(false);
    const plain = add({ shadow: false });
    expect(plain.ok && Object.keys(plain.value.model.tracks.overlay[0]!)).not.toContain('shadow');
    expect(add({ border: { colour: 'white', widthU: 6 } }).ok).toBe(false);                 // EM-2102: colour must be #RRGGBB
    expect(add({ shadow: { blurU: 40 } }).ok).toBe(false);                                 // strict: opacity required
    // Duplicate carries the look (C1: every field)
    const dup = applyOperations(r.value.model, duplicationSteps(r.value.model, [{ kind: 'image', id: o.id }]).map((s) => s.op), { assets: ASSETS, tier: 'T1', newId });
    expect(dup.ok).toBe(true); if (!dup.ok) return;
    const copy = dup.value.model.tracks.overlay.find((x) => x.id !== o.id)!;
    expect(copy).toMatchObject({ kind: 'image', radius: 24, shadow: true, border: { colour: '#FFFFFF', widthU: 6 } });
    const { summarizeForAgent } = await import('../src/index.js');
    expect(summarizeForAgent(dup.value.model, ASSETS).overlay[0]).toMatchObject({ kind: 'image', radius: 24, shadow: true, border: { colour: '#FFFFFF', widthU: 6 } });
  });
  it('refuses a non-image asset and a missing overlay', () => {
    expect(applyOperations(createEmptyModel('p'), [{ op: 'op:overlay.addImage', args: { assetId: 'v', atMs: 0 } }], { assets: ASSETS, tier: 'T1', newId }).ok).toBe(false);
    const r = applyOperations(createEmptyModel('p'), [{ op: 'op:overlay.remove', target: { kind: 'image', id: 'nope' }, args: {} }], { assets: ASSETS, tier: 'T1', newId });
    expect(!r.ok && r.issues[0]!.code).toBe('EM-2203');
  });
});

describe('FR-028 op:overlay.setOpacity, FR-022 italic, FR-025 variant (ADR-020 additions)', () => {
  const start = () => {
    const r = applyOperations(createEmptyModel('p'), [{ op: 'op:clip.insert', args: { assetId: 'v' } }, { op: 'op:overlay.addImage', args: { assetId: 'logo', atMs: 0 } },
      { op: 'op:shape.add', args: { presetId: 'preset:shape.circle', atMs: 0, durationMs: 1000 } }, { op: 'op:text.add', args: { text: 'Halo', variant: 'preset:text.title', atMs: 0, durationMs: 3000, styleOverrides: { fontSize: 90 } } }], { assets: ASSETS, tier: 'T1', newId });
    if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model;
  };
  it('sets the opacity of an image overlay and a Shape; wrong kind or id → EM-2203', () => {
    const m = start();
    const img = m.tracks.overlay.find((o) => o.kind === 'image')!, shape = m.tracks.overlay.find((o) => o.kind === 'shape')!;
    const r = applyOperations(m, [{ op: 'op:overlay.setOpacity', target: { kind: 'image', id: img.id }, args: { opacity: 0.4 } }, { op: 'op:overlay.setOpacity', target: { kind: 'shape', id: shape.id }, args: { opacity: 0.6 } }], { assets: ASSETS, tier: 'T1', newId });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.model.tracks.overlay.map((o) => o.opacity)).toEqual([0.4, 0.6]);
    expect(propertyKeysOf({ op: 'op:overlay.setOpacity', target: { kind: 'shape', id: shape.id }, args: { opacity: 0.6 } })).toEqual([`shape:${shape.id}.opacity`]);
    const bad = applyOperations(m, [{ op: 'op:overlay.setOpacity', target: { kind: 'shape', id: img.id }, args: { opacity: 0.5 } }], { assets: ASSETS, tier: 'T1', newId });
    expect(!bad.ok && bad.issues[0]!.code).toBe('EM-2203');
    expect(applyOperations(m, [{ op: 'op:overlay.setOpacity', target: { kind: 'image', id: img.id }, args: { opacity: 1.5 } }], { assets: ASSETS, tier: 'T1', newId }).ok).toBe(false);
  });
  it('italic is a text style field with its own key; fontSize range is 16–600', () => {
    const m = start(); const id = m.tracks.text[0]!.id;
    const r = applyOperations(m, [{ op: 'op:text.setStyle', target: { kind: 'text', id }, args: { italic: true, fontSize: 16 } }, { op: 'op:theme.setTextDefaults', target: { kind: 'project' }, args: { italic: true } }], { assets: ASSETS, tier: 'T1', newId });
    expect(r.ok && r.value.model.tracks.text[0]!.style).toMatchObject({ italic: true, fontSize: 16 });
    expect(r.ok && r.value.model.theme.textDefaults.italic).toBe(true);
    expect(propertyKeysOf({ op: 'op:text.setStyle', target: { kind: 'text', id }, args: { italic: true } })).toEqual([`text:${id}.italic`]);
    expect(applyOperations(m, [{ op: 'op:text.setStyle', target: { kind: 'text', id }, args: { fontSize: 601 } }], { assets: ASSETS, tier: 'T1', newId }).ok).toBe(false);   // ADR-034: 16–600 (hero numbers)
  });
  it('variant on a selected layer moves it to the variant position and drops size overrides', () => {
    const m = start(); const id = m.tracks.text[0]!.id;
    const r = applyOperations(m, [{ op: 'op:text.setStyle', target: { kind: 'text', id }, args: { variant: 'preset:text.lower-third' } }], { assets: ASSETS, tier: 'T1', newId });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const t = r.value.model.tracks.text[0]!;
    expect(t.variantId).toBe('preset:text.lower-third');
    expect(t.style.fontSize).toBeUndefined();
    expect(t.position.x).toBeLessThan(0); expect(t.position.y).toBeGreaterThan(0);   // bottom-left
    expect(propertyKeysOf({ op: 'op:text.setStyle', target: { kind: 'text', id }, args: { variant: 'preset:text.lower-third' } })).toEqual([`text:${id}.variant`]);
    expect(applyOperations(m, [{ op: 'op:text.setStyle', target: { kind: 'text', id }, args: { variant: 'preset:shape.circle' } }], { assets: ASSETS, tier: 'T1', newId }).ok).toBe(false);
  });
});
