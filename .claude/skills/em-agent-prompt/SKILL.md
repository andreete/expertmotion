---
name: em-agent-prompt
description: Change runtime prompts in SYSTEM_PROMPT.md safely: bump version, replay golden scenarios.
---
# Steps
1. Reproduce the failing scenario with the fake provider.
2. Edit SYSTEM_PROMPT.md; bump version (SemVer) and changelog.
3. Replay all GS fixtures; fix regressions.
4. process.md entry with replay output.
# Checks before finishing
- version bumped
- all GS fixtures pass; Locked Key tests pass
- envelope stays ≤ 4k tokens
# Files you may modify
- SYSTEM_PROMPT.md, packages/agents/src/prompts/**, test/fixtures/plans/**, process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
