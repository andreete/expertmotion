// Text Panel picks (FR-022, FR-025…FR-028) through createIntents + compileIntents (deterministic Compile path).
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, hashModel, type AssetFacts, type CompositionModelT } from '@expertmotion/composition-model';
import { compileIntents, createIntents, pickFromIntent, type DesignPick } from '../src/index.js';

const ASSETS: AssetFacts[] = [{ id: 'a1', kind: 'video', status: 'ready', durationMs: 5000 }, { id: 'img', kind: 'image', status: 'ready', width: 400, height: 200 }];
let n = 0; const newId = () => `x${++n}`;
function model(): CompositionModelT {
  const r = applyOperations(createEmptyModel('p1', { autoRatio: false }), [
    { op: 'op:clip.insert', args: { assetId: 'a1' } },
    { op: 'op:text.add', args: { text: 'Halo', variant: 'preset:text.title', atMs: 0, durationMs: 2000 } },
    { op: 'op:shape.add', args: { presetId: 'preset:shape.circle', atMs: 0, durationMs: 1000 } },
    { op: 'op:overlay.addImage', args: { assetId: 'img', atMs: 0 } }], { assets: ASSETS, tier: 'T1', newId });
  if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model;
}
const run = (m: CompositionModelT, p: Partial<DesignPick>) => {
  const r = createIntents({ projectId: 'p1', source: 'ui', ...p }, { model: m, baseVersion: hashModel(m), newId });
  if (!r.ok) return { issues: r.issues, intents: [], ops: [] };
  const c = compileIntents(r.value, (i) => pickFromIntent(i), m);
  return { issues: [], intents: r.value, ops: c.ok ? c.value : [] };
};

describe('Text Panel picks', () => {
  it('FR-022 italic compiles to text.setStyle on the selected layer, else the theme default', () => {
    const m = model(); const t = { kind: 'text' as const, id: m.tracks.text[0]!.id };
    expect(run(m, { field: 'italic', value: true, selection: [t] }).ops).toMatchObject([{ op: 'op:text.setStyle', target: t, args: { italic: true } }]);
    expect(run(m, { field: 'italic', value: true }).ops[0]).toMatchObject({ op: 'op:theme.setTextDefaults', args: { italic: true } });
  });
  it('FR-025 a variant with a selected Text Layer re-styles it (exclusive key); without one it is Add Text', () => {
    const m = model(); const t = { kind: 'text' as const, id: m.tracks.text[0]!.id };
    const r = run(m, { presetId: 'preset:text.lower-third', selection: [t] });
    expect(r.intents[0]).toMatchObject({ propertyKey: `text:${t.id}.variant`, needsInterpretation: false });
    expect(r.ops).toMatchObject([{ op: 'op:text.setStyle', target: t, args: { variant: 'preset:text.lower-third' } }]);
  });
  it('FR-026 a text effect without a selection is queued for the Editor Agent; with one it compiles', () => {
    const m = model(); const t = { kind: 'text' as const, id: m.tracks.text[0]!.id };
    const none = run(m, { presetId: 'preset:texteffect.highlight', playheadMs: 500 });
    expect(none.intents[0]).toMatchObject({ needsInterpretation: true, params: { targetLabel: 'needs the Editor Agent' } });
    expect(run(m, { presetId: 'preset:texteffect.highlight', selection: [t] }).ops[0]).toMatchObject({ op: 'op:text.setEffect', target: t });
  });
  it('FR-027 Add Text at the playhead: 3000 ms clamped to the Sequence end; no clips (ADR-031) → 3000 ms, no EM-2202', () => {
    const m = model();
    expect(run(m, { presetId: 'preset:text.title', text: 'Your text', playheadMs: 1000 }).ops[0]).toMatchObject({ op: 'op:text.add', args: { text: 'Your text', atMs: 1000, durationMs: 3000 } });
    expect(run(m, { presetId: 'preset:text.title', text: 'Your text', playheadMs: 4000 }).ops[0]).toMatchObject({ args: { atMs: 4000, durationMs: 1000 } });
    // ADR-031: a faceless project (no clips, fit-content) gets the text at the playhead with its full length; the text sets the video length.
    const empty = run(createEmptyModel('p1'), { presetId: 'preset:text.title', text: 'Your text', playheadMs: 0 });
    expect(empty.issues).toEqual([]);
    expect(empty.ops).toMatchObject([{ op: 'op:text.add', args: { text: 'Your text', atMs: 0, durationMs: 3000 } }]);
  });
  it('FR-027 content edits the selected layer (op:text.setContent)', () => {
    const m = model(); const t = { kind: 'text' as const, id: m.tracks.text[0]!.id };
    expect(run(m, { field: 'content', value: 'Promo hari ini', selection: [t] }).ops).toMatchObject([{ op: 'op:text.setContent', target: t, args: { text: 'Promo hari ini' } }]);
    expect(run(m, { field: 'content', value: 'x' }).issues[0]).toMatchObject({ code: 'EM-2201' });
  });
  it('FR-028 opacity applies to a Text Layer, a Shape and an overlay image; nothing selected → EM-2201', () => {
    const m = model();
    const shape = m.tracks.overlay.find((o) => o.kind === 'shape')!, img = m.tracks.overlay.find((o) => o.kind === 'image')!;
    const t = { kind: 'text' as const, id: m.tracks.text[0]!.id };
    const r = run(m, { field: 'opacity', value: 0.6, selection: [t, { kind: 'shape', id: shape.id }, { kind: 'image', id: img.id }] });
    expect(r.ops.map((o) => o.op)).toEqual(['op:text.setStyle', 'op:overlay.setOpacity', 'op:overlay.setOpacity']);
    expect(run(m, { field: 'opacity', value: 0.6 }).issues[0]).toMatchObject({ code: 'EM-2201' });
  });
});
