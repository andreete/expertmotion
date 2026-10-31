// Loudness (FR-284): parsing FFmpeg's EBU R128 output and the two-pass `loudnorm` arguments, plus the voice clean-up filter
// chain of the master build. Pure string work; the Local Service runs FFmpeg.

export interface LoudnessMeasure { integratedLufs: number; truePeakDb: number; lra: number; threshold?: number; offset?: number }
export interface LoudnormTarget { targetI?: number; tp?: number; lra?: number }
const num = (s: string | undefined): number => (s === undefined ? NaN : Number(s.trim()));

/** `loudnorm=…:print_format=json` prints a JSON object on stderr; the last one wins. */
export function parseLoudnormJson(stderr: string): Record<string, number> | null {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g); if (!blocks?.length) return null;
  try {
    const raw = JSON.parse(blocks[blocks.length - 1]!) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    return out;
  } catch { return null; }
}

/**
 * Integrated loudness, true peak and loudness range from an FFmpeg stderr: the `ebur128` filter summary ("I: -15.2 LUFS",
 * "LRA: 6.3 LU", "Peak: -1.0 dBFS") or the `loudnorm` JSON (input_i / input_tp / input_lra). null when neither is present.
 */
export function parseEbur128(stderr: string): LoudnessMeasure | null {
  const j = parseLoudnormJson(stderr);
  if (j && Number.isFinite(j.input_i)) return { integratedLufs: j.input_i!, truePeakDb: j.input_tp ?? NaN, lra: j.input_lra ?? NaN, ...(j.input_thresh === undefined ? {} : { threshold: j.input_thresh }), ...(j.target_offset === undefined ? {} : { offset: j.target_offset }) };
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = num(/\bI:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary)?.[1]), lra = num(/\bLRA:\s+(-?[\d.]+)\s+LU\b/.exec(summary)?.[1]), tp = num(/\bPeak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary)?.[1]);
  if (!Number.isFinite(i)) return null;
  const thr = num(/Integrated loudness:[\s\S]*?Threshold:\s+(-?[\d.]+)\s+LUFS/.exec(summary)?.[1]);
  return { integratedLufs: i, truePeakDb: tp, lra, ...(Number.isFinite(thr) ? { threshold: thr } : {}) };
}

const fmt = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0');
/**
 * Two-pass EBU R128 normalisation: `measureArgs(input)` prints the JSON measurement (parse with parseEbur128), then
 * `applyFilter(measured)` is the `-af` filter for the real encode (linear mode keeps the dynamics; one gain change).
 */
export function loudnormArgs(t: LoudnormTarget = {}): { target: Required<LoudnormTarget>; measureFilter: string; measureArgs: (input: string) => string[]; applyFilter: (m: LoudnessMeasure) => string; applyArgs: (input: string, output: string, m: LoudnessMeasure, extra?: string[]) => string[] } {
  const target = { targetI: t.targetI ?? -16, tp: t.tp ?? -1.5, lra: t.lra ?? 11 };
  const base = `loudnorm=I=${fmt(target.targetI)}:TP=${fmt(target.tp)}:LRA=${fmt(target.lra)}`;
  const measureFilter = `${base}:print_format=json`;
  const applyFilter = (m: LoudnessMeasure): string => `${base}:measured_I=${fmt(m.integratedLufs)}:measured_TP=${fmt(m.truePeakDb)}:measured_LRA=${fmt(m.lra)}:measured_thresh=${fmt(m.threshold ?? m.integratedLufs - 10)}:offset=${fmt(m.offset ?? 0)}:linear=true:print_format=summary`;
  return {
    target, measureFilter, applyFilter,
    measureArgs: (input) => ['-hide_banner', '-nostats', '-i', input, '-vn', '-af', measureFilter, '-f', 'null', '-'],
    applyArgs: (input, output, m, extra = []) => ['-hide_banner', '-y', '-i', input, '-vn', '-af', applyFilter(m), ...extra, output],
  };
}

/** The filters of voiceCleanFilter(), each present in the LGPL FFmpeg build (checked with `ffmpeg -filters`, 2026-10-31). */
export const VOICE_CLEAN_FILTERS: readonly string[] = ['highpass', 'equalizer', 'afftdn', 'agate'];
/** Voice clean-up for a phone / camera recording: rumble cut, a dip at the boxy 280 Hz band, FFT denoise, a gentle gate. */
export const voiceCleanFilter = (): string => 'highpass=f=90,equalizer=f=280:t=q:w=1.5:g=-3,afftdn=nf=-25,agate=threshold=0.02:ratio=2:attack=5:release=120';
