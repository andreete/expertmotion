#!/usr/bin/env bash
# Builds the Windows installer on a Linux host (no Windows machine needed for a test build).
# The real release path stays `npm run release:win` on Windows (DEPLOYMENT_AND_PACKAGING.md): only
# there can bytenode compile V8 bytecode and signtool sign the installer.
#
# Inputs placed beforehand (outside git, see poc/WINDOWS_RUNBOOK.md §7):
#   node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/  (Chrome for Testing)
#   node_modules/@remotion/compositor-win32-x64-msvc/                                (npm pack of the pinned version)
#   resources/bin-win32-x64/ (or resources/bin/) ffmpeg.exe, ffprobe.exe (+ DLLs)    (LGPL build, ADR-019)
#   EM_RELEASE_PRIVATE_KEY_PEM_FILE  path to the Ed25519 release key (PEM, never in the repo)
#   EM_ENGINE_PUBLIC_KEY_B64         matching public key (SPKI DER, base64)
# Usage: EM_RELEASE_PRIVATE_KEY_PEM_FILE=... EM_ENGINE_PUBLIC_KEY_B64=... bash scripts/cross-build-win.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${EM_RELEASE_PRIVATE_KEY_PEM_FILE:?set EM_RELEASE_PRIVATE_KEY_PEM_FILE}"
: "${EM_ENGINE_PUBLIC_KEY_B64:?set EM_ENGINE_PUBLIC_KEY_B64}"
export EM_ENGINE_PUBLIC_KEY_B64
export EM_RELEASE_PRIVATE_KEY_PEM="$(cat "$EM_RELEASE_PRIVATE_KEY_PEM_FILE")"

# Test build: placeholders (licence/manifest keys, TO_PIN, publisher) are listed but allowed; never ship this output.
node scripts/release-check.mjs --allow-placeholders
npm run build -w @expertmotion/ui                       # Editor (dist/ui is staged as-is)
npm run build:bundle -w @expertmotion/engine            # Engine bundle from the current source, so Export matches the preview
npm run build:release -w @expertmotion/service         # prompts → dist/assets.enc (half A in service, half B for main)
npm run build:main -w @expertmotion/desktop             # embeds the integrity public key and prompt key half B
node scripts/prepare-engines.mjs --platform=win32 --arch=x64   # → resources/engines-win32-x64 (whisper.cpp, sherpa-onnx, sd.cpp; pinned, cached)
node scripts/stage-desktop.mjs --platform=win32 --arch=x64 --check
node scripts/stage-desktop.mjs --platform=win32 --arch=x64
EM_OBFUSCATE_MAX_BYTES="${EM_OBFUSCATE_MAX_BYTES:-2500000}" node apps/desktop/scripts/harden.mjs   # bytecode steps are skipped off Windows
cd apps/desktop
# Portable ZIP: the NSIS target needs wine on Linux (uninstaller generation), so the installer is built on Windows.
npx electron-builder --win zip --x64 --config electron-builder.config.cjs --publish never \
  -c.npmRebuild=false -c.win.signExecutable=false -c.compression=normal \
  '-c.artifactName=Expertmotion-${version}-win-${arch}-portable.${ext}'
# Packaging guard: every module main/preload require must be in app.asar (a missing one = "Cannot find module" on launch).
VERSION="$(node -p "require('./package.json').version")"
node ../../scripts/check-asar-deps.mjs "../../release/$VERSION/win-unpacked/resources/app.asar"
