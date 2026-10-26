// QA 2026-10-25 (Windows, T0): captions at the element's timeline position (13), thumbnails without an image model (14),
// engine failures in the engine log (all), and the Piper voice path handed to sherpa-onnx (10–12).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, type CompositionModelT } from '@expertmotion/composition-model';
import { EmError } from '@expertmotion/shared';
import { registry, type ModelDef } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import { createEgress } from '../../src/services/egress.js';
import { createLogger } from '../../src/services/logger.js';
import { getEngineLog, setEngineLog } from '../../src/s2/proc.js';
import { audioPlacements, placePages, type GeneratorEngines } from '../../src/s2/generators-service.js';
import { modelsServiceOf } from '../../src/s2/models-service.js';
import { tempDir } from '../helpers.js';
import { FIXTURES, ffmpeg, hasFfmpeg, json, startS2, wavBuffer, type S2Service } from './harness.js';

let n = 0;
const newId = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++n).padStart(4, '0')}`;
const page = (startMs: number, text = `p${startMs}`) => ({ text, startMs, durationMs: 1000, tokens: [{ text, fromMs: startMs, toMs: startMs + 1000 }] });

/** A Sequence with one video clip (trim 1 s, 4 s long, rate 2 after the op) and a voice layer at 11 s trimmed by 2 s. */
function model(): CompositionModelT {
  const base = { ...createEmptyModel('P', { autoRatio: true, ratio: '16:9', resolution: '720p', fps: 30 }), durationPolicy: 'fixed' as const, fixedDurationMs: 40_000 };
  const r = applyOperations(base, [
    { op: 'op:clip.insert', args: { assetId: 'V1', trimBeforeMs: 1000, durationMs: 4000 } },
    { op: 'op:audio.addLayer', args: { assetId: 'A1', atMs: 11_000, volume: 1, role: 'voice' } },
    { op: 'op:audio.addBed', target: { kind: 'project' }, args: { assetId: 'A2', volume: 0.2, loop: true } },
  ] as never, { assets: [{ id: 'V1', kind: 'video', status: 'ready', durationMs: 10_000, hasAudio: true, width: 1280, height: 720 }, { id: 'A1', kind: 'audio', status: 'ready', durationMs: 20_000, hasAudio: true }, { id: 'A2', kind: 'audio', status: 'ready', durationMs: 30_000, hasAudio: true }], tier: 'T0', newId });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const m = r.value.model;
  m.tracks.video[0]!.playbackRate = 2;
  m.tracks.audio.find((a) => a.assetId === 'A1')!.trimBeforeMs = 2000;
  return m;
}
const durations: Record<string, number> = { V1: 10_000, A1: 20_000, A2: 30_000 };

describe('FR-104 caption placement on the timeline (QA 13)', () => {
  it('an audio layer at 11 s with a 2 s trim: source 3 s → timeline 12 s; before the trim is dropped; window = source length after trim', () => {
    const m = model();
    const [a1] = audioPlacements(m, (id) => durations[id] ?? null, { assetId: 'A1' });
    expect(a1).toMatchObject({ assetId: 'A1', fromMs: 11_000, toMs: 29_000, trimBeforeMs: 2000, playbackRate: 1 });
    const pages = placePages([page(1000), page(3000), page(21_500)], [a1!]);
    expect(pages.map((p) => (p as { startMs: number }).startMs)).toEqual([12_000]);   // 1 s is before the trim, 21.5 s is past the 18 s that play
    expect((pages[0] as { tokens: Array<{ fromMs: number }> }).tokens[0]!.fromMs).toBe(12_000);
  });
  it('a clip with trim and playback rate 2: source 3 s → (3 − 1) / 2 = 1 s on the timeline, clipped to the clip window', () => {
    const [v] = audioPlacements(model(), (id) => durations[id] ?? null, { assetId: 'V1' });
    expect(v).toMatchObject({ fromMs: 0, toMs: 4000, trimBeforeMs: 1000, playbackRate: 2 });
    expect(placePages([page(3000)], [v!])).toEqual([{ text: 'p3000', startMs: 1000, durationMs: 500, tokens: [{ text: 'p3000', fromMs: 1000, toMs: 1500 }] }]);
  });
  it('Sequence mode hears unmuted clips and non-bed layers; a muted clip and the music bed are left out', () => {
    const m = model();
    expect(audioPlacements(m, (id) => durations[id] ?? null).map((p) => p.assetId)).toEqual(['V1', 'A1']);
    m.tracks.video[0]!.muted = true;
    expect(audioPlacements(m, (id) => durations[id] ?? null).map((p) => p.assetId)).toEqual(['A1']);
    // the Creator chose this Asset explicitly: a muted placement still counts
    expect(audioPlacements(m, (id) => durations[id] ?? null, { assetId: 'V1' })).toHaveLength(1);
  });
});

describe('generators against the real service (QA 13, 14, engine log)', () => {
  let s: S2Service; let pid: string; let logDir: string; let prevLog: ReturnType<typeof getEngineLog>;
  const blob = crypto.randomBytes(1000);
  const sha = crypto.createHash('sha256').update(blob).digest('hex');
  const file = (name: string, key: string) => ({ name, bytes: blob.length, bytesExact: true, sha256: sha, url: `https://huggingface.co/test/resolve/abc/${key}/${name}`, revision: 'abc' });
  const base = { version: 't1', availability: 'download' as const, licence: { name: 'MIT', url: 'https://example.org/mit', redistribution: 'yes' as const }, commercialUse: 'yes' as const, languages: ['id' as const],
    minTier: 'T0' as const, recommendedFor: ['T0' as const], ramBytes: 0, flag: null, priority: 'P1' as const, notes: [] };
  const sttDef: ModelDef = { ...base, key: 'whisper-small', label: 'whisper test', engine: 'whisper.cpp', task: 'stt', files: [file('ggml-small.bin', 'w')], bytes: blob.length };
  const sdDef: ModelDef = { ...base, key: 'sd15-emaonly', label: 'sd test', engine: 'stable-diffusion.cpp', task: 'image', files: [file('model.safetensors', 'sd')], bytes: blob.length };
  const calls: string[] = [];
  const engines: Partial<GeneratorEngines> = {
    captions: async (i) => { calls.push(`captions:${path.basename(i.wavPath)}`); return { pages: path.basename(i.wavPath) === 'in.wav' ? [page(1000), page(3000)] : [page(1000)], language: 'id' }; },
    frame: async (i) => { calls.push(`frame:${i.frameMs}`); ffmpeg(['-i', path.join(FIXTURES, 'clip-a.mp4'), '-frames:v', '1', i.outPath]); },
    image: async () => { calls.push('image'); throw new Error('sd-cli must not run'); },
    voice: async () => { throw new EmError('EM-7101', 'sherpa-onnx stopped unexpectedly', { details: { engine: 'sherpa-onnx', cause: 'exit', exitCode: 255, signal: null,
      stderrTail: ["offline-tts-vits-model.cc:Init:169 'sample_rate' does not exist in the metadata"] } }); },
  };
  const mkAsset = (kind: 'audio' | 'video', name: string, ms: number): string => {
    const id = newId(); const dir = path.join(s.ctx.paths.media, pid, id); fs.mkdirSync(dir, { recursive: true });
    const f = kind === 'audio' ? 'original.wav' : 'original.mp4';
    if (kind === 'audio') fs.writeFileSync(path.join(dir, f), wavBuffer(ms)); else fs.copyFileSync(path.join(FIXTURES, 'clip-a-audio.mp4'), path.join(dir, f));
    const now = new Date().toISOString();
    s.ctx.db.prepare(`INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, playable_path, duration_ms, width, height, has_audio, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'ready',?,?)`).run(id, pid, kind, name, crypto.randomBytes(32).toString('hex'), 10, `${pid}/${id}/${f}`, `${pid}/${id}/${f}`, ms, kind === 'video' ? 1280 : null, kind === 'video' ? 720 : null, now, now);
    return id;
  };
  const final = (id: string) => new Promise<{ status: string; errorCode: string | null; result: Record<string, unknown> | null }>((res) => {
    const t = setInterval(async () => { const j = await json<{ status: string; errorCode: string | null; result: Record<string, unknown> | null }>(await s.api(`/generator-jobs/${id}`)); if (['done', 'failed', 'cancelled'].includes(j.status)) { clearInterval(t); res(j); } }, 30);
  });
  const gen = async (kind: string, body: Record<string, unknown>) => s.api(`/projects/${pid}/generators/${kind}`, { method: 'POST', json: body });

  beforeAll(async () => {
    const voiceDef: ModelDef = { ...base, key: 'piper-id-news-medium', label: 'piper test', engine: 'sherpa-onnx', task: 'tts', files: [file('v.onnx', 'p')], bytes: blob.length };
    s = await startS2([health, createAssetsModule(), createModelsModule({ registry: () => [sttDef, sdDef, voiceDef, registry['frame-composite']!], freeBytes: async () => 1e12 }), createGeneratorsModule({ engines })]);
    pid = s.project();
    s.ctx.egress = createEgress({ isPrivate: () => false, impl: (async () => new Response(blob, { status: 200 })) as unknown as typeof fetch });
    for (const k of ['whisper-small', 'piper-id-news-medium']) { await modelsServiceOf(s.ctx).install(k); await modelsServiceOf(s.ctx).idle(); }
    logDir = tempDir('em-gen-log-'); prevLog = getEngineLog(); setEngineLog(createLogger(logDir, { prefix: 'engine' }));
  });
  afterAll(async () => { setEngineLog(prevLog); await s.close(); });

  it.skipIf(!hasFfmpeg)('QA 13: captions of an audio layer placed at 11 s start at 12 s (asset mode and Sequence mode)', async () => {
    const aud = mkAsset('audio', 'Reels 14.m4a', 20_000);
    const m = structuredClone(s.heads.get(pid)!.model);
    m.durationPolicy = 'fixed'; m.fixedDurationMs = 40_000;
    m.tracks.audio.push({ id: 'L1', assetId: aud, role: 'voice', atMs: 11_000, lane: 0, trimBeforeMs: 2000, volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0, ducking: null });
    s.version(pid, m);
    const a = await final((await json<{ id: string }>(await gen('captions', { source: 'asset', assetId: aud, language: 'id', modelKey: 'whisper-small' }))).id);
    expect([a.status, a.errorCode]).toEqual(['done', null]);
    expect((a.result!['pages'] as Array<{ startMs: number }>).map((p) => p.startMs)).toEqual([12_000]);
    expect((a.result!['proposedOps'] as Array<{ args: { pages: Array<{ startMs: number }> } }>)[0]!.args.pages[0]!.startMs).toBe(12_000);
    const q = await final((await json<{ id: string }>(await gen('captions', { source: 'sequence', language: 'id', modelKey: 'whisper-small' }))).id);
    expect([q.status, q.errorCode]).toEqual(['done', null]);
    expect((q.result!['pages'] as Array<{ startMs: number }>).map((p) => p.startMs)).toEqual([12_000]);   // the segment is cut at the trim
    expect(calls).toContain('captions:seg-1.wav');
  });

  it('QA 14: R-135 lists "Thumbnail from a Frame" as installed (no download) next to a not-installed image model', async () => {
    const tier = s.ctx.hooks.tier;
    for (const t of ['T0', 'T1'] as const) {      // T1's default (SD 1.5) is not installed: the card offers the frame still instead
      s.ctx.hooks.tier = () => t;
      const card = (await json<{ items: Array<{ kind: string; model: { key: string; installed: boolean } | null }> }>(await s.api('/generators'))).items.find((c) => c.kind === 'thumbnail')!;
      expect(card.model).toMatchObject({ key: 'frame-composite', installed: true });
    }
    s.ctx.hooks.tier = tier;
    const { items } = await json<{ items: Array<{ kind: string; model: { key: string; installed: boolean } | null; models: Array<{ key: string; installed: boolean }> }> }>(await s.api('/generators'));
    const thumb = items.find((c) => c.kind === 'thumbnail')!;
    expect(thumb.model).toMatchObject({ key: 'frame-composite', installed: true });
    expect(Object.fromEntries(thumb.models.map((m) => [m.key, m.installed]))).toEqual({ 'sd15-emaonly': false, 'frame-composite': true });
  });

  it.skipIf(!hasFfmpeg)('QA 14: frame thumbnails work without an image model; sd-cli never runs unless its model is installed', async () => {
    const vid = mkAsset('video', 'clip.mp4', 4000);
    const r = applyOperations(s.heads.get(pid)!.model, [{ op: 'op:clip.insert', args: { assetId: vid } }] as never, { assets: [{ id: vid, kind: 'video', status: 'ready', durationMs: 4000, hasAudio: true, width: 1280, height: 720 }], tier: 'T0', newId });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    s.version(pid, r.value.model);
    calls.length = 0;
    // the sheet's default: frame-composite (a prompt is ignored for it)
    const a = await final((await json<{ id: string }>(await gen('thumbnail', { modelKey: 'frame-composite', prompt: 'kopi pagi', frameMs: 500, titleText: 'Kopi', language: 'id' }))).id);
    expect([a.status, a.errorCode, a.result!['source']]).toEqual(['done', null, 'frame-composite']);
    // no modelKey + a prompt + no image model installed → frame still, not EM-7001 and not sd-cli
    const b = await final((await json<{ id: string }>(await gen('thumbnail', { prompt: 'kopi pagi', language: 'id' }))).id);
    expect([b.status, b.result!['source']]).toEqual(['done', 'frame-composite']);
    expect(calls.filter((c) => c === 'image')).toEqual([]);
    // the image model chosen but not installed → EM-7001 before any job runs
    const c = await gen('thumbnail', { modelKey: 'sd15-emaonly', prompt: 'kopi pagi' });
    expect(c.status).toBe(422); expect((await json<{ error: { code: string } }>(c)).error.code).toBe('EM-7001');
    expect((await gen('thumbnail', { modelKey: 'whisper-small' })).status).toBe(400);
  });

  it('every engine failure lands in the engine log with engine, exit code and the stderr tail', async () => {
    const j = await final((await json<{ id: string }>(await gen('voice', { text: 'Halo semua', voiceId: 'piper-id-news-medium', language: 'id' }))).id);
    expect([j.status, j.errorCode]).toEqual(['failed', 'EM-7101']);
    const f = fs.readdirSync(logDir).find((x) => x.startsWith('engine-'))!;
    const line = fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['msg'] === 'generator engine failed')!;
    expect(line).toMatchObject({ kind: 'voice', engine: 'sherpa-onnx', binary: 'sherpa-onnx', code: 'EM-7101', exitCode: 255, cause: 'exit' });
    expect(line['stderrTail']).toEqual(["offline-tts-vits-model.cc:Init:169 'sample_rate' does not exist in the metadata"]);
  });
});
