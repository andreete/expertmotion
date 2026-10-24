import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headHash, insertClips, newProject, startS1, type S1Service } from './helpers.js';

const ULID0 = '01JAZK0000000000000000000A';

describe('projects R-010…R-019', () => {
  let s: S1Service;
  beforeAll(async () => { s = await startS1(); });
  afterAll(async () => { await s.close(); });

  it('creates a project with version 1, Location header and composition.updated', async () => {
    const r = await s.api('/projects', { method: 'POST', json: { name: 'Promo Kopi Agustus', settings: { fps: 30, ratio: '9:16', resolution: '1080p' } } });
    expect(r.status).toBe(201);
    const p = await r.json() as any;
    expect(r.headers.get('location')).toBe(`/api/v1/projects/${p.id}`);
    expect(p).toMatchObject({ name: 'Promo Kopi Agustus', language: 'id', durationMs: 1000, assetCount: 0, dirty: false, openedAt: null, settings: { fps: 30, ratio: '9:16', resolution: '1080p', language: 'id' } });
    expect(p.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(s.ctx.paths.media, p.id))).toBe(true);
    expect(s.events.some((e) => e.name === 'composition.updated' && e.data['projectId'] === p.id && e.data['cause'] === 'system')).toBe(true);
  });
  it('rejects duplicate names (EM-6103), bad bodies (EM-9002) and unknown ids (EM-6101)', async () => {
    await newProject(s, 'Dupe');
    expect((await s.json('/projects', { method: 'POST', json: { name: ' dupe ' } })).body.error.code).toBe('EM-6103');
    const bad = await s.json('/projects', { method: 'POST', json: { name: '', settings: { fps: 31 } } });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'EM-9002']);
    expect((await s.json('/projects', { method: 'POST', json: { name: 'x', settings: { ratio: 'custom', customRatio: { w: 100, h: 1000 } } } })).body.error.code).toBe('EM-2402');
    const nf = await s.json(`/projects/${ULID0}`);
    expect([nf.status, nf.body.error.code]).toEqual([404, 'EM-6101']);
    expect((await s.json('/projects/not-an-id')).body.error.code).toBe('EM-9002');
  });
  it('lists with cursor pagination and a total', async () => {
    for (let i = 0; i < 3; i++) await newProject(s, `List ${i}`);
    const a = await s.json('/projects?limit=2');
    expect(a.body.items).toHaveLength(2);
    expect(a.body.nextCursor).toBeTruthy();
    const b = await s.json(`/projects?limit=200&cursor=${a.body.nextCursor}`);
    const ids = [...a.body.items, ...b.body.items].map((x: any) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(a.body.total);
  });
  it('patches name and language; open issues a preview grant and fills recent', async () => {
    const p = await newProject(s, 'Rename me');
    const r = await s.json(`/projects/${p.id}`, { method: 'PATCH', json: { name: 'Renamed', language: 'en' } });
    expect(r.body).toMatchObject({ name: 'Renamed', language: 'en', settings: { language: 'en' } });
    const o = await s.json(`/projects/${p.id}/open`, { method: 'POST' });
    expect(o.status).toBe(200);
    expect(o.body.mediaGrant).toMatchObject({ projectId: p.id, kind: 'preview' });
    expect(o.body.mediaGrant.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(o.body.mediaGrant.baseUrl).toBe(`http://127.0.0.1:${s.cfg.port}/media/${o.body.mediaGrant.grant}`);
    expect(s.ctx.grants.check(o.body.mediaGrant.grant, p.id, 'x')).toBeTruthy();
    expect(o.body.head.model.projectId).toBe(p.id);
    expect(o.body.intentQueue).toMatchObject({ projectId: p.id, items: [], lockedKeys: [] });
    expect(o.body).toMatchObject({ checkpointNewerThanSave: null, latestPlan: null, renderJobs: [] });
    const rec = await s.json('/projects/recent');
    expect(rec.body.items[0].id).toBe(p.id);
  });
  it('settings: ratio/fps/resolution changes become a compile-path version with system intents', async () => {
    const p = await newProject(s, 'Settings');
    const g = await s.json(`/projects/${p.id}/settings`);
    expect(g.body).toMatchObject({ fps: 30, ratio: '9:16', resolution: '1080p' });
    const put = await s.json(`/projects/${p.id}/settings`, { method: 'PUT', json: { ...g.body, ratio: '16:9', fps: 25, autoRatio: false } });
    expect(put.status).toBe(200);
    expect(put.body.settings).toMatchObject({ ratio: '16:9', fps: 25, autoRatio: false });
    expect(put.body.version.cause).toBe('compile');
    const comp = await s.json(`/projects/${p.id}/composition`);
    expect(comp.body.head.model.settings).toMatchObject({ ratio: '16:9', fps: 25 });
    const q = await s.json(`/projects/${p.id}/intents`);
    expect(q.body.items.filter((i: any) => i.source === 'system' && i.status === 'executed')).toHaveLength(2);
    const same = await s.json(`/projects/${p.id}/settings`, { method: 'PUT', json: put.body.settings });
    expect(same.body.version).toBeNull();
    const bad = await s.json(`/projects/${p.id}/settings`, { method: 'PUT', json: { ...put.body.settings, ratio: 'custom', customRatio: { w: 200, h: 200 } } });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'EM-2402']);
  });
  it('FR-088/FR-095/FR-097: Auto lives in the model (can be re-enabled), follows the first clip, manual ratio turns it off, reset is one undoable version', async () => {
    const t = await startS1({ assets: [{ id: 'land', kind: 'video', status: 'ready', durationMs: 5000, width: 1920, height: 1080, name: 'land.mp4' }, { id: 'port', kind: 'video', status: 'ready', durationMs: 5000, width: 1080, height: 1920, name: 'port.mp4' }] });
    try {
      const p = await newProject(t, 'Auto', { ratio: '9:16', autoRatio: false });
      const pick = async (output: Record<string, unknown>) => t.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', category: 'layout', target: { kind: 'project' }, output, baseVersion: await headHash(t, p.id) } });
      const on = await pick({ kind: 'autoRatio', value: true });
      expect(on.status).toBe(201);
      expect(on.body.intent).toMatchObject({ propertyKey: 'project.ratioAuto', needsInterpretation: false, status: 'executed' });
      expect((await t.json(`/projects/${p.id}/settings`)).body.autoRatio).toBe(true);
      insertClips(t, p.id, ['land']);
      expect((await t.json(`/projects/${p.id}/settings`)).body).toMatchObject({ ratio: '16:9', autoRatio: true });
      insertClips(t, p.id, ['port']);
      expect((await t.json(`/projects/${p.id}/settings`)).body.ratio).toBe('16:9');       // only the first clip counts
      const manual = await pick({ kind: 'ratio', value: '1:1' });
      expect(manual.body.intent.status).toBe('executed');
      expect((await t.json(`/projects/${p.id}/settings`)).body).toMatchObject({ ratio: '1:1', autoRatio: false });
      const again = await pick({ kind: 'autoRatio', value: true });                          // the bug: Auto could never come back
      expect(again.body.queue.items.find((i: any) => i.id === on.body.intent.id).status).toBe('superseded');
      expect((await t.json(`/projects/${p.id}/settings`)).body).toMatchObject({ ratio: '16:9', autoRatio: true });
      await pick({ kind: 'resolution', value: '2k' });
      const g = (await t.json(`/projects/${p.id}/settings`)).body;
      const reset = await t.json(`/projects/${p.id}/settings`, { method: 'PUT', json: { fps: g.fps, language: g.language, ratio: '9:16', resolution: '1080p', autoRatio: false } });
      expect(reset.body.settings).toMatchObject({ ratio: '9:16', resolution: '1080p', autoRatio: false });
      expect(reset.body.version).not.toBeNull();
      await t.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });                 // one Undo restores all of it
      expect((await t.json(`/projects/${p.id}/settings`)).body).toMatchObject({ ratio: '16:9', resolution: '2k', autoRatio: true });
    } finally { await t.close(); }
  });
  it('FR-090/FR-097: a Performance Profile pick is a zero-op settings intent (executed, supersedable, restore undoes it); FR-085: applied intents carry the version hash', async () => {
    const p = await newProject(s, 'Profile');
    s.ctx.settings.update({ defaultPerformanceProfile: 'standard' });
    const pick = async (output: Record<string, unknown>, category = 'output') => s.json(`/projects/${p.id}/intents`, { method: 'POST', json: { source: 'ui', category, target: { kind: 'project' }, output, baseVersion: await headHash(s, p.id) } });
    const head0 = await headHash(s, p.id);
    const plans0 = (s.ctx.db.prepare('SELECT count(*) AS n FROM edit_plans').get() as { n: number }).n;
    const a = await pick({ kind: 'performanceProfile', value: 'accelerated' });
    expect(a.status).toBe(201);
    expect(a.body.intent).toMatchObject({ category: 'output', propertyKey: 'project.performanceProfile', status: 'executed', needsInterpretation: false, params: { __previous: 'standard' } });
    expect([a.body.appliedVersion, a.body.planId]).toEqual([null, null]);
    expect(s.ctx.settings.get().defaultPerformanceProfile).toBe('accelerated');
    expect(await headHash(s, p.id)).toBe(head0);                                                   // no Composition Version, no plan
    expect((s.ctx.db.prepare('SELECT count(*) AS n FROM edit_plans').get() as { n: number }).n).toBe(plans0);
    expect(s.events.some((e) => e.name === 'settings.changed' && (e.data['settings'] as any)?.defaultPerformanceProfile === 'accelerated')).toBe(true);
    const b = await pick({ kind: 'performanceProfile', value: 'turbo' });
    expect(b.body.superseded).toEqual([a.body.intent.id]);
    expect(b.body.intent.params.__previous).toBe('accelerated');
    expect(s.ctx.settings.get().defaultPerformanceProfile).toBe('turbo');
    const undo = await s.json(`/projects/${p.id}/intents/${a.body.intent.id}/restore`, { method: 'POST' });   // Undo = restore the replaced pick
    expect(undo.body.intent.status).toBe('executed');
    expect(undo.body.queue.items.find((i: any) => i.id === b.body.intent.id).status).toBe('superseded');
    expect(s.ctx.settings.get().defaultPerformanceProfile).toBe('accelerated');
    expect((await pick({ kind: 'performanceProfile', value: 'warp' })).body.error.code).toBe('EM-9002');
    const r = await pick({ kind: 'ratio', value: '1:1' }, 'layout');
    expect(r.body.intent.appliedHash).toBe(r.body.appliedVersion.hash);
    expect(r.body.intent.appliedVersion).toBeGreaterThan(0);
    s.ctx.settings.update({ defaultPerformanceProfile: 'standard' });
  });
  it('soft-deletes (204), then the project is gone; delete refuses while an agent run is active', async () => {
    const p = await newProject(s, 'Delete me');
    s.ctx.db.prepare("INSERT INTO agent_runs (id, project_id, agent, model_id, status, started_at) VALUES ('R1', ?, 'editor', 'm', 'running', 'now')").run(p.id);
    expect((await s.json(`/projects/${p.id}`, { method: 'DELETE' })).body.error.code).toBe('EM-2309');
    s.ctx.db.prepare("UPDATE agent_runs SET status = 'done' WHERE id = 'R1'").run();
    expect((await s.api(`/projects/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await s.json(`/projects/${p.id}`)).body.error.code).toBe('EM-6101');
    expect((await s.json('/projects?includeDeleted=true&limit=200')).body.items.some((x: any) => x.id === p.id)).toBe(true);
  });
  it('duplicates (Save As) with versions, remapped projectId and an independent head', async () => {
    const p = await newProject(s, 'Original');
    insertClips(s, p.id, ['a1', 'a2']);
    const d = await s.json(`/projects/${p.id}/duplicate`, { method: 'POST', json: { name: 'Copy' } });
    expect(d.status).toBe(201);
    expect(d.body.id).not.toBe(p.id);
    const a = (await s.json(`/projects/${p.id}/composition`)).body.head.model;
    const b = (await s.json(`/projects/${d.body.id}/composition`)).body.head.model;
    expect(b.projectId).toBe(d.body.id);
    expect(b.tracks.video.map((c: any) => c.assetId)).toEqual(a.tracks.video.map((c: any) => c.assetId));
    expect((await s.json(`/projects/${d.body.id}/composition/versions`)).body.total).toBe(2);
    expect((await s.json(`/projects/${p.id}/duplicate`, { method: 'POST', json: { name: 'copy' } })).body.error.code).toBe('EM-6103');
    await s.json(`/projects/${d.body.id}/composition/undo`, { method: 'POST' });
    expect((await s.json(`/projects/${p.id}/composition`)).body.head.model.tracks.video).toHaveLength(2);
  });
});

describe('composition R-050…R-056 and hooks', () => {
  let s: S1Service;
  beforeAll(async () => { s = await startS1(); });
  afterAll(async () => { await s.close(); });

  it('hooks.composition / applyOps; head, timing and issues', async () => {
    const p = await newProject(s);
    const vid = insertClips(s, p.id, ['a1', 'a2']);
    expect(s.ctx.hooks.composition(p.id).versionId).toBe(vid);
    const c = await s.json(`/projects/${p.id}/composition`);
    expect(c.body).toMatchObject({ canUndo: true, canRedo: false, timing: { durationMs: 16_000, cutStartMs: [10_000] }, issues: [] });
    expect(c.body.head).toMatchObject({ id: vid, cause: 'insert' });
    expect((await s.json(`/projects/${p.id}/composition?model=false`)).body.head.model).toBeUndefined();
    expect(() => s.ctx.hooks.composition('01JAZK0000000000000000000B')).toThrow(/Not found/);
    expect(() => s.ctx.hooks.applyOps(p.id, [{ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: 'nope' } }], { kind: 'asset', summary: 'x' })).toThrow();
    const ev = s.events.filter((e) => e.name === 'composition.updated' && e.data['projectId'] === p.id).at(-1)!;
    expect(ev.data).toMatchObject({ cause: 'insert', canUndo: true, durationMs: 16_000 });
    expect((ev.data['version'] as any).model).toBeUndefined();
    expect(ev.data['diff']).toEqual(expect.arrayContaining([expect.objectContaining({ change: 'added' })]));
  });
  it('undo/redo move the head with new rows; redo is cleared by another mutation; root gives EM-2401', async () => {
    const p = await newProject(s);
    const h1 = await headHash(s, p.id);
    insertClips(s, p.id, ['a1']); const h2 = await headHash(s, p.id);
    insertClips(s, p.id, ['a2']); const h3 = await headHash(s, p.id);
    const u1 = await s.json(`/projects/${p.id}/composition/undo`, { method: 'POST', json: {} });
    expect(u1.body).toMatchObject({ head: { hash: h2, cause: 'undo' }, canUndo: true, canRedo: true });
    const u2 = await s.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });
    expect(u2.body).toMatchObject({ head: { hash: h1 }, canUndo: false, canRedo: true });
    const root = await s.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });
    expect([root.status, root.body.error.code, root.body.error.details.reason]).toEqual([422, 'EM-2401', 'at-root']);
    expect((await s.json(`/projects/${p.id}/composition/redo`, { method: 'POST' })).body.head.hash).toBe(h2);
    expect((await s.json(`/projects/${p.id}/composition/redo`, { method: 'POST' })).body).toMatchObject({ head: { hash: h3, cause: 'redo' }, canRedo: false });
    expect((await s.json(`/projects/${p.id}/composition/redo`, { method: 'POST' })).body.error.details.reason).toBe('no-redo');
    await s.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });
    insertClips(s, p.id, ['a3']);
    expect((await s.json(`/projects/${p.id}/composition`)).body.canRedo).toBe(false);
    const list = await s.json(`/projects/${p.id}/composition/versions?limit=3`);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items[0].model).toBeUndefined();
    const rest = await s.json(`/projects/${p.id}/composition/versions?limit=50&cursor=${list.body.nextCursor}`);
    expect(list.body.items.length + rest.body.items.length).toBe(list.body.total);
    const one = await s.json(`/projects/${p.id}/composition/versions/${list.body.items[0].id}`);
    expect(one.body.model.tracks.video).toHaveLength(2);
    expect((await s.json(`/projects/${p.id}/composition/versions/${ULID0}`)).body.error.code).toBe('EM-2401');
  });
  it('diff returns element diff and the linear op history', async () => {
    const p = await newProject(s);
    const h1 = await headHash(s, p.id);
    insertClips(s, p.id, ['a1']); insertClips(s, p.id, ['a2']);
    const h3 = await headHash(s, p.id);
    const d = await s.json(`/projects/${p.id}/composition/diff?from=${h1}&to=${h3}`);
    expect(d.status).toBe(200);
    expect(d.body.ops.map((o: any) => o.args.assetId)).toEqual(['a1', 'a2']);
    expect(d.body.diff.filter((x: any) => x.change === 'added')).toHaveLength(2);
    expect((await s.json(`/projects/${p.id}/composition/diff?from=${h3}&to=${h1}`)).body.ops).toEqual([]);
    expect((await s.json(`/projects/${p.id}/composition/diff?from=zzz&to=${h1}`)).body.error.code).toBe('EM-2401');
  });
  it('validate is a dry run; stale baseVersion is 409 EM-2301', async () => {
    const p = await newProject(s);
    insertClips(s, p.id, ['a1', 'a2']);
    const h = await headHash(s, p.id);
    const ok = await s.json(`/projects/${p.id}/composition/validate`, { method: 'POST', json: { baseVersion: h, ops: [{ op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.fade', durationMs: 500 } }] } });
    expect(ok.body).toMatchObject({ ok: true, predictedDurationMs: 15_500 });
    const bad = await s.json(`/projects/${p.id}/composition/validate`, { method: 'POST', json: { baseVersion: h, ops: [{ op: 'op:clip.setTrim', target: { kind: 'clip', id: 'nope' }, args: { trimBeforeMs: 0, durationMs: 500 } }] } });
    expect(bad.body.ok).toBe(false);
    expect(await headHash(s, p.id)).toBe(h);
    const st = await s.json(`/projects/${p.id}/composition/validate`, { method: 'POST', json: { baseVersion: 'old', ops: [] } });
    expect([st.status, st.body.error.code]).toEqual([409, 'EM-2301']);
  });
});
