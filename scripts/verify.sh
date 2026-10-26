#!/usr/bin/env bash
# CI-equivalent check: typecheck + tests + docs consistency. On the shared Linux server this runs inside the memory cap.
set -euo pipefail
cd "$(dirname "$0")/.."
run() { if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 4000000 ]; then bash scripts/run-capped.sh "$@"; else "$@"; fi; }
run npm run typecheck
# Two Vitest runs: one single-fork process for every suite no longer fits the 512 MB Node heap on the shared
# 1.9 GB server (2026-10-26); the jsdom UI suites get a fresh process per file. The 512 MB cap stays.
run npx vitest run packages apps/service apps/desktop apps/admin tools
run npx vitest run apps/ui --poolOptions.forks.singleFork=false --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1   # a fresh process per file, one at a time
bash tools/docs-check.sh
