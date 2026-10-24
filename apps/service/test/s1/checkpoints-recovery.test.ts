import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';
import { Debouncer, RUNNING_FLAG, type Timers } from '../../src/s1/checkpoints.js';
import { s1 } from '../../src/s1/index.js';
const booted = (s: S1Service) => ((s.ctx.bus as unknown as { buffer: Array<{ name: string; data: Record<string, unknown> }> }).buffer);
import { headHash, insertClips, newProject, startS1, type S1Service } from './helpers.js';

function fakeTimers() {
  let now = 0; const q: Array<{ at: number; fn: () => void; id: number }> = []; let n = 0;
  const t: Timers = { now: () => now, set: (fn, ms) => { const id = ++n; q.push({ at: now + ms, fn, id }); return id; }, clear: (id) => { const i = q.findIndex((x) => x.id === id); if (i >= 0) q.splice(i, 1); } };
  const advance = (ms: number) => { const end = now + ms; for (;;) { q.sort((a, b) => a.at - b.at); const nx = q[0]; if (!nx || nx.at > end) break; q.shift(); now = nx.at; nx.fn(); } now = end; };
  return { t, advance };
}

describe('autosave debounce (NFR-020: 2 s after the last edit, at most 5 s while dirty)', () => {
  it('fires 2 s after a single edit', () => {
    const { t, advance } = fakeTimers(); const fired: Array<[string, number]> = [];
    const d = new Debouncer((k) => fired.push([k, t.now()]), () => ({ debounce: 2000, max: 5000 }), t);
    d.touch('p'); advance(1999); expect(fired).toEqual([]); advance(1); expect(fired).toEqual([['p', 2000]]);
  });
  it('keeps postponing while edits arrive but never beyond 5 s after the first', () => {
    const { t, advance } = fakeTimers(); const fired: number[] = [];
    const d = new Debouncer(() => fired.push(t.now()), () => ({ debounce: 2000, max: 5000 }), t);
    for (let i = 0; i < 12; i++) { d.touch('p'); advance(1000); }
    expect(fired.slice(0, 2)).toEqual([5000, 10_000]);
  });
  it('keys are independent; flush fires pending keys; cancel drops one', () => {
    const { t, advance } = fakeTimers(); const fired: string[] = [];
    const d = new Debouncer((k) => fired.push(k), () => ({ debounce: 2000, max: 5000 }), t);
    d.touch('a'); d.touch('b'); d.touch('c'); d.cancel('c'); d.flush();
    expect(fired.sort()).toEqual(['a', 'b']); advance(10_000); expect(fired).toHaveLength(2); expect(d.size).toBe(0);
  });
});

describe('checkpoints R-022…R-024 and autosave over HTTP', () => {
  let s: S1Service;
  beforeAll(async () => { s = await startS1(); s.ctx.settings.update({ autosaveDebounceMs: 500, autosaveMaxMs: 1000 }); });
  afterAll(async () => { await s.close(); });

  it('empty list carries EM-6202; manual checkpoint clears dirty; restore appends a restore version', async () => {
    const p = await newProject(s);
    s1(s.ctx).checkpoints.autosave.cancel(p.id);
    expect((await s.json(`/projects/${p.id}/checkpoints`)).body).toEqual({ items: [], notice: 'EM-6202' });
    insertClips(s, p.id, ['a1']);
    expect((await s.json(`/projects/${p.id}`)).body.dirty).toBe(true);
    const c = await s.json(`/projects/${p.id}/checkpoints`, { method: 'POST', json: { reason: 'manual' } });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ projectId: p.id, reason: 'manual', durationMs: 10_000 });
    expect((await s.json(`/projects/${p.id}`)).body.dirty).toBe(false);
    const h = await headHash(s, p.id);
    expect(fs.existsSync(path.join(s.ctx.paths.checkpoints, p.id, `${h}.json`))).toBe(true);
    insertClips(s, p.id, ['a2']);
    const r = await s.json(`/projects/${p.id}/checkpoints/${c.body.id}/restore`, { method: 'POST' });
    expect(r.body.version).toMatchObject({ cause: 'restore', hash: h });
    expect((await s.json(`/projects/${p.id}/composition/versions`)).body.total).toBe(4);
    expect((await s.json(`/projects/${p.id}/checkpoints/01JAZK0000000000000000000Q/restore`, { method: 'POST' })).body.error.code).toBe('EM-9003');
  });
  it('a damaged checkpoint file is EM-6201', async () => {
    const p = await newProject(s);
    insertClips(s, p.id, ['a1']);
    const c = await s.json(`/projects/${p.id}/checkpoints`, { method: 'POST', json: {} });
    const file = path.join(s.ctx.paths.checkpoints, p.id, `${await headHash(s, p.id)}.json`);
    const body = JSON.parse(fs.readFileSync(file, 'utf8')); body.model.tracks.video[0].durationMs = 999; fs.writeFileSync(file, JSON.stringify(body));
    const r = await s.json(`/projects/${p.id}/checkpoints/${c.body.id}/restore`, { method: 'POST' });
    expect([r.status, r.body.error.code]).toEqual([422, 'EM-6201']);
  });
  it('autosave writes a checkpoint shortly after head changes (debounced to one) and keeps 20', async () => {
    const p = await newProject(s);
    for (const a of ['a1', 'a2', 'a3']) insertClips(s, p.id, [a]);
    await new Promise((r) => setTimeout(r, 1300));
    const list = (await s.json(`/projects/${p.id}/checkpoints`)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'autosave', versionId: (await s.json(`/projects/${p.id}`)).body.headVersionId });
    for (let i = 0; i < 24; i++) { insertClips(s, p.id, ['a3']); await s.json(`/projects/${p.id}/checkpoints`, { method: 'POST', json: {} }); }
    expect((await s.json(`/projects/${p.id}/checkpoints`)).body.items).toHaveLength(20);
    expect(fs.readdirSync(path.join(s.ctx.paths.checkpoints, p.id)).filter((f) => f.endsWith('.json'))).toHaveLength(20);
  });
});

describe('crash recovery on start', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const dataDir = tempDir('em-s1-crash-');
  let pid = ''; let ckptHash = '';

  it('after an unclean shutdown, R-016 offers the newest checkpoint that differs from the head', async () => {
    let s = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    pid = (await newProject(s, 'Crashy')).id;
    insertClips(s, pid, ['a1', 'a2']);
    const c = await s.json(`/projects/${pid}/checkpoints`, { method: 'POST', json: {} });
    ckptHash = await headHash(s, pid);
    await s.json(`/projects/${pid}/composition/undo`, { method: 'POST' });       // head moves, autosave not yet written
    s1(s.ctx).checkpoints.autosave.cancel(pid);
    s1(s.ctx).checkpoints.checkpointDirty = () => [];                              // a crash skips the shutdown checkpoint (FR-165)
    await s.close();
    expect(fs.existsSync(path.join(dataDir, 'data', RUNNING_FLAG))).toBe(false);   // clean stop clears the flag
    fs.writeFileSync(path.join(dataDir, 'data', RUNNING_FLAG), '1');               // …simulate a crash instead
    s = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    try {
      expect(booted(s).some((e) => e.name === 'service.notice' && e.data['code'] === 'EM-8003')).toBe(true);
      const o = await s.json(`/projects/${pid}/open`, { method: 'POST' });
      expect(o.body.checkpointNewerThanSave).toMatchObject({ id: c.body.id, projectId: pid });
      const r = await s.json(`/projects/${pid}/checkpoints/${c.body.id}/restore`, { method: 'POST' });
      expect(r.body.version.hash).toBe(ckptHash);
      expect((await s.json(`/projects/${pid}/open`, { method: 'POST' })).body.checkpointNewerThanSave).toBeNull();
    } finally { await s.close(); }
  });
  it('plans left executing/draft are failed/cancelled (EM-4304) on start', async () => {
    let s = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    const h = s1(s.ctx).store.head(pid);
    s.ctx.db.prepare("INSERT INTO agent_runs (id, project_id, agent, model_id, status, started_at) VALUES ('RUN1', ?, 'editor', 'm', 'running', 'now')").run(pid);
    const plan = (id: string, status: string) => s.ctx.db.prepare("INSERT INTO edit_plans (id, project_id, base_version_id, origin, plan_json, status, agent_run_id, created_at, updated_at) VALUES (?,?,?,'editor-agent',?,?,?,'t','t')")
      .run(id, pid, h.versionId, JSON.stringify({ id, projectId: pid, baseVersion: h.hash, origin: 'editor-agent', goal: 'g', steps: [], touchesLockedKeys: [], risks: [], status, validation: [] }), status, status === 'draft' ? 'RUN1' : null);
    plan('PLANDRAFT', 'draft'); plan('PLANEXEC', 'executing');
    await s.close();
    s = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    try {
      const st = (id: string) => (s.ctx.db.prepare('SELECT status FROM edit_plans WHERE id = ?').get(id) as { status: string }).status;
      expect([st('PLANDRAFT'), st('PLANEXEC')]).toEqual(['cancelled', 'failed']);
      expect(s.ctx.db.prepare("SELECT status, error_code FROM agent_runs WHERE id = 'RUN1'").get()).toEqual({ status: 'cancelled', error_code: 'EM-4304' });
    } finally { await s.close(); }
  });
  it('when the database is lost, checkpoint folders are imported back as projects', async () => {
    const s = await startS1({ dataDir, cfg: { dbKeyHex: crypto.randomBytes(32).toString('hex') } });   // wrong key → fresh database
    try {
      const p = await s.json(`/projects/${pid}`);
      expect(p.status).toBe(200);
      expect(p.body.name).toBe('Crashy');
      expect((await s.json(`/projects/${pid}/composition`)).body.head).toMatchObject({ cause: 'restore' });
      expect(booted(s).some((e) => e.name === 'service.notice' && (e.data['imported'] as string[] | undefined)?.includes(pid))).toBe(true);
    } finally { await s.close(); }
  });
});

describe('soft-deleted projects are purged after 30 days', () => {
  let s: S1Service;
  beforeAll(async () => { s = await startS1(); });
  afterAll(async () => { await s.close(); });
  it('removes rows, media and checkpoints', async () => {
    const p = await newProject(s);
    insertClips(s, p.id, ['a1']);
    await s.json(`/projects/${p.id}/checkpoints`, { method: 'POST', json: {} });
    await s.api(`/projects/${p.id}`, { method: 'DELETE' });
    s.ctx.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), p.id);
    expect(s1(s.ctx).projects.purge()).toEqual([p.id]);
    expect(s.ctx.db.prepare('SELECT count(*) AS n FROM composition_versions WHERE project_id = ?').get(p.id)).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(s.ctx.paths.media, p.id))).toBe(false);
    expect(fs.existsSync(path.join(s.ctx.paths.checkpoints, p.id))).toBe(false);
  });
});
