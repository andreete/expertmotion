# process.md — execution log

Append an entry after every meaningful work unit. Newest entry first. Each entry records: stage, objectives, completed tasks, files created or modified, verification performed with actual results, blockers, failed approaches and lessons, pending decisions, next actionable tasks, and how to continue.

## Current state (keep this block up to date)

- **Current stage**: Stage 2 (technical proof of concept) **started 2026-10-24** on the Operator's instruction; Linux-runnable proofs done (POC-010 pass at curl level, POC-005 DB half pass, POC-004 offline half pass). The Windows proofs (POC-001/002/003/006/007/009, 008 performance, 005 steps 3–4) are **not run**: they need a Windows machine or CI (`poc/WINDOWS_RUNBOOK.md`).
- **Current objective**: finish Stage 2 on Windows; run POC-004 live with a provider key; run POC-010 with a real browser. Stage 2 exit criteria: `docs/STAGE_MANAGEMENT.md`, `docs/POC_PLAN.md` §1.
- **Blockers**: (1) Windows machine/CI access for the Electron proofs; (2) an OpenRouter test key (kept outside the repo) for POC-004 live; (3) a laptop browser for the POC-010 attacker page. Provisional ADRs 008/009/016 are treated as accepted until the Operator says otherwise (AGENTS.md rule 12). Remotion licence confirmation (BRD-010) is a launch blocker, not a Stage 2 blocker.
- **Next actionable tasks**: see Entry 3 below.

---

## 2026-10-24 — Entry 3: Stage 2 started; Linux-side proofs executed

- **Stage**: 2 (technical proof of concept).
- **Objectives**: execute the POCs that can run on the shared Linux server inside the memory cap; prepare everything else for a Windows run; record real results.
- **Completed**:
  - `poc/` scaffold: `README.md`, `run-capped.sh` (systemd user scope, soft 900 MB / hard 1.2 GB / swap 256 MB, Node heap 512 MB).
  - **POC-010** (`poc/010/server.mjs`, `test.mjs`): auth/Host/Origin guard per SEC-004…016.
  - **POC-005 Linux part** (`poc/005/db.mjs`, `service.mjs`, `test.mjs`): encrypted SQLite, WAL, kill -9 scenarios, recovery ladder.
  - **POC-004 offline half** (`poc/004/schemas.mjs`, `validate.mjs`, `fixtures.mjs`, `run.mjs`): validator reading the op and preset vocabularies from the docs, retry loop, Locked Key mutation test; live path written but not run.
  - `poc/WINDOWS_RUNBOOK.md` for everything that needs Windows.
- **Verification performed (actual results, all inside `run-capped.sh`)**:
  - POC-010: `node test.mjs` → **44/44 passed on 3 consecutive runs** (a first run had 1 failure: my timing benchmark was run sequentially and flagged a 1.165 ratio; fixed by interleaving 15 rounds and comparing medians, thresholds 1.05 position / 1.10 length unchanged in spirit; observed ratios 1.002–1.048 and 1.014–1.055).
  - POC-005: `node test.mjs` → **69/69 passed over 3 runs**. Restart-to-ready 7 ms; checkpoint age at kill 3.0 s; `integrity_check` ok after every kill; no "database is locked".
  - POC-004: `node run.mjs` → **offline 19/19 passed**; live half **not run** (no key).
  - `bash tools/docs-check.sh` → all rules PASS after the doc edits below.
- **Not verified / not run**: POC-001, 002, 003, 006, 007, 009 (Windows only); POC-008 (Windows binary, T0 timing); POC-005 steps 3–4 (real render and Chrome kill); POC-010 with a real browser attacker page (server has no browser or display; the curl matrix simulates the headers a browser sends); POC-004 live. The `sqlite3` CLI is not installed here, so "stock sqlite3 cannot read the file" was covered by opening without a key (SQLITE_NOTADB) instead.
- **Findings and doc changes made** (same commit): SEC-011 refined (lock applies to wrong-token requests only; valid tokens never limited; missing tokens not counted; reason: a web page cannot send a wrong `Authorization` header without a preflight, but it can send 21 token-less requests and would otherwise lock the Editor out); NFR-020 amended (autosave is a debounce: 2 s after last edit, ≤ 5 s while dirty, plus before Execute/render; a fixed 10 s timer only meets the 10 s limit at its boundary); `docs/POC_PLAN.md` §4 result log filled.
- **Failed approaches / lessons**: a sequential in-process timing test is too noisy to assert 5 % differences; interleave rounds and use medians. `better-sqlite3` is synchronous, so the "crash mid-transaction" hook is a synchronous sleep after writing 100 ops (printed `inTx` marker), not an `await`.
- **Pending decisions (Operator)**: unchanged (ADR-008/009/016, BRD-010, price, ratios, ASM-016). New: provide an OpenRouter test key path and two model ids (one tool-capable, one without tools) for POC-004 live (budget guard US$1 in the runner).
- **Next tasks**:
  1. Windows machine/CI: follow `poc/WINDOWS_RUNBOOK.md` in the order POC-001 → 003 → 002 → 007 → 006 → 005 (steps 3–4) → 009 → 008; log each in `docs/POC_PLAN.md` §4 and here.
  2. Laptop with a browser: run `poc/010` server and an attacker page from `http://localhost:8000` and `file://`; confirm the curl-level results.
  3. With a key: `EM_OPENROUTER_KEY_FILE=… EM_MODEL_TOOLS=… EM_MODEL_JSON=… node poc/004/run.mjs`; compare with POC-004 thresholds.
  4. If Stage 2 exit criteria pass: Stage 3 per `docs/ROADMAP.md` (start with the P0 vertical slice in `docs/BLUEPRINT.md`). Do not start Stage 3 before POC-001/002/003/006 pass.
- **How to continue**: read `AGENTS.md`, this file, `memory.md`, `docs/POC_PLAN.md` §4. Keep `bash tools/docs-check.sh` green. On the Linux server run only through `bash poc/run-capped.sh …`.

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
