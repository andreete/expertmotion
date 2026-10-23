#!/usr/bin/env bash
source "$(dirname "$0")/_lib.sh"
[ -z "$FILE" ] || [ ! -f "$FILE" ] && exit 0
if grep -Eq 'sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$FILE"; then
  git checkout -- "$FILE" 2>/dev/null || true
  block HG-011 "credential pattern detected in $FILE; write reverted"
fi
exit 0
