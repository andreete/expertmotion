---
name: em-service-route
description: Implement a Local Service route or SSE event from API_SPECIFICATION with auth, Zod DTOs, EM- errors and tests.
---
# Steps
1. Read the route in API_SPECIFICATION.md and related DATABASE_SCHEMA/AI_WORKFLOW schemas.
2. Implement handler behind the token + Host/Origin middleware; map errors to EM- codes.
3. Integration test with fake engine/provider.
4. Add VULNERABILITY_CHECKLIST items if the route touches files, egress or secrets. process.md entry.
# Checks before finishing
- integration test passes
- no new egress outside the single egress module
- route documented
# Files you may modify
- apps/service/**, docs/API_SPECIFICATION.md, docs/VULNERABILITY_CHECKLIST.md, process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
