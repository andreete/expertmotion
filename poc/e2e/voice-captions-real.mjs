// Real-engine check for FR-248 / FR-249 (QA 2026-10-28 #7 / #11): Piper id_ID voice (sherpa-onnx) + whisper.cpp on a short
// Indonesian script containing "energi bersih". Captions must read EXACTLY the script (whisper only gives times), and the word
// timing drift must stay under 80 ms per word against an energy-measured ground truth.
//
// Usage (shared server: always capped):
//   bash scripts/run-capped.sh node poc/e2e/voice-captions-real.mjs <modelsDir with piper/ and whisper/ggml-*.bin> <outDir>
// Engines come from resources/engines-linux-x64 (prepare-engines). Nothing is written into the repo.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { refineWordTimes, preparePiperVoice, synthesize, transcribe, buildTranscript, speechWindow, energyFrames, parseWav, wavDurationMs, timeWordsFromTokens, splitWords, transcriptToSrt, meanWordDriftMs, concatWavs } from '../../packages/models/dist/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [modelsDir, outDir] = process.argv.slice(2);
if (!modelsDir || !outDir) { console.error('usage: node poc/e2e/voice-captions-real.mjs <modelsDir> <outDir>'); process.exit(2); }
const eng = path.join(repo, 'resources/engines-linux-x64');
const sub = (e) => path.join(eng, e, fs.readdirSync(path.join(eng, e))[0]);
const sherpaDir = sub('sherpa-onnx'), whisperDir = sub('whisper.cpp');
const whisperModel = fs.readdirSync(path.join(modelsDir, 'whisper')).filter((f) => f.endsWith('.bin')).map((f) => path.join(modelsDir, 'whisper', f))[0];
fs.mkdirSync(outDir, { recursive: true });
const results = []; const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const threads = Math.max(1, Math.min(2, os.cpus().length));

const SCRIPT = 'Indonesia punya energi bersih yang melimpah. Tapi kenapa manfaatnya belum terasa? Mari kita bahas bersama.';
const piperDir = path.join(modelsDir, 'piper');
const voice = { kind: 'vits', ...(await preparePiperVoice(piperDir).then(({ modelPath, tokensPath }) => ({ modelPath, tokensPath }))) };
const job = (n) => { const d = path.join(outDir, n); fs.mkdirSync(d, { recursive: true }); return d; };
const whisper16k = async (wavIn, dir) => {
  // whisper.cpp wants 16 kHz mono: resample with the bundled FFmpeg if present, else ffmpeg on PATH
  const ff = fs.existsSync(path.join(repo, 'resources/bin-linux-x64/ffmpeg')) ? path.join(repo, 'resources/bin-linux-x64/ffmpeg') : 'ffmpeg';
  const { execFileSync } = await import('node:child_process');
  const out = path.join(dir, 'in.wav');
  execFileSync(ff, ['-v', 'error', '-y', '-i', wavIn, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
  return out;
};

// 1) whole script → one clip → whisper → transcript from the script
const d1 = job('script');
const t0 = Date.now();
const s1 = await synthesize({ voice, text: SCRIPT, threads }, { engineDir: sherpaDir, jobDir: d1 });
const wav1 = fs.readFileSync(s1.wavPath);
check('piper synthesised the script', s1.durationMs > 2000, { durationMs: s1.durationMs, ms: Date.now() - t0 });
const w1 = await whisper16k(s1.wavPath, d1);
const tr1 = await transcribe({ modelPath: whisperModel, wavPath: w1, language: 'id', threads, audioDurationMs: s1.durationMs }, { engineDir: whisperDir, jobDir: d1 });
const heard = tr1.captions.map((c) => c.text).join('').trim();
console.log('whisper heard:', JSON.stringify(heard));
const tx = buildTranscript({ spoken: SCRIPT, durationMs: s1.durationMs, tokens: tr1.captions.map((c) => ({ text: c.text, fromMs: c.startMs, toMs: c.endMs })), speech: speechWindow(wav1) ?? undefined, refine: (w) => refineWordTimes(w, energyFrames(wav1)) });
const captionText = tx.cues.map((c) => c.written).join(' ');
check('captions read exactly the script', captionText === SCRIPT, captionText);
check('captions contain "energi bersih"', /energi bersih/.test(captionText));
check('alignment method is aligned with whisper times', tx.method === 'aligned', { method: tx.method, matched: tx.stats.matched, words: tx.stats.words });
fs.writeFileSync(path.join(outDir, 'script.srt'), transcriptToSrt(tx.cues));
fs.writeFileSync(path.join(outDir, 'script.transcript.json'), JSON.stringify(tx, null, 1));

// 2) drift: every word synthesised alone, concatenated → exact word windows (energy onset inside each segment) as ground truth
const words = splitWords(SCRIPT);
const d2 = job('words');
const wavs = []; const seg = [];
let at = 0;
for (const [i, w] of words.entries()) {
  const dj = job(`words/w${i}`);
  const r = await synthesize({ voice, text: w, threads }, { engineDir: sherpaDir, jobDir: dj });
  const b = fs.readFileSync(r.wavPath); wavs.push(b);
  const win = speechWindow(b) ?? { fromMs: 0, toMs: r.durationMs };
  seg.push({ text: w, fromMs: at + win.fromMs, toMs: at + win.toMs });
  at += wavDurationMs(parseWav(b));
}
const joined = concatWavs(wavs, 0);
const jp = path.join(d2, 'joined.wav'); fs.writeFileSync(jp, joined);
const w2 = await whisper16k(jp, d2);
const tr2 = await transcribe({ modelPath: whisperModel, wavPath: w2, language: 'id', threads, audioDurationMs: at }, { engineDir: whisperDir, jobDir: d2 });
const tw = timeWordsFromTokens(words, tr2.captions.map((c) => ({ text: c.text, fromMs: c.startMs, toMs: c.endMs })), { fromMs: 0, toMs: at });
const raw = meanWordDriftMs(tw.words, seg);
console.log('whisper-only drift (info):', Math.round(raw), 'ms');
tw.words = refineWordTimes(tw.words, energyFrames(joined));
const drift = meanWordDriftMs(tw.words, seg);
const per = tw.words.map((w, i) => Math.abs(w.fromMs - seg[i].fromMs));
check('mean word-start drift < 80 ms', drift < 80, { meanMs: Math.round(drift), p90Ms: [...per].sort((a, b) => a - b)[Math.floor(per.length * 0.9)], maxMs: Math.max(...per), matched: tw.matched, words: words.length });
// proportional fallback on the same audio for comparison (no recognition)
const prop = buildTranscript({ spoken: words.join(' '), durationMs: at, speech: speechWindow(joined) ?? undefined });
console.log('proportional fallback drift (info):', Math.round(meanWordDriftMs(prop.words, seg)), 'ms');
const f = energyFrames(wav1); check('energy envelope readable', Array.isArray(f) && f.length > 100);

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), script: SCRIPT, heard, captionText, method: tx.method, driftMs: drift, results }, null, 1));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
