import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelDef } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import { createEgress } from '../../src/services/egress.js';
import { generatorsServiceOf, type GeneratorEngines } from '../../src/s2/generators-service.js';
import { modelsServiceOf } from '../../src/s2/models-service.js';
import { FIXTURES, ffmpeg, hasFfmpeg, json, startS2, wavBuffer, type S2Service } from './harness.js';

const blob = crypto.randomBytes(300_000);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const def = (key: string, over: Partial<ModelDef> = {}, content = blob): ModelDef => ({
  key, label: `Test ${key}`, engine: 'sherpa-onnx', task: 'tts', version: 't1', availability: 'download',
  files: [{ name: 'voice.onnx', bytes: content.length, bytesExact: true, sha256: sha(content), url: `https://huggingface.co/test/resolve/abc/${key}.onnx`, revision: 'abc' }],
  bytes: content.length, licence: { name: 'MIT', url: 'https://example.org/mit', redistribution: 'yes' }, commercialUse: 'yes', languages: ['id'], minTier: 'T0',
  recommendedFor: ['T0'], ramBytes: 0, flag: null, priority: 'P1', notes: [], ...over,
});
type ModelDto = { key: string; status: string; bytesDone: number; errorCode: string | null };
type GenJob = { id: string; status: string; errorCode: string | null; resultAssetId: string | null; result: Record<string, unknown> | null };

describe('Model Manager (R-140…R-144) through the egress module', () => {
  let s: S2Service; let fetched: string[] = []; let slow = false;
  const REG = [def('voice-ok'), def('voice-bad', {}, crypto.randomBytes(1000)), def('voice-slow'), { ...def('unpinned'), files: [{ ...def('unpinned').files[0]!, sha256: 'TO_PIN' }] }];
  beforeAll(async () => {
    s = await startS2([health, createModelsModule({ registry: () => REG, freeBytes: async () => 1e12 })]);
    s.ctx.egress = createEgress({ isPrivate: () => s.ctx.settings.get().privateMode, impl: (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u); fetched.push(url);
      if (url.includes('voice-slow')) {
        const sig = init?.signal as AbortSignal | undefined;
        const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(blob.subarray(0, 1000)); slow = true; sig?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }); } });
        return new Response(stream, { status: 200, headers: { 'content-length': String(blob.length) } });
      }
      return new Response(blob, { status: 200, headers: { 'content-length': String(blob.length) } });
    }) as typeof fetch });
  });
  afterAll(async () => { await s.close(); });

  it('lists models with tier and disk; installs, verifies the hash and emits model.installed', async () => {
    const list = await json<{ items: ModelDto[]; tier: string; diskFreeBytes: number }>(await s.api('/models'));
    expect(list.items.map((i) => i.key)).toEqual(REG.map((d) => d.key));
    expect(list.items.every((i) => i.status === 'not-installed')).toBe(true);
    const r = await s.api('/models/voice-ok/install', { method: 'POST' });
    expect(r.status).toBe(202); expect((await json<ModelDto>(r)).status).toBe('downloading');
    const ev = await s.waitEvent((e) => e.name === 'model.installed');
    expect((ev.data['model'] as ModelDto).status).toBe('installed');
    expect((await json<ModelDto>(await s.api('/models/voice-ok'))).status).toBe('installed');
    expect(fetched[0]).toContain('huggingface.co');
    expect((s.ctx.db.prepare("SELECT status FROM models WHERE key = 'voice-ok'").get() as { status: string }).status).toBe('installed');
    expect((await s.api('/models/voice-ok/install', { method: 'POST' })).status).toBe(202);   // already installed → state
  });
  it('a hash mismatch fails with EM-7003; unpinned entries are refused; unknown key 404', async () => {
    await s.api('/models/voice-bad/install', { method: 'POST' });
    const ev = await s.waitEvent((e) => e.name === 'model.failed' && e.data['key'] === 'voice-bad');
    expect(ev.data['code']).toBe('EM-7003');
    expect((await json<ModelDto>(await s.api('/models/voice-bad'))).errorCode).toBe('EM-7003');
    const u = await s.api('/models/unpinned/install', { method: 'POST' });
    expect(u.status).toBe(422); expect((await json<{ error: { code: string } }>(u)).error.code).toBe('EM-7110');
    expect((await s.api('/models/nope/install', { method: 'POST' })).status).toBe(404);
  });
  it('Private Mode blocks downloads with 423 EM-8202 and nothing is fetched', async () => {
    s.ctx.settings.update({ privateMode: true });
    const n = fetched.length;
    const r = await s.api('/models/voice-slow/install', { method: 'POST' });
    expect(r.status).toBe(423); expect((await json<{ error: { code: string } }>(r)).error.code).toBe('EM-8202');
    expect(fetched.length).toBe(n);
    s.ctx.settings.update({ privateMode: false });
  });
  it('FR-161: Private Mode pauses a running download with EM-7006 and resumes it automatically when turned off', async () => {
    slow = false;
    await s.api('/models/voice-slow/install', { method: 'POST' });
    for (let i = 0; i < 100 && !slow; i++) await new Promise((r) => setTimeout(r, 20));
    s.ctx.settings.update({ privateMode: true });
    const ev = await s.waitEvent((e) => e.name === 'model.failed' && e.data['key'] === 'voice-slow' && e.data['code'] === 'EM-7006');
    expect(ev.data['paused']).toBe(true);
    const paused = await json<ModelDto>(await s.api('/models/voice-slow'));
    expect(paused.status).toBe('not-installed'); expect(paused.errorCode).toBe('EM-7006');
    const n = fetched.length;
    s.ctx.settings.update({ privateMode: false });
    for (let i = 0; i < 100 && fetched.length === n; i++) await new Promise((r) => setTimeout(r, 20));
    expect(fetched.length).toBeGreaterThan(n);
    expect((await json<ModelDto>(await s.api('/models/voice-slow'))).status).toBe('downloading');
    await s.api('/models/voice-slow/cancel', { method: 'POST' });
  });
  it('cancel keeps the partial file; a second install while downloading is 409 EM-7104; delete removes weights', async () => {
    await s.api('/models/voice-slow/install', { method: 'POST' });
    expect((await s.api('/models/voice-slow/install', { method: 'POST' })).status).toBe(409);
    await new Promise((r) => setTimeout(r, 150));
    const c = await json<ModelDto>(await s.api('/models/voice-slow/cancel', { method: 'POST' }));
    expect(c.status).toBe('not-installed'); expect(c.bytesDone).toBeGreaterThan(0);
    expect((await s.api('/models/voice-ok', { method: 'DELETE' })).status).toBe(204);
    expect((await json<ModelDto>(await s.api('/models/voice-ok'))).status).toBe('not-installed');
  });
});

describe('generators (R-130…R-133) with fake engines', () => {
  let s: S2Service; let pid: string; let calls: string[] = []; let gate: Promise<void> = Promise.resolve();
  const voiceDef = def('piper-test');
  const imageDef = def('sd15-emaonly', { engine: 'stable-diffusion.cpp', task: 'image', files: [{ ...def('x').files[0]!, name: 'model.safetensors' }] });
  let pngN = 0;
  const engines: Partial<GeneratorEngines> = {
    image: async (i, c) => { const p = path.join(c.jobDir, `img-${++pngN}.png`); ffmpeg(['-ss', String(pngN * 0.3), '-i', path.join(FIXTURES, 'clip-a.mp4'), '-frames:v', '1', p]); c.onProgress(1); return { pngPath: p }; },
    voice: async (i, c) => { calls.push(`voice:${i.text}`); await gate; if (c.signal.aborted) throw new Error('aborted'); c.onProgress(0.5); const p = path.join(c.jobDir, 'out.wav'); fs.writeFileSync(p, wavBuffer(800)); return { wavPath: p }; },
  };
  beforeAll(async () => {
    s = await startS2([health, createAssetsModule(), createModelsModule({ registry: () => [voiceDef, imageDef], freeBytes: async () => 1e12 }), createGeneratorsModule({ engines })]);
    pid = s.project();
    // install the fake voice by writing its manifest-backed files through the real installer path
    s.ctx.egress = createEgress({ isPrivate: () => false, impl: (async () => new Response(blob, { status: 200 })) as unknown as typeof fetch });
    await modelsServiceOf(s.ctx).install('piper-test'); await modelsServiceOf(s.ctx).idle();
  });
  afterAll(async () => { await s.close(); });
  const gen = (kind: string, body: Record<string, unknown>) => s.api(`/projects/${pid}/generators/${kind}`, { method: 'POST', json: body });
  const final = (id: string) => new Promise<GenJob>((res) => { const t = setInterval(async () => { const j = await json<GenJob>(await s.api(`/generator-jobs/${id}`)); if (['done', 'failed', 'cancelled'].includes(j.status)) { clearInterval(t); res(j); } }, 30); });

  it('validates per kind: EM-7105 language, EM-7106 text length, EM-7001 model missing with size', async () => {
    expect((await json<{ error: { code: string } }>(await gen('voice', { text: 'Halo', voiceId: 'piper-test', language: 'fr' }))).error.code).toBe('EM-7105');
    expect((await json<{ error: { code: string } }>(await gen('voice', { text: 'a'.repeat(2001), voiceId: 'piper-test', language: 'id' }))).error.code).toBe('EM-7106');
    const missing = await json<{ error: { code: string; details: { modelKey: string } } }>(await gen('music', { prompt: 'santai', durationMs: 10_000 }));
    expect(missing.error.code).toBe('EM-7001'); expect(missing.error.details.modelKey).toBeTruthy();
    expect((await gen('voice', {})).status).toBe(400);
    expect((await s.api(`/projects/${pid}/generators/nope`, { method: 'POST', json: {} })).status).toBe(400);
  });
  it.skipIf(!hasFfmpeg)('voice: runs the engine, registers the audio as an Asset and inserts it via applyOps', async () => {
    const r = await gen('voice', { text: 'Halo semua', voiceId: 'piper-test', language: 'id', atMs: 500, insert: true });
    expect(r.status).toBe(202);
    const j = await final((await json<GenJob>(r)).id);
    expect(j.status).toBe('done'); expect(j.resultAssetId).toBeTruthy();
    const a = await json<{ kind: string; status: string }>(await s.api(`/projects/${pid}/assets/${j.resultAssetId}`));
    expect(a).toMatchObject({ kind: 'audio', status: 'ready' });
    expect(s.applied.at(-1)!.ops[0]).toMatchObject({ op: 'op:audio.addLayer', args: { assetId: j.resultAssetId, atMs: 500 } });
    expect(s.events.some((e) => e.name === 'service.notice' && e.data['kind'] === 'generator' && e.data['jobId'] === j.id && e.data['done'] === true)).toBe(true);
  });
  it.skipIf(!hasFfmpeg)('R-134: a finished job is inserted later without re-running; a second call is idempotent (EM-2308)', async () => {
    const j = await final((await json<GenJob>(await gen('voice', { text: 'Nanti saja', voiceId: 'piper-test', language: 'id', atMs: 0 }))).id);
    expect(j.status).toBe('done');
    const before = s.applied.length;
    const r1 = await json<{ versionId: string; notice?: string }>(await s.api(`/generator-jobs/${j.id}/insert`, { method: 'POST' }));
    expect(r1.versionId).toBeTruthy(); expect(r1.notice).toBeUndefined();
    expect(s.applied.length).toBe(before + 1);
    expect(s.applied.at(-1)!.ops[0]).toMatchObject({ op: 'op:audio.addLayer', args: { assetId: j.resultAssetId } });
    const r2 = await json<{ versionId: string; notice?: string }>(await s.api(`/generator-jobs/${j.id}/insert`, { method: 'POST' }));
    expect(r2).toEqual({ versionId: r1.versionId, notice: 'EM-2308' });
    expect(s.applied.length).toBe(before + 1);
    expect((await s.api('/generator-jobs/01ZZZZZZZZZZZZZZZZZZZZZZZZ/insert', { method: 'POST' })).status).toBe(404);
  });
  it('jobs run one at a time; a queued job can be cancelled; the model is in use while queued (EM-7104)', async () => {
    let open!: () => void; gate = new Promise((r) => { open = r; }); calls = [];
    const a = await json<GenJob>(await gen('voice', { text: 'satu', voiceId: 'piper-test', language: 'id' }));
    const b = await json<GenJob>(await gen('voice', { text: 'dua', voiceId: 'piper-test', language: 'id' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual(['voice:satu']);                                                     // b waits
    expect((await s.api('/models/piper-test', { method: 'DELETE' })).status).toBe(409);
    expect((await json<GenJob>(await s.api(`/generator-jobs/${b.id}/cancel`, { method: 'POST' }))).status).toBe('cancelled');
    await s.api(`/generator-jobs/${a.id}/cancel`, { method: 'POST' });
    open();
    expect((await final(a.id)).status).toBe('cancelled');
    expect(calls).toEqual(['voice:satu']);
    const list = await json<{ items: GenJob[]; total: number }>(await s.api(`/projects/${pid}/generator-jobs`));
    expect(list.total).toBeGreaterThanOrEqual(2);
    gate = Promise.resolve();
  });
  it('hashtags use the connected LLM, record usage and respect Private Mode', async () => {
    const usage: unknown[] = [];
    s.ctx.hooks.providerFor = () => ({ id: 'fake', model: 'fake/model', complete: async () => ({ text: '{"caption":"Kopi pagi terbaik","hashtags":["#kopi","#pagi","not a tag","#ngopi"]}', usage: { model: 'fake/model', inputTokens: 10, outputTokens: 5, costUsd: 0.001, approximate: false } }) });
    s.ctx.hooks.recordUsage = (_p, _a, _r, u) => { usage.push(...u); };
    const j = await final((await json<GenJob>(await gen('hashtags', { language: 'id', platform: 'tiktok', count: 10 }))).id);
    expect(j.status).toBe('done'); expect(j.result).toMatchObject({ caption: 'Kopi pagi terbaik', hashtags: ['#kopi', '#pagi', '#ngopi'] });
    expect(usage).toHaveLength(1);
    s.ctx.settings.update({ privateMode: true });
    const r = await gen('hashtags', { language: 'id', platform: 'tiktok', count: 10 });
    expect(r.status).toBe(423);
    s.ctx.settings.update({ privateMode: false });
  });
  it('R-135 lists the five Generator Cards with priority, enabled state, model, installed state, size and tier hint', async () => {
    type Card = { kind: string; enabled: boolean; priority: string; llm: boolean; tierHint: string; models: Array<{ key: string; installed: boolean; bytes: number }> };
    const { items } = await json<{ items: Card[] }>(await s.api('/generators'));
    expect(items.map((c) => c.kind)).toEqual(['voice', 'music', 'thumbnail', 'captions', 'hashtags']);
    expect(Object.fromEntries(items.map((c) => [c.kind, c.priority]))).toEqual({ voice: 'P1', music: 'P2', thumbnail: 'P2', captions: 'P1', hashtags: 'P1' });
    expect(items.every((c) => c.enabled)).toBe(true);
    expect(items.find((c) => c.kind === 'voice')!.models).toEqual([expect.objectContaining({ key: 'piper-test', installed: true, bytes: blob.length })]);
    expect(items.find((c) => c.kind === 'hashtags')!.llm).toBe(true);
    const t = await startS2([health, createGeneratorsModule({ enabledKinds: ['voice'] })]);
    const cards = (await json<{ items: Card[] }>(await t.api('/generators'))).items;
    expect(cards.filter((c) => c.enabled).map((c) => c.kind)).toEqual(['voice']);
    await t.close();
  });
  it.skipIf(!hasFfmpeg)('FR-103: thumbnail returns 1–4 candidates; the chosen one is saved to Outputs (R-136)', async () => {
    await modelsServiceOf(s.ctx).install('sd15-emaonly'); await modelsServiceOf(s.ctx).idle();
    const j = await final((await json<GenJob>(await gen('thumbnail', { prompt: 'kopi pagi', count: 3 }))).id);
    expect([j.status, j.errorCode]).toEqual(['done', null]);
    const cands = (j.result!['candidates'] as Array<{ assetId: string }>);
    expect(cands).toHaveLength(3);
    const out = await s.api(`/generator-jobs/${j.id}/save-output`, { method: 'POST', json: { assetId: cands[1]!.assetId } });
    expect(out.status).toBe(200);
    const o = await json<{ kind: string; path: string; fileName: string }>(out);
    expect(o.kind).toBe('still'); expect(fs.existsSync(o.path)).toBe(true); expect(o.fileName).toMatch(/thumbnail-\d{8}-\d{4}\.png$/);
    expect((await s.api(`/generator-jobs/${j.id}/save-output`, { method: 'POST', json: { assetId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } })).status).toBe(400);
    expect((s.ctx.db.prepare("SELECT count(*) n FROM outputs WHERE project_id = ? AND kind = 'still'").get(pid) as { n: number }).n).toBe(1);
  });
  it('FR-104: caption text edited in the preview replaces the pages on Insert (R-134 body.pages)', async () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FCP';
    const pages = [{ text: 'halo dunia', startMs: 0, durationMs: 1000, tokens: [{ text: 'halo', fromMs: 0, toMs: 500 }, { text: 'dunia', fromMs: 500, toMs: 1000 }] }];
    s.ctx.db.prepare("INSERT INTO generator_jobs (id, project_id, kind, input_json, status, progress, result_json, created_at) VALUES (?, ?, 'captions', '{}', 'done', 1, ?, ?)")
      .run(id, pid, JSON.stringify({ pages, proposedOps: [{ op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages } }] }), new Date().toISOString());
    const edited = [{ ...pages[0]!, text: 'Halo, Dunia!', tokens: [{ text: 'Halo,', fromMs: 0, toMs: 500 }, { text: 'Dunia!', fromMs: 500, toMs: 1000 }] }];
    const r = await s.api(`/generator-jobs/${id}/insert`, { method: 'POST', json: { pages: edited } });
    expect(r.status).toBe(200);
    expect(s.applied.at(-1)!.ops[0]).toMatchObject({ op: 'op:caption.setPages', args: { pages: edited } });
  });
  it('FR-108: jobs older than 7 days leave the Generated list; R-137 deletes one; R-131 filters by kind', async () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    s.ctx.db.prepare("INSERT INTO generator_jobs (id, project_id, kind, input_json, status, created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5OLD', ?, 'music', '{}', 'done', ?)").run(pid, old);
    s.ctx.db.prepare("INSERT INTO generator_jobs (id, project_id, kind, input_json, status, created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5NEW', ?, 'music', '{}', 'done', ?)").run(pid, new Date().toISOString());
    const list = await json<{ items: GenJob[] }>(await s.api(`/projects/${pid}/generator-jobs?kind=music`));
    expect(list.items.map((j) => j.id)).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5NEW']);
    expect((await s.api('/generator-jobs/01ARZ3NDEKTSV4RRFFQ69G5NEW', { method: 'DELETE' })).status).toBe(204);
    expect((await s.api('/generator-jobs/01ARZ3NDEKTSV4RRFFQ69G5NEW')).status).toBe(404);
    expect((await s.api('/generator-jobs/01ARZ3NDEKTSV4RRFFQ69G5NEW', { method: 'DELETE' })).status).toBe(404);
  });
  it('a build without a kind answers EM-9004; interrupted jobs fail on start', async () => {
    const t = await startS2([health, createGeneratorsModule({ enabledKinds: [] })]);
    const p = t.project();
    const r = await t.api(`/projects/${p}/generators/voice`, { method: 'POST', json: { text: 'x', voiceId: 'v', language: 'id' } });
    expect(r.status).toBe(422); expect((await json<{ error: { code: string; details: { feature: string } } }>(r)).error).toMatchObject({ code: 'EM-9004', details: { feature: 'generator.voice' } });
    t.ctx.db.prepare("INSERT INTO generator_jobs (id, project_id, kind, input_json, status, created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', ?, 'voice', '{}', 'running', ?)").run(p, new Date().toISOString());
    expect(generatorsServiceOf(t.ctx).recover()).toBe(1);
    await t.close();
  });
});
