// Rotation guess for footage stored sideways without a rotation flag (FR-280): a phone held upright but recorded as
// landscape. Two cues on a small grey frame: (1) the real world has more long horizontal structure (floor, desk, shelves,
// ceiling line) than vertical, so a sideways frame shows dominant VERTICAL edges; (2) rooms are lit from above, so brightness
// falls from the real top to the real bottom — in a sideways frame that gradient runs left ↔ right and tells 90 from 270.
// The Service combines metadata → this heuristic → the Creator's confirmation (confidence < 0.7 asks).

export interface RotationGuess { rotation: 0 | 90 | 270; confidence: number; edgeRatio: number; brightnessSlope: number }

/** Grey frame (`w`×`h`, row-major 8-bit) → suggested clockwise rotation to make it upright. */
export function suggestRotation(gray: Uint8Array, w: number, h: number): RotationGuess {
  if (w < 8 || h < 8 || gray.length < w * h) return { rotation: 0, confidence: 0, edgeRatio: 0, brightnessSlope: 0 };
  // downsample to ≤ 160 px on the long side (box filter) so edge statistics are about structure, not pixels
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 160));
  const W = Math.floor(w / step), H = Math.floor(h / step); const g = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0; for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) s += gray[(y * step + dy) * w + x * step + dx]!;
    g[y * W + x] = s / (step * step);
  }
  // Sobel-like gradients; only strong edges count, weighted by magnitude
  let vert = 0, horiz = 0;                                                        // vert = |gx| energy (vertical lines), horiz = |gy| energy
  const mags: number[] = [];
  const gx = new Float64Array(W * H), gy = new Float64Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    gx[i] = (g[i + 1]! - g[i - 1]!) + 0.5 * (g[i - W + 1]! - g[i - W - 1]! + g[i + W + 1]! - g[i + W - 1]!);
    gy[i] = (g[i + W]! - g[i - W]!) + 0.5 * (g[i + W - 1]! - g[i - W - 1]! + g[i + W + 1]! - g[i - W + 1]!);
    mags.push(Math.hypot(gx[i]!, gy[i]!));
  }
  const sorted = [...mags].sort((a, b) => a - b); const thr = sorted[Math.floor(sorted.length * 0.8)] ?? 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; const m = Math.hypot(gx[i]!, gy[i]!); if (m < thr || m === 0) continue;
    const ax = Math.abs(gx[i]!), ay = Math.abs(gy[i]!);
    if (ax > 2 * ay) vert += m; else if (ay > 2 * ax) horiz += m;                   // near-vertical / near-horizontal edges only
  }
  const edgeRatio = vert + horiz ? (vert - horiz) / (vert + horiz) : 0;             // > 0: vertical lines dominate → sideways
  // brightness slopes: mean of the left vs right third, top vs bottom third (normalised to the frame mean)
  const mean = (x0: number, x1: number, y0: number, y1: number): number => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += g[y * W + x]!; n++; } return n ? s / n : 0; };
  const all = mean(0, W, 0, H) || 1;
  const slopeX = (mean(0, Math.floor(W / 3), 0, H) - mean(Math.ceil((2 * W) / 3), W, 0, H)) / all;   // > 0: left brighter
  const slopeY = (mean(0, W, 0, Math.floor(H / 3)) - mean(0, W, Math.ceil((2 * H) / 3), H)) / all;   // > 0: top brighter (upright)
  const sideways = 0.6 * edgeRatio + 0.4 * (Math.abs(slopeX) - Math.abs(slopeY)) * 2;
  if (sideways <= 0) return { rotation: 0, confidence: clamp01(0.5 + Math.min(0.5, -sideways)), edgeRatio: round3(edgeRatio), brightnessSlope: round3(slopeY) };
  const rotation = slopeX >= 0 ? 90 : 270;                                          // bright side (ceiling) goes to the top
  const confidence = clamp01(0.45 + Math.min(0.35, sideways) + Math.min(0.2, Math.abs(slopeX) * 2));
  return { rotation, confidence: round3(confidence), edgeRatio: round3(edgeRatio), brightnessSlope: round3(slopeX) };
}
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Transposes a grey frame (clockwise rotation by `deg`), for tests and the rotation thumbnails. */
export function rotateGray(gray: Uint8Array, w: number, h: number, deg: 90 | 180 | 270): { gray: Uint8Array; w: number; h: number } {
  const out = new Uint8Array(w * h);
  if (deg === 180) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(h - 1 - y) * w + (w - 1 - x)] = gray[y * w + x]!; return { gray: out, w, h }; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (deg === 90) out[x * h + (h - 1 - y)] = gray[y * w + x]!;                      // clockwise: (x, y) → (h-1-y, x)
    else out[(w - 1 - x) * h + y] = gray[y * w + x]!;
  }
  return { gray: out, w: h, h: w };
}
