---
name: em-test-from-plan
description: Write and run tests for assigned QA- ids from TEST_PLAN.md; record real results.
---
# Steps
1. Read the QA rows and their FR/NFR references.
2. Write tests (Vitest/Playwright) under test/** or package tests.
3. Run them; if the environment cannot run them, say so.
4. Paste output into process.md.
# Checks before finishing
- results recorded with actual output
- QA ids referenced in test names
# Files you may modify
- **/test/**, docs/TEST_PLAN.md (status column), process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
