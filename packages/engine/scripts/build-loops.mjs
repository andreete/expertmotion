// Prerenders the Preview catalogue loops (ADR-011, DESIGN_CATALOGUE §2): resources/catalogue/<category>/<name>.webm,
// 2 s, 480 px wide (16:9 → 480×270), VP8, no audio. Build-time only; the shipped app never renders these.
// Needs the Engine bundle (npm run build:bundle) and `tsc -b packages/engine`. Heavy: run inside the memory cap.
//   bash scripts/run-capped.sh node packages/engine/scripts/build-loops.mjs [--only=transition,effect] [--limit=N] [--force] [--posters-only]
// Every loop also gets a poster <name>.jpg (the frame at POSTER_S): the Catalogue Card shows it while the loop is paused. Frame 0
// is no good — every demo starts with its entrance (text / clip not visible yet), and app:// answers without Range support, so
// the Editor cannot seek the paused <video> to a later frame (Entry 36: "empty brown gradients" on Windows).
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import { execFileSync } from 'node:child_process';
import { applyOperations, createEmptyModel } from '@expertmotion/composition-model';
import { compileDefaults, listPresets } from '@expertmotion/catalogue';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = new URL('../../../', import.meta.url).pathname;
const serveUrl = path.join(root, 'resources/engine/bundle');
const outRoot = path.join(root, 'resources/catalogue');
const fxDir = path.join(root, 'resources/catalogue/.fixtures');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const only = arg('only')?.split(','); const limit = Number(arg('limit') ?? Infinity); const force = process.argv.includes('--force');
const gl = process.env.EM_GL ?? (process.platform === 'win32' ? 'angle' : 'swangle');
// Fixed Remotion serve port (never let it auto-pick the 3000 range; dev ports 4110/4120 are the service and UI).
const port = Number(process.env.EM_RENDER_PORT ?? 4130);
const opts = { chromiumOptions: { gl }, concurrency: 1, logLevel: 'error', port };
const log = (o) => console.log(JSON.stringify(o));
if (!fs.existsSync(path.join(serveUrl, 'index.html'))) { console.error('Engine bundle missing: npm run build:bundle -w @expertmotion/engine'); process.exit(1); }

let n = 0; const newId = () => `e${++n}`;
const apply = (m, ops, assets = []) => { const r = applyOperations(m, ops, { assets, tier: 'T2', newId }); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model; };
const base = () => createEmptyModel('loops', { autoRatio: false, ratio: '16:9', resolution: '720p', fps: 30 });
const SCALE = 480 / 1280;
const POSTER_S = 1.0;
const postersOnly = process.argv.includes('--posters-only');
// The pinned Remotion compositor's FFmpeg (slim build: image2 + mjpeg are in it; no select/tile filters, so seek with -ss).
const compositorDir = path.join(root, 'node_modules/@remotion', process.platform === 'win32' ? 'compositor-win32-x64-msvc' : process.platform === 'darwin' ? `compositor-darwin-${process.arch}` : 'compositor-linux-x64-gnu');
function poster(loop) {
  const out = loop.replace(/\.webm$/, '.jpg');
  execFileSync(path.join(compositorDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), ['-loglevel', 'error', '-y', '-ss', String(POSTER_S), '-i', loop, '-frames:v', '1', '-q:v', '4', '-f', 'image2', '-update', '1', `${out}.part`],
    { env: { ...process.env, LD_LIBRARY_PATH: compositorDir, DYLD_LIBRARY_PATH: compositorDir }, stdio: ['ignore', 'ignore', 'pipe'] });
  fs.renameSync(`${out}.part`, out);
  return out;
}
if (postersOnly) {
  let made = 0; const failed = [];
  for (const p of listPresets({}).filter((x) => x.preview && (!only || only.includes(x.category)))) {
    const loop = path.join(root, 'resources', p.preview);
    if (!fs.existsSync(loop) || (!force && fs.existsSync(loop.replace(/\.webm$/, '.jpg')))) continue;
    try { poster(loop); made++; } catch (e) { failed.push({ preset: p.id, error: String(e.message ?? e).slice(0, 200) }); }
  }
  log({ posters: made, failed });
  process.exit(failed.length ? 1 : 0);
}

async function render(model, assetsProps, file) {
  const inputProps = { model, assets: assetsProps, quality: 'full' };
  const comp = await selectComposition({ serveUrl, id: 'ExpertmotionTimeline', inputProps, ...opts });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await renderMedia({ composition: comp, serveUrl, codec: 'vp8', crf: 20, muted: true, outputLocation: `${file}.part.webm`, inputProps, scale: SCALE, ...opts });
  fs.renameSync(`${file}.part.webm`, file);
}

// Two neutral fixture clips (rendered by the engine itself: no third-party media) for presets that need video.
await ensureBrowser();
async function fixture(name, palette, label) {
  const file = path.join(fxDir, `${name}.mp4`);
  if (fs.existsSync(file)) return file;
  const m = apply(base(), [
    { op: 'op:theme.set', args: { paletteId: palette } },
    { op: 'op:background.set', args: { presetId: 'preset:background.moving-gradient' } },
    { op: 'op:text.add', args: { text: label, variant: 'preset:text.title', atMs: 0, durationMs: 2500 } },
    { op: 'op:project.setDurationPolicy', args: { policy: 'fixed', fixedMs: 2500 } }]);
  const inputProps = { model: m, assets: {}, quality: 'full' };
  const comp = await selectComposition({ serveUrl, id: 'ExpertmotionTimeline', inputProps, ...opts });
  fs.mkdirSync(fxDir, { recursive: true });
  await renderMedia({ composition: comp, serveUrl, codec: 'h264', crf: 26, outputLocation: file, inputProps, scale: SCALE, ...opts });
  return file;
}
const clips = { A: await fixture('clip-a', 'preset:palette.editorial-dark', 'A'), B: await fixture('clip-b', 'preset:palette.neon-tech', 'B') };
const grant = crypto.randomBytes(32).toString('base64url');
const server = http.createServer((req, res) => {
  const m = /^\/media\/([\w-]{43})\/(A|B)\/playable$/.exec(req.url ?? '');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': `http://localhost:${port}`, 'Access-Control-Allow-Headers': 'Range' }); return res.end(); }
  if (!m || m[1] !== grant) { res.writeHead(404); return res.end(); }
  const f = clips[m[2]]; const size = fs.statSync(f).size; const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const start = r?.[1] ? Number(r[1]) : 0; const end = r?.[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
  res.writeHead(r ? 206 : 200, { 'Access-Control-Allow-Origin': `http://localhost:${port}`, 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length', 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(r ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  fs.createReadStream(f, { start, end }).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = (id) => `http://127.0.0.1:${server.address().port}/media/${grant}/${id}/playable`;
const ASSETS = [{ id: 'A', kind: 'video', status: 'ready', durationMs: 2500, width: 1280, height: 720 }, { id: 'B', kind: 'video', status: 'ready', durationMs: 2500, width: 1280, height: 720 }];
const ASSET_PROPS = { A: { kind: 'video', playable: url('A') }, B: { kind: 'video', playable: url('B') } };

/** A 2 s demo model showing one preset. Returns null for presets without a visual preview. */
function demo(p) {
  const d = compileDefaults(p.id); if (!d) return null;
  const fixed = { op: 'op:project.setDurationPolicy', args: { policy: 'fixed', fixedMs: 2000 } };
  const label = { op: 'op:text.add', args: { text: p.label.id, variant: 'preset:text.lower-third', atMs: 0, durationMs: 2000 } };
  switch (p.category) {
    case 'transition': {
      const m = apply(base(), [{ op: 'op:clip.insert', args: { assetId: 'A', durationMs: 1400 } }, { op: 'op:clip.insert', args: { assetId: 'B', durationMs: 1400 } }], ASSETS);
      return apply(m, [{ op: d.op, target: { kind: 'cut', index: 0 }, args: { ...d.args, durationMs: 800 } }], ASSETS);
    }
    case 'effect': {
      const m = apply(base(), [{ op: 'op:clip.insert', args: { assetId: 'A', durationMs: 2000 } }], ASSETS);
      return apply(m, [{ op: d.op, target: { kind: 'clip', id: m.tracks.video[0].id }, args: d.args }], ASSETS);
    }
    case 'background': return apply(base(), [{ op: d.op, args: d.args }, label, fixed]);
    case 'shape': {
      // ADR-039 infographic pills / cards are wide: give them a w × h demo box (the generic demo is a 200 u square)
      const box = /\.(typing-box|tag|source-tag)$/.test(p.id) ? { size: 640, height: 150 } : /\.browser-card$/.test(p.id) ? { size: 560, height: 380 } : {};
      return apply(base(), [{ op: 'op:background.set', args: { presetId: 'preset:background.solid' } }, { op: d.op, args: { ...d.args, ...box, atMs: 0, durationMs: 2000 } }, fixed]);
    }
    case 'text': return apply(base(), [{ op: 'op:background.set', args: { presetId: 'preset:background.solid' } }, { op: d.op, args: { ...d.args, text: 'Harga Naik Lagi', atMs: 0, durationMs: 2000 } }, fixed]);
    case 'texteffect': case 'motion': {
      const m = apply(base(), [{ op: 'op:background.set', args: { presetId: 'preset:background.solid' } }, { op: 'op:text.add', args: { text: 'Harga Naik Lagi', variant: 'preset:text.title', atMs: 0, durationMs: 2000 } }, fixed]);
      return apply(m, [{ op: d.op, target: { kind: 'text', id: m.tracks.text[0].id }, args: d.args }]);
    }
    case 'caption': return apply(base(), [{ op: 'op:background.set', args: { presetId: 'preset:background.solid' } }, { op: d.op, args: d.args },
      { op: 'op:caption.setPages', args: { pages: [{ text: ' Halo semua kamu', startMs: 0, durationMs: 2000, tokens: [{ text: ' Halo', fromMs: 0, toMs: 650 }, { text: ' semua', fromMs: 650, toMs: 1300 }, { text: ' kamu', fromMs: 1300, toMs: 2000 }] }] } }, fixed]);
    default: return null;   // font, palette, fontpair, easing: generated swatches in the Editor; audio: no visual
  }
}

const todo = listPresets({}).filter((p) => p.preview && (!only || only.includes(p.category)));
const report = { rendered: 0, skipped: 0, failed: [], seconds: 0 };
const t0 = Date.now();
for (const p of todo.slice(0, limit)) {
  const file = path.join(root, 'resources', p.preview);
  if (!force && fs.existsSync(file)) { if (!fs.existsSync(file.replace(/\.webm$/, '.jpg'))) poster(file); report.skipped++; continue; }
  try {
    const model = demo(p);
    if (!model) { report.skipped++; continue; }
    const t = Date.now(); await render(model, ASSET_PROPS, file); poster(file);
    report.rendered++; log({ preset: p.id, seconds: (Date.now() - t) / 1000, bytes: fs.statSync(file).size });
  } catch (e) { report.failed.push({ preset: p.id, error: String(e.message ?? e).slice(0, 300) }); log({ preset: p.id, failed: true }); }
}
server.close();
report.seconds = (Date.now() - t0) / 1000;
report.peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
fs.mkdirSync(outRoot, { recursive: true });
fs.writeFileSync(path.join(outRoot, 'report.json'), JSON.stringify(report, null, 2));
log(report);
if (report.failed.length) process.exit(1);
