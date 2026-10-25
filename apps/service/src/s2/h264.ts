// H.264 encoder choice for ingest (playable transcode and 720p proxy). The shipped ingestion FFmpeg is an LGPL build
// (ADR-019), so it has no libx264 (GPL); it does have libopenh264 (Cisco, BSD) and Windows Media Foundation (h264_mf).
// The encoders are read once per FFmpeg binary from `ffmpeg -encoders`; development builds with libx264 keep using it.
import { runTool } from './proc.js';

export type H264Encoder = 'libx264' | 'libopenh264' | 'h264_mf';
export const H264_PREFERENCE: readonly H264Encoder[] = ['libx264', 'libopenh264', 'h264_mf'];

const cache = new Map<string, Promise<H264Encoder | null>>();

/** Parses `ffmpeg -encoders` output ("V....D libopenh264  OpenH264 H.264 …") into the preferred available H.264 encoder. */
export function pickH264(encodersOutput: string): H264Encoder | null {
  const names = new Set(encodersOutput.split('\n').map((l) => /^\s*V[.A-Z]{5}\s+(\S+)/.exec(l)?.[1]).filter((x): x is string => Boolean(x)));
  return H264_PREFERENCE.find((e) => names.has(e)) ?? null;
}

export function detectH264(ffmpeg: string): Promise<H264Encoder | null> {
  let p = cache.get(ffmpeg);
  if (!p) {
    p = runTool({ exe: ffmpeg, args: ['-hide_banner', '-encoders'], timeoutMs: 15_000, maxCollectBytes: 1_000_000 })
      .then((r) => pickH264(r.stdout)).catch(() => null);
    cache.set(ffmpeg, p);
  }
  return p;
}

/** Video bitrate for the bitrate-driven encoders (OpenH264, Media Foundation), by output pixels. */
export function h264Bitrate(purpose: 'proxy' | 'playable', width: number | null, height: number | null): string {
  if (purpose === 'proxy') return '2500k';
  const px = (width ?? 1920) * (height ?? 1080);
  return px <= 1280 * 720 ? '5M' : px <= 1920 * 1080 ? '10M' : '20M';
}

/** `-c:v …` arguments for one encoder. libx264 keeps the CRF settings documented in ASSET_INGESTION.md §3.4. */
export function h264Args(enc: H264Encoder, purpose: 'proxy' | 'playable', size: { width: number | null; height: number | null }, big = false): string[] {
  if (enc === 'libx264') {
    return purpose === 'proxy'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-level', big ? '5.1' : '4.2'];
  }
  const br = h264Bitrate(purpose, size.width, size.height);
  return enc === 'libopenh264'
    ? ['-c:v', 'libopenh264', '-b:v', br, '-maxrate', br, '-allow_skip_frames', '0']
    : ['-c:v', 'h264_mf', '-b:v', br];
}
