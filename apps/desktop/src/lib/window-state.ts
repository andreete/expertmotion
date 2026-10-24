/**
 * Window bounds persistence (FR-155): minimum 1280×720, last bounds and maximised state remembered in
 * `<data>/window-state.json`, restored only when they still fit a connected display (a monitor may have been unplugged).
 * Pure functions; main.ts does the I/O.
 */
export const MIN_WIDTH = 1280;
export const MIN_HEIGHT = 720;
export const DEFAULT_SIZE = { width: 1440, height: 900 } as const;

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState { bounds?: Rect; maximized: boolean }

export function parseWindowState(raw: unknown): WindowState {
  if (typeof raw !== 'object' || raw === null) return { maximized: false };
  const v = raw as Record<string, unknown>;
  const b = v['bounds'] as Record<string, unknown> | undefined;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const bounds = b && num(b['x']) && num(b['y']) && num(b['width']) && num(b['height'])
    ? { x: Math.round(b['x'] as number), y: Math.round(b['y'] as number), width: Math.round(b['width'] as number), height: Math.round(b['height'] as number) } : undefined;
  return { ...(bounds ? { bounds } : {}), maximized: v['maximized'] === true };
}

/** Bounds to open with: saved ones if at least 100×100 px of the title area is on a display, sizes clamped to the minimum and the display. */
export function restoreBounds(state: WindowState, displays: readonly Rect[]): { width: number; height: number; x?: number; y?: number } {
  const b = state.bounds;
  if (!b) return { ...DEFAULT_SIZE };
  const d = displays.find((r) => overlap(b, r) >= 100 * 100 && b.y >= r.y && b.y < r.y + r.height - 40);
  if (!d) return { width: Math.max(MIN_WIDTH, Math.min(b.width, DEFAULT_SIZE.width)), height: Math.max(MIN_HEIGHT, Math.min(b.height, DEFAULT_SIZE.height)) };
  const width = Math.max(MIN_WIDTH, Math.min(b.width, d.width));
  const height = Math.max(MIN_HEIGHT, Math.min(b.height, d.height));
  return { x: Math.min(Math.max(b.x, d.x), d.x + d.width - width), y: Math.min(Math.max(b.y, d.y), d.y + d.height - height), width, height };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
