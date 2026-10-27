import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@expertmotion/shared';
import { calculateMetadata } from '@expertmotion/engine/metadata';
import type { EngineInputProps } from '@expertmotion/engine';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { mediaModule } from '../../src/modules/media.js';
import { createRendersModule } from '../../src/modules/renders.js';
import { defaultFileStem, failedFrameOf, gifPaletteArgs, modelHasAudio, probeMismatch, renderServiceOf, type RendererLike } from '../../src/s2/render-service.js';
import { engineStatus, verifyBundleHash } from '../../src/s2/engine-check.js';
import type { ServiceContext } from '../../src/context.js';
import { tempDir } from '../helpers.js';
import { json, startS2, type S2Service } from './harness.js';

type Job = { id: string; status: string; errorCode: string | null; outputId: string | null; width: number; height: number; notices?: string[]; notice?: string; outputProfile: { resolution: string } };

/** Fake @remotion/renderer: progress ticks, honours the cancel signal, writes the output file; records concurrency and inputs. */
function fakeRenderer(behaviour: { mode: 'ok' | 'fail' | 'fail-frame' | 'hang' | 'compose-fail'; steps?: number; stepMs?: number }) {
  const seen = { running: 0, maxRunning: 0, calls: [] as Array<Record<string, unknown>>, mediaStatus: [] as number[] };
  const r: RendererLike = {
    makeCancelSignal() {
      const sig = { cancelled: false, fns: [] as Array<() => void> };
      return { cancelSignal: sig, cancel: () => { sig.cancelled = true; sig.fns.forEach((f) => f()); } };
    },
    async selectComposition(o) {
      if (behaviour.mode === 'compose-fail') throw new Error('browser could not launch');
      const m = calculateMetadata({ props: o['inputProps'] as EngineInputProps });
      return { id: 'ExpertmotionTimeline', width: m.width, height: m.height, fps: m.fps, durationInFrames: m.durationInFrames };
    },
    async renderMedia(o) {
      seen.calls.push(o); seen.running++; seen.maxRunning = Math.max(seen.maxRunning, seen.running);
      const sig = o['cancelSignal'] as { cancelled: boolean; fns: Array<() => void> };
      try {
        const assets = (o['inputProps'] as EngineInputProps).assets;
        for (const a of Object.values(assets)) seen.mediaStatus.push((await fetch(a.playable)).status);   // the render grant works during the job
        const steps = behaviour.steps ?? 4;
        for (let i = 1; i <= steps; i++) {
          await new Promise<void>((res, rej) => { const t = setTimeout(res, behaviour.stepMs ?? 30); sig.fns.push(() => { clearTimeout(t); rej(new Error('renderMedia() got cancelled')); }); });
          if (behaviour.mode === 'hang') { await new Promise<void>((_res, rej) => sig.fns.push(() => rej(new Error('cancelled')))); }
          (o['onProgress'] as (p: { progress: number; renderedFrames: number }) => void)({ progress: i / steps, renderedFrames: i * 10 });
        }
        if (behaviour.mode === 'fail') throw new Error('Chrome crashed');
        if (behaviour.mode === 'fail-frame') throw new Error('Error while rendering frame 13: Target closed');
        fs.writeFileSync(o['outputLocation'] as string, crypto.randomBytes(2048));
      } finally { seen.running--; }
    },
    async renderStill(o) { fs.writeFileSync(o['output'] as string, crypto.randomBytes(512)); },
  };
  return { r, seen };
}

const profile = { ratio: '9:16', resolution: '1080p', fps: 30, format: 'mp4', alpha: false };

describe('renders (R-110…R-119) with a fake renderer', () => {
  let s: S2Service; let pid: string; let assetId: string; let mem = 8e9;
  let fake = fakeRenderer({ mode: 'ok' });
  const bundle = tempDir('em-bundle-');
  beforeAll(async () => {
    fs.writeFileSync(path.join(bundle, 'index.html'), '<html></html>');
    s = await startS2([health, createAssetsModule(), mediaModule, createRendersModule({ renderer: async () => fake.r, freeMemBytes: () => mem, remotionPort: async () => 4131, stallMs: 300, maxStartsPerMinute: 100, acceptUnvalidated: true })]);
    s.ctx.resources.engineBundle = bundle;
    s.ctx.resources.ffprobe = '/nonexistent/ffprobe'; s.ctx.resources.ffmpeg = '/nonexistent/ffmpeg';
    pid = s.project();
    assetId = newId(); const now = new Date().toISOString();
    fs.mkdirSync(path.join(s.ctx.paths.media, pid, assetId), { recursive: true });
    fs.writeFileSync(path.join(s.ctx.paths.media, pid, assetId, 'original.mp4'), 'video');
    s.ctx.db.prepare(`INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, playable_path, duration_ms, width, height, has_audio, status, created_at, updated_at)
      VALUES (?,?,'video','kopi.mp4','h',5,?,?,4000,1080,1920,0,'ready',?,?)`).run(assetId, pid, `${pid}/${assetId}/original.mp4`, `${pid}/${assetId}/original.mp4`, now, now);
    s.ctx.hooks.applyOps(pid, [{ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId } }], { kind: 'system', summary: 'seed' });
  });
  afterAll(async () => { await s.close(); });
  const create = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    s.api('/renders', { method: 'POST', headers, json: { projectId: pid, outputProfile: profile, performanceProfile: 'standard', ...body } });
  const waitFinal = (id: string) => s.waitEvent((e) => ['render.done', 'render.failed', 'render.cancelled'].includes(e.name) && e.data['jobId'] === id);

  it('estimate reports pixels, frames and all checks; memory below the gate is reported, never 4xx', async () => {
    const r = await json<{ ok: boolean; dimensions: { width: number; height: number }; totalFrames: number; checks: Array<{ check: string; ok: boolean; code?: string }>; estimate: { bytes: number } }>(
      await s.api('/renders/estimate', { method: 'POST', json: { projectId: pid, outputProfile: profile, performanceProfile: 'standard' } }));
    expect(r.ok).toBe(true); expect(r.dimensions).toEqual({ width: 1080, height: 1920 }); expect(r.totalFrames).toBe(120);
    expect(r.checks.map((c) => c.check).sort()).toEqual(['assets', 'dimensions', 'disk', 'duration', 'engine', 'folder', 'memory']);
    expect(r.estimate.bytes).toBeGreaterThan(0);
    mem = 1e9;
    const low = await s.api('/renders/estimate', { method: 'POST', json: { projectId: pid, outputProfile: profile, performanceProfile: 'standard' } });
    expect(low.status).toBe(200);
    const lowBody = await json<{ ok: boolean; checks: Array<{ check: string; ok: boolean; code?: string }> }>(low);
    // FR-204: low memory is an info note (EM-3107), never a block; the job waits and then runs in low-memory mode.
    expect(lowBody.ok).toBe(true);
    expect(lowBody.checks.find((c) => c.check === 'memory')).toMatchObject({ ok: true, code: 'EM-3107' });
    mem = 8e9;
    expect((await s.api('/renders/estimate', { method: 'POST', json: { projectId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', outputProfile: profile, performanceProfile: 'standard' } })).status).toBe(404);
  });

  it('queue runs one job at a time, emits progress and done, writes an Output; the render grant dies with the job', async () => {
    fake = fakeRenderer({ mode: 'ok', steps: 4, stepMs: 40 });
    const a = await json<Job>(await create());
    const bRes = await create();
    expect(bRes.status).toBe(202);
    const b = await json<Job>(bRes);
    expect(a.status).toBe('queued'); expect(b.notices).toContain('EM-3208');
    await waitFinal(a.id); await waitFinal(b.id);
    expect(fake.seen.maxRunning).toBe(1);
    expect(fake.seen.mediaStatus.every((st) => st === 200)).toBe(true);
    const done = await json<Job>(await s.api(`/renders/${a.id}`));
    expect(done.status).toBe('done'); expect(done.outputId).toBeTruthy();
    expect(s.events.some((e) => e.name === 'render.progress' && e.data['jobId'] === a.id)).toBe(true);
    const url = (fake.seen.calls[0]!['inputProps'] as EngineInputProps).assets[assetId]!.playable;
    expect((await fetch(url)).status).toBe(404);                                                  // grant revoked after the final event
    expect(s.ctx.mediaOrigins.size).toBe(0);
    expect(fake.seen.calls[0]!['port']).toBe(4131);
    const out = await json<{ path: string; fileName: string; validated: boolean; watermarked?: boolean; width: number }>(await s.api(`/outputs/${done.outputId}`));
    expect(out.fileName).toMatch(/^Promo-Kopi-9x16-1080p-.*\.mp4$/); expect(out.width).toBe(1080); expect(out.validated).toBe(false); expect(out.watermarked).toBeUndefined();
    expect(fs.existsSync(out.path)).toBe(true);
    const rev = await json<{ path: string; folder: string }>(await s.api(`/outputs/${done.outputId}/reveal`, { method: 'POST' }));
    expect(rev.path).toBe(out.path);
    const list = await json<{ items: unknown[] }>(await s.api(`/projects/${pid}/outputs`));
    expect(list.items.length).toBe(2);
    expect((await s.api(`/outputs/${done.outputId}`, { method: 'DELETE' })).status).toBe(204);
    expect(fs.existsSync(out.path)).toBe(false);
    const jobs = await json<{ items: Job[]; total: number }>(await s.api(`/renders?projectId=${pid}&status=done`));
    expect(jobs.total).toBe(2);
  });

  it('per-job SSE sends the current state, then the job events, and closes after the final event', async () => {
    fake = fakeRenderer({ mode: 'ok', steps: 3, stepMs: 40 });
    const j = await json<Job>(await create());
    const r = await fetch(`${s.base}/api/v1/renders/${j.id}/events?token=${s.token}`);
    expect(r.status).toBe(200);
    const text = await r.text();                                                                   // resolves only because the stream closes
    expect(text).toMatch(/event: render\.(queued|progress)/); expect(text).toContain('event: render.done');
    expect((await fetch(`${s.base}/api/v1/renders/01ARZ3NDEKTSV4RRFFQ69G5FAV/events?token=${s.token}`)).status).toBe(404);
  });

  it('cancel: a queued job is cancelled at once, a rendering job stops and leaves no file', async () => {
    fake = fakeRenderer({ mode: 'ok', steps: 20, stepMs: 50 });
    const a = await json<Job>(await create({ fileName: 'cancel-me' }));
    const b = await json<Job>(await create());
    const cb = await json<Job>(await s.api(`/renders/${b.id}/cancel`, { method: 'POST' }));
    expect(cb.status).toBe('cancelled');
    await s.waitEvent((e) => e.name === 'render.progress' && e.data['jobId'] === a.id && Number(e.data['progress']) > 0);
    await s.api(`/renders/${a.id}/cancel`, { method: 'POST' });
    await waitFinal(a.id);
    expect((await json<Job>(await s.api(`/renders/${a.id}`))).status).toBe('cancelled');
    expect(fs.existsSync(path.join(s.ctx.paths.outputs, pid, 'cancel-me.mp4'))).toBe(false);
    expect(fs.readdirSync(s.ctx.paths.tmp).filter((d) => d.startsWith('render-'))).toEqual([]);
    const again = await json<Job>(await s.api(`/renders/${a.id}/cancel`, { method: 'POST' }));
    expect(again.status).toBe('cancelled');
  });

  it('failures map to EM-3201 (render), EM-3002 (browser) and EM-3207 (stall)', async () => {
    // FR-143: the failure frame comes from the renderer error, else the last progress report; none before rendering starts.
    for (const [mode, code, frame] of [['fail', 'EM-3201', 20], ['fail-frame', 'EM-3201', 13], ['compose-fail', 'EM-3002', null], ['hang', 'EM-3207', null]] as const) {
      fake = fakeRenderer({ mode, steps: 2, stepMs: 20 });
      const j = await json<Job>(await create());
      const ev = await waitFinal(j.id);
      expect(ev.name).toBe('render.failed'); expect(ev.data['code']).toBe(code); expect(ev.data['frame'], mode).toBe(frame);
      expect((await json<Job & { failedFrame: number | null }>(await s.api(`/renders/${j.id}`))).failedFrame, mode).toBe(frame);
    }
    expect(failedFrameOf(Object.assign(new Error('x'), { frame: 7 }), 3)).toBe(7);
    expect(failedFrameOf(new Error('no frame info'), null)).toBeNull();
    expect((await s.api('/health', { auth: false })).status).toBe(200);
  });

  it('Idempotency-Key returns the first job with EM-2308; exports keep the chosen resolution and never carry a watermark', async () => {
    fake = fakeRenderer({ mode: 'ok', steps: 1, stepMs: 5 });
    const first = await json<Job>(await create({}, { 'Idempotency-Key': 'export-1' }));
    const second = await create({}, { 'Idempotency-Key': 'export-1' });
    expect(second.status).toBe(200);
    const sj = await json<Job>(second);
    expect(sj.id).toBe(first.id); expect(sj.notice).toBe('EM-2308');
    await waitFinal(first.id);
    const t = await json<Job>(await create());
    expect(t.outputProfile.resolution).toBe('1080p'); expect(t.notices ?? []).not.toContain('EM-5001'); expect(t.width).toBe(1080);
    await waitFinal(t.id);
    const props = fake.seen.calls.at(-1)!['inputProps'] as EngineInputProps & { watermark?: unknown };
    expect(props.quality).toBe('full'); expect('watermark' in props).toBe(false);
  });

  it('estimate returns the default filename, Private Mode and queue facts; GIF is capped to 720p with a note', async () => {
    const r = await json<{ defaultFileName: string; privateMode: boolean; queue: { active: string | null; queued: number } }>(await s.api('/renders/estimate', { method: 'POST', json: { projectId: pid, outputProfile: profile, performanceProfile: 'standard' } }));
    expect(r.defaultFileName).toMatch(/^Promo-Kopi-9x16-1080p-\d{8}-\d{4}$/); expect(r.privateMode).toBe(false); expect(r.queue).toEqual({ active: null, queued: 0 });
    const g = await json<{ effectiveProfile: { resolution: string }; warnings: Array<{ code: string }> }>(await s.api('/renders/estimate', { method: 'POST', json: { projectId: pid, outputProfile: { ...profile, format: 'gif' }, performanceProfile: 'standard' } }));
    expect(g.effectiveProfile.resolution).toBe('720p'); expect(g.warnings.map((w) => w.code)).toContain('EM-3103');
  });

  it('FR-138: transparent WebM needs background None (EM-9002 with a reason), allowed once the background is None', async () => {
    const webm = { ...profile, format: 'webm', codec: 'vp9', alpha: true };
    s.ctx.hooks.applyOps(pid, [{ op: 'op:background.set', target: { kind: 'project' }, args: { presetId: 'preset:background.gradient' } }], { kind: 'system', summary: 'bg' });
    const bad = await s.api('/renders/estimate', { method: 'POST', json: { projectId: pid, outputProfile: webm, performanceProfile: 'standard' } });
    expect(bad.status).toBe(422);
    expect((await json<{ error: { code: string; details: { reason: string } } }>(bad)).error).toMatchObject({ code: 'EM-9002', details: { reason: 'alpha-needs-background-none' } });
    s.ctx.hooks.applyOps(pid, [{ op: 'op:background.set', target: { kind: 'project' }, args: { presetId: 'preset:background.none' } }], { kind: 'system', summary: 'bg none' });
    expect((await s.api('/renders/estimate', { method: 'POST', json: { projectId: pid, outputProfile: webm, performanceProfile: 'standard' } })).status).toBe(200);
    s.ctx.hooks.applyOps(pid, [{ op: 'op:background.clear', target: { kind: 'project' }, args: {} }], { kind: 'system', summary: 'bg clear' });
  });

  it('blocking preflight: engine missing → 503 EM-3001; folder outside the profile → 403 EM-8302; no clips → EM-2202', async () => {
    s.ctx.resources.engineBundle = path.join(bundle, 'missing');
    const r = await create();
    expect(r.status).toBe(503); expect((await json<{ error: { code: string } }>(r)).error.code).toBe('EM-3001');
    s.ctx.resources.engineBundle = bundle;
    const f = await create({ folder: '/etc' });
    expect(f.status).toBe(403); expect((await json<{ error: { code: string } }>(f)).error.code).toBe('EM-8302');
    const pre = await json<{ ok: boolean; checks: Array<{ check: string; code?: string }> }>(await s.api('/renders/estimate', { method: 'POST', json: { projectId: pid, outputProfile: profile, performanceProfile: 'standard', folder: '/etc' } }));
    expect(pre.ok).toBe(false); expect(pre.checks.find((c) => c.check === 'folder')!.code).toBe('EM-8302');
    const empty = s.project('Kosong');
    const e = await s.api('/renders', { method: 'POST', json: { projectId: empty, outputProfile: profile, performanceProfile: 'standard' } });
    expect((await json<{ error: { code: string } }>(e)).error.code).toBe('EM-2202');
  });
});

describe('export defaults and engine checks (FR-137, FR-138, FR-140, FR-147)', () => {
  it('default filename is <project>-<ratio>-<res>-<yyyymmdd-hhmm>', () => {
    expect(defaultFileStem('Promo Kopi', { ratio: '9:16', resolution: '1080p' }, new Date(2026, 9, 24, 7, 5, 59))).toBe('Promo-Kopi-9x16-1080p-20261024-0705');
    expect(defaultFileStem('a/b:c', { ratio: 'custom', resolution: '720p' }, new Date(2026, 0, 2, 3, 4))).toMatch(/^a.b.c-custom-720p-20260102-0304$/);
  });
  it('GIF uses palette generation, ≤ 15 fps and an endless loop', () => {
    const a = gifPaletteArgs('in.mp4', 'out.gif', 30);
    expect(a.join(' ')).toContain('-r 15'); expect(a.join(' ')).toContain('palettegen'); expect(a.join(' ')).toContain('paletteuse');
    expect(a.slice(-3)).toEqual(['-loop', '0', 'out.gif']);
    expect(gifPaletteArgs('i', 'o', 12).join(' ')).toContain('-r 12');
  });
  const fakeCtx = (root: string, over: Partial<ServiceContext['resources']> = {}) => ({
    resources: { engineBundle: path.join(root, 'engine', 'bundle'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', loopsDir: '', licenseDir: '', enginesDir: '', sampleDir: '', ...over },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }) as unknown as ServiceContext;
  it('bundle hash: ok against the manifest, EM-3003 when a file changed, EM-3001 when the compositor FFmpeg is missing', async () => {
    const root = tempDir('em-res-'); const b = path.join(root, 'engine', 'bundle'); fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(b, 'index.html'), '<html></html>'); fs.writeFileSync(path.join(b, 'a.js'), 'console.log(1)');
    const entry = (f: string) => { const d = fs.readFileSync(path.join(b, f)); return { path: `engine/bundle/${f}`, size: d.length, sha256: crypto.createHash('sha256').update(d).digest('hex') }; };
    fs.writeFileSync(path.join(root, 'engine-manifest.json'), JSON.stringify({ files: [entry('index.html'), entry('a.js')] }));
    expect(await verifyBundleHash(fakeCtx(root))).toEqual({ hash: 'ok', mismatched: [] });
    const comp = path.join(root, 'compositor'); fs.mkdirSync(comp);
    const ok = await engineStatus(fakeCtx(root, { binariesDirectory: comp }));
    expect(ok).toMatchObject({ ok: false, code: 'EM-3001', missing: ['ffmpeg'] });
    fs.writeFileSync(path.join(comp, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), '');
    expect(await engineStatus(fakeCtx(root, { binariesDirectory: comp }))).toMatchObject({ ok: true, bundleHash: 'ok' });
    fs.writeFileSync(path.join(b, 'a.js'), 'console.log(2)');
    const bad = await engineStatus(fakeCtx(root));
    expect(bad).toMatchObject({ ok: false, code: 'EM-3003', bundleHash: 'mismatch', mismatched: ['engine/bundle/a.js'] });
  });
});

describe('render recovery on start', () => {
  it('jobs left queued/rendering by a crash are failed with EM-3203', async () => {
    const dataDir = tempDir(); const dbKeyHex = crypto.randomBytes(32).toString('hex');
    const a = await startS2([health, createRendersModule()], { dataDir, cfg: { dbKeyHex } });
    const pid = a.project(); const id = newId();
    a.ctx.db.prepare("INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, rendered_frames, created_at) VALUES (?,?,?,?,'standard','rendering',42,?)")
      .run(id, pid, a.heads.get(pid)!.versionId, JSON.stringify(profile), new Date().toISOString());
    fs.mkdirSync(path.join(a.ctx.paths.tmp, `render-${id}`));
    await a.close();
    const b = await startS2([health, createRendersModule()], { dataDir, cfg: { dbKeyHex } });
    const j = await json<Job>(await b.api(`/renders/${id}`));
    expect(j.status).toBe('failed'); expect(j.errorCode).toBe('EM-3203');
    expect((j as Job & { failedFrame: number | null }).failedFrame).toBe(42);                            // FR-143: last frame reported before the crash
    expect(fs.existsSync(path.join(b.ctx.paths.tmp, `render-${id}`))).toBe(false);
    await b.close();
    void renderServiceOf;
  });
});

describe('output validation with ffprobe (FR-145, SEC-068)', () => {
  const exp = { format: 'mp4' as const, width: 1080, height: 1350, fps: 30, durationMs: 4000, audio: true };
  const probe = (o: { w?: number; h?: number; fps?: string; dur?: string; audio?: boolean } = {}) => ({
    streams: [{ codec_type: 'video', width: o.w ?? 1080, height: o.h ?? 1350, avg_frame_rate: o.fps ?? '30/1', r_frame_rate: o.fps ?? '30/1' }, ...(o.audio === false ? [] : [{ codec_type: 'audio' }])],
    format: { duration: o.dur ?? '4.010' } });
  it('checks dimensions, duration ± 1 frame, fps and audio presence', () => {
    expect(probeMismatch(probe(), exp)).toBeNull();
    expect(probeMismatch(probe({ dur: '4.060' }), exp)).toBeNull();                         // within 1 frame + 50 ms slack
    expect(probeMismatch(probe({ h: 1080 }), exp)).toMatch(/^dimensions:/);
    expect(probeMismatch(probe({ dur: '4.2' }), exp)).toMatch(/^duration:/);
    expect(probeMismatch(probe({ fps: '25/1' }), exp)).toBe('fps: expected 30, got 25');
    expect(probeMismatch(probe({ fps: '30000/1001' }), exp)).toMatch(/^fps:/);
    expect(probeMismatch(probe({ audio: false }), exp)).toMatch(/^audio:/);
    expect(probeMismatch(probe({ audio: false }), { ...exp, audio: false })).toBeNull();     // silent model: no audio stream needed
    expect(probeMismatch(probe({ fps: '10/1', audio: false }), { ...exp, format: 'gif' })).toBeNull();   // GIF: fps capped, no audio
  });
  it('the model has audio when an audio layer or an unmuted clip of an asset with audio plays', () => {
    const base = { tracks: { audio: [] as Array<{ volume: number }>, video: [{ assetId: 'a', muted: false, volume: 1 }] } } as unknown as Parameters<typeof modelHasAudio>[0];
    expect(modelHasAudio(base, () => true)).toBe(true);
    expect(modelHasAudio(base, () => false)).toBe(false);
    const muted = { tracks: { audio: [], video: [{ assetId: 'a', muted: true, volume: 1 }] } } as unknown as Parameters<typeof modelHasAudio>[0];
    expect(modelHasAudio(muted, () => true)).toBe(false);
    const bed = { tracks: { audio: [{ volume: 0.5 }], video: [] } } as unknown as Parameters<typeof modelHasAudio>[0];
    expect(modelHasAudio(bed, () => false)).toBe(true);
  });
  it('a missing ffprobe fails the job with EM-3205 and keeps the file (no acceptUnvalidated)', async () => {
    const fake = fakeRenderer({ mode: 'ok', steps: 2, stepMs: 10 });
    const s = await startS2([health, createAssetsModule(), mediaModule, createRendersModule({ renderer: async () => fake.r, freeMemBytes: () => 8e9, remotionPort: async () => 4132, maxStartsPerMinute: 100 })]);
    try {
      const bundle = tempDir('em-bundle-'); fs.writeFileSync(path.join(bundle, 'index.html'), '<html></html>');
      s.ctx.resources.engineBundle = bundle; s.ctx.resources.ffprobe = '/nonexistent/ffprobe'; s.ctx.resources.ffmpeg = '/nonexistent/ffmpeg';
      const pid = s.project(); const assetId = newId(); const now = new Date().toISOString();
      fs.mkdirSync(path.join(s.ctx.paths.media, pid, assetId), { recursive: true });
      fs.writeFileSync(path.join(s.ctx.paths.media, pid, assetId, 'original.mp4'), 'video');
      s.ctx.db.prepare(`INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, playable_path, duration_ms, width, height, has_audio, status, created_at, updated_at)
        VALUES (?,?,'video','kopi.mp4','h',5,?,?,4000,1080,1920,0,'ready',?,?)`).run(assetId, pid, `${pid}/${assetId}/original.mp4`, `${pid}/${assetId}/original.mp4`, now, now);
      s.ctx.hooks.applyOps(pid, [{ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId } }], { kind: 'system', summary: 'seed' });
      const job = await json<Job>(await s.api('/renders', { method: 'POST', json: { projectId: pid, outputProfile: profile, performanceProfile: 'standard' } }));
      const ev = await s.waitEvent((e) => ['render.done', 'render.failed'].includes(e.name) && e.data['jobId'] === job.id);
      expect(ev.name).toBe('render.failed');
      expect((await json<Job>(await s.api(`/renders/${job.id}`))).errorCode).toBe('EM-3205');
      expect(fs.existsSync(path.join(s.ctx.paths.outputs, '_failed', `${job.id}.mp4`))).toBe(true);
    } finally { await s.close(); }
  });
});

describe('low free memory never blocks an export (FR-204, QA 2026-10-27)', () => {
  let s: S2Service; let pid: string; let mem = 5e8;
  const fake = fakeRenderer({ mode: 'ok', steps: 2, stepMs: 10 });
  const bundle = tempDir('em-bundle-lowmem-');
  beforeAll(async () => {
    fs.writeFileSync(path.join(bundle, 'index.html'), '<html></html>');
    s = await startS2([health, createAssetsModule(), mediaModule, createRendersModule({ renderer: async () => fake.r, freeMemBytes: () => mem, remotionPort: async () => 4133, maxStartsPerMinute: 100, acceptUnvalidated: true, lowMemWaitMs: 300, lowMemPollMs: 20 })]);
    s.ctx.resources.engineBundle = bundle;
    s.ctx.resources.ffprobe = '/nonexistent/ffprobe'; s.ctx.resources.ffmpeg = '/nonexistent/ffmpeg';
    pid = s.project();
    s.ctx.hooks.applyOps(pid, [{ op: 'op:text.add', target: { kind: 'sequence' }, args: { text: 'Halo', variant: 'preset:text.title', atMs: 0, durationMs: 2000 } }], { kind: 'system', summary: 'seed' });
  });
  afterAll(async () => { await s.close(); });
  const p720 = { ratio: '16:9', resolution: '720p', fps: 30, format: 'mp4', alpha: false };
  const create = async () => json<Job>(await s.api('/renders', { method: 'POST', json: { projectId: pid, outputProfile: p720, performanceProfile: 'standard' } }));
  const waitFinal = (id: string) => s.waitEvent((e) => ['render.done', 'render.failed', 'render.cancelled'].includes(e.name) && e.data['jobId'] === id);

  it('0.5 GB free: the job is accepted, waits with EM-3107, then renders in low-memory mode (concurrency 1, small cache)', async () => {
    mem = 5e8;
    const j = await create();
    expect(j.status).toBe('queued');
    const fin = await waitFinal(j.id);
    expect(fin.name).toBe('render.done');
    expect(s.events.some((e) => e.name === 'render.queued' && e.data['jobId'] === j.id && ((e.data['job'] as Job).notices ?? []).includes('EM-3107'))).toBe(true);
    const call = fake.seen.calls.at(-1)!;
    expect(call['concurrency']).toBe(1); expect(call['offthreadVideoCacheSizeInBytes']).toBe(64 * 1024 ** 2);
  });
  it('memory that frees up while waiting starts the job normally', async () => {
    mem = 5e8;
    const j = await create();
    setTimeout(() => { mem = 8e9; }, 60);
    expect((await waitFinal(j.id)).name).toBe('render.done');
    expect(fake.seen.calls.at(-1)!['offthreadVideoCacheSizeInBytes']).toBe(256 * 1024 ** 2);
  });
  it('below the 300 MB floor after the wait: failed with EM-3108 (close other programs), never a hang', async () => {
    mem = 1e8;
    const j = await create();
    const fin = await waitFinal(j.id);
    expect(fin.name).toBe('render.failed'); expect(fin.data['code']).toBe('EM-3108');
    mem = 8e9;
  });
});

describe('Windows output folders (FR-205)', () => {
  it('the default export folder is <Videos>/Expertmotion when the Shell reported Videos, else the app outputs folder', async () => {
    const { defaultOutputFolder, outputRoots } = await import('../../src/s2/render-repo.js');
    const ctx = { cfg: { videosDir: path.join(path.sep, 'x', 'Video Saya') }, paths: { outputs: path.join(path.sep, 'data', 'outputs') } } as unknown as ServiceContext;
    expect(defaultOutputFolder(ctx, 'p1')).toBe(path.join(path.sep, 'x', 'Video Saya', 'Expertmotion'));
    expect(outputRoots(ctx)).toContain(path.join(path.sep, 'x', 'Video Saya'));
    const plain = { cfg: {}, paths: ctx.paths } as unknown as ServiceContext;
    expect(defaultOutputFolder(plain, 'p1')).toBe(path.join(path.sep, 'data', 'outputs', 'p1'));
  });
  it('a redirected Videos folder outside the profile is an allowed output folder; other folders still EM-8302', async () => {
    const { checkOutputFolder } = await import('../../src/modules/settings.js');
    const home = tempDir('em-home-'); const videos = tempDir('em-videos-');
    expect(checkOutputFolder(path.join(videos, 'Expertmotion'), home, [videos])).toBe(path.join(fs.realpathSync(videos), 'Expertmotion'));
    expect(() => checkOutputFolder(path.join(tempDir('em-elsewhere-'), 'x'), home, [videos])).toThrow(/user profile/);
  });
  it('Windows device names never become a file name', async () => {
    const { sanitizeFilename } = await import('@expertmotion/shared');
    expect(sanitizeFilename('CON')).toBe('video-CON'); expect(sanitizeFilename('nul.mp4')).toBe('video-nul'); expect(sanitizeFilename('Promo Kopi')).toBe('Promo-Kopi');
    expect(sanitizeFilename('Kopi Susu Gula Aren')).toBe('Kopi-Susu-Gula-Aren');
  });
});
