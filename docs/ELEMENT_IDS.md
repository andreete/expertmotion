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
| `hdr.menu.file.recover` | (added per brief) | Recovery dialog listing checkpoints (`scr.project.recover`). |
| `hdr.menu.home` | Home | Switches Library Panel to Home mode (`lib.text.*`). |
| `hdr.menu.design` | Design | Switches Library Panel to Design mode (`lib.catalogue.*`). |
| `hdr.menu.tools` | Tools | Switches Library Panel to Tools mode (`lib.generator.*`). |
| `hdr.menu.help` | Help | Help menu: `hdr.menu.help.tour`, `.diagnostics`, `.license`, `.about`, `.docs`. |
| `hdr.title` | "Untitled" | Editable Project Title; blur or Enter saves. |
| `hdr.title.dirty` | (dot after title) | Unsaved-changes indicator. |
| `hdr.action.hardware` | display icon | Hardware Monitor popover (`scr.hardware`). |
| `hdr.action.save` | save icon | Same as `hdr.menu.file.save`. |
| `hdr.action.backup` | cloud-upload icon (repurposed) | Backup Project to a local zip. |
| `hdr.action.restore` | cloud-sync icon (repurposed) | Restore Project from a zip. Badge shows when a newer checkpoint exists. |
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
| `lib.text.add` | Home ▸ Add Text | Opens `lib.text.add.input` (text entry + variant) and adds a Text Layer at the playhead with current picks on confirm (`lib.text.add.confirm`). |
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
| `lib.assets.error` | (state) | Import error banner. |

## Stage (`stage.*`)

| Element ID | Mockup element | Behaviour summary |
|---|---|---|
| `stage.player.frame` | "Player" panel | Player container sized to the current Aspect Ratio. |
| `stage.player.canvas` | video area | Remotion Player surface. |
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
| `agent.output.ratio.auto` | Auto | Pick ratio from the first inserted Clip. |
| `agent.output.resolution.720p` / `.1080p` / `.2k` / `.2160p` | 480p/HD/2K/4K buttons | Resolution selector; `.disabled` with reason below the Hardware Tier threshold. |
| `agent.output.private` | Private Mode toggle | Blocks all outbound calls. |
| `agent.output.reset` | Reset to Defaults | Resets Output Settings (confirmation). |

## Screens and dialogs (`scr.*`)

| Element ID | Purpose |
|---|---|
| `scr.onboarding` | First-run wizard: `.welcome`, `.license`, `.provider`, `.models`, `.hardware`, `.tour`, `.done`. |
| `scr.license` | Licence entry / status / purchase link; `.status`, `.machinecode`, `.machinecode.copy`, `.input`, `.activate`, `.buy`, `.trial.continue`, `.remove`, `.rebind`, `.error`. |
| `scr.providers` | Provider Connections: `.list`, `.add`, `.provider.select`, `.key.input`, `.validate`, `.models.list`, `.assign.brainstorm`, `.assign.editor`, `.budget.project`, `.budget.month`, `.test`, `.save`. |
| `scr.models` | Model Manager: `.list`, `.row`, `.row.install`, `.row.remove`, `.row.progress`, `.tier`. |
| `scr.hardware` | Hardware Monitor popover: `.cpu`, `.ram`, `.procmem`, `.disk`, `.gpu`, `.workload`. |
| `scr.project.new` / `.open` / `.settings` / `.recover` | Project dialogs; settings has `.name`, `.fps`, `.ratio`, `.resolution`, `.duration.policy`, `.output.folder`. |
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
| `sys.live` | Visually hidden ARIA live region for status announcements. |

## Assumptions where the mockup does not define behaviour

1. The mockup shows only Design mode of the Library Panel; Home and Tools modes are derived from the yellow cards.
2. The cloud icons are repurposed to local Backup/Restore because Expertmotion has no cloud.
3. The avatar is licence status because Expertmotion has no user accounts.
4. "480p" in the mockup is treated as the draft preview quality, not an export preset (Master Project Prompt §13 lists 720p as the smallest export preset).
5. The three timeline rows in the mockup become five Tracks (video, overlay, text, caption, audio).
6. Chat footers show the per-agent model and context usage; the top Model Bar shows the default Provider Connection.
