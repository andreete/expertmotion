// ADR-031 / FR-192 / FR-193: Delete and Duplicate picks (`itemsEdit`) through createIntents + compileIntents: one child intent per
// resolved item, unique list keys (never superseding, never Locked Keys), all ops in one compile (one Composition Version).
import { describe, expect, it } from 'vitest';
import { applyOperations, copySnapshot, createEmptyModel, hashModel, type AssetFacts, type CompositionModelT } from '@expertmotion/composition-model';
import { compileIntents, createIntents, enqueue, lockedKeysFromQueue, pickFromIntent, type DesignPick } from '../src/index.js';

const ASSETS: AssetFacts[] = [{ id: 'a1', kind: 'video', status: 'ready', durationMs: 5000 }];
let n = 0; const newId = () => `i${++n}`;
function scenes(): CompositionModelT {
  const r = applyOperations(createEmptyModel('p1', { autoRatio: false }), [
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'Satu' } },
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'Dua' } },
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'Tiga' } }], { assets: ASSETS, tier: 'T1', newId });
  if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model;
}
const run = (m: CompositionModelT, itemsEdit: DesignPick['itemsEdit']) => {
  const r = createIntents({ projectId: 'p1', source: 'ui', ...(itemsEdit ? { itemsEdit } : {}) }, { model: m, baseVersion: hashModel(m), newId });
  if (!r.ok) return { issues: r.issues, intents: [], ops: [] };
  const c = compileIntents(r.value, (i) => pickFromIntent(i), m);
  if (!c.ok) throw new Error(JSON.stringify(c.issues));
  return { issues: [], intents: r.value, ops: c.value };
};

describe('itemsEdit picks (ADR-031)', () => {
  it('Delete of a scene clip and a text: parent + one child per op, unique list keys, compiled in a safe order', () => {
    const m = scenes();
    const [s1, s2] = m.tracks.video;
    const r = run(m, { action: 'remove', items: [{ kind: 'clip', id: s2!.id }, { kind: 'text', id: m.tracks.text[0]!.id }] });
    expect(r.issues).toEqual([]);
    expect(r.intents[0]).toMatchObject({ propertyKey: 'group:asset:', category: 'asset', propertyClass: 'list', needsInterpretation: false });
    const kids = r.intents.slice(1);
    expect(kids).toHaveLength(3);                                                   // text "Satu", scene 2's own text "Dua", clip 2
    expect(new Set(kids.map((k) => k.propertyKey)).size).toBe(3);
    expect(kids.every((k) => k.propertyKey.startsWith('list:remove:'))).toBe(true);
    expect(r.ops.map((o) => o.op)).toEqual(['op:text.remove', 'op:text.remove', 'op:clip.remove']);
    const applied = applyOperations(m, r.ops, { assets: ASSETS, tier: 'T1', newId });
    expect(applied.ok).toBe(true);
    if (applied.ok) { expect(applied.value.model.tracks.text.map((x) => [x.text, x.timing.atMs])).toEqual([['Tiga', 3000]]); expect(applied.value.model.tracks.video.map((c) => c.id)).toEqual([s1!.id, m.tracks.video[2]!.id]); }
    // events: two deletes never supersede each other and never become Locked Keys
    const q = enqueue(enqueue([], r.intents.map((i) => ({ ...i, status: 'executed' as const }))), run(m, { action: 'remove', items: [{ kind: 'clip', id: s2!.id }] }).intents);
    expect(q.filter((i) => i.status === 'superseded')).toEqual([]);
    expect(lockedKeysFromQueue(q)).toEqual([]);
  });
  it('Duplicate: text category, one op:text.add after the original; pickFromIntent restores the pick', () => {
    const m = scenes();
    const t = m.tracks.text[2]!;
    const r = run(m, { action: 'duplicate', items: [{ kind: 'text', id: t.id }] });
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]).toMatchObject({ category: 'text', propertyClass: 'list' });
    expect(pickFromIntent(r.intents[0]!).itemsEdit).toEqual({ action: 'duplicate', items: [{ kind: 'text', id: t.id }] });
    expect(r.ops).toMatchObject([{ op: 'op:text.add', args: { text: 'Tiga', atMs: t.timing.atMs + t.timing.durationMs, durationMs: t.timing.durationMs } }]);
  });
  it('nothing selected → EM-2201; only gone items → EM-2203; nothing duplicable → EM-2201', () => {
    const m = scenes();
    expect(run(m, { action: 'remove', items: [] }).issues[0]).toMatchObject({ code: 'EM-2201' });
    expect(run(m, { action: 'remove', items: [{ kind: 'text', id: 'gone' }] }).issues[0]).toMatchObject({ code: 'EM-2203' });
    expect(run(m, { action: 'duplicate', items: [{ kind: 'background' }] }).issues[0]).toMatchObject({ code: 'EM-2201' });
  });
});

describe('itemsEdit paste (FR-256)', () => {
  it('Paste after Cut: one child per clipboard entry with synthetic project targets, unique list keys, one compile at the playhead', () => {
    const m = scenes();
    const s2 = m.tracks.video[1]!;
    const { entries } = copySnapshot(m, [{ kind: 'clip', id: s2.id }]);
    const cut = applyOperations(m, run(m, { action: 'remove', items: [{ kind: 'clip', id: s2.id }] }).ops, { assets: ASSETS, tier: 'T1', newId });
    if (!cut.ok) throw new Error('cut');
    const after = cut.value.model;
    const r = run(after, { action: 'paste', items: [], paste: { atMs: 0, entries } });
    expect(r.issues).toEqual([]);
    expect(r.intents[0]).toMatchObject({ propertyKey: 'group:asset:', propertyClass: 'list' });
    expect(r.intents.slice(1).map((k) => k.resolvedTargets)).toEqual([[{ kind: 'project', index: 0 }], [{ kind: 'project', index: 1 }]]);
    expect(r.intents.slice(1).every((k) => k.propertyKey.startsWith('list:paste:'))).toBe(true);
    expect(r.ops.map((o) => o.op)).toEqual(['op:scene.add', 'op:text.add']);
    expect(pickFromIntent(r.intents[1]!).itemsEdit?.paste?.entries).toEqual(entries);
    const applied = applyOperations(after, r.ops, { assets: ASSETS, tier: 'T1', newId });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.value.model.tracks.text.map((x) => [x.text, x.timing.atMs]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([['Dua', 0], ['Satu', 3000], ['Tiga', 6000]]);
  });
  it('an empty clipboard → EM-2201; remove / duplicate unchanged', () => {
    const m = scenes();
    expect(run(m, { action: 'paste', items: [], paste: { atMs: 0, entries: [] } }).issues[0]).toMatchObject({ code: 'EM-2201' });
    expect(run(m, { action: 'duplicate', items: [{ kind: 'text', id: m.tracks.text[0]!.id }] }).ops).toHaveLength(1);
  });
});
