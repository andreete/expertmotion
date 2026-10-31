// Shared helpers of the analysis tests: the Reels-42 Test Kit (read-only, never copied into the repo; tests skip without it),
// FFmpeg decoding to 16 kHz mono PCM and the reference numbers of the QA PRD (DESIGN.md).
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { analysis as A, parseWhisperJson } from '../../src/index.js';

export const KIT = process.env.EM_REELS_KIT ?? '/home/andre/expertmotion-feedback/Test Kit';
export const RAW_AUDIO = join(KIT, 'Reels 42 Raw Audio.m4a');
export const RAW_VIDEO = join(KIT, 'Reels 42 Raw Video.MP4');
export const KEY_WORDS = join(KIT, 'reels42 Remotion Bridge', 'reels42-words.json');
/** whisper small-q5 `-oj -ojf -ml 1 -sow` output of the joined phrases (the prototype's listen step, with token probabilities), outside the repo. */
export const LISTEN_JSON = process.env.EM_REELS_LISTEN_JSON ?? '/tmp/claude-1004/-home-andre-expertmotion/b549442d-7045-45f3-8bb6-69f620968509/scratchpad/reels/listen42-full.json';
const FFMPEG_CANDIDATES = [process.env.EM_FFMPEG ?? '', '/home/andre/em-win-deps/ffmpeg-linux-lgpl/ffmpeg-n8.1-latest-linux64-lgpl-8.1/bin/ffmpeg', join(process.cwd(), 'resources', 'bin-linux-x64', 'ffmpeg')].filter(Boolean);
export const FFMPEG = FFMPEG_CANDIDATES.find((p) => existsSync(p)) ?? null;
export const kitReady = (): boolean => existsSync(KIT) && existsSync(RAW_AUDIO) && FFMPEG !== null;

/** 16 kHz mono s16le of a media file through an FFmpeg pipe (the Service does the same). */
export function decodePcm16k(path: string): Int16Array {
  if (!FFMPEG) throw new Error('ffmpeg not found');
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString() ?? r.status}`);
  return A.pcmFromS16le(new Uint8Array(r.stdout));
}
/** One grey frame (w×h bytes) at `atSec`, long side scaled to `w`. */
export function decodeGrayFrame(path: string, atSec: number, w: number): { gray: Uint8Array; w: number; h: number } {
  if (!FFMPEG) throw new Error('ffmpeg not found');
  const probe = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(atSec), '-i', path, '-frames:v', '1', '-vf', `scale=${w}:-2,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 16 * 1024 * 1024 });
  if (probe.status !== 0) throw new Error(`ffmpeg failed: ${probe.stderr?.toString() ?? probe.status}`);
  const gray = new Uint8Array(probe.stdout); const h = Math.round(gray.length / w);
  return { gray, w, h };
}

/** The brief's script (QA PRD prompt B): the hook line plus the Penjelasan paragraph. */
export const SCRIPT = 'Kenapa raksasa teknologi dunia tiba-tiba berlomba borong pembangkit listrik nuklir mini buat AI? '
  + 'Data center AI butuh pasokan listrik raksasa yang stabil 24 jam nonstop tanpa tergantung cuaca seperti panel surya. Solusi paling realistis saat ini adalah SMR atau Small Modular Reactor—yaitu reaktor nuklir skala kecil yang aman dan bisa dibangun dekat lokasi data center. Pembangkit nuklir mini ini mampu menghasilkan energi bersih tanpa emisi karbon dalam jumlah raksasa. Inilah alasan kenapa nuklir mini jadi kartu truf utama raksasa teknologi! Kamu setuju gak kalau AI masa depan ditenagai nuklir?';
/** Kept takes of the answer key (recording seconds). */
export const KEY_CUTS: Array<[number, number]> = [[8.14, 14.54], [48.72, 58.58], [68.72, 75.2], [77.99, 84.2], [91.47, 98.1], [100.44, 106.3], [110.25, 113.9], [116.34, 121.4]];
/** 59 s minus the silent card (3 s), the hold (1.2 s) and the poster (3.5 s). */
export const MAX_SPEECH_MS = 59000 - 3000 - 1200 - 3500;

export interface KeyWord { text: string; startMs: number; endMs: number }
export const readKeyWords = (): KeyWord[] => (JSON.parse(readFileSync(KEY_WORDS, 'utf8')) as KeyWord[]).map((w) => ({ text: w.text.trim(), startMs: w.startMs, endMs: w.endMs }));
/** One TimedWord per whisper segment (`-ml 1`), `conf` = mean token probability when the JSON carries tokens. */
export const readListenWords = (): A.TimedWord[] => parseWhisperJson(readFileSync(LISTEN_JSON, 'utf8')).captions.map((c) => ({ text: c.text, fromMs: c.startMs, toMs: c.endMs, ...(c.confidence === null ? {} : { conf: c.confidence }) }));

/** Fraction of the longer interval covered by the overlap of [a0,a1] and [b0,b1]. */
export const overlapRatio = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(a1 - a0, b1 - b0);
