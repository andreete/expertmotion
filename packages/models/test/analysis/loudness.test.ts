import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { analysis as A } from '../../src/index.js';
import { FFMPEG, RAW_AUDIO, kitReady } from './kit.js';

const EBUR = `[Parsed_ebur128_0 @ 0x55d] Summary:

  Integrated loudness:
    I:         -15.2 LUFS
    Threshold: -25.6 LUFS

  Loudness range:
    LRA:        6.3 LU
    Threshold: -35.7 LUFS
    LRA low:   -19.9 LUFS
    LRA high:  -13.6 LUFS

  True peak:
    Peak:       -1.0 dBFS
`;
const LOUDNORM = `[Parsed_loudnorm_0 @ 0x1]
{
	"input_i" : "-23.47",
	"input_tp" : "-6.12",
	"input_lra" : "9.80",
	"input_thresh" : "-33.90",
	"output_i" : "-16.10",
	"output_tp" : "-1.50",
	"output_lra" : "9.20",
	"output_thresh" : "-26.40",
	"normalization_type" : "dynamic",
	"target_offset" : "0.10"
}
`;

describe('analysis/loudness', () => {
  it('parseEbur128 reads the ebur128 summary and the loudnorm JSON; null for neither', () => {
    expect(A.parseEbur128(EBUR)).toEqual({ integratedLufs: -15.2, truePeakDb: -1, lra: 6.3, threshold: -25.6 });
    expect(A.parseEbur128(LOUDNORM)).toEqual({ integratedLufs: -23.47, truePeakDb: -6.12, lra: 9.8, threshold: -33.9, offset: 0.1 });
    expect(A.parseEbur128('frame=1 fps=0 size=0kB')).toBeNull();
    expect(A.parseLoudnormJson(LOUDNORM)?.output_i).toBe(-16.1);
    expect(A.parseLoudnormJson('{ "input_i": "-inf" }')).toEqual({});
  });
  it('loudnormArgs builds the two-pass filter strings and argv', () => {
    const ln = A.loudnormArgs();
    expect(ln.target).toEqual({ targetI: -16, tp: -1.5, lra: 11 });
    expect(ln.measureFilter).toBe('loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json');
    expect(ln.measureArgs('/in.m4a')).toEqual(['-hide_banner', '-nostats', '-i', '/in.m4a', '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
    const m = A.parseEbur128(LOUDNORM)!;
    expect(ln.applyFilter(m)).toBe('loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-23.47:measured_TP=-6.12:measured_LRA=9.8:measured_thresh=-33.9:offset=0.1:linear=true:print_format=summary');
    expect(ln.applyArgs('/in.wav', '/out.wav', m, ['-c:a', 'pcm_s16le'])).toEqual(['-hide_banner', '-y', '-i', '/in.wav', '-vn', '-af', ln.applyFilter(m), '-c:a', 'pcm_s16le', '/out.wav']);
    expect(A.loudnormArgs({ targetI: -14, tp: -1, lra: 7 }).applyFilter({ integratedLufs: -20, truePeakDb: -3, lra: 5 })).toBe('loudnorm=I=-14:TP=-1:LRA=7:measured_I=-20:measured_TP=-3:measured_LRA=5:measured_thresh=-30:offset=0:linear=true:print_format=summary');
  });
  it('voiceCleanFilter is the documented chain and names every filter it uses', () => {
    expect(A.voiceCleanFilter()).toBe('highpass=f=90,equalizer=f=280:t=q:w=1.5:g=-3,afftdn=nf=-25,agate=threshold=0.02:ratio=2:attack=5:release=120');
    const used = A.voiceCleanFilter().split(',').map((f) => f.split('=')[0]);
    expect(used).toEqual([...A.VOICE_CLEAN_FILTERS]);
  });
});

describe.skipIf(!FFMPEG)('analysis/loudness (FFmpeg build)', () => {
  it('every filter of voiceCleanFilter() and loudnorm / ebur128 exist in the LGPL build', () => {
    const out = spawnSync(FFMPEG!, ['-hide_banner', '-filters']).stdout.toString();
    for (const f of [...A.VOICE_CLEAN_FILTERS, 'loudnorm', 'ebur128']) expect(new RegExp(`\\s${f}\\s`).test(out), f).toBe(true);
  });
  it.skipIf(!kitReady() || !existsSync(RAW_AUDIO))('measures the raw voice with the two-pass loudnorm (first pass) and parses it', () => {
    const ln = A.loudnormArgs();
    const r = spawnSync(FFMPEG!, ln.measureArgs(RAW_AUDIO), { maxBuffer: 8 * 1024 * 1024 });
    const m = A.parseEbur128(r.stderr.toString());
    // eslint-disable-next-line no-console
    console.log(`[kit] raw voice loudness ${JSON.stringify(m)}`);
    expect(m).not.toBeNull();
    expect(m!.integratedLufs).toBeGreaterThan(-40); expect(m!.integratedLufs).toBeLessThan(-5);
    expect(m!.truePeakDb).toBeLessThanOrEqual(3);
    expect(ln.applyFilter(m!)).toContain(`measured_I=${Math.round(m!.integratedLufs * 100) / 100}`);
  }, 30_000);   // a 122 s m4a decode + loudnorm pass; the shared server may be busy
});
