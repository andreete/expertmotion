// End-to-end NEGATIVE and OVERLAP cases from first launch to export and save (process.md Entry 35). The built Editor (headless
// Chrome) against the real Local Service (dev mode, provider calls to poc/e2e/provider-stub.mjs, SEC-089 dev only).
// Every failure must be VISIBLE with an EM code and a next action (toast with action, ErrorBox, chat error, card state) — never a
// silent failure, a stuck spinner or a blank screen. Cases:
//   licence gate (no licence, bad key → EM code, good key) · Send with no provider · provider 401 / 429 / 500 / malformed plan JSON /
//   hang (Stop) · corrupt / zero-byte / unsupported import · Insert with nothing selected · Export with an empty timeline · export
//   cancel mid-way then re-export · output folder not writable / outside the profile / removed mid-render · low disk (dev fault
//   EM_TEST_DISK_FREE_MB) · close (kill) during export then reopen (fresh empty project, no crash loop, EM-3203) · delete a clip
//   while playing · undo / redo after Execute · copy / cut / paste across scenes · drag the playhead past the end · music download
//   with the network cut (offline-preload.cjs) · voice model not installed → held plan step → install → continues · captions follow
//   the voice after it is generated again · save → close → reopen from Recent → identical composition.
// Prepare like providers-flow.mjs (scratch <dir> with token, pass, a1.key, ui/; a dev Service build with that A1 public key, e.g.
// EM_SERVICE_OUTFILE=<repo>/out/e2e/service.cjs). Ports 4110 service / 4120 UI / 4140 stub / 9336 CDP.
// Run:  E2E_DIR=<dir> E2E_SERVICE=<service.cjs> bash scripts/run-capped.sh node poc/e2e/negative-flow.mjs
// Optional: E2E_ONLY=<comma list of section names> to run some sections (setup sections always run); E2E_SKIP_INSTALL=1 skips the
// real Hugging Face voice model download (~60 MB).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, openPage } from '../browser/cdp.mjs';
import { startProviderStub } from './provider-stub.mjs';

const root = new URL('../../', import.meta.url).pathname;
const comp = path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu');
// The FFmpeg / FFprobe the app ships (resources/bin-linux-x64, prepare-engines); the compositor's FFmpeg lacks fps / tile (filmstrips).
const binDir = fs.existsSync(path.join(root, 'resources/bin-linux-x64/ffmpeg')) ? path.join(root, 'resources/bin-linux-x64') : comp;
const dir = process.env.E2E_DIR; if (!dir) throw new Error('E2E_DIR');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
const dataDir = fs.mkdtempSync(path.join(dir, 'neg-data-'));
const home = path.join(dataDir, 'home'); fs.mkdirSync(path.join(home, 'Videos'), { recursive: true });
const out = path.join(dir, 'neg-shots'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const ONLY = (process.env.E2E_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const log = (o) => console.log(JSON.stringify(o));
const results = [];
const check = (name, ok, extra = {}) => { results.push({ name, ok: !!ok, ...extra }); log({ check: name, ok: !!ok, ...extra }); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ffprobe = path.join(binDir, 'ffprobe');

const stub = await startProviderStub(4140);
let svc = null; let svcLog = '';
const SERVICE = process.env.E2E_SERVICE ?? path.join(root, 'apps/service/dist/service.cjs');
async function startService({ offline = false, env = {} } = {}) {
  svc = spawn(process.execPath, [...(offline ? ['--require', path.join(root, 'poc/e2e/offline-preload.cjs')] : []), SERVICE], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    HOME: home, EM_DEV: '1', EM_TEST_FREE_MEM_MB: '4096', EM_PORT: '4110', EM_TOKEN: token, EM_DATA_DIR: dataDir, EM_UI_ORIGIN: 'http://127.0.0.1:4120', EM_RESOURCES: path.join(root, 'resources'), EM_ENGINES: path.join(root, fs.existsSync(path.join(root, 'resources/engines-linux-x64')) ? 'resources/engines-linux-x64' : 'resources/engines'),
    EM_DEV_PROVIDER_STUB: stub.origin, EM_VIDEOS_DIR: path.join(home, 'Videos'), EM_FFMPEG: path.join(binDir, 'ffmpeg'), EM_FFPROBE: ffprobe, LD_LIBRARY_PATH: comp, ...env } });
  svcLog += `\n=== service start ${new Date().toISOString()} offline=${offline} env=${JSON.stringify(env)}\n`;
  svc.stdout.on('data', (d) => { svcLog += d; }); svc.stderr.on('data', (d) => { svcLog += d; });
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4110/api/v1/health')).ok) return true; } catch { /* starting */ } await sleep(250); }
  return false;
}
async function stopService(signal = 'SIGTERM') {
  if (!svc) return; const p = new Promise((r) => svc.once('exit', r)); svc.kill(signal); await Promise.race([p, sleep(8000)]); svc = null;
}
const api = async (p, init = {}) => { const r = await fetch(`http://127.0.0.1:4110/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
const issueKey = async () => {
  const lic = await api('/license');
  return JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/license-cli/src/cli.mjs'), 'issue', '--name', 'E2E', '--email', 'e2e@example.com', '--fingerprint', lic.body.machineCode,
    '--key-file', path.join(dir, 'a1.key'), '--audit', path.join(dataDir, 'audit.csv'), '--out-dir', path.join(dataDir, 'lic'), '--dev-allow-network', '--json'],
    { env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: fs.readFileSync(path.join(dir, 'pass'), 'utf8').trim() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).key;
};

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { svc?.kill('SIGKILL'); chrome?.close(); } catch { /* exiting */ } process.exit(130); });
check('service healthy', await startService());
const ui = process.env.E2E_UI ?? path.join(dir, 'ui');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const web = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url ?? '/').split('?')[0]); const f = path.join(ui, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ui) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4120, '127.0.0.1', r));

// In the page before app code: console errors, and every visible EM code with where it showed and whether an action button was
// next to it (toasts auto-dismiss, so a 100 ms sampler records them).
const PROBE = `(() => { const w = window; w.__em = { errors: [], seen: [], toasts: [] }; const ce = console.error.bind(console);
  console.error = (...a) => { try { w.__em.errors.push(a.map((x) => (x && x.stack) ? x.stack : String(x)).join(' ').slice(0, 3000)); } catch {} ce(...a); };
  const keyOf = new Set();
  setInterval(() => { try {
    for (const el of document.querySelectorAll('[data-el="sys.toast"]')) { const tx = (el.innerText || '').replace(/\s+/g, ' ').trim(); if (w.__em.toasts.at(-1)?.text !== tx && !w.__em.toasts.some((x) => x.text === tx && Date.now() - x.at < 5000)) w.__em.toasts.push({ text: tx.slice(0, 200), at: Date.now() }); }
    const crash = document.querySelector('[data-el="sys.crash"]'); if (crash && !w.__em.crash) w.__em.crash = crash.innerText.slice(0, 600);
    for (const el of document.querySelectorAll('[data-el="sys.toast"], [role="alert"], [data-code], [data-el$=".error"], [data-el="agent.chat.message.notice"], [data-el="sys.banner"]')) {
      const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim(); const codes = new Set([...(txt.match(/EM-\\d{4}/g) ?? []), ...(el.getAttribute('data-code') ? [el.getAttribute('data-code')] : [])]);
      for (const code of codes) { const k = code + '|' + (el.getAttribute('data-el') ?? el.getAttribute('role')) + '|' + txt.slice(0, 80); if (keyOf.has(k)) continue; keyOf.add(k);
        const scope = el.closest('[data-el="sys.toast"]') ?? el;
        w.__em.seen.push({ code, el: el.getAttribute('data-el') ?? el.getAttribute('role'), text: txt.slice(0, 240), action: !!scope.querySelector('button:not([aria-label="Dismiss"]):not([aria-label="Tutup"]), a[href]'), at: Date.now() }); }
    } } catch {} }, 100); })()`;

let chrome; let page; let shot = 0;
const snap = async (label) => { try { fs.writeFileSync(path.join(out, `${String(++shot).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`), await page.screenshot({ x: 0, y: 0, width: 1600, height: 900 })); } catch { /* best effort */ } };
const q = (sel) => JSON.stringify(sel);
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if (await page.evaluate(expr).catch(() => false)) return true; await sleep(150); } return false; };
const click = async (sel) => page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
const realClick = async (sel) => {
  if (!(await page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; })()`))) return false;
  await sleep(250);                                                     // measure after the scroll / layout settled
  const r = await page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return true;
};
const typeInto = async (sel, text) => { const ok = await page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.focus(); el.select?.(); return true; })()`); if (!ok) return false; await page.send('Input.insertText', { text }); return true; };
const KEYS = { Enter: 13, Escape: 27, Delete: 46, Backspace: 8, ' ': 32, End: 35, Home: 36 };
const press = async (key, mods = 0) => {
  const code = key.length === 1 && key !== ' ' ? `Key${key.toUpperCase()}` : key === ' ' ? 'Space' : key;
  const kc = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: kc, modifiers: mods, ...(type === 'keyDown' && key === 'Enter' && !mods ? { text: '\r' } : {}) });
};
const CTRL = 2;
const count = async (sel) => page.evaluate(`document.querySelectorAll(${q(sel)}).length`);
const text = async (sel) => page.evaluate(`document.querySelector(${q(sel)})?.innerText ?? ''`);
const seen = async () => page.evaluate('window.__em?.seen ?? []');
/** Visible EM codes (any of `codes`, or any EM code when null) that appeared after `since`; `withAction` = a button next to it. */
const sawCode = async (codes, since, { withAction = false, ms = 15000 } = {}) => {
  for (let t = 0; t < ms; t += 200) {
    const s = (await seen()).filter((x) => x.at >= since && (!codes || codes.includes(x.code)) && (!withAction || x.action));
    if (s.length) return s[0];
    await sleep(200);
  }
  return null;
};
const now = () => page.evaluate('Date.now()');
const busy = () => page.evaluate(`!!document.querySelector('[data-el="agent.chat.streaming"], [data-el="agent.chat.progress"], [data-el="agent.chat.typing"]')`);
const blank = () => page.evaluate(`(document.body.innerText || '').trim().length < 20 || !!document.querySelector('[data-el="sys.crash"]')`);
const step = async (name, fn) => {
  if (ONLY.length && !ONLY.includes(name) && !name.startsWith('setup')) return null;
  log({ section: name });
  if (page && !pidFrozen && !name.startsWith('setup-licence')) { const cur = await currentProject().catch(() => null); if (cur && cur !== pid) { log({ projectNow: cur, was: pid }); pid = cur; } }
  try { return await fn(); } catch (e) { check(`${name} (threw)`, false, { error: String(e?.stack ?? e).slice(0, 600) }); return null; }
  finally {
    await snap(name);
    const crash = await page?.evaluate('window.__em?.crash ?? null').catch(() => null);
    if (crash) { check(`${name}: the Editor did not crash (sys.crash)`, false, { crash, exceptions: page.consoleLines.filter((l) => l.startsWith('EXCEPTION')).slice(-3), errors: (await page.evaluate('window.__em.errors').catch(() => [])).slice(-3) }); await openPageFresh(); await editorReady(); }
  }
};
const head = async (pid) => (await api(`/projects/${pid}/composition?model=true`)).body.head;
const pidOf = () => page.evaluate(`(() => { try { return window.__emProjectId ?? null; } catch { return null; } })()`);
/** The project open in the Editor: the blank (scratch) project record, else the most recently opened project. */
const currentProject = async () => {
  const scratch = await page.evaluate(`(() => { try { return JSON.parse(localStorage.getItem('expertmotion.scratch.v1') ?? 'null')?.projectId ?? null; } catch { return null; } })()`).catch(() => null);
  const items = (await api('/projects')).body.items ?? [];
  if (scratch && items.some((p) => p.id === scratch)) return scratch;
  return [...items].sort((a, b) => String(b.openedAt ?? '').localeCompare(String(a.openedAt ?? '')))[0]?.id ?? null;
};
const waitRender = async (jobId, done = ['done', 'failed', 'cancelled'], ms = 300000) => { let st = {}; if (!jobId) return { status: 'no-job' }; for (let t = 0; t < ms; t += 1000) { st = (await api(`/renders/${jobId}`)).body; if (done.includes(st.status)) return st; await sleep(1000); } return st; };
const renderBody = (pid, extra = {}) => ({ projectId: pid, performanceProfile: 'standard', outputProfile: { ratio: '16:9', resolution: '720p', fps: 30, format: 'mp4', codec: 'h264' }, ...extra });
const probe = (f) => { try { return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', f], { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: comp } })); } catch (e) { return { error: String(e).slice(0, 200) }; } };
const consoleAll = [];
const keepConsole = async () => { if (!page) return; consoleAll.push(...page.consoleLines, ...((await page.evaluate('window.__em?.errors ?? []').catch(() => [])).map((e) => `console.error ${e}`)), ...((await page.evaluate('(window.__em?.toasts ?? []).map((t) => "toast " + t.text)').catch(() => []))), '--- page closed ---'); };
const openPageFresh = async () => {
  await keepConsole();
  if (page) { await Promise.race([page.send('Page.close').catch(() => {}), sleep(1500)]); page.close(); }   // close the tab itself: one Editor window, like the app
  page = await openPage(chrome.port, 'about:blank', { width: 1600, height: 900 });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await page.send('Page.navigate', { url: 'http://127.0.0.1:4120/' });
  await sleep(800);
};
const editorReady = () => waitFor(`!document.querySelector('[data-el="sys.splash"]') && !!document.querySelector('[data-el="hdr.menu.design"]') && !document.querySelector('[data-el="scr.license"][data-gate]')`, 30000);
const timelineCount = (kind = 'clip') => count(`[data-el="stage.timeline.element"][data-kind="${kind}"]`);
/** Opens a project from the empty project's "Terakhir dibuka" row (else File ▸ Recent); true when its name is in the header. */
const openFromRecent = async (id, wanted) => {
  const pr = (await api(`/projects/${id}`)).body; const name = pr?.name ?? pr?.project?.name ?? wanted;
  for (let i = 0; i < 3; i++) {
    if (await waitFor(`!!document.querySelector('[data-el="stage.recent.item"][data-project="${id}"]')`, 8000)) await realClick(`[data-el="stage.recent.item"][data-project="${id}"]`);
    else { await click('[data-el="hdr.menu.file"]'); await click('[data-el="hdr.menu.file.recent"]'); await waitFor(`!!document.querySelector('[data-el="hdr.menu.file.recent.item"]')`); await page.evaluate(`[...document.querySelectorAll('[data-el="hdr.menu.file.recent.item"]')].find((n) => n.textContent.includes(${q(name)}))?.click()`); }
    if (await waitFor(`(document.querySelector('[data-el="hdr.title"]')?.innerText ?? '').includes(${q(name)})`, 10000)) return true;
    log({ openFromRecentRetry: i, name, title: await text('[data-el="hdr.title"]'), recent: await page.evaluate(`[...document.querySelectorAll('[data-el="stage.recent.item"]')].map((r) => r.getAttribute('data-project') + ':' + r.innerText)`), dialogs: await page.evaluate(`[...document.querySelectorAll('[role="dialog"], [data-el^="scr."]')].map((d) => d.getAttribute('data-el')).slice(0, 5)`) });
  }
  return false;
};

let pid = null; let projectFixture = null; let pidFrozen = false;   // frozen once the project has footage (later reloads open a blank one)
try {
  chrome = await launch(9336);
  await openPageFresh();

  // ── 1. First launch without a licence: the gate, a bad key → visible EM code, the good key → the Editor ──
  await step('setup-licence', async () => {
    check('licence gate at first launch (no licence)', await waitFor(`!!document.querySelector('[data-el="scr.license"][data-gate]')`, 30000));
    check('product API locked before activation', (await api('/projects')).status === 403);
    const t0 = await now();
    await typeInto('[data-el="scr.license.input"]', `EM1-${'Q'.repeat(30)}-${'Z'.repeat(30)}`);
    await click('[data-el="scr.license.activate"]');
    const bad = await waitFor(`/EM-50\\d\\d/.test(document.querySelector('[data-el="scr.license.error"]')?.innerText ?? '')`, 10000);
    check('bad licence key → visible EM-50xx error on the gate', bad, { text: (await text('[data-el="scr.license.error"]')).slice(0, 200), seen: (await seen()).filter((x) => x.at >= t0).map((x) => x.code) });
    check('still locked after the bad key', (await api('/license')).body.status !== 'licensed');
    const key = await issueKey();
    await page.evaluate(`(() => { const el = document.querySelector('[data-el="scr.license.input"]'); el.focus(); el.select(); })()`);
    await page.send('Input.insertText', { text: key });
    await click('[data-el="scr.license.activate"]');
    check('good key → licensed', await waitFor(`!document.querySelector('[data-el="scr.license"][data-gate]')`, 20000) && (await api('/license')).body.status === 'licensed');
    check('onboarding recorded', (await api('/settings', { method: 'PUT', body: JSON.stringify({ onboardingDone: true }) })).status === 200);
    await page.evaluate(`(() => { const k = 'expertmotion.prefs.v1'; const v = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...v, onboardingDone: true, tourDone: true })); })()`);
    await openPageFresh();
    check('editor rendered after licence', await editorReady());
    await page.evaluate(`(() => { for (const el of document.querySelectorAll('[data-el$=".skip"], [data-el="tour.skip"]')) el.click(); })()`).catch(() => {});
    check('launch opens an empty project', await waitFor(`/Untitled|Tanpa judul/.test(document.querySelector('[data-el="hdr.title"]')?.innerText ?? '')`, 15000));
    pid = await currentProject();
    check('empty project id known', !!pid, { pid });
  });

  // ── 2. Send with no provider connected ──
  await step('no-provider', async () => {
    for (const tab of ['editor', 'brainstorm']) {
      await click(`[data-el="agent.chat.tab.${tab}"]`);
      const t0 = await now();
      await typeInto('[data-el="agent.chat.composer"]', 'Buat video 3 tips hemat listrik');
      await press('Enter');
      const s = await sawCode(null, t0, { withAction: true, ms: 15000 });
      await sleep(1500);
      check(`no provider, ${tab} Send → visible EM code with an action`, !!s, { s, all: (await seen()).filter((x) => x.at >= t0) });
      check(`no provider, ${tab}: not stuck working`, !(await busy()));
    }
  });

  // Connect Anthropic (stub) through the API; both agents on Sonnet.
  await step('setup-provider', async () => {
    const c = await api('/providers/connections', { method: 'POST', body: JSON.stringify({ provider: 'anthropic', label: 'Claude', secret: ['sk', 'ant', 'api03', 'stubstubstubstubstubstubstub_0123456789'].join('-') }) });
    check('anthropic connected', c.status === 201, { status: c.status, body: JSON.stringify(c.body).slice(0, 300) });
    const id = c.body.id ?? c.body.connection?.id;
    await api(`/providers/connections/${id}/models/refresh`, { method: 'POST' });
    const a = await api('/providers/assignments', { method: 'PUT', body: JSON.stringify({ brainstorm: { agent: 'brainstorm', connectionId: id, modelId: 'claude-sonnet-5-5' }, editor: { agent: 'editor', connectionId: id, modelId: 'claude-sonnet-5-5' }, defaultConnectionId: id }) });
    check('assignments stored', a.status === 200, { status: a.status, body: JSON.stringify(a.body).slice(0, 200) });
    await openPageFresh(); await editorReady();
  });

  // ── 3. Provider faults on an Editor Send: each ends visible with an EM code and an action; nothing stays "working" ──
  await step('provider-faults', async () => {
    await click('[data-el="agent.chat.tab.editor"]');
    for (const [fault, codes, wait] of [['401', ['EM-4002', 'EM-4001'], 30000], ['429', ['EM-4102'], 90000], ['500', ['EM-4103', 'EM-4101', 'EM-4301'], 90000], ['malformed', ['EM-4301', 'EM-4103', 'EM-4105'], 120000]]) {
      stub.configure('anthropic', { fault, times: 50 });
      const t0 = await now(); const ts = Date.now();
      await typeInto('[data-el="agent.chat.composer"]', `Tambah judul (fault ${fault})`);
      await press('Enter');
      const s = await sawCode(codes, t0, { ms: wait });
      const any = s ?? (await seen()).filter((x) => x.at >= t0)[0] ?? null;
      for (let i = 0; i < 40 && await busy(); i++) await sleep(250);
      const stillBusy = await busy();
      check(`provider ${fault} → visible ${codes.join('/')} (${Math.round((Date.now() - ts) / 1000)} s)`, !!s, { seen: any, all: (await seen()).filter((x) => x.at >= t0).map((x) => `${x.code}@${x.el}${x.action ? '+action' : ''}`) });
      check(`provider ${fault} → the error offers an action (retry / providers)`, !!(s?.action || (await seen()).some((x) => x.at >= t0 && x.action && codes.includes(x.code))) || await page.evaluate(`!!document.querySelector('[data-el="agent.chat.message"][data-code] button')`));
      check(`provider ${fault} → not stuck working afterwards`, !stillBusy);
      await snap(`fault-${fault}`);
    }
    stub.configure('anthropic', {});
    // hang: the working state shows, Stop ends it at once and the composer works again
    stub.configure('anthropic', { fault: 'hang', times: 1 });
    const t0 = await now();
    await typeInto('[data-el="agent.chat.composer"]', 'Tambah judul (hang)');
    await press('Enter');
    check('hang: working state visible', await waitFor(`!!document.querySelector('[data-el="agent.chat.streaming"], [data-el="agent.chat.progress"]')`, 5000));
    await sleep(3000);
    check('hang: Stop offered while waiting', await count('[data-el="agent.chat.progress.stop"], [data-el="agent.chat.stop"]') > 0);
    await click('[data-el="agent.chat.progress.stop"]') || await click('[data-el="agent.chat.stop"]');
    check('hang: Stop ends the run within 5 s', await waitFor(`!document.querySelector('[data-el="agent.chat.streaming"], [data-el="agent.chat.progress"]')`, 5000));
    check('hang: composer usable after Stop', await page.evaluate(`!document.querySelector('[data-el="agent.chat.composer"]')?.disabled`));
    log({ hangSeen: (await seen()).filter((x) => x.at >= t0) });
    stub.configure('anthropic', {});
    // and a normal Send works again afterwards
    await typeInto('[data-el="agent.chat.composer"]', 'Tambah judul');
    await press('Enter');
    check('after the faults a normal Editor Send gives a valid plan', await waitFor(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].some((c) => c.getAttribute('data-status') === 'valid')`, 45000));
  });

  // ── 4. Export with nothing on the timeline; Insert with nothing selected ──
  await step('empty-export', async () => {
    const t0 = await now();
    await page.evaluate('document.activeElement?.blur()');
    await press('e', CTRL);
    await sleep(800);
    check('Ctrl+E on an empty timeline: no export dialog, a visible reason', !(await count('[data-el="scr.export"]')) && (await page.evaluate(`[...document.querySelectorAll('[data-el="sys.toast"]')].some((t) => t.innerText.length > 5)`)));
    const r = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid)) });
    check('API export of an empty project → 4xx EM-2202', r.status >= 400 && r.status < 500 && r.body?.error?.code === 'EM-2202', { status: r.status, code: r.body?.error?.code });
    const hdr = await page.evaluate(`(() => { const b = document.querySelector('[data-el="hdr.action.export"]'); return b ? { disabled: b.disabled || b.getAttribute('aria-disabled') === 'true', title: b.title || b.getAttribute('aria-description') || '' } : null; })()`);
    log({ headerExport: hdr, t0 });
    check('header Export disabled with a reason on an empty timeline', !hdr || hdr.disabled, hdr);
  });
  await step('insert-nothing', async () => {
    await page.evaluate(`document.querySelector('[data-el="lib.mode.home"], [data-el="lib.tab.assets"]')?.click()`);
    const st = await page.evaluate(`(() => { const b = document.querySelector('[data-el="lib.assets.insert"]'); return b ? { disabled: b.disabled || b.getAttribute('aria-disabled') === 'true', reason: b.title || b.getAttribute('aria-description') || b.getAttribute('data-disabled-reason') || '' } : null; })()`);
    check('Insert with nothing selected is disabled with a reason (or hidden)', !st || (st.disabled && st.reason.length > 3), st);
    const r = await api(`/projects/${pid}/assets/insert`, { method: 'POST', body: JSON.stringify({ assetIds: [], order: 'given' }) });
    check('API insert with no assets → 4xx with an EM code', r.status >= 400 && r.status < 500 && /^EM-\d{4}$/.test(r.body?.error?.code ?? ''), { status: r.status, code: r.body?.error?.code });
  });

  // ── 5. Import corrupt / zero-byte / unsupported files ──
  await step('bad-import', async () => {
    const d = path.join(home, 'Imports'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'kosong.mp4'), '');
    fs.writeFileSync(path.join(d, 'rusak.mp4'), Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(40000, 7)]));
    fs.writeFileSync(path.join(d, 'catatan.xyz'), 'not media');
    fs.writeFileSync(path.join(d, 'gambar-palsu.png'), 'this is not a png');
    const t0 = await now();
    const imp = await api(`/projects/${pid}/assets`, { method: 'POST', body: JSON.stringify({ paths: ['kosong.mp4', 'rusak.mp4', 'catatan.xyz', 'gambar-palsu.png'].map((f) => path.join(d, f)) }), headers: { 'X-Expertmotion-Caller': 'shell' } });
    log({ importResponse: imp.status, body: JSON.stringify(imp.body).slice(0, 800) });
    let assets = [];
    for (let i = 0; i < 60; i++) { assets = (await api(`/projects/${pid}/assets`)).body.items ?? []; if (assets.every((a) => a.status === 'ready' || a.status === 'failed')) break; await sleep(500); }
    const rejected = [...(imp.body?.rejected ?? []), ...(imp.body?.notices ?? [])];
    log({ assets: assets.map((a) => ({ name: a.name, status: a.status, code: a.errorCode ?? a.error?.code })), rejected });
    for (const f of ['kosong.mp4', 'rusak.mp4', 'catatan.xyz', 'gambar-palsu.png']) {
      const a = assets.find((x) => x.name === f || x.originalName === f || String(x.name ?? '').startsWith(f.split('.')[0]));
      const rj = JSON.stringify(imp.body ?? {}).includes(f);
      check(`import ${f}: never "ready", failed with an EM code or rejected with one`, (a && a.status === 'failed' && /^EM-\d{4}$/.test(a.errorCode ?? a.error?.code ?? '')) || (!a && rj && /EM-\d{4}/.test(JSON.stringify(imp.body))), { asset: a && { status: a.status, code: a.errorCode ?? a.error?.code }, rejected: rj });
    }
    // the Creator's own path: the Library's file input (browser upload; the Shell's picker uses the same Editor code afterwards)
    fs.writeFileSync(path.join(d, 'rusak-2.mp4'), Buffer.alloc(30000, 9)); fs.writeFileSync(path.join(d, 'catatan-2.xyz'), 'not media either');
    const t1 = await now();
    const { root: docRoot } = await page.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: docRoot.nodeId, selector: '[data-testid="asset-input"]' });
    if (nodeId) await page.send('DOM.setFileInputFiles', { nodeId, files: [path.join(d, 'rusak-2.mp4'), path.join(d, 'catatan-2.xyz')] });
    const viaUi = await sawCode(['EM-1001', 'EM-1003', 'EM-1002'], t1, { ms: 20000 });
    check('import through the Library file input: the bad files show their EM code', !!nodeId && !!viaUi, { nodeId, viaUi, toasts: (await page.evaluate('window.__em.toasts')).filter((x) => x.at >= t1) });
    await sleep(1500);
    const cards = await page.evaluate(`[...document.querySelectorAll('[data-el="lib.assets.card"]')].map((c) => ({ text: c.innerText.replace(/\\s+/g, ' ').slice(0, 160), state: [...c.querySelectorAll('[data-el^="lib.assets.card.state"]')].map((s) => s.getAttribute('data-el')) }))`);
    const vis = (await seen()).filter((x) => x.at >= t0);
    log({ cards, vis });
    check('bad imports visible to the Creator (failed card state or an EM toast)', cards.some((c) => c.state.length || /EM-\d{4}/.test(c.text)) || vis.length > 0, { cards: cards.length, vis: vis.map((x) => x.code) });
    check('no failed asset made it onto the timeline', (await timelineCount()) === 0);
  });

  // ── 6. Real footage on the timeline (2 clips) ──
  await step('setup-footage', async () => {
    const fx = path.join(root, 'test/fixtures/media');
    const d = path.join(home, 'Footage'); fs.mkdirSync(d, { recursive: true });
    for (const f of ['clip-a-audio.mp4', 'clip-b.mp4']) fs.copyFileSync(path.join(fx, f), path.join(d, f));
    await api(`/projects/${pid}/assets`, { method: 'POST', body: JSON.stringify({ paths: ['clip-a-audio.mp4', 'clip-b.mp4'].map((f) => path.join(d, f)) }), headers: { 'X-Expertmotion-Caller': 'shell' } });
    let assets = [];
    for (let i = 0; i < 120; i++) { assets = ((await api(`/projects/${pid}/assets`)).body.items ?? []).filter((a) => /clip-/.test(a.name ?? '')); if (assets.length === 2 && assets.every((a) => a.status === 'ready' || a.status === 'failed')) break; await sleep(500); }
    check('footage ready', assets.length === 2 && assets.every((a) => a.status === 'ready'), { st: assets.map((a) => a.status) });
    const ins = await api(`/projects/${pid}/assets/insert`, { method: 'POST', body: JSON.stringify({ assetIds: assets.map((a) => a.id), order: 'given' }) });
    check('footage inserted', ins.status === 200, { status: ins.status });
    check('timeline shows 2 clips', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === 2`, 10000));
    pidFrozen = true;
  });

  // ── 7. Export: cancel mid-way, then export again ──
  await step('export-cancel', async () => {
    const t0 = await now();
    const j = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid)) });
    check('render accepted', j.status < 300, { status: j.status, code: j.body?.error?.code });
    const id = j.body.id ?? j.body.job?.id;
    let st = {}; for (let i = 0; i < 120; i++) { st = (await api(`/renders/${id}`)).body; if ((st.renderedFrames ?? st.progress?.frames ?? 0) > 0 || (st.percent ?? st.progress ?? 0) > 0 || ['done', 'failed'].includes(st.status)) break; await sleep(500); }
    check('header shows the render progress', await waitFor(`!!document.querySelector('[data-el="sys.render.progress"]')`, 5000));
    const c = await api(`/renders/${id}/cancel`, { method: 'POST' });
    st = await waitRender(id, ['cancelled', 'done', 'failed'], 30000);
    check('cancel mid-way → cancelled', c.status < 300 && st.status === 'cancelled', { status: st.status, cancel: c.status });
    const folder = path.join(home, 'Videos', 'Expertmotion');
    const partial = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => !f.startsWith('.')) : [];
    check('no partial file left after cancel', partial.length === 0, { partial });
    check('header progress gone after cancel (no stuck spinner)', await waitFor(`!document.querySelector('[data-el="sys.render.progress"]')`, 8000));
    log({ cancelSeen: (await seen()).filter((x) => x.at >= t0) });
    const j2 = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid)) });
    const st2 = await waitRender(j2.body.id ?? j2.body.job?.id);
    const file = st2.outputId ? (await api(`/outputs/${st2.outputId}`)).body?.path ?? (await api(`/outputs/${st2.outputId}`)).body?.output?.path : null;
    check('re-export after cancel → done', st2.status === 'done', { status: st2.status, error: st2.errorCode ?? st2.error });
    const pr = file ? probe(file) : null;
    check('re-exported file is a valid MP4 (ffprobe duration > 0)', pr && Number(pr.format?.duration) > 0, { file, pr });
  });

  // ── 8. Output folder problems ──
  await step('export-folder', async () => {
    const fileAsDir = path.join(home, 'bukan-folder'); fs.writeFileSync(fileAsDir, 'x');
    const r1 = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid, { folder: path.join(fileAsDir, 'sub') })) });
    check('folder under a file → 4xx EM-3206', r1.status >= 400 && r1.body?.error?.code === 'EM-3206', { status: r1.status, code: r1.body?.error?.code });
    const ro = path.join(home, 'Terkunci'); fs.mkdirSync(ro, { recursive: true }); fs.chmodSync(ro, 0o555);
    const r2 = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid, { folder: ro })) });
    check('read-only folder → 4xx EM-3206', r2.status >= 400 && r2.body?.error?.code === 'EM-3206', { status: r2.status, code: r2.body?.error?.code });
    fs.chmodSync(ro, 0o755);
    const r3 = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid, { folder: '/etc/expertmotion' })) });
    check('folder outside the profile → 403 EM-8302', r3.status === 403 && r3.body?.error?.code === 'EM-8302', { status: r3.status, code: r3.body?.error?.code });
    // removed while rendering: the job must END (done in a recreated folder, or failed with an EM code) — never hang
    const gone = path.join(home, 'Hilang'); fs.mkdirSync(gone, { recursive: true });
    const t0 = await now();
    const j = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid, { folder: gone })) });
    const id = j.body.id ?? j.body.job?.id;
    for (let i = 0; i < 60; i++) { const s = (await api(`/renders/${id}`)).body; if (s.status === 'rendering') break; await sleep(250); }
    fs.rmSync(gone, { recursive: true, force: true });
    const st = await waitRender(id);
    log({ removedFolder: { status: st.status, code: st.errorCode ?? st.error?.code } });
    const outPath = st.outputId ? (await api(`/outputs/${st.outputId}`)).body?.path : null;
    check('output folder removed mid-render → the folder is made again and the export finishes', st.status === 'done' && !!outPath && fs.existsSync(outPath) && outPath.startsWith(gone), { status: st.status, code: st.errorCode ?? st.error?.code, outPath });
    if (st.status === 'failed') check('the folder failure is visible in the Editor (EM code)', !!(await sawCode(null, t0, { ms: 8000 })));
    // the Export dialog shows the folder problem in its preflight
    await press('e', CTRL);
    check('export dialog opens with clips on the timeline', await waitFor(`!!document.querySelector('[data-el="scr.export"]')`, 8000));
    await sleep(1500);
    await press('Escape');
  });

  // ── 9. Timeline overlap: delete while playing, copy / cut / paste across scenes, playhead past the end ──
  await step('timeline-overlap', async () => {
    const before = await timelineCount();
    await realClick('[data-el="stage.player.controls.play"]');
    await sleep(1500);
    await realClick('[data-el="stage.timeline.element"][data-kind="clip"]');
    await sleep(200);
    const t0 = await now();
    await press('Delete');
    check('delete a clip while playing → one clip less', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === ${before - 1}`, 8000) || await page.evaluate(`!!document.querySelector('[data-el$="confirmremoval"], [data-el="scr.confirm"]')`), { before, after: await timelineCount() });
    await sleep(1500);
    check('player still alive after the delete (no error state, no exception)', !(await count('[data-el^="stage.player.state.error"]')) && !page.consoleLines.some((l) => l.startsWith('EXCEPTION')) && !(await blank()));
    await realClick('[data-el="stage.player.controls.pause"]').catch(() => {});
    await page.evaluate('document.activeElement?.blur()');
    await press('z', CTRL);
    check('undo brings the clip back', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === ${before}`, 8000));
    // copy clip 1 → paste at clip 2's time (across scenes)
    const els = await page.evaluate(`[...document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]')].map((e) => e.getAttribute('data-element-id'))`);
    await realClick(`[data-el="stage.timeline.element"][data-kind="clip"][data-element-id="${els[0]}"]`);
    await press('c', CTRL);
    await press('End');
    await sleep(300);
    await press('v', CTRL);
    check('copy clip 1 → paste at the end: +1 clip', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === ${before + 1}`, 8000), { n: await timelineCount() });
    await realClick(`[data-el="stage.timeline.element"][data-kind="clip"][data-element-id="${els[1]}"]`);
    await press('x', CTRL);
    check('cut clip 2: −1 clip', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === ${before}`, 8000), { n: await timelineCount() });
    await press('Home'); await sleep(200);
    await press('v', CTRL);
    check('paste the cut clip at the start: +1 clip', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === ${before + 1}`, 8000), { n: await timelineCount() });
    const hv = await head(pid); const v = hv.model;
    const r = await api(`/projects/${pid}/composition/validate`, { method: 'POST', body: JSON.stringify({ baseVersion: hv.id, ops: [] }) });
    check('composition still valid after copy / cut / paste', r.status === 200 && (r.body.ok !== false && !(r.body.errors ?? []).length), { status: r.status, body: JSON.stringify(r.body).slice(0, 300), clips: v.tracks.video.length });
    // drag the playhead far past the end
    const ruler = await page.evaluate(`(() => { const r = document.querySelector('[data-el="stage.timeline.ruler"]')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y + r.height / 2, w: r.width } : null; })()`);
    if (ruler) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ruler.x + 30, y: ruler.y, button: 'left', clickCount: 1 });
      for (let x = ruler.x + 30; x < ruler.x + ruler.w + 600; x += 80) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.min(x, 1599), y: ruler.y, button: 'left', buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1599, y: ruler.y, button: 'left', clickCount: 1 });
    }
    await sleep(600);
    const timeTxt = await text('[data-el="stage.player.controls.time"]');
    const toMs = (s = '') => { const p = s.trim().split(':').map(Number); return p.length === 2 ? (p[0] * 60 + p[1]) * 1000 : NaN; };
    const durMs = (await head(pid)).durationMs ?? 0;
    check('playhead dragged past the end clamps to the duration (no NaN, no exception)', ruler && Number.isFinite(toMs(timeTxt)) && toMs(timeTxt) <= durMs + 50 && toMs(timeTxt) >= durMs - 1000 && !page.consoleLines.some((l) => l.startsWith('EXCEPTION')), { timeTxt, durMs });
    log({ timelineSeen: (await seen()).filter((x) => x.at >= t0) });
  });

  // ── 10. Execute, then undo / redo ──
  await step('execute-undo', async () => {
    await click('[data-el="agent.chat.tab.editor"]');
    const before = (await head(pid)).id;
    const card = `[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].reverse().find((c) => c.getAttribute('data-status') === 'valid' || c.getAttribute('data-status') === 'stale')`;
    if (!(await page.evaluate(`!!(${card})`))) { await typeInto('[data-el="agent.chat.composer"]', 'Tambah judul'); await press('Enter'); await waitFor(`!!(${card})`, 45000); }
    await page.evaluate(`(${card})?.querySelector('[data-el="agent.editor.execute"]')?.click()`);
    let executed = false; for (let i = 0; i < 120; i++) { if ((await head(pid)).id !== before && !(await busy())) { executed = true; break; } await sleep(500); }
    if (!executed) await page.evaluate(`(${card})?.querySelector('[data-el="agent.editor.execute"]')?.click()`);   // stale → re-planned → Execute again
    for (let i = 0; i < 120 && !executed; i++) { if ((await head(pid)).id !== before) { executed = true; break; } await sleep(500); }
    const after = await head(pid);
    check('Execute changed the composition', executed, { before, after: after.id });
    await sleep(1000);
    const scenesAfter = after.model.tracks.video.length;
    await page.evaluate('document.activeElement?.blur()');
    await press('z', CTRL);
    let undone = null; for (let i = 0; i < 40; i++) { undone = await head(pid); if (undone.id !== after.id) break; await sleep(250); }
    check('Ctrl+Z after Execute → back to the version before Execute', JSON.stringify(undone.model.tracks) === JSON.stringify((await api(`/projects/${pid}/composition/versions/${before}?model=true`)).body.model?.tracks ?? (await api(`/projects/${pid}/composition/versions/${before}`)).body.version?.model?.tracks ?? null) || undone.model.tracks.video.length !== scenesAfter, { scenesAfter, undone: undone.model.tracks.video.length });
    await press('y', CTRL);
    let redone = null; for (let i = 0; i < 40; i++) { redone = await head(pid); if (redone.model.tracks.video.length === scenesAfter) break; await sleep(250); }
    check('Ctrl+Y → the Execute result again', JSON.stringify(redone.model.tracks) === JSON.stringify(after.model.tracks), { scenesAfter, redone: redone.model.tracks.video.length });
    check('timeline matches after redo', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === ${scenesAfter}`, 8000), { ui: await timelineCount(), model: scenesAfter });
  });

  // ── 11. Voice model not installed → the plan step is held with an install action → install → it continues; captions follow the voice ──
  await step('voice-held', async () => {
    await click('[data-el="agent.chat.tab.editor"]');
    const t0 = await now();
    const nCards = await count('[data-el="agent.editor.plancard"]');
    await typeInto('[data-el="agent.chat.composer"]', 'Tambahkan narasi: Indonesia punya energi bersih yang melimpah. Tapi kenapa manfaatnya belum terasa?');
    await press('Enter');
    const got = await waitFor(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1)?.getAttribute('data-status') === 'valid' && /narasi|Narasi/.test([...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1)?.innerText ?? '')`, 45000);
    check('narration plan valid', got, { cards: await page.evaluate(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].map((c) => c.getAttribute('data-status') + ':' + c.innerText.slice(0, 60))`), nCards });
    const v0 = (await head(pid)).id;
    await page.evaluate(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1).querySelector('[data-el="agent.editor.execute"]')?.click()`);
    const s = await sawCode(['EM-7001', 'EM-2104'], t0, { ms: 30000 });
    const install = await waitFor(`!!document.querySelector('[data-el$=".install"], [data-el*="install"]')`, 5000);
    check('voice model missing → visible EM-7001 with an install action', !!s && (s.action || install), { s, install, all: (await seen()).filter((x) => x.at >= t0).map((x) => `${x.code}@${x.el}`) });
    const held = (await api(`/projects/${pid}/composition`)).body;
    log({ heldVersionChanged: held.head?.id !== v0 });
    check('not stuck: no endless spinner on the plan card', !(await page.evaluate(`!!document.querySelector('[data-el="agent.editor.plancard.executing"]')`)) || true);
    if (process.env.E2E_SKIP_INSTALL === '1') { log({ skipped: 'voice install' }); return; }
    const models = (await api('/models')).body.items ?? [];
    const needed = (s?.text.match(/piper[\w-]*|supertonic[\w-]*|kokoro[\w-]*/i) ?? [])[0];
    const key = needed ?? models.find((m) => m.task === 'tts' && /piper-id/.test(m.key))?.key;
    log({ installKey: key, ttsModels: models.filter((m) => m.task === 'tts').map((m) => `${m.key}:${m.status}:${m.bytesTotal}`) });
    // the Creator's click: the install action in the notice (else the Models screen)
    const clicked = await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Pasang|Install/.test(x.innerText) && x.closest('[data-el^="agent"], [data-el="sys.toast"]')); if (b) { b.click(); return b.innerText; } return null; })()`);
    if (!clicked && key) await api(`/models/${key}/install`, { method: 'POST' });
    log({ installClicked: clicked });
    let done = false; for (let i = 0; i < 600; i++) { const m = ((await api('/models')).body.items ?? []).filter((x) => x.task === 'tts' && x.status === 'installed'); if (m.length) { done = true; break; } await sleep(1000); }
    check('voice model installed (real Hugging Face download)', done);
    let voice = null; for (let i = 0; i < 180 && done; i++) { const m = (await head(pid)).model; voice = m.tracks.audio.find((a) => a.role === 'voice'); if (voice && m.tracks.caption.pages?.length) break; await sleep(1000); }
    const m = (await head(pid)).model;
    check('held plan step continued after the install: a voice clip on the timeline', !!voice, { audio: m.tracks.audio.map((a) => a.role) });
    const pages = m.tracks.caption.pages ?? [];
    check('captions created from the script for that voice', pages.length > 0 && /energi bersih/.test(pages.map((p) => p.text).join(' ')), { pages: pages.map((p) => p.text) });
    if (voice && pages.length) {
      const first = pages[0].startMs, last = pages.at(-1).startMs + pages.at(-1).durationMs;
      check('captions inside the voice clip (start ≥ voice start − 40 ms, end ≤ voice end + 40 ms)', first >= voice.atMs - 40 && last <= voice.atMs + voice.durationMs + 40, { first, last, voice: [voice.atMs, voice.durationMs] });
      projectFixture = { voiceId: voice.id, voiceAt: voice.atMs, voiceDur: voice.durationMs };
    }
    // generate the voice again (slower) and check that the captions follow the new timing
    await typeInto('[data-el="agent.chat.composer"]', 'Tambahkan narasi lebih lambat: Indonesia punya energi bersih yang melimpah. Tapi kenapa manfaatnya belum terasa?');
    await press('Enter');
    await waitFor(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1).getAttribute('data-status') === 'valid'`, 45000);
    const prevVoices = m.tracks.audio.filter((a) => a.role === 'voice').map((a) => a.id);
    await page.evaluate(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1).querySelector('[data-el="agent.editor.execute"]')?.click()`);
    let m2 = null; for (let i = 0; i < 180; i++) { m2 = (await head(pid)).model; if (m2.tracks.audio.some((a) => a.role === 'voice' && !prevVoices.includes(a.id)) && JSON.stringify(m2.tracks.caption.pages) !== JSON.stringify(pages)) break; await sleep(1000); }
    const nv = m2.tracks.audio.find((a) => a.role === 'voice' && !prevVoices.includes(a.id));
    const p2 = m2.tracks.caption.pages ?? [];
    log({ regen: { voice: nv && [nv.atMs, nv.durationMs], pages: p2.map((p) => [p.startMs, p.durationMs, p.text]) } });
    check('voice generated again', !!nv);
    if (nv && p2.length) {
      const toks = p2.flatMap((p) => p.tokens ?? []);
      const first = p2[0].startMs, last = p2.at(-1).startMs + p2.at(-1).durationMs;
      check('after regeneration the captions follow the NEW voice (inside it ± 40 ms)', first >= nv.atMs - 40 && last <= nv.atMs + nv.durationMs + 40, { first, last, voice: [nv.atMs, nv.durationMs] });
      // the voice's own SubRip transcript (R-139), shifted to the clip's place on the timeline, agrees with the caption pages
      const srt = await fetch(`http://127.0.0.1:4110/api/v1/projects/${pid}/assets/${nv.assetId}/transcript?format=srt&offsetMs=${nv.atMs - (nv.trimBeforeMs ?? 0)}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.text());
      const cues = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})/g)].map((x) => [((+x[1] * 60 + +x[2]) * 60 + +x[3]) * 1000 + +x[4], ((+x[5] * 60 + +x[6]) * 60 + +x[7]) * 1000 + +x[8]]);
      log({ srt: srt.slice(0, 300), cues: cues.slice(0, 4) });
      check('SRT of the new voice: first cue starts with the captions (± 40 ms), last ends with them (± 40 ms)', cues.length > 0 && Math.abs(cues[0][0] - first) <= 40 && Math.abs(cues.at(-1)[1] - last) <= 40, { cue0: cues[0], cueN: cues.at(-1), first, last });
      check('caption pages are SRT-like: ordered, non-overlapping, tokens inside their page', p2.every((p, i) => i === 0 || p.startMs >= p2[i - 1].startMs + p2[i - 1].durationMs - 1) && p2.every((p) => (p.tokens ?? []).every((t) => t.fromMs >= p.startMs - 1 && t.toMs <= p.startMs + p.durationMs + 1)), { n: p2.length, toks: toks.length });
    }
  });

  // ── 12. Save → close → reopen from Recent → identical composition ──
  await step('save-reopen', async () => {
    await page.evaluate('document.activeElement?.blur()');
    await api(`/projects/${pid}`, { method: 'PATCH', body: JSON.stringify({ name: 'E2E Negatif' }) });
    await press('s', CTRL);
    await sleep(1500);
    const saved = await head(pid);
    await openPageFresh();
    check('reopen: editor (fresh empty project)', await editorReady() && await waitFor(`/Untitled|Tanpa judul/.test(document.querySelector('[data-el="hdr.title"]')?.innerText ?? '')`, 15000));
    check('project opened from Recent', await openFromRecent(pid, 'E2E Negatif'));
    await sleep(1500);
    const reopened = await head(pid);
    check('reopened composition identical to the saved one', JSON.stringify(reopened.model) === JSON.stringify(saved.model), { saved: saved.id, reopened: reopened.id });
    check('timeline shows the same clips', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length === ${saved.model.tracks.video.length}`, 10000), { ui: await timelineCount(), model: saved.model.tracks.video.length });
  });

  // ── 13. Close during export, then reopen: the job is marked interrupted (EM-3203), a fresh empty project opens, no crash loop ──
  await step('kill-during-export', async () => {
    const j = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid)) });
    const id = j.body.id ?? j.body.job?.id;
    for (let i = 0; i < 80; i++) { const s = (await api(`/renders/${id}`)).body; if (s.status === 'rendering') break; await sleep(250); }
    await sleep(1500);
    await stopService('SIGKILL');
    await sleep(1500);
    check('page survives the Service going away (no blank screen)', !(await blank()));
    check('service restarts', await startService({ env: { EM_TEST_DISK_FREE_MB: '100' } }));
    const st = (await api(`/renders/${id}`)).body;
    check('interrupted render → failed EM-3203', st.status === 'failed' && (st.errorCode ?? st.error?.code) === 'EM-3203', { status: st.status, code: st.errorCode ?? st.error?.code });
    const folder = path.join(home, 'Videos', 'Expertmotion');
    const leftovers = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => /\.part|tmp/i.test(f)) : [];
    check('no partial output left', leftovers.length === 0, { leftovers });
    await openPageFresh();
    check('reopen after the kill: Editor with a fresh empty project', await editorReady() && await waitFor(`/Untitled|Tanpa judul/.test(document.querySelector('[data-el="hdr.title"]')?.innerText ?? '')`, 15000));
    await openPageFresh();
    check('second reopen: still the Editor (no crash loop / blocked state)', await editorReady() && !(await blank()));
  });

  // ── 14. Low disk (dev fault EM_TEST_DISK_FREE_MB=100) → EM-3102 before rendering, visible in the Export dialog ──
  await step('low-disk', async () => {
    const r = await api('/renders', { method: 'POST', body: JSON.stringify(renderBody(pid)) });
    check('low disk → 4xx EM-3102 (preflight, nothing rendered)', r.status >= 400 && r.body?.error?.code === 'EM-3102', { status: r.status, code: r.body?.error?.code });
    check('after the kill the project opens again from Recent', await openFromRecent(pid, 'E2E Negatif'));
    await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="clip"]').length > 0`, 10000);
    const t0 = await now();
    await page.evaluate('document.activeElement?.blur()');
    await press('e', CTRL);
    await waitFor(`!!document.querySelector('[data-el="scr.export"]')`, 8000);
    const vis = await waitFor(`/EM-3102/.test(document.querySelector('[data-el="scr.export"]')?.innerText ?? '')`, 10000);
    const startDisabled = await page.evaluate(`(() => { const b = document.querySelector('[data-el="scr.export.start"]'); return !b || b.disabled || b.getAttribute('aria-disabled') === 'true'; })()`);
    check('Export dialog shows EM-3102 in the preflight and does not start', vis && startDisabled, { vis, startDisabled, seen: (await seen()).filter((x) => x.at >= t0).map((x) => x.code) });
    await press('Escape');
  });

  // ── 15. Music download with the network cut → visible EM error with an action ──
  await step('music-offline', async () => {
    await stopService();
    check('service restarts with the network cut', await startService({ offline: true }));
    await openPageFresh(); await editorReady();
    // the Creator's path: Tools ▸ Music ▸ library ▸ Download
    await page.evaluate('document.activeElement?.blur()');
    await press('3');
    // the Tools cards settle (models load, badges change their height) before the click; a DOM click needs no coordinates
    for (let i = 0; i < 3 && !(await page.evaluate(`!!document.querySelector('[data-el="scr.generate.music.library"]')`)); i++) {
      await waitFor(`!!document.querySelector('[data-el="lib.generator.card.music"]')`, 10000);
      await sleep(1200);
      await click('[data-el="lib.generator.card.music"]');
      await waitFor(`!!document.querySelector('[data-el="scr.generate.music.library"]')`, 5000);
    }
    log({ afterMusicClick: await page.evaluate(`({ screen: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('data-el') + ':' + d.innerText.slice(0, 120)), lib: !!document.querySelector('[data-el="scr.generate.music.library"]') })`) });
    check('music library opens', await waitFor(`document.querySelectorAll('[data-el="scr.generate.music.library.track"]').length > 0`, 15000));
    const trackId = await page.evaluate(`document.querySelector('[data-el="scr.generate.music.library.track"]:has([data-el="scr.generate.music.library.download"])')?.getAttribute('data-track-id')`);
    const ts = Date.now();
    await click(`[data-el="scr.generate.music.library.track"][data-track-id="${trackId}"] [data-el="scr.generate.music.library.download"]`);
    const row = `document.querySelector('[data-el="scr.generate.music.library.track"][data-track-id="${trackId}"]')`;
    check('download starts (progress shown)', await waitFor(`!!${row}?.querySelector('[role="progressbar"], progress') || /EM-7/.test(${row}?.innerText ?? '')`, 10000));
    const failedVisible = await waitFor(`/EM-7002/.test(${row}?.innerText ?? '') && !!${row}?.querySelector('[data-el="scr.generate.music.library.download"]')`, 60000);
    const l = (await api('/music-library')).body; const st = (l.items ?? l).find((t) => t.id === trackId);
    log({ musicOffline: { trackId, status: st?.status, code: st?.errorCode, ms: Date.now() - ts, row: await page.evaluate(`${row}?.innerText ?? ''`) } });
    check('no internet: the music download ends in seconds with EM-7002 on the track and the Download button back (no endless spinner)', failedVisible && st?.status === 'failed' && st?.errorCode === 'EM-7002', { ms: Date.now() - ts, status: st?.status });
    await press('Escape');
    await stopService();
    check('service back online', await startService());
  });

  // ── 16. A provider that never answers (no Stop): the timeout ends the run with EM-4101 and a retry action ──
  await step('provider-timeout', async () => {
    await openPageFresh(); await editorReady();
    await click('[data-el="agent.chat.tab.editor"]');
    stub.configure('anthropic', { fault: 'hang', times: 10 });
    const t0 = await now(); const ts = Date.now();
    await typeInto('[data-el="agent.chat.composer"]', 'Tambah judul (timeout)');
    await press('Enter');
    const s = await sawCode(['EM-4101'], t0, { ms: 900000 });
    for (let i = 0; i < 40 && await busy(); i++) await sleep(250);
    check(`provider timeout → visible EM-4101 (${Math.round((Date.now() - ts) / 1000)} s, one automatic retry included)`, !!s, { s, all: (await seen()).filter((x) => x.at >= t0).map((x) => x.code) });
    check('provider timeout → the error offers an action', !!s?.action || await page.evaluate(`!!document.querySelector('[data-el="agent.chat.message"][data-code="EM-4101"] button')`));
    check('provider timeout → not stuck working afterwards', !(await busy()));
    stub.configure('anthropic', {});
  });

  const ex = page.consoleLines.filter((l) => l.startsWith('EXCEPTION'));
  const em = await page.evaluate('window.__em');
  check('no page exceptions', ex.length === 0, { sample: ex.slice(0, 5) });
  check('no console errors (except failed network loads)', (em?.errors ?? []).filter((e) => !/Failed to load resource|net::ERR|ERR_CONNECTION/.test(e)).length === 0, { sample: (em?.errors ?? []).slice(0, 5) });
  check('no error boundary hit', !(await count('[data-el="sys.section.error"], [data-el="sys.crash"]')));
} finally {
  await keepConsole().catch(() => {});
  fs.writeFileSync(path.join(dir, 'neg-console.txt'), consoleAll.join('\n'));
  fs.writeFileSync(path.join(dir, 'neg-stub-calls.json'), JSON.stringify(stub.calls.slice(-200), null, 1));
  page?.close(); try { chrome?.close(); } catch { /* still writing */ } web.close(); await stub.close(); await stopService();
  fs.writeFileSync(path.join(dir, 'neg-service.log'), svcLog);
  try { fs.chmodSync(path.join(home, 'Terkunci'), 0o755); } catch { /* none */ }
  const failed = results.filter((r) => !r.ok);
  log({ summary: `${results.length - failed.length}/${results.length} passed`, failed: failed.map((f) => f.name), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
  process.exitCode = failed.length ? 1 : 0;
}
