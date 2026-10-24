import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@expertmotion/shared';
import { health } from '../../src/modules/health.js';
import { mediaModule } from '../../src/modules/media.js';
import { json, startS2, type S2Service } from './harness.js';

describe('media serving (R-040…R-043)', () => {
  let s: S2Service; let p1: string; let p2: string; let a1: string; let a2: string; let out: string;
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const addAsset = (pid: string, rel: string | null, status = 'ready') => {
    const id = newId(); const now = new Date().toISOString();
    const dir = path.join(s.ctx.paths.media, pid, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'original.mp4'), bytes);
    fs.writeFileSync(path.join(dir, 'thumb.jpg'), 'jpg');
    s.ctx.db.prepare(`INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, playable_path, thumb_path, status, created_at, updated_at)
      VALUES (?,?,'video','a.mp4',?,?,?,?,?,?,?,?)`).run(id, pid, id, bytes.length, `${pid}/${id}/original.mp4`, rel ?? null, `${pid}/${id}/thumb.jpg`, status, now, now);
    return id;
  };
  const get = (url: string, init?: RequestInit) => fetch(`${s.base}${url}`, init);
  beforeAll(async () => {
    s = await startS2([health, mediaModule]);
    p1 = s.project(); p2 = s.project('Other');
    a1 = addAsset(p1, null); a2 = addAsset(p2, null);
    s.ctx.db.prepare('UPDATE assets SET playable_path = original_path WHERE id = ?').run(a1);
    // an Output for R-041
    const job = newId(); out = newId(); const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, created_at) VALUES (?,?,?,?, 'standard','done',?)")
      .run(job, p1, s.heads.get(p1)!.versionId, '{"ratio":"16:9","resolution":"720p","fps":30,"format":"mp4","alpha":false}', now);
    fs.mkdirSync(path.join(s.ctx.paths.outputs, p1), { recursive: true }); fs.writeFileSync(path.join(s.ctx.paths.outputs, p1, 'promo.mp4'), bytes);
    s.ctx.db.prepare("INSERT INTO outputs (id, project_id, render_job_id, path, kind, bytes, created_at) VALUES (?,?,?,?,'video',?,?)").run(out, p1, job, `${p1}/promo.mp4`, bytes.length, now);
  });
  afterAll(async () => { await s.close(); });

  it('R-042 issues a preview grant (new one revokes the old), R-043 revokes idempotently', async () => {
    const r = await s.api(`/projects/${p1}/media-grants`, { method: 'POST', json: {} });
    expect(r.status).toBe(201);
    const g = await json<{ grant: string; baseUrl: string; kind: string }>(r);
    expect(g.grant).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(g.baseUrl).toContain(`/media/${g.grant}`);
    const g2 = await json<{ grant: string }>(await s.api(`/projects/${p1}/media-grants`, { method: 'POST', json: {} }));
    expect(g2.grant).not.toBe(g.grant);
    expect((await get(`/media/${g.grant}/${a1}/original`)).status).toBe(404);
    expect((await get(`/media/${g2.grant}/${a1}/original`)).status).toBe(200);
    expect((await s.api(`/media-grants/${g2.grant}`, { method: 'DELETE' })).status).toBe(204);
    expect((await s.api(`/media-grants/${g2.grant}`, { method: 'DELETE' })).status).toBe(204);
    expect((await get(`/media/${g2.grant}/${a1}/original`)).status).toBe(404);
    expect((await s.api('/projects/01ARZ3NDEKTSV4RRFFQ69G5FAV/media-grants', { method: 'POST', json: {} })).status).toBe(404);
  });

  it('Range: full, partial, suffix, open-ended, unsatisfiable, HEAD; no Bearer needed', async () => {
    const g = s.ctx.grants.issuePreview(p1).token;
    const full = await get(`/media/${g}/${a1}/playable`);
    expect(full.status).toBe(200); expect(full.headers.get('accept-ranges')).toBe('bytes'); expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(true);
    const part = await get(`/media/${g}/${a1}/playable`, { headers: { Range: 'bytes=10-19' } });
    expect(part.status).toBe(206); expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);
    const suffix = await get(`/media/${g}/${a1}/playable`, { headers: { Range: 'bytes=-5' } });
    expect(suffix.headers.get('content-range')).toBe('bytes 995-999/1000'); expect((await suffix.arrayBuffer()).byteLength).toBe(5);
    const open = await get(`/media/${g}/${a1}/playable`, { headers: { Range: 'bytes=990-' } });
    expect((await open.arrayBuffer()).byteLength).toBe(10);
    const big = await get(`/media/${g}/${a1}/playable`, { headers: { Range: 'bytes=5-99999' } });
    expect(big.headers.get('content-range')).toBe('bytes 5-999/1000');
    const bad = await get(`/media/${g}/${a1}/playable`, { headers: { Range: 'bytes=2000-' } });
    expect(bad.status).toBe(416); expect(bad.headers.get('content-range')).toBe('bytes */1000');
    const head = await get(`/media/${g}/${a1}/playable`, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe('1000');
    expect((await get(`/media/${g}/${a1}/thumb`)).headers.get('content-type')).toBe('image/jpeg');
  });

  it('grant scoping: other project, unknown, malformed, missing variant, render grants limited to the job assets', async () => {
    const g1 = s.ctx.grants.issuePreview(p1).token;
    expect((await get(`/media/${g1}/${a2}/original`)).status).toBe(404);                  // asset of another project
    expect((await get(`/media/${'A'.repeat(43)}/${a1}/original`)).status).toBe(404);       // unknown grant
    expect((await get(`/media/short/${a1}/original`)).status).toBe(400);                    // malformed grant
    expect((await get(`/media/${g1}/not-a-ulid/original`)).status).toBe(400);
    expect((await get(`/media/${g1}/${a1}/proxy`)).status).toBe(404);                      // variant not produced
    expect((await get(`/media/${g1}/${a1}/secret`)).status).toBe(404);                     // unknown variant
    const rg = s.ctx.grants.issueRender(p1, 'JOB1', [a1]).token;
    expect((await get(`/media/${rg}/${a1}/original`)).status).toBe(200);
    const other = addAsset(p1, null);
    expect((await get(`/media/${rg}/${other}/original`)).status).toBe(404);                // not in the job's asset set
    s.ctx.grants.revokeJob('JOB1');
    expect((await get(`/media/${rg}/${a1}/original`)).status).toBe(404);                   // VC-12: finished job's grant
    expect((await get(`/api/v1/projects/${p1}/assets`, { headers: { Authorization: `Bearer ${g1}` } })).status).toBe(401);   // a grant opens nothing else
  });

  it('path traversal and tampered DB paths never leave the project media folder', async () => {
    const g = s.ctx.grants.issuePreview(p1).token;
    for (const u of [`/media/${g}/../../etc/passwd`, `/media/${g}/${a1}/..%2F..%2F..%2Fetc%2Fpasswd`, `/media/${g}/%2e%2e/${a1}/original`]) {
      expect([400, 404], u).toContain((await get(u)).status);
    }
    fs.writeFileSync(path.join(s.ctx.paths.data, 'secret.txt'), 'secret');
    s.ctx.db.prepare('UPDATE assets SET thumb_path = ? WHERE id = ?').run('../data/secret.txt', a1);
    const r = await get(`/media/${g}/${a1}/thumb`);
    expect(r.status).toBe(404); expect(await r.text()).not.toContain('secret"');
    s.ctx.db.prepare('UPDATE assets SET thumb_path = ? WHERE id = ?').run(`${p2}/${a2}/thumb.jpg`, a1);   // another project's file
    expect((await get(`/media/${g}/${a1}/thumb`)).status).toBe(404);
    fs.symlinkSync(path.join(s.ctx.paths.data, 'secret.txt'), path.join(s.ctx.paths.media, p1, a1, 'link.jpg'));
    s.ctx.db.prepare('UPDATE assets SET thumb_path = ? WHERE id = ?').run(`${p1}/${a1}/link.jpg`, a1);
    expect((await get(`/media/${g}/${a1}/thumb`)).status).toBe(404);                       // symlink escape caught by realpath
  });

  it('missing file → EM-1301; variant still being written → EM-6004; only GET/HEAD', async () => {
    const g = s.ctx.grants.issuePreview(p1).token;
    const ing = addAsset(p1, null, 'ingesting');
    const busy = await get(`/media/${g}/${ing}/playable`);
    expect(busy.status).toBe(409); expect((await json<{ error: { code: string } }>(busy)).error.code).toBe('EM-6004');
    fs.rmSync(path.join(s.ctx.paths.media, p1, ing, 'original.mp4'));
    const gone = await get(`/media/${g}/${ing}/original`);
    expect(gone.status).toBe(404); expect((await json<{ error: { code: string } }>(gone)).error.code).toBe('EM-1301');
    expect((await get(`/media/${g}/${a1}/original`, { method: 'POST' })).status).toBe(405);
    expect((await get(`/media/${g}/${a1}/original`, { method: 'DELETE' })).status).toBe(405);
  });

  it('R-041 outputs need a preview grant of the output project', async () => {
    const g = s.ctx.grants.issuePreview(p1).token;
    const r = await get(`/media/${g}/outputs/${out}/file`, { headers: { Range: 'bytes=0-9' } });
    expect(r.status).toBe(206);
    expect((await get(`/media/${g}/outputs/${out}/thumb`)).status).toBe(404);
    expect((await get(`/media/${s.ctx.grants.issuePreview(p2).token}/outputs/${out}/file`)).status).toBe(404);
    expect((await get(`/media/${s.ctx.grants.issueRender(p1, 'J2', [out]).token}/outputs/${out}/file`)).status).toBe(404);
  });

  it('CORS only for app:// and registered render origins', async () => {
    const g = s.ctx.grants.issuePreview(p1).token;
    expect((await get(`/media/${g}/${a1}/original`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    s.ctx.mediaOrigins.add('http://localhost:4130');
    const r = await get(`/media/${g}/${a1}/original`, { headers: { Origin: 'http://localhost:4130', Range: 'bytes=0-0' } });
    expect(r.status).toBe(206); expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:4130');
    s.ctx.mediaOrigins.delete('http://localhost:4130');
  });
});
