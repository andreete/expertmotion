// FR-048 missing/changed media, FR-050 24 h expiry of failed cards, FR-043 codec, FR-029/FR-030 Insert placement (no FFmpeg needed).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { ingestOf } from '../../src/s2/ingest.js';
import { FAILED_TTL_MS } from '../../src/s2/media-check.js';
import { importDir, json, shell, startS2, type S2Service } from './harness.js';

type Asset = { id: string; status: string; missing: boolean; codec: string | null; sha256: string };

describe('assets: media check, failed-card expiry, codec, Insert placement', () => {
  let s: S2Service; let src: string; let pid: string;
  const srt = (text: string) => `1\n00:00:00,000 --> 00:00:01,000\n${text}\n`;
  const importSrt = async (name: string, text: string): Promise<string> => {
    fs.writeFileSync(path.join(src, name), srt(text));
    const r = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, name)] } }));
    await ingestOf(s.ctx).idle();
    return r.items[0]!.id;
  };
  const get = async (id: string) => json<Asset>(await s.api(`/projects/${pid}/assets/${id}`));
  const originalOf = (id: string) => path.resolve(s.ctx.paths.media, (s.ctx.db.prepare('SELECT original_path FROM assets WHERE id = ?').get(id) as { original_path: string }).original_path);
  const row = (id: string, kind: string, status: string, extra: { probe?: string; updatedAt?: string; width?: number; height?: number } = {}) => {
    const now = new Date().toISOString();
    s.ctx.db.prepare('INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, status, error_code, probe_json, width, height, duration_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, pid, kind, `${id}.x`, `sha-${id}`, 1, `${pid}/${id}/original.x`, status, status === 'failed' ? 'EM-1001' : null, extra.probe ?? null, extra.width ?? null, extra.height ?? null, kind === 'image' ? 5000 : 4000, now, extra.updatedAt ?? now);
    fs.mkdirSync(path.dirname(path.resolve(s.ctx.paths.media, `${pid}/${id}/original.x`)), { recursive: true });
    fs.writeFileSync(path.resolve(s.ctx.paths.media, `${pid}/${id}/original.x`), 'x');
  };
  beforeAll(async () => {
    src = importDir();
    s = await startS2([health, createAssetsModule({ importRoots: () => [src] })]);
    pid = s.project();
  });
  afterAll(async () => { await s.close(); });

  it('a deleted original shows missing, notifies EM-1301, and Locate (R-036) with the same file restores it', async () => {
    const id = await importSrt('m.srt', 'Halo');
    expect((await get(id)).missing).toBe(false);
    fs.rmSync(originalOf(id));
    expect((await get(id)).missing).toBe(true);
    const check = await s.ctx.hooks.mediaCheck!(pid);
    expect(check.missing).toContain(id);
    expect(s.events.some((e) => e.name === 'service.notice' && e.data['kind'] === 'media-missing' && e.data['code'] === 'EM-1301')).toBe(true);
    const wrong = path.join(src, 'other.srt'); fs.writeFileSync(wrong, srt('Lain'));
    const bad = await s.api(`/projects/${pid}/assets/${id}/relocate`, { method: 'POST', headers: shell, json: { path: wrong } });
    expect(bad.status).toBe(422); expect((await json<{ error: { code: string } }>(bad)).error.code).toBe('EM-1302');
    const ok = await s.api(`/projects/${pid}/assets/${id}/relocate`, { method: 'POST', headers: shell, json: { path: path.join(src, 'm.srt') } });
    expect(ok.status).toBe(200);
    await ingestOf(s.ctx).idle();
    expect(await get(id)).toMatchObject({ missing: false, status: 'ready' });
  });
  it('a changed original is re-ingested in place with the new hash (EM-1302 notice)', async () => {
    const id = await importSrt('c.srt', 'Satu');
    const before = (await get(id)).sha256;
    fs.writeFileSync(originalOf(id), srt('Dua kalimat yang lebih panjang'));
    const check = await s.ctx.hooks.mediaCheck!(pid);
    expect(check.changed).toEqual([id]);
    await ingestOf(s.ctx).idle();
    const after = await get(id);
    expect(after.status).toBe('ready'); expect(after.sha256).not.toBe(before);
    expect(s.events.some((e) => e.name === 'service.notice' && e.data['kind'] === 'media-changed' && e.data['assetId'] === id)).toBe(true);
    expect((await s.ctx.hooks.mediaCheck!(pid)).changed).toEqual([]);          // unchanged now: no second re-ingest
  });
  it('failed cards stay listed for 24 h, then the listing removes them', async () => {
    row('01ARZ3NDEKTSV4RRFFQ69G5FB1', 'video', 'failed', { updatedAt: new Date(Date.now() - FAILED_TTL_MS - 60_000).toISOString() });
    row('01ARZ3NDEKTSV4RRFFQ69G5FB2', 'video', 'failed');
    const list = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets?status=failed`));
    expect(list.items.map((a) => a.id)).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FB2']);
    expect(fs.existsSync(path.join(s.ctx.paths.media, pid, '01ARZ3NDEKTSV4RRFFQ69G5FB1'))).toBe(false);
  });
  it('the DTO carries the codec label from the stored probe', async () => {
    row('01ARZ3NDEKTSV4RRFFQ69G5FB3', 'video', 'ready', { probe: JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac' }, { codec_type: 'video', codec_name: 'h264' }] }) });
    expect((await get('01ARZ3NDEKTSV4RRFFQ69G5FB3')).codec).toBe('H.264');
  });
  it('Insert: an image with asOverlay goes to the overlay at atMs; a video with atIndex goes after the selected clip', async () => {
    row('01ARZ3NDEKTSV4RRFFQ69G5FB4', 'video', 'ready'); row('01ARZ3NDEKTSV4RRFFQ69G5FB5', 'video', 'ready');
    row('01ARZ3NDEKTSV4RRFFQ69G5FB6', 'image', 'ready', { width: 400, height: 200 });
    const ins = (body: Record<string, unknown>) => s.api(`/projects/${pid}/assets/insert`, { method: 'POST', json: body }).then((r) => json<{ ops: Array<{ op: string; args: Record<string, unknown> }> }>(r));
    await ins({ assetIds: ['01ARZ3NDEKTSV4RRFFQ69G5FB4', '01ARZ3NDEKTSV4RRFFQ69G5FB3'], order: 'given' });
    const after = await ins({ assetIds: ['01ARZ3NDEKTSV4RRFFQ69G5FB5'], atIndex: 1 });
    expect(after.ops[0]).toMatchObject({ op: 'op:clip.insert', args: { atIndex: 1 } });
    expect(s.heads.get(pid)!.model.tracks.video.map((c) => c.assetId)).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FB4', '01ARZ3NDEKTSV4RRFFQ69G5FB5', '01ARZ3NDEKTSV4RRFFQ69G5FB3']);
    const img = await ins({ assetIds: ['01ARZ3NDEKTSV4RRFFQ69G5FB6'], asOverlay: true, atMs: 1200 });
    expect(img.ops[0]).toMatchObject({ op: 'op:overlay.addImage', args: { atMs: 1200 } });
    expect(s.heads.get(pid)!.model.tracks.overlay[0]).toMatchObject({ kind: 'image', timing: { atMs: 1200, durationMs: 5000 } });
  });
});
