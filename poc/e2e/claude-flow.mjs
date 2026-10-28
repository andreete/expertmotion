// End-to-end: the QA of 2026-10-27 with Claude (process.md Entry 30). The built Editor (headless Chrome) against the real Local
// Service (dev mode) whose provider calls go to the local provider stub, which behaves like Claude Sonnet 5.5 on the Messages API
// (validated requests, SSE streaming, native tool_use, proposals WITHOUT params, image input, `xml` mode = tool calls as <invoke>
// markup in plain text). Asserts: onboarding offers "switch to Anthropic" for an sk-ant- key chosen as OpenAI and fills the model
// table + defaults; the working state is visible from Send to the answer (phase text, typing dots, Stop, streamed text); no tool
// markup is ever visible; proposals render and survive a reload (the crash); an image attachment reaches Claude as an image part;
// a text-only model gets the file name only; the markup fallback runs the tool; the Editor's native tool call works; no page
// exception, console error or error-boundary hit.
// QA 2026-10-28 (Entry 33) adds: internet research (web_search server tool, progress "Searching the internet: …", citations as
// links, pause_turn continuation, an account with web search off → EM-4403 notice), openly licensed pictures (web_images →
// Import → Library asset), Diskusi and Editor as separate tabs with "Send to Editor" (both tabs show progress, the draft card
// follows the run), the plan preview before Execute and the timeline change after it, deleting through the chat with the inline
// confirmation (no EM-9002), fixing ONE caption word through a caption chip, audio + document attachments, and the acceptance
// prompt "Ekspor Nikel Indonesia 2026" (scene.compose preview with 6 scenes "perkiraan"; Execute makes the voices first — no local
// voice model here, so it must stop with the reason and change nothing).
//
// Prepare once exactly like poc/e2e/providers-flow.mjs (scratch folder <dir> outside the repo with token, pass, a1.key, a UI build in
// <dir>/ui and a dev Service build with that A1 public key). Ports 4110 service / 4120 UI / 4140 stub / 9335 CDP.
// Run:  E2E_DIR=<dir> bash scripts/run-capped.sh node poc/e2e/claude-flow.mjs   (a service.cjs outside the repo, E2E_SERVICE=…, needs NODE_PATH=<repo>/node_modules)
// Afterwards rebuild apps/service/dist WITHOUT the throwaway key: (cd apps/service && node scripts/build.mjs).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, openPage } from '../browser/cdp.mjs';
import { startProviderStub } from './provider-stub.mjs';

const root = new URL('../../', import.meta.url).pathname;
const comp = path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu');                    // ffprobe for image ingest
const dir = process.env.E2E_DIR; if (!dir) throw new Error('E2E_DIR');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
const dataDir = fs.mkdtempSync(path.join(dir, 'data-'));
const out = path.join(dir, 'claude-shots'); fs.mkdirSync(out, { recursive: true });
const log = (o) => console.log(JSON.stringify(o));
const results = [];
const check = (name, ok, extra = {}) => { results.push({ name, ok: !!ok, ...extra }); log({ check: name, ok: !!ok, ...extra }); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1×1 PNG (the CTA image the QA attached)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pngPath = path.join(dataDir, 'cta-logo.png'); fs.writeFileSync(pngPath, PNG);

const stub = await startProviderStub(4140);
stub.configure('anthropic', { thinkMs: 1500 });
const svc = spawn(process.execPath, [process.env.E2E_SERVICE ?? path.join(root, 'apps/service/dist/service.cjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  EM_DEV: '1', EM_TEST_FREE_MEM_MB: '4096', EM_PORT: '4110', EM_TOKEN: token, EM_DATA_DIR: dataDir, EM_UI_ORIGIN: 'http://127.0.0.1:4120', EM_RESOURCES: path.join(root, 'resources'),
  EM_DEV_PROVIDER_STUB: stub.origin, EM_FFMPEG: path.join(comp, 'ffmpeg'), EM_FFPROBE: path.join(comp, 'ffprobe'), LD_LIBRARY_PATH: comp } });
let svcLog = ''; svc.stdout.on('data', (d) => { svcLog += d; }); svc.stderr.on('data', (d) => { svcLog += d; });
const api = async (p, init = {}) => { const r = await fetch(`http://127.0.0.1:4110/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
for (let i = 0; i < 80; i++) { try { if ((await fetch('http://127.0.0.1:4110/api/v1/health')).ok) break; } catch { /* starting */ } await sleep(250); }
check('service healthy', (await fetch('http://127.0.0.1:4110/api/v1/health')).ok);
check('service runs the dev provider stub', /DEV provider stub active/.test(svcLog));
{
  const lic = await api('/license');
  const issued = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/license-cli/src/cli.mjs'), 'issue', '--name', 'E2E', '--email', 'e2e@example.com', '--fingerprint', lic.body.machineCode,
    '--key-file', path.join(dir, 'a1.key'), '--audit', path.join(dataDir, 'audit.csv'), '--out-dir', path.join(dataDir, 'lic'), '--dev-allow-network', '--json'],
    { env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: fs.readFileSync(path.join(dir, 'pass'), 'utf8').trim() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const act = await api('/license/activate', { method: 'POST', body: JSON.stringify({ key: issued.key }) });
  check('licence activated', act.status === 200 && act.body.status === 'licensed', { status: act.status });
}
const ui = process.env.E2E_UI ?? path.join(dir, 'ui');                    // E2E_UI: another UI build (an older commit)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const web = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url ?? '/').split('?')[0]); const f = path.join(ui, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ui) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4120, '127.0.0.1', r));
// console errors, and every progress line the chat shows (a MutationObserver sees each one, however short).
const PROBE = `(() => { const w = window; w.__em = { errors: [], progress: [] }; const ce = console.error.bind(console);
  console.error = (...a) => { try { w.__em.errors.push(a.map((x) => (x && x.stack) ? x.stack : String(x)).join(' ').slice(0, 3000)); } catch {} ce(...a); };
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => { const p = document.querySelector('[data-el="agent.chat.progress"]');
    if (p) { const v = (p.getAttribute('data-phase') ?? '') + '|' + p.innerText.replace(/\\s*·.*$/, '').trim(); if (w.__em.progress.at(-1) !== v) w.__em.progress.push(v); } }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })); })()`;

let chrome; let page; let shot = 0;
const snap = async (label) => { try { fs.writeFileSync(path.join(out, `${String(++shot).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`), await page.screenshot({ x: 0, y: 0, width: 1600, height: 900 })); } catch { /* best effort */ } };
const step = async (name, fn) => { try { return await fn(); } catch (e) { check(`${name} (threw)`, false, { error: String(e?.message ?? e).slice(0, 400) }); return null; } finally { await snap(name); } };
const q = (sel) => JSON.stringify(sel);
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if (await page.evaluate(expr).catch(() => false)) return true; await sleep(150); } return false; };
const click = async (sel) => page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
const typeInto = async (sel, text) => { const ok = await page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.focus(); el.select?.(); return true; })()`); if (!ok) return false; await page.send('Input.insertText', { text }); return true; };
const enter = async () => { for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); };
const selectValue = async (sel, value) => page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${q(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value === ${q(value)}; })()`);
const count = async (sel) => page.evaluate(`document.querySelectorAll(${q(sel)}).length`);
const text = async (sel) => page.evaluate(`document.querySelector(${q(sel)})?.innerText ?? ''`);
const MARKUP = /<\/?(invoke|function_calls|parameter|tool_call)\b|parameter name=/;
let markupSeen = 0;
/** Opens the E2E project: the Start screen's row (FR-202, other agent) or the old auto-open. */
const realClick = async (sel) => {
  const r = await page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return true;
};
const openProject = async () => {
  const opened = `!document.querySelector('[data-el="sys.splash"]') && !!document.querySelector('[data-el="agent.chat"]') && document.body.innerText.includes('E2E Claude')`;
  await waitFor(`!document.querySelector('[data-el="sys.splash"]') && (!!document.querySelector('[data-el="scr.start.item.open"]') || (${opened}))`, 30000);
  for (let i = 0; i < 3 && !(await page.evaluate(opened)); i++) {
    await sleep(600);
    await realClick('[data-el="scr.start.item.open"]');
    if (await waitFor(`!!document.querySelector('[data-el="agent.chat"]')`, 10000)) break;
    log({ openProjectRetry: i, console: page.consoleLines.slice(-8) });
  }
  return waitFor(`!!document.querySelector('[data-el="agent.chat"]') && document.body.innerText.includes('E2E Claude')`, 20000);
};
const assistantCount = () => count('[data-el="agent.chat.message"][data-role="assistant"][data-agent="brainstorm"]');
/**
 * Sends a Diskusi message and samples the chat every 100 ms until the answer is in the thread: the working bubble must be there
 * from the first sample to the answer (FR-214), with phase text and Stop; streamed text must grow before the end; no markup ever.
 */
const discuss = async (label, message, { mode = 'brainstorm' } = {}) => {
  await click(`[data-el="agent.chat.tab.${mode}"]`);                       // ADR-033: two tabs (separate threads)
  const before = mode === 'brainstorm' ? await assistantCount() : await count('[data-el="agent.editor.plancard"]');
  await page.evaluate('window.__em.progress = []');
  await typeInto('[data-el="agent.chat.composer"]', message);
  await enter();
  const samples = [];
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    const s = await page.evaluate(`(() => { const st = document.querySelector('[data-el="agent.chat.streaming"]'); const pr = document.querySelector('[data-el="agent.chat.progress"]');
      return { t: 0, streaming: !!st, phase: pr?.getAttribute('data-phase') ?? null, progress: pr?.innerText ?? '', text: st?.innerText ?? '', stop: !!document.querySelector('[data-el="agent.chat.stop"]'),
        placeholder: document.querySelector('[data-el="agent.chat.composer"]')?.getAttribute('placeholder') ?? '', thread: document.querySelector('[data-el="agent.chat.thread"]')?.innerText ?? '',
        answers: document.querySelectorAll(${q(mode === 'brainstorm' ? '[data-el="agent.chat.message"][data-role="assistant"][data-agent="brainstorm"]' : '[data-el="agent.editor.plancard"]')}).length,
        error: document.querySelector('[data-el="agent.chat.message"][data-code]')?.getAttribute('data-code') ?? null }; })()`);
    s.t = Date.now() - t0; samples.push(s);
    if (MARKUP.test(s.thread) || MARKUP.test(s.text)) markupSeen++;
    if (i === 12) await snap(`${label}-working`);                          // the working state mid-run (thinking / tool / streamed text)
    if (s.answers > before && !s.streaming) break;
    await sleep(100);
  }
  const done = samples.at(-1);
  const answeredAt = samples.findIndex((x) => x.answers > before);
  const during = samples.slice(0, answeredAt < 0 ? samples.length : answeredAt);
  const gaps = during.filter((x) => !x.streaming).length;
  const seen = await page.evaluate('window.__em.progress');
  const phases = [...new Set([...during.map((x) => x.phase), ...seen.map((x) => x.split('|')[0])].filter(Boolean))];
  const progressTexts = [...new Set([...during.map((x) => x.progress.replace(/\s*·.*$/, '').trim()), ...seen.map((x) => x.split('|')[1])].filter(Boolean))];
  const lengths = during.map((x) => x.text.length);
  log({ run: label, ms: done.t, samples: samples.length, phases, progressTexts, gaps, maxText: Math.max(0, ...lengths), error: done.error });
  check(`${label}: answered`, done.answers > before && !done.error, { error: done.error, ms: done.t });
  check(`${label}: working bubble from the first sample (no silent gap after Send)`, during.length > 0 && during[0].streaming, { first: during[0] && { streaming: during[0].streaming, phase: during[0].phase } });
  check(`${label}: working bubble for the whole run`, gaps === 0, { gaps, samples: during.length });
  check(`${label}: Stop replaces Send while working, composer says it is working`, during.every((x) => !x.streaming || x.stop) && during.some((x) => /working/i.test(x.placeholder)));
  return { samples, during, phases, progressTexts, lengths };
};

try {
  const p = await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'E2E Claude', settings: { ratio: '16:9', resolution: '720p', fps: 30, autoRatio: false } }) });
  check('project created', p.status < 300, { status: p.status });
  chrome = await launch(9335);
  page = await openPage(chrome.port, 'about:blank', { width: 1600, height: 900 });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await page.send('DOM.enable', {});
  await page.send('Page.navigate', { url: 'http://127.0.0.1:4120/' });
  await sleep(500);
  await page.evaluate(`(() => { const k = 'expertmotion.prefs.v1'; const v = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...v, onboardingDone: false, onboardingStep: 0, tourDone: true })); })()`);
  await page.send('Page.reload', {});

  // E2E_REPRO_ONBOARDING=1: the QA's exact sequence without the new one-click switch (OpenAI + sk-ant- key → EM-4002, then the
  // provider changed by hand to Anthropic → Validate) and what the Models step shows; then exits. Used against older builds.
  if (process.env.E2E_REPRO_ONBOARDING === '1') {
    await waitFor(`!!document.querySelector('[data-el="scr.onboarding.welcome"]')`, 30000);
    await page.evaluate(`document.querySelector('[data-el="scr.onboarding.welcome"] button')?.click()`);
    await waitFor(`!!document.querySelector('[data-el="scr.onboarding.provider"]')`);
    await selectValue('[data-el="scr.providers.provider.select"]', 'openai');
    await typeInto('[data-el="scr.providers.key.input"]', 'sk-ant-api03-stubstubstubstubstubstubstub_0123456789');
    stub.configure('openai', { fault: '401', times: 10 });
    await click('[data-el="scr.providers.validate"]');
    await waitFor(`/EM-4002|not accept|New keys/.test(document.body.innerText)`, 15000);
    await snap('repro-openai-refused');
    await selectValue('[data-el="scr.providers.provider.select"]', 'anthropic');
    await typeInto('[data-el="scr.providers.key.input"]', 'sk-ant-api03-stubstubstubstubstubstubstub_0123456789');
    await click('[data-el="scr.providers.validate"]');
    await waitFor(`!!document.querySelector('[data-el="scr.onboarding.models"]')`, 20000);
    await sleep(4000);
    await snap('repro-models-step');
    const state = await page.evaluate(`({ rows: document.querySelectorAll('[data-el="scr.providers.models.row"]').length, empty: !!document.querySelector('[data-el="scr.providers.models.empty"]'), text: document.querySelector('[data-el="scr.onboarding.models"]')?.innerText.slice(0, 400) })`);
    const conns = (await api('/providers/connections')).body.items.map((c) => ({ provider: c.provider, status: c.status, models: c.modelCount }));
    log({ repro: state, conns, defaultConnectionId: (await api('/providers/assignments')).body.defaultConnectionId, connIds: (await api('/providers/connections')).body.items.map((c) => `${c.provider}:${c.id}`) });
    check('repro: Models step shows the Anthropic model list', state.rows > 0 && !state.empty, state);
    throw new Error('repro done');
  }
  // ── FR-215 onboarding: OpenAI chosen with an Anthropic key → one-click switch; model list + defaults ──
  await step('onboarding-provider', async () => {
    check('onboarding wizard shown', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.welcome"]')`, 30000));
    await page.evaluate(`document.querySelector('[data-el="scr.onboarding.welcome"] button')?.click()`);
    check('provider step', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.provider"]')`));
    check('provider = openai', await selectValue('[data-el="scr.providers.provider.select"]', 'openai'));
    await typeInto('[data-el="scr.providers.key.input"]', 'sk-ant-api03-stubstubstubstubstubstubstub_0123456789');
    check('mismatch hint "This key belongs to Anthropic"', await waitFor(`/Anthropic/.test(document.querySelector('[data-el="scr.providers.key.mismatch"]')?.innerText ?? '')`, 5000), { text: await text('[data-el="scr.providers.key.mismatch"]') });
    await click('[data-el="scr.providers.key.mismatch.switch"]');
    check('provider switched to anthropic in one click', await page.evaluate(`document.querySelector('[data-el="scr.providers.provider.select"]').value === 'anthropic' && !document.querySelector('[data-el="scr.providers.key.mismatch"]')`));
    await click('[data-el="scr.providers.validate"]');
    check('models step reached', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.models"]')`, 20000));
  });
  await step('onboarding-models', async () => {
    check('model table filled (never "No model list yet")', await waitFor(`document.querySelectorAll('[data-el="scr.providers.models.row"]').length >= 10 && !document.querySelector('[data-el="scr.providers.models.empty"]')`, 15000), { rows: await count('[data-el="scr.providers.models.row"]') });
    const pre = await page.evaluate(`({ b: document.querySelector('[data-el="scr.providers.assign.agent.brainstorm"]')?.getAttribute('data-model-id'), e: document.querySelector('[data-el="scr.providers.assign.agent.editor"]')?.getAttribute('data-model-id') })`);
    check('defaults preselected: newest Claude Sonnet for both agents', pre.b === 'claude-sonnet-5-5' && pre.e === 'claude-sonnet-5-5', pre);
    await click('[data-el="scr.providers.defaults"]');
    check('"Use defaults" moves on', await waitFor(`!!document.querySelector('[data-el="scr.onboarding.hardware"]')`, 15000));
    const a = (await api('/providers/assignments')).body;
    check('"Use defaults" stored both assignments', a.brainstorm?.modelId === 'claude-sonnet-5-5' && a.editor?.modelId === 'claude-sonnet-5-5', { a: JSON.stringify(a).slice(0, 200) });
    const conns = (await api('/providers/connections')).body.items;
    check('no stale connection left behind', conns.length === 1 && conns[0].provider === 'anthropic' && a.defaultConnectionId === conns[0].id, { conns: conns.map((c) => `${c.provider}:${c.status}`) });
  });
  await step('editor-open', async () => {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ onboardingDone: true }) });
    await page.evaluate(`(() => { const k = 'expertmotion.prefs.v1'; const v = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...v, onboardingDone: true, tourDone: true })); })()`);
    await page.send('Page.reload', {});
    check('project open in the Editor', await openProject());
    await page.evaluate(`(() => { for (const el of document.querySelectorAll('[data-el="tour.skip"], [data-el$=".skip"]')) el.click(); })()`).catch(() => {});
  });

  // ── FR-210 / FR-211 / FR-214: Diskusi with native tools, streamed, progress all the way ──
  await step('diskusi-native', async () => {
    const r = await discuss('Diskusi (native tools)', 'Apakah kamu bisa buatkan konten edukasi full motion graphic untuk investor luar, temanya "Peluang Bisnis Data Center di Indonesia"? Script kira-kira 80 kata.');
    check('progress named the catalogue search', r.progressTexts.some((x) => /Searching the catalogue|Mencari di katalog/.test(x)), { texts: r.progressTexts });
    check('progress showed thinking and the idea search', r.phases.includes('thinking') && (r.phases.includes('planning') || r.phases.includes('reading')), { phases: r.phases });
    check('answer text streamed into the bubble before the end', r.lengths.some((n) => n > 20) && new Set(r.lengths.filter((n) => n > 0)).size > 1, { maxText: Math.max(0, ...r.lengths) });
    check('proposals card with 2 items', await waitFor(`document.querySelectorAll('[data-el="agent.brainstorm.handoff.item"]').length === 2`, 5000));
    const calls = stub.calls.filter((c) => c.provider === 'anthropic' && c.path === '/v1/messages' && c.tools?.length);
    check('native tools sent, streamed, tool_result returned, every request valid', calls.length >= 2 && calls.every((c) => c.stream && !c.problem) && calls[0].tools.includes('catalogue_search') && calls[1].toolResults.length === 1,
      { calls: calls.map((c) => ({ stream: c.stream, tools: c.tools?.length, results: c.toolResults?.length, problem: c.problem, maxTokens: c.maxTokens })) });
  });
  await step('reload-keeps-proposals', async () => {
    await page.send('Page.reload', {});
    check('project reopens after a reload', await openProject());
    check('stored proposals render after reload (no crash)', await waitFor(`document.querySelectorAll('[data-el="agent.brainstorm.handoff.item"]').length === 2 && !document.querySelector('[data-el="sys.section.error"]') && !document.querySelector('[data-el="sys.crash"]')`, 10000));
  });

  // ── FR-213: image attachment reaches Claude as an image part ──
  await step('image-attach', async () => {
    await click('[data-el="agent.chat.tab.brainstorm"]');
    const { root: docRoot } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: docRoot.nodeId, selector: '[data-el="agent.chat"] input[type="file"]' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [pngPath] });
    check('attachment chip shown and ready', await waitFor(`document.querySelector('[data-el="agent.chat.attach.chip"]')?.getAttribute('data-status') === 'ready'`, 20000), { chip: await page.evaluate(`document.querySelector('[data-el="agent.chat.attach.chip"]')?.outerHTML?.slice(0, 200) ?? null`) });
    check('no attachment error (was EM-9002 "Request not valid")', !(await count('[data-el="agent.chat.attach.error"]')), { error: await text('[data-el="agent.chat.attach.error"]') });
    await discuss('Diskusi (image)', 'Pakai gambar ini sebagai CTA');
    check('Claude received the image (reply says so)', /Gambar diterima \(image\/png\)/.test(await text('[data-el="agent.chat.thread"]')));
    const last = stub.calls.filter((c) => c.provider === 'anthropic' && c.path === '/v1/messages').at(-1);
    check('image sent as a base64 image part', last?.images?.some((x) => x.mediaType === 'image/png') && !last.problem, { images: last?.images, problem: last?.problem });
    check('sent message marks the image as sent', await page.evaluate(`[...document.querySelectorAll('[data-el="agent.chat.message.attachment"]')].some((x) => x.getAttribute('data-sent') === 'image')`));
  });
  await step('image-text-only-model', async () => {
    const a = (await api('/providers/assignments')).body;
    await api('/providers/assignments', { method: 'PUT', body: JSON.stringify({ brainstorm: { agent: 'brainstorm', connectionId: a.brainstorm.connectionId, modelId: 'claude-text-stub', settings: {} } }) });
    await waitFor(`/Text Stub/.test(document.querySelector('[data-el="agent.chat.model"]')?.innerText ?? '')`, 10000);
    await click('[data-el="agent.chat.attach"]');
    await waitFor(`!!document.querySelector('[data-el="agent.chat.attach.asset"]')`, 5000);
    await click('[data-el="agent.chat.attach.asset"]');
    check('composer says only the file name will be sent', await waitFor(`document.querySelector('[data-el="agent.chat.attach.note"]')?.getAttribute('data-code') === 'EM-4307'`, 5000), { note: await text('[data-el="agent.chat.attach.note"]') });
    await discuss('Diskusi (text-only model)', 'Ini logonya');
    const last = stub.calls.filter((c) => c.provider === 'anthropic' && c.path === '/v1/messages').at(-1);
    check('text-only model got no image part and no refusal', last && !last.images?.some(() => true) && !last.problem, { images: last?.images, problem: last?.problem });
    check('sent message marks the image as name only', await page.evaluate(`[...document.querySelectorAll('[data-el="agent.chat.message.attachment"]')].some((x) => x.getAttribute('data-sent') === 'name')`));
    await api('/providers/assignments', { method: 'PUT', body: JSON.stringify({ brainstorm: { agent: 'brainstorm', connectionId: a.brainstorm.connectionId, modelId: 'claude-sonnet-5-5', settings: {} } }) });
    await waitFor(`/Sonnet 5\\.5/.test(document.querySelector('[data-el="agent.chat.model"]')?.innerText ?? '')`, 10000);
  });

  // ── FR-211 fallback: Claude writes the tool call as <invoke> markup in plain text (QA screenshots) ──
  await step('diskusi-xml-markup', async () => {
    stub.configure('anthropic', { thinkMs: 600, mode: 'xml' });
    const n0 = stub.calls.length;
    await discuss('Diskusi (markup fallback)', 'Cari latar yang cocok');
    const calls = stub.calls.slice(n0).filter((c) => c.provider === 'anthropic' && c.path === '/v1/messages');
    check('markup read as a tool call: a second request carried the tool result', calls.length >= 2 && calls.every((c) => !c.problem), { calls: calls.length });
    check('the answer is shown without markup', /Ide konten/.test(await text('[data-el="agent.chat.thread"]')) && !MARKUP.test(await text('[data-el="agent.chat.thread"]')));
    stub.configure('anthropic', { thinkMs: 600, mode: 'native' });
  });

  // ── Editor: native composition_get tool call, then a plan ──
  await step('edit-native', async () => {
    await discuss('Edit (native tools)', 'Buatkan videonya dari ide tadi', { mode: 'editor' });
    check('plan card shown', (await count('[data-el="agent.editor.plancard"]')) > 0);
    const ed = stub.calls.filter((c) => c.provider === 'anthropic' && c.path === '/v1/messages' && c.tools?.includes('composition_validateOps'));
    check('Editor used native tools with valid requests', ed.length >= 2 && ed.every((c) => !c.problem) && ed.some((c) => c.toolResults?.length), { calls: ed.map((c) => ({ results: c.toolResults?.length, problem: c.problem })) });
  });

  // ── FR-216: internet research (Anthropic web_search server tool), citations, pause_turn, account with web search off ──
  await step('research-web-search', async () => {
    const n0 = stub.calls.length;
    const r = await discuss('Diskusi (riset internet)', 'Tolong riset data terbaru ekspor nikel Indonesia 2026 dan sebutkan sumbernya');
    const calls = stub.calls.slice(n0).filter((c) => c.provider === 'anthropic' && c.path === '/v1/messages');
    check('research: web_search_20260209 + web_fetch_20260209 offered, request valid', calls.some((c) => c.webTools?.includes('web_search_20260209') && c.webTools?.includes('web_fetch_20260209')) && calls.every((c) => !c.problem), { calls: calls.map((c) => ({ web: c.webTools, problem: c.problem, stop: c.stop })) });
    check('research: progress said what it searched ("Searching the internet: …")', r.progressTexts.some((x) => /Searching the internet: ekspor nikel|Mencari di internet: ekspor nikel/.test(x)), { texts: r.progressTexts });
    check('research: sources shown as links (cited first)', await waitFor(`document.querySelectorAll('[data-el="agent.chat.message.source"]').length >= 2`, 5000), { sources: await page.evaluate(`[...document.querySelectorAll('[data-el="agent.chat.message.source"]')].map((a) => a.getAttribute('href'))`) });
    check('research: first link is the cited ANTARA article', /antaranews\.com/.test(await page.evaluate(`document.querySelector('[data-el="agent.chat.message.source"]')?.getAttribute('href') ?? ''`)));
    check('research: answer has the researched figure and no "cannot access the internet"', /25,96/.test(await text('[data-el="agent.chat.thread"]')) && !/tidak bisa mengakses internet|cannot access the internet/i.test(await text('[data-el="agent.chat.thread"]')));
  });
  await step('research-pause-turn', async () => {
    stub.configure('anthropic', { thinkMs: 300, pauseOnce: true });
    const n0 = stub.calls.length;
    await discuss('Diskusi (riset, pause_turn)', 'Riset sumber terbaru soal volume ekspor nikel');
    const calls = stub.calls.slice(n0).filter((c) => c.provider === 'anthropic' && c.path === '/v1/messages');
    check('pause_turn: the paused turn was continued (pause_turn → end_turn, every request valid)', calls.map((c) => c.stop).join(',').includes('pause_turn,end_turn') && calls.every((c) => !c.problem), { stops: calls.map((c) => c.stop), problems: calls.map((c) => c.problem) });
    stub.configure('anthropic', { thinkMs: 300 });
  });
  await step('research-pictures', async () => {
    await discuss('Diskusi (gambar)', 'Carikan gambar bijih nikel untuk adegan 3');
    check('pictures: candidates listed with licence (by-nc dropped)', await waitFor(`document.querySelectorAll('[data-el="agent.chat.message.image"]').length === 1 && /CC BY 4\.0/.test(document.querySelector('[data-el="agent.chat.message.image"]').innerText)`, 8000), { text: await text('[data-el="agent.chat.message.images"]') });
    const before = (await api(`/projects/${(await api('/projects')).body.items[0].id}/assets`)).body.items?.length ?? 0;
    await click('[data-el="agent.chat.message.image.import"]');
    check('pictures: Import puts it in the Library with its credit', await waitFor(`document.querySelector('[data-el="agent.chat.message.image"]')?.getAttribute('data-imported') === 'true'`, 15000));
    const after = (await api(`/projects/${(await api('/projects')).body.items[0].id}/assets`)).body.items?.length ?? 0;
    check('pictures: one more asset in the project', after === before + 1, { before, after });
  });
  await step('research-org-disabled', async () => {
    stub.configure('anthropic', { thinkMs: 300, web: 'disabled' });
    await discuss('Diskusi (web search off di akun)', 'Riset internet: harga nikel terbaru');
    check('account with web search off: EM-4403 notice instead of a failure', await waitFor(`!!document.querySelector('[data-el="agent.chat.message.notice"][data-code="EM-4403"]')`, 8000), { notice: await text('[data-el="agent.chat.message.notice"]') });
    stub.configure('anthropic', { thinkMs: 300, web: 'on' });
  });

  // ── ADR-033 / FR-219: separate chats; "Send to Editor" with progress in both tabs; plan preview; Execute changes the timeline ──
  await step('handoff-send-to-editor', async () => {
    await click('[data-el="agent.chat.tab.brainstorm"]');
    check('Diskusi tab shows only Diskusi messages', await page.evaluate(`[...document.querySelectorAll('[data-el="agent.chat.message"]')].every((m) => m.getAttribute('data-agent') === 'brainstorm')`));
    const btn = await page.evaluate(`(() => { const all = [...document.querySelectorAll('[data-el="agent.chat.sendtoeditor"]')]; const b = all.at(-1); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
    check('"Send to Editor" on the latest draft', btn);
    const samples = [];
    for (let i = 0; i < 150; i++) {
      const v = await page.evaluate(`({ tab: document.querySelector('[data-el="agent.chat.tab.editor"]')?.getAttribute('aria-selected'), phases: !!document.querySelector('[data-el="agent.chat.phases"]'), streaming: !!document.querySelector('[data-el="agent.chat.streaming"][data-agent="editor"]'), plan: document.querySelector('[data-el="agent.editor.plancard"]:last-of-type')?.getAttribute('data-status') ?? null, cards: document.querySelectorAll('[data-el="agent.editor.plancard"]').length })`);
      samples.push(v); if (v.plan === 'valid' && !v.streaming) break; await sleep(100);
    }
    check('Editor tab opened at once with the phase stepper while it plans', samples.some((x) => x.tab === 'true' && x.phases), { first: samples[0], n: samples.length });
    check('Editor message carries "From Discussion"', await waitFor(`!!document.querySelector('[data-el="agent.editor.message.origin"]')`, 8000));
    check('plan ready with a readable preview (rows)', await waitFor(`([...document.querySelectorAll('[data-el="agent.editor.execute"]')].at(-1)?.closest('[data-el="agent.editor.plancard"]')?.querySelectorAll('[data-el="agent.editor.plancard.preview.row"]').length ?? 0) > 0`, 20000), { rows: await count('[data-el="agent.editor.plancard.preview.row"]') });
    await click('[data-el="agent.chat.tab.brainstorm"]');
    check('Diskusi tab: the draft card says the plan is ready', await waitFor(`document.querySelector('[data-el="agent.brainstorm.handoff.card"]')?.getAttribute('data-state') === 'ready'`, 8000));
    await click('[data-el="agent.brainstorm.handoff.open"]');
    const before = await count('[data-el="stage.timeline.element"]');
    await page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-el="agent.editor.execute"]')].at(-1); b?.scrollIntoView({ block: 'center' }); b?.click(); })()`);
    check('Execute applied the plan', await waitFor(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].some((c) => c.getAttribute('data-status') === 'executed')`, 20000));
    check('the timeline visibly changed', await waitFor(`document.querySelectorAll('[data-el="stage.timeline.element"]').length > ${before}`, 10000), { before, after: await count('[data-el="stage.timeline.element"]') });
    check('"Show in timeline" offered on the applied card', (await count('[data-el="agent.editor.plancard.showtimeline"]')) > 0);
    await click('[data-el="agent.chat.tab.brainstorm"]');
    check('Diskusi draft card follows to "applied"', await waitFor(`document.querySelector('[data-el="agent.brainstorm.handoff.card"]')?.getAttribute('data-state') === 'applied'`, 8000));
  });

  // ── QA #17: delete through the chat → inline confirmation → confirmDestructive → removed (never EM-9002) ──
  await step('delete-via-chat', async () => {
    const pid = (await api('/projects')).body.items[0].id;
    const clipsBefore = (await api(`/projects/${pid}/composition?model=true`)).body.head.model.tracks.video.length;
    await discuss('Edit (hapus adegan)', 'hapus adegan pertama dari timeline', { mode: 'editor' });
    check('delete plan previews the removal', await waitFor(`!!document.querySelector('[data-el="agent.editor.plancard.preview.row"][data-kind="remove"]')`, 8000));
    await page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-el="agent.editor.execute"]')].at(-1); b?.scrollIntoView({ block: 'center' }); b?.click(); })()`);
    check('inline removal confirmation (no "Request not valid")', await waitFor(`!!document.querySelector('[data-el="agent.editor.plancard.confirmremoval"]')`, 8000) && !(await page.evaluate(`/EM-9002/.test(document.body.innerText)`)));
    await click('[data-el="agent.editor.plancard.confirmremoval.yes"]');
    check('removed after confirming', await waitFor(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].filter((c) => c.getAttribute('data-status') === 'executed').length >= 2`, 15000));
    const clipsAfter = (await api(`/projects/${pid}/composition?model=true`)).body.head.model.tracks.video.length;
    check('the composition lost exactly that scene', clipsAfter === clipsBefore - 1, { clipsBefore, clipsAfter });
  });

  // ── QA #12 / #13: caption chip + fix ONE word ──
  await step('caption-fix-one-word', async () => {
    const pid = (await api('/projects')).body.items[0].id;
    await discuss('Edit (buat caption)', 'buat caption dari naskah', { mode: 'editor' });
    await page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-el="agent.editor.execute"]')].at(-1); b?.scrollIntoView({ block: 'center' }); b?.click(); })()`);
    await sleep(1500);
    const pages0 = (await api(`/projects/${pid}/composition?model=true`)).body.head.model.tracks.caption.pages;
    check('captions in place (2 pages)', pages0.length === 2, { pages: pages0.map((p) => p.text) });
    // the caption under the playhead is offered as a chip when the playhead is inside a page (the playhead is at 0 here: page 1)
    const suggested = await waitFor(`!!document.querySelector('[data-el="agent.chat.target.caption.suggest"]')`, 3000);
    check('caption under the playhead offered as a chip', suggested);
    await discuss('Edit (perbaiki 1 kata caption)', "ganti 'energi besi' jadi 'energi bersih' di detik 2", { mode: 'editor' });
    await page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-el="agent.editor.execute"]')].at(-1); b?.scrollIntoView({ block: 'center' }); b?.click(); })()`);
    await sleep(1500);
    const pages1 = (await api(`/projects/${pid}/composition?model=true`)).body.head.model.tracks.caption.pages;
    check('only that caption page changed ("energi bersih"), the other page untouched, timing kept', pages1.length === 2 && pages1[1].text.includes('energi bersih') && pages1[0].text === pages0[0].text && pages1[1].startMs === pages0[1].startMs && pages1[1].durationMs === pages0[1].durationMs, { before: pages0.map((p) => p.text), after: pages1.map((p) => p.text) });
  });

  // ── QA #14: audio and document attachments ──
  await step('attach-audio-and-document', async () => {
    const wav = path.join(dataDir, 'musik-latar.wav');
    const pcm = Buffer.alloc(16000); const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24); hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(wav, Buffer.concat([hdr, pcm]));
    const md = path.join(dataDir, 'naskah-nikel.md'); fs.writeFileSync(md, '# Naskah\n\nv1: Ekspor nikel Indonesia naik tujuh belas persen.\nv2: Tapi volumenya justru turun tiga koma delapan persen.\n');
    await click('[data-el="agent.chat.tab.brainstorm"]');
    const { root: docRoot } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: docRoot.nodeId, selector: '[data-el="agent.chat.attach.input"]' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [wav] });
    check('audio attachment becomes a Library asset chip', await waitFor(`!!document.querySelector('[data-el="agent.chat.attach.chip"][data-kind="audio"][data-status="ready"]')`, 30000), { chips: await page.evaluate(`[...document.querySelectorAll('[data-el="agent.chat.attach.chip"]')].map((x) => x.outerHTML.slice(0, 160))`) });
    const { root: r2 } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId: n2 } = await page.send('DOM.querySelector', { nodeId: r2.nodeId, selector: '[data-el="agent.chat.attach.input"]' });
    await page.send('DOM.setFileInputFiles', { nodeId: n2, files: [md] });
    check('document attachment chip (text extracted locally)', await waitFor(`!!document.querySelector('[data-el="agent.chat.attach.chip"][data-kind="document"]')`, 15000));
    const n0 = stub.calls.length;
    await discuss('Diskusi (lampiran audio + naskah)', 'Pakai musik dan naskah ini');
    const sent = stub.calls.slice(n0).filter((c) => c.provider === 'anthropic' && c.path === '/v1/messages').map((c) => c.lastUserText ?? '').find((x) => /Attached document/.test(x)) ?? '';
    check('the document text reached Claude, the audio is named', /Attached document "naskah-nikel\.md"/.test(sent) && /tujuh belas persen/.test(sent) && /musik-latar\.wav/.test(sent), { sample: sent.slice(0, 400) });
  });

  // ── Acceptance prompt: "Ekspor Nikel Indonesia 2026" (FR-224) ──
  await step('acceptance-nikel', async () => {
    const prompt = fs.readFileSync(process.env.E2E_NIKEL_PROMPT ?? path.join(root, 'poc/e2e/fixtures/nikel-prompt.md'), 'utf8');
    await discuss('Edit (nikel, jangan tanya balik)', prompt, { mode: 'editor' });
    check('nikel: a plan, not a question', await waitFor(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].some((c) => c.getAttribute('data-status') === 'valid')`, 15000) && !(await count('[data-el="agent.editor.askdiscussion"]')));
    const prev = await page.evaluate(`(() => { const c = [...document.querySelectorAll('[data-el="agent.editor.execute"]')].at(-1)?.closest('[data-el="agent.editor.plancard"]'); return { scenes: c?.querySelectorAll('[data-el="agent.editor.plancard.preview.row"][data-kind="scene"]').length ?? 0, voice: c?.querySelectorAll('[data-el="agent.editor.plancard.preview.row"][data-kind="voice"]').length ?? 0, estimate: !!c?.querySelector('[data-el="agent.editor.plancard.estimate"]'), total: c?.querySelector('[data-el="agent.editor.plancard.preview.total"]')?.innerText ?? '' }; })()`);
    check('nikel: preview shows 6 scenes, 9 voice clips, total, labelled as an estimate', prev.scenes === 6 && prev.voice === 9 && prev.estimate && /total/.test(prev.total), prev);
    const pid = (await api('/projects')).body.items[0].id;
    const v0 = (await api(`/projects/${pid}/composition`)).body.head.id;
    const planId = await page.evaluate(`[...document.querySelectorAll('[data-el="agent.editor.execute"]')].at(-1)?.closest('[data-el="agent.editor.plancard"]')?.getAttribute('data-plan-id') ?? ''`);
    const card = `document.querySelector('[data-el="agent.editor.plancard"][data-plan-id="${planId}"]')`;
    await page.evaluate(`(() => { const b = ${card}?.querySelector('[data-el="agent.editor.execute"]'); b?.scrollIntoView({ block: 'center' }); b?.click(); })()`);
    const phases = [];
    for (let i = 0; i < 300; i++) {
      const v = await page.evaluate(`({ s: ${card}?.getAttribute('data-status'), p: ${card}?.querySelector('[data-el="agent.editor.plancard.executing"]')?.getAttribute('data-phase') ?? null })`);
      if (v.p && phases.at(-1) !== v.p) phases.push(v.p);
      if (v.s === 'failed' || v.s === 'executed') break; await sleep(100);
    }
    await sleep(800);                                                        // nothing may flip the card back afterwards
    const status = await page.evaluate(`${card}?.getAttribute('data-status')`);
    const cardText = await page.evaluate(`${card}?.innerText ?? ''`);
    const apiPlan = (await api(`/plans/${planId}`)).body;
    const v1 = (await api(`/projects/${pid}/composition`)).body.head.id;
    log({ nikelExecute: { planId, phases, status, apiStatus: apiPlan.status, changed: v0 !== v1 } });
    if (status === 'failed') check('nikel: without a voice model Execute stops with the reason and changes nothing (no invented timing)', v0 === v1 && apiPlan.status === 'failed' && /EM-7\d{3}/.test(cardText), { status, phases, card: cardText.slice(0, 200) });
    else check('nikel: executed with the measured voices as one version', status === 'executed' && v0 !== v1, { status, phases });
  });

  const ex = page.consoleLines.filter((l) => l.startsWith('EXCEPTION'));
  const em = await page.evaluate('window.__em');
  check('no tool-call markup visible at any sample', markupSeen === 0, { markupSeen });
  check('no page exceptions', ex.length === 0, { sample: ex.slice(0, 5) });
  check('no console errors', em.errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)).length === 0, { sample: em.errors.slice(0, 5) });
  check('no error boundary hit', !(await count('[data-el="sys.section.error"], [data-el="sys.crash"]')));
  check('no agent run failed in the service log', !/agent run failed/.test(svcLog), { lines: svcLog.split('\n').filter((l) => /agent run failed/.test(l)).slice(0, 3) });
} finally {
  if (page) fs.writeFileSync(path.join(dir, 'claude-console.txt'), [...page.consoleLines, '--- console.error ---', ...((await page.evaluate('window.__em?.errors ?? []').catch(() => [])))].join('\n'));
  fs.writeFileSync(path.join(dir, 'claude-stub-calls.json'), JSON.stringify(stub.calls, null, 1));
  page?.close(); try { chrome?.close(); } catch { /* Chrome still writing */ } web.close(); await stub.close(); svc.kill('SIGTERM');
  await sleep(800);
  fs.writeFileSync(path.join(dir, 'claude-service.log'), svcLog);
  const failed = results.filter((r) => !r.ok);
  log({ summary: `${results.length - failed.length}/${results.length} passed`, failed: failed.map((f) => f.name), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
  process.exitCode = failed.length ? 1 : 0;
}
