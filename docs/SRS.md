# Software Requirements Specification (SRS)

| Field | Value |
|---|---|
| Status | baseline (targets marked "to confirm" are re-measured in the Stage 2 PoC, PERFORMANCE.md §5) |
| Owner | Requirements engineer + principal architect |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, PRD.md, FRD.md, ARCHITECTURE.md, PERFORMANCE.md, AI_WORKFLOW.md, DECISIONS.md, ELEMENT_IDS.md, ERROR_CATALOGUE.md, SECURITY.md, DATABASE_SCHEMA.md, MASTER_PROJECT_PROMPT.md §4, §9, §11–§16, §19 |
| Used by | TRD.md, API_SPECIFICATION.md, DATABASE_SCHEMA.md, SECURITY.md, TEST_PLAN.md, DEPLOYMENT_AND_PACKAGING.md, ACCESSIBILITY_AND_I18N.md, DEFINITION_OF_DONE.md |
| Owner of | every `NFR-` id, its metric, target and measurement method |
| ID range | NFR-001 … NFR-199 (blocks per category in §5.0) |

Structure follows IEEE 830: 1 Introduction, 2 Overall description, 3 External interface requirements, 4 System features (pointer to FRD.md), 5 Non-functional requirements, 6 Other requirements. Terms are used exactly as defined in GLOSSARY.md and are not redefined here.

## 1. Introduction

### 1.1 Purpose

This SRS states the externally visible quality attributes, interface constraints and limits that Expertmotion v1.0 must satisfy, so that TRD.md can choose implementations, TEST_PLAN.md can measure them, and DEFINITION_OF_DONE.md can gate releases. Functional behaviour is in FRD.md (FR-001…FR-178) and is referenced, not repeated.

### 1.2 Scope

Expertmotion is a local-first, AI-assisted motion video editor delivered as a Windows desktop executable (GLOSSARY ▸ Expertmotion). In scope for this SRS: the Desktop Shell, the Local Service, the Editor, the Engine, the Engine Binaries, and their interfaces to the operating system, the filesystem, external LLM providers, model weight hosts and the update feed. Out of scope: cloud rendering, accounts, collaboration, mobile and web-hosted versions (PRD §4.4).

### 1.3 Definitions, acronyms, abbreviations

All product terms: GLOSSARY.md. Identifier prefixes (`PRD-`, `FR-`, `NFR-`, `AI-`, `SEC-`, `QA-`, `EM-`, `preset:`, `op:`, `el:`): GLOSSARY ▸ Identifier prefixes. Hardware Tiers T0/T1/T2 and Performance Profiles: PERFORMANCE.md §1–§2.

### 1.4 References

| Document | Used for |
|---|---|
| MASTER_PROJECT_PROMPT.md | the brief; §4 principles, §9 providers, §11 storage, §12 packaging/security, §13 output, §14 hardware, §16 UI rules, §19 QA |
| PRD.md | scope, personas, success metrics, reference hardware (§6) |
| FRD.md | functional requirements |
| ARCHITECTURE.md | processes, modules, lifecycle, filesystem layout |
| PERFORMANCE.md | budgets, tiers, profiles, pixel table, preflight |
| AI_WORKFLOW.md | schemas, limits (≤ 40 steps, ≤ 200 ops), failure handling |
| ERROR_CATALOGUE.md | EM codes |
| SECURITY.md | SEC-001…SEC-096 controls referenced by §5.4 |
| API_SPECIFICATION.md (planned) | Local Service routes and SSE events |
| DATABASE_SCHEMA.md | DDL, Composition Model JSON Schema (`schemaVersion`), version hashing (§4.5), checkpoints, backup format (§7), retention (§8) |

### 1.5 Overview

§2 describes the product and its environment; §3 the interfaces; §5 the measurable non-functional requirements, each with id, statement, metric, target, measurement method, priority and related FR/PRD; §6 the Composition Model interface constraints, logging and data retention.

## 2. Overall description

### 2.1 Product perspective

Expertmotion is a self-contained desktop application composed of three processes plus child processes (ARCHITECTURE.md §1, §3):

| Component | Role | Boundary |
|---|---|---|
| Desktop Shell (Electron main) | window, lifecycle, OS credential store, updater, tray, native dialogs | talks to the OS and spawns the Local Service |
| Local Service (Node.js) | all state and logic: encrypted SQLite, Composition Model, Intent Compiler, agent runtime, render queue, Model Manager, Hardware Monitor, licence | HTTP + SSE on `127.0.0.1`, Service Token |
| Editor (React in the renderer) | presentation and interaction; Remotion Player | talks only to the Local Service |
| Engine | prebuilt Remotion bundle `ExpertmotionTimeline`, Chrome Headless Shell, FFmpeg | child processes of the Local Service |
| Engine Binaries | whisper.cpp, sherpa-onnx, stable-diffusion.cpp, optional embedded Python | one task per process, files in, files out |

External systems reached only from the Local Service and only when configured: LLM providers (OpenRouter P0; OpenAI, Anthropic, Google Gemini P1), model weight hosts, the signed update feed. Private Mode removes all three (PRD-020).

### 2.2 Product functions (summary)

| Function group | FRD group | Key FRs |
|---|---|---|
| Lifecycle and onboarding | 1 | FR-001…FR-008 |
| Projects, settings, recovery, backup | 2, 16 | FR-009…FR-019, FR-164…FR-178 |
| Text, designs, assets | 3, 4, 5 | FR-020…FR-054 |
| Preview and timeline | 6 | FR-055…FR-069 |
| Agents, intents, plans, output settings | 7 | FR-070…FR-099 |
| Generators | 8 | FR-100…FR-108 |
| Providers, models, hardware, licence | 9–12 | FR-109…FR-135 |
| Export | 13 | FR-136…FR-147 |
| Help, diagnostics, updates, Private Mode | 14, 15 | FR-148…FR-163 |

### 2.3 User classes and characteristics

| Class | Description | Relevant NFRs |
|---|---|---|
| Creator (primary; persona "Septi", PRD §2) | Indonesian content creator or small business owner, no editing team, no coding, mid-range Windows laptop, expects CapCut-level ease; reads English UI, prefers Indonesian content | usability (§5.8), i18n (§5.9), performance on T0 (§5.1) |
| Operator (Andre) | builds, signs, licences and supports; needs diagnostics without telemetry | logging (§6.2), maintainability (§5.6), security (§5.4) |
| Coding agents and contributors | maintain the codebase from documentation alone (PRD-021) | maintainability (§5.6) |

### 2.4 Operating environment

| Item | Minimum | Reference (PRD §6) |
|---|---|---|
| OS | Windows 10 64-bit (version 1809 or later) | Windows 11 |
| CPU | 4 threads x86-64 | Intel i5 8th gen or newer / Ryzen 5 |
| RAM | 8 GB | 16 GB |
| GPU | none required (T0) | integrated (T0); optional NVIDIA ≥ 4 GB (T1) / ≥ 8 GB (T2) |
| Disk | 5 GB free for app and data (plus models: 0.5–8 GB each) | SSD |
| Display | 1280×720 logical pixels, 100 % scaling | 1920×1080, up to 200 % scaling |
| Network | none required; internet only for providers, Model Downloads, updates | — |
| Privileges | standard user; no admin rights to run | — |
| Preinstalled software | none (no Node.js, Python, C++ toolchain, npm, browser) | — |

### 2.5 Design and implementation constraints

| Constraint | Source |
|---|---|
| One generic Remotion composition driven by a JSON Composition Model; no runtime code generation or bundling | ADR-001 |
| Deterministic Compile first; LLM only for interpretation; Execute is the only mutation gate | ADR-002, AI-001…AI-007 |
| Electron shell; Local Service as HTTP + SSE on loopback with Service Token | ADR-004, ADR-005 |
| Encrypted SQLite with OS-wrapped key; media on filesystem | ADR-006 |
| Defence-in-depth IP protection with honest boundaries | ADR-007 |
| Model weights downloaded on first use; runtime bundled | ADR-008 |
| Performance Profiles are resource policies, frame rate is a Project Setting | ADR-010 |
| English UI with i18n keys; Indonesian variants for content, onboarding, errors, tour | ADR-012 |
| Offline Ed25519 licence; Trial Mode watermark + 720p | ADR-014 |
| No MCP in MVP; typed in-process Tools | ADR-015 |
| Remotion licence confirmation is a launch blocker | ADR-017 |
| Development server limits (1.9 GB RAM, no display): only headless parts run there | PERFORMANCE §5 note |

### 2.6 Assumptions and dependencies

PRD §6 assumptions apply. Provisional ADRs (008, 009, 016) are assumed accepted. Budgets marked "to confirm" are re-baselined after POC-007 without changing their ids.

## 3. External interface requirements

### 3.1 User interfaces

The Editor is the only user interface. Every element is identified by an Element ID (ELEMENT_IDS.md); FRD.md cites them per requirement; UI_UX_SPECIFICATION.md owns visuals and copy. Minimum window 1280×720; three-column layout with the collapse order Library Panel → Agent Panel → Stage (FR-099). Full-screen dialogs (`scr.*`) are modal and keyboard-dismissable. Toasts, banners and chips (`sys.*`) never cover the Player controls.

### 3.2 Software interfaces

| Interface | Direction | Contract | Constraints |
|---|---|---|---|
| Local Service REST API | Editor → Local Service | API_SPECIFICATION.md (routes under `/api`, JSON, Zod-validated; errors as `{code: 'EM-xxxx', message, details?}`) | loopback only; `Authorization: Bearer <Service Token>`; Host/Origin allow-list; body ≤ 2 MB except media upload routes; 409 on concurrent agent run or Execute |
| Local Service SSE | Local Service → Editor | `/api/events` with events `service.ready`, `intent.updated`, `plan.ready`, `composition.updated`, `render.progress`, `render.done`, `ingest.progress`, `download.progress`, `provider.status`, `usage.updated`; 15 s heartbeat | token in query string (EventSource limitation), single-use per launch |
| Media serving | Local Service → Editor Player and Engine Chrome | `/media/:assetId` (original or proxy) with unguessable ids, range requests | loopback only; ids are 128-bit random |
| Shell ↔ Service control | Desktop Shell → Local Service | `{token, port, dataDir, dbKey}` over stdin at spawn; `ready` on stdout; SIGTERM for shutdown; checkpoint request before close | secrets never in argv or environment |
| Shell ↔ Editor | preload `contextBridge` | `{port, token}`, native dialogs (file/folder pickers, open folder), window controls | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| LLM providers | Local Service → provider | HTTPS JSON per provider (OpenRouter OpenAI-compatible chat completions with tools / JSON mode; others P1) via a provider adapter interface with a fake for tests | 30 s first-token / 120 s total timeout, one retry, `Retry-After` ≤ 20 s once (AI_WORKFLOW §12); responses Zod-validated (AI-005); single egress module |
| Model weight hosts | Local Service → host | HTTPS GET with range resume; SHA-256 manifest | hash verified before use; paused in Private Mode |
| Update feed | Desktop Shell → feed | electron-updater compatible feed; signed packages | signature verified before install; never during a render |
| Engine (Remotion) | Local Service → `@remotion/renderer` | `selectComposition` + `renderMedia` / `renderStill` with `serveUrl` = bundled folder, `inputProps` = Composition Model version + resolved media URLs | prebuilt bundle; no webpack at runtime; `inputProps` ≤ 2 MB |
| Engine Binaries | Local Service → child process | CLI arguments and files under app data; stdout progress parsing | no network; no proxy variables; killed on cancel/timeout |
| Windows DPAPI | Desktop Shell → OS | Electron `safeStorage` encrypt/decrypt of the Database Key | fails closed (EM-6001) |
| Filesystem | Local Service → OS | layout in ARCHITECTURE §8 | writes only under app data, the Project output folder and Creator-chosen allowed locations |

### 3.3 Hardware interfaces

| Interface | Use | Rule |
|---|---|---|
| GPU detection | `systeminformation.graphics()` for vendor, model, VRAM; nvidia-smi when present for utilisation | at startup, on opening the Hardware Monitor, before render; never more often than every 30 s (PowerShell cost on Windows); absence of a GPU never blocks the core workflow |
| CPU and memory meter | Node `os` every 2 s | overhead < 1 % CPU, < 20 MB RAM (NFR-009) |
| Disk | `systeminformation.fsSize()` | data drive and output drive; thresholds in PERFORMANCE §1, §7 |
| Hardware acceleration | NVENC via `hardwareAcceleration: 'if-possible'` on T2 (NVIDIA driver ≥ 525) | silent fallback to software with EM-3401 info |
| Removable drives | export and backup targets | allowed; unplugging mid-write yields EM-3204 / EM-6301, never a crash |

### 3.4 Communications interfaces

All inter-process communication is on `127.0.0.1` over HTTP/1.1 and SSE (ADR-005); no other listening sockets exist. Outbound traffic is HTTPS only (TLS 1.2+), from the single egress module, to the configured provider hosts, model hosts and update feed. No UDP, no multicast, no mDNS.

## 4. System features

System features are specified as functional requirements in FRD.md, grouped 1–16 with acceptance criteria and verification methods. This SRS adds no functional requirements.

## 5. Non-functional requirements

### 5.0 Conventions and id blocks

| Column | Meaning |
|---|---|
| Metric | what is measured and its unit |
| Target | the pass threshold for v1.0; "(to confirm)" = re-baselined after POC-007 |
| Measurement | how TEST_PLAN.md measures it: `bench` (scripted benchmark on reference hardware), `profiler` (OS/Chromium tools), `netcap` (network capture), `audit` (code/config review), `usability` (moderated test, 5 participants), `beta` (diagnostics logs from beta installs, opt-in, local export only), `unit`/`int`/`e2e` (automated tests) |
| Priority | MoSCoW + PRD tier |

| Block | Category |
|---|---|
| NFR-001 … NFR-019 | Performance |
| NFR-020 … NFR-029 | Reliability |
| NFR-030 … NFR-039 | Availability |
| NFR-040 … NFR-049 | Security |
| NFR-050 … NFR-059 | Privacy |
| NFR-060 … NFR-069 | Maintainability |
| NFR-070 … NFR-079 | Portability |
| NFR-080 … NFR-089 | Usability and accessibility |
| NFR-090 … NFR-099 | Internationalisation |
| NFR-100 … NFR-109 | Scalability and limits |
| NFR-110 … NFR-119 | Logging and diagnostics |
| NFR-120 … NFR-129 | Data retention and lifecycle |
| NFR-130 … NFR-139 | Composition Model and interface constraints |

### 5.1 Performance (NFR-001 … NFR-019)

Reference hardware = PRD §6 T0 laptop unless stated. Budgets are owned by PERFORMANCE.md §5; this table states them as requirements.

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-001 | Cold start from `Expertmotion.exe` launch to an interactive Editor (Player frame visible, menus responsive) shall complete quickly. | wall-clock seconds, 95th percentile of 10 cold starts | ≤ 5 s (to confirm) | bench | M / P0 | FR-001, FR-003, PRD-001 |
| NFR-002 | Player seek in Draft quality shall feel instant. | ms from scrubber release to frame paint, p95 | ≤ 100 ms | profiler, e2e | M / P0 | FR-056, PRD-009 |
| NFR-003 | Catalogue Card hover shall update the live Player promptly. | ms from hover start (after the 150 ms intent delay) to Player update, p95 | ≤ 300 ms | e2e, profiler | M / P0 | FR-033, ADR-011 |
| NFR-004 | Ingest of a 1 min 1080p30 H.264 clip (probe + proxy + thumbnails + waveform) shall finish quickly. | seconds | ≤ 20 s | bench | M / P0 | FR-042, PRD-005 |
| NFR-005 | Render of the standard workload (30 s, 1080p30, 3 Clips, 2 transitions, captions, Standard profile) shall finish within budget. | seconds | ≤ 90 s (≈ 3× realtime, to confirm) | bench | M / P0 | FR-141, PRD-014 |
| NFR-006 | Same workload with Turbo on T2 hardware. | seconds | ≤ 30 s (to confirm) | bench on T2 desktop | S / P1 | FR-090, PRD-035 |
| NFR-007 | Idle memory of the whole application (Shell + Service + Editor, no render) shall be bounded. | MB working set, 5 min after start with a 3-clip Project open | ≤ 450 MB | profiler | M / P0 | FR-001, ARCHITECTURE §9 |
| NFR-008 | Peak memory during a Standard render shall stay within the profile ceiling and never cause swap thrashing. | peak working set of all Expertmotion processes incl. Chrome children, as % of total RAM; page-fault rate | ≤ 40 % (16 GB → ≤ 6.4 GB); no sustained hard-fault storm > 5 s | profiler | M / P0 | FR-141, PERFORMANCE §2 |
| NFR-009 | Hardware Monitor overhead shall be negligible. | CPU % and MB attributable to the meter | < 1 % CPU, < 20 MB | profiler | M / P0 | FR-127, PERFORMANCE §6 |
| NFR-010 | Local UI interactions (menu open, tab switch, selection, search filter, intent queue update) shall respond within one perceptual frame budget. | ms to visual response, p95 | ≤ 100 ms | e2e | M / P0 | FR-034, FR-065, FR-078 |
| NFR-011 | Execute of a valid Edit Plan (≤ 200 ops) shall apply and propagate quickly. | ms from click to `composition.updated` received by the Editor, p95 | ≤ 1 000 ms; SSE propagation ≤ 500 ms | int, e2e | M / P0 | FR-082 |
| NFR-012 | Deterministic Compile of a Design Pick shall apply and refresh the Player without noticeable delay. | ms from card click to Player refresh, p95 | ≤ 500 ms | e2e | M / P0 | FR-036, AI-003 |
| NFR-013 | Provider round trips shall be bounded by timeouts, not by waiting. | first-token timeout; total timeout | 30 s; 120 s; one retry with backoff | int (fake provider) | M / P0 | FR-075, FR-080, AI_WORKFLOW §12 |
| NFR-014 | Export preflight shall complete before the Creator notices a wait. | ms for all PERFORMANCE §7 checks | ≤ 1 500 ms (GPU/disk probes cached ≤ 30 s) | bench | M / P0 | FR-139 |
| NFR-015 | Installer and footprint shall be bounded. | MB | installer ≤ 450 MB; app data baseline ≤ 200 MB (+ media + models); catalogue loops ≤ 40 MB | audit at build | M / P0 | PERFORMANCE §5, ADR-008 |
| NFR-016 | Autosave and checkpoint writes shall not block interaction. | ms main-thread stall in the Editor; service write time | 0 ms stall (async); write ≤ 200 ms for a 2 MB model | profiler, int | M / P0 | FR-165, FR-166 |
| NFR-017 | Render progress and ETA shall update at a steady rate. | update interval; ETA availability | progress every ≤ 1 s (throttled); ETA after 5 % | int | M / P0 | FR-141 |
| NFR-018 | Local generators shall complete within documented bounds on the recommended tier or be stopped. | wall-clock | voice 100 words ≤ 60 s (T0); captions 60 s audio ≤ 90 s (T0 small model); thumbnail still mode ≤ 10 s; music 30 s ≤ 3 min (T2); hard timeouts per engine → EM-7102 | bench | S / P1–P2 | FR-101…FR-104 |
| NFR-019 | Preview-to-export parity shall hold. | pixel diff between Player screenshot and `renderStill` at golden frames | ≤ 1 % differing pixels | int (golden frames) | M / P0 | FR-145, PRD §5 |

### 5.2 Reliability (NFR-020 … NFR-029)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-020 | No more than 10 s of work shall be lost on crash or power loss. | age of the newest restorable checkpoint at kill time | ≤ 10 s; restore succeeds in 100 % of 20 kill tests | int, vm | M / P0 | FR-165, FR-166, PRD-003 |
| NFR-021 | A render failure (engine crash, encoder failure, stall, cancel) shall never crash or hang the application. | Editor responsive within N s after the failure; orphan processes | responsive ≤ 10 s; 0 orphan Chrome/FFmpeg processes | int, vm (kill tests) | M / P0 | FR-143, FR-144, PRD-015 |
| NFR-022 | Sessions shall be crash-free. | % of sessions without Shell or Service fatal exit | ≥ 99 % | beta | M / P0 | PRD §5 |
| NFR-023 | The Local Service shall be supervised and restarted with bounded backoff; the Editor shall reconnect automatically. | restart delays; reconnect time; max attempts | 1 s, 3 s, 9 s; reconnect ≤ 5 s after `ready`; 3 attempts then EM-8002 | int, vm | M / P0 | FR-171, ARCHITECTURE §5 |
| NFR-024 | Every mutation of persistent state shall be transactional and leave no partial state; Execute shall be idempotent per `planId`. | DB consistency after fault injection at each step | 100 % consistent; duplicate Execute returns the first result | int (fault injection) | M / P0 | FR-082, FR-164, AI_WORKFLOW §6 |
| NFR-025 | Renders on reference hardware shall succeed. | % successful Render Jobs in the QA render matrix | ≥ 98 % | bench matrix | M / P0 | PRD §5 |
| NFR-026 | Persisted artefacts shall be integrity-checked. | checkpoints with hash; Outputs ffprobe-verified; Model Downloads hash-verified | 100 % | int | M / P0 | FR-145, FR-166, FR-124 |
| NFR-027 | Interrupted work shall be reconciled on start. | Render Jobs / agent runs / ingests left in a running state after start | 0 | int | M / P0 | FR-172 |
| NFR-028 | The Engine browser shall be warmed and health-checked so the first render does not fail for a cold start. | first-render failure rate due to browser start | 0 in 20 cold-start renders | bench | S / P0 | FR-003, FR-141 |
| NFR-029 | Edit Plans from the Editor Agent shall be valid on first attempt with a mid-tier model. | % of golden scenarios producing a `valid` plan without re-prompt | ≥ 90 %; 100 % of Locked Key violations caught; 0 unvalidated mutations | int (golden scenarios, fake and live) | M / P0 | FR-080, AI_WORKFLOW §13 |

### 5.3 Availability (NFR-030 … NFR-039)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-030 | All core functions (project, import, picks, timeline, preview, export, backup, licence verification, diagnostics) shall work with no network connection. | features passing the offline test suite | 100 % of FRD groups 1–6, 12–14, 16 | e2e offline, vm | M / P0 | FR-163, PRD-020 |
| NFR-031 | The product shall not depend on a single provider. | number of providers selectable; behaviour when one is down | OpenRouter in P0 (gives access to multiple vendors' models), 4 providers by P1; any provider failure degrades to EM-4xxx with the other connections usable | int | M / P0 | FR-111, brief §9 |
| NFR-032 | Missing or damaged Engine components shall disable rendering only. | features still usable with EM-3001 present | editing, saving, backup, preview of stills via Player | int | M / P0 | FR-140 |
| NFR-033 | Local Models shall remain usable offline once installed. | generator success offline with installed model | 100 % | int | S / P1 | FR-101…FR-104, FR-161 |
| NFR-034 | A single Expertmotion instance per user session shall be enforced; a second launch focuses the first. | behaviour | EM-8301, first window focused | e2e | M / P0 | FR-001 |

### 5.4 Security (NFR-040 … NFR-049)

Controls are specified as `SEC-` items in SECURITY.md; this section states the requirement and the metric. Threats and non-protected items are in THREAT_MODEL.md.

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-040 | Every Local Service request shall require the per-launch Service Token; requests without or with a wrong token are rejected. | % of routes enforcing the token; rejection status | 100 %; 401 → EM-8004 | int (route enumeration test) | M / P0 | ADR-005, SEC-001…SEC-005 |
| NFR-041 | Requests whose `Host` or `Origin` is not on the allow-list shall be rejected; no cookies are used (no CSRF surface). | % of routes; status | 100 %; 403 → EM-8005 | int | M / P0 | ADR-005, SEC-006, SEC-012 |
| NFR-042 | Project data and provider credentials shall be encrypted at rest: database with ChaCha20-Poly1305 under a 256-bit Database Key wrapped by DPAPI; credentials additionally field-level encrypted. | plaintext recoverable from disk without the Windows user context | none (verified by attempting to open the DB and grep media of secrets) | audit, vm | M / P0 | ADR-006, FR-118, FR-176, PRD-004, SEC-040, SEC-041, SEC-050 |
| NFR-043 | Secrets (provider keys, Service Token, Database Key, licence key) shall never appear in logs, SSE events, UI, diagnostics bundles, crash dumps or process listings. | occurrences found by pattern scan | 0 | int (redaction tests), audit | M / P0 | FR-112, FR-150, ARCHITECTURE §9, SEC-013, SEC-042, SEC-043 |
| NFR-044 | The Electron renderer shall be hardened: `contextIsolation`, `sandbox`, no `nodeIntegration`, CSP without `unsafe-eval`, navigation and `window.open` blocked, ASAR integrity fuses, no production source maps. | checklist items passing | 100 % of VULNERABILITY_CHECKLIST.md Electron items | audit | M / P0 | ADR-004, ADR-007, PRD-016, SEC-020…SEC-033 |
| NFR-045 | Installer and updates shall be code-signed and verified before execution; an unsigned or tampered update is discarded. | signature checks | 100 %; tampered package → EM-8103 | int, vm | M / P0 | FR-152, ADR-007, SEC-090…SEC-096 |
| NFR-046 | Filesystem access by the Local Service shall be restricted to app data, the Project output folder and Creator-chosen allowed locations; imported files are validated by content (probe), not by extension alone; path traversal is rejected. | fuzz cases rejected | 100 % of traversal/symlink/UNC cases → EM-1007 / EM-8302 | int (fuzz) | M / P0 | FR-041, FR-137, SEC-010, SEC-051, SEC-067 |
| NFR-047 | No Tool callable by a model shall execute shell commands, access the filesystem or the network; all mutations go through Execute. | registry audit; attempted misuse | 0 such tools; 0 mutations outside Execute | unit (registry test), audit | M / P0 | AI-006, AI-020, FR-080, SEC-088; tool-layer failures surface as EM-4501…EM-4507 |
| NFR-048 | Request bodies and uploads shall be size-limited and rate-limited per route. | limits | JSON ≤ 2 MB, Composition Model routes ≤ 4 MB (EM-8006); media per FRD §5 table; expensive routes rate-limited per SEC-011 | int | M / P0 | FR-041, SEC-009, SEC-011 |
| NFR-049 | Dependencies shall be integrity-pinned (lockfile, hashes) and scanned for known vulnerabilities before release. | high/critical findings open at release | 0 | audit (CI) | M / P0 | ADR-007, PRD §7, VULNERABILITY_CHECKLIST.md |

### 5.5 Privacy (NFR-050 … NFR-059)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-050 | Expertmotion shall send no telemetry or analytics to the Operator or third parties; diagnostics leave the machine only when the Creator copies the bundle. | outbound destinations observed in normal use | only allow-listed provider hosts, model hosts and the pinned update feed (SEC-071, SEC-082, SEC-096); anything else → EM-8203 | netcap | M / P0 | PRD §4.4, FR-150, FR-158 |
| NFR-051 | What is transmitted to an LLM provider (system prompt, compact project state, intents, Creator messages, attachments, Capability probes) shall be disclosed in the Providers screen and in Help before the first connection is saved. | disclosure present and accurate | yes; audited against the actual envelope schema | audit, e2e | M / P0 | FR-111, AI_WORKFLOW §7, brief §4.1 |
| NFR-052 | Hardware readings, usage records and logs shall stay local. | outbound transmissions of these data | 0 | netcap | M / P0 | FR-127, PERFORMANCE §6 |
| NFR-053 | Private Mode shall produce zero outbound connections from all Expertmotion processes, including Engine Binaries and the Desktop Shell. | outbound connections during a 10 min full-workflow session with Private Mode on | 0 | netcap, vm | M / P0 | FR-156…FR-163, PRD-020, AI-017 |
| NFR-054 | Media and project content shall never be uploaded; only textual summaries and Creator-chosen attachments reach providers. | bytes of media in provider payloads | 0 except attachments the Creator explicitly attached | int (payload inspection) | M / P0 | FR-072, FR-075 |
| NFR-055 | If a third-party component (for example Remotion v5 render telemetry) requires transmission, it shall be disclosed in About and disabled in Private Mode or the component version shall be held. | disclosure and gating present | yes | audit | M / P0 | ADR-017, RISK-001 |

### 5.6 Maintainability (NFR-060 … NFR-069)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-060 | Every process and module boundary (HTTP routes, SSE events, provider responses, Tool inputs, Composition Model, Edit Intent, Edit Plan, Operations, checkpoints, backup manifest) shall be defined by Zod schemas with inferred TypeScript types; no untyped `any` crosses a boundary. | boundaries without a schema | 0 | audit, unit | M / P0 | AI_WORKFLOW §3, DATABASE_SCHEMA.md |
| NFR-061 | Vocabularies shall be closed and single-sourced: Design Presets (DESIGN_CATALOGUE.md), Operations (AI_WORKFLOW.md §5), Element IDs (ELEMENT_IDS.md), EM codes (ERROR_CATALOGUE.md), i18n keys; code shall enumerate them from one registry each. | duplicated enumerations found | 0 | audit (lint rule) | M / P0 | ADR-001, FRD §17.1 |
| NFR-062 | Automated tests shall cover the deterministic core. | coverage of Compile path per P0 preset; golden scenarios automated; Composition Model `applyOps`/`validate` branch coverage | 100 % of P0 presets; 20/20 scenarios on fake provider; ≥ 90 % branches | unit, int (CI) | M / P0 | AI-011, GOLDEN_SCENARIOS.md |
| NFR-063 | Database migrations shall be forward-only, transactional, idempotent and tested from every shipped schema version. | migration test matrix pass | 100 %; failure leaves the previous schema intact (EM-6003) | int | M / P0 | FR-003, DATABASE_SCHEMA.md |
| NFR-064 | All `remotion` and `@remotion/*` packages shall be pinned to one identical version and bumped together; Electron, Chrome Headless Shell and FFmpeg versions are recorded in About and Diagnostics. | version skew found | 0 | audit (CI check) | M / P0 | FR-151, TRD.md |
| NFR-065 | Documentation shall be the source of truth: every FR has acceptance criteria and ≥ 1 QA case, every EM code is defined, every `el:` id exists, every preset has a Remotion mapping; a consistency script enforces this in CI. | traceability matrix gaps | 0 at release | audit (script) | M / P0 | PRD-021, INDEX.md matrices |
| NFR-066 | Provider adapters, the Engine and Engine Binaries shall sit behind interfaces with fakes so the Local Service is testable without network, Chrome or GPUs. | modules testable headless on the development server | Composition Model, intents, agents (fake provider), render queue (fake adapter), ingest (small fixtures) | unit, int | M / P0 | ARCHITECTURE §9 |
| NFR-067 | Adding a Design Preset shall require only: registry row, params schema, component, preview loop, tests; no changes to Editor, Intent Compiler or agent prompts beyond the registry. | files touched per new preset | ≤ 5 plus tests | review | S / P0 | ADR-001, DESIGN_CATALOGUE rule 3 |
| NFR-068 | Runtime system prompts shall be versioned and stored as assets, with a changelog, so agent behaviour changes are traceable. | prompts without version | 0 | audit | M / P0 | SYSTEM_PROMPT.md, ADR-003 |

### 5.7 Portability (NFR-070 … NFR-079)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-070 | v1.0 shall run on Windows 10 64-bit (1809+) and Windows 11 without preinstalled runtimes; unsupported OS versions get EM-8306. | clean-VM install matrix | pass on Win10 22H2, Win11 23H2/24H2 | vm | M / P0 | FR-001, PRD-001 |
| NFR-071 | Architecture and packages shall be OS-neutral so macOS and Linux builds (P2, PRD-055) need only packaging and shell work. | Windows-only code outside `apps/desktop` and the hardware module | 0 (`win32` branches isolated and documented) | audit | S / P0 | ADR-004, PRD-055 |
| NFR-072 | The application shall be functional on the minimum hardware (8 GB RAM, 4 threads, no GPU) with reduced defaults (T0, Standard, ≤ 1080p). | full workflow pass on minimum VM | pass with EM-8305 warning only | vm | M / P0 | FR-006, FR-093, PERFORMANCE §1 |
| NFR-073 | Installation and operation shall require no administrator rights (per-user install under `%LOCALAPPDATA%`), and shall respect Windows display scaling 100–200 %. | UAC prompts; layout defects at 125/150/200 % | 0 prompts; 0 clipped controls | vm, e2e | M / P0 | ARCHITECTURE §8, FR-155 |
| NFR-074 | Project portability across machines and Windows accounts shall be via the backup zip (FR-017/FR-018); the DPAPI binding of the live database is documented as a limitation, never hidden. | restore success on another account/machine | 100 % with all Assets playable | vm | M / P0 | FR-176, FR-177, ADR-006 |

### 5.8 Usability and accessibility (NFR-080 … NFR-089)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-080 | A new Creator shall reach a first export without help. | minutes from first launch to a rendered MP4; completion rate | ≤ 10 min; ≥ 4 of 5 participants | usability | M / P0 | FR-004…FR-008, FR-149, PRD-018, PRD §5 |
| NFR-081 | Text and essential UI graphics shall meet WCAG 2.1 AA contrast. | contrast ratio | ≥ 4.5:1 text, ≥ 3:1 large text and controls | audit (tooling) | M / P0 | UI_UX_SPECIFICATION.md, ACCESSIBILITY_AND_I18N.md |
| NFR-082 | Every action shall be operable by keyboard with visible focus; focus order follows the wireframe reading order; dialogs trap and restore focus. | actions unreachable by keyboard | 0 | e2e (axe + manual) | M / P0 | FR-153, FRD X-5 |
| NFR-083 | The layout shall be fully usable at the minimum window size with no horizontal page scroll. | defects at 1280×720 | 0 clipped controls; three columns visible or collapsible per FR-099 | e2e | M / P0 | FR-099, FR-155, brief §7.4 |
| NFR-084 | Every error shown shall carry a plain-language explanation and a recovery action, per ERROR_CATALOGUE.md style guide; stack traces never appear in the UI. | errors violating the style guide; stack traces in UI | 0 | audit, e2e | M / P0 | ERROR_CATALOGUE §1, §4, PRD-015 |
| NFR-085 | Labels shall be honest: Performance Profiles explain their policy; costs are marked approximate unless provider-reported; encryption claims state their boundary. | copy items audited against PERFORMANCE §2, AI_WORKFLOW §11, ADR-006 | 100 % compliant | audit | M / P0 | FR-091, FR-074, FR-176, brief §13 |
| NFR-086 | The distinction between Creator preference (Intent Queue), proposed interpretation (Plan Card), approved plan (Execute), executed Operation (ExecutionResult) and verified state (Composition Version) shall be visible in the UI at all times. | each of the five states has a distinct visual location | yes | e2e, review | M / P0 | FR-078, FR-081, FR-082, brief §16 |
| NFR-087 | Long-running work (ingest, agent runs, downloads, renders) shall show progress within 1 s of start and never block the UI thread. | time to first progress indication; UI responsiveness during work | ≤ 1 s; interactions ≤ 100 ms (NFR-010) | e2e | M / P0 | FR-042, FR-075, FR-124, FR-141 |
| NFR-088 | Destructive actions shall require confirmation and state exactly what will be lost; nothing is silently overwritten. | destructive actions without confirmation | 0 | e2e | M / P0 | FRD X-2, FR-052, FR-095, FR-018, FR-178 |
| NFR-089 | Screen-reader users shall get announcements for toasts, progress and reorder results. | `aria-live` regions present and tested | yes | e2e (axe), manual | S / P0 | FR-046, FR-154 |

### 5.9 Internationalisation (NFR-090 … NFR-099)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-090 | The UI shall ship in English with every string behind an i18n key; no hard-coded user-facing text in components. | hard-coded strings found | 0 | audit (lint) | M / P0 | ADR-012, ACCESSIBILITY_AND_I18N.md |
| NFR-091 | Indonesian variants shall exist from day one for: error copy, onboarding, tour, Design Preset labels and tags, generator outputs, chat replies when the Creator writes in Indonesian. | keys lacking an ID variant in these groups | 0 | audit (script) | M / P0 | ERROR_CATALOGUE §1, DESIGN_CATALOGUE rule 4 |
| NFR-092 | Generated content (voice, captions, hashtags, social caption text) shall support Indonesian and English selectable per run. | languages offered | id, en | e2e | S / P1 | FR-106 |
| NFR-093 | Numbers, dates and sizes in Indonesian copy shall use Indonesian conventions (1.000,5; "GB"; d MMM yyyy); English copy uses 1,000.5. | formatting defects | 0 | unit | M / P0 | ERROR_CATALOGUE §8 |
| NFR-094 | Fonts bundled for text rendering shall cover Indonesian and English Latin glyphs including diacritics used in loanwords. | missing glyphs in the test string set | 0 | unit (render) | M / P0 | DESIGN_CATALOGUE §10 |
| NFR-095 | Agents shall answer in the language the Creator writes in (id or en) regardless of the UI language. | golden scenario replies in the right language | 100 % | int | M / P0 | SYSTEM_PROMPT.md |

### 5.10 Scalability and limits (NFR-100 … NFR-109)

Limits are enforced with the EM code named; above the limit the application refuses gracefully rather than degrading unpredictably.

| ID | Statement | Metric | Target / limit | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-100 | Composition duration. | ms | 1 s … 30 min (EM-2002 / EM-3104) | unit | M / P0 | FR-015, FR-049, FR-139 |
| NFR-101 | Assets per Project. | count | ≤ 200 (EM-1401) | unit | M / P0 | FR-041 |
| NFR-102 | Edit Plan size. | steps; ops | ≤ 40 steps; ≤ 200 ops per plan (EM-2304) | unit | M / P0 | FR-080, AI_WORKFLOW §3 |
| NFR-103 | Import file limits. | bytes; pixels; duration | video ≤ 4 GB, ≤ 30 min, ≤ 4096 px/side; image ≤ 100 MB, ≤ 8192 px/side; audio ≤ 500 MB, ≤ 30 min; captions ≤ 2 MB; ≤ 50 files per drop (EM-1002, EM-1008, EM-1010) | unit | M / P0 | FR-041, FRD §5 table |
| NFR-104 | Timeline Elements per Project and effects per element. | count | ≤ 1 000 elements; ≤ 3 effects per element (T0: 2) (EM-2105) | unit | M / P0 | FR-036, FR-063 |
| NFR-105 | Composition Model size passed to the Engine. | bytes of `inputProps` JSON | ≤ 2 MB | unit | M / P0 | ARCHITECTURE §7, NFR-132 |
| NFR-106 | Concurrency. | simultaneous jobs | 1 Render Job; 1 agent run per agent per Project (EM-4305); 2 ingests; 1 Model Download; background jobs paused during Standard/Accelerated renders | int | M / P0 | FR-142, FR-084, FR-042, FR-124 |
| NFR-107 | Conversation length. | messages per thread retained; context window use | unlimited stored; request ≤ 60 % of model context with deterministic summarisation; message ≤ 4 000 chars (EM-4306) | int | M / P0 | FR-074, FR-075, AI_WORKFLOW §10 |
| NFR-108 | Projects per installation and Composition Versions per Project. | count | ≥ 500 Projects without Open-dialog slowdown > 1 s; ≥ 2 000 versions per Project with undo ≤ 200 ms | bench | S / P0 | FR-010, FR-167 |
| NFR-109 | Output size and resolution. | pixels | 240 … 4096 per side, even (EM-3103); GIF ≤ 720p ≤ 15 fps | unit | M / P0 | FR-139, FR-147, PERFORMANCE §3 |

### 5.11 Logging and diagnostics (NFR-110 … NFR-119)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-110 | Logs shall be structured JSON lines with the common fields of ERROR_CATALOGUE §5 and an EM code on every error entry. | entries without code/subsystem | 0 | audit | M / P0 | ERROR_CATALOGUE §5 |
| NFR-111 | Logs shall rotate and be bounded. | retention; size | 7 days; ≤ 50 MB per log file, ≤ 200 MB total | int | M / P0 | FR-175 |
| NFR-112 | A diagnostics bundle shall be producible in one click and contain no secrets or project media. | time; content | ≤ 10 s; scan finds 0 secrets, 0 media | e2e, audit | M / P0 | FR-150, NFR-043 |
| NFR-113 | Render Jobs shall log the full Remotion/FFmpeg parameters (without paths outside app data) and the last 50 lines of engine stderr on failure. | failures without parameters logged | 0 | int | M / P0 | FR-143 |
| NFR-114 | Agent runs shall log the envelope size, model, tokens, cost, validation outcome and retries, and store the raw model output on EM-4301 for transparency. | runs without a Usage Record | 0 | int | M / P0 | FR-074, FR-080, AI_WORKFLOW §11 |
| NFR-115 | Log level shall be configurable (info default, debug on demand) without restart, from Diagnostics. | behaviour | yes | e2e | S / P0 | FR-150 |

### 5.12 Data retention and lifecycle (NFR-120 … NFR-129)

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-120 | Retention periods shall be enforced by a housekeeping job at start. | items kept beyond their period | checkpoints 20/Project; logs 7 d; replaced-project checkpoints 7 d; uninserted generator results 7 d; Usage Records 12 mo; Outputs, Projects, conversations until deleted by the Creator | int | M / P0 | FR-175 |
| NFR-121 | Uninstall shall remove the application but keep `%APPDATA%\Expertmotion` (projects, media, outputs, models) unless the Creator ticks "also delete my projects and models"; the choice and its consequence are stated in the uninstaller. | behaviour | as stated | vm | M / P0 | brief §12, DEPLOYMENT_AND_PACKAGING.md |
| NFR-122 | Backup zips shall be self-describing, encrypted with a Creator passphrase by default (SEC-052), and restorable as a new Project on any Expertmotion of the same or newer version. | manifest fields; restore success | app version, schema version, Project id, Asset hashes/sizes; 100 % on same/newer; restore never overwrites | int | M / P0 | FR-017, FR-018, FR-177, DATABASE_SCHEMA §7 |
| NFR-123 | Deleting a Project shall remove its database rows, media and checkpoints within 10 s and report reclaimed space; Outputs are kept unless chosen. | completeness; time | 0 orphan files; ≤ 10 s | int | M / P0 | FR-178 |
| NFR-124 | Disk usage of the data folder shall be visible per Project and in total. | UI presence | Open dialog and Hardware Monitor | e2e | S / P0 | FR-178, FR-127 |

## 6. Other requirements

### 6.1 Composition Model and interface constraints (NFR-130 … NFR-139)

The Composition Model schema is owned by DATABASE_SCHEMA.md; the operation vocabulary by AI_WORKFLOW.md. These constraints bind both.

| ID | Statement | Metric | Target | Measurement | Priority | Related |
|---|---|---|---|---|---|---|
| NFR-130 | All times in the Composition Model, Edit Intents, Operations and API payloads shall be integers in milliseconds; frame counts are derived at render/preview from the Project frame rate and never stored as the source of truth. | fields holding frames or seconds as source values | 0 | audit (schema) | M / P0 | GLOSSARY ▸ Composition Model, PERFORMANCE §4 |
| NFR-131 | Every Composition Version shall be immutable and identified by a content hash (SHA-256 of canonical JSON, shown as `v<n>-<8 hex>`); `baseVersion` in intents and plans references this hash; equality of hashes implies identical renders. | mutable version rows; hash collisions in tests | 0 | unit | M / P0 | FR-082, FR-166, AI-013, ARCHITECTURE §9 |
| NFR-132 | A serialised Composition Version plus resolved media URLs shall fit the Engine `inputProps` limit. | bytes | ≤ 2 MB; above that the validator blocks with EM-2304-style plan rejection or EM-2001 on load | unit | M / P0 | NFR-105, ARCHITECTURE §7 |
| NFR-133 | The Composition Model JSON shall carry `schemaVersion`; the Local Service migrates older versions on load and refuses newer ones with EM-6302-style copy; checkpoints and backups keep their original `schemaVersion`. | unmigrated loads | 0 | int | M / P0 | NFR-063, FR-177 |
| NFR-134 | `applyOps(model, ops)` and `validate(model)` shall be pure, deterministic functions (same input → same output, no I/O), so that dry-run (`composition.validateOps`) and Execute produce identical results. | divergence between dry-run predicted diff and executed diff in golden scenarios | 0 | unit | M / P0 | AI_WORKFLOW §2 steps 8, 10 |
| NFR-135 | Derived timing (total duration = Σ Clips − Σ transition overlaps; or fixed) shall be computed by one function used by the Player, the renderer (`calculateMetadata`) and the Export summary. | places computing duration | 1 | audit | M / P0 | FR-057, FR-136, ARCHITECTURE §7 |
| NFR-136 | Output pixel dimensions shall be derived only from the PERFORMANCE §3 table function; no component stores pixels except the Output row after render. | hard-coded pixel values in code | 0 (table module excepted) | audit | M / P0 | FR-096, PERFORMANCE §3 |
| NFR-137 | Ops shall reference `assetId`/`jobId`/element ids, never file paths or code; media URLs are resolved by the Local Service at render/preview time. | ops containing paths or code | 0 (schema regex) | unit | M / P0 | AI_WORKFLOW §5 |
| NFR-138 | Locked Keys shall be derivable from the intent history alone (`target.property` of every `compiled`/`executed` intent not superseded) so the validator needs no extra state. | mismatch between derived and stored locked keys | 0 | unit | M / P0 | AI-014, GLOSSARY ▸ Locked Key |

### 6.2 Traceability: NFR → PRD / FR

| NFR block | PRD | FR groups |
|---|---|---|
| Performance NFR-001…019 | PRD-001, PRD-005, PRD-009, PRD-012, PRD-014, PRD-019 | 1, 4, 5, 6, 7, 13 |
| Reliability NFR-020…029 | PRD-003, PRD-012, PRD-014, PRD-015 | 7, 13, 16 |
| Availability NFR-030…034 | PRD-010, PRD-020 | 1, 9, 13, 15 |
| Security NFR-040…049 | PRD-004, PRD-016 | 1, 5, 9, 14, 16 |
| Privacy NFR-050…055 | PRD-020, ADR-017 | 7, 9, 11, 15 |
| Maintainability NFR-060…068 | PRD-021, PRD-013 | all |
| Portability NFR-070…074 | PRD-001, PRD-055 | 1, 2, 16 |
| Usability NFR-080…089 | PRD-002, PRD-015, PRD-018 | all |
| i18n NFR-090…095 | ADR-012, PRD-031, PRD-037 | 3, 4, 8, 14 |
| Limits NFR-100…109 | PRD-005, PRD-007, PRD-012, PRD-014 | 5, 6, 7, 13 |
| Logging NFR-110…115 | PRD-015, PRD-021 | 13, 14 |
| Retention NFR-120…124 | PRD-003, PRD-004 | 2, 16 |
| Composition Model NFR-130…138 | PRD-007, PRD-008, PRD-012, PRD-013 | 6, 7, 13, 16 |

### 6.3 Verification summary

| Method | NFRs |
|---|---|
| bench (reference hardware scripts) | NFR-001, 004, 005, 006, 014, 018, 025, 028, 108 |
| profiler | NFR-002, 003, 007, 008, 009, 016 |
| netcap | NFR-050, 052, 053 |
| audit / review | NFR-015, 042, 044, 049, 051, 055, 060, 061, 064, 065, 067, 068, 071, 081, 084, 085, 090, 091, 110, 112, 130, 135, 136 |
| usability | NFR-080 |
| beta (local diagnostics, opt-in) | NFR-022 |
| unit / int / e2e / vm | all others |

All measurements are recorded in TEST_PLAN.md with the hardware configuration, build id and date; a "to confirm" target becomes final when POC-007 measurements are accepted in STAGE_MANAGEMENT.md.
