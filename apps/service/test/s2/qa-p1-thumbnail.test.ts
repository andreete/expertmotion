// QA P1 2026-10-29 (round 1): "Title on the cover" was ignored. The title Text Layer got its variant's entrance (title = rise)
// starting exactly at the captured frame (opacity 0 there) and lasted 1 s, so other candidates missed it entirely.
// 1) always: the model handed to the still renderer has a static title over every candidate frame;
// 2) opt-in (EM_RENDER_SMOKE=1 + resources/engine/bundle): a real renderStill, and the title's pixels are in the PNG.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOperations, type CompositionModelT } from '@expertmotion/composition-model';
import { registry } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import type { GeneratorEngines } from '../../src/s2/generators-service.js';
import { FIXTURES, ffmpeg, hasFfmpeg, json, startS2, type S2Service } from './harness.js';

const BUNDLE = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../resources/engine/bundle');
const realStill = process.env['EM_RENDER_SMOKE'] === '1' && hasFfmpeg && fs.existsSync(path.join(BUNDLE, 'index.html'));
let n = 0;
const newId = () => `01ARZ3NDEKTSV4RRFFQ69H${String(++n).padStart(4, '0')}`;

type Job = { status: string; errorCode: string | null; result: Record<string, unknown> | null };
const final = (s: S2Service, id: string) => new Promise<Job>((res) => {
  const t = setInterval(async () => { const j = await json<Job>(await s.api(`/generator-jobs/${id}`)); if (['done', 'failed', 'cancelled'].includes(j.status)) { clearInterval(t); res(j); } }, 30);
});
/** A faceless project: two 3 s scenes (gradient backgrounds), no media. */
function scenes(s: S2Service, pid: string): void {
  const r = applyOperations(s.heads.get(pid)!.model, [{ op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000 } }, { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000 } }] as never, { assets: [], tier: 'T0', newId });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  s.version(pid, r.value.model);
}

describe.skipIf(!hasFfmpeg)('QA P1: the cover title is in every thumbnail candidate', () => {
  let s: S2Service; let pid: string;
  const seen: Array<{ model: CompositionModelT; frameMs: number }> = [];
  const engines: Partial<GeneratorEngines> = {
    frame: async (i) => { seen.push({ model: i.model as CompositionModelT, frameMs: i.frameMs }); ffmpeg(['-i', path.join(FIXTURES, 'clip-a.mp4'), '-frames:v', '1', i.outPath]); },
  };
  beforeAll(async () => {
    s = await startS2([health, createAssetsModule(), createModelsModule({ registry: () => [registry['frame-composite']!], freeBytes: async () => 1e12 }), createGeneratorsModule({ engines })]);
    pid = s.project(); scenes(s, pid);
  });
  afterAll(async () => { await s.close(); });

  it('the title is static (no entrance motion) and spans every candidate frame, including frame 0', async () => {
    const r = await s.api(`/projects/${pid}/generators/thumbnail`, { method: 'POST', json: { modelKey: 'frame-composite', titleText: 'Ekspor Nikel Naik', frameMs: 0, count: 3, style: 'bold', language: 'id' } });
    expect(r.status).toBe(202);
    const j = await final(s, (await json<{ id: string }>(r)).id);
    expect([j.status, j.errorCode]).toEqual(['done', null]);
    expect(seen.map((x) => x.frameMs)).toEqual([0, 1500, 3000]);
    for (const { model, frameMs } of seen) {
      const t = model.tracks.text.find((x) => x.text === 'Ekspor Nikel Naik');
      expect(t, `title at ${frameMs} ms`).toBeDefined();
      expect(t!.motion).toBeNull();
      expect(t!.effect).toBeNull();
      expect(t!.timing.atMs).toBeLessThanOrEqual(frameMs);
      expect(t!.timing.atMs + t!.timing.durationMs).toBeGreaterThan(frameMs);
    }
  });
});

describe.skipIf(!realStill)('QA P1: the cover title pixels are in a real still (opt-in, real Chrome)', () => {
  let s: S2Service; let pid: string;
  beforeAll(async () => {
    s = await startS2([health, createAssetsModule(), createModelsModule({ registry: () => [registry['frame-composite']!], freeBytes: async () => 1e12 }), createGeneratorsModule()]);
    s.ctx.resources.engineBundle = BUNDLE; s.ctx.hooks.tier = () => 'T0';
    pid = s.project(); scenes(s, pid);
  });
  afterAll(async () => { await s.close(); });

  const still = async (body: Record<string, unknown>): Promise<Buffer> => {
    const r = await s.api(`/projects/${pid}/generators/thumbnail`, { method: 'POST', json: { modelKey: 'frame-composite', frameMs: 0, count: 1, style: 'bold', language: 'id', ...body } });
    const j = await final(s, (await json<{ id: string }>(r)).id);
    expect([j.status, j.errorCode]).toEqual(['done', null]);
    const a = s.ctx.db.prepare('SELECT original_path p FROM assets WHERE id = ?').get(String(j.result!['assetId'])) as { p: string };
    const raw = path.join(s.ctx.paths.tmp, `${crypto.randomUUID()}.gray`);
    ffmpeg(['-i', path.join(s.ctx.paths.media, a.p), '-vf', 'scale=320:-2', '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
    return fs.readFileSync(raw);
  };
  it('frame 0 with "Title on the cover": many pixels differ from the same frame without a title', { timeout: 240_000 }, async () => {
    const plain = await still({});
    const titled = await still({ titleText: 'JUDUL BESAR' });
    expect(titled.length).toBe(plain.length);
    let diff = 0; for (let i = 0; i < plain.length; i++) if (Math.abs(plain[i]! - titled[i]!) > 48) diff++;
    expect(diff / plain.length).toBeGreaterThan(0.005);      // the title's glyphs (white on the gradient), not noise
  });
});
