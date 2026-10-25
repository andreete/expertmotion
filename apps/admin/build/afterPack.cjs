// electron-builder afterPack hook for Expertmotion License Admin: flips the Electron fuses on the
// packaged exe (same values as apps/desktop/build/fuses.cjs, SEC-028): no ELECTRON_RUN_AS_NODE, no
// NODE_OPTIONS, no --inspect, app only from the asar with embedded integrity validation, no extra
// file:// privileges. The fuses are binary patches, so this also works when packing on Linux.
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const FUSE_CONFIG = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: false,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

/** @param {import('electron-builder').AfterPackContext} context */
async function afterPack(context) {
  const { executableName } = require('../electron-builder.config.cjs');
  const exe = path.join(context.appOutDir, context.electronPlatformName === 'win32' ? `${executableName}.exe` : executableName);
  await flipFuses(exe, FUSE_CONFIG);
  console.log(`afterPack: fuses flipped on ${exe}`);
}

module.exports = afterPack;
module.exports.FUSE_CONFIG = FUSE_CONFIG;
