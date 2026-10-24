// FR-042: the filmstrip is poster + 10 strip frames. The FFmpeg runner is mocked (no binaries needed): the fake ffprobe
// reports a 5 s H.264 clip and the fake ffmpeg evaluates the filmstrip filter graph to count the frames it would extract.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const probe = {
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv420p', avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: '5.000', nb_frames: '150' }],
    format: { duration: '5.000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  };
  return { calls, probe };
});
vi.mock('../../src/s2/proc.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/s2/proc.js')>();
  return {
    ...real,
    runTool: vi.fn(async (spec: { args: readonly string[]; cwd?: string }) => {
      const args = [...spec.args];
      fake.calls.push({ args, ...(spec.cwd ? { cwd: spec.cwd } : {}) });
      if (args.includes('-print_format')) return { code: 0, stdout: JSON.stringify(fake.probe), stderrTail: [] };
      const out = args[args.length - 1]!;
      if (spec.cwd && out !== 'pipe:1') fs.writeFileSync(path.join(spec.cwd, out), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return { code: 0, stdout: '', stderrTail: [] };
    }),
  };
});

import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { mediaModule } from '../../src/modules/media.js';
import { FILMSTRIP_FRAMES, ingestOf } from '../../src/s2/ingest.js';
import { importDir, json, shell, startS2, type S2Service } from './harness.js';

/** Frames an `fps=R,…,tile=CxR` graph (R decimal, or N/D) emits for a clip of `durS` seconds, and how many fit in the single tiled image. */
function framesOf(vf: string, durS: number): { sampled: number; tiled: number } {
  const fps = /fps=([\d.]+)(?:\/([\d.]+))?/.exec(vf); const tile = /tile=(\d+)x(\d+)/.exec(vf);
  const rate = fps ? Number(fps[1]) / (fps[2] ? Number(fps[2]) : 1) : 0;
  return { sampled: Math.round(rate * durS), tiled: tile ? Number(tile[1]) * Number(tile[2]) : 0 };
}

describe('FR-042 filmstrip (mocked FFmpeg runner)', () => {
  let s: S2Service; let src: string; let pid: string;
  beforeAll(async () => {
    src = importDir();
    s = await startS2([health, createAssetsModule({ importRoots: () => [src] }), mediaModule]);
    pid = s.project();
  });
  afterAll(async () => { await s.close(); });

  it('extracts 10 frames spread over the clip into one 10×1 strip, plus the poster', async () => {
    const r = await s.api(`/projects/${pid}/assets`, { method: 'POST', headers: shell, json: { paths: [path.join(src, 'clip-a.mp4')] } });
    expect(r.status).toBe(202);
    const { items } = await json<{ items: Array<{ id: string }> }>(r);
    await ingestOf(s.ctx).idle();
    const a = await json<{ status: string; media: Record<string, boolean> }>(await s.api(`/projects/${pid}/assets/${items[0]!.id}`));
    expect(a.status).toBe('ready');
    expect(a.media).toMatchObject({ thumb: true, filmstrip: true });
    expect(FILMSTRIP_FRAMES).toBe(10);
    const strip = fake.calls.filter((c) => c.args.at(-1) === 'strip.jpg');
    expect(strip).toHaveLength(1);
    const vf = strip[0]!.args[strip[0]!.args.indexOf('-vf') + 1]!;
    expect(framesOf(vf, 5)).toEqual({ sampled: 10, tiled: 10 });                     // 10 frames sampled evenly, all 10 in the strip
    expect(strip[0]!.args.slice(strip[0]!.args.indexOf('-frames:v'), strip[0]!.args.indexOf('-frames:v') + 2)).toEqual(['-frames:v', '1']);   // one image out
    expect(fake.calls.filter((c) => c.args.at(-1) === 'thumb.jpg')).toHaveLength(1);   // poster
    expect(fs.existsSync(path.join(s.ctx.paths.media, pid, items[0]!.id, 'strip.jpg'))).toBe(true);
  });
});
