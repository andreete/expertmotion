// Expertmotion app mark (Operator feedback 2026-10-26): a rounded square with a diagonal gradient from the Editor accent
// #E8913A to a darker burnt tone, a white "play" triangle with rounded corners and a fainter motion echo behind it.
// This script is the single source of the mark's geometry. It writes
//   build/tray.png          32×32 tray icon
//   build/icon.ico          app / installer icon: PNG-in-ICO with 16, 24, 32, 48 and 256 px entries
//   build/expertmotion-mark.svg   the same design as SVG (the Editor header logo, its favicon and the admin header copy it)
// No image dependency: shapes are rasterised procedurally (signed-distance tests, 8×8 / 4×4 supersampling) and encoded
// with a minimal RGBA PNG writer over node:zlib. Run once (`node apps/desktop/scripts/make-tray-icon.mjs`); outputs are committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Geometry in a 64×64 design box (same numbers as the SVG). */
export const MARK = {
  size: 64, radius: 14,
  from: [0xf0, 0x9c, 0x48], to: [0xb0, 0x52, 0x18],                        // gradient: top-left → bottom-right
  echo: { points: [[16, 21], [33, 32], [16, 43]], round: 2.5, alpha: 0.42 },
  play: { points: [[27, 18], [48, 32], [27, 46]], round: 3 },
};

export function markSvg() {
  const pts = (p) => p.map(([x, y]) => `${x},${y}`).join(' ');
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs><linearGradient id="em-mark-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(MARK.from)}"/><stop offset="1" stop-color="${hex(MARK.to)}"/></linearGradient></defs>
  <rect width="64" height="64" rx="${MARK.radius}" fill="url(#em-mark-g)"/>
  <g opacity="${MARK.echo.alpha}"><polygon points="${pts(MARK.echo.points)}" fill="#fff" stroke="#fff" stroke-width="${MARK.echo.round * 2}" stroke-linejoin="round"/></g>
  <polygon points="${pts(MARK.play.points)}" fill="#fff" stroke="#fff" stroke-width="${MARK.play.round * 2}" stroke-linejoin="round"/>
</svg>
`;
}

// ---- rasteriser -------------------------------------------------------------------------------------------------
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function inTriangle(px, py, [a, b, c]) {
  const s = (p, q) => (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
/** Triangle grown by `r` (SVG fill + round-join stroke of width 2r). */
const inRoundTri = (x, y, t) => inTriangle(x, y, t.points) || Math.min(segDist(x, y, t.points[0], t.points[1]), segDist(x, y, t.points[1], t.points[2]), segDist(x, y, t.points[2], t.points[0])) <= t.round;
function inRoundRect(x, y) {
  const { size: s, radius: r } = MARK;
  if (x < 0 || y < 0 || x > s || y > s) return false;
  const cx = Math.min(Math.max(x, r), s - r), cy = Math.min(Math.max(y, r), s - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Colour of one sample point in design units, plus coverage (0 or 1). */
function sample(x, y) {
  if (!inRoundRect(x, y)) return [0, 0, 0, 0];
  const t = Math.max(0, Math.min(1, (x + y) / (2 * MARK.size)));
  let c = MARK.from.map((v, i) => v + (MARK.to[i] - v) * t);
  const over = (a) => { c = c.map((v) => v * (1 - a) + 255 * a); };
  if (inRoundTri(x, y, MARK.echo)) over(MARK.echo.alpha);
  if (inRoundTri(x, y, MARK.play)) over(1);
  return [c[0], c[1], c[2], 1];
}

export function rasterise(N) {
  const ss = N <= 64 ? 8 : 4, k = MARK.size / N;
  const rows = Buffer.alloc((N * 4 + 1) * N);
  for (let y = 0; y < N; y++) {
    rows[y * (N * 4 + 1)] = 0;
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const p = sample((x + (sx + 0.5) / ss) * k, (y + (sy + 0.5) / ss) * k);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (N * 4 + 1) + 1 + x * 4;
      rows[o] = a ? Math.round(r / a) : 0; rows[o + 1] = a ? Math.round(g / a) : 0; rows[o + 2] = a ? Math.round(b / a) : 0;
      rows[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return rows;
}

// ---- PNG / ICO -------------------------------------------------------------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
export function png(N) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rasterise(N), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** ICO with PNG entries (supported since Windows Vista); width/height byte 0 = 256. */
export function ico(sizes) {
  const imgs = sizes.map((n) => png(n));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((n, i) => {
    const e = 6 + 16 * i;
    head[e] = n >= 256 ? 0 : n; head[e + 1] = n >= 256 ? 0 : n; head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += imgs[i].length;
  });
  return Buffer.concat([head, ...imgs]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const build = join(here, '..', 'build');
  writeFileSync(join(build, 'tray.png'), png(32));
  writeFileSync(join(build, 'icon.ico'), ico([16, 24, 32, 48, 256]));
  writeFileSync(join(build, 'expertmotion-mark.svg'), markSvg());
  if (process.argv.includes('--previews')) {                                  // optional size previews for a visual check
    const out = process.argv[process.argv.indexOf('--previews') + 1];
    mkdirSync(out, { recursive: true });
    for (const n of [16, 24, 32, 48, 256]) writeFileSync(join(out, `mark-${n}.png`), png(n));
  }
  console.log(`wrote ${build}/tray.png, icon.ico and expertmotion-mark.svg`);
}
