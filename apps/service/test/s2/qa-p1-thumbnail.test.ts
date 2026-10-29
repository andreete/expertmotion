// QA P1 2026-10-29 (round 1): "Title on the cover" was ignored. The title Text Layer got its variant's entrance (title = rise)
// starting exactly at the captured frame (opacity 0 there) and lasted 1 s, so other candidates missed it entirely.
// 1) always: the model handed to the still renderer has a static title over every candidate frame;
// 2) opt-in (EM_RENDER_SMOKE=1 + resources/engine/bundle): a real renderStill, and the title's pixels are in the PNG.
import zlib from 'node:zlib';
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

/** Minimal PNG decoder (8-bit RGB / RGBA, non-interlaced, as Remotion writes) → one luminance byte per pixel. */
function pngGray(png: Buffer): Buffer {
  let o = 8, w = 0, h = 0, ch = 4; const idat: Buffer[] = [];
  while (o < png.length) {
    const len = png.readUInt32BE(o); const type = png.toString('ascii', o + 4, o + 8); const d = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[8] !== 8 || d[12] !== 0) throw new Error('unsupported PNG'); ch = d[9] === 6 ? 4 : d[9] === 2 ? 3 : 0; if (!ch) throw new Error('unsupported colour type'); }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * ch; const out = Buffer.alloc(w * h); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch]! : 0, b = prev[x]!, c = x >= ch ? prev[x - ch]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x]! + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = Math.round(0.299 * line[x * ch]! + 0.587 * line[x * ch + 1]! + 0.114 * line[x * ch + 2]!);
    prev = line;
  }
  return out;
}
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
    expect(seen).toHaveLength(3);                                                         // capture times: settledCaptureMs (qa-p1-thumbnail-settle)
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
    return pngGray(fs.readFileSync(path.join(s.ctx.paths.media, a.p)));
  };
  it('frame 0 with "Title on the cover": many pixels differ from the same frame without a title', { timeout: 240_000 }, async () => {
    const plain = await still({});
    const titled = await still({ titleText: 'JUDUL BESAR' });
    expect(titled.length).toBe(plain.length);
    let diff = 0; for (let i = 0; i < plain.length; i++) if (Math.abs(plain[i]! - titled[i]!) > 48) diff++;
    expect(diff / plain.length).toBeGreaterThan(0.005);      // the title's glyphs (white on the gradient), not noise
  });
});
