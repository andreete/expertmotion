---
name: em-ui-component
description: Implement an Editor component from UI_UX_SPECIFICATION with element ids, i18n and Playwright test.
---
# Steps
1. Read the spec section, ELEMENT_IDS.md and EDITOR_INTERACTION_MODEL.md rows.
2. Build the component with data-el ids, states, EN/ID keys in locale files.
3. Add Playwright e2e (needs a display; not on the shared server) and a11y checks.
4. process.md entry.
# Checks before finishing
- data-el ids exist in ELEMENT_IDS.md (add there first)
- e2e + a11y pass or recorded as "needs Windows"
# Files you may modify
- apps/ui/**, locales, docs/ELEMENT_IDS.md (append), process.md

Shared rules: read process.md and the owning documents first; docs change in the same commit; run the validation and paste real output into process.md; stop at a safe checkpoint when context is low. See docs/AGENT_SKILLS.md.
