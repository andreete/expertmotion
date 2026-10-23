#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
changed=$(git status --porcelain 2>/dev/null | wc -l)
if [ "$changed" -gt 0 ] && ! git status --porcelain 2>/dev/null | grep -q 'process.md'; then
  echo "Reminder (HG-012): files changed but process.md has no new entry. Append one before finishing (template: docs/STAGE_MANAGEMENT.md)." >&2
fi
exit 0
