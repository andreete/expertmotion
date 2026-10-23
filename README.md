# Expertmotion

Expertmotion is a local-first, AI-assisted motion video editor for beginners, independent content creators and small businesses. It ships as a Windows desktop executable that launches a local web-based editor. Under the hood it drives Remotion; the Creator never needs Node.js, npm, React or a terminal.

The workflow: launch the app → onboarding → connect an AI provider and pick models → drag clips, images and audio in → order them and insert → pick designs (transitions, captions, backgrounds, motion, shapes, easing, effects, audio) → brainstorm with the Brainstorming Agent → let the Editor Agent turn picks and instructions into a validated edit plan → Execute → preview → render and export locally.

**Product name is always Expertmotion.** Reference screenshots say "Remason"; that is not the product.

## Status

Stage 0 (discovery) and Stage 1 (product definition and architecture) are being documented. No application code exists in this repository yet. See `process.md` for the current state and next tasks.

## Where to start

| You are… | Read, in order |
|---|---|
| Any coding agent | `AGENTS.md`, `process.md`, `memory.md`, `docs/INDEX.md` |
| Claude Code | `CLAUDE.md` (which points to `AGENTS.md`) |
| A human reviewer | `docs/MASTER_PROJECT_PROMPT.md` (the brief), `docs/ASSESSMENT.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md` |
| Implementing a feature | `docs/FRD.md` → `docs/AI_WORKFLOW.md` → `docs/DESIGN_CATALOGUE.md` → `docs/API_SPECIFICATION.md` → `docs/DATABASE_SCHEMA.md` → `docs/TEST_PLAN.md` |

## Deliverables of the Master Project Prompt (§23)

| Deliverable | Where |
|---|---|
| A. Repository and reference assessment | `docs/ASSESSMENT.md` |
| B. Product and architecture foundation | `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/TRD.md`, `docs/AGENT_DESIGN.md`, `docs/AI_WORKFLOW.md`, `docs/DATABASE_SCHEMA.md`, `docs/DEPLOYMENT_AND_PACKAGING.md`, `docs/SECURITY.md`, `docs/UI_UX_SPECIFICATION.md`, `docs/INDEX.md` (traceability) |
| C. Execution framework | `docs/ROADMAP.md`, `docs/STAGE_MANAGEMENT.md`, `docs/QA_PROCESS.md`, `docs/TEST_PLAN.md`, `docs/DEFINITION_OF_DONE.md`, `AGENTS.md`, `CLAUDE.md`, `docs/AGENT_SKILLS.md`, `docs/HOOKS_AND_GUARDRAILS.md`, `process.md`, `memory.md` |
| D. Technical proof-of-concept plan | `docs/POC_PLAN.md` |

## Repository layout (documentation phase)

```
AGENTS.md  CLAUDE.md  SYSTEM_PROMPT.md  process.md  memory.md  README.md
.claude/   settings.json, hooks/, skills/, agents/   (Claude Code wiring)
docs/      all specifications (see docs/INDEX.md), MASTER_PROJECT_PROMPT.md, assets/
```

The planned code layout (`apps/desktop`, `apps/service`, `apps/ui`, `packages/*`) is specified in `docs/BLUEPRINT.md` and created in Stage 3.

## Reference material

- `docs/assets/expertmotion-editor-mockup.png`: the proposed editor UI (primary visual reference).
- `docs/assets/remotion-untuk-pemula.pdf` (+ extracted text): the Indonesian beginner's guide to Remotion 4.0.537 that lists the features to automate.
- Remotion: https://www.remotion.dev/ (docs, learn, elements), https://github.com/remotion-dev/remotion. Findings with access dates are in `docs/ASSESSMENT.md`.

## Licence

Proprietary. Expertmotion is sold under a one-time licence (see `docs/BRD.md`, `docs/LICENSE_OPERATIONS.md`). Third-party components keep their own licences; see the compliance section of `docs/BRD.md` and `docs/LOCAL_AI_MODELS.md`.
