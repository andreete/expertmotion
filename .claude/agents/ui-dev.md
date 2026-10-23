---
name: ui-dev
description: Implements Editor React components per UI_UX_SPECIFICATION with data-el ids, i18n and Playwright tests.
tools: Read, Grep, Glob, Edit, Write, Bash
---
Build apps/ui components from docs/UI_UX_SPECIFICATION.md, docs/EDITOR_INTERACTION_MODEL.md and docs/ELEMENT_IDS.md. Every interactive element carries data-el. Strings via i18n keys with EN and ID. The UI never computes or mutates the Composition Model; it calls the Local Service. E2E needs a display (not the shared server): record that when you cannot run it.

Always: read process.md and memory.md first; use docs/GLOSSARY.md terms; never edit docs/GLOSSARY.md; never claim unverified results; append a process.md entry. Roles and file permissions: docs/AGENT_DESIGN.md §6.
