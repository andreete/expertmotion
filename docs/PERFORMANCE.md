# Performance: hardware tiers, Performance Profiles, output dimensions, budgets

| Field | Value |
|---|---|
| Status | baseline (targets marked "to confirm" are re-measured in Stage 2 PoC) |
| Owner | Engine lead |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-010), ASSESSMENT.md |
| Used by | FRD.md, SRS.md, UI_UX_SPECIFICATION.md, DEPLOYMENT_AND_PACKAGING.md, TEST_PLAN.md, LOCAL_AI_MODELS.md |
| Owner of | Hardware Tiers, Performance Profiles, ratio × resolution pixel table, render/memory budgets, monitoring policy |

## 1. Hardware Tiers

Detected at startup by the Hardware Monitor and re-checked on demand. The tier decides defaults and which options are offered; it never blocks the core workflow.

| Tier | Detection rule | Defaults |
|---|---|---|
| **T0** CPU-only | no discrete GPU, or GPU without usable VRAM info, or VRAM < 4 GB | Profile Standard; `gl: 'swangle'` for WebGL effects; 2K/4K disabled with the EM-3105 reason ("needs a graphics card with at least 4 GB"); local models: whisper small/medium, Piper voices, SD 1.5 (slow) |
| **T1** GPU ≥ 4 GB | discrete or integrated GPU with ≥ 4 GB VRAM reported | Profile Accelerated available; `gl: 'angle'`; 2K enabled, 4K enabled with warning; whisper large-v3-turbo; SD 1.5 for thumbnails (FLUX.1-schnell q4 needs ≈ 7 GB + encoders → T2); ACE-Step small |
| **T2** GPU ≥ 8 GB | ≥ 8 GB VRAM | Profile Turbo available; `hardwareAcceleration: 'if-possible'` (NVENC on NVIDIA driver ≥ 525); all presets; FLUX.1-schnell; ACE-Step full |

RAM gates independent of tier: total RAM < 8 GB → warn at startup; free RAM < 2 GB before render → block render with `EM-3101`.

## 2. Performance Profiles (what Standard / Accelerated / Turbo actually do)

A Performance Profile is a resource policy. It never changes the frame rate or the output dimensions, and it never claims faster hardware (brief §13).

| Policy | Standard | Accelerated | Turbo |
|---|---|---|---|
| Render concurrency (`renderMedia.concurrency`) | 1 | min(2, threads/2) | min(4, threads/2), measured by benchmark |
| Preview quality in Player | Draft (proxy media URLs + 720p-row composition metadata) | Draft | Full (source media, export-row metadata) |
| `imageFormat` | jpeg | jpeg | jpeg (png only when alpha export is chosen) |
| `hardwareAcceleration` | disabled | if-possible (T2 only; falls back silently) | if-possible (T2 only) |
| `chromiumOptions.gl` | T0: swangle; T1/T2: angle | angle | angle |
| Memory ceiling for Local Service + Chrome | 40 % of total RAM | 55 % | 70 % |
| `offthreadVideoCacheSizeInBytes` / `mediaCacheSizeInBytes` | 256 MB | 512 MB | 1 GB |
| `disallowParallelEncoding` | true | false | false |
| Background tasks (ingest, model download) during render | paused | paused | allowed |
| Availability | all tiers | T1, T2 | T2 (T1 with warning) |

Tooltip copy (EN): "Profiles change how many frames render in parallel and how much memory Expertmotion may use. Faster profiles need more RAM and a GPU; the video itself is identical." (ID: "Profil mengatur berapa frame dirender bersamaan dan berapa memori yang boleh dipakai Expertmotion. Profil lebih cepat butuh RAM dan GPU lebih besar; hasil videonya sama.")

Auto-selection (P1, PRD-035): run `npx remotion benchmark`-equivalent once per machine on a 5 s sample; store in `hardware_profiles`.

## 3. Aspect Ratios and Resolutions: exact output pixels

Notation is width:height. Even dimensions only (H.264 requires multiples of 2). The preset number is always the **short side** (720, 1080, 1440, 2160): 16:9 1080p = 1920×1080 and 9:16 1080p = 1080×1920 (industry convention). The long side = round-to-even(short × ratio).

| Ratio | 720p | 1080p | 2K | 2160p (4K) | Typical use |
|---|---|---|---|---|---|
| 16:9 | 1280×720 | 1920×1080 | 2560×1440 | 3840×2160 | YouTube, presentations |
| 9:16 | 720×1280 | 1080×1920 | 1440×2560 | 2160×3840 | Reels, TikTok, Shorts |
| 1:1 | 720×720 | 1080×1080 | 1440×1440 | 2160×2160 | Instagram feed |
| 4:5 | 720×900 | 1080×1350 | 1440×1800 | 2160×2700 | Instagram portrait |
| 5:4 | 900×720 | 1350×1080 | 1800×1440 | 2700×2160 | print-like landscape |
| 4:3 | 960×720 | 1440×1080 | 1920×1440 | 2880×2160 | classic TV |
| 3:4 | 720×960 | 1080×1440 | 1440×1920 | 2160×2880 | portrait classic |
| Custom | short side = preset short side; long side = round-to-even(short × ratio) | | | | |

Rules:
- "2K" is defined as short side 1440 (QHD-class); table values are authoritative.
- Custom ratios are clamped to 1:3 … 3:1; width and height ≥ 240.
- Draft preview = the Player receives proxy media URLs and the 720p-row width/height as composition metadata (the Player has no `scale` option); export never uses Draft.
- `Auto` sets the ratio from the first inserted Clip's probe (`detectFormat` ported from Experthinker Studio, extended to the seven ratios; nearest ratio by aspect difference).
- The Composition Model stores ratio + resolution preset; pixel values are derived with this table at render (`calculateMetadata`).

Pixel labels shown under ratio buttons use the current Resolution (e.g. "1:1 · 1080×1080").

## 4. Frame rate

Project Settings frame rate ∈ {24, 25, 30, 50, 60}; default 30. Changing fps re-derives all frame counts from millisecond times; it never alters perceived timing. Clips with a different native fps are resampled by `@remotion/media`.

## 5. Budgets (NFR inputs; "to confirm" after POC-007)

| Metric | Target | Measured on |
|---|---|---|
| Cold start to interactive Editor | ≤ 5 s (to confirm) | reference laptop T0 |
| Player seek latency (Draft) | ≤ 100 ms | reference laptop |
| Catalogue hover → live preview update | ≤ 300 ms | reference laptop |
| Ingest 1 min 1080p30 H.264 clip (probe + proxy + thumbs) | ≤ 20 s | reference laptop |
| Render 30 s, 1080p30, 3 clips, 2 transitions, captions, Standard | ≤ 90 s (≈ 3× realtime, to confirm) | reference laptop |
| Same, Turbo on T2 | ≤ 30 s (to confirm) | T2 desktop |
| Idle RAM (Shell + Service + Editor) | ≤ 450 MB | reference laptop |
| Peak RAM during Standard render | ≤ 40 % of total RAM; never swap-thrash | reference laptop (16 GB → ≤ 6.4 GB) |
| Disk: installer (compressed, before models) | ≤ 450 MB (expected ≈ 300–400 MB) | POC-001 |
| Disk: app data baseline | ≤ 200 MB + media + models | — |
| Catalogue loops total | ≤ 40 MB (webm, 2 s, 480 px) | build |

Development-server note: on the shared 1.9 GB Linux server only headless parts may run (composition-model tests, service unit tests, small stills) under the existing cgroup cap (soft 900 MB, hard 1.2 GB, concurrency 1). Full renders and Electron are tested on Windows hardware.

## 6. Monitoring policy

- Cheap meter every 2 s from Node `os` (total/free RAM, `process.memoryUsage()`, CPU via delta of `os.cpus()` times).
- `systeminformation` for disk, GPU (`graphics()`), and static CPU info: at startup, on opening the Hardware Monitor, and before render; never more often than every 30 s because Windows calls spawn PowerShell.
- GPU utilisation shown only when nvidia-smi is available; otherwise "GPU: present / not detected" without a percentage.
- Overhead budget: < 1 % CPU, < 20 MB RAM.
- Privacy: readings stay local; shown in Diagnostics; never transmitted.

## 7. Pre-render checks (Export preflight)

| Check | Rule | Error |
|---|---|---|
| Disk | free space ≥ 3 × estimated output size + 500 MB | EM-3102 |
| Memory | free RAM ≥ 2 GB (Standard) / 3 GB (Accelerated) / 4 GB (Turbo) | EM-3101 |
| Dimensions | even, within 240 … 4096 per side, matches table | EM-3103 |
| Duration | 1 s … 30 min; transitions overlap already subtracted | EM-3104 |
| Assets | all referenced assets present and probed | EM-1301 |
| Chrome/FFmpeg | engine binaries present and executable | EM-3001 |
| Resolution vs tier | selected Resolution allowed for the current Hardware Tier (UI already disables higher ones; preflight re-checks after a tier change) | EM-3105 (info; offers the highest allowed preset) |
| Licence | Trial Mode → force 720p + watermark; show notice | EM-5001 (notice) |

## 8. Known slow paths and mitigations (from Remotion docs and the book §8.6)

| Cause | Mitigation in Expertmotion |
|---|---|
| High resolution | Draft preview; export resolution gated by tier |
| Wrong concurrency | profiles + benchmark |
| Heavy codecs (VP8/VP9/AV1) | H.264 default; WebM only for alpha export |
| PNG frames | JPEG unless alpha |
| Heavy effects/WebGL without GPU | `swangle` + warning badge on GPU-heavy presets; limit to 2 simultaneous effects on T0 |
| Legacy video tag | always `@remotion/media` |
| Fonts from network | bundled woff2 only |
