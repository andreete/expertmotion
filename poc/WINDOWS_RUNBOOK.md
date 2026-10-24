# Windows runbook for the Stage 2 proofs that cannot run on the Linux server

Status: written 2026-10-24. **Nothing in this file has been executed**; the Linux-side proofs (POC-004 offline half, POC-005 DB half, POC-010) were run and are logged in `docs/POC_PLAN.md` §4. The Electron/Windows proofs below need a Windows 10/11 x64 machine (or `windows-latest` CI) and a clean VM. The experiments, hypotheses and pass/fail criteria are defined in `docs/POC_PLAN.md`; this runbook only says what to prepare and what to record. Do not duplicate or change criteria here; change them in POC_PLAN.md.

## 0. Machine preparation

| Item | Detail |
|---|---|
| Build machine | Windows 10/11 x64, Node 22 LTS, npm, Git, ~20 GB free disk, 16 GB RAM (`docs/DEPLOYMENT_AND_PACKAGING.md` §10) |
| Clean VM | Windows 11 x64 snapshot with a **standard (non-admin)** user; no Node, Python, VC++ redistributable, npm |
| T0 laptop | 16 GB RAM, integrated GPU, SSD (`docs/PRD.md` §6); Performance Monitor available |
| Optional | T2 desktop with NVIDIA GPU ≥ 8 GB (Turbo row of POC-007) |
| Repository | `git clone` this repo; `poc/` folders are throwaway; keep all results in `process.md` Entry 4+ |

## 1. Order (from POC_PLAN §1)

1. **POC-001** packaging without manual runtime → 2. **POC-003** native deps → 3. **POC-002** parity → 4. **POC-007** resources (T0) → 5. **POC-006** artefact security → 6. **POC-005** steps 3–4 (real render kill, Chrome kill) → 7. **POC-009** `swangle` → 8. **POC-008** whisper.cpp.

## 2. What to create (all under `poc/<id>/`; use DEPLOYMENT_AND_PACKAGING.md §2–§3 as the specification)

| POC | Create | Reference sections |
|---|---|---|
| 001 | Minimal Electron Shell that starts the Local Service with `utilityProcess.fork` and sends `{token, port, dataDir, dbKey}` via `postMessage` (SEC-002); a 200-line Express service reusing `poc/010/server.mjs` guards; Editor page with one button "Render 5 s"; `packages/engine` stub with one `ExpertmotionTimeline` (Solid + Text + bundled 5 s MP4 via `@remotion/media` `<Video>`); `bundle()` at build time into `resources/engine`; `electron-builder` NSIS per-user config with `asarUnpack` and `extraResources` for Chrome Headless Shell and the compositor | DEPLOYMENT §2 (B1–B4, B7), §3, §5; ARCHITECTURE §5, §7; REMOTION_CAPABILITY_MAP §E, §G |
| 003 | Service code that opens an encrypted DB (reuse `poc/005/db.mjs`) from `app.asar.unpacked`, writes 1 000 rows, wrong-key open, then `renderMedia` with explicit `browserExecutable` and `binariesDirectory`; DPAPI round trip with `safeStorage` | POC_PLAN POC-003; SECURITY SEC-040…046, SEC-061 |
| 002 | Composition with 2 clips, `fade` + `slide`, one effect, a karaoke caption page, bundled font; five golden frames; `pixelmatch` diff of `renderStill` vs `playerRef.seekTo` + `capturePage` | POC_PLAN POC-002; DESIGN_CATALOGUE §2–§4, §8 |
| 007 | Extend POC-002's composition to 30 s; Performance Monitor counters listed in POC_PLAN POC-007; `pktmon` capture for Private Mode | PERFORMANCE §2, §5 |
| 006 | Full build with B5 (bytecode) and B6 (asset encryption) enabled; `npx asar list`, `@electron/fuses read`, sentinel sentences in the prompt asset | DEPLOYMENT §2 B5–B8; SECURITY SEC-020…033, SEC-130…134 |

## 3. Also run on Windows (Node only, minutes each)

```powershell
cd poc\010; npm install; node test.mjs          # expect 44/44 (uses `ss`; replace the listener check with `netstat -ano | findstr :4111` on Windows)
cd ..\005;  npm install; node test.mjs          # expect 69/69; confirms better-sqlite3-multiple-ciphers prebuild + SIGKILL semantics on Windows (SIGKILL maps to TerminateProcess)
cd ..\004;  node run.mjs                        # offline half 19/19; set EM_OPENROUTER_KEY_FILE etc. for the live half
```

The `ss` call in `poc/010/test.mjs` and the `/tmp`-style temp dirs are Linux-flavoured; if a Windows run fails there, record it and patch the test, not the criteria.

## 4. What to record per run (append to `docs/POC_PLAN.md` §4 and `process.md`)

Date · hardware (CPU, RAM, GPU, Windows build) · exact command · pass/fail per criterion · numbers (installer size, installed size, render time, peak RAM per process, outbound connections) · errors verbatim · follow-up (ADR / RISK / PERFORMANCE.md change).

## 5. Known unverified items to confirm while doing this (from the docs)

`electronFuses` option names in electron-builder; binary file names inside `@remotion/compositor-win32-x64-msvc`; Chrome Headless Shell size; whether `bytenode` works on the pinned Electron (ASSESSMENT §5 says it crashes on Electron ≥ 42); fuse-flip vs ASAR-hash ordering in `afterPack`; `--force-color-profile=srgb`; whisper.cpp CLI flags. Each is marked **[UNVERIFIED]** where it is used.

## 6. Building the real installer (Stage 3 code, added 2026-10-24)

The application code now exists; these steps build the installer from it on the Windows build machine (Node 22, Git, Visual Studio Build Tools for native modules).

1. `npm ci` (downloads Electron; the Linux server skipped it with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`).
2. `npx remotion browser ensure` (Chrome Headless Shell into `node_modules/.remotion`).
3. Put the LGPL full FFmpeg and ffprobe for ingestion into `resources/bin/` (ADR-019; record the build URL and hash in `docs/DEPLOYMENT_AND_PACKAGING.md`).
4. `npm run build:all` (service bundle, Editor, engine fonts and bundle, desktop main).
5. `node packages/engine/scripts/build-loops.mjs` (all catalogue loops; about 8 s each on this server, faster on a GPU). Check `resources/catalogue/report.json` has no failures.
6. `node scripts/stage-desktop.mjs --check`, then `npm run stage:desktop`. Review the `REVIEW:` line of the notices output (GPL or unknown licences).
7. `npm run harden -w @expertmotion/desktop` (bytenode, obfuscation, encrypted prompts, signed integrity manifest; the signing key comes from a file outside the repo).
8. `npm run pack:win -w @expertmotion/desktop`; the installer lands in `release/<version>/`.
9. Smoke test on a clean Windows VM: install without admin, first run, licence screen shows a Machine Code, import a clip, Insert, pick Fade, Export 720p in Trial Mode (watermark visible), uninstall keeps or removes data as chosen.

Record installer size, cold start, idle RAM and the export time in `docs/POC_PLAN.md` §4 (POC-001, POC-007, POC-008).

## 7. Test installer built on the Linux server (added 2026-10-24)

`scripts/cross-build-win.sh` builds the NSIS installer on the Linux server so the Operator can download and try it without setting up a build machine. Inputs were fetched outside git: Chrome Headless Shell 157.0.8080.0 win64 (Chrome for Testing), `@remotion/compositor-win32-x64-msvc@4.0.535` (npm pack), FFmpeg n8.1 LGPL shared win64 (BtbN; DLLs beside `ffmpeg.exe`/`ffprobe.exe`). better-sqlite3-multiple-ciphers ships N-API prebuilds for win32-x64, so no native rebuild is needed (`-c.npmRebuild=false`).

Differences from the Windows release path (§6), all deliberate:

| Item | Linux test build | Windows release build |
|---|---|---|
| V8 bytecode for main and service (bytenode) | skipped (needs the pinned Electron on Windows) | yes |
| Code signing (signtool, OV certificate) | none: SmartScreen shows "Windows protected your PC" (More info → Run anyway) | signed |
| Obfuscation, startup integrity check (EM-8007), Electron fuses, asar | yes | yes |
| Release key | a test key in `~/em-win-deps/keys` on the server, never in git | the Operator's release key |

Use the test installer for the §6 step 9 smoke test; ship only the signed Windows build.
