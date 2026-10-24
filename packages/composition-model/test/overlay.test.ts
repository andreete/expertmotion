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
  it('refuses a non-image asset and a missing overlay', () => {
    expect(applyOperations(createEmptyModel('p'), [{ op: 'op:overlay.addImage', args: { assetId: 'v', atMs: 0 } }], { assets: ASSETS, tier: 'T1', newId }).ok).toBe(false);
    const r = applyOperations(createEmptyModel('p'), [{ op: 'op:overlay.remove', target: { kind: 'image', id: 'nope' }, args: {} }], { assets: ASSETS, tier: 'T1', newId });
    expect(!r.ok && r.issues[0]!.code).toBe('EM-2203');
  });
});
