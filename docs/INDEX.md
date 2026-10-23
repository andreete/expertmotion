# Documentation Index

| Field | Value |
|---|---|
| Status | Living |
| Owner | Documentation lead |
| Last updated | 2026-10-24 |

This index is the map of the documentation. Status values: `planned`, `draft`, `review`, `baseline`. "Owner of" lists the concepts a document is the single source of truth for; other documents reference, never redefine.

## Reading order

1. `MASTER_PROJECT_PROMPT.md` — the brief (verbatim).
2. `GLOSSARY.md` — the words every document uses.
3. `ASSESSMENT.md` — Deliverable A: what was inspected and found.
4. `PRD.md` → `BRD.md` → `FRD.md` → `SRS.md` — what to build and why.
5. `UXRD.md` → `USER_FLOWS.md` → `EDITOR_INTERACTION_MODEL.md` → `UI_UX_SPECIFICATION.md` → `ELEMENT_IDS.md` → `ACCESSIBILITY_AND_I18N.md` → `ONBOARDING_TOUR.md` — how it looks and behaves.
6. `ARCHITECTURE.md` → `BLUEPRINT.md` → `TRD.md` → `API_SPECIFICATION.md` → `DATABASE_SCHEMA.md` → `PERFORMANCE.md` → `ASSET_INGESTION.md` — how it is built.
7. `AI_WORKFLOW.md` → `AGENT_DESIGN.md` → `../SYSTEM_PROMPT.md` → `DESIGN_CATALOGUE.md` → `REMOTION_CAPABILITY_MAP.md` → `LOCAL_AI_MODELS.md` → `MCP_AND_TOOLING.md` → `GOLDEN_SCENARIOS.md` — the AI and Remotion layers.
8. `SECURITY.md` → `THREAT_MODEL.md` → `VULNERABILITY_CHECKLIST.md` → `LICENSE_OPERATIONS.md` → `DEPLOYMENT_AND_PACKAGING.md` — security, licensing, shipping.
9. `ROADMAP.md` → `STAGE_MANAGEMENT.md` → `POC_PLAN.md` → `DEVELOPMENT_WORKFLOW.md` → `DEFINITION_OF_DONE.md` → `QA_PROCESS.md` → `TEST_PLAN.md` → `ERROR_CATALOGUE.md` — process.
10. `DECISIONS.md`, `RISKS_AND_ASSUMPTIONS.md`, `AGENT_SKILLS.md`, `HOOKS_AND_GUARDRAILS.md` — decisions, risks, tooling.

## Document map

| Document | Purpose | Owner of | ID prefix | Status |
|---|---|---|---|---|
| MASTER_PROJECT_PROMPT.md | The brief | — | — | baseline |
| GLOSSARY.md | Canonical vocabulary (frozen; controlled additions logged in ADR-018) | terms | — | baseline (frozen) |
| ASSESSMENT.md | Deliverable A: repo, mockup, PDF, Remotion, feasibility, licensing, gaps | findings | — | baseline |
| PRD.md | Product requirements, personas, MVP scope P0/P1/P2, metrics | product scope | PRD- | baseline |
| BRD.md | Business model, licensing path, costs, compliance, KPIs | business rules, compliance | BRD-, K- | baseline |
| FRD.md | Functional requirements per command and element | FR list | FR- | baseline |
| SRS.md | Software requirements, NFRs, interfaces | NFR list | NFR- | baseline |
| UXRD.md | UX requirements, personas, JTBD | UX list | UX- | baseline |
| USER_FLOWS.md | End-to-end flows with states | flows | — | baseline |
| EDITOR_INTERACTION_MODEL.md | Ten-point interaction spec per significant action | interactions | IX- | baseline |
| UI_UX_SPECIFICATION.md | Screens, components, tokens, copy | design system | — | baseline |
| ELEMENT_IDS.md | UI element IDs and wireframe | element IDs | el: | baseline |
| ACCESSIBILITY_AND_I18N.md | Keyboard, contrast, i18n keys | i18n scheme | — | baseline |
| ONBOARDING_TOUR.md | First-run tour copy (EN/ID) | tour | — | baseline |
| ARCHITECTURE.md | C4, processes, data flow, shell comparison | architecture | — | baseline |
| BLUEPRINT.md | Repo layout, packages, port list | module boundaries | — | baseline |
| TRD.md | Stack, versions, dependencies, budgets | stack | TR- | baseline |
| API_SPECIFICATION.md | Local Service REST + SSE contract | routes, events | R- | baseline |
| DATABASE_SCHEMA.md | SQLite DDL, Composition Model JSON Schema, migrations, encryption | schema | CM- | baseline |
| PERFORMANCE.md | Hardware tiers, Performance Profiles, ratio × resolution table, budgets | profiles, pixel table | — | baseline |
| ASSET_INGESTION.md | Import pipeline | ingestion rules | — | baseline |
| AI_WORKFLOW.md | Edit-intent pipeline, schemas, op vocabulary, locking, tools | intents, plans, ops | AI- | baseline |
| AGENT_DESIGN.md | Agents, permissions, runtime sub-agents, repo-side subagents | agent roles | AGD- | baseline |
| ../SYSTEM_PROMPT.md | Versioned runtime prompts (v1.0.0) | prompts | — | baseline |
| DESIGN_CATALOGUE.md | Closed preset registry | preset IDs | preset: | baseline |
| REMOTION_CAPABILITY_MAP.md | Feature → Remotion API mapping with sources | mapping | — | baseline |
| LOCAL_AI_MODELS.md | Model registry, licences, tiers, download policy | model registry | — | baseline |
| MCP_AND_TOOLING.md | MCP evaluation, tool layer | tooling decision | — | baseline |
| GOLDEN_SCENARIOS.md | 20 end-to-end scenarios + fixtures | scenarios | GS- | baseline |
| SECURITY.md | Security requirements and controls | SEC list | SEC- | baseline |
| THREAT_MODEL.md | STRIDE, boundaries, not-protected list | threats | — | baseline |
| VULNERABILITY_CHECKLIST.md | Per-release checklist | checklist | — | baseline |
| LICENSE_OPERATIONS.md | Licence key format and runbook, trial | licence ops | LIC- | baseline |
| DEPLOYMENT_AND_PACKAGING.md | Electron build, signing, installer, updater | packaging | — | baseline |
| ROADMAP.md | Stages 0–7, milestones | roadmap | — | baseline |
| STAGE_MANAGEMENT.md | Gates, criteria, roles, releases | gates | — | baseline |
| POC_PLAN.md | Deliverable D experiments | POC list | POC- | baseline |
| DEVELOPMENT_WORKFLOW.md | Branching, reviews, handover | workflow | — | baseline |
| DEFINITION_OF_DONE.md | DoD per artefact | DoD | — | baseline |
| QA_PROCESS.md | QA approach, triage | QA process | — | baseline |
| TEST_PLAN.md | Test cases and matrices | QA list | QA- | baseline |
| ERROR_CATALOGUE.md | Error codes and copy | error codes | EM- | baseline |
| DECISIONS.md | ADRs | decisions | ADR- | baseline |
| RISKS_AND_ASSUMPTIONS.md | Risks, assumptions | risks | RISK-, ASM- | baseline |
| AGENT_SKILLS.md | Development skills | skills | — | baseline |
| HOOKS_AND_GUARDRAILS.md | Hooks and policy checks | hooks | HG- | baseline |

## Traceability matrices (filled during the consistency pass)

| Matrix | Rule | Status |
|---|---|---|
| Element → FRD → UI spec | every `el:` ID appears in FRD.md and UI_UX_SPECIFICATION.md | pending |
| Menu item → Catalogue → Remotion | every Home/Design/Tools item has rows in DESIGN_CATALOGUE.md and REMOTION_CAPABILITY_MAP.md | pending |
| FR → acceptance → test | every FR has acceptance criteria, priority, verification method, and ≥ 1 QA- case | pending |
| Tool → prompt → agent | every tool in AI_WORKFLOW.md appears in SYSTEM_PROMPT.md and AGENT_DESIGN.md | pending |
| Preset → mapping | every `preset:` has a Remotion mapping | pending |
| String → ID variant | every user-facing string has an Indonesian variant | pending |
| Risk → owner | every RISK- has owner, likelihood, impact, mitigation | pending |
| ADR → reference | every ADR is referenced by ≥ 1 document | pending |
| P0 → stage → test | every P0 item maps to a stage task and a test | pending |
