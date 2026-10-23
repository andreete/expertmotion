---
name: em-security-review
description: Threat-model a change; add SEC- requirement, checklist item and test idea; honest language.
---
# Steps
1. Read THREAT_MODEL.md and SECURITY.md.
2. Identify new assets/boundaries; STRIDE the change.
3. Add/update SEC- rows and a VULNERABILITY_CHECKLIST item; propose tests.
# Checks before finishing
- no claims of impossibility
- every item verifiable
# Files you may modify
- docs/SECURITY.md, docs/THREAT_MODEL.md, docs/VULNERABILITY_CHECKLIST.md, process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
