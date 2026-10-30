// R-025 Sample Project (ONBOARDING_TOUR §2): idempotent create, isSample in every ProjectDto, hard delete when another project is
// created or opened, 503 EM-3001 without the bundled files, and (with the compositor FFmpeg) the prepared composition.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService, tempDir, type TestService } from '../helpers.js';
import { FFMPEG, FFPROBE, FIXTURES, hasFfmpeg } from '../s2/harness.js';
import { health } from '../../src/modules/health.js';
import { projectsModule } from '../../src/modules/projects.js';
import { compositionModule } from '../../src/modules/composition.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { intentsModule } from '../../src/modules/intents.js';

const SRT = ['Selamat datang di Kafe Senja.', 'Setiap sore kami menyeduh kopi susu segar.', 'Gula aren asli, susu dingin, espresso pilihan.', 'Duduk santai sambil menikmati senja di kota.', 'Sampai jumpa di Kafe Senja!']
  .map((t, i) => `${i + 1}\n00:00:${String(i * 3).padStart(2, '0')},200 --> 00:00:${String(i * 3 + 2).padStart(2, '0')},800\n${t}\n`).join('\n');
/** Smallest file the MP4 sniffer accepts (ftyp box), for runs without the committed fixtures; it fails ingest at probe. */
const fakeMp4 = (tag: number) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2'), Buffer.alloc(64, tag)]);

/** Writes the four bundled files into <dataDir>/sample (the test harness' sampleDir). */
function seedSample(dataDir: string): string {
  const dir = path.join(dataDir, 'sample'); fs.mkdirSync(dir, { recursive: true });
  const src = ['clip-a.mp4', 'clip-b.mp4', 'clip-a-audio.mp4'];
  src.forEach((f, i) => {
    const from = path.join(FIXTURES, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, `clip-${i + 1}.mp4`)); else fs.writeFileSync(path.join(dir, `clip-${i + 1}.mp4`), fakeMp4(i + 1));
  });
  fs.writeFileSync(path.join(dir, 'kafe-senja.srt'), SRT);
  return dir;
}

interface Ev { name: string; data: Record<string, any> }
type Svc = TestService & { events: Ev[]; json<T = any>(p: string, init?: Parameters<TestService['api']>[1]): Promise<{ status: number; body: T; headers: Headers }>; waitFor(pred: (e: Ev) => boolean, ms?: number): Promise<Ev> };

async function start(opts: { seed?: boolean } = {}): Promise<Svc> {
  const dataDir = tempDir('em-sample-');
  if (opts.seed !== false) seedSample(dataDir);
  const s = await startService({ dataDir, modules: [health, projectsModule, compositionModule, createAssetsModule({ importRoots: () => [] }), intentsModule] }) as Svc;
  s.ctx.resources.ffmpeg = hasFfmpeg ? FFMPEG : '/nonexistent/ffmpeg';
  s.ctx.resources.ffprobe = hasFfmpeg ? FFPROBE : '/nonexistent/ffprobe';
  s.events = [];
  const emit = s.ctx.bus.emit.bind(s.ctx.bus);
  s.ctx.bus.emit = (name, data) => { s.events.push({ name, data }); return emit(name, data); };
  s.json = async (p, init) => { const r = await s.api(p, init); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : undefined, headers: r.headers }; };
  s.waitFor = async (pred, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) { const e = s.events.find(pred); if (e) return e; if (Date.now() - t0 > ms) throw new Error('timed out waiting for event'); await new Promise((r) => setTimeout(r, 25)); }
  };
  return s;
}
const sampleNotice = (id: string) => (e: Ev) => e.name === 'service.notice' && e.data['kind'] === 'sample' && e.data['projectId'] === id;
/** Waits until the background preparation is over (ready or failed), so deletes do not race the ingest queue in assertions. */
async function settled(s: Svc, id: string) { await s.waitFor(sampleNotice(id)); }

let s: Svc | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

describe('R-025 POST /projects/sample', () => {
  it('answers 503 EM-3001 when the bundled sample folder is missing, and creates nothing', async () => {
    s = await start({ seed: false });
    const r = await s.json('/projects/sample', { method: 'POST', json: {} });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('EM-3001');
    expect((await s.json('/projects')).body.total).toBe(0);
  });

  it('requires the Service Token and rejects unknown fields', async () => {
    s = await start();
    expect((await s.api('/projects/sample', { method: 'POST', json: {}, auth: false })).status).toBe(401);
    const bad = await s.json('/projects/sample', { method: 'POST', json: { language: 'fr' } });
    expect(bad.status).toBe(400);
    expect((await s.json('/projects/sample', { method: 'POST', json: { name: 'x' } })).status).toBe(400);
  });

  it('creates "Contoh · Kafe Senja" with isSample (201), then returns the same project (200); isSample shows in list, get and recent', async () => {
    s = await start();
    const other = (await s.json('/projects', { method: 'POST', json: { name: 'Promo Kopi' } })).body;
    const a = await s.json('/projects/sample', { method: 'POST' });
    expect(a.status).toBe(201);
    expect(a.headers.get('location')).toBe(`/api/v1/projects/${a.body.id}`);
    expect(a.body).toMatchObject({ name: 'Contoh · Kafe Senja', language: 'id', isSample: true, assetCount: 4 });
    const b = await s.json('/projects/sample', { method: 'POST', json: { language: 'en' } });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.isSample).toBe(true);

    const list = (await s.json('/projects')).body;
    expect(list.total).toBe(2);
    expect(list.items.find((p: any) => p.id === a.body.id).isSample).toBe(true);
    expect(list.items.find((p: any) => p.id === other.id).isSample).toBeUndefined();
    expect((await s.json(`/projects/${a.body.id}`)).body.isSample).toBe(true);
    const opened = await s.json(`/projects/${a.body.id}/open`, { method: 'POST' });
    expect(opened.status).toBe(200);
    expect(opened.body.project.isSample).toBe(true);
    const recent = (await s.json('/projects/recent')).body;
    expect(recent.items.map((p: any) => [p.id, p.isSample])).toEqual([[a.body.id, true]]);
    expect((await s.json(`/projects/${a.body.id}`)).status).toBe(200);          // opening the sample itself keeps it
    await settled(s, a.body.id);
  });

  it('uses the English name for language "en" and avoids a name a Creator project already uses', async () => {
    s = await start();
    await s.json('/projects', { method: 'POST', json: { name: 'Sample · Kafe Senja' } });
    const r = await s.json('/projects/sample', { method: 'POST', json: { language: 'en' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Sample · Kafe Senja (2)', language: 'en', isSample: true });
    await settled(s, r.body.id);
  });

  it('is hard-deleted (rows, assets, media folder) when the Creator opens another project', async () => {
    s = await start();
    const other = (await s.json('/projects', { method: 'POST', json: { name: 'Promo Kopi' } })).body;
    const sample = (await s.json('/projects/sample', { method: 'POST' })).body;
    await settled(s, sample.id);
    expect(fs.existsSync(path.join(s.ctx.paths.media, sample.id))).toBe(true);
    expect((await s.json(`/projects/${other.id}/open`, { method: 'POST' })).status).toBe(200);
    expect((await s.json(`/projects/${sample.id}`)).status).toBe(404);
    expect((await s.json('/projects?includeDeleted=true')).body.items.map((p: any) => p.id)).toEqual([other.id]);   // no 30-day retention
    for (const t of ['projects', 'assets', 'composition_versions']) {
      const col = t === 'projects' ? 'id' : 'project_id';
      expect((s.ctx.db.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${col} = ?`).get(sample.id) as { n: number }).n).toBe(0);
    }
    expect(fs.existsSync(path.join(s.ctx.paths.media, sample.id))).toBe(false);
    // a new sample can be created afterwards
    expect((await s.json('/projects/sample', { method: 'POST' })).status).toBe(201);
  });

  it('is hard-deleted when the Creator creates another project, even while its media is still ingesting', async () => {
    s = await start();
    const sample = (await s.json('/projects/sample', { method: 'POST' })).body;
    const created = await s.json('/projects', { method: 'POST', json: { name: 'Proyek Baru' } });
    expect(created.status).toBe(201);
    expect(created.body.isSample).toBeUndefined();
    expect((await s.json(`/projects/${sample.id}`)).status).toBe(404);
    expect((s.ctx.db.prepare('SELECT count(*) AS n FROM assets WHERE project_id = ?').get(sample.id) as { n: number }).n).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    await (await import('../../src/s2/ingest.js')).ingestOf(s.ctx).idle();
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(path.join(s.ctx.paths.media, sample.id))).toBe(false);
    expect(s.events.some(sampleNotice(sample.id))).toBe(false);                 // preparation abandoned, no version on a deleted project
    expect((await s.json('/projects')).body.items.map((p: any) => p.name)).toEqual(['Proyek Baru']);
  });

  it('"Keep the sample project" (R-014 isSample:false): becomes an ordinary project named without the marker and survives a new project and opening another', async () => {
    s = await start();
    const sample = (await s.json('/projects/sample', { method: 'POST' })).body;
    await settled(s, sample.id);
    expect((await s.json(`/projects/${sample.id}/open`, { method: 'POST' })).status).toBe(200);
    const kept = await s.json(`/projects/${sample.id}`, { method: 'PATCH', json: { isSample: false } });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ id: sample.id, name: 'Kafe Senja', assetCount: 4 });
    expect(kept.body.isSample).toBeUndefined();
    expect((s.ctx.db.prepare('SELECT is_sample FROM projects WHERE id = ?').get(sample.id) as { is_sample: number }).is_sample).toBe(0);
    // File ▸ New (R-011), then open the new one (R-016): the kept project stays, with its media
    const created = await s.json('/projects', { method: 'POST', json: { name: 'Proyek Baru' } });
    expect(created.status).toBe(201);
    expect((await s.json(`/projects/${created.body.id}/open`, { method: 'POST' })).status).toBe(200);
    const after = await s.json(`/projects/${sample.id}`);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ name: 'Kafe Senja', assetCount: 4 });
    expect(fs.existsSync(path.join(s.ctx.paths.media, sample.id))).toBe(true);
    expect((await s.json('/projects/recent')).body.items.map((p: any) => p.id)).toEqual([created.body.id, sample.id]);
    expect((await s.json('/projects')).body.items.map((p: any) => p.name).sort()).toEqual(['Kafe Senja', 'Proyek Baru']);
    // a later tour makes a fresh sample under the marked name; repeating the keep on an ordinary project changes nothing
    const again = await s.json('/projects/sample', { method: 'POST' });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ name: 'Contoh · Kafe Senja', isSample: true });
    expect((await s.json(`/projects/${sample.id}`, { method: 'PATCH', json: { isSample: false } })).body.name).toBe('Kafe Senja');
    await settled(s, again.body.id);
  });

  it('Keep: a taken plain name gets " (2)", an explicit name wins, isSample:true is refused, an unknown id is 404', async () => {
    s = await start();
    await s.json('/projects', { method: 'POST', json: { name: 'Kafe Senja' } });
    const a = (await s.json('/projects/sample', { method: 'POST' })).body;
    await settled(s, a.id);
    expect((await s.json(`/projects/${a.id}`, { method: 'PATCH', json: { isSample: true } })).status).toBe(400);
    expect((await s.json(`/projects/${a.id}`, { method: 'PATCH', json: { isSample: false, name: 'Kafe Senja' } })).body.error.code).toBe('EM-6103');
    expect((await s.json(`/projects/${a.id}`)).body.isSample).toBe(true);                  // the failed rename rolled the keep back
    const kept = await s.json(`/projects/${a.id}`, { method: 'PATCH', json: { isSample: false } });
    expect(kept.body).toMatchObject({ name: 'Kafe Senja (2)' });
    const b = (await s.json('/projects/sample', { method: 'POST' })).body;
    await settled(s, b.id);
    const named = await s.json(`/projects/${b.id}`, { method: 'PATCH', json: { isSample: false, name: 'Kafe Senja Sore' } });
    expect(named.body).toMatchObject({ name: 'Kafe Senja Sore' });
    expect(named.body.isSample).toBeUndefined();
    expect((await s.json('/projects/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'PATCH', json: { isSample: false } })).status).toBe(404);
  });

  it('"Start my own project" / Skip keep today\'s behaviour: a sample that was not kept is removed by the next new project', async () => {
    s = await start();
    const sample = (await s.json('/projects/sample', { method: 'POST' })).body;
    await settled(s, sample.id);
    await s.json(`/projects/${sample.id}`, { method: 'PATCH', json: { name: 'Contoh · Kafe Senja Baru' } });   // a plain rename does not keep it
    expect((await s.json('/projects', { method: 'POST', json: { name: 'Proyek Saya' } })).status).toBe(201);
    expect((await s.json(`/projects/${sample.id}`)).status).toBe(404);
  });

  it.skipIf(!hasFfmpeg)('prepares one version: three clips in order, SRT captions, editorial-dark palette; emits ingest.*, composition.updated, service.notice ready', async () => {
    s = await start();
    const sample = (await s.json('/projects/sample', { method: 'POST' })).body;
    const notice = await s.waitFor(sampleNotice(sample.id), 60_000);
    expect(notice.data).toMatchObject({ kind: 'sample', projectId: sample.id, ready: true });
    expect(s.events.filter((e) => e.name === 'ingest.done' && e.data['projectId'] === sample.id)).toHaveLength(4);

    const assets = (await s.json(`/projects/${sample.id}/assets`)).body.items as Array<{ id: string; name: string; kind: string; status: string }>;
    expect(assets.map((a) => [a.name, a.kind, a.status])).toEqual([['clip-1.mp4', 'video', 'ready'], ['clip-2.mp4', 'video', 'ready'], ['clip-3.mp4', 'video', 'ready'], ['kafe-senja.srt', 'subtitle', 'ready']]);
    const comp = (await s.json(`/projects/${sample.id}/composition`)).body;
    const m = comp.head.model;
    expect(m.tracks.video.map((c: any) => c.assetId)).toEqual(assets.slice(0, 3).map((a) => a.id));
    expect(m.tracks.caption.sourceAssetId).toBe(assets[3]!.id);
    expect(m.tracks.caption.pages.length).toBeGreaterThan(0);
    expect(m.tracks.caption.pages.map((p: any) => p.text).join(' ')).toContain('Kafe Senja');
    expect(m.theme.paletteId).toBe('preset:palette.editorial-dark');
    expect(comp.head.cause).toBe('insert');
    const versions = (await s.json(`/projects/${sample.id}/composition/versions`)).body.items;
    expect(versions).toHaveLength(2);                                            // v1 empty + one sample version
    const upd = s.events.filter((e) => e.name === 'composition.updated' && e.data['projectId'] === sample.id);
    expect(upd.at(-1)!.data['version'].id).toBe(comp.head.id);
    expect(s.events.findIndex((e) => e === upd.at(-1))).toBeLessThan(s.events.findIndex((e) => e === notice));
    expect((await s.json(`/projects/${sample.id}`)).body).toMatchObject({ isSample: true, assetCount: 4 });
  }, 90_000);
});
