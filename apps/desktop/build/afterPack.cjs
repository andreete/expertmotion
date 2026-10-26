// electron-builder afterPack hook (DEPLOYMENT §2 B7, SEC-028): flips the Electron fuses on the
// packaged binary AFTER the bytecode step (the RunAsNode fuse must be off only once bytenode has
// finished compiling with ELECTRON_RUN_AS_NODE on the build machine — coordinator hardening note).
// Runs on every platform's build (Windows, the Linux build server, a Mac). The executable name comes from the packager: on Linux it
// is `executableName` (expertmotion), not the product name. On macOS the fuse flip invalidates the signature, so the ad-hoc
// signature is reset (arm64 refuses to start an unsigned binary); electron-builder's codesign pass then signs with the Developer ID.
/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const { FUSE_CONFIG, flipFuses, packagedExecutable } = require('./fuses.cjs');
  const { appOutDir, electronPlatformName, packager } = context;
  const name = electronPlatformName === 'linux' ? (packager.executableName ?? packager.appInfo.productFilename) : packager.appInfo.productFilename;
  const exe = packagedExecutable(appOutDir, electronPlatformName, name);
  await flipFuses(exe, { ...FUSE_CONFIG, resetAdHocDarwinSignature: electronPlatformName === 'darwin' });
  console.log(`afterPack: fuses flipped on ${exe}`);
};
