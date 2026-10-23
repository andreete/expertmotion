# Glossary

| Field | Value |
|---|---|
| Status | **Frozen** (2026-10-24, after PRD, ARCHITECTURE, AI_WORKFLOW, DESIGN_CATALOGUE, PERFORMANCE). New terms: add here first, then use. |
| Owner | Documentation lead |
| Last updated | 2026-10-24 |
| Depends on | MASTER_PROJECT_PROMPT.md |
| Used by | every document in `docs/` |

Every document in this repository uses the terms below exactly as written here (capitalisation included). If a document needs a new term, add it here first. If two documents disagree with this file, this file wins and the documents are fixed.

## Product and people

| Term | Definition |
|---|---|
| **Expertmotion** | The product. A local-first, AI-assisted motion video editor delivered as a Windows desktop executable that launches a local web-based editor built on Remotion. Never "Remason", "Studio", "Experthinker Studio" or "the dashboard". |
| **Creator** | The end user. A beginner or independent content creator, or a small business, without an editing team or coding skills. The primary persona is "Septi" (see UXRD). |
| **Operator** | The person who builds, signs, licences and supports Expertmotion (Andre). |
| **Desktop Shell** | The Electron application that the Creator launches (`Expertmotion.exe`). It owns the window, the lifecycle of the Local Service, OS credential storage, the updater and the tray. |
| **Local Service** | The Node.js process (Express HTTP + SSE on `127.0.0.1`) started by the Desktop Shell. It owns the database, the Composition Model, the render queue, the Model Manager, provider calls and the agent runtime. |
| **Editor** | The React web application rendered inside the Desktop Shell window (and in a browser during development). It never talks to Remotion directly; it talks to the Local Service. |
| **Engine** | The prebuilt Remotion bundle plus Chrome Headless Shell and FFmpeg used for preview and rendering. The Creator never sees the word Remotion in the Editor. |

## Editor layout

| Term | Definition |
|---|---|
| **Header** | Top bar with the menu tabs **File**, **Home**, **Design**, **Tools**, **Help**, the Project Title, and the header actions (Save, Backup/Restore, Hardware Monitor, Model Manager, Purchase, Licence Status, Export). |
| **Menu Tab** | One of File, Home, Design, Tools, Help. Selecting Home, Design or Tools switches the **Library Panel** mode. |
| **Library Panel** | The left column. It has a **Catalogue Search**, a mode-dependent upper area (**Preview Catalogue** in Design mode, **Text Panel** in Home mode, **Generator Cards** in Tools mode) and the always-visible **Asset Panel**. |
| **Preview Catalogue** | Grid of **Catalogue Cards**, one per Design Preset, grouped by category. Cards show a prerendered loop; hovering or selecting a card drives the single live preview. |
| **Catalogue Card** | One Design Preset in the Preview Catalogue. Clicking it creates a Design Pick. |
| **Text Panel** | Home-mode content of the Library Panel: font family, size, weight/style, colour, alignment, text variants, text styling presets, Add Text. Picks here are deterministic (no LLM). |
| **Generator Cards** | Tools-mode content of the Library Panel: Generate Voice, Generate Music, Generate Thumbnail, Generate Captions, Suggest Hashtags. |
| **Asset Panel** | Lower part of the Library Panel: drag-and-drop import, Asset thumbnails with metadata, **Sequence Badges** for ordering, and the **Insert** button. |
| **Sequence Badge** | The number a Creator assigns to an Asset to set its order before Insert (1 = first). |
| **Insert** | Button that adds the ordered selected Assets to the Composition as Clips in Sequence Badge order. |
| **Stage** | The centre column. Contains the **Player** and the **Timeline View**. (Not to be confused with a roadmap Stage; see "Roadmap Stage".) |
| **Player** | The live preview (Remotion `<Player>`): play/pause, playhead, time display, total duration, ratio and resolution indicator, loading/error states. |
| **Timeline View** | Read-only structured view under the Player of Tracks and Timeline Elements (clips, audio, text, captions, transitions, motion, effects, backgrounds, generated assets). Supports selection, scrubbing and inspection in MVP; limited reordering and trimming are P1. |
| **Agent Panel** | The right column: **Model Bar**, **Brainstorming Chat**, **Editor Chat** (with the **Plan Card** and **Execute**), and the **Output Settings**. |
| **Model Bar** | Top of the Agent Panel: the default Provider Connection and model, with per-agent overrides shown in each chat footer (model name, context usage counter). |
| **Plan Card** | The structured, read-only rendering of an Edit Plan inside the Editor Chat, with a free-text notes field and the Execute button. |
| **Output Settings** | Bottom of the Agent Panel: Aspect Ratio, Resolution, Performance Profile, Auto ratio toggle, Private Mode toggle, Reset to Defaults. Frame rate and duration live in File ▸ Project Settings. |
| **Hardware Monitor** | Popover from the Header showing CPU, system memory, process memory, disk free space, GPU availability and current render/background workload. |
| **Model Manager** | Screen listing local AI models: installed state, size, licence, hardware tier, download progress, remove. |

## Project data

| Term | Definition |
|---|---|
| **Project** | A Creator's saved work: settings, Assets, Sequences, Composition Model versions, intents, plans, conversations, render jobs. Stored in the local database plus a media folder. |
| **Project Settings** | Name, frame rate (24/25/30/50/60), default Aspect Ratio and Resolution, duration policy, output folder. |
| **Asset** | An imported media file (video, image, audio) with probe metadata, proxy, thumbnail and waveform, stored on the filesystem and indexed in the database. |
| **Sequence** | An ordered list of Clips in a Project. MVP has exactly one Sequence per Project. |
| **Composition Model** | The versioned JSON document that fully describes what the Engine renders: Project Settings, Tracks, Timeline Elements, transitions, captions, effects, audio, theme. Schema owned by `DATABASE_SCHEMA.md`. Times are in milliseconds. |
| **Composition Version** | An immutable snapshot of the Composition Model created by every successful Execute, Insert, or deterministic pick. Undo/redo and rollback move between versions. |
| **Track** | A layer lane in the Composition Model: `video`, `overlay`, `text`, `caption`, `audio`. |
| **Timeline Element** | Anything placed on a Track with a start and duration: Clip, Text Layer, Caption Block, Audio Layer, Shape, Background, Effect Instance, Transition. |
| **Clip** | A Timeline Element on the `video` track referencing an Asset with `trimBeforeMs`, `durationMs`, `playbackRate`, `volume`, `objectFit`. |
| **Cut** | The boundary between two adjacent Clips. Transitions attach to Cuts. |
| **Design Preset** | A catalogued, parameterised building block (transition, caption style, background, motion preset, shape, easing, visual effect, audio treatment, text style). Each has a stable `presetId` in `DESIGN_CATALOGUE.md`. |
| **Theme** | Project-wide palette, fonts and spacing used by presets. |
| **Output Profile** | Aspect Ratio + Resolution + frame rate + codec settings used for a render. Exact pixel table in `PERFORMANCE.md`. |
| **Aspect Ratio** | One of 16:9, 9:16, 1:1, 4:5, 5:4, 4:3, 3:4, Custom (width:height). |
| **Resolution** | One of 720p, 1080p, 2K, 2160p (exact pixels depend on the Aspect Ratio). "Draft" is the proxy preview quality, not an export preset. |
| **Performance Profile** | Standard, Accelerated or Turbo. A documented resource policy (render concurrency, preview scale, hardware acceleration, memory ceiling), not a frame rate and not a promise of faster hardware. |
| **Render Job** | One request to render a Composition Version with an Output Profile to a file, with progress, ETA, cancellation and status (`queued`, `rendering`, `done`, `failed`, `cancelled`). |
| **Output** | A rendered file (video, GIF, still, audio) with its metadata and thumbnail. |

## AI workflow

| Term | Definition |
|---|---|
| **Design Pick** | A Creator's UI action that expresses a preference: clicking a Catalogue Card, choosing a font size, toggling a ratio. Captured as an Edit Intent. |
| **Edit Intent** | A typed object describing what the Creator wants, with source (`ui`, `brainstorm`, `chat`), target reference, property key, property class, value, and status. Schema owned by `AI_WORKFLOW.md`. |
| **Intent Queue** | The visible, ordered list of pending Edit Intents for a Project. Superseded intents stay visible (struck through) and can be restored. |
| **Target Resolution** | The deterministic rule that decides which Timeline Element(s) an Edit Intent applies to when the Creator did not select one (table in `AI_WORKFLOW.md`). |
| **Property Class** | `scalar` (a later value supersedes the earlier one), `list` (values accumulate, deduplicated by presetId), `exclusive-group` (exactly one value per target). |
| **Locked Key** | A `target.property` key already decided by a compiled Edit Intent. The validator rejects any LLM-authored Operation that touches a Locked Key. |
| **Compile** | Deterministic conversion of a fully specified Edit Intent into Operations without calling an LLM. |
| **Rewrite** | Deterministic conversion of an under-specified Edit Intent plus context into a complete instruction for the Editor Agent (the "query rewrite"). |
| **Edit Plan** | A structured JSON plan (goal, ordered steps with tool + arguments + expected diff, risks, notes, `baseVersion`) produced by the Editor Agent or by Compile. Shown in the Plan Card. |
| **Operation** | One atomic, schema-validated mutation of the Composition Model (for example `clip.setTrim`, `transition.set`, `text.add`). The op vocabulary is closed and owned by `AI_WORKFLOW.md`. |
| **Execute** | The Creator's approval action. Applies all Operations of an Edit Plan in one transaction against `baseVersion`, creating a new Composition Version, or rejects with a reason. |
| **Stale Plan** | An Edit Plan whose `baseVersion` no longer matches the current Composition Version. It must be re-planned, never force-applied. |
| **Brainstorming Agent** | The conversational copilot in the Brainstorming Chat. Understands goals, asks questions, suggests concepts, and hands fully specified requests to the Editor Agent as Edit Intents with `source: brainstorm`. Never mutates the Composition Model. |
| **Editor Agent** | The worker agent in the Editor Chat. Reads the Intent Queue, context and capabilities, produces Edit Plans, and after Execute drives Operations through tools. |
| **Runtime Sub-agent** | A deterministic worker invoked by Edit Plan steps: Ingest, Caption, Audio, Layout, Thumbnail, QA-check. Not an LLM unless stated. |
| **Tool** | A narrow, typed Local Service API callable by agents (for example `composition.applyOps`). Never a shell or filesystem. |
| **Provider Connection** | A configured external LLM provider (OpenRouter, OpenAI, Anthropic, Google Gemini) with an encrypted credential, validated status and the list of available models. |
| **Model Assignment** | Which model (from which Provider Connection) each agent uses. Independent per agent. |
| **Capability Table** | Per-model facts the app relies on: context length, tool calling, structured output, streaming, price per token if known. |
| **Usage Record** | Tokens and, where the provider reports it, cost for one agent run. Costs are labelled "approximate" unless the provider returns them. |
| **Private Mode** | Setting that blocks every outbound network call (providers, model downloads, update checks). Agents are unavailable while it is on; everything else works. |

## Local AI

| Term | Definition |
|---|---|
| **Local Model** | An open-source model executed on the Creator's computer by a bundled engine binary. Registry in `LOCAL_AI_MODELS.md`. |
| **Engine Binary** | A prebuilt, signed executable shipped with Expertmotion that runs Local Models as a child process (whisper.cpp, sherpa-onnx, stable-diffusion.cpp, optional embedded Python for music). |
| **Hardware Tier** | `T0` CPU-only, `T1` GPU with ≥ 4 GB VRAM, `T2` GPU with ≥ 8 GB VRAM. Determined by the Hardware Monitor at startup; decides defaults and which models are offered. |
| **Model Download** | First-use download of model weights, hash-verified and resumable, shown with size and progress. Weights are never inside the installer. |

## Security and licensing

| Term | Definition |
|---|---|
| **Service Token** | Random per-launch bearer token generated by the Desktop Shell and required on every Local Service request. |
| **Licence Key** | An Ed25519-signed token binding a licence to a Machine Fingerprint and tier. Verified offline. Operations in `LICENSE_OPERATIONS.md`. |
| **Machine Fingerprint** | A stable hash derived from hardware identifiers used to bind a Licence Key to one computer. |
| **Trial Mode** | Unlicensed state: full editor, exports watermarked and capped at 720p. |
| **Database Key** | Random 256-bit key that encrypts the SQLite database, stored wrapped by the OS credential facility (Windows DPAPI via Electron `safeStorage`), never next to the database file. |

## Process

| Term | Definition |
|---|---|
| **Roadmap Stage** | One of Stage 0–7 defined in `ROADMAP.md` and `STAGE_MANAGEMENT.md` (Discovery, Definition, PoC, Foundation, Editor MVP, AI Orchestration, Rendering, Hardening). |
| **P0 / P1 / P2** | MVP essential / next / later, as defined in `PRD.md` following the Master Project Prompt §17. |
| **ADR** | Architecture Decision Record in `DECISIONS.md`: problem, alternatives, selected solution, rationale, trade-offs, consequences. |
| **Golden Scenario** | One of the 20 end-to-end test scenarios in `GOLDEN_SCENARIOS.md` with expected Intent Queue, Edit Plan, Operations and render settings. |
| **Element ID** | The stable identifier of a UI element defined in `ELEMENT_IDS.md` (for example `hdr.menu.design`). |

## Identifier prefixes

| Prefix | Meaning | Defined in |
|---|---|---|
| `PRD-` | product requirement | PRD.md |
| `BRD-` | business requirement | BRD.md |
| `FR-` | functional requirement | FRD.md |
| `NFR-` | non-functional requirement | SRS.md |
| `UX-` | UX requirement | UXRD.md |
| `AI-` | AI workflow requirement | AI_WORKFLOW.md |
| `SEC-` | security requirement | SECURITY.md |
| `QA-` | test case or QA requirement | TEST_PLAN.md |
| `ADR-` | architecture decision | DECISIONS.md |
| `RISK-` | risk | RISKS_AND_ASSUMPTIONS.md |
| `POC-` | proof-of-concept experiment | POC_PLAN.md |
| `EM-` | user-facing error code | ERROR_CATALOGUE.md |
| `preset:` | Design Preset id (e.g. `preset:transition.fade`) | DESIGN_CATALOGUE.md |
| `op:` | Operation name (e.g. `op:transition.set`) | AI_WORKFLOW.md |
| `el:` | Element ID (e.g. `el:hdr.menu.design`) | ELEMENT_IDS.md |

## Words to avoid

| Do not write | Write instead |
|---|---|
| Remason, Studio, dashboard | Expertmotion, Editor |
| scene, template (for the catalogue) | Clip, Design Preset |
| prompt (for a UI pick) | Design Pick, Edit Intent |
| run / apply (for the approval click) | Execute |
| settings panel (right column) | Output Settings |
| speed (for fps) | Performance Profile (policy) or frame rate (fps), whichever is meant |
| "cannot be reverse-engineered", "unbreakable", "military-grade" | "raises the cost of extraction", with the concrete layers named |
| "the AI decides" | "the Editor Agent proposes; deterministic validation and the Creator's Execute decide" |
