# Technical Requirements Document (TRD)

| Field | Value |
|---|---|
| Status | baseline (versions marked "pin at Stage n" are fixed at that Roadmap Stage gate and recorded here) |
| Owner | Principal architect |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-001, 004, 005, 006, 007, 008, 010, 012, 014, 017), ARCHITECTURE.md, BLUEPRINT.md, PERFORMANCE.md, DATABASE_SCHEMA.md, AI_WORKFLOW.md, ASSESSMENT.md §1, §4, §5, §8, §9 |
| Used by | SRS.md (NFR derivation), DEPLOYMENT_AND_PACKAGING.md, DEVELOPMENT_WORKFLOW.md, DEFINITION_OF_DONE.md, TEST_PLAN.md, SECURITY.md, POC_PLAN.md |
| Owner of | the stack and pinned versions, dependency policy, TR-xxx technical requirements, development environment variables, development-server constraints, compatibility matrix, coding standards, logging and diagnostics format |
| ID range | TR-001 … TR-199 |

Performance budgets live in PERFORMANCE.md, security controls in SECURITY.md (`SEC-`), packaging steps in DEPLOYMENT_AND_PACKAGING.md, error codes in ERROR_CATALOGUE.md (`EM-`). This document references them and adds the technical constraints the implementation must satisfy.

## 1. Stack and pinned versions

Rule: every runtime dependency is pinned to an exact version in `package.json` (`.npmrc` `save-exact=true`) and locked in the single root `package-lock.json`. "Installed in the predecessor" = measured in `/home/andre/experthinker-studio/package-lock.json` on 2026-10-24.

### 1.1 Runtime and shell

| Component | Version to use | Notes |
|---|---|---|
| Node.js (development, tooling, CI) | **22.x LTS** (≥ 22.13; pin the minor in `.nvmrc` / `engines`) | Remotion requires 20.19+/22.13+/24+ (book §2.1, ASSESSMENT.md §4). Production never ships a separate Node: the Local Service runs on the Node embedded in Electron (`ELECTRON_RUN_AS_NODE=1`). |
| Electron | **latest stable at Stage 3 start, then pinned exactly** (`electron@<major.minor.patch>`) | The Electron major fixes the Chromium version (preview parity), the embedded Node version and the **native-module ABI**. All native modules (`better-sqlite3-multiple-ciphers`) must be built or prebuilt for that exact Electron ABI (`electron-rebuild` or `prebuild-install --runtime=electron --target=<version>`); the same modules are built for plain Node 22 in development, so two builds exist in `node_modules` only when `npm run rebuild:electron` is run. Upgrading Electron therefore means: re-run prebuild checks, re-run the V8 bytecode build (bytecode is version-locked, ADR-007), re-run the parity test (POC-002). |
| Chromium (Editor renderer) | the one embedded in the pinned Electron | not installed separately |
| Chrome Headless Shell (renderer) | the version `@remotion/renderer` pins for the chosen Remotion version (`node_modules/.remotion/chrome-headless-shell/win64/VERSION`) | copied into `resources/engine/chrome/` at package time; never downloaded at runtime in production (ADR-008, EM-3001) |
| FFmpeg / ffprobe | the build shipped by Remotion's compositor package for the pinned Remotion version | `binariesDirectory` option; also used by `ingest/`; package name to verify (ASSESSMENT.md §4) |

### 1.2 Libraries

| Library | Version | Pin rule | Used by |
|---|---|---|---|
| `remotion`, `@remotion/player`, `@remotion/renderer`, `@remotion/bundler`, `@remotion/cli`, `@remotion/fonts`, `@remotion/transitions`, `@remotion/media`, `@remotion/captions`, `@remotion/shapes`, `@remotion/layout-utils`, `@remotion/effects`, `@remotion/noise`, `@remotion/rough-notation`, `@remotion/zod-types`, `@remotion/media-utils` | **4.0.535** (installed in the predecessor) to start; **one identical exact version for every `@remotion/*` package** | Evaluate an upgrade to **≥ 4.0.537** (the version the reference book verified `@remotion/effects` and `@remotion/media` against) during Stage 2; adopt only if POC-002 parity and POC render tests pass. Never upgrade to v5 without the ADR required by BRD-012 (telemetry vs Private Mode). A CI check fails when two `@remotion/*` versions differ. | engine, service (renderer only), ui (player only) |
| `react`, `react-dom` | **19.3.0** (installed in the predecessor) | pin exact; one copy in the workspace (`overrides`) so Player and Editor share React | ui, engine |
| `vite` | **6.4.4** (installed) | pin exact; `@vitejs/plugin-react` matching 6.x | ui |
| `typescript` | **5.9.3** (installed; requirement ≥ 5.6) | pin exact; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` | all |
| `zod` | **4.5.4** (installed) | pin exact; `z.toJSONSchema` is the only JSON-Schema generator; `@remotion/zod-types` supports Zod 4 since 4.0.426 | all |
| `express` | **4.22.3** (installed) | pin exact; Express 5 is not adopted in MVP (middleware ecosystem) | service |
| `better-sqlite3-multiple-ciphers` | the release whose embedded SQLite ≥ 3.45 and which publishes Electron prebuilds for the pinned Electron ABI; the predecessor's plain `better-sqlite3` 12.11.1 is the API baseline | pin at Stage 3 when Electron is pinned | service |
| `ai` (Vercel AI SDK) | **6.x** (pin exact at Stage 4) | `generateText` / `streamObject` with Zod 4 schemas; providers `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` (P1) | agents |
| `@openrouter/ai-sdk-provider` | latest compatible with AI SDK 6 (pin exact at Stage 4) | OpenRouter first (PRD-010); `usage.cost` read from the response | agents |
| `systeminformation` | **5.x** (pin exact at Stage 3) | GPU/disk/CPU facts; polled ≤ once per 30 s (PERFORMANCE.md §6) | service/hardware |
| `tailwindcss`, `@tailwindcss/vite` | **4.3.3** (installed) | pin exact | ui |
| `ulid` | current 2.x (pin at Stage 3) | ids (DATABASE_SCHEMA.md §2) | shared |
| `@noble/ed25519` | **2.x** (pin at Stage 3); alternative `libsodium-wrappers` if constant-time concerns arise in review | licence verification (ADR-014); the Operator CLI uses the same library to sign | service/license, tools/license-cli |
| `pino` | **9.x** (pin at Stage 3) | JSON-lines logger with redaction paths; `pino-roll` or built-in rotation (§9) | service, desktop |
| `vitest` | **3.x** (pin at Stage 3) | unit and integration tests, coverage via `@vitest/coverage-v8` | all |
| `@playwright/test` | **1.5x** (pin at Stage 4) | Editor e2e against a dev Local Service; Electron e2e via `_electron` on Windows | test/e2e |
| `esbuild` | **0.25.x** (pin at Stage 3) | service bundle | tools/release |
| `electron-vite` | latest compatible with the pinned Electron (pin at Stage 3) | main/preload build, bytecode plugin for `license/` and `prompts/` only | desktop |
| `electron-builder` | **26.x** (pin at Stage 3) | NSIS x64 installer, signing, `latest.yml` for the updater | tools/release |
| `electron-updater` | matching electron-builder | signed updates (EM-8103) | desktop |
| `eslint` 9 (flat config), `eslint-plugin-import`, `typescript-eslint` | pin at Stage 3 | dependency rules (BLUEPRINT.md §2.1), `no-explicit-any` | all |
| `@cyclonedx/cyclonedx-npm`, `license-checker-rseidelsohn` | pin at Stage 3 | SBOM and licence scan (§2) | tools/release |
| whisper.cpp, sherpa-onnx (`sherpa-onnx-node`), stable-diffusion.cpp, ACE-Step runtime | **pin at Stage 5 / P1 (whisper, sherpa) and P2 (sd.cpp, ACE-Step)** | Engine Binaries are release archives with recorded sha256 (LOCAL_AI_MODELS.md); GPL-3 Piper runs as a separate process only (BRD-019) | models |

### 1.3 Explicitly not used

| Not used | Why |
|---|---|
| `@remotion/bundler` at runtime, webpack in the installed app | prebuilt Engine bundle (ADR-001); `@remotion/bundler` is a build-time dependency of `packages/engine` only |
| `@remotion/lambda`, `@remotion/cloudrun` | local only |
| `@remotion/google-fonts` at runtime | offline rule; fonts are bundled woff2 |
| `keytar` | archived; Electron `safeStorage` instead (ASSESSMENT.md §6) |
| `cors` package in production | explicit Host/Origin middleware (API_SPECIFICATION.md §2.3); CORS headers only for the Vite dev origin |
| `chokidar` in the service | no runtime bundle watching (BLUEPRINT.md §5.1) |
| `@modelcontextprotocol/sdk` | ADR-015 |

## 2. Dependency policy

| Rule | Mechanism | Gate |
|---|---|---|
| Exact pins for every dependency; no `^`/`~` in any `package.json` | `.npmrc` `save-exact=true`; `tools/release/check-pins.mjs` | CI fails on a range |
| Single root lockfile committed; installs use `npm ci` | npm workspaces | CI |
| All `@remotion/*` and `remotion` at one identical version | `tools/release/check-remotion-versions.mjs` | CI |
| `npm audit --omit=dev` has no high/critical findings at release; moderate findings triaged in process.md | `npm audit` in the release script | release checklist |
| Licence scan: only MIT, ISC, BSD-2/3, Apache-2.0, 0BSD, Unlicense, CC0, OFL (fonts), MPL-2.0 (noted) in the shipped JS graph; GPL/AGPL/LGPL forbidden in bundled JS (binaries as separate processes are listed, BRD-019); unknown licences block | `license-checker-rseidelsohn --onlyAllow` | CI + release |
| SBOM per release (CycloneDX JSON) covering npm packages, Chrome Headless Shell, FFmpeg, fonts, Engine Binaries, model manifests | `tools/release/sbom.mjs` | release artefact |
| Lockfile integrity: `npm ci` verifies `integrity` hashes; the release build runs from a clean clone | release script | release |
| Dependency updates: monthly batch on a branch; Electron and Remotion updates always via an ADR note + POC-002 parity re-run | DEVELOPMENT_WORKFLOW.md | review |
| Native modules only from packages publishing prebuilds for both Node 22 and the pinned Electron; otherwise a build toolchain is required on the release machine (documented in DEPLOYMENT_AND_PACKAGING.md) | review | Stage 3 gate |
| No dependency that phones home at runtime (telemetry) unless disabled by configuration and documented in `scr.about` | review of each new dependency | PR review |

## 3. Technical requirements

Columns: priority (Must/Should/Could), verification (how the requirement is checked), traces (requirements or ADRs it serves). Status is `planned` for all rows until implementation.

### 3.1 Runtime and processes

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-001 | The Local Service runs as a child process of the Desktop Shell on Electron's embedded Node (`ELECTRON_RUN_AS_NODE=1`, `utilityProcess` or `child_process.fork` of the packaged `service.mjs`); no separate Node binary is installed or downloaded. | Must | clean-VM test lists only `Expertmotion.exe` processes + Chrome Headless Shell + ffmpeg during render | PRD-001, ADR-004 |
| TR-002 | The Shell passes `{token, port, dataDir, dbKeyHex}` to the Service as one JSON line on stdin and reads `ready <port>` from stdout; nothing secret appears in argv or the environment. | Must | process listing during run shows no token; unit test of the handshake parser | ARCHITECTURE.md §5, SEC- |
| TR-003 | The Service binds only `127.0.0.1` on a free port chosen from 47600–47699 (production) or `EM_PORT` (development); binding `0.0.0.0`, `::` or a hostname is impossible by construction (the host is a constant). | Must | `netstat` in TEST_PLAN; code review | ADR-005 |
| TR-004 | The Shell restarts a crashed Service with backoff 1 s, 3 s, 9 s and gives up after 3 attempts (EM-8002); the Editor shows `sys.offline` within 2 s and reconnects automatically. | Must | kill the service in e2e; observe banner and recovery | UX-032, EM-8001/8002/8003 |
| TR-005 | On startup the Service marks interrupted work: `render_jobs` `queued|rendering` → `failed` (EM-3203), `agent_runs` `running` → `cancelled` (EM-4304), ingesting assets → `failed` (EM-1201); partial output files are deleted. | Must | integration test with a pre-seeded DB | DATABASE_SCHEMA.md §7 |
| TR-006 | Graceful shutdown: on SIGTERM or `POST /service/shutdown`, the Service checkpoints every open project, cancels running renders (Chrome killed), closes the DB and exits within 5 s; the Shell force-kills after 5 s. | Must | e2e timing | ARCHITECTURE.md §5 |
| TR-007 | The Service never spawns a shell (`shell: true`) and never builds a command line from model output or Creator text; every child process (`ffmpeg`, `ffprobe`, Engine Binaries) is spawned with an argv array and a fixed executable path inside the install directory. | Must | code review + grep gate (`spawn(` without `shell`) | AI-020, SEC- |
| TR-008 | The Editor runs in the Electron renderer with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a CSP that allows `connect-src` and `media-src` only to `http://127.0.0.1:*` and `'self'`, and exactly one preload bridge (`window.expertmotion`). | Must | VULNERABILITY_CHECKLIST | ARCHITECTURE.md §3, SEC- |
| TR-009 | The Editor is a plain web app: `npm run dev` serves it from Vite on `127.0.0.1:5173` (or `EM_UI_PORT`) against a Local Service started with `EM_TOKEN`, so development needs no Electron on Linux. | Must | dev workflow test on the shared server | ADR-004 consequence, ADR-005 |
| TR-010 | A single application instance is enforced (`app.requestSingleInstanceLock`); a second launch focuses the existing window (EM-8301) and forwards opened file paths. | Should | manual test | ELEMENT_IDS `sys.*` |

### 3.2 API

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-020 | The Local Service exposes REST + SSE under `/api/v1` exactly as API_SPECIFICATION.md defines; every route is declared with a Zod request schema and a Zod response schema from which the Editor's DTO types are generated (`packages/shared/dto`). | Must | contract tests generated from the route table | API_SPECIFICATION.md |
| TR-021 | Every request except `GET /api/v1/health` and `GET /media/*` requires `Authorization: Bearer <Service Token>`; `GET /api/v1/events` accepts the token in `?token=` because `EventSource` cannot set headers; a wrong or missing token answers `401 EM-8004` without revealing which. | Must | API tests | ADR-005, SEC- |
| TR-022 | Host and Origin guards: `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; non-safe methods with an `Origin` header accept only `app://expertmotion` (production) or the Vite dev origin; otherwise `403 EM-8005`. No cookies are ever set (no CSRF surface). | Must | API tests incl. DNS-rebinding style `Host` | ADR-005 |
| TR-023 | JSON bodies are limited to 2 MB (`413 EM-8006`), multipart uploads to the per-kind limits in ASSET_INGESTION.md, SSE connections to 8 per token; all limits are constants in `apps/service/src/config.ts`. | Must | API tests | PERFORMANCE.md |
| TR-024 | Every error response uses the envelope `{error: {code: 'EM-xxxx', message, details?, path?}}` with the HTTP status mapping of API_SPECIFICATION.md §2.5; unknown exceptions become `500 EM-9001` and are logged with a stack trace. | Must | API tests; grep for `res.status(…).json` outside `http/errors.ts` must be empty | ERROR_CATALOGUE.md |
| TR-025 | `POST /plans/:id/execute` and `POST /renders` are idempotent: a repeated request with the same `Idempotency-Key` (or, for Execute, the same `planId`) returns the first result with `200` and `EM-2308` in `details.notice`. | Must | API tests | AI_WORKFLOW.md §6 |
| TR-026 | SSE: `retry: 2000`, heartbeat `: ping` every 15 s, every event carries `id: <seq>` and the payload field `seq`; the server keeps the last 500 events per connection scope so `Last-Event-ID` replays missed events after a reconnect. | Must | SSE tests with a forced disconnect | API_SPECIFICATION.md §7 |
| TR-027 | Long operations (ingest, plan, agent run, render, model download, backup) are jobs: `202 Accepted` with an id, progress over SSE, cancel endpoint; no HTTP request blocks longer than 30 s. | Must | API tests | brief §7.3 |

### 3.3 Data

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-030 | All structured data is in one SQLite database opened with `better-sqlite3-multiple-ciphers`, `PRAGMA cipher = 'chacha20'`, `PRAGMA key = "x'<hex>'"`, WAL mode, `foreign_keys = ON`, `busy_timeout = 5000`; the DDL is DATABASE_SCHEMA.md §3. | Must | open the DB file with plain sqlite3 → fails; schema diff test | ADR-006, PRD-004 |
| TR-031 | The Database Key is a random 256-bit value generated on first run, wrapped with `safeStorage.encryptString` (DPAPI) by the Shell and stored as `keyring.bin`; the Service receives the unwrapped key over stdin and holds it only in memory. Provider secrets are additionally encrypted with AES-256-GCM under an HKDF-derived key (label `provider-secrets`). | Must | code review; unit tests for wrap/unwrap and HKDF vectors | DATABASE_SCHEMA.md §1 |
| TR-032 | Media bytes never enter the database; originals, playable transcodes, proxies, thumbnails, filmstrips and waveforms live under `%APPDATA%\Expertmotion\media\<projectId>\<assetId>\`, referenced by relative paths. | Must | schema review; disk inspection | brief §11 |
| TR-033 | Every change to the Composition Model is one SQLite transaction that writes the `composition_versions` row, the `operations_history` rows and `projects.head_version_id` together; a failure anywhere rolls everything back (`ExecutionResult.rollback.performed = true`). | Must | fault-injection test (throw after the version insert) | DATABASE_SCHEMA.md §2, AI-004 |
| TR-034 | JSON columns are Zod-validated before write and on read (`migrateModel` for older `schemaVersion`); `CHECK(json_valid())` exists on every JSON column. | Must | schema test | DATABASE_SCHEMA.md §2 |
| TR-035 | Migrations are forward-only SQL files applied at startup in a transaction after copying the DB to `expertmotion.db.bak-<version>`; a failed migration restores the copy and shows EM-6003. | Must | migration tests with a seeded older DB | DATABASE_SCHEMA.md §5 |
| TR-036 | Checkpoints: autosave every 10 s when dirty, before Execute, before render, manual; ≤ 20 JSON files per project under `data\checkpoints\<projectId>\`; restore never overwrites, it creates a new version with `cause = 'restore'`. | Must | e2e kill test (PRD-003) | DATABASE_SCHEMA.md §4.5 |
| TR-037 | Backup zips contain only the project's own data (no provider keys, no licence), encrypted with an Argon2id-derived key by default; restore validates manifest hashes and imports as a new project. | Must | backup/restore round-trip test | DATABASE_SCHEMA.md §6 |
| TR-038 | IDs are ULIDs; paths stored in the DB are relative to the media/outputs roots; absolute paths appear only in memory. | Must | DB inspection | DATABASE_SCHEMA.md §2 |

### 3.4 Engine

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-040 | The Engine bundle is built at package time by `packages/engine/scripts/build-bundle.ts` into `resources/engine/bundle/` with a `manifest.json` (`remotionVersion`, `bundleVersion` sha256, `builtAt`); the Service passes the folder as `serveUrl`. No webpack, no `@remotion/bundler`, no TypeScript compilation at runtime. | Must | installed app has no `webpack` in its file tree; render works offline | ADR-001, ADR-004 |
| TR-041 | Exactly one composition id exists in the bundle: `ExpertmotionTimeline`; `getCompositions` at startup must list it or the Service reports EM-3003. | Must | startup self-check test | BLUEPRINT.md §3.3 |
| TR-042 | `calculateMetadata` derives `width`/`height` from the ratio × resolution table (PERFORMANCE.md §3), `fps` from Project Settings and `durationInFrames` from `deriveTiming(model)`; the same function is used by the Player and by `selectComposition` (one code path). | Must | unit test per table cell; parity test | ADR-001, PERFORMANCE.md §3 |
| TR-043 | All times in the Composition Model are integer milliseconds; frames are derived with `Math.round(ms / 1000 × fps)` at render; changing fps never changes stored times. | Must | unit tests at 24/25/30/50/60 | PERFORMANCE.md §4 |
| TR-044 | Chrome Headless Shell is bundled and pinned (`browserExecutable` always set, `chromeMode: 'headless-shell'`); production never downloads a browser (EM-3001 if missing). | Must | network capture during first render on a clean VM shows no download | ADR-008 |
| TR-045 | FFmpeg and ffprobe are bundled and used via `binariesDirectory` (renderer) and direct spawn (ingest); the system PATH is never consulted. | Must | rename system ffmpeg in a VM → still works | ADR-008 |
| TR-046 | Render options are derived only from the Performance Profile table (PERFORMANCE.md §2): `concurrency`, `chromiumOptions.gl`, `hardwareAcceleration`, `offthreadVideoCacheSizeInBytes`, `mediaCacheSizeInBytes`, `disallowParallelEncoding`, `imageFormat`; no other code sets these. | Must | unit test of `profiles.ts`; grep gate | ADR-010 |
| TR-047 | One Render Job executes at a time (global queue); cancellation kills Chrome via `makeCancelSignal` and deletes the partial file within 2 s; a stall of 120 s without progress fails the job (EM-3207). | Must | e2e cancel + stall tests | PRD-014 |
| TR-048 | Output validation: after `renderMedia`, ffprobe must report the expected width, height, fps (± 0.01), duration (± 1 frame) and an audio stream when the model has audible audio; otherwise the job fails with EM-3205 and the file is kept in `outputs\_failed\` for diagnostics. | Must | render tests with each ratio × resolution of the P0 matrix | brief §10 "Output validation" |
| TR-049 | Assets are served to Chrome and to the Player over loopback HTTP (`GET /media/:assetId/:variant`) with `Range` support and unguessable ids; `file://` is not used (revisit per ARCHITECTURE.md §11.2). | Must | render test with a 200 MB source | ARCHITECTURE.md §7 |
| TR-050 | Fonts come only from `packages/engine/public/fonts/*.woff2` via `@remotion/fonts` `loadFont` + `staticFile`; `@remotion/google-fonts` and any `https://fonts.*` URL are forbidden in the engine graph. | Must | grep gate; offline render | DESIGN_CATALOGUE.md §10 |
| TR-051 | Preview parity: for every P0 preset and each of the 7 ratios, a Player screenshot and `renderStill` of the same frame differ by ≤ 1 % of pixels (perceptual diff); failures block the release. | Must | TEST_PLAN golden frames | PRD §5, POC-002 |
| TR-052 | Memory discipline in the Engine: no module-level caches of decoded media or models; `premountFor` ≤ 2 s; effects limited per element (CM-006); catalogue cards use prerendered loops, never live Players (ADR-011). | Must | code review; PERFORMANCE.md §5 budgets | ADR-011 |
| TR-053 | Trial Mode: the Engine renders the watermark component when `inputProps.watermark = true`; the Service forces it and caps the resolution to 720p for unlicensed installs; the Player never shows the watermark. | Must | licence tests | PRD-017 |

### 3.5 Agents and providers

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-060 | Every provider response is parsed with Zod (`EditPlan`, `BrainstormTurn`); parse failure re-prompts with the Zod error at most twice, then EM-4301; no partially parsed output is ever used. | Must | fake-provider tests with malformed replies | AI-005 |
| TR-061 | Tools are registered in `packages/agents/runtime/ToolRegistry` with Zod input/output schemas and a permission table (AGENT_DESIGN.md §2.4); the registry type has no way to register a tool that executes shell, filesystem or network actions. | Must | registry unit test (attempt to register a forbidden tool fails to compile/throws) | AI-006, AI-020 |
| TR-062 | All outbound HTTP from the Service goes through one `Egress` module; Private Mode makes it throw EM-8202 before any socket is opened; provider adapters, model downloads and the updater receive their `fetch` from `Egress`. | Must | network capture with Private Mode on shows zero outbound connections | PRD-020, AI-017 |
| TR-063 | Provider timeouts: 30 s to first token, 120 s total; one retry with backoff; 429 honours `Retry-After` up to 20 s once; every call records a `usage_records` row. | Must | fake-provider timing tests | AI_WORKFLOW.md §12 |
| TR-064 | Model Assignment is per agent; the Providers screen refuses models without JSON output capability and warns below 32k context (Capability Table from the provider's model list, cached in `provider_connections.models_json`). | Must | unit + UI test | AGD-004, AI-015 |
| TR-065 | Prompts are versioned assets (SYSTEM_PROMPT.md), stored encrypted in the install and decrypted in memory by the bytecode-protected loader; the prompt version is recorded in each `agent_runs` row. | Should | build inspection; log fields | ADR-007 |
| TR-066 | One agent run per agent per project at a time (409 EM-4305); runs are cancellable (AbortSignal propagated to the provider stream). | Must | API tests | ARCHITECTURE.md §9 |

### 3.6 Performance (budgets in PERFORMANCE.md)

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-070 | The implementation meets PERFORMANCE.md §5 budgets on the reference laptop (T0, 16 GB): cold start ≤ 5 s, seek ≤ 100 ms, hover → preview ≤ 300 ms, idle RAM ≤ 450 MB, Standard render peak ≤ 40 % RAM. "To confirm" values are re-baselined after POC-007 and recorded in PERFORMANCE.md, not here. | Must | PT in TEST_PLAN | PERFORMANCE.md §5 |
| TR-071 | Hardware Tier detection (T0/T1/T2) runs at startup with `systeminformation` and is cached; the cheap meter (Node `os`) runs every 2 s with < 1 % CPU and < 20 MB RAM overhead. | Must | profiler run | PERFORMANCE.md §1, §6 |
| TR-072 | Export preflight implements PERFORMANCE.md §7 (disk, memory, dimensions, duration, assets, binaries, licence) and refuses to enqueue on a blocking check. | Must | unit tests per check | PRD-014 |
| TR-073 | Ingest parallelism is 2; ingest and model downloads pause while a render runs on Standard/Accelerated (PERFORMANCE.md §2). | Should | integration test | PERFORMANCE.md §2 |

### 3.7 Security (controls in SECURITY.md `SEC-`)

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-080 | Implement the SECURITY.md control set for: Service Token, Host/Origin guards, path confinement for media and output folders (EM-8302, EM-1007), import validation (magic bytes + ffprobe, size and dimension limits), Electron hardening fuses (`RunAsNode` off, `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on, ASAR integrity), signed installer and updates, no production source maps, secret redaction in logs. | Must | VULNERABILITY_CHECKLIST | PRD-016, ADR-007 |
| TR-081 | File-system access from the API is confined: media under the media root, outputs under the Creator-chosen output folder inside the user profile or removable drives, imports only from paths the Shell dialog returned or the Creator dropped (the Service canonicalises and rejects traversal). | Must | API tests with `..`, UNC, device paths | SEC- |
| TR-082 | Secrets (Service Token, Database Key, provider keys, licence token) never appear in logs, diagnostics bundles, error messages, SSE payloads or the DOM. | Must | log scan test with planted secrets | SEC- |

### 3.8 Packaging (steps in DEPLOYMENT_AND_PACKAGING.md)

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-090 | The installer is a signed NSIS x64 per-user installer ≤ 450 MB containing Shell, Editor, Service, Engine bundle, Chrome Headless Shell, FFmpeg and catalogue loops; model weights are never inside (ADR-008). | Must | clean-VM install; size check | PRD-001, PERFORMANCE.md §5 |
| TR-091 | Updates are delivered with `electron-updater` from a static feed (`latest.yml`), signature-verified, applied on restart, with rollback of an interrupted update (EM-8104); update checks go through `Egress` (Private Mode blocks them). | Must | update test with a tampered package | BRD-015, PRD-020 |
| TR-092 | Uninstall removes the install directory; app data under `%APPDATA%\Expertmotion` is kept unless the Creator ticks "also remove my projects" (documented). | Should | uninstall test | brief §12 |

### 3.9 Logging and diagnostics

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-100 | Logs are JSON lines (`pino`) in `logs\service.log` and `logs\shell.log` with the common fields of ERROR_CATALOGUE.md §5 (`ts, level, code, subsystem, projectId?, sessionId, component, message, cause, stack`); level `info` by default, `debug` with `EM_LOG_LEVEL=debug`. | Must | log schema test | ERROR_CATALOGUE.md §5 |
| TR-101 | Rotation: daily files, 7 days kept, 20 MB per file cap; rotation never blocks a request. | Must | long-run test | ARCHITECTURE.md §9 |
| TR-102 | Redaction before write by key (`authorization`, `token`, `apiKey`, `secret`, `dbKey`, `licence`) and by pattern (`Bearer …`, `sk-…`, `sk-or-…`, `AIza…`, 32+ hex runs next to `key`); file paths of imported media are hashed in logs unless `EM_LOG_PATHS=1` in development. | Must | planted-secret test | TR-082 |
| TR-103 | The Diagnostics bundle (`POST /diagnostics/bundle`) is a zip containing: `service.log` + `shell.log` (last 7 days, redacted), `versions.json` (app, Electron, Remotion, Chrome Headless Shell, FFmpeg, bundleVersion), `hardware.json` (tier, CPU, RAM, GPU, disk free), `settings.json` (non-secret settings, Private Mode state), `license.json` (status, tier, `updatesUntil`, fingerprint hash prefix only), `projects.json` (ids, names, version counts, last error codes), `render-jobs.json` (last 20 jobs with codes and `error_detail`), `migrations.json`, `env.json` (OS version, locale, `EM_*` flags present, never values). No media, no Composition Model contents unless the Creator ticks "include project structure" (then `model_json` with text contents replaced by lengths). | Must | bundle content test | PRD-015, `scr.diagnostics` |
| TR-104 | Crash reporting is local only: the Shell writes `crash-<ts>.json` (reason, versions) into `logs\`; nothing is uploaded. | Must | network capture | BRD-013 |

### 3.10 Internationalisation

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-110 | Every Creator-facing string in the Editor and every `EM-` copy is an i18n key with `en.json` and `id.json` values (scheme in ACCESSIBILITY_AND_I18N.md); a missing `id` value fails the build; the UI language is English in MVP (ADR-012). | Must | lint | UX-041, BRD-014 |
| TR-111 | Numbers, dates and units are formatted with `Intl` using the UI locale; Composition text uses `formatNumber(value, ProjectSettings.language)`. | Must | unit tests | BLUEPRINT.md §5.2 |
| TR-112 | Agents receive the project language and reply in it; preset labels in replies use the `id`/`en` label from the catalogue. | Must | fake-provider test | UX-042 |
| TR-113 | The forbidden-word lint (Remotion, React, Node, npm, Chrome, Chromium, FFmpeg, JSON, SQLite, Electron, stack trace, token in its technical sense) runs on `en.json`/`id.json`. | Must | lint | UX-040 |

### 3.11 Testing

| ID | Requirement | Priority | Verification | Traces |
|---|---|---|---|---|
| TR-120 | Unit tests with Vitest for every package; **line coverage ≥ 90 % for `packages/composition-model` and `packages/agents/src/intents`**, ≥ 70 % for the rest of `packages/*` and `apps/service`; coverage is enforced in CI per package. | Must | `vitest --coverage` thresholds | brief §19 |
| TR-121 | Golden Scenarios (GOLDEN_SCENARIOS.md) run in three modes: Compile path (pure), fake provider replaying recorded EditPlans, live provider on demand; the first two run in CI. | Must | CI job | AI_WORKFLOW.md §13 |
| TR-122 | API contract tests exercise every route in API_SPECIFICATION.md for success, 400, 401, 403, 404 and 409 where applicable, generated from the route table so a new route without tests fails CI. | Must | CI job | TR-020 |
| TR-123 | Render tests cover the P0 matrix (7 ratios × 720p/1080p, 30 fps, 3 clips, 2 transitions, captions) with ffprobe assertions and golden-frame parity; they run on Windows hardware only (never on the Linux dev server). | Must | TEST_PLAN render matrix | TR-048, TR-051 |
| TR-124 | Playwright e2e covers the P0 vertical slice (BLUEPRINT.md §7) and user flows F1–F8 (USER_FLOWS.md) against a dev Local Service with a fake provider; the Electron variant runs on Windows. | Must | CI (browser) + Windows job (Electron) | PRD §7 |
| TR-125 | Security tests: token/Origin/Host negatives, path traversal, oversized bodies, malformed media (fuzzed headers), planted secrets in logs; part of VULNERABILITY_CHECKLIST automation. | Must | CI job | PRD-016 |
| TR-126 | Fakes exist for every external boundary: `ProviderAdapter` (recorded replies), `RenderAdapter` (no Chrome), `Egress` (throwing/recording), `EngineAdapter` (models), `safeStorage` (identity in dev), so the whole service suite runs headless in < 2 minutes within the Linux cgroup cap. | Must | CI timing | ARCHITECTURE.md §9 "Testing seams" |

### 3.12 Coding standards

| ID | Requirement | Priority | Verification |
|---|---|---|---|
| TR-130 | TypeScript `strict` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`; `any` is forbidden (`@typescript-eslint/no-explicit-any: error`); `unknown` + Zod at every boundary (HTTP, DB JSON, provider output, IPC, stdin handshake, files). | Must | lint + `tsc -b` |
| TR-131 | Types are derived from Zod schemas (`z.infer`), never duplicated by hand; a schema lives in exactly one package (ownership table in BLUEPRINT.md §4). | Must | review |
| TR-132 | `packages/composition-model` and `packages/agents/src/intents` are pure: no I/O, no `Date.now()`/`Math.random()` without injection (`ctx.now`, `ctx.newId`), no global state; functions return new objects and never mutate inputs (`readonly` types, `Object.freeze` in tests). | Must | lint rules (`no-restricted-imports` for `node:*`), mutation tests |
| TR-133 | ESM everywhere (`"type": "module"`), named exports only, no default exports except React lazy components; import boundaries per BLUEPRINT.md §2.1 enforced by ESLint. | Must | lint |
| TR-134 | Errors: throw `EmError` with an `EM-` code at the point where the failure is understood; never throw strings; never catch-and-ignore without a logged reason; `console.*` is forbidden in `apps/service` and `packages/*` (use the `Logger`). | Must | lint (`no-console`), review |
| TR-135 | React: function components, hooks, no class components; state that mirrors the Local Service is fed only by API responses and SSE (no optimistic Composition Model edits); every interactive element has `data-el`. | Must | review, UI lint for `data-el` |
| TR-136 | Formatting by Prettier (project config), lint by ESLint 9 flat config, pre-commit hook runs `lint-staged` (format + lint + `tsc -b` for touched packages); CI runs `npm run typecheck && npm test && npm run lint`. | Must | CI |
| TR-137 | Public functions in `packages/*` have a one-paragraph JSDoc stating inputs, outputs, purity and the owning document; no commented-out code is committed. | Should | review |
| TR-138 | Naming follows GLOSSARY.md in identifiers that face other developers (`EditIntent`, `EditPlan`, `CompositionVersion`, `RenderJob`, `DesignPreset`, `PerformanceProfile`); the words Studio, scene, template (for presets) and prompt (for picks) do not appear in new code. | Should | grep gate on `src/**` |

## 4. Environment variables and configuration keys (development)

Production receives its configuration from the stdin handshake (TR-002) and the `settings` table; environment variables are **development only** and are ignored when the handshake is present, except `EM_LOG_LEVEL`.

| Variable | Default | Meaning |
|---|---|---|
| `EM_PORT` | `4100` on the shared Linux server (ports 3000/4000 belong to another tenant), otherwise `47600` | Local Service port when no handshake is present |
| `EM_DATA_DIR` | `./.em-data` (git-ignored) in development; `%APPDATA%\Expertmotion` in production | root of `data\`, `media\`, `outputs\`, `models\`, `logs\` |
| `EM_TOKEN` | none (the Service generates one and prints it once when absent) | **dev-only** fixed Service Token so the Vite Editor and curl can authenticate; refused when a handshake is present |
| `EM_DB_KEY_HEX` | none (dev: derived from a file `.em-data/dev.key` created on first run) | **dev-only** Database Key; never set in production |
| `EM_PRIVATE_MODE` | unset | `1` forces Private Mode on at startup regardless of settings (tests, air-gapped development) |
| `EM_ENGINE_BUNDLE_DIR` | `resources/engine/bundle` | folder passed as `serveUrl`; `npm run build:engine` fills it |
| `EM_BROWSER_EXECUTABLE` | bundled path; dev: Remotion's downloaded Headless Shell | override for development only |
| `EM_ALLOW_BROWSER_DOWNLOAD` | `0` | `1` lets `ensureBrowser` download in development (never set in production) |
| `EM_UI_PORT` | `5173` | Vite dev server port; also the allowed dev Origin |
| `EM_UI_ORIGIN` | `http://127.0.0.1:5173` | extra allowed Origin in development |
| `EM_LOG_LEVEL` | `info` | `debug` enables verbose logs (also honoured in production via the Shell's `--log-level` flag) |
| `EM_LOG_PATHS` | `0` | `1` logs raw file paths instead of hashes (development) |
| `EM_RENDER_CONCURRENCY_MAX` | unset | caps `renderMedia.concurrency` for every profile (set `1` on the shared server) |
| `EM_MEMORY_CEILING_MB` | unset | lets the preflight treat this as total RAM (shared server: `900`) |
| `EM_FAKE_PROVIDER` | unset | `replay:<dir>` uses recorded provider replies; `throw` makes any provider call fail (tests) |
| `EM_FAKE_RENDER` | unset | `1` replaces `RenderAdapter` with a fake that writes a tiny valid MP4 from `test/fixtures` (service tests on Linux) |

Configuration keys in the `settings` table (non-secret, `GET/PUT /settings`): `privateMode`, `outputFolder`, `autoPlan`, `uiLanguage`, `theme`, `defaultPerformanceProfile`, `defaultRatio`, `defaultResolution`, `defaultFps`, `checkUpdates`, `diagnosticsIncludeStructure`. Secret settings are never in `settings` (provider keys → `provider_connections.secret_enc`, licence → `license.token_enc`).

## 5. Development-server constraints (shared Linux host)

Facts (ASSESSMENT.md §1, CLAUDE.md of the predecessor): Ubuntu 24.04, 1.9 GB RAM, 2 CPUs, no display, shared with another tenant (ports 3000/4000, PostgreSQL, nginx), swap already in use.

| Rule | Detail |
|---|---|
| Headless only | `packages/*` unit tests, `apps/service` integration tests with `EM_FAKE_RENDER=1`, `apps/ui` Vitest component tests, Vite build, small `renderStill` smoke tests (≤ 720p, 1 frame). No Electron (cannot run or build without a display), no `renderMedia` of more than 5 s, no catalogue-loop build, no Playwright Electron. |
| Memory cap | Run everything under a systemd user cgroup equivalent to the predecessor's `dev:capped`: `MemoryHigh=900M`, `MemoryMax=1200M`, `MemorySwapMax=256M`, `NODE_OPTIONS=--max-old-space-size=512`. Keep `EM_RENDER_CONCURRENCY_MAX=1`, `EM_MEMORY_CEILING_MB=900`. Measure `memory.current` before and after any new long-running test. |
| Ports | `EM_PORT=4100`, `EM_UI_PORT=5173`; never 3000 or 4000; the Service still binds `127.0.0.1` only. |
| Single Chrome | at most one Chrome Headless Shell process (`concurrency: 1`); kill it after each test file (`afterAll`). |
| No long-lived caches | no in-memory bundle, media or model caches in tests; stills cache on disk only. |
| Windows machine or CI | required from Stage 2 (BRD-016) for: Electron packaging, full renders, catalogue loops, Playwright Electron, parity tests, hardware tier tests. |

## 6. Compatibility matrix

| Target | v1.0 (MVP) | Later |
|---|---|---|
| Windows 10 21H2+ x64 | **supported** (minimum 8 GB RAM, 5 GB free disk + models; recommended 16 GB) | — |
| Windows 11 x64 | **supported** (reference) | — |
| Windows arm64 | not supported (no Chrome Headless Shell win-arm64 in Remotion's list) | evaluate |
| macOS 13+ (arm64, x64) | not supported (PRD-055) | Developer ID + notarization, `safeStorage` Keychain, Chrome Headless Shell mac-arm64/mac-x64 |
| Ubuntu 22.04+ x64 (glibc ≥ 2.35) | not supported (PRD-055); development of headless parts only | `safeStorage` may fall back to `basic_text` → must be detected (ASSESSMENT.md §6) |
| GPU | none (T0, `swangle`), ≥ 4 GB (T1, `angle`), ≥ 8 GB (T2, NVENC with driver ≥ 525) | WebGPU effects when Chrome Headless Shell supports them on the target |
| Display | 1280×720 minimum, 1024 px wide degraded (UX-050) | — |
| Browsers (development only) | Chromium-based browser matching the Electron Chromium major for the Vite Editor | — |

## 7. Requirement traceability

| Area | TR ids | Serves |
|---|---|---|
| Runtime | TR-001…010 | PRD-001, ADR-004, ADR-005, UX-032 |
| API | TR-020…027 | API_SPECIFICATION.md, ADR-005, AI-013 |
| Data | TR-030…038 | PRD-003, PRD-004, ADR-006, DATABASE_SCHEMA.md |
| Engine | TR-040…053 | PRD-008, PRD-009, PRD-013, PRD-014, PRD-017, ADR-001, ADR-008, ADR-010, ADR-011 |
| Agents | TR-060…066 | PRD-010, PRD-011, PRD-012, PRD-020, AI-001…020, AGD-001…006 |
| Performance | TR-070…073 | PRD-019, PERFORMANCE.md |
| Security | TR-080…082 | PRD-016, SECURITY.md |
| Packaging | TR-090…092 | PRD-001, BRD-015, DEPLOYMENT_AND_PACKAGING.md |
| Logging | TR-100…104 | PRD-015, BRD-013, ERROR_CATALOGUE.md §5 |
| i18n | TR-110…113 | ADR-012, BRD-014, UX-040…042 |
| Testing | TR-120…126 | brief §19, PRD §7 |
| Standards | TR-130…138 | DEFINITION_OF_DONE.md |
