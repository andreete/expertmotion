import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { mediaModule } from '../../src/modules/media.js';
import { ingestOf } from '../../src/s2/ingest.js';
import { WaveformReducer, decidePlayable, normalizeProbe, sniff } from '../../src/s2/probe.js';
import { tempDir } from '../helpers.js';
import { ffmpeg, hasFfmpeg, importDir, json, shell, startS2, wavBuffer, type S2Service } from './harness.js';

type Asset = { id: string; status: string; kind: string; errorCode: string | null; sequenceBadge: number | null; media: Record<string, boolean>; durationMs: number | null; width: number | null; hasAudio: boolean | null };

describe('assets: import guards, badges, insert, delete (no FFmpeg needed)', () => {
  let s: S2Service; let src: string; let pid: string;
  beforeAll(async () => {
    src = importDir();
    s = await startS2([health, createAssetsModule({ importRoots: () => [src] }), mediaModule]);
    pid = s.project();
  });
  afterAll(async () => { await s.close(); });

  it('paths[] needs the Shell caller header (T+S)', async () => {
    const r = await s.api(`/projects/${pid}/assets`, { method: 'POST', json: { paths: [path.join(src, 'x.mp4')] } });
    expect(r.status).toBe(403);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('EM-8005');
  });
  it('refuses paths outside the import roots, traversal and UNC paths with EM-1007', async () => {
    const outside = tempDir('em-outside-'); fs.writeFileSync(path.join(outside, 'a.mp4'), 'x');
    for (const p of [path.join(outside, 'a.mp4'), `${src}/../${path.basename(outside)}/a.mp4`, '\\\\server\\share\\a.mp4']) {
      const r = await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [p] } });
      expect(r.status, p).toBe(403);
      expect((await json<{ error: { code: string } }>(r)).error.code).toBe('EM-1007');
    }
    fs.symlinkSync(path.join(outside, 'a.mp4'), path.join(src, 'link.mp4'));
    const r = await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, 'link.mp4')] } });
    expect(r.status).toBe(403);
  });
  it('rejects wrong content (EM-1001), >50 paths (EM-1010) and multipart', async () => {
    fs.writeFileSync(path.join(src, 'notes.mp4'), 'this is text, not a video');
    const r = await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, 'notes.mp4')] } });
    expect(r.status).toBe(422); expect((await json<{ error: { code: string } }>(r)).error.code).toBe('EM-1001');
    const many = await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: Array.from({ length: 51 }, () => path.join(src, 'notes.mp4')) } });
    expect(many.status).toBe(413); expect((await json<{ error: { code: string } }>(many)).error.code).toBe('EM-1010');
    const mp = await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: '--x--' });
    expect(mp.status).toBe(400);
  });
  it('a mixed batch reports per-file notices', async () => {
    fs.writeFileSync(path.join(src, 'doc.docx'), 'PK');
    fs.writeFileSync(path.join(src, 'subs.srt'), '1\n00:00:00,000 --> 00:00:01,500\nHalo semua\n\n2\n00:00:01,500 --> 00:00:03,000\nApa kabar\n');
    const r = await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, 'doc.docx'), path.join(src, 'subs.srt')] } });
    expect(r.status).toBe(202);
    const body = await json<{ items: Asset[]; notices: Array<{ code: string }> }>(r);
    expect(body.items).toHaveLength(1); expect(body.notices[0]!.code).toBe('EM-1001');
    await ingestOf(s.ctx).idle();
    const a = await json<Asset>(await s.api(`/projects/${pid}/assets/${body.items[0]!.id}`));
    expect(a.status).toBe('ready'); expect(a.kind).toBe('subtitle');
    expect(s.ctx.hooks.assetFacts(pid).find((f) => f.id === a.id)?.captionPages?.length).toBeGreaterThan(0);
  });

  it('Sequence Badges are unique, contiguous and drive the Insert order; Insert applies one version and clears badges', async () => {
    const ids: string[] = [];
    for (const n of ['a', 'b', 'c']) {
      fs.writeFileSync(path.join(src, `s-${n}.srt`), `1\n00:00:00,000 --> 00:00:01,000\n${n}\n`);
      const r = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, `s-${n}.srt`)] } }));
      ids.push(r.items[0]!.id);
    }
    await ingestOf(s.ctx).idle();
    const badge = (id: string, b: number | null) => s.api(`/projects/${pid}/assets/${id}/sequence-badge`, { method: 'PUT', json: { badge: b } });
    await badge(ids[2]!, 1); await badge(ids[0]!, 2); await badge(ids[1]!, 3);              // C, A, B
    const shifted = await json<{ items: Asset[] }>(await badge(ids[1]!, 1));                // B to the front: B, C, A
    expect(shifted.items.length).toBe(3);
    const list = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets?kind=subtitle`));
    const order = (id: string) => list.items.find((a) => a.id === id)!.sequenceBadge;
    expect([order(ids[1]!), order(ids[2]!), order(ids[0]!)]).toEqual([1, 2, 3]);
    await badge(ids[2]!, null);
    const after = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets?kind=subtitle`));
    expect(after.items.find((a) => a.id === ids[0])!.sequenceBadge).toBe(2);              // renumbered
    const r = await s.api(`/projects/${pid}/assets/insert`, { method: 'POST', json: { assetIds: [ids[0]!, ids[1]!] } });
    expect(r.status).toBe(200);
    const ins = await json<{ ops: Array<{ op: string; args: { assetId: string } }>; version: { id: string } }>(r);
    expect(ins.ops.map((o) => o.args.assetId)).toEqual([ids[1], ids[0]]);
    expect(ins.ops[0]!.op).toBe('op:caption.importSrt');
    expect(s.heads.get(pid)!.versionId).toBe(ins.version.id);
    const cleared = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets?kind=subtitle`));
    expect(cleared.items.every((a) => a.sequenceBadge === null)).toBe(true);
  });
  it('pagination, 404 and validation', async () => {
    const p1 = await json<{ items: Asset[]; nextCursor: string | null; total: number }>(await s.api(`/projects/${pid}/assets?limit=2`));
    expect(p1.items).toHaveLength(2); expect(p1.nextCursor).not.toBeNull();
    const p2 = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets?limit=2&cursor=${p1.nextCursor}`));
    expect(p2.items[0]!.id).not.toBe(p1.items[0]!.id);
    expect((await s.api(`/projects/${pid}/assets/01ARZ3NDEKTSV4RRFFQ69G5FAV`)).status).toBe(404);
    expect((await s.api(`/projects/${pid}/assets/..%2F..`)).status).toBe(400);
    expect((await s.api('/projects/01ARZ3NDEKTSV4RRFFQ69G5FAV/assets')).status).toBe(404);
  });
  it('a dev raw upload dedupes by sha256 (EM-1006) and production refuses it', async () => {
    const body = fs.readFileSync(path.join(src, 's-a.srt'));
    const up = () => s.api(`/projects/${pid}/assets`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Expertmotion-Filename': encodeURIComponent('ulang a.srt') }, body });
    const r = await json<{ items: Asset[]; notices: Array<{ code: string }> }>(await up());
    expect(r.notices[0]?.code).toBe('EM-1006');
    s.cfg.dev = false;
    expect((await up()).status).toBe(403);
    s.cfg.dev = true;
  });
  it('restart recovery: a half-copied ingest fails with EM-1201', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAZ'; const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, status, created_at, updated_at) VALUES (?,?,'video','x.mp4',?,1,?,'ingesting',?,?)")
      .run(id, pid, `pending-${id}`, `${pid}/${id}/original.mp4`, now, now);
    const r = ingestOf(s.ctx).recover();
    expect(r.failed).toContain(id);
    expect((s.ctx.db.prepare('SELECT error_code FROM assets WHERE id = ?').get(id) as { error_code: string }).error_code).toBe('EM-1201');
  });
});

describe.skipIf(!hasFfmpeg)('assets: real ingest with the slim FFmpeg', () => {
  let s: S2Service; let src: string; let pid: string;
  beforeAll(async () => {
    src = importDir();
    ffmpeg(['-i', path.join(src, 'clip-a.mp4'), '-frames:v', '1', path.join(src, 'still.png')]);
    fs.writeFileSync(path.join(src, 'tone.wav'), wavBuffer(1500));
    const good = fs.readFileSync(path.join(src, 'clip-a.mp4'));
    fs.writeFileSync(path.join(src, 'broken.mp4'), Buffer.concat([good.subarray(0, 32), Buffer.alloc(4096, 7)]));
    s = await startS2([health, createAssetsModule({ importRoots: () => [src] }), mediaModule]);
    pid = s.project();
  });
  afterAll(async () => { await s.close(); });

  it('video, image and audio reach ready with probe facts and variants; events stream progress', async () => {
    const r = await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: ['clip-a-audio.mp4', 'still.png', 'tone.wav'].map((f) => path.join(src, f)) } });
    expect(r.status).toBe(202);
    const { items } = await json<{ items: Asset[] }>(r);
    expect(items.map((i) => i.status)).toEqual(['ingesting', 'ingesting', 'ingesting']);
    await ingestOf(s.ctx).idle();
    const [v, img, aud] = await Promise.all(items.map(async (i) => json<Asset>(await s.api(`/projects/${pid}/assets/${i.id}`))));
    expect(v!.status).toBe('ready'); expect(v!.kind).toBe('video'); expect(v!.hasAudio).toBe(true); expect(v!.durationMs).toBeGreaterThan(3000);
    expect(v!.media).toMatchObject({ playable: true, proxy: true, thumb: true, waveform: true });
    expect(img!.status).toBe('ready'); expect(img!.media).toMatchObject({ proxy: true, thumb: true }); expect(img!.durationMs).toBe(5000);
    expect(aud!.status).toBe('ready'); expect(aud!.media.waveform).toBe(true);
    const wave = JSON.parse(fs.readFileSync(path.join(s.ctx.paths.media, pid, aud!.id, 'wave.json'), 'utf8')) as { peaks: number[]; lengthMs: number };
    expect(Math.abs(wave.lengthMs - 1500)).toBeLessThan(50); expect(wave.peaks.length).toBe(Math.round(wave.lengthMs / 10));   // AAC priming adds a few ms expect(Math.max(...wave.peaks)).toBeGreaterThan(50);
    expect(s.events.some((e) => e.name === 'ingest.progress' && e.data['assetId'] === v!.id)).toBe(true);
    expect(s.events.filter((e) => e.name === 'ingest.done').length).toBe(3);
    // derived files carry no source metadata; original is byte-identical
    expect(fs.readFileSync(path.join(s.ctx.paths.media, pid, v!.id, 'original.mp4')).equals(fs.readFileSync(path.join(src, 'clip-a-audio.mp4')))).toBe(true);
  });
  it('re-importing the same file is a duplicate (EM-1006), not a new asset', async () => {
    const before = (s.ctx.db.prepare('SELECT count(*) AS n FROM assets').get() as { n: number }).n;
    await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, 'clip-a-audio.mp4')] } });
    await ingestOf(s.ctx).idle();
    expect((s.ctx.db.prepare('SELECT count(*) AS n FROM assets').get() as { n: number }).n).toBe(before);
    expect(s.events.some((e) => e.name === 'ingest.failed' && e.data['code'] === 'EM-1006')).toBe(true);
  });
  it('an unreadable file fails with EM-1003 and keeps the service alive', async () => {
    const r = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, 'broken.mp4')] } }));
    await ingestOf(s.ctx).idle();
    const a = await json<Asset>(await s.api(`/projects/${pid}/assets/${r.items[0]!.id}`));
    expect(a.status).toBe('failed'); expect(a.errorCode).toBe('EM-1003');
    expect((await s.api('/health', { auth: false })).status).toBe(200);
  });
  it('Insert of a ready video builds op:clip.insert and sets the auto ratio; delete with references needs confirm', async () => {
    const list = await json<{ items: Asset[] }>(await s.api(`/projects/${pid}/assets?kind=video&status=ready`));
    const v = list.items[0]!;
    const ins = await s.api(`/projects/${pid}/assets/insert`, { method: 'POST', json: { assetIds: [v.id] } });
    expect(ins.status).toBe(200);
    expect(s.heads.get(pid)!.model.tracks.video[0]!.assetId).toBe(v.id);
    const del = await s.api(`/projects/${pid}/assets/${v.id}`, { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect((await json<{ error: { code: string; details: { clips: number } } }>(del)).error).toMatchObject({ code: 'EM-1101', details: { clips: 1 } });
    const ok = await s.api(`/projects/${pid}/assets/${v.id}?confirm=true`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(s.heads.get(pid)!.model.tracks.video).toHaveLength(0);
    expect(fs.existsSync(path.join(s.ctx.paths.media, pid, v.id))).toBe(false);
  });
});

describe('probe helpers', () => {
  it('sniffs magic bytes and decides the playable copy', () => {
    expect(sniff(Buffer.from('\0\0\0\x20ftypisom', 'latin1'))).toBe('isobmff');
    expect(sniff(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))).toBe('png');
    expect(sniff(Buffer.from([0, 1, 2, 3]))).toBeNull();
    const f = normalizeProbe('video', { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '4.0' }, streams: [
      { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, avg_frame_rate: '30/1', r_frame_rate: '30/1', side_data_list: [{ rotation: -90 }] },
      { codec_type: 'audio', codec_name: 'aac', channels: 2 }] });
    expect([f.width, f.height, f.rotated, f.fps]).toEqual([1080, 1920, true, 30]);
    expect(decidePlayable(f, true)).toBe('original');
    expect(decidePlayable(f, false)).toBe('remux');
    expect(decidePlayable({ ...f, codec: 'hevc' }, true)).toBe('transcode');
    expect(decidePlayable({ ...f, vfr: true }, true)).toBe('transcode');
  });
  it('waveform reducer skips the WAV header and yields 100 peaks per second', () => {
    const red = new WaveformReducer(8000, 80);
    const buf = wavBuffer(1000, 440, 8000);
    for (let i = 0; i < buf.length; i += 333) red.push(buf.subarray(i, i + 333));   // odd chunking
    const w = red.finish();
    expect(w.peaks.length).toBe(100); expect(w.lengthMs).toBe(1000);
  });
});
