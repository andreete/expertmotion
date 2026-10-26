// OPT-IN end-to-end render smoke (real Chrome Headless Shell + the prebuilt Engine bundle). Skipped unless EM_RENDER_SMOKE=1.
// Run only inside the memory cap and only when resources/engine/bundle exists (do not rebuild it):
//   EM_RENDER_SMOKE=1 bash scripts/run-capped.sh npx vitest run apps/service/test/s2/render-smoke.test.ts
// Flow: ingest two committed fixture clips → Insert → POST /renders (720p mp4, Standard, T0/swangle) → Chrome loads media through
// /media/<render grant>/… (CORS via ctx.mediaOrigins) → ffprobe validation → Output row; the render grant is dead afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { mediaModule } from '../../src/modules/media.js';
import { createRendersModule } from '../../src/modules/renders.js';
import { ingestOf } from '../../src/s2/ingest.js';
import { applyOperations, createEmptyModel, type OperationT } from '@expertmotion/composition-model';
import { hasFfmpeg, importDir, json, shell, startS2, type S2Service } from './harness.js';

const BUNDLE = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../resources/engine/bundle');
const enabled = process.env['EM_RENDER_SMOKE'] === '1' && hasFfmpeg && fs.existsSync(path.join(BUNDLE, 'index.html'));

describe.skipIf(!enabled)('render smoke (real renderer)', () => {
  let s: S2Service; let src: string; let pid: string;
  beforeAll(async () => {
    src = importDir();
    s = await startS2([health, createAssetsModule({ importRoots: () => [src] }), mediaModule, createRendersModule({ freeMemBytes: () => 4 * 1024 ** 3 })]);
    s.ctx.resources.engineBundle = BUNDLE;
    s.ctx.hooks.tier = () => 'T0';
    pid = s.project('Smoke');
    const check = s.ctx.grants.check.bind(s.ctx.grants);
    s.ctx.grants.check = (t, p, a) => { const g = check(t, p, a); if (g?.kind === 'render') renderHits++; return g; };
  });
  let renderHits = 0;
  afterAll(async () => { await s.close(); });

  it('ingests, inserts and renders a validated 720p MP4', async () => {
    const t0 = Date.now();
    const imp = await json<{ items: Array<{ id: string }> }>(await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, 'clip-a-audio.mp4'), path.join(src, 'clip-b.mp4')] } }));
    await ingestOf(s.ctx).idle();
    const ins = await s.api(`/projects/${pid}/assets/insert`, { method: 'POST', json: { assetIds: imp.items.map((i) => i.id), order: 'given' } });
    expect(ins.status).toBe(200);
    const r = await s.api('/renders', { method: 'POST', json: { projectId: pid, outputProfile: { ratio: '16:9', resolution: '720p', fps: 30, format: 'mp4', alpha: false }, performanceProfile: 'standard', fileName: 'smoke' } });
    const body = await json<{ id: string; error?: unknown }>(r);
    expect(r.status, JSON.stringify(body)).toBe(202);
    const ev = await s.waitEvent((e) => ['render.done', 'render.failed', 'render.cancelled'].includes(e.name) && e.data['jobId'] === body.id, 280_000);
    expect(ev.name, JSON.stringify(ev.data)).toBe('render.done');
    const out = ev.data['output'] as { path: string; validated: boolean; width: number; height: number; bytes: number };
    expect(out.validated).toBe(true); expect([out.width, out.height]).toEqual([1280, 720]);
    console.log(JSON.stringify({ smoke: 'ok', seconds: (Date.now() - t0) / 1000, bytes: out.bytes, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      renderGrantMediaRequests: renderHits, originsCleared: s.ctx.mediaOrigins.size === 0 }));
    expect(renderHits).toBeGreaterThan(0);
  }, 300_000);

  // GS-23 / ADR-030: a video WITHOUT any media (scene clips with backgrounds, titles, transitions) exports like any other.
  it('renders a faceless video built only from scene clips (no assets) to a validated MP4', async () => {
    const fid = s.project('Faceless');
    const ops: OperationT[] = [
      { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 1500, background: 'preset:background.spotlight', title: 'Tagihan listrik bengkak?' } },
      { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 1500, background: 'preset:background.gradient', title: 'Tips 1', text: 'Cabut charger', transition: 'preset:transition.slide', transitionMs: 300 } },
      { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 1500, background: 'preset:background.dots', title: 'Follow!', transition: 'preset:transition.fade', transitionMs: 300 } },
    ];
    let n = 0;
    const r0 = applyOperations(createEmptyModel(fid, { autoRatio: false, ratio: '9:16', resolution: '720p', fps: 30 }), ops, { assets: [], tier: 'T0', newId: () => `sc${++n}` });
    if (!r0.ok) throw new Error(JSON.stringify(r0.issues));
    s.version(fid, r0.value.model);
    const r = await s.api('/renders', { method: 'POST', json: { projectId: fid, outputProfile: { ratio: '9:16', resolution: '720p', fps: 30, format: 'mp4', alpha: false }, performanceProfile: 'standard', fileName: 'faceless' } });
    const body = await json<{ id: string; error?: unknown }>(r);
    expect(r.status, JSON.stringify(body)).toBe(202);
    const ev = await s.waitEvent((e) => ['render.done', 'render.failed', 'render.cancelled'].includes(e.name) && e.data['jobId'] === body.id, 280_000);
    expect(ev.name, JSON.stringify(ev.data)).toBe('render.done');
    const out = ev.data['output'] as { validated: boolean; width: number; height: number; durationMs: number | null };
    expect(out.validated).toBe(true); expect([out.width, out.height]).toEqual([720, 1280]);
    console.log(JSON.stringify({ faceless: 'ok', output: out }));
  }, 300_000);
});
