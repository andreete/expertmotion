# UX Requirements Document (UXRD)

| Field | Value |
|---|---|
| Status | baseline |
| Owner | UI/UX lead |
| Last updated | 2026-10-24 |
| Depends on | MASTER_PROJECT_PROMPT.md (§2, §7, §9, §13, §16), GLOSSARY.md, PRD.md, DECISIONS.md (ADR-002, 010, 011, 012, 014), AI_WORKFLOW.md, DESIGN_CATALOGUE.md, PERFORMANCE.md, ELEMENT_IDS.md |
| Used by | USER_FLOWS.md, EDITOR_INTERACTION_MODEL.md, UI_UX_SPECIFICATION.md, ACCESSIBILITY_AND_I18N.md, ONBOARDING_TOUR.md, FRD.md, TEST_PLAN.md |
| Owner of | personas (detail), jobs-to-be-done, UX principles, UX- requirements, the five-state display model, state policy (error/empty/loading), UX research plan |
| ID range | UX-001 … UX-099 |

This document says what the Creator must be able to feel, find, understand and recover from. It does not define screens (UI_UX_SPECIFICATION.md), element ids (ELEMENT_IDS.md), flows (USER_FLOWS.md) or per-action behaviour (EDITOR_INTERACTION_MODEL.md). Terms follow GLOSSARY.md exactly. Every user-facing string carries an Indonesian (ID) variant; the MVP UI shows the English string (ADR-012).

## 1. Personas

PRD.md §2 owns the one-line persona table. This section adds the detail the UX work needs.

### 1.1 Septi, the Creator (primary)

| Aspect | Detail |
|---|---|
| Who | Indonesian content creator, 20–35, posts Reels/TikTok/Shorts daily and a YouTube explainer every week or two. Works alone. |
| Goals | Publish a polished, animated video in under an hour from raw phone clips; keep one recognisable style across videos; add captions because most viewers watch muted; export in the right ratio for each platform without re-editing. |
| Skills | Fluent with CapCut, Canva and phone editors; has never opened a terminal; knows "AI" from ChatGPT; types in Bahasa Indonesia, reads English UI. |
| Devices | Mid-range Windows 11 laptop (i5, 16 GB RAM, integrated GPU = Hardware Tier T0), 1366×768 or 1920×1080 screen, trackpad more than mouse, mobile hotspot internet that drops. |
| Anxieties | "Will this cost me money every time I click?" · "Did the AI change something I did not ask for?" · "If it crashes, do I lose an hour?" · "Is my footage being uploaded somewhere?" · "I do not understand the technical words." |
| Success looks like | Opens Expertmotion, drops three clips, picks a transition and a caption style, types one sentence to the Brainstorming Agent, presses Execute, exports a 9:16 1080p MP4, and understands every step she took. |

### 1.2 The small business owner

| Aspect | Detail |
|---|---|
| Who | Runs a café, salon or online shop; makes two or three promo videos a month; often delegates to a nephew or part-time staff. |
| Goals | Brand consistency (same colours, same font), quick turnaround, no subscription per seat, a result that looks "not amateur". |
| Skills | Lower than Septi: uses WhatsApp and Instagram, has used ready-made Canva layouts. Will read a tooltip once and never again. |
| Devices | Older Windows 10 laptop (8 GB RAM, T0) or the shop PC; sometimes a 1280×720 screen. |
| Anxieties | "Which button do I press first?" · "Is this the price for the licence, or per video?" · "What if my staff breaks the project?" |
| Success looks like | Reuses last month's project, swaps the clips, keeps the Theme, exports 1:1 and 9:16 versions. |

### 1.3 Andre, the Operator

| Aspect | Detail |
|---|---|
| Who | Builds, signs, licenses and supports Expertmotion. |
| Goals | Low support load: Creators can self-diagnose and send a diagnostics bundle; failures name an `EM-` code; the UI never promises what the system cannot verify. |
| Skills | Engineer. Uses the same Editor as Creators plus Help ▸ Diagnostics. |
| Devices | Development on the shared 1.9 GB Linux server (headless parts only; PERFORMANCE.md §5); testing on Windows hardware. |
| Anxieties | "A Creator says 'it broke' with no detail" · "A render hangs a laptop and the product gets blamed" · "Someone screenshots a cost figure the provider never reported." |
| Success looks like | Every support request arrives with an `EM-` code and a diagnostics bundle; no error copy mentions Remotion, Node or Chrome. |

## 2. Jobs-to-be-done

| JTBD | When… | I want to… | So that… | Primary element ids |
|---|---|---|---|---|
| J1 | I have raw clips on my laptop | drop them in and get them in the right order | I can start designing in under two minutes | `lib.assets.drop`, `lib.assets.card.badge.sequence`, `lib.assets.insert` |
| J2 | I know roughly the look I want | browse looks and see each one on my own footage before committing | I do not waste a cycle on a wrong pick | `lib.catalogue.card`, `stage.player.canvas` (ADR-011) |
| J3 | I can describe but not name what I want | say it in my own words and get a concrete proposal | I do not need the vocabulary of a motion designer | `agent.brainstorm.composer`, `agent.brainstorm.handoff`, `agent.editor.plancard` |
| J4 | The AI proposes a change | see exactly what will change and approve or refuse | nothing happens behind my back | `agent.editor.plancard.step.diff`, `agent.editor.execute`, `agent.editor.cancel` |
| J5 | I change my mind | undo one step or go back to a known-good version | I can experiment without fear | `agent.editor.intentqueue.item.restore`, Ctrl+Z, `hdr.menu.file.recover` |
| J6 | I am ready to publish | choose the platform format and export without technical questions | the file is right first time | `agent.output.ratio.*`, `agent.output.resolution.*`, `scr.export` |
| J7 | Something fails | know what happened, what to do, and that my work is safe | I keep trust in the product | `sys.toast`, `stage.player.state.error`, `scr.project.recover` |
| J8 | I am on a hotspot or offline | keep working with everything that does not need the internet | my day is not blocked | `agent.output.private`, `sys.privatemode.banner` |
| J9 | I worry about cost | see what each AI call used, honestly labelled | I can budget | `agent.*.footer.ctx`, `scr.providers.budget.project`, `scr.providers.budget.month`, Plan Card usage line |

## 3. UX principles

| # | Principle | What it means in the Editor | Violates it |
|---|---|---|---|
| P1 | **Select, preview, describe** (brief §16) | Every creative choice is a click on something visible (Catalogue Card, Text Panel) or a sentence to an agent. The Player shows the result of a hover before a click. | Free-form parameter forms as the primary path; numeric fields the Creator must fill before anything happens. |
| P2 | **Never show code, Remotion or a terminal** (brief §2, GLOSSARY "Engine") | No word "Remotion", "React", "Node", "npm", "Chrome", "FFmpeg", "JSON", "stack trace" in any Creator-facing string. Errors speak in `EM-` codes plus plain language. Diagnostics (Help ▸ Diagnostics) may show technical detail, behind one more click. | A toast reading "renderMedia failed: ECONNRESET". |
| P3 | **Every AI action is visible and reversible** (brief §8.4, ADR-002) | Every pick and every message becomes an Intent Queue item. Every agent proposal is a Plan Card with steps and an expected diff. Every mutation creates a Composition Version that undo can reach. Deterministic picks are labelled "Applied directly". | An agent reply that says "Done!" without a Plan Card; a change not in the Intent Queue. |
| P4 | **Honest system status** (brief §9, §13) | Costs read "≈" or "n/a" unless the provider reported them. Performance Profiles explain themselves (PERFORMANCE.md §2 tooltip). Progress shows ETA only when supportable. Private Mode states exactly what it blocks. Trial Mode states watermark + 720p before the Creator starts a render. | "Turbo makes rendering 4× faster"; "Cost: $0.0021" computed from a guessed price. |
| P5 | **Beginner-first with progressive disclosure** | Defaults do the right thing (Auto ratio, Standard profile, Theme default fonts). Advanced detail (params, risks, raw model text, versions) sits behind "Details" disclosures, never removed. The tour and empty states teach the first path only. | Showing every preset param on first hover; hiding undo because it is "advanced". |
| P6 | **Work is never lost** (PRD-003) | Autosave checkpoint ≤ 10 s; recovery dialog on relaunch; a running render that fails marks the job failed and leaves the Editor alive (PRD-015). | A modal that blocks saving; a crash that loses the Intent Queue. |
| P7 | **One live thing at a time** (ADR-011, PERFORMANCE.md) | One Player, one render, one agent run per agent. The UI makes waiting legible (spinner with the model name, progress chip) instead of letting the Creator start parallel work that would exhaust memory. | Two renders queued silently; six looping Players in the catalogue. |

## 4. The five states (brief §16) and how the UI shows each

The Creator must always be able to tell which of the five states a change is in. The states are displayed with distinct words, places and visual treatments; they are never merged.

| State | Definition | Where it appears | Visual treatment (tokens in UI_UX_SPECIFICATION.md) | Copy EN / ID |
|---|---|---|---|---|
| S1 **User preference** | A Design Pick, Text Panel pick, Output Settings change or chat message, stored as an Edit Intent with status `queued`. Nothing has changed in the Composition Model. | `agent.editor.intentqueue.item`; `lib.catalogue.card.selected`; selected ratio/resolution buttons | Neutral chip, left border in `--muted`; icon "bookmark" | "Queued" / "Antre" · for superseded: "Replaced by …" / "Diganti oleh …" |
| S2 **Proposed AI interpretation** | An Edit Plan with `origin: editor-agent` and status `draft` or `valid`, or a Brainstorming handoff card with `proposedIntents`. Still nothing has changed. | `agent.editor.plancard` (header badge), `agent.brainstorm.handoff` | Dashed accent border, badge "Proposed"; steps listed with expected diff; risks visible | "Proposed by Editor Agent · nothing applied yet" / "Usulan Editor Agent · belum diterapkan" |
| S3 **Approved edit plan** | The Creator pressed Execute; plan status `executing`. The transaction is running. | `agent.editor.plancard` (badge changes), `agent.editor.execute` becomes a spinner, `agent.editor.cancel` enabled | Solid accent border; progress indicator on the card; Execute disabled | "Executing…" / "Menjalankan…" |
| S4 **Executed operation** | `ExecutionResult.ok = true`; a new Composition Version exists; SSE `composition.updated` received. | Plan Card badge; `sys.toast` with the diff summary; Intent Queue items move to `executed` | Success colour badge with check; toast "Applied: 3 changes · v13" with Undo action | "Applied · version 13" / "Diterapkan · versi 13" · Compile path: "Applied directly" / "Langsung diterapkan" |
| S5 **Verified composition state** | Post-validation (`validate(model)`) passed, the Player has loaded the new version and the Timeline View reflects it. | `stage.player.controls` version chip; `stage.timeline` refreshed; Header `hdr.title.dirty` set until saved | Version chip "v13 ✓"; elements changed in the last version pulse once (200 ms) | "Preview up to date" / "Pratinjau sudah terbaru" · if post-validation emitted warnings: "Applied with 1 note" / "Diterapkan dengan 1 catatan" |

Rules:

1. A state transition is always shown in the place where the previous state was shown (the Plan Card badge moves S2 → S3 → S4; it does not vanish).
2. A failure returns the change to the previous visible state with a reason: Execute failure → plan status `failed`, badge "Not applied · EM-2xxx" / "Tidak diterapkan · EM-2xxx", version unchanged (AI_WORKFLOW.md §12 rollback).
3. S1 items are editable (restore, remove); S2 is editable only through the notes field and re-plan; S3 is cancellable; S4 and S5 are reversible only through undo (a new version), never edited in place.
4. The Stale Plan case shows "Composition changed; re-plan" / "Komposisi berubah; susun ulang" on `agent.editor.plancard.baseversion.stale` and keeps the plan in S2 with Execute disabled.

## 5. UX requirements

Verification methods: **UT** moderated usability test (§8), **UI** automated UI test keyed on element ids, **IR** inspection review against this document, **PT** performance test (PERFORMANCE.md).

### 5.1 Time to value and discoverability

| ID | Requirement | Acceptance criteria | Verification | Traces |
|---|---|---|---|---|
| UX-001 | A new Creator reaches a first exported MP4 within 10 minutes of launching the installer for the first time, including onboarding. | In UT with 5 participants matching persona 1.1, median ≤ 10 min, no participant > 15 min; task = three provided clips, one transition, one caption style, export 9:16 1080p (720p in Trial Mode). | UT | PRD-018, PRD §5 |
| UX-002 | Insert is discoverable without the tour. | ≥ 4 of 5 UT participants who skipped the tour find `lib.assets.insert` and place clips within 3 minutes of their first import, unprompted. The Asset Panel empty state names the Insert step. | UT, IR | PRD-006 |
| UX-003 | The Creator understands what Execute does before pressing it the first time. | After their first Plan Card appears, ≥ 4 of 5 participants correctly state (think-aloud) that "nothing changes until I press Execute" and name at least one listed step. | UT | PRD-012, AI-004 |
| UX-004 | Every Catalogue Card previews on the Creator's own footage before a click. | Hover on `lib.catalogue.card` updates `stage.player.canvas` within 300 ms (PERFORMANCE.md §5); when no Clip exists, the Player shows the preset on a neutral sample with the label "Sample · insert a clip to preview on your video" / "Contoh · sisipkan klip untuk melihat di video kamu". | PT, UI | ADR-011 |
| UX-005 | The Creator never needs to type a parameter to get a result. | Every P0 preset in DESIGN_CATALOGUE.md produces a valid Composition Version from a single click with defaults; parameters are reachable through "Details" or the Editor Agent. | UI | AI-011, PRD-013 |
| UX-006 | Catalogue Search finds presets by plain words in EN and ID. | Typing "lembut" or "smooth" into `lib.search.input` lists `preset:transition.fade` first; search covers labels and tags (DESIGN_CATALOGUE.md §13). | UI | — |

### 5.2 Trust, visibility and reversibility

| ID | Requirement | Acceptance criteria | Verification | Traces |
|---|---|---|---|---|
| UX-010 | Every change to the Composition Model is traceable to a visible Intent Queue item. | For each `composition.updated` event, the Intent Queue contains ≥ 1 item with status `executed` or `compiled` whose `propertyKey` appears in the version diff. No change without an item. | UI | AI-010, P3 |
| UX-011 | Superseded picks stay visible and can be restored in one click. | `agent.editor.intentqueue.item.superseded` is struck through, shows "replaced by", and `.item.restore` sets it back to `queued` (stamping `restoredAt`, AI_WORKFLOW.md §3) and makes the newer one superseded in turn. | UI | AI-018 |
| UX-012 | The five states (§4) are visually distinct. | Side-by-side screenshots of S1–S5 are classified correctly by ≥ 4 of 5 UT participants after the tour. Badge copy differs for every state. | UT, IR | brief §16 |
| UX-013 | Deterministic picks are labelled as applied directly, not as AI work. | Compile-path versions show "Applied directly" on the toast and the Intent Queue item; no model name or token usage is shown for them. | UI | ADR-002 |
| UX-014 | Undo is one gesture and always available after a mutation. | Ctrl+Z (or toast "Undo") moves the project head to the previous Composition Version within 500 ms; Ctrl+Y redoes; the Player and Timeline View refresh. P0 covers linear undo; P1 (PRD-034) adds the version list. | UI | PRD-034 |
| UX-015 | Destructive operations ask once and name what is destroyed. | `op:clip.remove`, `op:caption.clear`, `op:background.clear`, Output Settings Reset, Restore from zip, New Project with unsaved changes: a modal names the affected items ("Remove clip 2 (beach.mp4) and its transition?" / "Hapus klip 2 (beach.mp4) beserta transisinya?"). Never a bare "Are you sure?". | UI, IR | brief §8.4 |
| UX-016 | The Creator can always see whether an agent is working and on what. | While a provider call is in flight, the relevant chat shows "Asking <model>…" / "Bertanya ke <model>…" with a cancel affordance; no hidden calls. | UI | AI_WORKFLOW.md §11 |

### 5.3 Honesty: cost, performance, privacy

| ID | Requirement | Acceptance criteria | Verification | Traces |
|---|---|---|---|---|
| UX-020 | Cost is shown only as the provider reports it, labelled otherwise. | Usage lines show "$0.004" when the provider returned cost; "≈ $0.004" when computed from the Capability Table; "n/a" otherwise. The tooltip explains the label. In UT, ≥ 4 of 5 participants explain the "≈" correctly. | UI, UT | brief §9, AI_WORKFLOW.md §11 |
| UX-021 | Context usage is visible per agent at all times. | `agent.brainstorm.footer.ctx` and `agent.editor.footer.ctx` show "used / limit" tokens from the last request; turns amber at 60 %, red at 85 %. | UI | AI-015 |
| UX-022 | Performance Profiles are explained honestly where they are chosen. | `agent.output.profile.help` shows the PERFORMANCE.md §2 tooltip verbatim; unavailable profiles are disabled with the tier reason, never hidden. | IR, UI | ADR-010 |
| UX-023 | Aspect Ratio controls show orientation and exact pixels. | Each `agent.output.ratio.*` button shows an orientation glyph and "W×H" for the current Resolution from the PERFORMANCE.md §3 table; width always precedes height. | UI | brief §13 |
| UX-024 | Private Mode is unmistakable. | While on: `sys.privatemode.banner` is visible in every screen, `agent.modelbar.status` shows the private icon, both composers are disabled with the inline note "Private Mode is on. Agents, model downloads and update checks are paused; everything else works." / "Mode Privat aktif. Agen, unduhan model, dan pemeriksaan pembaruan dijeda; fitur lain tetap berjalan." In UT, 5 of 5 participants state correctly what Private Mode blocks. | UI, UT | PRD-020, AI-017 |
| UX-025 | Trial Mode limits are stated before the Creator invests effort. | On first launch and in `scr.export.preflight`, Trial Mode shows "Trial: watermark and 720p. Purchase to remove." / "Uji coba: watermark dan 720p. Beli lisensi untuk menghapusnya." before Start. | UI | PRD-017 |
| UX-026 | Progress shows an ETA only when it is supportable. | `scr.export.eta` shows "Estimating…" / "Memperkirakan…" until ≥ 5 % rendered and ≥ 3 progress samples exist; then an ETA rounded to 10 s. | UI | brief §13 |

### 5.4 Resilience and recovery

| ID | Requirement | Acceptance criteria | Verification | Traces |
|---|---|---|---|---|
| UX-030 | After a crash or forced quit the Creator recovers the last checkpoint without hunting. | On relaunch, `scr.project.recover` opens automatically when a checkpoint is newer than the last save, naming the project, time and version; one click restores. In UT (forced kill), 5 of 5 participants recover without help. | UT, UI | PRD-003 |
| UX-031 | A failed render never takes the Editor down and explains itself. | Killing Chrome Headless Shell during a render shows `sys.toast` with "Export failed · EM-3xxx" / "Ekspor gagal · EM-3xxx", a "Details" action and a "Try again" action; the Editor remains interactive; partial files are removed. | UI | PRD-015 |
| UX-032 | Loss of the Local Service is shown as one calm banner, not many errors. | `sys.offline` appears within 2 s of connection loss, suppresses other error toasts, shows reconnection attempts ("Reconnecting… 2/3" / "Menyambung ulang… 2/3") and clears itself. | UI | ARCHITECTURE.md §5.6 |
| UX-033 | Provider failures offer a next step, not a dead end. | `EM-41xx`/`EM-43xx` messages in chat include "Try again" / "Coba lagi" and "Switch model" / "Ganti model" actions; the Creator's message is kept in the composer. | UI | AI_WORKFLOW.md §12 |
| UX-034 | Interrupted agent runs are labelled as interrupted. | After a Local Service restart, an in-flight Plan Card shows "Interrupted · re-run" / "Terputus · jalankan ulang" with a one-click re-run. | UI | AI_WORKFLOW.md §12 |

### 5.5 Comprehension and language

| ID | Requirement | Acceptance criteria | Verification | Traces |
|---|---|---|---|---|
| UX-040 | No Creator-facing string contains a forbidden technical word. | Lint of `en.json`/`id.json` (ACCESSIBILITY_AND_I18N.md) rejects: Remotion, React, Node, npm, Chrome, Chromium, FFmpeg, JSON, SQLite, Electron, stack, null, undefined, exception. Diagnostics screen strings are exempt (namespace `ui.scr.diagnostics.*`). | UI (lint) | P2 |
| UX-041 | Every string has an Indonesian variant from day one. | `id.json` has a value for every key in `en.json`; missing keys fail the build. | UI (lint) | ADR-012 |
| UX-042 | Agents reply in the project language. | Project language (id/en, Project Settings) is sent to both agents; a Creator writing in Indonesian receives Indonesian replies and Indonesian preset labels (DESIGN_CATALOGUE.md rule 4). | UI | — |
| UX-043 | Tooltips exist for every icon-only control and every ⓘ. | All `IconButton` instances and `agent.output.*.help` have a tooltip; tooltips ≤ 2 sentences; shown after 400 ms hover or on focus. | IR, UI | — |

### 5.6 Layout, input and comfort

| ID | Requirement | Acceptance criteria | Verification | Traces |
|---|---|---|---|---|
| UX-050 | The Editor is complete at 1280×720 and degrades gracefully to 1024 px wide. | At 1280×720 all regions in ELEMENT_IDS.md are visible; between 1024 and 1279 px the Library Panel collapses to an icon rail (EDITOR_INTERACTION_MODEL.md §6). Below 1024 px a notice recommends a larger window; nothing overlaps. | UI | brief §7.4 |
| UX-051 | The whole P0 workflow is operable by keyboard. | F1–F8 in USER_FLOWS.md can be completed with keyboard alone, using the shortcuts in EDITOR_INTERACTION_MODEL.md §4; focus is visible at every step. | UI | ACCESSIBILITY_AND_I18N.md |
| UX-052 | Playback and scrubbing feel immediate. | Space toggles playback within 50 ms; a scrub seek updates the frame within 100 ms in Draft quality (PERFORMANCE.md §5). | PT | PRD-009 |
| UX-053 | Long Indonesian copy never overflows. | Preset labels, Intent Queue items and Plan Card steps truncate with an ellipsis and a tooltip; text in the Player uses `fitText` (ported) and the safe area. | UI | DESIGN_CATALOGUE.md §10 |
| UX-054 | Reduced motion is honoured. | With OS "reduce motion" on, UI transitions ≤ 1 frame, catalogue loops pause until hover, pulses are replaced by a static outline. The Player content itself is unaffected (it is the Creator's video). | UI | ACCESSIBILITY_AND_I18N.md |

## 6. State policy: error, empty, loading

Applies to every region and screen; UI_UX_SPECIFICATION.md §9 gives the components.

| State | Rule | Required content | Forbidden |
|---|---|---|---|
| **Empty** | Every list or canvas that can be empty teaches the next action in ≤ 2 sentences and offers one button. | Icon (Lucide), one headline, one sentence, one primary action, EN/ID. Examples: `lib.assets.empty` "Drop video, image or audio here" / "Letakkan video, gambar, atau audio di sini"; `stage.timeline.empty` "Insert assets, then your picks and the Editor Agent fill this timeline." / "Sisipkan aset, lalu pilihan kamu dan Editor Agent mengisi lini masa ini." | Blank space; a disabled control with no explanation. |
| **Loading** | Show a skeleton for layout-stable regions and a spinner with a verb for operations; after 8 s add "This is taking longer than usual" / "Ini lebih lama dari biasanya" and, where supported, a cancel. | Verb phrase naming the object: "Loading preview…" / "Memuat pratinjau…", "Asking Claude 3.5 Sonnet…" / "Bertanya ke Claude 3.5 Sonnet…", "Preparing proxy for beach.mp4…" / "Menyiapkan proxy untuk beach.mp4…". | Indefinite spinners without a label; blocking the whole window for a panel-local load. |
| **Error** | Every error has an `EM-` code, a plain-language sentence, a recovery action, and a "Details" disclosure that copies the code and context. Errors appear where the action happened (inline), escalating to `sys.toast` only when the origin is not on screen. | Code, cause in one sentence, one or two actions. "Could not import holiday.mov · EM-1xxx. The file uses a codec we cannot read yet. Try converting it to MP4." / "Tidak dapat mengimpor holiday.mov · EM-1xxx. Berkas memakai codec yang belum bisa dibaca. Coba ubah ke MP4." | Technical words (UX-040); stacking more than 3 toasts; auto-dismissing errors that need action. |
| **Degraded** | When a capability is unavailable (Private Mode, T0 tier, Trial Mode, model not installed) the control stays visible, disabled, with the reason adjacent. | Reason text or badge: `lib.catalogue.card.badge.gpu`, `agent.output.resolution.2160p.disabled` "Needs a GPU tier" / "Perlu GPU". | Hiding controls; silently substituting a different result. |

Toast severity and timing are owned by UI_UX_SPECIFICATION.md §10.

## 7. Scope of UX work per Roadmap Stage

| Roadmap Stage | UX deliverable | Exit criterion |
|---|---|---|
| Stage 1 Definition | This document, USER_FLOWS, EDITOR_INTERACTION_MODEL, UI_UX_SPECIFICATION, ACCESSIBILITY_AND_I18N, ONBOARDING_TOUR | Traceability: every `el:` id appears in UI_UX_SPECIFICATION.md |
| Stage 2 PoC | Clickable prototype of F2, F3, F8 (static data); optional, non-gating (ROADMAP.md Stage 2 task 11: does not gate exit) | UT round 1 (§8) |
| Stage 4 Editor MVP | Real Editor without agents | UT round 2 |
| Stage 5 AI Orchestration | Plan Card, Intent Queue, handoff | UT round 3 (UX-003, UX-012) |
| Stage 6 Rendering | Export, preflight, progress, recovery | UT round 4 (UX-001, UX-030, UX-031) |
| Stage 7 Hardening | Full first-run on a clean VM, tour, licence | UT round 5 (full UX-001 measurement) |

## 8. Research plan

| Item | Detail |
|---|---|
| Method | Moderated, remote or in-person, think-aloud, 45 min, Indonesian language with English UI, 5 participants per round (Nielsen's 5-user heuristic; the PRD metric is defined on 5 participants). |
| Recruitment | 3 matching persona 1.1, 2 matching persona 1.2; none with prior Expertmotion exposure; Windows laptop of their own where possible (T0 expected). |
| Rounds | One per Roadmap Stage from Stage 2 (see §7). Round 5 is the release measurement for UX-001. |
| Core tasks | T1 install and reach the empty project (F1) · T2 import three clips, order 2-3-1, Insert (F2) · T3 pick a transition and caption style, Execute (F3) · T4 ask the Brainstorming Agent for "judul pembuka yang energik", hand off, Execute (F4/F5) · T5 export 9:16 (F8) · T6 (round ≥ 4) forced quit and recovery (F9) · T7 toggle Private Mode and explain it (F10). |
| Measures | Time on task, completion without moderator help, errors, SUS score (target ≥ 75 by round 5), state-recognition quiz (UX-012), cost-label comprehension (UX-020), Private Mode comprehension (UX-024). |
| Recording | Screen + audio, local files only; participants consent in writing; no footage leaves the Operator's machine (mirrors the product's own privacy stance). |
| Output | Findings table (severity 1–4, element id, proposed change) appended to `docs/research/round-<n>.md`; changes flow into this document's requirements and the FRD. |
| Analytics | None. Expertmotion sends no telemetry (PRD §4.4); all usability data comes from moderated sessions and opt-in diagnostics bundles. |

## 9. Traceability

| UX- | PRD | AI / ADR |
|---|---|---|
| UX-001, 002, 003 | PRD-018, PRD-006, PRD-012 | AI-004 |
| UX-004, 005, 006 | PRD-013 | ADR-011, AI-011 |
| UX-010 … 016 | PRD-012, PRD-034 | AI-010, AI-018, ADR-002 |
| UX-020 … 026 | PRD-008, PRD-010, PRD-017, PRD-020 | AI-015, AI-017, ADR-010, ADR-014 |
| UX-030 … 034 | PRD-003, PRD-015 | AI_WORKFLOW.md §12 |
| UX-040 … 043 | PRD-021 | ADR-012 |
| UX-050 … 054 | PRD-002, PRD-009 | — |
