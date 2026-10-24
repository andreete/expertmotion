// electron-builder afterPack hook (DEPLOYMENT §2 B7, SEC-028): flips the Electron fuses on the
// packaged binary AFTER the bytecode step (the RunAsNode fuse must be off only once bytenode has
// finished compiling with ELECTRON_RUN_AS_NODE on the build machine — coordinator hardening note).
// Runs on the Windows build machine; never on the Linux dev server.
/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const { FUSE_CONFIG, flipFuses, packagedExecutable } = require('./fuses.cjs');
  const { appOutDir, electronPlatformName, packager } = context;
  const productName = packager.appInfo.productFilename;
  const exe = packagedExecutable(appOutDir, electronPlatformName, productName);
  await flipFuses(exe, FUSE_CONFIG);
  console.log(`afterPack: fuses flipped on ${exe}`);
};
