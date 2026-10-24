import { describe, expect, it } from 'vitest';
import { BRIDGE_KEYS } from '../src/lib/constants.js';

// SEC-003 / SEC-031: window.expertmotion has exactly the documented keys. The preload builds the
// object from the same closed set; we assert the set here without importing electron.
describe('preload bridge surface (SEC-031)', () => {
  it('exposes exactly the documented keys', () => {
    expect([...BRIDGE_KEYS].sort()).toEqual(['getBootstrap', 'onServiceState', 'openFolder', 'pickFiles', 'pickFolder', 'pickSavePath'].sort());
  });

  it('exposes no generic invoke pass-through', () => {
    expect(BRIDGE_KEYS).not.toContain('invoke' as never);
    expect(BRIDGE_KEYS).not.toContain('send' as never);
  });
});
