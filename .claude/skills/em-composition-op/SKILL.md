---
name: em-composition-op
description: Add or change an Operation of the Composition Model (schema, applyOps, validate, tests, AI_WORKFLOW row, ADR note).
---
# Steps
1. Confirm nobody else is editing docs/AI_WORKFLOW.md or docs/DATABASE_SCHEMA.md (process.md).
2. Add the op row to AI_WORKFLOW.md §5 and the ADR note in DECISIONS.md.
3. Implement Zod schema, applyOps case, validate rules in packages/composition-model; add tests.
4. Update GOLDEN_SCENARIOS fixtures if affected. process.md entry.
# Checks before finishing
- unit coverage ≥ 90 % lines in composition-model
- golden scenarios replay
- op name follows op:entity.verb
# Files you may modify
- packages/composition-model/**, docs/AI_WORKFLOW.md, docs/DECISIONS.md, test/**, process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
