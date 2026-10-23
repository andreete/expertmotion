#!/usr/bin/env bash
source "$(dirname "$0")/_lib.sh"
[ -z "$CMD" ] && exit 0
if is_shared_server && printf '%s' "$CMD" | grep -Eq 'npm run dev(\s|$)' && ! printf '%s' "$CMD" | grep -q 'dev:capped'; then block HG-001 "use 'npm run dev:capped' on the shared 1.9 GB server"; fi
if printf '%s' "$CMD" | grep -Eq '(:|PORT=|--port[ =])(3000|4000)\b'; then block HG-002 "ports 3000/4000 belong to another tenant; use 4100-4199"; fi
if printf '%s' "$CMD" | grep -Eq 'git push.*(--force|-f\b)|rm -rf +(/|~)(\s|$)'; then block HG-003 "destructive command"; fi
if printf '%s' "$CMD" | grep -q '/home/andre/experthinker-studio' && printf '%s' "$CMD" | grep -Eq '(>|sed -i|\brm\b|\bmv\b|npm (install|i|ci)\b|git (commit|checkout|reset))'; then block HG-004 "the predecessor repo is read-only reference material"; fi
exit 0
