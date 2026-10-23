// Builds the Engine bundle at BUILD time (ADR-001: no webpack at runtime) into resources/engine/bundle (BLUEPRINT §2.2).
// Requires `tsc -b packages/engine` first (workspace packages resolve to their dist/).
import { bundle } from '@remotion/bundler';
import fs from 'node:fs';
const root = new URL('../../../', import.meta.url).pathname;
const outDir = `${root}resources/engine/bundle`;
fs.rmSync(outDir, { recursive: true, force: true });
const t0 = Date.now();
const serveUrl = await bundle({
  entryPoint: new URL('../dist/entry.js', import.meta.url).pathname,   // tsc output: .js import specifiers resolve as written
  publicDir: new URL('../public', import.meta.url).pathname,
  outDir,
  enableCaching: false,
  onProgress: (p) => { if (p % 25 === 0) process.stdout.write(`bundle ${p}%\n`); },
});
const files = fs.readdirSync(outDir);
console.log(JSON.stringify({ serveUrl, seconds: (Date.now() - t0) / 1000, files: files.length, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));
