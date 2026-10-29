// FR-266 (2026-10-29): how loud a ducked music bed plays. The bed's OWN volume (Inspector, op:audio.addBed / setVolume) is the
// level between speech; preset:audio.duck-voice's params give the dip as a RATIO duckTo / volume (defaults 0.15 / 0.5 → 30 %).
// Before, the preset's `volume` (default 0.5) replaced the bed's own level, so a quiet 0.2 bed played at 0.5 between speech.
// `k` is how far into a speech window the ramp is (0 = no speech, 1 = fully ducked).
export function duckedVolume(layerVolume: number, params: Record<string, unknown>, k: number): number {
  const pv = Number(params['volume'] ?? 0.5), dt = Number(params['duckTo'] ?? 0.15);
  const ratio = Math.max(0, Math.min(1, Number.isFinite(pv) && pv > 0.001 && Number.isFinite(dt) ? dt / pv : 0.3));
  const full = Math.max(0, Math.min(1, layerVolume));
  const kk = Math.max(0, Math.min(1, k));
  return full + (full * ratio - full) * kk;
}
