---
name: em-release
description: Produce a release per STAGE_MANAGEMENT checklist (Windows machine or CI only).
---
# Steps
1. Confirm stage exit criteria and VULNERABILITY_CHECKLIST sign-off.
2. Build per DEPLOYMENT_AND_PACKAGING.md; sign; smoke on a clean VM.
3. Publish update feed + revocation list; write release notes.
4. process.md entry with artefact hashes.
# Checks before finishing
- cannot run on the shared Linux server
- checklist signed; smoke recorded
# Files you may modify
- release scripts, CHANGELOG.md, process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
