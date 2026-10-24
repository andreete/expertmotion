# memory.md — durable project context

Read this before any work. Update it after architecture decisions, milestones, failed experiments and roadmap changes. Keep entries short and structured; link to the owning document instead of duplicating it. Never record API keys, passwords or personal data.

## 1. Product vision and non-negotiable constraints

- **Expertmotion**: local-first, AI-assisted motion video editor for non-technical creators; Windows desktop executable launching a local web editor; Remotion is the engine, never the interface. Brief: `docs/MASTER_PROJECT_PROMPT.md`.
- Constraints: no manual runtime installs for the Creator; project data and media local by default; outbound traffic only to configured providers and model downloads; Private Mode blocks all of it; realistic IP protection (never promise "impossible to reverse"); no unauthenticated local control interface; the LLM is never the sole enforcer of invariants; all documentation in English.
- Product name is always Expertmotion. "Remason" in the mockup is a reference name only.

## 2. Confirmed decisions (details in `docs/DECISIONS.md`)

| ADR | Decision | Status |
|---|---|---|
| 001 | Document-driven Remotion (`ExpertmotionTimeline` renders a JSON Composition Model); no runtime code generation | accepted |
| 002 | Hybrid edit pipeline: deterministic compile first, Editor Agent only for gaps; Locked Keys; transactional Execute with `baseVersion` | accepted |
| 003 | Brainstorming Agent + Editor Agent with independent models; deterministic runtime sub-agents | accepted |
| 004 | Electron shell (Remotion official pattern) | accepted |
| 005 | Private loopback HTTP + SSE Local Service with per-launch Service Token | accepted |
| 006 | Encrypted SQLite (`better-sqlite3-multiple-ciphers`), key wrapped by DPAPI via Electron `safeStorage`, media on disk | accepted |
| 007 | IP protection as defence in depth with honest boundaries | accepted |
| 008 | Installer bundles runtime + engines; model weights download on first use | provisional (Operator to confirm) |
| 009 | Local open-source models for Tools; social caption text + hashtags via the connected LLM | provisional (caption-text interpretation to confirm) |
| 010 | Performance Profiles are resource policies; fps is a project setting; ratios 16:9, 9:16, 1:1, 4:5, 5:4, 4:3, 3:4, Custom; resolutions 720p/1080p/2K/2160p | accepted |
| 011 | Prerendered catalogue loops + one live Player | accepted |
| 012 | English UI with i18n keys; Indonesian UI later; id/en content | accepted |
| 013 | New monorepo `/home/andre/expertmotion` (apps/desktop, apps/service, apps/ui, packages/composition-model, packages/catalogue, packages/engine, packages/agents, packages/models, packages/shared); port selected modules from `/home/andre/experthinker-studio` | accepted |
| 014 | Offline Ed25519 licence bound to Machine Fingerprint; Trial Mode | accepted |
| 015 | No MCP in MVP; typed in-process Tools | accepted |
| 016 | Priorities per brief §17: Tools in P1 (voice, captions) and P2 (music, thumbnails) | provisional (reconciliation flagged) |
| 017 | Remotion licence confirmation is a launch blocker | accepted |

Operator decisions given in chat on 2026-10-24: Windows first; local open-source models for generative Tools; new repo; offline signed licence key. The Operator intends to hand execution of later stages to other models (e.g. Opus); documents must be self-sufficient.

- Operator requirements 2026-10-24: no manual installs; maximum compression; maximum reverse-engineering cost (ADR-021); one Licence Key = one computer (ADR-022). Honest boundary kept: not impossible for the device owner.

## 3. Technology stack (pin exact versions in `docs/TRD.md`)

Node 22 LTS · Electron (current LTS) · Remotion ≥ 4.0.535 (evaluate 4.0.537+ for `@remotion/effects`, `@remotion/media`) · React 19 · Vite · Tailwind v4 · Zod 4 · Express · `better-sqlite3-multiple-ciphers` · Vercel AI SDK v6 (+ `@openrouter/ai-sdk-provider`) · `systeminformation` · Engine binaries: whisper.cpp, sherpa-onnx (Piper voices), stable-diffusion.cpp, optional embedded Python (ACE-Step).

## 4. Canonical locations

| Concept | Single source |
|---|---|
| Vocabulary | `docs/GLOSSARY.md` |
| UI element IDs | `docs/ELEMENT_IDS.md` |
| Composition Model JSON Schema, DDL | `docs/DATABASE_SCHEMA.md` |
| Intent / Plan / Operation schemas, op vocabulary, Target Resolution, Property Classes, Locked Keys | `docs/AI_WORKFLOW.md` |
| Agent roles and permissions | `docs/AGENT_DESIGN.md`; prompts in `SYSTEM_PROMPT.md` |
| Preset IDs | `docs/DESIGN_CATALOGUE.md` |
| Remotion mapping with sources | `docs/REMOTION_CAPABILITY_MAP.md` |
| Model registry | `docs/LOCAL_AI_MODELS.md` |
| Routes and SSE events | `docs/API_SPECIFICATION.md` |
| Ratio × resolution pixels, Performance Profiles, hardware tiers | `docs/PERFORMANCE.md` |
| Error codes | `docs/ERROR_CATALOGUE.md` |
| Risks | `docs/RISKS_AND_ASSUMPTIONS.md` |
| Runtime prompts (versioned) | `SYSTEM_PROMPT.md` (v1.0.1) |
| Consistency checks | `bash tools/docs-check.sh` (greps only; must pass before every commit) |

## 5. Important discoveries (verified 2026-10-24; URLs in `docs/ASSESSMENT.md`)

- Remotion: `@remotion/media` `<Video>/<Audio>` is the recommended tag; `trimBefore` + `durationInFrames`; 19 built-in transitions (+ `none`; `cube` is paid); `@remotion/effects` has 81 effects (WebGL; cylinder/sphere/pageTurn need WebGPU); Chrome Headless Shell and FFmpeg are distributed by Remotion packages; `renderMedia` supports `hardwareAcceleration` (NVENC on Windows), `concurrency`, `licenseKey`; Remotion's MCP is deprecated; Elements are 40+ source components (incl. 5 caption styles).
- Remotion licence: free for individuals and companies ≤ 3 people; Company License for 4+ (Automators $0.01/render, $100/month minimum); end-user-PC metering undefined; v5 makes telemetry mandatory. Launch blocker: confirm in writing.
- Packaging: Remotion has an official Electron template; the Local Service runs as an Electron `utilityProcess` (RunAsNode fuse off) with the bootstrap `{token, port, dataDir, dbKey}` over `parentPort`; FFmpeg for output ships in `@remotion/compositor-win32-x64-msvc` (slim), ingestion needs a separate full FFmpeg build; bytenode breaks `Function.toString` and crashes on Electron ≥ 42 (never on the renderer path); V8 bytecode and obfuscation are reversible; Windows EV certificates no longer bypass SmartScreen; Azure Artifact Signing is country-restricted (Indonesia not listed) → OV certificate from a CA.
- Storage: keytar is archived; Electron `safeStorage` uses DPAPI on Windows; `better-sqlite3-multiple-ciphers` ships Electron prebuilds.
- Local models: whisper.cpp large-v3 Indonesian WER ≈ 7%; Piper `id_ID-news_tts-medium` is the only offline Indonesian TTS found (engine piper1-gpl is GPL-3); Kokoro has no Indonesian; F5-TTS, XTTS-v2, Fish Speech, MusicGen are non-commercial; ACE-Step and FLUX.1-schnell are Apache-2.0; Stable Audio Open is under the Stability Community License; `@remotion/install-whisper-cpp` compiles from source on macOS/Linux and only has Windows prebuilts ≤ 1.6.0 → ship own binaries.
- Providers: OpenRouter returns `usage.cost`; OpenAI recommends the Responses API; Gemini has an OpenAI-compatible endpoint (beta); Anthropic Messages API with SSE.
- Book "Remotion untuk Pemula" (Septianus Angga, Remotion 4.0.537, Oct 2026): chapters map directly to catalogue categories; extracted text in `docs/assets/remotion-untuk-pemula-extracted-text.txt`.

## 6. Known limitations and open questions

- Stage 2 results so far (2026-10-24, Linux): POC-010 curl matrix 44/44; POC-005 DB half 69/69 over 3 runs; POC-004 offline half 19/19 (live half needs a key). Windows proofs not run. SEC-011 and NFR-020 were amended from these results.

- Indonesian TTS quality from open models is "news reader", not expressive.
- Local music generation needs Python + ≥ 4 GB VRAM for usable speed; fallback is a royalty-free loop library.
- JavaScript shipped to the Creator can be extracted by a determined attacker; encryption at rest does not protect against the device owner.
- Open (Operator): Remotion licence for end-user renders (ADR-017, BRD-010); ADR-008/009/016 await confirmation; product price and trial reminder policy (BRD); whether 2:3 / 3:2 ratios ("4:6 / 6:4") are added after demand review; the Piper `id_ID-news_tts-medium` voice card cites a dataset of unclear licence (RISK-002); whether Septianus Angga (author of the reference book) is a channel partner (ASM-016).
- Haiku dry-run 2026-10-24: the Editor Agent prompt works on a Haiku-class model for title/transition/locked-key cases; partial-plan rule added after it blocked a whole plan on one missing asset.
- The shared development server (1.9 GB RAM, Linux, no display) cannot build or run Electron; packaging and Windows QA happen on the Operator's PC or CI. Headless parts must run under the memory cap described in `CLAUDE.md`.

## 7. Stable conventions

- Requirement IDs: `PRD-`, `BRD-`, `FR-`, `NFR-`, `UX-`, `AI-`, `SEC-`, `QA-`, `ADR-`, `RISK-`, `POC-`, `EM-`; preset IDs `preset:<category>.<name>`; ops `op:<entity>.<verb>`; element IDs `el:<region>.<group>.<element>`.
- Every doc starts with the header table (Status, Owner, Last updated, Depends on, Used by).
- Times in the Composition Model are milliseconds; frames are derived at render.
- Commit after every batch of documents; `process.md` entry after every meaningful work unit.
- Phase rule (Operator, 2026-10-24): documentation phase ended and Stage 2 (PoC) started the same day on the Operator's instruction; proof code is throwaway under `poc/`, run on the shared server only via `bash poc/run-capped.sh`. Product code (Stage 3) only after Stage 2 exit criteria pass.
