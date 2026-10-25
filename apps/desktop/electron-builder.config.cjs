/**
 * electron-builder configuration (DEPLOYMENT_AND_PACKAGING.md §3). NSIS per-user x64, asar with
 * asarUnpack for native modules and Remotion binaries, extraResources for the Engine bundle,
 * Chrome Headless Shell, compositor and bin/. afterPack flips the Electron fuses (SEC-028).
 *
 * Zero-manual-install (coordinator item 1): the installer carries the Electron runtime, the Shell,
 * the Editor (dist/ui), the Local Service (dist/service), the Engine bundle, Chrome Headless Shell,
 * the compositor FFmpeg and resources/bin. Nothing is downloaded at first run except model weights
 * (ADR-008), which are never in the installer.
 *
 * Maximum compression (coordinator item 2): compression 'maximum' (7z LZMA level 9 for the app
 * package, NSIS solid install payload), asar enabled, no source maps, dev artefacts excluded.
 *
 * This is a .cjs config consumed by the electron-builder CLI on the Windows build machine. It is
 * not executed on the Linux dev server; its shape is unit-checked (test/electron-builder.test.ts).
 */

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.expertmotion.desktop',
  productName: 'Expertmotion',
  artifactName: 'Expertmotion-Setup-${version}-win-${arch}.${ext}',
  copyright: 'Copyright © Expertmotion',
  directories: { output: '../../release/${version}', buildResources: 'build' },

  // Maximum compression + protection (SEC-130, SEC-133).
  asar: true,
  compression: 'maximum',
  removePackageScripts: true,
  npmRebuild: true,
  asarUnpack: [
    '**/node_modules/better-sqlite3-multiple-ciphers/**',
    '**/node_modules/argon2/**',
    '**/node_modules/@remotion/renderer/**',
    '**/node_modules/@remotion/compositor-win32-x64-msvc/**',
  ],

  files: [
    'dist/**',
    'build/tray.png', // system tray icon (main.ts createTray)
    'package.json',
    '!**/*.map',
    '!**/*.ts',
    '!**/*.tsx',
    '!**/test/**',
    '!**/*.test.*',
    '!**/.env*',
    '!**/tsconfig*.json',
    '!native/**', // the optional C++ addon, built separately and unpacked if present
    '!**/node_modules/@remotion/compositor-{linux,darwin}-*/**', // other platforms' compositors (the Windows one ships in engine/compositor)
  ],

  // Everything the Creator needs ships here; nothing is fetched at first run except models (ADR-008).
  extraResources: [
    { from: 'resources/engine/bundle', to: 'engine/bundle' },
    { from: 'resources/engine/chrome', to: 'engine/chrome' },
    { from: 'resources/engine/compositor', to: 'engine/compositor' },
    { from: 'resources/bin', to: 'bin' },
    { from: 'resources/sample', to: 'sample' },                 // onboarding Sample Project (CC0, build-sample.mjs; API R-025)
    { from: 'resources/engine-manifest.json', to: 'engine-manifest.json' },
    { from: 'resources/integrity-manifest.json', to: 'integrity-manifest.json' },
    { from: 'resources/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
  ],

  afterPack: require('./build/afterPack.cjs'),

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    verifyUpdateCodeSignature: true,
    signtoolOptions: {
      publisherName: process.env.EM_PUBLISHER_NAME || '<exact certificate subject CN>',
      rfc3161TimeStampServer: process.env.EM_TIMESTAMP_URL || 'http://timestamp.digicert.com',
      signingHashAlgorithms: ['sha256'],
    },
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    differentialPackage: 'store-asar', // byte-stable asar member → small differential updates (SEC-093)
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    uninstallDisplayName: 'Expertmotion ${version}',
    // license, include (installer.nsh) and solid-compression tuning are added on the build machine.
  },

  publish: [{ provider: 'generic', url: process.env.EM_FEED_URL || 'https://updates.expertmotion.example/win' }],
};

module.exports = config;
