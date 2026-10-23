# process.md — execution log

Append an entry after every meaningful work unit. Newest entry first. Each entry records: stage, objectives, completed tasks, files created or modified, verification performed with actual results, blockers, failed approaches and lessons, pending decisions, next actionable tasks, and how to continue.

## Current state (keep this block up to date)

- **Current stage**: Stage 1 complete pending Operator review (documentation suite written and cross-checked). Next stage: Stage 2 (technical proof of concept), to be executed by an implementation agent on a Windows machine or CI (see `docs/POC_PLAN.md`, `docs/ROADMAP.md`).
- **Current objective**: Operator reviews the suite, confirms the three provisional ADRs (008, 009, 016) and the open questions in `memory.md` §6, then starts Stage 2 with POC-001/003/002 in that order.
- **Blockers**: no application code may be written until the Operator starts Stage 2 (Operator instruction 2026-10-24: "documents only; code will be executed by another model"). Remotion licence confirmation (BRD-010) is a launch blocker, not a Stage 2 blocker.
- **Next actionable tasks**: see Entry 2 below.

---

## 2026-10-24 — Entry 2: full documentation suite written, cross-reviewed and reconciled

- **Stage**: 1 (Product definition and architecture) — documentation deliverables A–D complete.
- **Objectives**: write every document in `docs/INDEX.md`; wire `.claude/` (hooks, skills, subagents); reconcile cross-document inconsistencies; verify with greps and a Haiku dry-run.
- **Completed** (46 documents in `docs/` + root files):
  - Core (coordinator): ASSESSMENT, PRD, ARCHITECTURE, AI_WORKFLOW, DESIGN_CATALOGUE (112 preset ids), PERFORMANCE, DATABASE_SCHEMA, AGENT_DESIGN, SYSTEM_PROMPT.md (v1.0.1), AGENTS.md, CLAUDE.md, AGENT_SKILLS, HOOKS_AND_GUARDRAILS, `.claude/settings.json`, 7 hook scripts (self-test passes), 11 skills, 11 subagent definitions, `tools/docs-check.sh`.
  - Parallel writers (8 agents): BRD (27 BRD-, 11 KPIs), RISKS_AND_ASSUMPTIONS (29 RISK-, 21 ASM-), LICENSE_OPERATIONS; FRD (178 FR-), SRS (110 NFR-), ERROR_CATALOGUE (159 EM-); UXRD (34 UX-), USER_FLOWS (F1–F15), EDITOR_INTERACTION_MODEL (IX-01…25), UI_UX_SPECIFICATION, ACCESSIBILITY_AND_I18N, ONBOARDING_TOUR; REMOTION_CAPABILITY_MAP (all presets mapped, sources with access dates), LOCAL_AI_MODELS, ASSET_INGESTION; ROADMAP (stages 0–7, 28–38 developer-weeks estimate), STAGE_MANAGEMENT, DEVELOPMENT_WORKFLOW, DEFINITION_OF_DONE, QA_PROCESS, TEST_PLAN (222 QA-); SECURITY (89 SEC-), THREAT_MODEL, VULNERABILITY_CHECKLIST, DEPLOYMENT_AND_PACKAGING, POC_PLAN (POC-001…010); MCP_AND_TOOLING, GOLDEN_SCENARIOS (GS-01…20); BLUEPRINT, TRD (TR-), API_SPECIFICATION (97 routes, 23 SSE events).
- **Decisions taken during the pass** (all in `docs/DECISIONS.md`): ADR-018 glossary change log; `packages/catalogue` added (ADR-013) to break the engine ↔ model ↔ agents cycle; Local Service via `utilityProcess.fork` + `parentPort` bootstrap; media grants in the URL path as the second exception to the Bearer rule (ADR-005); installer size wording unified (≈ 300–400 MB compressed, budget ≤ 450 MB, POC-001 measures); pixel table rule = short side; Performance Profiles vs fps (ADR-010); dev ports 4110/4120, production 47600–47699; `op:theme.setTextDefaults`; multi-target intents expand to parent + per-cut children; `EditIntent.status` has `removed`, no `restored`; cut indexes 0-based in data; Indonesian copy uses friendly "kamu" except legal/licence texts; FFmpeg: Remotion slim build (`@remotion/compositor-win32-x64-msvc`) for output, separate full build for ingestion; Piper voices on sherpa-onnx with espeak-ng GPL-3 handling.
- **Verification performed (actual results)**:
  - `bash tools/docs-check.sh`: PASS remason-only-in-rules, header-tables, preset-mapping (112/112), element-ids-resolve, em-codes-defined, adrs-referenced (18/18). Informational: 14 ops not yet referenced by FRD/GOLDEN_SCENARIOS (clear/remove variants).
  - `bash .claude/hooks/selftest.sh`: 7/7 PASS (guards only; no application code executed).
  - Haiku dry-run (model: Haiku, inputs: SYSTEM_PROMPT P-2 + AI_WORKFLOW + DESIGN_CATALOGUE, 3 scenarios): scenario 1 valid plan (title via `op:text.add`); scenario 2 respected the Locked Key `cut:0.transition` and reported it as an info risk; scenario 3 blocked the whole plan because one intent lacked an asset → prompt rule 6 changed to partial plans with a `warn` risk (SYSTEM_PROMPT v1.0.1).
  - No builds, tests or renders apply (documentation phase).
- **Failed approaches / lessons**: writing 40 documents in parallel produced ~60 cross-document inconsistencies (ids, names, pixel values, status enums); the fix was to freeze owner documents first, give every writer the same owner set, and run a second reconciliation pass with disjoint write-sets. Keep `tools/docs-check.sh` green before every commit.
- **Pending decisions (Operator)**: ADR-008 (weights downloaded on first use), ADR-009 (social caption text/hashtags via connected LLM), ADR-016 (Tools in P1/P2); Remotion licence confirmation (BRD-010); product price and trial reminder policy (BRD D-decisions); 2:3/3:2 ratios; whether Septianus Angga is a channel partner (ASM-016).
- **Next tasks** (Stage 2, implementation agent, Windows machine or CI unless noted):
  1. Read `AGENTS.md`, `memory.md`, this file, `docs/INDEX.md`; confirm the three provisional ADRs with the Operator.
  2. POC-001 packaging smoke → POC-003 native deps → POC-002 parity → POC-007 resources → POC-006 artefact security → POC-005 recovery (Linux-runnable DB part) → POC-004 provider structured output (Linux-runnable) → POC-009, POC-008, POC-010. Record each result in this file.
  3. Only after POC gates pass: Stage 3 foundation per `docs/ROADMAP.md`, starting with the P0 vertical slice defined in `docs/BLUEPRINT.md`.
- **How to continue**: do not write application code before the Operator starts Stage 2. On the shared Linux server run only headless, capped work (`CLAUDE.md`). Keep `bash tools/docs-check.sh` passing; append an entry here after every work unit.

## 2026-10-24 — Entry 1: repository created, foundation documents written

- **Stage**: 0 → 1.
- **Objectives**: create the `expertmotion` repository; copy the brief and reference materials; write the documents every other document depends on (glossary, element IDs, ADRs, index, memory, process).
- **Completed**:
  - `git init` in `/home/andre/expertmotion` (branch `main`).
  - Copied `docs/MASTER_PROJECT_PROMPT.md`, `docs/assets/expertmotion-editor-mockup.png` (renamed from "Remason Editor.png"), `docs/assets/remotion-untuk-pemula.pdf`, and the extracted text `docs/assets/remotion-untuk-pemula-extracted-text.txt` (produced with a Node script because `pdftotext` is not installed on the dev server; glyphs decoded via the PDF's ToUnicode maps; 107 pages, ~123k characters).
  - Written: `README.md`, `docs/INDEX.md`, `docs/GLOSSARY.md`, `docs/ELEMENT_IDS.md`, `docs/DECISIONS.md` (ADR-001…017), `memory.md`, this file.
- **Research performed before writing** (summaries in `memory.md` §5, full findings go into `docs/ASSESSMENT.md`): the mockup inspected at full resolution; the PDF read in full; remotion.dev docs, pricing/licence FAQ, Elements, Electron template; packaging options (Electron, Tauri, Neutralino, Node SEA, pkg, Bun); code protection limits; encrypted SQLite and key storage; local model licences (TTS, music, STT, image); provider APIs; hardware monitoring; inventory of `/home/andre/experthinker-studio` for reusable modules.
- **Verification**: files exist (`ls docs`), git initialised. No builds or tests apply yet.
- **Decisions taken**: see `docs/DECISIONS.md`. Operator chat decisions: Windows first; local open-source models for Tools; new repo; offline Ed25519 licence.
- **Failed approaches / lessons**: PDF text extraction with naive stream parsing produced garbage until (a) `endstream` matches were excluded from `stream` matches, (b) page `/Resources` were parsed as nested dicts (the first non-greedy `<<…>>` match stopped at `/ExtGState`), (c) ToUnicode CMaps were applied per font. Keep the extracted text file so nobody repeats this.
- **Pending decisions**: ADR-008, ADR-009, ADR-016 (Operator confirmation).
- **Next tasks** (in order):
  1. Write `docs/ASSESSMENT.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/AI_WORKFLOW.md`, `docs/DESIGN_CATALOGUE.md`, `docs/PERFORMANCE.md`; then freeze `docs/GLOSSARY.md`.
  2. Batch A: BRD, RISKS_AND_ASSUMPTIONS, LICENSE_OPERATIONS; FRD, SRS, ERROR_CATALOGUE; UXRD, USER_FLOWS, EDITOR_INTERACTION_MODEL, UI_UX_SPECIFICATION, ACCESSIBILITY_AND_I18N, ONBOARDING_TOUR; REMOTION_CAPABILITY_MAP, LOCAL_AI_MODELS, ASSET_INGESTION.
  3. Batch B: BLUEPRINT, TRD, DATABASE_SCHEMA, API_SPECIFICATION; AGENT_DESIGN, SYSTEM_PROMPT.md, MCP_AND_TOOLING, GOLDEN_SCENARIOS; ROADMAP, STAGE_MANAGEMENT, DEVELOPMENT_WORKFLOW, DEFINITION_OF_DONE, QA_PROCESS, TEST_PLAN; SECURITY, THREAT_MODEL, VULNERABILITY_CHECKLIST, DEPLOYMENT_AND_PACKAGING, POC_PLAN.
  4. `AGENTS.md`, `CLAUDE.md`, `.claude/` wiring.
  5. Consistency pass + traceability matrices in `docs/INDEX.md`; Haiku dry-run of the AI workflow.
- **How to continue**: read `memory.md`, this entry, `docs/INDEX.md`; pick the first unfinished task above; write the document using the header table and the glossary; append an entry here; commit.
