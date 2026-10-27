// End-to-end: the black-window-after-connecting-Claude flow (process.md Entry 28). The built Editor (headless Chrome) against
// the real Local Service (dev mode) whose provider calls go to the local provider stub (EM_DEV_PROVIDER_STUB, dev only).
// Flow: Providers → add Anthropic key → Validate → pick models (table, both agents) → Test → Save → assign again (AssignForm)
// → close → chat ModelPopover pick → Diskusi message → Edit message → OpenRouter with 450 models (popover, search, more)
// → provider faults (529 / 429 / 401) → editor still interactive. Captured: Runtime.exceptionThrown, console errors, error
// boundary hits (sys.crash, sys.section), long tasks, JS heap and DOM nodes (Performance.getMetrics), DOM mutation rate
// while idle (render-loop detector), service requests per step (refetch-storm detector), a screenshot per step.
//
// Prepare once (scratch folder <dir> outside the repo; ports 4110 service / 4120 UI / 4140 stub / 9334 CDP):
//   head -c 24 /dev/urandom | base64 | tr -d '/+=' > <dir>/token; echo -n <passphrase> > <dir>/pass
//   EXPERTMOTION_LICENSE_PASSPHRASE=$(cat <dir>/pass) node tools/license-cli/src/cli.mjs keygen --kid A1 --out <dir>/a1.key --seal --dev-allow-network
//   (cd apps/service && EM_LICENSE_PUBLIC_KEY_A1_HEX=<printed hex> node scripts/build.mjs)
//   VITE_EM_API=http://127.0.0.1:4110 VITE_EM_TOKEN=$(cat <dir>/token) npx vite build apps/ui --outDir <dir>/ui --emptyOutDir
// Run:  E2E_DIR=<dir> bash scripts/run-capped.sh node poc/e2e/providers-flow.mjs
// Afterwards rebuild apps/service/dist WITHOUT the throwaway key: (cd apps/service && node scripts/build.mjs).
// Optional: E2E_SERVICE=<another service.cjs> (e.g. an older commit, to reproduce), E2E_OR_MODELS=<real OpenRouter /models JSON> (else 450 synthetic rows), E2E_HEAP_MB (default 80; measured peak 24 MB).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, openPage } from '../browser/cdp.mjs';
import { startProviderStub } from './provider-stub.mjs';

const root = new URL('../../', import.meta.url).pathname;
const dir = process.env.E2E_DIR; if (!dir) throw new Error('E2E_DIR');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
const dataDir = fs.mkdtempSync(path.join(dir, 'data-'));
const out = path.join(dir, 'shots'); fs.mkdirSync(out, { recursive: true });
const HEAP_MB = Number(process.env.E2E_HEAP_MB ?? 80);
const log = (o) => console.log(JSON.stringify(o));
const results = []; const metrics = [];
const check = (name, ok, extra = {}) => { results.push({ name, ok: !!ok, ...extra }); log({ check: name, ok: !!ok, ...extra }); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stub = await startProviderStub(4140);
const svc = spawn(process.execPath, [process.env.E2E_SERVICE ?? path.join(root, 'apps/service/dist/service.cjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  EM_DEV: '1', EM_TEST_FREE_MEM_MB: '4096', EM_PORT: '4110', EM_TOKEN: token, EM_DATA_DIR: dataDir, EM_UI_ORIGIN: 'http://127.0.0.1:4120', EM_RESOURCES: path.join(root, 'resources'),
  EM_DEV_PROVIDER_STUB: stub.origin } });
let svcLog = ''; svc.stdout.on('data', (d) => { svcLog += d; }); svc.stderr.on('data', (d) => { svcLog += d; });
const api = async (p, init = {}) => { const r = await fetch(`http://127.0.0.1:4110/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
for (let i = 0; i < 80; i++) { try { if ((await fetch('http://127.0.0.1:4110/api/v1/health')).ok) break; } catch { /* starting */ } await sleep(250); }
check('service healthy', (await fetch('http://127.0.0.1:4110/api/v1/health')).ok);
check('service runs the dev provider stub', /DEV provider stub active/.test(svcLog));

{ // licence (no Trial Mode): issue a throwaway key for this Machine Code
  const lic = await api('/license');
  const issued = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/license-cli/src/cli.mjs'), 'issue', '--name', 'E2E', '--email', 'e2e@example.com', '--fingerprint', lic.body.machineCode,
    '--key-file', path.join(dir, 'a1.key'), '--audit', path.join(dataDir, 'audit.csv'), '--out-dir', path.join(dataDir, 'lic'), '--dev-allow-network', '--json'],
    { env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: fs.readFileSync(path.join(dir, 'pass'), 'utf8').trim() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const act = await api('/license/activate', { method: 'POST', body: JSON.stringify({ key: issued.key }) });
  check('licence activated', act.status === 200 && act.body.status === 'licensed', { status: act.status });
}

const ui = path.join(dir, 'ui');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const web = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url ?? '/').split('?')[0]); const f = path.join(ui, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ui) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4120, '127.0.0.1', r));

// Collected in the page before any app code runs: long tasks, error-boundary logs, DOM mutations, service requests.
const PROBE = `(() => {
  const w = window; w.__em = { longTasks: [], errors: [], mutations: 0, requests: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__em.longTasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  const ce = console.error.bind(console);
  console.error = (...a) => { try { w.__em.errors.push(a.map((x) => (x && x.stack) ? x.stack : String(x)).join(' ').slice(0, 3000)); } catch {} ce(...a); };
  const f = w.fetch.bind(w); w.fetch = (...a) => { try { if (String(a[0].url ?? a[0]).includes('/api/v1/')) w.__em.requests++; } catch {} return f(...a); };
  w.__em.mutBy = {};
  document.addEventListener('DOMContentLoaded', () => new MutationObserver((m) => { w.__em.mutations += m.length;
    for (const x of m) { const t = x.target.nodeType === 1 ? x.target : x.target.parentElement; const k = t?.closest?.('[data-el]')?.getAttribute('data-el') ?? '?'; w.__em.mutBy[k] = (w.__em.mutBy[k] ?? 0) + 1; } })
    .observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }));
})()`;

let chrome; let page;
const step = async (name, fn) => {
  try { const r = await fn(); return r; } catch (e) { check(`${name} (threw)`, false, { error: String(e?.message ?? e).slice(0, 400) }); return null; }
  finally { await sample(name); }
};
const sample = async (label) => {
  if (!page) return;
  try {
    const m = Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const em = await page.evaluate(`(() => { const e = window.__em; const r = { longTasks: e.longTasks.length, longest: Math.max(0, ...e.longTasks.map((x) => x.ms)), errors: e.errors.length, mutations: e.mutations, requests: e.requests,
      crash: !!document.querySelector('[data-el="sys.crash"]'), sections: [...document.querySelectorAll('[data-el="sys.section.error"]')].map((x) => x.getAttribute('data-section')) }; return r; })()`);
    const row = { label, heapMb: +(m.JSHeapUsedSize / 1048576).toFixed(1), heapTotalMb: +(m.JSHeapTotalSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, layouts: m.LayoutCount, styleRecalcs: m.RecalcStyleCount, scriptS: +m.ScriptDuration.toFixed(2), ...em };
    metrics.push(row); log({ metrics: row });
    fs.writeFileSync(path.join(out, `${String(metrics.length).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`), await page.screenshot({ x: 0, y: 0, width: 1600, height: 900 }));
  } catch (e) { log({ sampleFailed: label, error: String(e) }); }
};
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await page.evaluate(expr).catch(() => false)) return true; await sleep(200); } return false; };
const q = (sel) => JSON.stringify(sel);
const click = async (sel) => page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
const realClick = async (sel) => {
  const r = await page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return true;
};
const typeInto = async (sel, text) => {
  const ok = await page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.focus(); el.select?.(); return true; })()`);
  if (!ok) return false;
  await page.send('Input.insertText', { text }); return true;
};
const key = async (k, code = k, keyCode = 13) => { for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && k === 'Enter' ? { text: '\r' } : {}) }); };
const selectValue = async (sel, value) => page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${q(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value === ${q(value)}; })()`);
const count = async (sel) => page.evaluate(`document.querySelectorAll(${q(sel)}).length`);
const exceptions = () => page.consoleLines.filter((l) => l.startsWith('EXCEPTION'));
/** Idle render-loop detector: DOM mutations and service requests over `ms` with nothing happening. */
const idle = async (label, ms = 4000) => {
  const a = await page.evaluate('({ m: window.__em.mutations, r: window.__em.requests, by: { ...window.__em.mutBy } })'); await sleep(ms);
  const b = await page.evaluate('({ m: window.__em.mutations, r: window.__em.requests, by: { ...window.__em.mutBy } })');
  const by = Object.entries(b.by).map(([k, v]) => [k, v - (a.by[k] ?? 0)]).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 6);
  const row = { label, ms, mutations: b.m - a.m, requests: b.r - a.r, by }; log({ idle: row });
  return row;
};
/**
 * Entry 30: idle = no render loop. The Editor has periodic, legitimate updates (rotating search suggestion, catalogue preview loops,
 * hardware tick, open dialogs) whose count depends on timing (HEAD build: 61 in 5 s with Providers open), so the check is per element:
 * a loop shows up as one element mutating many times.
 */
const calm = (row) => row.mutations < 120 && row.by.every(([, n]) => n <= 30);
/** Waits until no element matching `sel` is present (busy line gone). */
const settle = async (ms = 600) => { await waitFor(`!document.querySelector('[data-el="scr.providers.busy"], [data-el="agent.chat.model.loading"]')`, 20000); await sleep(ms); };

try {
  const p = await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'E2E Providers', settings: { ratio: '9:16', resolution: '720p', fps: 30, autoRatio: false } }) });
  check('project created', p.status < 300, { status: p.status });
  check('onboarding recorded', (await api('/settings', { method: 'PUT', body: JSON.stringify({ onboardingDone: true }) })).status === 200);

  chrome = await launch(9334);
  page = await openPage(chrome.port, 'about:blank', { width: 1600, height: 900 });
  await page.send('Performance.enable', { timeDomain: 'timeTicks' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await page.send('Page.navigate', { url: 'http://127.0.0.1:4120/' });
  await sleep(500);
  await page.evaluate(`(() => { const k = 'expertmotion.prefs.v1'; const v = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...v, onboardingDone: true, tourDone: true })); })()`);
  await page.send('Page.reload', {});
  await step('editor', async () => {
    check('editor rendered', await waitFor(`!!document.querySelector('[data-el="hdr.menu.file"]')`, 30000));
    await page.evaluate(`(() => { for (const el of document.querySelectorAll('[data-el="tour.skip"], [data-el$=".skip"]')) el.click(); })()`).catch(() => {});
    // FR-202 (Entry 29): a launch shows the Start screen; open the project from its row (older builds open it by themselves).
    await waitFor(`!document.querySelector('[data-el="sys.splash"]') && (!!document.querySelector('[data-el="scr.start.item.open"]') || !!document.querySelector('[data-el="agent.chat"]'))`, 30000);
    if (!(await count('[data-el="agent.chat"]'))) { await sleep(500); await realClick('[data-el="scr.start.item.open"]'); }
    check('project open', await waitFor(`!!document.querySelector('[data-el="agent.chat"]') && document.body.innerText.includes('E2E Providers')`, 15000));
  });

  // ── Providers: add Anthropic ──
  await step('providers-open', async () => {
    check('chat shows Connect', await waitFor(`!!document.querySelector('[data-el="agent.chat.model"]')`));
    await click('[data-el="agent.chat.model"]');
    check('providers screen opened', await waitFor(`!!document.querySelector('[data-el="scr.providers"]')`));
  });
  await step('anthropic-key', async () => {
    check('provider = anthropic', await selectValue('[data-el="scr.providers.provider.select"]', 'anthropic'));
    await typeInto('[data-el="scr.providers.key.input"]', 'sk-ant-api03-stubstubstubstubstubstubstub_0123456789');
  });
  await step('anthropic-validate', async () => {
    await click('[data-el="scr.providers.validate"]');
    check('anthropic validated (model table)', await waitFor(`!!document.querySelector('[data-el="scr.providers.models.all"]')`, 20000));
  });
  await step('anthropic-pick-table', async () => {
    await page.evaluate(`document.querySelector('[data-el="scr.providers.models.all"]').open = true`);
    await waitFor(`document.querySelectorAll('[data-el="scr.providers.models.row"]').length > 0`);
    check('anthropic rows listed', (await count('[data-el="scr.providers.models.row"]')) >= 10, { rows: await count('[data-el="scr.providers.models.row"]') });
    await realClick('[data-el="scr.providers.models.row"][data-model-id="claude-sonnet-5-5"]');
    await click('[data-el="scr.providers.assign.agent.editor"]');
    await realClick('[data-el="scr.providers.models.row"][data-model-id="claude-opus-5-5"]');
    await page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-el="scr.providers.models.category.free"], [data-el="scr.providers.models.category.paid"], [data-el="scr.providers.models.category.all"]')]; for (const x of b) x.click(); })()`);
    await page.evaluate(`(() => { for (const s of ['name','context','price','name']) document.querySelector('[data-el="scr.providers.models.sort.' + s + '"]')?.click(); })()`);
    await typeInto('[data-el="scr.providers.models.search"]', 'opus');
    await sleep(300);
    check('editor model chosen', await page.evaluate(`document.querySelector('[data-el="scr.providers.assign.agent.editor"]')?.getAttribute('data-model-id') === 'claude-opus-5-5'`));
  });
  await step('anthropic-test', async () => {
    await click('[data-el="scr.providers.test"]');
    check('test result shown', await waitFor(`!!document.querySelector('[data-el="scr.providers.test.result"]')`, 25000));
    check('test OK for both agents', await page.evaluate(`[...document.querySelectorAll('[data-el="scr.providers.test.result"] li')].every((li) => !li.getAttribute('data-code'))`), { text: await page.evaluate(`document.querySelector('[data-el="scr.providers.test.result"]')?.innerText ?? ''`) });
  });
  await step('anthropic-save', async () => {
    await click('[data-el="scr.providers.save"]');
    check('connection row listed', await waitFor(`!!document.querySelector('[data-el="scr.providers.row"]') && !document.querySelector('[data-el="scr.providers.locked"]')`, 20000));
    await settle(1500);
    const a = (await api('/providers/assignments')).body;
    check('assignments stored', a.brainstorm?.modelId === 'claude-sonnet-5-5' && a.editor?.modelId === 'claude-opus-5-5', { a: JSON.stringify(a).slice(0, 300) });
  });
  const afterConnect = await idle('after connecting Anthropic', 5000);
  check('no render loop after connecting (idle: no element > 30 mutations / 5 s, total < 120)', calm(afterConnect), afterConnect);
  check('no refetch storm after connecting (idle requests < 6)', afterConnect.requests < 6, afterConnect);
  await step('assignform', async () => {
    check('assign form shown', await waitFor(`!!document.querySelector('[data-el="scr.providers.models.all"]')`));
    await page.evaluate(`document.querySelector('[data-el="scr.providers.models.all"]').open = true`);
    await waitFor(`document.querySelectorAll('[data-el="scr.providers.models.row"]').length > 0`);
    await realClick('[data-el="scr.providers.models.row"][data-model-id="claude-haiku-4-5"]');
    await click('[data-el="scr.providers.assign.both"]');
    await click('[data-el="scr.providers.row.test"]');
    await settle(800);
    await click('[data-el="scr.providers.save"]');
    await settle(1500);
    const a = (await api('/providers/assignments')).body;
    check('assignform save stored haiku for both', a.brainstorm?.modelId === 'claude-haiku-4-5' && a.editor?.modelId === 'claude-haiku-4-5', { a: JSON.stringify(a).slice(0, 300) });
  });
  await step('providers-close', async () => {
    await realClick('[data-el="scr.providers"] [data-close]');
    check('providers closed', await waitFor(`!document.querySelector('[data-el="scr.providers"]')`));
  });
  const afterClose = await idle('editor after closing Providers', 5000);
  check('editor idle after closing (no element > 30 mutations / 5 s, total < 120)', calm(afterClose), afterClose);

  // ── chat ModelPopover ──
  await step('popover-brainstorm', async () => {
    await click('[data-el="agent.chat.mode.brainstorm"]');
    await realClick('[data-el="agent.chat.model"]');
    check('model popover open', await waitFor(`document.querySelectorAll('[data-el="agent.chat.model.row"]').length > 0`));
    await realClick('[data-el="agent.chat.model.row"][data-model-id="claude-sonnet-5-5"]');
    await settle(800);
    check('popover pick stored', (await api('/providers/assignments')).body.brainstorm?.modelId === 'claude-sonnet-5-5');
  });
  await step('popover-editor', async () => {
    await click('[data-el="agent.chat.mode.editor"]');
    await realClick('[data-el="agent.chat.model"]');
    await waitFor(`document.querySelectorAll('[data-el="agent.chat.model.row"]').length > 0`);
    await typeInto('[data-el="agent.chat.model.search"]', 'opus 5');
    await sleep(300);
    await realClick('[data-el="agent.chat.model.row"][data-model-id="claude-opus-5-5"]');
    await settle(800);
    if (await count('[data-el="agent.chat.model.popover"]')) await key('Escape', 'Escape', 27);
    check('editor popover pick stored', (await api('/providers/assignments')).body.editor?.modelId === 'claude-opus-5-5');
  });

  // ── chat: Diskusi + Edit ──
  await step('diskusi', async () => {
    await click('[data-el="agent.chat.mode.brainstorm"]');
    await typeInto('[data-el="agent.chat.composer"]', 'Buat ide video 3 tips hemat listrik');
    await key('Enter', 'Enter', 13);
    check('diskusi answer shown', await waitFor(`[...document.querySelectorAll('[data-el="agent.chat.message"][data-agent="brainstorm"][data-role="assistant"]')].some((m) => m.innerText.includes('hemat listrik'))`, 30000));
  });
  await step('edit', async () => {
    await click('[data-el="agent.chat.mode.editor"]');
    await typeInto('[data-el="agent.chat.composer"]', 'Buat videonya: 5 adegan dengan judul');
    await key('Enter', 'Enter', 13);
    check('edit plan card shown', await waitFor(`!!document.querySelector('[data-el^="agent.editor.plancard"]')`, 45000), { tail: page.consoleLines.slice(-4) });
  });
  await step('edit-execute', async () => {
    const ok = await click('[data-el="agent.editor.execute"]');
    check('plan executed (scene clips on the timeline)', ok && await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"]').length >= 5`, 30000), { n: await count('[data-el="stage.timeline.element"]') });
  });

  // ── faults: overloaded / rate limited / bad key ──
  await step('fault-529', async () => {
    stub.configure('anthropic', { fault: '529', times: 10 });
    await click('[data-el="agent.chat.mode.brainstorm"]');
    await typeInto('[data-el="agent.chat.composer"]', 'Satu ide lagi');
    await key('Enter', 'Enter', 13);
    check('529 shows an error bubble, not a crash', await waitFor(`!!document.querySelector('[data-el="agent.chat.message"][data-role="system"][data-code]')`, 40000), { code: await page.evaluate(`document.querySelector('[data-el="agent.chat.message"][data-role="system"][data-code]')?.getAttribute('data-code') ?? null`) });
    stub.configure('anthropic', { fault: null });
  });
  await step('fault-429-test', async () => {
    stub.configure('anthropic', { fault: '429', times: 1 });
    await click('[data-el="agent.chat.model"]'); await waitFor(`!!document.querySelector('[data-el="agent.chat.model.manage"]')`);
    await click('[data-el="agent.chat.model.manage"]');
    await waitFor(`!!document.querySelector('[data-el="scr.providers"]')`);
    await click('[data-el="scr.providers.test"]');
    check('429 is retried, test result shown', await waitFor(`!!document.querySelector('[data-el="scr.providers.test.result"]')`, 40000));
    stub.configure('anthropic', { fault: null });
  });
  await step('fault-401-add', async () => {
    await click('[data-el="scr.providers.add.open"]');
    await waitFor(`!!document.querySelector('[data-el="scr.providers.add"] [data-el="scr.providers.provider.select"]')`);
    await selectValue('[data-el="scr.providers.add"] [data-el="scr.providers.provider.select"]', 'anthropic');
    await typeInto('[data-el="scr.providers.add"] [data-el="scr.providers.key.input"]', 'sk-ant-api03-badbadbadbadbadbadbadbad_0123456789');
    await click('[data-el="scr.providers.add"] [data-el="scr.providers.validate"]');
    check('401 shows the key error inline', await waitFor(`!!document.querySelector('[data-el="scr.providers.keyhint"]') || document.body.innerText.includes('EM-4002')`, 20000));
    await click('[data-el="scr.providers.cancel"]');
  });

  // ── OpenRouter with 450 models ──
  await step('openrouter-add', async () => {
    await click('[data-el="scr.providers.add.open"]');
    await waitFor(`!!document.querySelector('[data-el="scr.providers.add"] [data-el="scr.providers.provider.select"]')`);
    await selectValue('[data-el="scr.providers.add"] [data-el="scr.providers.provider.select"]', 'openrouter');
    await typeInto('[data-el="scr.providers.add"] [data-el="scr.providers.key.input"]', 'sk-or-v1-stubstubstubstubstubstubstubstubstub0123');
    await click('[data-el="scr.providers.add"] [data-el="scr.providers.validate"]');
    check('openrouter validated', await waitFor(`!!document.querySelector('[data-el="scr.providers.add"] [data-el="scr.providers.models.all"]')`, 30000));
    await page.evaluate(`document.querySelector('[data-el="scr.providers.add"] [data-el="scr.providers.models.all"]').open = true`);
    await waitFor(`document.querySelectorAll('[data-el="scr.providers.models.row"]').length > 0`);
    check('openrouter table rendered at most one page', (await count('[data-el="scr.providers.models.row"]')) <= 100, { rows: await count('[data-el="scr.providers.models.row"]'), total: await page.evaluate(`document.querySelector('[data-el="scr.providers.models.count"]')?.innerText`) });
    for (let i = 0; i < 4; i++) await click('[data-el="scr.providers.models.more"]');
    await click('[data-el="scr.providers.add"] [data-el="scr.providers.save"]');
    check('openrouter saved', await waitFor(`document.querySelectorAll('[data-el="scr.providers.row"]').length >= 2`, 20000));
    await settle(1500);
  });
  await step('openrouter-popover', async () => {
    await realClick('[data-el="scr.providers"] [data-close]');
    await waitFor(`!document.querySelector('[data-el="scr.providers"]')`);
    await realClick('[data-el="agent.chat.model"]');
    await waitFor(`!!document.querySelector('[data-el="agent.chat.model.connection"]')`);
    const orId = await page.evaluate(`[...document.querySelectorAll('[data-el="agent.chat.model.connection"] option')].find((o) => /OpenRouter/i.test(o.textContent))?.value ?? null`);
    await selectValue('[data-el="agent.chat.model.connection"]', orId);
    check('openrouter popover rows', await waitFor(`document.querySelectorAll('[data-el="agent.chat.model.row"]').length > 20`, 15000), { rows: await count('[data-el="agent.chat.model.row"]') });
    for (let i = 0; i < 8; i++) await click('[data-el="agent.chat.model.more"]');
    log({ popoverRowsAfterMore: await count('[data-el="agent.chat.model.row"]') });
    await typeInto('[data-el="agent.chat.model.search"]', 'model-1');
    await sleep(400);
    await realClick('[data-el="agent.chat.model.row"]');
    await settle(800);
    if (await count('[data-el="agent.chat.model.popover"]')) await key('Escape', 'Escape', 27);
  });
  const afterOr = await idle('editor after OpenRouter', 5000);
  check('editor idle after OpenRouter (no element > 30 mutations / 5 s, total < 120)', calm(afterOr), afterOr);

  // ── still interactive ──
  await step('interactive', async () => {
    await realClick('[data-el="hdr.menu.file"]');
    check('header File menu opens after connecting', await waitFor(`!!document.querySelector('[data-el="hdr.menu.file.new"]')`, 5000));
    await key('Escape', 'Escape', 27);
    await realClick('[data-el="hdr.menu.design"]');
    check('header Design tab still switches the library', await waitFor(`!!document.querySelector('[data-preset-id]')`, 8000));
  });

  // ── onboarding route: Help ▸ Onboarding → Provider (ConnectForm, Anthropic) → Models (full AssignForm table) → Hardware → Tour ──
  const clickText = async (text, scope = 'button') => page.evaluate(`(() => { const b = [...document.querySelectorAll(${q(scope)})].find((x) => x.innerText.trim() === ${q(text)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  await step('onboarding-provider', async () => {
    await realClick('[data-el="hdr.menu.help"]');
    await click('[data-el="hdr.menu.help.onboarding"]');
    check('onboarding opened', await waitFor(`!!document.querySelector('[data-el="scr.onboarding"]')`));
    await page.evaluate(`(() => { const s = document.querySelector('[data-el="scr.onboarding.welcome"] button'); s?.click(); })()`);
    await waitFor(`!!document.querySelector('[data-el="scr.onboarding.provider"]')`);
    await selectValue('[data-el="scr.onboarding.provider"] [data-el="scr.providers.provider.select"]', 'anthropic');
    await typeInto('[data-el="scr.onboarding.provider"] [data-el="scr.providers.key.input"]', 'sk-ant-api03-onbonbonbonbonbonbonbonb_0123456789');
    await click('[data-el="scr.onboarding.provider"] [data-el="scr.providers.validate"]');
    check('onboarding moved to Models after connecting', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.models"]')`, 25000));
  });
  await step('onboarding-models', async () => {
    await waitFor(`document.querySelectorAll('[data-el="scr.onboarding.models"] [data-el="scr.providers.models.row"]').length > 0`, 15000);
    check('onboarding model table rows', (await count('[data-el="scr.onboarding.models"] [data-el="scr.providers.models.row"]')) > 0);
    await realClick('[data-el="scr.onboarding.models"] [data-el="scr.providers.models.row"][data-model-id="claude-opus-5-5"]');
    await click('[data-el="scr.onboarding.models"] [data-el="scr.providers.test"]');
    await waitFor(`!!document.querySelector('[data-el="scr.onboarding.models"] [data-el="scr.providers.test.result"]')`, 25000);
    await click('[data-el="scr.onboarding.models"] [data-el="scr.providers.save"]');
    check('onboarding moved to Hardware', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.hardware"]')`, 20000));
  });
  await step('onboarding-tour', async () => {
    await page.evaluate(`document.querySelector('[data-el="scr.onboarding.hardware"] button')?.click()`);
    await waitFor(`!!document.querySelector('[data-el="scr.onboarding.tour"]')`);
    await page.evaluate(`document.querySelector('[data-el="scr.onboarding.tour"] button')?.click()`);
    check('onboarding closed, tour shown', await waitFor(`!document.querySelector('[data-el="scr.onboarding"]') && !!document.querySelector('[data-el="sys.tour"]')`, 15000));
    await sleep(3000);
    await click('[data-el="sys.tour.end"]');
    check('tour ended, editor visible', await waitFor(`!document.querySelector('[data-el="sys.tour"]') && !!document.querySelector('[data-el="hdr.menu.file"]')`, 10000));
  });
  await step('interactive-after-onboarding', async () => {
    await realClick('[data-el="hdr.menu.file"]');
    check('File menu opens after onboarding connect', await waitFor(`!!document.querySelector('[data-el="hdr.menu.file.new"]')`, 5000));
    await key('Escape', 'Escape', 27);
  });

  const ex = exceptions();
  const em = await page.evaluate('window.__em');
  check('no page exceptions', ex.length === 0, { sample: ex.slice(0, 5) });
  check('no console errors from React / boundaries', em.errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)).length === 0, { sample: em.errors.slice(0, 5) });
  check('no error boundary hit', !metrics.some((m) => m.crash || m.sections.length), { hits: metrics.filter((m) => m.crash || m.sections.length).map((m) => m.label) });
  const peak = Math.max(...metrics.map((m) => m.heapMb));
  check(`JS heap stays under ${HEAP_MB} MB`, peak < HEAP_MB, { peakMb: peak });
  check('no long task over 1 s', !metrics.length || Math.max(...metrics.map((m) => m.longest)) < 1000, { longest: Math.max(...metrics.map((m) => m.longest)), count: metrics.at(-1)?.longTasks });
  log({ stubCalls: stub.calls.length, byPath: Object.entries(stub.calls.reduce((a, c) => { const k = `${c.provider} ${c.method} ${c.path}`; a[k] = (a[k] ?? 0) + 1; return a; }, {})) });
} finally {
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 1));
  if (page) fs.writeFileSync(path.join(dir, 'console.txt'), [...page.consoleLines, '--- console.error ---', ...((await page.evaluate('window.__em?.errors ?? []').catch(() => [])))].join('\n'));
  page?.close(); try { chrome?.close(); } catch { /* Chrome still writing its profile */ } web.close(); await stub.close(); svc.kill('SIGTERM');
  await sleep(800);
  fs.writeFileSync(path.join(dir, 'service.log'), svcLog);
  const failed = results.filter((r) => !r.ok);
  log({ summary: `${results.length - failed.length}/${results.length} passed`, failed: failed.map((f) => f.name), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
  process.exitCode = failed.length ? 1 : 0;
}
