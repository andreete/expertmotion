# Assessment (Deliverable A): repository, references, Remotion, feasibility

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Principal architect |
| Last updated | 2026-10-24 (all web sources accessed 2026-10-24) |
| Depends on | MASTER_PROJECT_PROMPT.md |
| Used by | PRD.md, BRD.md, ARCHITECTURE.md, RISKS_AND_ASSUMPTIONS.md, DECISIONS.md |

Facts are separated from assumptions. Items marked **[UNVERIFIED]** were not confirmed against a primary source and must be checked before anyone relies on them.

## 1. Existing repository: `/home/andre/experthinker-studio`

Experthinker Studio is the predecessor: an npm-workspaces monorepo (~7.7k lines TypeScript, not a git repository) that renders six fixed Remotion templates for an Indonesian explainer-video brand, with an Express API, a React dashboard and an MCP server for Claude.

| Workspace | Purpose | Key facts |
|---|---|---|
| `packages/video` | Remotion 4.0.535 project | `brand.ts`, `formats.ts` (vertical/landscape/square/portrait + safe areas, `detectFormat`), `layout.tsx` (`useLayout`, unit `u = min(w,h)/1080`), `fit.ts` (`fitText` without DOM), `schemas.ts` (React-free registry, `computeMetadata`, `getJsonSchema` via Zod 4.5.4), `registry.tsx`, `validation.ts`; components `KineticText`, `AnimatedNumber`, `BarChart`, `LineChart`, `SceneShell`, `SourceTag`, `Logo`; compositions Explainer, HookIntro, DataExplainer, KeyFact, Contrast, ReflectiveOutro; 22 tests via `tsx`. |
| `apps/server` | Express 4 + better-sqlite3 12 | `queue.ts` (RenderQueue: enqueue/cancel/ETA/throttled progress/auto-thumbnail), `bundler.ts` (BundleManager with chokidar watch, keeps last good bundle), `browser.ts` (`browserReady` warm-up), `stills.ts` (`renderStillCached`), `app.ts` (routes, `openSse` SSE helper, Host/Origin guards), `db.ts` (tables `renders`, `presets`, `settings`), `config.ts` (`STUDIO_PORT` default 4000, `RENDER_CONCURRENCY`). |
| `apps/dashboard` | Vite 6 + React 19 + Tailwind v4 + `@remotion/player` | `store.tsx` (SSE store), `components/SchemaForm.tsx` (JSON-Schema form with `oneOf` scene lists), `components/ui.tsx`, `pages/Editor.tsx` (Player wrapper sized from metadata, safe-area overlay). |
| `apps/mcp` | stdio MCP server (SDK 1.32) | thin HTTP client of the API; `render_video` gated by `userApproved`. |
| `scripts/` | `dev-capped.sh` (systemd cgroup memory cap), `print-mcp-config.mjs` | server-specific. |

Conventions worth keeping: pinned identical `@remotion/*` versions; React-free schema module shared by server and UI; format as a prop with shared `computeMetadata`; local woff2 fonts via `@remotion/fonts`; SSE with 15 s heartbeat; render jobs persisted in SQLite and marked failed on restart.

Reusable for Expertmotion (port list in `BLUEPRINT.md`): render queue, bundle manager (prebuilt path only), browser warm-up, stills cache, SSE helper, util (`HttpError`, `newId`, `sha1`, `sanitizeFilename`), formats/safe areas, layout unit, `fitText`, Player wrapper, SSE store, UI kit, SchemaForm (inspector fallback). Not reusable: brand, evidence-first rules (`source`/`date`/confidence), the six templates and Indonesian defaults, id-ID number formatting as default, MCP tools, repo-relative paths, dev-server memory scripts.

Gaps relative to Expertmotion: no timeline model (fixed props per template), three hand-edited registrations per template, no desktop packaging, no asset ingestion, no agents, paths relative to the repo instead of app data.

Operational constraint of the development server (relevant until development moves to a Windows machine): Ubuntu 24.04, 1.9 GB RAM, 2 CPUs, shared with another tenant; Studio processes must stay under a 900 MB soft / 1.2 GB hard cgroup cap; ports 3000/4000 belong to the other tenant (Studio uses 4100); no display, so Electron cannot run or be built there.

## 2. UI reference: `docs/assets/expertmotion-editor-mockup.png`

Inspected at full resolution (4269×9163). The upper third holds four yellow cards with the menu contents; the lower part is a dark three-column editor titled "Remason Editor" (reference name only).

| Region | Visible content | Interpretation / assumption |
|---|---|---|
| Yellow cards | File: Open, New Video, Save, Save as, Import, Export, Setting (1 Frame, 2 FPS, 3 Duration). Home: Font, Colour, Font Size, Add Text, Text Effect, Text Style, Video Size, Ratio Setting, Opacity, Insert Image, Insert Video. Design: Transition, Captions, Background, Motions, Shapes, Easing, Visual Effects, Audio. Tools: Generate Voice, Generate Music, Generate Thumbnail, Generate Caption + Hashtag. | Menu contents of the Header tabs. The brief §7.1 adds Recent projects and Recovery to File, and alignment/weight to Home; both are adopted. |
| Header | Wordmark, menus File Home Design Tools Help, title "Untitled", icons (display, save, cloud-upload, cloud-sync with badge, grid), "Purchase" button, avatar, "Export" button (disabled look), window controls. | Cloud icons repurposed to local Backup/Restore (no cloud); avatar = licence status (no accounts); display icon = Hardware Monitor; grid = Model Manager. See `ELEMENT_IDS.md`. |
| Left column | Search "People are searching for…"; "Preview" grid of four cards (Pale Clarity, Strip Wipe, Sharding Down, Dream Drift) with lock/download badges; "Asset Upload" grid of four clips (Cute Ghost, Hallo…Sweep, Dark F…Reveal, Rollin…umpkin); blue "Insert" button. | Design-mode Library Panel. Card names are placeholders. Badges = "model not installed". Sequence ordering badges are added (brief §7.2). |
| Centre | "Player" panel with a landscape image and a hamburger menu; three timeline rows "Drag material here and start to create". | Player + Timeline View. Rows become five Tracks; copy replaced because the timeline is read-only for the Creator (brief §7.3 allows limited interactions, kept P1). |
| Right column | Model selector "Model: MiniMax H3"; "Brainstorming Agent" chat with two assistant messages, composer "Hey Adam!", footer "Claude 3.5 Sonnet ▾ … anthropic 0 / 200000"; "Editor Agent" chat with the same footer and an "Execute" button; settings: Speed (Standard, Accelerated, Turbo), Video Dimensions (16:9, 1:1, 9:16, Custom; "Auto"), 480p 480×480 / HD 768×768 / 2K 1440×1440 / 4K 2160×2160 (2K and 4K greyed), Private Mode toggle, "Reset to Defaults". | Agent Panel. Top selector = default Provider Connection; footers = per-agent Model Assignment + context usage. Speed = Performance Profile (brief §13), not fps. Pixel labels in the mockup are for 1:1 at a small size; the real table is in `PERFORMANCE.md`; 480p becomes draft preview quality. |

Mockup text is English; the Creator persona is Indonesian (ADR-012).

## 3. Reference book: `docs/assets/remotion-untuk-pemula.pdf`

"Remotion untuk Pemula: Membuat Video dengan Kode, dari Nol", Septianus Angga, Edition 1, October 2026, Remotion 4.0.537, 107 pages, A4, produced with Chromium/Skia. Read in full; extracted text in `docs/assets/remotion-untuk-pemula-extracted-text.txt`.

What it teaches, and what Expertmotion must therefore automate:

| Chapter | Content | Expertmotion feature |
|---|---|---|
| 1 Remotion itu apa | frames, fps, "a frame is a function of its index", Chrome screenshots + FFmpeg | hidden; explains why preview = render |
| 2 Menyiapkan alat | Node, `npx create-video`, Studio, agent skills | eliminated by the Desktop Shell |
| 3 Video pertamamu | Composition (id, width, height, fps, durationInFrames), sizes 1080×1920 / 1920×1080 / 1080×1080 / 1080×1350, `useCurrentFrame`, `useVideoConfig`, `<Still>`, `<Folder>` | Project Settings, Output Profile, thumbnails via still |
| 4 Mendesain tampilan | pixels, positions, layers/`AbsoluteFill`/zIndex, 3 colour notations, 6 palettes with contrast ratios, 7 font moods, size guide for 1080×1920 (title 90–140, heading 64–90, body 44–56, source ≥ 34), Google Fonts vs local woff2, 9 CSS backgrounds, `@remotion/shapes`, `@remotion/rough-notation` highlights, `<Sequence from durationInFrames>`, `<Series>` | Theme, Text Panel, Backgrounds, Shapes, Text Effects, timeline model |
| 5 Membuat gerak | `interpolate` (+ clamp), 5 basic transforms (translate, scale, rotate, skew, opacity) as separate CSS props, Easing guide (in/out/inOut/back/bounce), `spring` (damping/stiffness/mass/delay/durationInFrames), `interpolateColors`, seeded `random`, `<TransitionSeries>` with 19 presentations and `linearTiming`/`springTiming`, overlap shortens duration, `@remotion/effects` 81 effects via `effects` prop (WebGL; `--gl=angle`; `swangle` on CPU; cylinder/sphere/pageTurn need WebGPU), other packages (paths, noise, motion-blur, lottie, three, layout-utils, light-leaks) | Motion presets, Easing, Transitions, Visual Effects |
| 6 Memasukkan media | `public/` + `staticFile`, `<Img>`, `<AnimatedImage>`, `@remotion/media` `<Video>` (trimBefore, playbackRate, volume, muted, loop, objectFit), `<Sequence from>` placement, dark gradient over video, `colorKey` greenscreen, `<Audio>` volume curves, ducking, multiple audio layers, Remotion does not generate speech, `visualizeAudio` | Asset ingestion, Clips, Audio treatments |
| 7 Props dan caption | props/`defaultProps`/`--props`, Studio props editor (auto since 4.0.516), Zod optional, `calculateMetadata` (duration from data, fetch), SSR loop (`bundle` → `selectComposition` → `renderMedia`), 3 reusable templates, captions: whisper options table, `Caption` shape, `createTikTokStyleCaptions`, page rendering with active-word highlight, `whiteSpace: pre`, 4 caption styles (editorial, karaoke, box, pop) | Composition Model, render pipeline, Captions |
| 8 Render | Studio Render button, CLI, `still`, `--frames`, flags, 6 codecs with CRF table (h264 18, h265 23, vp8 9, vp9 28, av1 30; ProRes profiles), GIF, alpha (vp8/vp9 + png + yuva420p), audio-only, slowness causes (resolution, concurrency, codec, PNG, heavy effects, old video tag), `benchmark`, `--log=verbose`, Lambda/Cloud Run/Docker, Player, licence (free ≤ 3 people; 4+ Company License), common errors (flicker from non-frame-based motion, `delayRender` timeout, "Target closed" = memory) | Export dialog, Performance Profiles, Error Catalogue |
| App. A/B/C | 81 effects grouped (colour & light; blur & focus; pixel & dots; lens & warp; edges & shadows; textures & generated backgrounds; reveal & wipe; 3D); 19 transitions described; cheat sheet; glossary | Design Catalogue seeds |

The book is honest about what it tested (shapes, all effects except 3, all transitions, 4 caption styles, render flags) and what it only read (whisper, visualizeAudio, noise, motion-blur, Lottie, Three, Lambda, Player). Expertmotion's PoC must test the "only read" items it depends on (whisper, Player parity).

## 4. Official Remotion resources

| Topic | Finding | Source |
|---|---|---|
| Site structure | Products (Plugins, Player, Lambda, Editor Starter, Timeline, Recorder, Convert); Resources (Elements, Templates, Prompts, Learn, Blog, Showcase); Commercial (License + Pricing, Store, Experts). | https://www.remotion.dev/ |
| Learn | `/learn` opens one tutorial ("Recreating the Apple fireworks animation"), not a curriculum. | https://www.remotion.dev/learn |
| Elements | 40+ drop-in **source** React components in 11 categories (Audio, Backgrounds, Captions ×5, Charts, Effects, Layouts, Maps, Overlays incl. Social Safe Zones, Storytelling, Text Effects, YouTube). Installed from Studio ("Browse Elements"). No price shown **[UNVERIFIED licence terms]**; falls under the Remotion License. | https://www.remotion.dev/elements, https://www.remotion.dev/docs/elements |
| Store | Editor Starter $600 (timeline, canvas, fonts, uploads, 80+ flags), Timeline $300, Colors and Shapes $20, Cube Transition free. | https://www.remotion.pro/store, https://www.remotion.dev/docs/editor-starter |
| Video tag | `@remotion/media` `<Video>`/`<Audio>` recommended for new code; `<OffthreadVideo>` legacy; `<Html5Video>` = old tag. `trimBefore` + `durationInFrames` (`trimAfter` deprecated); props `playbackRate`, `volume` (number), `muted`, `loop`, `objectFit`, `crop*`, `effects`, `premountFor`/`postmountFor`, `onError`; no reverse playback. | https://www.remotion.dev/docs/media, /docs/media/video, /docs/video-tags |
| Sequence | `from`, `durationInFrames`, `layout`, `premountFor` (Studio default 2 s from 4.0.535), `postmountFor`. | https://www.remotion.dev/docs/sequence |
| Transitions | fade, pushCut, slide, wipe, flip, clockWipe, iris, zoomBlur, dreamyZoom, filmBurn, linearBlur, bookFlip, zoomInOut, dissolve, ripple, crosswarp, crossZoom, swap, blurSlide, none; `cube` paid; `linearTiming`, `springTiming`; `<TransitionSeries.Overlay>`. Exact version of each newer presentation **[UNVERIFIED]**. | https://www.remotion.dev/docs/transitions/presentations |
| Effects | `@remotion/effects` since 4.0.464; `effects` prop on `<Solid>`, `<CanvasImage>`, `<Img>`, `<Video>`, `<HtmlInCanvas>`, shapes; WebGL; `--gl` values null/angle/egl/swiftshader/vulkan/angle-egl/swangle. | https://www.remotion.dev/docs/gl-options, book App. A |
| Captions | `Caption {text,startMs,endMs,timestampMs,confidence}`, `createTikTokStyleCaptions`, `parseSrt`, `parseVtt`, `serializeSrt`; transcription via `@remotion/install-whisper-cpp` (compiles from source on macOS/Linux, Windows prebuilt ≤ 1.6.0), `@remotion/whisper-web`, `@remotion/whisper-webgpu`, `@remotion/openai-whisper`, `@remotion/elevenlabs`. | https://www.remotion.dev/docs/captions/api, /docs/captions/transcribing, /docs/install-whisper-cpp/install-whisper-cpp |
| Layout/text | `@remotion/layout-utils`: `measureText`, `fitText`, `fitTextOnNLines`, `fillTextBox`; `@remotion/fonts`, `@remotion/google-fonts`; `@remotion/zod-types` supports Zod 4 since 4.0.426. | https://www.remotion.dev/docs/layout-utils, /docs/zod-types |
| Player | required `component|lazyComponent`, `durationInFrames`, `fps`, `compositionWidth/Height`; `inputProps`, `controls`, `loop`, `clickToPlay`, `playbackRate`, `initialFrame`, `inFrame`/`outFrame`, `renderLoading`, `renderPoster`, `errorFallback`, `acknowledgeRemotionLicense`; ref `play/pause/toggle/seekTo/getCurrentFrame/isPlaying/mute/setVolume/addEventListener`; events play, pause, seeked, timeupdate, frameupdate, ended, error, waiting, resume. | https://www.remotion.dev/docs/player/api |
| Renderer | `bundle`, `selectComposition`, `renderMedia` (codec, crf, concurrency default half the threads, onProgress, cancelSignal, frameRange, scale, imageFormat, pixelFormat, x264Preset, proResProfile, audioCodec, videoBitrate, chromiumOptions{gl…}, chromeMode, offthreadVideoCacheSizeInBytes, mediaCacheSizeInBytes, disallowParallelEncoding, hardwareAcceleration disabled/if-possible/required, binariesDirectory, licenseKey, timeoutInMilliseconds), `renderStill`, `ensureBrowser`. Hardware acceleration: VideoToolbox on macOS; NVENC on Windows/Linux for h264/h265 (driver ≥ 525); no `crf` with it. | https://www.remotion.dev/docs/renderer, /docs/hardware-acceleration, /docs/encoding |
| Chrome Headless Shell | auto-downloaded (since 4.0.247) into `node_modules/.remotion/chrome-headless-shell/<platform>/`, version pinned by a `VERSION` file; `browserExecutable` override; platforms mac-arm64, mac-x64, linux64, linux-arm64, win64; size not stated **[UNVERIFIED, estimate ~100 MB]**. | https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell |
| FFmpeg | bundled slim build since v4 in `@remotion/compositor-*` **[package name UNVERIFIED by fetch]**; `npx remotion ffmpeg`. | https://www.remotion.dev/docs/ffmpeg |
| Electron | official template (experimental): `bundle()` at package time, `renderMedia()` in main, IPC via preload. No Tauri guide exists. | https://www.remotion.dev/docs/electron |
| Studio | props editor from defaultProps/Zod; canvas drag/scale/rotate, keyframes, drop effects (4.0.475); `saveDefaultProps`, `writeStaticFile`. | https://www.remotion.dev/docs/visual-editing, /docs/studio/interactivity |
| AI | `/docs/ai` hub; docs as Markdown (`.md` suffix, `llms.txt`); Agent Skills `npx skills add remotion-dev/skills`; Claude Code plugin; **Remotion MCP deprecated** (shutdown no earlier than 2026-08-31). | https://www.remotion.dev/docs/ai, /docs/ai/skills, /docs/ai/mcp |
| Licence | Free: individuals, companies ≤ 3 people, non-profits, evaluation; unlimited commercial use. Company License for 4+: Creators $25/seat/mo; **Automators $0.01/render, $100/mo minimum** ("video editors, prompt-to-video apps, embedding the Player"); Enterprise from $500/mo. A render = successful video/audio/GIF/still/sequence; previews do not count. End customers need no licence. Not allowed: letting users bring their own Remotion code; reselling modified Remotion. End-user-PC metering not defined. `@remotion/licensing` + `licenseKey`; reporting mandatory from v5. | https://www.remotion.pro/license, https://www.remotion.dev/docs/license/faq, https://www.remotion.dev/docs/pricing, https://www.remotion.dev/docs/licensing |
| System requirements | page returned 404; Node/OS minimums **[UNVERIFIED]**; the book cites macOS 15+, glibc ≥ 2.35, Node 20.19+/22.13+/24+. | book §2.1 |

## 5. Desktop packaging options (brief §4.2 criteria)

| Option | Install simplicity | Remotion compatibility | Native deps | RAM / size | Signing/update | Verdict |
|---|---|---|---|---|---|---|
| **Electron** | one installer | official template | prebuilds for better-sqlite3(-multiple-ciphers) | ~130–200 MB idle; installer 80–200 MB + Chrome Headless Shell | mature (electron-builder, fuses, auto-update) | **selected (ADR-004)** |
| Tauri 2 + Node sidecar | one installer | no guide; preview in WebView2 (parity risk) | sidecar must be pkg/SEA-built; addons extracted | shell 30–50 MB, but Node + Headless Shell added | updater requires signature | rejected for MVP |
| Neutralino | small | backend as WebSocket extension; ship own Node | manual | small | weak ecosystem | rejected |
| Node SEA alone | needs a browser | fine for the service | addons via `process.dlopen` from temp; ESM limits | small | manual | rejected (no window/tray/keychain) |
| @yao-pkg/pkg | — | fine | extracts `.node` to temp | — | — | only as a sidecar builder |
| Bun `--compile` | — | rendering under Bun **[UNVERIFIED]** | embeds analysable addons | — | — | rejected |

Sources: https://v2.tauri.app/learn/sidecar-nodejs/, https://nodejs.org/api/single-executable-applications.html, https://github.com/yao-pkg/pkg, https://bun.com/docs/runtime/node-api, https://www.remotion.dev/docs/electron, https://electronjs.org/docs/latest/tutorial/asar-integrity.

Code protection facts: minification is reversible; `javascript-obfuscator` output is routinely reversed (webcrack, synchrony); V8 bytecode (bytenode, pkg "traditional", electron-vite plugin) is decompilable (View8, Ghidra plugin) and version-locked; bytenode removes function source so `Function.prototype.toString` breaks and arrow functions crash in Puppeteer contexts, and it crashes on Electron ≥ 42 → never on the renderer path. Sources: https://cdn.jsdelivr.net/npm/bytenode@1.7.0/README.md, https://research.checkpoint.com/2024/exploring-compiled-v8-javascript-usage-in-malware/, https://electron-vite.org/guide/source-code-protection.

Signing: Windows EV certificates no longer grant immediate SmartScreen reputation; Azure Artifact Signing (~$9.99/mo) is limited to organisations in US/CA/EU/UK (Indonesia not listed **[UNVERIFIED current list]**) → OV certificate from a CA. macOS later: Developer ID + notarization; every embedded binary signed. Sources: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options, https://www.todesktop.com/blog/posts/windows-apps-psa-ev-certs-do-not-grant-immediate-reputation-anymore.

## 6. Local storage and credentials

- `better-sqlite3-multiple-ciphers`: better-sqlite3 API + `PRAGMA key`/`rekey`, ChaCha20-Poly1305 default, SQLCipher-compatible mode, Electron prebuilds. https://github.com/thecodrr/better-sqlite3-multiple-ciphers
- Key storage: keytar is archived; Electron `safeStorage` (DPAPI on Windows; Linux may fall back to `basic_text`, detect with `getSelectedStorageBackend()`); `@napi-rs/keyring` as an alternative. https://www.electronjs.org/docs/api/safe-storage
- Boundary: with the key or its derivation on the device, the device owner or an admin can recover data; encryption protects against other users, stolen disks and out-of-session malware only.

## 7. Local AI models (Indonesian + English, commercial use)

| Task | Candidate | Indonesian | Licence | Runtime | Notes |
|---|---|---|---|---|---|
| STT (captions) | whisper.cpp (ggml large-v3 / medium / small) | yes, WER ≈ 7.4 % (CV17, large-v3) | MIT (engine), model OpenAI MIT | prebuilt binary | ship own signed binaries |
| STT | sherpa-onnx (`sherpa-onnx-node`) | Indonesian k2 models exist | Apache-2.0 | npm native | also does TTS |
| TTS | Piper `id_ID-news_tts-medium` on sherpa-onnx | yes (news voice) | engine piper1-gpl **GPL-3**; voice card to check | ONNX via sherpa-onnx | only offline Indonesian option found |
| TTS | Kokoro-82M | no | Apache-2.0 | ONNX | English only |
| TTS | F5-TTS, XTTS-v2, Fish/OpenAudio S1, OmniVoice | varies | non-commercial | Python | excluded |
| TTS | Chatterbox (MIT), Qwen3-TTS (Apache-2.0), MeloTTS (MIT), Orpheus | no Indonesian listed | permissive | Python | watch list |
| Music | ACE-Step 1.5 | n/a | Apache-2.0 | Python/PyTorch, from 4 GB VRAM | heaviest item |
| Music | Stable Audio Open | n/a | Stability Community License (< $1M revenue) | Python | alternative |
| Music | MusicGen | n/a | CC-BY-NC | — | excluded |
| Image | FLUX.1-schnell | n/a | Apache-2.0 | stable-diffusion.cpp (q4 ≈ 6.5 GB VRAM) | T2 default |
| Image | SD 1.5 | n/a | OpenRAIL-M | stable-diffusion.cpp (CPU 512 px ≈ 2.3 GB RAM) | T0/T1 default |
| Image | SDXL-Turbo | n/a | licence to re-check (Community License?) | sd.cpp | **[UNVERIFIED]** |

Sources: https://huggingface.co/rhasspy/piper-voices/discussions/40, https://github.com/SWivid/F5-TTS, https://stability.ai/license, https://comfyui-wiki.com/en/models/ace-step, https://huggingface.co/openai/whisper-large-v3, https://www.remotion.dev/docs/install-whisper-cpp/install-whisper-cpp. Cloud fallbacks (not MVP): OpenRouter TTS/images endpoints, ElevenLabs (Indonesian), Google Chirp 3 HD `id-ID`; Suno has no public API.

## 8. Providers

| Provider | Endpoint | Tool calling / structured output | Usage & cost | Source |
|---|---|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions`; `GET /api/v1/models` (pricing strings, `supported_parameters`, `context_length`) | passes through per model; filter `?supported_parameters=tools` | `usage.cost` in every response (last SSE chunk) | https://openrouter.ai/docs/api-reference/overview, https://openrouter.ai/docs/guides/administration/usage-accounting |
| OpenAI | Responses API recommended (Chat Completions still works; Assistants API ends 2026-08-26) | yes | token usage | https://platform.openai.com/docs |
| Anthropic | `POST /v1/messages`, headers `x-api-key`, `anthropic-version`, SSE streaming | tool use; adaptive thinking on current models | `usage` tokens; cost from price table | https://platform.claude.com/docs/en/build-with-claude/streaming |
| Google Gemini | OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai/` (beta) + native API | function calling | token usage | https://ai.google.dev/gemini-api/docs/openai |
| Abstraction | Vercel AI SDK v6 (OpenAI, Anthropic, Google first-party; `@openrouter/ai-sdk-provider` community) | unified tool calling, streaming, usage | — | https://ai-sdk.dev/providers/ai-sdk-providers |
| MCP | spec 2026-07-28; stdio + Streamable HTTP | — | — | https://modelcontextprotocol.io/specification/latest |

## 9. Hardware monitoring

`systeminformation` v5 (MIT; v6 beta): CPU, memory, disk, GPU vendor/model/VRAM on all OSes; GPU utilisation/temperature only via nvidia-smi; on Windows calls spawn PowerShell (slow; poll rarely, cache; WMIC removed on new Windows 11). Node `os` module for a cheap RAM/CPU meter (`os.loadavg()` is 0 on Windows). https://systeminformation.io/

## 10. Feasibility and licensing assessment

| Item | Assessment |
|---|---|
| Zero-install Windows executable | Feasible with Electron: bundle Node (inside Electron), prebuilt Remotion bundle, Chrome Headless Shell (~100 MB), FFmpeg (compositor package), engine binaries. Installer ≈ 300–400 MB before models. |
| Preview-to-render parity | Good: Electron's Chromium and Chrome Headless Shell are both Chromium; still must be tested (POC-002). |
| Remotion licence | Free while the Operator's company ≤ 3 people. Selling a desktop editor that renders on the Creator's PC is not covered explicitly; Automators pricing could apply if the company grows. **Launch blocker: written confirmation (ADR-017).** v5 telemetry vs Private Mode is an open conflict. |
| IP protection | Achievable as "expensive to extract", not "impossible" (ADR-007). |
| Encrypted local data | Achievable against third parties, not against the device owner (ADR-006). |
| Indonesian TTS | Only Piper news voice offline; expressive Indonesian needs a cloud voice later. |
| Local music | Needs Python + GPU; P2; loop-library fallback. |
| Build/QA environment | Needs a Windows machine or CI; the current dev server cannot run Electron. |

## 11. Gaps, conflicts and risks (summary; full register in `RISKS_AND_ASSUMPTIONS.md`)

1. Remotion licence for end-user renders undefined (RISK-001).
2. Operator's chat decision "local models for all Tools" vs brief §17 priorities → ADR-016 (Tools in P1/P2).
3. "Everything inside the .exe" vs model weight size → ADR-008 (download on first use).
4. Mockup "Speed" vs brief §13 → ADR-010 (performance profiles).
5. Mockup 480p vs brief 720p minimum → draft preview quality.
6. Indonesian TTS quality; Piper GPL engine.
7. Windows code-signing cost and SmartScreen reputation.
8. Electron RAM on low-end PCs; two Chromium instances during render.
9. WebGL effects on machines without GPU (`swangle` fallback, slower).
10. LLM cost surprises → budget limits and usage display.
11. Scope creep beyond P0.
