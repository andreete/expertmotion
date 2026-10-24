// Electron fuse values and helpers (SEC-028), shared by afterPack.cjs and the unit test. Kept out of
// electron-builder.config.cjs because electron-builder rejects unknown top-level config keys.
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('node:path');

/** Fuse values (SEC-028). Exported so afterPack.cjs and the unit test share one source. */
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

/** Executable name per platform, used by afterPack to locate the binary to flip. */
function packagedExecutable(appOutDir, electronPlatformName, productName) {
  if (electronPlatformName === 'win32') return path.join(appOutDir, `${productName}.exe`);
  if (electronPlatformName === 'darwin') return path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
  return path.join(appOutDir, productName);
}

module.exports = { FUSE_CONFIG, flipFuses, packagedExecutable };
