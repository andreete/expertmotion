// End-to-end on Linux: the built Editor (headless Chrome) against the real Local Service (dev mode).
// Usage (inside the memory cap, ports 4110 service / 4120 UI / 4130 render / 9333 CDP):
//   VITE_EM_API=http://127.0.0.1:4110 VITE_EM_TOKEN=$(cat <dir>/token) npx vite build apps/ui --outDir <dir>/ui
//   E2E_DIR=<dir> bash scripts/run-capped.sh node poc/e2e/run.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, openPage } from '../browser/cdp.mjs';

const root = new URL('../../', import.meta.url).pathname;
const dir = process.env.E2E_DIR; if (!dir) throw new Error('E2E_DIR');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
const dataDir = fs.mkdtempSync(path.join(dir, 'data-'));
const comp = path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu');
const out = path.join(dir, 'shots'); fs.mkdirSync(out, { recursive: true });
const log = (o) => console.log(JSON.stringify(o));
const results = [];
const check = (name, ok, extra = {}) => { results.push({ name, ok: !!ok, ...extra }); log({ check: name, ok: !!ok, ...extra }); };

// 1. Service
const svc = spawn(process.execPath, [path.join(root, 'apps/service/dist/service.cjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  EM_DEV: '1', EM_TEST_FREE_MEM_MB: '4096', EM_PORT: '4110', EM_TOKEN: token, EM_DATA_DIR: dataDir, EM_UI_ORIGIN: 'http://127.0.0.1:4120', EM_RESOURCES: path.join(root, 'resources'),
  EM_FFMPEG: path.join(comp, 'ffmpeg'), EM_FFPROBE: path.join(comp, 'ffprobe'), LD_LIBRARY_PATH: comp } });
let svcLog = ''; svc.stdout.on('data', (d) => { svcLog += d; }); svc.stderr.on('data', (d) => { svcLog += d; });
const api = async (p, init = {}) => { const r = await fetch(`http://127.0.0.1:4110/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4110/api/v1/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
check('service healthy', (await fetch('http://127.0.0.1:4110/api/v1/health')).ok);

// 1b. Licence gate (no Trial Mode): locked until a key issued for this Machine Code is activated. The service must be built
//     with EM_LICENSE_PUBLIC_KEY_A1_HEX and E2E_LICENSE_KEY_FILE / E2E_LICENSE_PASSPHRASE_FILE point at the matching sealed key.
{
  const lic = await api('/license');
  check('unlicensed at first start', lic.body.status === 'unlicensed', { status: lic.body.status });
  check('product locked before activation', (await api('/projects')).status === 403);
  const { execFileSync } = await import('node:child_process');
  const issued = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/license-cli/src/cli.mjs'), 'issue', '--name', 'E2E', '--email', 'e2e@example.com', '--fingerprint', lic.body.machineCode,
    '--key-file', process.env.E2E_LICENSE_KEY_FILE, '--audit', path.join(dataDir, 'audit.csv'), '--out-dir', path.join(dataDir, 'lic'), '--dev-allow-network', '--json'],
    { env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: fs.readFileSync(process.env.E2E_LICENSE_PASSPHRASE_FILE, 'utf8') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const act = await api('/license/activate', { method: 'POST', body: JSON.stringify({ key: issued.key }) });
  check('licence activated', act.status === 200 && act.body.status === 'licensed', { status: act.status });
}

// 2. Static UI server on 4120 (stands in for app://)
const ui = path.join(dir, 'ui');
// Stage the catalogue loops next to the Editor, as scripts/stage-desktop.mjs does for the installer.
if (fs.existsSync(path.join(root, 'resources/catalogue'))) fs.cpSync(path.join(root, 'resources/catalogue'), path.join(ui, 'catalogue'), { recursive: true, filter: (f) => !f.includes('.fixtures') });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const web = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url ?? '/').split('?')[0]); const f = path.join(ui, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ui) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4120, '127.0.0.1', r));

let chrome;
try {
  // 3. Project + assets through the API (the drag-and-drop path is the Shell's file picker)
  const p = await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'E2E Review HP', settings: { ratio: '16:9', resolution: '720p', fps: 30, autoRatio: false } }) });
  check('project created', p.status === 201 || p.status === 200, { status: p.status });
  const pid = p.body.id ?? p.body.project?.id;
  const fx = path.join(root, 'test/fixtures/media');
  const imp = await api(`/projects/${pid}/assets`, { method: 'POST', body: JSON.stringify({ paths: [path.join(fx, 'clip-a-audio.mp4'), path.join(fx, 'clip-b.mp4')] }), headers: { 'X-Expertmotion-Caller': 'shell' } });
  check('import accepted', imp.status < 300, { status: imp.status, body: JSON.stringify(imp.body).slice(0, 300) });
  let assets = [];
  for (let i = 0; i < 120; i++) { assets = (await api(`/projects/${pid}/assets`)).body.items ?? []; if (assets.length === 2 && assets.every((a) => a.status === 'ready' || a.status === 'failed')) break; await new Promise((r) => setTimeout(r, 500)); }
  check('ingest finished', assets.length === 2 && assets.every((a) => a.status === 'ready'), { statuses: assets.map((a) => a.status) });
  const ins = await api(`/projects/${pid}/assets/insert`, { method: 'POST', body: JSON.stringify({ assetIds: assets.map((a) => a.id), order: 'given' }) });
  check('insert', ins.status === 200, { status: ins.status, body: JSON.stringify(ins.body).slice(0, 300) });

  // 4. Editor in headless Chrome. Returning Creator: onboarding done is recorded server-side (FR-004, R-171).
  check('onboarding recorded', (await api('/settings', { method: 'PUT', body: JSON.stringify({ onboardingDone: true }) })).status === 200);
  chrome = await launch(9333);
  let page = await openPage(chrome.port, 'http://127.0.0.1:4120/', { width: 1600, height: 900 });
  // Returning Creator: onboarding already done (prefs live in the Editor origin's localStorage).
  await page.evaluate(`(() => { const k = 'expertmotion.prefs.v1'; const v = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...v, onboardingDone: true, tourDone: true })); return k; })()`);
  page.close(); page = await openPage(chrome.port, 'http://127.0.0.1:4120/', { width: 1600, height: 900 });
  const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await page.evaluate(expr).catch(() => false)) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
  check('editor rendered', await waitFor(`!!document.querySelector('[data-el="hdr.menu.design"]') && !document.querySelector('[data-el^="scr.onboarding"]')`));
  // Dismiss onboarding/tour if shown
  await page.evaluate(`(() => { for (const el of document.querySelectorAll('[data-el$=".skip"], [data-el$=".close"], [data-el="tour.skip"]')) el.click(); return true; })()`).catch(() => {});
  check('project opened in the Editor', await waitFor(`document.body.innerText.includes('E2E Review HP')`));
  check('timeline shows 2 clips', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === 2`), { n: await page.evaluate(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length`) });
  fs.writeFileSync(path.join(out, '1-editor.png'), await page.screenshot({ x: 0, y: 0, width: 1600, height: 900 }));

  // 5. Design ▸ Transitions ▸ Fade (Compile path, no provider)
  await page.evaluate(`document.querySelector('[data-el="hdr.menu.design"]')?.click()`);
  await waitFor(`!!document.querySelector('[data-preset-id="preset:transition.fade"]')`);
  const clicked = await page.evaluate(`(() => { const c = document.querySelector('[data-preset-id="preset:transition.fade"]'); if (!c) return false; c.click(); return true; })()`);
  check('fade card clicked', clicked);
  let transitions = [];
  for (let i = 0; i < 40; i++) { transitions = (await api(`/projects/${pid}/composition?model=true`)).body.head?.model?.transitions ?? []; if (transitions.length) break; await new Promise((r) => setTimeout(r, 250)); }
  const intents = (await api(`/projects/${pid}/intents`)).body;
  log({ intents: JSON.stringify(intents).slice(0, 600) });
  check('fade applied through the service', transitions.length === 1 && transitions[0].presetId === 'preset:transition.fade', { transitions: transitions.map((t) => t.presetId) });
  check('timeline shows the transition', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="transition"]').length === 1`));
  check('intent queue shows the pick', await waitFor(`!!document.querySelector('[data-el^="agent.editor.intentqueue.item"]')`));
  await new Promise((r) => setTimeout(r, 1500));
  fs.writeFileSync(path.join(out, '2-fade.png'), await page.screenshot({ x: 0, y: 0, width: 1600, height: 900 }));

  // 6. Player actually decodes media from the service (grant URL + CORS)
  // Trusted click (autoplay policy): real mouse events at the button's centre through CDP.
  const realClick = async (sel) => {
    const r = await page.evaluate(`(() => { const b = document.querySelector('${sel}')?.getBoundingClientRect(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; })()`);
    if (!r) return false;
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    return true;
  };
  await realClick('[data-el="stage.player.controls.play"]');
  const times = [];
  for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 1000)); times.push(await page.evaluate(`document.querySelector('[data-el="stage.player.controls.time"]')?.textContent ?? document.querySelector('[data-el^="stage.player.controls"]')?.textContent ?? ''`)); }
  check('player advances while playing', new Set(times).size > 2, { times });
  check('player plays past the cut into clip B', times.some((t) => t >= '00:04.00'), { last: times.at(-1), console: page.consoleLines.slice(-6) });
  const media = await page.evaluate(`JSON.stringify(performance.getEntriesByType('resource').filter((e) => e.name.includes('/media/')).map((e) => ({ u: e.name.split('/').slice(-2).join('/'), s: e.responseStatus, b: e.transferSize })))`);
  const playerErr = page.consoleLines.filter((l) => /media|CORS|decode|Failed to load/i.test(l)).slice(0, 5);
  check('player fetched media from the service', JSON.parse(media).some((e) => e.s === 200 || e.s === 206), { media: media.slice(0, 400), playerErr });
  fs.writeFileSync(path.join(out, '3-playing.png'), await page.screenshot({ x: 0, y: 0, width: 1600, height: 900 }));

  // 7. Export 720p via the API (the same route the Export dialog calls); Trial Mode → watermark
  const job = await api('/renders', { method: 'POST', body: JSON.stringify({ projectId: pid, performanceProfile: 'standard', outputProfile: { ratio: '16:9', resolution: '720p', fps: 30, format: 'mp4', codec: 'h264' } }) });
  check('render accepted', job.status < 300, { status: job.status, code: job.body?.error?.code });
  const jobId = job.body.id ?? job.body.job?.id;
  let st = {};
  for (let i = 0; i < 240 && jobId; i++) { st = (await api(`/renders/${jobId}`)).body; if (['done', 'failed', 'cancelled'].includes(st.status)) break; await new Promise((r) => setTimeout(r, 1000)); }
  check('render done', st.status === 'done', { status: st.status, error: st.error ?? st.errorCode });
  const errs = page.consoleLines.filter((l) => /EXCEPTION|error/i.test(l));
  check('no page exceptions', !page.consoleLines.some((l) => l.startsWith('EXCEPTION')), { sample: errs.slice(0, 8) });
  page.close();
} finally {
  chrome?.close(); web.close(); svc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  fs.writeFileSync(path.join(dir, 'service.log'), svcLog);
  const failed = results.filter((r) => !r.ok);
  log({ summary: `${results.length - failed.length}/${results.length} passed`, failed: failed.map((f) => f.name), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
  process.exitCode = failed.length ? 1 : 0;
}
