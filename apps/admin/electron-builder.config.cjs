/**
 * electron-builder configuration for Expertmotion License Admin (Operator only, never shipped to
 * Creators). Windows portable ZIP only, no installer: unzip on the signing PC and run the .exe.
 * Output: release/admin/<version>/Expertmotion-License-Admin-<version>-win-x64.zip
 * Everything the app needs is bundled into dist/ by scripts/build.mjs, so no node_modules are packed.
 */

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.expertmotion.license-admin',
  productName: 'Expertmotion License Admin',
  executableName: 'Expertmotion-License-Admin',
  artifactName: 'Expertmotion-License-Admin-${version}-win-${arch}.${ext}',
  copyright: 'Copyright © Expertmotion',
  electronVersion: '45.0.0',
  directories: { output: '../../release/admin/${version}' },
  asar: true,
  compression: 'normal',
  npmRebuild: false,
  nodeGypRebuild: false,
  removePackageScripts: true,
  afterPack: (ctx) => require('./build/afterPack.cjs')(ctx),
  files: ['dist/**', 'package.json', '!**/*.map', '!**/*.ts', '!**/test/**', '!node_modules/**'],
  win: {
    target: [{ target: 'zip', arch: ['x64'] }],
    signAndEditExecutable: false,
  },
  publish: null,
};

module.exports = config;
