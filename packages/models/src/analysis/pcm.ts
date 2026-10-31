// PCM helpers for the footage analysis (FR-280 … FR-284): RMS envelopes in dB, statistics, 16-bit mono WAV read / write.
// Pure functions; the Local Service decodes media to 16 kHz mono s16le with FFmpeg and injects the samples.
import { encodeWav, parseWav } from '../engines/sherpa.js';

export const DB_FLOOR = -120;

/** RMS envelope in dBFS per `hopMs` window (−120 dB floor for digital silence). */
export function rmsEnvelopeDb(pcm: Int16Array, sr: number, hopMs = 10): Float64Array {
  const hop = Math.max(1, Math.round((sr * hopMs) / 1000));
  const n = Math.floor(pcm.length / hop);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const base = i * hop;
    for (let j = 0; j < hop; j++) { const v = pcm[base + j]! / 32768; s += v * v; }
    out[i] = Math.max(DB_FLOOR, 10 * Math.log10(s / hop + 1e-12));
  }
  return out;
}

/** Mean 0, standard deviation 1 (a flat input stays all zeros). */
export function zscore(a: ArrayLike<number>): Float64Array {
  const n = a.length; const out = new Float64Array(n); if (!n) return out;
  let m = 0; for (let i = 0; i < n; i++) m += a[i]!; m /= n;
  let v = 0; for (let i = 0; i < n; i++) v += (a[i]! - m) ** 2;
  const sd = Math.sqrt(v / n) || 1;
  for (let i = 0; i < n; i++) out[i] = (a[i]! - m) / sd;
  return out;
}

/** Value at quantile `p` (0..1) of the sorted copy (nearest-rank, floor). */
export function percentile(a: ArrayLike<number>, p: number): number {
  if (!a.length) return NaN;
  const s = Float64Array.from(a as ArrayLike<number>).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]!;
}

export const median = (a: ArrayLike<number>): number => percentile(a, 0.5);

/** Mono Int16 samples of a 16-bit PCM WAV (channels are averaged). */
export function readWav16(wav: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const w = parseWav(wav);
  if (w.audioFormat !== 1 || w.bitsPerSample !== 16) throw new SyntaxError('expected 16-bit PCM wav');
  const ch = Math.max(1, w.channels); const frames = Math.floor(w.data.byteLength / Math.max(2 * ch, w.blockAlign));
  const view = new DataView(w.data.buffer, w.data.byteOffset, w.data.byteLength);
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0; for (let c = 0; c < ch; c++) v += view.getInt16(i * w.blockAlign + c * 2, true);
    pcm[i] = Math.round(v / ch);
  }
  return { pcm, sampleRate: w.sampleRate };
}

/** A 16-bit mono PCM WAV file of `pcm` at `sr` Hz. */
export function writeWav16(pcm: Int16Array, sr: number): Uint8Array {
  const data = new Uint8Array(pcm.length * 2); const dv = new DataView(data.buffer);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i]!, true);
  return encodeWav({ audioFormat: 1, channels: 1, sampleRate: sr, blockAlign: 2, bitsPerSample: 16 }, data);
}

/** Int16 view of raw little-endian s16le bytes (FFmpeg `-f s16le` pipe output); copies when the byte offset is odd. */
export function pcmFromS16le(bytes: Uint8Array): Int16Array {
  const len = Math.floor(bytes.byteLength / 2);
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, len);
  const copy = new Uint8Array(len * 2); copy.set(bytes.subarray(0, len * 2));
  return new Int16Array(copy.buffer);
}

/** Second-order (RBJ) band-pass of `pcm` around `fc` Hz with quality `q`, as floats in [−1, 1]. */
export function bandpassPcm(pcm: Int16Array, sr: number, fc: number, q: number): Float64Array {
  const w0 = (2 * Math.PI * Math.min(fc, sr / 2 - 1)) / sr, alpha = Math.sin(w0) / (2 * q), cosw = Math.cos(w0);
  const b0 = alpha / (1 + alpha), b2 = -alpha / (1 + alpha), a1 = (-2 * cosw) / (1 + alpha), a2 = (1 - alpha) / (1 + alpha);
  const y = new Float64Array(pcm.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! / 32768; const o = b0 * v + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o;
  }
  return y;
}
/** RMS envelope in dB of float samples (see rmsEnvelopeDb). */
export function rmsEnvelopeDbF(x: Float64Array, sr: number, hopMs: number): Float64Array {
  const hop = Math.max(1, Math.round((sr * hopMs) / 1000)); const n = Math.floor(x.length / hop); const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const base = i * hop; for (let j = 0; j < hop; j++) s += x[base + j]! ** 2; out[i] = Math.max(DB_FLOOR, 10 * Math.log10(s / hop + 1e-12)); }
  return out;
}

/** Peak sample magnitude in dBFS. */
export function peakDb(pcm: Int16Array): number {
  let p = 0; for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]!); if (v > p) p = v; }
  return p ? 20 * Math.log10(p / 32768) : DB_FLOOR;
}
