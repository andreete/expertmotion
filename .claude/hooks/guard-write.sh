#!/usr/bin/env bash
source "$(dirname "$0")/_lib.sh"
[ -z "$FILE" ] && exit 0
case "$FILE" in
  */docs/GLOSSARY.md) [ "${GLOSSARY_CHANGE:-0}" = "1" ] || block HG-005 "docs/GLOSSARY.md is frozen; set GLOSSARY_CHANGE=1 and add an ADR note";;
  *.env|*.pem|*.key|*license-private*) block HG-007 "secrets and private keys are never written into the repo";;
esac
if printf '%s' "$NEW" | grep -qi 'remason'; then warn HG-006 "content mentions 'Remason'; the product name is Expertmotion"; fi
exit 0
