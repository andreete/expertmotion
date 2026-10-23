#!/usr/bin/env bash
# Documentation consistency checks for Expertmotion (greps only; no application code).
# Usage: bash tools/docs-check.sh   -> prints PASS/FAIL per rule and the traceability counts for docs/INDEX.md
cd "$(dirname "$0")/.."
fail=0; r() { if [ "$2" = "0" ]; then echo "PASS $1"; else echo "FAIL $1 ($2)"; fail=1; fi; }
# 1 product name: 'Remason' only where the rule is stated
bad=$(grep -rli --include="*.md" --include="*.json" --include="*.sh" "remason" docs *.md .claude 2>/dev/null | grep -vE "MASTER_PROJECT_PROMPT|ASSESSMENT|INDEX|README|AGENTS|GLOSSARY|ELEMENT_IDS|process.md|memory.md|CLAUDE.md|HOOKS_AND_GUARDRAILS|AGENT_SKILLS|UI_UX_SPECIFICATION|docs-maintainer|em-docs-sync|hooks/" | wc -l); r "remason-only-in-rules" "$bad"
# 2 header table in every doc
miss=0; for f in docs/*.md SYSTEM_PROMPT.md; do case "$f" in *MASTER_PROJECT_PROMPT*) continue;; esac; head -6 "$f" | grep -q "^| Status" || { echo "  no header: $f"; miss=$((miss+1)); }; done; r "header-tables" "$miss"
# 3 ids: distinct definitions per prefix (repeats in traceability tables are expected, so this is informational)
for pfx in PRD BRD FR NFR UX AI SEC QA ADR RISK POC EM GS TR LIC; do n=$(grep -rhoE "\b$pfx-[0-9]{2,4}\b" docs | sort -u | wc -l); printf "INFO distinct %s ids: %s\n" "$pfx" "$n"; done
# 4 every preset id in DESIGN_CATALOGUE appears in REMOTION_CAPABILITY_MAP
m=0; for id in $(grep -oE "preset:[a-z]+\.[a-z0-9-]+" docs/DESIGN_CATALOGUE.md | sort -u); do grep -q "$id" docs/REMOTION_CAPABILITY_MAP.md || { echo "  unmapped $id"; m=$((m+1)); }; done; r "preset-mapping" "$m"
# 5 every op in AI_WORKFLOW §5 appears in GOLDEN_SCENARIOS or FRD (coverage, informational)
m=0; for op in $(grep -oE "\`op:[a-z]+\.[a-zA-Z]+\`" docs/AI_WORKFLOW.md | tr -d '`' | sort -u); do grep -q "$op" docs/FRD.md docs/GOLDEN_SCENARIOS.md || { echo "  op not referenced: $op"; m=$((m+1)); }; done; echo "INFO ops-without-reference: $m"
# 6 element ids cited in FRD/UI spec exist in ELEMENT_IDS
m=0; for id in $(grep -ohE "\`(hdr|lib|stage|agent|scr|sys)\.[a-z0-9.]+\`" docs/FRD.md docs/UI_UX_SPECIFICATION.md docs/USER_FLOWS.md docs/EDITOR_INTERACTION_MODEL.md docs/ONBOARDING_TOUR.md | tr -d '`' | sed 's/\.$//' | sort -u); do
  base="$id"; found=0
  while [ -n "$base" ]; do grep -qF "$base" docs/ELEMENT_IDS.md && { found=1; break; }; [ "${base%.*}" = "$base" ] && break; base="${base%.*}"; done
  [ $found -eq 0 ] && { echo "  unknown element id: $id"; m=$((m+1)); }; done; r "element-ids-resolve" "$m"
# 7 EM codes cited anywhere exist in ERROR_CATALOGUE
m=0; for c in $(grep -rhoE "EM-[0-9]{4}" docs *.md | sort -u); do grep -q "$c" docs/ERROR_CATALOGUE.md || { echo "  undefined $c"; m=$((m+1)); }; done; r "em-codes-defined" "$m"
# 8 every ADR referenced somewhere
m=0; for a in $(grep -oE "^## ADR-[0-9]+" docs/DECISIONS.md | sed 's/## //'); do n=$(grep -rl "$a" docs *.md | grep -v DECISIONS.md | wc -l); [ "$n" -eq 0 ] && { echo "  unreferenced $a"; m=$((m+1)); }; done; r "adrs-referenced" "$m"
# counts for INDEX matrices
echo "COUNTS: FR=$(grep -cE "^\| FR-[0-9]+" docs/FRD.md) NFR=$(grep -cE "^\| NFR-[0-9]+" docs/SRS.md) UX=$(grep -cE "^\| \*{0,2}UX-[0-9]+" docs/UXRD.md) SEC=$(grep -cE "^\| SEC-[0-9]+" docs/SECURITY.md) QA=$(grep -cE "^\| QA-[0-9]+" docs/TEST_PLAN.md) EM=$(grep -cE "^\| EM-[0-9]{4}" docs/ERROR_CATALOGUE.md) RISK=$(grep -cE "^\| RISK-[0-9]+" docs/RISKS_AND_ASSUMPTIONS.md) POC=$(grep -cE "^\| POC-[0-9]+|^## POC-[0-9]+|^### POC-[0-9]+" docs/POC_PLAN.md) GS=$(grep -cE "^## GS-[0-9]+|^### GS-[0-9]+" docs/GOLDEN_SCENARIOS.md) presets=$(grep -oE "preset:[a-z]+\.[a-z0-9-]+" docs/DESIGN_CATALOGUE.md | sort -u | wc -l) ops=$(grep -oE "\`op:[a-z]+\.[a-zA-Z]+\`" docs/AI_WORKFLOW.md | sort -u | wc -l)"
exit $fail
