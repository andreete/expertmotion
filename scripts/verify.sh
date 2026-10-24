#!/usr/bin/env bash
# CI-equivalent check: typecheck + tests + docs consistency. On the shared Linux server this runs inside the memory cap.
set -euo pipefail
cd "$(dirname "$0")/.."
run() { if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 4000000 ]; then bash scripts/run-capped.sh "$@"; else "$@"; fi; }
run npm run typecheck
run npx vitest run
bash tools/docs-check.sh
