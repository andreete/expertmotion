// Writes build/tray.png (32×32, the Editor accent #E8913A as a rounded square with a dark "play" triangle). No image
// dependency: a minimal RGBA PNG encoder over node:zlib. Run once; the PNG is committed.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = 32, accent = [0xe8, 0x91, 0x3a], ink = [0x1a, 0x12, 0x06];
const px = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  px[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const o = y * (N * 4 + 1) + 1 + x * 4, r = 7;
    const cx = Math.min(Math.max(x + 0.5, r), N - r), cy = Math.min(Math.max(y + 0.5, r), N - r);
    const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
    const tri = x >= 11 && x <= 23 && Math.abs(y + 0.5 - 16) <= (x - 11) * -0.55 + 7.5;   // play triangle
    const c = tri ? ink : accent;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = inside ? 255 : 0;
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'tray.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
