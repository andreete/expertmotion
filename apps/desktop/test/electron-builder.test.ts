import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// The config is a .cjs file consumed by the electron-builder CLI on Windows. We assert its shape
// here (it never runs on the Linux dev server) so DEPLOYMENT §3 and the Operator's zero-install /
// maximum-compression / protection requirements stay enforced.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../electron-builder.config.cjs') as {
  default: Record<string, any>;
  FUSE_CONFIG: Record<string, unknown>;
};
const config = mod.default;

describe('electron-builder config (DEPLOYMENT §3)', () => {
  it('is NSIS per-user x64 with no elevation', () => {
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(config.nsis.perMachine).toBe(false);
    expect(config.nsis.allowElevation).toBe(false);
    expect(config.nsis.oneClick).toBe(false);
  });

  it('maximum compression + asar + no dev artefacts (coordinator item 2, SEC-130)', () => {
    expect(config.asar).toBe(true);
    expect(config.compression).toBe('maximum');
    expect(config.files).toContain('!**/*.map');
    expect(config.files).toContain('!**/*.ts');
    expect(config.files).toContain('!**/test/**');
  });

  it('carries everything for zero-manual-install (coordinator item 1)', () => {
    const dests = config.extraResources.map((r: { to: string }) => r.to);
    for (const needed of ['engine/bundle', 'engine/chrome', 'engine/compositor', 'bin']) {
      expect(dests).toContain(needed);
    }
  });

  it('unpacks native modules and Remotion binaries from the asar (SEC-033)', () => {
    expect(config.asarUnpack.some((g: string) => g.includes('better-sqlite3-multiple-ciphers'))).toBe(true);
    expect(config.asarUnpack.some((g: string) => g.includes('@remotion/renderer'))).toBe(true);
    expect(config.asarUnpack.some((g: string) => g.includes('compositor-win32-x64-msvc'))).toBe(true);
  });

  it('verifies update code signature and ships a signed feed (SEC-091)', () => {
    expect(config.win.verifyUpdateCodeSignature).toBe(true);
    expect(config.publish[0].provider).toBe('generic');
  });

  it('flips the fuses per SEC-028', () => {
    // @electron/fuses enum: RunAsNode=0, EnableCookieEncryption=1, NodeOptions=2, NodeCliInspect=3,
    // EmbeddedAsarIntegrityValidation=4, OnlyLoadAppFromAsar=5, GrantFileProtocolExtraPrivileges=7.
    const f = mod.FUSE_CONFIG;
    expect(f[0]).toBe(false); // RunAsNode off
    expect(f[1]).toBe(true);  // cookie encryption on
    expect(f[2]).toBe(false); // NodeOptions off
    expect(f[3]).toBe(false); // NodeCliInspect off
    expect(f[4]).toBe(true);  // embedded asar integrity on
    expect(f[5]).toBe(true);  // only load app from asar
    expect(f[7]).toBe(false); // grant file protocol extra privileges off
  });
});
