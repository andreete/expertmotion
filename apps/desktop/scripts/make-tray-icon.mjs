// Writes build/tray.png (32×32) and build/icon.ico (256×256 PNG-in-ICO, installer/uninstaller icon) ( the Editor accent #E8913A as a rounded square with a dark "play" triangle). No image
// dependency: a minimal RGBA PNG encoder over node:zlib. Run once; the PNG is committed.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function render(N) {
const accent = [0xe8, 0x91, 0x3a], ink = [0x1a, 0x12, 0x06];
const px = Buffer.alloc((N * 4 + 1) * N), k = N / 32;
for (let y = 0; y < N; y++) {
  px[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const o = y * (N * 4 + 1) + 1 + x * 4, r = 7 * k;
    const cx = Math.min(Math.max(x + 0.5, r), N - r), cy = Math.min(Math.max(y + 0.5, r), N - r);
    const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
    const X = (x + 0.5) / k, Y = (y + 0.5) / k;
    const tri = X >= 11 && X <= 23.5 && Math.abs(Y - 16) <= (X - 11) * -0.6 + 7.5;   // play triangle
    const c = tri ? ink : accent;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = inside ? 255 : 0;
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
writeFileSync(join(dir, 'tray.png'), render(32));
// ICO with one 256×256 PNG entry (width/height byte 0 = 256), supported since Windows Vista.
const big = render(256), head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 0; head[7] = 0; head[8] = 0; head[9] = 0; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(big.length, 14); head.writeUInt32LE(22, 18);
writeFileSync(join(dir, 'icon.ico'), Buffer.concat([head, big]));
console.log(`wrote ${dir}/tray.png and icon.ico`);
