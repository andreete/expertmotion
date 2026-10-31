// Procedural sound effects (FR-284, ADR-039): short self-made sounds (CC0) synthesised deterministically, so a project never
// depends on a downloaded SFX pack. Mono Int16, peak −6 dBFS.

export type SfxKind = 'whoosh' | 'pop' | 'click' | 'tick' | 'ding' | 'rise';
export const SFX_KINDS: readonly SfxKind[] = ['whoosh', 'pop', 'click', 'tick', 'ding', 'rise'];
/** `soundMs` = the audible part; `durationMs` = the file length (≥ MIN_SFX_MS so an SFX layer satisfies the Composition Model's 100 ms minimum). */
export interface SfxMeta { kind: SfxKind; durationMs: number; soundMs: number; licence: string; description: string }
export const MIN_SFX_MS = 120;
const meta = (kind: SfxKind, soundMs: number, description: string): SfxMeta => ({ kind, soundMs, durationMs: Math.max(MIN_SFX_MS, soundMs), licence: SFX_LICENCE, description });
export const SFX_LICENCE = 'self-made, CC0';
export const SFX_LIBRARY: Readonly<Record<SfxKind, SfxMeta>> = Object.freeze({
  whoosh: meta('whoosh', 350, 'band-passed noise sweep (scene change)'),
  pop: meta('pop', 60, 'sine drop 900→300 Hz (icon lands)'),
  click: meta('click', 15, 'short click (button, CTA)'),
  tick: meta('tick', 25, 'tick (progress, typing)'),
  ding: meta('ding', 600, 'decaying harmonics at 1200 Hz (card completes)'),
  rise: meta('rise', 500, 'sine sweep 300→1200 Hz (rows build up)'),
});
export const SFX_PEAK_DBFS = -6;

/** Deterministic noise in [−1, 1] (LCG, fixed seed). */
function noise(n: number, seed = 12345): Float64Array {
  const out = new Float64Array(n); let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s / 2147483648 - 1; }
  return out;
}
/** Two-pole resonant band-pass with a per-sample centre frequency (state-variable form). */
function bandSweep(x: Float64Array, sr: number, f0: number, f1: number, q: number): Float64Array {
  const out = new Float64Array(x.length); let low = 0, band = 0;
  for (let i = 0; i < x.length; i++) {
    const f = f0 + (f1 - f0) * (i / x.length); const w = 2 * Math.sin((Math.PI * Math.min(f, sr / 4)) / sr);
    const high = x[i]! - low - band / q; band += w * high; low += w * band; out[i] = band;
  }
  return out;
}
const toInt16 = (x: Float64Array, peakDb: number): Int16Array => {
  let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  const g = p ? Math.pow(10, peakDb / 20) / p : 0; const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, x[i]! * g)) * 32767);
  return out;
};

/** The samples of one effect at `sr` Hz (48 kHz default), peak −6 dBFS, identical on every call. */
export function synthSfx(kind: SfxKind, sr = 48000): Int16Array {
  const { soundMs, durationMs } = SFX_LIBRARY[kind]; const n = Math.round((sr * soundMs) / 1000); const x = new Float64Array(Math.round((sr * durationMs) / 1000));   // silence after the sound
  const t = (i: number): number => i / sr;
  switch (kind) {
    case 'whoosh': {
      const b = bandSweep(noise(n), sr, 400, 2600, 2.5);
      for (let i = 0; i < n; i++) { const u = i / n; x[i] = b[i]! * Math.sin(Math.PI * u) ** 2 * (0.4 + 0.6 * u); }
      break;
    }
    case 'pop': {
      let ph = 0;
      for (let i = 0; i < n; i++) { const u = i / n; ph += (2 * Math.PI * (900 - 600 * u)) / sr; x[i] = Math.sin(ph) * Math.exp(-u * 5); }
      break;
    }
    case 'click': {
      const nz = noise(n, 777);
      for (let i = 0; i < n; i++) { const u = i / n; x[i] = (0.6 * nz[i]! + 0.4 * Math.sin(2 * Math.PI * 2000 * t(i))) * Math.exp(-u * 6); }
      break;
    }
    case 'tick': {
      for (let i = 0; i < n; i++) { const u = i / n; x[i] = Math.sin(2 * Math.PI * 3000 * t(i)) * Math.exp(-u * 7) * Math.min(1, i / (0.001 * sr)); }
      break;
    }
    case 'ding': {
      for (let i = 0; i < n; i++) {
        const s = t(i);
        x[i] = Math.sin(2 * Math.PI * 1200 * s) * Math.exp(-s * 5) + 0.5 * Math.sin(2 * Math.PI * 2400 * s) * Math.exp(-s * 8) + 0.25 * Math.sin(2 * Math.PI * 3600 * s) * Math.exp(-s * 12);
        x[i]! *= Math.min(1, i / (0.002 * sr));
      }
      break;
    }
    case 'rise': {
      let ph = 0;
      for (let i = 0; i < n; i++) { const u = i / n; ph += (2 * Math.PI * (300 + 900 * u)) / sr; x[i] = Math.sin(ph) * Math.sin(Math.PI * u) ** 0.7; }
      break;
    }
  }
  return toInt16(x, SFX_PEAK_DBFS);
}
