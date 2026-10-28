# Editor Interaction Model

| Field | Value |
|---|---|
| Status | baseline |
| Owner | UI/UX lead + AI agent architect |
| Last updated | 2026-10-26 |
| Depends on | MASTER_PROJECT_PROMPT.md §16, GLOSSARY.md, ELEMENT_IDS.md, UXRD.md, USER_FLOWS.md, AI_WORKFLOW.md (§3–§7, §12), DESIGN_CATALOGUE.md, PERFORMANCE.md, ARCHITECTURE.md §5 |
| Used by | UI_UX_SPECIFICATION.md, FRD.md, TEST_PLAN.md, GOLDEN_SCENARIOS.md, ERROR_CATALOGUE.md |
| Owner of | the ten-point interaction spec per UI action, selection model, keyboard shortcuts, drag-and-drop rules, panel resize/collapse rules, responsive rules, focus management |
| ID range | IX-01 … IX-40 (interaction ids used by TEST_PLAN) |

## 0. How to read

Every significant action gets the ten points required by the brief §16, in a fixed-row table:

| # | Point | Meaning here |
|---|---|---|
| 1 | User action | The gesture, with element id(s) and shortcut |
| 2 | Application response | Immediate UI feedback (≤ 100 ms) before any server round trip |
| 3 | Structured edit intent | `category / propertyKey / propertyClass` of the Edit Intent created, or **none** |
| 4 | Agent involvement | none · Compile (deterministic) · Editor Agent · Brainstorming Agent |
| 5 | State changes | Intent Queue, plan, Composition Version, settings, selection |
| 6 | Preview updates | What the Player does |
| 7 | Timeline updates | What the Timeline View does |
| 8 | Persistence | What is written, when (checkpoint ≤ 10 s, PRD-003) |
| 9 | Error handling | `EM-` range + meaning (ERROR_CATALOGUE.md owns codes) and where the error is shown |
| 10 | Undo / recovery | How the Creator reverses it |

Copy EN / ID appears where the action produces a new string. Property keys follow AI_WORKFLOW.md examples (`cut:3.transition`, `project.captionStyle`, `clip:abc.effects`, `text:xyz.fontSize`, `theme.textDefaults.fontSize`, `project.ratio`).

```
Creator gesture ─► (2) optimistic UI ─► POST intent ─► (3) typed intent ─► (4) Compile | Editor Agent
      ▲                                                         │
      │                                     intent.updated / plan.ready / composition.updated (SSE)
      └──────────── (10) undo = move head to previous version ◄─┘ (5)(6)(7)(8)
```

## 1. Library Panel actions

### IX-01 Catalogue Card hover

| # | Spec |
|---|---|
| 1 | Pointer enters `lib.catalogue.card` (or keyboard focus lands on it) for ≥ 150 ms. |
| 2 | Card raises (shadow, 120 ms); `lib.catalogue.card.thumb` loop plays; after 150 ms the Editor asks the Player to show the preset on the Creator's current Composition Version (ADR-011): transitions preview around the nearest Cut, captions/backgrounds/effects on the frame under the playhead, motion/shapes/text on the element under the playhead or a sample. Tooltip after 400 ms: label EN, params summary, flags ("Slower without GPU" / "Lebih lambat tanpa GPU"). |
| 3 | none. |
| 4 | none. |
| 5 | Transient `previewPreset` in Editor memory only. |
| 6 | Player enters "Previewing Fade" / "Mencoba Pudar" overlay chip; plays a 2 s loop; restores the real frame on pointer leave (≤ 300 ms budget, PERFORMANCE.md §5). With no Clip: neutral sample with label "Sample · insert a clip to preview on your video" / "Contoh · sisipkan klip untuk melihat di video kamu". |
| 7 | None; the affected Cut/element is outlined with a dashed accent while hovering. |
| 8 | None. |
| 9 | Preview render error → Player shows the last real frame and a 2 s inline note "Preview unavailable for this preset" / "Pratinjau tidak tersedia untuk preset ini" (`EM-2xxx`, composition preview); never a toast. |
| 10 | Not applicable; nothing changed. |

### IX-02 Catalogue Card click, per category

| # | Spec |
|---|---|
| 1 | Click or Enter on `lib.catalogue.card`. |
| 2 | Card gets `.selected`; a chip flies to the Intent Queue (200 ms); Intent Queue item appears in state S1 immediately (optimistic), replaced by the server item on `intent.updated`. |
| 3 | Per category: **transition** `transition / cut:<n>.transition / exclusive-group`; **caption** `caption / project.captionStyle / exclusive-group`; **background** `background / project.background / exclusive-group`; **motion** `motion / <element>.motion / exclusive-group`; **shape** `shape / project.shapes / list`; **easing** `easing / theme.easing or <element>.motion.easing / scalar`; **effect** `effect / <element>.effects / list`; **audio** `audio / project.audioBed or audio:<id>.ducking / list or exclusive-group`. Target per AI_WORKFLOW.md §4. A multi-target result (e.g. all Cuts) is stored as one parent intent plus one child per Cut with `parentIntentId` (`cut:0.transition`, `cut:1.transition`, … in data; "cut 1", "cut 2" in copy); a later pick on one Cut supersedes only that child (AI_WORKFLOW.md §6). |
| 4 | Compile when fully specified (all P0 presets with defaults). Editor Agent only when Target Resolution cannot settle (e.g. motion with nothing selected and no Clip under the playhead → reject instead, `EM-2201`). |
| 5 | Intent `queued` → `compiled`; same-key intents `superseded`; new Composition Version; `hdr.title.dirty`. |
| 6 | Player reloads the new version and seeks to the first affected time (first affected Cut, element start, or stays for project-wide picks). |
| 7 | New/changed `stage.timeline.element.*` pulse once; transitions appear on Cuts; project-wide picks (caption style, background) show on their Track header. |
| 8 | Intent, ops and version written in one transaction before `composition.updated`; checkpoint within 10 s. |
| 9 | Catalogue validation → `EM-2xxx` inline under the Intent Queue item ("Needs a clip" / "Perlu klip"); hardware gating → `EM-2xxx` "Up to 2 effects per element on this PC" / "Maksimal 2 efek per elemen di PC ini"; model missing → `EM-7xxx` prompt to Model Manager; preset licence-excluded → never shown. |
| 10 | Ctrl+Z or the toast Undo moves the head to the previous version; the Intent Queue item shows "undone" / "dibatalkan" and can be re-applied with Restore. |

### IX-03 Text Panel pick (font, size, weight, colour, align, variant, effect, opacity)

| # | Spec |
|---|---|
| 1 | Change a control in `lib.text.*` (click, keyboard, or numeric input + Enter). |
| 2 | Control shows the new value; Intent Queue item optimistic; if no Text Layer is selected a small caption under the control reads "applies to new text" / "berlaku untuk teks baru". |
| 3 | `text / text:<id>.<field>` (selected) or `theme.textDefaults.<field>` (nothing selected) / `scalar`; variant → `text:<id>.variant / exclusive-group`; effect → `text:<id>.effect / exclusive-group`; opacity → `<element>.opacity / scalar` for the selected element. |
| 4 | Compile, always (brief §16 "selecting a known font size should create a typed operation directly"): `op:text.setStyle` for the selected Text Layer, `op:theme.setTextDefaults` when nothing is selected. |
| 5 | Scalar supersede within the key; one Composition Version per pick, coalesced when picks arrive < 2 s apart (one version, several ops; one Intent Queue item each). |
| 6 | Player updates the selected Text Layer in place; for Theme defaults no visible change until Add Text. |
| 7 | Selected text element pulses; nothing for Theme defaults. |
| 8 | As IX-02. |
| 9 | `fitText` shrink → `warn` note on the item "Shrunk to 84 to fit the frame" / "Diperkecil ke 84 agar muat di bingkai"; invalid numeric (e.g. size 2) → inline field error, no intent. |
| 10 | Ctrl+Z; Restore on the superseded item re-queues the older value. |

### IX-04 Add Text

| # | Spec |
|---|---|
| 1 | Click `lib.text.add`, type in `lib.text.add.input` (text + variant) and confirm with `lib.text.add.confirm` (Enter in the field). |
| 2 | Field clears; new Text Layer appears selected; inspector opens. |
| 3 | `text / text:new / list` with `params {text, variant, atMs: playhead, durationMs: 3000, position: variant default}`. |
| 4 | Compile when text is present. Empty text → `needsInterpretation: true` → Editor Agent proposes copy (F6.E1); disabled with hint when no provider is configured. |
| 5 | New Text Layer id; selection = new layer; version. |
| 6 | Player seeks to `atMs` and shows the text with the variant's default motion. |
| 7 | `stage.timeline.element.text` added at the playhead on a `stage.timeline.lane.layer` row: the layer just in front of everything it overlaps (ADR-027 lane rule). |
| 8 | As IX-02. |
| 9 | Beyond total duration → trimmed + `warn` "Shortened to end of video" / "Dipersingkat sampai akhir video"; text > 200 chars → field error "Keep it under 200 characters" / "Maksimal 200 karakter". |
| 10 | Ctrl+Z removes the layer (previous version); `op:text.remove` via inspector asks confirmation (UX-015). |

### IX-05 Asset drop / import

| # | Spec |
|---|---|
| 1 | Drop files on `lib.assets.drop`; or click the panel; or `hdr.menu.file.import`; or `lib.text.insert.image` / `.insert.video` (Home). |
| 2 | Drop target highlights on drag-over with "Drop to import" / "Lepas untuk mengimpor"; cards appear instantly in `.state.ingesting` with a step label. |
| 3 | none at import (an Asset is not a Composition change). `lib.text.insert.*` additionally creates `asset / sequence.clips / list` → Insert at playhead after ingest. |
| 4 | none. |
| 5 | Asset rows + files; no Composition Version. |
| 6 | None. |
| 7 | None. |
| 8 | File copied to `media/<projectId>/<assetId>/`, DB row, probe/proxy/thumbnail/waveform written as produced (`ingest.progress` per stage, then `ingest.done`). |
| 9 | `EM-1xxx`: unsupported type/codec, damaged file, too large (limit in ASSET_INGESTION.md), duplicate (info). Shown on the card (`.state.unsupported`) and in `lib.assets.error` when more than one fails. `EM-6xxx` disk full. |
| 10 | Remove card (asks only if the Asset is used by a Clip: "beach.mp4 is in the timeline. Remove it and clip 2?" / "beach.mp4 ada di lini masa. Hapus beserta klip 2?"). |

### IX-06 Sequence Badge change

| # | Spec |
|---|---|
| 1 | Click `lib.assets.card.badge.sequence` (cycles 1…n, then none); drag a card above/below another; or type a number in the badge. |
| 2 | Badge renumbers; other badges shift to stay unique and gapless; `lib.assets.insert` label updates ("Insert 3" / "Sisipkan 3"); card auto-selects. |
| 3 | none (ordering is pre-Composition state). |
| 4 | none. |
| 5 | Editor-side `sequenceOrder` saved to project settings (not the Composition Model). |
| 6–7 | None. |
| 8 | Saved with project settings on the next checkpoint. |
| 9 | None. |
| 10 | Click to cycle back; Esc while dragging cancels. |

### IX-07 Insert

| # | Spec |
|---|---|
| 1 | Click `lib.assets.insert` (Enter when focused). |
| 2 | Button spinner (≤ 1 s); cards show "In timeline" / "Di lini masa" chip; Intent Queue item "Insert 3 clips" / "Sisipkan 3 klip". |
| 3 | `asset / sequence.clips / list` with ordered `assetIds`. |
| 4 | Compile → `op:clip.insert` × n; Auto ratio → additionally `op:output.setRatio` from the first Clip's probe. |
| 5 | Clips appended after existing Clips (MVP; insert-at-playhead is P1 with reordering); version; Export enabled. |
| 6 | Player seeks to the first new Clip. |
| 7 | New `stage.timeline.element.clip` bars; Cuts between them; empty state removed. |
| 8 | As IX-02. |
| 9 | Asset still ingesting → that asset skipped with note; Asset missing (`EM-1301`) → rejected; duration > 30 min → `EM-2xxx` block "Video would be longer than 30 minutes" / "Video akan lebih dari 30 menit". |
| 10 | Ctrl+Z removes the inserted Clips (previous version). |

### IX-08 Generator Card click (Tools; P1/P2)

| # | Spec |
|---|---|
| 1 | Click `lib.generator.card.*`. |
| 2 | Opens `scr.generate.*` as a right-side sheet over the Agent Panel (not a blocking modal); the Player keeps working. |
| 3 | On `.run`: `generate / project.generated.<kind> / list`, `needsInterpretation: false` (form is fully specified). |
| 4 | Runtime Sub-agent (whisper, sherpa-onnx, …); hashtags/caption text use the connected LLM (ADR-009) and show the model name. |
| 5 | Job rows; after `.insert`, a Plan Card with `op:generated.insert` / `op:caption.setPages` → Execute. |
| 6 | After Execute: Player shows/plays the inserted result. |
| 7 | New element on the relevant Track (`.generated`, `.caption`, `.audio`). |
| 8 | Job + result asset persisted; generated files under `media/`. |
| 9 | `EM-7xxx` (model missing, engine crash, no audio, hardware insufficient) in the sheet with a fallback action ("Use the smaller model" / "Pakai model lebih kecil"). |
| 10 | Cancel in the sheet stops the job; after Execute, Ctrl+Z. |

## 2. Stage actions

### IX-09 Timeline element select

| # | Spec |
|---|---|
| 1 | Click `stage.timeline.element`; Shift+click extends; Ctrl+click toggles; click empty lane clears; Tab/Shift+Tab cycles elements on the focused Track. |
| 2 | Element gets `.selected` outline (2 px accent); `stage.timeline.inspector` opens with the read-only property sheet; Library Panel shows a chip "Picks apply to: clip 2" / "Pilihan berlaku untuk: klip 2". |
| 3 | none. |
| 4 | none. |
| 5 | Editor selection (not persisted across restarts; see §3). |
| 6 | Player seeks to the element's start if the playhead is outside it (toggle in `stage.player.menu`). |
| 7 | Outline; adjacent Cuts highlighted for Clips. |
| 8 | None. |
| 9 | None. |
| 10 | Esc clears selection. |

### IX-10 Inspector "Ask Editor Agent to change"

| # | Spec |
|---|---|
| 1 | Click the shortcut in `stage.timeline.inspector` (or press `A` with an element selected). |
| 2 | `agent.chat.composer` focuses with a target chip "clip 2 · beach.mp4" and a prefilled stem "Change clip 2: " / "Ubah klip 2: ". |
| 3 | Created only on send: category inferred by the Rewrite step from the instruction, target `clip:<id>`, `needsInterpretation: true`. |
| 4 | Editor Agent (IX-14). |
| 5–8 | As IX-14. |
| 9 | As IX-14. |
| 10 | Esc removes the chip and stem. |

### IX-11 Player transport (play/pause, scrub, frame-step, fullscreen, menu)

| # | Spec |
|---|---|
| 1 | Space / `stage.player.controls.play`; drag `.scrubber`; ←/→ frame; Shift+←/→ 1 s; Home/End start/end; `.fullscreen`; `stage.player.menu` items (safe area, Draft/Full quality, loop, mute). |
| 2 | Immediate (≤ 50 ms toggle, ≤ 100 ms seek). |
| 3 | none. |
| 4 | none. |
| 5 | Playhead in Editor memory; menu toggles in settings.json. |
| 6 | Player state. |
| 7 | `stage.timeline.head` follows; ruler auto-scrolls to keep the playhead visible. |
| 8 | Player menu toggles only. |
| 9 | Media error → `stage.player.state.error` `EM-1xxx` with "Rebuild preview" / "Bangun ulang pratinjau". |
| 10 | Not applicable. |

### IX-26 Timeline drag, trim and lane change (texts, images, shapes, audio; ADR-027, FR-068)

| # | Spec |
|---|---|
| 1 | Pointer: drag a `stage.timeline.element` with `data-editable` (text, image, shape, audio) to move it in time and up/down across lanes (one `ROW` = 36 px per lane); drag a `stage.timeline.element.handle` (left / right 6 px) to trim. Drop on `stage.timeline.lane.new` to open a new lane (in front of all layers, or a new audio lane). Snapping: to the playhead and to other items' edges within 8 px (`stage.timeline.snap` guide), otherwise to the frame grid; hold **Alt/Option** to disable snapping. Esc cancels the drag. Keyboard (bar focused): ←/→ one frame, Shift+←/→ one second, Alt+↑ / Alt+↓ one lane up / down. Video Clips keep FR-068 reorder/trim (no lane change). |
| 2 | While dragging: the bar dims, `stage.timeline.ghost` shows the target row, start time and length; the target row gets the 2 px accent inset outline; the drag threshold is 4 px. On drop the bar moves at once (optimistic queue receipt). |
| 3 | category text, shape, audio or asset (image) / `<kind>:<id>.timing` (joined with `<kind>:<id>.layer` when the lane changes) or `<kind>:<id>.layer` (lane / layer key only) / scalar, `source: ui`, pick field `elementEdit`. |
| 4 | Compile (no LLM): `op:element.setTiming {atMs, durationMs, trimBeforeMs? (audio left edge), layer?}` or `op:element.setLayer {layer}` / `{move}`. The model applies the lane rule: a busy lane sends the item to the lane above (or a new lane inserted there); lanes stay dense. |
| 5 | One Intent Queue item ("Move or trim", "Move to layer 3", "One layer up" / "Pindah atau pangkas", "Pindah ke lapisan 3", "Naik satu lapisan"), executed; one Composition Version per gesture or key press; the Creator's own later drags supersede it. |
| 6 | Player shows the new timing and stacking at the current frame (same `ExpertmotionTimeline` as export). |
| 7 | Rows are rebuilt from layers: top row = front-most layer; the element stays selected and keeps keyboard focus after a lane change. |
| 8 | As IX-02 (version row, autosave checkpoint). |
| 9 | Audio past its source (not looping) → `EM-2306` toast and nothing applied (the drag already clamps to the source); an element removed meanwhile → `EM-2203`; a no-op drag sends nothing. |
| 10 | Ctrl+Z restores the previous version (timing and layers together). |

### IX-27 Canvas transform on the Player (clips, images, shapes; ADR-028, FR-180)

| # | Spec |
|---|---|
| 1 | Pointer, with one clip, image or shape selected and playing at the playhead: `stage.player.canvas.box` shows its picture's box (rotated with it). Drag inside the box = move; drag a corner `stage.player.canvas.handle` (`nw/ne/se/sw`) = scale with the opposite corner fixed, **Shift** = keep the centre; drag the top handle (`rotate`) = rotate, **Shift** = snap to 0 / 90 / 180 / 270°; double-click the box = reset (centred, 100 %, 0°); Esc cancels a running gesture (and only the gesture). Snap guides (`stage.player.canvas.guide`): the centre snaps to the frame centre lines and the bounding box to the frame edges within 6 screen px; **Alt** turns snapping off. Drag threshold 3 px; clicks outside the box still play / pause. Keyboard / exact values: the inspector fields (`stage.timeline.inspector.transform.*`: X / Y in % of the frame, Scale %, Rotation °, Enter applies, Esc reverts; Fit, Fill, Reset; align centre / top / bottom / left / right). |
| 2 | While dragging the Player shows the new picture live (optimistic local transform of the shown model, never sent; `data-gesture` on the box); after release the box keeps the new picture until the new Composition Version arrives. |
| 3 | category asset (clip, image) or shape / `<kind>:<id>.transform` / scalar, `source: ui`, pick field `transformEdit {kind, id, x, y, scale, rotation}` (all four values, so the newest full state wins on supersession). |
| 4 | Compile (no LLM): `op:element.setTransform {x, y, scale, rotation}`; x / y are fractions of the frame, scale 1 = the fit result (clip) or the stored size (image / shape), rotation in degrees. |
| 5 | One Intent Queue item "Position, zoom or rotation" / "Posisi, zoom atau rotasi", executed; one Composition Version per gesture or field change; toast "Move / Zoom / Rotate / Reset Clip 1" with Undo. |
| 6 | Player shows the transformed picture inside the frame (overflow hidden); export renders the same CSS (`clipTransformStyle` / `overlayTransform`, one function for both). |
| 7 | The element stays selected; the inspector fields show the new values. |
| 8 | As IX-02 (version row, autosave checkpoint). |
| 9 | Element removed meanwhile → `EM-2203`; scale outside 10 %–1000 % (clip) / 5 %–2000 % (image, shape) is clamped by the handles and fields; a gesture that changes nothing sends nothing. |
| 10 | Ctrl+Z restores the previous version. |

### IX-28 Split at the playhead (scissors, S; ADR-028, FR-179)

| # | Spec |
|---|---|
| 1 | `stage.timeline.split` (scissors in the Timeline header) or **S**: splits every selected clip, text, image, shape or audio layer that plays at the playhead (at least 100 ms from both its edges); with nothing splittable selected, the clip under the playhead. While playing, the live playhead is used. |
| 2 | No dialog; the Timeline shows two bars at once after the version arrives. Nothing at the playhead → info toast "There is no clip under the playhead to split." / "Tidak ada klip di bawah playhead untuk dipotong."; a selection that does not play there → "The selected item does not play at the playhead…" / "Item yang dipilih tidak diputar di posisi playhead…"; nothing is sent. |
| 3 | category by kind (asset when mixed) / `list:split:<kind>:<id>:<atMs>:<unique>` per item (a split never supersedes another pick and is not a Locked Key) / list, `source: ui`, pick field `splitEdit {atMs, items}`; several items = one parent with one child per item (expansion rule). |
| 4 | Compile (no LLM): `op:element.split {atMs}` per item, all in ONE plan and ONE Composition Version. The first part keeps the id; the second part continues the source (clip `trimBeforeMs + d × playbackRate`, audio `trimBeforeMs + d`); the transition after a clip moves to the second part; transitions next to a shortened part are re-clamped (EM-2305 warn). |
| 5 | One Intent Queue item "Split at the playhead (n)" / "Potong di playhead (n)", executed; toast "Split 2 items at 00:02.00" with Undo. |
| 6 | Player unchanged at every frame (the parts play back to back). |
| 7 | The selection keeps the first parts (their ids are unchanged). |
| 8 | As IX-02. |
| 9 | `EM-2201` (nothing at the playhead, from a stale client), `EM-2203` (item gone). |
| 10 | Ctrl+Z restores the previous version (every split of the press at once). |

### IX-29 Delete Timeline items (Delete / Backspace, inspector, menu; ADR-031, FR-192)

| # | Spec |
|---|---|
| 1 | Delete or Backspace with focus outside an input / textarea / contenteditable (and no dialog open), `stage.timeline.inspector.delete`, or `stage.itemmenu.delete`: deletes every selected clip (media or scene), text, image, shape, audio layer, transition (cut), clip effect, the project background and caption pages. |
| 2 | No dialog (CapCut behaviour, Operator 2026-10-26; Undo is one key away). The selection is cleared at once after the version arrives, the inspector closes, and the selection chips and pointed chips of the deleted items leave the chat composer. A selection with nothing deletable (e.g. only the playhead) → info toast "This item can't be deleted here." / "Item ini tidak bisa dihapus di sini.". |
| 3 | category by kind (asset when mixed) / `list:remove:<kind>:<id or index>:<unique>` per item (never supersedes, never a Locked Key) / list, `source: ui`, pick field `itemsEdit {action: 'remove', items}`; several items = one parent with one child per op (expansion rule). |
| 4 | Compile (no LLM, `removalSteps`): `op:transition.clear`, `op:effect.remove`, `op:background.clear`, ONE `op:caption.setPages` without the selected pages, `op:text.remove` / `op:overlay.remove` / `op:shape.remove`, `op:audio.remove`, `op:clip.remove` last — all in ONE plan and ONE Composition Version. A deleted scene clip takes its own texts / images / shapes with it (items fully inside its window); later scenes and their items close the gap (scene anchoring, ADR-031). An effect of a clip deleted in the same pick is dropped with the clip. |
| 5 | One Intent Queue item "Delete (2)" / "Hapus (2)", executed; toast "Deleted 2 items" / "2 item dihapus" with Undo. |
| 6 | Player shows the new version. |
| 7 | The bars disappear; later clips move left (the Sequence closes the gap; transitions next to a removed clip merge or drop as `op:clip.remove` defines). |
| 8 | As IX-02. |
| 9 | `EM-2203` (every item already gone, e.g. after an agent plan), `EM-2201` (nothing listed). |
| 10 | Ctrl+Z restores every deleted item of the press at once. |

### IX-30 Item context menu (right-click, Shift+F10, ContextMenu key; ADR-031, FR-193, FR-194)

| # | Spec |
|---|---|
| 1 | Right-click a Timeline bar, or Shift+F10 / the ContextMenu key on a focused bar, or right-click the selected element's box on the Player (`stage.player.canvas.box`). An unselected bar becomes the selection first; a bar inside the selection acts on the whole selection. |
| 2 | `stage.itemmenu` (role menu) at the pointer (at the bar for the keyboard): **Delete** / **Hapus** (Del), **Split at playhead** / **Belah di playhead** (S; disabled "Move the playhead onto the item first." / "Geser playhead ke item ini dulu." when the playhead is not ≥ 100 ms inside), **Duplicate** / **Duplikat** (disabled for audio, captions, transitions, effects and the background), **Ask Editor Agent** / **Tanya Editor Agent** (disabled in Private Mode). Focus goes to the first available entry; ↑ / ↓ / Home / End move; Enter / Space run; Esc, Tab or a click outside close it and return focus to the bar (Esc does not clear the selection). |
| 3 | Delete = IX-29; Split = IX-28; Duplicate = `list:duplicate:<kind>:<id>:<unique>` per item, pick field `itemsEdit {action: 'duplicate', items}`; Ask = none (chips only). |
| 4 | Duplicate: Compile (no LLM, `duplicationSteps`): a text / image / shape copy (`op:text.add` / `op:overlay.addImage` / `op:shape.add` with the content, variant, style, position, size, fill / stroke, motion preset, opacity) starts where the original ends (lane rule picks the lane); a media clip copy is `op:clip.insert {assetId, atIndex: i + 1, trimBeforeMs, durationMs}`; a scene clip copy is `op:scene.add {durationMs, background, backgroundParams, atIndex: i + 1}` plus copies of its own texts / images / shapes at the same offsets. One version. Not copied (no add op takes them): clip volume, fades, motion, effects, framing (transform); item zoom / rotation; text effects; audio layers cannot be duplicated (no op keeps trim / length / loop). Ask: the items become chips (`agent.chat.target`), the chat switches to Edit and the composer gets focus; the next Edit message carries them as `targets` (R-081). |
| 5 | Duplicate: Intent Queue item "Duplicate (1)" / "Duplikat (1)", executed; toast "Duplicated 1 item" / "1 item diduplikat" with Undo. |
| 6 | Player shows the new version. |
| 7 | The copies appear after the originals; later scene clips and their items move right. |
| 8 | As IX-02. |
| 9 | `EM-2201` (nothing duplicable), `EM-2203` (item gone), `EM-2102` (a copied value outside the add op's range, e.g. a hand-made model). |
| 10 | Ctrl+Z removes every copy of the action at once. |

### IX-31 Move the playhead from anywhere on the Timeline (FR-253, FR-254; QA 2026-10-28 #6)

| # | Spec |
|---|---|
| 1 | Press + drag the playhead line `stage.timeline.head` anywhere along its height (12 px grab zone, pointer capture), press / drag on the sticky ruler `stage.timeline.ruler`, or press / drag on empty track space (a lane or track row, not a bar). **Alt+click** on a bar seeks to the click point and leaves the selection unchanged. Keyboard: focus the playhead (Tab, `role="slider"`) or anywhere outside text fields: ←/→ one frame, Shift+←/→ one second, Home / End. |
| 2 | The Player follows live (one seek per animation frame while dragging; the release applies the exact last position). A plain press on empty track space also clears the selection; Shift or Ctrl / ⌘ keep it. The ruler with the playhead marker stays at the top of `stage.timeline.scroll` while the lanes scroll; lane names stay at the left. |
| 3 | No Edit Intent (UI state only). |
| 4 | — |
| 5 | — |
| 6 | The Player shows the frame at the new time. |
| 7 | The playhead line and the ruler marker move; `data-scrubbing` on the line while dragging. |
| 8 | Esc does not apply (no change to cancel); a pointer cancel ends the scrub at the last position. |
| 9 | — |
| 10 | n/a (the playhead position is saved per project as before). |

### IX-32 Copy / Cut / Paste Timeline items (FR-255, FR-256; QA 2026-10-28 #5)

| # | Spec |
|---|---|
| 1 | Item menu (`stage.itemmenu.copy` / `.cut` / `.paste`) or Ctrl+C / Ctrl+X / Ctrl+V (⌘ on macOS) with focus outside text fields and no text selected on the page. Right-click on empty track space opens the menu with only Paste. |
| 2 | Copy: toast "Copied 2 items" / "2 item disalin" (with a note when captions, transitions, effects or music beds were left out); nothing is sent to the Local Service. Cut: Copy + IX-29 Delete. Paste: at the playhead (live Player time). Empty clipboard → info toast "Nothing copied yet…" / "Belum ada yang disalin…". The clipboard is in-app (never the OS clipboard), lives for the Editor window session and works across projects (an Asset that is not in the target project blocks the pick). |
| 3 | Paste: category asset / `list:paste:project:<n>:<unique>` per entry (never supersedes, never a Locked Key) / list, `source: ui`, pick field `itemsEdit {action: 'paste', items: [], paste: {atMs, entries}}` (≤ 50 entries, ≤ 64 KB, each entry carries only the add op of its kind). |
| 4 | Compile (no LLM, `pasteSteps`): clips (`op:clip.insert` / `op:scene.add` with `atIndex`) first, inserted one after the other at the cut at / after the playhead (inside a clip → after it), then `op:text.add` / `op:overlay.addImage` / `op:shape.add` / `op:audio.addLayer` at the first clip's start + offset (no clips: playhead + offset); ONE plan, ONE Composition Version. |
| 5 | One Intent Queue item "Paste (2)" / "Tempel (2)", executed; toast "Pasted 2 items" / "2 item ditempel" with Undo. |
| 6 | Player shows the new version. |
| 7 | The pasted bars appear (overlapping texts / images / shapes on free lanes); later scene clips and their items move right. |
| 8 | As IX-02. |
| 9 | `EM-2201` (empty clipboard), `EM-2102` / `EM-2203` (a value or Asset the project does not accept), 400 for a malformed clipboard. |
| 10 | Ctrl+Z removes the whole paste at once (Cut: Ctrl+Z restores the deleted items). |

## 3. Agent Panel actions

### IX-12 Brainstorm send

| # | Spec |
|---|---|
| 1 | Type in `agent.chat.composer`, press Enter or `.send` (Shift+Enter = newline); optional `.attach` (Asset or image). |
| 2 | User bubble appended; composer clears but keeps the text in a recoverable buffer until the reply succeeds; status line "Asking <model>…" / "Bertanya ke <model>…" with Cancel; `.footer.ctx` updates after the reply. |
| 3 | none directly. A handoff later produces intents with `source: brainstorm`. |
| 4 | Brainstorming Agent (read-only tools only). |
| 5 | Thread message rows; usage record; optional handoff card (`agent.brainstorm.handoff`). |
| 6–7 | None (the Brainstorming Agent never mutates). |
| 8 | Messages and usage persisted per project. |
| 9 | `EM-41xx` timeout/rate limit, `EM-43xx` schema, `EM-42xx` budget: system bubble with "Try again" / "Coba lagi" and "Switch model" / "Ganti model"; composer restored. Private Mode: composer disabled with inline note (UX-024). Attachment to a non-vision model: blocked before send. |
| 10 | Cancel aborts the request (no usage beyond what the provider bills for the partial call; shown as "cancelled"). Messages can be deleted from the thread (local only). |

### IX-13 Handoff accept / dismiss

| # | Spec |
|---|---|
| 1 | On `agent.brainstorm.handoff`: untick rows, click "Apply to video" / "Kerjakan di video" or "Dismiss" / "Abaikan". |
| 2 | Card collapses to a one-line receipt "Sent 3 to Editor Agent" / "3 dikirim ke Editor Agent"; Editor Chat scrolls into view with a system bubble. |
| 3 | One intent per ticked row, `source: brainstorm`; fully specified rows `needsInterpretation: false`. |
| 4 | Compile for the specified rows; one Editor Agent run for the rest (batched into a single plan). |
| 5 | Intent Queue grows; versions for compiled rows; plan `draft` → `valid`. |
| 6–7 | Compiled rows refresh the Player/Timeline immediately; the plan waits for Execute. |
| 8 | Intents persisted; handoff decision persisted on the brainstorm message. |
| 9 | Invalid preset id → row greyed "Not available in this version" / "Tidak tersedia di versi ini"; rest proceed. |
| 10 | Dismiss is reversible: the card stays in the thread collapsed with "Show again" / "Tampilkan lagi". Compiled rows: Ctrl+Z. |

### IX-14 Editor send

| # | Spec |
|---|---|
| 1 | Type in `agent.chat.composer`, Enter or `.send`; or click `agent.editor.plan` to plan the queued intents without a message; optional target chip (IX-10). |
| 2 | User bubble; "Asking <model>…" with Cancel; Execute disabled while planning. |
| 3 | `chat`-sourced intent: category inferred by Rewrite (or `layout`/`text`/… when the Creator used the inspector chip), `propertyKey` set by the plan validator per op, `needsInterpretation: true`. |
| 4 | Editor Agent: Rewrite envelope with queued intents, Locked Keys, capabilities → `EditPlan` → validation → dry run. |
| 5 | Plan `draft` → `valid` / `invalid` / `stale`; Intent Queue items referenced become `planned`. |
| 6 | None until Execute. Optional "Preview plan" (P1) renders the dry-run version into the Player with a "Preview only" chip. |
| 7 | None until Execute. |
| 8 | Message, plan, validation and usage persisted. |
| 9 | `EM-41xx`/`EM-43xx`/`EM-42xx` as IX-12; `touchesLockedKeys` → one re-prompt, then dropped with a risk row; 409 when a run is already in progress → "The Editor Agent is still working on the previous request" / "Editor Agent masih mengerjakan permintaan sebelumnya"; stale or invalid plan → `agent.editor.plancard.replan` re-plans against the current version. |
| 10 | Cancel (IX-16); a plan can be discarded ("Discard plan" / "Buang rencana") without any state change. |

### IX-15 Execute

| # | Spec |
|---|---|
| 1 | Click `agent.editor.execute` or Ctrl+Enter while focus is outside a text field (inside a chat composer Ctrl+Enter sends the message, FR-153); applies only when plan `valid` and `baseVersion` = head. On a stale plan (the Creator or another pick changed the Timeline after it was made, FR-195) Execute stays enabled but never applies it: toast "Timeline changed — re-planning" / "Timeline berubah — rencana disusun ulang", a new plan is made on the current head (R-070 with the new `baseVersion`; the old plan stays `stale`) and needs its own Execute. |
| 2 | Plan Card badge → "Executing…" / "Menjalankan…" (S3), Execute replaced by progress, `agent.editor.cancel` enabled; steps tick as they complete. |
| 3 | none new; executes the plan's intents. |
| 4 | Runtime only: `composition.applyOps` (not callable by the model); sub-agent steps (captions, tts) run as plan steps. |
| 5 | Transaction at `baseVersion` → new version; intents `executed`; plan `executed`; `hdr.title.dirty`. Idempotent by `planId`. |
| 6 | Player reloads the new version; seeks to the first diff element. |
| 7 | Elements in `ExecutionResult.diff` pulse (added = accent, modified = accent-2, removed = fade out 200 ms). |
| 8 | Intents, plan, ops, result, usage in one transaction (AI_WORKFLOW.md §2 step 14). |
| 9 | Mid-transaction failure → SQLite rollback, badge "Not applied · EM-2xxx" / "Tidak diterapkan · EM-2xxx" with Details; stale → 409 EM-2301 (also when the head moved between the click and the transaction), badge "Composition changed; re-plan" / "Komposisi berubah; susun ulang" and the automatic re-plan of point 1 (FR-195; validation is not relaxed: the Service still refuses every plan whose `baseVersion` is not the head); post-validation `block` → rollback with the rule named ("Video would be shorter than 1 second" / "Video akan kurang dari 1 detik"). |
| 10 | Toast "Applied: 3 changes · v13" / "Diterapkan: 3 perubahan · v13" with **Undo** (moves head to `fromVersion`); `hdr.action.undo` / Ctrl+Z; `hdr.action.redo` / Ctrl+Shift+Z (Ctrl+Y). |

### IX-16 Cancel (agent request or running plan)

| # | Spec |
|---|---|
| 1 | Click `agent.editor.cancel` (or the Cancel on the status line), or Esc while the chat has focus. |
| 2 | Status line "Cancelling…" / "Membatalkan…" ≤ 1 s; then "Cancelled" / "Dibatalkan". |
| 3 | none. |
| 4 | Aborts the provider stream; a running plan is rolled back at the transaction boundary (ops are one transaction, so either nothing or everything; a multi-step plan with a sub-agent job cancels the job and rolls back). |
| 5 | Plan `cancelled`; intents back to `queued`; version unchanged. |
| 6–7 | Unchanged. |
| 8 | Cancellation persisted on the plan/run. |
| 9 | If the transaction already committed when Cancel arrives, the UI shows "Already applied · Undo?" / "Sudah diterapkan · Batalkan?" (`EM-2xxx` info). |
| 10 | Re-run from the card. |

### IX-17 Intent restore / remove / clear

| # | Spec |
|---|---|
| 1 | `agent.editor.intentqueue.item.restore` on a struck-through item; `.item.remove` on a queued item; `.clear` clears all queued (not executed) items. |
| 2 | Restore: item moves to the top unstruck, the item it replaces becomes struck; Remove: item slides out (200 ms) with a 5 s toast Undo; Clear: confirmation naming the count ("Clear 4 queued picks?" / "Hapus 4 pilihan antre?"). |
| 3 | Restore sets the superseded intent back to `queued` (stamping `restoredAt`) and marks the newer intent `superseded` in turn; Remove sets the intent `removed`; Clear = Remove for each queued/superseded item. |
| 4 | Restore: Compile (or Editor Agent if it needed interpretation). |
| 5 | Versions per Compile; a `valid` plan that referenced a removed intent becomes `stale` ("re-plan"). |
| 6–7 | Compile results refresh as IX-02. |
| 8 | As IX-02. |
| 9 | Restoring an intent whose target no longer exists (Clip removed) → `EM-2xxx` "That clip is no longer in the timeline" / "Klip itu sudah tidak ada di lini masa". |
| 10 | Toast Undo for Remove; Restore is itself the undo of supersede. |

## 4. Output Settings actions

### IX-18 Ratio / Resolution / Performance Profile change

| # | Spec |
|---|---|
| 1 | Click `agent.output.ratio.*` (incl. `.custom` → `scr.ratio.custom` dialog with `.width`, `.height`, `.preview`, `.apply`, clamped 1:3…3:1), `agent.output.ratio.auto` sticky toggle (a manual ratio pick turns it off), `agent.output.resolution.*`, `agent.output.profile.*`; or `lib.text.ratio` / `lib.text.videosize` shortcuts. |
| 2 | Button active state; pixel labels under every ratio recompute from PERFORMANCE.md §3; Player frame animates to the new aspect (200 ms); `stage.player.controls.ratio`/`.res` update. Profile: Player quality switches (Draft/Full) and a one-line note "Preview: Draft" / "Pratinjau: Draft". |
| 3 | ratio: `layout / project.ratio / scalar`; resolution: `layout / project.resolution / scalar`; profile: `output / project.performanceProfile / scalar`; auto: `layout / project.ratioAuto / scalar`. |
| 4 | Compile. |
| 5 | Version for ratio/resolution (they are Composition Model fields); profile is a project setting (version not required but recorded as an intent for visibility). |
| 6 | Player re-letterboxes; `fitText` re-fits text; safe-area overlay redraws. |
| 7 | Unchanged lengths; Track headers unchanged. |
| 8 | As IX-02; profile in Project Settings. |
| 9 | Resolution above tier → `.disabled` with reason "Needs a GPU tier" / "Perlu GPU" (not an error); Turbo on T1 → allowed with warning badge; custom ratio invalid → field error. |
| 10 | Ctrl+Z (ratio/resolution); Reset to Defaults (IX-19). |

### IX-19 Reset to Defaults

| # | Spec |
|---|---|
| 1 | Click `agent.output.reset`. |
| 2 | Modal names the changes: "Reset to 16:9 · 1080p · Standard · Auto off · Private Mode unchanged?" / "Kembalikan ke 16:9 · 1080p · Standard · Auto nonaktif · Mode Privat tidak berubah?". |
| 3 | One `layout` intent per field that differs. |
| 4 | Compile. |
| 5 | One version. |
| 6–7 | As IX-18. |
| 8 | As IX-02. |
| 9 | None. |
| 10 | Ctrl+Z. |

### IX-20 Private Mode toggle

| # | Spec |
|---|---|
| 1 | Toggle `agent.output.private` (Space when focused). |
| 2 | Toggle animates; `sys.privatemode.banner` slides in (200 ms); `agent.chat.status` icon; composers disable with inline note; Model Manager/Update controls disable. |
| 3 | none (settings, not Composition). |
| 4 | none; in-flight agent runs cancelled (IX-16 semantics). |
| 5 | `settings.privateMode`; egress module flag; downloads paused. |
| 6–7 | None. |
| 8 | settings.json + DB settings immediately. |
| 9 | None. The ADR-017 telemetry open question is surfaced in Export preflight copy if unresolved. |
| 10 | Toggle off. |

## 5. Header and project actions

### IX-21 Export start / cancel

| # | Spec |
|---|---|
| 1 | `hdr.action.export` / `hdr.menu.file.export` / Ctrl+E → `scr.export`; `.start`; `.cancel`. |
| 2 | Dialog opens with preflight rows filling in (≤ 2 s); Start enabled only when no ⚠ block; on Start the dialog shows progress and the header gains `sys.render.progress`; the dialog can be closed and reopened from the chip. |
| 3 | none (`render.start` is Creator-only; agents may only suggest). |
| 4 | none. |
| 5 | Render Job `queued` → `rendering` → `done` / `failed` / `cancelled`; Output row on done. |
| 6 | Player keeps working (Draft); background ingest/download paused in Standard/Accelerated. |
| 7 | Unchanged. |
| 8 | Job rows, output file under `outputs/<projectId>/`, thumbnail. |
| 9 | Preflight `EM-3101…3104`, `EM-1301`, `EM-3001`; runtime `EM-3xxx` with Try again / Details; cancel removes partial files. |
| 10 | Cancel; re-export; failed job retains settings for one-click retry. |

### IX-22 Save / Save As / Open / New / Recent / Project Settings

| # | Spec |
|---|---|
| 1 | Ctrl+S / `hdr.action.save` / `hdr.menu.file.save`; Ctrl+Shift+S Save As; Ctrl+O Open (`scr.project.open`, with `scr.project.open.delete` per row); Ctrl+N New; `hdr.menu.file.recent`; `hdr.menu.file.settings`. |
| 2 | Save: `hdr.title.dirty` clears, toast "Saved" / "Tersimpan" (1.5 s); Save As: name dialog; Open/New with unsaved changes: modal "Save changes to 'promo-kafe'?" / "Simpan perubahan ke 'promo-kafe'?" Save / Don't save / Cancel; Settings: `scr.project.settings`. |
| 3 | Settings changes: fps → `output / project.fps / scalar`; duration policy → `output / project.durationPolicy / scalar`; others (name, output folder) none. |
| 4 | Compile for fps/duration policy. |
| 5 | Save marks the head version as saved; Save As clones the project (new id, same versions); New creates project "Untitled" with defaults; fps change re-derives frames (version). |
| 6 | fps change: Player reloads; perceived timing unchanged. |
| 7 | Ruler re-labels. |
| 8 | DB; checkpoints continue regardless of Save. |
| 9 | `EM-6xxx` write failure → toast with Retry and "Back up now"; name collision on Save As → inline. |
| 10 | Open the previous project from Recent; Recover (F9.5). |

### IX-23 Backup / Restore

| # | Spec |
|---|---|
| 1 | `hdr.action.backup` → `scr.backup` (`.backup.passphrase` default, `.backup.plain` with warning, `.backup.start`); `hdr.action.restore` → `scr.backup` (`.restore.file`, `.restore.passphrase` when encrypted, `.restore.start`). |
| 2 | Native save/open dialog; passphrase fields; `scr.backup.progress`; Restore shows a preview card (name, versions, assets, size) with the note "Restored as a new project; nothing is overwritten" / "Dipulihkan sebagai proyek baru; tidak ada yang ditimpa" before committing. |
| 3 | none. |
| 4 | none. |
| 5 | Backup: none. Restore: always a new project (DATABASE_SCHEMA.md §6; never overwrites); a same-identity project becomes "<name> (restored)" with `EM-6303`. |
| 6–7 | After restore: Player/Timeline load the restored head. |
| 8 | Zip without credentials, licence or Database Key; encrypted with an Argon2id-derived key (SECURITY.md SEC-052) unless the Creator chose plain; restore validates manifest hashes, then writes DB rows + media and re-ingests missing derived files. |
| 9 | `EM-6302` (not a backup / newer version), `EM-6305` (passphrase not accepted; nothing imported), `EM-6304` (disk), `EM-6303` (restored as a copy, info) in the dialog. |
| 10 | Delete the restored copy (Open ▸ Delete, `scr.project.open.delete`); the original project is never touched. |

### IX-24 Menu Tab switch, Catalogue Search, Project Title edit

| # | Spec |
|---|---|
| 1 | `hdr.menu.home` / `.design` / `.tools`; type in `lib.search.input` (`/` focuses it); click `hdr.title`. |
| 2 | Library Panel swaps mode (120 ms crossfade), `lib.mode.header` updates; search filters cards live (debounce 150 ms) across labels and tags EN/ID, "No matches for 'x'" / "Tidak ada hasil untuk 'x'"; title becomes an input, Enter/blur saves, Esc cancels. |
| 3 | none. |
| 4 | none. |
| 5 | Mode and last search in Editor memory (mode persisted per project). |
| 6–7 | None. |
| 8 | Title rename → DB. |
| 9 | Empty title → reverts with inline "Name cannot be empty" / "Nama tidak boleh kosong". |
| 10 | Esc. |

### IX-25 Hardware Monitor, Model Manager, Licence popover, Help items

| # | Spec |
|---|---|
| 1 | `hdr.action.hardware` → `scr.hardware` popover; `hdr.action.models` → `scr.models`; `hdr.action.license` → popover and `scr.license` (`.status`, `.machinecode`, `.machinecode.copy`, `.buy`, `.remove`, `.rebind`); `hdr.menu.help.*` → tour / diagnostics / licence / about / docs. |
| 2 | Popovers open anchored (120 ms); screens open as sheets; Esc closes; focus returns to the trigger. |
| 3–4 | none. |
| 5 | Model installs/removals (F11); licence activation (F13); tour restart. |
| 6–7 | None. |
| 8 | Model files, licence state, tour flag. |
| 9 | `EM-7xxx` models; `EM-5xxx` licence; hardware read failure → "Could not read GPU info" / "Tidak dapat membaca info GPU" (no code; informational). |
| 10 | Close. |

## 6. Selection model

| Rule | Detail |
|---|---|
| Single selection | Click selects one Timeline Element; the inspector shows it; Design Picks target it (AI_WORKFLOW.md §4 "Creator selected" column). |
| Multi selection | Shift+click range within one Track or lane; Ctrl+click toggles across Tracks; inspector shows "3 elements" with common fields; picks apply to "each selected" per Target Resolution. Cuts are selectable as thin handles between Clips (single only). |
| Playhead as implicit target | With nothing selected, motion/effect picks target the Clip under the playhead; text picks target a Text Layer under the playhead if one exists ("apply to this text" / "terapkan ke teks ini" offered). |
| Selection vs. playhead independence | Selecting does not move the playhead unless "Seek on select" is on in `stage.player.menu` (default on). |
| Clearing | Esc, a press on empty track space (which also seeks there, IX-31; Shift / Ctrl keep the selection), a Delete (IX-29), or a Composition Version that removes the element. |
| Chips | Every selected element is a chip in the chat composer at once ("Klip 2", "Adegan 1", the text's first words, an asset name); Ctrl+click / Shift+click add more chips, a chip appears once per element, and a chip whose element is gone leaves the composer (FR-194). |
| Persistence | Selection is not saved; playhead position is saved per project (restore on open). |
| Asset selection | Independent of timeline selection; `lib.assets.card.select` checkboxes; Space toggles the focused card. |
| Indicators | `stage.timeline.element.selected`; Library Panel chip "Picks apply to: …" / "Pilihan berlaku untuk: …"; inspector header. |

## 7. Keyboard shortcuts

Windows keys; `Ctrl` = `Ctrl` (macOS build P2 maps to `Cmd`). Shortcuts are listed in Help and in tooltips.

| Shortcut | Action | Scope | Element |
|---|---|---|---|
| Space | Play / pause | Editor (not in text fields) | `stage.player.controls.play` |
| ← / → | Previous / next frame (also with the Timeline playhead `stage.timeline.head` focused, IX-31); with an editable Timeline bar focused: move it one frame earlier / later (IX-26) | Editor | `stage.player.controls.scrubber`, `stage.timeline.head`, `stage.timeline.element` |
| Shift+← / → | −1 s / +1 s (Player, or the focused Timeline bar) | Editor | same |
| Alt+↑ / Alt+↓ | Focused Timeline bar one lane up / down (layer forward / back; IX-26) | Stage | `stage.timeline.element` |
| Alt (held while dragging) | Disable snapping to the playhead and edges (IX-26) and to the frame centre / edges on the Player (IX-27) | Stage | `stage.timeline.snap`, `stage.player.canvas.guide` |
| S | Split the selected item(s) — or the clip under the playhead — at the playhead (IX-28) | Stage | `stage.timeline.split` |
| Shift (held while scaling / rotating on the Player) | Scale from the centre / snap rotation to 0 / 90 / 180 / 270° (IX-27) | Player | `stage.player.canvas.handle` |
| Home / End | Start / end | Editor | same |
| J / K / L | Reverse-scrub step / pause / play (K pauses; J steps back 1 s because reverse playback is out of scope) | Editor | same |
| Ctrl+S | Save | Global | `hdr.action.save` |
| Ctrl+Shift+S | Save As | Global | `hdr.menu.file.saveas` |
| Ctrl+O / Ctrl+N | Open / New | Global | `hdr.menu.file.open` / `.new` |
| Ctrl+I | Import | Global | `hdr.menu.file.import` |
| Ctrl+E | Export | Global | `hdr.action.export` |
| Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) | Undo / redo (Composition Version head); the shortcut sheet shows Ctrl+Shift+Z (FR-153) | Global (text fields keep native undo while focused) | — |
| Ctrl+Enter | Send the chat message (FR-153) when a chat composer has focus; otherwise Execute the current plan | composer → send; global (focus outside text fields) when a valid plan exists → Execute | `agent.*.composer`, `agent.editor.execute` |
| Esc | Cancel a running Player or Timeline drag · cancel running request · close popover/modal · clear selection · exit fullscreen (in that priority) | Global | `agent.editor.cancel`, … |
| / | Focus Catalogue Search | Editor | `lib.search.input` |
| 1 / 2 / 3 | Switch to Home / Design / Tools | Editor | `hdr.menu.*` |
| Enter | Insert when Asset Panel focused and ≥ 1 selected | Library Panel | `lib.assets.insert` |
| Delete / Backspace | Delete every selected Timeline item as one undoable pick, no dialog (IX-29) | Stage (not in text fields) | `stage.timeline.inspector.delete` |
| Shift+F10 / ContextMenu | Item menu of the focused Timeline bar (IX-30) | Timeline bar | `stage.itemmenu` |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / Cut / Paste Timeline items on the in-app clipboard; Paste at the playhead (IX-32). Not in text fields and not while page text is selected (native copy / paste then) | Stage | `stage.itemmenu.copy` / `.cut` / `.paste` |
| Alt+click on a bar | Seek to the click point without changing the selection (IX-31) | Timeline | `stage.timeline.element` |
| A | Ask Editor Agent about the selection | Stage | inspector shortcut |
| F | Fullscreen Player toggle | Editor | `stage.player.controls.fullscreen` |
| Shift+? | Shortcut sheet | Global | — |
| Alt+1 / Alt+2 / Alt+3 | Focus Library Panel / Stage / Agent Panel | Global | regions |
| Ctrl+B / Ctrl+Shift+B | Collapse/expand Library Panel / Agent Panel | Global | regions |

Shortcuts never fire while a text input, textarea or contenteditable has focus, except Ctrl+S, Ctrl+Enter (composer) and Esc.

## 8. Drag-and-drop rules

| Source → target | Allowed | Effect | Rejected feedback |
|---|---|---|---|
| OS files → `lib.assets.drop` | yes | Import (IX-05) | Unsupported types listed on the card |
| OS files → `stage.player.canvas` or `stage.timeline` | yes | Import then Insert at end (video/image → Clip; audio → `op:audio.addLayer` at playhead) | Same |
| OS files → Agent composer `.attach` | images only | Attach to the message (vision models) | "Only images can be attached here" / "Hanya gambar yang bisa dilampirkan di sini" |
| Asset card → Asset card | yes | Reorder Sequence Badges (IX-06) | — |
| Asset card → `stage.timeline.track.video` | yes (P0 end-append; P1 at drop index) | Insert that Asset | Still ingesting → not-allowed cursor |
| Asset card → `stage.timeline.lane.audio` | audio assets | `op:audio.addLayer` at drop time | Non-audio → not-allowed |
| Catalogue Card → Timeline Element | yes | Same as click with explicit target (IX-02) | Category/target mismatch → not-allowed cursor + tooltip "Transitions go on cuts" / "Transisi ditempatkan di potongan" |
| Catalogue Card → Player | yes | Same as click with playhead target | — |
| Timeline Element → another position | yes (FR-068; ADR-027 Operator decision 2026-10-25) | video Clip: `op:clip.move`; text / image / shape / audio: `op:element.setTiming` (time and, when dropped on another lane, `layer`) or `op:element.setLayer` (lane only) — IX-26 | dropping a visual item on the video or audio rows (or audio on layer rows) clamps to the nearest lane of its kind |
| Element edge → trim | yes | video Clip: `op:clip.setTrim`; others: `op:element.setTiming` (audio left edge with `trimBeforeMs`) | trims stop at 100 ms and at the source end of non-looping audio |
| Picture on the Player → another place / size / angle | yes (FR-180; ADR-028 Operator request 2026-10-26) | `op:element.setTransform` on the selected clip, image or shape — IX-27 | scale clamped to the item's range; the picture is clipped by the frame |
| Panel divider | yes | Resize (§9) | — |

General: drag threshold 4 px; drop targets show a 2 px accent inset outline during drag-over; Esc cancels; keyboard alternative exists for every drop (import button, badge click, Insert).

## 9. Panel resize and collapse

| Rule | Value |
|---|---|
| Default widths (UI_UX_SPECIFICATION.md §3) | Library Panel 300 px · Stage flex · Agent Panel 420 px (360 px below 1280, 480 px from 1600; operator feedback 2026-10-25) |
| Library Panel range | 240–420 px; collapses to a 48 px icon rail (mode icons + assets icon) below 240 or via Ctrl+B |
| Agent Panel range | 320–900 px, the maximum capped so the Stage keeps its minimum width; collapses to a 48 px rail (brainstorm, editor, output icons with badges for pending plan / unread) via Ctrl+Shift+B |
| Stage minimum | 640 px wide (FR-099); Player keeps aspect inside; Timeline View height 220 px min, resizable up to 50 % of the Stage height |
| Agent Panel internal layout | Since 2026-10-26 one assistant chat (FR-181) takes the panel height above Output Settings (no outer scroll; the thread scrolls inside, the composer with the Diskusi / Edit switch stays visible; the "Your picks" strip sits above the composer in Edit mode). `agent.chat.maximize` gives the chat the whole panel (Output Settings hidden); the same toggle restores. The split with `agent.chat.divider` is retired. Output Settings is a collapsible section below the chat, collapsed by default with "16:9 · 1080p · 30 fps · Standard" in its header (`agent.output.toggle`); when open its body scrolls inside at most 55 % of the window height (FR-099) |
| Dividers | 6 px hit area, 1 px line; double-click resets to default; keyboard: focus divider, ←/→ by 16 px |
| Persistence | Widths per window size bucket (≤ 1279, 1280–1599, ≥ 1600), collapsed states, the chat split ratio, the maximized chat and the Output Settings collapsed state in settings.json (`layout`, FR-155) and the local prefs |
| Collapsed rail behaviour | Clicking a rail icon opens that panel as an overlay (not pushing the Stage) until focus leaves; pinning re-expands |

## 10. Minimum window and responsive rules

| Width | Behaviour |
|---|---|
| ≥ 1600 | Defaults; Library Panel may show 3 catalogue columns |
| 1280–1599 | Defaults (300 / flex / 420); 2 catalogue columns; minimum supported window **1280×720** (Electron `minWidth: 1280, minHeight: 720` for the main window; the Shell enforces it) |
| 1024–1279 | Library Panel collapses to the icon rail automatically; opening it overlays the Stage; Agent Panel defaults to 360 and shrinks toward 320 before the Stage would drop below 640; Output Settings keeps its header row "9:16 · 1080p · 30 fps · Standard" with expand |
| < 1024 | Not supported: a non-blocking `sys.toast` "Expertmotion works best at 1280×720 or wider" / "Expertmotion bekerja paling baik pada 1280×720 atau lebih lebar"; both side panels collapse; nothing overlaps; the Shell prevents resizing below 1024×600 |
| Height < 720 | Timeline View shrinks to 160 px and gains vertical scroll; Output Settings collapses |
| Fullscreen Player | All panels hidden; Esc or F restores |
| DPI | Layout in CSS px; 125 %/150 % Windows scaling supported; icons are SVG |

## 11. Focus management

| Situation | Rule |
|---|---|
| App start | Focus on the Project Title when the project is empty, otherwise on the Player. |
| Mode switch | Focus moves to `lib.mode.header`; the first card/control is next in Tab order. |
| Popover/modal open | Focus trapped inside; first focusable element focused; Esc closes; focus returns to the opener. Modals are `role="dialog"` with `aria-labelledby`. |
| Toast with action | Not focus-stealing; F6 cycles regions including the toast stack; the toast action is reachable via Alt+T. |
| Plan Card ready | Focus is not stolen; a live region announces "Plan ready: <goal>" / "Rencana siap: <goal>"; Ctrl+Enter (focus outside text fields) Executes when a valid plan exists. |
| Execute done | Live region announces "Applied, version 13" / "Diterapkan, versi 13"; focus stays. |
| Error inline | Focus moves to the first errored field in forms; for Intent Queue rejects the item receives focus only if the Creator's last action created it. |
| Region order (F6) | Header → Library Panel → Stage → Agent Panel → toasts. |
| Tab order inside Stage | Player controls → scrubber → Timeline ruler → Tracks (Tab between Tracks, ←/→ between elements on a Track) → inspector. |
| Timeline element focus | Roving tabindex; Enter selects; Space toggles multi-select; the inspector mirrors the focused element only on selection, not on focus. |
| Deleted element | Focus moves to the next element on the same Track, else the Track header. |

## Notes (inconsistencies observed, not fixed here)

1. `EditIntent.status` in AI_WORKFLOW.md §3 has no value for a Creator-removed intent; this document uses `rejected` with reason `creator-removed` for `agent.editor.intentqueue.item.remove`. AI_WORKFLOW.md may prefer a dedicated `removed` status.
2. ELEMENT_IDS.md lists `lib.text.variant` values "Title / Subtitle / Caption / Lower third"; DESIGN_CATALOGUE.md §10 P0 variants are Title / Subtitle / Lower third / Callout (no "Caption" variant). This document follows the catalogue.
