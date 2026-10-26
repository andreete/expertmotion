#!/usr/bin/env bash
# Builds the Linux packages (AppImage + deb, x64) on a Linux host: the Linux counterpart of scripts/cross-build-win.sh
# (DEPLOYMENT_AND_PACKAGING §17). Output: release/<version>/Expertmotion-<version>-linux-x86_64.AppImage and
# Expertmotion-<version>-linux-amd64.deb (electron-builder's arch names), plus release/<version>/linux-unpacked/.
#
# Inputs placed beforehand (outside git):
#   node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/   (npx remotion browser ensure on Linux)
#   node_modules/@remotion/compositor-linux-x64-gnu/                                       (installed by npm on Linux)
#   resources/bin-linux-x64/ffmpeg, ffprobe (+ FFMPEG_LICENSE.txt)                         (BtbN n8.1 linux64 LGPL, ADR-019)
#   EM_RELEASE_PRIVATE_KEY_PEM_FILE  path to the Ed25519 release key (PEM, never in the repo)
#   EM_ENGINE_PUBLIC_KEY_B64         matching public key (SPKI DER, base64)
# The Generator Engine Binaries are downloaded (pinned, sha256-verified) by prepare-engines into its cache ($EM_ENGINE_CACHE).
#
# On the shared 1.9 GB server run it inside the memory cap, one heavy job at a time:
#   EM_NODE_HEAP=1100 bash scripts/run-capped.sh bash scripts/build-linux.sh
# Electron cannot be launched on a server without a display: smoke-test the packages on an Ubuntu 24.04 desktop.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${EM_RELEASE_PRIVATE_KEY_PEM_FILE:?set EM_RELEASE_PRIVATE_KEY_PEM_FILE}"
: "${EM_ENGINE_PUBLIC_KEY_B64:?set EM_ENGINE_PUBLIC_KEY_B64}"
export EM_ENGINE_PUBLIC_KEY_B64
export EM_RELEASE_PRIVATE_KEY_PEM="$(cat "$EM_RELEASE_PRIVATE_KEY_PEM_FILE")"
[ "$(uname -s)" = Linux ] || { echo "build-linux: run this on Linux (AppImage/deb tooling and the Linux binaries are exercised here)" >&2; exit 1; }

# Test build: placeholders (licence/manifest keys, TO_PIN, publisher) are listed but allowed; never ship this output.
node scripts/release-check.mjs --allow-placeholders
if [ -z "${EM_SKIP_APP_BUILD:-}" ]; then                 # EM_SKIP_APP_BUILD=1 reuses apps/ui/dist, apps/service/dist and apps/desktop/dist/main.cjs
  npm run build -w @expertmotion/ui
  npm run build:release -w @expertmotion/service
  npm run build:main -w @expertmotion/desktop
fi
node scripts/prepare-engines.mjs --platform=linux --arch=x64          # → resources/engines-linux-x64 (pinned, cached, exec bits kept)
node scripts/stage-desktop.mjs --platform=linux --arch=x64 --check
node scripts/stage-desktop.mjs --platform=linux --arch=x64
# EM_OBFUSCATE_MAX_BYTES: under the real 1.2 GB cap the 2.4 MB Editor chunk does not fit javascript-obfuscator (it swap-thrashed for
# over an hour on 2026-10-26), so this TEST build leaves chunks above 2 MB unobfuscated; a release machine unsets it.
EM_OBFUSCATE_MAX_BYTES="${EM_OBFUSCATE_MAX_BYTES:-2000000}" node apps/desktop/scripts/harden.mjs   # bytecode steps are skipped off Windows
cd apps/desktop
# compression=normal: xz -9 for the deb needs ~700 MB on its own; the release machine may pass EM_COMPRESSION=maximum.
npx electron-builder --linux AppImage deb --x64 --config electron-builder.config.cjs --publish never \
  -c.npmRebuild=false -c.compression="${EM_COMPRESSION:-normal}"
