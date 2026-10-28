// QA 2026-10-28 (#7, #8, #9, #10, #11; acceptance prompt "Ekspor Nikel"): voice clips in one request with measured durations,
// captions from the SCRIPT timed by (misheard) recognition, the voice picker (local / cloud / Private Mode), cloud voice request
// shapes, the CC0 music library, held plan steps continuing after a model install (FR-245 … FR-252, ADR-035).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry, type ModelDef } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import { createEgress } from '../../src/services/egress.js';
import { createSecretBox } from '../../src/s3/crypto.js';
import { generatorsServiceOf, type GeneratorEngines } from '../../src/s2/generators-service.js';
import { modelsServiceOf } from '../../src/s2/models-service.js';
import { ingestOf } from '../../src/s2/ingest.js';
import { hasFfmpeg, json, startS2, wavBuffer, type S2Service } from './harness.js';

const SCRIPT = ['Indonesia punya energi bersih.', 'Tapi volumenya turun.', 'Follow untuk fakta energi.'];
const MS_PER_CHAR = 60;

describe.skipIf(!hasFfmpeg)('voice clips, transcripts, voices and music (QA 2026-10-28)', { timeout: 30_000 }, () => {
  let s: S2Service; let pid: string;
  const blob = crypto.randomBytes(1000);
  const sha = crypto.createHash('sha256').update(blob).digest('hex');
  const file = (name: string, key: string) => ({ name, bytes: blob.length, bytesExact: true, sha256: sha, url: `https://huggingface.co/test/resolve/abc/${key}/${name}`, revision: 'abc' });
  const base = { version: 't1', availability: 'download' as const, licence: { name: 'MIT', url: 'https://example.org/mit', redistribution: 'yes' as const }, commercialUse: 'yes' as const, languages: ['id' as const],
    minTier: 'T0' as const, recommendedFor: ['T0' as const], ramBytes: 0, flag: null, priority: 'P1' as const, notes: [] };
  const sttDef: ModelDef = { ...base, key: 'whisper-small', label: 'whisper test', engine: 'whisper.cpp', task: 'stt', files: [file('ggml-small.bin', 'w')], bytes: blob.length };
  const voiceDef: ModelDef = { ...base, key: 'piper-id-news-medium', label: 'piper test', engine: 'sherpa-onnx', task: 'tts', files: [file('v.onnx', 'p')], bytes: blob.length };
  const speeds: Array<number | undefined> = []; let failOn: string | null = null; const outbound: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const engines: Partial<GeneratorEngines> = {
    voice: async (i, c) => {
      speeds.push(i.speed);
      if (failOn && i.text.includes(failOn)) throw Object.assign(new Error('sherpa failed'), { name: 'Error' });
      const out = path.join(c.jobDir, 'out.wav');
      fs.writeFileSync(out, wavBuffer(Math.round((i.text.length * MS_PER_CHAR) / (i.speed ?? 1)), 220, 16000));
      return { wavPath: out };
    },
    // whisper "hears" bersih as besi, and gives contiguous word times over the clip
    wordTokens: async (i) => {
      const dur = i.audioDurationMs; const text = fs.existsSync(i.wavPath) ? lastText : '';
      const words = text.replace('bersih', 'besi').split(' ');
      return words.map((w, k) => ({ text: ` ${w}`, fromMs: Math.round((k * dur) / words.length), toMs: Math.round(((k + 1) * dur) / words.length) }));
    },
  };
  let lastText = '';
  const origVoice = engines.voice!;
  engines.voice = async (i, c) => { lastText = i.text; return origVoice(i, c); };
  const final = (id: string) => new Promise<{ status: string; errorCode: string | null; result: Record<string, unknown> | null }>((res) => {
    const t = setInterval(async () => { const j = await json<{ status: string; errorCode: string | null; result: Record<string, unknown> | null }>(await s.api(`/generator-jobs/${id}`)); if (['done', 'failed', 'cancelled'].includes(j.status)) { clearInterval(t); res(j); } }, 30);
  });

  beforeAll(async () => {
    s = await startS2([health, createAssetsModule(), createModelsModule({ registry: () => [sttDef, voiceDef, registry['frame-composite']!], freeBytes: async () => 1e12 }), createGeneratorsModule({ engines })]);
    pid = s.project();
    s.ctx.egress = createEgress({ isPrivate: () => s.ctx.settings.get().privateMode, impl: (async () => new Response(blob, { status: 200 })) as unknown as typeof fetch });
    await modelsServiceOf(s.ctx).install('whisper-small'); await modelsServiceOf(s.ctx).idle();
    // the shared server's disk may be below the 500 MB import floor (EM-6005); these tests are about voices, not disk space
    ingestOf(s.ctx).checkCapacity = async () => undefined;
  });
  afterAll(async () => { await s.close(); });

  it('FR-252: a plan voice step without its model is held (needs-model notice) and continues after the install', async () => {
    const svc = generatorsServiceOf(s.ctx);
    svc.runPlanSteps(pid, 'PLAN1', [{ n: 1, tool: 'tts.generate', args: { text: 'Halo, ini suara uji.', voice: 'suara natural jelas', language: 'id' }, dependsOn: [] }]);
    const held = await s.waitEvent((e) => e.name === 'service.notice' && e.data['kind'] === 'plan-step' && e.data['status'] === 'needs-model');
    expect(held.data).toMatchObject({ code: 'EM-7001', modelKey: 'piper-id-news-medium', step: 1, held: [1] });
    expect(svc.heldSteps()).toEqual([{ modelKey: 'piper-id-news-medium', projectId: pid, planId: 'PLAN1', steps: [1] }]);
    await modelsServiceOf(s.ctx).install('piper-id-news-medium'); await modelsServiceOf(s.ctx).idle();
    await s.waitEvent((e) => e.name === 'service.notice' && e.data['kind'] === 'plan-step' && e.data['status'] === 'resumed');
    const started = await s.waitEvent((e) => e.name === 'service.notice' && e.data['kind'] === 'plan-step' && e.data['status'] === 'started');
    const j = await final(String(started.data['jobId']));
    expect(j.status).toBe('done');
    expect(svc.heldSteps()).toEqual([]);
  });

  it('FR-251: v1…v3 in one request — assets named after the ids, measured durations, 0.3 s / 0.5 s gaps, cues from the script', async () => {
    const r = await s.api(`/projects/${pid}/generators/voice-batch`, { method: 'POST', json: {
      clips: SCRIPT.map((text, i) => ({ id: `v${i + 1}`, text, ...(i === 1 ? { written: 'Tapi volumenya −3,8%.' } : {}) })), voiceId: 'local:piper-id-news-medium', language: 'id',
      scenes: [['v1', 'v2'], ['v3']], startMs: 1000, insert: true, captions: true } });
    expect(r.status).toBe(202);
    const j = await final((await json<{ id: string }>(r)).id);
    expect([j.status, j.errorCode]).toEqual(['done', null]);
    const clips = j.result!['clips'] as Array<{ id: string; assetId: string; name: string; durationMs: number; atMs: number; endMs: number; timing: string; cues: Array<{ written: string; text: string; fromMs: number; toMs: number }> }>;
    expect(clips.map((c) => c.name)).toEqual(['v1.wav', 'v2.wav', 'v3.wav']);
    expect(clips[0]!.durationMs).toBe(SCRIPT[0]!.length * MS_PER_CHAR);
    expect(clips[1]!.atMs).toBe(clips[0]!.endMs + 300);            // same scene
    expect(clips[2]!.atMs).toBe(clips[1]!.endMs + 500);            // after a scene's last clip
    expect(clips[0]!.atMs).toBe(1000);
    expect(clips[0]!.timing).toBe('aligned');
    expect(clips[0]!.cues.map((c) => c.written).join(' ')).toBe(SCRIPT[0]);   // "bersih", not the recognised "besi"
    expect(clips[1]!.cues[0]!.written).toBe('Tapi volumenya −3,8%.');          // display form …
    expect(clips[1]!.cues[0]!.text).toBe(SCRIPT[1]);                            // … spoken form
    // assets in the Library with names and probed durations (AssetFacts.durationMs for the motion composer)
    const facts = s.ctx.hooks.assetFacts(pid);
    for (const c of clips) expect(facts.find((f) => f.id === c.assetId)).toMatchObject({ kind: 'audio', name: c.name });
    expect(Math.abs((facts.find((f) => f.id === clips[0]!.assetId)!.durationMs ?? 0) - clips[0]!.durationMs)).toBeLessThan(60);
    // inserted as ONE version: 3 voice layers + caption pages at the clip positions
    const head = s.heads.get(pid)!.model;
    const layers = head.tracks.audio.filter((a) => clips.some((c) => c.assetId === a.assetId));
    expect(layers.map((l) => l.atMs)).toEqual(clips.map((c) => c.atMs));
    const pages = head.tracks.caption.pages;
    expect(pages.map((p) => p.text.trim()).join(' ')).toBe(`${SCRIPT[0]} Tapi volumenya −3,8%. ${SCRIPT[2]}`);
    expect(pages[0]!.startMs).toBeGreaterThanOrEqual(1000);
    for (const p of pages) expect(clips.some((c) => p.startMs >= c.atMs && p.startMs + p.durationMs <= c.endMs)).toBe(true);
    // the transcript of each clip: JSON and SRT (R-139)
    const tj = await json<{ cues: Array<{ written: string }>; method: string }>(await s.api(`/projects/${pid}/assets/${clips[0]!.assetId}/transcript`));
    expect(tj.cues.map((c) => c.written).join(' ')).toBe(SCRIPT[0]);
    const srt = await (await s.api(`/projects/${pid}/assets/${clips[0]!.assetId}/transcript?format=srt&offsetMs=1000`)).text();
    expect(srt).toMatch(/^1\n00:00:01,\d{3} --> /);
    expect(srt).toContain('energi bersih');
    // the agent-runtime hook resolves with the same shape
    const viaHook = await s.ctx.hooks.voiceBatch!(pid, { clips: [{ id: 'v9', text: 'Follow septianus angga W.' }], voiceId: 'suara natural', language: 'id' });
    expect(viaHook.clips[0]).toMatchObject({ id: 'v9', name: 'v9.wav' });
    expect(s.ctx.hooks.voiceTranscript!(viaHook.clips[0]!.assetId)!.spoken).toBe('Follow septianus angga W.');
  });

  it('FR-251: longer than maxTotalMs → generated again a little faster (never cut); a failed clip fails the batch and places nothing', async () => {
    speeds.length = 0;
    const before = s.applied.length;
    const r = await s.api(`/projects/${pid}/generators/voice-batch`, { method: 'POST', json: { clips: SCRIPT.map((text, i) => ({ id: `s${i}`, text })), voiceId: 'local:piper-id-news-medium', language: 'id', maxTotalMs: 4000, insert: false } });
    const j = await final((await json<{ id: string }>(r)).id);
    expect(j.status).toBe('done');
    expect(j.result!['regenerated']).toBe(true);
    expect(Number(j.result!['speed'])).toBeGreaterThan(1);
    expect(Number(j.result!['speed'])).toBeLessThanOrEqual(1.2);
    expect(speeds.slice(3).every((x) => x === Number(j.result!['speed']))).toBe(true);
    failOn = 'volumenya';
    const f = await final((await json<{ id: string }>(await s.api(`/projects/${pid}/generators/voice-batch`, { method: 'POST', json: { clips: SCRIPT.map((text, i) => ({ id: `f${i}`, text })), voiceId: 'local:piper-id-news-medium', language: 'id', insert: true } }))).id);
    failOn = null;
    expect(f.status).toBe('failed');
    expect(s.applied.length).toBe(before);
    await expect(s.ctx.hooks.voiceBatch!(pid, { clips: [{ id: 'x', text: 'Halo.' }], voiceId: 'openai:gpt-4o-mini-tts:coral', language: 'id' })).rejects.toMatchObject({ code: 'EM-7113' });
    expect((await s.api(`/projects/${pid}/generators/voice-batch`, { method: 'POST', json: { clips: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }], voiceId: 'x' } })).status).toBe(400);
  });

  it('FR-246: the voice list — local ready, cloud needs a connection, Private Mode disables cloud with its reason', async () => {
    const list = await json<{ items: Array<{ id: string; availability: string; cloud: boolean; usdPer1kChars?: number }> }>(await s.api('/voices?language=id'));
    expect(list.items.find((v) => v.id === 'local:piper-id-news-medium')!.availability).toBe('ready');
    expect(list.items.filter((v) => v.cloud).every((v) => v.availability === 'no-connection')).toBe(true);
    expect(list.items.filter((v) => v.id.startsWith('gemini:'))).toHaveLength(30);
    s.ctx.settings.update({ privateMode: true });
    const priv = await json<{ items: Array<{ cloud: boolean; availability: string }>; privateMode: boolean }>(await s.api('/voices?language=id'));
    expect(priv.privateMode).toBe(true);
    expect(priv.items.filter((v) => v.cloud).every((v) => v.availability === 'private-mode')).toBe(true);
    s.ctx.settings.update({ privateMode: false });
  });

  it('FR-246: cloud voices send the documented request shapes through the tts egress purpose (OpenAI, Gemini, ElevenLabs)', async () => {
    const boxP = createSecretBox(s.ctx.cfg.dbKeyHex); const now = new Date().toISOString();
    for (const [id, provider] of [['01CONNOPENAI0000000000000A', 'openai'], ['01CONNG00GLE0000000000000A', 'google']] as const) {
      s.ctx.db.prepare("INSERT INTO provider_connections(id, provider, label, base_url, secret_enc, secret_hint, status, created_at, updated_at) VALUES (?,?,?,NULL,?,?,'valid',?,?)")
        .run(id, provider, provider, boxP.seal(`sk-test-${provider}-0123456789`, `provider_connections:${id}`), '…6789', now, now);
    }
    const pcm = wavBuffer(1200, 300, 24000);
    s.ctx.egress = createEgress({ isPrivate: () => false, impl: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input); const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      outbound.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.startsWith('https://api.openai.com/v1/audio/speech')) return new Response(pcm, { status: 200, headers: { 'content-type': 'audio/wav' } });
      if (url.includes('generativelanguage.googleapis.com')) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.subarray(44).toString('base64') } }] } }] });
      if (url.startsWith('https://api.elevenlabs.io/v1/user')) return Response.json({ subscription: { tier: 'creator' } });
      if (url.startsWith('https://api.elevenlabs.io/v2/voices')) return Response.json({ voices: [{ voice_id: 'Abc123Def456', name: 'Sari', labels: { gender: 'female', description: 'warm' } }] });
      if (url.includes('/with-timestamps')) {
        const text = (JSON.parse(String(init!.body)) as { text: string }).text; const chars = [...text];
        return Response.json({ audio_base64: pcm.toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.03), character_end_times_seconds: chars.map((_, i) => i * 0.03 + 0.03) } });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch });
    const run = async (voiceId: string) => final((await json<{ id: string }>(await s.api(`/projects/${pid}/generators/voice`, { method: 'POST', json: { text: 'Energi bersih melimpah.', voiceId, language: 'id', speed: 1.1, style: 'hangat', captions: true } }))).id);
    const o = await run('openai:gpt-4o-mini-tts:coral');
    expect([o.status, o.errorCode]).toEqual(['done', null]);
    const oa = outbound.find((x) => x.url.includes('api.openai.com'))!;
    expect(oa.headers['Authorization']).toBe('Bearer sk-test-openai-0123456789');
    expect(oa.body).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'Energi bersih melimpah.', voice: 'coral', response_format: 'wav', speed: 1.1 });
    expect(String((oa.body as { instructions: string }).instructions)).toContain('Bahasa Indonesia');
    expect(Number(o.result!['costUsd'])).toBeGreaterThan(0);
    const g = await run('gemini:gemini-3.8-flash-tts:Sulafat');
    expect([g.status, g.errorCode]).toEqual(['done', null]);
    const ga = outbound.find((x) => x.url.includes('generativelanguage'))!;
    expect(ga.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent');
    expect(ga.headers['x-goog-api-key']).toBe('sk-test-google-0123456789');
    expect(ga.body).toMatchObject({ generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: 'Sulafat' } } } });
    // ElevenLabs: own key (validated), voices from the account, engine word times → timing 'engine'
    expect((await s.api('/voice-keys/elevenlabs', { method: 'PUT', json: { key: 'el_0123456789abcdefghijKLMN' } })).status).toBe(200);
    const vl = await json<{ items: Array<{ id: string }>; elevenLabsKey: string }>(await s.api('/voices?language=id&refresh=1'));
    expect(vl.items.some((v) => v.id === 'elevenlabs:eleven_multilingual_v2:Abc123Def456')).toBe(true);
    expect(vl.elevenLabsKey).toBe('…KLMN');
    const e = await run('elevenlabs:eleven_multilingual_v2:Abc123Def456');
    expect([e.status, e.errorCode, e.result!['timing']]).toEqual(['done', null, 'engine']);
    const el = outbound.find((x) => x.url.includes('/with-timestamps'))!;
    expect(el.headers['xi-api-key']).toBe('el_0123456789abcdefghijKLMN');
    expect(el.body).toMatchObject({ model_id: 'eleven_multilingual_v2', language_code: 'id', voice_settings: { speed: 1.1 } });
    expect(JSON.stringify(s.ctx.db.prepare('SELECT * FROM voice_keys').all())).not.toContain('el_0123456789');   // sealed at rest
    s.ctx.settings.update({ privateMode: true });
    expect((await s.api(`/projects/${pid}/generators/voice`, { method: 'POST', json: { text: 'x', voiceId: 'openai:gpt-4o-mini-tts:coral', language: 'id' } })).status).toBe(423);
    s.ctx.settings.update({ privateMode: false });
  });

  it('FR-247: the CC0 music library lists moods with licence + credit; Private Mode refuses downloads; a bad file never verifies', async () => {
    const lib = await json<{ items: Array<{ id: string; mood: string; status: string; credit: string; licence: { spdx: string } }>; moods: string[] }>(await s.api('/music-library?mood=calm'));
    expect(lib.items.length).toBeGreaterThan(2);
    expect(lib.items.every((t) => t.mood === 'calm' && t.status === 'not-downloaded' && t.licence.spdx === 'CC0-1.0' && t.credit.includes('CC0'))).toBe(true);
    expect(lib.moods).toContain('cinematic');
    const cards = await json<{ items: Array<{ kind: string; models: Array<{ key: string; installed: boolean }> }> }>(await s.api('/generators'));
    expect(cards.items.find((c) => c.kind === 'music')!.models.find((m) => m.key === 'loop-library-cc0')).toMatchObject({ installed: true });
    // AI music is not offered: asking for it explains instead of "model not available"
    const ace = await s.api(`/projects/${pid}/generators/music`, { method: 'POST', json: { prompt: 'santai', durationMs: 10_000, modelKey: 'ace-step-v1-3.5b' } });
    expect((await json<{ error: { code: string } }>(ace)).error.code).toBe('EM-7107');
    s.ctx.settings.update({ privateMode: true });
    const p = await s.api(`/projects/${pid}/generators/music`, { method: 'POST', json: { prompt: 'santai', durationMs: 10_000 } });
    expect((await json<{ error: { code: string } }>(p)).error.code).toBe('EM-8202');
    s.ctx.settings.update({ privateMode: false });
    s.ctx.egress = createEgress({ isPrivate: () => false, impl: (async () => new Response(blob, { status: 200 })) as unknown as typeof fetch });
    await s.api(`/music-library/${lib.items[0]!.id}/download`, { method: 'POST' });
    const failed = await s.waitEvent((e) => e.name === 'service.notice' && e.data['kind'] === 'music-library' && e.data['status'] === 'failed');
    expect(failed.data['code']).toBe('EM-7003');
  });
});
