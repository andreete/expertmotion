// Stage 2 task 4 / slice v0 on Linux: Composition Model JSON → prebuilt bundle → selectComposition + renderMedia + renderStill.
// Run inside the memory cap: bash scripts/run-capped.sh node poc/slice-v0/render.mjs
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { applyOperations, createEmptyModel, deriveFrameTiming } from '@expertmotion/composition-model';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { startMediaServer } from './media-server.mjs';

const root = new URL('../../', import.meta.url).pathname;
const serveUrl = `${root}resources/engine/bundle`;
const fx = `${root}test/fixtures/media`;
const out = `${root}poc/slice-v0/out`; fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(fx, { recursive: true });
const bin = `${root}node_modules/@remotion/compositor-linux-x64-gnu`;
const probe = (f) => JSON.parse(execFileSync(`${bin}/ffprobe`, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).toString());
const SCALE = Number(process.env.SLICE_SCALE ?? 0.5);
const log = (o) => console.log(JSON.stringify(o));
let n = 0; const newId = () => `e${++n}`;
const apply = (m, ops, assets) => { const r = applyOperations(m, ops, { assets, tier: 'T0', newId }); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model; };
const opts = { chromiumOptions: { gl: 'swangle' }, concurrency: 1, logLevel: 'error' };   // T0 / no GPU on this server (PERFORMANCE §1)

const tb = Date.now(); await ensureBrowser(); log({ step: 'ensureBrowser', seconds: (Date.now() - tb) / 1000 });

// 1) Fixture media made by the engine itself (no third-party media, no licence questions)
async function renderFixture(name, ratio, palette, title) {
  let m = createEmptyModel('fx', { autoRatio: false, ratio, resolution: '720p' });
  m = apply(m, [
    { op: 'op:theme.set', args: { paletteId: palette } },
    { op: 'op:background.set', args: { presetId: 'preset:background.moving-gradient', params: { angle: 30 } } },
    { op: 'op:shape.add', args: { presetId: 'preset:shape.star', atMs: 0, durationMs: 4000, motionId: 'preset:motion.pop' } },
    { op: 'op:text.add', args: { text: title, variant: 'preset:text.title', atMs: 0, durationMs: 4000 } },
    { op: 'op:project.setDurationPolicy', args: { policy: 'fixed', fixedMs: 4000 } },
  ], []);
  const inputProps = { model: m, assets: {}, quality: 'full', watermark: false };
  const comp = await selectComposition({ serveUrl, id: 'ExpertmotionTimeline', inputProps, ...opts });
  const file = `${fx}/${name}.mp4`; const t0 = Date.now();
  await renderMedia({ composition: comp, serveUrl, codec: 'h264', crf: 28, outputLocation: file, inputProps, scale: 0.5, ...opts });
  log({ step: `fixture ${name}`, seconds: (Date.now() - t0) / 1000, dims: `${comp.width}x${comp.height}`, frames: comp.durationInFrames });
  return file;
}
const clipA = fs.existsSync(`${fx}/clip-a.mp4`) ? `${fx}/clip-a.mp4` : await renderFixture('clip-a', '16:9', 'preset:palette.neon-tech', 'Klip A');
const clipB = fs.existsSync(`${fx}/clip-b.mp4`) ? `${fx}/clip-b.mp4` : await renderFixture('clip-b', '9:16', 'preset:palette.pastel-friendly', 'Klip B');
if (!fs.existsSync(`${fx}/bed.m4a`)) execFileSync(`${bin}/ffmpeg`, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', `${fx}/bed.m4a`]);
// Add an audio track to clip A so ducking has speech to react to (sine stands in for a voice)
if (!fs.existsSync(`${fx}/clip-a-audio.mp4`)) execFileSync(`${bin}/ffmpeg`, ['-hide_banner', '-loglevel', 'error', '-y', '-i', clipA, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-shortest', `${fx}/clip-a-audio.mp4`]);
const dur = (f) => Math.round(Number(probe(f).format.duration) * 1000);

// 2) Slice v0: two Clips, a fade, a title with highlight, captions, an effect, a ducked music bed — all from JSON
const media = await startMediaServer({ a: `${fx}/clip-a-audio.mp4`, b: clipB, bed: `${fx}/bed.m4a` });
const assets = [
  { id: 'a', kind: 'video', status: 'ready', durationMs: dur(`${fx}/clip-a-audio.mp4`), width: 640, height: 360, hasAudio: true },
  { id: 'b', kind: 'video', status: 'ready', durationMs: dur(clipB), width: 360, height: 640, hasAudio: false },
  { id: 'bed', kind: 'audio', status: 'ready', durationMs: dur(`${fx}/bed.m4a`) },
];
let model = createEmptyModel('slice', { autoRatio: false, ratio: '9:16', resolution: '720p', fps: 30 });
model = apply(model, [
  { op: 'op:clip.insert', args: { assetId: 'a' } },
  { op: 'op:clip.insert', args: { assetId: 'b' } },
  { op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.fade', durationMs: 500 } },
  { op: 'op:background.set', args: { presetId: 'preset:background.video-dim' } },
  { op: 'op:text.add', args: { text: 'Harga cabai naik lagi', variant: 'preset:text.title', atMs: 300, durationMs: 3000 } },
  { op: 'op:caption.setStyle', args: { presetId: 'preset:caption.karaoke' } },
  { op: 'op:caption.setPages', args: { pages: [{ text: ' Halo semua kamu', startMs: 4200, durationMs: 1800, tokens: [{ text: ' Halo', fromMs: 4200, toMs: 4800 }, { text: ' semua', fromMs: 4800, toMs: 5400 }, { text: ' kamu', fromMs: 5400, toMs: 6000 }] }] } },
  { op: 'op:audio.addBed', args: { assetId: 'bed', volume: 0.5, loop: true, fadeInMs: 500, fadeOutMs: 500, duckingPresetId: 'preset:audio.duck-voice' } },
], assets);
model = apply(model, [
  { op: 'op:text.setEffect', target: { kind: 'text', id: model.tracks.text[0].id }, args: { presetId: 'preset:texteffect.highlight' } },
  { op: 'op:effect.add', target: { kind: 'clip', id: model.tracks.video[0].id }, args: { presetId: 'preset:effect.vignette' } },
], assets);
fs.writeFileSync(`${out}/slice-v0.model.json`, JSON.stringify(model, null, 2));
const inputProps = { model, assets: { a: { kind: 'video', playable: media.url('a'), hasAudio: true }, b: { kind: 'video', playable: media.url('b') }, bed: { kind: 'audio', playable: media.url('bed') } }, quality: 'full', watermark: false };
const comp = await selectComposition({ serveUrl, id: 'ExpertmotionTimeline', inputProps, ...opts });
const expected = deriveFrameTiming(model);
const t0 = Date.now(); let lastPct = -1;
await renderMedia({ composition: comp, serveUrl, codec: 'h264', outputLocation: `${out}/slice-v0.mp4`, inputProps, scale: SCALE, ...opts,
  onProgress: ({ progress }) => { const p = Math.floor(progress * 4) * 25; if (p !== lastPct) { lastPct = p; log({ render: p }); } } });
const seconds = (Date.now() - t0) / 1000;
const p = probe(`${out}/slice-v0.mp4`); const v = p.streams.find((s) => s.codec_type === 'video'); const a = p.streams.find((s) => s.codec_type === 'audio');
const [num, den] = v.r_frame_rate.split('/').map(Number);
log({ step: 'slice-v0', seconds, composition: `${comp.width}x${comp.height}@${comp.fps} ${comp.durationInFrames}f`, expectedFrames: expected.durationInFrames,
  output: { codec: v.codec_name, width: v.width, height: v.height, fps: num / den, frames: Number(v.nb_frames), durationS: Number(p.format.duration), audio: a?.codec_name ?? null } });

// 3) Golden still frames for parity work (POC-002): mid clip A, mid fade, highlighted caption word
for (const frame of [45, Math.round(expected.clipStartFrames[1] + expected.transitionFrames[0] / 2) - 1, 150]) {
  await renderStill({ composition: comp, serveUrl, frame, output: `${out}/still-${frame}.png`, inputProps, imageFormat: 'png', scale: SCALE, ...opts });
}
log({ step: 'stills', files: fs.readdirSync(out).filter((f) => f.startsWith('still-')) });
log({ peakRssMbNode: Math.round(process.resourceUsage().maxRSS / 1024) });
media.server.close();
