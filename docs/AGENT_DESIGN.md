# Agent Design

| Field | Value |
|---|---|
| Status | baseline |
| Owner | AI agent architect |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-002, 003, 009, 015), AI_WORKFLOW.md, DESIGN_CATALOGUE.md, MCP_AND_TOOLING.md, ../SYSTEM_PROMPT.md |
| Used by | SYSTEM_PROMPT.md, API_SPECIFICATION.md, FRD.md, TEST_PLAN.md, AGENT_SKILLS.md, HOOKS_AND_GUARDRAILS.md |
| Owner of | agent roles and permissions, runtime sub-agent roster, repo-side (development) subagent roster |

Two different things are called "agent" in this project (brief §20). This document keeps them apart:

- **Runtime agents** live inside Expertmotion and help the Creator (Brainstorming Agent, Editor Agent, deterministic Runtime Sub-agents).
- **Development subagents** are Claude Code / coding-assistant roles that help build Expertmotion (defined in §6 and wired in `.claude/agents/`).

## 1. Runtime agent roster

| Agent | Type | Model | Talks to | May mutate state? | Purpose |
|---|---|---|---|---|---|
| **Brainstorming Agent** | LLM | Creator-assigned (`model_assignments.brainstorm`) | Creator (Brainstorming Chat) | **No** | understand goals, ask, suggest concepts/styles/story order, organise assets, propose composition changes as Edit Intents, explain in beginner language |
| **Editor Agent** | LLM | Creator-assigned (`model_assignments.editor`) | Creator (Editor Chat), Intent Queue | **Only via Edit Plans executed by the Creator's Execute** | translate intents + instructions into validated Edit Plans; after Execute, its plan steps run through tools |
| Ingest Sub-agent | deterministic | — | Local Service | writes `assets` | probe, transcode, proxy, thumbs, waveform (ASSET_INGESTION.md) |
| Caption Sub-agent | deterministic (+ whisper.cpp P1) | — | plan step | produces caption pages (returned to the plan as `op:caption.setPages`) | SRT/VTT parse (P0), transcription (P1), `createTikTokStyleCaptions` |
| Audio Sub-agent | deterministic | — | plan step | — (returns ops) | ducking curve computation from voice/clip audio ranges, loudness normalisation suggestion |
| Layout Sub-agent | deterministic | — | plan step / validator | — | `fitText` sizing, safe-area placement per ratio, overlap checks (CM-008) |
| Thumbnail Sub-agent | deterministic (+ sd.cpp P2) | — | plan step | writes `assets` | `renderStill` of a chosen frame + title; image generation in P2 |
| QA-check Sub-agent | deterministic | — | post-Execute | — | runs `validate(model)`, duration/overlap/asset checks, produces the `ExecutionResult.diff` |

Runtime Sub-agents are plain functions/jobs; they are listed as "agents" only because Edit Plan steps address them by name (`tool` field). None of them calls an LLM except where marked P1/P2 for local models, and even then the model is a transcription/synthesis model, not an instruction-following LLM.

## 2. Responsibilities and limits

### 2.1 Brainstorming Agent (brief §8.1)

Does: clarify objectives; propose 2–3 concepts with structure (hook → body → CTA); suggest which asset goes where (by asset name/duration, never by file path); recommend presets **by id from the Design Catalogue**; explain terms in plain language (Indonesian or English, matching the Creator); produce `proposedIntents` when the Creator agrees ("ya, pakai itu"), each as an `EditIntent` with `source: 'brainstorm'`.

Does not: call mutation or validation tools; promise render times or costs it cannot see (it may quote `render.estimate` output); invent presets, assets or features; mention Remotion, React, code or files.

Tools: `composition.get` (summary), `assets.list`, `catalogue.search`, `hardware.profile`, `project.settings.get`, `render.estimate`.

Output contract (Zod `BrainstormTurn`): `{ reply: string, questions?: string[], proposedIntents?: EditIntent[], suggestedNextStep?: 'send-to-editor'|'import-assets'|'none' }`.

### 2.2 Editor Agent (brief §8.2)

Inputs (always the Rewrite envelope from AI_WORKFLOW §7): queued Edit Intents with resolved targets, Creator message, Creator notes, compact Composition Model, assets, Locked Keys, capabilities (ops + preset ids + limits), Output Settings, Hardware Tier.

Does: produce one `EditPlan` JSON; use `composition.validateOps` to dry-run before answering (recommended, max 3 calls); keep plans minimal (only what the intents and message ask); respect Locked Keys absolutely; ask one clarifying question instead of guessing when an intent is ambiguous (returned as a plan with zero steps and `risks[{code:'needs-input'}]`); write `expectedDiff` in the Creator's language.

Does not: write code; reference files; add unrequested elements; change Output Settings unless asked; call `render.start`.

Tools: Brainstorming set + `composition.validateOps`, `assets.probe`, `catalogue.search`.

Output contract: `EditPlan` (AI_WORKFLOW §3) only. Any prose must go in `goal`/`expectedDiff`/`risks[].message`.

### 2.3 Model Assignment and capability gating

| Capability (from Capability Table) | Brainstorming Agent | Editor Agent |
|---|---|---|
| tool calling | optional (falls back to JSON mode) | preferred; JSON mode fallback with embedded tool list |
| structured output / JSON mode | required | required |
| context length | ≥ 32k recommended | ≥ 32k required (envelope ≈ 6–12k tokens) |
| image input | optional (attachments) | optional |
| price | shown; budget applies | shown; budget applies |

The Providers screen refuses to assign a model that lacks JSON output capability and warns below 32k context.

### 2.4 Permissions matrix (enforced by the tool registry, not by prompts)

| Tool | Brainstorm | Editor | Runtime (plan step) | Creator UI |
|---|---|---|---|---|
| composition.get | read | read | read | read |
| composition.validateOps | — | yes | yes | — |
| composition.applyOps | — | — | **Execute only** | via Execute |
| catalogue.search | yes | yes | — | yes |
| assets.list / probe | list | both | both | both |
| captions.generate, tts.generate, music.generate, thumbnail.generate | — | — | plan step (P1/P2) | Generator Cards |
| render.estimate | yes | yes | — | yes |
| render.start | — | — | — | **Creator only** |
| hardware.profile, project.settings.get | yes | yes | yes | yes |

## 3. Conversation and hand-off protocol

1. Brainstorming Chat: free dialogue. When the agent returns `proposedIntents`, the Editor renders `agent.brainstorm.handoff` ("Send to Editor Agent" / "Kirim ke Editor Agent"; "Dismiss" / "Abaikan").
2. On send, intents are validated like UI picks (steps 2–5 of the pipeline) and appear in the Intent Queue tagged "from Brainstorm".
3. The Editor Agent is invoked only when the Creator presses "Plan" (`agent.editor.send` with or without a message) or when a queued intent needs interpretation and the Creator has enabled "auto-plan" (default on; setting).
4. The Plan Card shows goal, steps, expected diff, risks, usage. Execute applies; Cancel discards; editing the queue invalidates the plan (`stale`).
5. After Execute, the Editor Agent receives the `ExecutionResult` summary as a system message in its thread so follow-ups are grounded.

## 4. Context, memory and privacy per agent

- Each agent has one conversation per project; summaries are deterministic (AI_WORKFLOW §10).
- No cross-project memory in MVP; project language (`projects.language`) sets the reply language.
- What is sent to a provider (disclosed in Settings ▸ Providers, EN/ID): system prompt, thread (windowed), compact Composition Model (ids, durations, preset ids, text contents of Text Layers and captions), asset names and metadata (never file bytes unless the Creator attaches an image), Creator messages. Never sent: file paths, licence, other projects, provider keys.

## 5. Failure behaviour (summary; details AI_WORKFLOW §12)

Timeouts and rate limits retry once; invalid output re-prompts twice; Locked Key violations re-prompt once then drop; budget stops new runs; Private Mode disables composers with an inline notice ("Agents are off in Private Mode" / "Agen nonaktif dalam Mode Privat"); interrupted runs are marked cancelled.

## 6. Development subagents (repo-side, Claude Code `.claude/agents/*.md`)

These help build Expertmotion. They never ship in the product.

| Subagent | Scope | May modify | Inputs | Outputs | Validation | Integration owner |
|---|---|---|---|---|---|---|
| `requirements-analyst` | turn a feature request into FR/NFR/UX ids and acceptance criteria | `docs/FRD.md`, `docs/SRS.md`, `docs/UXRD.md` (append only) | PRD, glossary, request | new requirement rows | ids unique; glossary terms | implementation agent |
| `architecture-reviewer` | review a design or PR against ADRs and architecture | nothing (report only) | diff/doc | findings with ADR refs | — | Operator |
| `remotion-engine-dev` | implement Design Presets and the `ExpertmotionTimeline` composition | `packages/engine/**`, `docs/DESIGN_CATALOGUE.md` rows, `docs/REMOTION_CAPABILITY_MAP.md` rows | catalogue row, mapping row | component + golden frames + loop | typecheck, golden-frame tests in 7 ratios, memory measured on the shared server | implementation agent |
| `composition-model-dev` | schema, ops, validate, migrations | `packages/composition-model/**`, `docs/DATABASE_SCHEMA.md`, `docs/AI_WORKFLOW.md` §5 | op spec | code + tests + doc rows | unit tests; ADR note for new ops | implementation agent |
| `agents-dev` | Intent Compiler, Rewrite envelope, provider adapters, prompts | `packages/agents/**`, `SYSTEM_PROMPT.md` (version bump) | AI_WORKFLOW, AGENT_DESIGN | code + golden scenario replays | GS replays pass; Locked Key tests | implementation agent |
| `ui-dev` | Editor React components per ELEMENT_IDS | `apps/ui/**` | UI spec, element ids | components with `data-el` | Playwright e2e; a11y checks | implementation agent |
| `service-dev` | Local Service routes, DB, render queue, ingest | `apps/service/**` | API spec, DB schema | code + integration tests | API tests; security checklist items | implementation agent |
| `desktop-dev` | Electron shell, packaging, signing scripts | `apps/desktop/**`, `docs/DEPLOYMENT_AND_PACKAGING.md` | packaging doc | build scripts | clean-VM smoke (Windows only) | Operator |
| `security-reviewer` | threat model and checklist review of a change | nothing (report only) | diff | findings with SEC- refs | — | Operator |
| `qa-engineer` | write/execute tests from TEST_PLAN | `**/test/**`, `docs/TEST_PLAN.md` | FR/QA ids | tests + results in process.md | tests actually run | implementation agent |
| `docs-maintainer` | keep docs, INDEX matrices, process.md, memory.md consistent | `docs/**`, `process.md`, `memory.md` | changes | updated docs | consistency pass rules | implementation agent |

Coordination rules (brief §20): no two subagents edit `docs/GLOSSARY.md` (frozen), `docs/DATABASE_SCHEMA.md` or `docs/AI_WORKFLOW.md` concurrently; schema changes go through `composition-model-dev` only; a coordinating (implementation) agent integrates, runs the full test suite and writes the process.md entry.

## 7. Requirements

| ID | Requirement | Verification |
|---|---|---|
| AGD-001 | Brainstorming Agent has no mutation or validation tools (registry-enforced) | registry unit test |
| AGD-002 | Editor Agent output is always an `EditPlan`; prose-only replies are rejected and re-prompted | fake provider test |
| AGD-003 | Hand-off requires an explicit Creator action | e2e |
| AGD-004 | Model assignment refuses models without JSON output capability | unit |
| AGD-005 | Disclosure text of what is sent to providers exists in Settings (EN/ID) | UI review |
| AGD-006 | Development subagents never write to the frozen glossary | hook (HOOKS_AND_GUARDRAILS.md) |
