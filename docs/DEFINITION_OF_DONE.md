# Definition of Done

| Field | Value |
|---|---|
| Status | baseline |
| Owner | QA lead |
| Last updated | 2026-10-24 |
| Depends on | MASTER_PROJECT_PROMPT.md §19; GLOSSARY.md; STAGE_MANAGEMENT.md; DEVELOPMENT_WORKFLOW.md; QA_PROCESS.md; DESIGN_CATALOGUE.md; AI_WORKFLOW.md; DATABASE_SCHEMA.md §5; PERFORMANCE.md §5 |
| Used by | AGENTS.md, CLAUDE.md, HOOKS_AND_GUARDRAILS.md, STAGE_MANAGEMENT.md gates, TEST_PLAN.md |
| ID range | none (DoD items are `D-<artefact>-<n>`) |

"Done" is a property of an artefact, verified by evidence, not a feeling of the author. The baseline below applies to every artefact; the per-artefact tables add what that artefact type needs on top.

## 1. Baseline (brief §19, verbatim)

A task is complete only when:

- Acceptance criteria are satisfied.
- Relevant automated tests pass.
- Important errors are handled.
- Security and privacy requirements are met.
- Documentation is updated.
- Dependencies and interfaces remain consistent.
- The feature is verified in the relevant environment.
- Limitations are documented.
- Changes are traceable to requirements or decisions.

A generated UI, untested code change, or successful compilation alone does not prove a feature is complete.

## 2. Project-wide additions to the baseline

| ID | Rule |
|---|---|
| D-ALL-1 | **Verified** has the meaning of DEVELOPMENT_WORKFLOW.md §12: the command was run in this session on the named environment and the output recorded. Work that needs Windows is not done until it ran on Windows. |
| D-ALL-2 | **Memory budget measured when on the shared server:** any task that ran a render, a bundle, a test suite or a dev server on the 1.9 GB Linux dev server records the cgroup `memory.current` peak (and swap use) in the `process.md` entry, and the peak stayed under the 900 MB soft cap (a breach up to the 1.2 GB hard cap is reported as a finding, not accepted silently). |
| D-ALL-3 | The `process.md` entry for the work unit exists (STAGE_MANAGEMENT.md §10.2) and `memory.md` was updated if the §10.3 rule applies. |
| D-ALL-4 | Glossary terms used exactly; no forbidden words in Creator-facing strings (UX-040); product name always Expertmotion. |
| D-ALL-5 | Nothing described as production-ready that is a placeholder, stub or fake (brief §22.8); fakes are named `Fake*` and live under `test/` or behind an explicit `--fake` flag. |
| D-ALL-6 | No secret, key or personal data in code, fixtures, logs, docs or `process.md`. |

## 3. Feature (an `FR-` implemented)

| ID | Done when |
|---|---|
| D-FEAT-1 | The `FR-` exists in FRD.md with acceptance criteria, priority and verification method; the implementation references it in the PR and commits. |
| D-FEAT-2 | Every acceptance criterion of the FR passes, with the `QA-` case(s) executed in the required environment and recorded (QA record). |
| D-FEAT-3 | Unit tests for pure logic, integration tests for Service routes (fake Engine/provider), e2e for Creator-visible flows; tests fail without the change. |
| D-FEAT-4 | Failure paths return `EM-` codes that exist in ERROR_CATALOGUE.md with EN/ID copy and a recovery action; the Editor shows them per the UXRD error policy. |
| D-FEAT-5 | Security review items touched by the feature pass (local API auth, path restriction, egress through the single module, no model-input execution paths); new SEC- items added if a new boundary appeared. |
| D-FEAT-6 | Documentation updated: FRD status, API_SPECIFICATION (routes/events), DATABASE_SCHEMA (tables), AI_WORKFLOW (ops/tools), UI_UX_SPECIFICATION (screens), ELEMENT_IDS (new `el:`), ACCESSIBILITY_AND_I18N (new keys). |
| D-FEAT-7 | `data-el` attributes present for every `el:` id the FR names; keyboard operable; both i18n locales complete. |
| D-FEAT-8 | Limitations stated in the FR row and, if Creator-visible, in the About/limitations list. |
| D-FEAT-9 | `npm run verify` green on Linux (capped) and Windows; e2e green where the FR is Creator-visible. |

## 4. Document

| ID | Done when |
|---|---|
| D-DOC-1 | Header table present (Status, Owner, Last updated, Depends on, Used by, ID range where applicable). |
| D-DOC-2 | Uses GLOSSARY.md terms exactly; references owning documents instead of redefining tables or schemas. |
| D-DOC-3 | Every id it introduces is in the declared range and unique; every id it cites exists (or is cited by group/range with a note that the consistency pass links it). |
| D-DOC-4 | Tables over prose; estimates labelled as estimates with confidence; facts separated from assumptions; sources with access dates for external facts. |
| D-DOC-5 | Link check passes (`npm run lint` docs step); INDEX.md status updated. |
| D-DOC-6 | Reviewed by a second reader (review agent or Operator) for contradictions with PRD/ARCHITECTURE/AI_WORKFLOW; contradictions recorded in `process.md` and resolved or escalated. |
| D-DOC-7 | Change log row added (for living documents). |

## 5. Design Preset (`preset:<category>.<name>`)

| ID | Done when |
|---|---|
| D-PRESET-1 | Catalogue row in DESIGN_CATALOGUE.md with id, labels EN/ID, params, defaults, Property Class, priority, flags (`gpu`, `webgpu`, `model:*`, `licence:*`), preview asset path, tags EN/ID; REMOTION_CAPABILITY_MAP.md row with the Remotion API and source. |
| D-PRESET-2 | Registry entry in `packages/engine/src/catalogue/<category>.ts` (Zod params schema, defaults) and the React implementation keyed by `presetId`; sizes in `u`; frame-based animation; `fitText` for text; stays inside the safe area in every ratio. |
| D-PRESET-3 | Compile table entry in `packages/agents` (category → ops with defaults) and a unit test proving the preset compiles to valid ops without a provider call (AI-011). |
| D-PRESET-4 | Preview loop built (2 s, 480 px, webm) by `build:engine`; total catalogue loops ≤ 40 MB after the addition. |
| D-PRESET-5 | Golden frames committed for **all 7 ratios** (16:9, 9:16, 1:1, 4:5, 5:4, 4:3, 3:4) at the fixed frames; diff ≤ 1 % against the Player screenshot at the same frames on Windows (parity). |
| D-PRESET-6 | Validator rules specific to the preset implemented and tested (e.g. transition ≤ 50 % of the shorter Clip; effect count ≤ 3, T0 ≤ 2). |
| D-PRESET-7 | i18n labels (`catalogue.<id>.label`, `.description`) in `en.json` and `id.json`; tags searchable through `lib.search.input` and `catalogue.search`. |
| D-PRESET-8 | Hardware flags honoured: `gpu` presets show the GPU badge and render under `swangle` on T0 without blank frames (golden frame on T0 or documented exclusion); `webgpu` presets disabled below T2. |
| D-PRESET-9 | Added to SYSTEM_PROMPT.md capability list (if the agent may use it) and to at least one Golden Scenario or the catalogue e2e spec. |

## 6. Operation (`op:<entity>.<verb>`)

| ID | Done when |
|---|---|
| D-OP-1 | ADR note in DECISIONS.md (the op vocabulary is closed; AI_WORKFLOW.md §5). |
| D-OP-2 | Row in AI_WORKFLOW.md §5 with target, args (Zod summary), Property Class, notes; Zod schema in `packages/agents/src/schemas.ts` (or the shared schema location) and `packages/composition-model` `applyOps` case. |
| D-OP-3 | `validate(model)` post-conditions and the plan validator cover the op's invariants (duration recomputation, Locked Keys, destructive confirmation flag). |
| D-OP-4 | Unit tests: happy path, each rejection path with its `EM-` code, idempotency where applicable, interaction with `baseVersion`/stale detection. |
| D-OP-5 | Compile row if a UI pick produces it deterministically; Target Resolution row if a new category. |
| D-OP-6 | SYSTEM_PROMPT.md capability list and at least one Golden Scenario updated; `eval:agents` passes. |
| D-OP-7 | Timeline View renders the resulting element kind; Plan Card `expectedDiff` wording exists in EN/ID. |

## 7. Agent prompt change (`SYSTEM_PROMPT.md`)

| ID | Done when |
|---|---|
| D-PROMPT-1 | Prompt version bumped (`<agent>@<n>`) with a dated change note; `agent_runs` records the version. |
| D-PROMPT-2 | All 20 golden scenarios re-run on the fake provider (recorded responses re-validated against the new envelope) and on at least one live mid-tier model; pass rate recorded in GOLDEN_SCENARIOS.md results table with model id and date; no regression below the previous rate without an Operator decision. |
| D-PROMPT-3 | Locked Key violation scenarios (GS-11…GS-14 group) still at 100 % caught. |
| D-PROMPT-4 | Prompt contains no secrets, no product-internal paths and no forbidden words in Creator-visible replies; Indonesian reply behaviour (UX-042) re-checked. |
| D-PROMPT-5 | Context budget unchanged or re-measured (system prompt tokens listed in the change note). |
| D-PROMPT-6 | AGENT_DESIGN.md permission table still matches the tools the prompt describes (traceability "Tool → prompt → agent"). |

## 8. Model integration (Local Model or Engine Binary)

| ID | Done when |
|---|---|
| D-MODEL-1 | Registry row in LOCAL_AI_MODELS.md and `packages/models`: id, task, language coverage, size, licence (name, URL, commercial-use statement, redistribution terms, attribution/notice text), engine binary and its licence, SHA-256 of weights and binaries, download URL(s), Hardware Tier availability, fallback. |
| D-MODEL-2 | Licence recorded in third-party notices (About) and BRD compliance section; GPL engines run as separate processes with a source offer. |
| D-MODEL-3 | Hash verified at download and at first use; resume works; corrupted download rejected with an `EM-` code; Private Mode blocks the download with the inline notice. |
| D-MODEL-4 | Tier table applied: offered only on allowed tiers; default picked per PERFORMANCE.md §1; fallback behaviour tested when hardware is insufficient or the model is absent (brief §15). |
| D-MODEL-5 | Engine process adapter has a timeout, kill-on-cancel, no network (no proxy env passed; egress check before spawn), temp files cleaned; output validated (duration/sample rate/dimensions) before `op:generated.insert`. |
| D-MODEL-6 | Tests: adapter unit tests with a fake process; one integration test with the real binary on Windows per supported tier; quality spot-check recorded (e.g. Indonesian WER sample, listening test) with the known limitation written down. |
| D-MODEL-7 | Model Manager shows installed state, size, licence, tier, progress, remove; removing frees disk. |

## 9. Release

| ID | Done when |
|---|---|
| D-REL-1 | STAGE_MANAGEMENT.md §6 release checklist R1–R14 complete with evidence. |
| D-REL-2 | PRD §7 release criteria 1–5 evidenced (for v1.0) or the regression equivalent for minors. |
| D-REL-3 | QA_PROCESS.md §12 sign-off record filled: full regression, render matrix, performance budgets, security checklist, packaging on clean Windows 10 and 11 VMs, accessibility, usability (where required). |
| D-REL-4 | Zero open Severity 1/2; Severity 3 listed in known limitations. |
| D-REL-5 | Artefact hashes published; tag pushed; revocation list bundled; `process.md` approval line written by the Operator. |

## 10. Bug fix

| ID | Done when |
|---|---|
| D-BUG-1 | Reproduced first as a failing automated test at the lowest pyramid level that captures it (or a manual `QA-` case when automation is impossible, with the reason). |
| D-BUG-2 | Root cause stated in the commit body and the bug record; the fix addresses the cause, not the symptom. |
| D-BUG-3 | Regression test stays in the suite; related `QA-` case updated if the expected behaviour was wrong. |
| D-BUG-4 | ERROR_CATALOGUE.md updated if the bug was a missing or misleading error; docs updated if the bug was a spec gap (and the spec gap recorded in `process.md` lessons). |
| D-BUG-5 | Verified in the environment where it was reported (Windows for Shell/render/packaging bugs). |
| D-BUG-6 | Severity 1/2 fixes follow the hotfix path (STAGE_MANAGEMENT.md §7). |

## 11. Quick reference

| Artefact | Minimum evidence to attach |
|---|---|
| Feature | QA record, `verify` output (both OSes when applicable), PR checklist, docs diff |
| Document | link check, second-reader note |
| Design Preset | golden frames × 7, Compile test, loop size, catalogue row |
| Operation | ADR note, tests per path, Golden Scenario update |
| Prompt | eval table row (fake + live), version bump |
| Model | registry row with licence + hash, tier test on Windows |
| Release | release checklist, sign-off record, hashes |
| Bug fix | failing-then-passing test, root cause |

## 12. Change log

| Date | Change |
|---|---|
| 2026-10-24 | First baseline. |
