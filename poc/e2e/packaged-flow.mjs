// End-to-end on the REAL packaged desktop app (Electron Shell + app:// Editor + utilityProcess Service + packaged engine), the
// QA 2026-10-27 journey that failed on Windows ("could not export a single video"), process.md Entry 29:
//   splash → licence activation → onboarding (provider skipped: release builds have no provider stub) → New project 720p
//   → faceless video (texts + background through the Editor's own controls) → preview plays, bundled fonts loaded, no font
//   error → Export MP4 720p (progress, low-memory wait FR-204 on a small machine) → file exists, ffprobe duration > 0
//   → close → relaunch → an empty project, the last one in "Terakhir dibuka" (FR-260; was the Start screen of FR-202) → crash loop:
//   crash right after opening a project, reopen, kill → next launch: empty project with "Proyek terakhir gagal dibuka"
//   (sys.launch.notice) → safe open (chat + preview hidden).
// Captured per step: renderer console errors / warnings, exceptions, CSP / network log entries, the Shell + Service logs,
// cgroup memory.current, and a Page.captureScreenshot PNG.
//
// The app must be a TEST build (throwaway licence key; never ship it): see process.md Entry 29 "How to continue":
//   1. keygen: EXPERTMOTION_LICENSE_PASSPHRASE=<pw> node tools/license-cli/src/cli.mjs keygen --kid A1 --out <dir>/a1.key --seal --dev-allow-network
//   2. build the Linux unpacked app with EM_LICENSE_PUBLIC_KEY_A1_HEX=<printed hex> (build-linux.sh steps, electron-builder `--linux dir`,
//      output outside release/), then rebuild apps/service/dist without the key.
// Run (inside the memory cap; one heavy job at a time):
//   E2E_DIR=<scratch dir with a1.key + pass> E2E_APP=<…/linux-unpacked> [E2E_WRAP=<launcher that provides DISPLAY / dbus / Secret Service>] \
//     bash scripts/run-capped.sh node poc/e2e/packaged-flow.mjs
// On a server without a display, E2E_WRAP starts Xvfb + a dbus session with an unlocked gnome-keyring (Electron's
// `--ozone-platform=headless` aborts in GTK: "Can't create a GtkStyleContext without a display connection"). The app's
// system libraries (GTK etc.) must be resolvable; on a desktop Ubuntu they are installed.
// Ports: CDP 9351 (never 3000/4000). Exit code 0 only when every check passed.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const dir = process.env.E2E_DIR; const appDir = process.env.E2E_APP;
if (!dir || !appDir) throw new Error('E2E_DIR and E2E_APP are required');
const wrap = process.env.E2E_WRAP ?? '';
const CDP = Number(process.env.E2E_CDP_PORT ?? 9351);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(dir, `run-${runId}`); fs.mkdirSync(out, { recursive: true });
const home = path.join(out, 'home'); fs.mkdirSync(home, { recursive: true });
const cfgDir = path.join(home, 'config');
const dataRoot = path.join(cfgDir, 'Expertmotion');
const videos = path.join(home, 'Video Saya'); fs.mkdirSync(videos, { recursive: true });   // a space in the Videos path, like "My Videos"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const steps = [];
const log = (o) => { console.log(JSON.stringify(o)); fs.appendFileSync(path.join(out, 'events.jsonl'), `${JSON.stringify(o)}\n`); };
const check = (name, ok, extra = {}) => { results.push({ name, ok: !!ok, ...extra }); log({ check: name, ok: !!ok, ...extra }); return !!ok; };

// ── memory: the cgroup this script runs in (run-capped scope) includes the app it starts ──
function cgroupMemMb() {
  try {
    const cg = /^0::(.*)$/m.exec(fs.readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
    return Math.round(Number(fs.readFileSync(`/sys/fs/cgroup${cg}/memory.current`, 'utf8')) / 1048576);
  } catch { return null; }
}
let memPeak = 0;
const memTimer = setInterval(() => { const m = cgroupMemMb(); if (m && m > memPeak) memPeak = m; }, 500);

// ── app process ──
let app = null;
function launchApp(tag) {
  const args = [path.join(appDir, 'expertmotion'), '--no-sandbox', `--remote-debugging-port=${CDP}`, '--password-store=gnome-libsecret'];
  const cmd = wrap ? [wrap, home, ...args] : args;
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: cfgDir, XDG_VIDEOS_DIR: videos, ELECTRON_ENABLE_LOGGING: '0' };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'user-dirs.dirs'), `XDG_VIDEOS_DIR="${videos}"\n`);   // app.getPath('videos') reads this on Linux
  const p = spawn(cmd[0], cmd.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const f = fs.createWriteStream(path.join(out, `app-${tag}.log`));
  p.stdout.pipe(f); p.stderr.pipe(f);
  p.on('exit', (code, sig) => log({ app: tag, exit: code, signal: sig }));
  app = p; return p;
}
async function killApp(signal = 'SIGTERM') {
  if (!app || app.exitCode !== null) return;
  try { process.kill(-app.pid, signal); } catch { /* gone */ }
  for (let i = 0; i < 60 && app.exitCode === null && app.signalCode === null; i++) await sleep(250);
  // Electron helpers may outlive the wrapper; make sure nothing keeps the CDP port.
  try { execFileSync('pkill', ['-9', '-f', `remote-debugging-port=${CDP}`]); } catch { /* none */ }
  await sleep(1000);
}

// ── CDP page session ──
let page = null;
async function attach(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.startsWith('app://expertmotion'));
      if (t) { page = await session(t.webSocketDebuggerUrl); return page; }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('no app:// page target');
}
async function session(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const consoleLines = []; const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { r, j } = pending.get(msg.id); pending.delete(msg.id); msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLines.push({ type: msg.params.type, text });
      if (msg.params.type === 'error' || msg.params.type === 'warning') errors.push(`console.${msg.params.type}: ${text}`.slice(0, 1000));
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`.slice(0, 1500));
    if (msg.method === 'Log.entryAdded' && (msg.params.entry.level === 'error' || msg.params.entry.level === 'warning')) errors.push(`log.${msg.params.entry.source}: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`.slice(0, 1000));
  };
  ws.onclose = () => { for (const { j } of pending.values()) j(new Error('CDP socket closed')); pending.clear(); };
  const send = (method, params = {}) => new Promise((r, j) => {
    if (ws.readyState !== WebSocket.OPEN) { j(new Error('CDP socket closed')); return; }
    const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); j(new Error(`CDP timeout: ${method}`)); } }, 60_000);
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  return { ws, send, evaluate, consoleLines, errors, close: () => { try { ws.close(); } catch { /* closed */ } } };
}
const waitFor = async (expr, ms = 30_000) => { const until = Date.now() + ms; while (Date.now() < until) { try { if (await page.evaluate(expr)) return true; } catch { /* navigating */ } await sleep(250); } return false; };
const exists = (sel) => page.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
async function centre(sel) {
  return page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
}
/** A trusted mouse click (CDP Input) at the element's centre. */
async function click(sel) {
  const c = await centre(sel); if (!c) throw new Error(`not found: ${sel}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
}
/** Click the first button whose visible text matches (onboarding buttons have no data-el). */
async function clickText(text, scope = 'body') {
  const sel = await page.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled);
    if (!b) return null; b.setAttribute('data-e2e-target', '1'); return '[data-e2e-target="1"]'; })()`);
  if (!sel) throw new Error(`no button "${text}"`);
  await click(sel); await page.evaluate(`document.querySelector('[data-e2e-target]')?.removeAttribute('data-e2e-target')`);
}
async function typeInto(sel, value) { await click(sel); await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select?.(); })()`); await page.send('Input.insertText', { text: value }); }
async function selectValue(sel, value) {
  await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
let shotN = 0;
async function shot(name) {
  if (!page) return null;
  try {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(out, `${String(++shotN).padStart(2, '0')}-${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f;
  } catch (e) { return `failed: ${e.message}`; }
}
/** One journey step: run, then record screenshot, memory and the renderer errors that appeared during it. */
async function step(name, fn) {
  const before = page?.errors.length ?? 0; const errSrc = page; const t0 = Date.now(); let threw = null;
  try { await fn(); } catch (e) { threw = String(e?.message ?? e).slice(0, 500); check(`${name} (threw)`, false, { error: threw }); }
  const errs = errSrc ? errSrc.errors.slice(before) : [];
  const s = { step: name, ms: Date.now() - t0, memMb: cgroupMemMb(), shot: page ? await shot(name.replace(/\W+/g, '-')) : null, rendererErrors: errs };
  steps.push(s); log(s);
}
const shellLog = () => { try { const d = path.join(dataRoot, 'logs'); return fs.readdirSync(d).filter((f) => f.startsWith('shell-')).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join(''); } catch { return ''; } };
const serviceLog = () => { try { const d = path.join(dataRoot, 'logs'); return fs.readdirSync(d).filter((f) => f.startsWith('service-')).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join(''); } catch { return ''; } };
const fontErrors = () => page.errors.filter((e) => /fetchFontData|Failed to fetch|EM-8014|font/i.test(e));

let exitCode = 1;
try {
  // ── Launch 1: first start ──
  log({ memBeforeMb: cgroupMemMb(), app: appDir });
  launchApp('1');
  await attach();
  await step('splash', async () => {
    check('splash or licence visible', await waitFor(`!!document.querySelector('[data-el^="sys.splash"], [data-el="scr.license"]')`, 60_000));
  });
  await step('licence-screen', async () => {
    if (await (async () => { for (let i = 0; i < 40; i++) { if (/keyring unavailable/.test(shellLog())) return true; if (await exists('[data-el="scr.license.machinecode"]').catch(() => false)) return false; await sleep(250); } return false; })())
      throw new Error('EM-6001: no Secret Service in this session (the launcher must provide an unlocked keyring)');
    check('licence screen (no Trial Mode)', await waitFor(`!!document.querySelector('[data-el="scr.license.machinecode"]') && /[A-Z0-9]{4}/.test(document.querySelector('[data-el="scr.license.machinecode"]').textContent)`, 90_000));
  });
  await step('licence-activate', async () => {
    const machineCode = (await page.evaluate(`document.querySelector('[data-el="scr.license.machinecode"]').textContent`)).trim().split(/\s/)[0];
    const issued = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/license-cli/src/cli.mjs'), 'issue', '--name', 'E2E', '--email', 'e2e@example.com', '--fingerprint', machineCode,
      '--key-file', path.join(dir, 'a1.key'), '--audit', path.join(out, 'audit.csv'), '--out-dir', path.join(out, 'lic'), '--dev-allow-network', '--json'],
    { env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: fs.readFileSync(path.join(dir, 'pass'), 'utf8').trim() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    await typeInto('[data-el="scr.license.input"]', issued.key);
    await click('[data-el="scr.license.activate"]');
    check('licence activated → onboarding', await waitFor(`!!document.querySelector('[data-el="scr.onboarding"]')`, 30_000));
  });
  await step('onboarding', async () => {
    await clickText('Get started', '[data-el="scr.onboarding"]');
    check('onboarding provider step', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.provider"]')`));
    await clickText('Skip for now', '[data-el="scr.onboarding"]');        // release build: no provider stub, no real key here
    check('onboarding hardware step', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.hardware"]')`));
    await clickText('Next', '[data-el="scr.onboarding"]');
    await waitFor(`!!document.querySelector('[data-el="scr.onboarding.tour"]')`);
    await clickText('Skip the tour', '[data-el="scr.onboarding"]');
    check('onboarding done step', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.done.open"]')`));
    await click('[data-el="scr.onboarding.done.open"]');
    check('New project dialog', await waitFor(`!!document.querySelector('[data-el="scr.project.new"]')`));
  });
  await step('new-project-720p', async () => {
    await typeInto('[data-el="scr.project.new.name"]', 'Video Faceless Uji');
    await selectValue('[data-el="scr.project.new.ratio"]', '16:9');
    await selectValue('[data-el="scr.project.new.resolution"]', '720p');
    await click('[data-el="scr.project.new.create"]');
    check('editor opened on the new project', await waitFor(`!!document.querySelector('[data-region="stage"]') && !document.querySelector('[data-el="scr.project.new"]')`, 30_000));
    await page.evaluate(`(() => { for (const el of document.querySelectorAll('[data-el="tour.skip"]')) el.click(); return true; })()`).catch(() => undefined);
  });
  await step('faceless-video', async () => {
    await click('[data-el="hdr.menu.home"]');
    await waitFor(`!!document.querySelector('[data-el="lib.text.add"]:not([aria-disabled="true"])')`);
    await click('[data-el="lib.text.add"]');
    check('text layer on the timeline', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"][data-kind="text"]').length >= 1`, 30_000));
    if (await exists('[data-el="lib.text.add.input"]')) { await typeInto('[data-el="lib.text.add.input"]', 'Kopi pagi: 3 fakta singkat'); await click('[data-el="lib.text.add.confirm"]'); await sleep(1500); }
    await click('[data-el="hdr.menu.design"]');
    await waitFor(`!!document.querySelector('[data-el="lib.catalogue.tab"][data-category="background"]')`);
    await click('[data-el="lib.catalogue.tab"][data-category="background"]');
    await waitFor(`!!document.querySelector('[data-preset-id="preset:background.gradient"]')`);
    await click('[data-preset-id="preset:background.gradient"]');
    check('background applied (gradient)', await waitFor(`!!document.querySelector('[data-el="stage.timeline.element"][data-kind="background"], [data-preset-id="preset:background.gradient"][data-selected]')`, 30_000));
    const dur = await page.evaluate(`document.querySelector('[data-el="stage.player.controls.time"]')?.textContent ?? ''`);
    log({ playerTime: dur });
  });
  await step('preview-plays-fonts', async () => {
    await click('[data-el="stage.player.controls.play"]').catch(() => undefined);
    const t0 = await page.evaluate(`document.querySelector('[data-el="stage.player.controls.time"]')?.textContent ?? ''`);
    await sleep(2500);
    const t1 = await page.evaluate(`document.querySelector('[data-el="stage.player.controls.time"]')?.textContent ?? ''`);
    check('preview time advances while playing', t0 !== t1, { t0, t1 });
    const fonts = await page.evaluate(`(async () => { await document.fonts.ready; const all = [...document.fonts]; return { loaded: all.filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight + ' ' + f.style), error: all.filter((f) => f.status === 'error').length, families: [...new Set(all.filter((f) => f.status === 'loaded').map((f) => f.family))] }; })()`);
    log({ fonts: { loaded: fonts.loaded.length, error: fonts.error, families: fonts.families } });
    check('bundled fonts loaded in the packaged Editor (Inter, Plus Jakarta Sans, Archivo, …)', fonts.families.includes('Inter') && fonts.families.length >= 4 && fonts.error === 0, { families: fonts.families, error: fonts.error });
    check('no font fetch error / unhandled rejection in the renderer', fontErrors().length === 0, { fontErrors: fontErrors().slice(0, 3) });
    await click('[data-el="stage.player.controls.pause"]').catch(() => undefined);
  });
  let outFile = null;
  await step('export-mp4-720p', async () => {
    await click('[data-el="hdr.action.export"]');
    check('export dialog', await waitFor(`!!document.querySelector('[data-el="scr.export"]')`));
    check('preflight ready (Start enabled)', await waitFor(`!!document.querySelector('[data-el="scr.export.start"]:not([aria-disabled="true"])')`, 60_000),
      { checks: await page.evaluate(`[...document.querySelectorAll('[data-el="scr.export.preflight"] li')].map((li) => li.textContent.trim()).join(' | ')`) });
    const summary = await page.evaluate(`document.querySelector('[data-el="scr.export.profile.summary"]')?.textContent ?? ''`);
    check('profile is 1280×720 MP4', summary.includes('1280×720'), { summary });
    await click('[data-el="scr.export.start"]');
    const t0 = Date.now(); const seen = new Set();
    let done = false;
    while (Date.now() - t0 < 12 * 60_000) {
      const st = await page.evaluate(`({ waiting: !!document.querySelector('[data-el="scr.export.waiting.memory"]'), stage: document.querySelector('[data-el="scr.export.stage"]')?.textContent ?? null,
        done: !!document.querySelector('[data-el="scr.export.done"]'), failed: document.querySelector('[data-el="scr.export"] [role="alert"]')?.textContent ?? null })`);
      const key = st.waiting ? 'waiting-memory' : st.stage ?? ''; if (key && !seen.has(key)) { seen.add(key); log({ exportProgress: key, atS: Math.round((Date.now() - t0) / 1000), memMb: cgroupMemMb() }); if (seen.size <= 6) await shot(`export-${seen.size}`); }
      if (st.done) { done = true; break; }
      if (st.failed) { check('export failed', false, { error: st.failed }); break; }
      await sleep(1000);
    }
    check('export finished', done, { seconds: Math.round((Date.now() - t0) / 1000), stagesSeen: [...seen] });
    outFile = await page.evaluate(`document.querySelector('[data-el="scr.export.done"] code')?.textContent ?? null`);
    log({ outFile });
  });
  await step('output-file-valid', async () => {
    check('output file exists', !!outFile && fs.existsSync(outFile), { outFile });
    check('default export folder is <Videos>/Expertmotion (path with a space)', !!outFile && outFile.startsWith(path.join(videos, 'Expertmotion')), { outFile });
    const ffprobe = [path.join(appDir, 'resources/bin/ffprobe'), path.join(root, 'resources/bin-linux-x64/ffprobe')].find((f) => fs.existsSync(f));
    const pj = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outFile], { encoding: 'utf8' }));
    const v = pj.streams.find((s) => s.codec_type === 'video');
    const duration = Number(pj.format.duration);
    check('ffprobe: h264 1280x720, duration > 0', v?.codec_name === 'h264' && v.width === 1280 && v.height === 720 && duration > 0, { codec: v?.codec_name, w: v?.width, h: v?.height, duration, bytes: fs.statSync(outFile).size });
    await click('[data-el="scr.export"] button[aria-label]').catch(() => undefined);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => undefined);
  });
  const projectName = 'Video Faceless Uji';
  // ── close → relaunch: an EMPTY project, not the old project (QA #7; FR-260 superseded the Start-screen launch of FR-202) ──
  await step('close-app', async () => {
    page.close(); page = null; await killApp('SIGTERM');
    check('app closed', app.exitCode !== null || app.signalCode !== null);
  });
  launchApp('2'); await attach();
  const recentItem = `[...document.querySelectorAll('[data-el="stage.recent.item"]')].find((b) => b.textContent.includes(${JSON.stringify(projectName)}))`;
  await step('relaunch-empty-project', async () => {
    check('launch opens an empty project (no auto-open of the last one)', await waitFor(`/Untitled|Tanpa judul/.test(document.querySelector('[data-el="hdr.title"]')?.textContent ?? '') && !document.querySelectorAll('[data-el="stage.timeline.element"]').length`, 90_000),
      { title: await page.evaluate(`document.querySelector('[data-el="hdr.title"]')?.textContent ?? null`) });
    check('"Terakhir dibuka" has the project', await waitFor(`!!(${recentItem})`, 20_000));
  });
  // ── crash loop: crash right after opening, the Shell reloads, it reopens, the app is killed → blocked on the next launch ──
  await step('open-then-crash', async () => {
    await page.evaluate(`(${recentItem})?.click()`);
    check('project opened from "Terakhir dibuka"', await waitFor(`(document.querySelector('[data-el="hdr.title"]')?.textContent ?? '').includes(${JSON.stringify(projectName)})`, 30_000));
    await sleep(3000);                                                        // localStorage commit of the guard
    await page.send('Page.crash').catch(() => undefined);                     // renderer process gone (FR-185 main auto-reloads once)
    page.close(); await sleep(4000); await attach();
    check('after the renderer crash the Shell reloaded and the in-window reload reopened the project', await waitFor(`(document.querySelector('[data-el="hdr.title"]')?.textContent ?? '').includes(${JSON.stringify(projectName)})`, 60_000));
    await sleep(4000);
  });
  await step('kill-during-reopen', async () => { page.close(); page = null; await killApp('SIGKILL'); });
  launchApp('3'); await attach();
  await step('crash-loop-notice', async () => {
    check('empty project with the "last project failed to open" notice (sys.launch.notice)', await waitFor(`!!document.querySelector('[data-el="sys.launch.notice"]') && /Untitled|Tanpa judul/.test(document.querySelector('[data-el="hdr.title"]')?.textContent ?? '')`, 90_000),
      { notice: await page.evaluate(`document.querySelector('[data-el="sys.launch.notice"]')?.textContent ?? null`) });
    check('the project is not auto-opened', !(await page.evaluate(`(document.querySelector('[data-el="hdr.title"]')?.textContent ?? '').includes(${JSON.stringify(projectName)})`)));
  });
  await step('safe-open', async () => {
    await click('[data-el="sys.launch.notice.safe"]');
    check('safe mode banner', await waitFor(`!!document.querySelector('[data-el="sys.safe.banner"]')`, 30_000));
    check('chat and preview hidden in safe mode', await exists('[data-el="sys.safe.chat"]') && await exists('[data-el="sys.safe.preview"]'));
    await click('[data-el="sys.safe.preview.show"]');
    check('preview can be shown on demand', await waitFor(`!!document.querySelector('[data-el="stage.player.controls.play"]')`, 20_000));
  });
  await step('final-logs', async () => {
    const shell = shellLog(); const svc = serviceLog();
    fs.writeFileSync(path.join(out, 'shell.log'), shell); fs.writeFileSync(path.join(out, 'service.log'), svc);
    check('Shell log has no "Failed to fetch" font error', !/fetchFontData|Failed to fetch/.test(shell));
    log({ serviceLowMemory: svc.split('\n').filter((l) => /memory|render/.test(l)).slice(-8) });
  });
  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  log({ fatal: String(e?.stack ?? e).slice(0, 2000) });
} finally {
  try { page?.close(); } catch { /* closed */ }
  await killApp('SIGTERM');
  clearInterval(memTimer);
  const passed = results.filter((r) => r.ok).length;
  const summary = { passed, total: results.length, failed: results.filter((r) => !r.ok).map((r) => r.name), memPeakMb: memPeak, out };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ summary, results, steps }, null, 2));
  log({ summary });
  process.exit(exitCode);
}
