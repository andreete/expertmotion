# Golden Scenarios (GS-01 … GS-20): end-to-end acceptance tests and agent evals

| Field | Value |
|---|---|
| Status | baseline (expected values are the contract; fixtures marked **[TO SELECT]** are chosen in Stage 2) |
| Owner | AI agent architect + QA lead |
| Last updated | 2026-10-25 |
| Depends on | GLOSSARY.md, AI_WORKFLOW.md (§3 schemas, §4 Target Resolution, §5 ops, §6 Property Classes, §7 Compile vs Rewrite, §8 tools, §9 hand-off, §12 failures, §13 evaluation), DESIGN_CATALOGUE.md, PERFORMANCE.md, ELEMENT_IDS.md, DATABASE_SCHEMA.md (§4 Composition Model), ERROR_CATALOGUE.md, MCP_AND_TOOLING.md, PRD.md, UXRD.md §4 |
| Used by | TEST_PLAN.md, QA_PROCESS.md, AGENT_DESIGN.md, SYSTEM_PROMPT.md, POC_PLAN.md, DEFINITION_OF_DONE.md, ROADMAP.md |
| Owner of | the 20 Golden Scenarios, the fixture set, the base states B0–B3, the scenario execution harness contract (`test/fixtures/plans/GS-xx.json`) |
| ID range | GS-01 … GS-20 (scenario ids; variants are `GS-xxb`). Note: the `GS-` prefix is not yet listed in GLOSSARY.md "Identifier prefixes"; GLOSSARY.md defines the term Golden Scenario and names this file |

Each scenario is both an **acceptance test** (PRD-012 "Golden scenarios GS-01…GS-20 pass"; AI-014 Locked Keys verified by GS-09 and GS-11) and an **agent eval** (AI_WORKFLOW §13). Everything the Creator sees is given in English with an Indonesian variant (EN / ID). Terms follow GLOSSARY.md; element ids follow ELEMENT_IDS.md; `op:` names and args follow AI_WORKFLOW §5 exactly; `preset:` ids follow DESIGN_CATALOGUE.md.

## 1. Conventions used in every scenario

| Item | Convention |
|---|---|
| Times | milliseconds, as in the Composition Model. Frames = `round(ms / 1000 × fps)`. |
| Clip ids | assigned at Insert in track order: `c1`, `c2`, `c3`, … Text layers `t1`, `t2`; audio layers `a1`; overlay `o1`. |
| Cut ids | `cut:<cutIndex>` with `cutIndex` **0-based** as in `Transition.cutIndex` (DATABASE_SCHEMA §4.1). `cut:0` is between `c1` and `c2`. The Intent Queue **displays** cuts 1-based ("cut 1 of 2"). |
| Property keys | `cut:0.transition`, `clip:c2.effects`, `clip:c2.motion`, `text:t1.style.fontSize`, `project.captionStyle`, `project.captionPages`, `project.background`, `project.ratio`, `project.resolution`, `theme.textDefaults.fontSize`, `theme.textDefaults.colour`, `sequence.clips`, `project.audioBed`. |
| Multi-target intents | A pick whose Target Resolution yields N targets is stored as **one parent intent** (displayed as one Intent Queue item, N `resolvedTargets`) plus N **child intents** carrying `parentIntentId` and a per-target `propertyKey` (`cut:0.transition`, `cut:1.transition`). Conflict resolution (AI_WORKFLOW §6 expansion rule) runs on the children: a later intent supersedes only the child whose key it takes over; the parent item then shows "cut 1 replaced by Slide" and keeps its other targets; the parent is `superseded` only when all its children are. Scenario tables list the parent first and its children indented as `1a`, `1b`, …. |
| Version labels | `vB1`, `vB2`, … are symbolic labels for Composition Version hashes (real values are sha256 of canonical JSON). `+1` means "one new version after the base". |
| New element references inside a plan | An op that must reference an element added by an earlier op in the same plan uses `target: {kind, index}` (position in its track after the earlier op is applied), because ids are assigned by the runner. |
| Fault injection | Test-only environment variables read by the Local Service in test builds only: `EM_TEST_DISK_FREE_MB`, `EM_TEST_CRASH_AFTER_OP`, `EM_TEST_TIER`, `EM_TEST_KILL_CHROME_AT_PERCENT`. They are compiled out of release builds (a packaging test asserts the strings are absent). |
| Render settings column | Standard render for the 16:9 bases: ratio 16:9, 1080p (1920×1080), 30 fps, H.264 CRF 18, AAC, `imageFormat: jpeg`, Performance Profile Standard (concurrency 1), `gl` per tier (PERFORMANCE §2). Scenarios state only what differs. |
| Provider | Unless stated, the Model Assignment for both agents is the **fake provider** (`FakeProviderAdapter`, MCP_AND_TOOLING §5.1) with model id `fake-mid` (`toolCalling: true`, `contextLength: 128000`), replaying `test/fixtures/plans/GS-xx.json`. |
| Error codes | All codes are cited from ERROR_CATALOGUE.md (its copy is authoritative; copy quoted here is abbreviated). The tool-layer codes EM-4501…4507 and the egress code EM-8203 were proposed in MCP_AND_TOOLING.md §3.3.1 and are adopted in the catalogue (see §5). |

### 1.1 Fixtures

All media fixtures live in `test/fixtures/media/`. Licence: CC0 1.0 (public domain) so they can be redistributed in the repository and in the QA bundle. Concrete files are **[TO SELECT]** in Stage 2 from CC0 sources (Pexels/Pixabay items explicitly marked CC0, Wikimedia Commons CC0, Freesound CC0); the properties below are the contract that the selected files must match (re-encode with FFmpeg if necessary).

| Fixture id | File name | Kind | Duration | Dimensions | fps | Codec | Audio | Purpose | Licence / source |
|---|---|---|---|---|---|---|---|---|---|
| FX-V1 | `kota-pagi.mp4` | video | 8 000 ms | 1920×1080 | 30 | H.264 | AAC stereo, ambient + speech | long landscape clip; speech for ducking | CC0 **[TO SELECT]** |
| FX-V2 | `unboxing-hp.mp4` | video | 6 000 ms | 1920×1080 | 30 | H.264 | AAC stereo, speech | landscape clip with voice | CC0 **[TO SELECT]** |
| FX-V3 | `kopi-latte.mov` | video | 5 000 ms | 1080×1920 (portrait) | 30 | HEVC | none | transcode path (PRD-005), portrait in a 16:9 project (objectFit cover), Auto ratio source | CC0 **[TO SELECT]** |
| FX-I1 | `logo.png` | image | — | 512×512, alpha | — | PNG | — | overlay image with transparency | CC0 (drawn by Operator) **[TO SELECT]** |
| FX-I2 | `produk.jpg` | image | — | 1200×1500 | — | JPEG | — | portrait photo overlay | CC0 **[TO SELECT]** |
| FX-M1 | `bed-lofi.mp3` | audio | 30 000 ms | — | — | MP3 44.1 kHz stereo | music | music bed (loop, ducking) | CC0 **[TO SELECT]** (Freesound/Pixabay CC0) |
| FX-A1 | `narasi.wav` | audio | 7 000 ms | — | — | WAV 48 kHz mono | Indonesian voice | voice layer; source of FX-S1 | recorded by the Operator and released CC0 **[TO RECORD]** |
| FX-S1 | `narasi.srt` | subtitle | cues 0–7 000 ms | — | — | SRT, UTF-8 | 5 cues, Indonesian, matches FX-A1 | P0 caption path (`op:caption.importSrt`) | written by the Operator, CC0 |

FX-S1 content (fixed; the pages expected in GS-07 derive from it):

```
1
00:00:00,000 --> 00:00:01,400
Halo semua, hari ini kita review HP dua juta.

2
00:00:01,500 --> 00:00:03,000
Layarnya besar, baterainya awet.

3
00:00:03,100 --> 00:00:04,600
Kameranya cukup untuk konten harian.

4
00:00:04,700 --> 00:00:05,900
Harganya masih masuk akal.

5
00:00:06,000 --> 00:00:07,000
Masih layak di 2026? Kita lihat.
```

### 1.2 Base states

| Base | Definition | Head version | Duration |
|---|---|---|---|
| **B0** | New Project "GS Review HP": fps 30, ratio 16:9, 1080p, `autoRatio: false`, language `id`, theme `preset:palette.editorial-dark`, `preset:fontpair.jakarta-inter`, `preset:easing.out-cubic`, `textDefaults {fontSize 64, weight 700, colour #F4EFE6, align center, opacity 1}`; FX-V1, FX-V2, FX-V3 imported and `ready` (FX-V3 transcoded to H.264 `playable_path`); no Clips. Hardware Tier **T1**, Performance Profile Standard, licensed, Private Mode off, fake provider assigned to both agents, monthly budget unset. | `vB0` (empty model) | 0 (Export disabled: `hdr.action.export.disabled`) |
| **B1** | B0 after GS-01: `video: [c1 = FX-V3 5 000, c2 = FX-V1 8 000, c3 = FX-V2 6 000]`, no transitions. | `vB1` | 19 000 ms (570 frames) |
| **B2** | B1 after GS-02: `preset:transition.fade` 500 ms on `cut:0` and `cut:1`. Locked Keys: `cut:0.transition`, `cut:1.transition`, `sequence.clips`. | `vB2` | 18 000 ms (540 frames) |
| **B3** | B1 after GS-08: title `t1` + `preset:transition.push-cut` 400 ms on both cuts (agent-set, **not** Locked). | `vB3` | 18 200 ms (546 frames) |

## 2. Scenario index

| Id | Title | Priority | Path | Language of Creator input |
|---|---|---|---|---|
| GS-01 | Import three clips, order 2-3-1, Insert | P0 | Compile | — (UI only) |
| GS-02 | Fade with nothing selected applies to all Cuts | P0 | Compile | — |
| GS-03 | Slide on one selected Clip supersedes Fade on that Cut only | P0 | Compile | — |
| GS-04 | Text Panel: font size then colour with nothing selected (Theme default) | P0 | Compile | — |
| GS-05 | Add Text title in Indonesian fits a 9:16 frame | P0 | Compile | ID |
| GS-06 | Effects: Vignette then Film grain (list, dedupe), third effect on T0 | P0 | Compile | — |
| GS-07 | Caption style pick + SRT import (P0 caption path) | P0 | Compile | ID (SRT content) |
| GS-08 | Brainstorm "buat intro energik untuk video review HP" → handoff → Edit Plan | P0 | Editor Agent | ID |
| GS-09 | Editor chat "ganti semua transisi jadi wipe dari kiri" respects a Locked Cut | P0 | Editor Agent | ID |
| GS-10 | Stale Plan after an Insert → re-plan | P0 | Editor Agent | ID |
| GS-11 | Locked Key violation by the model → re-prompt, then drop | P0 | Editor Agent | ID |
| GS-12 | Invalid JSON from the provider → retries → EM-4301 | P0 | Editor Agent | ID |
| GS-13 | Ratio 16:9 → 9:16 with Auto off; 4K disabled on T0 | P0 | Compile | — |
| GS-14 | Export preflight failure (low disk) then success with ffprobe validation | P0 | — (render) | — |
| GS-15 | Cancel a render mid-way; partial file removed | P0 | — (render) | — |
| GS-16 | Private Mode on: agents disabled, picks still compile | P0 | Compile | ID |
| GS-17 | Crash during Execute → rollback, version unchanged | P0 | Editor Agent | ID |
| GS-18 | Budget exceeded → EM-4201 | P0 | Editor Agent | ID |
| GS-19 | Superseded intent restored | P0 | Compile | — |
| GS-20 | English: "make the captions pop and add soft music bed, duck under my voice" | P0 (with P1/P2 markers) | Editor Agent | EN |

Indonesian Creator input appears in GS-05, GS-07, GS-08, GS-09, GS-10, GS-11, GS-12, GS-16, GS-17, GS-18 (10 scenarios); English in GS-20; the rest are UI-only.

## 3. Scenarios

### GS-01 Import three clips, order 2-3-1, Insert

| Field | Value |
|---|---|
| Priority | P0 (PRD-005, PRD-006, PRD-012) |
| Preconditions | B0 **before** import: empty Asset Panel (`lib.assets.empty` visible). Tier T1, Standard, 16:9 1080p 30 fps, Auto off. |

**Creator actions**

1. Drag FX-V1, FX-V2, FX-V3 onto `lib.assets.drop` in that order.
2. Observe three `lib.assets.card` entries; FX-V3 shows `lib.assets.card.state.ingesting` ("Converting…" / "Mengonversi…") until its H.264 transcode finishes, then `lib.assets.card.meta` shows "1080×1920 · 30 fps · 0:05 · no audio".
3. Click `lib.assets.card.badge.sequence` on FX-V1 until it shows **2**; on FX-V2 until **3**; on FX-V3 until **1**.
4. Tick `lib.assets.card.select` on all three.
5. Click `lib.assets.insert`.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | asset | `params: {assetIds: [FX-V3, FX-V1, FX-V2]}` (Sequence Badge order) | `{kind: 'sequence'}` | `[{kind: 'sequence'}]` | `sequence.clips` | list | false | compiled |

Queue item copy: "Insert 3 clips · applied directly" / "Sisipkan 3 klip · langsung diterapkan".

**Expected path**: Compile (no provider call; `agent_runs` count unchanged).

**Expected Edit Plan** (origin `compile`, created and executed in one step per AI-004):

```json
{ "origin": "compile", "baseVersion": "vB0", "goal": "Insert 3 clips in Sequence Badge order",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "3 clips added; duration 0:19",
    "ops": [
      { "op": "op:clip.insert", "target": { "kind": "sequence" }, "args": { "assetId": "FX-V3", "atIndex": 0 } },
      { "op": "op:clip.insert", "target": { "kind": "sequence" }, "args": { "assetId": "FX-V1", "atIndex": 1 } },
      { "op": "op:clip.insert", "target": { "kind": "sequence" }, "args": { "assetId": "FX-V2", "atIndex": 2 } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "executed" }
```

**Expected Composition diff**: `video` gains `c1 {assetId FX-V3, trimBeforeMs 0, durationMs 5000, objectFit cover}`, `c2 {FX-V1, 8000}`, `c3 {FX-V2, 6000}`; `transitions: []`. Total duration **19 000 ms** (570 frames). New version `vB1`, `cause: 'insert'`. `hdr.action.export` enabled.

**Expected render settings**: standard (16:9 1080p 30 fps). Not rendered in this scenario.

**Edge handling**: Insert with no selection → `lib.assets.insert` disabled. Inserting an asset still `ingesting` → the Insert waits with "Waiting for conversion…" / "Menunggu konversi…" (no intent until `ready`). FX-V3 is portrait: in the 16:9 Player it is centre-cropped (`objectFit: cover`), no letterbox.

**Pass criteria**: Timeline View shows `stage.timeline.element.clip` ×3 in order FX-V3, FX-V1, FX-V2 (PRD-006 "ordered 2-3-1 insert as 1-2-3"); `stage.player.controls.duration` = "00:19.00"; one `edit_intents` row (`compiled`), one `edit_plans` row (`compile`), one new `composition_versions` row; zero provider calls; Player plays all three clips without `stage.player.state.error`.

### GS-02 Fade with nothing selected applies to all Cuts

| Field | Value |
|---|---|
| Priority | P0 (PRD-012, PRD-013) |
| Preconditions | B1. Nothing selected in the Timeline View (click `stage.timeline.ruler` empty area to clear). |

**Creator actions**

1. Click `hdr.menu.design`; `lib.mode.header` shows "Preview".
2. Click `lib.catalogue.tab` "Transitions".
3. Hover `lib.catalogue.card[data-preset-id="preset:transition.fade"]` → the Player previews the fade on the current Cut (ADR-011).
4. Click the card.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 (parent) | transition | `preset:transition.fade`, `{durationMs: 500, timing: 'linear'}` (catalogue defaults) | `{kind: 'selection'}` | `[{kind:'cut', index: 0}, {kind:'cut', index: 1}]` | `cut:*.transition` (display only; the keys live on the children) | exclusive-group | false | compiled |
| 1a (child, `parentIntentId: <1>`) | transition | same | `{kind:'cut', index: 0}` | `[{kind:'cut', index: 0}]` | `cut:0.transition` | exclusive-group | false | compiled |
| 1b (child, `parentIntentId: <1>`) | transition | same | `{kind:'cut', index: 1}` | `[{kind:'cut', index: 1}]` | `cut:1.transition` | exclusive-group | false | compiled |

The queue shows one item (the parent, AI_WORKFLOW §6 expansion rule); the children are not listed separately. Queue copy: "Transition · Fade → all 2 cuts · applied directly" / "Transisi · Pudar → semua 2 potongan · langsung diterapkan" (cut indexes are 0-based in data, 1-based in copy).

**Expected path**: Compile.

**Expected Edit Plan**

```json
{ "origin": "compile", "baseVersion": "vB1", "goal": "Apply Fade to 2 cuts",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "2 transitions added; duration 0:19 → 0:18",
    "ops": [
      { "op": "op:transition.set", "target": { "kind": "cut", "index": 0 }, "args": { "presetId": "preset:transition.fade", "durationMs": 500, "timing": "linear" } },
      { "op": "op:transition.set", "target": { "kind": "cut", "index": 1 }, "args": { "presetId": "preset:transition.fade", "durationMs": 500, "timing": "linear" } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "executed" }
```

**Expected Composition diff**: `transitions: [{cutIndex 0, fade, 500, linear}, {cutIndex 1, fade, 500, linear}]`. Total **18 000 ms** (540 frames) = 19 000 − 2 × 500 (CM-004 satisfied: 500 ≤ 0.5 × 5 000). Version `vB2`, `cause: 'compile'`. Locked Keys now `cut:0.transition`, `cut:1.transition`.

**Expected render settings**: standard; `durationInFrames` 540.

**Edge handling**: with a single Clip (no Cuts) the pick is rejected at step 4 with EM-2202 and no intent is queued (**[GAP-2]**: the EM-2202 copy "No clips yet / Insert at least one asset…" addresses zero clips; a one-clip project needs "Add a second clip first" / "Tambahkan klip kedua dulu" wording or its own code).

**Pass criteria**: two `stage.timeline.element.transition` elements; duration label "00:18.00"; `lib.catalogue.card.selected` on Fade; golden still at 4 750 ms (middle of cut 0) shows a 50 % blend of `c1` and `c2` (pixel diff ≤ 1 % against the reference frame); no provider call; the `edit_intents` rows are one parent and two children with `parentIntentId` set.

### GS-03 Slide on one selected Clip supersedes Fade on that Cut only

| Field | Value |
|---|---|
| Priority | P0 (PRD-012; AI_WORKFLOW §4 row "transition / Creator selected a Timeline Element") |
| Preconditions | B2. |

**Creator actions**

1. Click `stage.timeline.element.clip[data-element-id="c1"]` → `stage.timeline.element.selected`; `stage.timeline.inspector` shows FX-V3.
2. In Design ▸ Transitions click `lib.catalogue.card[data-preset-id="preset:transition.slide"]`.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 (GS-02 parent) | transition | fade | selection | cut:0, cut:1 | `cut:*.transition` | exclusive-group | false | compiled (**not** superseded: child 1b still stands); display "Fade → cuts 1, 2 · cut 1 replaced by Slide" / "Pudar → potongan 1, 2 · potongan 1 diganti oleh Geser" |
| 1a (child of 1) | transition | fade | cut:0 | `[cut:0]` | `cut:0.transition` | exclusive-group | false | **superseded** (by 2) |
| 1b (child of 1) | transition | fade | cut:1 | `[cut:1]` | `cut:1.transition` | exclusive-group | false | compiled (unchanged) |
| 2 | transition | `preset:transition.slide`, `{direction: 'from-right', durationMs: 500, timing: 'linear'}` | `{kind: 'clip', id: 'c1'}` | `[{kind: 'cut', index: 0}]` (the Cut **after** the selected Clip) | `cut:0.transition` | exclusive-group | false | compiled; `supersedes: [<child 1a>]` |

Partial supersession (AI_WORKFLOW §6 expansion rule): only child 1a is superseded; the parent stays `compiled` and keeps `cut:1.transition`. Had the Creator also replaced cut 2, child 1b and then the parent would become `superseded`.

**Expected path**: Compile.

**Expected Edit Plan**

```json
{ "origin": "compile", "baseVersion": "vB2", "goal": "Apply Slide to cut 1",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "cut 1: Fade → Slide (from right)",
    "ops": [ { "op": "op:transition.set", "target": { "kind": "cut", "index": 0 }, "args": { "presetId": "preset:transition.slide", "durationMs": 500, "timing": "linear", "params": { "direction": "from-right" } } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "executed" }
```

(The Compile path is allowed to replace a Locked Key because the lock belongs to the Creator's own picks; Locked Keys only constrain **agent** ops.)

**Expected Composition diff**: `transitions[0]` modified (`presetId`, `params.direction`); `transitions[1]` unchanged (fade). Total **18 000 ms** (unchanged: 500 → 500). Version `vB2+1`.

**Expected render settings**: standard; 540 frames.

**Edge handling**: selecting `c3` (last Clip, no following Cut) and picking a transition → rejected "This clip has no cut after it; select an earlier clip" / "Klip ini tidak memiliki potongan setelahnya; pilih klip sebelumnya" (no catalogue code yet; same **[GAP-2]**), no intent. Selecting a `stage.timeline.element.transition` directly targets that Cut.

**Pass criteria**: `cut:1` still fade; Intent Queue shows both items, item 1 (parent) not struck through (its child 1b still owns `cut:1.transition`) but annotated; child 1a is `superseded` with `supersededBy: <2>`; Player still shows a fade at 12 500 ms and a slide at 4 750 ms.

### GS-04 Text Panel: font size then colour with nothing selected (Theme default)

| Field | Value |
|---|---|
| Priority | P0 (brief §16 "selecting a known font size should create a typed operation directly") |
| Preconditions | B2. Nothing selected; no Text Layer under the playhead (playhead at 0). |

**Creator actions**

1. Click `hdr.menu.home`; `lib.mode.header` shows "Text".
2. Click `lib.text.size` preset **72**.
3. Click `lib.text.colour` swatch accent (`#E8913A`, from `preset:palette.editorial-dark`).

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | text | `params: {fontSize: 72}` | `{kind: 'selection'}` | `[{kind: 'project'}]` (Theme default for new text) | `theme.textDefaults.fontSize` | scalar | false | compiled |
| 2 | text | `params: {colour: '#E8913A'}` | `{kind: 'selection'}` | `[{kind: 'project'}]` | `theme.textDefaults.colour` | scalar | false | compiled |

Both items carry the note "applies to new text" / "berlaku untuk teks baru" (AI_WORKFLOW §4). Different keys → no supersession.

**Expected path**: Compile, two plans (one per pick), two versions.

**Expected Edit Plan** (second pick shown):

```json
{ "origin": "compile", "baseVersion": "vB2+1", "goal": "Set default text colour to #E8913A",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Theme: default text colour #F4EFE6 → #E8913A (new text only)",
    "ops": [ { "op": "op:theme.setTextDefaults", "target": { "kind": "project" }, "args": { "colour": "#E8913A" } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "executed" }
```

The op is `op:theme.setTextDefaults {fontFamily?, fontSize?, weight?, colour?, align?, opacity?}` (AI_WORKFLOW §5), one field per pick; the first pick emits `{ "op": "op:theme.setTextDefaults", "target": { "kind": "project" }, "args": { "fontSize": 72 } }`.

**Expected Composition diff**: `theme.textDefaults.fontSize 64 → 72`, then `theme.textDefaults.colour #F4EFE6 → #E8913A`. No Timeline Element changes; duration **18 000 ms**. Versions `vB2+1`, `vB2+2`.

**Expected render settings**: standard. Not rendered.

**Edge handling (GS-04b)**: same picks with a Text Layer under the playhead → the queue item offers "Apply to this text" / "Terapkan ke teks ini"; choosing it re-targets to `{kind:'text', id:'t1'}` with key `text:t1.style.fontSize` and op `op:text.setStyle {fontSize: 72}`.

**Pass criteria**: two versions with `cause: 'compile'`; Theme fields changed; a subsequent `lib.text.add` creates a Text Layer whose rendered size is 72u and colour `#E8913A`; no provider call; both queue items labelled "Applied directly" (UX-013).

### GS-05 Add Text title in Indonesian fits a 9:16 frame

| Field | Value |
|---|---|
| Priority | P0 (PRD-013 "renders in all ratios without overflow", UX-053) |
| Preconditions | B2 but Project created with ratio **9:16** 1080p (1080×1920). Playhead at 500 ms. Nothing selected. |

**Creator actions**

1. `hdr.menu.home` → `lib.text.variant` **Title**.
2. Click `lib.text.add`; in its inline input (`lib.text.add.input`, **[GAP-4]** not yet in ELEMENT_IDS.md) type "Review HP 2 Juta: Masih Layak di 2026?" and confirm.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | text | `preset:text.title`, `params: {text: "Review HP 2 Juta: Masih Layak di 2026?", durationMs: 3000}` | `{kind: 'playhead'}` | `[{kind: 'playhead'}]` → absolute `atMs: 500` | `text.add@500` (list key for additions) | list | false (text and variant present → Compile, AI_WORKFLOW §7) | compiled |

**Expected path**: Compile.

**Expected Edit Plan**

```json
{ "origin": "compile", "baseVersion": "vB2", "goal": "Add title at 0:00.5",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Title added 0:00.5–0:03.5",
    "ops": [ { "op": "op:text.add", "args": { "text": "Review HP 2 Juta: Masih Layak di 2026?", "variant": "preset:text.title", "atMs": 500, "durationMs": 3000, "position": { "x": 0, "y": -200 } } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "executed" }
```

**Expected Composition diff**: `text: [t1 {variantId preset:text.title, text …, timing {500, 3000}, position {0, -200}, style {}, effect null, motion {presetId preset:motion.rise, durationMs 600, exit true}}]` (motion from the variant default, DESIGN_CATALOGUE §10). Duration unchanged **18 000 ms**.

**Expected render settings**: 9:16, 1080p → **1080×1920**, 30 fps, 540 frames.

**Edge handling**: `fitText` (DESIGN_CATALOGUE §10, CM-008): at u = 1 the 38-character title at 110u does not fit the safe width (≈ 972u) on one line; the renderer wraps to two lines and scales to ≈ 95u (≥ 34u minimum → **no** CM-008 warning). A 120-character text would trigger CM-008 `warn` "Long text was shrunk to fit" / "Teks panjang diperkecil agar pas" and still render inside the safe area.

**Pass criteria**: golden still at 2 000 ms (9:16) shows the full title on two lines inside the safe area with no clipped glyphs; the same model rendered at 16:9 and 1:1 (`op:output.setRatio` in a test loop) also shows the whole text; the Timeline View shows `stage.timeline.element.text` on `stage.timeline.track.text`; no provider call.

### GS-06 Effects: Vignette then Film grain (list, dedupe), third effect on T0

| Field | Value |
|---|---|
| Priority | P0 (PRD-013, PRD-019, PERFORMANCE §8 "limit to 2 simultaneous effects on T0") |
| Preconditions | B2 with `EM_TEST_TIER=T0` (Hardware Tier T0; `gl: swangle`). Design ▸ Effects tab open. All effect cards show `lib.catalogue.card.badge.gpu` ("Needs a GPU; slower on this computer" / "Butuh GPU; lebih lambat di komputer ini"). |

**Creator actions**

1. Select `stage.timeline.element.clip[data-element-id="c2"]`.
2. Click `lib.catalogue.card[data-preset-id="preset:effect.vignette"]`.
3. Click `lib.catalogue.card[data-preset-id="preset:effect.film-grain"]`.
4. Click `preset:effect.vignette` again (the inspector slider for intensity was moved to 0.8 first; `stage.timeline.inspector`).
5. Click `lib.catalogue.card[data-preset-id="preset:effect.glow"]`.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | effect | `preset:effect.vignette`, `{intensity: 0.5}` | `{kind:'clip', id:'c2'}` | `[clip c2]` | `clip:c2.effects` | list | false | compiled |
| 2 | effect | `preset:effect.film-grain`, `{intensity: 0.5}` | clip c2 | `[clip c2]` | `clip:c2.effects` | list | false | compiled; display "Effects: Vignette, Film grain" / "Efek: Vignet, Butir film" |
| 3 | effect | `preset:effect.vignette`, `{intensity: 0.8}` | clip c2 | `[clip c2]` | `clip:c2.effects` | list (dedupe by presetId → merge, newest params win) | false | compiled; display "Vignette intensity 0.5 → 0.8" |
| 4 | effect | `preset:effect.glow` | clip c2 | `[clip c2]` | `clip:c2.effects` | list | false | **rejected** (CM-006: ≤ 2 effects per element on T0 → EM-2105) |

**Expected path**: Compile for 1–3; item 4 is rejected at pipeline step 4 (catalogue/hardware validation) before any plan.

**Expected Edit Plan** (item 3; items 1–2 are analogous `op:effect.add` plans):

```json
{ "origin": "compile", "baseVersion": "vB2+2", "goal": "Update Vignette on clip 2",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "clip 2: Vignette intensity 0.5 → 0.8",
    "ops": [ { "op": "op:effect.setParams", "target": { "kind": "clip", "id": "c2" }, "args": { "presetId": "preset:effect.vignette", "params": { "intensity": 0.8 } } } ] } ],
  "touchesLockedKeys": [], "risks": [ { "code": "EM-2103", "message": "'Vignette' needs a graphics card to render at normal speed. On this computer it will work but render slowly.", "severity": "warn" } ], "status": "executed" }
```

**Expected Composition diff**: `c2.effects = [{vignette, {intensity 0.8}, static}, {film-grain, {intensity 0.5}, static}]` (two entries, never three). Duration **18 000 ms**. Three new versions.

**Expected render settings**: standard with `chromiumOptions.gl: 'swangle'` (T0).

**Expected failure (item 4)**: `sys.toast` **EM-2105** "Effect limit reached: A clip can have up to 2 effects on this computer. Remove one before adding another." / "Batas efek tercapai: Satu klip dapat memiliki hingga 2 efek di komputer ini. Hapus satu sebelum menambah yang lain." (`{max}` = 2, `tier` = T0). The queue shows item 4 as `rejected` with that reason. Variant GS-06b on T1: Glow is accepted (3 effects), a fourth is rejected with EM-2105 and `{max}` = 3. The T0 startup notice EM-3402 "No graphics card detected" was shown once at launch.

**Pass criteria**: exactly two `EffectInstance`s on `c2`; `op:effect.add` was issued twice and `op:effect.setParams` once (operations_history); item 4 created no version; the GPU badge is visible on every effect card on T0; render still at 9 000 ms differs from the un-effected reference (effects applied) and renders within 2× the Standard budget on the reference T0 laptop.

### GS-07 Caption style pick + SRT import (P0 caption path)

| Field | Value |
|---|---|
| Priority | P0 (PRD-013 "caption display from SRT/VTT import in P0") |
| Preconditions | B1. FX-S1 not yet imported. Design ▸ Captions tab open. |

**Creator actions**

1. Click `lib.catalogue.card[data-preset-id="preset:caption.karaoke"]`.
2. Drag FX-S1 (`narasi.srt`) onto `lib.assets.drop`; the card appears with kind badge "Subtitles" / "Subtitel".
3. Click the card's action "Use as captions" / "Pakai sebagai caption" (`lib.assets.card.action.captions`, **[GAP-4]** not yet in ELEMENT_IDS.md).

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | caption | `preset:caption.karaoke`, `{position: 'bottom', fontSize: 56, combineTokensWithinMs: 1200, maxLines: 2}` | `{kind: 'project'}` | `[project]` | `project.captionStyle` | exclusive-group | false | compiled |
| 2 | caption | `params: {assetId: FX-S1}` | `{kind: 'project'}` | `[project]` | `project.captionPages` | scalar | false | compiled |

**Expected path**: Compile (twice).

**Expected Edit Plan** (item 2):

```json
{ "origin": "compile", "baseVersion": "vB1+1", "goal": "Import captions from narasi.srt",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Captions: 5 cues → pages 0:00–0:07 (Indonesian)",
    "ops": [ { "op": "op:caption.importSrt", "target": { "kind": "project" }, "args": { "assetId": "FX-S1" } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "executed" }
```

**Expected Composition diff**: `tracks.caption.styleId = preset:caption.karaoke`, `params` as above; `pages` built deterministically by `parseSrt` → `createTikTokStyleCaptions({combineTokensWithinMs: 1200})`: cue 1 (1 400 ms) → 2 pages, cues 2–4 → 2 pages each (≥ 1 200 ms), cue 5 → 1 page → **9 pages**, ordered and non-overlapping; `sourceAssetId = FX-S1`, `language = 'id'` (project language). Duration unchanged **19 000 ms** (pages end at 7 000 ms; CM-009 satisfied).

**Expected render settings**: standard; 570 frames.

**Edge handling (GS-07b)**: an SRT whose last cue ends at 25 000 ms in a 19 000 ms project → pages trimmed at 19 000 ms with `warn` "Captions after 0:19 were cut" / "Caption setelah 0:19 dipotong" (CM-009). A malformed SRT → asset `failed` with `EM-1xxx` reason; no intent. Picking `preset:caption.none` later → `op:caption.setStyle {presetId: preset:caption.none}` hides captions but keeps the pages.

**Pass criteria**: `stage.timeline.track.caption` shows 9 `stage.timeline.element.caption` blocks; still at 2 200 ms shows "Layarnya besar," with the active word in the accent colour, karaoke fill left-to-right; the same still at 9:16 and 1:1 keeps the text within the safe area; no provider call.

### GS-08 Brainstorm "buat intro energik untuk video review HP" → handoff → Edit Plan

| Field | Value |
|---|---|
| Priority | P0 (PRD-011, PRD-012, AI-019) |
| Preconditions | B1. Project language `id`. Fake provider replays `test/fixtures/plans/GS-08.json` for both agents (`fake-mid`). |

**Creator actions**

1. Type in `agent.brainstorm.composer`: "buat intro energik untuk video review HP" and click `agent.brainstorm.send`.
2. Read the reply in `agent.brainstorm.thread` (Indonesian, UX-042): a 3-sentence concept (judul besar yang muncul "pop", transisi dorong yang cepat, durasi intro ≈ 2,5 detik) and a question-free proposal.
3. The handoff card `agent.brainstorm.handoff` lists 3 proposed intents; click "Send to Editor Agent" / "Kirim ke Editor Agent".
4. The Editor Agent runs automatically on the hand-off (spinner "Asking fake-mid…" / "Bertanya ke fake-mid…"); `agent.editor.plancard` appears with badge "Proposed by Editor Agent · nothing applied yet" / "Usulan Editor Agent · belum diterapkan".
5. Click `agent.editor.execute`.

**Expected Brainstorming Agent output** (`proposedIntents`, source `brainstorm`):

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status after handoff |
|---|---|---|---|---|---|---|---|---|
| 1 | text | `preset:text.title`, `instruction: "judul pembuka energik untuk review HP 2 juta, maksimal 6 kata"` (no final text → creative placement) | `{kind: 'playhead'}` | `[{kind:'playhead'}]` → `atMs 0` | `text.add@0` | list | **true** | queued → planned |
| 2 | motion | `preset:motion.pop`, `{durationMs: 500}` | the title from item 1 (`{kind:'text', index: 0}`) | `[text index 0]` | `text:#0.motion` | exclusive-group | **true** (target does not exist yet) | queued → planned |
| 3 | transition | `preset:transition.push-cut`, `{direction: 'from-left', durationMs: 400, timing: 'linear'}` | `{kind: 'selection'}` | `[cut 0, cut 1]` | `cut:*.transition` | exclusive-group | false | queued → planned |

Handoff rule used here: intents arriving from the Brainstorming Agent are **never applied immediately**; the whole hand-off is planned by the Editor Agent in one run, and the Rewrite envelope carries `compiledOps` for the fully specified ones (item 3), which the plan must include verbatim (validator check). **[GAP-5]** AI_WORKFLOW §7/§9 do not state how a hand-off mixing Compile-able and interpretive intents is planned; this document assumes "one plan, compiled ops included".

**Expected path**: Editor Agent (Rewrite envelope: `creatorMessage` = the brainstorm text, `intents` = the 3 above, `lockedKeys: ["sequence.clips"]`, `capabilities.presets` = P0 set).

**Expected Edit Plan** (origin `editor-agent`, replayed from the fixture):

```json
{ "origin": "editor-agent", "baseVersion": "vB1", "goal": "Intro energik: judul pop + transisi dorong cepat",
  "steps": [
    { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Judul 'Review HP 2 Juta: Worth It?' 0:00–0:02.5",
      "ops": [ { "op": "op:text.add", "intentId": "<intent 1>", "args": { "text": "Review HP 2 Juta: Worth It?", "variant": "preset:text.title", "atMs": 0, "durationMs": 2500, "position": { "x": 0, "y": -120 } } } ] },
    { "n": 2, "tool": "composition.applyOps", "dependsOn": [1], "expectedDiff": "Judul: gerak Pop 500 ms",
      "ops": [ { "op": "op:motion.set", "intentId": "<intent 2>", "target": { "kind": "text", "index": 0 }, "args": { "presetId": "preset:motion.pop", "params": { "durationMs": 500, "easingId": "preset:easing.back" } } } ] },
    { "n": 3, "tool": "composition.applyOps", "expectedDiff": "2 transisi Push cut 400 ms; durasi 0:19 → 0:18.2",
      "ops": [
        { "op": "op:transition.set", "intentId": "<intent 3>", "target": { "kind": "cut", "index": 0 }, "args": { "presetId": "preset:transition.push-cut", "durationMs": 400, "timing": "linear", "params": { "direction": "from-left" } } },
        { "op": "op:transition.set", "intentId": "<intent 3>", "target": { "kind": "cut", "index": 1 }, "args": { "presetId": "preset:transition.push-cut", "durationMs": 400, "timing": "linear", "params": { "direction": "from-left" } } } ] } ],
  "touchesLockedKeys": [], "risks": [ { "code": "TEXT-LANG", "message": "Judul memakai campuran Indonesia/Inggris ('Worth It?'); ganti di catatan bila perlu", "severity": "info" } ],
  "status": "valid", "usage": { "model": "fake-mid", "inputTokens": 3100, "outputTokens": 420, "costUsd": 0.0031, "approximate": false } }
```

**Expected Composition diff**: `text: [t1 {title, "Review HP 2 Juta: Worth It?", {0, 2500}, {0,-120}, motion {pop, 500, easing back}}]`; `transitions: [{0, push-cut, 400}, {1, push-cut, 400}]`. Total **18 200 ms** (546 frames) = 19 000 − 2 × 400. Version `vB3`, `cause: 'execute'`. Intent statuses → `executed`. Toast "Applied: 3 changes · v3" / "Diterapkan: 3 perubahan · v3".

**Expected render settings**: standard; 546 frames.

**Edge handling**: "Dismiss" on the handoff card leaves the queue untouched and records nothing but the chat message. If the Brainstorming Agent returns `proposedIntents` with an unknown `presetId`, step 4 validation marks that intent `rejected` on the card ("Unknown preset; removed" / "Preset tidak dikenal; dihapus") and the rest proceed.

**Pass criteria**: the handoff card is shown before anything enters the Intent Queue (AI-019); the plan validates on the first attempt (dry-run `composition.validateOps` ok); `t1` exists with `motion.presetId = preset:motion.pop`; both transitions are push-cut; `usage_records` has exactly 2 rows (one per agent); the Brainstorming Agent made no `mutate` call and no `composition.validateOps` call (tool log); replies are in Indonesian.

### GS-09 Editor chat "ganti semua transisi jadi wipe dari kiri" respects a Locked Cut

| Field | Value |
|---|---|
| Priority | P0 (AI-007, AI-014, PRD-012) |
| Preconditions | B3, then the Creator selects `c1` and picks `preset:transition.slide` (as GS-03) → `cut:0` = Slide from-right 500 ms (**Locked Key `cut:0.transition`**), `cut:1` = push-cut 400 ms (agent-set, not locked). Duration 19 000 − 500 − 400 = **18 100 ms**; head `vB3+1`. |

**Creator actions**

1. Type in `agent.editor.composer`: "ganti semua transisi jadi wipe dari kiri" → `agent.editor.send`.
2. Plan Card appears; read `agent.editor.plancard.risk`.
3. `agent.editor.execute`.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | transition | — (`instruction: "ganti semua transisi jadi wipe dari kiri"`) | `{kind: 'selection'}` (nothing selected) | `[cut 0, cut 1]` | `cut:*.transition` | exclusive-group | true | queued → planned → executed |

Rewrite envelope: `lockedKeys: ["cut:0.transition", "sequence.clips"]`, `creatorMessage` as typed, `constraints: ["never touch lockedKeys", …]`.

**Expected path**: Editor Agent.

**Expected Edit Plan**

```json
{ "origin": "editor-agent", "baseVersion": "vB3+1", "goal": "Ganti transisi yang bisa diubah menjadi Wipe dari kiri",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "potongan 2: Push cut → Wipe (dari kiri) 500 ms; durasi 0:18.1 → 0:18.0",
    "ops": [ { "op": "op:transition.set", "intentId": "<intent 1>", "target": { "kind": "cut", "index": 1 }, "args": { "presetId": "preset:transition.wipe", "durationMs": 500, "timing": "linear", "params": { "direction": "from-left" } } } ] } ],
  "touchesLockedKeys": [],
  "risks": [ { "code": "LOCKED-SKIPPED", "message": "Potongan 1 (Geser) kamu pilih sendiri, jadi tidak diubah. Pilih Sapu di katalog untuk menggantinya.", "severity": "info" } ],
  "status": "valid" }
```

EN variant of the risk: "Cut 1 (Slide) was your own pick, so it was left unchanged. Pick Wipe in the catalogue to replace it."

**Expected Composition diff**: `transitions[1]` → `{cutIndex 1, wipe, 500, linear, {direction from-left}}`; `transitions[0]` unchanged (slide). Total **18 000 ms** (540 frames) = 19 000 − 500 − 500. Version `vB3+2`.

**Expected render settings**: standard; 540 frames.

**Edge handling**: if the model nevertheless emits an op on `cut:0`, GS-11 applies (re-prompt, then drop). The Intent Queue item from GS-03 (Slide) remains `compiled` and still owns `cut:0.transition`.

**Pass criteria**: `cut:0` is still Slide after Execute (checked in the model and in a still at 4 750 ms); the plan contains exactly one op; the risk is visible in `agent.editor.plancard.risk`; `touchesLockedKeys` is empty; reply language Indonesian.

### GS-10 Stale Plan after an Insert → re-plan

| Field | Value |
|---|---|
| Priority | P0 (AI-013, UXRD §4 rule 4) |
| Preconditions | B1. FX-V3 still available in the Asset Panel. |

**Creator actions**

1. `agent.editor.composer`: "tambahkan transisi fade di semua potongan" → send. Plan Card shows a 2-op plan (`plan.ready`, `baseVersion vB1`).
2. **Before** Execute: in `lib.assets.panel` select FX-V3 (`lib.assets.card.select`), click `lib.assets.insert` → the Insert compiles immediately (`c4 = FX-V3 5 000`, head `vB1+1`, duration 24 000 ms).
3. Observe `agent.editor.plancard.baseversion.stale` with "Composition changed; re-plan" / "Komposisi berubah; susun ulang"; `agent.editor.execute` is disabled.
4. Click the re-plan action on the stale badge (`agent.editor.plancard.replan`, **[GAP-4]** not yet in ELEMENT_IDS.md).
5. New Plan Card (`baseVersion vB1+1`) with 3 ops → `agent.editor.execute`.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | transition | — (`instruction`) | selection | first plan: `[cut 0, cut 1]`; after re-plan: `[cut 0, cut 1, cut 2]` (Target Resolution re-run on the new head) | `cut:*.transition` | exclusive-group | true | queued → planned → planned (re-plan) → executed |
| 2 | asset | `{assetIds: [FX-V3]}` | project | `[project]` | `sequence.clips` | list | false | compiled |

**Expected path**: Editor Agent twice (2 provider calls in `agent_runs`; the first plan ends `status: 'stale'`).

**Expected Edit Plan** (second plan):

```json
{ "origin": "editor-agent", "baseVersion": "vB1+1", "goal": "Fade di semua 3 potongan",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "3 transisi Fade 500 ms; durasi 0:24 → 0:22.5",
    "ops": [
      { "op": "op:transition.set", "target": { "kind": "cut", "index": 0 }, "args": { "presetId": "preset:transition.fade", "durationMs": 500, "timing": "linear" } },
      { "op": "op:transition.set", "target": { "kind": "cut", "index": 1 }, "args": { "presetId": "preset:transition.fade", "durationMs": 500, "timing": "linear" } },
      { "op": "op:transition.set", "target": { "kind": "cut", "index": 2 }, "args": { "presetId": "preset:transition.fade", "durationMs": 500, "timing": "linear" } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "valid" }
```

**Expected Composition diff**: `video` has 4 Clips (c4 = FX-V3 at index 3); `transitions` ×3 fade 500. Total **22 500 ms** (675 frames) = 24 000 − 3 × 500. Head `vB1+2`.

**Expected render settings**: standard; 675 frames.

**Expected failure**: a forced `POST /plans/<stale>/execute` (API test, bypassing the disabled button) returns **409** with **EM-2301** "Composition changed, plan is out of date" / "Komposisi berubah, rencana kedaluwarsa" (action "Plan again" / "Rencanakan lagi" re-runs the plan with the same intents); no version is created. The stale badge copy stays as UXRD §4 rule 4 states it.

**Pass criteria**: first plan row `status = 'stale'`, never executed; second plan validates first time; `operations_history` for `vB1+2` has 3 rows; the stale badge and the disabled Execute were visible (UI test on element ids).

### GS-11 Locked Key violation by the model → re-prompt, then drop

| Field | Value |
|---|---|
| Priority | P0 (AI-014 "100 % of Locked Key violations caught") |
| Preconditions | B2 (both Cuts Fade by UI picks → Locked Keys `cut:0.transition`, `cut:1.transition`). Fixture `GS-11.json` holds two deliberately violating responses. |

**Creator actions**

1. `agent.editor.composer`: "tambahkan judul 'Harga Resmi' di awal dan buat transisinya lebih cepat" → send.
2. Observe the spinner twice ("Asking fake-mid…" then "Checking the plan again…" / "Memeriksa rencana lagi…").
3. Plan Card appears with one step and one warning; `agent.editor.execute`.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | text | — (`instruction`, contains the quoted title) | playhead (0) | `[playhead]` | `text.add@0` | list | true | queued → planned → executed |

(The chat message is one intent of category `text`; the "faster transitions" part is interpreted by the Editor Agent and collides with Locked Keys. The Rewrite envelope lists `lockedKeys: ["cut:0.transition", "cut:1.transition", "sequence.clips"]`.)

**Expected provider exchange (fixture)**

| Call | Model response (abbreviated) | Validator result |
|---|---|---|
| 1 | `text.add "Harga Resmi"` + `transition.set cut 0 fade 250` + `transition.set cut 1 fade 250` | `touchesLockedKeys: ["cut:0.transition", "cut:1.transition"]` → plan `invalid`; **one** re-prompt listing the keys (AI_WORKFLOW §6, §12) |
| 2 | `text.add "Harga Resmi"` + `transition.set cut 1 fade 250` | still touches `cut:1.transition` → the violating op is **dropped**; plan proceeds with the remaining op; risk `warn` added |

**Expected Edit Plan** (as shown after the drop):

```json
{ "origin": "editor-agent", "baseVersion": "vB2", "goal": "Tambah judul 'Harga Resmi' di awal; transisi tidak diubah",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Judul 'Harga Resmi' 0:00–0:02.5",
    "ops": [ { "op": "op:text.add", "args": { "text": "Harga Resmi", "variant": "preset:text.title", "atMs": 0, "durationMs": 2500, "position": { "x": 0, "y": -120 } } } ] } ],
  "touchesLockedKeys": [],
  "risks": [ { "code": "EM-2302", "message": "Rencana Editor Agent mencoba mengubah pengaturan yang sudah kamu pilih (Transisi potongan 2). Langkah itu dihapus. Periksa rencana sebelum Execute.", "severity": "warn" } ],
  "status": "valid" }
```

EN (EM-2302 catalogue copy): "The Editor Agent's plan tried to change settings you already picked (Transition on cut 2). Those steps were removed. Review the plan before Execute." `{keys}` is rendered with UI labels, never raw `cut:1.transition` (ERROR_CATALOGUE §8).

**Expected Composition diff**: `t1` added; `transitions` unchanged (fade 500 ×2). Total **18 000 ms**. Head `vB2+1`.

**Expected render settings**: standard; 540 frames.

**Pass criteria**: exactly 2 provider calls; `edit_plans` keeps the first (invalid) response in `plan_json.validation` with `touchesLockedKeys`; the final model has both transitions at 500 ms fade; the warn risk is displayed; `agent_runs.status = 'done'`. Eval metric: locked-key catch rate 100 % across 20 replays with randomised violating ops.

### GS-12 Invalid JSON from the provider → retries → EM-4301

| Field | Value |
|---|---|
| Priority | P0 (AI-005, AI_WORKFLOW §12) |
| Preconditions | B1. Fixture `GS-12.json`: response 1 = Indonesian prose with no JSON; response 2 = JSON with `"op": "op:transition.add"` (not in the vocabulary) and `durationMs: 5000`; response 3 = truncated JSON (`…"steps": [{"n": 1, "tool": "composi`). |

**Creator actions**

1. `agent.editor.composer`: "bikin intronya lebih hidup" → send.
2. Observe three spinner phases.
3. Read the error in `agent.editor.thread` and expand "Show raw answer" / "Tampilkan jawaban mentah".

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | motion (category inferred from the Rewrite; may be `text`) | — (`instruction`) | playhead | `[clip c1]` (Clip under the playhead at 0) | `clip:c1.motion` | exclusive-group | true | queued → **rejected** (reason EM-4301) |

**Expected path**: Editor Agent; **3 provider calls** (initial + 2 re-prompts carrying the Zod error), then stop.

**Expected Edit Plan**: none persisted as `valid`; an `edit_plans` row with `status: 'invalid'` and `validation: [{path: "", code: "EM-4301", message: "…"}]` may exist for transparency.

**Expected failure**: chat message **EM-4301** "The model's answer could not be used: fake-mid returned a plan Expertmotion could not understand after two tries. Try again, rephrase, or choose a more capable model. The raw answer is available below." / "Jawaban model tidak dapat dipakai: fake-mid mengembalikan rencana yang tidak dapat dipahami Expertmotion setelah dua kali percobaan. Coba lagi, ubah kalimat, atau pilih model yang lebih mampu. Jawaban mentahnya tersedia di bawah." with actions "Try again" / "Coba lagi" and "Show raw answer" / "Tampilkan jawaban mentah" (collapsed) (UX-033); log fields `zodErrors[]`, `attempts: 3`. Re-prompt 2 includes the Zod issue `steps[0].ops[0].op: invalid op name "op:transition.add"` and `durationMs: must be ≤ 2000`.

**Expected Composition diff**: none. Head stays `vB1`. Duration **19 000 ms**.

**Pass criteria**: `agent_runs.status = 'failed'`, `error_code = 'EM-4301'`; 3 `usage_records` rows; no `composition_versions` row added; Execute never enabled; the raw response is not written to `service.log` (MCP_AND_TOOLING §3.3.2).

### GS-13 Ratio 16:9 → 9:16 with Auto off; 4K disabled on T0

| Field | Value |
|---|---|
| Priority | P0 (PRD-008, PRD-019, ADR-010) |
| Preconditions | B2 with `EM_TEST_TIER=T0`. `agent.output.ratio.auto` off. |

**Creator actions**

1. Click `agent.output.ratio.9x16` (label "9:16 · 1080×1920").
2. Observe `stage.player.frame` resize to portrait; `stage.player.controls.ratio` = "9:16", `.res` = "1080×1920".
3. Hover `agent.output.resolution.2160p.disabled`; read the reason. Click it.
4. Hover `agent.output.resolution.2k.disabled`; same.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | layout | `params: {ratio: '9:16'}` | project | `[project]` | `project.ratio` | scalar | false | compiled |
| — | (none) | the 4K/2K clicks create **no** intent | — | — | — | — | — | — |

**Expected path**: Compile.

**Expected Edit Plan**

```json
{ "origin": "compile", "baseVersion": "vB2", "goal": "Set aspect ratio to 9:16",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Output 16:9 1920×1080 → 9:16 1080×1920; clips are centre-cropped",
    "ops": [ { "op": "op:output.setRatio", "target": { "kind": "project" }, "args": { "ratio": "9:16" } } ] } ],
  "touchesLockedKeys": [], "risks": [ { "code": "CROP", "message": "Landscape clips 2 and 3 will be cropped at the sides", "severity": "info" } ], "status": "executed" }
```

**Expected Composition diff**: `settings.ratio '16:9' → '9:16'`; no element changes (positions are in u). Duration **18 000 ms**. Head `vB2+1`.

**Expected render settings**: 9:16 1080p → **1080×1920**, 30 fps, 540 frames, `gl: swangle`.

**Expected failure/edge**: tooltip on 4K and 2K = **EM-3105** (info) "Resolution not available on this computer: 2160p needs a graphics card with at least 4 GB of memory. 1080p is the highest option here." / "Resolusi tidak tersedia di komputer ini: 2160p membutuhkan kartu grafis dengan memori minimal 4 GB. 1080p adalah pilihan tertinggi di sini."; the click is inert. GS-13b (T1): 2K enabled; 4K enabled with warning "Slow on this computer; expect several minutes" / "Lambat di komputer ini; bisa beberapa menit". GS-13c: a fake plan containing `op:output.setResolution {preset: '2160p'}` on T0 → CM-010 `warn` on the plan (message = EM-3105 copy) and the Export preflight refuses the render (**[GAP-6]** PERFORMANCE §7 has no preflight row for the tier gate, and EM-3105 is `info`, so the blocking case has no `error` code). GS-13d: Auto on and B0 → the first Insert (FX-V3, portrait) sets `9:16` automatically via `op:output.setRatio` with `source: 'system'`.

**Pass criteria**: Player frame aspect 9:16 within 1 px; export dialog summary says 1080×1920; `settings.resolution` still `1080p`; no intent rows for the disabled buttons; the reason tooltip text matches the EN string (ID variant present in `id.json`).

### GS-14 Export preflight failure (low disk) then success with ffprobe validation

| Field | Value |
|---|---|
| Priority | P0 (PRD-014, PERFORMANCE §7) |
| Preconditions | B2. `EM_TEST_DISK_FREE_MB=300` for the first attempt. Output folder = default. |

**Creator actions**

1. Click `hdr.action.export` → `scr.export` opens; `scr.export.profile.summary` reads "16:9 · 1920×1080 · 30 fps · 0:18 · H.264 MP4 · Standard".
2. `scr.export.preflight` runs; the Disk row fails; `scr.export.start` disabled.
3. Set `EM_TEST_DISK_FREE_MB=20000` (test harness) and click "Check again" / "Periksa lagi".
4. `scr.export.start` → `scr.export.progress`, `scr.export.eta`, `sys.render.progress` chip.
5. On `scr.export.done`, click `scr.export.open.folder`.

**Expected Intent Queue**: unchanged (Export creates a Render Job, not an Edit Intent).

**Expected path**: none (render pipeline, ARCHITECTURE §6.2).

**Expected Edit Plan**: none.

**Expected render settings**: `{ratio '16:9', resolution '1080p' → 1920×1080, fps 30, codec h264, crf 18, audioCodec aac, imageFormat jpeg, concurrency 1, hardwareAcceleration 'disabled', gl 'angle' (T1), disallowParallelEncoding true}`; `durationInFrames 540`. Estimated size ≈ 25 MB → required free space = 3 × 25 + 500 = **575 MB**.

**Expected failure (step 2)**: **EM-3102** "Not enough disk space: The output folder needs about 0.6 GB free; 0.3 GB is available. Free space or choose another folder." / "Ruang disk tidak cukup: Folder keluaran membutuhkan sekitar 0,6 GB kosong; tersedia 0,3 GB. Kosongkan ruang atau pilih folder lain." Actions "Choose folder" / "Pilih folder" (→ `scr.export.folder`) and "Check again" / "Periksa lagi". Start disabled; no `render_jobs` row.

**Expected success (steps 4–5)**: `render_jobs` row `queued → rendering → done`, `progress` monotonic, `eta_ms` present after 10 %; `outputs` row with `validated = 1` after ffprobe: `duration_ms` within ±33 ms of 18 000, `width 1920`, `height 1080`, `fps 30`, video codec h264, audio aac; thumbnail written; SSE `render.progress` ≥ 5 events and one `render.done`. (GS-14b: an ffprobe mismatch, e.g. a test build forcing 25 fps, yields **EM-3205** "Output check failed" with `{field: fps, expected: 30, actual: 25}` and `validated = 0`; the file is kept for inspection.)

**Pass criteria**: both states observed in order; the output plays in Windows Media Player; file name follows the `scr.export.filename` pattern; render time on the reference laptop ≤ 90 s (PERFORMANCE §5, to confirm); the Editor stayed responsive (Player seek < 100 ms during render is **not** required; UI remains interactive).

### GS-15 Cancel a render mid-way; partial file removed

| Field | Value |
|---|---|
| Priority | P0 (PRD-014 "cancel removes partial file", PRD-015) |
| Preconditions | B2. Disk and RAM preflight pass. |

**Creator actions**

1. `hdr.action.export` → `scr.export.start`.
2. When `scr.export.progress` shows ≈ 40 %, click `scr.export.cancel`; confirm "Stop export?" / "Hentikan ekspor?".
3. Observe the dialog state "Cancelled" / "Dibatalkan" and the `sys.render.progress` chip disappearing.
4. Click `scr.export.start` again and let it finish.

**Expected Intent Queue / Edit Plan**: unchanged / none.

**Expected render settings**: as GS-14.

**Expected behaviour**: `render_jobs` row 1 → `cancelled` (`finished_at` set, `output_id` NULL); dialog shows **EM-3202** (info) "Rendering cancelled: Rendering was cancelled. The partial file was removed." / "Render dibatalkan: Render dibatalkan. File yang belum selesai dihapus."; the Chrome Headless Shell process and FFmpeg child spawned for job 1 are gone within 5 s (no orphan `chrome-headless-shell` / `ffmpeg` processes owned by the Local Service); the partial file in `outputs/<projectId>/` is deleted; SSE `render.cancelled`; no `outputs` row for job 1. Job 2 completes normally (`done`, `validated = 1`).

**Edge handling**: closing the window during a render → the Desktop Shell prompts "An export is running. Stop it and quit?" / "Ekspor sedang berjalan. Hentikan dan keluar?" (ARCHITECTURE §5 step 5). Killing the Service during a render → on restart the job is `failed` with **EM-3203** "Rendering was interrupted" / "Render terhenti" and the partial file deleted (DATABASE_SCHEMA §7).

**Pass criteria**: zero files in the output folder after cancel; process list clean; the Editor never shows `sys.offline`; memory of the Local Service returns to within 50 MB of its pre-render value within 30 s; job 2 succeeds.

### GS-16 Private Mode on: agents disabled, picks still compile

| Field | Value |
|---|---|
| Priority | P0 (PRD-020, AI-017) |
| Preconditions | B1. A real-looking Provider Connection is configured (fake adapter counts calls). |

**Creator actions**

1. Toggle `agent.output.private` on. `sys.privatemode.banner` appears: "Private Mode: nothing leaves this computer. Agents and model downloads are paused." / "Mode Privat: tidak ada yang keluar dari komputer ini. Agen dan unduhan model dijeda."
2. Try to type in `agent.editor.composer` → it is `.disabled` with the inline notice **EM-4401** "Agents are off in Private Mode: Private Mode blocks all internet use, so the agents are unavailable. Designs, timeline and export still work." / "Agen nonaktif dalam Private Mode: Private Mode memblokir semua akses internet, sehingga agen tidak tersedia. Desain, timeline dan ekspor tetap berfungsi." (action "Turn off Private Mode" / "Matikan Private Mode"); `agent.modelbar.status` shows "Private Mode".
3. Design ▸ Transitions → click `preset:transition.fade` (nothing selected).
4. `hdr.action.models` → every `scr.models.row.install` is disabled with **EM-7006** "Download paused" / "Unduhan dijeda" (`reason: private`).
5. `hdr.action.export` → render a 1080p export.
6. Toggle `agent.output.private` off → composers re-enable; type "halo" and send → the fake provider receives the call.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | transition | fade, 500 | selection | `[cut 0, cut 1]` | `cut:*.transition` | exclusive-group | false | compiled |

**Expected path**: Compile (identical to GS-02; result `vB2`, 18 000 ms).

**Expected Edit Plan**: as GS-02.

**Expected render settings**: standard; the render completes (no network needed).

**Expected failure (unit level)**: a direct call to `egressFetch(providerUrl, …, 'provider')` while Private Mode is on throws **EM-8202** "Blocked by Private Mode" (MCP_AND_TOOLING §5.6) **before** DNS resolution; a programmatic `POST /projects/:id/plans` with an interpretive intent returns 409 with EM-4401.

**Pass criteria**: a network capture (test harness socket monitor) shows **zero** outbound connections between steps 1 and 6 (PRD-020); the fake adapter's call counter is unchanged until step 6; the pick compiled and rendered; the banner is visible on every screen; the composer re-enables within 1 s of toggling off.

### GS-17 Crash during Execute → rollback, version unchanged

| Field | Value |
|---|---|
| Priority | P0 (brief §8.4 "rollback for failed operations", AI_WORKFLOW §12) |
| Preconditions | B1. `EM_TEST_CRASH_AFTER_OP=2` (the Service process exits with code 137 after the second op is written inside the Execute transaction). Fixture `GS-17.json` returns a 3-op plan. |

**Creator actions**

1. `agent.editor.composer`: "kasih fade di semua potongan dan judul 'Halo!' di awal" → send.
2. Plan Card shows 3 ops (2 × `op:transition.set`, 1 × `op:text.add`); `agent.editor.execute`.
3. Observe `sys.offline` ("Reconnecting…" / "Menyambung ulang…") for ≈ 1–3 s (Desktop Shell restart with backoff), then the Editor reconnects.
4. Read the Plan Card: "Interrupted; nothing was applied. Execute again." / "Terputus; tidak ada yang diterapkan. Jalankan lagi."
5. `agent.editor.execute` again (fault injection off).

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | transition | — (`instruction`) | selection | `[cut 0, cut 1]` | `cut:*.transition` | exclusive-group | true | planned → (crash) planned → executed |
| 2 | text | — (same message; the Rewrite splits it) | playhead | `[playhead]` | `text.add@0` | list | true | planned → executed |

**Expected path**: Editor Agent (one provider call; the re-Execute reuses the same plan because `baseVersion` still matches).

**Expected Edit Plan**

```json
{ "origin": "editor-agent", "baseVersion": "vB1", "goal": "Fade di 2 potongan + judul 'Halo!'",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "2 Fade 500 ms; judul 'Halo!' 0:00–0:02; durasi 0:19 → 0:18",
    "ops": [
      { "op": "op:transition.set", "target": { "kind": "cut", "index": 0 }, "args": { "presetId": "preset:transition.fade", "durationMs": 500, "timing": "linear" } },
      { "op": "op:transition.set", "target": { "kind": "cut", "index": 1 }, "args": { "presetId": "preset:transition.fade", "durationMs": 500, "timing": "linear" } },
      { "op": "op:text.add", "args": { "text": "Halo!", "variant": "preset:text.title", "atMs": 0, "durationMs": 2000, "position": { "x": 0, "y": -120 } } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "valid" }
```

**Expected Composition diff**: **after the crash**: none; head `vB1`, `composition_versions` count unchanged, `operations_history` has **no** rows for this plan (SQLite transaction rolled back by the WAL on reopen), plan status back to `valid` (from `executing`), checkpoint file for `vB1` intact. **After step 5**: transitions ×2 fade, `t1` added; total **18 000 ms**; head `vB1+1`; `ExecutionResult.ok = true`, `appliedOps 3`.

**Expected render settings**: standard; 540 frames after step 5.

**Edge handling (GS-17b)**: an in-process failure instead of a kill (op 3 throws a validator `block`, e.g. CM-005) → `ExecutionResult {ok: false, error: {code: 'EM-2307', step: 1}, rollback: {performed: true, toVersion: 'vB1'}}`, Plan Card badge "Not applied · EM-2307" / "Tidak diterapkan · EM-2307" with the copy "Step 1 failed, so the whole change was undone. Your project is unchanged." / "Langkah 1 gagal, sehingga seluruh perubahan dibatalkan. Proyek kamu tidak berubah." (UXRD §4 rule 2); the model is unchanged. A second Execute of an already-applied plan returns **EM-2308** "Already applied" (idempotency, AI_WORKFLOW §6).

**Pass criteria**: DB integrity check passes after restart (`PRAGMA integrity_check = ok`); version count before = after the crash; no partial element (`t1` absent, no transitions) in the head model; the second Execute succeeds without a new provider call; `agent_runs` for the plan is `done` (the agent run had finished before Execute).

### GS-18 Budget exceeded → EM-4201

| Field | Value |
|---|---|
| Priority | P0 (PRD-010 "budget limit", AI-016) |
| Preconditions | B1. `provider_connections.budget_month_usd = 1.00`. Seeded `usage_records` for the current month totalling **$0.85**. Fixture `GS-18.json` returns a valid plan whose recorded usage costs **$0.20**. |

**Creator actions**

1. Open the project: `sys.toast` **EM-4202** (warn, once per session) "80 % of budget used: This project has used $0.85 of its $1.00 AI budget." / "80 % anggaran terpakai: Proyek ini telah memakai $0,85 dari anggaran AI $1,00." (AI_WORKFLOW §11); `agent.editor.footer.ctx` tooltip repeats the figures.
2. `agent.editor.composer`: "tambahkan fade di semua potongan" → send → plan arrives; usage now $1.05.
3. `agent.editor.composer`: "sekarang tambahkan judul" → send.
4. Read the error; open `scr.providers` via "Change budget" / "Ubah anggaran", set `scr.providers.budget.month` to $5.00, save; send again → works.
5. Meanwhile click `preset:transition.slide` with `c1` selected → compiles regardless of budget.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | transition | — | selection | `[cut 0, cut 1]` | `cut:*.transition` | exclusive-group | true | planned (not executed in this scenario) |
| 2 | text | — ("sekarang tambahkan judul") | playhead | `[playhead]` | `text.add@0` | list | true | queued → **rejected** (EM-4201) → re-queued after step 4 → planned |
| 3 | transition | slide, from-right | clip c1 | `[cut 0]` | `cut:0.transition` | exclusive-group | false | compiled |

**Expected path**: Editor Agent for 1; blocked for 2 (no provider call); Compile for 3; Editor Agent for 2 after the budget change.

**Expected Edit Plan**: for step 2 none; for the retry a normal `editor-agent` plan.

**Expected failure (step 3)**: chat message **EM-4201** "Budget reached: This project has used its AI budget of $1.00. Raise the limit in Providers to continue." / "Anggaran tercapai: Proyek ini telah memakai anggaran AI sebesar $1,00. Naikkan batasnya di Providers untuk melanjutkan." with action "Change budget" / "Ubah anggaran" (→ `scr.providers.budget.month`); `agent_runs` row with `status 'failed'`, `error_code 'EM-4201'`, no `usage_records` row for it.

**Expected Composition diff**: only item 3 changes the model (`cut:0` slide; duration 19 000 − 500 = **18 500 ms**); head `vB1+1`.

**Expected render settings**: standard; 555 frames.

**Pass criteria**: the fake adapter's call counter increases by exactly 1 in step 2, 0 in step 3, 1 in step 4; the 80 % warning appeared before the first run; the Compile pick was unaffected (UX-013); the budget check happens **before** any egress (ordering asserted in the unit test).

### GS-19 Superseded intent restored

| Field | Value |
|---|---|
| Priority | P0 (AI-018, UXRD S1 "Replaced by …") |
| Preconditions | B2. Nothing selected (Theme default path, as GS-04). |

**Creator actions**

1. `hdr.menu.home` → `lib.text.size` **72**.
2. `lib.text.size` **96**.
3. In `agent.editor.intentqueue`, item 1 is `.item.superseded` (struck through, "Font size 96 (replaced 72)" / "Ukuran huruf 96 (menggantikan 72)"). Click its `agent.editor.intentqueue.item.restore`.

**Expected Intent Queue**

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status |
|---|---|---|---|---|---|---|---|---|
| 1 | text | `{fontSize: 72}` | selection | `[project]` | `theme.textDefaults.fontSize` | scalar | false | compiled → superseded (by 2) → Restore sets `queued` and stamps `restoredAt` → **compiled** again (there is no `restored` status, AI_WORKFLOW §3) |
| 2 | text | `{fontSize: 96}` | selection | `[project]` | `theme.textDefaults.fontSize` | scalar | false | compiled, `supersedes: [1]` → **superseded** (by the restore of 1) |

**Expected path**: Compile ×3 (72, 96, 72 again). Each creates a Composition Version (`cause: 'compile'`, `'compile'`, `'restore'`).

**Expected Edit Plan** (restore):

```json
{ "origin": "compile", "baseVersion": "vB2+2", "goal": "Restore default font size 72",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Theme: default font size 96 → 72 (new text only)",
    "ops": [ { "op": "op:theme.setTextDefaults", "target": { "kind": "project" }, "args": { "fontSize": 72 } } ] } ],
  "touchesLockedKeys": [], "risks": [], "status": "executed" }
```

**Expected Composition diff**: `theme.textDefaults.fontSize 64 → 72 → 96 → 72`. Three versions `vB2+1..+3`; duration **18 000 ms** unchanged.

**Expected render settings**: standard. Not rendered.

**Edge handling**: restoring an intent whose target no longer exists (Clip removed) → "Cannot restore: the clip no longer exists" / "Tidak bisa dipulihkan: klip sudah tidak ada", status stays `superseded` and `restoredAt` is not stamped. `agent.editor.intentqueue.item.remove` sets status `removed` (AI_WORKFLOW §3); `agent.editor.intentqueue.clear` removes only `superseded`, `rejected` and `removed` items, never `compiled`/`executed` ones (history lives in versions).

**Pass criteria**: three versions with the listed causes; item statuses exactly as in the table; `Ctrl+Z` after step 3 moves the head to the 96 version (undo = version move, DATABASE_SCHEMA §4.5) and the queue display updates accordingly; no provider call.

### GS-20 English: "make the captions pop and add soft music bed, duck under my voice"

| Field | Value |
|---|---|
| Priority | P0 for the flow; individual steps marked **P0 / P1 / P2** below (ADR-016) |
| Preconditions | B2 + GS-07 applied (captions from FX-S1, style `preset:caption.editorial`). FX-M1 **not** imported yet. Project language `en` (so replies are English). Fixture `GS-20.json` (two runs). |

**Creator actions**

1. `agent.editor.composer`: "make the captions pop and add soft music bed, duck under my voice" → send.
2. Read the Plan Card and its warn risk; `agent.editor.execute`.
3. Drag FX-M1 (`bed-lofi.mp3`) onto `lib.assets.drop`; wait for `ready`.
4. `agent.editor.composer`: "now add the music" → send; `agent.editor.execute`.

**Expected Intent Queue** (after step 1 the Rewrite splits the message into three intents, one per category):

| # | category | presetId / params | target (as given) | resolvedTargets | propertyKey | propertyClass | needsInterpretation | status | MVP note |
|---|---|---|---|---|---|---|---|---|---|
| 1 | caption | — ("pop") | project | `[project]` | `project.captionStyle` | exclusive-group | true | planned → executed | `preset:caption.pop` is **P1**; in MVP the Editor Agent must pick a P0 style and say so |
| 2 | audio | — ("soft music bed") | selection (none) | `[project]` (project audio bed) | `project.audioBed` | list | true | planned → **deferred** (no asset) → planned (run 2) → executed | `op:audio.addBed` is P0 but needs an `assetId`; music generation is **P2** |
| 3 | audio | — ("duck under my voice") | project audio bed | `[project]` | `audio:bed.ducking` | exclusive-group | true | deferred → executed (run 2) | `preset:audio.duck-voice` is P0 |

**Expected path**: Editor Agent, two runs.

**Expected Edit Plan — run 1**

```json
{ "origin": "editor-agent", "baseVersion": "vB2+2", "goal": "Bolder captions; music bed needs a track first",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Captions: Editorial → Box, 64u, accent highlight",
    "ops": [ { "op": "op:caption.setStyle", "intentId": "<intent 1>", "target": { "kind": "project" }, "args": { "presetId": "preset:caption.box", "params": { "fontSize": 64, "position": "bottom", "maxLines": 2 } } } ] } ],
  "touchesLockedKeys": [],
  "risks": [
    { "code": "EM-9004", "message": "'Pop captions' is not available in this version of Expertmotion yet; Box with a larger size is the closest available now.", "severity": "info" },
    { "code": "ASSET-NEEDED", "message": "No music track in this project. Import an audio file (MP3/WAV) and ask again; the bed will be set to soft volume and duck under your voice.", "severity": "warn" } ],
  "status": "valid" }
```

ID variants of the two risks: "'Caption Pop' belum tersedia di versi Expertmotion ini; Kotak dengan ukuran lebih besar adalah yang terdekat saat ini." (EM-9004 copy) / "Belum ada musik di proyek ini. Impor file audio (MP3/WAV) lalu minta lagi; musik akan dipasang pelan dan meredam saat suaramu terdengar."

The agent is expected to call `catalogue.search {query: "pop", category: "caption"}` (returns `[]` in MVP because P1 presets are absent from the capabilities block) and `assets.list` (no audio) before answering; it must **not** emit `op:audio.addBed` without an `assetId` (Zod would reject it in the dry run: EM-4503, surfaced as EM-2303 "Plan is not valid" if uncorrected).

**Expected Edit Plan — run 2**

```json
{ "origin": "editor-agent", "baseVersion": "vB2+3", "goal": "Add soft music bed ducked under voice",
  "steps": [ { "n": 1, "tool": "composition.applyOps", "expectedDiff": "Music bed 'bed-lofi.mp3' at 20 % volume, looped, fades 1 s, ducks to 15 % under clip audio",
    "ops": [ { "op": "op:audio.addBed", "intentId": "<intent 2>", "target": { "kind": "project" }, "args": { "assetId": "FX-M1", "volume": 0.2, "loop": true, "duckingPresetId": "preset:audio.duck-voice" } } ] } ],
  "touchesLockedKeys": [],
  "risks": [ { "code": "DUCK-SOURCE", "message": "There is no separate voice track; the bed ducks under the clips' own audio (clips 2 and 3).", "severity": "info" } ],
  "status": "valid" }
```

**Expected Composition diff**: run 1: `tracks.caption.styleId editorial → box`, `params` updated; pages unchanged. Run 2: `audio: [a1 {assetId FX-M1, role 'bed', atMs 0, volume 0.2, loop true, fadeInMs 1000, fadeOutMs 1000, ducking {preset:audio.duck-voice, {duckTo 0.15, rampMs 500}}}]`. Duration **18 000 ms** (bed loops to project end). Heads `vB2+3`, `vB2+4`.

**Expected render settings**: standard; 540 frames; audio mix present (ffprobe: one AAC stream).

**P1/P2 markers and MVP response**

| Requested | Catalogue status | MVP response in the plan |
|---|---|---|
| "captions pop" (`preset:caption.pop`) | **P1** (PRD-031) | choose a P0 style (`box`), risk `info` with the EM-9004 "Coming in a later version" copy |
| music bed from an existing track (`op:audio.addBed`, `preset:audio.bed-soft`) | **P0** | applied once an asset exists |
| generate music (`music.generate`) | **P2** (PRD-051) | never proposed; the plan asks for an import instead |
| ducking (`preset:audio.duck-voice`) | **P0** | applied with the bed |
| caption generation from the voice (`captions.generate`) | **P1** (PRD-031) | not requested here; if the Creator had asked "add captions" with no SRT, the plan would ask for an SRT import |

**Pass criteria**: run 1 is valid on the first attempt and contains **no** audio op; the warn risk is shown; run 2 adds exactly one audio layer with ducking; replies are in English; at a still at 9 000 ms the Box caption is visible; an audio-level check on the export shows the bed at −14 dB ± 2 dB relative to its unducked level during `c2`'s speech (duck to 0.15 of 0.2 → ≈ −16.5 dB; tolerance for ramps).

## 4. How the scenarios are executed

Three harnesses share the same scenario files and the same assertions (AI_WORKFLOW §13).

### 4.1 (a) Compile path as unit tests

| Item | Specification |
|---|---|
| Location | `packages/agents/test/golden/GS-xx.compile.test.ts` (Vitest), pure functions only (`intents`, `composition`, `catalogue` modules; no DB, no HTTP) |
| Input | `test/fixtures/projects/B0.json … B3.json` (Composition Model + asset metadata); `test/fixtures/events/GS-xx.events.json`: the Creator actions as captured UI events `{el: 'lib.catalogue.card', presetId, selection, playheadMs}` |
| Assertions | (1) the Intent Queue after each event deep-equals the expected table (ids normalised); (2) `compile(intent)` deep-equals the expected ops; (3) `applyOps(model, ops)` produces the expected diff and `deriveTiming().durationMs`; (4) `validate(model)` issues match (codes and severities); (5) zero calls on the provider spy |
| Scenarios | GS-01, 02, 03, 04, 05, 06, 07, 13, 16 (pick part), 19; plus the compiled portions of GS-08, 10, 18 |
| Runs where | every commit (pre-push hook, MCP_AND_TOOLING §4); CI; also on the shared 1.9 GB development server (no Chrome needed) |

### 4.2 (b) Fake provider replaying recorded Edit Plans

| Item | Specification |
|---|---|
| Fixture | `test/fixtures/plans/GS-xx.json` (format below), one file per scenario; recorded once from a live run with a mid-tier model, then hand-edited where a deliberate fault is needed (GS-11, GS-12) |
| Harness | `FakeProviderAdapter` (MCP_AND_TOOLING §5.1) implements `run()` by matching the incoming request to `turns[i].match` (agent, turn index, and a sha256 of the Rewrite envelope's `intents` + `lockedKeys` + `creatorMessage`) and streaming `turns[i].response`; a mismatch fails the test with a diff of the envelope (this is how envelope regressions are caught) |
| Scope | the whole Local Service in-process (Express app with supertest, real SQLite in a temp file, real `applyOps`), no Desktop Shell, no Chrome; render steps use the `RenderAdapter` fake except in GS-14/15, which run the real Engine on Windows CI only |
| Assertions | plan validation results (`status`, `touchesLockedKeys`, `risks`), provider call counts, `agent_runs`/`usage_records` rows, Composition diff, duration, SSE event sequence |
| Scenarios | GS-08, 09, 10, 11, 12, 17, 18, 20 (plus GS-14, 15 for the render queue with the fake Engine) |

Fixture format:

```json
{
  "scenario": "GS-09",
  "recordedAt": "2026-11-xx",
  "recordedWith": { "provider": "openrouter", "model": "<mid-tier model id>", "systemPromptVersion": "editor@1.3.0" },
  "fakeModel": { "id": "fake-mid", "toolCalling": true, "contextLength": 128000, "pricePerMTok": { "in": 1.0, "out": 3.0 } },
  "turns": [
    { "agent": "editor", "n": 1,
      "match": { "envelopeHash": "sha256:…", "creatorMessage": "ganti semua transisi jadi wipe dari kiri", "lockedKeys": ["cut:0.transition", "sequence.clips"] },
      "toolCalls": [ { "name": "composition.get", "input": { "projectId": "$project", "summary": true } } ],
      "response": { "type": "final", "plan": { "goal": "…", "steps": [ … ], "risks": [ … ] } },
      "usage": { "inputTokens": 2890, "outputTokens": 310, "costUsd": 0.0038 } }
  ],
  "expect": { "planStatus": "valid", "touchesLockedKeys": [], "providerCalls": 1, "durationMs": 18000, "headVersionDelta": 1 }
}
```

`$project`, `$intent:n`, `$version:head` are placeholders substituted by the harness. Re-recording: `npm run golden:record -- GS-09 --model <id>` writes a new file and prints the diff against the committed one; a human reviews before commit.

### 4.3 (c) Optional live run

| Item | Specification |
|---|---|
| Command | `npm run eval:agents -- --live --model openrouter/<id> --scenarios GS-08,GS-09,GS-10,GS-11,GS-12,GS-17,GS-18,GS-20 --repeat 5` (Operator's key via environment; never committed) |
| What differs | the real provider answers; assertions on **exact** ops are relaxed to **semantic** checks per scenario (e.g. GS-09: exactly one `op:transition.set`, target `cut:1`, preset `wipe`, direction `from-left`; GS-20 run 1: no audio op, one caption op with a P0 preset) |
| Report | `reports/golden-live-<date>-<model>.json`: per scenario `validFirstAttempt`, `lockedKeyViolationsCaught`, `unvalidatedMutations`, `providerCalls`, `costUsd`, `latencyMs` |
| Where | Operator's PC or CI with network; never on the shared development server during business hours |

### 4.4 Acceptance thresholds (AI_WORKFLOW §13, PRD §5)

| Metric | Threshold | Measured by |
|---|---|---|
| Compile-path scenarios passing | **100 %** (every run) | (a) |
| Replay scenarios passing | **100 %** (every run) | (b) |
| Valid Edit Plan on the first attempt, mid-tier model | **≥ 90 %** over the live set × 5 repeats | (c) |
| Locked Key violations caught | **100 %** (GS-09, GS-11 with randomised violating ops, 20 replays) | (b) |
| Unvalidated mutations | **0** (every `composition_versions` row has a `plan_id` or `cause ∈ {insert, undo, redo, restore, system}`; every op row passed `validateOps`) | (a), (b), (c) |
| Agent cost per scenario, mid-tier model | ≤ US$0.02 (GS-08 two agents ≤ 0.04) | (c) usage records |
| Scenario wall time (replay) | ≤ 5 s each on the reference laptop | (b) |

A release candidate ships only when (a) and (b) are green on Windows CI and the latest (c) report meets the thresholds (DEFINITION_OF_DONE.md).

## 5. Error codes referenced

All codes are owned by ERROR_CATALOGUE.md (159 codes, final); every row below exists there with the meaning given. EM-4503 originated in MCP_AND_TOOLING.md §3.3.1 and is adopted.

| Code | Severity | Meaning here | Scenarios |
|---|---|---|---|
| EM-1301 | error | referenced asset missing before render | GS-14 preflight row |
| EM-1xxx | — | import/ingest failures (malformed SRT) | GS-07b |
| EM-2103 | warn | preset needs a GPU; renders slowly on T0 | GS-06 |
| EM-2105 | error | effect limit for the Hardware Tier reached | GS-06 |
| EM-2201 | error | pick with nothing selected and no clip under the playhead | GS-12 (Target Resolution) |
| EM-2202 | error | no clips yet (used for "no Cut" until GAP-2 is settled) | GS-02, GS-03 edges |
| EM-2301 | warn | Stale Plan (HTTP 409 on Execute) | GS-10 |
| EM-2302 | error | plan touched Locked Keys; steps removed | GS-11 |
| EM-2303 | error | plan not valid | GS-20 (uncorrected dry-run failure) |
| EM-2307 | error | Execute failed; rolled back | GS-17b |
| EM-2308 | info | plan already applied (idempotency) | GS-17b |
| EM-3102 | error | disk preflight | GS-14 |
| EM-3105 | info | resolution not available on this computer | GS-13 |
| EM-3202 | info | render cancelled, partial file removed | GS-15 |
| EM-3203 | warn | render interrupted by restart | GS-15 edge |
| EM-3205 | error | output check (ffprobe) failed | GS-14b |
| EM-3402 | warn | no graphics card detected | GS-06 |
| EM-4005 | info | model works in simple (JSON) mode | MCP_AND_TOOLING §3.5 |
| EM-4201 | error | budget reached | GS-18 |
| EM-4202 | warn | 80 % of budget used | GS-18 |
| EM-4301 | error | model answer unusable after two tries | GS-12 |
| EM-4401 | info | agents off in Private Mode | GS-16 |
| EM-4503 | error | invalid tool input after two corrections | GS-20 |
| EM-7006 | info | model download paused (Private Mode) | GS-16 |
| EM-8202 | info | egress blocked by Private Mode | GS-16 |
| EM-9004 | info | feature coming in a later version | GS-20 |

## 6. Open points raised by the scenarios (to settle in the owning documents; not fixed here)

| Ref | Gap | Owning document |
|---|---|---|
| GAP-1 | **Settled**: AI_WORKFLOW.md §6 expansion rule (one parent intent + per-target children with `parentIntentId`; partial supersession on the children); GS-02 and GS-03 updated | AI_WORKFLOW.md §6 |
| GAP-2 | Code and copy for a transition pick when no Cut applies (one clip, or last clip selected); EM-2202 covers only "no clips yet" | AI_WORKFLOW.md §4, ERROR_CATALOGUE.md |
| GAP-3 | **Settled**: `op:theme.setTextDefaults {fontFamily?, fontSize?, weight?, colour?, align?, opacity?}` added to AI_WORKFLOW.md §5 (propertyKey `theme.textDefaults.<field>`); GS-04 and GS-19 use it | AI_WORKFLOW.md §5 |
| GAP-4 | Element ids used by the scenarios but absent from ELEMENT_IDS.md: `lib.text.add.input`, `lib.assets.card.action.captions`, `agent.editor.plancard.replan` | ELEMENT_IDS.md |
| GAP-5 | Planning rule for a hand-off mixing Compile-able and interpretive intents (GS-08) | AI_WORKFLOW.md §7, §9 |
| GAP-6 | Tier-gated resolution has no preflight row; EM-3105 is `info`, the blocking case at render has no `error` code (GS-13c) | PERFORMANCE.md §7, ERROR_CATALOGUE.md |
| GAP-7 | **Settled**: `ElementRef.kind` now includes `sequence` (AI_WORKFLOW.md §3); `op:clip.insert` targets `{kind: 'sequence'}` | AI_WORKFLOW.md §3, §5 |

## 7. Traceability

| Requirement | Scenarios |
|---|---|
| PRD-005, PRD-006 | GS-01 |
| PRD-008 | GS-13 |
| PRD-010 | GS-18 |
| PRD-011 | GS-08 |
| PRD-012 ("Golden scenarios 1–10 pass") | GS-01 … GS-10 |
| PRD-013 | GS-02, GS-05, GS-06, GS-07 |
| PRD-014 | GS-14, GS-15 |
| PRD-015 | GS-15, GS-17 |
| PRD-019 | GS-06, GS-13 |
| PRD-020 | GS-16 |
| AI-003, AI-011 | GS-01 … GS-07, GS-13, GS-19 |
| AI-004 | GS-08, GS-09, GS-17 |
| AI-005 | GS-12 |
| AI-007, AI-014 | GS-09, GS-11 |
| AI-013 | GS-10 |
| AI-016 | GS-18 |
| AI-017 | GS-16 |
| AI-018 | GS-19 |
| AI-019 | GS-08 |
| UX-013, UX-033, UX-042, UX-053 | GS-04, GS-12, GS-08/09, GS-05 |
