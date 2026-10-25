# Stage Management: gates, reviews, branches, versions, releases, hand-over, roles

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Engineering manager |
| Last updated | 2026-10-25 |
| Depends on | MASTER_PROJECT_PROMPT.md §18, §19, §21; GLOSSARY.md; ROADMAP.md; DEFINITION_OF_DONE.md; QA_PROCESS.md; DECISIONS.md; DATABASE_SCHEMA.md §5 |
| Used by | process.md, memory.md, AGENTS.md, CLAUDE.md, HOOKS_AND_GUARDRAILS.md, DEPLOYMENT_AND_PACKAGING.md, LICENSE_OPERATIONS.md |
| ID range | none (gates are `G<stage>`; checklists are numbered within this file) |

`ROADMAP.md` defines the Roadmap Stages; this document defines how a stage is **entered, reviewed, exited and signed off**, how code moves from a branch to a signed release, and how LLM coding agents hand work to one another without losing context.

## 1. Roles and RACI

| Role | Who | Responsibilities |
|---|---|---|
| **Operator** | Andre | Owns scope, priorities and all sign-offs; runs Windows verification; holds signing keys and licence keys; approves releases, hotfixes and rollbacks; confirms provisional ADRs. |
| **Implementation agent** | an LLM coding agent (any provider) working in the repository | Implements stage tasks from `ROADMAP.md` and `FRD.md`; writes tests; updates documentation; writes the `process.md` entry; never signs off its own work. |
| **Review agent** | a second LLM session or model, started fresh with only the repository | Reviews diffs against FR/ADR/DoD; runs the verification commands itself; reports findings; does not modify code except trivial fixes agreed with the Operator. |
| **QA** | the Operator, or an agent executing `TEST_PLAN.md` cases and recording results | Executes the stage's `QA-` cases in the required environment; records actual results; files bugs with severity (QA_PROCESS.md §10). |

| Activity | Operator | Implementation agent | Review agent | QA |
|---|---|---|---|---|
| Open a stage (entry checklist) | A | R | C | I |
| Implement tasks | A | R | I | I |
| Automated tests written and green | A | R | C | I |
| Code review | A | C | R | I |
| Execute `QA-` cases in the required environment | A | C | I | R |
| Windows / clean-VM verification | R/A | I | I | C |
| process.md entry and memory.md update | A | R | C | I |
| Stage exit sign-off | R/A | C | C | C |
| ADR creation | A | R | C | I |
| Release build, signing, publishing | R/A | C | C | C |
| Hotfix decision and rollback | R/A | C | C | C |

R = responsible, A = accountable, C = consulted, I = informed. The Operator is accountable for everything; nothing is "done" until the Operator has seen the evidence.

## 2. Stage gate process

Every Roadmap Stage has an entry gate and an exit gate. Gates are checklists; a gate passes only when every item has **evidence** attached (a file path, a test report, a recording, a `process.md` entry). Verbal or in-chat claims are not evidence (brief §22.14).

### 2.1 Evidence types

| Evidence | Form | Where it lives |
|---|---|---|
| Test results | command output of `npm run verify` / `npm run test:e2e` / eval scripts with date, commit hash and environment | pasted into the `process.md` entry (trimmed), full logs under `reports/<stage>/` (git-ignored except summaries) |
| QA execution record | table of `QA-` ids with pass/fail/blocked and tester, environment, build hash | `reports/<stage>/qa-<date>.md` and summarised in `process.md` |
| Demo recording | screen recording (≤ 5 min) showing the stage's slice increment on the real target (Windows for Stage 2+) | `reports/<stage>/demo-<date>.mp4` (git-ignored; path and hash in `process.md`) |
| `process.md` entry | entry per template §8.1 | `process.md` |
| Measurements | memory, timings, sizes, with the machine and method | PERFORMANCE.md (budgets) and `process.md` |
| Review notes | review agent's findings and their resolution | PR description or `reports/<stage>/review-<date>.md` |

### 2.2 Generic entry checklist (all stages)

| # | Item | Evidence |
|---|---|---|
| E1 | Previous stage exit gate signed off by the Operator | `process.md` entry with "Exit gate G<n-1>: signed" |
| E2 | Documents the stage depends on (ROADMAP.md stage row "Dependencies") are at status `baseline` | INDEX.md status column |
| E3 | Required environment available (ROADMAP.md §3) | one-line statement with machine name, OS, RAM |
| E4 | Stage task list copied into a tracking list (GitHub issues or `reports/<stage>/tasks.md`), each task traced to PRD-/FR- ids | the list |
| E5 | Blockers listed in ROADMAP.md stage row are resolved or explicitly accepted by the Operator | `process.md` "Pending decisions" |
| E6 | `main` is green (`npm run verify`) at the starting commit | command output |

### 2.3 Generic exit checklist (all stages)

| # | Item | Evidence |
|---|---|---|
| X1 | Every task in the stage list is done per `DEFINITION_OF_DONE.md`, or moved to a later stage with a written reason | task list |
| X2 | Stage acceptance criteria (ROADMAP.md) each have a pass with evidence | QA execution record |
| X3 | All `QA-` cases tagged for the stage pass, or each failure has an accepted deviation with a bug id and severity ≤ 3 | QA record; bug list |
| X4 | No open Severity 1 or 2 bugs introduced in the stage | bug list |
| X5 | `npm run verify` green on the Linux dev server **and** on the Windows machine (from Stage 2) | outputs |
| X6 | Slice increment demonstrated on the target environment | demo recording |
| X7 | Documentation updated: affected `docs/*.md`, `DECISIONS.md` for any decision changed, `ERROR_CATALOGUE.md` for new codes, `INDEX.md` statuses | commit list |
| X8 | `process.md` entry written per template; `memory.md` updated (§8.2 rule) | files |
| X9 | Memory budget measured when work ran on the shared server (cgroup `memory.current` peak) and recorded | `process.md` |
| X10 | Operator sign-off line: `Exit gate G<n>: signed by Operator on <date>, commit <hash>` | `process.md` |

### 2.4 Stage-specific gate additions

| Gate | Extra entry items | Extra exit items | Sign-off |
|---|---|---|---|
| G1 (Definition) | — | INDEX.md traceability matrices contain no `pending`; GLOSSARY.md frozen; provisional ADRs confirmed or accepted as provisional in writing | Operator |
| G2 (PoC) | Windows machine with Node 22 ready; OpenRouter test key with ≤ US$5 budget | every `POC-` experiment has a recorded result; slice v0 installer runs on a clean VM; PERFORMANCE.md "to confirm" rows have measured values or revised targets; any changed decision has an ADR | Operator |
| G3 (Foundation) | API_SPECIFICATION.md, DATABASE_SCHEMA.md, ERROR_CATALOGUE.md EM-1xxx/EM-6xxx baseline | kill-and-recover test passes (PRD-003); auth tests pass (SEC- local API group); migration test from empty DB; ingest fixtures for every supported container pass | Operator |
| G4 (Editor MVP) | DESIGN_CATALOGUE.md P0 frozen; REMOTION_CAPABILITY_MAP.md baseline | golden frames for all P0 presets × 7 ratios green; Compile unit test per P0 preset; UT round 2 report or waiver | Operator |
| G5 (AI) | SYSTEM_PROMPT.md v1; GOLDEN_SCENARIOS.md fixtures; test key | GS-01…GS-20 pass on fake provider; live run report; "no unvalidated mutation" test; Private Mode network capture shows zero outbound | Operator |
| G6 (Rendering) | ERROR_CATALOGUE.md EM-3xxx baseline; ≥ 16 GB Windows machine | render matrix sampled rows report; Chrome-kill and cancel tests pass; budgets confirmed | Operator |
| G7 (Release) | OV certificate in hand; Remotion correspondence started; beta participants identified | release checklist §6 complete; PRD §7 criteria 1–5 evidenced | Operator (release approval) |

## 3. Review cadence

| Review | When | Participants | Output |
|---|---|---|---|
| Task review | every PR (feature branch → `main`) | review agent + Operator | approved PR with checklist (DEVELOPMENT_WORKFLOW.md §7) |
| Checkpoint review | at every `process.md` entry (≥ once per work session) | Operator reads the entry | accepted / corrections requested |
| Stage review | at the exit gate | Operator, review agent, QA record | signed exit gate |
| Risk review | at every stage review and whenever a `RISK-` changes likelihood | Operator | RISKS_AND_ASSUMPTIONS.md updated |
| Retrospective | after Stages 2, 4 and 7 | Operator + agent | "Failed approaches and lessons" consolidated in `memory.md` §6 |

With one developer the cadence is event-driven, not calendar-driven: a review happens when its trigger occurs.

## 4. Branch model

| Branch | Purpose | Rules |
|---|---|---|
| `main` | trunk; always releasable in the sense that `npm run verify` is green | protected: no direct pushes after Stage 2; PR + green verification + review required; squash or rebase merge; linear history preferred |
| `feat/<stage>-<short-topic>` | short-lived feature branch (≤ 3 days of work, ≤ ~800 changed lines) | branched from `main`; rebased on `main` before merge; deleted after merge |
| `fix/<issue-id>-<topic>` | bug fix | same rules as `feat/` |
| `docs/<topic>` | documentation-only changes | may skip e2e; still needs link/consistency check |
| `release/x.y` | stabilisation for a minor release | created from `main` when Stage 7 starts (`release/1.0`); only `fix/` merges; tags `vX.Y.Z` are cut from it; fixes are cherry-picked back to `main` the same day |
| `hotfix/x.y.z-<topic>` | urgent fix on a shipped release | branched from the release tag; see §7 |

Agents must not create long-lived personal branches or work on `main` directly. One PR corresponds to one task from the stage list where possible.

## 5. Versioning

| Item | Rule |
|---|---|
| Scheme | SemVer `MAJOR.MINOR.PATCH` for the product (`apps/desktop` package version is the product version; workspaces share it via `npm version --workspaces`). |
| Build metadata | `+<yyyymmdd>.<shortsha>` appended in the About screen, logs, diagnostics zip and installer file name suffix (NSIS artefact name: `Expertmotion-<version>-setup.exe`; metadata in the file's version resource). Build metadata never influences update ordering. |
| Pre-releases | `-poc.N` (Stage 2 artefacts), `-alpha.N` (Stages 3–5 internal), `-beta.N` (Stage 7 beta), `-rc.N` (release candidates). |
| MINOR bump | any P1/P2 feature release (v1.1, v1.2). |
| PATCH bump | hotfixes and fix-only releases. |
| MAJOR bump | Composition Model `schemaVersion` change that is not forward-migratable, or licence tier model change. |
| Schema versions | `schema_migrations.version` (DB) and `CompositionModel.schemaVersion` are independent integers, both listed in the release notes. |
| Prompt versions | `SYSTEM_PROMPT.md` carries its own version per prompt (`editor-agent@3`), recorded in `agent_runs`. |
| Revocation list | `revocations.json` with its own monotonically increasing `listVersion`; shipped with every release and update. |

## 6. Release train and release checklist

A release is cut from `release/x.y` when the Stage 7 exit gate (or, for later minors, the equivalent regression pass) is signed. One release at a time; no parallel release branches.

| # | Step | Evidence |
|---|---|---|
| R1 | `release/x.y` frozen: only `fix/` merges for 48 h with no Severity 1/2 bugs | bug list |
| R2 | Version bumped; `CHANGELOG.md` updated (Keep-a-Changelog format: Added / Changed / Fixed / Security / Known limitations) | commit |
| R3 | `npm run verify && npm run test:e2e` green on Windows; golden frames green; dependency audit and licence check clean (DEVELOPMENT_WORKFLOW.md §11) | outputs in `reports/release-x.y.z/` |
| R4 | `npm run build:engine` (bundle + catalogue loops) and `npm run build:desktop` produce reproducible artefacts (same lockfile, pinned Electron and Remotion versions; two builds differ only in signature and timestamp) | hashes |
| R5 | Installer, updater package and every embedded executable (Chrome Headless Shell, FFmpeg, engine binaries) signed with the OV certificate; `signtool verify /pa` passes | output |
| R6 | Installer smoke on a **clean Windows 10 and Windows 11 VM** without dev tools: install, first run (licence screen, activate a key issued for the VM), create project, import, Insert, pick, export 10 s MP4, close, reopen (recovery), uninstall with data-retention prompt (TEST_PLAN.md §2) | QA record |
| R7 | Update path tested: previous release → this release via the signed feed; interrupted update recovers | QA record |
| R8 | Licence runbook: issue a key for the test machine, activate, reboot, verify; tampered key rejected; key on the revocation list rejected (LICENSE_OPERATIONS.md) | QA record |
| R9 | Revocation list `listVersion` incremented and bundled | file |
| R10 | VULNERABILITY_CHECKLIST.md run for this release; no production source maps; fuses verified; secret scan of the installer contents | checklist with evidence |
| R11 | Documentation updated: user help, known limitations (About), third-party notices, INDEX.md, `memory.md`, `process.md` | commits |
| R12 | SHA-256 of all artefacts published next to the download; tag `vX.Y.Z` on `release/x.y`; GitHub release (or equivalent) created as draft | tag, release page |
| R13 | Operator approval line in `process.md`: `Release vX.Y.Z approved by Operator on <date>, commit <hash>, installer sha256 <hash>` | `process.md` |
| R14 | Publish; monitor diagnostics reports from beta/first users for 72 h; decide hotfix or proceed | `process.md` |

## 7. Hotfix path

| Step | Rule |
|---|---|
| Trigger | Severity 1 (data loss, crash on launch, security) or Severity 2 (core workflow blocked, no workaround) in a shipped release (QA_PROCESS.md §10). |
| Branch | `hotfix/x.y.z-<topic>` from tag `vx.y.(z-1)`; minimal change; no refactoring. |
| Verification | the failing scenario reproduced as a test first; `npm run verify` green; targeted `QA-` cases plus TEST_PLAN.md §2 installer smoke on one clean VM; golden frames if the Engine changed. |
| Release | PATCH bump; abbreviated checklist R2–R5, R6 (one VM), R9–R13; changelog states the fix and its cause in plain language. |
| Back-merge | cherry-pick to `release/x.y` and `main` the same day; `process.md` entry. |

## 8. Rollback

| Scenario | Action |
|---|---|
| Bad release detected before most users updated | unpublish the feed entry; re-point the updater to the previous version (electron-updater serves the last good `latest.yml`); publish a notice; hotfix. |
| User-side rollback | installer of the previous version remains downloadable with its hash; the DB migration policy is forward-only with a `expertmotion.db.bak-<version>` copy (DATABASE_SCHEMA.md §5), so a downgrade restores from the `.bak` (documented in help; data since the upgrade is lost and the dialog says so). |
| Composition Model `schemaVersion` bump | never roll back a release that migrated models without also shipping the lazy `migrateModel` for the older reader; prefer forward hotfix. |
| Revocation list | shipped lists are never retracted; an erroneously revoked key is re-issued (LICENSE_OPERATIONS.md). |
| Decision rollback | a reverted ADR gets a new ADR with status `superseded by` on the old one; history is never edited. |

## 9. Change control for owned documents

| Document / artefact | Rule |
|---|---|
| `GLOSSARY.md` | **frozen.** New terms are appended with a dated note; existing terms are never redefined. A term change requires an ADR and an update of every document that uses it in the same PR. |
| `DECISIONS.md` | append-only; new ADR for every decision that changes architecture, schema, op vocabulary, catalogue rules, security controls, packaging or licensing. |
| Composition Model schema (`DATABASE_SCHEMA.md` §4, `packages/composition-model/src/schema.ts`) | ADR note + `schemaVersion` bump + `migrateModel` + migration tests + golden fixtures updated (DATABASE_SCHEMA.md §5, DEFINITION_OF_DONE.md). |
| DB DDL | ADR note + `NNN_name.sql` migration + repository update + migration test on empty and seeded DB. |
| Operation vocabulary (`AI_WORKFLOW.md` §5) | ADR note + Zod + `applyOps` + validator + Compile row (if deterministic) + tests + SYSTEM_PROMPT capability list + GOLDEN_SCENARIOS update. |
| Design Catalogue ids | never renamed; new id + deprecation; DoD for Design Presets. |
| `SYSTEM_PROMPT.md` | version bump per prompt; golden scenarios re-run; result table updated. |
| `ELEMENT_IDS.md` | ids never change meaning; additions allowed; removal only with a deprecation note and a search proving no reference remains. |
| `API_SPECIFICATION.md` | breaking route changes need a version note; the Editor and Service ship together, so no runtime negotiation, but tests must be updated in the same PR. |
| Requirement documents (PRD/FRD/SRS/UXRD/AI/SEC) | ids are stable; a withdrawn requirement is marked `withdrawn` with a reason, never deleted; new ids are appended. |
| `ROADMAP.md` | re-estimated at every stage exit; changes recorded in its change log and in `memory.md` §2 when they affect scope. |

Concurrent edits: two agents never edit the same owned document in parallel (brief §20). The coordinating session assigns document ownership per batch and performs the consistency pass afterwards.

## 10. How LLM coding agents hand over

### 10.1 Session protocol

| Phase | Agent does |
|---|---|
| Start | Read `AGENTS.md` (or `CLAUDE.md`), `process.md` (Current state + newest entry), `memory.md`, the current stage row in `ROADMAP.md`, and the documents the task depends on. State the task and the acceptance criteria in its own words before editing anything. |
| Work | Small commits on a `feat/` or `fix/` branch; run the relevant verification after every meaningful change; never claim a result that was not produced by a command in this session. |
| Checkpoint | When context or token budget runs low, or after any meaningful work unit: **stop at a safe checkpoint** (tests green or the failing state described precisely), write the `process.md` entry, update `memory.md` if §10.3 applies, commit, and end with the "How to continue" lines. Do not start a new sub-task that cannot be finished and recorded. |
| Hand-over | The next agent starts at "Start". No chat history is assumed to exist. |

### 10.2 `process.md` entry template (newest first; also update the "Current state" block)

```markdown
## <YYYY-MM-DD> — Entry <N>: <one-line summary>

- **Stage**: Stage <n> <name>; gate status (entry/exit items touched).
- **Objectives**: what this session set out to do, with PRD-/FR-/QA- ids.
- **Completed**: bullet list of finished tasks.
- **Files created or modified**: paths (grouped), with one phrase each.
- **Verification performed**: exact commands run, environment (Linux dev server capped / Windows <machine>), and the actual results (pass counts, failures, measurements). "Not run" where applicable.
- **Memory budget** (if run on the shared server): cgroup `memory.current` peak, swap, any throttling.
- **Blockers**: what stops progress and who can unblock it.
- **Failed approaches and lessons**: what did not work and why (so nobody repeats it).
- **Decisions taken**: ADR ids created or amended; provisional decisions with the word "provisional".
- **Pending decisions**: questions for the Operator.
- **Next actionable tasks**: ordered, concrete, each with the file(s) to touch.
- **How to continue**: the exact reading order and first command for the next agent.
```

### 10.3 `memory.md` update rule

Update `memory.md` (not `process.md`) when any of the following happened in the session: an ADR was created, accepted or superseded; a milestone (`M0`–`M9`) was reached; an experiment failed in a way that constrains future work; the roadmap or scope changed; a stack version was pinned or changed; a canonical location moved; a limitation was discovered. Entries are short, structured and link to the owning document. Never record keys, passwords or personal data. If nothing on this list happened, do not touch `memory.md`.

### 10.4 Checkpoint quality bar

A checkpoint is safe when: the branch builds (`npm run typecheck`), tests either pass or the failing tests are named in the entry with the reason, no half-written migration or schema change is committed without its tests, and the entry's "How to continue" can be followed by a fresh agent without asking questions.

## 11. Definitions used by gates

| Term | Meaning here |
|---|---|
| Signed | the Operator wrote the sign-off line in `process.md`; nothing else counts |
| Green | the named command exited 0 in the named environment in this session, output recorded |
| Accepted deviation | a failing or skipped item with a bug id, severity, Operator initials and a target stage for the fix |
| Waiver | the Operator's written decision to skip an item, with reason and date |

## 12. Change log

| Date | Change |
|---|---|
| 2026-10-24 | First baseline. |
