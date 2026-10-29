// End-to-end: a FULL automatic video from one prompt (process.md Entry 35). The nikel prompt (poc/e2e/fixtures/nikel-prompt.md)
// goes through the Editor chat → plan (scene.compose, provider stub answering like Claude) → Execute (voices FIRST with the real
// local voice model, measured, composed again with the real durations) → the composition is checked deterministically:
//   qualityCheck (the ADR-034 gate, with the prompt's safe zone) has no warning · no two text boxes visible at the same time overlap
//   · every text / shape / image is animated (entrance motion or a counter) · scene lengths = voice clips + 0.3 s gaps + 0.5 s tail
//   (± 1 frame) · every voice clip lies inside its scene and the texts that the spec ties to a clip start with it (± 40 ms)
//   · total ≤ 60 s — then exported as a short low-resolution MP4 (720p, Standard profile, render concurrency 1) and checked with
//   ffprobe (duration, 720×1280, an audio stream) and frames extracted for a human look.
// Prepare like negative-flow.mjs. A voice model must be installable (Hugging Face) or copied in: E2E_MODELS_FROM=<a data dir whose
// models/ already holds an installed voice model> (copied into this run's data dir before the Service starts).
// Run:  E2E_DIR=<dir> E2E_SERVICE=<service.cjs> bash scripts/run-capped.sh node poc/e2e/nikel-auto.mjs
// Optional: E2E_ENGINE_BUNDLE=<an Engine bundle built from the current sources> (EM_BUNDLE_OUT=<dir> node packages/engine/scripts/build-bundle.mjs);
// else the Service renders with resources/engine/bundle.
// Ports 4110 service / 4120 UI / 4140 stub / 9337 CDP. Exit code 0 only when every check passed.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, openPage } from '../browser/cdp.mjs';
import { startProviderStub } from './provider-stub.mjs';
import { qualityCheck, textGeometry, deriveTiming } from '../../packages/composition-model/dist/index.js';

const root = new URL('../../', import.meta.url).pathname;
const comp = path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu');
// The FFmpeg / FFprobe the app ships (resources/bin-linux-x64, prepare-engines); the compositor's FFmpeg lacks fps / tile (filmstrips).
const binDir = fs.existsSync(path.join(root, 'resources/bin-linux-x64/ffmpeg')) ? path.join(root, 'resources/bin-linux-x64') : comp;
const ffmpeg = path.join(binDir, 'ffmpeg'), ffprobe = path.join(binDir, 'ffprobe');
const dir = process.env.E2E_DIR; if (!dir) throw new Error('E2E_DIR');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
const dataDir = fs.mkdtempSync(path.join(dir, 'nikel-data-'));
const home = path.join(dataDir, 'home'); fs.mkdirSync(path.join(home, 'Videos'), { recursive: true });
const out = path.join(dir, 'nikel-out'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const log = (o) => console.log(JSON.stringify(o));
const results = [];
const check = (name, ok, extra = {}) => { results.push({ name, ok: !!ok, ...extra }); log({ check: name, ok: !!ok, ...extra }); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spec = JSON.parse(fs.readFileSync(path.join(root, 'packages/agents/test/fixtures/nikel-spec.json'), 'utf8'));

if (process.env.E2E_MODELS_FROM) fs.cpSync(path.join(process.env.E2E_MODELS_FROM, 'models'), path.join(dataDir, 'models'), { recursive: true, filter: (f) => !f.includes('music-library') });
const stub = await startProviderStub(4140);
const svc = spawn(process.execPath, [process.env.E2E_SERVICE ?? path.join(root, 'apps/service/dist/service.cjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  HOME: home, EM_DEV: '1', EM_TEST_FREE_MEM_MB: '4096', EM_PORT: '4110', EM_TOKEN: token, EM_DATA_DIR: dataDir, EM_UI_ORIGIN: 'http://127.0.0.1:4120', EM_RESOURCES: path.join(root, 'resources'), EM_ENGINES: path.join(root, fs.existsSync(path.join(root, 'resources/engines-linux-x64')) ? 'resources/engines-linux-x64' : 'resources/engines'),
  EM_DEV_PROVIDER_STUB: stub.origin, EM_VIDEOS_DIR: path.join(home, 'Videos'), ...(process.env.E2E_ENGINE_BUNDLE ? { EM_ENGINE_BUNDLE: process.env.E2E_ENGINE_BUNDLE } : {}), EM_FFMPEG: ffmpeg, EM_FFPROBE: ffprobe, LD_LIBRARY_PATH: comp } });
let svcLog = ''; svc.stdout.on('data', (d) => { svcLog += d; }); svc.stderr.on('data', (d) => { svcLog += d; });
const api = async (p, init = {}) => { const r = await fetch(`http://127.0.0.1:4110/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4110/api/v1/health')).ok) break; } catch { /* starting */ } await sleep(250); }
check('service healthy', (await fetch('http://127.0.0.1:4110/api/v1/health')).ok);
{
  const lic = await api('/license');
  const key = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/license-cli/src/cli.mjs'), 'issue', '--name', 'E2E', '--email', 'e2e@example.com', '--fingerprint', lic.body.machineCode,
    '--key-file', path.join(dir, 'a1.key'), '--audit', path.join(dataDir, 'audit.csv'), '--out-dir', path.join(dataDir, 'lic'), '--dev-allow-network', '--json'],
    { env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: fs.readFileSync(path.join(dir, 'pass'), 'utf8').trim() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).key;
  check('licence activated', (await api('/license/activate', { method: 'POST', body: JSON.stringify({ key }) })).body.status === 'licensed');
  await api('/settings', { method: 'PUT', body: JSON.stringify({ onboardingDone: true }) });
  const c = await api('/providers/connections', { method: 'POST', body: JSON.stringify({ provider: 'anthropic', label: 'Claude', secret: ['sk', 'ant', 'api03', 'stubstubstubstubstubstubstub_0123456789'].join('-') }) });
  const id = c.body.id ?? c.body.connection?.id;
  await api(`/providers/connections/${id}/models/refresh`, { method: 'POST' });
  check('provider connected + assigned', (await api('/providers/assignments', { method: 'PUT', body: JSON.stringify({ brainstorm: { agent: 'brainstorm', connectionId: id, modelId: 'claude-sonnet-5-5' }, editor: { agent: 'editor', connectionId: id, modelId: 'claude-sonnet-5-5' }, defaultConnectionId: id }) })).status === 200);
}
const installedTts = async () => ((await api('/models')).body.items ?? []).filter((m) => m.task === 'tts' && m.status === 'installed');
const installVoice = async (key = 'supertonic-3-int8') => {
  if ((await installedTts()).length) return true;
  log({ installing: key });
  await api(`/models/${key}/install`, { method: 'POST' });
  for (let i = 0; i < 900; i++) { if ((await installedTts()).length) return true; const f = ((await api('/models')).body.items ?? []).find((m) => m.key === key); if (f?.status === 'failed') return false; await sleep(1000); }
  return false;
};
const ui = path.join(dir, 'ui');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const web = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url ?? '/').split('?')[0]); const f = path.join(ui, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ui) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4120, '127.0.0.1', r));

let chrome; let page;
const q = (sel) => JSON.stringify(sel);
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await page.evaluate(expr).catch(() => false)) return true; await sleep(200); } return false; };
const click = async (sel) => page.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
const snap = async (label) => { try { fs.writeFileSync(path.join(out, `${label}.png`), await page.screenshot({ x: 0, y: 0, width: 1600, height: 900 })); } catch { /* best effort */ } };
const head = async (pid) => (await api(`/projects/${pid}/composition?model=true`)).body.head;
try {
  chrome = await launch(9337);
  page = await openPage(chrome.port, 'about:blank', { width: 1600, height: 900 });
  await page.send('Page.navigate', { url: 'http://127.0.0.1:4120/' });
  await sleep(600);
  await page.evaluate(`(() => { const k = 'expertmotion.prefs.v1'; const v = JSON.parse(localStorage.getItem(k) ?? '{}'); localStorage.setItem(k, JSON.stringify({ ...v, onboardingDone: true, tourDone: true })); })()`);
  await page.send('Page.reload', {});
  check('editor with an empty project', await waitFor(`!!document.querySelector('[data-el="agent.chat.tab.editor"]') && /Untitled|Tanpa judul/.test(document.querySelector('[data-el="hdr.title"]')?.innerText ?? '')`, 30000));
  const pid = await page.evaluate(`JSON.parse(localStorage.getItem('expertmotion.scratch.v1') ?? 'null')?.projectId ?? null`);
  check('project id', !!pid, { pid });

  // ── the prompt through the Editor chat ──
  const prompt = fs.readFileSync(path.join(root, 'poc/e2e/fixtures/nikel-prompt.md'), 'utf8');
  await click('[data-el="agent.chat.tab.editor"]');
  await page.evaluate(`(() => { const el = document.querySelector('[data-el="agent.chat.composer"]'); el.focus(); })()`);
  await page.send('Input.insertText', { text: prompt });
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  check('a valid plan (not a question)', await waitFor(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].some((c) => c.getAttribute('data-status') === 'valid')`, 60000));
  await snap('1-plan');
  const v0 = (await head(pid)).id;
  const executeLast = async () => {
    const planId = await page.evaluate(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1)?.getAttribute('data-plan-id')`);
    await page.evaluate(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1)?.querySelector('[data-el="agent.editor.execute"]')?.click()`);
    const phases = []; let status = null; const t0 = Date.now();
    for (let i = 0; i < 3000; i++) {
      const v = await page.evaluate(`(() => { const c = document.querySelector('[data-el="agent.editor.plancard"][data-plan-id="${planId}"]'); return { s: c?.getAttribute('data-status'), p: c?.querySelector('[data-el="agent.editor.plancard.executing"]')?.getAttribute('data-phase') ?? null }; })()`);
      if (v.p && phases.at(-1) !== v.p) phases.push(v.p);
      status = v.s; if (status === 'failed' || status === 'executed') break; await sleep(200);
    }
    const card = await page.evaluate(`document.querySelector('[data-el="agent.editor.plancard"][data-plan-id="${planId}"]')?.innerText ?? ''`);
    log({ execute: { planId, status, phases, s: Math.round((Date.now() - t0) / 1000), card: card.slice(0, 600) } });
    return { planId, status, phases, card };
  };
  let { status, phases, card } = await executeLast();
  if (!(await installedTts()).length || status === 'failed') {
    // no voice model yet: Execute must stop with the reason and an install action, change nothing, then work after the install
    const toasts = await page.evaluate(`[...document.querySelectorAll('[data-el="sys.toast"]')].map((t) => t.innerText.replace(/\\s+/g, ' '))`);
    check('no voice model: Execute stops with EM-7001 and nothing changed', status === 'failed' && /EM-7001/.test(card + toasts.join(' ')) && (await head(pid)).id === v0, { status, card: card.slice(0, 300), toasts });
    const offer = await page.evaluate(`[...document.querySelectorAll('button')].filter((b) => /Pasang|Install|Model/i.test(b.innerText) && b.closest('[data-el="sys.toast"], [data-el^="agent.editor.plancard"]')).map((b) => b.innerText)`);
    check('…with an install action next to it', offer.length > 0, { offer });
    await snap('1b-needs-voice');
    check('voice model installed (real download)', await installVoice());
    await page.evaluate(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1)?.querySelector('[data-el="agent.editor.plancard.replan"]')?.click()`);
    check('Re-plan after the install gives a valid plan', await waitFor(`[...document.querySelectorAll('[data-el="agent.editor.plancard"]')].at(-1)?.getAttribute('data-status') === 'valid'`, 60000));
    ({ status, phases, card } = await executeLast());
  }
  check('Execute: voices first, then one composition version', status === 'executed' && phases.includes('voice') && (await head(pid)).id !== v0, { status, phases });
  await sleep(2000); await snap('2-executed');
  const h = await head(pid); const m = h.model;
  fs.writeFileSync(path.join(out, 'model.json'), JSON.stringify(m, null, 1));

  // ── deterministic checks of what a viewer will see ──
  const timing = deriveTiming(m);
  const fps = m.settings.fps; const frame = 1000 / fps;
  check('9:16 at 30 fps', m.settings.ratio === '9:16' && fps === 30, { ratio: m.settings.ratio, fps });
  check('6 scenes', m.tracks.video.length === 6, { n: m.tracks.video.length });
  const voices = m.tracks.audio.filter((a) => a.role === 'voice').sort((a, b) => a.atMs - b.atMs);
  check('9 voice clips', voices.length === 9, { n: voices.length });
  check('total ≤ 60 s', timing.durationMs <= 60000, { ms: timing.durationMs });
  const issues = qualityCheck(m, { safeArea: spec.style.safeArea });
  fs.writeFileSync(path.join(out, 'quality.json'), JSON.stringify(issues, null, 1));
  check('qualityCheck: no warning', !issues.some((x) => x.severity === 'warn'), { warn: issues.filter((x) => x.severity === 'warn').map((x) => `${x.code}:${x.ids.join('+')}@${x.atMs}`).slice(0, 10), info: issues.filter((x) => x.severity === 'info').length });
  // overlapping text boxes among texts visible at the same time
  const boxes = m.tracks.text.map((t) => ({ id: t.id, text: t.text, from: t.timing.atMs, to: t.timing.atMs + t.timing.durationMs, b: textGeometry(t, m.settings.ratio, m.theme.textDefaults, m.settings.customRatio).box }));
  const overl = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.to <= b.from || b.to <= a.from) continue;
    const ix = Math.min(a.b.x1, b.b.x1) - Math.max(a.b.x0, b.b.x0), iy = Math.min(a.b.y1, b.b.y1) - Math.max(a.b.y0, b.b.y0);
    // a transition crossfade shows the old scene's texts fading out while the new ones fade in: only overlaps longer than the crossfade count
    const both = Math.min(a.to, b.to) - Math.max(a.from, b.from);
    if (ix > 1 && iy > 1 && both > 15 * frame) overl.push({ a: a.text.slice(0, 30), b: b.text.slice(0, 30), ms: both });
  }
  check('no two text boxes visible at the same time overlap', overl.length === 0, { overl: overl.slice(0, 6), texts: boxes.length });
  const still = [...m.tracks.text, ...m.tracks.overlay].filter((x) => !x.motion && !(x.effect?.presetId === 'preset:texteffect.counter'));
  check('every text / shape / image is animated', still.length === 0, { still: still.map((x) => x.text ?? x.kind ?? x.id).slice(0, 8), total: m.tracks.text.length + m.tracks.overlay.length });
  // voice-first durations: scene = its clips + 0.3 s between + 0.5 s after (± 1 frame per clip for frame rounding)
  const sceneRows = spec.scenes.map((s, i) => {
    const clipIds = s.clips; const start = timing.clipStartMs[i]; const dur = m.tracks.video[i]?.durationMs ?? 0;
    const next = timing.clipStartMs[i + 1] ?? Infinity;      // a crossfade overlaps the next scene: a voice belongs to the scene it starts in
    const vs = voices.filter((v) => v.atMs >= start - frame && v.atMs < next - frame);
    // 0.5 s after the scene's last clip "before the next scene"; the LAST scene holds 1 s after the last word (composer: the CTA stays readable)
    const want = vs.reduce((acc, v) => acc + v.durationMs, 0) + 300 * Math.max(0, vs.length - 1) + (i === spec.scenes.length - 1 ? 1000 : 500);
    return { i, clips: clipIds.length, voices: vs.length, dur, want, inside: vs.every((v) => v.atMs >= start - frame && v.atMs + v.durationMs <= start + dur + frame) };
  });
  log({ scenes: sceneRows });
  check('each scene holds its voice clips', sceneRows.every((r) => r.voices === r.clips && r.inside), { rows: sceneRows.map((r) => `${r.i}:${r.voices}/${r.clips}${r.inside ? '' : '!'}`) });
  // the crossfade overlaps the next scene by the transition length, so a scene is its voice plus gaps plus tail plus the overlap
  const tr = (i) => (m.transitions ?? []).find((t) => t.cutIndex === i)?.durationMs ?? 0;   // cut i = between scene i and i+1
  check('scene length = voice clips + 0.3 s gaps + 0.5 s tail (last scene 1 s) (± 2 frames, + its transition)', sceneRows.every((r) => Math.abs(r.dur - r.want - tr(r.i)) <= 2 * frame + 1 || Math.abs(r.dur - r.want) <= 2 * frame + 1), { rows: sceneRows.map((r) => `${r.i}:${r.dur}~${r.want}+${tr(r.i)}`) });
  // texts tied to a clip start with it
  const starts = voices.map((v) => v.atMs);
  const tied = m.tracks.text.filter((t) => starts.some((s) => Math.abs(t.timing.atMs + (t.motion?.delayMs ?? 0) - s) <= 40));
  const sceneFirst = new Set(timing.clipStartMs.map((x) => Math.round(x)));
  const offBeat = m.tracks.text.filter((t) => !sceneFirst.has(Math.round(t.timing.atMs)) && !starts.some((s) => Math.abs(t.timing.atMs + (t.motion?.delayMs ?? 0) - s) <= 40) && !starts.some((s, k) => t.timing.atMs > s && t.timing.atMs < s + voices[k].durationMs));
  check('texts appear with their voice clip (± 40 ms) or on the scene start / inside a clip', offBeat.length === 0, { tied: tied.length, offBeat: offBeat.map((t) => `${t.text.slice(0, 24)}@${t.timing.atMs}`).slice(0, 6) });
  // voice WAVs are real speech: measure each voice asset's own duration against the layer
  const assets = (await api(`/projects/${pid}/assets`)).body.items ?? [];
  const vDur = voices.map((v) => ({ layer: v.durationMs + (v.trimBeforeMs ?? 0), asset: assets.find((a) => a.id === v.assetId)?.durationMs ?? null }));
  check('voice layers use the measured clip length (± 40 ms)', vDur.every((x) => x.asset !== null && Math.abs(x.layer - x.asset) <= 40), { vDur });

  // ── export a short low-resolution MP4 ──
  const tr0 = Date.now();
  const j = await api('/renders', { method: 'POST', body: JSON.stringify({ projectId: pid, performanceProfile: 'standard', outputProfile: { ratio: '9:16', resolution: '720p', fps: 30, format: 'mp4', codec: 'h264' } }) });
  check('render accepted', j.status < 300, { status: j.status, code: j.body?.error?.code });
  let st = {}; for (let i = 0; i < 1800; i++) { st = (await api(`/renders/${j.body.id ?? j.body.job?.id}`)).body; if (['done', 'failed', 'cancelled'].includes(st.status)) break; await sleep(1000); }
  log({ render: { status: st.status, s: Math.round((Date.now() - tr0) / 1000), code: st.errorCode } });
  check('render done', st.status === 'done', { status: st.status, code: st.errorCode });
  const file = st.outputId ? (await api(`/outputs/${st.outputId}`)).body?.path : null;
  if (file) {
    fs.copyFileSync(file, path.join(out, 'nikel.mp4'));
    const pr = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file], { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: comp } }));
    log({ ffprobe: pr });
    const v = pr.streams.find((s) => s.codec_type === 'video');
    check('ffprobe: h264 720×1280 30 fps', v?.codec_name === 'h264' && v.width === 720 && v.height === 1280 && v.r_frame_rate === '30/1', { v });
    check('ffprobe: an audio stream (the voice)', pr.streams.some((s) => s.codec_type === 'audio'));
    check('ffprobe: duration = composition (± 0.1 s)', Math.abs(Number(pr.format.duration) * 1000 - timing.durationMs) <= 100, { file: Number(pr.format.duration), model: timing.durationMs });
    const shots = [0.6, 3.5, 9, 15, 22, 30, 38, timing.durationMs / 1000 - 0.8];
    for (const s of shots) execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', s.toFixed(2), '-i', file, '-frames:v', '1', path.join(out, `frame-${String(s.toFixed(1)).padStart(5, '0')}.png`)], { env: { ...process.env, LD_LIBRARY_PATH: comp } });
    // loudness of the voice track: not silent
    // volumedetect reports on stderr (and fails when the file has no audio stream at all)
    const { spawnSync } = await import('node:child_process');
    const vol = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: comp } }).stderr ?? '';
    const mean = /mean_volume: (-?[\d.]+) dB/.exec(vol)?.[1];
    log({ meanVolumeDb: mean });
    check('audio is not silent (mean volume > −50 dB)', mean !== undefined && Number(mean) > -50, { mean });
  }
  check('no page exceptions', !page.consoleLines.some((l) => l.startsWith('EXCEPTION')), { sample: page.consoleLines.filter((l) => l.startsWith('EXCEPTION')).slice(0, 3) });
} finally {
  if (page) fs.writeFileSync(path.join(out, 'console.txt'), page.consoleLines.join('\n'));
  page?.close(); try { chrome?.close(); } catch { /* writing */ } web.close(); await stub.close(); svc.kill('SIGTERM');
  await sleep(800);
  fs.writeFileSync(path.join(out, 'service.log'), svcLog);
  const failed = results.filter((r) => !r.ok);
  log({ summary: `${results.length - failed.length}/${results.length} passed`, failed: failed.map((f) => f.name), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
  process.exitCode = failed.length ? 1 : 0;
}
