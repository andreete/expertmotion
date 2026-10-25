import { describe, expect, it } from 'vitest';
import { h264Args, h264Bitrate, pickH264 } from '../../src/s2/h264.js';

const enc = (names: string[]) => ['Encoders:', ' V..... = Video', ' ------', ...names.map((n) => ` V....D ${n.padEnd(20)} some encoder`), ' A....D aac                  AAC'].join('\n');

describe('H.264 encoder choice (LGPL ingestion FFmpeg has no libx264)', () => {
  it('prefers libx264, then libopenh264, then h264_mf; none → null', () => {
    expect(pickH264(enc(['libx264', 'libopenh264', 'h264_mf']))).toBe('libx264');
    expect(pickH264(enc(['libopenh264', 'h264_mf', 'h264_nvenc']))).toBe('libopenh264');
    expect(pickH264(enc(['h264_mf']))).toBe('h264_mf');
    expect(pickH264(enc(['mpeg4']))).toBeNull();
  });
  it('bitrate-driven encoders get a bitrate by size; libx264 keeps CRF', () => {
    expect(h264Args('libopenh264', 'proxy', { width: 1280, height: 720 })).toEqual(['-c:v', 'libopenh264', '-b:v', '2500k', '-maxrate', '2500k', '-allow_skip_frames', '0']);
    expect(h264Bitrate('playable', 3840, 2160)).toBe('20M');
    expect(h264Bitrate('playable', 1920, 1080)).toBe('10M');
    expect(h264Args('h264_mf', 'playable', { width: 1280, height: 720 })).toEqual(['-c:v', 'h264_mf', '-b:v', '5M']);
    expect(h264Args('libx264', 'playable', { width: 1920, height: 1080 })).toContain('-crf');
  });
});
