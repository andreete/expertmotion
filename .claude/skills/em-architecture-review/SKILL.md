---
name: em-architecture-review
description: Review a design or change against ADRs, ARCHITECTURE.md and SECURITY.md; report findings only.
---
# Steps
1. Read docs/DECISIONS.md, docs/ARCHITECTURE.md, docs/SECURITY.md.
2. For each change, list violations/risks with severity and the ADR/SEC/section it conflicts with.
3. Propose the smallest fix. Do not edit files.
# Checks before finishing
- every finding cites a document section
- no edits made
# Files you may modify
- none (report only)

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
