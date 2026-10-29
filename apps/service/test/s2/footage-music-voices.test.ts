// Operator 2026-10-29 (automatic video maker first): the Service side of FR-261 / FR-262 (footage read before an Editor run,
// transcripts in AssetFacts, captions of the footage audio with the plan's caption look), FR-266 (music.generate plan step:
// CC0 library track, looped to the video, ducked under speech) and FR-267 … FR-269 (Supertonic local voices, naturalness order
// with one recommended voice, Azure AI Speech and Google Cloud TTS with their documented request shapes, migration 23).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@expertmotion/shared';
import { MUSIC_LIBRARY, registry, type ModelDef } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import { createEgress } from '../../src/services/egress.js';
import { generatorsServiceOf, musicBedOp, type GeneratorEngines } from '../../src/s2/generators-service.js';
import { modelsServiceOf } from '../../src/s2/models-service.js';
import { musicLibraryOf } from '../../src/s2/music-library-service.js';
import { voicesServiceOf } from '../../src/s2/voices-service.js';
import { ingestOf } from '../../src/s2/ingest.js';
import { FIXTURES, hasFfmpeg, json, startS2, wavBuffer, type S2Service } from './harness.js';

const page = (startMs: number, text: string) => ({ text, startMs, durationMs: 1500, tokens: text.split(' ').map((w, k) => ({ text: ` ${w}`, fromMs: startMs + k * 300, toMs: startMs + k * 300 + 280 })) });

describe.skipIf(!hasFfmpeg)('footage read, music plan step, more voices (2026-10-29)', { timeout: 40_000 }, () => {
  let s: S2Service; let pid: string;
  const blob = crypto.randomBytes(1000);
  const sha = crypto.createHash('sha256').update(blob).digest('hex');
  const file = (name: string, key: string) => ({ name, bytes: blob.length, bytesExact: true, sha256: sha, url: `https://huggingface.co/test/resolve/abc/${key}/${name}`, revision: 'abc' });
  const base = { version: 't1', availability: 'download' as const, licence: { name: 'MIT', url: 'https://example.org/mit', redistribution: 'yes' as const }, commercialUse: 'yes' as const, languages: ['id' as const],
    minTier: 'T0' as const, recommendedFor: ['T0' as const], ramBytes: 0, flag: null, priority: 'P1' as const, notes: [] };
  const sttDef: ModelDef = { ...base, key: 'whisper-small', label: 'whisper test', engine: 'whisper.cpp', task: 'stt', files: [file('ggml-small.bin', 'w')], bytes: blob.length };
  const supertonicDef: ModelDef = { ...base, key: 'supertonic-3-int8', label: 'supertonic test', engine: 'sherpa-onnx', task: 'tts', languages: ['id', 'en'], files: [file('vector_estimator.int8.onnx', 'st')], bytes: blob.length };
  const piperDef: ModelDef = { ...base, key: 'piper-id-news-medium', label: 'piper test', engine: 'sherpa-onnx', task: 'tts', files: [file('v.onnx', 'p')], bytes: blob.length };
  const voiceCalls: Array<{ speakerId?: number; language?: string }> = [];
  const engines: Partial<GeneratorEngines> = {
    captions: async () => ({ pages: [page(500, 'halo semua'), page(2000, 'nama saya Rina')], language: 'id' }),
    wordTokens: async () => [],
    voice: async (i, c) => { voiceCalls.push({ ...(i.speakerId !== undefined ? { speakerId: i.speakerId } : {}), ...(i.language ? { language: i.language } : {}) }); const out = path.join(c.jobDir, 'out.wav'); fs.writeFileSync(out, wavBuffer(900, 220, 16000)); return { wavPath: out }; },
  };
  const mkVideo = (name: string): string => {
    const id = newId(); const dir = path.join(s.ctx.paths.media, pid, id); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'clip-a-audio.mp4'), path.join(dir, 'original.mp4'));
    const now = new Date().toISOString();
    s.ctx.db.prepare(`INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, playable_path, duration_ms, width, height, has_audio, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'ready',?,?)`).run(id, pid, 'video', name, crypto.randomBytes(32).toString('hex'), 10, `${pid}/${id}/original.mp4`, `${pid}/${id}/original.mp4`, 4000, 640, 360, now, now);
    return id;
  };
  const final = (id: string) => new Promise<{ status: string; errorCode: string | null; result: Record<string, unknown> | null }>((res) => {
    const t = setInterval(async () => { const j = await json<{ status: string; errorCode: string | null; result: Record<string, unknown> | null }>(await s.api(`/generator-jobs/${id}`)); if (['done', 'failed', 'cancelled'].includes(j.status)) { clearInterval(t); res(j); } }, 30);
  });

  beforeAll(async () => {
    s = await startS2([health, createAssetsModule(), createModelsModule({ registry: () => [sttDef, supertonicDef, piperDef, registry['frame-composite']!], freeBytes: async () => 1e12 }), createGeneratorsModule({ engines })]);
    pid = s.project();
    s.ctx.egress = createEgress({ isPrivate: () => s.ctx.settings.get().privateMode, impl: (async () => new Response(blob, { status: 200 })) as unknown as typeof fetch });
    for (const k of ['whisper-small', 'supertonic-3-int8']) { await modelsServiceOf(s.ctx).install(k); await modelsServiceOf(s.ctx).idle(); }
    ingestOf(s.ctx).checkCapacity = async () => undefined;                   // the shared disk may be below the 500 MB import floor (EM-6005)
  });
  afterAll(async () => { await s.close(); });

  it('FR-262: reading the footage stores what it says in SOURCE time; AssetFacts carry it (segments + words), the timeline is untouched', async () => {
    const v = mkVideo('wawancara.mp4');
    const before = s.applied.length;
    expect(await s.ctx.hooks.readFootage!(pid, [v])).toEqual([v]);
    expect(s.applied.length).toBe(before);                                    // insert: false
    const facts = s.ctx.hooks.assetFacts(pid).find((a) => a.id === v)!;
    expect(facts.transcript?.segments.map((g) => [g.text, g.fromMs])).toEqual([['halo semua', 500], ['nama saya Rina', 2000]]);
    expect(facts.transcript?.words?.find((w) => w.text === 'nama')?.fromMs).toBe(2000);
  });
  it('FR-261: captions of the footage audio (Sequence) come with the plan\'s caption look', async () => {
    const v = mkVideo('kebun.mp4');
    const m = structuredClone(s.heads.get(pid)!.model);
    m.tracks.video.push({ id: 'C1', assetId: v, trimBeforeMs: 0, durationMs: 4000, playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, objectFit: 'cover', motion: null, effects: [] });
    s.version(pid, m);
    generatorsServiceOf(s.ctx).runPlanSteps(pid, 'PLANCAP', [{ n: 2, tool: 'captions.generate', args: { source: 'sequence', presetId: 'preset:caption.karaoke', language: 'id', modelKey: 'whisper-small' }, dependsOn: [1] }]);
    const started = await s.waitEvent((e) => e.name === 'service.notice' && e.data['planId'] === 'PLANCAP' && e.data['status'] === 'started');
    expect((await final(String(started.data['jobId']))).status).toBe('done');
    const ops = s.applied.at(-1)!.ops;
    expect(ops.map((o) => o.op)).toEqual(['op:caption.setPages', 'op:caption.setStyle']);
    expect(ops[1]!.args).toEqual({ presetId: 'preset:caption.karaoke' });
  });
  it('FR-266: a music.generate plan step puts a best-fit CC0 bed under the video, as long as the video, ducked under speech', async () => {
    const lib = musicLibraryOf(s.ctx);
    const track = MUSIC_LIBRARY.find((t) => t.mood === 'calm')!;
    const src = path.join(s.ctx.paths.tmp, 'calm.wav'); fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, wavBuffer(3000, 330, 22050));
    const asked: string[] = [];
    lib.pickFor = async (d: string) => { asked.push(d); return track; };
    lib.readyFile = async () => src;
    generatorsServiceOf(s.ctx).runPlanSteps(pid, 'PLANMUSIC', [{ n: 3, tool: 'music.generate', args: { prompt: 'tenang, akustik', durationMs: 8000, volume: 0.25 }, dependsOn: [1] }]);
    const started = await s.waitEvent((e) => e.name === 'service.notice' && e.data['planId'] === 'PLANMUSIC' && e.data['status'] === 'started');
    const j = await final(String(started.data['jobId']));
    expect([j.status, j.errorCode]).toEqual(['done', null]);
    expect(asked[0]).toMatch(/tenang, akustik/);
    expect(j.result).toMatchObject({ trackId: track.id, cc0: true, durationMs: 8000 });
    const bed = s.applied.at(-1)!.ops.find((o) => o.op === 'op:audio.addBed')!;
    expect(bed.args).toMatchObject({ volume: 0.25, loop: true, duckingPresetId: 'preset:audio.duck-voice', duckingParams: { volume: 0.25, duckTo: 0.088, rampMs: 400 } });
    const layer = s.heads.get(pid)!.model.tracks.audio.find((a) => a.role === 'bed')!;
    expect(layer.ducking).toMatchObject({ presetId: 'preset:audio.duck-voice', params: { volume: 0.25, duckTo: 0.088 } });
    expect(musicBedOp('A1').args).toMatchObject({ volume: 0.2, duckingParams: { volume: 0.2, duckTo: 0.07 } });
  });
  // Real network + real FreePD track (opt-in: EM_REAL_MUSIC=1): download through download.ts with the pinned sha256, loop / fade
  // with the real FFmpeg, one ducked bed. Run once on the shared server for Entry 34 (process.md); skipped in verify.sh.
  it.runIf(process.env['EM_REAL_MUSIC'] === '1')('FR-266 (real): the CC0 library downloads and verifies a calm track and the plan step places it ducked', async () => {
    s.ctx.egress = createEgress({ isPrivate: () => false });
    const lib = musicLibraryOf(s.ctx);
    delete (lib as unknown as Record<string, unknown>)['pickFor']; delete (lib as unknown as Record<string, unknown>)['readyFile'];
    generatorsServiceOf(s.ctx).runPlanSteps(pid, 'PLANREAL', [{ n: 1, tool: 'music.generate', args: { prompt: 'tenang, calm, ambient', durationMs: 12_000 }, dependsOn: [] }]);
    const started = await s.waitEvent((e) => e.name === 'service.notice' && e.data['planId'] === 'PLANREAL' && e.data['status'] === 'started', 60_000);
    const j = await final(String(started.data['jobId']));
    expect([j.status, j.errorCode]).toEqual(['done', null]);
    const t = MUSIC_LIBRARY.find((x) => x.id === j.result!['trackId'])!;
    expect(t.mood).toBe('calm');
    expect(fs.existsSync(path.join(s.ctx.paths.models, 'music-library'))).toBe(true);
    const bed = s.heads.get(pid)!.model.tracks.audio.filter((a) => a.role === 'bed').at(-1)!;
    expect(bed.ducking?.presetId).toBe('preset:audio.duck-voice');
    console.log(JSON.stringify({ realMusic: { track: t.id, title: t.title, bytes: t.bytes, assetDurationMs: s.ctx.hooks.assetFacts(pid).find((a) => a.id === bed.assetId)?.durationMs, ducking: bed.ducking } }));
  }, 120_000);
  it('FR-267: Supertonic speakers are local voices (speaker index + language reach the engine)', async () => {
    const list = await voicesServiceOf(s.ctx).list('id');
    const st = list.filter((v) => v.modelKey === 'supertonic-3-int8');
    expect(st).toHaveLength(10);
    expect(st.every((v) => v.availability === 'ready')).toBe(true);
    const job = await json<{ id: string }>(await s.api(`/projects/${pid}/generators/voice`, { method: 'POST', json: { text: 'Halo dari Supertonic.', voiceId: 'local:supertonic-3-int8:s5', language: 'id' } }));
    expect((await final(job.id)).status).toBe('done');
    expect(voiceCalls.at(-1)).toEqual({ speakerId: 5, language: 'id' });
  });
  it('FR-268: the list is sorted by naturalness among what can run, with ONE recommended voice (cloud neural first when connected)', async () => {
    let list = await voicesServiceOf(s.ctx).list('id');
    expect(list.filter((v) => v.recommended)).toHaveLength(1);
    expect(list.find((v) => v.recommended)!.modelKey).toBe('supertonic-3-int8');           // nothing cloud connected: the best local voice
    const firstNotReady = list.findIndex((v) => v.availability !== 'ready');
    expect(list.slice(firstNotReady).every((v) => v.availability !== 'ready')).toBe(true);
    s.ctx.egress = createEgress({ isPrivate: () => false, impl: (async (u: string) => (String(u).includes('voices/list') ? Response.json([{ ShortName: 'id-ID-GadisNeural' }]) : new Response('x', { status: 404 }))) as unknown as typeof fetch });
    await voicesServiceOf(s.ctx).setAzureKey('0123456789abcdef0123456789abcdef', 'SouthEastAsia');
    list = await voicesServiceOf(s.ctx).list('id');
    expect(list.find((v) => v.recommended)!.id).toMatch(/^azure:dragonhd:/);
    expect(list[0]!.provider).toBe('azure');
    voicesServiceOf(s.ctx).removeVoiceKey('azure');
  });
  it('FR-269: Azure AI Speech and Google Cloud TTS — key checks, documented request shapes, Private Mode, refusals', async () => {
    const out: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const pcm = wavBuffer(800, 300, 24000);
    s.ctx.egress = createEgress({ isPrivate: () => s.ctx.settings.get().privateMode, impl: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input); out.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body: String(init?.body ?? '') });
      if (url === 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/voices/list') return Response.json([{ ShortName: 'id-ID-GadisNeural' }]);
      if (url === 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/v1') return new Response(pcm, { status: 200, headers: { 'content-type': 'audio/wav' } });
      if (url.startsWith('https://texttospeech.googleapis.com/v1/voices')) return (init?.headers as Record<string, string>)['x-goog-api-key'] === 'AIzaBADBADBADBADBADBADBADBADBADBADBAD00' ? Response.json({ error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 }) : Response.json({ voices: [] });
      if (url === 'https://texttospeech.googleapis.com/v1/text:synthesize') return Response.json({ audioContent: pcm.toString('base64') });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch });
    // keys: format checks first, then the documented key check call
    expect((await s.api('/voice-keys/azure', { method: 'PUT', json: { key: '0123456789abcdef0123456789abcdef', region: 'south east asia!' } })).status).toBe(400);
    expect((await s.api('/voice-keys/azure', { method: 'PUT', json: { key: '0123456789abcdef0123456789abcdef', region: 'southeastasia' } })).status).toBe(200);
    expect(out.at(-1)).toMatchObject({ url: 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/voices/list', headers: { 'Ocp-Apim-Subscription-Key': '0123456789abcdef0123456789abcdef' } });
    const bad = await s.api('/voice-keys/google-cloud', { method: 'PUT', json: { key: 'AIzaBADBADBADBADBADBADBADBADBADBADBAD00' } });
    expect((await json<{ error: { code: string; details: { reason: string } } }>(bad)).error).toMatchObject({ code: 'EM-7112', details: { reason: 'key' } });
    expect((await s.api('/voice-keys/google-cloud', { method: 'PUT', json: { key: 'AIzaGOODGOODGOODGOODGOODGOODGOODGOOD00' } })).status).toBe(200);
    const keys = await json<{ azure: { hint: string; region: string }; 'google-cloud': { hint: string } }>(await s.api('/voice-keys'));
    expect(keys.azure.region).toBe('southeastasia');
    expect(JSON.stringify(keys)).not.toContain('0123456789abcdef0123456789abcdef');
    const vl = await json<{ items: Array<{ id: string; availability: string }>; azureKey: string; googleCloudKey: string }>(await s.api('/voices?language=id'));
    expect(vl.items.find((v) => v.id === 'azure:neural:id-ID-Gadis')!.availability).toBe('ready');
    expect(vl.items.find((v) => v.id === 'google:chirp3-hd:Kore')!.availability).toBe('ready');
    expect(vl.azureKey).toMatch(/^…/);
    const run = async (voiceId: string) => {
      const r = await json<{ id?: string; error?: { code: string } }>(await s.api(`/projects/${pid}/generators/voice`, { method: 'POST', json: { text: 'Energi bersih & murah.', voiceId, language: 'id', speed: 1.1 } }));
      return r.id ? final(r.id) : { status: 'refused', errorCode: r.error?.code ?? null, result: null };
    };
    expect((await run('azure:dragonhd:id-ID-Gadis')).status).toBe('done');
    const az = out.find((x) => x.url.endsWith('/cognitiveservices/v1'))!;
    expect(az.headers).toMatchObject({ 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'Expertmotion' });
    expect(az.body).toContain('<voice name="id-ID-Gadis:DragonHDLatestNeural">');
    expect(az.body).toContain('xml:lang="id-ID"');
    expect(az.body).toContain('<prosody rate="+10%">Energi bersih &amp; murah.</prosody>');
    expect((await run('google:chirp3-hd:Kore')).status).toBe('done');
    const gc = out.find((x) => x.url.endsWith('/v1/text:synthesize'))!;
    expect(gc.headers['x-goog-api-key']).toBe('AIzaGOODGOODGOODGOODGOODGOODGOODGOOD00');
    expect(JSON.parse(gc.body)).toEqual({ input: { text: 'Energi bersih & murah.' }, voice: { languageCode: 'id-ID', name: 'id-ID-Chirp3-HD-Kore' }, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: 1.1 } });
    // Private Mode: refused before any request
    const n = out.length;
    s.ctx.settings.update({ privateMode: true });
    expect((await run('azure:neural:id-ID-Ardi')).errorCode).toBe('EM-8202');
    s.ctx.settings.update({ privateMode: false });
    expect(out.length).toBe(n);
    // migration 23: the key table accepts the new providers (and keeps the CHECK)
    expect(() => s.ctx.db.prepare("INSERT INTO voice_keys (provider, secret_enc, secret_hint, created_at, updated_at) VALUES ('other', x'00', 'x', 'n', 'n')").run()).toThrow();
  });
});
