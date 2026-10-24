import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CancelledError, ENGINE_TIMEOUTS, aceStepArgs, buildChildEnv, concatWavs, createJobDir, defaultKillTree, defaultThreads, exeName, generateImage, generateMusic,
  isInside, jobDirPath, lastLines, parseMusicProgress, parseSdProgress, parseWav, parseWhisperJson, removeJobDir, runProcess, safeArgValue, sdArgs,
  sherpaTtsAdapter, sherpaTtsArgs, splitTtsText, sweepJobDirs, synthesize, transcribe, transcribeToPages, wavDurationMs, whisperAdapter, whisperArgs,
  withJobDir, type EngineContext, type ImageInput,
} from '../src/index.js';
import { FakeChild, expectEm, fakeSpawn, makeWav, tempDir } from './helpers.js';

let tmp: { dir: string; done: () => Promise<void> };
let jobDir: string;
const engineDir = '/opt/em/engines/x/1.0';
beforeEach(async () => { tmp = await tempDir(); jobDir = await createJobDir(tmp.dir, 'job1'); });
afterEach(async () => { await tmp.done(); });
const PARENT_ENV = { SYSTEMROOT: 'C:\\Windows', HTTPS_PROXY: 'http://proxy', NODE_OPTIONS: '--inspect', EM_TOKEN: 'secret', LANG: 'id_ID.UTF-8', HOME: '/home/x' };
const ctx = (spawn: NonNullable<EngineContext['spawn']>, extra: Partial<EngineContext> = {}): EngineContext => ({ engineDir, jobDir, spawn, parentEnv: PARENT_ENV, platform: 'linux', ...extra });

const WHISPER_JSON = JSON.stringify({
  result: { language: 'id' },
  transcription: [
    { offsets: { from: 0, to: 0 }, text: '', tokens: [] },
    { offsets: { from: 0, to: 320 }, text: ' Halo', tokens: [{ text: '[_BEG_]', p: 0.1 }, { text: ' Halo', p: 0.9 }] },
    { offsets: { from: 320, to: 700 }, text: ' semuanya,', tokens: [{ text: ' semu', p: 0.8 }, { text: 'anya', p: 0.6 }, { text: ',', p: 1 }] },
    { offsets: { from: 700, to: 900 }, text: ' [BLANK_AUDIO]', tokens: [] },
    { offsets: { from: 1500, to: 1900 }, text: ' selamat', tokens: [] },
    { offsets: { from: 1900, to: 2400 }, text: ' datang', tokens: [{ text: ' datang', p: 0.95 }] },
  ],
});

describe('process sandbox (SEC-060…065)', () => {
  it('buildChildEnv keeps only the allow-listed keys', () => {
    const env = buildChildEnv({ engineDir, jobDir, parentEnv: PARENT_ENV });
    expect(env).toEqual({ SYSTEMROOT: 'C:\\Windows', TEMP: jobDir, TMP: jobDir, PATH: engineDir, NO_PROXY: '*', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LANG: 'id_ID.UTF-8' });
    expect(buildChildEnv({ engineDir, jobDir, parentEnv: {} })).not.toHaveProperty('SYSTEMROOT');
  });
  it('threads, timeouts, helpers', () => {
    expect(defaultThreads(2)).toBe(1); expect(defaultThreads(6)).toBe(4); expect(defaultThreads(32)).toBe(8);
    expect(ENGINE_TIMEOUTS.captions(30_000)).toBe(360_000);
    expect(ENGINE_TIMEOUTS.thumbnail('T0')).toBe(900_000); expect(ENGINE_TIMEOUTS.thumbnail('T2')).toBe(180_000);
    expect(safeArgValue('-m evil')).toBe(' -m evil'); expect(safeArgValue('ok')).toBe('ok');
    expect(exeName('sd', 'win32')).toBe('sd.exe'); expect(exeName('sd', 'linux')).toBe('sd');
    expect(isInside('/a/b', '/a/b/c')).toBe(true); expect(isInside('/a/b', '/a/b/../c')).toBe(false); expect(isInside('/a/b', '/a/b')).toBe(false);
    expect(lastLines('a\n\nb\nc\n', 2)).toEqual(['b', 'c']);
  });
  it('spawns with an argument array, shell:false, cwd = job dir, and returns output', async () => {
    const f = fakeSpawn(({ child }) => { child.out('hello\nwor'); child.out('ld\n'); child.err('warn\n'); child.exit(0); });
    const lines: string[] = [];
    const r = await runProcess({ engine: 't', exe: '/bin/t', args: ['a; rm -rf /', '$(x)'], cwd: jobDir, env: { PATH: engineDir }, timeoutMs: 1000, spawn: f.spawn, onStdoutLine: (l) => lines.push(l) });
    expect(r).toEqual({ exitCode: 0, stdout: 'hello\nworld\n', stderr: 'warn\n' });
    expect(lines).toEqual(['hello', 'world']);
    expect(f.calls[0]!.args).toEqual(['a; rm -rf /', '$(x)']);
    expect(f.calls[0]!.options).toEqual({ cwd: jobDir, env: { PATH: engineDir }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  });
  it('non-zero exit → EM-7101 with the stderr tail; relative exe refused', async () => {
    const f = fakeSpawn(({ child }) => { for (let i = 0; i < 30; i++) child.err(`line ${i}\n`); child.exit(3); });
    const d = await expectEm(runProcess({ engine: 't', exe: '/bin/t', args: [], cwd: jobDir, env: {}, timeoutMs: 1000, spawn: f.spawn }), 'EM-7101');
    expect(d.exitCode).toBe(3);
    expect((d.stderrTail as string[]).length).toBe(20);
    expect((d.stderrTail as string[])[19]).toBe('line 29');
    await expectEm(runProcess({ engine: 't', exe: 'whisper-cli', args: [], cwd: jobDir, env: {}, timeoutMs: 1000, spawn: f.spawn }), 'EM-7101');
  });
  it('spawn error (ENOENT) → EM-7101', async () => {
    const f = fakeSpawn(({ child }) => { child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })); });
    expect((await expectEm(runProcess({ engine: 't', exe: '/bin/missing', args: [], cwd: jobDir, env: {}, timeoutMs: 1000, spawn: f.spawn }), 'EM-7101')).cause).toBe('spawn');
    const thrower = (): never => { throw new Error('EACCES'); };
    await expectEm(runProcess({ engine: 't', exe: '/bin/x', args: [], cwd: jobDir, env: {}, timeoutMs: 1000, spawn: thrower }), 'EM-7101');
  });
  it('a hung binary is killed at the timeout → EM-7102 (QA-LM-006)', async () => {
    const f = fakeSpawn(() => { /* never exits */ });
    let killed: FakeChild | null = null;
    const d = await expectEm(runProcess({ engine: 't', exe: '/bin/t', args: [], cwd: jobDir, env: {}, timeoutMs: 30, spawn: f.spawn, killTree: (c) => { killed = c as FakeChild; c.kill('SIGKILL'); } }), 'EM-7102');
    expect(d.timeoutMs).toBe(30);
    expect(killed).not.toBeNull();
    expect(f.calls[0]!.child.killed).toBe('SIGKILL');
  });
  it('settles after the kill grace even when the child ignores the kill', async () => {
    const f = fakeSpawn(() => undefined, { hangOnKill: true });
    await expectEm(runProcess({ engine: 't', exe: '/bin/t', args: [], cwd: jobDir, env: {}, timeoutMs: 10, killGraceMs: 20, spawn: f.spawn }), 'EM-7102');
  });
  it('abort kills the process and rejects with CancelledError', async () => {
    const ctrl = new AbortController();
    const f = fakeSpawn(() => { setTimeout(() => ctrl.abort(), 5); });
    await expect(runProcess({ engine: 't', exe: '/bin/t', args: [], cwd: jobDir, env: {}, timeoutMs: 5000, signal: ctrl.signal, spawn: f.spawn })).rejects.toBeInstanceOf(CancelledError);
    expect(f.calls[0]!.child.killed).toBe('SIGKILL');
    const pre = new AbortController(); pre.abort();
    await expect(runProcess({ engine: 't', exe: '/bin/t', args: [], cwd: jobDir, env: {}, timeoutMs: 5000, signal: pre.signal, spawn: f.spawn })).rejects.toBeInstanceOf(CancelledError);
  });
  it('caps captured output at maxOutputBytes, dropping the oldest', async () => {
    const f = fakeSpawn(({ child }) => { for (let i = 0; i < 100; i++) child.out(`${String(i).padStart(3, '0')}\n`); child.out('x'.repeat(50)); child.exit(0); });
    const r = await runProcess({ engine: 't', exe: '/bin/t', args: [], cwd: jobDir, env: {}, timeoutMs: 1000, spawn: f.spawn, maxOutputBytes: 40 });
    expect(r.stdout.length).toBeLessThanOrEqual(40);
    expect(r.stdout.endsWith('x'.repeat(40))).toBe(true);
  });
  it('defaultKillTree uses taskkill /T /F with an absolute path on Windows, SIGKILL elsewhere', () => {
    const f = fakeSpawn(() => undefined);
    const child = new FakeChild();
    defaultKillTree(child, { platform: 'win32', systemRoot: 'C:\\Windows', spawn: f.spawn });
    expect(f.calls[0]!.command).toMatch(/System32.taskkill\.exe$/);
    expect(f.calls[0]!.args).toEqual(['/PID', '4242', '/T', '/F']);
    const c2 = new FakeChild(); defaultKillTree(c2, { platform: 'linux' }); expect(c2.killed).toBe('SIGKILL');
  });
  it('job dirs: create, withJobDir cleanup, orphan sweep, id validation (SEC-062)', async () => {
    expect(jobDirPath(tmp.dir, 'abc')).toBe(join(tmp.dir, 'jobs', 'abc'));
    expect(() => jobDirPath(tmp.dir, '../etc')).toThrow(RangeError);
    let seen = '';
    await expect(withJobDir(tmp.dir, 'j2', async (d) => { seen = d; await writeFile(join(d, 'f'), 'x'); throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(readFile(join(seen, 'f'))).rejects.toThrow();
    await createJobDir(tmp.dir, 'orphan');
    expect((await sweepJobDirs(tmp.dir, ['job1'])).sort()).toEqual(['orphan']);
    await removeJobDir(tmp.dir, 'job1');
    expect(await sweepJobDirs(tmp.dir)).toEqual([]);
  });
});

describe('whisper.cpp adapter', () => {
  const model = '/data/models/whisper.cpp/whisper-small/ggml-small.bin';
  it('argv exactly per LOCAL_AI_MODELS §3.2', () => {
    expect(whisperArgs({ modelPath: model, wavPath: '/j/in.wav', language: 'id', threads: 4, outBase: '/j/out' }))
      .toEqual(['-m', model, '-f', '/j/in.wav', '-l', 'id', '-t', '4', '-oj', '-ojf', '-ml', '1', '-sow', '-np', '-of', '/j/out']);
  });
  it('parses -ojf JSON into Caption[] (leading space, midpoint, mean token p, specials and non-speech dropped)', () => {
    const r = parseWhisperJson(WHISPER_JSON);
    expect(r.language).toBe('id');
    expect(r.captions.map((c) => c.text)).toEqual([' Halo', ' semuanya,', ' selamat', ' datang']);
    expect(r.captions[0]).toEqual({ text: ' Halo', startMs: 0, endMs: 320, timestampMs: 160, confidence: 0.9 });
    expect(r.captions[1]!.confidence).toBeCloseTo(0.8, 5);
    expect(r.captions[2]!.confidence).toBeNull();
    expect(() => parseWhisperJson('{oops')).toThrow(/valid JSON/);
    expect(() => parseWhisperJson('{"x":1}')).toThrow(/no segments/);
  });
  it('transcribe runs whisper-cli in the job dir and reads out.json; pages via TikTok grouping', async () => {
    const f = fakeSpawn(async ({ args, child }) => {
      child.err('whisper_print_progress_callback: progress =  50%\n');
      await writeFile(`${args[args.indexOf('-of') + 1]}.json`, WHISPER_JSON);
      child.exit(0);
    });
    const progress: number[] = [];
    const r = await transcribeToPages({ modelPath: model, language: 'id', threads: 3, audioDurationMs: 2400 }, ctx(f.spawn, { onProgress: (p) => progress.push(p) }));
    const call = f.calls[0]!;
    expect(call.command).toBe(join(engineDir, 'whisper-cli'));
    expect(call.args).toEqual(whisperArgs({ modelPath: model, wavPath: join(jobDir, 'in.wav'), language: 'id', threads: 3, outBase: join(jobDir, 'out') }));
    expect(call.options.cwd).toBe(jobDir);
    expect(call.options.env).not.toHaveProperty('HTTPS_PROXY');
    expect(call.options.env).not.toHaveProperty('EM_TOKEN');
    expect(progress).toEqual([0, 0.5, 1]);
    // ' selamat' joins page 1 because the page spans only 700 ms (≤ 1200) when it arrives; ' datang' starts page 2.
    expect(r.pages.map((p) => p.text)).toEqual(['Halo semuanya, selamat', 'datang']);
    expect(r.pages[0]).toEqual({ text: 'Halo semuanya, selamat', startMs: 0, durationMs: 1900,
      tokens: [{ text: 'Halo', fromMs: 0, toMs: 320 }, { text: ' semuanya,', fromMs: 320, toMs: 700 }, { text: ' selamat', fromMs: 1500, toMs: 1900 }] });
    expect(r.pages[1]).toEqual({ text: 'datang', startMs: 1900, durationMs: 500, tokens: [{ text: 'datang', fromMs: 1900, toMs: 2400 }] });
  });
  it('language allow-list → EM-7105; input outside job dir refused; no speech → EM-7103; missing output → EM-7101', async () => {
    const none = fakeSpawn(() => undefined);
    await expectEm(transcribe({ modelPath: model, language: 'fr', threads: 1, audioDurationMs: 1 }, ctx(none.spawn)), 'EM-7105');
    await expectEm(transcribe({ modelPath: model, language: 'id', threads: 1, audioDurationMs: 1, wavPath: '/etc/passwd' }, ctx(none.spawn)), 'EM-7101');
    expect(none.calls.length).toBe(0);
    const empty = fakeSpawn(async ({ child }) => { await writeFile(join(jobDir, 'out.json'), JSON.stringify({ transcription: [{ offsets: { from: 0, to: 9 }, text: ' [BLANK_AUDIO]' }] })); child.exit(0); });
    await expectEm(transcribe({ modelPath: model, language: 'auto', threads: 1, audioDurationMs: 1 }, ctx(empty.spawn)), 'EM-7103');
    const nofile = fakeSpawn(({ child }) => child.exit(0));
    await expectEm(transcribe({ modelPath: model, language: 'en', threads: 1, audioDurationMs: 1 }, ctx(nofile.spawn)), 'EM-7101');
  });
  it('timeout from the audio length kills the engine (EM-7102)', async () => {
    const hang = fakeSpawn(() => undefined);
    await expectEm(transcribe({ modelPath: model, language: 'id', threads: 1, audioDurationMs: 1 }, ctx(hang.spawn, { timeoutMs: 20 })), 'EM-7102');
    expect(hang.calls[0]!.child.killed).toBe('SIGKILL');
  });
  it('BLUEPRINT adapter shape', async () => {
    const f = fakeSpawn(async ({ child }) => { await writeFile(join(jobDir, 'out.json'), WHISPER_JSON); child.exit(0); });
    const a = whisperAdapter(engineDir, { spawn: f.spawn, platform: 'win32' });
    expect(a.kind).toBe('transcribe');
    const r = await a.run({ modelPath: model, language: 'id', threads: 1, audioDurationMs: 1000 }, { cwd: jobDir, signal: new AbortController().signal, onProgress: () => undefined });
    expect(r.captions.length).toBe(4);
    expect(f.calls[0]!.command).toBe(join(engineDir, 'whisper-cli.exe'));
  });
});

describe('sherpa-onnx TTS adapter', () => {
  const voice = { kind: 'vits' as const, modelPath: '/m/sherpa-onnx/piper-id-news-medium/id_ID-news_tts-medium.onnx', tokensPath: '/m/sherpa-onnx/piper-id-news-medium/tokens.txt' };
  it('argv per LOCAL_AI_MODELS §3.2 (text last, leading dash neutralised)', () => {
    expect(sherpaTtsArgs(voice, { engineDir, threads: 2, outPath: '/j/out.wav', text: 'Halo dunia' })).toEqual([
      `--vits-model=${voice.modelPath}`, `--vits-tokens=${voice.tokensPath}`, `--vits-data-dir=${join(engineDir, 'espeak-ng-data')}`, '--num-threads=2', '--output-filename=/j/out.wav', 'Halo dunia']);
    expect(sherpaTtsArgs(voice, { engineDir, threads: 1, outPath: '/o', text: '--help', speed: 1.25 }).slice(-1)[0]).toBe(' --help');
    expect(sherpaTtsArgs(voice, { engineDir, threads: 1, outPath: '/o', text: 'x', speed: 0.8 })).toContain('--vits-length-scale=1.250');
    const k = sherpaTtsArgs({ kind: 'kokoro', modelPath: '/k/model.onnx', voicesPath: '/k/voices.bin', tokensPath: '/k/tokens.txt', speakerId: 3 }, { engineDir, threads: 1, outPath: '/o', text: 'Hi' });
    expect(k.slice(0, 5)).toEqual(['--kokoro-model=/k/model.onnx', '--kokoro-voices=/k/voices.bin', '--kokoro-tokens=/k/tokens.txt', `--kokoro-data-dir=${join(engineDir, 'espeak-ng-data')}`, '--sid=3']);
  });
  it('splits long Indonesian text on sentence ends without breaking numbers', () => {
    const t = 'Harga paket ini Rp 1.250.000 saja. Promo berlaku sampai 31 Desember 2026! Apakah kamu siap? ' + 'kata '.repeat(120);
    const chunks = splitTtsText(t, 120);
    expect(chunks[0]).toContain('Rp 1.250.000 saja.');
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(t.replace(/\s+/g, ' ').trim());
    expect(splitTtsText('   ')).toEqual([]);
    expect(splitTtsText('a'.repeat(250), 100).map((c) => c.length)).toEqual([100, 100, 50]);
  });
  it('one process per chunk, then out.wav joined with 250 ms silence', async () => {
    const f = fakeSpawn(async ({ args, child }) => {
      const out = args.find((a) => a.startsWith('--output-filename='))!.slice('--output-filename='.length);
      await writeFile(out, makeWav(2205));
      child.exit(0);
    });
    const progress: number[] = [];
    const r = await synthesize({ voice, text: `${'Satu dua tiga. '.repeat(10)}Empat lima enam.`, threads: 2, chunkChars: 60 }, ctx(f.spawn, { onProgress: (p) => progress.push(p) }));
    expect(f.calls.length).toBe(r.chunks);
    expect(r.chunks).toBeGreaterThan(1);
    expect(r.wavPath).toBe(join(jobDir, 'out.wav'));
    expect(r.durationMs).toBe(r.chunks * 100 + (r.chunks - 1) * 250);
    expect(progress.at(-1)).toBe(1);
    for (const c of f.calls) { expect(c.command).toBe(join(engineDir, 'sherpa-onnx-offline-tts')); expect(c.options.env.PATH).toBe(engineDir); }
  });
  it('single chunk writes out.wav directly; adapter shape', async () => {
    const f = fakeSpawn(async ({ child }) => { await writeFile(join(jobDir, 'out.wav'), makeWav(22050)); child.exit(0); });
    const r = await sherpaTtsAdapter(engineDir, { spawn: f.spawn, platform: 'linux' }).run({ voice, text: 'Halo', threads: 1 }, { cwd: jobDir, signal: new AbortController().signal, onProgress: () => undefined });
    expect(r).toEqual({ wavPath: join(jobDir, 'out.wav'), chunks: 1, durationMs: 1000 });
  });
  it('limits: > 2 000 chars EM-7106, empty EM-9002, bad speed EM-9002, no audio EM-7103, junk wav EM-7101', async () => {
    const none = fakeSpawn(({ child }) => child.exit(0));
    await expectEm(synthesize({ voice, text: 'a'.repeat(2001), threads: 1 }, ctx(none.spawn)), 'EM-7106');
    await expectEm(synthesize({ voice, text: '  ', threads: 1 }, ctx(none.spawn)), 'EM-9002');
    await expectEm(synthesize({ voice, text: 'x', threads: 1, speed: 2 }, ctx(none.spawn)), 'EM-9002');
    await expectEm(synthesize({ voice, text: 'x', threads: 1 }, ctx(none.spawn)), 'EM-7103');
    const junk = fakeSpawn(async ({ child }) => { await writeFile(join(jobDir, 'out.wav'), Buffer.alloc(100, 7)); child.exit(0); });
    await expectEm(synthesize({ voice, text: 'x', threads: 1 }, ctx(junk.spawn)), 'EM-7101');
  });
  it('WAV helpers', () => {
    const w = parseWav(makeWav(441, 44100));
    expect(w).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 44100, bitsPerSample: 16, blockAlign: 2 });
    expect(wavDurationMs(w)).toBe(10);
    expect(() => concatWavs([makeWav(10, 22050), makeWav(10, 44100)])).toThrow(/differ/);
    expect(() => concatWavs([])).toThrow(RangeError);
    expect(() => parseWav(new Uint8Array(4))).toThrow(SyntaxError);
  });
});

describe('stable-diffusion.cpp adapter', () => {
  const sd15: ImageInput = { model: { kind: 'sd15', modelPath: '/m/stable-diffusion.cpp/sd15-emaonly/v1-5-pruned-emaonly.safetensors' }, prompt: 'pantai Bali saat senja', negativePrompt: 'teks', width: 512, height: 896, seed: 42, threads: 4, tier: 'T0' };
  const flux: ImageInput = { ...sd15, model: { kind: 'flux', diffusionModelPath: '/m/f/flux1-schnell-Q4_0.gguf', clipLPath: '/m/f/clip_l.safetensors', t5xxlPath: '/m/f/t5xxl_fp8_e4m3fn.safetensors', vaePath: '/m/f/ae.safetensors' }, width: 768, height: 1344, tier: 'T2' };
  it('argv per LOCAL_AI_MODELS §3.2 (SD 1.5: 20 steps cfg 7.0; FLUX: 4 steps cfg 1.0 + encoders)', () => {
    expect(sdArgs(sd15, '/j/out.png')).toEqual(['-M', 'txt2img', '-m', sd15.model.kind === 'sd15' ? sd15.model.modelPath : '', '-p', 'pantai Bali saat senja', '-n', 'teks',
      '-W', '512', '-H', '896', '--steps', '20', '--cfg-scale', '7.0', '-s', '42', '--vae-tiling', '--clip-on-cpu', '-o', '/j/out.png', '-t', '4']);
    const a = sdArgs(flux, '/j/out.png');
    expect(a.slice(0, 10)).toEqual(['-M', 'txt2img', '--diffusion-model', '/m/f/flux1-schnell-Q4_0.gguf', '--clip_l', '/m/f/clip_l.safetensors', '--t5xxl', '/m/f/t5xxl_fp8_e4m3fn.safetensors', '--vae', '/m/f/ae.safetensors']);
    expect(a).toContain('4'); expect(a[a.indexOf('--cfg-scale') + 1]).toBe('1.0');
    expect(a).not.toContain('-m');
  });
  it('progress parsing', () => {
    expect(parseSdProgress('  |=====>     | 5/20 - 1.20s/it')).toBe(0.25);
    expect(parseSdProgress('sampling 3/4 2.1it/s')).toBe(0.75);
    expect(parseSdProgress('loading model')).toBeNull();
  });
  it('runs sd, validates the PNG, honours timeouts and input limits', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const f = fakeSpawn(async ({ child }) => { child.out('|==>  | 10/20 - 1s/it\n'); await writeFile(join(jobDir, 'out.png'), png); child.exit(0); });
    const progress: number[] = [];
    expect(await generateImage(sd15, ctx(f.spawn, { onProgress: (p) => progress.push(p) }))).toEqual({ pngPath: join(jobDir, 'out.png') });
    expect(progress).toEqual([0, 0.49, 1]);
    const notPng = fakeSpawn(async ({ child }) => { await writeFile(join(jobDir, 'out.png'), 'GIF89a'); child.exit(0); });
    await expectEm(generateImage(sd15, ctx(notPng.spawn)), 'EM-7101');
    const nothing = fakeSpawn(({ child }) => child.exit(0));
    await expectEm(generateImage(flux, ctx(nothing.spawn)), 'EM-7103');
    await expectEm(generateImage({ ...sd15, width: 500 }, ctx(nothing.spawn)), 'EM-9002');
    await expectEm(generateImage({ ...sd15, prompt: '' }, ctx(nothing.spawn)), 'EM-9002');
    await expectEm(generateImage({ ...sd15, seed: -1 }, ctx(nothing.spawn)), 'EM-9002');
    await expectEm(generateImage({ ...sd15, prompt: 'x'.repeat(1001) }, ctx(nothing.spawn)), 'EM-9002');
  });
});

describe('ACE-Step python wrapper adapter', () => {
  const input = { pythonExe: '/m/python/3.11/venv/bin/python', modelDir: '/m/ace-step/ace-step-v1-3.5b', prompt: 'lo-fi santai, instrumental, no vocals', durationMs: 30_500, seed: 7, device: 'cuda' as const, offload: true };
  it('argv per LOCAL_AI_MODELS §3.2', () => {
    expect(aceStepArgs(input, '/j/out.wav')).toEqual(['-I', '-m', 'expertmotion_music', '--model', '/m/ace-step/ace-step-v1-3.5b/', '--prompt', 'lo-fi santai, instrumental, no vocals',
      '--duration', '30.5', '--seed', '7', '--out', '/j/out.wav', '--device', 'cuda', '--offload']);
    expect(aceStepArgs({ ...input, offload: false, prompt: '-x' }, '/o')).not.toContain('--offload');
    expect(aceStepArgs({ ...input, prompt: '-x' }, '/o')[6]).toBe(' -x');
  });
  it('JSON progress lines', () => {
    expect(parseMusicProgress('{"progress":0.5}')).toBe(0.5);
    expect(parseMusicProgress('{"percent":20}')).toBe(0.2);
    expect(parseMusicProgress('{"progress":"x"}')).toBeNull();
    expect(parseMusicProgress('{bad')).toBeNull();
    expect(parseMusicProgress('loading')).toBeNull();
  });
  it('runs python -I with PYTHONNOUSERSITE, PATH = interpreter dir; spawn failure → EM-7107', async () => {
    const f = fakeSpawn(async ({ child }) => { child.out('{"progress":0.4}\n'); await writeFile(join(jobDir, 'out.wav'), makeWav(100)); child.exit(0); });
    expect(await generateMusic(input, ctx(f.spawn))).toEqual({ wavPath: join(jobDir, 'out.wav') });
    expect(f.calls[0]!.command).toBe(input.pythonExe);
    expect(f.calls[0]!.options.env.PYTHONNOUSERSITE).toBe('1');
    expect(f.calls[0]!.options.env.PATH).toBe('/m/python/3.11/venv/bin');
    const missing = fakeSpawn(({ child }) => { child.emit('error', new Error('spawn ENOENT')); });
    await expectEm(generateMusic(input, ctx(missing.spawn)), 'EM-7107');
    const crash = fakeSpawn(({ child }) => child.exit(1));
    await expectEm(generateMusic(input, ctx(crash.spawn)), 'EM-7101');
    const none = fakeSpawn(({ child }) => child.exit(0));
    await expectEm(generateMusic(input, ctx(none.spawn)), 'EM-7103');
    await expectEm(generateMusic({ ...input, durationMs: 1000 }, ctx(none.spawn)), 'EM-9002');
    await expectEm(generateMusic({ ...input, prompt: 'x'.repeat(301) }, ctx(none.spawn)), 'EM-9002');
    await expectEm(generateMusic({ ...input, seed: 1.5 }, ctx(none.spawn)), 'EM-9002');
  });
});
