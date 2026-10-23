---
name: em-requirements
description: Turn a feature request into FR/NFR/UX requirement rows with acceptance criteria (use when a request has no requirement id yet).
---
# Steps
1. Read docs/PRD.md, docs/GLOSSARY.md and the existing FRD/SRS/UXRD rows for the area.
2. Draft rows (id, statement, trigger element id, inputs/outputs, agent involvement, validation, errors EM-, priority MoSCoW + P0/P1/P2, acceptance Given/When/Then, verification).
3. Append to docs/FRD.md / SRS.md / UXRD.md; update docs/INDEX.md matrices.
4. process.md entry.
# Checks before finishing
- ids unique: grep -c "FR-0xx" docs/FRD.md
- every row has acceptance + verification
- glossary terms only
# Files you may modify
- docs/FRD.md, docs/SRS.md, docs/UXRD.md (append), docs/INDEX.md, process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
