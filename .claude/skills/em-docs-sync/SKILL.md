---
name: em-docs-sync
description: Keep docs, INDEX matrices, process.md and memory.md consistent after a work unit or during a consistency pass.
---
# Steps
1. grep -ri remason . (must be empty); check header tables; ids unique.
2. Update docs/INDEX.md statuses and traceability matrices.
3. Append process.md entry; update memory.md if decisions changed.
# Checks before finishing
- matrices updated
- glossary untouched unless GLOSSARY_CHANGE=1 with ADR note
# Files you may modify
- docs/**, process.md, memory.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
