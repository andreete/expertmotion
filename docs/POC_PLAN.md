# Proof-of-concept plan (Deliverable D)

| Field | Value |
|---|---|
| Status | baseline (Roadmap Stage 2 input; results are appended to each POC and summarised in RISKS_AND_ASSUMPTIONS.md) |
| Owner | Principal architect (experiments executed by the Stage 2 engineer) |
| Last updated | 2026-10-24 |
| Depends on | MASTER_PROJECT_PROMPT.md §23 Deliverable D, ASSESSMENT.md §10–11, DECISIONS.md (ADR-004…008, 014, 017), ARCHITECTURE.md §7, PERFORMANCE.md, SECURITY.md, DEPLOYMENT_AND_PACKAGING.md, AI_WORKFLOW.md |
| Used by | ROADMAP.md (Stage 2 gate), STAGE_MANAGEMENT.md, RISKS_AND_ASSUMPTIONS.md, TEST_PLAN.md, PERFORMANCE.md (budgets "to confirm") |
| Owner of | POC- experiments, their pass/fail criteria and the Stage 2 exit condition |
| ID range | POC-001 … POC-099 |

Purpose (brief §23 D, §18 Stage 2): validate the highest-risk assumptions with the smallest experiments **before** the Editor is built. Every POC is throwaway code in `poc/<id>/` of the repository; nothing from it is merged without going through the normal workflow. Each POC records: hypothesis, setup, steps, pass/fail, effort, and what happens if it fails. Results are appended under "Result" with date, hardware and numbers.

## 1. Risk ranking and schedule

| Rank | POC | Assumption at risk | Why this rank | Runs on |
|---|---|---|---|---|
| 1 | POC-001 | Electron + Local Service + Remotion render work from a clean Windows VM with nothing installed (PRD-001) | if this fails the product does not exist | Windows |
| 2 | POC-003 | native dependency distribution (`better-sqlite3-multiple-ciphers` unpacked, Chrome Headless Shell + FFmpeg from `resources/`) | blocks POC-001 in practice; separate because its failure modes differ | Windows |
| 3 | POC-002 | preview-to-render parity (Player vs `renderStill` ≤ 1 % pixel diff) | the core promise "what you see is what you export" | Windows |
| 4 | POC-007 | resource consumption on a T0 laptop (two Chromium instances) | decides minimum hardware and Performance Profile numbers | Windows T0 |
| 5 | POC-006 | production artefact security (no maps, ASAR integrity, bytecode, no prompt strings, token required) | ADR-007 is a sales promise; bytenode compatibility unknown | Windows |
| 6 | POC-005 | persistence and recovery after `kill -9` during Execute and render | PRD-003/PRD-015 acceptance | Linux (DB parts) + Windows (render part) |
| 7 | POC-004 | AI connectivity and structured output with two OpenRouter models incl. a non-tool-calling one; `usage.cost` | ADR-002/003 depend on cheap models emitting valid JSON | Linux |
| 8 | POC-009 | WebGL effects without GPU via `swangle` | T0 is the primary persona's hardware | Windows T0 |
| 9 | POC-008 | whisper.cpp prebuilt transcribes 60 s Indonesian (P1) | P1 feature, but shapes the Engine Binary distribution pattern | Windows (also Linux for the binary itself) |
| 10 | POC-010 | Service Token + Host guard defeat a browser forgery attempt | ADR-005 claim; cheap to prove | Linux + any browser |

Suggested order: 001 → 003 → 002 → 007 → 006 (same Windows machine, same packaged build), in parallel 004 → 005 → 010 on the Linux server, then 009 and 008. Total estimate: 14–18 engineer-days.

Stage 2 exit (STAGE_MANAGEMENT.md): POC-001, 002, 003, 005, 006, 010 pass; POC-004 passes with at least one model; POC-007 produces numbers that replace every "to confirm" in PERFORMANCE.md §5; POC-008/009 may fail with a recorded fallback.

Linux development-server rule for every POC run there: inside the existing cgroup cap (soft 900 MB, hard 1.2 GB), one process at a time, no Electron, no full renders (ASSESSMENT §1, PERFORMANCE §5).

## 2. Experiments

### POC-001 Packaging without manual runtime

| Field | Content |
|---|---|
| Hypothesis | A signed-or-unsigned NSIS installer built per DEPLOYMENT_AND_PACKAGING.md §2 installs as a standard user on a clean Windows 11 VM and the app renders a 5 s H.264 clip of a one-composition Remotion bundle through the Local Service, with no Node, Python, VC++ redistributable or npm present. |
| Setup | Windows build machine (Node 22, pinned Electron, electron-builder); clean Windows 11 x64 VM snapshot with a **standard** (non-admin) user; `poc/001/`: minimal Shell (`utilityProcess.fork` of a 200-line Express service), Editor page with one button, `packages/engine` stub with one `ExpertmotionTimeline` showing a Solid, a Text Layer and a `<Video>` of a bundled 5 s MP4. |
| Steps | 1 Build B1–B4, B7 (skip B5/B6/B8). 2 Copy the installer to the VM; install as the standard user; confirm no UAC. 3 Launch; confirm `Expertmotion.exe` + utility process + no console. 4 Press "Render 5 s"; the Service calls `selectComposition` + `renderMedia({serveUrl: resources/engine, browserExecutable, binariesDirectory, codec:'h264'})`. 5 `ffprobe` the output. 6 Record installer size, installed size, time-to-first-frame, memory. 7 Uninstall; confirm `%APPDATA%\Expertmotion` prompt. |
| Pass | Install without elevation; render completes; output is 5.0 s ± 1 frame, 1920×1080, 30 fps, plays in Windows Media Player; no error dialog; installed size ≤ 500 MB; installer ≤ 450 MB compressed before models (expected ≈ 300–400 MB; this measurement is the number PERFORMANCE.md §5, DEPLOYMENT_AND_PACKAGING.md §7 and ADR-004 quote). |
| Fail | Any missing-DLL dialog, Chrome launch failure, "Remotion binaries must not be loaded from inside app.asar" error, UAC prompt, or size over budget. |
| Effort | 3 days |
| If it fails | Missing runtime DLLs → bundle them in `resources/bin` or switch Engine Binary builds to static; binaries in ASAR → fix `asarUnpack`/`extraResources`; Chrome needs libraries → use `chromeMode`/`ensureBrowser` offline copy; size → drop sherpa-onnx/sd.cpp from MVP installer (download on demand like models, ADR-008 extension). If Electron itself cannot do it, ADR-004 is reopened (Tauri + sidecar is the documented alternative). |

### POC-002 Preview-to-render parity

| Field | Content |
|---|---|
| Hypothesis | The `@remotion/player` running in Electron's Chromium and `renderStill` running in Chrome Headless Shell produce the same pixels for the same frame of the same `ExpertmotionTimeline` input (≤ 1 % differing pixels at a tolerance of 8/255 per channel). |
| Setup | POC-001 build plus `poc/002/`: a composition with 2 Clips, a `fade` and a `slide` transition (`@remotion/transitions`), one `@remotion/effects` effect (e.g. vignette) on a Clip, a `karaoke`-style caption page, a Text Layer with a bundled woff2 font and a gradient background. Five golden frames: mid-clip, mid-`fade`, mid-`slide`, a frame with the effect and highlighted caption word, the last frame. Pixel diff tool: `pixelmatch` (Node). |
| Steps | 1 Render the five frames with `renderStill({imageFormat:'png', scale:1})`. 2 In the Editor window, `playerRef.seekTo(frame)`, wait for `frameupdate`, capture with `webContents.capturePage()` of the Player element at 1:1 (window scaled so the Player is 1920×1080 or use `scale` 0.5 on both sides). 3 `pixelmatch` each pair; store diff images. 4 Repeat with `gl:'angle'` and `gl:'swangle'` for the renderer, and with the Player in `Draft` (proxy) vs full to confirm Draft is only a resolution change. 5 Check fonts loaded (`document.fonts.check`) before capture. |
| Pass | All five frames ≤ 1 % differing pixels (full quality); transition frames may use a ±1-frame search window because the Player and renderer may round time differently — if the match needs the window, record it. |
| Fail | > 1 % on any frame after accounting for the ±1-frame window, or systematic colour shift (sRGB/ICC) or font fallback differences. |
| Effort | 2 days |
| If it fails | Colour shift → force `--force-color-profile=srgb` on both Chromiums (Electron `app.commandLine.appendSwitch`, renderer `chromiumOptions`) **[switch name UNVERIFIED]**; font fallback → preload fonts with `@remotion/fonts` `loadFont` and `delayRender`; effect differences between `angle`/`swangle` → mark the affected presets "GPU-only" in DESIGN_CATALOGUE.md or exclude them from P0; timing → derive Player frames and `renderStill` frames from the same `deriveTiming()` to avoid rounding. If parity is fundamentally unreachable for a preset, the preset is removed (ADR-001 keeps the catalogue closed). |

### POC-003 Native dependency distribution

| Field | Content |
|---|---|
| Hypothesis | `better-sqlite3-multiple-ciphers` (Electron prebuild) loads from `app.asar.unpacked` inside the utility process and opens a ChaCha20-Poly1305-encrypted DB; `@remotion/renderer` finds Chrome Headless Shell and the compositor (FFmpeg) in `resources/` through `browserExecutable` and `binariesDirectory`; `argon2` loads the same way. |
| Setup | POC-001 build. `poc/003/`: Service code that opens `test.db` with `PRAGMA key`/`cipher='chacha20'`, writes 1 000 rows in a transaction, re-opens with a wrong key, then starts a `renderMedia` with explicit binary paths. `npmRebuild: true` and the `asarUnpack` globs from DEPLOYMENT_AND_PACKAGING.md §3. |
| Steps | 1 Build; inspect `resources/app.asar.unpacked/node_modules` for the `.node` files. 2 Launch on the clean VM; the Service logs `sqlite_version`, cipher, row count. 3 Open `test.db` with stock `sqlite3.exe` → expect "file is not a database". 4 Wrong-key open → expect `SQLITE_NOTADB`. 5 Render 2 s; log the resolved `browserExecutable`, `binariesDirectory`; confirm no download attempt (`netstat`, no `node_modules/.remotion` created in `%APPDATA%`). 6 Byte-flip `ffmpeg.exe` in a copy → confirm hash check catches it (SEC-061). 7 Confirm `safeStorage.isEncryptionAvailable()` is true for the standard user and `encryptString`/`decryptString` round-trip; attempt decrypt from a second Windows account → fails. |
| Pass | All loads succeed without a rebuild on the VM; wrong key and stock sqlite3 fail as expected; render uses only `resources/` binaries; hash check triggers; DPAPI round-trip ok and cross-account fails. |
| Fail | `Module did not self-register`/ABI mismatch, `.node` not found inside ASAR, Remotion downloading Chrome at runtime, or `binariesDirectory` not honoured for the compositor. |
| Effort | 1.5 days |
| If it fails | ABI → `electron-rebuild` in B7 (`npmRebuild`) with the exact Electron; not found → fix `asarUnpack` or move natives to `extraResources` and `require` by absolute path; Chrome download → copy the whole `chrome-headless-shell/win64` folder including `VERSION`; compositor path → set `binariesDirectory` to the package folder itself (Remotion Electron guide) and confirm the binary file names (**[UNVERIFIED]**); DPAPI unavailable → block first run with EM-6xxx (SEC-040) and investigate the VM's user profile. |

### POC-004 AI connectivity and structured output

| Field | Content |
|---|---|
| Hypothesis | Through OpenRouter, (a) a tool-calling model and (b) a model **without** tool calling (JSON-mode prompting) both return an `EditPlan` that passes the Zod schema in AI_WORKFLOW.md §3 for three golden scenarios, within ≤ 2 retries; `usage.cost` is present in the response and recorded. |
| Setup | Linux dev server (fits in the cap: plain Node, no Remotion). `poc/004/`: `packages/agents` schemas, the Rewrite envelope from AI_WORKFLOW.md §7 for scenarios 1–3 of GOLDEN_SCENARIOS.md (fixtures), Vercel AI SDK with `@openrouter/ai-sdk-provider` or raw `fetch` to `https://openrouter.ai/api/v1/chat/completions` with `usage: {include: true}`; a Creator-supplied test key (never committed; read from a file outside the repo). Models: one with `tools` in `supported_parameters` (mid-tier) and one without (small/cheap); list from `GET /api/v1/models?supported_parameters=tools`. |
| Steps | 1 For each model × scenario: send the envelope; parse with Zod; on failure re-prompt with the Zod error (max 2). 2 Record validity on first attempt, retries, `touchesLockedKeys` violations, latency, `usage.cost`, tokens. 3 Inject a Locked Key conflict scenario and a prompt-injection filename (AC-1) and record behaviour. 4 Dry-run `applyOps` on a fixture Composition Model for every valid plan. |
| Pass | ≥ 90 % plans valid on first attempt for the tool-calling model and ≥ 70 % for the JSON-mode model (≥ 95 % within 2 retries for both); 100 % Locked Key violations caught by the validator; `usage.cost` non-null for every call; total spend of the experiment < US$1. |
| Fail | A model category cannot reach the threshold even with retries, or `usage.cost` missing, or the validator misses a violation. |
| Effort | 1.5 days |
| If it fails | JSON-mode too weak → Capability Table marks such models "not for Editor Agent" and the Model Bar hides them; cost missing → compute from the models endpoint pricing and label "approximate" (AI_WORKFLOW §11); validator gap → fix before any UI work (AI-014). |

### POC-005 Persistence and recovery

| Field | Content |
|---|---|
| Hypothesis | Killing the Local Service with `kill -9` (Linux) / `taskkill /F` (Windows) during Execute leaves the DB consistent at the previous Composition Version; killing it during a render leaves the job `failed`, the partial file deleted, and the project reopens from the last checkpoint (≤ 10 s old, PRD-003). |
| Setup | Linux part: `poc/005/`: Service with the `composition_versions`, `plans`, `render_jobs`, `recovery_checkpoints` tables from DATABASE_SCHEMA.md, WAL on, encrypted; a plan of 200 ops applied in one transaction with an injected `await sleep()` mid-transaction (test hook) and autosave every 10 s. Windows part: POC-001 build rendering a 30 s clip. |
| Steps | 1 Start Execute; kill at the hook; restart; assert head version = base version, plan status `valid`, no partial rows (`PRAGMA integrity_check` ok). 2 Dirty the model, wait 12 s, kill; restart; assert a checkpoint file ≤ 10 s old exists and imports. 3 Start render; kill the Service at 40 %; restart; assert `render_jobs.status = failed` with the "interrupted" EM-3xxx, partial output absent, Chrome Headless Shell processes gone (Windows). 4 Kill Chrome Headless Shell (not the Service) during render; assert job `failed`, Service alive, next render works (PRD-015). 5 Corrupt the DB header; restart; assert `.bak` fallback or checkpoint-import path is offered. |
| Pass | All five assertions hold on three consecutive runs; no `database is locked` loops; restart-to-ready ≤ 5 s. |
| Fail | Any orphaned `rendering` job, a half-applied version, a checkpoint older than 10 s, a lingering Chrome process, or a DB that will not open. |
| Effort | 1.5 days (1 Linux, 0.5 Windows) |
| If it fails | Transaction leak → wrap `applyOps` + version insert in one `db.transaction()`; checkpoint age → autosave interval 5 s + checkpoint before Execute/render; orphans → startup sweep by `status='rendering'` + `taskkill /T`; locks → `busy_timeout` 5 000 ms and a single writer connection. |

### POC-006 Production artefact security

| Field | Content |
|---|---|
| Hypothesis | The packaged build (B1–B8) contains no source maps, terminates when `app.asar` is modified, ships the `license`/`prompts` modules as bytecode that runs on the pinned Electron, reveals no prompt sentence to `strings`, and answers `401` to a token-less request. |
| Setup | Full build with B5/B6 enabled on the Windows build machine; three sentinel sentences placed in the prompt asset; `@electron/fuses` CLI; `npx asar`; Sysinternals `strings`. |
| Steps | 1 `npx asar list resources\app.asar`: count `.map`, `.ts`, `.tsx` → expect 0. 2 `npx @electron/fuses read --app Expertmotion.exe` → expect SEC-028 values. 3 Flip one byte in `app.asar`; launch → expect immediate termination (log the exit code). 4 Confirm `license.jsc`, `prompts.jsc` present, `.cjs` absent; launch; the Service verifies a test Licence Key and loads prompts → expect success (bytenode compatibility with the pinned Electron, including the ASSESSMENT §5 note about Electron ≥ 42). 5 `strings -n 12 app.asar app.asar.unpacked resources`, then `findstr /i "<sentinel>"` on the output → expect 0 hits. 6 `curl` without token → `401`; with `Host: evil` → `403`. 7 Time a naive attacker: unpack ASAR, read `service.cjs` minified; note what is readable (expected: a lot) to keep ADR-007's honesty. |
| Pass | Steps 1–6 as expected. Step 7 is documentary. |
| Fail | Bytecode crashes or `Function.toString`-dependent code breaks; ASAR tamper not detected; sentinel found; auth bypass. |
| Effort | 1 day |
| If it fails | bytenode incompatible → switch the Shell/Service build to electron-vite `build.bytecode` (main-process style bundle, DEPLOYMENT_AND_PACKAGING.md §1 fallback) or drop bytecode and rely on asset encryption + minification (ADR-007 amended); tamper not detected → check `afterPack` ordering (fuses must be flipped **after** ASAR hash embedding by electron-builder) **[ordering constraint UNVERIFIED]**; sentinel found → the asset was bundled plaintext somewhere (fix the Vite/esbuild include). |

### POC-007 Resource consumption

| Field | Content |
|---|---|
| Hypothesis | On a T0 reference laptop (16 GB RAM, integrated GPU, PRD §6) idle RAM of Shell + Service + Editor ≤ 450 MB; a Standard render of 30 s 1080p30 with 3 clips, 2 transitions and captions completes ≤ 90 s with peak RAM ≤ 40 % of total; Accelerated (if allowed on the machine) stays under 55 %; two Chromium instances (Electron + Chrome Headless Shell) never make the machine swap-thrash. Also: in Private Mode zero outbound connections during render (SEC-111 check). |
| Setup | POC-001/002 build with the POC-002 composition extended to 30 s; T0 laptop with Windows Performance Monitor (`perfmon`) counters for `Process(*)\Working Set - Private`, `% Processor Time`, `Memory\Pages/sec`; a network monitor (e.g. `pktmon` or Wireshark loopback-excluded capture). Optionally a T2 desktop for the Turbo row. |
| Steps | 1 Measure idle for 2 min after onboarding. 2 Render Standard; record wall time, peak RAM per process (`Expertmotion.exe`, utility process, `chrome-headless-shell.exe` tree, `ffmpeg`/compositor), CPU, pages/sec. 3 Repeat Accelerated (`concurrency` 2). 4 Repeat with `gl:'swangle'` and `gl:'angle'`. 5 Private Mode on, render again with capture running. 6 Cancel at 50 %; confirm RAM returns to idle within 10 s. 7 Record cold start to interactive, Player seek latency, catalogue hover latency (PERFORMANCE §5). |
| Pass | Numbers within PERFORMANCE §5 targets, or new justified targets written back; no swap thrash (pages/sec stays near idle); zero outbound in Private Mode; RAM returns to idle after cancel. |
| Fail | Peak > 55 % on Standard, render > 2× target, swap thrash, lingering memory, or any outbound connection in Private Mode. |
| Effort | 2 days (plus hardware access) |
| If it fails | Lower `mediaCacheSizeInBytes`/`offthreadVideoCacheSizeInBytes` for Standard; `concurrency` 1 fixed on T0; Draft preview forced during render; raise minimum RAM in PRD §6; if telemetry traffic appears, implement SEC-111 blocking at the egress layer and escalate under ADR-017. |

### POC-008 whisper.cpp prebuilt transcription (P1 risk)

| Field | Content |
|---|---|
| Hypothesis | A prebuilt, Operator-signed `whisper.cpp` Windows x64 binary with the `small` (and `large-v3-turbo` on T1) ggml model transcribes a 60 s Indonesian clip to word-level timestamps usable by `createTikTokStyleCaptions` in ≤ 2× real time on T0, spawned with an argument array and a scrubbed environment, with no network. |
| Setup | `poc/008/`: whisper.cpp release binary (hash recorded), models downloaded by the POC script with sha256 check, a 60 s Indonesian speech clip (Creator-recorded, consent noted), conversion to 16 kHz mono WAV via the bundled FFmpeg, output as JSON with word timestamps; the Linux server can run the Linux binary for the correctness half if RAM allows (small model ≈ 500 MB — borderline under the cap; use `tiny` there). |
| Steps | 1 Spawn with `spawn(exe, ['-m', model, '-f', wav, '-l', 'id', '-oj', '-ml', '1', ...])` **[flag names to confirm against the pinned whisper.cpp release; UNVERIFIED]**; measure time and peak RAM. 2 Parse the JSON into `Caption[]`; run `createTikTokStyleCaptions`. 3 Score WER against a hand-made transcript (target ≤ 20 % for `small`, ≤ 12 % for `large-v3-turbo`). 4 `netstat` during run → no connections. 5 Kill mid-run → clean exit, temp dir removed. |
| Pass | ≤ 2× real time on T0 with `small`; captions render in the POC-002 composition; WER within targets; no network; clean kill. |
| Fail | Slower than 4× real time, WER > 30 %, binary needs extra DLLs, or no word-level timestamps. |
| Effort | 1.5 days |
| If it fails | Try `sherpa-onnx` offline ASR with an Indonesian model (also covers TTS); fall back to SRT import only in P1 and move generation to P2; document in LOCAL_AI_MODELS.md. |

### POC-009 Effects without GPU via `swangle`

| Field | Content |
|---|---|
| Hypothesis | The six P0 visual effects and the P0 transitions render correctly with `chromiumOptions.gl = 'swangle'` on a T0 machine with no usable GPU, at ≤ 3× the `angle` render time; WebGPU-only effects are excluded from P0 (ASSESSMENT §4). |
| Setup | POC-002 build; T0 laptop with the GPU disabled in Device Manager (or a VM without GPU passthrough); a 10 s composition with each P0 effect for 1.5 s plus two transitions. |
| Steps | 1 Render with `gl:'angle'` on a GPU machine as reference stills. 2 Render the same with `gl:'swangle'` on the GPU-less machine; compare with `pixelmatch` (≤ 1 %). 3 Record render times and RAM. 4 Try `gl:null` (Chrome decides) and note behaviour. 5 Render a WebGPU-only effect to confirm it fails gracefully (error captured as EM-3xxx, not a hang). |
| Pass | All P0 effects/transitions ≤ 1 % diff vs reference; `swangle` time ≤ 3× `angle`; WebGPU effect fails within the timeout with a clean error. |
| Fail | Visual differences, hangs, or > 5× slowdown. |
| Effort | 1 day |
| If it fails | Mark affected presets `gpuOnly` (badge in the Catalogue, disabled on T0, UX "Degraded" state); reduce the T0 effect limit (AI_WORKFLOW `effect.add` max 2 on T0 already); if `swangle` hangs, exclude WebGL effects from T0 entirely and offer CSS-filter equivalents. |

### POC-010 Service Token and Host guard against browser forgery

| Field | Content |
|---|---|
| Hypothesis | A web page in any browser on the same machine cannot cause a state change or read data from the Local Service without the Service Token, and a request with a valid token but a spoofed `Host`/`Origin` is rejected; `EventSource` works for the Editor with the query-string token and for nothing else. |
| Setup | Linux dev server (Node only, within the cap) running the `http` module of the Service with the auth middleware (SEC-004–012) and three routes (`GET /api/projects`, `POST /api/renders`, `GET /api/events`); an attacker page served from `http://localhost:8000` and from `file://`; Playwright (Chromium, Firefox) on a laptop pointed at the server over an SSH tunnel to its loopback, or run everything on the laptop. |
| Steps | 1 Attacker page: port-scan 47600–47699 via `fetch` timing; `fetch` with `mode:'no-cors'` POST; HTML form POST; `EventSource` without token; `fetch` with a guessed token; `<img src>` to `/media/<id>`. 2 `curl` matrix: no token → 401; wrong → 401; valid + `Host: evil` → 403; valid + `Origin: http://attacker.test` → 403; `OPTIONS` → 403; `?token=` on `/api/projects` → 401; `?token=` on `/api/events` → 200 stream. 3 Confirm no `Set-Cookie` ever and no `Access-Control-Allow-Origin`. 4 Timing: 10 000 wrong-token requests; assert constant-time comparison (no length leak) and that the rate limit (if implemented) kicks in. 5 Confirm logs contain no token (`token=[REDACTED]`). |
| Pass | Every attacker action fails with 401/403 and no state change (`render_jobs` empty); legitimate Editor flows (header token, `EventSource` with query token) succeed; logs redacted. |
| Fail | Any 2xx for the attacker, a cookie, a CORS header, or a token in logs. |
| Effort | 0.5 day |
| If it fails | Fix the middleware order (auth before body parsing), the Host/Origin allow-list, or the redaction; re-run. This POC becomes the TEST_PLAN suite for SEC-004–012. |

## 3. Where each POC runs

| POC | Linux dev server (under the cgroup cap) | Windows build machine / T0 laptop / clean VM |
|---|---|---|
| POC-001 | — | all |
| POC-002 | pixel-diff tooling can be developed here against committed stills | capture + render |
| POC-003 | — | all |
| POC-004 | all (plain Node, fake Composition Model, OpenRouter over HTTPS) | — |
| POC-005 | steps 1, 2, 5 (DB transactions, checkpoints, corruption) | steps 3, 4 (render kill, Chrome kill) |
| POC-006 | — | all |
| POC-007 | — | T0 laptop (+ optional T2) |
| POC-008 | correctness with the Linux binary and `tiny` model only | performance and the signed win64 binary |
| POC-009 | — | GPU-less Windows machine or VM |
| POC-010 | all (service + curl); browser part from a laptop | optional repeat against the packaged build |

## 4. Result log (append per run)

| POC | Date | Hardware | Result | Numbers | Follow-up (ADR/RISK/PERFORMANCE change) |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
