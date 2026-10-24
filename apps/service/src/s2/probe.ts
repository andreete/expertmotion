// Media facts for ingestion (ASSET_INGESTION.md §1–§3, §6, §7): kind sniffing (extension + magic bytes), ffprobe, normalisation,
// the transcode decision, the fast-start check and the waveform reducer. Pure where possible; ffprobe is spawned via runTool.
import fs from 'node:fs';
import path from 'node:path';
import { runTool } from './proc.js';

export type AssetKind = 'video' | 'image' | 'audio' | 'subtitle';
const EXT: Record<string, AssetKind> = {
  '.mp4': 'video', '.m4v': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.avif': 'image', '.apng': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.aac': 'audio', '.m4a': 'audio', '.ogg': 'audio', '.opus': 'audio', '.flac': 'audio',
  '.srt': 'subtitle', '.vtt': 'subtitle',
};
/** FRD §5 / API_SPECIFICATION §2.5 per-kind size limits. */
export const SIZE_LIMIT: Record<AssetKind, number> = { video: 4 * 1024 ** 3, image: 100 * 1024 ** 2, audio: 500 * 1024 ** 2, subtitle: 2 * 1024 ** 2 };
export const MAX_DURATION_MS = 1_800_000;
export const MAX_IMAGE_SIDE = 8192;
export const kindFromExt = (name: string): AssetKind | null => EXT[path.extname(name).toLowerCase()] ?? null;

/** Magic-byte sniff of the first bytes (SEC-067). Returns the family or null when the bytes match nothing we accept. */
export function sniff(head: Buffer): 'isobmff' | 'matroska' | 'png' | 'jpeg' | 'gif' | 'webp' | 'wav' | 'mp3' | 'ogg' | 'flac' | 'aac' | 'text' | null {
  const s = (a: number, b: number) => head.subarray(a, b).toString('latin1');
  if (head.length >= 12 && s(4, 8) === 'ftyp') return 'isobmff';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
  if (s(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (s(0, 4) === 'GIF8') return 'gif';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (s(0, 3) === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe6) === 0xe2)) return 'mp3';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0) return 'aac';
  if (head.length > 0 && !head.subarray(0, Math.min(head.length, 512)).includes(0)) return 'text';
  return null;
}
const FAMILIES: Record<AssetKind, readonly string[]> = {
  video: ['isobmff', 'matroska'], image: ['png', 'jpeg', 'gif', 'webp', 'isobmff'], audio: ['isobmff', 'wav', 'mp3', 'ogg', 'flac', 'aac'], subtitle: ['text'],
};
export function sniffMatches(kind: AssetKind, head: Buffer): boolean { const f = sniff(head); return f !== null && FAMILIES[kind].includes(f); }
export async function readHead(file: string, n = 64): Promise<Buffer> {
  const fh = await fs.promises.open(file, 'r');
  try { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}

export interface ProbeStream { codec_type?: string; codec_name?: string; profile?: string; width?: number; height?: number; pix_fmt?: string; bits_per_raw_sample?: string;
  r_frame_rate?: string; avg_frame_rate?: string; nb_frames?: string; duration?: string; channels?: number; sample_rate?: string; color_transfer?: string; color_primaries?: string;
  disposition?: { attached_pic?: number }; side_data_list?: Array<{ rotation?: number }>; tags?: Record<string, string> }
export interface ProbeJson { streams?: ProbeStream[]; format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string } }

export async function ffprobe(exe: string, file: string, signal?: AbortSignal): Promise<ProbeJson> {
  const r = await runTool({ exe, args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file], timeoutMs: 60_000, maxCollectBytes: 2 * 1024 * 1024, ...(signal ? { signal } : {}) });
  const j = JSON.parse(r.stdout) as ProbeJson;
  if (!j || !Array.isArray(j.streams) || j.streams.length === 0) throw new Error('no streams');
  return j;
}

const rate = (r?: string): number => { if (!r) return 0; const [a, b] = r.split('/').map(Number); return b ? (a ?? 0) / b : Number(a ?? 0); };
const STD_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
export const nearestFps = (f: number): number => STD_FPS.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), 30);

export interface MediaFacts {
  kind: AssetKind; durationMs: number | null; width: number | null; height: number | null; fps: number | null; hasAudio: boolean;
  codec: string | null; pixFmt: string | null; bitDepth: number | null; hdr: boolean; vfr: boolean; rotated: boolean; animated: boolean;
  audioCodec: string | null; channels: number | null; formatName: string;
}
/** Normalises ffprobe output (§3.2) for a kind decided by extension/sniff. Display dimensions account for rotation. */
export function normalizeProbe(kind: AssetKind, p: ProbeJson): MediaFacts {
  const streams = p.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmtDur = Number(p.format?.duration ?? NaN);
  const durS = Number.isFinite(fmtDur) ? fmtDur : Number(v?.duration ?? a?.duration ?? NaN);
  const rotation = Math.abs(Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.['rotate'] ?? 0)) % 180;
  const rotated = rotation === 90;
  const w = v?.width ?? null, h = v?.height ?? null;
  const avg = rate(v?.avg_frame_rate), real = rate(v?.r_frame_rate);
  const vfr = kind === 'video' && avg > 0 && real > 0 && Math.abs(avg - real) / real > 0.005;
  const transfer = v?.color_transfer ?? '';
  const nb = Number(v?.nb_frames ?? 0);
  return {
    kind, durationMs: kind === 'image' ? null : Number.isFinite(durS) ? Math.round(durS * 1000) : null,
    width: rotated ? h : w, height: rotated ? w : h, fps: kind === 'video' && avg > 0 ? nearestFps(avg) : null, hasAudio: !!a,
    codec: v?.codec_name ?? a?.codec_name ?? null, pixFmt: v?.pix_fmt ?? null, bitDepth: v?.bits_per_raw_sample ? Number(v.bits_per_raw_sample) : null,
    hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67' || v?.color_primaries === 'bt2020', vfr, rotated,
    animated: kind === 'image' && (nb > 1 || (v?.codec_name === 'gif' && Number(v?.duration ?? 0) > 0.1)),
    audioCodec: a?.codec_name ?? null, channels: a?.channels ?? null, formatName: p.format?.format_name ?? '',
  };
}

/** §1/§2 limits after probe. Returns an EM code + reason, or null. */
export function checkLimits(f: MediaFacts): { code: 'EM-1001' | 'EM-1008' | 'EM-1011'; reason: string } | null {
  if (f.kind === 'image') {
    if (!f.width || !f.height) return { code: 'EM-1001', reason: 'no-image' };
    if (f.width > MAX_IMAGE_SIDE || f.height > MAX_IMAGE_SIDE) return { code: 'EM-1008', reason: 'dimensions' };
    return null;
  }
  if (f.kind === 'video') {
    if (!f.width || !f.height) return { code: 'EM-1001', reason: 'no-video-stream' };
    if (f.width < 64 || f.height < 64 || Math.max(f.width, f.height) > 7680 || Math.min(f.width, f.height) > 4320) return { code: 'EM-1001', reason: 'dimensions' };
  }
  if (f.kind === 'audio' && !f.hasAudio) return { code: 'EM-1001', reason: 'no-audio-stream' };
  if (f.durationMs !== null && f.durationMs > MAX_DURATION_MS) return { code: 'EM-1011', reason: 'duration' };
  return null;
}

export type PlayablePlan = 'original' | 'remux' | 'transcode';
/** §3.3: skip transcoding only for fast-start H.264 yuv420p 8-bit SDR CFR MP4/MOV with AAC ≤ 2 ch (or no audio). */
export function decidePlayable(f: MediaFacts, faststart: boolean): PlayablePlan {
  if (f.kind === 'audio') return f.audioCodec === 'mp3' || f.audioCodec === 'aac' ? 'original' : 'transcode';
  if (f.kind !== 'video') return 'original';
  const okVideo = f.formatName.includes('mp4') && f.codec === 'h264' && f.pixFmt === 'yuv420p' && (f.bitDepth === null || f.bitDepth <= 8) && !f.hdr && !f.vfr;
  const okAudio = !f.hasAudio || (f.audioCodec === 'aac' && (f.channels ?? 2) <= 2);
  if (!okVideo || !okAudio) return 'transcode';
  return faststart ? 'original' : 'remux';
}

/** Walks top-level ISO-BMFF boxes: true when `moov` comes before `mdat`. */
export async function isFastStart(file: string): Promise<boolean> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size; let off = 0; const hdr = Buffer.alloc(16);
    for (let i = 0; i < 64 && off + 8 <= size; i++) {
      await fh.read(hdr, 0, 16, off);
      let len = hdr.readUInt32BE(0); const type = hdr.subarray(4, 8).toString('latin1');
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (len === 1) len = Number(hdr.readBigUInt64BE(8)); else if (len === 0) return false;
      if (len < 8) return false;
      off += len;
    }
    return false;
  } finally { await fh.close(); }
}

/**
 * Streaming WAV (s16le mono) → 8-bit peaks at 100 windows/s (§3.7). The slim FFmpeg has no raw `s16le` muxer, so the pipe
 * carries a WAV container and this reducer skips the RIFF header up to the `data` chunk.
 */
export class WaveformReducer {
  private header = Buffer.alloc(0); private inData = false; private carry: Buffer | null = null;
  private windowMax = 0; private inWindow = 0; private samples = 0;
  readonly peaks: number[] = [];
  constructor(private readonly sampleRate = 8000, private readonly perWindow = 80) {}
  push(chunk: Buffer): void {
    let buf = chunk;
    if (!this.inData) {
      this.header = Buffer.concat([this.header, chunk]);
      const i = this.header.indexOf('data', 12, 'latin1');
      if (i < 0 || this.header.length < i + 8) { if (this.header.length > 1 << 16) throw new Error('no data chunk'); return; }
      this.inData = true; buf = this.header.subarray(i + 8); this.header = Buffer.alloc(0);
    }
    if (this.carry) { buf = Buffer.concat([this.carry, buf]); this.carry = null; }
    const even = buf.length - (buf.length % 2);
    for (let o = 0; o < even; o += 2) {
      const v = Math.abs(buf.readInt16LE(o)); if (v > this.windowMax) this.windowMax = v;
      this.samples++;
      if (++this.inWindow === this.perWindow) this.flushWindow();
    }
    if (even < buf.length) this.carry = buf.subarray(even);
  }
  private flushWindow(): void { this.peaks.push(Math.min(255, Math.round((this.windowMax / 32768) * 255))); this.windowMax = 0; this.inWindow = 0; }
  finish(): { version: 1; sampleRate: number; channels: 1; bits: 8; lengthMs: number; peaks: number[] } {
    if (this.inWindow > 0) this.flushWindow();
    return { version: 1, sampleRate: Math.round(this.sampleRate / this.perWindow), channels: 1, bits: 8, lengthMs: Math.round((this.samples / this.sampleRate) * 1000), peaks: this.peaks };
  }
}
