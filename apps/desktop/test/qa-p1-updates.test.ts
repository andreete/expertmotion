// QA P1 2026-10-29 (round 1): "Updates paused by Private Mode" on every launch. The check ran before the Service was ready and
// privateModeOn() failed closed to true; builds without an update feed ran it at all. Now: unknown ≠ Private Mode, no feed → nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planUpdateCheck, pausedBannerAllowed, UNKNOWN_PRIVATE_MODE_RETRY_MS } from '../src/lib/updater-policy.js';

const base = { lastCheckAt: null, editorInteractive: true, now: 1_000_000 };

describe('QA P1: update banner only for real Private Mode', () => {
  it('Service not ready yet (Private Mode unknown): no check, NO paused banner, retry shortly', () => {
    expect(planUpdateCheck({ ...base, feed: true, privateMode: 'unknown' })).toEqual({ check: false, reason: 'service-not-ready', banner: null, retryMs: UNKNOWN_PRIVATE_MODE_RETRY_MS });
  });
  it('a build without an update feed: no check and no banner, whatever Private Mode is', () => {
    for (const pm of ['on', 'off', 'unknown'] as const) expect(planUpdateCheck({ ...base, feed: false, privateMode: pm })).toEqual({ check: false, reason: 'no-feed', banner: null });
  });
  it('Private Mode really on: the paused banner; off: the check runs', () => {
    expect(planUpdateCheck({ ...base, feed: true, privateMode: 'on' })).toEqual({ check: false, reason: 'private-mode', banner: 'paused' });
    expect(planUpdateCheck({ ...base, feed: true, privateMode: 'off' })).toEqual({ check: true });
    expect(planUpdateCheck({ ...base, feed: true, privateMode: 'off', lastCheckAt: base.now - 1000 })).toEqual({ check: false, reason: 'too-soon', banner: null });
    expect(pausedBannerAllowed('on')).toBe(true); expect(pausedBannerAllowed('unknown')).toBe(false); expect(pausedBannerAllowed('off')).toBe(false);
  });
  it('main.ts: every "paused" push is gated by real Private Mode, and nothing runs without a feed', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    const paused = src.split('\n').filter((l) => l.includes("setUpdate({ type: 'paused' })"));
    expect(paused.length).toBeGreaterThan(0);
    for (const l of paused) expect(l).toMatch(/pausedBannerAllowed\(pm\)|decision\.banner === 'paused'/);
    expect(src).toMatch(/function scheduleUpdateCheck\(\): void \{\n\s+if \(!app\.isPackaged \|\| !updatesEnabled\) return;/);
    expect(src).toMatch(/async function onUpdateAction\(action: UpdateAction\): Promise<void> \{\n\s+if \(!app\.isPackaged \|\| !updatesEnabled\) return;/);
    expect(src).toMatch(/if \(endpoint === null \|\| lastServiceState\.status !== 'ready'\) return 'unknown';/);
  });
});
