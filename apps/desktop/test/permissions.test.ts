import { describe, expect, it } from 'vitest';
import { allowPermission, originOf } from '../src/lib/permissions.js';

describe('renderer permissions (SEC-029)', () => {
  it('grants Local Network Access only to the packaged Editor origin', () => {
    for (const p of ['local-network-access', 'local-network', 'loopback-network']) {
      expect(allowPermission(p, 'app://expertmotion/index.html')).toBe(true);
      expect(allowPermission(p, 'app://expertmotion')).toBe(true);
      expect(allowPermission(p, 'https://evil.example/')).toBe(false);
      expect(allowPermission(p, 'app://other/index.html')).toBe(false);
      expect(allowPermission(p, undefined)).toBe(false);
    }
  });
  it('allows the dev UI origin only when it is listed (development)', () => {
    expect(allowPermission('loopback-network', 'http://127.0.0.1:4120/', { devOrigins: ['http://127.0.0.1:4120'] })).toBe(true);
    expect(allowPermission('loopback-network', 'http://127.0.0.1:4120/')).toBe(false);
  });
  it('still denies every other permission, even for the Editor', () => {
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'hid', 'usb', 'display-capture', 'unknown']) {
      expect(allowPermission(p, 'app://expertmotion/index.html')).toBe(false);
    }
  });
  it('normalises origins', () => {
    expect(originOf('app://expertmotion/a/b.html?x=1')).toBe('app://expertmotion');
    expect(originOf('http://127.0.0.1:4120/x')).toBe('http://127.0.0.1:4120');
    expect(originOf('not a url')).toBeNull();
  });
});
