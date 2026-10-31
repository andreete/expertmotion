// Footage prep job (FR-285 … FR-289, R-130 kind `prep`, R-145, R-148, R-149, R-153, R-154) with small synthetic fixtures: a 6 s
// "voice" WAV with three speech-like bursts, a 7.3 s testsrc camera video whose audio carries the same bursts 1.3 s later (the camera
// started first), a fake whisper that reads the joined WAV, a fake Engine still for the cover. Needs the full LGPL ffmpeg
// (resources/bin-linux-x64) for the voice clean-up filters; skipped when it is missing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyModel } from '@expertmotion/composition-model';
import { analysis, parseWav, type ModelDef, type RecognisedToken } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { mediaModule } from '../../src/modules/media.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import { createEgress } from '../../src/services/egress.js';
import { GENERATOR_KINDS, type GeneratorEngines } from '../../src/s2/generators-service.js';
import { modelsServiceOf } from '../../src/s2/models-service.js';
import { brainstormTools } from '../../src/modules/agents.js';
import { cleanFilterFor, frameTimes, metadataRotation, PREP_STAGE_LABELS, PREP_STAGES, latestAnalysis, type FootageAnalysis } from '../../src/s2/reels/footage-prep.js';
import { buildCredits, textsOfPreset } from '../../src/s2/reels/credits.js';
import { SFX_KINDS } from '../../src/s2/sfx-service.js';
import { json, startS2, type S2Service } from './harness.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const FULL_FFMPEG = [path.join(ROOT, 'resources/bin-linux-x64/ffmpeg'), '/home/andre/em-win-deps/ffmpeg-linux-lgpl/ffmpeg-n8.1-latest-linux64-lgpl-8.1/bin/ffmpeg'].find((p) => fs.existsSync(p));
const FULL_FFPROBE = FULL_FFMPEG ? path.join(path.dirname(FULL_FFMPEG), 'ffprobe') : undefined;
const hasFull = (() => { try { if (!FULL_FFMPEG || !FULL_FFPROBE) return false; execFileSync(FULL_FFMPEG, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const SR = 16000; const OFFSET_MS = 1300; const VOICE_MS = 14_000; const CAMERA_MS = 15_600;
/** Six irregular "phrases" (start, end, pitch Hz, wobble Hz): distinct content so the correlation has one clear peak like real speech. */
const BURSTS: Array<[number, number, number, number]> = [[500, 1700, 170, 5], [2600, 4300, 220, 9], [5100, 5900, 190, 13], [7200, 9000, 150, 7], [9800, 10_600, 240, 11], [11_500, 13_200, 200, 6]];
/** Speech-like bursts (three harmonics with an amplitude wobble) over a faint noise floor; `shiftMs` delays them (camera started earlier). */
function speechWav(totalMs: number, shiftMs: number, noise: number): Buffer {
  const n = Math.round((SR * totalMs) / 1000); const data = Buffer.alloc(n * 2);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) {
    const ms = (i / SR) * 1000; const t = i / SR;
    const b = BURSTS.find(([a, e]) => ms >= a + shiftMs && ms < e + shiftMs);
    const wobble = b ? 0.6 + 0.4 * Math.sin(2 * Math.PI * b[3] * t) : 0;
    const v = b ? wobble * (Math.sin(2 * Math.PI * b[2] * t) * 0.5 + Math.sin(2 * Math.PI * b[2] * 1.7 * t) * 0.3 + Math.sin(2 * Math.PI * 1200 * t) * 0.15) * 9000 : 0;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v + rnd() * noise))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const SCRIPT = 'Halo semua selamat datang.\nHari ini kita bahas reaktor SMR.\nReaktor kecil ini modular.\nListriknya untuk pusat data.\nBiayanya masih tinggi.\nSampai jumpa lagi.';
const LINE_WORDS = SCRIPT.split('\n').map((l) => l.replace(/[.]/g, '').split(' '));
/** The fake whisper for piece i: the burst inside the piece WAV (energy over −30 dB, piece time) → the words of script line i spread across it. */
function fakeTokens(wavPath: string, i: number): RecognisedToken[] {
  const w = parseWav(fs.readFileSync(wavPath)); const pcm = new Int16Array(w.data.buffer, w.data.byteOffset, Math.floor(w.data.byteLength / 2));
  const p = analysis.findPhrases(analysis.makeEnvelope(pcm, w.sampleRate, 10), { thrDb: -30, mergeGapMs: 400, minMs: 300 })[0] ?? { fromMs: 0, toMs: Math.round((pcm.length / w.sampleRate) * 1000) };
  const words = LINE_WORDS[i] ?? ['kata']; const step = (p.toMs - p.fromMs) / words.length;
  return words.map((t, k) => ({ text: ` ${t}`, fromMs: Math.round(p.fromMs + k * step), toMs: Math.round(p.fromMs + (k + 1) * step) }));
}
const blob = crypto.randomBytes(200_000);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const sttDef: ModelDef = { key: 'whisper-small-q5', label: 'Whisper small q5', engine: 'whisper.cpp', task: 'stt', version: 't1', availability: 'download',
  files: [{ name: 'ggml-small-q5_1.bin', bytes: blob.length, bytesExact: true, sha256: sha(blob), url: 'https://huggingface.co/test/resolve/abc/ggml-small-q5_1.bin', revision: 'abc' }],
  bytes: blob.length, licence: { name: 'MIT', url: 'https://example.org/mit', redistribution: 'yes' }, commercialUse: 'yes', languages: ['id', 'en'], minTier: 'T0', recommendedFor: ['T0'], ramBytes: 0, flag: 'model:whisper', priority: 'P1', notes: [] };
type GenJob = { id: string; status: string; errorCode: string | null; resultAssetId: string | null; result: Record<string, unknown> | null };

describe('pure helpers of the footage prep', () => {
  it('metadataRotation reads the display matrix (-90 → rotate 90° cw) and tags', () => {
    expect(metadataRotation(JSON.stringify({ streams: [{ codec_type: 'video', side_data_list: [{ rotation: -90 }] }] }))).toBe(90);
    expect(metadataRotation(JSON.stringify({ streams: [{ codec_type: 'video', side_data_list: [{ rotation: 90 }] }] }))).toBe(270);
    expect(metadataRotation(JSON.stringify({ streams: [{ codec_type: 'video', tags: { rotate: '180' } }] }))).toBe(180);
    expect(metadataRotation(JSON.stringify({ streams: [{ codec_type: 'video' }] }))).toBeNull(); expect(metadataRotation(null)).toBeNull();
  });
  it('frameTimes (R-149): explicit times, cut middles by id, `count` cuts from a time on, evenly spaced without cuts', () => {
    const a = { cuts: [{ id: 'cut-1', startMs: 1000, endMs: 3000 }, { id: 'cut-2', startMs: 5000, endMs: 6000 }, { id: 'cut-3', startMs: 8000, endMs: 9000 }], durationMs: 20_000 } as unknown as FootageAnalysis;
    expect(frameTimes(a, { atMs: [10, 20] })).toEqual([10, 20]);
    expect(frameTimes(a, { cutIds: ['cut-3', 'nope', 'cut-1'] })).toEqual([8500, 2000]);
    expect(frameTimes(a, { count: 2, fromMs: 4000 })).toEqual([5500, 8500]);
    expect(frameTimes(a, { count: 5, fromMs: 1000 })).toEqual([2000, 5500, 8500]);
    expect(frameTimes(undefined, { count: 4, fromMs: 0 })).toEqual([7500, 22_500, 37_500, 52_500]);
  });
  it('cleanFilterFor drops filters the ffmpeg build lacks; loudnorm JSON is parsed from stderr', () => {
    expect(cleanFilterFor(new Set(['highpass', 'equalizer', 'afftdn', 'agate']))).toEqual({ filter: 'highpass=f=90,equalizer=f=280:t=q:w=1.5:g=-3,afftdn=nf=-25,agate=threshold=0.02:ratio=2:attack=5:release=120', dropped: [] });
    expect(cleanFilterFor(new Set(['highpass']))).toEqual({ filter: 'highpass=f=90', dropped: ['equalizer', 'afftdn', 'agate'] });
    expect(cleanFilterFor(new Set())).toEqual({ filter: null, dropped: ['highpass', 'equalizer', 'afftdn', 'agate'] });
    const m = analysis.parseEbur128('[Parsed_loudnorm_1 @ 0x1] \n{\n\t"input_i" : "-23.52",\n\t"input_tp" : "-6.10",\n\t"input_lra" : "9.80",\n\t"input_thresh" : "-33.90",\n\t"output_i" : "-16.0",\n\t"target_offset" : "0.42"\n}\n');
    expect(m).toMatchObject({ integratedLufs: -23.52, truePeakDb: -6.1, lra: 9.8, threshold: -33.9, offset: 0.42 });
    expect(analysis.parseEbur128('nothing')).toBeNull();
  });
  it('syncOffset finds a 1.3 s lead of the camera from the two synthetic tracks (±30 ms)', () => {
    const v = parseWav(speechWav(VOICE_MS, 0, 40)), c = parseWav(speechWav(CAMERA_MS, OFFSET_MS, 400));
    const toPcm = (d: Uint8Array) => new Int16Array(d.buffer, d.byteOffset, Math.floor(d.byteLength / 2));
    const r = analysis.syncOffset(toPcm(v.data), toPcm(c.data), SR, { maxLagMs: 5000 });
    expect(Math.abs(r.offsetMs - OFFSET_MS)).toBeLessThanOrEqual(30); expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });
  it('stage ids and Indonesian labels; prep is a generator kind', () => {
    expect([...PREP_STAGES]).toEqual(['probe', 'sync', 'master', 'phrases', 'listen', 'takes', 'timing']);
    for (const s of PREP_STAGES) expect(PREP_STAGE_LABELS[s].id.length).toBeGreaterThan(3);
    expect(GENERATOR_KINDS).toContain('prep');
  });
});

describe.skipIf(!hasFull)('footage prep job (R-130 prep, R-145, R-148, R-149, R-153, R-154) on synthetic fixtures', () => {
  let s: S2Service; let pid: string; let fx: string; let listened: Array<{ prompt?: string; language: string; files: number }> = []; let stills = 0;
  const engines: Partial<GeneratorEngines> = {
    listenPieces: async (i, c) => { listened.push({ ...(i.prompt ? { prompt: i.prompt } : {}), language: i.language, files: i.wavPaths.length }); c.onProgress(1); return i.wavPaths.map((p, k) => fakeTokens(p, k)); },
    frame: async (i) => { stills++; execFileSync(FULL_FFMPEG!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:size=108x192', '-frames:v', '1', '-q:v', '5', i.outPath]); },
  };
  const upload = async (file: string): Promise<string> => {
    const r = await s.api(`/projects/${pid}/assets`, { method: 'POST', body: new Uint8Array(fs.readFileSync(file)), headers: { 'content-type': 'application/octet-stream', 'x-expertmotion-filename': path.basename(file) } });
    expect(r.status).toBe(202);
    const id = (await json<{ items: Array<{ id: string }> }>(r)).items[0]!.id;
    await s.waitEvent((e) => e.name === 'ingest.done' && (e.data['asset'] as { id: string }).id === id, 60_000);
    return id;
  };
  const final = (id: string) => new Promise<GenJob>((res) => { const t = setInterval(async () => { const j = await json<GenJob>(await s.api(`/generator-jobs/${id}`)); if (['done', 'failed', 'cancelled', 'needs-input'].includes(j.status)) { clearInterval(t); res(j); } }, 50); });
  beforeAll(async () => {
    s = await startS2([health, createAssetsModule(), mediaModule, createModelsModule({ registry: () => [sttDef], freeBytes: async () => 1e12 }), createGeneratorsModule({ engines })]);
    s.ctx.resources.ffmpeg = FULL_FFMPEG!; s.ctx.resources.ffprobe = FULL_FFPROBE!;
    pid = s.project('Reels Uji');
    fx = fs.mkdtempSync(path.join(os.tmpdir(), 'em-reels-fx-'));
    fs.writeFileSync(path.join(fx, 'voice.wav'), speechWav(VOICE_MS, 0, 40));
    fs.writeFileSync(path.join(fx, 'cam-audio.wav'), speechWav(CAMERA_MS, OFFSET_MS, 400));
    // a 15.6 s 320x240 landscape camera file without a rotation flag, its audio = the room recording
    execFileSync(FULL_FFMPEG!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${CAMERA_MS / 1000}`, '-i', path.join(fx, 'cam-audio.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'libopenh264', '-b:v', '600k', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', path.join(fx, 'camera.mp4')]);
  }, 120_000);
  afterAll(async () => { await s.close(); fs.rmSync(fx, { recursive: true, force: true }); });

  it('without an installed transcription model the job is refused with EM-7001 naming the model', async () => {
    const voiceId = await upload(path.join(fx, 'voice.wav'));
    const r = await s.api(`/projects/${pid}/generators/prep`, { method: 'POST', json: { voiceAssetId: voiceId } });
    expect(r.status).toBe(422);
    const e = await json<{ error: { code: string; details: { modelKey: string } } }>(r);
    expect(e.error.code).toBe('EM-7001'); expect(typeof e.error.details.modelKey).toBe('string');
    // install the fake model through the real installer path
    s.ctx.egress = createEgress({ isPrivate: () => false, impl: (async () => new Response(blob, { status: 200 })) as unknown as typeof fetch });
    await modelsServiceOf(s.ctx).install('whisper-small-q5'); await modelsServiceOf(s.ctx).idle();
  }, 60_000);

  it('runs probe → sync → master → phrases → listen → takes → timing: offset ≈ 1.3 s, master Asset, 3 cuts, analysis stored (R-145)', async () => {
    const voiceId = await upload(path.join(fx, 'voice.wav')); const camId = await upload(path.join(fx, 'camera.mp4'));
    const r = await s.api(`/projects/${pid}/generators/prep`, { method: 'POST', json: { voiceAssetId: voiceId, cameraAssetId: camId, script: SCRIPT, shortSide: 240 } });
    expect(r.status).toBe(202);
    const j = await final((await json<GenJob>(r)).id);
    expect(j.errorCode).toBeNull(); expect(j.status).toBe('done');
    const res = j.result as { offsetMs: number; cuts: Array<{ id: string; text: string; startMs: number; endMs: number; words: Array<{ text: string; fromMs: number; toMs: number }> }>; masterAssetId: string; rotation: number; rotationSource: string; phrases: unknown[]; loudness: { inputI: number }; analysisId: string; model: string };
    expect(Math.abs(res.offsetMs - OFFSET_MS)).toBeLessThanOrEqual(40);
    expect(res.phrases.length).toBe(BURSTS.length);
    expect(res.cuts.map((c) => c.text)).toEqual(SCRIPT.split('\n'));   // the cut text is the script line (display text), the words are what was heard
    // cuts start 120 ms before the voice and end 150 ms after it, snapped to the quietest frame within 150 ms (recording time); words timed inside the cut
    expect(res.cuts[0]!.startMs).toBeGreaterThanOrEqual(BURSTS[0]![0] - 120 - 150 - 20); expect(res.cuts[0]!.startMs).toBeLessThanOrEqual(BURSTS[0]![0]);
    expect(res.cuts[0]!.endMs).toBeGreaterThanOrEqual(BURSTS[0]![1]); expect(res.cuts[0]!.endMs).toBeLessThanOrEqual(BURSTS[0]![1] + 150 + 150 + 20);
    for (const c of res.cuts) for (const w of c.words) { expect(w.fromMs).toBeGreaterThanOrEqual(c.startMs); expect(w.toMs).toBeLessThanOrEqual(c.endMs); }
    expect(res.rotation).toBe(0); expect(res.rotationSource).toBe('none'); expect(res.loudness.inputI).toBeLessThan(0); expect(res.model).toBe('whisper-small-q5');
    expect(listened.at(-1)!.language).toBe('id'); expect(listened.at(-1)!.prompt).toMatch(/^SMR\.?$/); expect(listened.at(-1)!.files).toBe(BURSTS.length);   // one piece per phrase, names only, never the script
    // the master: a video Asset of the project, 320x240 (short side 240 for the test), ~6 s, with the voice's audio, ingested with proxy/thumb/waveform
    expect(j.resultAssetId).toBe(res.masterAssetId);
    const a = await json<{ kind: string; status: string; name: string; width: number; height: number; durationMs: number; hasAudio: boolean; fps: number; media: Record<string, boolean> }>(await s.api(`/projects/${pid}/assets/${res.masterAssetId}`));
    expect(a).toMatchObject({ kind: 'video', status: 'ready', hasAudio: true, width: 320, height: 240, fps: 30 });
    expect(a.name).toBe('voice · master.mp4'); expect(Math.abs(a.durationMs - VOICE_MS)).toBeLessThanOrEqual(150);
    expect(a.media).toMatchObject({ playable: true, thumb: true, waveform: true });
    // stored and served (R-145); progress notices carried the stage ids with Indonesian labels
    const row = s.ctx.db.prepare('SELECT * FROM footage_analyses WHERE project_id = ?').get(pid) as { id: string; master_asset_id: string };
    expect(row.id).toBe(res.analysisId); expect(row.master_asset_id).toBe(res.masterAssetId);
    const got = await json<{ id: string; cuts: unknown[]; voiceAssetId: string }>(await s.api(`/projects/${pid}/footage-analysis`));
    expect(got.id).toBe(res.analysisId); expect(got.cuts.length).toBe(BURSTS.length); expect(got.voiceAssetId).toBe(voiceId);
    expect((j.result as { analysis: { cuts: unknown[] } }).analysis.cuts.length).toBe(BURSTS.length);   // the UI reads result.analysis first
    const list = await json<{ items: Array<{ id: string; kind: string }> }>(await s.api(`/projects/${pid}/generator-jobs?kind=prep&limit=1`));
    expect(list.items).toHaveLength(1); expect(list.items[0]).toMatchObject({ id: j.id, kind: 'prep' });
    const stages = s.events.filter((e) => e.name === 'service.notice' && e.data['kind'] === 'generator' && e.data['jobId'] === j.id && e.data['stage']).map((e) => e.data['stage']);
    expect(new Set(stages)).toContain('master'); expect(new Set(stages)).toContain('listen');
    expect(s.events.find((e) => e.name === 'service.notice' && e.data['jobId'] === j.id && e.data['stage'] === 'master')!.data['stageLabel']).toEqual(PREP_STAGE_LABELS.master);
  }, 180_000);

  it('media tools: media.analysis.get returns the cuts; media.frames returns a JPEG contact sheet with cells (R-149)', async () => {
    const tools = brainstormTools(s.ctx, pid, 'id') as Record<string, (i: Record<string, unknown>) => unknown>;
    const a = tools['media.analysis.get']!({}) as { cuts: Array<{ id: string }>; masterAssetId: string };
    expect(a.cuts.length).toBe(BURSTS.length); expect(a.masterAssetId).toBeTruthy();
    const f = await tools['media.frames']!({ cutIds: a.cuts.map((c) => c.id) }) as { imageBase64: string; cells: Array<{ atMs: number; x: number; y: number }>; cols: number; rows: number; mediaType: string };
    expect(f.mediaType).toBe('image/jpeg'); expect(f.cells.length).toBe(6); expect(f.cols).toBe(3); expect(f.rows).toBe(2);
    const buf = Buffer.from(f.imageBase64, 'base64'); expect(buf[0]).toBe(0xff); expect(buf[1]).toBe(0xd8); expect(buf.length).toBeLessThan(1_500_000);
    expect(f.cells[1]!.x).toBeGreaterThan(0);
    const r = await s.api(`/projects/${pid}/footage-analysis/frames?atMs=500,2000`);
    expect(r.status).toBe(200); expect(r.headers.get('content-type')).toContain('image/jpeg');
    const cells = JSON.parse(r.headers.get('x-expertmotion-cells')!) as { cells: unknown[]; cols: number }; expect(cells.cells.length).toBe(2); expect(cells.cols).toBe(2);
    // the cover picker's call: count cuts from the first cut's start → one cell per cut, ceil(sqrt(3)) = 2 columns
    const r2 = await s.api(`/projects/${pid}/footage-analysis/frames?atMs=${a.cuts.length ? 0 : 0}&count=3`);
    expect(r2.status).toBe(200);
    const c2 = JSON.parse(r2.headers.get('x-expertmotion-cells')!) as { cells: Array<{ atMs: number }>; cols: number; rows: number }; expect(c2.cells.length).toBe(3); expect(c2.cols).toBe(2); expect(c2.rows).toBe(2);
    expect(c2.cells[0]!.atMs).toBeGreaterThan(BURSTS[0]![0]); expect(c2.cells[0]!.atMs).toBeLessThan(BURSTS[0]![1]);
    // media.analyze on already analysed assets answers at once with the stored summary
    const sum = await tools['media.analyze']!({ voiceAssetId: a.cuts.length ? (await json<{ voiceAssetId: string }>(await s.api(`/projects/${pid}/footage-analysis`))).voiceAssetId : '' }) as { status: string; cuts: unknown[]; offsetMs: number };
    expect(sum.status).toBe('done'); expect(sum.cuts.length).toBe(BURSTS.length); expect(Math.abs(sum.offsetMs - OFFSET_MS)).toBeLessThanOrEqual(40);
  }, 60_000);

  it('rotation confirmation (FR-286): a landscape file for a 9:16 project stops with needs-input + 4 thumbnails; R-148 continues with the chosen rotation', async () => {
    const pid2 = s.project('Reels Portrait');
    s.version(pid2, createEmptyModel(pid2, { autoRatio: false, ratio: '9:16', resolution: '1080p', fps: 30 }));
    const saved = pid; pid = pid2;
    const voiceId = await upload(path.join(fx, 'voice.wav')); const camId = await upload(path.join(fx, 'camera.mp4'));
    pid = saved;
    const r = await s.api(`/projects/${pid2}/generators/prep`, { method: 'POST', json: { voiceAssetId: voiceId, cameraAssetId: camId, script: SCRIPT, shortSide: 240, confirmRotation: true } });
    const j = await final((await json<GenJob>(r)).id);
    expect(j.status).toBe('needs-input');
    const res = j.result as { needsRotationConfirm: boolean; code: string; offsetMs: number; thumbs: Record<string, string>; thumbnails: Array<{ rotation: number; url: string }> };
    expect(res.needsRotationConfirm).toBe(true); expect(res.code).toBe('EM-1503'); expect(Math.abs(res.offsetMs - OFFSET_MS)).toBeLessThanOrEqual(40);
    expect(Object.keys(res.thumbs).sort()).toEqual(['0', '180', '270', '90']);
    expect(res.thumbnails.map((t) => t.rotation)).toEqual([0, 90, 180, 270]);
    for (const t of res.thumbnails) expect(t.url.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);   // plain <img src> without a token
    const t = await s.api(res.thumbs['90']!.replace(/^\/api\/v1/, ''));
    expect(t.status).toBe(200); expect(t.headers.get('content-type')).toContain('image/jpeg');
    expect(s.events.some((e) => e.name === 'service.notice' && e.data['jobId'] === j.id && e.data['status'] === 'needs-input')).toBe(true);
    // the Brainstorm tool reports the wait instead of starting another job
    const tools = brainstormTools(s.ctx, pid2, 'id') as Record<string, (i: Record<string, unknown>) => unknown>;
    expect(await tools['media.analyze']!({ voiceAssetId: voiceId, cameraAssetId: camId }) as { status: string }).toMatchObject({ status: 'needs-input', jobId: j.id });
    // continue: a new job with rotation 90, the sync result reused (no second measurement), portrait master 240x320
    const c = await s.api(`/projects/${pid2}/footage-prep/${j.id}/continue`, { method: 'POST', json: { rotation: 90 } });
    expect(c.status).toBe(202);
    const j2 = await final((await json<GenJob>(c)).id);
    expect(j2.errorCode).toBeNull(); expect(j2.status).toBe('done');
    const res2 = j2.result as { rotation: number; rotationSource: string; offsetMs: number; masterAssetId: string; cuts: unknown[] };
    expect(res2).toMatchObject({ rotation: 90, rotationSource: 'creator', offsetMs: res.offsetMs }); expect(res2.cuts.length).toBe(BURSTS.length);
    const a = await json<{ width: number; height: number }>(await s.api(`/projects/${pid2}/assets/${res2.masterAssetId}`));
    expect(a).toMatchObject({ width: 240, height: 320 });
    expect((await json<GenJob>(await s.api(`/generator-jobs/${j.id}`))).status).toBe('done');   // the stopped job left the pending list
    expect((await s.api(`/projects/${pid2}/footage-prep/${j.id}/continue`, { method: 'POST', json: { rotation: 90 } })).status).toBe(409);
  }, 180_000);

  it('SFX Assets (FR-288): six self-made CC0 sounds registered once per project, deduped on the second call', async () => {
    const first = await s.ctx.hooks.sfxAssets!(pid);
    expect(Object.keys(first).sort()).toEqual([...SFX_KINDS].sort());
    const a = await json<{ kind: string; name: string; status: string; durationMs: number }>(await s.api(`/projects/${pid}/assets/${first['whoosh']}`));
    expect(a).toMatchObject({ kind: 'audio', name: 'SFX · whoosh.wav', status: 'ready' }); expect(Math.abs(a.durationMs - 350)).toBeLessThanOrEqual(20);
    expect(await s.ctx.hooks.sfxAssets!(pid)).toEqual(first);
  }, 60_000);

  it('credits: music / SFX / sources / plan lines from a model (FR-288)', async () => {
    const sfx = await s.ctx.hooks.sfxAssets!(pid);
    const model = s.heads.get(pid)!.model;
    const m = { ...model, tracks: { ...model.tracks, audio: [{ id: 'a1', assetId: sfx['pop']!, role: 'sfx', atMs: 0, trimBeforeMs: 0, volume: 0.5, loop: false, fadeInMs: 0, fadeOutMs: 0 }],
      shape: [{ id: 'sh1', presetId: 'preset:shape.source-tag', params: { text: 'Sumber · IEA 2025 · dicek 2026-10-31' }, timing: { atMs: 0, durationMs: 1000 } }] } } as unknown as typeof model;
    expect(textsOfPreset(m, 'preset:shape.source-tag')).toEqual(['Sumber · IEA 2025 · dicek 2026-10-31']);
    const txt = buildCredits(s.ctx, pid, m, { outputFile: '/tmp/x/reels-9x16-1080p.mp4', extra: ['Laporan BRIN 2024', '  '], projectName: 'Reels Uji' });
    expect(txt).toContain('CREDITS — reels-9x16-1080p.mp4'); expect(txt).toContain('Sound effects:'); expect(txt).toContain('pop (self-made, CC0)');
    expect(txt).toContain('Sources:'); expect(txt).toContain('Sumber · IEA 2025'); expect(txt).toContain('Laporan BRIN 2024'); expect(txt).not.toContain('Music:');
  });

  it('cover (R-153): a JPG still of the supplied model saved as an Output kind still `<project>-cover.jpg`', async () => {
    const model = s.heads.get(pid)!.model;
    const r = await s.api(`/projects/${pid}/cover`, { method: 'POST', json: { hookWord: 'NUKLIR', line: 'Mini reactor', model } });
    expect(r.status).toBe(200);
    const o = await json<{ kind: string; fileName: string; path: string; validated: boolean }>(r);
    expect(o.kind).toBe('still'); expect(o.fileName).toMatch(/^Reels.Uji-cover\.jpg$/); expect(fs.existsSync(o.path)).toBe(true); expect(stills).toBe(1);
    const head = fs.readFileSync(o.path).subarray(0, 2); expect([...head]).toEqual([0xff, 0xd8]);
    const job = s.ctx.db.prepare('SELECT output_profile_json FROM render_jobs WHERE output_id = (SELECT id FROM outputs WHERE path LIKE ?)').get('%-cover.jpg') as { output_profile_json: string };
    expect(JSON.parse(job.output_profile_json)).toMatchObject({ format: 'jpg' });
    // without a model the composer builds the cover model from the spec + the analysis (first cut, master asset) → a second still
    expect(latestAnalysis(s.ctx, pid)?.masterAssetId).toBeTruthy();
    const r2 = await s.api(`/projects/${pid}/cover`, { method: 'POST', json: { hookWord: 'NUKLIR', kicker: 'OPINI', line: 'Reaktor mini', subline: 'untuk pusat data', pills: [{ text: '24 jam', tone: 'info' }], handle: '@kanal' } });
    expect(r2.status).toBe(200);
    const o2 = await json<{ kind: string; fileName: string }>(r2);
    expect(o2.kind).toBe('still'); expect(o2.fileName).toMatch(/-cover-2\.jpg$/); expect(stills).toBe(2);
  }, 60_000);
});
