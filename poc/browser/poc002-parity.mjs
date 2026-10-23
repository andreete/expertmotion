// POC-002 Linux variant: @remotion/player in Chromium vs renderStill in Chrome Headless Shell, same model, same frames.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import pixelmatch from 'pixelmatch'; import { PNG } from 'pngjs';
import { launch, openPage } from './cdp.mjs';
import { startMediaServer } from '../slice-v0/media-server.mjs';
const here = new URL('.', import.meta.url).pathname, root = new URL('../../', import.meta.url).pathname;
const SCALE = 0.5;
const model = JSON.parse(fs.readFileSync(`${root}poc/slice-v0/out/slice-v0.model.json`, 'utf8'));
const fx = `${root}test/fixtures/media`;
const media = await startMediaServer({ a: `${fx}/clip-a-audio.mp4`, b: `${fx}/clip-b.mp4`, bed: `${fx}/bed.m4a` });
const props = { model, assets: { a: { kind: 'video', playable: media.url('a'), hasAudio: true }, b: { kind: 'video', playable: media.url('b') }, bed: { kind: 'audio', playable: media.url('bed') } }, quality: 'full', watermark: false };
const pub = `${root}packages/engine/public`;
const page = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style><div id="root"></div><script type="module" src="/player.js"></script>'); }
  const file = url === '/player.js' ? `${here}out/player.js` : path.join(pub, path.normalize(url).replace(/^\/+/, ''));
  if (!file.startsWith(pub) && !file.endsWith('player.js') || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
}).listen(4114, '127.0.0.1');
const chrome = await launch(9335);
const results = [];
try {
  const p = await openPage(chrome.port, 'http://127.0.0.1:4114/', { width: 400, height: 700 });
  await new Promise((r) => setTimeout(r, 500));
  const size = await p.evaluate(`window.__mount(${JSON.stringify(props)}, ${SCALE})`);
  const rect = await p.evaluate(`(() => { const r = document.querySelector('#root > div').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  for (const frame of [45, 112, 150]) {
    const ref = PNG.sync.read(fs.readFileSync(`${root}poc/slice-v0/out/still-${frame}.png`));
    let best = null;
    for (const f of frame === 112 ? [111, 112, 113] : [frame]) {         // ±1-frame window only around the transition (POC_PLAN)
      await p.evaluate(`window.__seek(${f})`);
      const shot = PNG.sync.read(await p.screenshot(rect));
      fs.writeFileSync(`${here}out/player-${f}.png`, PNG.sync.write(shot));
      if (shot.width !== ref.width || shot.height !== ref.height) { best = { f, ratio: 1, note: `size ${shot.width}x${shot.height} vs ${ref.width}x${ref.height}` }; continue; }
      const diff = new PNG({ width: ref.width, height: ref.height });
      const n = pixelmatch(ref.data, shot.data, diff.data, ref.width, ref.height, { threshold: 0.1 });
      const ratio = n / (ref.width * ref.height);
      fs.writeFileSync(`${here}out/diff-${f}.png`, PNG.sync.write(diff));
      if (!best || ratio < best.ratio) best = { f, ratio };
    }
    results.push({ frame, matchedFrame: best.f, diffPercent: +(best.ratio * 100).toFixed(3), pass: best.ratio <= 0.01, note: best.note });
  }
  console.log(JSON.stringify({ playerSize: size, rect }));
  if (p.consoleLines.length) console.log('page console:', p.consoleLines.slice(0, 10));
} finally { chrome.close(); page.close(); media.server.close(); }
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  frame ${r.frame} (best ${r.matchedFrame}): ${r.diffPercent} % pixels differ${r.note ? ' — ' + r.note : ''}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
