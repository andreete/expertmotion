# Development Workflow: setup, scripts, environments, commits, reviews, style, testing, secrets, dependencies

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Engineering manager |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md; ARCHITECTURE.md §4, §5; ASSESSMENT.md §1; PERFORMANCE.md §5 (development-server note); STAGE_MANAGEMENT.md; DEFINITION_OF_DONE.md; DECISIONS.md (ADR-013) |
| Used by | AGENTS.md, CLAUDE.md, HOOKS_AND_GUARDRAILS.md, AGENT_SKILLS.md, QA_PROCESS.md, BLUEPRINT.md, TRD.md |
| ID range | none |

This document tells a developer or coding agent how to work in `/home/andre/expertmotion` day to day. Stage gates and hand-over are in `STAGE_MANAGEMENT.md`; the meaning of "done" is in `DEFINITION_OF_DONE.md`; exact dependency versions are pinned in `TRD.md`.

## 1. Toolchain and package manager

| Item | Decision | Why |
|---|---|---|
| Node | **22 LTS** (`.nvmrc` = `22`; `engines.node: ">=22.13 <23"`) | Remotion requires Node 20.19+/22.13+/24+ (ASSESSMENT.md §4); Electron bundles its own Node for the Shell, but `apps/service` runs as a plain Node child process, so one version is pinned for both development and the bundled runtime. |
| Package manager | **npm workspaces** (`package-lock.json` committed, `npm ci` in verification) | The predecessor repository (`/home/andre/experthinker-studio`) uses npm workspaces and its ported modules carry npm-shaped scripts; electron-builder and Remotion's Electron template document npm; one fewer global tool for the Operator and for CI; pnpm's symlinked `node_modules` complicates electron-builder's dependency packing and native module rebuilds. pnpm's disk savings do not matter at this repository size. Revisit (ADR) only if install time or hoisting bugs become a measured problem. |
| TypeScript | 5.x, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, project references per workspace | — |
| Test runners | Vitest (unit, integration), Playwright (e2e against Editor + Service), custom `golden-frames` script (renderStill + pixelmatch) | — |
| Lint / format | ESLint (typescript-eslint strict, `no-explicit-any`, import rules), Prettier | — |
| Electron tooling | electron-vite, electron-builder, @electron/fuses (Windows only) | ADR-004 |

Versions of Remotion, Electron, React, Zod, Vercel AI SDK and native modules are pinned exactly in `TRD.md`; all `@remotion/*` packages and `remotion` share one exact version and are bumped together (predecessor rule, kept).

## 2. Repository layout (planned; created in Stage 2, from ADR-013 and ARCHITECTURE.md §4)

```
expertmotion/
  apps/desktop/            Electron main + preload (Windows build only)
  apps/service/            Local Service: http, db, ingest, render, hardware, license, settings
  apps/ui/                 Editor: Vite + React 19 + Tailwind v4 + @remotion/player
  packages/composition-model/   Zod schema, applyOps, validate, deriveTiming, hash (pure)
  packages/catalogue/      React-free Design Catalogue registry: preset ids, labels EN/ID, Zod params, defaults, flags, Compile defaults (ADR-013)
  packages/engine/         ExpertmotionTimeline, preset React components keyed by presetId, Root.tsx, build scripts
  packages/agents/         intents (Target Resolution, Property Classes, Compile, Rewrite, Locked Keys), provider adapters, runners, tools
  packages/models/         local model registry, download, engine process adapters
  packages/shared/         ids, hashing, HttpError, formats, fitText, egress module, i18n helpers
  scripts/                 dev-capped.sh, verify.sh, golden-frames, build helpers
  docs/                    specifications (see docs/INDEX.md)
  reports/                 gate evidence (summaries committed; logs and recordings git-ignored)
  AGENTS.md CLAUDE.md SYSTEM_PROMPT.md process.md memory.md
```

Dependency direction (enforced by ESLint `import/no-restricted-paths`): `shared` ← `catalogue` ← `composition-model` ← `engine` ← `agents` ← `service` ← `desktop`; `ui` imports `shared`, `catalogue`, `composition-model` (types) and `engine` (Player component) only. `packages/catalogue` is React-free and imports nothing but `shared`, so `composition-model` validation and `agents` Compile read preset schemas without a cycle through `engine` (ADR-013, ARCHITECTURE.md §4).

## 3. Repository scripts (root `package.json`)

| Script | Does | Environment |
|---|---|---|
| `dev` | Service (tsx watch) + Editor (Vite) concurrently, browser mode, no Electron | Linux or Windows |
| `dev:capped` | `scripts/dev-capped.sh`: same as `dev` inside a systemd user cgroup (§4) | Linux dev server only |
| `dev:service` | Service alone; uses `EM_TOKEN` when set, otherwise generates a dev token and prints it once on start (TRD §4) | both |
| `dev:ui` | Editor alone (proxies `/api` to the Service port) | both |
| `dev:desktop` | electron-vite dev: Shell starts the Service with `utilityProcess.fork`, sends the bootstrap over `parentPort`/`postMessage`, loads the Vite URL | Windows |
| `typecheck` | `tsc -b` across all workspaces | both |
| `lint` | ESLint + i18n lint (`en.json` vs `id.json` keys, forbidden words UX-040) + docs link check | both |
| `format` / `format:check` | Prettier write / check | both |
| `test` | Vitest unit + integration (fake Engine, fake provider) | both |
| `test:e2e` | Playwright against `dev` (browser mode) or against the Electron build (`--electron`) | browser mode on Linux through an SSH tunnel; Electron mode on Windows |
| `test:golden` | `renderStill` fixtures × 7 ratios, pixel diff ≤ 1 % (`--update` to re-baseline, review required) | Linux at reduced resolution and concurrency 1 under the cap; Windows full |
| `eval:agents` | golden scenarios on the fake provider; `--live --model <id>` for live runs with the test key (the only name; GOLDEN_SCENARIOS.md §4.3 uses it) | both (live needs network and a key) |
| `build:engine` | `bundle()` the Remotion project to `apps/desktop/resources/engine/` (the prebuilt bundle served as `serveUrl`; ARCHITECTURE.md §7, DEPLOYMENT_AND_PACKAGING.md B3) and build catalogue loops to `apps/desktop/dist/ui/catalogue/` (≤ 40 MB) | Windows (loops); bundle only also works on Linux |
| `build:service` | esbuild/tsup bundle of the Service for packaging | both |
| `build:ui` | Vite production build | both |
| `build:desktop` | `build:engine` + `build:service` + `build:ui` + electron-builder NSIS, fuses, signing when `CSC_LINK` is set | Windows |
| `verify` | `format:check && lint && typecheck && test` (the gate command) | both |
| `audit:deps` | `npm audit --omit=dev --audit-level=high` + licence check (allow-list) + lockfile integrity | both |
| `release:changelog` | assembles CHANGELOG from Conventional Commits since the last tag | both |

Script names are contracts: `AGENTS.md`, hooks and the gates refer to them; renaming one is a documentation change too.

## 4. Running on the Linux dev server (shared, 1.9 GB RAM)

| Rule | Value / command |
|---|---|
| Always start under the cap | `npm run dev:capped` → `systemd-run --user --scope -p MemoryHigh=900M -p MemoryMax=1200M -p MemorySwapMax=256M npm run dev`, with `NODE_OPTIONS=--max-old-space-size=512` per Node process (pattern from the predecessor's `scripts/dev-capped.sh`, copied and renamed) |
| Tests under the cap | `systemd-run --user --scope -p MemoryHigh=900M -p MemoryMax=1200M npm run test` (the `verify.sh` wrapper does this automatically when it detects `systemd-run` and a user session) |
| Measure | before and after any render or heavy test: `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/<unit>.scope/memory.current` (the `dev-capped.sh` prints the exact path); record the peak in the `process.md` entry |
| Render limits | `concurrency: 1`; one Render Job at a time; ≤ 720p; ≤ 5 s; `imageFormat: jpeg`; never two Chrome Headless Shell instances; no in-memory caches of bundles or outputs beyond the single prebuilt bundle path |
| Ports | **never 3000 or 4000** (other tenant); the predecessor repository uses 4100 and 5173; Expertmotion development uses `EM_PORT=4110` (Service) and `EM_UI_PORT=4120` (Vite) (variable names per TRD §4: `EM_PORT`, `EM_UI_PORT`, `EM_TOKEN`, `EM_DATA_DIR`, `EM_PRIVATE_MODE`); anything else in 4100–4199 only. Production Shell picks a free port in 42300–42399 (ARCHITECTURE.md §5), never used in development on this server. |
| Electron | cannot run or build here (no display, insufficient RAM): `apps/desktop` is type-checked only; its tests run on Windows |
| Browser access | `ssh -L 4120:127.0.0.1:4120 -L 4110:127.0.0.1:4110 <server>` then open `http://127.0.0.1:4120`; the Service's Host/Origin allow-list includes `127.0.0.1:4120` in development only |
| Fixtures | media fixtures ≤ 2 s, ≤ 720p, ≤ 2 MB each, committed under `fixtures/media/` with licence notes; large fixtures are generated by FFmpeg at test time (colour bars, tone) |
| Discipline | stop processes when done (`systemctl --user stop <unit>`); the server is shared and swap is already in use by the other tenant |

If the cap throttles (MemoryHigh) the run becomes slow but survives; if MemoryMax kills a render, the Service must mark the job `failed` and keep serving (this is itself a test: TEST_PLAN.md §3).

## 5. Running on Windows (Electron, packaging, real renders)

| Step | Command / rule |
|---|---|
| Prerequisites | Windows 10/11 64-bit, Node 22 LTS via nvm-windows or the installer, Git, Visual Studio Build Tools (only for rebuilding native modules; the release uses prebuilds), PowerShell 7 |
| Clone and install | `git clone … && npm ci` |
| Browser mode | `npm run dev` then `http://127.0.0.1:4120` |
| Electron mode | `npm run dev:desktop` (Shell starts the Service with `utilityProcess.fork` and hands over `{token, port, dataDir, dbKey}` via `parentPort`/`postMessage`, never stdin/argv/env; loads Vite) |
| Native modules | `npx electron-builder install-app-deps` after changing Electron or `better-sqlite3-multiple-ciphers` versions |
| Full renders | allowed; respect Performance Profile ceilings; record peak RAM with the Hardware Monitor or Task Manager in the `process.md` entry when measuring budgets |
| Packaging | `npm run build:desktop`; unsigned builds for local testing (`CSC_IDENTITY_AUTO_DISCOVERY=false`); signed builds only by the Operator with the certificate (§10) |
| Clean VM | Hyper-V or VirtualBox snapshot of a fresh Windows without dev tools; every installer smoke starts from the snapshot (TEST_PLAN.md §2) |
| Reference hardware | T0 laptop (PRD §6) is the budget reference; T2 desktop optional |

## 6. Commit conventions

| Rule | Value |
|---|---|
| Format | Conventional Commits: `type(scope): subject` with types `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `security`; scopes are workspace names (`service`, `ui`, `desktop`, `composition-model`, `engine`, `agents`, `models`, `shared`, `docs`) |
| Subject | imperative, ≤ 72 chars, no trailing period; body explains why and references ids (`PRD-014`, `FR-…`, `ADR-010`, `QA-031`) |
| Breaking | `!` after the type/scope and a `BREAKING CHANGE:` footer for schema, op vocabulary, API or catalogue id changes (which also require an ADR) |
| AI authorship | commits authored or co-authored by a coding agent carry the trailer `Co-Authored-By: <agent name> <noreply@…>` as configured in the session; the human committer remains the Operator |
| Size | one logical change per commit; generated files (bundle, loops, golden baselines) in their own commit with the generating command in the body |
| Commit frequency | at every safe checkpoint (STAGE_MANAGEMENT.md §10.4); never leave verified work uncommitted at the end of a session |
| Never commit | `.env*` (except `.env.example`), keys, certificates, licence private keys, provider credentials, `reports/**/*.log`, `reports/**/*.mp4`, `dist/`, `out/`, `node_modules/`, downloaded model weights, Chrome Headless Shell |

## 7. Pull request and review checklist

Every PR description contains the checklist below; the review agent verifies each line by running commands, not by reading the description.

| # | Check |
|---|---|
| P1 | Linked to a stage task and to `PRD-`/`FR-`/`ADR-` ids; scope matches the task (no drive-by changes) |
| P2 | `npm run verify` green locally; output pasted (trimmed) |
| P3 | New or changed behaviour has tests at the right pyramid level (QA_PROCESS.md §2); tests fail without the change (reviewer spot-checks one) |
| P4 | Zod validation at every boundary touched (HTTP input, provider output, file metadata, IPC); no `any`, no non-null assertions without a comment |
| P5 | Errors map to `EM-` codes that exist in ERROR_CATALOGUE.md; new codes added there with EN/ID copy |
| P6 | User-facing strings via i18n keys with `en.json` and `id.json` entries; forbidden words lint passes (UX-040) |
| P7 | Documentation updated in the same PR (FRD/ARCHITECTURE/API/DATABASE/AI_WORKFLOW/DESIGN_CATALOGUE as applicable); `docs/INDEX.md` status if a document changed state |
| P8 | Schema, op vocabulary, catalogue or API changes carry an ADR note, migration and fixture updates (STAGE_MANAGEMENT.md §9) |
| P9 | Security: no new outbound call outside the egress module; no shell/fs/network tool reachable from model input; no secret in code, logs or test fixtures; path handling uses the restricted helpers |
| P10 | Memory: if run on the shared server, peak `memory.current` recorded; no new long-lived caches, no parallel renders, no extra Chrome instances |
| P11 | `process.md` entry written (or will be at the checkpoint that includes this PR) |
| P12 | Reviewer ran at least one verification command themselves and states which |

Approval requires the review agent's findings resolved and the Operator's merge. Documentation-only PRs need P1, P6 (if copy), P7, P11.

## 8. Code style

| Area | Rule |
|---|---|
| TypeScript | `strict`; no `any` (use `unknown` + narrowing); no `enum` (use `as const` unions); explicit return types on exported functions; `readonly` where data is immutable; ESM only |
| Boundaries | Zod schemas at every boundary: HTTP request/response, SSE payloads, provider responses, IPC messages, file metadata from ffprobe, JSON files on disk, environment variables. Types are inferred from schemas (`z.infer`), never duplicated by hand |
| Pure core | `packages/composition-model` and `packages/agents/src/intents/**` are pure: no I/O, no Date.now()/random without injection, deterministic outputs; property-based tests welcome |
| Side effects | isolated behind interfaces with fakes: `RenderAdapter`, `ProviderAdapter`, `Egress`, `Clock`, `FileSystem` (restricted), `ProcessRunner` (allow-listed binaries only) |
| Errors | throw `HttpError`/`AppError` with an `EM-` code; never throw strings; never swallow errors silently; log with structured fields; stack traces only in logs |
| Naming | Glossary terms exactly (`CompositionVersion`, `EditIntent`, `DesignPreset`, `OutputProfile`); files kebab-case; React components PascalCase; `data-el` attributes equal the `el:` ids without the prefix |
| React | function components, hooks; no business logic in components (call the Service); Player wrapper is the only place that touches `@remotion/player`; i18n via `t('ui.…')` |
| Remotion | `@remotion/media` `<Video>/<Audio>`; frame-based animation only (`useCurrentFrame`), never time-based; sizes in `u`; `fitText` for text; fonts via `@remotion/fonts` from bundled files; no `fetch` inside compositions; nothing that breaks `Function.toString` (no bytecode on the renderer path, ADR-007) |
| SQL | parameterised statements only; one transaction per Execute/Insert/undo; repositories per table; no string-built SQL |
| Comments | explain why, not what; TODOs carry an issue id; no commented-out code |
| Formatting | Prettier defaults with `printWidth: 100`, single quotes, trailing commas |

## 9. Testing conventions

| Level | Tool | Location | Rules |
|---|---|---|---|
| Unit | Vitest | `packages/*/test/**`, `apps/*/test/unit/**` | fast (< 10 s per package), no network, no Chrome; one `describe` per module; Compile table has one test per P0 preset; `applyOps` has one test per op including rejection paths |
| Integration | Vitest + supertest | `apps/service/test/integration/**` | real Express app, in-memory encrypted SQLite (`:memory:` with key), fake `RenderAdapter`, fake `ProviderAdapter`, temp data dir; asserts `EM-` codes and SSE events |
| Golden frames | `scripts/golden-frames.ts` (renderStill + pixelmatch) | `packages/engine/test/golden/<preset>/<ratio>-f<frame>.png` | fixed frames (first, middle, last of the effect); diff ≤ 1 %; baselines re-generated only with `--update` and reviewed as images in the PR; Linux runs at 50 % scale and compares against Linux baselines, Windows at full scale against Windows baselines (platform-specific rasterisation) |
| E2E | Playwright | `apps/ui/test/e2e/**` | selectors by `data-el` only; fixtures seeded through the API; one spec per user flow F1–F8; runs in browser mode on both OSes and in Electron mode on Windows |
| Agent evals | `eval:agents` | `packages/agents/test/golden-scenarios/**` | recorded provider responses per GS; fake provider by default; live runs record model, date, pass rate into GOLDEN_SCENARIOS.md results table |
| Packaging | manual script `TEST_PLAN.md` §2 | clean VM | recorded in QA record |
| Fixtures | `fixtures/` | media ≤ 2 MB; SRT/VTT samples in id and en; corrupt and unsupported files (truncated MP4, renamed .txt, 0-byte, HEVC MOV 2 s) | provenance and licence in `fixtures/README.md` |
| Naming | `it('rejects a transition longer than 50 % of the shorter clip (EM-2xxx)')` | — | the expected code or behaviour is in the name |
| Flakiness | a test that fails intermittently is quarantined (`it.skip` with issue id) within the day and fixed before the stage exit; no retries in CI config to hide flakes | — |

## 10. Secrets handling

| Rule | Detail |
|---|---|
| Never committed | provider keys, licence Ed25519 private key, code-signing certificate and password, test accounts. `.gitignore` covers `.env*`; a pre-commit secret scan (gitleaks or equivalent; HOOKS_AND_GUARDRAILS.md) blocks `sk-`, `sk-or-`, `AIza`, `-----BEGIN`, `.pfx` |
| Development keys | `.env.local` (git-ignored) with `OPENROUTER_TEST_KEY` limited to ≤ US$5/month on the provider side; `.env.example` lists variable names only |
| Runtime | provider credentials live encrypted in the DB (ADR-006), the Database Key is wrapped by `safeStorage`; development on Linux uses a plaintext dev key file under `.data/` (git-ignored) with a startup warning, since DPAPI is unavailable |
| Licence signing key | offline on the Operator's machine (LICENSE_OPERATIONS.md); only the public key is in the repository |
| Signing certificate | Operator's Windows machine or HSM/token; `CSC_LINK`/`CSC_KEY_PASSWORD` set in the shell for the release build only, never in files |
| Logs | redaction patterns tested (`packages/shared/test/redact.test.ts`); diagnostics zips are reviewed before sharing |
| Agents | coding agents never read `.env.local` into prompts or paste keys into `process.md`; if a key leaks into a commit, rotate it first, then rewrite history only if the Operator agrees |

## 11. Dependency policy

| Rule | Detail |
|---|---|
| Pinning | exact versions in every `package.json` (no `^`/`~`); `package-lock.json` committed; `npm ci` everywhere |
| Adding | a new runtime dependency needs: purpose, licence, size, maintenance status, alternatives considered, operational implications (brief §22.10) in the PR body; added to `TRD.md`'s dependency table |
| Licences | allow-list: MIT, ISC, BSD-2/3, Apache-2.0, 0BSD, Unlicense, CC0, OFL (fonts), MPL-2.0 (unmodified). Deny: GPL/AGPL in-process (GPL binaries only as separate processes with notices, e.g. Piper), SSPL, non-commercial, "Community" licences without a check against revenue terms. `audit:deps` fails on unknown licences |
| Audit | `npm audit --omit=dev --audit-level=high` in `verify` from Stage 3; a high/critical finding without a fix is recorded in RISKS_AND_ASSUMPTIONS.md with a mitigation or the dependency is replaced |
| Upgrades | Remotion family bumped together after reading the changelog and re-running golden frames; Electron bumped only with a fuses/bytecode compatibility check (ADR-007); native modules re-verified with `install-app-deps` on Windows |
| Integrity | lockfile integrity hashes checked by `npm ci`; packaged third-party binaries (Chrome Headless Shell, FFmpeg, engine binaries) carry SHA-256 in `packages/models/registry` or `DEPLOYMENT_AND_PACKAGING.md` and are verified at build and at first run |
| Supply chain | no post-install scripts from new dependencies without review (`ignore-scripts` with an allow-list for native modules); Renovate/Dependabot optional later, always behind the PR checklist |

## 12. Documentation-first and "verified"

| Rule | Detail |
|---|---|
| FR before code | a feature is implemented only when its `FR-` exists in FRD.md with acceptance criteria and a `QA-` case; if the FR is missing, the agent writes it (or a draft marked `proposed`) and gets Operator acceptance before coding |
| ADR before change | any decision that changes architecture, schema, op vocabulary, catalogue rules, security controls, packaging or licensing is recorded in DECISIONS.md first (status `proposed` is acceptable to start work) |
| Reference, never redefine | documents link to the owning document; copying a table into a second place is a defect |
| "Verified" means | the claim was produced by a command executed in this session on the named environment, and the output (or its summary with counts) is recorded. "It should work", "compiles", "the UI renders" or "tests were added" are not verification (brief §19). A feature that needs Windows is "verified" only when run on Windows; until then the `process.md` entry says "not yet verified on Windows" |
| Agents claiming results | an agent that cannot run the relevant command states so explicitly and marks the item unverified; the Operator or QA runs it and records the result |

## 13. Open points for this document

| # | Point | Owner | Resolve by |
|---|---|---|---|
| 1 | **Decided** (ADR-013, ARCHITECTURE.md §4): registry **data** (ids, labels, Zod params, defaults, flags, Compile defaults) lives in the React-free `packages/catalogue`; preset **components** stay in `packages/engine`, keyed by preset id. BLUEPRINT.md carries the file layout. | Principal architect | closed 2026-10-24 |
| 2 | Choice of commit-trailer agent name format for `Co-Authored-By` across providers. | Operator | Stage 2 |

## 14. Change log

| Date | Change |
|---|---|
| 2026-10-24 | First baseline. |
