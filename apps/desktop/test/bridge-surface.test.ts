import { describe, expect, it } from 'vitest';
import { BRIDGE_KEYS, isAllowedExternal } from '../src/lib/constants.js';

// SEC-003 / SEC-031: window.expertmotion has exactly the documented keys. The preload builds the
// object from the same closed set; we assert the set here without importing electron.
describe('preload bridge surface (SEC-031)', () => {
  it('exposes exactly the documented keys', () => {
    expect([...BRIDGE_KEYS].sort()).toEqual(['getBootstrap', 'getPathsForFiles', 'onServiceState', 'openExternal', 'openFolder', 'pickFiles', 'pickFolder', 'pickSavePath'].sort());
  });

  it('exposes no generic invoke pass-through', () => {
    expect(BRIDGE_KEYS).not.toContain('invoke' as never);
    expect(BRIDGE_KEYS).not.toContain('send' as never);
  });

  it('openExternal accepts only HTTPS links to the storefront host', () => {
    expect(isAllowedExternal('https://expertmotion.app/buy')).toBe(true);
    expect(isAllowedExternal('https://shop.expertmotion.app/x')).toBe(true);
    for (const u of ['http://expertmotion.app/buy', 'https://expertmotion.app.evil.com/', 'file:///C:/Windows/system32/calc.exe', 'https://user:pw@expertmotion.app/', 'javascript:alert(1)', 'ms-settings:']) expect(isAllowedExternal(u)).toBe(false);
  });
});
