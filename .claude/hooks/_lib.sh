#!/usr/bin/env bash
# Shared helpers for Expertmotion hooks. Input: tool call JSON on stdin (Claude Code convention).
INPUT="$(cat)"
field() { # field <jq-path> ; falls back to grep when jq is missing
  if command -v jq >/dev/null 2>&1; then printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null; else printf '%s' "$INPUT" | grep -o "\"${1##*.}\":\"[^\"]*\"" | head -1 | sed -E 's/^"[^"]*":"//; s/"$//'; fi
}
CMD="$(field '.tool_input.command')"
FILE="$(field '.tool_input.file_path')"
NEW="$(field '.tool_input.content')"; [ -z "$NEW" ] && NEW="$(field '.tool_input.new_string')"
block() { printf 'BLOCKED by Expertmotion hook %s: %s\n' "$1" "$2" >&2; exit 2; }
warn()  { printf 'WARNING (Expertmotion hook %s): %s\n' "$1" "$2" >&2; }
is_shared_server() { # 1.9 GB box: total memory below 4 GB
  local kb; kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 99999999); [ "${kb:-99999999}" -lt 4000000 ]
}
