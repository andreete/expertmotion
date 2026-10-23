# Agent Skills (development-time)

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Engineering lead |
| Last updated | 2026-10-24 |
| Depends on | AGENTS.md, AGENT_DESIGN.md §6, DEFINITION_OF_DONE.md, DEVELOPMENT_WORKFLOW.md |
| Used by | .claude/skills/*, CLAUDE.md |

These are reusable workflows for coding agents building Expertmotion (brief §20). They are **not** runtime capabilities of the product (those are in AGENT_DESIGN.md §1 and SYSTEM_PROMPT.md). Each skill is implemented for Claude Code as `.claude/skills/<name>/SKILL.md`; other assistants can follow the same text. Conventions differ between tools (frontmatter, invocation, permissions), so each SKILL.md states only steps and checks, nothing tool-specific beyond the frontmatter Claude Code needs.

| Skill | Purpose | Activate when | Inputs | Outputs | Tools used | Constraints | Validation |
|---|---|---|---|---|---|---|---|
| `em-requirements` | Turn a feature request into requirement rows | a request has no FR/NFR/UX id yet | request text, PRD, glossary | new rows in FRD/SRS/UXRD with acceptance criteria; INDEX matrix update | Read, Edit | append-only ids; glossary terms; no code | ids unique (grep); each row has acceptance + verification |
| `em-architecture-review` | Review a design/PR against ADRs, architecture, security | before merging structural changes | diff or doc | findings list with ADR/SEC refs and severity | Read, Grep | report only; no edits | every finding cites a document section |
| `em-remotion-preset` | Add or change a Design Preset end to end | catalogue row planned or requested | catalogue row, mapping row | engine component, Compile entry, preview loop script entry, golden frames in 7 ratios, i18n labels, docs rows | Read, Edit, Write, Bash (tests) | one preset per run; pinned Remotion version; measure memory on the shared server | typecheck + golden-frame tests pass; DESIGN_CATALOGUE and REMOTION_CAPABILITY_MAP rows present |
| `em-composition-op` | Add or change an Operation | AI_WORKFLOW §5 needs a new op | op spec | Zod schema, `applyOps` case, `validate` rules, tests, AI_WORKFLOW row, ADR note | Read, Edit, Write, Bash | never edit AI_WORKFLOW concurrently with another agent | unit tests ≥ 90 % lines in composition-model; golden scenarios pass |
| `em-agent-prompt` | Change runtime prompts safely | SYSTEM_PROMPT.md change requested or GS failures | failing scenarios | new prompt version, changelog row, GS replay results | Read, Edit, Bash (replay) | bump version; keep ≤ 4k-token envelope rule | all GS fixtures replay; Locked Key tests pass |
| `em-ui-component` | Implement an Editor component | UI_UX_SPECIFICATION section assigned | spec section, element ids | React component with `data-el`, i18n keys, states, Playwright test | Read, Write, Edit, Bash | ids from ELEMENT_IDS only; EN/ID strings | e2e passes; a11y checks (focus, labels, contrast) |
| `em-service-route` | Implement a Local Service route or SSE event | API_SPECIFICATION route assigned | route spec | handler, Zod DTOs, error mapping to EM- codes, integration test | Read, Write, Edit, Bash | token + Host/Origin middleware mandatory; no new egress | integration test; security checklist items for the route |
| `em-security-review` | Threat-model a change and update checklist | any security-relevant change | diff | SEC- requirement/update, checklist item, test idea | Read, Edit | report + doc rows; honest language | referenced in VULNERABILITY_CHECKLIST |
| `em-test-from-plan` | Write and run tests from TEST_PLAN ids | QA- ids assigned | QA rows | tests, results pasted in process.md | Read, Write, Bash | run them; never claim without output | results recorded with actual output |
| `em-release` | Produce a release following the checklist | stage 7 / release train | version, changelog | signed artefacts (Windows), release notes, revocation list, process.md entry | Bash (Windows/CI) | cannot run on the shared Linux server | VULNERABILITY_CHECKLIST signed; clean-VM smoke recorded |
| `em-docs-sync` | Keep docs, INDEX matrices, process.md and memory.md consistent | end of any work unit; consistency pass | changed files | updated INDEX statuses/matrices, process.md entry, memory.md changes | Read, Edit, Grep | glossary frozen; never rename ids | `grep -ri remason` empty; matrices updated |

## Skill file format (Claude Code)

```
---
name: em-<skill>
description: <one line, when to use>
---
# Steps
1. …
# Checks before finishing
- …
# Files you may modify
- …
```

## Rules shared by all skills

1. Read `process.md` and the owning documents before editing.
2. Make the documentation change in the same commit as the code change.
3. Run the validation listed above and paste real output into `process.md`; if it cannot run in this environment, state that.
4. Stop at a safe checkpoint when context is low; write "how to continue".
