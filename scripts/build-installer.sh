#!/usr/bin/env bash
# Builds Expertmotion-Setup-<version>.exe from release/<version>/win-unpacked with makensis (Linux or Windows).
# makensis: $MAKENSIS, else electron-builder's cached NSIS bundle, else `makensis` on PATH.
# Usage: bash scripts/build-installer.sh   (after scripts/cross-build-win.sh or the electron-builder step of release:win)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
SRC="$ROOT/release/$VERSION/win-unpacked"
OUT="$ROOT/release/$VERSION/Expertmotion-Setup-$VERSION.exe"
[ -f "$SRC/Expertmotion.exe" ] || { echo "build-installer: $SRC/Expertmotion.exe missing (build the app first)" >&2; exit 1; }
if [ -z "${MAKENSIS:-}" ]; then
  NSIS_HOME="$(ls -d "$HOME"/.cache/electron-builder/nsis-3*/nsis-3* 2>/dev/null | head -1 || true)"
  if [ -n "$NSIS_HOME" ] && [ -x "$NSIS_HOME/linux/makensis" ]; then MAKENSIS="$NSIS_HOME/linux/makensis"; export NSISDIR="$NSIS_HOME";
  else MAKENSIS="$(command -v makensis)"; fi
fi
# makensis paths: Windows-style separators work on both hosts.
"$MAKENSIS" -V2 -INPUTCHARSET UTF8 \
  -DVERSION="$VERSION" -DSRC_DIR="$SRC" -DOUT_FILE="$OUT" -DICON="$ROOT/apps/desktop/build/icon.ico" \
  "$ROOT/apps/desktop/installer/expertmotion.nsi"
ls -la "$OUT"
