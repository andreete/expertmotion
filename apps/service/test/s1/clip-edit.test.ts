// FR-068 (P1): Timeline drag on the video Track → clipEdit picks compiled to op:clip.move / op:clip.setTrim (Compile path,
// queue-visible, one version each); the Creator's own drags are not blocked by their earlier picks' Locked Keys.
// ADR-027: elementEdit picks (texts, images, shapes, audio) compile to op:element.setTiming / op:element.setLayer, undoable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headHash, insertClips, newProject, startS1, type S1Service } from './helpers.js';

describe('FR-068 clip edits', () => {
  let s: S1Service;
  beforeAll(async () => { s = await startS1(); });
  afterAll(async () => { await s.close(); });

  it('reorders with transitions re-attached, trims inside the source, rejects trims past the source (EM-2306)', async () => {
    const p = await newProject(s, 'Drag');
    insertClips(s, p.id, ['a1', 'a2', 'a3']);
    const model = async () => (await s.json(`/projects/${p.id}/composition`)).body.head.model;
    const ids = (await model()).tracks.video.map((c: { id: string }) => c.id) as string[];
    const pick = async (body: Record<string, unknown>) => s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', category: 'transition', target: { kind: 'selection' }, ...body, baseVersion: await headHash(s, p.id) } });
    expect((await pick({ presetId: 'preset:transition.fade' })).body.intent.status).toBe('executed');     // locks cut:0 / cut:1 transitions
    const move = await s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', category: 'asset', target: { kind: 'clip', id: ids[2] }, clipEdit: { clipId: ids[2], toIndex: 0 }, baseVersion: await headHash(s, p.id) } });
    expect([move.status, move.body.error]).toEqual([201, undefined]);
    expect(move.body.intent).toMatchObject({ category: 'asset', propertyKey: `clip:${ids[2]}.order`, status: 'executed' });
    const m1 = await model();
    expect(m1.tracks.video.map((c: { id: string }) => c.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(m1.transitions.map((x: { cutIndex: number }) => x.cutIndex)).toEqual([0, 1]);
    const trim = await s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', category: 'asset', target: { kind: 'clip', id: ids[0] }, clipEdit: { clipId: ids[0], trimBeforeMs: 1000, durationMs: 7000 }, baseVersion: await headHash(s, p.id) } });
    expect(trim.body.intent.status).toBe('executed');
    expect((await model()).tracks.video[1]).toMatchObject({ trimBeforeMs: 1000, durationMs: 7000 });
    const tooLong = await s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', category: 'asset', target: { kind: 'clip', id: ids[0] }, clipEdit: { clipId: ids[0], trimBeforeMs: 1000, durationMs: 9500 }, baseVersion: await headHash(s, p.id) } });
    expect(tooLong.body.error?.code ?? tooLong.body.intent?.rejectionReason).toMatch(/EM-2306/);
    const gone = await s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', category: 'asset', target: { kind: 'selection' }, clipEdit: { clipId: '01JAZK0000000000000000000A', toIndex: 0 }, baseVersion: await headHash(s, p.id) } });
    expect(gone.body.error.code).toBe('EM-2203');
  });

  it('ADR-027: element drags, lane changes and layer keys are one executed pick each and undo like any pick', async () => {
    const p = await newProject(s, 'Lanes');
    insertClips(s, p.id, ['a1', 'a2']);
    const model = async () => (await s.json(`/projects/${p.id}/composition`)).body.head.model;
    const post = async (body: Record<string, unknown>) => s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', target: { kind: 'playhead' }, ...body, baseVersion: await headHash(s, p.id) } });
    for (const text of ['Judul', 'Atas']) expect((await post({ category: 'text', presetId: 'preset:text.title', text, playheadMs: 0 })).body.intent.status).toBe('executed');
    const [a, b] = (await model()).tracks.text as Array<{ id: string; layer: number }>;
    expect([a!.layer, b!.layer]).toEqual([0, 1]);                                      // the second title went in front
    const down = await post({ category: 'text', target: { kind: 'text', id: b!.id }, elementEdit: { kind: 'text', id: b!.id, move: 'down' } });
    expect([down.status, down.body.intent]).toEqual([201, expect.objectContaining({ status: 'executed', propertyKey: `text:${b!.id}.layer` })]);
    expect((await model()).tracks.text.map((x: { layer: number }) => x.layer)).toEqual([1, 0]);
    const drag = await post({ category: 'text', target: { kind: 'text', id: a!.id }, elementEdit: { kind: 'text', id: a!.id, atMs: 5000, durationMs: 2000, layer: 0 } });
    expect(drag.body.intent).toMatchObject({ status: 'executed', propertyKey: `text:${a!.id}.timing|text:${a!.id}.layer` });
    const m = await model();
    expect(m.tracks.text[0]).toMatchObject({ timing: { atMs: 5000, durationMs: 2000 }, layer: 0 });     // nothing at 5–7 s: lane 0 is free
    await s.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });
    expect((await model()).tracks.text[0]).toMatchObject({ timing: { atMs: 0 }, layer: 1 });
    const gone = await post({ category: 'shape', elementEdit: { kind: 'shape', id: '01JAZK0000000000000000000B', move: 'up' } });
    expect(gone.body.error.code).toBe('EM-2203');
    const bad = await post({ category: 'text', elementEdit: { kind: 'text', id: a!.id, move: 'sideways' } });
    expect(bad.status).toBe(400);
  });
});
