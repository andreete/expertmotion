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

describe('update banner state (FR-152, FR-162)', () => {
  it('available → downloading → downloaded (EM-8105) and stays offered', async () => {
    const { nextUpdateState } = await import('../src/lib/updater-policy.js');
    let s = nextUpdateState({ status: 'idle' }, { type: 'checking' });
    expect(s).toEqual({ status: 'checking' });
    s = nextUpdateState(s, { type: 'available', version: '1.1.0' });
    s = nextUpdateState(s, { type: 'progress', percent: 41.6 });
    expect(s).toEqual({ status: 'downloading', version: '1.1.0', percent: 42 });
    s = nextUpdateState(s, { type: 'downloaded', version: '1.1.0' });
    expect(s).toEqual({ status: 'downloaded', version: '1.1.0', code: 'EM-8105' });
    expect(nextUpdateState(s, { type: 'checking' })).toBe(s);
    expect(nextUpdateState(s, { type: 'paused' })).toBe(s);
    const d = nextUpdateState(s, { type: 'deferred' });
    expect(d.status).toBe('deferred');
    expect(nextUpdateState(d, { type: 'resumed' }).status).toBe('downloaded');
  });
  it('Private Mode shows paused; errors map to EM-8101/8102/8103/8104', async () => {
    const { nextUpdateState, updateErrorCode } = await import('../src/lib/updater-policy.js');
    expect(nextUpdateState({ status: 'idle' }, { type: 'paused' })).toEqual({ status: 'paused' });
    expect(updateErrorCode('net::ERR_INTERNET_DISCONNECTED', 'check')).toBe('EM-8101');
    expect(updateErrorCode('socket hang up', 'download')).toBe('EM-8102');
    expect(updateErrorCode('New version is not signed by the application owner', 'download')).toBe('EM-8103');
    expect(updateErrorCode('installer exited 2', 'install')).toBe('EM-8104');
  });
  it('never installs while a Render Job runs', async () => {
    const { installDecision } = await import('../src/lib/updater-policy.js');
    expect(installDecision({ renderActive: true, downloaded: true })).toBe('defer');
    expect(installDecision({ renderActive: false, downloaded: true })).toBe('install');
    expect(installDecision({ renderActive: false, downloaded: false })).toBe('nothing');
  });
});

describe('background download and EM-8104 rollback detection (FR-152)', () => {
  it('downloads in the background only when not Private Mode, not metered and no render runs', async () => {
    const { downloadDecision } = await import('../src/lib/updater-policy.js');
    const base = { privateMode: false, metered: null, renderActive: false, status: 'available' as const };
    expect(downloadDecision(base)).toEqual({ download: true });
    expect(downloadDecision({ ...base, metered: false })).toEqual({ download: true });
    expect(downloadDecision({ ...base, privateMode: true })).toEqual({ download: false, reason: 'private-mode' });
    expect(downloadDecision({ ...base, metered: true })).toEqual({ download: false, reason: 'metered' });
    expect(downloadDecision({ ...base, renderActive: true })).toEqual({ download: false, reason: 'rendering' });
    expect(downloadDecision({ ...base, status: 'downloaded' })).toEqual({ download: false, reason: 'not-available' });
  });
  it('an install that left the previous version running is reported as EM-8104; a finished one is not', async () => {
    const { parsePendingUpdate, pendingUpdateOutcome, nextUpdateState } = await import('../src/lib/updater-policy.js');
    const now = Date.now();
    const p = parsePendingUpdate({ fromVersion: '1.0.0', toVersion: '1.1.0', at: now - 60_000 });
    expect(pendingUpdateOutcome(p, '1.0.0', now)).toBe('interrupted');
    expect(pendingUpdateOutcome(p, '1.1.0', now)).toBe('applied');
    expect(pendingUpdateOutcome(null, '1.0.0', now)).toBe('none');
    expect(pendingUpdateOutcome(p, '1.0.0', now + 8 * 24 * 3600_000)).toBe('none');            // stale marker
    expect(parsePendingUpdate({ fromVersion: 1 })).toBeNull();
    expect(nextUpdateState({ status: 'idle' }, { type: 'interrupted', fromVersion: '1.0.0', toVersion: '1.1.0' })).toEqual({ status: 'error', version: '1.1.0', code: 'EM-8104' });
  });
});
