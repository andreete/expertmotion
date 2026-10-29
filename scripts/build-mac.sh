#!/usr/bin/env bash
# Builds the macOS packages (dmg + zip per architecture, hardened runtime, signed, optionally notarised). RUN ON A MAC
# (DEPLOYMENT_AND_PACKAGING §17.4); it has never been run on the Linux build server.
#
# Needs: macOS 13+ with Xcode command-line tools, cmake and git (whisper.cpp has no official macOS CLI build and is compiled from
# the pinned tag, packages/models/engines.json), Node 22, `npm ci` on the Mac (installs @remotion/compositor-darwin-<arch> and the
# darwin prebuilds), and per architecture:
#   node_modules/.remotion/chrome-headless-shell/mac-<arch>/chrome-headless-shell-mac-<arch>/  (npx remotion browser ensure)
#   node_modules/@remotion/compositor-darwin-<arch>/  (the other architecture: `npm pack @remotion/compositor-darwin-<arch>@<pinned>`)
#   resources/bin-darwin-<arch>/ffmpeg, ffprobe        (an LGPL build for that architecture, ADR-019; the Operator supplies it)
#   EM_RELEASE_PRIVATE_KEY_PEM_FILE, EM_ENGINE_PUBLIC_KEY_B64   (integrity manifest, as on Windows/Linux)
# Signing (Apple Developer ID Application certificate in the login keychain, or CSC_LINK + CSC_KEY_PASSWORD for a .p12):
#   CSC_NAME="Developer ID Application: <Name> (<TEAMID>)"   optional; electron-builder finds the identity otherwise
#   EM_MAC_UNSIGNED=1                                         local test build: no signing, no notarisation (Gatekeeper will block it)
# Notarisation (off unless EM_MAC_NOTARIZE=1), one of:
#   APPLE_API_KEY (path to AuthKey_<id>.p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER   (recommended)
#   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
# Usage: bash scripts/build-mac.sh [arm64|x64 ...]   (default: arm64 x64; one architecture per electron-builder run)
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo "build-mac: run this on a Mac (codesign, notarytool, hdiutil and the whisper.cpp source build need macOS)" >&2; exit 1; }
: "${EM_RELEASE_PRIVATE_KEY_PEM_FILE:?set EM_RELEASE_PRIVATE_KEY_PEM_FILE}"
: "${EM_ENGINE_PUBLIC_KEY_B64:?set EM_ENGINE_PUBLIC_KEY_B64}"
export EM_ENGINE_PUBLIC_KEY_B64
export EM_RELEASE_PRIVATE_KEY_PEM="$(cat "$EM_RELEASE_PRIVATE_KEY_PEM_FILE")"
if [ $# -gt 0 ]; then ARCHES=("$@"); else ARCHES=(arm64 x64); fi
for A in "${ARCHES[@]}"; do case "$A" in arm64|x64) ;; *) echo "build-mac: unknown architecture $A (arm64 | x64)" >&2; exit 1;; esac; done
if [ "${EM_MAC_NOTARIZE:-}" = 1 ] && [ -z "${APPLE_API_KEY:-}${APPLE_ID:-}${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  echo "build-mac: EM_MAC_NOTARIZE=1 needs APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID" >&2; exit 1
fi
SIGN_ARGS=()
if [ "${EM_MAC_UNSIGNED:-}" = 1 ]; then export CSC_IDENTITY_AUTO_DISCOVERY=false; unset EM_MAC_NOTARIZE; SIGN_ARGS=(-c.mac.notarize=false); fi

# EM_RELEASE_CHECK_ARGS=--allow-placeholders for a test build (EM_PUBLISHER_NAME is the Windows certificate and is listed too).
node scripts/release-check.mjs ${EM_RELEASE_CHECK_ARGS:-}
npm run build -w @expertmotion/ui
npm run build:bundle -w @expertmotion/engine
npm run build:release -w @expertmotion/service
npm run build:main -w @expertmotion/desktop
for ARCH in "${ARCHES[@]}"; do
  node scripts/prepare-engines.mjs --platform=darwin --arch="$ARCH"      # → resources/engines-darwin-$ARCH (whisper-cli built from source)
  node scripts/stage-desktop.mjs --platform=darwin --arch="$ARCH" --check
  node scripts/stage-desktop.mjs --platform=darwin --arch="$ARCH"
  node apps/desktop/scripts/harden.mjs                                   # bytecode steps are skipped off Windows
  (cd apps/desktop && EM_MAC_ARCH="$ARCH" npx electron-builder --mac --"$ARCH" --config electron-builder.config.cjs --publish never ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"})   # bash 3.2 (macOS) safe with set -u
done
# Check on the Mac afterwards (DEPLOYMENT_AND_PACKAGING §17.4): codesign --verify --deep --strict, spctl -a -vv, xcrun stapler validate.
