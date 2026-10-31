// ADR-041 end-to-end: a "viral explainer" Reel from internet assets, like the five reference videos the Operator put in
// /home/andre/expertmotion-expectation (Sample 1: narration + pictures with red boxes / arrows / an X, boxed yellow headline,
// watermark, captions). Drives the REAL Service bundle with the provider stub playing the models:
//   licence → provider → project → pictures into the Library (local files standing in for pictures the Creator confirmed from
//   web.images, plus ONE real web.screenshot through the Brainstorming Agent's tool call) → Diskusi answer "PRD siap." →
//   send-to-editor → Editor plan = scene.compose(viral spec) (+ tts.generate narration with the local voice model) → Execute →
//   720p render (E2E_FINAL=1: 1080p too) → deterministic checks on the model and the file.
// Run: E2E_DIR=out/e2e E2E_MODELS_FROM=<dir with models/> bash scripts/run-capped.sh node poc/e2e/viral.mjs
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { startProviderStub } from './provider-stub.mjs';

const root = new URL('../../', import.meta.url).pathname;
const binDir = fs.existsSync(path.join(root, 'resources/bin-linux-x64/ffmpeg')) ? path.join(root, 'resources/bin-linux-x64') : path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu');
const ffmpeg = path.join(binDir, 'ffmpeg'), ffprobe = path.join(binDir, 'ffprobe');
const dir = process.env.E2E_DIR; if (!dir) throw new Error('E2E_DIR');
const INPUTS = process.env.E2E_VIRAL_INPUTS; if (!INPUTS) throw new Error('E2E_VIRAL_INPUTS (folder with news.jpg photo.jpg face.jpg ig.png poster.png)');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
const dataDir = fs.mkdtempSync(path.join(dir, 'viral-data-'));
const home = path.join(dataDir, 'home'); fs.mkdirSync(path.join(home, 'Videos'), { recursive: true });
const out = path.join(dir, 'viral-out'); fs.mkdirSync(out, { recursive: true });
const log = (o) => console.log(JSON.stringify(o));
const results = [];
const check = (id, name, ok, extra = {}) => { results.push({ id, name, ok: !!ok, ...extra }); log({ check: `${id} ${name}`, ok: !!ok, ...extra }); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.E2E_MODELS_FROM) fs.cpSync(path.join(process.env.E2E_MODELS_FROM, 'models'), path.join(dataDir, 'models'), { recursive: true, filter: (f) => !f.includes('music-library') });
const stub = await startProviderStub(4141);
const svc = spawn(process.execPath, [process.env.E2E_SERVICE ?? path.join(dir, 'service.cjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  HOME: home, EM_DEV: '1', EM_TEST_FREE_MEM_MB: '4096', EM_PORT: '4111', EM_TOKEN: token, EM_DATA_DIR: dataDir, EM_UI_ORIGIN: 'http://127.0.0.1:4121', EM_RESOURCES: path.join(root, 'resources'),
  EM_ENGINES: path.join(root, fs.existsSync(path.join(root, 'resources/engines-linux-x64')) ? 'resources/engines-linux-x64' : 'resources/engines'),
  EM_DEV_PROVIDER_STUB: stub.origin, EM_VIDEOS_DIR: path.join(home, 'Videos'), EM_DEBUG_AGENT_DUMP: path.join(out, 'agent-dump'), EM_FFMPEG: ffmpeg, EM_FFPROBE: ffprobe } });
let svcLog = ''; svc.stdout.on('data', (d) => { svcLog += d; }); svc.stderr.on('data', (d) => { svcLog += d; });
const api = async (p, init = {}) => { const r = await fetch(`http://127.0.0.1:4111/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4111/api/v1/health')).ok) break; } catch { /* starting */ } await sleep(250); }
check('S0', 'service healthy', (await fetch('http://127.0.0.1:4111/api/v1/health')).ok);
const t0 = Date.now(); const elapsed = () => Math.round((Date.now() - t0) / 1000);

try {
  const lic = await api('/license');
  const key = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/license-cli/src/cli.mjs'), 'issue', '--name', 'E2E', '--email', 'e2e@example.com', '--fingerprint', lic.body.machineCode,
    '--key-file', path.join(dir, 'a1.key'), '--audit', path.join(dataDir, 'audit.csv'), '--out-dir', path.join(dataDir, 'lic'), '--dev-allow-network', '--json'],
    { env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: fs.readFileSync(path.join(dir, 'pass'), 'utf8').trim() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).key;
  check('S1', 'licence activated', (await api('/license/activate', { method: 'POST', body: JSON.stringify({ key }) })).body.status === 'licensed');
  await api('/settings', { method: 'PUT', body: JSON.stringify({ onboardingDone: true, webResearch: true }) });
  const c = await api('/providers/connections', { method: 'POST', body: JSON.stringify({ provider: 'anthropic', label: 'Claude', secret: ['sk', 'ant', 'api03', 'stubstubstubstubstubstubstub_0123456789'].join('-') }) });
  const cid = c.body.id ?? c.body.connection?.id;
  await api(`/providers/connections/${cid}/models/refresh`, { method: 'POST' });
  check('S2', 'provider connected + assigned', (await api('/providers/assignments', { method: 'PUT', body: JSON.stringify({ brainstorm: { agent: 'brainstorm', connectionId: cid, modelId: 'claude-sonnet-5-5' }, editor: { agent: 'editor', connectionId: cid, modelId: 'claude-sonnet-5-5' }, defaultConnectionId: cid }) })).status < 300);

  // voice model (narration): installed copy or a real download
  const installedTts = async () => ((await api('/models')).body.items ?? []).filter((m) => m.task === 'tts' && m.status === 'installed');
  if (!(await installedTts()).length) {
    log({ installing: 'supertonic-3-int8' }); await api('/models/supertonic-3-int8/install', { method: 'POST' });
    for (let i = 0; i < 900 && !(await installedTts()).length; i++) { const f = ((await api('/models')).body.items ?? []).find((m) => m.key === 'supertonic-3-int8'); if (f?.status === 'failed') break; await sleep(1000); }
  }
  check('S2b', 'a local voice model is installed (free, offline)', (await installedTts()).length > 0, { models: (await installedTts()).map((m) => m.key) });

  // project + pictures (the Library: what the Creator confirmed from web.images / uploaded)
  const pj = await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'Berita viral' }) });
  const pid = pj.body.id ?? pj.body.project?.id; check('S3', 'project created', !!pid, { pid });
  const upload = async (file, name) => {
    const r = await fetch(`http://127.0.0.1:4111/api/v1/projects/${pid}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Expertmotion-Filename': encodeURIComponent(name), 'Content-Length': String(fs.statSync(file).size) }, body: fs.createReadStream(file), duplex: 'half' });
    const j = await r.json(); return j.items?.[0]?.id;
  };
  const ids = { news: await upload(path.join(INPUTS, 'news.jpg'), 'berita.jpg'), photo: await upload(path.join(INPUTS, 'photo.jpg'), 'foto.jpg'), face: await upload(path.join(INPUTS, 'face.jpg'), 'komentar.jpg'), logo: await upload(path.join(INPUTS, 'ig.png'), 'logo.png'), poster: await upload(path.join(INPUTS, 'poster.png'), 'poster.png') };
  let assets = [];
  for (let i = 0; i < 120; i++) { assets = (await api(`/projects/${pid}/assets`)).body.items ?? []; if (Object.values(ids).every((id) => assets.find((a) => a.id === id)?.status === 'ready')) break; await sleep(1000); }
  check('C1', 'five pictures imported and ready', Object.values(ids).every((id) => assets.find((a) => a.id === id)?.status === 'ready'), { statuses: Object.values(ids).map((id) => assets.find((a) => a.id === id)?.status) });

  // Diskusi: the Creator names a page; the model screenshots it (REAL Chrome) and finds its pictures, then says the plan is ready
  const pageUrl = process.env.E2E_PAGE_URL ?? 'https://id.wikipedia.org/wiki/Jakarta';
  await fetch(`${stub.origin}/__stub/script`, { method: 'POST', body: JSON.stringify({ provider: 'anthropic', replies: [
    { text: 'Saya potret halamannya dulu.', toolUse: { name: 'web_screenshot', input: { url: pageUrl, viewport: 'phone' } } },
    { text: 'Lalu saya ambil gambar-gambar di halaman itu.', toolUse: { name: 'web_images', input: { query: 'jakarta', source: 'page', url: pageUrl } } },
    { json: { reply: 'Tangkapan layar dan gambar dari halaman sudah ada. Naskah 7 kalimat siap, durasi di bawah 60 detik.\n\nPRD siap.', suggestedNextStep: 'none' } },   // 'none': the driver approves explicitly (an automatic hand-off would race the scripted plan)
  ] }) });
  const baseVersion = async () => (await api(`/projects/${pid}/composition`)).body.head?.hash ?? (await api(`/projects/${pid}/composition`)).body.head?.id;
  const brief = `Buat video berita viral 9:16 di bawah 60 detik tentang boikot sebuah acara. Pakai gambar dari internet, potret halaman ini: ${pageUrl} dan ambil fotonya. Judul kuning berkotak, panah merah, narasi suara, caption, watermark logo.`;
  const msg = await api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', body: JSON.stringify({ text: brief, baseVersion: await baseVersion() }) });
  check('S7', 'brief sent to Diskusi', msg.status < 300, { status: msg.status, code: msg.body?.error?.code });
  let thread = [];
  const threadItems = async () => { const b = (await api(`/projects/${pid}/conversations/brainstorm`)).body; return b.messages?.items ?? b.items ?? []; };
  for (let i = 0; i < 240; i++) { thread = await threadItems(); if (thread.some((m) => m.role === 'assistant' && /PRD siap/.test(JSON.stringify(m)))) break; await sleep(1000); }
  const prdMsg = thread.find((m) => m.role === 'assistant' && /PRD siap/.test(JSON.stringify(m)));
  check('C10', 'Diskusi answered with the plan ("PRD siap")', !!prdMsg, { msgs: thread.length, err: svcLog.match(/EM-44\d\d[^\n]{0,80}/g)?.slice(-3) });
  const stubLog = (await (await fetch(`${stub.origin}/__stub/log`)).json()).calls;
  const toolText = stubLog.map((x) => x.toolResultText ?? '').join('\n');
  assets = (await api(`/projects/${pid}/assets`)).body.items ?? [];
  const shot = assets.find((a) => /Tangkapan layar/i.test(a.name ?? ''));
  check('I1', 'web.screenshot: a REAL phone screenshot of the page became a Library asset with credit = URL', !!shot && (shot.credit ?? '').includes(new URL(pageUrl).host), { shot: shot && { id: shot.id, name: shot.name, w: shot.width, h: shot.height, credit: shot.credit, licence: shot.licence }, tool: toolText.match(/assetId[^,}]{0,60}/)?.[0] });
  const candidates = thread.flatMap((m) => JSON.stringify(m).match(/"source":"page"/g) ?? []).length;
  check('I2', 'web.images source=page: picture candidates of the page were offered to the Creator', candidates > 0 || /pageUrl|candidates/.test(toolText), { candidates, sample: toolText.slice(0, 200) });
  // import one page picture through R-089 (what the Creator's click does)
  let pageAsset = null;
  fs.writeFileSync(path.join(out, 'thread.json'), JSON.stringify(thread, null, 1));
  // the candidate block as the UI card reads it: any block whose items carry an id and a source / provider (prefer page pictures)
  let candMsg = null, candId = null, candSource = 'page';
  for (const m of thread) {
    const walk = (v) => { if (candId) return; if (Array.isArray(v)) { for (const x of v) walk(x); return; } if (!v || typeof v !== 'object') return;
      if (Array.isArray(v.items) && v.items.some((it) => it && typeof it === 'object' && it.id && (it.source || it.provider))) {
        const it = v.items.find((x) => (x.source ?? x.provider) === 'page') ?? v.items[0]; candMsg = m; candId = String(it.id); candSource = String(it.source ?? it.provider); return; }
      for (const k of Object.keys(v)) walk(v[k]); };
    walk(m);
  }
  if (candMsg && candId) {
    const imp = await api(`/projects/${pid}/research/images/import`, { method: 'POST', body: JSON.stringify({ messageId: candMsg.id, source: candSource, id: candId }) });
    for (let i = 0; i < 60 && imp.status < 300; i++) { assets = (await api(`/projects/${pid}/assets`)).body.items ?? []; pageAsset = assets.find((a) => a.credit && a.credit.includes(new URL(pageUrl).host) && !/Tangkapan layar/.test(a.name ?? '') && a.status === 'ready'); if (pageAsset) break; await sleep(1000); }
    check('I3', 'R-089 import of a page picture → ready asset with credit + licence label', !!pageAsset, { status: imp.status, code: imp.body?.error?.code, asset: pageAsset && { name: pageAsset.name, credit: pageAsset.credit, licence: pageAsset.licence } });
  } else check('I3', 'R-089 import of a page picture', false, { reason: 'no page candidate in the thread' });

  // Editor: the viral spec with the Library's pictures (fixture → real asset ids)
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'packages/agents/test/fixtures/viral-spec.json'), 'utf8'));
  const map = { 'IMG-poster': shot?.id ?? ids.poster, 'IMG-post': pageAsset?.id ?? ids.news, 'IMG-news': ids.news, 'IMG-photo': ids.photo, 'IMG-comment': ids.face, LOGO: ids.logo };
  const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'assetId' && map[x] ? map[x] : walk(x)])) : v);
  const spec2 = walk(spec);
  fs.writeFileSync(path.join(out, 'spec.json'), JSON.stringify(spec2, null, 1));
  const planJson = { goal: 'Video berita viral 9:16: hook berkotak, 4 adegan gambar beranotasi, statistik, ajakan follow, watermark, narasi.', steps: [{ n: 1, tool: 'scene.compose', ops: [], args: spec2, expectedDiff: `${spec2.scenes.length} adegan`, dependsOn: [] }], risks: [], notes: 'Gambar dari internet dengan sumber; tangkapan layar halaman sebagai adegan 2.' };
  await fetch(`${stub.origin}/__stub/script`, { method: 'POST', body: JSON.stringify({ provider: 'anthropic', replies: [{ json: planJson, fillBaseVersion: true }, { json: planJson, fillBaseVersion: true }, { json: planJson, fillBaseVersion: true }] }) });
  const send = await api(`/projects/${pid}/conversations/brainstorm/messages/${prdMsg.id}/send-to-editor`, { method: 'POST', body: JSON.stringify({ baseVersion: await baseVersion() }) });
  check('S8', 'sent to the Editor', send.status < 300, { status: send.status, code: send.body?.error?.code });
  let plan = null;
  for (let i = 0; i < 240; i++) { const list = (await api(`/projects/${pid}/plans`)).body.items ?? []; plan = list.find((p) => ['valid', 'invalid', 'stale'].includes(p.status)) ?? null; if (plan) break; await sleep(1000); }
  if (plan) plan = (await api(`/plans/${plan.id}`)).body;
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan, null, 1));
  check('S9', 'Editor plan valid (scene.compose + narration voices)', plan?.status === 'valid', { status: plan?.status, validation: plan?.validation?.slice(0, 5), risks: plan?.risks?.slice(0, 6), steps: plan?.steps?.map((s) => s.tool) });

  const ex = await api(`/plans/${plan.id}/execute`, { method: 'POST', headers: { 'Idempotency-Key': `viral-${Date.now()}` }, body: JSON.stringify({ confirmDestructive: true }) });
  check('S10', 'Execute accepted', ex.status < 300, { status: ex.status, code: ex.body?.error?.code, msg: ex.body?.error?.message });
  let plan2 = plan;
  for (let i = 0; i < 900; i++) { plan2 = (await api(`/plans/${plan.id}`)).body; if (['executed', 'failed', 'cancelled'].includes(plan2.status)) break; await sleep(1000); }
  check('S11', 'Execute done (voices first, then the composition)', plan2.status === 'executed', { status: plan2.status, s: elapsed(), err: plan2.error ?? plan2.steps?.filter((s) => s.status === 'failed').map((s) => s.error) });
  let gjobs = [];
  for (let i = 0; i < 300; i++) { gjobs = (await api(`/projects/${pid}/generator-jobs`)).body.items ?? []; if (!gjobs.some((g) => ['queued', 'running'].includes(g.status))) break; await sleep(1000); }
  const head = (await api(`/projects/${pid}/composition?model=true`)).body.head; const m = head.model;
  fs.writeFileSync(path.join(out, 'model.json'), JSON.stringify(m, null, 1));
  const total = m.tracks.video.reduce((s, c) => s + (c.durationMs ?? c.timing?.durationMs ?? 0), 0) - (m.transitions ?? []).reduce((s, t) => s + (t.durationMs ?? 0), 0);
  const overlays = m.tracks.overlay; const imgs = overlays.filter((o) => o.kind === 'image'); const shapes = overlays.filter((o) => o.kind === 'shape');
  const byPreset = (re) => shapes.filter((s) => re.test(s.presetId));
  check('V1', 'ratio 9:16, under 60 s', m.settings.ratio === '9:16' && total > 20_000 && total <= 60_000, { ratio: m.settings.ratio, totalMs: total });
  check('V2', 'picture scenes use the blurred-image / paper backgrounds', m.tracks.video.some((c) => /blurred-image/.test(JSON.stringify(c.scene ?? c))) && JSON.stringify(m).includes('background.paper'), { bgs: [...new Set(m.tracks.video.map((c) => c.scene?.background?.presetId ?? c.scene?.presetId).filter(Boolean))] });
  check('V3', 'pictures placed as rounded, shadowed overlays (≥ 6 incl. the watermark)', imgs.length >= 6 && imgs.filter((o) => o.radius).length >= 4 && imgs.some((o) => o.shadow), { images: imgs.length, rounded: imgs.filter((o) => o.radius).length, shadow: imgs.filter((o) => o.shadow).length });
  check('V4', 'annotations: a red box, an X, an arrow and a ring', byPreset(/highlight-box/).length >= 1 && byPreset(/x-mark/).length >= 1 && byPreset(/shape\.arrow/).length >= 1 && byPreset(/shape\.ring/).length >= 1 && shapes.some((s) => /E53935/i.test(s.stroke ?? s.fill ?? '')), { kinds: [...new Set(shapes.map((s) => s.presetId))] });
  const wm = imgs.find((o) => o.assetId === ids.logo);
  const voiceEnd = m.tracks.audio.filter((a) => a.role === 'voice').reduce((e, a) => Math.max(e, a.atMs + a.durationMs), 0);
  check('V5', 'watermark spans the narrated part of the video (from 0 to at least the last spoken word)', !!wm && wm.timing.atMs <= 100 && wm.timing.atMs + wm.timing.durationMs >= voiceEnd - 100, { wm: wm && wm.timing, voiceEnd, total });
  const boxed = m.tracks.text.filter((t) => /texteffect\.boxed/.test(t.effect?.presetId ?? ''));
  check('V6', 'headline words on yellow boxes (texteffect.boxed), Poppins + Inter', boxed.length >= 1 && /poppins/.test(m.theme?.fontPairId ?? ''), { boxed: boxed.length, theme: m.theme?.paletteId, fonts: m.theme?.fontPairId });
  const voices = m.tracks.audio.filter((a) => a.role === 'voice');
  const capTrack = m.tracks.caption ?? m.captions ?? {};
  check('V7', 'narration: one voice clip per spoken line (7), captions on', voices.length === 7 && (capTrack.pages?.length ?? 0) > 0, { voices: voices.length, pages: capTrack.pages?.length, style: capTrack.styleId });
  check('V8', 'source tags on every picture scene', byPreset(/source-tag/).length >= 4, { sources: byPreset(/source-tag/).length });
  const credits = fs.existsSync(path.join(home, 'Videos')) ? execFileSync('bash', ['-lc', `ls ${path.join(home, 'Videos')}/**/*CREDITS* ${path.join(home, 'Videos')}/*CREDITS* 2>/dev/null | head -1`], { encoding: 'utf8' }).trim() : '';

  const render = async (resolution) => {
    const tr = Date.now();
    const j = await api('/renders', { method: 'POST', body: JSON.stringify({ projectId: pid, performanceProfile: 'standard', outputProfile: { ratio: '9:16', resolution, fps: 30, format: 'mp4', codec: 'h264' } }) });
    if (j.status >= 300) return { ok: false, status: j.status, code: j.body?.error?.code };
    let s = {}; for (let i = 0; i < 5400; i++) { s = (await api(`/renders/${j.body.id ?? j.body.job?.id}`)).body; if (['done', 'failed', 'cancelled'].includes(s.status)) break; await sleep(1000); }
    const file = s.outputId ? (await api(`/outputs/${s.outputId}`)).body?.path : null;
    log({ render: { resolution, status: s.status, s: Math.round((Date.now() - tr) / 1000), code: s.errorCode, file } });
    return { ok: s.status === 'done', file, s: Math.round((Date.now() - tr) / 1000), code: s.errorCode };
  };
  const pre = await render('720p');
  check('S12', 'preview render 720p done', pre.ok, { s: pre.s, code: pre.code });
  let finalFile = null;
  if (process.env.E2E_FINAL === '1') { const fin = await render('1080p'); check('S13', 'final render 1080p done', fin.ok, { s: fin.s, code: fin.code }); finalFile = fin.file; }
  const file = finalFile ?? pre.file;
  if (file) {
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' }));
    const v = probe.streams.find((s) => s.codec_type === 'video');
    check('F1', 'file: h264 9:16 with audio, duration = composition ± 0.2 s', v?.codec_name === 'h264' && v.height / v.width > 1.7 && probe.streams.some((s) => s.codec_type === 'audio') && Math.abs(Number(probe.format.duration) * 1000 - total) < 200, { w: v?.width, h: v?.height, dur: probe.format.duration });
    for (const t of [1.5, 7, 15, 24, 33, 42, 50]) { try { execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=540:960', path.join(out, `f_${t}.png`)]); } catch { /* past the end */ } }
    fs.copyFileSync(file, path.join(out, path.basename(file)));
    const dirOut = path.dirname(file); const cr = fs.readdirSync(dirOut).find((f) => /CREDITS/i.test(f));
    check('F2', 'CREDITS.txt lists the pictures with their credit', !!cr && /Tangkapan layar|wikipedia|KOMPAS|Sumber|credit|Pictures/i.test(fs.readFileSync(path.join(dirOut, cr), 'utf8')), { credits: cr, sample: cr ? fs.readFileSync(path.join(dirOut, cr), 'utf8').slice(0, 300) : credits });
  }
} catch (e) { check('X', `driver error: ${e?.stack ?? e}`, false); }
finally {
  const pass = results.filter((r) => r.ok).length;
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ pass, total: results.length, results }, null, 1));
  fs.writeFileSync(path.join(out, 'service.log'), svcLog);
  log({ summary: `${pass}/${results.length}`, failed: results.filter((r) => !r.ok).map((r) => r.id), s: elapsed() });
  svc.kill('SIGTERM'); await stub.close?.(); setTimeout(() => process.exit(0), 500);
}
