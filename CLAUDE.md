# CLAUDE.md — Claude Code specifics for Expertmotion

Canonical rules live in `AGENTS.md`; read it first. This file adds only Claude Code mechanics.

## Session start
1. `process.md` → `memory.md` → `docs/INDEX.md`. Glossary is frozen (`docs/GLOSSARY.md`).
2. Product name: **Expertmotion**. Never "Remason".

## Commands (planned; they exist once Stage 3 creates the code)
```
npm run dev            # service + UI in a browser (Windows/Linux dev)
npm run dev:capped     # same inside the cgroup memory cap — REQUIRED on the shared Linux server
npm run typecheck      # all workspaces
npm test               # unit + integration (Vitest)
npm run test:e2e       # Playwright (needs a display; not on the shared server)
npm run build:engine   # Remotion bundle + catalogue preview loops
npm run build:desktop  # Electron installer (Windows machine or CI only)
```
During the documentation phase there is nothing to run.

## Hard environment rules on the shared Linux server
- 1.9 GB RAM total, shared. Keep this repo's processes ≤ 900 MB (soft) / 1.2 GB (hard) via the cgroup script; render concurrency 1; one Chrome at a time; never parallel renders.
- Never bind ports 3000 or 4000; use 4100–4199.
- No Electron, no Playwright, no GPU tests here. Say so in `process.md` when a task needs Windows.
- Do not touch `/home/andre/experthinker-studio` except to read it for the port list.

## Hooks (see `docs/HOOKS_AND_GUARDRAILS.md`; wired in `.claude/settings.json`)
- PreToolUse(Bash): blocks `npm run dev` without cap on the shared server, blocks binding 3000/4000, blocks `git push --force`, blocks writing to `docs/GLOSSARY.md` without the `GLOSSARY-CHANGE` marker.
- PostToolUse(Edit/Write): typecheck when files under `packages/composition-model` or `packages/agents` change (once code exists); doc-sync reminder when a `docs/*.md` owner file changes.
- Stop: reminds to append `process.md` if files changed and no entry was added.
- SessionStart: prints the "Current state" block of `process.md`.

## Skills (`.claude/skills/`)
`em-requirements`, `em-architecture-review`, `em-remotion-preset`, `em-composition-op`, `em-agent-prompt`, `em-ui-component`, `em-service-route`, `em-security-review`, `em-test-from-plan`, `em-release`, `em-docs-sync`. Purpose, inputs, outputs and validation in `docs/AGENT_SKILLS.md`.

## Subagents (`.claude/agents/`)
Roles and the files each may modify: `docs/AGENT_DESIGN.md` §6. The frozen glossary and the schema owners (`DATABASE_SCHEMA.md`, `AI_WORKFLOW.md`) are edited by one agent at a time.

## Writing rules
- Documents start with the header table (Status, Owner, Last updated, Depends on, Used by, ID range).
- Requirement ids: `PRD- BRD- FR- NFR- UX- AI- SEC- QA- ADR- RISK- POC- EM-`; presets `preset:cat.name`; ops `op:entity.verb`; elements `el:region.group.element`.
- Honest language about protection and encryption (ADR-006/007). Never claim unverified results.

## Commit messages
Conventional Commits (`docs:`, `feat:`, `fix:`, `test:`, `chore:`), body in English, trailer `Co-Authored-By: <model name> <noreply@anthropic.com>` when AI-authored. Commit after each coherent batch; never force-push `main`.
