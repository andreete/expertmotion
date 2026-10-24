// Project lifecycle and persistence gaps: persisted redo (FR-168), checkpoint hash + size (FR-016), duration policy and output
// folder as settings (FR-009, FR-015), permanent delete with "keep Outputs" (FR-178), disk usage (R-026), thumbnail (R-027),
// retention (FR-175), recovery summary (R-003, FR-171/172), pre-render and shutdown checkpoints (FR-165).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';
import { insertClips, newProject, startS1, type S1Service } from './helpers.js';
import { RUNNING_FLAG } from '../../src/s1/checkpoints.js';
import { s1 } from '../../src/s1/index.js';
import { purgeRetention } from '../../src/s1/retention.js';
import { buildRecoverySummary } from '../../src/s1/recovery.js';

let svc: S1Service | null = null;
afterEach(async () => { await svc?.close(); svc = null; });
const DAY = 24 * 3_600_000;

describe('FR-168 redo survives a restart', () => {
  it('keeps the redo stack in the database and clears it on a new mutation', async () => {
    const dataDir = tempDir('em-s1-redo-'), key = crypto.randomBytes(32).toString('hex');
    svc = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    const p = await newProject(svc);
    insertClips(svc, p.id, ['a1']); insertClips(svc, p.id, ['a2']);
    expect((await svc.json(`/projects/${p.id}/composition/undo`, { method: 'POST' })).body.canRedo).toBe(true);
    await svc.close();
    svc = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    const head = await svc.json(`/projects/${p.id}/composition?model=true`);
    expect(head.body.canRedo).toBe(true);
    const r = await svc.json(`/projects/${p.id}/composition/redo`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.head.model ?? r.body.head).toBeTruthy();
    expect((await svc.json(`/projects/${p.id}/composition?model=true`)).body.head.model.tracks.video).toHaveLength(2);
    expect(r.body.canRedo).toBe(false);
    // Undo, then a new mutation: redo is gone (branch), also after a restart.
    await svc.json(`/projects/${p.id}/composition/undo`, { method: 'POST' });
    insertClips(svc, p.id, ['a3']);
    expect((await svc.json(`/projects/${p.id}/composition?model=false`)).body.canRedo).toBe(false);
    expect((await svc.json(`/projects/${p.id}/composition/redo`, { method: 'POST' })).body.error.code).toBe('EM-2401');
  });
});

describe('FR-016 checkpoints carry version hash and size', () => {
  it('lists hash and bytes', async () => {
    svc = await startS1();
    const p = await newProject(svc);
    const c = await svc.json(`/projects/${p.id}/checkpoints`, { method: 'POST', json: { reason: 'manual' } });
    expect(c.status).toBe(201);
    expect(c.body.hash).toBe(p.headHash);
    expect(c.body.bytes).toBeGreaterThan(100);
    const l = await svc.json(`/projects/${p.id}/checkpoints`);
    expect(l.body.items[0]).toMatchObject({ hash: p.headHash, bytes: c.body.bytes });
  });
});

describe('FR-009 / FR-015 duration policy and output folder', () => {
  const inHome = path.join(os.homedir(), 'em-test-out-folder');
  it('New accepts a duration policy and an output folder', async () => {
    svc = await startS1();
    const r = await svc.json('/projects', { method: 'POST', json: { name: 'Fixed', durationPolicy: 'fixed', fixedDurationMs: 5000, outputFolder: inHome } });
    expect(r.status).toBe(201);
    const s = await svc.json(`/projects/${r.body.id}/settings`);
    expect(s.body).toMatchObject({ durationPolicy: 'fixed', fixedDurationMs: 5000, outputFolder: path.resolve(inHome) });
    expect((await svc.json('/projects', { method: 'POST', json: { name: 'Bad', durationPolicy: 'fixed' } })).body.error.code).toBe('EM-9002');
    expect((await svc.json('/projects', { method: 'POST', json: { name: 'Out', outputFolder: '/etc' } })).body.error.code).toBe('EM-8302');
  });
  it('Project Settings compiles the duration policy into op:project.setDurationPolicy and stores the folder', async () => {
    svc = await startS1();
    const p = await newProject(svc);
    insertClips(svc, p.id, ['a1']);                                   // 10 s of content
    const cur = (await svc.json(`/projects/${p.id}/settings`)).body;
    expect(cur.durationPolicy).toBe('fit-content');
    const r = await svc.json(`/projects/${p.id}/settings`, { method: 'PUT', json: { ...cur, durationPolicy: 'fixed', fixedDurationMs: 5000, outputFolder: inHome } });
    expect(r.status).toBe(200);
    expect(r.body.version).not.toBeNull();
    expect(r.body.version.durationMs).toBe(5000);
    expect(r.body.settings).toMatchObject({ durationPolicy: 'fixed', fixedDurationMs: 5000, outputFolder: path.resolve(inHome) });
    const q = await svc.json(`/projects/${p.id}/intents`);
    expect(q.body.items.some((i: { propertyKey: string; source: string }) => i.propertyKey === 'project.durationPolicy' && i.source === 'system')).toBe(true);
    // Back to fit-content and clearing the folder.
    const back = await svc.json(`/projects/${p.id}/settings`, { method: 'PUT', json: { ...cur, durationPolicy: 'fit-content', outputFolder: null } });
    expect(back.body.version.durationMs).toBe(10_000);
    expect(back.body.settings.outputFolder).toBeNull();
    // Unchanged policy: no new version.
    expect((await svc.json(`/projects/${p.id}/settings`, { method: 'PUT', json: { ...cur, durationPolicy: 'fit-content' } })).body.version).toBeNull();
  });
});

function fakeOutput(s: S1Service, projectId: string): string {
  const db = s.ctx.db, now = new Date().toISOString(), jobId = s.ctx.newId(), outId = s.ctx.newId();
  const head = (db.prepare('SELECT head_version_id AS v FROM projects WHERE id = ?').get(projectId) as { v: string }).v;
  db.prepare("INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, progress, created_at) VALUES (?,?,?,'{}','standard','done',1,?)").run(jobId, projectId, head, now);
  const rel = `${projectId}/clip.mp4`;
  fs.mkdirSync(path.join(s.ctx.paths.outputs, projectId), { recursive: true });
  fs.writeFileSync(path.join(s.ctx.paths.outputs, rel), Buffer.alloc(2048));
  db.prepare("INSERT INTO outputs (id, project_id, render_job_id, path, kind, bytes, created_at) VALUES (?,?,?,?,'video',2048,?)").run(outId, projectId, jobId, rel, now);
  return path.join(s.ctx.paths.outputs, rel);
}

describe('FR-178 delete, keep Outputs, disk usage', () => {
  it('permanent delete removes rows, media and checkpoints; Outputs kept unless asked', async () => {
    svc = await startS1();
    const a = await newProject(svc, 'Keep');
    const b = await newProject(svc, 'Drop');
    for (const p of [a, b]) fs.writeFileSync(path.join(svc.ctx.paths.media, p.id, 'x.bin'), Buffer.alloc(1000));
    await svc.json(`/projects/${a.id}/checkpoints`, { method: 'POST', json: { reason: 'manual' } });
    const fa = fakeOutput(svc, a.id), fb = fakeOutput(svc, b.id);

    const du = await svc.json('/projects/disk-usage');
    expect(du.status).toBe(200);
    const ua = du.body.items.find((i: { projectId: string }) => i.projectId === a.id);
    expect(ua).toMatchObject({ outputsBytes: 2048, outputCount: 1 });
    expect(ua.mediaBytes).toBeGreaterThanOrEqual(1000);
    expect(ua.checkpointBytes).toBeGreaterThan(0);
    expect(ua.totalBytes).toBe(ua.mediaBytes + ua.checkpointBytes + ua.outputsBytes);
    expect(du.body.totalBytes).toBeGreaterThanOrEqual(ua.totalBytes);
    expect(du.body.freeBytes).toBeGreaterThan(0);
    expect((await svc.json(`/projects/disk-usage?projectId=${a.id}`)).body.items).toHaveLength(1);

    expect((await svc.api(`/projects/${a.id}?permanent=true&keepOutputs=true`, { method: 'DELETE' })).status).toBe(204);
    expect(fs.existsSync(path.join(svc.ctx.paths.media, a.id))).toBe(false);
    expect(fs.existsSync(path.join(svc.ctx.paths.checkpoints, a.id))).toBe(false);
    expect(fs.existsSync(fa)).toBe(true);
    expect((await svc.json(`/projects/${a.id}`)).status).toBe(404);
    expect((await svc.json('/projects/recent')).body.items.some((p: { id: string }) => p.id === a.id)).toBe(false);
    expect(svc.ctx.db.prepare('SELECT count(*) AS n FROM projects WHERE id = ?').get(a.id)).toEqual({ n: 0 });

    expect((await svc.api(`/projects/${b.id}?permanent=true&keepOutputs=false`, { method: 'DELETE' })).status).toBe(204);
    expect(fs.existsSync(fb)).toBe(false);
  });
  it('a busy project is not deleted (EM-2309)', async () => {
    svc = await startS1();
    const p = await newProject(svc);
    const head = (svc.ctx.db.prepare('SELECT head_version_id AS v FROM projects WHERE id = ?').get(p.id) as { v: string }).v;
    svc.ctx.db.prepare("INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, progress, created_at) VALUES (?,?,?,'{}','standard','rendering',0.4,?)").run(svc.ctx.newId(), p.id, head, new Date().toISOString());
    expect((await svc.json(`/projects/${p.id}?permanent=true`, { method: 'DELETE' })).body.error.code).toBe('EM-2309');
  });
});

describe('FR-010 Open dialog thumbnail (R-027)', () => {
  it('204 without assets, the first clip thumbnail otherwise', async () => {
    svc = await startS1();
    const p = await newProject(svc);
    expect((await svc.api(`/projects/${p.id}/thumbnail`)).status).toBe(204);
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(svc.ctx.paths.media, p.id, 'a1'), { recursive: true });
    fs.writeFileSync(path.join(svc.ctx.paths.media, p.id, 'a1', 'thumb.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    svc.ctx.db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, thumb_path, status, created_at, updated_at) VALUES (?,?,'video','a.mp4','h',10,?,?,'ready',?,?)")
      .run('a1', p.id, `${p.id}/a1/original.mp4`, `${p.id}/a1/thumb.jpg`, now, now);
    insertClips(svc, p.id, ['a1']);
    const r = await svc.api(`/projects/${p.id}/thumbnail`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('image/jpeg');
    expect(Buffer.from(await r.arrayBuffer())).toHaveLength(4);
    expect((await svc.api(`/projects/${p.id}/thumbnail`, { auth: false })).status).toBe(401);
  });
});

describe('FR-175 retention', () => {
  it('purges generated-but-not-inserted results after 7 days and usage after 12 months', async () => {
    svc = await startS1();
    const p = await newProject(svc);
    const db = svc.ctx.db, now = Date.now();
    const old = new Date(now - 8 * DAY).toISOString(), fresh = new Date(now - DAY).toISOString();
    const job = (id: string, finished: string, result: object) => db.prepare("INSERT INTO generator_jobs (id, project_id, kind, input_json, status, progress, result_json, created_at, finished_at) VALUES (?,?,'hashtags','{}','done',1,?,?,?)").run(id, p.id, JSON.stringify(result), finished, finished);
    job('01JOLDNOTINSERTED0000000000', old, { hashtags: ['#a'] });
    job('01JOLDINSERTED000000000000A', old, { hashtags: ['#a'], versionId: 'v' });
    job('01JFRESHNOTINSERTED0000000', fresh, { hashtags: ['#a'] });
    db.prepare("INSERT INTO agent_runs (id, project_id, agent, model_id, status, started_at) VALUES ('r1', ?, 'editor', 'm', 'done', ?)").run(p.id, old);
    const usage = db.prepare("INSERT INTO usage_records (agent_run_id, project_id, provider, model_id, input_tokens, output_tokens, created_at) VALUES ('r1', ?, 'openrouter', 'm', 1, 1, ?)");
    usage.run(p.id, new Date(now - 400 * DAY).toISOString());
    usage.run(p.id, new Date(now - 30 * DAY).toISOString());
    const r = purgeRetention(svc.ctx, now);
    expect(r).toMatchObject({ generatorJobs: 1, usageRecords: 1 });
    expect((db.prepare('SELECT id FROM generator_jobs ORDER BY id').all() as Array<{ id: string }>).map((x) => x.id)).toEqual(['01JFRESHNOTINSERTED0000000', '01JOLDINSERTED000000000000A']);
    expect(db.prepare('SELECT count(*) AS n FROM usage_records').get()).toEqual({ n: 1 });
  });
});

describe('FR-175 checkpoint retention at start', () => {
  it('prunes to the newest 20 checkpoints and removes unreferenced files on restart', async () => {
    const dataDir = tempDir('em-s1-cp-prune-'), key = crypto.randomBytes(32).toString('hex');
    svc = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    const p = await newProject(svc);
    expect((await svc.json(`/projects/${p.id}/checkpoints`, { method: 'POST', json: { reason: 'manual' } })).status).toBe(201);
    const db = svc.ctx.db;
    const base = db.prepare('SELECT * FROM recovery_checkpoints WHERE project_id = ? LIMIT 1').get(p.id) as { version_id: string; file_path: string } | undefined;
    expect(base).toBeTruthy();
    const dir = path.join(svc.ctx.paths.checkpoints, p.id);
    const body = fs.readFileSync(path.join(svc.ctx.paths.data, base!.file_path));
    // 25 rows (as an older build without pruning-on-write could leave), each with its own file, plus one stray file.
    for (let i = 0; i < 25; i++) {
      const h = crypto.createHash('sha256').update(`cp${i}`).digest('hex');
      fs.writeFileSync(path.join(dir, `${h}.json`), body);
      db.prepare('INSERT INTO recovery_checkpoints (id, project_id, version_id, file_path, reason, created_at) VALUES (?,?,?,?,?,?)')
        .run(`01JPRUNE${String(i).padStart(18, '0')}`, p.id, base!.version_id, `checkpoints/${p.id}/${h}.json`, 'autosave', new Date(Date.now() + i * 1000).toISOString());
    }
    const stray = crypto.createHash('sha256').update('stray').digest('hex');
    fs.writeFileSync(path.join(dir, `${stray}.json`), body);
    await svc.close();
    svc = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    s1(svc.ctx);
    const n = (svc.ctx.db.prepare('SELECT count(*) AS n FROM recovery_checkpoints WHERE project_id = ?').get(p.id) as { n: number }).n;
    expect(n).toBe(20);
    const kept = svc.ctx.db.prepare('SELECT id FROM recovery_checkpoints WHERE project_id = ? ORDER BY created_at DESC').all(p.id) as Array<{ id: string }>;
    expect(kept[0]!.id).toBe(`01JPRUNE${String(24).padStart(18, '0')}`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(20);
    expect(files).not.toContain(`${stray}.json`);
  });
});

describe('R-003 recovery summary (FR-171 / FR-172)', () => {
  it('reports an unclean previous run once per start, with the rows recovery marked', async () => {
    const dataDir = tempDir('em-s1-recov-'), key = crypto.randomBytes(32).toString('hex');
    svc = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    const clean = await svc.json('/service/recovery');
    expect(clean.body).toMatchObject({ unclean: false, renders: [], agentRuns: [], ingests: [], plans: [] });
    await svc.close();
    fs.writeFileSync(path.join(dataDir, 'data', RUNNING_FLAG), '1');          // simulate a crash
    svc = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    const r = await svc.json('/service/recovery');
    expect(r.status).toBe(200);
    expect(r.body.unclean).toBe(true);
    expect(r.body.startedAt).not.toBe(clean.body.startedAt);
  });
  it('collects interrupted renders, agent runs and imports from the start window', async () => {
    svc = await startS1();
    const p = await newProject(svc);
    const db = svc.ctx.db, at = s1(svc.ctx).checkpoints.bootAt;
    const head = (db.prepare('SELECT head_version_id AS v FROM projects WHERE id = ?').get(p.id) as { v: string }).v;
    db.prepare("INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, progress, error_code, created_at, finished_at) VALUES ('j1',?,?,'{}','standard','failed',0.4,'EM-3203',?,?)").run(p.id, head, at, at);
    db.prepare("INSERT INTO agent_runs (id, project_id, agent, model_id, status, error_code, started_at, finished_at) VALUES ('r1', ?, 'editor', 'm', 'cancelled', 'EM-4304', ?, ?)").run(p.id, at, at);
    db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, status, error_code, created_at, updated_at) VALUES ('a9',?,'video','b.mp4','h',1,'x','failed','EM-1201',?,?)").run(p.id, at, at);
    const late = new Date(Date.parse(at) + 120_000).toISOString();
    db.prepare("INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, progress, error_code, created_at, finished_at) VALUES ('j2',?,?,'{}','standard','failed',0.4,'EM-3203',?,?)").run(p.id, head, late, late);
    const sum = buildRecoverySummary(svc.ctx, at, { unclean: true, offered: [p.id], imported: [] });
    expect(sum.renders).toEqual([{ jobId: 'j1', projectId: p.id }]);
    expect(sum.agentRuns).toEqual([{ runId: 'r1', projectId: p.id, agent: 'editor' }]);
    expect(sum.ingests).toEqual([{ assetId: 'a9', projectId: p.id, name: 'b.mp4' }]);
    expect(sum.checkpoints.offered).toEqual([p.id]);
  });
});

describe('FR-165 checkpoints before risky operations', () => {
  it('pre-render hook writes a pre-render checkpoint; shutdown checkpoints what is dirty', async () => {
    svc = await startS1();
    const p = await newProject(svc);
    insertClips(svc, p.id, ['a1']);
    svc.ctx.hooks.checkpoint!(p.id, 'pre-render');
    const l = await svc.json(`/projects/${p.id}/checkpoints`);
    expect(l.body.items[0].reason).toBe('pre-render');
    insertClips(svc, p.id, ['a2']);
    const ck = s1(svc.ctx).checkpoints;
    ck.autosave.cancel(p.id);
    expect(ck.checkpointDirty()).toEqual([p.id]);
    expect(ck.checkpointDirty()).toEqual([]);                          // nothing left to save
    expect((await svc.json(`/projects/${p.id}`)).body.dirty).toBe(false);
  });
});
