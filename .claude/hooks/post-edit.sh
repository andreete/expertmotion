#!/usr/bin/env bash
source "$(dirname "$0")/_lib.sh"
[ -z "$FILE" ] && exit 0
case "$FILE" in
  */packages/composition-model/*|*/packages/agents/*)
    if [ -f package.json ] && grep -q '"typecheck"' package.json; then npm run -s typecheck >&2 || warn HG-008 "typecheck failed after editing $FILE"; fi;;
esac
case "$(basename "$FILE")" in
  DATABASE_SCHEMA.md|AI_WORKFLOW.md|DESIGN_CATALOGUE.md|ELEMENT_IDS.md|API_SPECIFICATION.md|ERROR_CATALOGUE.md|PERFORMANCE.md)
    refs=$(grep -rl "$(basename "$FILE")" docs *.md 2>/dev/null | grep -v "$(basename "$FILE")" | tr '\n' ' ')
    warn HG-009 "owner document changed; check referencing docs: $refs";;
esac
case "$FILE" in *.md) grep -n 'Remason' "$FILE" >/dev/null 2>&1 && warn HG-010 "'Remason' found in $FILE";; esac
exit 0
