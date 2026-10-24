# Architecture Decision Records

| Field | Value |
|---|---|
| Status | Living document; ADRs are append-only (supersede, never edit history) |
| Owner | Principal architect |
| Last updated | 2026-10-24 |
| Depends on | MASTER_PROJECT_PROMPT.md, ASSESSMENT.md |
| Used by | all documents |

Format per Master Project Prompt §6: problem, alternatives, selected solution, rationale, trade-offs, consequences. Status values: `proposed`, `accepted`, `provisional` (accepted but awaiting Operator confirmation), `superseded by ADR-xxx`.

---

## ADR-001 Document-driven Remotion composition, no runtime code generation

- **Status**: accepted (2026-10-24)
- **Problem**: Remotion compositions are React code. Letting an LLM write React per edit would require runtime bundling, arbitrary code execution, and would make validation impossible. Remotion's licence also forbids end users bringing their own Remotion code into a sold product.
- **Alternatives**: (a) LLM generates React per project and the app bundles it at runtime (Remotion "dynamic compilation"); (b) fixed set of templates with props (Experthinker Studio approach); (c) one generic timeline composition driven by a JSON Composition Model.
- **Selected**: (c). One composition `ExpertmotionTimeline` reads the Composition Model and renders Tracks, Clips, Text Layers, Captions, Transitions, Effects and Audio using Design Presets implemented once in code.
- **Rationale**: prebuilt bundle (no webpack at runtime), deterministic schema validation, Haiku-class models only emit JSON operations, preview and render share one code path, licensing stays within "users create videos from your template".
- **Trade-offs**: new visual capabilities need a code release (a new Design Preset); creativity is bounded by the catalogue.
- **Consequences**: `DATABASE_SCHEMA.md` owns the Composition Model schema; `DESIGN_CATALOGUE.md` is the closed preset list; `AI_WORKFLOW.md` owns the operation vocabulary; the Engine package contains the preset implementations.

## ADR-002 Hybrid edit pipeline: deterministic compile first, LLM only for gaps

- **Status**: accepted
- **Problem**: Sending every click to an LLM is slow, costly and error-prone; letting the LLM enforce invariants is unsafe (Master Project Prompt §8.3, §16).
- **Alternatives**: (a) everything through the Editor Agent; (b) everything deterministic (no agent); (c) hybrid.
- **Selected**: (c). UI action → typed Edit Intent → validate against Design Catalogue → Target Resolution → conflict resolution by Property Class → if fully specified, Compile directly into Operations; otherwise Rewrite into a complete instruction for the Editor Agent → structured Edit Plan → schema and capability validation → Execute → transactional apply → post-validation → persist.
- **Rationale**: latency and cost drop, model errors cannot corrupt state, Intent Queue remains the single visible record of what the Creator asked for.
- **Trade-offs**: two code paths to test; the Creator may expect "the AI did it" for deterministic picks (UI shows "applied directly").
- **Consequences**: Locked Keys (compiled intents) are protected from LLM operations; plans carry `baseVersion`; stale plans are re-planned, never force-applied.

## ADR-003 Two runtime agents with independent model assignment; sub-agents are deterministic workers

- **Status**: accepted
- **Problem**: The brief requires a Brainstorming Agent and an Editor Agent with separately chosen models and budget visibility.
- **Alternatives**: single agent with modes; two LLM agents; two LLM agents plus LLM sub-agents.
- **Selected**: two LLM agents. The Brainstorming Agent never mutates state and hands over requests as Edit Intents (`source: brainstorm`). The Editor Agent plans and executes through Tools. Runtime Sub-agents (Ingest, Caption, Audio, Layout, Thumbnail, QA-check) are deterministic code invoked by plan steps.
- **Rationale**: clear permissions, two model bills the Creator can see, fewer non-deterministic hops.
- **Trade-offs**: hand-off UX must be explicit (handoff card).
- **Consequences**: `AGENT_DESIGN.md` defines permissions; `SYSTEM_PROMPT.md` holds versioned prompts; the Capability Table gates model choice with JSON-mode fallback when tool calling is unsupported.

## ADR-004 Desktop shell: Electron

- **Status**: accepted
- **Problem**: Ship a Windows executable that bundles the UI, the Local Service (Node), Remotion rendering (Chrome Headless Shell + FFmpeg) and native modules, without the Creator installing anything.
- **Alternatives** (criteria from §4.2): Electron; Tauri 2 + Node sidecar (pkg/SEA); Neutralino + Node extension; Node SEA alone with a browser; Bun compile.
- **Selected**: Electron with Remotion's official Electron pattern (bundle at build time, `renderMedia` in the main/service process, UI via IPC/HTTP).
- **Rationale**: Remotion documents and supports Electron; the preview Chromium is the same engine family as the renderer (parity); `better-sqlite3-multiple-ciphers` ships Electron prebuilds; ASAR integrity fuses and `safeStorage` (DPAPI) are built in; mature signing/updater tooling. Tauri has no Remotion guide, previews in WebView2 (parity risk), and needs a separately packaged Node sidecar; SEA cannot load native addons from its VFS without extraction tricks.
- **Trade-offs**: larger installer (≈ 300–400 MB compressed before models; budget ≤ 450 MB, measured in POC-001) and higher idle RAM (~130–200 MB) than Tauri; two Chromium instances during render (Electron + Headless Shell).
- **Consequences**: `DEPLOYMENT_AND_PACKAGING.md` is Electron-specific; the UI remains a plain web app so development runs in a browser against the Local Service.

## ADR-005 Local Service is a private, token-authenticated loopback HTTP + SSE API

- **Status**: accepted
- **Problem**: localhost binding alone is not sufficient protection (§12); other local processes and web pages can reach `127.0.0.1`.
- **Alternatives**: Electron IPC only (no HTTP); HTTP without auth; HTTP with per-launch token.
- **Selected**: Express on `127.0.0.1` with a random per-launch Service Token injected by the Desktop Shell, Host/Origin allow-list, token in a header (no cookies, so no CSRF), path-restricted file access, JSON size limits. SSE for progress. Kept as HTTP (not IPC-only) so the Editor can run in a browser during development. Two documented exceptions to "token in a header": the `EventSource` connection carries the Service Token in the query string (browsers cannot set headers on SSE), and media URLs for Chrome Headless Shell and the Player carry a per-session media grant token in the path (`/media/<grant>/<assetId>/…`, SEC-010); both are loopback-only and read-only.
- **Trade-offs**: token plumbing in dev mode; one open port.
- **Consequences**: `API_SPECIFICATION.md` documents the header; `SECURITY.md` and `VULNERABILITY_CHECKLIST.md` test it.

## ADR-006 Encrypted SQLite with OS-wrapped key; media on the filesystem

- **Status**: accepted
- **Problem**: Protect project data and provider credentials at rest without storing the key next to the data (§4.3, §11).
- **Alternatives**: plaintext SQLite + encrypted credential fields; SQLCipher; `better-sqlite3-multiple-ciphers`; full-disk-only reliance.
- **Selected**: `better-sqlite3-multiple-ciphers` (ChaCha20-Poly1305) with a random 256-bit Database Key wrapped by Electron `safeStorage` (Windows DPAPI). Provider credentials additionally encrypted field-level. Media files stay on disk under the app data folder with hashes in the index.
- **Rationale**: same API as better-sqlite3, Electron prebuilds, no key beside the data.
- **Trade-offs**: cannot protect against the device owner or an admin with a debugger; DPAPI ties data to the Windows user account (documented backup/restore path).
- **Consequences**: `DATABASE_SCHEMA.md` and `THREAT_MODEL.md` state the boundary explicitly; the Operator never claims the data is unreadable by the device owner.

## ADR-007 IP protection as defence in depth, with honest boundaries

- **Status**: accepted
- **Problem**: The Operator wants source, prompts and orchestration protected from competitors; a distributed app cannot be made impossible to reverse-engineer (§4.3).
- **Alternatives**: none (plain JS); obfuscation only; V8 bytecode everywhere; server-side "secret sauce" (breaks local-first).
- **Selected**: bundle + minify with no production source maps; ASAR integrity fuses; V8 bytecode (bytenode, or the electron-vite plugin as fallback) only for the licence and prompt modules in the main/service process (never the renderer or Remotion path, where `Function.toString` is required; compatibility with the pinned Electron is verified in POC-006); prompt/template assets encrypted at rest and decrypted in memory; signed installer and signed updates; dependency integrity via lockfile and hash checks; Ed25519 licence.
- **Trade-offs**: all layers are reversible by a determined attacker; bytecode is tied to the Electron version.
- **Consequences**: documentation says "raises the cost of extraction"; `THREAT_MODEL.md` lists what is not protected.

## ADR-008 Installer bundles the runtime; model weights download on first use

- **Status**: provisional (awaiting Operator confirmation; deviates from "everything inside the .exe")
- **Problem**: Local models are gigabytes; shipping them inside the installer makes it 5–20 GB and ties releases to model updates.
- **Alternatives**: bundle everything; download everything (including Chrome and FFmpeg) on first run; bundle runtime + engines, download weights.
- **Selected**: bundle Electron runtime, prebuilt Remotion bundle, Chrome Headless Shell, FFmpeg and Engine Binaries so an offline first render works; download model weights on first use with size shown, hash verification and resume.
- **Trade-offs**: first use of a generator needs internet once; Private Mode blocks downloads.
- **Consequences**: `LOCAL_AI_MODELS.md` defines the registry and download policy; Model Manager UI; `DEPLOYMENT_AND_PACKAGING.md` lists what is bundled.

## ADR-009 Generative tools run on local open-source models; social caption text and hashtags use the connected LLM

- **Status**: provisional (Operator chose local models for Tools; the caption-text/hashtag interpretation awaits confirmation)
- **Problem**: Voice, music, thumbnail and caption generation in Indonesian and English without per-use cloud cost.
- **Alternatives**: cloud via Creator's keys; local models; both.
- **Selected**: local Engine Binaries and models (whisper.cpp for subtitles; sherpa-onnx + Piper voices for TTS; stable-diffusion.cpp with FLUX.1-schnell or SD 1.5 for thumbnails; ACE-Step via on-demand embedded Python for music). Social caption text and hashtag suggestions are produced by the Creator's connected LLM (it is already configured and costs cents); a small local llama.cpp model is a later option. A provider interface keeps cloud generators possible later without UI change.
- **Trade-offs**: Indonesian TTS quality is "news reader" (no high-quality commercial open model exists); music needs ≥ 4 GB VRAM for usable speed. Piper voices run on sherpa-onnx (Apache-2.0); the GPL-3 component is the espeak-ng phonemizer inside the sherpa-onnx TTS binary (and piper1-gpl if ever used), so TTS runs as a separate Engine Binary process with a source offer in the Third-Party Notices (LOCAL_AI_MODELS.md). The `id_ID-news_tts-medium` voice card points to a dataset of unclear licence → RISK-002; redistribution unverified.
- **Consequences**: Tools are P1 (voice, captions) and P2 (music, thumbnails) per PRD; `LOCAL_AI_MODELS.md` registry; `LICENSING_AND_COMPLIANCE` section in BRD.

## ADR-010 Output settings: Performance Profiles are resource policies, frame rate is a project setting

- **Status**: accepted
- **Problem**: The mockup's "Speed: Standard / Accelerated / Turbo" could be read as fps; the brief (§13) requires these labels to map to documented resource policies.
- **Selected**: Performance Profile = {render concurrency, preview scale, hardware acceleration, memory ceiling, image format}. Frame rate (24/25/30/50/60) is in File ▸ Project Settings. Aspect Ratios 16:9, 9:16, 1:1, 4:5, 5:4, 4:3, 3:4, Custom; Resolutions 720p, 1080p, 2K, 2160p with an explicit pixel table; "Draft" is the proxy preview quality.
- **Consequences**: `PERFORMANCE.md` owns the tables; the Output Settings tooltip explains profiles honestly.

## ADR-011 Preview Catalogue uses prerendered loops and one live Player

- **Status**: accepted
- **Problem**: Dozens of simultaneous Remotion Players would exhaust memory on low-end PCs.
- **Selected**: Catalogue Cards show build-time prerendered webm/GIF loops; one live Player applies the hovered/selected preset to the Creator's current Clip.
- **Consequences**: build pipeline renders catalogue loops; `DESIGN_CATALOGUE.md` lists the preview asset per preset.

## ADR-012 English UI for MVP with i18n keys from day one; Indonesian UI later

- **Status**: accepted
- **Problem**: The persona is Indonesian; the mockup and the brief's documentation language are English; the brief allows separate localisation (§22).
- **Selected**: English UI strings behind i18n keys; Indonesian variants for generated content, onboarding, errors and tour copy from day one; full Indonesian UI in a later release.
- **Consequences**: `ACCESSIBILITY_AND_I18N.md` defines the key scheme; every user-facing string in the docs carries an ID variant.

## ADR-013 Repository: new monorepo `expertmotion`, porting selected modules from Experthinker Studio

- **Status**: accepted (Operator decision 2026-10-24)
- **Problem**: Overhaul in place would break the running Studio; starting from zero wastes verified code.
- **Selected**: new repo with `apps/desktop`, `apps/service`, `apps/ui`, `packages/composition-model`, `packages/catalogue` (React-free preset registry, added to break the engine ↔ model ↔ agents cycle), `packages/engine`, `packages/agents`, `packages/models`, `packages/shared`; port render queue, bundle manager (prebuilt path), browser warm-up, stills cache, SSE helper, formats/safe areas, layout unit, `fitText`, Player wrapper, SSE store, UI kit, SchemaForm (inspector fallback). Drop brand, evidence-first rules, six templates, MCP tools.
- **Consequences**: `BLUEPRINT.md` has the file-by-file port list.

## ADR-014 Offline Ed25519 licence bound to a Machine Fingerprint; Trial Mode

- **Status**: accepted (Operator decision 2026-10-24)
- **Problem**: One-time purchase without running a licence server at launch.
- **Selected**: licence token signed with the Operator's Ed25519 private key, containing licensee, Machine Fingerprint hash, tier, issue date, update-eligibility date; verified offline with the embedded public key; re-bind limit; revocation list shipped with updates; Trial Mode = watermark + 720p cap.
- **Trade-offs**: a patched binary can bypass checks (ADR-007 boundary); clock tampering handled by monotonic checks.
- **Consequences**: `LICENSE_OPERATIONS.md` runbook; `scr.license` flow.

## ADR-015 MCP is not used in MVP; agents call typed in-process Tools

- **Status**: accepted
- **Problem**: §8.5 asks to evaluate MCP against typed internal APIs.
- **Selected**: typed in-process Tools with schema validation and a permission table. An MCP façade over the same Tools is a post-MVP option for external assistants. Remotion's own MCP is deprecated.
- **Consequences**: `MCP_AND_TOOLING.md` records the evaluation.

## ADR-016 Priorities follow the Master Project Prompt §17; Tools land in P1/P2

- **Status**: provisional (reconciliation flagged to the Operator)
- **Problem**: The Operator's chat decision favoured local models for all Tools; the brief places voiceover in P1 and music/thumbnails in P2 and asks for a reliable P0 first.
- **Selected**: P0 = packaged app, editor, projects, persistence, imports, ordering, timeline representation, output settings, preview, one provider, both agents, structured intents, composition, render/export, progress/recovery, security/packaging. Voice + captions P1; music + thumbnails P2. The local-model decision governs how they are built.
- **Consequences**: `PRD.md`, `ROADMAP.md`; model research is documented now so nothing is rediscovered.

## ADR-017 Remotion licence path is a launch blocker to resolve with Remotion

- **Status**: accepted
- **Problem**: Remotion is free for individuals and companies ≤ 3 people; companies of 4+ need a Company License (Automators: $0.01/render, $100/month minimum). Public docs do not define how renders on an end user's own PC are metered. From Remotion 5.0 render reporting is mandatory for the Automators licence (voluntary below 5.0, optional for Creators; Remotion states telemetry never blocks a render), which would conflict with Private Mode if Expertmotion ever falls under Automators.
- **Selected**: proceed on the free licence while the Operator's company is ≤ 3 people; the BRD requires written confirmation from Remotion before commercial launch; the Engine passes `licenseKey` when a Company License exists; Private Mode behaviour with telemetry is documented as an open question.
- **Consequences**: `BRD.md`, `RISKS_AND_ASSUMPTIONS.md` (RISK-001).

## ADR-018 Glossary change log (controlled additions after the freeze)

- **Status**: accepted
- **Problem**: the glossary was frozen after the core documents, but the parallel writing of 40 documents surfaced terms and prefixes that every document needs.
- **Rule**: additions only (no renames, no meaning changes), each logged here; editing requires `GLOSSARY_CHANGE=1` (HG-005).
- **2026-10-24 additions**: terms *Machine Code*, *keyId (kid)*, *Cut index* (0-based in data, 1-based in UI); *Asset* now includes subtitle files (SRT/VTT); *Provider Connection* includes a custom OpenAI-compatible https base URL; *Resolution* notes the stored lowercase values; *Intent Queue* notes the `removed` status; identifier prefixes `GS-`, `ASM-`, `LIC-`, `AGD-`, `TR-`, `HG-`, `IX-`, `CM-`, `K-`, `R-`; copy rule: friendly "kamu" in Creator-facing Indonesian copy, "Anda" only in legal/licence texts.
- **Consequences**: documents written before these additions were aligned in the consistency pass of 2026-10-24.

## ADR-019 Two FFmpeg builds; H.264 encoding path for ingestion

- **Status**: provisional (settled in Stage 2, POC-003)
- **Problem**: Remotion ships a slim FFmpeg (`@remotion/compositor-win32-x64-msvc`) built for its output codecs; ingestion must probe and decode sources it does not cover (AV1, HDR, FLAC, ProRes). A full FFmpeg configured as LGPL has no libx264, yet the ingestion pipeline (ASSET_INGESTION.md §4) encodes playable copies and proxies to H.264.
- **Alternatives**: (A) bundle a GPL-configured full FFmpeg with libx264 and accept GPL obligations for that binary (source offer, notices); (B) decode with the LGPL full build to a raw pipe and encode with the compositor FFmpeg that Remotion already uses for H.264 output; (C) use OpenH264/`h264_mf` (Media Foundation) encoders in the LGPL build on Windows.
- **Selected (provisional)**: (B) as default, (C) as the measured alternative in POC-003; (A) only if both fail quality or speed targets, after legal review (BRD §6).
- **Consequences**: `resources/engine/compositor/` (slim, output) and `resources/bin/ffmpeg-full/` (LGPL, ingestion) in the installer; ASSET_INGESTION §3/§4 command lines are updated once POC-003 picks the encoder; Third-Party Notices list both builds.

## ADR-020 Operation vocabulary additions found during implementation

- **Status**: accepted (2026-10-24, Stage 2 implementation)
- **Problem**: writing `packages/catalogue` Compile rules showed that the P0 preset `preset:audio.fade-in-out` had no operation in AI_WORKFLOW.md §5 that could apply it (only `op:clip.setVolume` carries fades, and only for Clips).
- **Selected**: add `op:audio.setFades {fadeInMs?, fadeOutMs?}` (target `audio`, scalar per field, propertyKeys `audio:<id>.fadeInMs` / `audio:<id>.fadeOutMs`). The P2 preset `preset:audio.visualizer-bars` gets no Compile rule until its P2 operation is designed (no mapping onto `op:shape.add`, which only accepts shape presets).
- **Consequences**: AI_WORKFLOW.md §5 row added; `packages/composition-model` implements it with tests; the closed vocabulary now has 41 operations.

## ADR-021 Maximum protection pipeline (Operator requirement 2026-10-24)

- **Status**: accepted
- **Problem**: the Operator requires the shipped executable to be as hard as realistically possible to decompile or reverse-engineer (by people, LLM agents or brute force), and compressed so the app stays light.
- **Selected** (all in `apps/desktop/scripts/harden.mjs` and the electron-builder flow): (1) V8 bytecode (bytenode, compiled with the pinned Electron) for the whole main-process bundle and the whole Local Service bundle; (2) heavy javascript-obfuscator pass (RC4 string arrays, control-flow flattening, dead-code injection, self-defending) on code that must stay JavaScript: the Editor bundle and the Engine bundle that Chrome executes; (3) prompt/template assets AES-256-GCM encrypted, key split between bytecode and build constant, decrypted in memory only; (4) signed integrity manifest (Ed25519) of service, engine bundle and binaries checked at startup (EM-8002 on mismatch); (5) ASAR integrity + fuses, no source maps, signed installer and updates; (6) optional Node-API C++ addon (MSVC) for licence verification and key derivation; (7) `compression: maximum` (NSIS solid LZMA, ASAR, pruned dev dependencies).
- **Trade-offs**: bytecode is tied to the Electron version; obfuscation slows the Editor and Engine somewhat (measured in POC-006/POC-007); builds need the Windows machine.
- **Honest boundary** (unchanged from ADR-007): these layers make extraction slow and expensive; code executed on the Creator's computer can still be traced by a determined device owner. No duration ("years") is promised.

## ADR-022 One Licence Key, one computer (Operator requirement 2026-10-24)

- **Status**: accepted (refines ADR-014)
- **Selected**: every key is issued for exactly one Machine Code (no unbound or floating keys); verification fails on another computer (EM-5003; the 2-of-3 tolerance only absorbs hardware drift on the same machine); moving to a new computer is an Operator re-bind that issues a new key and revokes the old one via the signed revocation list (EM-5004); at most 3 re-binds per 12 months, enforced by the issuing CLI.
- **Boundary**: offline verification cannot stop a patched binary (ADR-007); the revocation list reaches an offline machine only with an update.

## ADR-023 Provider calls use JSON-mode prompting in the MVP

- **Status**: accepted (2026-10-24, Stage 2 implementation)
- **Problem**: AGENT_DESIGN prefers tool calling with `composition.validateOps` for capable models; not every OpenRouter model supports tools, and the runtime validates every plan deterministically anyway.
- **Selected**: the MVP sends the Rewrite envelope and asks for the EditPlan JSON (SYSTEM_PROMPT P-2) for every model; the runtime performs the dry-run that `composition.validateOps` would have done and re-prompts with the issues (max 2 corrections). Tool calling becomes an optimisation for capable models in P1. Provider: Vercel AI SDK 6.0.315 + `@openrouter/ai-sdk-provider` 2.10.0 (latest provider 3.x needs AI SDK 7; upgrade is a later, deliberate step).
