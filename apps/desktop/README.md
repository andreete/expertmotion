# @expertmotion/desktop — Desktop Shell

The Electron application that launches the local Editor. It owns the window, the OS credential
store, the Local Service lifecycle, the updater and the tray. It contains **no business logic**
(ARCHITECTURE.md §3): everything stateful lives in the Local Service.

Source of truth: `AGENTS.md`, `docs/ARCHITECTURE.md` (§3, §5, §8), `docs/SECURITY.md`
(SEC-001…033, SEC-040, SEC-090…104, SEC-130…134), `docs/DEPLOYMENT_AND_PACKAGING.md`,
`docs/API_SPECIFICATION.md` §2, `docs/DECISIONS.md` (ADR-004/005/006/007/019).

## Layout

```
src/
  main.ts            Electron main process (orchestration only); wires Electron to src/lib/*
  preload.ts         the contextBridge: window.expertmotion (SEC-031)
  lib/               PURE logic, no `electron` import — unit-tested on Linux
    constants.ts     port range, backoff schedule, CSP directives, IPC channels, EM codes, bridge keys
    port.ts          free loopback port 47600–47699 with retry (SEC-008)
    backoff.ts       restart policy 1/3/9 s, max 3, budget reset (SEC-033)
    csp.ts           the Editor CSP string, prod + dev (SEC-024)
    protocol.ts      app:// path resolution with traversal containment (SEC-025)
    ipc.ts           IPC sender validation predicate (SEC-030)
    data-dir.ts      %APPDATA%\Expertmotion layout (ARCHITECTURE §8)
    dev-mode.ts      SEC-014 dev relaxations; packaged build ignores every EM_* var
    bootstrap.ts     the {type:'bootstrap', token, port, dataDir, dbKeyHex} message (SEC-002)
    keyring.ts       safeStorage gate: refuse when unavailable / basic_text on Linux (SEC-040)
    updater-policy.ts electron-updater config + "may I check now?" (SEC-090…096)
    integrity.ts     signed integrity-manifest build + verify (SEC-133, hardening item 4)
    obfuscation.ts   javascript-obfuscator config (hardening item 2)
    harden-plan.ts   hardening pipeline planner + bytecode exclusions (hardening items 1–4)
    keysplit.ts      prompt-asset AES key split across bytecode + build constant (SEC-132)
  native/            OPTIONAL C++ addon stub (licence verify + key derivation) — see its README
scripts/
  build-main.mjs     esbuild → dist/main.cjs + dist/preload.cjs (CJS, minified, no source maps)
  harden.mjs         the hardening stage (items 1–4); `--plan` for a Linux dry run, `--no-bytecode` escape hatch
build/
  afterPack.cjs      electron-builder afterPack: flips the fuses (SEC-028) after bytecode
electron-builder.config.cjs   NSIS per-user x64, asar, maximum compression, fuses (DEPLOYMENT §3)
test/                Vitest unit tests of the pure lib (no `electron` import)
```

## Bridge surface (SEC-003, SEC-031)

`window.expertmotion` exposes exactly, and only:

| Method | Returns | Purpose |
|---|---|---|
| `getBootstrap()` | `{port, token}` | the Local Service endpoint for the Editor's fetch/EventSource |
| `pickFiles(options?)` | `string[]` | native open dialog for import; the paths feed the Shell-only `paths[]` route (API §2.3) |
| `pickFolder(options?)` | `string \| null` | choose a folder (e.g. output location) |
| `pickSavePath(options?)` | `string \| null` | native save dialog |
| `openFolder(path)` | `void` | reveal a file/folder in the OS file manager |
| `onServiceState(cb)` | unsubscribe | Service up/down + re-bootstrap on restart (API §2.1 rotation) |
| `onUpdateState(cb)` / `getUpdateState()` | unsubscribe / `UpdateState` | FR-152 updater state for `sys.update` (available, downloading, downloaded EM-8105, deferred while a render runs, paused by Private Mode, error EM-8101…8104) |
| `updateAction(action)` | `void` | Creator consent: `download` (never automatic), `restart` (deferred until no Render Job runs), `later`, `check` |
| `openPath(path)` | `void` | FR-146 Play: opens a rendered `.mp4/.webm/.gif/.png/.wav` with the system player; anything else is ignored |

No generic `invoke(channel, …)`. Every IPC handler validates `event.senderFrame` against the
`app://expertmotion/` main frame (plus the Vite dev origin when not packaged).

## Build (on Windows; see §"Linux" for what runs here)

Full release pipeline is `docs/DEPLOYMENT_AND_PACKAGING.md` B1…B10. The Shell's own steps:

```powershell
# 1. Build the Shell bundles (CJS, minified, no source maps — SEC-130)
npm run build:main -w @expertmotion/desktop

# 2. (The Editor, Service and Engine are built by their own packages into dist/ui, dist/service
#     and resources/engine per DEPLOYMENT §2 B1–B4 before this point.)

# 3. Harden (items 1–4). Bytecode needs the pinned Electron; set EM_ELECTRON_PATH to its binary.
#    Provide the real release keys via env; see "Hardening inputs" below.
$env:EM_ELECTRON_PATH = "node_modules\electron\dist\electron.exe"
npm run harden -w @expertmotion/desktop

# 4. Package (NSIS per-user x64, asar, maximum compression; afterPack flips the fuses)
npm run pack:win -w @expertmotion/desktop
```

### Hardening inputs (environment variables, build machine only)

| Var | Meaning |
|---|---|
| `EM_ELECTRON_PATH` | path to the pinned Electron binary bytenode compiles against |
| `EM_FEED_URL` | pinned update feed (SEC-096); baked into main.cjs by `build:main` |
| `EM_RELEASE_PRIVATE_KEY_PEM` | Ed25519 private key that signs the integrity manifest (offline) |
| `EM_ENGINE_PUBLIC_KEY_B64` | the matching public key; baked into the bytecode-compiled main bundle |
| `EM_PROMPT_KEY_HALF_A` / `_HALF_B` | the two 32-byte halves of the prompt-asset key (one lives in the bytecode module, one is a build constant) |
| `EM_PUBLISHER_NAME`, `EM_TIMESTAMP_URL` | Authenticode subject + RFC 3161 timestamp server (SEC-092) |

## Protection layers (ADR-007, SEC-130…134) — and their honest limits

Expertmotion applies defence in depth to raise the cost of reverse engineering and secret
extraction. **None of these can make it impossible.** A person who owns the computer, with a
debugger, a patched binary or a modified OS, can still read decrypted memory and observe behaviour
(ADR-006, ADR-007 boundary statement). We never write "cannot be reverse-engineered" or
"unbreakable". What each layer does:

1. **V8 bytecode (bytenode, hardening item 1).** The whole main-process bundle (`main.cjs → main.jsc`)
   and the whole Local Service bundle (`service.cjs → service.jsc` + a tiny loader) are compiled to
   V8 bytecode, removing readable JavaScript source. Compiled with the pinned Electron via
   `ELECTRON_RUN_AS_NODE` on the Windows build machine; the `RunAsNode` fuse is flipped **off
   afterwards** by `afterPack.cjs`, so the shipped binary cannot be coaxed into plain Node.
   **Exclusion list** (`BYTECODE_EXCLUSIONS`): anything that needs `Function.prototype.toString` is
   never bytecode — the Remotion renderer/Engine bundle (served to Chrome, not loaded as a Node
   module here) and the Editor bundle (obfuscated instead). An `--no-bytecode` escape hatch and a
   loader smoke test exist. **[UNVERIFIED]**: bytenode on Electron ≥ 42 (V8 ≥ 14.8) can hard-abort
   with SIGTRAP if the wrong compile mode is used; we compile the main bundle with
   `compileElectronMainCode` and the utility-process service with `compileElectronCode`, but this
   must be verified against the exact shipped Electron in **POC-006**.

2. **javascript-obfuscator (hardening item 2).** Applied to the code that must stay JavaScript: the
   Editor bundle (`dist/ui/assets/*.js`, `debugProtection` on) and the Engine bundle
   (`resources/engine/bundle/*.js`, `debugProtection` **off** because it renders headless under
   Chrome Headless Shell, where a debugger-trap loop would stall a render). Options are strong but
   render-safe: `stringArray` + `rc4`, `stringArrayThreshold 1`, `controlFlowFlattening 0.5`,
   `deadCodeInjection 0.2`, `identifierNamesGenerator hexadecimal`, `selfDefending`, `splitStrings`,
   `transformObjectKeys`, no source maps. We deliberately leave `renameGlobals`/`renameProperties`
   off so Remotion's component-name resolution keeps working.
   **Verification (runs on Linux):** re-render one golden still after obfuscating the Engine bundle
   and pixel-diff it against the pre-obfuscation still:
   ```bash
   # after `node apps/desktop/scripts/harden.mjs` has obfuscated resources/engine/bundle
   node packages/engine/scripts/render-golden-still.mjs --preset <id> --ratio 16x9 --out /tmp/after.png
   # compare with the committed golden frame (TEST_PLAN parity, ≤ 1% diff)
   ```
   The obfuscator config itself is proven to produce runnable code on Linux by a standalone check
   (see "Verification on this server").

3. **Prompt/template asset encryption (hardening item 3, B6, SEC-132).** The generated prompts
   module is encrypted with AES-256-GCM. The key is **split**: one 32-byte half is a build constant
   compiled into the bytecode service module, the other is injected at build time; the Service
   combines them in memory only (`keysplit.ts` derives the key by XOR + SHA-256, so neither half
   alone reveals it). The decrypted prompts never touch disk.

4. **Startup integrity (hardening item 4, SEC-061, SEC-133).** The build generates
   `resources/integrity-manifest.json`: sha256 + size of `service.jsc`, the Engine bundle index and
   each `resources/bin` binary, signed with the Operator's Ed25519 **release key**. The embedded
   public key verifies the signature at startup and every file's digest; a mismatch refuses to start
   with **EM-8002**. This is in addition to Electron's own ASAR integrity fuse (SEC-133).

5. **Optional native hardening (hardening item 5).** `native/` is a documented stub for a Node-API
   C++ addon that would move licence verification and the prompt-key derivation into MSVC-compiled
   code. Not required to build; the pure-JS paths (`keysplit.ts`, the licence module) remain the
   fallback so Linux CI works. See `native/README.md`.

## Verification on this server (Linux, memory-capped)

Electron cannot run or be packaged on the shared Linux dev server (no display, 1.9 GB RAM,
AGENTS.md §4). Everything here is verified as typecheck + unit tests of the pure logic, run under
the global memory cap:

```bash
bash scripts/run-capped.sh npx tsc -p apps/desktop --noEmit      # clean
bash scripts/run-capped.sh npx vitest run apps/desktop           # 72 tests pass
bash scripts/run-capped.sh node apps/desktop/scripts/build-main.mjs   # dist/main.cjs + dist/preload.cjs
bash scripts/run-capped.sh node apps/desktop/scripts/harden.mjs --plan  # prints the plan (bytecode skipped off-Windows)
```

### What cannot be tested on Linux — **[UNVERIFIED]**

- Launching the Shell, the window, the tray, the app:// protocol handler at runtime, the native
  dialogs, `safeStorage`/DPAPI, `utilityProcess.fork` + `postMessage`, and the real restart
  supervision. These are wired in `main.ts` from the unit-tested pure helpers, but the wiring itself
  runs only on Windows (POC-005 for crash/restart, POC-010 for the HTTP guards).
- **bytenode on the shipped Electron ≥ 42** (SIGTRAP risk) — POC-006.
- The electron-builder NSIS build, signing, fuse flipping, ASAR integrity, differential updates and
  the installer smoke test (DEPLOYMENT §2 B7–B10) — Windows build machine.
- The golden-still re-render after Engine obfuscation needs Chrome Headless Shell + ~1 GB headroom;
  the config is proven runnable on Linux but the full render is run on Windows or a capped small
  still only.

## Needed from other packages

- `apps/ui` must build to `apps/desktop/dist/ui/` (served over `app://`).
- `apps/service` must build to `apps/desktop/dist/service/service.cjs` (forked by the Shell) and, on
  the service side, read the bootstrap on `process.parentPort` and reply `{type:'ready', port}` /
  `{type:'fatal', code}` (TRD TR-002); expose `privateMode` in `GET /api/v1/settings` and honour
  `POST /service/shutdown` with `X-Expertmotion-Caller: shell` (API §2.3, R-002).
- `packages/engine` must build to `apps/desktop/resources/engine/bundle/`; Chrome Headless Shell,
  the compositor and `resources/bin` must be staged before packaging (DEPLOYMENT §2 B3–B4).
- A `build/tray.png` tray icon and the NSIS `build/installer.nsh` + `build/EULA.txt` are added on the
  build machine (not in scope for the Linux-only work).
