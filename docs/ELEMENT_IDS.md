# UI Element IDs and Annotated Wireframe

| Field | Value |
|---|---|
| Status | Baseline (new elements may be added; existing IDs never change meaning) |
| Owner | UI/UX lead |
| Last updated | 2026-10-24 |
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
│   hdr.action.models  hdr.action.purchase  hdr.action.license  hdr.action.export  hdr.win.*    │
├────────────────────┬──────────────────────────────────────────────┬───────────────────────────┤
│ lib.search.input   │ stage.player.frame                          │ agent.modelbar            │
│ lib.mode.header    │  stage.player.canvas                        │  agent.modelbar.provider  │
│  (Design mode)     │  stage.player.controls                      │  agent.modelbar.model     │
│ lib.catalogue      │   .play .pause .time .duration .ratio .res  │ agent.brainstorm.panel    │
│  lib.catalogue.tab │   .scrubber .fullscreen .menu               │  .thread .message         │
│  lib.catalogue.card│  stage.player.state.loading/.error          │  .composer .send .attach  │
│   .thumb .label    │                                             │  .footer.model .footer.ctx│
│   .badge.model     │ stage.timeline                              │  .handoff (→ Editor)      │
│   .badge.gpu       │  stage.timeline.ruler  stage.timeline.head  │ agent.editor.panel        │
│  (Home mode)       │  stage.timeline.track.video                 │  .thread .message         │
│ lib.text.*         │  stage.timeline.track.overlay               │  .intentqueue             │
│  (Tools mode)      │  stage.timeline.track.text                  │   .item .item.superseded  │
│ lib.generator.card │  stage.timeline.track.caption               │   .item.restore .clear    │
│                    │  stage.timeline.track.audio                 │  .plancard                │
│ lib.assets.panel   │  stage.timeline.element                     │   .goal .step .risk .notes│
│  lib.assets.drop   │   .clip .text .caption .audio .transition   │   .baseversion.stale      │
│  lib.assets.card   │   .effect .background .shape .generated     │  .execute  .cancel        │
│   .thumb .meta     │  stage.timeline.inspector                   │  .composer .send .attach  │
│   .badge.sequence  │  stage.timeline.empty                       │  .footer.model .footer.ctx│
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
| `hdr.menu.file.new` | New Video | New Project dialog (`scr.project.new`). |
| `hdr.menu.file.open` | Open | Open Project dialog (`scr.project.open`). |
| `hdr.menu.file.recent` | (added per brief) | Recent projects submenu. |
| `hdr.menu.file.save` | Save | Save Project. |
| `hdr.menu.file.saveas` | Save as | Save As dialog. |
| `hdr.menu.file.import` | Import | Opens OS file picker into the Asset Panel. |
| `hdr.menu.file.export` | Export | Opens Export dialog (`scr.export`). |
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
| `hdr.action.purchase` | Purchase | Opens Licence screen (`scr.license`). Hidden when licensed. |
| `hdr.action.license` | avatar | Licence status popover (trial / licensed / expired updates). |
| `hdr.action.export` | Export | Opens Export dialog. `hdr.action.export.disabled` until a Composition Version with ≥ 1 Clip exists. |
| `hdr.win.minimize` / `hdr.win.maximize` / `hdr.win.close` | window controls | Standard window controls. |

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
| `stage.player.controls.time` / `.duration` | (controls) | Current time / total duration (mm:ss.ff). |
| `stage.player.controls.ratio` / `.res` | (added) | Aspect Ratio and Resolution indicators. |
| `stage.player.controls.fullscreen` | (added) | Fullscreen toggle. |
| `stage.player.menu` | hamburger (≡) | Player menu: safe-area overlay, draft/full quality, loop, mute. |
| `stage.player.state.loading` / `.error` | (states) | Loading spinner / error card with recovery action. |
| `stage.timeline` | rows under player | Timeline View container. |
| `stage.timeline.ruler` / `.head` | (added) | Time ruler and playhead line. |
| `stage.timeline.track.video` / `.overlay` / `.text` / `.caption` / `.audio` | three rows in mockup | One lane per Track. |
| `stage.timeline.element` | (bars) | One Timeline Element; variants `.clip`, `.text`, `.caption`, `.audio`, `.transition`, `.effect`, `.background`, `.shape`, `.generated`. Click → selection + inspector. |
| `stage.timeline.element.selected` | (state) | Selected element; Design Picks target it. |
| `stage.timeline.inspector` | (added) | Read-only property sheet for the selected element, with "Ask Editor Agent to change" shortcut. |
| `stage.timeline.quickparams` / `stage.timeline.quickparams.field` / `stage.timeline.quickparams.apply` | (added, P1) | FR-098 quick params under the inspector: transition duration, motion duration/delay, effect values; validated against the preset params schema (EM-2102 inline) before a Compile pick. |
| `stage.timeline.empty` | "Drag material here…" (replace) | Copy: "Insert assets, then your picks and the Editor Agent fill this timeline." |

## Agent Panel (`agent.*`)

| Element ID | Mockup element | Behaviour summary |
|---|---|---|
| `agent.modelbar` | "Model: MiniMax H3" | Default Provider Connection + model; click → Providers screen. |
| `agent.modelbar.status` | (dot) | Connection validated / error / Private Mode. |
| `agent.brainstorm.panel` | "Brainstorming Agent" | Brainstorming Chat container. |
| `agent.brainstorm.thread` / `.message` | messages | Thread and message bubbles (`.user`, `.assistant`, `.system`). |
| `agent.brainstorm.composer` / `.send` / `.attach` | input, send, attach icon | Composer; attach = reference an Asset or image into the chat. |
| `agent.brainstorm.footer.model` | "Claude 3.5 Sonnet ▾" | Per-agent Model Assignment override. |
| `agent.brainstorm.footer.ctx` | "0 / 200000" | Context usage: tokens used / model context length. |
| `agent.brainstorm.handoff` | (added) | Card shown when the Brainstorming Agent proposes Edit Intents: "Send to Editor Agent" / "Dismiss". |
| `agent.brainstorm.handoff.item` / `agent.brainstorm.handoff.item.reason` | (added) | One proposed change in plain words (category, value → target); an invalid one is greyed (`data-invalid`) with its reason and EM code and cannot be sent (FR-076). |
| `agent.editor.panel` | "Editor Agent" | Editor Chat container. |
| `agent.editor.thread` / `.message` | messages | As above. |
| `agent.editor.intentqueue` | (added) | Intent Queue list; `.item`, `.item.superseded`, `.item.restore`, `.item.remove`, `.clear`. |
| `agent.editor.plancard` | (added) | Plan Card; `.goal`, `.step`, `.step.tool`, `.step.diff`, `.risk`, `.notes`, `.baseversion`, `.baseversion.stale`. |
| `agent.editor.plan` | (added) | "Plan" button: asks the Editor Agent to plan the queued intents (also triggered by composer send and by hand-off when auto-plan is on). |
| `agent.editor.plancard.replan` | (added) | Re-plan a stale or invalid plan against the current version. |
| `agent.editor.execute` | Execute | Executes the current Edit Plan. Disabled when no plan, stale, or validation failed. |
| `agent.editor.cancel` | (added) | Cancels a running plan or agent request. |
| `agent.editor.composer` / `.send` / `.attach` | input, send | Composer for direct instructions to the Editor Agent. |
| `agent.editor.footer.model` / `.footer.ctx` | footer | As for brainstorm. |
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
| `scr.onboarding` | First-run wizard: `.welcome`, `.license`, `.provider`, `.models`, `.hardware`, `.tour`, `.done`. |
| `scr.license` | Licence entry / status / purchase link; `.status`, `.machinecode`, `.machinecode.copy`, `.input`, `.activate`, `.buy`, `.trial.continue`, `.remove`, `.rebind`, `.error`. |
| `scr.providers` | Provider Connections: `.list`, `.add`, `.provider.select`, `.key.input`, `.validate`, `.models.list`, `.assign.brainstorm`, `.assign.editor`, `.budget.project`, `.budget.month`, `.test`, `.save`. FR-109…FR-119 additions: `.row` (one connection), `.row.usage`, `.row.isdefault`, `.row.edit`, `.row.test`, `.row.default` (Set default), `.row.remove`, `.row.remove.confirm`, `.row.remove.yes`, `.edit`, `.edit.save`, `.add.open`, `.cancel`, `.label.input`, `.provider.disclosure` (what is sent + terms link), `.key.toggle` (show/hide), `.key.shape`, `.locked`, `.models.search`, `.models.refresh`, `.assign.note` (EM-4005 / image-input note), `.budget.warn` (EM-4202), `.test.result`. |
| `scr.models` | Model Manager: `.list`, `.row`, `.row.install`, `.row.remove`, `.row.progress`, `.tier`. FR-120…FR-126 additions: `.filter`, `.filter.purpose`, `.filter.installed`, `.filter.fits`, `.row.expand`, `.row.card`, `.row.notice` (engine licence notice), `.row.recommended`, `.row.tier`, `.row.status`, `.row.pause`, `.row.cancel`, `.row.install.confirm` (EM-7005), `.row.install.anyway`, `.row.remove.confirm`, `.row.remove.yes`, `.footer`, `.folder` (per-engine open folder), `.registry` (EM-7111). |
| `scr.hardware` | Hardware Monitor popover: `.cpu`, `.ram`, `.procmem`, `.disk`, `.gpu`, `.workload`. FR-127…FR-130 additions: `.output` (output drive), `.vram`, `.tier`, `.recheck`, `.workload.item`, `.workload.cancel`. |
| `scr.project.new` / `.open` / `.settings` / `.recover` | Project dialogs; open has `.list`, `.delete` (confirmation); settings has `.name`, `.fps`, `.ratio`, `.resolution`, `.duration.policy`, `.output.folder`; recover has `.list`, `.restore`. |
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
| `sys.offline` | Local Service unreachable banner with retry. |
| `sys.render.progress` | Persistent render progress chip in the header area. |
| `sys.update` | Update available / downloaded / restart prompt. |
| `sys.privatemode.banner` | Banner while Private Mode is on. |
| `sys.fatal` | Fatal Service state shown in the Editor (EM-8002 after three failed restarts, EM-6001 storage locked; FR-171, FR-176). The Editor stays mounted behind it. |
| `sys.fatal.diagnostics` | Open Diagnostics: opens the logs folder through the Shell (the Diagnostics screen needs the Service). |
| `sys.fatal.quit` | Quit Expertmotion. |
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
| `agent.divider` | Stage / Agent Panel divider | As `lib.divider` for the Agent Panel, 320–520 px; the Stage never shrinks below 560 px. |
| `stage.divider` | Player / Timeline View divider | ↑/↓ resizes the Timeline View height (220 px to 50 % of the Stage). |
| `lib.catalogue.card.details` | ⓘ on a Catalogue Card | Opens `lib.catalogue.params` (also Space on the focused card). |
| `lib.catalogue.params` | Preset "Details" popover | Parameter fields with defaults from the catalogue; focus trapped, Esc closes and returns focus to ⓘ. |
| `lib.catalogue.params.field` | one parameter input | `data-param` carries the parameter name. |
| `lib.catalogue.params.apply` | "Apply with these settings" | Design Pick with the edited `params` (Compile path). |
| `lib.catalogue.params.reset` | "Reset to defaults" | Restores the preset defaults in the form. |
| `agent.editor.intentqueue.group` | "Applied in v5 (3)" row | Collapsed group of the items executed in one older version; `aria-expanded` toggles. |
| `stage.player.state.error.reload` / `stage.player.state.error.recovery` | Player error card actions | FR-062: "Reload preview" re-issues the media grant and remounts the Player; "Open Recovery" opens `scr.project.recover`. |
| `stage.player.state.loading` (overlay) | Player loading overlay | FR-061: covers the frame while a newer Composition Version is fetched (`composition.updated`) or media buffers; no older frame is shown as current. |
| `stage.timeline.element.generated` | "generated" badge on a bar | FR-064: the element's Asset came from a generator job (voice, music, thumbnail). |
| `agent.brainstorm.message.copy` / `agent.editor.message.copy` | copy icon under a message | FR-077: copies the message text to the clipboard. |
| `agent.brainstorm.message.retry` / `agent.editor.message.retry` | "Try again" on a saved failure | FR-077: a persisted system message keeps its EM code and inline recovery after a restart. |
| `agent.editor.message.applied` | "Applied directly: …" line | FR-085: a deterministic pick compiled and applied without any model, in thread order. |
| `agent.brainstorm.attach.file` / `agent.editor.attach.file` | "Image from this computer" in the attach menu | FR-072: imports a PNG/JPEG/WebP ≤ 10 MB (EM-1002 above) and attaches it. |
| `agent.brainstorm.attach.error` / `agent.editor.attach.error` | inline attachment notice | FR-072: EM-4307 (model cannot read images) or EM-1002 with Remove attachment / Switch model. |
| `agent.brainstorm.footer.model.option` / `agent.editor.footer.model.option` | one model row in the footer picker | FR-073: lists models of every validated connection with context, tools, image and price columns; applies to the next request of that agent only. |
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
| `scr.onboarding.skip` | per-step "Skip" ("Lewati") | On Licence, Provider, Models, Hardware: records the step in the onboarding record and moves on. |
| `scr.onboarding.provider.consequence` | Provider step note | "Agents stay off until a provider is connected" (FR-007). |
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
| `scr.license.buy.blocked` | EM-8202 note on the buy link | Private Mode: the storefront URL with Copy instead of opening the browser (FR-132). |
| `scr.license.clock` | "Clock changed" badge | EM-5007, informational; licence state unchanged (FR-134). Also in the header licence popover. |
| `scr.export.still.time` | PNG frame time (s) | Chosen time for the PNG still (`stillAtMs`), default the playhead; "Use playhead" resets it (FR-138, FR-147). |
| `scr.export.preflight.fix` | Recovery button of a preflight row | Choose folder, Use Standard, Open Output Settings, Go to assets, Open Diagnostics, Enter licence key, View progress or Check again (FR-139). |
| `scr.export.preflight.recheck` | "Check again" | Re-runs R-110. |
| `scr.export.private` | "Private Mode on" row | Context only; exporting works unchanged (FR-163). |
| `scr.export.elapsed` | Elapsed time | Time since the job started, next to `.eta` (FR-141). |
| `scr.export.done.thumb` | Done thumbnail | Output thumbnail (R-041 `thumb`, PNG stills show the file) (FR-146). |
| `scr.export.done.play` | Play | Opens the Output with the system player (`openPath`). |
| `scr.export.done.copypath` | Copy path | Copies the Output's absolute path. |
| `scr.export.again` | Export another | Back to the setup state. |
| `scr.export.diagnostics` | Open Diagnostics on failure | Next to Try again in the failed state (FR-143). |
| `scr.export.failed.frame` | Failure frame | "Stopped at frame {n} of {total} ({time})" under the failure message (FR-143, `RenderJobDto.failedFrame`); absent when the frame is unknown. |
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
| `scr.license.trial.notice` | EM-5001 notice in the onboarding Licence step | First launch in Trial Mode (FR-133); outside onboarding the same notice is a one-time `sys.toast`. |
| `agent.brainstorm.budget` / `agent.editor.budget` | "Change budget" in the EM-4201 message | FR-117 / AI-016: opens `scr.providers` with focus on `.budget.project` (or `.budget.month`) of the connection whose cap is used up. |
| `scr.generate.voice.voice` | Voice picker | Installed Piper/Kokoro voices (FR-101). |
| `scr.generate.voice.speed` | Speed slider | 0.8–1.2 (FR-101). |
| `scr.generate.voice.preview` | Audio preview | Plays the generated audio before Insert (FR-101, FR-102). |
| `scr.generate.voice.install` | Install model | Inline Model Download with size and progress (FR-107). |
| `scr.generate.voice.generated` | Generated list | Results from the last 7 days not inserted yet (FR-108). |
| `scr.generate.voice.generated.insert` | Insert a listed result | R-134 (FR-108). |
| `scr.generate.voice.generated.delete` | Delete a listed result | R-137 (FR-108). |
| `scr.generate.music.duration` | Music length | 10–120 s (FR-102). |
| `scr.generate.music.instrumental` | Instrumental toggle | Default on (FR-102). |
| `scr.generate.music.language` | Language toggle | Indonesia / English for sung lyrics, default from the Project language (FR-106). |
| `scr.generate.music.cc0` | CC0 loop library note | T0 or the loop library chosen (FR-102). |
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

## Assumptions where the mockup does not define behaviour

1. The mockup shows only Design mode of the Library Panel; Home and Tools modes are derived from the yellow cards.
2. The cloud icons are repurposed to local Backup/Restore because Expertmotion has no cloud.
3. The avatar is licence status because Expertmotion has no user accounts.
4. "480p" in the mockup is treated as the draft preview quality, not an export preset (Master Project Prompt §13 lists 720p as the smallest export preset).
5. The three timeline rows in the mockup become five Tracks (video, overlay, text, caption, audio).
6. Chat footers show the per-agent model and context usage; the top Model Bar shows the default Provider Connection.
