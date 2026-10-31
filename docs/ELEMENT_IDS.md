# UI Element IDs and Annotated Wireframe

| Field | Value |
|---|---|
| Status | Baseline (new elements may be added; existing IDs never change meaning) |
| Owner | UI/UX lead |
| Last updated | 2026-10-31 |
| Depends on | GLOSSARY.md, docs/assets/expertmotion-editor-mockup.png |
| Used by | FRD.md, UI_UX_SPECIFICATION.md, EDITOR_INTERACTION_MODEL.md, TEST_PLAN.md, ONBOARDING_TOUR.md, ERROR_CATALOGUE.md |

## Purpose

Every requirement, test step, tour step and interaction spec refers to UI elements by the IDs below, never by position or colour. Implementations use the same ID as the `data-el` attribute on the DOM element so that tests and docs stay aligned.

## Naming scheme

```
<region>.<group>.<element>[.<state-or-variant>]
```

- `region`: `hdr` (Header), `lib` (Library Panel), `stage` (Player + Timeline View), `agent` (Agent Panel), `scr` (full screens and dialogs), `sys` (toasts, global states).
- Lower-case, dot-separated, no spaces. Variants use a trailing segment (`.disabled`, `.active`, `.error`).
- A repeated element (card, row) uses the generic ID; the instance is identified in tests by a data attribute (`data-preset-id`, `data-asset-id`, `data-element-id`).

## Annotated wireframe (desktop ≥ 1280×720)

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ hdr.logo  hdr.menu.file hdr.menu.home hdr.menu.design hdr.menu.tools hdr.menu.help            │
│                         hdr.title  [Untitled ✎]                                               │
│   hdr.action.hardware  hdr.action.save  hdr.action.backup  hdr.action.restore                 │
│   hdr.action.models  hdr.action.license  hdr.action.export  (native window frame buttons)    │
├────────────────────┬──────────────────────────────────────────────┬───────────────────────────┤
│ lib.search.input   │ stage.player.frame                          │ agent.chat (one chat)     │
│ lib.mode.header    │  stage.player.canvas                        │ .header .status .usage    │
│  (Design mode)     │  stage.player.controls                      │ .model ▾ → .model.popover │
│ lib.catalogue      │   .play .pause .time .duration .ratio .res  │ .thread                   │
│  lib.catalogue.tab │   .scrubber .fullscreen .menu               │  .message (💡 / ✂️ tag)    │
│  lib.catalogue.card│  stage.player.state.loading/.error          │  .apply (Kerjakan di      │
│   .thumb .label    │  stage.player.canvas.box .handle .guide     │   video)                  │
│   .badge.model     │ stage.timeline                              │ agent.brainstorm.handoff  │
│   .badge.gpu       │  stage.timeline.ruler  stage.timeline.head  │ agent.editor.plancard     │
│  (Home mode)       │  stage.timeline.track.caption               │  .goal .step .risk .notes │
│ lib.text.*         │  stage.timeline.lane.new / .lane.layer (×n) │  .baseversion.stale .undo │
│  (Tools mode)      │   (top row = front-most layer)              │ agent.editor.execute      │
│ lib.generator.card │  stage.timeline.track.video                 │  .cancel                  │
│                    │  stage.timeline.lane.audio (×n) / .lane.new │ agent.editor.picks        │
│ lib.assets.panel   │  stage.timeline.element                     │  .intentqueue.toggle      │
│  lib.assets.drop   │   .clip .text .image .caption .audio .trans.│  .intentqueue .item …     │
│  lib.assets.card   │   .effect .background .shape .generated     │ .composer .send .attach   │
│   .thumb .meta     │  stage.timeline.inspector                   │ .mode (Diskusi | Edit)    │
│   .badge.sequence  │  stage.timeline.empty                       │                           │
│   .select          │                                             │ agent.output              │
│  lib.assets.insert │                                             │  .ratio.* .auto           │
│  lib.assets.empty  │                                             │  .resolution.*            │
│  lib.assets.error  │                                             │  .profile.*               │
│                    │                                             │  .private  .reset         │
└────────────────────┴──────────────────────────────────────────────┴───────────────────────────┘
 sys.toast  sys.offline  sys.render.progress  sys.update
```

## Header (`hdr.*`)

| Element ID | Mockup element | Behaviour summary |
|---|---|---|
| `hdr.logo` | "Remason Editor" wordmark (replace) | Expertmotion wordmark. Click → About. |
| `hdr.menu.file` | File | Opens the File menu (`hdr.menu.file.*` items below). |
| `hdr.menu.file.new` | New Video | "New Project" (Ctrl+N): creates a Project with the default settings at once and opens it (FR-009; the unsaved prompt `scr.unsaved` comes first when the open Project has unsaved changes). Changed 2026-10-26 (QA #5): it no longer opens the dialog. |
| `hdr.menu.file.newcustom` | (added 2026-10-26) | "New Project with Settings…": the New Project dialog (`scr.project.new`) with name, fps, ratio, resolution, duration policy and output folder. |
| `hdr.menu.file.open` | Open | Open Project dialog (`scr.project.open`). |
| `hdr.menu.file.recent` | (added per brief) | Recent projects submenu. |
| `hdr.menu.file.save` | Save | Save Project. |
| `hdr.menu.file.saveas` | Save as | Save As dialog. |
| `hdr.menu.file.backup` | (added 2026-10-31, FR-315) | "Back up project to zip…": opens the Backup dialog (`scr.backup`), the same as `hdr.action.backup`; disabled without a project. |
| `hdr.menu.file.import` | Import | Opens OS file picker into the Asset Panel. |
| `hdr.menu.file.export` | Export | Opens Export dialog (`scr.export`). |
| `hdr.menu.file.openexports` | (added 2026-10-31, FR-315) | "Open exports folder": reveals the newest Output of the open project in the OS file manager (Shell `openFolder`), else the project's / the app's output folder; an info toast when nothing was exported yet. Disabled (reason "Only in the desktop app") without the Shell bridge. |
| `hdr.menu.file.settings` | Setting: Frame, FPS, Duration | Project Settings dialog (`scr.project.settings`). |
| `hdr.menu.file.recover` | (added per brief) | Recovery dialog listing checkpoints (`scr.project.recover`). A badge on this item shows when a checkpoint newer than the saved state exists. |
| `hdr.menu.home` | Home | Switches Library Panel to Home mode (`lib.text.*`). |
| `hdr.menu.design` | Design | Switches Library Panel to Design mode (`lib.catalogue.*`). |
| `hdr.menu.tools` | Tools | Switches Library Panel to Tools mode (`lib.generator.*`). |
| `hdr.menu.help` | Help | Help menu: `hdr.menu.help.tour`, `.onboarding`, `.diagnostics`, `.license`, `.about`, `.docs`. |
| `hdr.title` | "Untitled" | Editable Project Title; blur or Enter saves. |
| `hdr.title.dirty` | (dot after title) | Unsaved-changes indicator. |
| `hdr.action.hardware` | display icon | Hardware Monitor popover (`scr.hardware`). |
| `hdr.action.save` | save icon | Same as `hdr.menu.file.save`. |
| `hdr.action.backup` | cloud-upload icon (repurposed) | Backup Project to a local zip. |
| `hdr.action.restore` | cloud-sync icon (repurposed) | Restore Project from a zip (`scr.backup.restore`). |
| `hdr.action.undo` / `hdr.action.redo` | (added) | Move the project head between Composition Versions (Ctrl+Z / Ctrl+Shift+Z; Ctrl+Y also redoes). |
| `hdr.action.models` | grid icon | Opens Model Manager (`scr.models`). |
| `hdr.action.license` | avatar | Licence status popover ("Licensed", updates date, short Machine Code; never the licensee's name, Operator 2026-10-26) with "Manage licence" → `scr.license`. The Editor is only reachable while licensed (no Trial Mode). |
| `hdr.action.export` | Export | Opens Export dialog. `hdr.action.export.disabled` until a Composition Version with ≥ 1 Clip exists. |

## Library Panel (`lib.*`)

| Element ID | Mockup element | Behaviour summary |
|---|---|---|
| `lib.search.input` | "People are searching for…" | Catalogue Search with suggested queries (`lib.search.suggestion`). Filters the current mode's cards. |
| `lib.mode.header` | "Preview" heading | Shows the current mode name: Preview (Design), Text (Home), Tools. |
| `lib.catalogue.tab` | (added) | Category tabs in Design mode: Transitions, Captions, Backgrounds, Motion, Shapes, Easing, Effects, Audio. |
| `lib.catalogue.card` | thumbnail cards (Pale Clarity, Strip Wipe, …) | One Design Preset. Hover → live preview on the Player; click → Design Pick. |
| `lib.catalogue.card.thumb` | thumbnail | Prerendered loop. |
| `lib.catalogue.card.label` | card label | Preset label (EN; ID variant via i18n). |
| `lib.catalogue.card.badge.model` | lock/download badge | "Needs a model that is not installed". Click → Model Manager. |
| `lib.catalogue.card.badge.gpu` | (added) | "Needs a GPU" (WebGL/WebGPU effects) when Hardware Tier is T0. |
| `lib.catalogue.card.selected` | (state) | Pick is in the Intent Queue. |
| `lib.catalogue.empty` | (state) | Search returned nothing; shows suggested queries. |
| `lib.text.font` | Home ▸ Font | Font family picker (bundled fonts). |
| `lib.text.size` | Home ▸ Font Size | Size presets + numeric input. |
| `lib.text.weight` | Home ▸ Text Style | Weight/style toggles. |
| `lib.text.colour` | Home ▸ Colour | Theme colour swatches + custom. |
| `lib.text.align` | (added per brief) | Left / centre / right. |
| `lib.text.effect` | Home ▸ Text Effect | Text animation presets (rough-notation, kinetic). |
| `lib.text.variant` | Home ▸ Text Style | Title / Subtitle / Lower third / Callout variants (`preset:text.*`). |
| `lib.text.add` | Home ▸ Add Text | FR-027: adds a "Your text" ("Teks kamu") Text Layer at the playhead (3000 ms, clamped to the Sequence end) with the current picks and the chosen variant, selects it and focuses `lib.text.add.input` (content of the selected Text Layer; `lib.text.add.confirm` applies `op:text.setContent`). |
| `lib.text.opacity` | Home ▸ Opacity | Opacity for the selected element. |
| `lib.text.ratio` | Home ▸ Ratio Setting | Shortcut to `agent.output.ratio.*`. |
| `lib.text.videosize` | Home ▸ Video Size | Shortcut to `agent.output.resolution.*`. |
| `lib.text.insert.image` | Home ▸ Insert Image | Import image → Overlay layer. |
| `lib.text.insert.video` | Home ▸ Insert Video | Import video → Clip. |
| `lib.generator.card` | Tools items | One Generator Card: `.voice`, `.music`, `.thumbnail`, `.captions`, `.hashtags`. Each opens its form (`scr.generate.*`). |
| `lib.assets.panel` | "Asset Upload" | Asset Panel container. |
| `lib.assets.drop` | (whole panel) | Drag-and-drop target; also click to pick files. |
| `lib.assets.card` | asset thumbnails | One Asset. Shows thumbnail, name, duration, badge. |
| `lib.assets.card.meta` | (tooltip) | Resolution, fps, duration, audio, size. |
| `lib.assets.card.badge.sequence` | (added) | Sequence Badge number; click cycles / drag to reorder. |
| `lib.assets.card.select` | (checkbox) | Select for Insert. |
| `lib.assets.card.action.usecaptions` | (menu, subtitle assets) | Use this SRT/VTT asset as the project captions (`op:caption.importSrt`). |
| `lib.assets.card.action.remove` | (menu) | Remove asset (confirmation if used by a Clip). |
| `lib.assets.card.state.ingesting` | (state) | Probe/transcode/proxy progress. |
| `lib.assets.card.state.unsupported` | (state) | Unsupported file with reason (`EM-1xxx`). |
| `lib.assets.insert` | Insert | Inserts selected Assets in Sequence Badge order. Disabled when nothing selected. |
| `lib.assets.empty` | (state) | Empty-state copy with import hint. |
| `lib.assets.error` | (state) | Import-level error banner (FR-053: EM-6401, EM-6005, EM-1401, EM-1010) with a recovery action; per-file errors stay on the card. |

## Stage (`stage.*`)

| Element ID | Mockup element | Behaviour summary |
|---|---|---|
| `stage.player.frame` | "Player" panel | Player container sized to the current Aspect Ratio. |
| `stage.player.canvas` | video area | Remotion Player surface. |
| `stage.player.controls` | (controls) | Controls bar; overlays the Player as a bar at the bottom while the frame is fullscreen (FR-059, `data-fullscreen` on `stage.player.frame`). |
| `stage.player.controls.play` / `.pause` | (controls) | Toggle playback (Space). |
| `stage.player.controls.scrubber` | (controls) | Playhead scrubber; frame-step with arrows. |
| `stage.player.controls.time` / `.duration` | (controls) | Current time / total duration (mm:ss.d, tenths of a second). |
| `stage.player.controls.ratio` / `.res` | (added) | Aspect Ratio and Resolution indicators. |
| `stage.player.controls.fullscreen` | (added) | Fullscreen toggle. |
| `stage.player.menu` | hamburger (≡) | Player menu: safe-area overlay, draft/full quality, loop, mute. |
| `stage.player.state.loading` / `.error` | (states) | Loading spinner / error card with recovery action. |
| `stage.player.canvas.layer` | (added 2026-10-26, ADR-028) | Transparent layer over the Player surface that holds the canvas handles; it only takes pointer events on the box, so clicks elsewhere still play / pause. |
| `stage.player.canvas.box` | (added 2026-10-26, ADR-028) | Selection box of the selected clip, image or shape while it plays at the playhead (`data-kind`, `data-element-id`, `data-x` / `data-y` / `data-scale` / `data-rotation` = the shown transform, `data-gesture` while dragging): drag inside = move, double-click = reset (IX-27, FR-180). |
| `stage.player.canvas.handle` | (added 2026-10-26, ADR-028) | Corner handles `data-handle="nw|ne|se|sw"` (scale; Shift keeps the centre) and the rotation handle `data-handle="rotate"` above the top edge (Shift snaps to 0 / 90 / 180 / 270). |
| `stage.player.canvas.guide` | (added 2026-10-26, ADR-028) | Snap guide line while moving (`data-axis="x"` vertical / `"y"` horizontal, `data-at` in frame units): frame centre lines and frame edges; hidden while Alt is held. |
| `stage.timeline` | rows under player | Timeline View container. |
| `stage.timeline.ruler` / `.head` | (added) | Time ruler and playhead line. FR-253 / FR-254 (2026-10-28): the ruler is sticky at the top of the Timeline scroll area (`data-sticky="top"`); the playhead line is a `role="slider"` over the whole Timeline height (12 px grab zone, `aria-valuenow` = ms, `data-scrubbing` while dragged); press + drag on the ruler, the line or empty track space scrubs. |
| `stage.timeline.scroll` | (added 2026-10-28, FR-254) | The single scroll container of the Timeline (both axes): lane names stick to the left, the ruler to the top. |
| `stage.timeline.lanes.labels` | (added 2026-10-30, Entry 36) | The sticky lane-name column (120 px, 136 px from 1280, 176 px from 1536 wide); each name carries its full text as tooltip. |
| `stage.timeline.head.handle` | (added 2026-10-28, FR-253) | Playhead marker inside the sticky ruler (stays visible while the lanes scroll). |
| `stage.timeline.track.video` / `.caption` | rows in mockup | The video Track row and the caption row (captions render above every layer, so their row is the top row). |
| `stage.timeline.lane.layer` | (added 2026-10-26, ADR-027) | One row per visual layer (texts, images, shapes), `data-layer="<n>"`, ordered front-most on top (CapCut order); between the caption row and the video Track. |
| `stage.timeline.lane.audio` | (added 2026-10-26, ADR-027) | One row per audio lane, `data-lane="<n>"`, under the video Track (lane 0 nearest). |
| `stage.timeline.lane.new` | (added 2026-10-26, ADR-027) | The empty lane above the top layer (`data-layer`) and below the last audio lane (`data-lane`): dropping a bar there opens a new lane; shows "Drop here for a new layer in front" while dragging. |
| `stage.timeline.element.handle` | (added 2026-10-26, ADR-027) | Left / right trim handle inside a draggable bar (`data-edge="start|end"`): video Clips, texts, images, shapes, audio layers. |
| `stage.timeline.ghost` | (added 2026-10-26, ADR-027) | Live drag ghost on the target row (`data-row`, `data-from-ms`, `data-to-ms`); the dragged bar is dimmed meanwhile. |
| `stage.timeline.snap` | (added 2026-10-26, ADR-027) | Vertical snap guide at the playhead or edge the drag snapped to (`data-ms`); hidden while Alt is held. |
| `stage.timeline.element` | (bars) | One Timeline Element; variants `.clip`, `.text`, `.image`, `.caption`, `.audio`, `.transition`, `.effect`, `.background`, `.shape`, `.generated`. Click → selection + inspector. Texts, images, shapes and audio carry `data-editable` and `data-lane` (drag, trim, ←/→ nudge, Alt+↑/↓ lane; IX-26). |
| `stage.timeline.element.selected` | (state) | Selected element; Design Picks target it. |
| `stage.timeline.inspector` | (added) | Read-only property sheet for the selected element, with "Ask Editor Agent to change" shortcut. |
| `stage.timeline.quickparams` / `stage.timeline.quickparams.field` / `stage.timeline.quickparams.apply` | (added, P1) | FR-098 quick params under the inspector: transition duration, motion duration/delay, effect values; validated against the preset params schema (EM-2102 inline) before a Compile pick. |
| `stage.timeline.split` | (added 2026-10-26, ADR-028) | Scissors button in the Timeline header (shortcut S): splits the selected clips / texts / images / shapes / audio layers that play at the playhead, or the clip under the playhead when nothing is selected, as one undoable pick (IX-28, FR-179). |
| `stage.timeline.inspector.transform` | (added 2026-10-26, ADR-028) | "Position & zoom" section of the inspector for a selected clip, image or shape (FR-180). |
| `stage.timeline.inspector.transform.x` / `.y` / `.scale` / `.rotation` | (added 2026-10-26, ADR-028) | Numeric fields: X / Y in % of the frame (0 = centred), Scale in % (100 = the fit result / stored size), Rotation in degrees; Enter or leaving the field applies, Esc reverts. |
| `stage.timeline.inspector.transform.fit` / `.fill` / `.reset` | (added 2026-10-26, ADR-028) | Fit (whole picture inside the frame, centred), Fill (no empty frame, centred), Reset (the original position, zoom and rotation). |
| `stage.timeline.inspector.transform.align` | (added 2026-10-26, ADR-028) | Quick-align buttons `data-align="center|top|bottom|left|right"` (centre both axes, or the bounding box against one frame edge). |
| `stage.timeline.empty` | "Drag material here…" (replace) | Copy: "Insert assets, then your picks and the Editor Agent fill this timeline." |

## Agent Panel (`agent.*`)

| Element ID | Mockup element | Behaviour summary |
|---|---|---|
| `agent.chat` | the assistant chat | One thread per Project with two modes (Operator decision 2026-10-26, FR-073): `data-mode` = `brainstorm` ("Diskusi", Brainstorming Agent) / `editor` ("Edit", Editor Agent); `data-maximized` while it fills the Agent Panel (FR-099). Replaces the two chats and the Model Bar. |
| `agent.chat.header` | chat header bar | Status dot, model button, compact usage, help ⓘ, maximize; `data-mode`. |
| `agent.chat.status` | (dot) | Connection of the current mode's model: `data-status` = `valid` / `error` / `unvalidated` / `none` / `private` (shield in Private Mode); the last EM-4xxx run failure wins (FR-071). |
| `agent.chat.model` | "Model: Claude Sonnet 4.5 ▾" | The current mode's Model Assignment (separate per agent, `data-agent`); opens `agent.chat.model.popover`; without any Provider Connection it reads "Connect an AI provider" and opens `scr.providers`. ⚠ when the model carries a quality warning. |
| `agent.chat.model.popover` | model list popover | FR-073 / FR-115 (2026-10-26): a clean list, not a table: `.search` (name or id; ↑/↓ + Enter), `.refresh`, `.connection` (only with more than one validated connection), `.list` (listbox), `.section` (`data-section` = `recommended` "Disarankan" / `free` "Gratis" / `paid` "Berbayar"), `.row` (model name, short provider, `data-model-id`, `data-quality` = ok / weak / unsupported, `aria-selected`), `.row.price` ("$0.30/1M" or "Free"), `.row.warn` (⚠, `data-reasons`), `.more` (per section), `.warning` + `.warning.recommended` (a warned pick keeps the popover open), `.nomatch`, `.empty`, `.fetch`, `.manage` ("Manage providers…" → `scr.providers`). |
| `agent.chat.usage` | "1,2K / 200K" | Compact context usage of the current mode's last request; tooltip: tokens, last request cost, summarisation note; `data-tone` muted / warn (≥ 60 %) / danger (≥ 80 %) (FR-074). |
| `agent.chat.thread` | messages | One thread: both agents' messages in time order, the Plan Cards and "Applied directly" lines (FR-085, FR-086). |
| `agent.chat.message` / `agent.chat.message.agent` | a message bubble and its agent tag | `data-agent` = `brainstorm` / `editor`, `data-role` = `user` / `assistant` / `system`; `.agent` is the tag ("💡 Diskusi" / "✂️ Edit") on every message, including the Creator's own (the mode it was sent in). |
| `agent.chat.streaming` | streaming reply | The reply while it streams (FR-075), with its agent tag and Cancel; `data-agent`. |
| `agent.chat.apply` | "Kerjakan di video" / "Apply to video" | On a Diskusi answer: sends the answer to Edit mode as the request; on a proposed-changes card (`agent.brainstorm.handoff`) it hands the ticked proposals to the Intent Queue (R-082). Either way the chat switches to Edit. |
| `agent.chat.composer` / `agent.chat.send` / `agent.chat.attach` | input, send, attach icon | One composer for both modes (`data-mode`); Enter sends; Tab in an empty composer switches the mode; attach = reference an Asset or image. |
| `agent.chat.mode` / `agent.chat.mode.brainstorm` / `agent.chat.mode.editor` | "💡 Diskusi \| ✂️ Edit" | Mode switch in the composer (`role=radiogroup`, `aria-checked`); Ctrl+1 / Ctrl+2 inside the chat; remembered per Project (prefs). |
| `agent.chat.tabs` / `agent.chat.tab.brainstorm` / `agent.chat.tab.editor` | "Diskusi \| Editor" | ADR-033 / FR-219 (QA 2026-10-28 #2): the two chats as tabs (`role=tablist`, `aria-selected`; Diskusi amber 💡, Editor blue ✂), each with its own thread and composer; `data-busy` (spinner) while that agent works, `data-unread` (dot) for an answer in the other tab; Ctrl+1 / Ctrl+2, Tab in an empty composer. Replaces `agent.chat.mode` (kept for reference; no longer rendered). |
| `agent.chat.research` | "🌐 Web aktif" | FR-216: switch for the setting "Izinkan riset internet" (`role=switch`, `aria-checked`); disabled with "Mode Privat memblokir riset internet" in Private Mode. |
| `agent.chat.sendtoeditor` | "Kirim ke Editor" | FR-219: on every Diskusi answer and on its proposals card: the whole draft becomes one Editor request (R-083b); the Editor tab opens with its progress. |
| `agent.brainstorm.handoff.card` / `agent.brainstorm.handoff.open` | "Editor sedang membuat …" + "Lihat di Editor" | FR-219 / FR-223: the hand-off card on a Diskusi draft; `data-state` = `planning` (with `agent.chat.phases`) / `ready` / `applied` / `failed`. |
| `agent.editor.message.origin` | "💡 Dari Diskusi" | FR-219: tag on an Editor request that came from a Diskusi draft ("(dikirim otomatis)" when "buatkan videonya" started it). |
| `agent.editor.askdiscussion` | "Tanya Diskusi" | FR-219: on an Editor question: sends it to the Diskusi tab ("Editor butuh info ini …"). |
| `agent.chat.phases` / `agent.chat.phase` / `agent.chat.phases.meta` | "Membaca draf → Menyusun adegan → Memeriksa → Siap" | FR-223: phase stepper with a progress bar (`role=progressbar`, `data-phase-index`), seconds and "percobaan n/m"; in the Editor's working bubble and on the hand-off card. |
| `agent.chat.message.sources` / `agent.chat.message.source` | "Sumber (2)" + numbered links | FR-216: the web sources of an answer (cited first; publisher, host, page age); a link opens in the system browser (Shell `openSource`: public https only, refused in Private Mode with a toast holding the copyable address; R1). |
| `agent.chat.message.images` / `agent.chat.message.image` / `agent.chat.message.image.import` | "Gambar berlisensi terbuka (n)" + Impor | FR-217: picture candidates with licence chip, author, source page; `data-imported` after Import. |
| `agent.chat.message.notice` | research notice | FR-216: why research did not run for this answer (`data-code` EM-4403 / EM-4404). |
| `agent.chat.attach.audio` / `agent.chat.attach.document` / `agent.chat.attach.input` | "Musik atau suara…" / "Dokumen atau naskah…" | FR-221: attach menu entries; the hidden file input; chips `agent.chat.attach.chip` carry `data-kind` = `image` / `audio` / `document` (document chips show the character count, ✂ when truncated). |
| `agent.chat.message.attachment.truncated` | "Dokumen panjang: hanya bagian awal yang dikirim" | FR-221. |
| `agent.chat.target.caption.suggest` | "＋ Tunjuk Caption 0:17 “energi besi…”" | FR-220: offers the caption page under the playhead as a chip (kind `caption`). |
| `agent.editor.picks` | "Your picks" strip | The Intent Queue as a compact strip above the composer, shown in Edit mode only; `data-open` while expanded. |
| `agent.editor.intentqueue.toggle` / `agent.editor.intentqueue.count` | "Your picks (3) ▴" | Expands / collapses the strip (`aria-expanded`, persisted in prefs `picksOpen`); the count badge is highlighted while picks wait for Plan. |
| `agent.editor.plancard.undo` | Undo on an executed plan | The one-line summary after Execute (and an older plan in the thread) offers Undo while its version is the head. |
| `agent.brainstorm.handoff` | (added) | Card shown when the Brainstorming Agent proposes Edit Intents: "Apply to video" (Kerjakan di video) / "Dismiss". |
| `agent.brainstorm.handoff.item` / `agent.brainstorm.handoff.item.reason` | (added) | One proposed change in plain words (category, value → target); an invalid one is greyed (`data-invalid`) with its reason and EM code and cannot be sent (FR-076). |
| `agent.editor.intentqueue` | (added) | Intent Queue list; `.item`, `.item.superseded`, `.item.restore`, `.item.remove`, `.clear`. |
| `agent.editor.plancard` | (added) | Plan Card; `.goal`, `.step`, `.step.tool`, `.step.diff`, `.risk`, `.notes`, `.baseversion`, `.baseversion.stale`. |
| `agent.editor.plan` | (added) | "Plan" button: asks the Editor Agent to plan the queued intents (also triggered by composer send and by hand-off when auto-plan is on). |
| `agent.editor.plancard.replan` | (added) | Re-plan a stale or invalid plan against the current version. |
| `agent.editor.execute` | Execute | Executes the current Edit Plan. Disabled when no plan, stale, or validation failed. |
| `agent.editor.cancel` | (added) | Cancels a running plan or agent request. |
| `agent.output` | settings block | Output Settings container. |
| `agent.output.profile.standard` / `.accelerated` / `.turbo` | Speed buttons | Performance Profile selector (policies in PERFORMANCE.md). |
| `agent.output.profile.help` | ⓘ | Tooltip explaining profiles honestly. |
| `agent.output.ratio.help` / `agent.output.private.help` | ⓘ | Tooltips for Video Dimensions (pixel table) and Private Mode (what is blocked). |
| `agent.output.ratio.16x9` / `.9x16` / `.1x1` / `.4x5` / `.5x4` / `.4x3` / `.3x4` / `.custom` | Video Dimensions | Aspect Ratio selector; shows orientation icon and pixel label for the current Resolution. |
| `agent.output.ratio.auto` | Auto | Sticky toggle: ratio follows the first inserted Clip; a manual ratio pick turns it off. |
| `agent.output.resolution.720p` / `.1080p` / `.2k` / `.2160p` | 480p/HD/2K/4K buttons | Resolution selector; `.disabled` with reason below the Hardware Tier threshold. |
| `agent.output.private` | Private Mode toggle | Blocks all outbound calls. |
| `agent.output.reset` | Reset to Defaults | Resets Output Settings (confirmation). |

## Screens and dialogs (`scr.*`)

| Element ID | Purpose |
|---|---|
| `scr.onboarding` | First-run wizard (after activation): `.welcome`, `.provider`, `.models`, `.hardware`, `.tour`, `.done`. |
| `scr.license` | Licence screen. Unlicensed: the whole window (`data-gate`), nothing else of the product; licensed: "Manage licence" modal. Parts: `.status`, `.machinecode`, `.machinecode.copy`, `.input`, `.activate`, `.buy`, `.help`, `.lang`, `.steps`, `.remove`, `.rebind`, `.error`. |
| `scr.providers` | Provider Connections: `.list`, `.add`, `.provider.select`, `.key.input`, `.validate`, `.models.list`, `.budget.project`, `.budget.month`, `.test`, `.save`. FR-109…FR-119 additions: `.row` (one connection), `.row.usage`, `.row.isdefault`, `.row.edit`, `.row.test`, `.row.default` (Set default), `.row.remove`, `.row.remove.confirm`, `.row.remove.yes`, `.edit`, `.edit.save`, `.add.open`, `.cancel`, `.label.input`, `.provider.disclosure` (what is sent + terms link), `.key.toggle` (show/hide), `.key.shape`, `.locked`, `.models.search`, `.models.refresh`, `.assign.note` (EM-4005 / image-input note), `.budget.warn` (EM-4202), `.test.result`. 2026-10-25 model table (FR-114, FR-115; replaces the tier pickers): `.assign.agent` (two-option toggle "Brainstorming Agent \| Editor Agent", each option shows that agent's chosen model label), `.assign.agent.brainstorm` / `.assign.agent.editor` (one option; `data-model-id` = the chosen model id), `.assign.both` ("Also use for the … Agent": copies the shown agent's pick to the other agent); the ModelPicker parts under `.models`: `.models.search`, `.models.refresh`, `.models.filter.json` / `.models.filter.images` (chips, `aria-pressed`), `.models.category` (segmented All / Free / Paid radiogroup, added 2026-10-25) with `.models.category.all` / `.models.category.free` / `.models.category.paid` (`aria-checked`), `.models.count`, `.models.sort.name` / `.models.sort.context` / `.models.sort.price` (column headers, `aria-sort`), `.models.list` (listbox), `.models.row` (one model, `data-model-id`, `data-quality` = ok / weak / unsupported, `aria-selected`; never disabled), `.models.row.recommended` (badge on 1–3 rows), `.models.row.warn` (⚠ quality badge with the reason tooltip, `data-reasons`), `.models.row.price.unknown` ("price n/a"), `.models.warning` (inline warning under the table when the selected model carries a quality warning), `.models.warning.recommended` ("Use recommended instead"), `.models.more` ("Show N more"), `.models.nomatch`, `.models.empty` (no Capability Table yet), `.models.fetch` ("Fetch models"). |
| `scr.models` | Model Manager: `.list`, `.row`, `.row.install`, `.row.remove`, `.row.progress`, `.tier`. FR-120…FR-126 additions: `.filter`, `.filter.purpose`, `.filter.installed`, `.filter.fits`, `.row.expand`, `.row.card`, `.row.notice` (engine licence notice), `.row.recommended`, `.row.tier`, `.row.status`, `.row.pause`, `.row.cancel`, `.row.install.confirm` (EM-7005), `.row.install.anyway`, `.row.remove.confirm`, `.row.remove.yes`, `.footer`, `.registry` (EM-7111). 2026-10-25: `.row.name` (product name in the row header), `.row.licence` (licence link in the card). 2026-10-27 (Entry 28): `.row.licence` and `.row.notice.link` (component licence link) open in the system browser through the Shell (`ExternalLink`; a raw `target=_blank` link was refused by the Shell's window-open handler and did nothing). 2026-10-26: the card shows languages, licence and component licences only (no engine names, paths, checksums or notes); `.row.tier` only when the model needs more than T0. |
| `scr.hardware` | Hardware Monitor popover: `.cpu`, `.ram`, `.procmem`, `.disk`, `.gpu`, `.workload`. FR-127…FR-130 additions: `.output` (output drive), `.vram`, `.tier`, `.recheck`, `.workload.item`, `.workload.cancel`. |
| `scr.project.new` / `.open` / `.settings` / `.recover` | Project dialogs; open has `.list`, `.delete` (confirmation); settings has `.name`, `.fps`, `.ratio`, `.resolution`, `.duration.policy`, `.output.folder`; recover has `.list`, `.restore`. |
| `scr.start` | Start screen (FR-202): shown on every launch and whenever no project is open; `.new` "Proyek baru", `.open` "Buka…", `.list` recent projects, `.item` (one row, `data-project`), `.item.open` (open), `.item.safe` ("Mode aman"), `.item.failed` ("Gagal dibuka" on a project the crash-loop guard blocked), `.notice` (`data-kind` `crash-loop` / `abnormal`) with `.notice.safe` "Buka dalam mode aman" and `.notice.new` "Proyek baru". |
| `scr.ratio.custom` | Custom ratio dialog: `.width`, `.height`, `.preview`, `.apply` (clamped 1:3 … 3:1). |
| `scr.backup` | Backup/Restore dialogs: `.backup.passphrase`, `.backup.plain` (warning), `.backup.start`, `.restore.file`, `.restore.passphrase`, `.restore.start`, `.progress`. |
| `scr.history` | Version history list (`.list`, `.item`, `.item.restore`) reached from Edit ▸ History or the Plan Card. |
| `scr.export` | Export dialog: `.profile.summary`, `.codec`, `.quality`, `.filename`, `.folder`, `.preflight` (disk/RAM/dimension checks), `.start`, `.progress`, `.eta`, `.cancel`, `.open.folder`, `.done`. |
| `scr.generate.voice` / `.music` / `.thumbnail` / `.captions` / `.hashtags` | Generator forms with `.input`, `.language`, `.model`, `.run`, `.progress`, `.result`, `.insert`. |
| `scr.diagnostics` | Logs, versions, hardware, "copy diagnostics bundle". |
| `scr.about` | Version, licence notices, third-party notices. |

## Global (`sys.*`)

| Element ID | Purpose |
|---|---|
| `sys.toast` | Transient notifications with optional action (`.action`). |
| `sys.toasts` | The toast stack: one top layer above modals, the onboarding screen and the tour; kept left of the Agent column so it never covers the Plan Card or the composer. Error toasts show their body line `sys.toast.body` and the code's next action (QA UX round 1). |
| `sys.offline` | Local Service unreachable banner with retry. |
| `sys.render.progress` | Persistent render progress chip in the header area. |
| `sys.update` | Update available / downloaded / restart prompt. |
| `sys.privatemode.banner` | Banner while Private Mode is on. |
| `sys.fatal` | Fatal Service state shown in the Editor (EM-8002 after three failed restarts, EM-6001 storage locked; FR-171, FR-176). The Editor stays mounted behind it. |
| `sys.fatal.diagnostics` | Open Diagnostics: opens the logs folder through the Shell (the Diagnostics screen needs the Service). |
| `sys.fatal.quit` | Quit Expertmotion. |
| `sys.fatal.retry` | Try again (EM-8002 only): asks the Shell to start the Local Service once more with a fresh restart budget (FR-184). |
| `sys.splash` | Startup screen (FR-184): app mark, current step, thin progress bar; `data-phase` = `starting` / `integrity` / `keyring` / `service` / `project` / `failed`. Rendered before anything is awaited; covers the Editor until the first project is open. |
| `sys.splash.placeholder` | Static first paint in `index.html` (dark background, app mark, "Memulai…"; inline styles only) until the script replaces it with `sys.splash`. |
| `sys.splash.step` | Current step: "Memeriksa file aplikasi…" (integrity), "Membuka penyimpanan…" (keyring), "Menyalakan layanan…" (service), "Memuat proyek…" (project). |
| `sys.splash.progress` | Thin determinate bar over all steps (integrity fills by bytes hashed; other steps ease toward their share). |
| `sys.splash.elapsed` | Elapsed seconds since the Shell started, shown after 5 s. |
| `sys.splash.slow` | "Still working" line after 20 s. |
| `sys.splash.error` | Failure before the Editor mounted: title, EM- code (`sys.splash.code`), one sentence. |
| `sys.splash.code` | The EM- code of the failure, selectable. |
| `sys.splash.retry` | "Coba lagi" / "Try again": Shell retry after EM-8002, otherwise a window reload. |
| `sys.splash.logs` | "Buka folder log" / "Open log folder": opens the Shell's logs folder. |
| `sys.crash` | Top-level error boundary (FR-185): "Ada yang tidak beres" / "Something went wrong" with EM-8009 instead of a black window. |
| `sys.crash.code` | EM-8009, selectable. |
| `sys.crash.message` | The error name and message (≤ 300 characters), selectable. |
| `sys.crash.reload` | "Muat ulang" / "Reload": reloads the window; the Local Service keeps running. |
| `sys.crash.pick` | "Buka proyek lain" / "Open another project" (FR-202): reloads to the Start screen (no reopen). |
| `sys.crash.new` | "Proyek baru" / "New project" (FR-202): reloads and creates a new project. |
| `sys.crash.logs` | "Buka folder log" / "Open log folder" (FR-202): reveals the log folder the Shell reported. |
| `sys.safe.banner` | Safe open banner (FR-202): "Mode aman: chat dan pratinjau disembunyikan." |
| `sys.safe.exit` | "Keluar dari mode aman" / "Leave safe mode". |
| `sys.safe.chat` | Placeholder for the assistant chat in safe mode; `sys.safe.chat.show` "Tampilkan chat" renders it. |
| `sys.safe.preview` | Placeholder for the Player in safe mode ("Pratinjau dijeda"); `sys.safe.preview.show` "Tampilkan pratinjau" renders it. |
| `sys.section.error` | Panel error boundary (FR-200, Entry 28): inline card "Bagian ini gagal dimuat" / "This part failed to load" with EM-8009 in place of ONE failing panel; `data-section` names it (`header`, `library`, `player`, `timeline`, `chat`, `chat.thread`, `chat.model-popover`, `providers.models`, `licence`, `tour`, `toasts`, `screen.<kind>` for every dialog / screen). The rest of the Editor stays usable. |
| `sys.section.message` | The error name and message (≤ 200 characters, key-like strings redacted), selectable. |
| `sys.section.reload` | "Muat ulang bagian" / "Reload part": remounts only that panel (never automatically). |
| `sys.section.close` | "Tutup" / "Close": shown for a dialog / screen boundary; closes the failed dialog. |
| `sys.live` | Visually hidden ARIA live region for status announcements. |

## Additions found while building the Editor (Stage 3, 2026-10-24)

| ID | Element | Behaviour |
|---|---|---|
| `hdr.menu.help.shortcuts` | Help ▸ Keyboard shortcuts | Opens `scr.shortcuts`. |
| `hdr.menu.file.recent.item` | one Recent project row | Opens that Project. |
| `lib.catalogue` | Catalogue grid container | Holds the category tabs and Catalogue Cards. |
| `lib.text.size.preset` | one font-size preset chip | Text Panel size pick (deterministic, Compile path). |
| `lib.text.size.overflow` | Fit warning under Font Size | FR-021: shown for the selected Text Layer when the renderer's fit (engine `textLayerFit`) shrinks it below the chosen size (`data-kind="shrunk"`) or it would not fit the safe area even at 34 u (`data-kind="overflow"`). |
| `lib.text.weight.italic` | "Italic" style option | FR-022: italic, regular weight (`italic` field of `op:text.setStyle` / `op:theme.setTextDefaults`; bundled italic fonts). |
| `lib.text.weight.regular` | "Regular" style option | FR-022: weight 400, not italic. |
| `lib.text.weight.bold` | "Bold" style option | FR-022: weight 800, not italic. |
| `lib.text.weight.bolditalic` | "Bold Italic" style option | FR-022: weight 800, italic. |
| `lib.text.font.sample` | one font sample card in `lib.text.font` | FR-020: rendered sample in that bundled font; click = font pick (`data-font` = family). |
| `lib.text.colour.hex` | custom hex input | FR-023: `#RRGGBB`, applied on Enter/blur. |
| `lib.text.colour.contrast` | "Low contrast" hint | FR-023: shown when the text colour has < 4.5:1 contrast with the background; warn only, the pick still applies. |
| `lib.catalogue.empty.clear` | "Clear search" in the empty state | FR-040: clears the Catalogue Search. |
| `lib.assets.card.state.missing` | missing-file state on an Asset card | FR-048: the stored original is not on disk (EM-1301); Locate and Remove actions. |
| `lib.assets.card.action.locate` | "Locate…" on a missing Asset | FR-048: OS picker → R-036 re-links by hash (EM-1302 when the file differs). |
| `lib.assets.error.action` | recovery button in `lib.assets.error` | FR-053: "Try again" (EM-6401, EM-6005) or "OK" (EM-1401, EM-1010). |
| `stage.timeline.element.missing` | "missing" marker on a Timeline Element | FR-048: the element's Asset file is missing; the Player shows a placeholder frame. |
| `stage.player.menu.safearea` | Player menu item | Toggles the safe-area overlay. |
| `stage.player.menu.draft` | Player menu item | Draft / full preview quality. |
| `stage.player.menu.loop` | Player menu item | Loop playback. |
| `stage.player.menu.mute` | Player menu item | Mute preview audio. |
| `stage.player.menu.seekonselect` | Player menu item | Seek the Player when a Timeline Element is selected. |
| `scr.confirm` | Confirmation dialog | Shared confirm for destructive actions (Clear picks, delete). |
| `scr.shortcuts` | Shortcuts dialog | Lists keyboard shortcuts. |
| `scr.export.codec.mp4` | Export format option | MP4 (H.264). |
| `scr.export.codec.gif` | Export format option | Animated GIF. |
| `scr.export.codec.png` | Export format option | PNG still. |
| `scr.export.codec.webm` | Export format option | WebM with alpha (VP9 + PNG frames, FR-138); disabled with a reason unless the background is `preset:background.none` (or absent). |
| `scr.export.codec.webm.reason` | Reason line under the format options | "Transparent WebM needs the background set to None…" shown while the option is disabled (FR-138). |
| `scr.project.new.name` | New Project name field | Project name input. |
| `scr.project.settings.language` | Project Settings language toggle | Project language id/en (stored in project settings). |
| `hdr.title.sample` | "Sample ·" / "Contoh ·" marker in the Project Title | Shown only on the R-025 sample project (`isSample: true`); the marker uses the project's language. |
| `lib.divider` | Library Panel / Stage divider | `role="separator"`; drag or ←/→ (16 px) resizes the Library Panel 240–420 px, dragging below 200 px collapses it to the rail; double-click or Enter resets (EDITOR_INTERACTION_MODEL.md §9). |
| `agent.divider` | Stage / Agent Panel divider | As `lib.divider` for the Agent Panel, 320–900 px (default 360 / 420 / 480 px for the narrow / standard / wide window bucket); the maximum is further capped so the Stage never shrinks below 640 px (FR-099, operator feedback 2026-10-25). |
| `agent.chat.maximize` | maximize / restore toggle in the chat header | FR-099: `aria-pressed`; maximizing gives the chat the whole Agent Panel (Output Settings hidden); pressed again restores; persisted (`layout.chatMaximized`). |
| `agent.output.toggle` | Output Settings header button | FR-099: `aria-expanded`; expands/collapses Output Settings (collapsed by default; persisted as `layout.outputCollapsed`). |
| `agent.output.summary` | summary in the collapsed Output Settings header | FR-099: "16:9 · 1080p · 30 fps · Standard" (ratio · resolution · frame rate · Performance Profile), shown only while collapsed. |
| `stage.divider` | Player / Timeline View divider | ↑/↓ resizes the Timeline View height (220 px to 50 % of the Stage). |
| `lib.catalogue.card.details` | ⓘ on a Catalogue Card | Opens `lib.catalogue.params` (also Space on the focused card). |
| `lib.catalogue.params` | Preset "Details" popover | Parameter fields with defaults from the catalogue; focus trapped, Esc closes and returns focus to ⓘ. |
| `lib.catalogue.params.field` | one parameter input | `data-param` carries the parameter name. |
| `lib.catalogue.params.apply` | "Apply with these settings" | Design Pick with the edited `params` (Compile path). |
| `lib.catalogue.params.reset` | "Reset to defaults" | Restores the preset defaults in the form. |
| `agent.editor.intentqueue.group` | "Applied in v5 (3)" row | Collapsed group of the items executed in one older version; `aria-expanded` toggles. |
| `stage.player.state.error.reload` / `stage.player.state.error.recovery` | Player error card actions | FR-062: "Reload preview" re-issues the media grant and remounts the Player; "Open Recovery" opens `scr.project.recover`. |
| `stage.player.state.error.copy` / `stage.player.state.safe` / `stage.player.state.safe.retry` | Preview recovery (QA 2026-10-31) | The error card shows Expertmotion's own copy only (EM-3301; the library message is available through "Salin detail teknis"); the Player rebuilds once by itself, then switches to safe mode (effects not painted in the preview, CSS stand-in) with a notice and a retry; renders are unaffected. |
| `stage.player.state.loading` (overlay) | Player loading overlay | FR-061: covers the frame while a newer Composition Version is fetched (`composition.updated`) or media buffers; no older frame is shown as current. |
| `stage.player.state.loading.retry` | Retry under "This is taking longer than usual" | QA 2026-10-25: shown when no composition arrived after 8 s; fetches the head version and a new media grant again. The wait cause (`no-project`, `head-loading`, `head-missing`, `head-without-model`, `metadata`) is logged as an `[em]` console warning, which the Desktop Shell writes to its log. |
| `stage.player.state.empty` / `stage.player.state.empty.import` | Player empty state | QA 2026-10-25: a Composition Version with nothing in it (no clips, texts, overlays, captions, audio or background) shows "Nothing to preview yet" with Import… instead of a spinner; a hover preview of a preset still plays. |
| `stage.player.state.noproject` / `stage.player.state.noproject.new` / `stage.player.state.noproject.open` | Player without a Project | No Project open: "No project open" with New Project (same as `hdr.menu.file.new`) and Open… (`scr.project.open`). Since FR-202 the App shows the Start screen (`scr.start`) whenever no project is open; the Player keeps this state for completeness. |
| `stage.timeline.element.generated` | "generated" badge on a bar | FR-064: the element's Asset came from a generator job (voice, music, thumbnail). |
| `agent.chat.message.copy` | copy icon under a message | FR-077: copies the message text to the clipboard. |
| `agent.chat.message.retry` | "Try again" on a failure | FR-077: a persisted system message keeps its EM code and inline recovery after a restart; also on a live error bubble. "Switch model" opens `agent.chat.model.popover` for that agent. |
| `agent.editor.message.applied` | "Applied directly: …" line | FR-085: a deterministic pick compiled and applied without any model, in thread order. |
| `agent.chat.attach.file` | "Image from this computer" in the attach menu | FR-072: imports a PNG/JPEG/WebP ≤ 10 MB (EM-1002 above) and attaches it. |
| `agent.chat.attach.error` | inline attachment notice | FR-072: EM-4307 (model cannot read images) or EM-1002 with Remove attachment / Switch model. |
| `agent.editor.plancard.step.ops` / `agent.editor.plancard.model` / `agent.editor.plancard.result` | Plan Card details | FR-081 ops count per step and model name; FR-086 diff summary ("3 added, 1 modified") once executed. |
| `agent.editor.plancard.step.dropped` / `agent.editor.plancard.locked` | Plan Card details | FR-081: a step EM-2302 removed (it touched a Locked Key), shown struck through, and the inline EM-2302 notice; steps of a plan that still touch Locked Keys are struck through (`data-locked` on `agent.editor.plancard.step`). |
| `agent.output.ratio.help.table` | pixel table in the ratio help popover | FR-087/FR-096: PERFORMANCE §3 pixels for every ratio × resolution, computed. |
| `agent.output.ratio.auto.hint` | "applies after the first insert" | FR-088: Auto is on but there is no Clip yet. |
| `agent.output.profile.help.learnmore` | "Learn more" next to the profile help | FR-091: opens the offline Help (`scr.help`) at the Performance profiles topic. |
| `scr.ratio.custom.preset` | extra ratio chip (21:9, 2:1, 1.91:1, 3:2, 2:3, 1:2, 9:21) | FR-092: fills width and height. |
| `sys.tour` | Tour card | Card of the in-app tour (ONBOARDING_TOUR.md §3); `data-step` = 1…10, `data-phase` = choose/preparing/step/done. |
| `sys.tour.next` | Tour "Next" | Next step (each step also advances on its real trigger). |
| `sys.tour.back` | Tour "Back" | Previous step. |
| `sys.tour.end` | Tour "End tour" | Ends the tour (Esc asks first). |
| `sys.tour.choice.current` | Re-run choice "This project" | Help ▸ Tour on a project with clips. |
| `sys.tour.choice.sample` | Re-run choice "Sample project" | Opens the R-025 sample project and starts the tour. |
| `sys.tour.sampleplan` | Prepared sample plan (TOUR-7) | Shown when no provider is connected or no plan exists. |
| `sys.tour.done.keep` | Closing card "Keep the sample project" | Ends the tour. |
| `sys.tour.done.own` | Closing card "Start my own project" | Ends the tour and opens `scr.project.new`. |

State variants (UI implementation rule): a superseded queue row uses `agent.editor.intentqueue.item.superseded`; a stale base version `agent.editor.baseversion.stale`; the play button swaps to `stage.player.controls.pause` while playing. Other states keep the base id and use `data-variant`, `aria-pressed` or `aria-selected`. Timeline Elements use `stage.timeline.element` with `data-kind="clip|transition|text|caption|audio|shape|image"`.

## Additions for the project lifecycle (FR-002, FR-004…FR-019, FR-164…FR-178 gap closure, 2026-10-24)

| ID | Element | Behaviour |
|---|---|---|
| `hdr.menu.help.onboarding` | Help ▸ Resume onboarding | Reopens `scr.onboarding` at the last step reached (FR-004). |
| `scr.onboarding.skip` | per-step "Skip" ("Lewati") | On Provider, Models, Hardware: records the step in the onboarding record and moves on. |
| `scr.onboarding.provider.consequence` | Provider step note | "Agents stay off until connected" (FR-007). |
| `scr.onboarding.hardware.disk` | Hardware step free disk | Free space on the data drive (FR-006). |
| `scr.onboarding.hardware.recheck` | Hardware step "Check again" | Re-runs the hardware check (R-151) and a live reading (R-152). |
| `scr.onboarding.done.open` | Done step "Open a new project" | Stores the onboarding record (settings) and opens `scr.project.new` prefilled "Untitled" (FR-008). |
| `scr.project.new.fps` / `scr.project.new.ratio` / `scr.project.new.resolution` / `scr.project.new.duration.policy` / `scr.project.new.duration.fixed` / `scr.project.new.output.folder` / `scr.project.new.create` | New Project fields | FR-009 defaults: 30 fps, Auto/9:16, 1080p, fit-content, the app output folder. |
| `scr.project.saveas.create` | Save As "Save copy" | Duplicates the open Project (R-019) and switches to the copy (FR-013). |
| `scr.project.settings.duration.fixed` | Project Settings fixed length (s) | Shown when the duration policy is fixed; 1–1800 s (FR-015). |
| `scr.project.open.thumb` | Open dialog thumbnail | First clip thumbnail of the head version (R-027); placeholder icon when none (FR-010). |
| `scr.project.open.usage` | Open dialog per-project size | Media + checkpoints + Outputs on disk (R-026, FR-178). |
| `scr.project.open.usage.total` | Open dialog total | Total used by projects and free space on the data drive. |
| `scr.project.open.delete.confirm` | Delete confirmation button | Permanent delete (R-015 `permanent=true`); typed name required when the Project has Outputs. |
| `scr.project.open.delete.keepoutputs` | "Keep the exported videos" checkbox | Checked by default; unchecked removes the Output files too (FR-178). |
| `scr.project.recover.hash` | Recovery row version hash | First 6 characters of the checkpoint's version hash (FR-016); the row also shows the file size. |
| `scr.backup.backup.folder` | Backup location | Folder field + Browse; defaults to the output folder (FR-017). |
| `scr.backup.backup.estimate` | Backup size estimate | Originals + versions (+ Outputs when included) against free space (R-026). |
| `scr.backup.backup.folder.default` | "Usually in {path}" | Hint under the folder field with the app's output folder (R-002) when known — the Service reports no backup-specific default (FR-314). |
| `scr.backup.result` | Backup result row | After a successful backup (`service.notice` kind backup, done, path): `.path` (the full path, selectable `<code>`), `.open` ("Open folder", Shell `openFolder`; absent without the bridge), `.copy` ("Copy path" → "Copied"). The toast `ui.scr.backup.done` stays (FR-314). |
| `scr.project.saveas.storage` | Save As storage note | `role=note`: the copy is kept inside the app database, not as a file; the shareable file is the backup zip (FR-313). Contains `.backup` ("Back up to zip…"), which opens `scr.backup` in place of this dialog. |
| `scr.unsaved` | Unsaved changes prompt | `.save`, `.discard` ("Don't save"), `.cancel`; shown before New, Open, Recent and window close when the title / layout state is dirty; states that the composition is already stored (FR-174). |
| `scr.close.render` | Close during an export | `.cancel` ("Cancel render and close"), `.keep` ("Keep rendering"); EM-8304 (FR-002). |

## Additions: licence, export, help, diagnostics, updates, generators (FR gap closure, 2026-10-24)

| ID | Element | Behaviour |
|---|---|---|
| `scr.help` | Offline help (Help ▸ Documentation) | Bundled in the Editor build, works without internet (FR-148); `.sections` holds the topics. |
| `scr.help.sections` | Offline help topics | Collapsible sections (getting started, import, design, agents, export, Private Mode, licence, troubleshooting). |
| `scr.help.performance.table` | Performance profiles topic table | What Standard / Accelerated / Turbo change (PERFORMANCE §2), in plain words (FR-091). |
| `scr.help.online` | Online documentation link | Opens the system browser; in Private Mode shows `.blocked` (EM-8202) with the URL to copy instead. |
| `scr.help.online.blocked` | EM-8202 note with copyable URL | Shown instead of opening the browser while Private Mode is on. |
| `scr.license.buy.blocked` | EM-8202 note on the "Get a licence key" link | Private Mode: the storefront URL with Copy instead of opening the browser (FR-132). `scr.license.help.blocked` is the same for the activation help link. |
| `scr.license.clock` | "Clock changed" badge | EM-5007, informational; licence state unchanged (FR-134). Also in the header licence popover. |
| `scr.export.still.time` | PNG frame time (s) | Chosen time for the PNG still (`stillAtMs`), default the playhead; "Use playhead" resets it (FR-138, FR-147). |
| `scr.export.preflight.fix` | Recovery button of a preflight row | Choose folder, Use Standard, Open Output Settings, Go to assets, Open Diagnostics, Enter licence key, View progress or Check again (FR-139). |
| `scr.export.preflight.recheck` | "Check again" | Re-runs R-110. |
| `scr.export.preflight.passed` | "N checks passed" disclosure | Passed checks without a note or action collapse into this one line (expand to see them); failed, noted or actionable checks stay as rows (Operator 2026-10-26). |
| `scr.export.private` | "Private Mode on" row | Context only; exporting works unchanged (FR-163). |
| `scr.export.elapsed` | Elapsed time | Time since the job started, next to `.eta` (FR-141). |
| `scr.export.done.thumb` | Done thumbnail | Output thumbnail (R-041 `thumb`, PNG stills show the file) (FR-146). |
| `scr.export.done.play` | Play | Opens the Output with the system player (`openPath`). |
| `scr.export.done.copypath` | Copy path | Copies the Output's absolute path. |
| `scr.export.again` | Export another | Back to the setup state. |
| `scr.export.diagnostics` | Open Diagnostics on failure | Next to Try again in the failed state (FR-143). |
| `scr.export.failed.frame` | Failure frame | "Stopped at frame {n} of {total} ({time})" under the failure message (FR-143, `RenderJobDto.failedFrame`); absent when the frame is unknown. |
| `scr.export.waiting.memory` | Waiting for memory | EM-3107 title + body while the queued job waits for free memory (FR-204). |
| `scr.export.stage` | Stage line | "Menyalakan mesin render…" / frame progress / "Menulis file video…" / "Memeriksa file hasil…" / EM-3208 (FR-204). |
| `scr.export.failed.retry` | Try again | "Coba lagi" under a failed export: back to the setup with the same choices (FR-204). |
| `scr.diagnostics.licence` | Licence state row | Status and code, never the key (FR-150); `.private` appears while Private Mode is on (FR-163). |
| `scr.diagnostics.private` | "Private Mode on" | Context in Diagnostics (FR-163). |
| `scr.diagnostics.codes` | Recent EM codes | R-182 list with time, source and job/run id (FR-150). |
| `scr.diagnostics.bundle.path` | Bundle path | Path of the written zip (copied automatically) with Copy and Open folder. |
| `scr.about.builddate` | Build date | From R-001 `buildDate` (FR-151). |
| `scr.about.remotion` | Remotion licence statement | How the Engine is licensed (FR-151). |
| `scr.about.notices.list` | Third-party notices list | Every bundled Engine Binary and the font licence (FR-151). |
| `scr.about.security` | Honest boundary statement | What the data protection does and does not cover (FR-176, ADR-006, SECURITY.md §1). |
| `scr.about.gpl` | GPL source offer | Written offer for the GPL components (espeak-ng, compositor FFmpeg; RISK-030, BRD-019). |
| `sys.update.download` | Update "Download" | Consent to download an available update (FR-152). |
| `sys.update.restart` | Update "Restart now" | EM-8105; disabled while an export runs, the Shell also defers the install until the queue is empty. |
| `sys.update.later` | Update "Later" | Hides the banner; the update stays downloaded. |
| `sys.update.retry` | Update "Try again" | EM-8104 (interrupted update, previous version kept), EM-8102, EM-8101: runs a new check (FR-152). |
| `agent.chat.budget` | "Change budget" in the EM-4201 message | FR-117 / AI-016: opens `scr.providers` with focus on `.budget.project` (or `.budget.month`) of the connection whose cap is used up. |
| `scr.generate.voice.voice` | Voice picker (legacy id) | Replaced by `scr.generate.voice.picker` (FR-246); kept for older builds. |
| `scr.generate.voice.picker` | Voice picker | Every narrator voice for the language: local (offline) and cloud (OpenAI, Google Gemini, ElevenLabs with the Creator's own keys), with availability (FR-246, ADR-035). |
| `scr.generate.voice.search` | Voice search | Free-text description ("perempuan hangat", "jelas, percaya diri") ranks the voices (FR-246). |
| `scr.generate.voice.filter` | Voice filter | All / Female / Male / Offline / Cloud (FR-246). |
| `scr.generate.voice.list` | Voice list | One `scr.generate.voice.row` per voice (`data-voice-id`), selectable (FR-246). |
| `scr.generate.voice.error` | Voice list error | The voice list could not be loaded: the reason (EM code) and Try again (review U6, 2026-10-29). |
| `scr.generate.voice.row` | Voice row | Name, gender, character words, provider badge, price per 1,000 characters (cloud), why it cannot run yet (FR-246). |
| `scr.generate.voice.private` | Private Mode note | Cloud voices are off while Private Mode is on (FR-246, SEC-135). |
| `scr.generate.voice.selected` | Chosen narrator | Name, licence / quality note, cost estimate for the current text (`scr.generate.voice.cost`) (FR-246). |
| `scr.generate.voice.cost` | Cost estimate | ≈ US$ for the current text with the chosen cloud voice (FR-246). |
| `scr.generate.voice.el` | ElevenLabs key | Add / remove the Creator's ElevenLabs key (validated, stored sealed, hint only) (FR-246). |
| `scr.generate.voice.voice.style` | Speaking style | Free text for voices that support a style instruction (OpenAI gpt-4o-mini-tts, Gemini, ElevenLabs) (FR-246). |
| `scr.generate.voice.voice.captions` | Voice + captions | One action makes the voice and its captions from the exact script, timed to the voice (FR-248, default on). |
| `scr.generate.music.library` | CC0 music library | Curated public-domain tracks by mood, download on demand, preview, "Use as music" (FR-247). |
| `scr.generate.music.library.moods` | Mood filter | All + the library moods (FR-247). |
| `scr.generate.music.library.list` | Track list | One `scr.generate.music.library.track` per track (`data-track-id`) (FR-247). |
| `scr.generate.music.library.track` | Library track | Title, artist, mood, genre, length, credit line, licence link (FR-247). |
| `scr.generate.music.library.play` | Track preview | Plays a downloaded track (FR-247). |
| `scr.generate.music.library.download` | Download track | Verified download with progress (FR-245, FR-247). |
| `scr.generate.music.library.insert` | Use as music | Copies the track into the project and adds it as the music bed in one version (R-222, FR-247). |
| `scr.generate.music.library.licence` | Licence link | CC0 1.0 deed (FR-247). |
| `scr.generate.music.ai` | AI music note | Explains that AI music needs a GPU and is not shipped in this version (FR-247). |
| `scr.models.row.failhint` | Download failure hint | What happened and what to do, in words, by cause (busy server, blocked secure connection, dropped connection …) (FR-245). |
| `scr.generate.voice.speed` | Speed slider | 0.8–1.2 (FR-101). |
| `scr.generate.voice.preview` | Audio preview | Plays the generated audio before Insert (FR-101, FR-102). |
| `scr.generate.voice.install` | Install model | Inline Model Download with size and progress (FR-107). |
| `scr.generate.voice.generated` | Generated list | Results from the last 7 days not inserted yet (FR-108). |
| `scr.generate.voice.generated.insert` | Insert a listed result | R-134 (FR-108). |
| `scr.generate.voice.generated.delete` | Delete a listed result | R-137 (FR-108). |
| `scr.generate.music.duration` | Music length | 10–120 s (FR-102). |
| `scr.generate.music.instrumental` | Instrumental toggle (removed) | Library music is always instrumental (FR-247). |
| `scr.generate.music.language` | Language toggle | Indonesia / English for sung lyrics, default from the Project language (FR-106). |
| `scr.generate.music.cc0` | CC0 loop library note (removed) | Replaced by `scr.generate.music.library` (FR-247). |
| `scr.generate.music.preview` | Audio preview | Plays the generated audio before Insert (FR-101, FR-102). |
| `scr.generate.music.install` | Install model | Inline Model Download with size and progress (FR-107). |
| `scr.generate.music.generated` | Generated list | Results from the last 7 days not inserted yet (FR-108). |
| `scr.generate.music.generated.insert` | Insert a listed result | R-134 (FR-108). |
| `scr.generate.music.generated.delete` | Delete a listed result | R-137 (FR-108). |
| `scr.generate.thumbnail.prompt` | Thumbnail image prompt | Optional; empty uses the playhead frame (FR-103). |
| `scr.generate.thumbnail.count` | Count | Thumbnail candidates 1–4, hashtags 10–20 (FR-103, FR-105). |
| `scr.generate.thumbnail.candidate` | Thumbnail candidate | Selectable image (FR-103). |
| `scr.generate.thumbnail.saveoutput` | Save to Outputs | R-136 for the chosen candidate (FR-103). |
| `scr.generate.thumbnail.style` | Thumbnail style | Bold / Clean / Cinematic / Playful: title variant in still mode, prompt wording in prompt mode (FR-103). |
| `scr.generate.thumbnail.insert` | Insert as overlay | Inserts the chosen candidate as an image overlay at the playhead (R-134, `op:generated.insert {kind: thumbnail}`, FR-103). |
| `scr.generate.thumbnail.language` | Language toggle | Indonesia / English, default from the Project language (FR-106). |
| `scr.generate.thumbnail.install` | Install model | Inline Model Download with size and progress (FR-107). |
| `scr.generate.thumbnail.generated` | Generated list | Results from the last 7 days not inserted yet (FR-108). |
| `scr.generate.thumbnail.generated.delete` | Delete a listed result | R-137 (FR-108). |
| `scr.generate.captions.pages` | Editable caption preview | One text field per caption page; edits are sent with Insert (FR-104). |
| `scr.generate.captions.source` | Audio source | The Sequence audio (default, every Clip placed on the timeline) or one Asset with audio (FR-104). |
| `scr.generate.captions.install` | Install model | Inline Model Download with size and progress (FR-107). |
| `scr.generate.captions.generated` | Generated list | Results from the last 7 days not inserted yet (FR-108). |
| `scr.generate.captions.generated.insert` | Insert a listed result | R-134 (FR-108). |
| `scr.generate.captions.generated.delete` | Delete a listed result | R-137 (FR-108). |
| `scr.generate.hashtags.platform` | Platform | TikTok / Instagram / YouTube (FR-105). |
| `scr.generate.hashtags.tone` | Tone | Casual / Professional / Energetic / Informative / Funny (FR-105). |
| `scr.generate.hashtags.count` | Count | Thumbnail candidates 1–4, hashtags 10–20 (FR-103, FR-105). |
| `scr.generate.hashtags.copycaption` | Copy caption + hashtags | Copies the social caption text with the hashtags (FR-105). |
| `scr.generate.hashtags.generated` | Generated list | Results from the last 7 days not inserted yet (FR-108). |
| `scr.generate.hashtags.generated.delete` | Delete a listed result | R-137 (FR-108). |

## Additions for the asset, library and lifecycle gap closure (FR-012, FR-018, FR-031, FR-042, FR-045, FR-048, FR-053, 2026-10-24)

| ID | Element | Behaviour |
|---|---|---|
| `lib.assets.selectall` | "Select all" in the Asset Panel header | FR-045: selects every ready Asset in panel order and assigns the next Sequence Badges (ingesting, failed, missing and caption Assets are skipped); pressed again it clears the selection. Ctrl+A does the same while focus is inside `lib.assets.panel`. |
| `lib.assets.card.action.importagain` | "Import again" on an interrupted card | FR-042: an EM-1201 card (Service restarted mid-ingest) is removed and the picker opens for that file type. |
| `lib.assets.error.diagnostics` | "Open Diagnostics" in `lib.assets.error` | FR-053: second recovery action of EM-6401 (ERROR_CATALOGUE); opens `scr.diagnostics`. |
| `lib.text.ratio.menu` / `lib.text.ratio.option` | Home ▸ Ratio popover and one ratio in it | FR-031: the same choices as `agent.output.ratio.*` (Custom opens `scr.ratio.custom`), applied through the same Output intent; `data-value` = ratio, `aria-checked` on the current one. |
| `lib.text.videosize.menu` / `lib.text.videosize.option` | Home ▸ Video Size popover and one resolution in it | FR-031: the same choices and tier gating as `agent.output.resolution.*`; `data-value` = resolution. |
| `stage.timeline.inspector.missing` | Missing-file box in the Timeline inspector | FR-048: shown when the selected element's Asset file is missing (EM-1301). |
| `stage.timeline.inspector.locate` / `stage.timeline.inspector.remove` | Locate / Remove in that box | FR-048: same actions as `lib.assets.card.action.locate` and `lib.assets.card.action.remove`. |
| `scr.backup.restore.renamed` | EM-6303 notice in the restore dialog | FR-018: the backup was restored as a renamed copy; nothing was overwritten. |
| `scr.backup.restore.open` | "Open restored project" | FR-018: opens the restored copy and closes the dialog. |

## Additions for pointing, agent progress and error recovery (FR-189, FR-190, FR-191) (QA 2026-10-26 items 3–6)

| Element id | Mockup label | Purpose |
|---|---|---|
| `agent.chat.targets` | chip strip above the composer | The pointed assets and Timeline elements ("@Klip 2", "@Reels 14.m4a"): explicit "Ask assistant" picks plus the current Timeline selection; sent as `targets` (ids + kind + label) with the next message in either mode; cleared after a successful send. |
| `agent.chat.target` / `agent.chat.target.remove` | one chip / its × | `data-kind` = `asset` / `clip` / `text` / `image` / `shape` / `audio` / `cut`; × (or Backspace in an empty composer for the last chip) removes it. |
| `agent.chat.message.targets` | chips on a sent message | Read-only copy of the targets a message was sent with (message block `targets`). |
| `agent.chat.progress` | "Menyusun rencana…" | What the running agent is doing (`agent.run.progress`: `data-phase` = `reading` / `planning` / `checking` / `correcting` ("Memperbaiki rencana (2/3)…") / `tool` / `waiting` (rate-limit retry, "Penyedia sibuk, mencoba lagi (1/2)…")); after 5 s it ends with the seconds since the run started ("· 42 dtk", `data-elapsed`), and "Menjalankan N perubahan…" while a plan executes. |
| `agent.chat.typing` / `agent.chat.progress.stop` | animated dots and "Hentikan" in the working bubble | FR-214 (QA 2026-10-27 "dikira error"): from Send to the answer `agent.chat.streaming` always shows the agent tag, the typing dots, `agent.chat.progress` (`data-phase` also `sending` "Mengirim…" / "Menyiapkan gambar…", `thinking` "Memikirkan ide…", `writing` "Menulis jawaban…", `tool` named per tool: "Mencari di katalog…", "Membaca proyek…"), the elapsed seconds from 2 s on, and Stop. Reduced motion: the dots do not move. |
| `agent.chat.stop` | Stop button in place of Send | FR-214: while the mode's agent works the send button turns into Stop (cancels the run, R-085) and the composer placeholder reads "Agent sedang bekerja…" (`data-busy` on `agent.chat.composer`). |
| `agent.chat.attach.chip` / `agent.chat.attach.preparing` / `agent.chat.attach.asset` | attached image chip, "Menyiapkan gambar…", an existing image in the attach menu | FR-213: the chip shows a spinner while the image is imported (`data-status` = `ingesting` / `ready`); Send waits until it is ready; a failed import removes the chip with its EM code. |
| `agent.chat.attach.note` | "Model ini tidak bisa membaca gambar…" | FR-213: the assigned model's Capability Table says it cannot read images: the message is still sent, with the file name instead of the picture (`data-code=EM-4307`), plus "Switch model". |
| `agent.chat.message.attachment` | attachment on a sent message | `data-sent` = `image` (the picture went to the model) / `name` (only the file name; a note says so). |
| `scr.providers.key.mismatch` / `scr.providers.key.mismatch.switch` | "Ini key Anthropic — ganti penyedia ke Anthropic?" | FR-215: the pasted key's prefix names another provider (`sk-ant-` Anthropic, `sk-or-` OpenRouter, `AIza` Gemini, `sk-` / `sk-proj-` OpenAI); one click switches the provider select (`data-provider`). |
| `scr.providers.defaults` | "Use defaults" in the onboarding Models step | FR-215: stores the default model of each agent (newest Claude Sonnet / GPT / Gemini Flash–Pro, else the Balanced tier) and moves on; the model list loads by itself with "Memuat daftar model…". |
| `agent.chat.error.action` / `agent.chat.error.reason` | next-action button and reason in an error bubble | The failure card (live `agent.run.failed` or a saved "EM-xxxx: reason" message) shows the reason and the recovery actions chosen by the EM code (`data-action` = `providers` / `rephrase` / `switchmodel`; "Try again" keeps `agent.chat.message.retry` (`data-action=retry`), the budget action keeps `agent.chat.budget`). |
| `agent.chat.error.keyhint` | "Key baru kadang perlu 1–2 menit untuk aktif" | EM-4002 on a key added or replaced in the last 5 minutes: hint, automatic retry countdown (every ~20 s, at most 3 times) and "Coba lagi"; also on the Providers add / validate forms (`scr.providers.keyhint`). |
| `scr.providers.terms` | provider terms link under the provider select | Entry 28: opens the provider's terms in the system browser through the Shell (`ExternalLink`; EM-8202 with a copyable URL in Private Mode). |
| `scr.providers.keyhint` | same hint on the Providers form | See `agent.chat.error.keyhint`; the retry re-runs the validation. |
| `agent.chat.error.keywrong` | "Key ini salah atau sudah tidak aktif…" | QA P1 2026-10-29: EM-4002 when the key is not new or the automatic retries are used up; the card title is "Key tidak valid", the reason line names the provider's own reason, the action "Ganti key" opens Providers. |
| `scr.providers.keywrong` | same line on the Providers forms | See `agent.chat.error.keywrong`; shown under "Key tidak valid" + the provider's reason after the retries. |
| `scr.providers.keyreason` | the provider's own reason under "Key tidak valid" | e.g. Kata Anthropic: “invalid x-api-key” (QA P1 2026-10-29). |
| `scr.providers.replacekey` | "Ganti key" button | Clears and focuses the key field (Providers add / Onboarding connect form). |
| `scr.providers.busy` | "Memeriksa kunci…" / "Memuat daftar model…" / "Menguji koneksi…" / "Menyimpan…" / "Mencoba lagi (2/3)…" | Status line (never red) while a provider action runs (`data-busy` = `validate` / `models` / `test` / `save`); after 8 s the waited seconds and "free models can be slow or rate limited". Errors stay in the ErrorBox. |
| `agent.chat.model.loading` | "Memuat daftar model…" | Model popover while the Capability Table loads / refreshes, or "Menyimpan…" while a pick is saved. |
| `lib.assets.card.action.ask` | "Tanya asisten" in the Asset card menu | Points the assistant at this Asset: adds it as a chip and focuses the composer. |
| `stage.timeline.inspector.ask` | "Tanya asisten" in the Timeline inspector | Points the assistant at the selected element (chip + composer focus; in Edit mode also the FR-067 target). |
| `agent.editor.plancard.toolstep` | a generator step on the Plan Card | `tts.generate` ("Suara narasi: …") / `captions.generate` ("Teks layar dari naskah"); `data-status` = `ready` / `needs-model` (skipped until the model is installed). |
| `agent.editor.plancard.preview` / `agent.editor.plancard.preview.row` / `agent.editor.plancard.preview.summary` / `agent.editor.plancard.preview.total` | readable plan preview | FR-222: rows `data-kind` = `scene` / `text` / `shape` / `transition` / `background` / `voice` / `captions` / `audio` / `clip` / `remove` / `caption-fix` / `timing` / `other` with start–end times; summary counts and the total duration. |
| `agent.editor.plancard.close` | ✕ in the card header | FR-222 / QA #16: discards a proposed plan (collapses an executed one); always visible. |
| `agent.editor.plancard.confirmremoval` / `agent.editor.plancard.confirmremoval.yes` | "Rencana ini menghapus n item:" + "Hapus & terapkan" | FR-225: inline removal confirmation (EM-4310); Execute then sends `confirmDestructive: true`. |
| `agent.editor.plancard.showtimeline` | "Lihat di timeline" | FR-222: selects the elements the executed plan added. |
| `agent.editor.plancard.revise` | "Ubah" | FR-222: asks the Editor for a change to this plan (composer prefilled). |
| `agent.editor.plancard.executing` | Execute phase + bar | FR-223 / FR-224: `data-phase` = `voice` / `measure` / `compose` / `apply` / `failed` (plan.progress). |
| `agent.editor.plancard.estimate` | "Waktu masih perkiraan…" | FR-224: the plan's timing waits for the real voice clips. |
| `agent.editor.plancard.steps.live` / `agent.editor.plancard.step.live` | generator step status | FR-223: after Execute each generator step shows `data-status` started / done / failed / skipped with its code. |
| `agent.editor.plancard.models` | "Buka Model Manager" | Shown with a `model-missing` risk; opens `scr.models`. |
| `agent.editor.plancard.toolnote` | "Suara sedang dibuat…" | After Execute, when a generator step started (`toolSteps`). |

## Additions for manual Timeline edits and collaboration (ADR-031, FR-192 … FR-195, 2026-10-26)

| ID | Mockup label / location | Notes |
|---|---|---|
| `stage.itemmenu` | context menu of a Timeline item or of the selected element on the Player | Opens on right-click, Shift+F10 or the ContextMenu key on a Timeline bar (an unselected bar becomes the selection first; a bar inside the selection acts on all of it) and on right-click of `stage.player.canvas.box`; `data-source="timeline|canvas"`; `role="menu"`, ↑ / ↓ / Home / End move, Enter / Space run, Esc / Tab / click outside close and return focus to the bar (FR-193, IX-30). |
| `stage.itemmenu.delete` / `.split` / `.duplicate` / `.ask` | "Hapus" / "Belah di playhead" / "Duplikat" / "Tanya Editor Agent" | Delete = the Delete-key pick; Split = the S pick (`aria-disabled` with the reason when the playhead is not inside the item); Duplicate = one `itemsEdit {action: duplicate}` pick for clips, scene clips, texts, images and shapes (disabled for audio, captions, transitions, effects, the background); Ask = the items as chips, Edit mode, composer focused (FR-194). A disabled entry keeps its reason as `title`. |
| `stage.itemmenu.copy` / `.cut` / `.paste` | "Salin" / "Potong" / "Tempel di playhead" (added 2026-10-28, FR-255 / FR-256) | Copy = snapshots of the selection onto the in-app clipboard (Ctrl+C; no version); Cut = Copy + the Delete pick (Ctrl+X; one Undo); Paste = the clipboard at the playhead as ONE `itemsEdit {action: paste}` pick (Ctrl+V; one Undo). Right-click on empty track space opens the menu with only Paste. `aria-disabled` with the reason when nothing copyable is selected / the clipboard is empty. |
| `stage.timeline.inspector.delete` | "Hapus" next to "Tanya asisten" in the Timeline inspector | Deletes every selected item (same pick as the Delete key; Ctrl+Z restores; FR-192). |

## Additions for startup, recovery and busy feedback (FR-184 … FR-186, 2026-10-26)

The startup and crash ids (`sys.splash.*`, `sys.crash.*`, `sys.fatal.retry`) are listed under Global (`sys.*`) above.

| Element id | Mockup label | Purpose |
|---|---|---|
| `lib.assets.importing` | "Mengimpor 2/5…" | Asset Panel header line while a batch of files is prepared: assets seen ingesting since none were; disappears when the batch is done (FR-186). |
| `scr.project.open.opening` | "Membuka proyek…" | On the chosen row of the Open dialog until the project is loaded; the dialog closes afterwards (FR-186). |
| `scr.generate.voice.progress.status` (same under `.music`, `.thumbnail`, `.captions`, `.hashtags`) | "Membuat suara… 45 %" | Generator status line above the bar: "Memulai…" during the request, "Menunggu giliran…" while queued, then what it makes and the percent (FR-186). |

## Additions for the automatic-first Editor (FR-260 … FR-269, ADR-036 … ADR-038, 2026-10-29)

| ID | Visible element | Notes |
|---|---|---|
| `hdr.menu.file.close` | File ▸ "Tutup proyek" | FR-260: closes the open project (unsaved prompt first) and leaves an empty project open. |
| `stage.recent` | "Terakhir dibuka:" row in the empty project | FR-260: up to three recent projects (the untouched blank project is never listed); hidden when there are none. |
| `stage.recent.item` | one recent project chip | Opens it (unsaved prompt first); `data-project` = its id. |
| `stage.recent.all` | "Semua…" | Opens File ▸ Open (`scr.project.open`). |
| `sys.launch.notice` | notice bar inside the empty project | FR-260: `data-kind` `crash-loop` ("Proyek terakhir gagal dibuka") or `abnormal` ("Sesi terakhir tidak tertutup normal"). |
| `sys.launch.notice.safe` | "Buka dalam mode aman" | Crash loop: opens that project in safe mode (FR-202). |
| `sys.launch.notice.open` | "Buka lagi" | Abnormal end: opens that project normally. |
| `sys.launch.notice.dismiss` | "Tutup" | Hides the notice. |
| `stage.player.state.empty.write` | "Tulis ide" (primary) | FR-263: focuses the Editor composer (Editor tab). `stage.player.state.empty.import` is now "Impor footage". |
| `sys.tooltip` | the tooltip (`role=tooltip`, id `em-tooltip`) | FR-264: one delegated layer; hover after 350 ms, keyboard focus at once; clamped inside the window. |
| `agent.chat.start` | empty-thread starter | FR-265: hint row + example prompts. |
| `agent.chat.start.hint` | "Tulis ide atau tempel prompt lengkap — Expertmotion membuat videonya otomatis" | First-run hint; remembered as dismissed (`nudgesDismissed` `chat:start-hint`). |
| `agent.chat.start.hint.dismiss` | × | Hides the hint for good. |
| `agent.chat.examples` | example prompt group | `role=group`. |
| `agent.chat.example` | one example chip (`data-key`) | Fills the Editor composer with the prompt (never sends); the footage chip shows only with an imported video. |
| `scr.generate.voice.recommended` | "Disarankan" badge | FR-268: the one recommended voice (default choice). |
| `scr.generate.voice.azure` | Azure AI Speech key | FR-269: `.key`, `.region`, `.save`, `.remove`; hint + region only. |
| `scr.generate.voice.group.free` / `scr.generate.voice.group.paid` | Voice list group headers | Operator 2026-10-31: free offline voices are listed first under "Gratis · luring", cloud voices under "Berbayar oleh penyedianya · kunci milikmu sendiri"; rows carry `data-free`. |
| `scr.generate.voice.connect` | Connect (cloud voice without a key) | Opens the provider's key field below (ElevenLabs / Azure / Google) or the Providers screen (OpenAI / Gemini). |
| `scr.generate.voice.keys` | Paid-voice keys section | Titled "Suara berbayar (opsional): tambahkan kunci milikmu" with the note that every offline voice is free; contains `scr.generate.voice.el`, `.azure`, `.google`. |
| `scr.generate.voice.google` | Google Cloud TTS key | FR-269: `.key`, `.save`, `.remove`; hint only. |

## Assumptions where the mockup does not define behaviour

1. The mockup shows only Design mode of the Library Panel; Home and Tools modes are derived from the yellow cards.
2. The cloud icons are repurposed to local Backup/Restore because Expertmotion has no cloud.
3. The avatar is licence status because Expertmotion has no user accounts.
4. "480p" in the mockup is treated as the draft preview quality, not an export preset (Master Project Prompt §13 lists 720p as the smallest export preset).
5. The three timeline rows in the mockup become five Tracks (video, overlay, text, caption, audio); since 2026-10-26 (ADR-027) the Timeline View draws them as lanes: captions, one row per layer (front-most on top), the video Track, audio lanes.
6. Since 2026-10-26 one assistant chat replaces the two chats and the Model Bar: the chat header shows the current mode's model (per agent) and its context usage.

## Additions for the QA UX fixes (round 1, 2026-10-29)

| Element ID | Mockup / label | Purpose |
|---|---|---|
| `sys.screen.error` / `sys.screen.error.action` | error card at the top of a dialog / the onboarding screen | P1-6: an error or warning raised while a screen is open is shown inside it (title, body, code, next action) and leaves the toast stack. |
| `scr.providers.add.error` / `scr.providers.add.retry` | "Provider is busy" + "Try again" in the connect form | P1-6: a validation that failed for another reason than a refused key (busy, provider error, no internet); the Service removed the stored connection again. |
| `scr.help.ai` / `scr.help.ai.open` | "The easiest way: ask the AI assistant" + "Write to the assistant" | Help starts with the AI chat; the button closes Help and focuses the Editor composer. |
| `stage.timeline.compact` | "Compact" / "All layers" | Packs layers that never overlap in time into shared rows (default above 6 layers); `aria-pressed`; packed rows carry `data-layers`. |
| `scr.export.ratio` / `scr.export.resolution` | ratio and resolution selects in the Export dialog | The same Output Settings pick as `agent.output.ratio.*` / `agent.output.resolution.*` (one undoable version). |
| `scr.export.waiting.memory.detail` | "Waited 12 s · 610 MB free, 900 MB needed" | Under EM-3107 while the export waits for free memory (render.queued `memoryWait`). |
| `scr.project.new.customratio` / `.width` / `.height` | Custom ratio fields in the New dialog | Width / height (1:3…3:1); applied to the new project as an Output Settings pick. |
| `scr.models.row.offline` / `scr.models.row.offline.retry` | "No internet connection — the download continues by itself…" + "Try again" | P1-9: shown from the first failed try that had no route to the internet (`model.progress noNetwork`); the download keeps retrying and resumes on its own. |
| `scr.models.row.optional` | "Optional" / "Opsional" badge (was "Later version") | Entry 36: a P2 model, not needed for the main features; tooltip says so. `scr.models.row.recommended` shows on the first recommended model of each purpose only. |
| `sys.toasts.more` | "+2 more" / "+2 lainnya" pill above the toast stack | Entry 36: at most two toasts show at once (the stack stays inside the Timeline View); the pill shows the older ones. |
| `agent.chat.message.text` / `agent.chat.message.fold` | A user message's text / "Show all" · "Tampilkan semua" | Entry 36: the long draft sent from Diskusi ("Kirim ke Editor") starts folded to four lines (`data-folded`). |
| `agent.chat.composer.count` | "6 120 / 8000" | Characters in the composer from 6 000 on; past 8 000 (the Service limit) it says so and Send is disabled (Send is also disabled for an empty / whitespace-only message). |
| `scr.generate.music.library.meta` | artist · mood · genre · length | The track facts on their own wrapping line under the title. |
| `lib.assets.card.duration` | "0:05" on the Asset card thumbnail | The length, moved off the name row so the name gets two lines (QA UX round 1, 1280 px). |

## Additions for the Reels pipeline (FR-280 … FR-299, DESIGN §E, 2026-10-31)

| Element ID | Mockup / label | Purpose |
|---|---|---|
| `scr.channel` / `scr.channel.text` / `scr.channel.count` / `scr.channel.ratio` / `scr.channel.import` / `scr.channel.import.input` / `scr.channel.clear` / `scr.channel.save` | "Profil kanal" dialog | The channel's standing rules (≤ 6 000 characters, setting `channelProfile`, R-171), loaded into both agents; `scr.channel.ratio` shows the format the text implies (`data-ratio`); `scr.channel.import` reads a .md / .txt. Opened from `agent.chat.menu.profile`, `hdr.menu.help.channel` and `agent.chat.attach.profile`. |
| `hdr.menu.help.channel` | Help ▸ "Profil kanal" | Opens `scr.channel`. |
| `agent.chat.menu` / `agent.chat.menu.profile` / `agent.chat.menu.prep` | "⋮" in the chat header | Chat menu: Profil kanal, Siapkan rekaman (disabled with its reason without a video + audio pair). |
| `agent.chat.attach.profile` | "Jadikan profil kanal" on an attached .md / .txt chip | Opens `scr.channel` with the file's text as the draft (shown when the Editor read the file itself). |
| `agent.chat.composer.time` | "0:23" chip in the Editor composer | A time typed in the message ("perbaiki di 0:23"; `data-ms`) is sent as `playheadMs` with the message and the Player jumps there. |
| `agent.chat.prd.approve` | "PRD siap · Setujui & kirim ke Editor" | On a Diskusi answer that ends with "PRD siap": the same hand-off as `agent.chat.sendtoeditor` (R-083b). |
| `agent.chat.prep` | Footage prep card | The prep job (R-130 kind `prep`); `data-status` = `running` / `needs-input` / `done` / `failed`, `data-stage` = probe / sync / master / phrases / listen / takes / timing. |
| `agent.chat.prep.stages` / `agent.chat.prep.stage` / `agent.chat.prep.percent` | Indonesian stage list + "45 % · 12 s" | One `agent.chat.prep.stage` per stage (`data-stage`, `data-state` done / active / todo). |
| `agent.chat.prep.rotate` / `agent.chat.prep.rotation` | "Putar video?" with four thumbnails | `needs-input` (EM-1503): one `agent.chat.prep.rotation` button per `data-rotation` 0 / 90 / 180 / 270 → `POST /projects/:id/footage-prep/:jobId/continue`. |
| `agent.chat.prep.summary` / `agent.chat.prep.cuts` / `agent.chat.prep.cut` / `agent.chat.prep.dropped` | "Offset 3.54 dtk · 8 potongan · 0:57 dipakai" + cut table | Done: the cut table (no · recording time range · words · spoken text; `data-cut-id`) and the dropped count. |
| `agent.chat.prep.error` / `agent.chat.prep.retry` | failure line with its EM code | Failed: EM-1500 … EM-1505 title and body, "Coba lagi". |
| `agent.chat.cover` / `agent.chat.cover.open` / `agent.chat.cover.sheet` / `agent.chat.cover.cell` / `agent.chat.cover.form` / `agent.chat.cover.hook` / `agent.chat.cover.line` / `agent.chat.cover.handle` / `agent.chat.cover.render` / `agent.chat.cover.result` / `agent.chat.cover.result.image` / `agent.chat.cover.reveal` / `agent.chat.cover.copypath` | "Cover" card | Cover candidates: the contact sheet (`GET …/footage-analysis/frames`) with one `agent.chat.cover.cell` per cut (`data-cut-id`, `aria-selected`), the words, "Buat cover" → `POST /projects/:id/cover` → the saved JPG (`data-state` idle / open / done) with Open folder (R-119) and Copy path. |
| `agent.editor.stage` / `agent.editor.stage.prep` / `agent.editor.stage.preview` / `agent.editor.stage.final` | "Siapkan · Pratinjau · Final" | On the Plan Card and the hand-off card of a project with a recording: prep with the project's video + audio, Execute + 720p render, 1080p render (the Export dialog opens on the running job). Disabled with a reason while a prep / render runs. |
| `lib.assets.prep` | "Siapkan rekaman" in the Asset Panel | Shown when the project has at least one ready video and one ready audio Asset; starts the prep job. |
| `scr.export.codec.jpg` / `scr.export.done.credits` | "Cover (JPG)" format · "CREDITS.txt ditulis di samping video" | Export: a JPEG still (`format:'jpg'`, same still-time field as PNG); after a video render the note that the Service wrote `<name>-CREDITS.txt`. |
| `scr.project.new.ratio.channel` | "Dari profil kanal" under the ratio select | New project: the ratio came from the channel profile (Reels / Shorts / TikTok / 9:16 → 9:16). |

## Additions for internet assets (FR-300 … FR-307, ADR-041, 2026-10-31)

| Element ID | Mockup / label | Purpose |
|---|---|---|
| `agent.chat.message.images` | "Gambar dari kompas.com (5)" / "Foto dan video stok (8)" / "Gambar berlisensi terbuka (n)" | The candidate block of one answer; `data-source` = `page` / `stock` / `open`. |
| `agent.chat.message.image` | one candidate row | `data-source` (openverse / wikimedia / pexels / pexels-video / page), `data-kind` (image / video), `data-imported` after Import. |
| `agent.chat.message.image.kind` | "Video · 12 dtk" badge | Shown on video candidates (Pexels clips) with the duration when known (FR-306). |
| `agent.chat.message.image.licence` | "Pexels License · 1080×1920" / "Hak cipta pemilik — kutipan/komentar · 1200×800 · kompas.com" | The licence line of a candidate: CC code, Pexels License or the owner's-copyright text, size, host (FR-306). |
| `agent.chat.message.images.owner` | "Hak cipta pemilik — pakai untuk kutipan/komentar, cantumkan sumber." | Notice under a block that contains page pictures (FR-304, FR-307); `role=note`. |
| `scr.providers.research` | "Riset internet" section of the AI providers screen | The research switch mirror (`scr.providers.research.toggle`, same setting as `agent.chat.research`) and the Pexels key (FR-301). |
| `scr.providers.research.pexels` / `.key` / `.save` / `.remove` / `.status` / `.error` / `.link` | "Kunci API Pexels (opsional)" | `data-connected` true / false on the group; the key input (password), Save (R-089b), remove (R-089c), the status line ("Pexels terhubung (…abcd)" or the note with the pexels.com/api link), the EM-4410 line (`data-code`) after a refused key. |

## Retired ids

Removed on 2026-10-26 (Operator UI polish); the names are not reused: `hdr.win.minimize`, `hdr.win.maximize`, `hdr.win.close` (header window buttons that duplicated the native Windows frame; closing goes through the native frame and the same unsaved / render prompts), `scr.models.folder` (per-engine "Open <engine> folder" buttons in the Model Manager footer).

Removed on 2026-10-26 with the two separate chats (Operator decision: ONE assistant chat with two modes, Diskusi / Edit; FR-073, FR-099); the names are not reused: `agent.modelbar`, `agent.modelbar.status`, `agent.modelbar.provider`, `agent.modelbar.model` (now `agent.chat.model` / `agent.chat.status` in the chat header), `agent.chats`, `agent.chat.divider` (no split any more), `agent.brainstorm.panel`, `agent.editor.panel` (now `agent.chat`), `agent.brainstorm.header`, `agent.editor.header` (now `agent.chat.header`), `agent.brainstorm.maximize`, `agent.editor.maximize` (now `agent.chat.maximize`), `agent.brainstorm.thread`, `agent.editor.thread` (now `agent.chat.thread`), `agent.brainstorm.message` / `agent.editor.message` with `.copy` / `.retry` (now `agent.chat.message` with `data-agent`), `agent.brainstorm.composer` / `.send` / `.attach` / `.attach.file` / `.attach.error` and the same under `agent.editor.` (now `agent.chat.composer` …), `agent.brainstorm.footer.model` / `.footer.ctx` / `.footer.model.popover` / `.footer.model.connection` / `.footer.model.picker.*` and the same under `agent.editor.` (now `agent.chat.model`, `agent.chat.usage`, `agent.chat.model.popover` …), `agent.brainstorm.budget`, `agent.editor.budget` (now `agent.chat.budget`).

Removed on 2026-10-26 with the layered lanes (Operator decision: CapCut-style timeline, ADR-027); the names are not reused: `stage.timeline.track.overlay`, `stage.timeline.track.text` (now one `stage.timeline.lane.layer` per layer, texts and overlays mixed by stacking order), `stage.timeline.track.audio` (now `stage.timeline.lane.audio` per lane).

Removed on 2026-10-25 with the LLM tier pickers (Operator feedback: one searchable model table instead of Fast / Balanced / Best; FR-115); the names are not reused: `scr.providers.assign.brainstorm` / `scr.providers.assign.editor` (exact model selects), `scr.providers.assign.brainstorm.tier` / `scr.providers.assign.editor.tier` (tier radiogroups), `scr.providers.assign.tier.option`, `scr.providers.assign.tier.empty`, `scr.providers.assign.custom`, `scr.providers.assign.brainstorm.advanced` / `scr.providers.assign.editor.advanced` (Advanced disclosures), `agent.brainstorm.footer.model.tier` / `agent.editor.footer.model.tier` (footer tier buttons), `agent.brainstorm.footer.model.option` / `agent.editor.footer.model.option` (footer Advanced rows; now `….footer.model.picker.row`). Also removed on 2026-10-25 (Operator decision: every model selectable, Free / Paid category), not reused: `scr.providers.models.filter.free` and `agent.<agent>.footer.model.picker.filter.free` (now `….category.free`), `scr.providers.models.row.reason` and `agent.<agent>.footer.model.picker.row.reason` (disabled-row reason; now `….row.warn`).

Removed on 2026-10-25 together with Trial Mode (Operator decision; LICENSE_OPERATIONS §7); the names are not reused: `hdr.action.purchase` (header Purchase button), `scr.license.trial.continue` ("Continue with Trial"), `scr.license.trial.notice` (EM-5001 notice), `scr.onboarding.license` (onboarding Licence step).
