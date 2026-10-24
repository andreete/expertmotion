// WCAG 2.x contrast ratio for the Text Panel colour hint (FR-023: ≥ 4.5:1 recommended, warn only).
export const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
/** Contrast ratio of two #RRGGBB colours (1…21), or null when either is not a valid hex. */
export function contrastRatio(a: string, b: string): number | null {
  if (!HEX_RE.test(a) || !HEX_RE.test(b)) return null;
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
export const MIN_CONTRAST = 4.5;
