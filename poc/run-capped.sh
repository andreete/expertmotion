#!/usr/bin/env bash
# Run a command inside a systemd user scope with the shared-server memory cap (AGENTS.md §4).
# Usage: bash poc/run-capped.sh node poc/010/test.mjs
MAX="${EM_MEMORY_MAX:-1200M}"; HIGH="${EM_MEMORY_HIGH:-900M}"; SWAP="${EM_SWAP_MAX:-256M}"; HEAP="${EM_NODE_HEAP:-512}"
BASE_OPTS="$(printf '%s' "${NODE_OPTIONS:-}" | sed -E 's/--max-old-space-size=[0-9]+//g')"
export NODE_OPTIONS="$(printf '%s --max-old-space-size=%s' "${BASE_OPTS}" "${HEAP}" | sed -E 's/^ +//')"
if command -v systemd-run >/dev/null 2>&1 && systemctl --user is-system-running >/dev/null 2>&1; then
  exec systemd-run --user --scope --quiet -p MemoryMax="$MAX" -p MemoryHigh="$HIGH" -p MemorySwapMax="$SWAP" "$@"
else
  echo "warning: no systemd user scope; running uncapped" >&2; exec "$@"
fi
