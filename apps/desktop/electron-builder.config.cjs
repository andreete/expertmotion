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
 * Platforms (DEPLOYMENT_AND_PACKAGING §17): Windows (NSIS, the release path), Linux (AppImage + deb, x64; scripts/build-linux.sh)
 * and macOS (dmg + zip, arm64 and x64, hardened runtime; scripts/build-mac.sh on a Mac). extraResources are the same paths on every
 * platform because scripts/stage-desktop.mjs --platform=<p> stages exactly one platform's binaries into apps/desktop/resources (and
 * refuses another platform's files); the per-platform `files` lists keep other platforms' native modules and compositors out of
 * the asar.
 *
 * Its shape is unit-checked (test/electron-builder.test.ts).
 */

/**
 * Files of the asar. Every platform section repeats this list before its own exclusions: electron-builder 26 lets a platform's
 * `files` replace the root list, and an exclusion-only list then means "everything" (found 2026-10-26: the first Linux build
 * packed resources/engine, bin and engines into a 699 MB app.asar).
 */
const commonFiles = [
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
];
/** Native modules and compositors of the OTHER platforms, excluded from each platform's asar. */
const sqlitePrebuilds = (keep) => ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'linuxmusl-x64', 'linuxmusl-arm64', 'darwin-x64', 'darwin-arm64']
  .filter((p) => !keep.includes(p)).map((p) => `!**/node_modules/better-sqlite3-multiple-ciphers/prebuilds/${p}.node`);
const compositors = (keep) => ['win32-x64-msvc', 'linux-x64-gnu', 'linux-x64-musl', 'linux-arm64-gnu', 'linux-arm64-musl', 'darwin-x64', 'darwin-arm64']
  .filter((p) => !keep.includes(p)).map((p) => `!**/node_modules/@remotion/compositor-${p}/**`);
const macArches = process.env.EM_MAC_ARCH ? [process.env.EM_MAC_ARCH] : ['arm64', 'x64'];
/** Update feed per platform: Linux and macOS publish only when the Operator sets their feed (a test build has none). */
const feed = (envName, fallback) => (process.env[envName] ? [{ provider: 'generic', url: process.env[envName] }] : fallback);

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
    '**/node_modules/@remotion/compositor-linux-x64-gnu/**',
    '**/node_modules/@remotion/compositor-darwin-arm64/**',
    '**/node_modules/@remotion/compositor-darwin-x64/**',
  ],

  files: commonFiles,

  // Everything the Creator needs ships here; nothing is fetched at first run except models (ADR-008).
  extraResources: [
    { from: 'resources/engine/bundle', to: 'engine/bundle' },
    { from: 'resources/engine/chrome', to: 'engine/chrome' },
    { from: 'resources/engine/compositor', to: 'engine/compositor' },
    { from: 'resources/bin', to: 'bin' },
    { from: 'resources/engines', to: 'engines' },              // whisper.cpp, sherpa-onnx, stable-diffusion.cpp (scripts/prepare-engines.mjs)
    { from: 'resources/sample', to: 'sample' },                 // onboarding Sample Project (CC0, build-sample.mjs; API R-025)
    { from: 'resources/engine-manifest.json', to: 'engine-manifest.json' },
    { from: 'resources/integrity-manifest.json', to: 'integrity-manifest.json' },
    { from: 'resources/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
  ],

  afterPack: require('./build/afterPack.cjs'),

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    // other platforms' compositors (the Windows one also ships in engine/compositor) and native prebuilds
    files: [...commonFiles, '!**/node_modules/@remotion/compositor-{linux,darwin}-*/**', ...sqlitePrebuilds(['win32-x64'])],
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

  // Linux (Operator 2026-10-26): AppImage (self-updating, runs from any folder) + deb (installs to /opt/Expertmotion, AppArmor profile
  // for Ubuntu 24.04's user-namespace restriction, chrome-sandbox handling by electron-builder's after-install script). x64 only.
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    artifactName: 'Expertmotion-${version}-linux-${arch}.${ext}',
    executableName: 'expertmotion',
    icon: 'build/icons',
    category: 'AudioVideo',
    synopsis: 'AI-assisted motion video editor',
    description: 'Expertmotion: a local-first, AI-assisted motion video editor for creators. Projects, media and AI models stay on this computer.',
    maintainer: process.env.EM_LINUX_MAINTAINER || 'Expertmotion <support@expertmotion.app>',
    vendor: 'Expertmotion',
    desktop: { entry: { Name: 'Expertmotion', Comment: 'AI-assisted motion video editor', Categories: 'AudioVideo;Video;AudioVideoEditing;', StartupWMClass: 'Expertmotion', Keywords: 'video;editor;motion;caption;' } },
    files: [...commonFiles, ...compositors(['linux-x64-gnu']), ...sqlitePrebuilds(['linux-x64'])],
    publish: feed('EM_FEED_URL_LINUX', null),
  },
  deb: {
    // electron-builder's defaults plus libgomp1 (OpenMP runtime of whisper.cpp / stable-diffusion.cpp) and libsecret (keyring, SEC-040).
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libgomp1'],
    recommends: ['gnome-keyring'],
    priority: 'optional',
  },
  appImage: { artifactName: 'Expertmotion-${version}-linux-${arch}.AppImage' },

  // macOS preparation (built and signed on a Mac: scripts/build-mac.sh). Hardened runtime + entitlements for Chrome Headless Shell,
  // the compositor and the Engine Binaries (all signed by electron-builder's codesign pass); notarisation runs only when
  // EM_MAC_NOTARIZE=1 and the Apple credentials are in the environment (DEPLOYMENT_AND_PACKAGING §17.4).
  mac: {
    target: [{ target: 'dmg', arch: macArches }, { target: 'zip', arch: macArches }],
    artifactName: 'Expertmotion-${version}-mac-${arch}.${ext}',
    icon: 'build/icon.png',
    category: 'public.app-category.video',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    notarize: process.env.EM_MAC_NOTARIZE === '1',
    minimumSystemVersion: '12.0',
    // scripts/build-mac.sh packs one architecture per run (EM_MAC_ARCH) because it stages that architecture's binaries.
    files: [...commonFiles, ...compositors(macArches.map((a) => `darwin-${a}`)), ...sqlitePrebuilds(macArches.map((a) => `darwin-${a}`))],
    publish: feed('EM_FEED_URL_MAC', null),
  },
  dmg: { sign: false },

  publish: [{ provider: 'generic', url: process.env.EM_FEED_URL || 'https://updates.expertmotion.example/win' }],
};

module.exports = config;
