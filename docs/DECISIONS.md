# Architecture Decision Records

| Field | Value |
|---|---|
| Status | Living document; ADRs are append-only (supersede, never edit history) |
| Owner | Principal architect |
| Last updated | 2026-10-26 |
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

## ADR-014 Offline Ed25519 licence bound to a Machine Fingerprint (Trial Mode removed 2026-10-25)

- **Status**: accepted (Operator decision 2026-10-24)
- **Problem**: One-time purchase without running a licence server at launch.
- **Selected**: licence token signed with the Operator's Ed25519 private key, containing licensee, Machine Fingerprint hash, tier, issue date, update-eligibility date; verified offline with the embedded public key; re-bind limit; revocation list shipped with updates; Trial Mode = watermark + 720p cap.
- **Trade-offs**: a patched binary can bypass checks (ADR-007 boundary); clock tampering handled by monotonic checks.
- **Consequences**: `LICENSE_OPERATIONS.md` runbook; `scr.license` flow.
- **Amendment 2026-10-25 (Operator decision)**: **Trial Mode is removed.** Every install must be activated with a Licence Key bound to its Machine Code before the product is usable: until then the Editor shows only the licence screen and the Local Service answers EM-5010 on every `/api/v1` route except the licence screen's (LICENSE_OPERATIONS.md §7, SEC-122). Single edition: the Payload `tier` stays for compatibility and never gates a feature. Exports are never watermarked or capped (the Engine watermark component, the 720p cap, EM-5001 and the onboarding Licence step are gone). Activation is rate-limited (EM-5011, SEC-123). Licence states become `licensed` / `unlicensed` / `invalid` / `revoked` / `machine-mismatch` (migration 32, DATABASE_SCHEMA.md §5.1); a key whose `upd` predates the build no longer runs in a degraded mode, it does not activate that build (EM-5005, now `error`). Trade-off: an evaluator cannot try the product without a key; BRD-002, D-3 and K-08 are void. **Open for the Operator**: GLOSSARY.md still defines "Trial Mode" (frozen file, HG-005); the term should be marked retired there.

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

- **Change (2026-10-25)**: "Trial Mode" retired (no trial; the licence screen gates the product, EM-5010, ADR-014 amendment) and "Purchase" removed from the Header actions.

## ADR-019 Two FFmpeg builds; H.264 encoding path for ingestion

- **Status**: provisional (settled in Stage 2, POC-003)
- **Problem**: Remotion ships a slim FFmpeg (`@remotion/compositor-win32-x64-msvc`) built for its output codecs; ingestion must probe and decode sources it does not cover (AV1, HDR, FLAC, ProRes). A full FFmpeg configured as LGPL has no libx264, yet the ingestion pipeline (ASSET_INGESTION.md §4) encodes playable copies and proxies to H.264.
- **Alternatives**: (A) bundle a GPL-configured full FFmpeg with libx264 and accept GPL obligations for that binary (source offer, notices); (B) decode with the LGPL full build to a raw pipe and encode with the compositor FFmpeg that Remotion already uses for H.264 output; (C) use OpenH264/`h264_mf` (Media Foundation) encoders in the LGPL build on Windows.
- **Selected (provisional)**: (B) as default, (C) as the measured alternative in POC-003; (A) only if both fail quality or speed targets, after legal review (BRD §6).
- **Finding (2026-10-24, Stage 2)**: the compositor FFmpeg (n7.1) already contains libx264 and libfdk_aac. Option (B) is therefore technically feasible without a second GPL build: decode with the full LGPL build and encode with the compositor. This does not remove the licence question, because the compositor binary itself is GPL-encumbered (RISK-030); legal review stays a release gate.
- **Consequences**: `resources/engine/compositor/` (slim, output) and `resources/bin/ffmpeg-full/` (LGPL, ingestion) in the installer; ASSET_INGESTION §3/§4 command lines are updated once POC-003 picks the encoder; Third-Party Notices list both builds.

## ADR-020 Operation vocabulary additions found during implementation

- **Status**: accepted (2026-10-24, Stage 2 implementation)
- **Problem**: writing `packages/catalogue` Compile rules showed that the P0 preset `preset:audio.fade-in-out` had no operation in AI_WORKFLOW.md §5 that could apply it (only `op:clip.setVolume` carries fades, and only for Clips).
- **Selected**: add `op:audio.setFades {fadeInMs?, fadeOutMs?}` (target `audio`, scalar per field, propertyKeys `audio:<id>.fadeInMs` / `audio:<id>.fadeOutMs`). The P2 preset `preset:audio.visualizer-bars` gets no Compile rule until its P2 operation is designed (no mapping onto `op:shape.add`, which only accepts shape presets).
- **Consequences**: AI_WORKFLOW.md §5 row added; `packages/composition-model` implements it with tests; the closed vocabulary now has 41 operations.

- **Addition (2026-10-24, Stage 3)**: `op:overlay.addImage` and `op:overlay.remove` with the new target kind `image`, because FR-029 (Insert Image as an overlay) had no operation; the Engine already rendered `OverlayImage`.

- **Addition (2026-10-24, Stage 3, FR gap closure)**: `op:overlay.setOpacity` (target `image` or `shape`, FR-028 opacity of overlay elements; `OverlayShape.opacity` optional field), and two optional args on existing ops: `italic` on `op:text.setStyle` / `op:theme.setTextDefaults` (FR-022, bundled italic font files) and `variant` on `op:text.setStyle` (FR-025). Text `fontSize` range is 16–200 u per FR-021. The vocabulary has 45 operations.

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

## ADR-024 Schema additions made while building the Local Service (Stage 3)

- **Status**: accepted (2026-10-24)
- **Problem**: implementing the service against DATABASE_SCHEMA §3 surfaced needs the initial DDL did not cover; the schema may only change through migrations (DATABASE_SCHEMA §5).
- **Selected**: migration 10 (undo/redo rows repeat a model hash, so the unique index on `composition_versions(project_id, hash)` becomes a plain index; `edit_plans` gains `intent_ids_json`, `message`, `result_json`, `idempotency_key`); migration 11 (`projects.is_sample` for the tour's Sample Project, R-025); migration 30 (`project_budgets`, `provider_defaults`, `brainstorm_handoffs`, `agent_runs.plan_id`); migration 20 (`render_jobs.failed_frame`, FR-143, added 2026-10-24). Added 2026-10-24 (FR gap closure): migration 13 (`projects.ui_state_json`, FR-012 Save persists UI state) and migration 21 (`assets.deleted_at` soft delete for Undo after Remove Asset, FR-052; `assets.source_key` path-import identity digest for EM-1006, FR-041). Intent status `held` (FR-037, EM-2104) is a value of the existing `edit_intents.status` column (no DDL change). Migrations are TypeScript modules so the bundled service needs no SQL files; each workspace area owns a version range (10–19, 20–29, 30–39).
- **Alternatives**: editing 001 in place (rejected: breaks databases already migrated); a JSON side store (rejected: no transactions with the rest).
- **Consequences**: DATABASE_SCHEMA §5.1 lists every applied migration; a new migration also needs a test and a row there.

## ADR-025 Design Preset descriptors are not encrypted in assets.enc (SEC-132 scope)

- **Status**: provisional (2026-10-24, security gap closure; Operator to confirm)
- **Problem**: SEC-132 (P0) asks for prompt **and** Design Preset descriptor assets to be stored AES-256-GCM encrypted. The prompts are (apps/service `assets.enc`, split key). The preset descriptors (`packages/catalogue`) are, however, read by the Editor bundle (Catalogue grid, Parameter Panel, Player) and by the Engine bundle that Chrome Headless Shell evaluates — both ship as JavaScript the renderer must execute.
- **Selected**: descriptors stay in the (obfuscated, SEC-130/131) Editor and Engine bundles; `assets.enc` covers the prompt set only. SEC-132 is read as "prompt assets encrypted; preset descriptors protected by obfuscation + the signed integrity manifest (SEC-133)". Recorded as RISK-031.
- **Alternatives**: (a) encrypt descriptors and decrypt in the Service, serving them to the Editor over the API — rejected: the plaintext then sits in the renderer heap and in every API response, so it adds a code path and startup latency for no extraction cost a debugger cannot bypass in minutes; (b) decrypt inside the Editor with a key in its bundle — rejected: the key would ship next to the ciphertext (no gain, ADR-007 honesty).
- **Consequences**: the release grep check of SEC-132 ("known prompt sentence → 0 hits") stays valid; no check is claimed for preset parameter tables. Revisit if presets gain proprietary content beyond parameter tables (e.g. Operator-authored motion curves worth protecting), then a Service-side catalogue API is the path.

## ADR-026 Model files are served from the Operator's Cloudflare R2 CDN

- **Status**: accepted (Operator decision 2026-10-25)
- **Problem**: Creators' apps downloaded model weights straight from Hugging Face `resolve/main` URLs: the files can change or disappear upstream, gated repositories need a Hugging Face account, and the allow-list had to trust several third-party hosts (SEC-071).
- **Alternatives**: keep Hugging Face with pinned commits (still third-party availability and gating); Cloudflare Pages / Workers static assets (25 MB per-file limit, unusable for GB weights); a paid object store with egress fees.
- **Selected**: the Operator mirrors each redistributable model file once (`tools/model-mirror`) into a Cloudflare R2 bucket on a custom domain (free tier 10 GB storage, no egress fee) as `m/<sha256>`, with a signed `models.json` (SEC-072). Release builds bake `EM_MODEL_CDN_URL`; the model-download allow-list is then exactly that host, and the Service fetches the signed list from it at most once per 24 h.
- **Trade-offs**: the Operator runs the mirror and pays for storage above 10 GB (the full mirrorable set is ≈ 23.4 GB; FLUX alone is 12.25 GB); models whose licence forbids redistribution cannot be offered this way; one more Operator secret (the R2 upload token, never in the repo or binary).
- **Consequences**: DEPLOYMENT_AND_PACKAGING.md §16 (runbook), LOCAL_AI_MODELS.md §4.5 (policy), SECURITY.md SEC-071/SEC-072, API R-147, `scripts/release-check.mjs` item for `EM_MODEL_CDN_URL`.
- **Amendment (2026-10-25, Operator decision)**: the default is now a direct download from Hugging Face at pinned commits with a sha256 and exact size per file (`packages/models/src/pins.ts`, read from the public HF API; every file anonymous, the FLUX VAE from the byte-identical Apache-2.0 copy in `second-state/FLUX.1-schnell-GGUF`). Allowed hosts add `*.hf.co` (HF's regional download CDN). The Model Manager never shows the download source (no source URL; licence links point to SPDX licence texts). The Cloudflare R2 CDN stays available as an option (`EM_MODEL_CDN_URL`), no longer required by `release-check`. Verified on 2026-10-25 with a real install of `piper-id-news-medium` (63 MB, both files hash-verified).

## ADR-027 Layered lanes: stacking order, element timing and layer operations (CapCut-style Timeline)

- **Status**: accepted (Operator decision 2026-10-25)
- **Problem**: the Timeline View showed fixed rows (video, overlay, text, caption, audio) with overlapping items drawn over each other, only video Clips could be dragged or trimmed, and the Composition Model had no stacking order: the Engine painted all overlays under all texts in array order, so a text could never sit under an image and the Editor Agent could not "put the title above the image". The Operator wants the timeline to work like CapCut / common editors: layered tracks with the top row as the front-most layer, and every item draggable (time and lane) and trimmable, with snapping and undo.
- **Alternatives**: (a) a free `zIndex` number per item with overlapping items allowed on one row (rejected: two concepts — row and z — to keep in sync, and the Timeline would still draw overlaps); (b) one array per lane (rejected: a schema rewrite of every track and every op); (c) per-kind timing ops (`op:overlay.setTiming`, `op:shape.setTiming`, …) (rejected: four ops for one gesture; one generic op is simpler for the Editor Agent).
- **Selected**: Composition Model **schema v2**: `layer` (integer ≥ 0, higher = more in front) on TextLayer, OverlayImage and OverlayShape, one Timeline lane per layer; `lane` (integer ≥ 0) on AudioLayer (rows under the video Track, no stacking meaning). **Lane rule** (deterministic, in `applyOps`, `packages/composition-model/src/layers.ts`): items on one lane never overlap in time; a new item goes just in front of every item it overlaps (layer 0 when it overlaps nothing; audio: first free lane); a move, trim or explicit lane that would overlap goes to the lane above, or to a new lane inserted there (lanes above shift up by one); lanes are renumbered densely after every op (an emptied lane disappears, as in CapCut). Render order = visual items sorted by layer (stable: overlays, then texts), captions above all, video below; the same `ExpertmotionTimeline` code renders preview and export. Two operations: `op:element.setTiming {atMs, durationMs, trimBeforeMs? (audio left-edge trim), layer?}` on text / image / shape / audio (one op per drag gesture, also across lanes; `op:text.setTiming` stays and follows the same rule) and `op:element.setLayer {layer} | {move: up|down|front|back}` (stacking; audio: lane number or up/down). Optional `layer` on `op:text.add`, `op:shape.add`, `op:overlay.addImage`. A looping audio layer with a `durationMs` now stops there (v1 ignored it; the migration drops it from v1 looping layers). The Timeline UI compiles every drag, trim, lane change and layer key to one `elementEdit` Design Pick (Compile path, no LLM, undoable like other picks). Snapping: playhead and other items' edges within 8 px, frame grid otherwise; Alt/Option disables snapping. Validator CM-012 (warn) reports overlaps on one lane in hand-made JSON.
- **Trade-offs**: dense renumbering changes other items' `layer` values (their relative order never changes), so a plan diff can list items the op did not target; a Creator's drag locks `<kind>:<id>.timing` / `.layer` against later agent edits like every UI pick; the vocabulary grows to 47 operations.
- **Consequences**: DATABASE_SCHEMA §4 (fields, CM-012) and §5.2 (v1 → v2 migration, golden fixture `packages/composition-model/test/fixtures/model-v1.json` → `model-v2.expected.json`); AI_WORKFLOW §4, §5, §6; SYSTEM_PROMPT v1.1.0; FRD FR-063, FR-064, FR-068; EDITOR_INTERACTION_MODEL IX-26, §7, §8; ELEMENT_IDS lanes; UI_UX_SPECIFICATION Timeline rows; GOLDEN_SCENARIOS GS-21.

## ADR-028 Split at the playhead and canvas transform (CapCut-style cut, move / zoom / rotate inside the frame)

- **Status**: accepted (Operator request 2026-10-26); the schema-versioning choice below is **provisional** until the Operator confirms that a build older than this change does not need to refuse such projects.
- **Problem**: beginners expect two basic CapCut tools: (A) cut a clip (or a text, image, shape, audio layer) in two at the playhead, and (B) move, zoom and rotate a picture inside the frame — e.g. a 1:1 video or photo in a 16:9 project, choosing which part shows. The model had only `objectFit` cover / contain and an optional crop on Clips, position / size on overlays, and no way to split anything except by re-inserting and trimming by hand; the Editor Agent could not do "cut the clip at 5 seconds" or "zoom the video to 120 % and move it left".
- **Alternatives**: (a) per-kind ops (`op:clip.split`, `op:text.split`, …; `op:clip.setTransform`, `op:overlay.setTransform`) (rejected: more names for one gesture each; one generic `op:element.*` is simpler for the Editor Agent, as ADR-027); (b) transform as `crop` + `objectPosition` (rejected: no zoom beyond cover, no rotation); (c) a transform object on overlays too (rejected: overlays already have `position` in u, two sources of truth for one place); (d) schema v3 with a required `transform` defaulted by migration (rejected for now: it changes the hash of every stored model and every checkpoint, for a value that is the identity when absent).
- **Selected**: **(1) Model, no schema bump**: optional `transform {x, y, scale, rotation}` on Clip (x / y = centre offset as a fraction of the frame width / height, scale 1 = the objectFit result, 0.1…10, rotation degrees clockwise stored in [0, 360)); optional `scale` (0.05…20, 1 = stored `size`) and `rotation` on OverlayImage and OverlayShape, their x / y staying in `position` (u). Absent = the identity = the picture before this ADR, and `applyOps` removes the fields again when a reset reaches the identity, so stored models, their hashes and checkpoints are unchanged and a reset restores the old hash. `schemaVersion` stays 2 (DATABASE_SCHEMA §4.5 / §5.2 note). Caveat: an Expertmotion build from before this ADR silently drops the fields (Zod strips unknown keys) instead of refusing the project — acceptable while no build has shipped (Stage 4 not released); revisit with a v3 marker if a released build must refuse. **(2) Ops (vocabulary 49)**: `op:element.split {atMs}` on clip / text / image / shape / audio (composition time; ≥ 100 ms from both ends; the target keeps its id as the first part, the second part gets a new id and continues the source: clip `trimBeforeMs + d × playbackRate` (image clips 0), audio `trimBeforeMs + d` (mod source length when looping; open-ended stays open); first part keeps the fade-in and the motion with exit off, second the fade-out and no motion; effects, volume, fit, crop and transform copied; a clip split inserts a cut with no transition, the transition after the clip moves to the second part, adjacent transitions are re-clamped to half the shorter clip (EM-2305 warn, removed below 100 ms); keys `clip:<id>.trim` + `sequence.order` or `<kind>:<id>.timing`) and `op:element.setTransform {x?, y?, scale?, rotation?}` on clip / image / shape (absolute values, omitted fields kept; key `<kind>:<id>.transform`). **(3) Engine**: one pure CSS function per kind (`clipTransformStyle`: `translate(x·W px, y·H px) rotate() scale()` on a wrapper around the media inside a clip frame with `overflow: hidden`; `overlayTransform`: `translate(-50%, -50%) rotate() scale()` on the overlay box), used by the same `ExpertmotionTimeline` in the Player and the render (parity). **(4) UI**: Player canvas handles (move with snap guides to the frame centre / edges, corner scale with the opposite corner fixed or Shift = centre, rotation handle with Shift = 90° snaps, double-click reset, Esc cancel, Alt = no snapping), live optimistic preview of the shown model, one `transformEdit` Design Pick per gesture with all four values; Inspector X / Y % / Scale % / Rotation ° fields, Fit / Fill / Reset, align centre / top / bottom / left / right; Timeline scissors + S → one `splitEdit` pick for every selected item at the playhead (or the clip under the playhead): one parent, one child per item, one Composition Version. Split intents use a unique `list:split:…` key (an event: never superseded, never a Locked Key); transform intents are scalar `<kind>:<id>.transform` (Locked Key for the Editor Agent like every UI pick).
- **Trade-offs**: x / y in frame fractions mean a ratio change keeps the relative place (a quarter to the left stays a quarter) but not the pixel offset; overlay x / y round to 0.1 u; the second part of a split loses an enter motion and the first part its exit motion (the model cannot separate enter from exit of one preset); text is not transformable on the Player yet (it has position and its own fit rules); rotation of a clip shows the background in the corners unless zoomed (as in CapCut); the vocabulary grows to 49 operations.
- **Consequences**: DATABASE_SCHEMA §4.2 (Clip `transform`, overlay `scale` / `rotation`), §5.2 note; AI_WORKFLOW §4 (split / transform Target Resolution and Compile rows), §5 (two rows), §6 (transition re-clamp row); SYSTEM_PROMPT v1.2.0; FRD FR-179, FR-180; EDITOR_INTERACTION_MODEL IX-27, IX-28, §7 (S, Shift, Alt), §8; ELEMENT_IDS `stage.player.canvas.*`, `stage.timeline.split`, `stage.timeline.inspector.transform.*`; UI_UX_SPECIFICATION Player and Timeline; API_SPECIFICATION R-060 `splitEdit` / `transformEdit`; GOLDEN_SCENARIOS GS-22.

## ADR-029 Linux packages now, macOS prepared: one build per platform with its own binaries

- **Status**: accepted for the platform scope (Operator decision 2026-10-26: ship Ubuntu Linux AppImage + deb x64 now, prepare macOS); `provisional` for the engine-build choices below (the Operator confirms them after the first desktop smoke test).
- **Problem**: the product was packaged for Windows only (PRD-055 listed macOS / Linux as P2). Each platform needs different executables (PE / ELF / Mach-O), shared-library lookup (PATH + DLLs / RUNPATH + LD_LIBRARY_PATH / LC_RPATH), file permissions, keyring backend and signing. The Operator's rule: no build may ever call another platform's path or binary ("jangan sampai salah alamat").
- **Alternatives**: (a) one multi-platform resources tree with runtime selection (rejected: every package would carry every platform's binaries, and a lookup bug could start the wrong one); (b) per-platform `extraResources` macros in electron-builder (rejected: electron-builder's `${os}` names differ from Node's and the staging guard would be split across two tools); (c) build engines from source on every platform (rejected for Windows and Linux: official pinned releases exist; kept only where none exists).
- **Selected**: `packages/models/engines.json` entries carry `platform` + `arch`; `scripts/prepare-engines.mjs --platform` writes `resources/engines-<platform>-<arch>/` with a `PLATFORM.json` marker; `scripts/stage-desktop.mjs --platform --arch` stages exactly one platform (Chrome Headless Shell folder, compositor package, `resources/bin-<platform>-<arch>`, engines) into `apps/desktop/resources` and refuses any executable image of another OS or CPU, a wrong marker, or a Windows file name off Windows; per-platform electron-builder `files` keep other platforms' native prebuilds and compositors out of the asar. Engine child env per platform (Linux: `LD_LIBRARY_PATH` = engine folder, `TMPDIR`; macOS: no `DYLD_*`, LC_RPATH only). Provisional engine choices: Linux stable-diffusion.cpp **CPU** build (no GPU driver or libvulkan needed); macOS whisper.cpp **built from the pinned tag + commit** (no official macOS CLI); macOS stable-diffusion.cpp official universal binary although it requires macOS 26 (documented gap).
- **Trade-offs**: one electron-builder run per platform and, on macOS, per architecture; the Linux sd.cpp build does not use a GPU; the Linux ingestion FFmpeg is the static BtbN build (≈ 140 MB each for ffmpeg and ffprobe, larger than the Windows shared build); Linux has no ASAR integrity (Electron limitation) and no V8 bytecode step yet; minimum Ubuntu 24.04 (glibc 2.38 for sd.cpp).
- **Consequences**: DEPLOYMENT_AND_PACKAGING.md §17 (inputs, engines, Linux build and runtime, macOS preparation, guards); `scripts/build-linux.sh`, `scripts/build-mac.sh`; SECURITY.md SEC-040 (Linux keyring behaviour), SEC-061 (Linux / macOS executable names hashed); LOCAL_AI_MODELS.md §3.1; PRD-055 Linux part delivered.

## ADR-030 Videos without media: scene clips, generator plan steps, lenient plan reading (QA 2026-10-26)

- **Status**: accepted (Operator emphasis 2026-10-26: "a project with ZERO assets must produce a complete, renderable motion video straight from a prompt"); the no-schema-bump choice is **provisional** on the same terms as ADR-028.
- **Problem**: Windows QA with Claude Haiku 4.5 found (2) no way to make a faceless video, (4) no video from a complete Diskusi answer even with one asset, (5) Editor runs that fail or do nothing. Causes found in the code: the Local Service refused every Editor run while the video Track was empty (EM-2202 "insert an asset first", also when the asset was in the Library); the video Track required media, so there were no scenes, cuts or transitions without footage and an empty Track lasted 1 s; the model was never told the args of any op (names only) and the plan parser was strict (`baseVersion` echo, `tool` literal, strict ops / targets, `expectedDiff` ≤ 200, no top-level `ops`), so near-misses failed three times and ended as EM-4301 — or as a false "composition changed" (EM-2301) when the model echoed a wrong base; a failed plan was posted as the Creator's own text with an empty Plan Card; nothing about a run was logged.
- **Alternatives**: (a) texts only on a fixed-duration project (`op:project.setDurationPolicy` + `op:text.add`) (rejected as the only path: no per-scene backgrounds, no transitions between scenes; kept working: a project without Clips now fits its texts / overlays / voice-over); (b) a new Track of "scenes" (rejected: a second sequence beside the video Track, transitions duplicated); (c) a generated solid-colour video Asset per scene (rejected: encodes media for a colour, needs FFmpeg and disk, breaks Undo symmetry); (d) **scene clips on the video Track** (selected).
- **Selected**: **(1) Model**: a Clip has exactly one of `assetId` (media) or `scene {presetId (background preset), params}` (CM-001); optional fields, `schemaVersion` stays 2 (DATABASE_SCHEMA §4.2 note). A scene clip renders its background preset in its window through the same `ExpertmotionTimeline` (Player = render); trim / split / transition / motion / effects / transform / Undo work as for media; no source checks. A project without Clips fits the end of its texts, overlays and audio layers with a length (DATABASE_SCHEMA §4.3). **(2) Ops (vocabulary 51)**: `op:scene.add {durationMs, background?, backgroundParams?, atIndex?, title?, text?, titleVariant?, textVariant?, motionId?, transition?, transitionMs?}` appends a scene clip with its texts over it (from the clip start plus the incoming transition) and the transition from the previous scene; `op:scene.setBackground {presetId, params?}` on a scene clip. **(3) Generator plan steps**: `tts.generate {text, atMs?, voiceId?, language?, speed?}` and `captions.generate {source: script | voice | sequence, text?, atMs?, durationMs?, presetId?}` are Edit Plan steps (no ops); `validatePlan` checks their args, marks a step `needs-model` with a `model-missing` warn risk when its local model is not installed (the rest of the plan runs), and turns script captions that need no model into `op:caption.setPages` in the same version; after Execute the Local Service runs the voice job (inserted at `atMs`) and times the script captions over the voice layer (deterministic Caption Sub-agent, no transcription model). **(4) Lenient reading**: unambiguous slips are repaired deterministically (plan-normalize.ts: wrappers, code fences, missing `n` / `expectedDiff` / risks, `op:` prefix and known aliases, args at the op's top level or in `params`, near-miss arg names, short preset ids, an asset id where its one clip is meant, string targets, percent volumes / scales, intents with preset ids compiled); the runtime owns `baseVersion`; correction messages name step, op and the op's exact args signature; every op's args are in the envelope (`capabilities.opArgs`, generated from the Zod schemas). **(5) Pointing**: chat chips are explicit `targets` resolved with facts (FR-189); a vague request with chips that yields no plan becomes a short question. **(6) Diagnostics**: one service log line per agent run (agent, mode, provider, model, duration, plan size, repairs, validation codes / paths, provider code / status / reason; never prompt or Creator text or keys) and `agent.run.progress` phases (FR-190).
- **Trade-offs**: repairs can only fix what is unambiguous — an ambiguous slip still costs a correction round; dropped unknown args are named in the correction message but a plan whose only arg was unknown can still be a valid no-op; scene texts are absolute in time, so inserting a scene in the middle later does not move the texts of the scenes after it (the Editor Agent appends scenes; Timeline edits move texts with their gestures); script caption timing is proportional to word length, not the spoken audio; one background per scene (no per-scene gradients beyond the preset params); an older build drops `scene` and would read a scene clip as broken (CM-001) — acceptable while no build has shipped.
- **Consequences**: DATABASE_SCHEMA §4.2–§4.4; AI_WORKFLOW §3 (plan step tools), §5 (two rows), §7 (`targets`, `opArgs`, `stepTools`), §8, §12, §14 (AI-022…AI-025); AGENT_DESIGN §2.2, §2.4; SYSTEM_PROMPT v1.4.0; FRD FR-188…FR-191; API_SPECIFICATION R-081 `targets`, `agent.run.progress`, `agent.run.failed` `message` / `details`, R-073 `toolSteps`, EM-4002 `details.recentKey`; GOLDEN_SCENARIOS GS-23; ELEMENT_IDS (chips, progress, error actions); engine `ClipView` scene branch; render preflight accepts videos without media.
