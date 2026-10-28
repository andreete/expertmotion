// FR-068 (P1): Timeline drag on the video Track → clipEdit picks compiled to op:clip.move / op:clip.setTrim (Compile path,
// queue-visible, one version each); the Creator's own drags are not blocked by their earlier picks' Locked Keys.
// ADR-027: elementEdit picks (texts, images, shapes, audio) compile to op:element.setTiming / op:element.setLayer, undoable.
// ADR-028: splitEdit (scissors / S) → op:element.split per item in ONE version; transformEdit (Player handles) → op:element.setTransform.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copySnapshot } from '@expertmotion/composition-model';
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

  it('ADR-028: a split of a clip and a text at the playhead is one executed pick and one undo; a transform pick is a scalar key', async () => {
    const p = await newProject(s, 'Cut');
    insertClips(s, p.id, ['a1', 'a2']);
    const model = async () => (await s.json(`/projects/${p.id}/composition`)).body.head.model;
    const post = async (body: Record<string, unknown>) => s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', target: { kind: 'playhead' }, ...body, baseVersion: await headHash(s, p.id) } });
    expect((await post({ category: 'text', presetId: 'preset:text.title', text: 'Judul', playheadMs: 0 })).body.intent.status).toBe('executed');
    const m0 = await model();
    const clip = m0.tracks.video[0] as { id: string; durationMs: number }, text = m0.tracks.text[0] as { id: string };
    const before = await headHash(s, p.id);
    const cut = await post({ category: 'asset', target: { kind: 'clip', id: clip.id }, splitEdit: { atMs: 1500, items: [{ kind: 'clip', id: clip.id }, { kind: 'text', id: text.id }] } });
    expect([cut.status, cut.body.intent.status]).toEqual([201, 'executed']);
    const m1 = await model();
    expect(m1.tracks.video.map((c: { trimBeforeMs: number; durationMs: number }) => [c.trimBeforeMs, c.durationMs])).toEqual([[0, 1500], [1500, clip.durationMs - 1500], [0, 6000]]);
    expect(m1.tracks.text.map((x: { timing: { atMs: number; durationMs: number } }) => x.timing)).toEqual([{ atMs: 0, durationMs: 1500 }, { atMs: 1500, durationMs: 1500 }]);
    const queue = (await s.json(`/projects/${p.id}/intents`)).body;
    const kids = (queue.items as Array<{ parentIntentId?: string; propertyKey: string; status: string }>).filter((i) => i.parentIntentId === cut.body.intent.id);
    expect(kids.map((k) => [k.propertyKey.split(':').slice(0, 3).join(':'), k.status]).sort()).toEqual([['list:split:clip', 'executed'], ['list:split:text', 'executed']]);
    await s.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });
    expect(await headHash(s, p.id)).toBe(before);                                      // one undo restores both
    const tf = await post({ category: 'asset', target: { kind: 'clip', id: clip.id }, transformEdit: { kind: 'clip', id: clip.id, x: -0.1, y: 0, scale: 1.2, rotation: 0 } });
    expect(tf.body.intent).toMatchObject({ status: 'executed', propertyKey: `clip:${clip.id}.transform` });
    expect((await model()).tracks.video[0].transform).toEqual({ x: -0.1, y: 0, scale: 1.2, rotation: 0 });
    const outside = await post({ category: 'asset', splitEdit: { atMs: 50, items: [{ kind: 'clip', id: clip.id }] } });
    expect(outside.body.error.code).toBe('EM-2201');
    expect((await post({ category: 'asset', transformEdit: { kind: 'clip', id: clip.id, scale: 99 } })).status).toBe(400);
    expect((await post({ category: 'asset', transformEdit: { kind: 'image', id: '01JAZK0000000000000000000C', x: 0 } })).body.error.code).toBe('EM-2203');
  });

  it('ADR-031: Delete of a clip + a text and Duplicate of a text are one executed pick each; one undo restores the delete; a text without clips works', async () => {
    const p = await newProject(s, 'Hapus');
    insertClips(s, p.id, ['a1', 'a2']);
    const model = async () => (await s.json(`/projects/${p.id}/composition`)).body.head.model;
    const post = async (body: Record<string, unknown>) => s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', target: { kind: 'playhead' }, ...body, baseVersion: await headHash(s, p.id) } });
    expect((await post({ category: 'text', presetId: 'preset:text.title', text: 'Judul', playheadMs: 0 })).body.intent.status).toBe('executed');
    const m0 = await model();
    const clip = m0.tracks.video[0] as { id: string }, text = m0.tracks.text[0] as { id: string };
    const before = await headHash(s, p.id);
    const del = await post({ category: 'asset', target: { kind: 'clip', id: clip.id }, itemsEdit: { action: 'remove', items: [{ kind: 'clip', id: clip.id }, { kind: 'text', id: text.id }] } });
    expect([del.status, del.body.intent.status]).toEqual([201, 'executed']);
    const m1 = await model();
    expect([m1.tracks.video.length, m1.tracks.text.length]).toEqual([1, 0]);
    const kids = ((await s.json(`/projects/${p.id}/intents`)).body.items as Array<{ parentIntentId?: string; propertyKey: string; status: string }>).filter((i) => i.parentIntentId === del.body.intent.id);
    expect(kids.map((k) => [k.propertyKey.split(':').slice(0, 3).join(':'), k.status]).sort()).toEqual([['list:remove:clip', 'executed'], ['list:remove:text', 'executed']]);
    await s.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });
    expect(await headHash(s, p.id)).toBe(before);                                      // one undo brings both back
    const dup = await post({ category: 'text', target: { kind: 'text', id: text.id }, itemsEdit: { action: 'duplicate', items: [{ kind: 'text', id: text.id }] } });
    expect(dup.body.intent.status).toBe('executed');
    expect((await model()).tracks.text.map((x: { text: string }) => x.text)).toEqual(['Judul', 'Judul']);
    expect((await post({ category: 'asset', itemsEdit: { action: 'remove', items: [{ kind: 'text', id: '01JAZK0000000000000000000D' }] } })).body.error.code).toBe('EM-2203');
    expect((await post({ category: 'asset', itemsEdit: { action: 'explode', items: [{ kind: 'text', id: text.id }] } })).status).toBe(400);
    // FR-027 / ADR-031: Add Text in a project with zero clips (faceless) is applied, 3 s long
    const empty = await newProject(s, 'Kosong');
    const add = await s.json(`/projects/${empty.id}/intents`, { method: 'POST', json: { source: 'ui', category: 'text', presetId: 'preset:text.title', text: 'Halo', target: { kind: 'playhead' }, playheadMs: 0, baseVersion: empty.headHash } });
    expect([add.status, add.body.intent.status]).toEqual([201, 'executed']);
    expect((await s.json(`/projects/${empty.id}/composition`)).body.head.model.tracks.text[0].timing).toEqual({ atMs: 0, durationMs: 3000 });
  });
  it('FR-255 / FR-256: Cut (copy + Delete) then Paste at the playhead is one executed pick and one undo; untrusted clipboards are refused', async () => {
    const p = await newProject(s, 'Tempel');
    insertClips(s, p.id, ['a1', 'a2']);
    const model = async () => (await s.json(`/projects/${p.id}/composition`)).body.head.model;
    const post = async (body: Record<string, unknown>) => s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', target: { kind: 'playhead' }, ...body, baseVersion: await headHash(s, p.id) } });
    expect((await post({ category: 'text', presetId: 'preset:text.title', text: 'Judul', playheadMs: 0 })).body.intent.status).toBe('executed');
    const m0 = await model();
    const clip = m0.tracks.video[0] as { id: string }, text = m0.tracks.text[0] as { id: string };
    const { entries } = copySnapshot(m0, [{ kind: 'clip', id: clip.id }, { kind: 'text', id: text.id }]);
    expect((await post({ category: 'asset', target: { kind: 'clip', id: clip.id }, itemsEdit: { action: 'remove', items: [{ kind: 'clip', id: clip.id }, { kind: 'text', id: text.id }] } })).body.intent.status).toBe('executed');
    const before = await headHash(s, p.id);
    const paste = await post({ category: 'asset', playheadMs: 0, itemsEdit: { action: 'paste', items: [], paste: { atMs: 0, entries } } });
    expect([paste.status, paste.body.intent.status]).toEqual([201, 'executed']);
    const m1 = await model();
    expect(m1.tracks.video.map((c: { assetId: string }) => c.assetId)).toEqual(m0.tracks.video.map((c: { assetId: string }) => c.assetId));
    expect(m1.tracks.text.map((x: { text: string; timing: { atMs: number } }) => [x.text, x.timing.atMs])).toEqual([['Judul', 0]]);
    await s.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });
    expect(await headHash(s, p.id)).toBe(before);                                      // one undo removes the whole paste
    // untrusted input: an op that is not the add op of its kind, too many entries, items with paste, paste without entries
    const bad = [{ ...entries[0]!, op: { op: 'op:clip.remove', args: {} } }];
    expect((await post({ category: 'asset', itemsEdit: { action: 'paste', items: [], paste: { atMs: 0, entries: bad } } })).status).toBe(400);
    expect((await post({ category: 'asset', itemsEdit: { action: 'paste', items: [], paste: { atMs: 0, entries: Array.from({ length: 51 }, () => entries[1]!) } } })).status).toBe(400);
    expect((await post({ category: 'asset', itemsEdit: { action: 'paste', items: [{ kind: 'text', id: text.id }], paste: { atMs: 0, entries } } })).status).toBe(400);
    expect((await post({ category: 'asset', itemsEdit: { action: 'paste', items: [] } })).status).toBe(400);
    expect((await post({ category: 'asset', itemsEdit: { action: 'remove', items: [] } })).status).toBe(400);
    // a pasted clip whose asset is not in this project is blocked by applyOperations (nothing applied)
    const foreign = [{ kind: 'clip', offsetMs: 0, durationMs: 1000, op: { op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: '01JAZK0000000000000000000Z', durationMs: 1000 } } }];
    const h = await headHash(s, p.id);
    const r = await post({ category: 'asset', itemsEdit: { action: 'paste', items: [], paste: { atMs: 0, entries: foreign } } });
    expect(r.status === 201 ? r.body.intent.status : r.status).not.toBe('executed');
    expect(await headHash(s, p.id)).toBe(h);
  });
});
