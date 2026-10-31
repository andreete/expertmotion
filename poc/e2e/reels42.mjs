// End-to-end, BLIND rebuild of a talking-head Reel from raw inputs (QA PRD "rebuild Reels 42", ADR-039). The app only receives the
// INPUTS (recorder audio, sideways camera file, class poster, the brief, the channel profile); the answer key is read by THIS driver
// to score the output (checks A1–A24 of the QA PRD) and never reaches the Service or the provider stub.
// Flow (the three Creator actions): import → "Siapkan" (footage prep: sync, master, phrases, listen, takes, timing) → Diskusi
// (PRD first, "PRD siap.") → approve → Editor plan (scene.compose talking-head + music + cover) → Execute → Pratinjau 720p →
// Final 1080p. The provider stub is SCRIPTED by the driver (a model stand-in): its Editor spec is written from the analysis the app
// produced plus the brief's facts, like a model that followed the PRD — it never sees the key.
// Run:  E2E_DIR=<dir> E2E_SERVICE=<service.cjs> EM_REELS_KIT=<Test Kit dir> E2E_WHISPER_MODEL=<ggml-*.bin> \
//       bash scripts/run-capped.sh node poc/e2e/reels42.mjs   (E2E_FINAL=1 also renders 1080p; E2E_PREP_JOB=<jobId> reuses a data dir)
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startProviderStub } from './provider-stub.mjs';
import { qualityCheck, deriveTiming } from '../../packages/composition-model/dist/index.js';

const root = new URL('../../', import.meta.url).pathname;
const binDir = fs.existsSync(path.join(root, 'resources/bin-linux-x64/ffmpeg')) ? path.join(root, 'resources/bin-linux-x64') : path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu');
const ffmpeg = path.join(binDir, 'ffmpeg'), ffprobe = path.join(binDir, 'ffprobe');
const KIT = process.env.EM_REELS_KIT ?? '/home/andre/expertmotion-feedback/Test Kit';
const dir = process.env.E2E_DIR; if (!dir) throw new Error('E2E_DIR');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
const dataDir = process.env.E2E_DATA_DIR ?? fs.mkdtempSync(path.join(dir, 'reels-data-'));
const home = path.join(dataDir, 'home'); fs.mkdirSync(path.join(home, 'Videos'), { recursive: true });
const out = path.join(dir, 'reels-out'); fs.mkdirSync(out, { recursive: true });
const log = (o) => console.log(JSON.stringify(o));
const results = [];
const check = (id, name, ok, extra = {}) => { results.push({ id, name, ok: !!ok, ...extra }); log({ check: `${id} ${name}`, ok: !!ok, ...extra }); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inputs = { audio: path.join(KIT, 'Reels 42 Raw Audio.m4a'), video: path.join(KIT, 'Reels 42 Raw Video.MP4'), poster: process.env.E2E_POSTER ?? path.join(KIT, 'cta-class.png') };
const keyWords = JSON.parse(fs.readFileSync(path.join(KIT, 'reels42 Remotion Bridge/reels42-words.json'), 'utf8'));
// Answer key: the kept takes (recording s) from the QA PRD §4; only the DRIVER reads them.
const KEY_CUTS = [[8.14, 14.54], [48.72, 58.58], [68.72, 75.20], [77.99, 84.20], [91.47, 98.10], [100.44, 106.30], [110.25, 113.90], [116.34, 121.40]];
const KEY_OFFSET_MS = 3536;

// ── whisper model into the data dir (installed-model layout), so the prep job finds an STT model without downloading 190–540 MB ──
if (process.env.E2E_MODELS_FROM) fs.cpSync(path.join(process.env.E2E_MODELS_FROM, 'models'), path.join(dataDir, 'models'), { recursive: true, filter: (f) => !f.includes('music-library') });
const stub = await startProviderStub(4140);
const svc = spawn(process.execPath, [process.env.E2E_SERVICE ?? path.join(root, 'apps/service/dist/service.cjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  HOME: home, EM_DEV: '1', EM_TEST_FREE_MEM_MB: '4096', EM_PORT: '4110', EM_TOKEN: token, EM_DATA_DIR: dataDir, EM_UI_ORIGIN: 'http://127.0.0.1:4120', EM_RESOURCES: path.join(root, 'resources'),
  EM_ENGINES: path.join(root, fs.existsSync(path.join(root, 'resources/engines-linux-x64')) ? 'resources/engines-linux-x64' : 'resources/engines'),
  EM_DEV_PROVIDER_STUB: stub.origin, EM_VIDEOS_DIR: path.join(home, 'Videos'), EM_DEBUG_AGENT_DUMP: path.join(out, 'agent-dump'), ...(process.env.E2E_ENGINE_BUNDLE ? { EM_ENGINE_BUNDLE: process.env.E2E_ENGINE_BUNDLE } : {}), EM_FFMPEG: ffmpeg, EM_FFPROBE: ffprobe } });
let svcLog = ''; svc.stdout.on('data', (d) => { svcLog += d; }); svc.stderr.on('data', (d) => { svcLog += d; });
const api = async (p, init = {}) => { const r = await fetch(`http://127.0.0.1:4110/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body && !init.raw ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
const apiBin = async (p) => { const r = await fetch(`http://127.0.0.1:4110/api/v1${p}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') }; };
for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:4110/api/v1/health')).ok) break; } catch { /* starting */ } await sleep(250); }
check('S0', 'service healthy', (await fetch('http://127.0.0.1:4110/api/v1/health')).ok);
const t0 = Date.now(); const elapsed = () => Math.round((Date.now() - t0) / 1000);
const actions = []; // the Creator's actions (A23: ≤ 3 beyond the brief and approvals)

try {
  // ── licence, provider, channel profile (B0) ──
  const lic = await api('/license');
  const key = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/license-cli/src/cli.mjs'), 'issue', '--name', 'E2E', '--email', 'e2e@example.com', '--fingerprint', lic.body.machineCode,
    '--key-file', path.join(dir, 'a1.key'), '--audit', path.join(dataDir, 'audit.csv'), '--out-dir', path.join(dataDir, 'lic'), '--dev-allow-network', '--json'],
    { env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: fs.readFileSync(path.join(dir, 'pass'), 'utf8').trim() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).key;
  check('S1', 'licence activated', (await api('/license/activate', { method: 'POST', body: JSON.stringify({ key }) })).body.status === 'licensed');
  const profile = fs.readFileSync(path.join(root, 'poc/e2e/fixtures/reels-channel-profile.md'), 'utf8');
  const st = await api('/settings', { method: 'PUT', body: JSON.stringify({ onboardingDone: true, channelProfile: profile, webResearch: true }) });
  check('C20', 'channel profile saved (B0)', st.status === 200 && (st.body.channelProfile ?? st.body.settings?.channelProfile ?? '').includes('Experthinker'), { status: st.status });
  const c = await api('/providers/connections', { method: 'POST', body: JSON.stringify({ provider: 'anthropic', label: 'Claude', secret: ['sk', 'ant', 'api03', 'stubstubstubstubstubstubstub_0123456789'].join('-') }) });
  const cid = c.body.id ?? c.body.connection?.id;
  await api(`/providers/connections/${cid}/models/refresh`, { method: 'POST' });
  check('S2', 'provider connected + assigned', (await api('/providers/assignments', { method: 'PUT', body: JSON.stringify({ brainstorm: { agent: 'brainstorm', connectionId: cid, modelId: 'claude-sonnet-5-5' }, editor: { agent: 'editor', connectionId: cid, modelId: 'claude-sonnet-5-5' }, defaultConnectionId: cid }) })).status === 200);

  // ── project + the three inputs (dev raw upload = the Assets panel on Windows) ──
  const pj = await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'Reels 42' }) });
  const pid = pj.body.id ?? pj.body.project?.id; check('S3', 'project created', !!pid, { pid, status: pj.status });
  const upload = async (file, name) => {
    const r = await fetch(`http://127.0.0.1:4110/api/v1/projects/${pid}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Expertmotion-Filename': encodeURIComponent(name), 'Content-Length': String(fs.statSync(file).size) }, body: fs.createReadStream(file), duplex: 'half' });
    const j = await r.json(); return { status: r.status, id: j.items?.[0]?.id, body: j };
  };
  const tUp = Date.now();
  const aud = await upload(inputs.audio, 'Reels 42.m4a'); const vid = await upload(inputs.video, 'Reels 42.MP4'); const pos = await upload(inputs.poster, 'cta-class.png');
  check('C1', 'uploads accepted (m4a 3 MB, MP4 568 MB, PNG)', aud.status < 300 && vid.status < 300 && pos.status < 300, { s: Math.round((Date.now() - tUp) / 1000), aud: aud.status, vid: vid.status, pos: pos.status, err: [aud, vid, pos].map((x) => x.body?.error?.code).filter(Boolean) });
  const assetsReady = async (ids, maxS = 900) => { for (let i = 0; i < maxS; i++) { const items = (await api(`/projects/${pid}/assets`)).body.items ?? []; const rows = ids.map((id) => items.find((a) => a.id === id)); if (rows.every((a) => a?.status === 'ready')) return rows; if (rows.some((a) => a?.status === 'failed')) return rows; await sleep(1000); } return []; };
  const ready = await assetsReady([aud.id, vid.id, pos.id]);
  check('C1b', 'ingest done for all three (full quality kept)', ready.length === 3 && ready.every((a) => a.status === 'ready'), { s: elapsed(), kinds: ready.map((a) => `${a.kind}:${a.width ?? ''}x${a.height ?? ''}@${a.fps ?? ''} ${a.durationMs}ms`) });
  const probe = (await api(`/projects/${pid}/assets/${vid.id}?probe=true`)).body;
  log({ probe: { width: probe.width, height: probe.height, fps: probe.fps, durationMs: probe.durationMs, rotated: probe.probe?.rotated ?? probe.rotated ?? null } });
  check('C3', 'probe: camera 1920x1080 50 fps ~131.7 s, recorder ~122.2 s', probe.width === 1920 && probe.height === 1080 && Math.abs(probe.durationMs - 131680) < 500 && Math.abs(ready[0].durationMs - 122197) < 500, { v: [probe.width, probe.height, probe.fps, probe.durationMs], a: ready[0].durationMs });

  // ── an STT model (Model Manager): the prep job needs one installed; a real pinned download when the data dir has none ──
  const sttInstalled = async () => ((await api('/models')).body.items ?? []).filter((x) => x.task === 'stt' && x.status === 'installed');
  if (!(await sttInstalled()).length) {
    const mk = process.env.E2E_WHISPER_KEY ?? 'whisper-small-q5'; const tm = Date.now();
    const ins = await api(`/models/${mk}/install`, { method: 'POST' });
    log({ installing: mk, status: ins.status, code: ins.body?.error?.code });
    for (let i = 0; i < 900; i++) { if ((await sttInstalled()).length) break; const f = ((await api('/models')).body.items ?? []).find((x) => x.key === mk); if (f?.status === 'failed') break; await sleep(1000); }
    check('C4a', `STT model ${mk} installed (pinned download, hash-verified)`, (await sttInstalled()).length > 0, { s: Math.round((Date.now() - tm) / 1000) });
  }

  // ── Action 1: "Siapkan" (footage prep) ──
  actions.push('prep');
  const brief = fs.readFileSync(path.join(root, 'poc/e2e/fixtures/reels42-brief.md'), 'utf8');
  // the script as a Creator / the Diskusi model would hand it over: the quoted spoken lines only
  const script = [...brief.split('Naskah Video:')[1].split('Link :')[0].matchAll(/"([^"]+)"/g)].map((x) => x[1].replace(/\s+/g, ' ').trim()).join('\n');
  const tPrep = Date.now();
  let prep = await api(`/projects/${pid}/generators/prep`, { method: 'POST', body: JSON.stringify({ voiceAssetId: aud.id, cameraAssetId: vid.id, script, ...(process.env.E2E_WHISPER_KEY ? { sttModelKey: process.env.E2E_WHISPER_KEY } : {}) }) });
  check('S4', 'prep job accepted', prep.status < 300, { status: prep.status, code: prep.body?.error?.code, msg: prep.body?.error?.message });
  let jobId = prep.body.id ?? prep.body.job?.id ?? prep.body.jobId;
  const pollJob = async (id, maxS = 2400) => { let j = {}; const stages = []; for (let i = 0; i < maxS; i++) { j = (await api(`/generator-jobs/${id}`)).body; const stg = j.stage ?? j.progressStage; if (stg && stages.at(-1) !== stg) { stages.push(stg); log({ prep: { stage: stg, percent: Math.round((j.progress ?? 0) * 100), s: elapsed() } }); } if (['done', 'failed', 'cancelled', 'needs-input'].includes(j.status)) break; await sleep(1500); } return { job: j, stages }; };
  let { job, stages } = await pollJob(jobId);
  let rotationSource = job.result?.analysis?.rotationSource ?? job.result?.rotationSource ?? null; let suggested = job.result?.suggestedRotation ?? job.result?.analysis?.rotation ?? null;
  if (job.status === 'needs-input') {
    // the Creator looks at the four thumbnails and picks the upright one (the camera file has no rotation flag)
    log({ needsInput: job.result });
    check('C3b', 'sideways camera: the app asks for the rotation with thumbnails', Array.isArray(job.result?.thumbnails) && job.result.thumbnails.length === 4, { suggested: job.result?.suggestedRotation, confidence: job.result?.confidence });
    const cont = await api(`/projects/${pid}/footage-prep/${jobId}/continue`, { method: 'POST', body: JSON.stringify({ rotation: 90 }) });
    check('S5', 'continue with rotation 90', cont.status < 300, { status: cont.status, code: cont.body?.error?.code });
    jobId = cont.body.id ?? cont.body.job?.id ?? jobId;
    ({ job, stages } = await pollJob(jobId));
  }
  log({ prepDone: { status: job.status, s: Math.round((Date.now() - tPrep) / 1000), stages, error: job.errorCode ?? job.error } });
  check('S6', 'prep finished', job.status === 'done', { status: job.status, code: job.errorCode, stages });
  const an = job.result?.analysis ?? (await api(`/projects/${pid}/footage-analysis`)).body?.analysis ?? (await api(`/projects/${pid}/footage-analysis`)).body;
  fs.writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(an, null, 1));
  check('C6', `sync offset ${an?.offsetMs} ms (key ${KEY_OFFSET_MS} ± 20)`, Math.abs((an?.offsetMs ?? 0) - KEY_OFFSET_MS) <= 20, { offsetMs: an?.offsetMs, points: an?.sync?.points, drift: an?.sync?.driftMs });
  check('C7', `phrases ${an?.phrases?.length} (key 22 ± 2)`, Math.abs((an?.phrases?.length ?? 0) - 22) <= 2);
  check('C3c', 'rotation 90 applied to the master', an?.rotation === 90, { rotation: an?.rotation, source: an?.rotationSource ?? rotationSource, suggested });
  const cuts = an?.cuts ?? [];
  const ov = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  const cutRows = cuts.map((cu) => { const r = [cu.startMs / 1000, cu.endMs / 1000]; const best = KEY_CUTS.map((k) => ov(r, k) / (k[1] - k[0])).reduce((m, x, i, arr) => (x > arr[m] ? i : m), 0); return { id: cu.id, rec: r.map((x) => x.toFixed(2)).join('-'), key: best, cover: +(ov(r, KEY_CUTS[best]) / (KEY_CUTS[best][1] - KEY_CUTS[best][0])).toFixed(3), text: cu.text.slice(0, 50) }; });
  log({ cuts: cutRows, dropped: (an?.dropped ?? []).map((d) => `${(d.startMs / 1000).toFixed(1)}-${(d.endMs / 1000).toFixed(1)} ${d.reason}: ${String(d.text ?? '').slice(0, 40)}`) });
  const keyHits = KEY_CUTS.map((k, i) => cutRows.some((r) => r.key === i && r.cover >= 0.9));
  check('A3', `same takes: ${keyHits.filter(Boolean).length}/8 key cuts covered ≥ 90 %`, keyHits.filter(Boolean).length >= 7, { hits: keyHits, n: cuts.length });
  const spokenAll = cuts.map((c) => c.text).join(' ');
  check('A6', 'left-out lines not in the cuts (Nah alasannya / Ya ya solusi / Pembangkit nu- / Tulis pendapat)', !/nah,? alasannya|ya,? ya,? solusi|tulis pendapat/i.test(spokenAll), { total: cuts.reduce((s, c) => s + c.endMs - c.startMs, 0) });
  // master asset
  const assets = (await api(`/projects/${pid}/assets`)).body.items ?? [];
  const master = assets.find((a) => a.id === an?.masterAssetId) ?? assets.find((a) => /master/i.test(a.name ?? ''));
  check('C3d', 'master 1080x1920 30 fps registered and ready', master?.status === 'ready' && master.width === 1080 && master.height === 1920 && master.fps === 30, { master: master && [master.id, master.width, master.height, master.fps, master.durationMs] });
  const masterPath = master ? (await api(`/projects/${pid}/assets/${master.id}?probe=true`)).body?.paths?.playable ?? null : null;

  // ── Diskusi: the brief → PRD first (the stub plays a model that reads the analysis, then writes the PRD) ──
  const prdText = buildPrd(an, cuts);
  await fetch(`${stub.origin}/__stub/script`, { method: 'POST', body: JSON.stringify({ provider: 'anthropic', replies: [
    { text: 'Saya baca hasil analisis rekamannya dulu.', toolUse: { name: 'media_analysis_get', input: {} } },
    { json: { reply: prdText, suggestedNextStep: 'none' } },
  ] }) });
  const baseVersion = async () => (await api(`/projects/${pid}/composition`)).body.head?.hash ?? (await api(`/projects/${pid}/composition`)).body.head?.id;
  const msg = await api(`/projects/${pid}/conversations/brainstorm/messages`, { method: 'POST', body: JSON.stringify({ text: brief, baseVersion: await baseVersion() }) });
  check('S7', 'brief sent to Diskusi', msg.status < 300, { status: msg.status, code: msg.body?.error?.code, msg: msg.body?.error?.message });
  const runId = msg.body.runId ?? msg.body.run?.id;
  let thread = [];
  const threadItems = async () => { const b = (await api(`/projects/${pid}/conversations/brainstorm`)).body; return b.messages?.items ?? b.items ?? []; };
  for (let i = 0; i < 240; i++) { thread = await threadItems(); if (thread.some((m) => m.role === 'assistant' && /PRD siap/.test(JSON.stringify(m)))) break; await sleep(1000); }
  const prdMsg = thread.find((m) => m.role === 'assistant' && /PRD siap/.test(JSON.stringify(m)));
  check('C10', 'PRD written first and announced ("PRD siap")', !!prdMsg, { runId, msgs: thread.length });
  const stubLog = (await (await fetch(`${stub.origin}/__stub/log`)).json()).calls;
  const toolText = stubLog.map((x) => x.toolResultText ?? '').join('\n');
  check('C4', 'Diskusi read the analysis through media.analysis.get (tool result carried the cut table)', /cuts|offsetMs/.test(toolText), { tools: [...new Set(stubLog.flatMap((x) => x.tools ?? []).filter((n) => /media/.test(n)))], sample: toolText.slice(0, 160) });

  // ── Approve → Editor plan (the stub answers with the talking-head spec from the analysis + the PRD facts) ──
  actions.push('approve-and-send');
  const spec = buildSpec(an, cuts, { master: master?.id, voice: aud.id, poster: pos.id });
  fs.writeFileSync(path.join(out, 'spec.json'), JSON.stringify(spec, null, 1));
  // one scene.compose step: the app derives the music and cover steps from spec.music / spec.cover (a model may add them too)
  const planJson = { goal: 'Reel talking-head 9:16: hook, kartu ilustrasi, 5 penjelasan dengan bubble, hold, CTA, poster.', steps: [
    { n: 1, tool: 'scene.compose', ops: [], args: spec, expectedDiff: `${spec.scenes.length} adegan`, dependsOn: [] },
  ], risks: [], notes: 'Sumber dari PRD; kartu sumber = ilustrasi karena klip YouTube tidak bisa diunduh.' };
  await fetch(`${stub.origin}/__stub/script`, { method: 'POST', body: JSON.stringify({ provider: 'anthropic', replies: [{ json: planJson, fillBaseVersion: true }, { json: planJson, fillBaseVersion: true }, { json: planJson, fillBaseVersion: true }] }) });
  const send = await api(`/projects/${pid}/conversations/brainstorm/messages/${prdMsg.id}/send-to-editor`, { method: 'POST', body: JSON.stringify({ baseVersion: await baseVersion() }) });
  check('S8', 'approved → sent to the Editor', send.status < 300, { status: send.status, code: send.body?.error?.code, msg: send.body?.error?.message });
  let plan = null;
  for (let i = 0; i < 240; i++) { const list = (await api(`/projects/${pid}/plans`)).body.items ?? []; plan = list.find((p) => ['valid', 'invalid', 'stale'].includes(p.status)) ?? null; if (plan) break; await sleep(1000); }
  if (plan) plan = (await api(`/plans/${plan.id}`)).body;
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan, null, 1));
  check('S9', 'Editor plan valid', plan?.status === 'valid', { status: plan?.status, validation: plan?.validation?.slice(0, 5), risks: plan?.risks?.slice(0, 6), steps: plan?.steps?.map((s) => s.tool) });

  // ── Action 2: Pratinjau = Execute + 720p ──
  actions.push('preview');
  const ex = await api(`/plans/${plan.id}/execute`, { method: 'POST', headers: { 'Idempotency-Key': `reels-${Date.now()}` }, body: JSON.stringify({ confirmDestructive: true }) });
  check('S10', 'Execute accepted', ex.status < 300, { status: ex.status, code: ex.body?.error?.code, msg: ex.body?.error?.message });
  let plan2 = plan;
  for (let i = 0; i < 600; i++) { plan2 = (await api(`/plans/${plan.id}`)).body; if (['executed', 'failed', 'cancelled'].includes(plan2.status)) break; await sleep(1000); }
  check('S11', 'Execute done', plan2.status === 'executed', { status: plan2.status, s: elapsed() });
  // generator steps (music, cover) finish asynchronously
  let covers = [], gjobs = [];
  for (let i = 0; i < 300; i++) { gjobs = (await api(`/projects/${pid}/generator-jobs`)).body.items ?? []; const pending = gjobs.filter((g) => ['queued', 'running'].includes(g.status) && g.kind !== 'prep'); covers = ((await api(`/projects/${pid}/outputs`)).body.items ?? []).filter((o) => o.kind === 'still'); if (!pending.length && (covers.length || i > 60)) break; await sleep(1000); }
  const head = (await api(`/projects/${pid}/composition?model=true`)).body.head; const m = head.model;
  fs.writeFileSync(path.join(out, 'model.json'), JSON.stringify(m, null, 1));
  if (m.tracks.video.length < spec.scenes.length) throw new Error(`composition has ${m.tracks.video.length} clips, expected ${spec.scenes.length}: stop measuring`);
  const timing = deriveTiming(m); const fps = m.settings.fps; const frame = 1000 / fps;
  check('C2', 'project is 9:16 at 30 fps', m.settings.ratio === '9:16' && fps === 30, { ratio: m.settings.ratio, fps });
  check('A2', `length ${(timing.durationMs / 1000).toFixed(2)} s (< 60, target 57.87 ± 2)`, timing.durationMs < 60000 && Math.abs(timing.durationMs - 57870) <= 2000, { ms: timing.durationMs });
  // scene roles in order
  const roles = spec.scenes.map((s) => s.role); const want = ['talk', 'card', 'explain', 'explain', 'explain', 'explain', 'explain', 'explain', 'hold', 'talk', 'poster'];
  check('A4', 'order: hook, card, 24 jam, SMR, reaktor kecil, energi bersih, kartu truf, pertanyaan, hold, CTA, poster', m.tracks.video.length === spec.scenes.length && JSON.stringify(roles) === JSON.stringify(want), { roles, clips: m.tracks.video.length });
  // voice layers → recording ranges (A3 on the actual timeline, A7 lip sync = offset applied to the master)
  const voices = m.tracks.audio.filter((a) => a.role === 'voice').sort((a, b) => a.atMs - b.atMs);
  const recRanges = voices.map((v) => [v.trimBeforeMs / 1000, (v.trimBeforeMs + v.durationMs) / 1000]);
  check('A3b', 'timeline voice layers = the picked cuts', recRanges.length === cuts.length && recRanges.every((r, i) => Math.abs(r[0] - cuts[i].startMs / 1000) < 0.05), { n: recRanges.length });
  check('A7', `lip sync: master built at offset ${an?.offsetMs} ms (key ${KEY_OFFSET_MS} ± 20); one frame = 33 ms`, Math.abs((an?.offsetMs ?? 0) - KEY_OFFSET_MS) <= 20 && Math.abs((an?.offsetMs ?? 0) - KEY_OFFSET_MS) <= frame);
  // A5 clean cuts: raw recorder envelope ≤ −43 dB within 100 ms outside every cut
  const env = envelopeDb(inputs.audio);
  const quiet = cuts.map((cu) => ({ id: cu.id, before: maxDb(env, cu.startMs - 100, cu.startMs), after: maxDb(env, cu.endMs, cu.endMs + 100) }));
  check('A5', 'clean cuts: ≤ −43 dB within 0.1 s outside every cut', quiet.every((q) => q.before <= -43 && q.after <= -43), { worst: quiet.map((q) => `${q.id}:${q.before.toFixed(0)}/${q.after.toFixed(0)}`) });
  // A8 / A9 subtitles vs the key words (map caption token times back to recording time through the scenes)
  const sceneStart = timing.clipStartMs; const voiceByScene = spec.scenes.map((s, i) => s.cut ? { start: sceneStart[i], cut: cuts.find((c) => c.id === s.cut) } : null);
  const toRec = (ms) => { for (let i = voiceByScene.length - 1; i >= 0; i--) { const v = voiceByScene[i]; if (v && ms >= sceneStart[i] - 1) return v.cut.startMs + (ms - sceneStart[i]); } return null; };
  const outWords = (m.tracks.caption.pages ?? []).flatMap((p) => p.tokens.map((t) => ({ text: t.text.trim(), rec: toRec(t.fromMs) })));
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9àâéèêîôûç-]/g, '');
  const { errors, aligned } = alignWords(outWords.map((w) => norm(w.text)), keyWords.map((w) => norm(w.text)));
  const startErr = aligned.map(([i, j]) => Math.abs(outWords[i].rec - keyWords[j].startMs)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const med = startErr[Math.floor(startErr.length / 2)] ?? Infinity, mx = startErr.at(-1) ?? Infinity;
  check('A8', `subtitle words: ${errors} errors / ${keyWords.length} (≤ 3); SMR / Small Modular Reactor / data center / AI / DM exact`, errors <= 3 && /SMR/.test(JSON.stringify(m.tracks.caption.pages)) && /Small Modular Reactor/.test((m.tracks.caption.pages ?? []).map((p) => p.text).join(' ').replace(/\s+/g, ' ')), { errors, outWords: outWords.length, exact: ['SMR', 'Small', 'Modular', 'Reactor', 'data', 'center', 'AI', 'DM'].map((w) => (m.tracks.caption.pages ?? []).some((p) => p.tokens.some((t) => t.text.trim().replace(/[?.,!]/g, '') === w))) });
  check('A9', `subtitle timing: median ${med.toFixed(0)} ms (≤ 100), max ${mx.toFixed(0)} ms (≤ 250)`, med <= 100 && mx <= 250, { aligned: aligned.length });
  // A10 no captions over the silent scenes
  const silentIdx = spec.scenes.map((s, i) => (['card', 'hold', 'poster'].includes(s.role) ? i : -1)).filter((i) => i >= 0);
  const silentWin = silentIdx.map((i) => [sceneStart[i], sceneStart[i] + m.tracks.video[i].durationMs]);
  const overSilent = (m.tracks.caption.pages ?? []).filter((p) => silentWin.some(([a, b]) => p.startMs < b - frame && p.startMs + p.durationMs > a + frame));
  check('A10', 'no subtitles over the clip card, the hold or the poster', overSilent.length === 0, { over: overSilent.length });
  // A11 source clip card
  const card = m.tracks.video[1]; const cardTexts = elementsIn(m, sceneStart[1], card.durationMs);
  check('A11', 'source clip = silent drawn card 3.0 ± 0.5 s labelled "ilustrasi · bukan cuplikan asli"', !card.assetId && Math.abs(card.durationMs - 3000) <= 500 && /ilustrasi/.test(cardTexts.join(' ')) && !/youtube\.com\/watch/.test(JSON.stringify(m)), { dur: card.durationMs, texts: cardTexts.slice(0, 4) });
  // A12 evidence: source tags on fact scenes, OPINI tags, the reality check, "aman" as a claim
  const allTexts = textsOf(m);
  const factScenes = [2, 3, 4, 5, 6, 7]; const tagged = factScenes.map((i) => elementsIn(m, sceneStart[i], m.tracks.video[i].durationMs).some((t) => /dicek|sumber|Okt|Nov|Apr|2024|2025|2026/i.test(t)));
  check('A12', 'evidence: source tag on every fact scene, OPINI on "realistis" and the question, "aman" = klaim, reality check on screen', tagged.every(Boolean) && (allTexts.join(' ').match(/OPINI/g) ?? []).length >= 2 && /klaim/i.test(allTexts.join(' ')) && /Belum ada SMR yang menyuplai data center/.test(allTexts.join(' ')), { tagged });
  check('A13', 'nothing about Indonesia added on screen', !/indonesia/i.test(allTexts.join(' ')));
  // A14 one scene per spoken line; graphics within 0.3 s of their trigger word (composer anchors) — checked on the model
  const sayBlocks = spec.scenes.flatMap((s, i) => (s.blocks ?? []).filter((b) => b.at?.say).map((b) => ({ i, say: b.at.say, cut: cuts.find((c) => c.id === s.cut) })));
  const anchors = sayBlocks.map((b) => { const w = b.cut?.words.find((x) => norm(x.text).startsWith(norm(b.say.split(' ')[0]))); return w ? sceneStart[b.i] + (w.fromMs - b.cut.startMs) : null; }).filter((x) => x !== null);
  const starts = [...m.tracks.text, ...m.tracks.overlay].map((e) => e.timing.atMs);
  const hit = anchors.filter((a) => starts.some((s) => s >= a - 300 && s <= a + 300));
  check('A14', `scenes: one per cut (${cuts.length}); graphics within 0.3 s of their word: ${hit.length}/${anchors.length}`, cuts.length === 8 && hit.length >= Math.ceil(anchors.length * 0.9), { anchors: anchors.length });
  // A15 bubble
  const bubbles = m.tracks.overlay.filter((o) => o.kind === 'video' && o.shape === 'circle');
  const bubbleSpan = bubbles.length ? [Math.min(...bubbles.map((b) => b.timing.atMs)), Math.max(...bubbles.map((b) => b.timing.atMs + b.timing.durationMs))] : null;
  check('A15', 'face bubble 260 u ± 10, yellow ring, from the first explanation to the question', bubbles.length >= 6 && bubbles.every((b) => Math.abs(b.size.w - 260) <= 10 && /^#FFD43B$/i.test(b.ring?.colour ?? '')) && bubbleSpan && Math.abs(bubbleSpan[0] - sceneStart[2]) < 50, { n: bubbles.length, span: bubbleSpan, sizes: [...new Set(bubbles.map((b) => b.size.w))] });
  // A16 safe areas via the quality gate (reels zones) + graphics inside y 110–1250 by construction
  const issues = qualityCheck(m, { safeArea: { top: 110, right: 48, bottom: 1920 - 1250, left: 48 } });
  const bad = issues.filter((x) => x.severity === 'warn' && ['overlap', 'text-overflow', 'off-frame'].includes(x.code));
  check('A16', 'no overlapping / cut-off text, nothing off frame', bad.length === 0, { bad: bad.map((x) => `${x.code}:${x.ids.join('+')}@${x.atMs}`).slice(0, 8), total: issues.length });
  // A18 music, A19 sfx (model side)
  const bed = m.tracks.audio.find((a) => a.role === 'bed'); const sfx = m.tracks.audio.filter((a) => a.role === 'sfx');
  check('A18a', 'music bed at 0.3 with ducking, gain lift over silent cards, fades 0.5 / 2.5 s', !!bed && Math.abs(bed.volume - 0.3) < 0.01 && !!bed.ducking && (bed.gain?.length ?? 0) >= 3 && bed.fadeInMs === 500 && bed.fadeOutMs === 2500, { bed: bed && { v: bed.volume, gain: bed.gain?.length, fi: bed.fadeInMs, fo: bed.fadeOutMs, duck: !!bed.ducking } });
  // an SFX inside a speech scene must land within 4 frames BEFORE a spoken word (recording time through the scene's cut)
  const sfxWordHits = sfx.filter((s) => { const rec = toRec(s.atMs); return rec !== null && cuts.some((c) => c.words.some((w) => w.fromMs >= rec - 1 && w.fromMs - rec <= 4 * frame + 1)); });
  check('A19', `sound effects: ${sfx.length} (≥ 30), ≤ 0.55, 90 % within 4 frames before a word`, sfx.length >= 30 && sfx.every((s) => s.volume <= 0.55 + 1e-6) && sfxWordHits.length >= sfx.filter((s) => toRec(s.atMs) !== null).length * 0.9, { total: sfx.length, onWords: sfxWordHits.length, inSpeech: sfx.filter((s) => toRec(s.atMs) !== null).length });
  // A20 CTA
  const ctaIdx = spec.scenes.length - 2; const ctaTexts = elementsIn(m, sceneStart[ctaIdx], m.tracks.video[ctaIdx].durationMs);
  check('A20', 'CTA: the spoken "solusi data center … DM aku ya, link ada di bio" with its DM box', /solusi data (center|senter)|DM aku|link ada di bio/i.test(cuts.at(-1)?.text ?? '') && ctaTexts.some((t) => /DM|solusi data center|bio/i.test(t)), { texts: ctaTexts.slice(0, 5) });
  // A21 poster
  const last = m.tracks.video.at(-1); const posterImg = m.tracks.overlay.find((o) => o.kind === 'image' && o.assetId === pos.id);
  check('A21a', 'poster = last 3.5 ± 0.5 s, the uploaded image at 78 %, handle under it', !last.assetId && Math.abs(last.durationMs - 3500) <= 500 && !!posterImg && Math.abs(posterImg.size.w / 1080 - 0.78) < 0.02 && /@septianusanggaw/.test(allTexts.join(' ')), { dur: last.durationMs, w: posterImg?.size.w });
  // A22 cover
  const cover = covers.at(-1);
  const coverPath = cover ? (await api(`/outputs/${cover.id}`)).body?.path : null;
  const coverProbe = coverPath && fs.existsSync(coverPath) ? JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', coverPath], { encoding: 'utf8' })).streams[0] : null;
  if (coverPath) fs.copyFileSync(coverPath, path.join(out, 'cover.jpg'));
  check('A22', 'cover 1080x1920 JPG with a hook word from the list (eyes-open check needs a vision model: not measured here)', coverProbe?.width === 1080 && coverProbe?.height === 1920 && /mjpeg|jpeg/.test(coverProbe?.codec_name ?? '') && /^(GILA|GOKIL|AWAS|HOROR|KEREN|WAJIB TAHU|PENTING!?|SEREM|NGERI)/i.test(spec.cover.hookWord), { cover: coverProbe, hook: spec.cover.hookWord });
  check('A23', `process: PRD before editing, ${actions.length} Creator actions (prep, preview, final)`, !!prdMsg && actions.length <= 3, { actions });

  // ── render: 720p preview, then (E2E_FINAL=1) the 1080p final; measure the file ──
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
  if (process.env.E2E_FINAL === '1') { actions.push('final'); const fin = await render('1080p'); check('S13', 'final render 1080p done', fin.ok, { s: fin.s, code: fin.code }); finalFile = fin.file; }
  const file = finalFile ?? pre.file;
  if (file) {
    fs.copyFileSync(file, path.join(out, finalFile ? 'reels42-final.mp4' : 'reels42-preview.mp4'));
    const pr = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file], { encoding: 'utf8' }));
    const v = pr.streams.find((s) => s.codec_type === 'video'); const a = pr.streams.find((s) => s.codec_type === 'audio');
    const wantW = finalFile ? 1080 : 720;
    check('A1', `format: h264 ${v?.width}x${v?.height} ${v?.r_frame_rate} + ${a?.codec_name}`, v?.codec_name === 'h264' && v.width === wantW && v.height === wantW * 16 / 9 && v.r_frame_rate === '30/1' && a?.codec_name === 'aac', { v, a });
    check('A2b', 'file duration = composition (± 0.1 s)', Math.abs(Number(pr.format.duration) * 1000 - timing.durationMs) <= 100, { file: Number(pr.format.duration) });
    const eb = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'ebur128=peak=true', '-vn', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stderr;
    const summary = eb.slice(eb.lastIndexOf('Summary:'));   // the per-frame lines also print "I:"; only the summary counts
    const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]), TP = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
    check('A17', `loudness I ${I} LUFS (−16 ± 1), true peak ${TP} dBFS (≤ −1)`, Math.abs(I + 16) <= 1 && TP <= -1, { I, TP });
    // A18b music under speech: measure the bed-only level is not possible from the mix; check the voice/music gap by comparing a speech window vs a silent-card window
    const lvl = (from, to) => { const r = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr; return Number(/mean_volume: (-?[\d.]+) dB/.exec(r)?.[1]); };
    const speech = lvl(sceneStart[2] / 1000 + 0.5, sceneStart[2] / 1000 + 4), cardLvl = lvl(sceneStart[1] / 1000 + 0.3, sceneStart[1] / 1000 + 2.7);
    // under speech the bed is ducked (bed volume × duckTo/volume); the Reel's own card shows the UNDUCKED, lifted bed level
    const duckRatio = bed?.ducking ? (Number(bed.ducking.params?.duckTo ?? 0.15) / Number(bed.ducking.params?.volume ?? 0.5)) : 1;
    const underSpeechDb = cardLvl - 20 * Math.log10(1.5) + 20 * Math.log10(duckRatio);   // card level → plain bed → ducked bed
    check('A18b', `voice ≥ 12 dB above the music under speech (speech ${speech} dB, ducked bed ≈ ${underSpeechDb.toFixed(1)} dB; card bed ${cardLvl} dB)`, speech - underSpeechDb >= 12 && cardLvl < speech, { speech, cardLvl, duckRatio, underSpeechDb });
    // A21b the poster frame vs the input image (unchanged picture → high correlation of the centred crop)
    const corr = posterCorrelation(file, inputs.poster, timing.durationMs / 1000 - 1.0, v.width, v.height, posterImg?.size.w / 1080 ?? 0.78, posterImg?.position.y ?? 0);
    check('A21b', `poster frame matches the uploaded image (correlation ${corr.toFixed(3)} ≥ 0.9; QR decodes only if unchanged)`, corr >= 0.9, { corr });
    const credits = fs.existsSync(file.replace(/\.mp4$/, '-CREDITS.txt')) ? fs.readFileSync(file.replace(/\.mp4$/, '-CREDITS.txt'), 'utf8') : (fs.existsSync(path.join(path.dirname(file), 'CREDITS.txt')) ? fs.readFileSync(path.join(path.dirname(file), 'CREDITS.txt'), 'utf8') : '');
    check('A24', 'CREDITS file lists music, sound effects, poster and the sources', /CC0/i.test(credits) && /whoosh|SFX|efek suara/i.test(credits) && /poster|cta-class/i.test(credits) && /google|world-nuclear|nuclearnewsnetwork|publicpower|ans\.org/i.test(credits), { len: credits.length, head: credits.slice(0, 200) });
    if (credits) fs.writeFileSync(path.join(out, 'CREDITS.txt'), credits);
    for (const s of [1, 5, 8, 12, 20, 27, 34, 41, 47, 51, 56]) execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(s), '-i', file, '-frames:v', '1', '-vf', 'scale=270:480', path.join(out, `f_${String(s).padStart(2, '0')}.png`)]);
  }
} finally {
  try { fs.writeFileSync(path.join(out, 'stub-calls.json'), JSON.stringify((await (await fetch(`${stub.origin}/__stub/log`)).json()).calls, null, 1)); } catch { /* stub gone */ }
  svc.kill('SIGTERM'); await stub.close(); await sleep(800);
  fs.writeFileSync(path.join(out, 'service.log'), svcLog);
  const failed = results.filter((r) => !r.ok);
  // QA PRD §6 rubric (points only for the checks measurable here)
  const area = { structure: ['A2', 'A3', 'A3b', 'A4', 'A5', 'A6', 'A7', 'A2b'], words: ['A8', 'A9', 'A10'], evidence: ['A11', 'A12', 'A13'], scenes: ['A14', 'A15', 'A16', 'C2'], audio: ['A17', 'A18a', 'A18b', 'A19'], ending: ['A20', 'A21a', 'A21b', 'A22'], process: ['A23', 'C10', 'C20'] };
  const pts = { structure: 25, words: 20, evidence: 15, scenes: 15, audio: 10, ending: 10, process: 5 };
  let score = 0; const perArea = {};
  for (const [k, ids] of Object.entries(area)) { const rows = results.filter((r) => ids.includes(r.id)); const ok = rows.filter((r) => r.ok).length; const p = rows.length ? Math.round((pts[k] * ok) / rows.length) : 0; perArea[k] = `${ok}/${rows.length} → ${p}/${pts[k]}`; score += p; }
  const blockers = ['A1', 'A2', 'A4', 'A7', 'A11', 'A12', 'A13', 'A20', 'A21a', 'A21b', 'A22'].filter((id) => results.some((r) => r.id === id && !r.ok));
  log({ summary: `${results.length - failed.length}/${results.length} checks passed`, score: `${score}/100`, perArea, blockersFailed: blockers, failed: failed.map((f) => `${f.id} ${f.name}`), minutes: Math.round((Date.now() - t0) / 60000), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, score, perArea, blockers }, null, 1));
  process.exitCode = failed.length ? 1 : 0;
}

// ───────── helpers ─────────
function textsOf(m) { return [...m.tracks.text.map((t) => t.text), ...m.tracks.overlay.filter((o) => o.kind === 'shape').flatMap((s) => shapeTexts(s.params))]; }
function shapeTexts(p) { const out = []; const walk = (v) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(p ?? {}); return out; }
function elementsIn(m, from, dur) { const inWin = (e) => e.timing.atMs < from + dur - 1 && e.timing.atMs + e.timing.durationMs > from + 1; return [...m.tracks.text.filter(inWin).map((t) => t.text), ...m.tracks.overlay.filter((o) => o.kind === 'shape' && inWin(o)).flatMap((s) => shapeTexts(s.params))]; }
function envelopeDb(file) { const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 }); const hop = 160; const n = Math.floor(pcm.length / 2 / hop); const e = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < hop; j++) { const v = pcm.readInt16LE((i * hop + j) * 2) / 32768; s += v * v; } e[i] = 10 * Math.log10(s / hop + 1e-12); } return e; }
function maxDb(env, fromMs, toMs) { let mx = -120; for (let i = Math.max(0, Math.floor(fromMs / 10)); i < Math.min(env.length, Math.ceil(toMs / 10)); i++) mx = Math.max(mx, env[i]); return mx; }
/** Word-level alignment (edit distance over word sequences) → error count (sub + ins + del) and the matched index pairs. */
function alignWords(a, b) {
  const n = a.length, mm = b.length; const D = Array.from({ length: n + 1 }, () => new Int32Array(mm + 1));
  for (let i = 0; i <= n; i++) D[i][0] = i; for (let j = 0; j <= mm; j++) D[0][j] = j;
  const sim = (x, y) => x === y || (x.length > 3 && y.length > 3 && lev(x, y) <= 1);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= mm; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (sim(a[i - 1], b[j - 1]) ? 0 : 1));
  const aligned = []; let i = n, j = mm;
  while (i > 0 && j > 0) { if (D[i][j] === D[i - 1][j - 1] + (sim(a[i - 1], b[j - 1]) ? 0 : 1)) { if (sim(a[i - 1], b[j - 1])) aligned.push([i - 1, j - 1]); i--; j--; } else if (D[i][j] === D[i - 1][j] + 1) i--; else j--; }
  return { errors: D[n][mm], aligned: aligned.reverse() };
}
function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
/** Grey correlation between the output's poster frame (centred box of `scale` width) and the input poster scaled to it. */
function posterCorrelation(file, poster, atS, W, H, scale, centreYU = 0) {
  const u = W / 1080;   // layout unit → px (u = short side / 1080)
  const w = Math.round(W * scale / 2) * 2, h = Math.round(w * 16 / 9 / 2) * 2; const x = Math.round((W - w) / 2);
  const grey = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  // the box centre comes from the model (u from the frame centre); the metric is sensitive to a few px, so refine ± 6 px
  const ref = grey(['-i', poster, '-vf', `scale=${w}:${h},scale=64:112`]); let best = -1;
  const y0 = Math.round(H / 2 + centreYU * u - h / 2);
  for (let dy = -6; dy <= 6; dy += 2) { const y = y0 + dy; if (y < 0 || y + h > H) continue; const img = grey(['-ss', String(atS), '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},scale=64:112`]); best = Math.max(best, corr(ref, img)); }
  return best;
}
function corr(a, b) { const n = Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; } return sab / Math.sqrt(saa * sbb || 1); }

/** The PRD the Diskusi stand-in writes from the analysis (7 sections; facts + sources are the brief's research list). */
function buildPrd(an, cuts) {
  const row = (c, i) => `| ${i + 1} | ${(c.startMs / 1000).toFixed(2)}–${(c.endMs / 1000).toFixed(2)} | ${((c.endMs - c.startMs) / 1000).toFixed(1)} | ${c.text} |`;
  return ['# PRD Reels 42 — SMR: nuklir mini buat listrik AI', '', '## 1. Tujuan & naskah', 'Reel 9:16 < 60 s: kenapa raksasa teknologi berlomba ke nuklir mini (SMR) untuk data center AI; ditutup pertanyaan, bukan vonis.', '',
    '## 2. Cek fakta', '| Klaim | Verdict | Sumber (tanggal) |', '|---|---|---|', '| Raksasa teknologi berlomba ke nuklir mini | Benar, sebagian besar perjanjian | Google–Kairos hingga 500 MW (Google, 14 Okt 2024); Amazon–X-energy ±320 MW (Amazon, 16 Okt 2024); Meta–Oklo hingga 1.200 MW (NNN, 1 Okt 2026) |',
    '| Butuh listrik raksasa stabil 24 jam | Benar | IEA: permintaan data center > 2× (≈945 TWh) pada 2030 (APPA, 11 Apr 2025) |', '| SMR = reaktor skala kecil | Benar | ≤ 300 MWe per unit (World Nuclear Association, 23 Okt 2026) |',
    '| "Solusi paling realistis saat ini" | OPINI; "saat ini" belum tepat | Belum ada SMR yang menyuplai data center; target pertama 2030 (NNN, 1 Okt 2026) |', '| Aman | Klaim pengembang | WNA, 23 Okt 2026 |', '| Bersih tanpa emisi | Hampir nol, bukan nol | 5–6 g CO2e/kWh (UNECE via ANS, 30 Nov 2021) |', '',
    `## 3. File mentah`, `Kamera mulai ${(an.offsetMs / 1000).toFixed(3)} s sebelum perekam; ${an.phrases.length} frasa; master 1080×1920 30 fps dengan suara perekam.`, '',
    '## 4. Rencana edit', 'Hook full screen → kartu ilustrasi 3 s (klip EBS tidak bisa diunduh) → 5 adegan penjelasan dengan bubble → pertanyaan + hold 1,2 s → CTA → poster 3,5 s.', '',
    '## 5. Tabel potongan', '| # | Waktu rekaman (s) | Durasi | Kata |', '|---|---|---|---|', ...cuts.map(row), '', `Dibuang: ${(an.dropped ?? []).map((d) => `${(d.startMs / 1000).toFixed(1)}–${(d.endMs / 1000).toFixed(1)} (${d.reason})`).join(', ')}`, '',
    '## 6. Cover', 'Kata hook "GOKIL!", wajah dari take pembuka dengan mata terbuka, pil "stabil 24 jam" dan "target pertama: 2030".', '',
    '## 7. Pemeriksaan & item terbuka', '- Klip EBS asli: kirim potongan 03:40–03:48 bila ingin dipakai.', '- Kata cover bisa diganti.', '', 'PRD siap.'].join('\n');
}
/** The Editor stand-in's talking-head VideoSpec: one scene per cut (by the cut's own words), blocks only from the PRD facts. */
function buildSpec(an, cuts, ids) {
  const find = (re) => cuts.find((c) => re.test(c.text))?.id;
  const hook = find(/kenapa raksasa/i), h24 = find(/butuh pasokan/i), smr = find(/paling realistis/i), small = find(/yaitu reaktor|skala kecil/i), clean = find(/mampu menghasilkan|energi bersih/i), trump = find(/inilah alasan|kartu truf/i), question = find(/setuju/i), cta = find(/DM aku|link ada di bio|solusi data (center|senter)/i);
  const S = (text) => ({ kind: 'source', text });
  const scenes = [
    { role: 'talk', cut: hook, zoom: { from: 1.12, to: 1.2 }, keywords: ['nuklir mini'], pops: [{ say: 'teknologi' }, { say: 'listrik' }, { say: 'nuklir' }], blocks: [
      { kind: 'heading', text: 'Big tech berlomba ke nuklir mini?', at: { ms: 0 } },
      { kind: 'chip', icon: 'chip-ai', text: 'raksasa teknologi', at: { say: 'teknologi' }, sfx: 'pop' }, { kind: 'chip', icon: 'bolt', text: 'listrik', at: { say: 'listrik' }, sfx: 'pop' }, { kind: 'chip', icon: 'reactor', text: 'nuklir mini', at: { say: 'nuklir' }, sfx: 'pop' }] },
    { role: 'card', durationMs: 3000, heading: 'Video EBS', tag: 'ilustrasi · bukan cuplikan asli', blocks: [
      { kind: 'browser-card', urlText: 'youtube.com · EBS', title: 'SMR di dekat data center AI', fromLabel: '03:40', toLabel: '03:48', progress: 1, caption: 'topik video: SMR di dekat data center AI', inner: 'reactor-datacenter', at: { ms: 0 }, sfx: 'tick' },
      S('EBS (YouTube) · cuplikan 03:40–03:48 belum diverifikasi · ilustrasi · dicek 30 Okt 2026')] },
    { role: 'explain', cut: h24, heading: 'Listrik AI harus nyala 24 jam', blocks: [
      { kind: 'tag', text: 'IEA: listrik data center dunia naik lebih dari 2×, ≈ 945 TWh pada 2030', tone: 'info', at: { say: 'raksasa' }, sfx: 'pop' },
      { kind: 'day-strip', hours: [0, 6, 12, 18, 24], strip: [{ label: 'pembangkit nuklir', fromH: 0, toH: 24, icon: 'reactor' }, { label: 'panel surya (tanpa baterai)', fromH: 6, toH: 18, icon: 'sun' }], note: 'cuaca & waktu', at: { say: '24' }, sfx: 'rise' },
      { kind: 'chip', icon: 'check', text: 'stabil siang & malam', tone: 'positive', at: { say: 'nonstop' }, sfx: 'ding' },
      { kind: 'chip', icon: 'cloud', text: 'cuaca & waktu', tone: 'warn', at: { say: 'cuaca' }, sfx: 'pop' },
      S('Alasan perusahaan: listrik bebas karbon 24/7 · Google 14 Okt 2024 · IEA via APPA 11 Apr 2025 · dicek 30 Okt 2026')] },
    { role: 'explain', cut: smr, heading: 'Solusi paling realistis?', blocks: [
      { kind: 'tag', text: 'OPINI', tone: 'opinion', at: { say: 'realistis' }, sfx: 'pop' },
      { kind: 'icon', icon: 'reactor', at: { say: 'adalah' } },
      { kind: 'rows', at: { say: 'Small' }, sfx: 'rise', rows: [{ badge: 'S', title: 'Small', sub: 'skala kecil' }, { badge: 'M', title: 'Modular', sub: 'dibuat per modul di pabrik' }, { badge: 'R', title: 'Reactor', sub: 'reaktor nuklir' }] },
      { kind: 'note', text: 'saat ini: belum ada SMR yang menyuplai data center', tone: 'warning', at: { say: 'Reactor' }, sfx: 'click' },
      S('Definisi: World Nuclear Association (diperbarui 23 Okt 2026) · ilustrasi · dicek 30 Okt 2026')] },
    { role: 'explain', cut: small, heading: 'Reaktor skala kecil', blocks: [
      { kind: 'stat', value: '≤ 300 MWe', label: 'per unit (umumnya)', at: { say: 'kecil' }, sfx: 'pop' },
      { kind: 'chip', icon: 'shield', text: 'aman?', tone: 'warn', at: { say: 'aman' }, sfx: 'ding' }, { kind: 'tag', text: 'klaim pengembang: sistem keselamatan pasif', tone: 'warn', at: { say: 'aman' } },
      { kind: 'chip', icon: 'data-center', text: 'dekat data center', at: { say: 'dibangun' }, sfx: 'pop' },
      { kind: 'note', text: 'rencana · tetap butuh jaringan listrik', tone: 'warning', at: { say: 'lokasi' }, sfx: 'click' },
      S('World Nuclear Association 23 Okt 2026 · Nuclear News Network 1 Okt 2026 · ilustrasi · dicek 30 Okt 2026')] },
    { role: 'explain', cut: clean, heading: 'Energi bersih, emisi sangat rendah', blocks: [
      { kind: 'bars', at: { say: 'bersih' }, sfx: 'rise', bars: [{ label: 'nuklir', value: 5.5, unit: 'g/kWh', tone: 'positive' }, { label: 'angin lepas pantai', value: 12, unit: 'g/kWh' }, { label: 'surya skala besar', value: 48, unit: 'g/kWh', tone: 'warning' }] },
      { kind: 'tag', text: 'bukan nol, tapi sangat rendah', tone: 'warn', at: { say: 'karbon' }, sfx: 'pop' },
      { kind: 'note', text: 'satu SMR ≤ 300 MWe; Kairos Hermes 2 = 50 MW', at: { say: 'jumlah' }, sfx: 'pop' },
      S('UNECE & IPCC via ANS (30 Nov 2021) · WNA 23 Okt 2026 · NNN 1 Okt 2026 · ilustrasi bar · dicek 30 Okt 2026')] },
    { role: 'explain', cut: trump, heading: 'Kesepakatan raksasa teknologi', blocks: [
      { kind: 'rows', at: { say: 'alasan' }, sfx: 'rise', rows: [{ badge: 'G', title: 'Google · Kairos', sub: 'hingga 500 MW', right: '2030', rightSub: 'reaktor pertama' }, { badge: 'A', title: 'Amazon · X-energy', sub: '± 320 MW', right: 'awal 2030-an', rightSub: 'fase 1', tone: 'warn' }, { badge: 'M', title: 'Meta · Oklo', sub: 'hingga 1.200 MW', right: '2030', rightSub: 'fase 1', tone: 'info' }] },
      { kind: 'note', text: 'perjanjian & kerangka kerja, bukan pembelian pembangkit jadi', at: { say: 'nuklir' } },
      { kind: 'tag', text: 'Belum ada SMR yang menyuplai data center. Target pertama: 2030', tone: 'negative', at: { say: 'jadi' }, sfx: 'ding' },
      { kind: 'icon', icon: 'card-ace', at: { say: 'kartu' }, sfx: 'pop' },
      S('Google 14 Okt 2024 · Amazon 16 Okt 2024 · Meta Jan 2026 & status (NNN 1 Okt 2026) · dicek 30 Okt 2026')] },
    { role: 'explain', cut: question, heading: 'AI masa depan ditenagai nuklir?', blocks: [
      { kind: 'icon', icon: 'chip-ai', at: { ms: 0 } }, { kind: 'icon', icon: 'reactor', at: { ms: 200 }, sfx: 'pop' },
      { kind: 'tag', text: 'OPINI', tone: 'opinion', at: { say: 'setuju' } },
      { kind: 'chip', icon: 'check', text: '+ stabil 24 jam, emisi sangat rendah', tone: 'positive', at: { say: 'masa' }, sfx: 'pop' },
      { kind: 'chip', icon: 'warning', text: '? biaya & waktu bangun belum teruji', tone: 'warn', at: { say: 'nuklir' }, sfx: 'ding' },
      { kind: 'note', text: 'contoh: proyek NuScale–UAMPS (AS) dibatalkan 8 Nov 2023 (POWER)', at: { say: 'nuklir' } },
      S('POWER 8 Nov 2023 · NNN 1 Okt 2026 · dicek 30 Okt 2026')] },
    { role: 'hold', durationMs: 1200 },
    { role: 'talk', cut: cta, zoom: { from: 1.28, to: 1.36 }, keywords: ['solusi data center'], pops: [{ say: 'solusi' }], blocks: [
      { kind: 'heading', text: 'Butuh solusi data center?', at: { say: 'solusi' }, sfx: 'pop' },
      { kind: 'typing-box', text: 'solusi data center', prefixBadge: 'DM', typing: true, at: { say: 'DM' }, sfx: 'tick' },
      { kind: 'chip', icon: 'globe', text: 'link di bio', at: { say: 'bio' }, sfx: 'pop' }] },
    { role: 'poster', imageAssetId: ids.poster, scale: 0.78, handle: '@septianusanggaw', durationMs: 3500 },
  ];
  return {
    title: 'SMR: nuklir mini buat listrik AI', ratio: '9:16', fps: 30, language: 'id', maxDurationMs: 60000,
    talkingHead: { masterAssetId: ids.master, voiceAssetId: ids.master },
    captions: { from: 'analysis', keywords: [{ words: ['stabil', 'bersih', 'solusi', 'nonstop'], colour: '#4DD4C4' }, { words: ['cuaca', 'realistis'], colour: '#FFA94D' }], yU: 1455, fontSizeU: 68, maxWords: 3 },
    music: { mood: 'calm', volume: 0.3, liftOverSilent: 1.5, fadeInMs: 500, fadeOutMs: 2500 }, sfx: { enabled: true, level: 0.55 }, sourceTagYU: 1285,
    credits: ['Google: new nuclear energy agreement with Kairos Power — https://blog.google/outreach-initiatives/sustainability/google-kairos-power-nuclear-energy-agreement/ (14 Oct 2024)',
      'Amazon: small modular reactors and X-energy — https://www.aboutamazon.com/news/sustainability/amazon-nuclear-small-modular-reactor-net-carbon-zero (16 Oct 2024)',
      'Nuclear News Network: nuclear power for data centers — https://www.nuclearnewsnetwork.com/news/nuclear-power-data-centers-explained (1 Oct 2026)',
      'World Nuclear Association: small nuclear power reactors — https://world-nuclear.org/information-library/nuclear-fuel-cycle/nuclear-power-reactors/small-nuclear-power-reactors.aspx (23 Oct 2026)',
      'APPA (IEA): data center electricity demand — https://www.publicpower.org/periodical/article/electricity-demand-data-centers-worldwide-set-more-double-2030-iea (11 Apr 2025)',
      'ANS (UNECE/IPCC): life-cycle emissions — https://www.ans.org/news/article-3470/study-new-uk-nuclear-likely-to-be-lower-carbon-source-than-solar-or-wind (30 Nov 2021)',
      'POWER: UAMPS and NuScale terminate SMR project — https://www.powermag.com/uamps-and-nuscale-power-terminate-smr-nuclear-project/ (8 Nov 2023)',
      'Poster kelas: cta-class.png (diunggah Creator, tidak diubah)'],
    cover: { cutId: hook, hookWord: 'GOKIL!', kicker: 'SMR · LISTRIK AI', line: 'Big tech berlomba ke nuklir', subline: 'NUKLIR MINI BUAT AI', pills: [{ text: 'stabil 24 jam', tone: 'positive' }, { text: 'target pertama: 2030', tone: 'warn' }], icons: ['atom', 'chip-ai', 'bolt'], source: 'Google · Amazon · NNN 1 Okt 2026 · dicek 30 Okt 2026', handle: '@septianusanggaw' },
    scenes,
  };
}
