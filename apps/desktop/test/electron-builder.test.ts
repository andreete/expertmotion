import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The config is a .cjs file consumed by the electron-builder CLI on Windows. We assert its shape
// here (it never runs on the Linux dev server) so DEPLOYMENT §3 and the Operator's zero-install /
// maximum-compression / protection requirements stay enforced.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../electron-builder.config.cjs') as Record<string, any>;
const mod = require('../build/fuses.cjs') as { FUSE_CONFIG: Record<string, unknown>; packagedExecutable: (dir: string, platform: string, name: string) => string };

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
    for (const needed of ['engine/bundle', 'engine/chrome', 'engine/compositor', 'bin', 'sample']) {
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

  it('Linux: AppImage + deb x64, icon set, desktop entry, deb dependencies incl. libgomp1 and libsecret (DEPLOYMENT §17)', () => {
    expect(config.linux.target).toEqual([{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }]);
    expect(config.linux.executableName).toBe('expertmotion');
    expect(config.linux.category).toBe('AudioVideo');
    expect(config.linux.desktop.entry.Categories).toContain('AudioVideo');
    for (const n of [16, 32, 48, 64, 128, 256, 512]) expect(existsSync(join(__dirname, '..', config.linux.icon, `${n}x${n}.png`)), `${n}`).toBe(true);
    expect(config.deb.depends).toEqual(expect.arrayContaining(['libgomp1', 'libsecret-1-0', 'libnss3']));
    expect(config.linux.artifactName).toContain('linux');
  });

  it('keeps other platforms\' native modules and compositors out of each package (no wrong-platform binaries)', () => {
    const lin = config.linux.files.join(' '), win = config.win.files.join(' '), mac = config.mac.files.join(' ');
    expect(lin).toContain('compositor-win32-x64-msvc'); expect(lin).toContain('prebuilds/win32-x64.node'); expect(lin).toContain('compositor-darwin-arm64');
    expect(lin).not.toContain('compositor-linux-x64-gnu/'); expect(lin).not.toContain('prebuilds/linux-x64.node');
    expect(win).toContain('compositor-{linux,darwin}-*'); expect(win).toContain('prebuilds/linux-x64.node'); expect(win).not.toContain('prebuilds/win32-x64.node');
    expect(mac).toContain('compositor-linux-x64-gnu'); expect(mac).toContain('prebuilds/win32-x64.node'); expect(mac).not.toContain('prebuilds/darwin-arm64.node');
    // the same extraResources on every platform: stage-desktop stages exactly one platform into apps/desktop/resources
    expect(config.extraResources.find((r: { to: string }) => r.to === 'engines').from).toBe('resources/engines');
    // a platform list must never be exclusion-only (electron-builder would then pack everything, resources/ included, into the asar)
    for (const p of ['win', 'linux', 'mac']) { expect(config[p].files.slice(0, config.files.length), p).toEqual(config.files); expect(config[p].files).toContain('dist/**'); }
  });

  it('macOS preparation: dmg + zip, hardened runtime, entitlements present, notarisation off unless EM_MAC_NOTARIZE=1', () => {
    expect(config.mac.target.map((t: { target: string }) => t.target)).toEqual(['dmg', 'zip']);
    expect(config.mac.target[0].arch).toEqual(['arm64', 'x64']);
    expect(config.mac.hardenedRuntime).toBe(true);
    expect(config.mac.notarize).toBe(false);
    for (const f of [config.mac.entitlements, config.mac.entitlementsInherit, config.mac.icon]) expect(existsSync(join(__dirname, '..', f)), f).toBe(true);
    const ent = readFileSync(join(__dirname, '..', config.mac.entitlementsInherit), 'utf8');
    for (const k of ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation']) expect(ent).toContain(`com.apple.security.cs.${k}`);
  });

  it('afterPack finds the packaged executable per platform (Linux uses executableName)', () => {
    expect(mod.packagedExecutable('/o', 'linux', 'expertmotion')).toBe(join('/o', 'expertmotion'));
    expect(mod.packagedExecutable('/o', 'win32', 'Expertmotion')).toBe(join('/o', 'Expertmotion.exe'));
    expect(mod.packagedExecutable('/o', 'darwin', 'Expertmotion')).toBe(join('/o', 'Expertmotion.app', 'Contents', 'MacOS', 'Expertmotion'));
    expect(readFileSync(join(__dirname, '../build/afterPack.cjs'), 'utf8')).toContain('packager.executableName');
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
