# process.md — execution log

Append an entry after every meaningful work unit. Newest entry first. Each entry records: stage, objectives, completed tasks, files created or modified, verification performed with actual results, blockers, failed approaches and lessons, pending decisions, next actionable tasks, and how to continue.

## Current state (keep this block up to date)

- **Current stage**: Stage 3 (foundation, P0 code). Core flow works end to end on Linux, but the FR audit (Entry 7) found 53/178 FRs fully done, 114 partial, 9 missing; the Windows-only proofs and the installer build are the Operator's next step ("pengetesan di windows secara manual di belakang").
- **Verified here**: `bash scripts/verify.sh` → typecheck of all workspaces clean, **610 tests passed** (1 opt-in render smoke skipped by default, run separately and passing), docs-check green; `poc/e2e/run.mjs` → **18/18** (real Editor in headless Chrome against the real service: import, ingest, Insert, Fade pick via Compile, playback through the cut, 720p export).
- **Blockers (all need the Operator)**: Windows machine for the installer and Electron runtime checks (`poc/WINDOWS_RUNBOOK.md` §6); a provider key for live agent runs; pinned model hashes (`packages/models` registry, SEC-074) before any model can install; the production licence public key (`tools/license-cli keygen --kid A1 --seal`, paste into `apps/service/src/license/keys.ts`); the real storefront host (`EXTERNAL_HOSTS`, `VITE_EM_STORE_URL`); Remotion licence answer (BRD-010); legal review of the compositor FFmpeg (RISK-030); OV code-signing certificate.
- **Windows test build**: portable ZIP produced on this server (Entry 6); not yet run on Windows.
- **Next actionable tasks**: see Entry 6, then Entry 5.

---

## 2026-10-24 — Entry 7b: partial FRs closed (FR-090/097, FR-085, FR-021, FR-143, FR-038, FR-042, FR-115 doc)

- **Stage**: 3.
- **Completed**: FR-090/FR-097 Performance Profile is a zero-op settings intent (`output.kind:'performanceProfile'`, key `project.performanceProfile`; agents `settingsPatchOf`, Compile emits no op; the Service applies it to Settings and records it `executed` with `params.__previous`; Undo = Restore of the replaced pick, else re-pick); FR-085 intents carry `appliedHash`, the Editor line shows the short hash; FR-021 engine `textLayerFit`/`layoutFor` (shared with the renderer) drive `lib.text.size.overflow`; FR-143 migration 20 `render_jobs.failed_frame` (renderer error frame, else last progress; recovery copies `rendered_frames`), `render.failed.frame`, `scr.export.failed.frame`; FR-038 fixture test (P0 gpu preset: badge, pick works, EM-2103 once); FR-042 filmstrip test with a mocked FFmpeg runner; FR-115 FRD aligned to AGD-004 (refuse no-JSON-output models; code unchanged).
- **Docs**: FRD FR-090/FR-115, AI_WORKFLOW §3/§4, API_SPECIFICATION R-060/RenderJobDto/`render.failed`, DATABASE_SCHEMA §3/§5.1, ELEMENT_IDS, ADR-024 note.
- **Verification**: `bash scripts/verify.sh` → typecheck clean, 754 tests passed (1 skipped), docs-check PASS.
- **Not done / notes**: global Undo (Ctrl+Z) still walks Composition Versions only; the profile's Undo is the toast action / queue Restore. Profile stays an app setting (`defaultPerformanceProfile`), not per-project.

## 2026-10-24 — Entry 7: FR gap audit (read-only, 4 parallel auditors)

FRD has FR-001…FR-178 (not 204; docs-check counts other "FR-" mentions). Static code reading against each row:

| Range | DONE | PARTIAL | MISSING | Blocked / Windows-only |
|---|---|---|---|---|
| FR-001…054 (lifecycle, File, Home, Catalogue, Assets) | 13 | 39 | 2 | (001/002 also need Windows) |
| FR-055…108 (Stage, Agent Panel, Output Settings, Tools) | 19 | 35 | 1 (P1) | 0 |
| FR-109…155 (Providers, Model Manager, Hardware, Licence, Export, Help) | 8 | 31 | 5 | 3 |
| FR-156…178 (Private Mode, persistence) | 13 | 9 | 1 | 0 |
| **Total 178** | **53** | **114** | **9** | **3** |

The earlier "P0 code-complete" claim was wrong: the core flow works end to end, but most FRs miss details from their acceptance criteria.

**Real bugs (fix first)**: FR-013 Save As creates a blank project; FR-088 Auto ratio can never be re-enabled (UI reads model.settings, service writes settings_json); FR-015 duration policy never saved; FR-029/030 Insert Image/Video only import; FR-116 Providers "Test" is fake; FR-118 Validate saves the connection; FR-148 Documentation link is rejected by the https-only allow-list; FR-174 no Save/Don't save/Cancel prompt; FR-002 shell ignores EM-8304 on close during render; FR-128 low-disk event never emitted; FR-152 24 h update check never scheduled.

**Missing P0**: FR-048 missing-media state/Locate/hash check; FR-054 asset filter by search; FR-116 provider test probe; FR-121/122/126 model card, filters, disk footer; FR-130 workload list with Cancel; FR-174 unsaved-changes prompt. Also FR-075 no streaming (`agent.run.delta` never emitted), Brainstorming Agent has no read-only tools. SEC-072 signed model manifest missing.

**Blocked on Operator**: FR-124 model hashes, FR-131 licence public key, FR-152 feed URL/publisher.

Full per-row tables: the four audit reports summarised here (re-run the audit with Explore agents per FR range if needed).

---

## 2026-10-24 — Entry 6b: AI prompts encrypted in release builds

- `npm run build:release -w @expertmotion/service` stubs `prompts.generated` with empty strings, writes `dist/assets.enc` (AES-256-GCM of the prompt set) and `dist/prompt-half-b.hex`; half A is a build constant in `service.cjs`, half B a build constant in `main.cjs` sent in the bootstrap message (`promptKeyHalf`); key = sha256(A xor B) (`apps/service/src/services/prompt-assets.ts`, same derivation as `apps/desktop/src/lib/keysplit.ts`). The service decrypts before boot and installs the set (`installPromptSet` in `packages/agents/src/prompt-store.ts`); a missing or altered file or half fails with EM-8007. `harden` verifies no prompt text remains in `service.cjs`, `main.cjs` carries this build's half B, and `assets.enc` is in the signed integrity manifest. `release:win` and `cross-build-win.sh` run the release service build. Development builds are unchanged (prompts bundled).
- Verified: 615 tests passed (5 new), typecheck clean; the built `assets.enc` decrypts with the half A found in `service.cjs` plus half B, and `service.cjs` contains no prompt text. Honest limit: both halves are on the user's machine (as bytecode in the Windows build), so a determined owner can still recover the prompts; this raises the cost, it does not prevent it.

---

## 2026-10-24 — Entry 6: Windows test build produced on the Linux server

- **Stage**: 3.
- **Completed**:
  - `scripts/cross-build-win.sh` + `stage-desktop.mjs --platform=win32`: Windows build from Linux with Chrome Headless Shell 157.0.8080.0 win64, `@remotion/compositor-win32-x64-msvc@4.0.535`, FFmpeg n8.1 LGPL shared (BtbN). Inputs and a **test** Ed25519 release key live in `~/em-win-deps` (outside git; `SHA256SUMS` there). Runbook §7.
  - Output: `release/0.0.0/Expertmotion-0.0.0-win-x64-portable.zip` (393 MB, copy in `~/`), unzip and run `Expertmotion.exe`. The NSIS `Setup.exe` was **not** produced: electron-builder needs `wine` for the uninstaller and wine was not allowed on this server; build the installer on Windows (`npm run release:win`).
  - Startup integrity check wired in the Shell (`checkIntegrity` in `apps/desktop/src/main.ts`, new **EM-8007**): it was signed at build time but never verified before. Replayed against the built tree: 12/12 entries match, signature valid, key embedded in `main.cjs`.
- **Bugs found (fixed)**: `electron-builder.config.cjs` exported `default`/helpers on the config object (circular JSON, the Windows build would have failed too); helpers moved to `apps/desktop/build/fuses.cjs`. Five shape presets (rect, star, arrow, pie, polygon) compiled shape-specific keys at the top level of `op:shape.add` and were rejected (EM-2102); now in `params` (catalogue + `intents.ts` hoists size/fill/stroke/strokeWidth), plus a test that every preset's compiled args pass its op schema. Obfuscating the 5.6 MB Engine chunk ran out of memory here; `EM_OBFUSCATE_MAX_BYTES` (default 2.5 MB in the cross-build only) skips the two largest Engine chunks.
- **Verification**: `bash scripts/verify.sh` → typecheck clean, **610 passed**, docs-check green; catalogue loops 83 rendered, 0 failed.
- **Known gaps (honest)**: test build has no V8 bytecode (bytenode needs Windows) and is unsigned (SmartScreen warning); the two largest Engine chunks are not obfuscated in it; prompt encryption is now wired (see Entry 6b). Electron runtime still unverified until the Operator runs the ZIP on Windows.
- **Next tasks**: Operator runs the ZIP on Windows 10/11 (runbook §6 step 9 checks) and reports errors from `%APPDATA%\Expertmotion\logs\shell.log` and `service.log`; then the Windows `release:win` build for the real installer.

---

## 2026-10-24 — Entry 5: integration, end-to-end run, gap closing

- **Stage**: 3.
- **Completed** (commits on `main` after Entry 4):
  - Service modules S1 (projects, composition, undo/redo, autosave/checkpoints, crash recovery, backup/restore, Intent Queue, plans, Execute with rollback), S2 (assets/ingest, media with grants and Range, render queue, catalogue, generators, Model Manager routes), S3 (providers OpenRouter/OpenAI/Anthropic/Gemini with encrypted keys, assignments, budgets, conversations and agent runs, brainstorm handoff, usage, settings, hardware, licence routes, diagnostics, shutdown, events) integrated through `ctx.hooks`.
  - Editor UI (`apps/ui`): all regions, mock mode, EN/ID i18n, onboarding tour on the real Editor with the Sample Project, resizable panels, preset parameter popover, executed-pick grouping, deterministic generator Insert.
  - New contract pieces: R-025 Sample Project ("Kafe Senja", engine-rendered CC0 media via `packages/engine/scripts/build-sample.mjs`), R-134 insert a finished generator result, `op:overlay.addImage`/`op:overlay.remove` (ADR-020 addition), `EditIntent.appliedVersion`, migrations 10/11/30 (ADR-024), `/media` CORS exception for the Player and render origins, root-mounted media routes, EM-1011, EM-7109, EM-7110.
  - Build: `scripts/stage-desktop.mjs`, `npm run build:all` / `release:win`, `build-loops.mjs` (catalogue previews at `resources/catalogue/<category>/<name>.webm`, served with the Editor), desktop window minimum 1280×720 with remembered bounds.
- **Bugs found by running things for real (fixed)**: Remotion auto-picked port 3001 and its render page fetched media cross-origin (pinned ports 4130 dev / 47600–47699, per-job CORS origins); `os.freemem()` under-reported on Linux so renders were refused (`services/memory.ts`); Intent Queue rows collapsed and the agent column overlapped; catalogue loops were requested from the service; preload/UI bridge names and picker options disagreed; drag-and-drop would have failed in the packaged app (now `webUtils` paths); restore picker used a wrong extension; lower-third and corner text overflowed the frame; licence `updates-expired` violated the DB CHECK; model error codes clashed with storage codes.
- **Verification**: see Current state. Golden scenarios: harness (a) GS-01…07, 13, 16, 19 and package-level replays GS-08, 09, 10, 17, 18, 20 green.
- **Not verified (needs Windows or keys)**: Electron runtime, NSIS installer, DPAPI keyring, bytenode/obfuscation on the real bundles, NVENC, Windows Machine Fingerprint, live provider calls, real model downloads (unpinned), GPU tiers.
- **Next tasks** (Operator or the next implementation agent):
  1. Windows: `poc/WINDOWS_RUNBOOK.md` §6 (build, loops, sample, stage, harden, pack, clean-VM smoke) and the Stage 2 POCs it lists; record results in `docs/POC_PLAN.md` §4.
  2. Pin model hashes and sizes in `packages/models/src/registry.ts`, then install/run each engine on Windows (whisper.cpp, sherpa-onnx + Piper id, sd.cpp, ACE-Step).
  3. Live agent evaluation `npm run eval:agents` per GOLDEN_SCENARIOS §4.3 with an OpenRouter key.
  4. Golden frames (pixel references) on Windows CI; remaining UI items listed in `apps/ui/README.md` (Brainstorm/Editor inner divider, tour resume offer, light theme, timeline editing which is P1).
- **How to continue**: read `AGENTS.md`, `memory.md`, this entry, `docs/INDEX.md`; run `bash scripts/verify.sh` and `poc/e2e/run.mjs` (see its header) before and after changes; heavy commands only through `bash scripts/run-capped.sh` on the shared server.

## 2026-10-24 — Entry 4: Stage 3 foundation code (packages, service skeleton, licence, desktop, models)

- **Stage**: 3 (foundation), on the Operator's instruction to code everything now and test on Windows later.
- **Completed** (commits on `main`):
  - `packages/shared`, `packages/catalogue` (112 presets as data, Compile table), `packages/composition-model` (schema v1, 41 ops, CM-001…011, timing, diff, hash, migration), `packages/engine` (`ExpertmotionTimeline`, 19 transitions, effects, captions, ducking, watermark, pixel table, bundled fonts, `build:bundle`), `packages/agents` (intents, Target Resolution, Intent Queue, Compile, `validatePlan`, Rewrite envelope, OpenRouter via AI SDK 6, Editor/Brainstorm runners).
  - `apps/service` skeleton: config (dev env / parentPort bootstrap), encrypted DB with migrations bundled as code (`db/migrations/index.ts`; ranges 010–019 S1, 020–029 S2, 030–039 S3), recovery ladder, Host/Origin + Bearer guards, `route()` helper with Zod → EM-9002, SSE bus with replay, media grants, egress allow-list, settings store, redacting logger, module system (`src/modules/*`, static list), cross-module `ctx.hooks`, `boot.ts`, `main.ts`, esbuild bundle script.
  - Licence (`apps/service/src/license`, `tools/license-cli`): Ed25519 offline keys, 2-of-3 Machine Fingerprint, revocation list with epochs, clock check, Trial Mode; CLI enforces one key per computer (Machine Code required, rebind revokes the old key, at most 3 rebinds per 12 months). Notes in LICENSE_OPERATIONS "Implementation notes".
  - `packages/models`: registry, pinned resumable downloads, install/verify, engine adapters (whisper.cpp, sherpa-onnx, stable-diffusion.cpp, ACE-Step), SRT/VTT parsing and caption pages (equal to `@remotion/captions` on 7 cases), job runner.
  - `apps/desktop`: Electron main (single instance, safeStorage keyring, utilityProcess supervisor with backoff, app:// with CSP, deny-all permissions, IPC sender checks, updater policy honouring Private Mode), frozen preload bridge, integrity manifest, hardening pipeline (`scripts/harden.mjs`: bytenode main + service on Windows, obfuscation of UI and engine bundles, encrypted prompts, signed manifest), electron-builder NSIS config with maximum compression and fuses.
  - Golden scenarios: `packages/agents/test/golden` (harness (a) GS-01…07, 13, 16, 19; package-level replays GS-08, 09, 10, 17, 18, 20).
- **Verification (actual results, all inside `scripts/run-capped.sh`)**: service skeleton 14/14; licence 62/62 + CLI 15/15; models 85/85; desktop 72/72; golden 21/21; typecheck clean for packages, service and desktop.
- **Findings and doc changes**: RISK-030 + ADR-019 finding (compositor FFmpeg contains libx264 and libfdk_aac); `license.status` gains `updates-expired`; LOCAL_AI_MODELS used EM-600x for model errors (clash with storage codes) → remapped to EM-7xxx, new EM-7109 "not enough memory"; Hugging Face redirect host `cas-bridge.xethub.hf.co` added to SEC-071; GS-13: 2K/4K on T0 are blocked in the Editor, a programmatic pick is stored with CM-010 and export offers 1080p.
- **Failed approaches / lessons**: migrations read from disk break once the service is bundled into one file, so they are TypeScript modules; parallel agents get disjoint files, a pre-allocated migration file each, and hooks in `context.ts` written before they start.
- **In progress (parallel agents)**: Editor UI (`apps/ui`); service modules S1 (projects, composition, checkpoints, backup, intents, plans), S2 (assets, media, renders, catalogue, generators, models), S3 (providers, conversations, usage, settings, hardware, licence routes, diagnostics, events).
- **Next tasks**: integrate the agent results; run the whole suite; build the service bundle and a packaging staging script (service `dist/service.cjs` → `apps/desktop/dist/service/`, UI build → `apps/desktop/dist/ui/`); run a real capped render through the service API on Linux; then the Windows runbook.
- **How to continue**: read `AGENTS.md`, `memory.md`, this entry, `docs/INDEX.md`. Every heavy command through `bash scripts/run-capped.sh`.

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
