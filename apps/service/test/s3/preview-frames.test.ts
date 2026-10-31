// composition.frames (FR-310 … FR-312, ADR-041 addendum; QA 2026-10-31 "Saya tidak bisa melihat … preview"): the agents see the
// Player picture. 1) always (fake still renderer, real ffmpeg tile pass): default times = the middle of every scene, ≤ 6 cells,
// cells ≤ 360 px wide, the textual on-screen summary lists the texts / pictures at each time, EM-4412 on a failed still, the same
// (version, times) is rendered once per run; 2) opt-in (EM_PREVIEW_SMOKE=1 + resources/engine/bundle): the GS-23 faceless model
// through the real Engine still renderer once:
//   EM_PREVIEW_SMOKE=1 EM_NODE_HEAP=900 bash scripts/run-capped.sh npx vitest run apps/service/test/s3/preview-frames.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, deriveTiming, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { health } from '../../src/modules/health.js';
import { describeOnScreen, jpegSize, onScreenAt, previewFrameTimes, previewFramesTool, previewModel, sceneMiddles, PREVIEW_CELL_WIDTH } from '../../src/s3/preview-frames.js';
import { FIXTURES, ffmpeg, hasFfmpeg, startS2, type S2Service } from '../s2/harness.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const BUNDLE = path.join(ROOT, 'resources/engine/bundle');
// The tile pass needs the product's full ffmpeg (resources/bin-linux-x64, as footage-prep.test.ts); Remotion's minimal ffmpeg (harness) has no `tile`.
const FULL_FFMPEG = [path.join(ROOT, 'resources/bin-linux-x64/ffmpeg'), '/home/andre/em-win-deps/ffmpeg-linux-lgpl/ffmpeg-n8.1-latest-linux64-lgpl-8.1/bin/ffmpeg'].find((p) => fs.existsSync(p));
const hasFull = hasFfmpeg && !!FULL_FFMPEG;
const realStill = process.env['EM_PREVIEW_SMOKE'] === '1' && hasFull && fs.existsSync(path.join(BUNDLE, 'index.html'));

/** GS-23: a faceless 9:16 video from scene clips only (as render-smoke.test.ts), plus a shape and a caption page. */
function faceless(projectId: string, scenes = 3): CompositionModelT {
  const ops: OperationT[] = [
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 1500, background: 'preset:background.spotlight', title: 'Tagihan listrik bengkak?' } },
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 1500, background: 'preset:background.gradient', title: 'Tips 1', text: 'Cabut charger', transition: 'preset:transition.slide', transitionMs: 300 } },
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 1500, background: 'preset:background.dots', title: 'Follow!', transition: 'preset:transition.fade', transitionMs: 300 } },
  ];
  for (let i = 3; i < scenes; i++) ops.push({ op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 1000, background: 'preset:background.solid', title: `Adegan ${i + 1}` } });
  ops.push({ op: 'op:shape.add', target: { kind: 'overlay' }, args: { presetId: 'preset:shape.circle', atMs: 1400, durationMs: 1200, position: 'center', size: 200 } } as OperationT);
  ops.push({ op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages: [{ startMs: 1300, durationMs: 1300, text: 'cabut charger yang nganggur', tokens: [] }] } } as OperationT);
  let n = 0;
  const r = applyOperations(createEmptyModel(projectId, { autoRatio: false, ratio: '9:16', resolution: '1080p', fps: 30 }), ops, { assets: [], tier: 'T0', newId: () => `el${++n}` });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}

describe('composition.frames: times and the on-screen summary (FR-310, FR-311)', () => {
  const model = faceless('P1');
  const timing = deriveTiming(model);
  it('default times are the middle of every scene, in order; more than 6 scenes → 6 spread over the video', () => {
    const mids = model.tracks.video.map((c, i) => Math.round(timing.clipStartMs[i]! + c.durationMs / 2));
    expect(sceneMiddles(model)).toEqual(mids);
    expect(previewFrameTimes(model, {})).toEqual(mids);
    const many = faceless('P2', 10);
    const t = previewFrameTimes(many, {});
    expect(t).toHaveLength(6); expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(t[0]).toBe(750); expect(t[5]).toBe(sceneMiddles(many, 10)[9]);
  });
  it('given times are clamped into the video and deduplicated; scenes:true adds the scene middles; never more than 6', () => {
    expect(previewFrameTimes(model, { atMs: [12_000, 1000, 1000, -4] })).toEqual([0, 1000, timing.durationMs - 1]);
    expect(previewFrameTimes(model, { atMs: [1000], scenes: true })).toEqual([...new Set([1000, ...sceneMiddles(model)])].sort((a, b) => a - b));
    expect(previewFrameTimes(model, { atMs: [1, 2, 3, 4, 5, 6], scenes: true })).toHaveLength(6);
  });
  it('onScreenAt names the clip / scene, the texts, the shape and the caption page at a time; describeOnScreen puts them in one line', () => {
    const first = onScreenAt(model, 750);
    expect(first.clip).toMatchObject({ index: 0, scene: 'preset:background.spotlight' });
    expect(first.texts.map((x) => x.text)).toContain('Tagihan listrik bengkak?');
    expect(first.pictures).toEqual([]); expect(first.caption).toBeNull(); expect(first.clock).toBe('0:01');
    const second = onScreenAt(model, timing.clipStartMs[1]! + 600);
    expect(second.clip).toMatchObject({ index: 1, scene: 'preset:background.gradient' });
    expect(second.texts.map((x) => x.text).sort()).toEqual(['Cabut charger', 'Tips 1']);
    expect(second.pictures).toEqual([{ id: expect.any(String), kind: 'shape', preset: 'preset:shape.circle' }]);
    expect(second.caption).toBe('cabut charger yang nganggur');
    const line = describeOnScreen(second);
    expect(line).toMatch(/^0:0[12] — clip 2 \(scene background\.gradient\); texts: /);
    expect(line).toContain("'Tips 1'"); expect(line).toContain("'Cabut charger'"); expect(line).toContain('shape preset:shape.circle'); expect(line).toContain("caption 'cabut charger yang nganggur'");
    const cut = onScreenAt(model, timing.clipStartMs[1]!);
    expect(cut.transition).toBe('preset:transition.slide');
    expect(describeOnScreen(onScreenAt(model, timing.durationMs + 500))).toContain('no clip (empty frame)');
  });
  it('the still is rendered on a 720p copy of the model (the head itself is untouched)', () => {
    const m = previewModel(model);
    expect(m.settings.resolution).toBe('720p'); expect(model.settings.resolution).toBe('1080p');
    expect(m.tracks.text).toEqual(model.tracks.text);
  });
});

describe.skipIf(!hasFull)('composition.frames handler: contact sheet, cache, EM-4412 (fake still renderer, FR-310 … FR-312)', () => {
  let s: S2Service; let pid: string; let versionId: string;
  const rendered: Array<{ frameMs: number; resolution: string }> = [];
  let fail = false;
  const renderStill = async (m: CompositionModelT, frameMs: number, outPath: string) => {
    if (fail) throw new Error('Chrome did not start');
    rendered.push({ frameMs, resolution: m.settings.resolution });
    ffmpeg(['-ss', String(frameMs / 1000), '-i', path.join(FIXTURES, 'clip-a.mp4'), '-frames:v', '1', '-vf', 'scale=720:1280', '-q:v', '4', outPath]);   // the bundled ffmpeg has no lavfi: a fixture frame stands in for the still
  };
  beforeAll(async () => {
    s = await startS2([health]);
    s.ctx.resources.ffmpeg = FULL_FFMPEG!;
    pid = s.project('Hemat Listrik');
    versionId = s.version(pid, faceless(pid));
  });
  afterAll(async () => { await s.close(); });

  it('default call: one still per scene middle, a JPEG sheet with cells ≤ 360 px wide, the summary per cell; the same (version, times) renders once per run', async () => {
    const tool = previewFramesTool(s.ctx, pid, { renderStill, waitForRenders: async () => undefined });
    const t0 = Date.now();
    const r = await tool({}) as { versionId: string; cols: number; rows: number; frame: { width: number; height: number }; cells: Array<{ atMs: number; clock: string; x: number; y: number; w: number; h: number }>; summary: string[]; imageBase64: string; mediaType: string };
    expect(r.versionId, JSON.stringify(r).slice(0, 600)).toBe(versionId);
    expect(rendered.map((x) => x.frameMs)).toEqual(sceneMiddles(s.ctx.hooks.composition(pid).model));
    expect(rendered.every((x) => x.resolution === '720p')).toBe(true);
    expect(r.frame).toEqual({ width: 720, height: 1280 });
    expect([r.cols, r.rows]).toEqual([2, 2]); expect(r.cells).toHaveLength(3);
    for (const c of r.cells) { expect(c.w).toBeLessThanOrEqual(PREVIEW_CELL_WIDTH); expect(c.h).toBe(640); }
    expect(r.cells[1]).toMatchObject({ x: 360, y: 0, clock: '0:02' }); expect(r.cells[2]).toMatchObject({ x: 0, y: 640 });
    expect(r.mediaType).toBe('image/jpeg');
    const sheet = Buffer.from(r.imageBase64, 'base64');
    expect(jpegSize(sheet)).toEqual({ width: 720, height: 1280 });
    expect(r.summary).toHaveLength(3);
    expect(r.summary[0]).toContain("title 'Tagihan listrik bengkak?'"); expect(r.summary[1]).toContain('shape preset:shape.circle'); expect(r.summary[2]).toContain("'Follow!'");
    // cache: same input, same version → no new still
    const again = await tool({ scenes: true }) as typeof r;
    expect(rendered).toHaveLength(3); expect(again.imageBase64).toBe(r.imageBase64);
    // other times → rendered (± 1 s around 0:02 as the prompt tells the model)
    const other = await tool({ atMs: [1000, 2000, 3000] }) as typeof r;
    expect(rendered).toHaveLength(6); expect(other.cells.map((c) => c.atMs)).toEqual([1000, 2000, 3000]);
    // a new head version renders again
    s.version(pid, faceless(pid, 4));
    await tool({ atMs: [1000, 2000, 3000] });
    expect(rendered).toHaveLength(9);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 60_000);

  it('one time → one cell, no tile pass (scale only)', async () => {
    const before = rendered.length;
    const r = await previewFramesTool(s.ctx, pid, { renderStill, waitForRenders: async () => undefined })({ atMs: [1950] }) as { cols: number; rows: number; cells: Array<{ atMs: number; w: number; h: number }>; imageBase64: string; summary: string[] };
    expect(rendered).toHaveLength(before + 1);
    expect([r.cols, r.rows]).toEqual([1, 1]); expect(r.cells).toEqual([{ atMs: 1950, clock: '0:02', x: 0, y: 0, w: 360, h: 640 }]);
    expect(jpegSize(Buffer.from(r.imageBase64, 'base64'))).toEqual({ width: 360, height: 640 });
    expect(r.summary).toHaveLength(1);
  });
  it('a still that cannot be rendered is EM-4412 in the tool result, with the textual summary so the model can still answer', async () => {
    fail = true;
    try {
      const tool = previewFramesTool(s.ctx, pid, { renderStill, waitForRenders: async () => undefined });
      const r = await tool({ atMs: [750] }) as { error: { code: string; message: string }; summary: string[] };
      expect(r.error.code).toBe('EM-4412');
      expect(r.error.message).toMatch(/preview could not be captured/i);
      expect(r.summary[0]).toContain("'Tagihan listrik bengkak?'");
    } finally { fail = false; }
  });
  it('a project without a head answers EM-9003 (never throws)', async () => {
    const tool = previewFramesTool(s.ctx, 'NOPE', { renderStill, waitForRenders: async () => undefined });
    expect(await tool({})).toMatchObject({ error: { code: 'EM-9003' } });
  });
});

describe.skipIf(!realStill)('composition.frames through the real Engine still renderer (opt-in, GS-23 faceless)', () => {
  let s: S2Service; let pid: string;
  beforeAll(async () => {
    s = await startS2([health]);
    s.ctx.resources.ffmpeg = FULL_FFMPEG!;
    s.ctx.resources.engineBundle = BUNDLE;
    s.ctx.hooks.tier = () => 'T0';
    pid = s.project('Faceless');
    s.version(pid, faceless(pid));
  });
  afterAll(async () => { await s.close(); });

  it('renders the three scene middles into one contact sheet within the 60 s cap', { timeout: 150_000 }, async () => {
    const t0 = Date.now();
    const r = await previewFramesTool(s.ctx, pid)({}) as { error?: { code: string; message: string }; frame?: { width: number; height: number }; cells?: unknown[]; imageBase64?: string; summary?: string[] };
    const ms = Date.now() - t0;
    expect(r.error, JSON.stringify(r.error)).toBeUndefined();
    expect(r.frame).toEqual({ width: 720, height: 1280 });
    expect(r.cells).toHaveLength(3);
    const sheet = Buffer.from(r.imageBase64!, 'base64');
    expect(jpegSize(sheet)).toEqual({ width: 720, height: 1280 });
    expect(sheet.length).toBeGreaterThan(5000);
    // eslint-disable-next-line no-console
    console.log(`[preview-smoke] 3 stills + sheet ${sheet.length} B in ${ms} ms (incl. Chrome start), peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
    expect(ms).toBeLessThan(60_000);
  }, 150_000);
});
