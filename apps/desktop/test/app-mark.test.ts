// Operator feedback 2026-10-26: one app mark everywhere. The generator (scripts/make-tray-icon.mjs) owns the geometry;
// the committed SVG, the Editor header logo, the favicon and the License Admin header must carry the same shapes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script without type declarations
import { MARK, ico, markSvg, png } from '../scripts/make-tray-icon.mjs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
type Pt = [number, number];
const pts = (p: Pt[]) => p.map(([x, y]) => `${x},${y}`).join(' ');

describe('app mark', () => {
  it('the committed SVG is the generator output', () => {
    expect(read('../build/expertmotion-mark.svg')).toBe(markSvg());
  });
  it('the Editor logo, favicon and admin header use the same geometry and colours', () => {
    const shapes = [pts(MARK.echo.points as Pt[]), pts(MARK.play.points as Pt[])];
    const colours = ['f09c48', 'b05218'];
    for (const file of ['../../ui/src/components/AppMark.tsx', '../../ui/index.html', '../../admin/src/renderer/index.html']) {
      const src = read(file).toLowerCase();
      for (const s of [...shapes, ...colours]) expect(src, `${file} has ${s}`).toContain(s);
    }
  });
  it('writes a 32 px RGBA PNG and a PNG-in-ICO with 16…256 px entries', () => {
    const p = png(32) as Buffer;
    expect(p.subarray(1, 4).toString()).toBe('PNG');
    expect([p.readUInt32BE(16), p.readUInt32BE(20), p[25]]).toEqual([32, 32, 6]);
    const i = ico([16, 32, 256]) as Buffer;
    expect([i.readUInt16LE(2), i.readUInt16LE(4)]).toEqual([1, 3]);
    expect([i[6], i[22], i[38]]).toEqual([16, 32, 0]);                               // 0 = 256 px
    expect(i.subarray(i.readUInt32LE(6 + 12) + 1, i.readUInt32LE(6 + 12) + 4).toString()).toBe('PNG');
  });
});
