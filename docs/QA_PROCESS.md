# QA Process

| Field | Value |
|---|---|
| Status | baseline |
| Owner | QA lead |
| Last updated | 2026-10-25 |
| Depends on | MASTER_PROJECT_PROMPT.md §19; GLOSSARY.md; PRD.md §5, §7; ARCHITECTURE.md §7, §9; AI_WORKFLOW.md §12, §13; PERFORMANCE.md; DESIGN_CATALOGUE.md; UXRD.md §7, §8; ASSESSMENT.md §1; DEFINITION_OF_DONE.md; STAGE_MANAGEMENT.md |
| Used by | TEST_PLAN.md, ROADMAP.md, STAGE_MANAGEMENT.md gates, VULNERABILITY_CHECKLIST.md, GOLDEN_SCENARIOS.md |
| ID range | none (test cases are `QA-` in TEST_PLAN.md; severities are `S1`–`S4`) |

This document defines **how** Expertmotion is tested: levels, environments, matrices, the AI and security testing approach, performance and usability testing, bug handling, regression policy and release sign-off. The individual cases are in `TEST_PLAN.md`.

## 1. Principles

| # | Principle |
|---|---|
| 1 | Every P0 requirement has at least one automated check and one executed `QA-` case in the environment it targets (Windows for Shell, packaging and real renders). |
| 2 | Deterministic layers (Composition Model, intents, Compile, catalogue) are tested exhaustively at unit level because they are the invariant enforcers (AI-001). |
| 3 | LLM behaviour is tested with **fake providers replaying recorded plans** by default; live runs are opt-in, bounded by a budget, and recorded with model id and date. |
| 4 | Preview-to-export parity is measured (pixel diff), not assumed (brief §10). |
| 5 | Nothing is "passed" without an execution record (DEVELOPMENT_WORKFLOW.md §12). |
| 6 | QA on the shared Linux server respects the memory cap and records peak memory (DEFINITION_OF_DONE.md D-ALL-2). |

## 2. Test pyramid

| Level | What | Tooling | Where it runs | Target volume and speed | Owner |
|---|---|---|---|---|---|
| **Unit** | `packages/composition-model` (`applyOps` per op, `validate` invariants, `deriveTiming`, hashing, `migrateModel`); `packages/agents/intents` (Target Resolution rows, Property Class reducer, supersede/restore, Locked Keys, Compile row per P0 preset, Rewrite envelope); catalogue registry (ids unique, params schemas parse defaults, flags, labels EN/ID present); `packages/shared` (formats pixel table, `fitText`, redaction, egress gate) | Vitest | Linux (capped) and Windows | hundreds of cases; < 60 s total | implementation agent |
| **Integration** | Service API with **fake Engine** (`FakeRenderAdapter`: scripted progress, failure, cancel) and **fake provider** (`FakeProviderAdapter`: recorded responses, injected errors 429/timeout/invalid JSON); encrypted in-memory DB; migrations; ingest with 2 s fixtures; SSE event sequences; auth middleware; egress gate in Private Mode | Vitest + supertest | Linux (capped) and Windows | ~150 cases; < 3 min | implementation agent |
| **Engine golden frames** | `renderStill` of each P0 preset at fixed frames (first, mid, last of the effect) in all 7 ratios, compared to committed baselines; **parity**: Player screenshot vs `renderStill` at the same frame; threshold **pixel diff ≤ 1 %** (pixelmatch, threshold 0.1, anti-aliasing ignored) | `scripts/golden-frames.ts`, Playwright for Player screenshots | Linux at 50 % scale, concurrency 1, ≤ 720p baselines; Windows full scale | P0: 44 presets × 7 ratios × 3 frames ≈ 900 stills; Windows nightly or per engine PR | engine owner |
| **E2E** | Playwright against the Editor + Service in browser mode (both OSes) and Electron mode (Windows): user flows F1–F8, Intent Queue, Plan Card, Execute, Export dialog, recovery dialog, Private Mode banner | Playwright | Linux via tunnel; Windows | ~40 specs; < 15 min | QA |
| **Packaging** | Signed installer on **clean Windows 10 and 11 VMs** without dev tools: install, first run, core workflow, update, uninstall, data retention | manual script (TEST_PLAN.md §2), snapshot VMs | Windows | per release and per Stage 2/3/7 gate | Operator/QA |

## 3. Environments

| Environment | Role | Constraints and rules |
|---|---|---|
| **Linux dev server** (`/home/andre/expertmotion`, Ubuntu 24.04, 1.9 GB RAM, 2 CPUs, no display, shared tenant) | headless unit, integration, agent evals, reduced golden frames, browser-mode e2e via SSH tunnel | run under `systemd-run` cap (soft 900 MB, hard 1.2 GB, swap 256 MB), render concurrency 1, one job at a time, ≤ 720p, ≤ 5 s; record `memory.current` peak; ports 4110/4120 only; never Electron |
| **Windows reference laptop (T0)** | budget reference (PERFORMANCE.md §5), Electron-mode e2e, full golden frames, render matrix T0 rows, usability sessions | Windows 11, i5 8th gen or newer / Ryzen 5, 16 GB RAM, integrated GPU, SSD; Hardware Monitor must report T0 |
| **Windows T2 desktop** (optional) | Turbo/NVENC rows, `webgpu` presets, 2K/4K rows | ≥ 8 GB VRAM NVIDIA driver ≥ 525 |
| **Clean Windows VMs** | packaging tests | fresh Windows 10 22H2 and Windows 11 images, no Node/Python/VC++ redistributables beyond the OS default, snapshot restored before each run, network on/off switchable for Private Mode tests |
| **Minimum-spec VM** | PRD §6 minimum (Windows 10, 8 GB RAM, 5 GB free) | startup warning rows, EM-3101 memory block, Standard profile only |
| **CI (later)** | Windows runner for `verify`, e2e, golden frames on PR | optional from Stage 3; until then the Operator's machine is the CI |

## 4. Device matrix

| Row | OS | RAM | GPU / Tier | Display | Used for |
|---|---|---|---|---|---|
| D1 | Windows 11 23H2+ | 16 GB | integrated / T0 | 1920×1080 150 % scaling | reference laptop; everything |
| D2 | Windows 10 22H2 | 8 GB | none / T0 | 1366×768 100 % | minimum spec; packaging; low-memory paths; layout at 1280×720 window (UX-050) |
| D3 | Windows 11 | 32 GB | NVIDIA ≥ 8 GB / T2 | 2560×1440 | Turbo, NVENC, webgpu, 4K rows |
| D4 | Windows 11 | 16 GB | NVIDIA 4–6 GB / T1 | 1920×1080 | Accelerated, 2K, `angle` effects |
| D5 | Windows 11 VM | 8 GB | virtual / T0 | 1280×720 | clean install, uninstall, update |
| D6 | Linux dev server | 1.9 GB | none | headless | unit/integration only (not a product target) |

D1, D2 (as VM) and D5 are mandatory for v1.0; D3/D4 rows are marked "not run" in the release record if the hardware is unavailable, and the release notes say which profiles were not verified.

## 5. Render matrix

Full space: 7 Aspect Ratios × 4 Resolutions × 5 frame rates = 140 Output Profiles, × 3 Performance Profiles (licensed only: there is no Trial Mode). Sampled per release:

| Set | Rows | Content | Checks |
|---|---|---|---|
| **A: pixel table** (28) | every ratio × every resolution at 30 fps, Standard, licensed | 3 clips, 2 transitions (`fade`, `slide`), caption `box`, title text, audio bed; 10 s | ffprobe width×height equals PERFORMANCE.md §3; even dimensions; fps 30; duration = Σ clips − Σ transitions ± 1 frame; audio stream present; first/last frame not black; file plays in Windows Media Player and VLC |
| **B: frame rates** (5) | 16:9 1080p at 24/25/30/50/60; 9:16 1080p at 30/60 | same content | ffprobe `r_frame_rate`; frame count = round(ms × fps / 1000); captions aligned to the same ms; audio sync (clap test: visual flash vs audio spike within 1 frame) |
| **C: profiles** (6) | 16:9 1080p30 and 9:16 1080p30 × Standard / Accelerated / Turbo | 30 s PERFORMANCE.md §5 workload | output identical in dimensions/duration across profiles (md5 of frame-decoded stills within diff ≤ 1 %); time and peak RAM recorded against budgets; Turbo on T1 shows the warning |
| **D: edge** (8) | Custom 1:3 and 3:1 at 720p; Custom near-odd dimension (round-to-even); 4K on T0 disabled with reason; 2K on T1; alpha export (WebM + `background.none`); GIF; PNG still; unlicensed `POST /renders` → 403 EM-5010 | — | per TEST_PLAN.md §11–12 |
| **E: durations** (4) | 1 s minimum; 30 min maximum (Standard, T0, 720p to bound time); 0.9 s and 30:01 rejected | colour bars | EM-3104 for rejects; the 30 min run records time and RAM (may be nightly) |

Set A+B+D run per release; set C per release on D1 (and D3 when available); set E 30-min row at least once per minor.

## 6. AI workflow testing

| Aspect (brief §19) | Approach | Fixtures / tooling | Pass criterion |
|---|---|---|---|
| Structured-output validation | every provider response parsed with Zod; invalid responses recorded as fixtures (truncated JSON, wrong enum, extra op, missing `baseVersion`) | `FakeProviderAdapter` with `respondWith([...])`; 20 golden scenarios (GS-01…GS-20) with recorded valid plans | 100 % of invalid fixtures rejected; valid plans accepted; retries ≤ 2 then `EM-4301` |
| Ambiguous requests | scenarios where Target Resolution cannot settle (no selection, no playhead clip) and vague chat ("make it better") | GS group "ambiguous"; fake brainstorm transcripts | `EM-2201` or a clarifying question; never a guess that mutates |
| Invalid plans | ops outside the vocabulary; args out of range; > 200 ops; `dependsOn` cycles; targets that do not exist | recorded fixtures | plan `invalid` with `validation[]`; Execute disabled |
| Unsupported operations | op names not in the registry; presets flagged `licence:paid`, `webgpu` on T0, `model:*` not installed | capability flags in envelope | rejected with reason; agent re-prompted once; then dropped with notice |
| Conflicts | duplicate `setTrim`, transition longer than 50 % of the shorter clip, `clip.remove` with dependent intents, Locked Key touched, stale `baseVersion` | AI_WORKFLOW.md §6 matrix as a table-driven test | behaviour exactly as the matrix row |
| Retries | provider timeout (30 s / 120 s), 429 with `Retry-After`, 5xx | fake adapter with injected faults and a fake clock | one retry/backoff as specified; ops never re-executed on retry (idempotent `planId`) |
| Cancellation | Creator cancels during streaming; Service restart mid-run | abort signal; integration test kills the runner | run `cancelled`; partial plan discarded; composer re-enabled; usage recorded for tokens consumed |
| Provider errors | invalid key (401), quota (402/403), model removed (404), malformed SSE | fake HTTP layer | `EM-41xx`/`EM-43xx` with Try again / Switch model actions; key stays encrypted; nothing logged in clear |
| Recovery | plan `valid` survives restart; interrupted run labelled; Execute after restart with unchanged head succeeds, with changed head → stale | integration | per AI_WORKFLOW.md §12 |
| Live runs (optional) | `npm run eval:agents --live --model <id>` on ≤ 3 models (one Haiku-class, one mid-tier, one strong) | OpenRouter test key ≤ US$5 | mid-tier ≥ 90 % first-attempt validity (PRD §5); results table in GOLDEN_SCENARIOS.md with date; a drop > 10 points opens an S3 bug |
| Mutation audit | the whole integration suite asserts that every `composition_versions` row has `cause ∈ {execute, compile, insert, undo, redo, system}` and a matching plan or intent | DB assertion in `afterAll` | 0 unvalidated mutations (AI_WORKFLOW.md §13) |

Private Mode: the egress module is the single chokepoint; a test enables Private Mode and asserts that every outbound function throws `EM-4xxx`/Private Mode notice without touching the network; on Windows a packet capture (or Windows Firewall logging) during a 10-minute scripted session confirms zero outbound connections (PRD-020).

## 7. Security testing

Security requirements are owned by SECURITY.md (SEC- groups); the per-release checklist is VULNERABILITY_CHECKLIST.md. QA executes the following groups every release and whenever the touched area changes.

| Group (brief §19) | Tests | Tooling |
|---|---|---|
| Local API authorization | no token → 401; wrong token → 401; token in query on non-SSE route → 401; valid token with wrong `Origin`/`Host` → 403; token rotates per launch; token not in argv/env of the Service process (inspect process listing) | supertest; Windows Process Explorer |
| File access | `/media/:assetId` with path traversal id → 404; import of a path outside the allowed dialogs (symlink/junction to `C:\Windows`) → rejected; output folder outside user-writable paths → EM; no route accepts raw paths from the Editor except through Shell dialogs | integration; manual |
| Credential handling | provider key stored encrypted (DB dump shows ciphertext); never in logs (redaction test on 50 synthetic log lines); never in diagnostics zip; Database Key absent from disk in clear (search app data for the key bytes); DPAPI unavailable → startup refuses with EM and guidance | integration; manual on Windows |
| Malicious asset inputs | zip-bomb-like huge dimensions, 0-byte, truncated MP4, polyglot (PNG with HTML), wrong extension, file name with control characters and `..`, 10 GB file, SRT with 100k cues and HTML tags | fixtures; ingest tests | rejected or sanitised with EM-1xxx; no crash; no path written outside the asset folder |
| Request forgery | HTML page on another origin attempting `fetch` to the Service port with and without credentials; DNS-rebinding style `Host` header; WebSocket/SSE from foreign origin | Playwright page served from `http://localhost:9999` | all blocked by Origin/Host checks and the bearer requirement (no cookies) |
| Unsafe execution paths | registry test: no tool executes shell/fs/network from model input (AI-020); fuzz op args with strings containing `$(…)`, `;`, `..\\`, `file://`; engine process adapter rejects arguments not from the allow-list; no `eval`/`new Function` in production bundles (grep) | unit; bundle grep |
| Dependency integrity | `npm ci` lockfile check; `audit:deps` clean at high/critical; SHA-256 of Chrome Headless Shell, FFmpeg, engine binaries verified at build and first run; tampered binary → refuses to start render with EM-3001 | script |
| Production artifact exposure | installer contents: no `.map` files, no `.env`, no test fixtures, no prompts in clear (encrypted assets), bytecode only in licence/prompt modules; fuses verified with `@electron/fuses` check; `--inspect` disabled; ASAR integrity on; DevTools disabled in production | script over the unpacked installer |
| Licence | tampered token, wrong fingerprint, expired update eligibility, revoked key, clock set back | unit + manual |

Findings are bugs with severity per §10; S1/S2 security findings block release.

## 8. Performance testing

| Budget (PERFORMANCE.md §5) | Method | Environment | Frequency |
|---|---|---|---|
| Cold start ≤ 5 s to interactive Editor | stopwatch from double-click to `stage.player.frame` visible, 5 runs, median | D1 | each stage from 3; release |
| Player seek ≤ 100 ms (Draft) | Playwright measures `seeked` event latency over 20 seeks | D1 | release; engine PRs |
| Catalogue hover → live preview ≤ 300 ms | Playwright timestamp from hover to Player prop update | D1 | release |
| Ingest 1 min 1080p30 ≤ 20 s | scripted import; SSE `ingest.done` timestamp | D1 | release |
| Render 30 s 1080p30 Standard ≤ 90 s | matrix set C | D1 | release |
| Turbo on T2 ≤ 30 s | matrix set C | D3 | when available |
| Idle RAM ≤ 450 MB | sum of Shell + Service + Editor private bytes after 2 min idle | D1 | release |
| Peak RAM ≤ 40 % total during Standard render | Hardware Monitor log + Task Manager | D1, D2 | release |
| Installer ≤ 450 MB; app data baseline ≤ 200 MB; loops ≤ 40 MB | file sizes | build | each build |
| Monitoring overhead < 1 % CPU, < 20 MB | compare with monitor disabled | D1 | once per minor |
| Shared server budget | cgroup `memory.current` peak ≤ 900 MB during the full test suite | D6 | every run |

Targets marked "to confirm" in PERFORMANCE.md are re-baselined after Stage 2 (POC) with evidence; a regression > 20 % against a confirmed budget is an S2 bug.

## 9. Usability testing

| Item | Rule |
|---|---|
| Participants | 5 per round matching persona Septi (UXRD §1.1); rounds per UXRD §7/§8 (round 1 prototype in Stage 2, round 2 Stage 4, round 3 Stage 5, round 4 Stage 6, round 5 Stage 7 release measurement) |
| Protocol | moderated, think-aloud, 45 min, provided assets (3 clips, 1 music, 1 SRT); tasks: first export (UX-001), find Insert (UX-002), explain Execute (UX-003), classify states (UX-012), explain "≈" cost (UX-020), recover after forced kill (UX-030) |
| Metrics | time to first export (median ≤ 10 min, none > 15 min), task success, SUS score (target ≥ 70), error count, quotes |
| Output | report in `reports/ut-round-<n>.md` with findings mapped to UX- ids and bugs filed (usability bugs default S3; S2 if ≥ 3 of 5 fail a P0 task) |
| Privacy | no recordings of faces without consent; no personal data in the report; recordings deleted after the stage |

## 10. Bug severity and triage SLA

| Severity | Definition | Examples | Response (with one developer) | Release rule |
|---|---|---|---|---|
| **S1 Critical** | data loss, security breach, crash on launch, corrupt export silently passed as success, licence bypass | DB unreadable after update; key logged in clear; export with wrong duration marked `done` | acknowledge same day; fix via hotfix path before any other work | blocks release; triggers hotfix |
| **S2 Major** | P0 workflow blocked with no workaround; budget regression > 20 %; S1-class issue with a workaround | Insert fails for MOV; Execute always stale; render fails on T0 Standard | fix within the current stage before exit | blocks release |
| **S3 Minor** | wrong behaviour with workaround; UI defect; wrong copy; non-P0 feature broken | tooltip missing; superseded item not struck through; GIF export fails | fix within the current or next stage | may ship, listed in known limitations |
| **S4 Trivial** | cosmetic; log noise; docs typo | — | batch | may ship |

Triage happens at every checkpoint review (STAGE_MANAGEMENT.md §3). Every bug record has: id, title, severity, environment (device row, build hash), steps, expected vs actual, evidence (log, screenshot), traced `QA-`/`FR-` id, owner, target stage. Bugs are tracked as GitHub issues (or `reports/bugs.md` until the repository is hosted), never only in chat.

## 11. Regression policy

| Rule | Detail |
|---|---|
| Every fixed bug leaves a test | DEFINITION_OF_DONE.md D-BUG-1/3 |
| Per PR | `verify` (unit + integration) and the e2e specs for touched flows; golden frames when `packages/engine` changed |
| Per stage exit | full automated suite on Linux and Windows; all `QA-` cases tagged for the stage and all P0 cases from earlier stages (cumulative regression); render matrix sets A sample (7 rows: one per ratio at 1080p30) |
| Per release | entire TEST_PLAN.md P0 and P1 cases; matrix sets A, B, D (and C on D1); packaging on D5 (Win10 and Win11); security §7; performance §8 |
| Per dependency bump | Remotion: golden frames + matrix A sample; Electron: fuses, bytecode, packaging smoke; native modules: `install-app-deps` + DB tests on Windows; provider SDK: `eval:agents` fake + one live |
| Baseline updates | golden baselines change only with `--update`, image review in the PR, and a note on why rendering changed |
| Flaky tests | quarantined with an issue within the day; a quarantined test cannot stay through a stage exit |

## 12. Release sign-off

The release QA record (`reports/release-x.y.z/qa-signoff.md`) contains:

| Section | Content | Must show |
|---|---|---|
| Build | version, commit, installer SHA-256, signing status | signed |
| Automated | `verify`, e2e (browser + Electron), golden frames, `eval:agents` fake (+ live table) outputs with counts | all green; live ≥ 90 % mid-tier |
| Manual QA | TEST_PLAN.md execution table: every P0/P1 `QA-` with pass/fail/blocked/not-run, tester, device row | 100 % P0 pass; P1 failures ≤ S3 |
| Render matrix | sets A, B, D results; C on D1; rows not run named | all run rows pass |
| Security | VULNERABILITY_CHECKLIST.md completed; §7 groups executed | no S1/S2 |
| Performance | §8 table with measured values vs budgets | within budget or waiver |
| Packaging | D5 Win10 and Win11 clean-VM runs; update path; uninstall | pass |
| Usability | round 5 report (v1.0) or "not required" for minors | UX-001 met |
| Accessibility | keyboard-only F1–F8; contrast report (axe/Lighthouse) | no critical |
| Open bugs | list by severity | 0 × S1/S2 |
| Known limitations | copied to About and release notes | present |
| Sign-off | `QA sign-off vX.Y.Z by <name> on <date>` and the Operator's release approval line (STAGE_MANAGEMENT.md R13) | both present |

## 13. Change log

| Date | Change |
|---|---|
| 2026-10-24 | First baseline. |
