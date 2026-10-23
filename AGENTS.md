# AGENTS.md — canonical instructions for every coding agent working on Expertmotion

This file is the single source of repository-wide rules. Tool-specific files (`CLAUDE.md`, `.claude/`) only add mechanics and point back here. If any instruction elsewhere conflicts with this file, this file wins.

## 1. What this project is

Expertmotion: a local-first, AI-assisted motion video editor for non-technical creators, shipped as a Windows desktop executable (Electron) that launches a local web editor; Remotion is the engine, never the interface. The brief is `docs/MASTER_PROJECT_PROMPT.md`. The product name is always **Expertmotion** ("Remason" in the mockup is a reference name).

## 2. Start every session like this

1. Read `process.md` (current stage, blockers, next tasks) and `memory.md` (decisions, stack, canonical locations).
2. Read `docs/INDEX.md` and open only the documents your task needs. `docs/GLOSSARY.md` is frozen: use its terms exactly.
3. Confirm the current stage in `docs/ROADMAP.md` and the stage's exit criteria in `docs/STAGE_MANAGEMENT.md`.
4. Work. Then append a `process.md` entry (template in `docs/STAGE_MANAGEMENT.md`), update `memory.md` if a decision or discovery changed, and commit.

## 3. Non-negotiable rules

1. **Documentation is the source of truth.** Requirements (`FR-`, `NFR-`, `UX-`, `AI-`, `SEC-`), decisions (`ADR-`) and schemas live in `docs/`. Code implements them; if code must deviate, update the document first (or in the same change) and say so in `process.md`.
2. **Single owners.** Composition Model schema → `docs/DATABASE_SCHEMA.md`; Intent/Plan/Operation schemas and the op vocabulary → `docs/AI_WORKFLOW.md`; preset ids → `docs/DESIGN_CATALOGUE.md`; element ids → `docs/ELEMENT_IDS.md`; routes/events → `docs/API_SPECIFICATION.md`; errors → `docs/ERROR_CATALOGUE.md`; pixel table and profiles → `docs/PERFORMANCE.md`. Never redefine these elsewhere; reference them.
3. **The LLM never enforces invariants.** Deterministic code validates, orders, resolves conflicts and mutates state. Agents propose; the Creator's Execute and the validator decide (ADR-002).
4. **No runtime code generation.** Remotion compositions are fixed code (`ExpertmotionTimeline` + Design Presets) driven by the JSON Composition Model (ADR-001). Never add a path that compiles or evals model output.
5. **Local-first and private.** Local Service binds to `127.0.0.1` with a per-launch Service Token; outbound traffic only to configured providers, model downloads and updates; Private Mode blocks all of it; no telemetry.
6. **Honest security language.** Never write "cannot be reverse-engineered", "unbreakable" or "even the user cannot read it". Write what the layers do and what they do not protect against (ADR-006, ADR-007).
7. **No secrets in the repo or binary.** No API keys, no private signing keys, no `.env` committed. The licence module embeds only the Ed25519 public key.
8. **Verified means executed.** Never claim a build, test, render or security check passed without running it and pasting the actual result into `process.md`. If something cannot be run in the current environment, say so.
9. **Pinned dependencies.** All `@remotion/*` packages share one exact version. New dependencies need purpose, licence and operational note in `docs/TRD.md`.
10. **Priorities.** P0 (`docs/PRD.md` §4.1) before P1/P2. Do not implement P1/P2 features at the expense of P0 reliability.
11. **English documentation.** User-facing strings get Indonesian variants (i18n keys per `docs/ACCESSIBILITY_AND_I18N.md`).
12. **Ask only when blocked.** Prefer a clearly labelled provisional decision (recorded as a `provisional` ADR) over a blocking question, unless proceeding would be unsafe or wasteful.

## 4. Environment facts you must respect

- **Shared Linux development server** (if you are on it): Ubuntu, 1.9 GB RAM, 2 CPUs, no display, shared with another tenant. Only headless work (docs, composition-model, intents, service unit tests, small stills). Run anything heavy inside the memory cap (`npm run dev:capped` pattern: cgroup soft 900 MB / hard 1.2 GB, render concurrency 1). Never bind ports 3000 or 4000 (another tenant); use 4100+. Electron cannot be built or run here.
- **Windows machine or CI** is required for Electron packaging, installer smoke tests, GPU-tier tests.
- The predecessor repository `/home/andre/experthinker-studio` is read-only reference material (port list in `docs/BLUEPRINT.md`). Do not modify it.

## 5. Working agreements by task type

| Task | Must do |
|---|---|
| New Design Preset | catalogue row (`DESIGN_CATALOGUE.md`) + mapping row (`REMOTION_CAPABILITY_MAP.md`) + engine component + Compile table entry + preview loop + golden frames in all seven ratios + i18n labels |
| New Operation | `AI_WORKFLOW.md` §5 row + schema + `applyOps` + `validate` + tests + ADR note |
| Schema change | migration + Zod + fixtures + `DATABASE_SCHEMA.md` + ADR note; never edit concurrently with another agent |
| Prompt change | bump version in `SYSTEM_PROMPT.md` + re-run golden scenarios |
| UI change | use `data-el` ids from `ELEMENT_IDS.md`; add new ids there first |
| Security-relevant change | `SECURITY.md` requirement + `VULNERABILITY_CHECKLIST.md` item + test |
| Any change | typecheck, tests, docs, `process.md` entry; measure memory when on the shared server |

Full criteria: `docs/DEFINITION_OF_DONE.md`.

## 6. Hand-over protocol (continuity across models and accounts)

- Stop at a safe checkpoint when context or budget runs low: commit, write the `process.md` entry with "how to continue", update `memory.md`.
- Never rely on chat history. Everything the next agent needs is in the repo.
- Record failed approaches and lessons in `process.md` so they are not repeated.

## 7. Development skills, hooks and subagents

- Skills (reusable dev workflows): `docs/AGENT_SKILLS.md`, implemented for Claude Code under `.claude/skills/`.
- Hooks (deterministic checks): `docs/HOOKS_AND_GUARDRAILS.md`, wired in `.claude/settings.json`.
- Development subagents (roles, permissions, files they may modify): `docs/AGENT_DESIGN.md` §6, defined under `.claude/agents/`.
- Runtime agents inside the product (Brainstorming Agent, Editor Agent) are a different thing: `docs/AGENT_DESIGN.md` §1–5 and `SYSTEM_PROMPT.md`.

## 8. Current phase

Stage 2 (technical proof of concept), started 2026-10-24 on the Operator's instruction. Throwaway proof code lives in `poc/`; product code (Stage 3) starts only after the Stage 2 exit criteria pass (`docs/POC_PLAN.md` §1). Current state and next tasks: `process.md`.
