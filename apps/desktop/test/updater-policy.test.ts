import { describe, expect, it } from 'vitest';
import { shouldCheckForUpdates, updaterConfig } from '../src/lib/updater-policy.js';

describe('updater policy (SEC-090…096)', () => {
  it('is autoDownload off, no downgrade, verified signature', () => {
    const c = updaterConfig('https://host/win');
    expect(c).toEqual({ autoDownload: false, allowDowngrade: false, channel: 'latest', feedUrl: 'https://host/win', verifyUpdateCodeSignature: true });
  });

  const base = { privateMode: false, lastCheckAt: null, editorInteractive: true, now: 1_000_000 };

  it('never checks in Private Mode (SEC-094)', () => {
    expect(shouldCheckForUpdates({ ...base, privateMode: true })).toEqual({ check: false, reason: 'private-mode' });
  });

  it('waits until the Editor is interactive', () => {
    expect(shouldCheckForUpdates({ ...base, editorInteractive: false })).toEqual({ check: false, reason: 'not-interactive' });
  });

  it('checks once, then not again within 24 h', () => {
    expect(shouldCheckForUpdates(base)).toEqual({ check: true });
    expect(shouldCheckForUpdates({ ...base, lastCheckAt: base.now - 60_000 })).toEqual({ check: false, reason: 'too-soon' });
    expect(shouldCheckForUpdates({ ...base, lastCheckAt: base.now - 25 * 60 * 60 * 1000 })).toEqual({ check: true });
  });
});
