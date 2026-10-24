import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, MIN_HEIGHT, MIN_WIDTH, parseWindowState, restoreBounds, settingsWithWindow, windowStateFromSettings } from '../src/lib/window-state.js';

const D = [{ x: 0, y: 0, width: 1920, height: 1080 }];
describe('window state (FR-155)', () => {
  it('defaults when nothing was saved or the file is garbage', () => {
    expect(restoreBounds(parseWindowState(null), D)).toEqual(DEFAULT_SIZE);
    expect(parseWindowState({ bounds: { x: 'a' }, maximized: 'yes' })).toEqual({ maximized: false });
  });
  it('restores saved bounds on a connected display and enforces 1280×720', () => {
    expect(restoreBounds({ bounds: { x: 100, y: 50, width: 1500, height: 950 }, maximized: false }, D)).toEqual({ x: 100, y: 50, width: 1500, height: 950 });
    expect(restoreBounds({ bounds: { x: 10, y: 10, width: 800, height: 500 }, maximized: false }, D)).toMatchObject({ width: MIN_WIDTH, height: MIN_HEIGHT });
  });
  it('a window saved on an unplugged monitor reopens centred with a sane size', () => {
    const r = restoreBounds({ bounds: { x: 2500, y: 100, width: 1600, height: 900 }, maximized: false }, D);
    expect(r.x).toBeUndefined();
    expect(r.width).toBeGreaterThanOrEqual(MIN_WIDTH);
  });
  it('keeps the window inside the display when it was partly off-screen', () => {
    const r = restoreBounds({ bounds: { x: 1000, y: 300, width: 1400, height: 900 }, maximized: false }, D);
    expect(r.x! + r.width).toBeLessThanOrEqual(1920);
    expect(r.y! + r.height).toBeLessThanOrEqual(1080);
  });
});

describe('window state in settings.json (FR-155)', () => {
  const b = { x: 100, y: 50, width: 1500, height: 950 };
  it('reads the window key, falling back to the legacy window-state.json content', () => {
    expect(windowStateFromSettings({ theme: 'dark', window: { bounds: b, maximized: true } })).toEqual({ bounds: b, maximized: true });
    expect(windowStateFromSettings({ theme: 'dark' }, { bounds: b, maximized: false })).toEqual({ bounds: b, maximized: false });
    expect(windowStateFromSettings(undefined, undefined)).toEqual({ maximized: false });
  });
  it('writes only the window key and keeps the other settings', () => {
    expect(settingsWithWindow({ theme: 'light', window: { maximized: true } }, { bounds: b, maximized: false })).toEqual({ theme: 'light', window: { bounds: b, maximized: false } });
    expect(settingsWithWindow('garbage', { maximized: true })).toEqual({ window: { maximized: true } });
  });
});
