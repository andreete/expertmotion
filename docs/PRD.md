# Product Requirements Document (PRD)

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Product manager |
| Last updated | 2026-10-24 |
| Depends on | MASTER_PROJECT_PROMPT.md, ASSESSMENT.md, GLOSSARY.md, DECISIONS.md |
| Used by | BRD.md, FRD.md, SRS.md, UXRD.md, ROADMAP.md, TEST_PLAN.md |
| ID range | PRD-001 … PRD-099 |

## 1. Vision

Expertmotion lets a person with no editing team and no technical skills turn raw clips into a polished motion video by selecting, previewing and describing what they want. A Brainstorming Agent helps with ideas; an Editor Agent turns picks and instructions into validated edits; Remotion renders the result locally. The Creator never sees code, Node.js, npm or Remotion.

**Primary objective** (brief §24): a reliable Windows desktop executable that launches the editor, bundles the runtime, protects implementation details as realistically as possible, and supports a complete, verified workflow from project creation to exported video.

## 2. Personas

| Persona | Who | Goals | Pain today |
|---|---|---|---|
| **Septi, the Creator** (primary) | Indonesian content creator, 20–35, posts short videos (Reels/TikTok/Shorts) and YouTube explainers; no team; uses a mid-range Windows laptop; comfortable with CapCut-style apps | Produce consistent, animated videos fast; reuse a style; add captions; export in the right ratio | Motion graphics need After Effects skills or a freelancer; code tools (Remotion) need Node/npm; AI tools are cloud-only and per-use priced |
| **Small business owner** | Runs a shop or service, makes promo videos | Same as above with brand consistency | Same |
| **Andre, the Operator** | Builds, signs, licenses and supports Expertmotion | Ship a sellable product; protect IP; keep support load low | Shared 1.9 GB dev server; no Windows CI yet |

## 3. The core workflow (brief §2)

1. Launch `Expertmotion.exe` → the Desktop Shell starts the Local Service and opens the Editor.
2. First run: onboarding (licence or trial, provider connection, model assignment, hardware check, tour).
3. Import assets by drag-and-drop; ingestion probes, transcodes if needed, makes proxies and thumbnails.
4. Order assets with Sequence Badges; **Insert** places them as Clips.
5. Pick designs in Design/Home; each pick becomes an Edit Intent in the Intent Queue.
6. Talk to the Brainstorming Agent; it proposes Edit Intents to hand to the Editor Agent.
7. The Editor Agent produces an Edit Plan; the Creator presses **Execute**; the Composition Model gains a new version.
8. Preview in the Player; inspect the Timeline View.
9. Set Output Settings; Export renders locally with progress and cancellation.

## 4. Scope

### 4.1 P0 — essential MVP (every item must ship in v1.0)

| ID | Requirement | Rationale | Acceptance (summary; full criteria in FRD/TEST_PLAN) |
|---|---|---|---|
| PRD-001 | Packaged Windows desktop application; no manual installation of Node.js, Python, C++ toolchains or npm | brief §4.2 | Clean Windows 10/11 VM without dev tools: install, launch, create a project, render 10 s video |
| PRD-002 | Local Editor served by the Desktop Shell with the three-column layout (Library Panel, Stage, Agent Panel) and Header menus File/Home/Design/Tools/Help | brief §7 | All `el:` IDs in ELEMENT_IDS.md present |
| PRD-003 | Project creation, opening, saving, Save As, recent projects, autosave and recovery | brief §7.1 | Kill the app mid-edit → reopen → last checkpoint ≤ 10 s old restored |
| PRD-004 | Local persistence in an encrypted SQLite database plus media folder | brief §11 | DB unreadable without the OS-wrapped key; media listed in index |
| PRD-005 | Import of video (MP4/MOV/WebM/MKV), image (PNG/JPG/WebP/GIF/AVIF), audio (MP3/WAV/AAC/M4A/OGG/FLAC) and subtitle (SRT/VTT) files with validation, transcoding when needed, proxies, thumbnails (ASSET_INGESTION.md) | brief §7.2 | Unsupported file shows a reason; HEVC MOV is transcoded and plays |
| PRD-006 | Asset preview, metadata, selection, Sequence Badge ordering and Insert | brief §7.2 | Three assets ordered 2-3-1 insert as 1-2-3 |
| PRD-007 | Composition Model with Tracks (video, overlay, text, caption, audio) and a read-only Timeline View with selection, scrubbing and inspection | brief §7.3 | Every element in the model appears on its Track |
| PRD-008 | Output Settings: Aspect Ratio (16:9, 9:16, 1:1, 4:5, 5:4, 4:3, 3:4, Custom), Resolution (720p, 1080p, 2K, 2160p), frame rate (24/25/30/50/60) in Project Settings, Performance Profile (Standard/Accelerated/Turbo) | brief §13, ADR-010 | Exported file dimensions match PERFORMANCE.md table |
| PRD-009 | Main Player preview with play/pause, scrubber, time, duration, ratio/resolution indicator, loading and error states | brief §7.3 | Seek latency ≤ 100 ms on reference PC (NFR) |
| PRD-010 | At least one external AI provider (OpenRouter first, because one key gives access to OpenAI, Anthropic and Google models) with credential validation, model listing, budget limit | brief §9 | Connection test passes; invalid key shows a clear error |
| PRD-011 | Brainstorming Agent and Editor Agent with independent model assignment and visible usage | brief §8 | Each chat footer shows its model and context usage |
| PRD-012 | Structured Edit Intents from every UI pick; Intent Queue; deterministic Compile for fully specified picks; Edit Plans for the rest; Execute as the only mutation gate | brief §8.3, ADR-002 | Golden scenarios GS-01…GS-20 pass (Compile path and fake-provider replay) |
| PRD-013 | Remotion composition generated from the Composition Model (`ExpertmotionTimeline`) with the P0 catalogue (DESIGN_CATALOGUE.md §12; "none" presets not counted): 6 transitions, 3 caption styles (caption *display*, from SRT/VTT import in P0), 5 backgrounds, 5 motion presets, 4 shapes, 5 easings, 6 visual effects, 3 audio treatments, 4 text variants + 2 text effects | ADR-001 | Each preset renders in all ratios without overflow |
| PRD-014 | Render and export H.264 MP4 (plus GIF and PNG still) locally with progress, ETA, cancellation, output folder control, pre-render checks (disk, memory, dimensions) | brief §13 | 30 s 1080p30 render completes; cancel removes partial file |
| PRD-015 | Recoverable errors with the Error Catalogue copy; render failure never crashes the app | brief §7.3 | Kill Chrome during render → job failed, app alive |
| PRD-016 | Essential security: Service Token, Host/Origin guards, path restrictions, Electron hardening, encrypted credentials, signed installer | brief §12 | VULNERABILITY_CHECKLIST passes |
| PRD-017 | Offline Ed25519 licence with Trial Mode (watermark + 720p cap) | ADR-014 | Valid key activates; tampered key rejected |
| PRD-018 | Onboarding wizard and in-app tour | brief §9 | New user reaches first export in ≤ 10 minutes in usability test |
| PRD-019 | Hardware Monitor (CPU, RAM, process memory, disk, GPU availability, workload) informing defaults and warnings | brief §14 | T0/T1/T2 detected; 4K disabled on T0 with reason |
| PRD-020 | Private Mode blocking all outbound calls | brief §4.1 | Network monitor shows zero outbound connections while on |
| PRD-021 | Continuity: process.md, memory.md, DECISIONS.md maintained; docs are the source of truth | brief §21 | Hand-over test: fresh agent resumes from docs alone |

### 4.2 P1 — next

| ID | Requirement |
|---|---|
| PRD-030 | Expanded transition (all 19 + none) and motion libraries |
| PRD-031 | Richer text styling; caption *generation* from audio with local whisper.cpp (id/en), 5 caption styles |
| PRD-032 | Additional providers as separate connections (OpenAI, Anthropic, Google) and model capability refresh |
| PRD-033 | Voiceover generation with local TTS (sherpa-onnx + Piper id/en) |
| PRD-034 | Improved undo/redo across Composition Versions in the UI |
| PRD-035 | Hardware-aware Performance Profile auto-selection and render benchmark |
| PRD-036 | Timeline interactions: limited reordering and trimming of Clips |
| PRD-037 | Social caption text and hashtag suggestions via the connected LLM (id/en) |

### 4.3 P2 — later

| ID | Requirement |
|---|---|
| PRD-050 | Advanced visual effects (full 81-effect catalogue, WebGPU effects when available) |
| PRD-051 | Music generation (ACE-Step on T1/T2; loop-library fallback on T0) |
| PRD-052 | Advanced thumbnail generation (stable-diffusion.cpp + composition of title/still) |
| PRD-053 | Expanded local model support and Model Manager features (custom voices) |
| PRD-054 | More sophisticated editing (keyframes, multi-sequence projects) |
| PRD-055 | macOS and Linux builds |
| PRD-056 | Plugin/preset marketplace; MCP façade for external assistants |

### 4.4 Out of scope (explicit)

- Cloud rendering (Lambda, Cloud Run), accounts, cloud sync, collaboration.
- Free-form React/Remotion code authoring or import by the Creator (licence and safety).
- Professional NLE features: multi-cam, colour grading, keyframe graph editor, nested sequences.
- Reverse playback (not supported by `@remotion/media`).
- Telemetry or analytics sent to the Operator (none in v1; if Remotion v5 forces render telemetry, it is disclosed and gated).
- Mobile or web-hosted versions.

## 5. Success metrics

| Metric | Target (v1.0) | How measured |
|---|---|---|
| Time to first export for a new Creator | ≤ 10 min | moderated usability test, 5 participants |
| Terminal/manual installs required | 0 | clean-VM packaging test |
| Render success rate on reference hardware | ≥ 98 % | QA render matrix |
| Preview-to-export visual parity | no visible differences in golden frames (pixel diff ≤ 1 %) | TEST_PLAN golden frames |
| Crash-free sessions | ≥ 99 % | diagnostics logs in beta |
| Edit Plan validity on first attempt (Editor Agent) | ≥ 90 % of golden scenarios | agent evals |
| Agent cost per typical 60 s project | ≤ US$0.10 with a mid-tier model | usage records |

## 6. Constraints and assumptions

- Reference hardware: Windows 11, Intel i5 (8th gen or newer) or Ryzen 5, 16 GB RAM, integrated GPU, SSD (T0); optional NVIDIA GPU ≥ 4 GB (T1) / ≥ 8 GB (T2). Minimum: Windows 10 64-bit, 8 GB RAM, 5 GB free disk (plus models).
- Internet is needed only for provider calls, model downloads and updates.
- Remotion licence path per ADR-017; documentation and UI in English (ADR-012).
- The three provisional decisions (ADR-008, ADR-009, ADR-016) are assumed accepted until the Operator says otherwise.

## 7. Release criteria for v1.0

1. All P0 requirements verified per TEST_PLAN on a clean Windows VM and on the reference laptop.
2. Vulnerability checklist complete; threat model reviewed.
3. Installer and updater signed; licence issuance runbook tested end to end.
4. Remotion licence position confirmed in writing (ADR-017, BRD-010).
5. Documentation current; process.md and memory.md updated; known limitations published in About.
