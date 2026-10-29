# AI Workflow: edit-intent pipeline, schemas, operations, agents and tools

| Field | Value |
|---|---|
| Status | baseline |
| Owner | AI agent architect |
| Last updated | 2026-10-30 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-002, 003, 015), ARCHITECTURE.md, DESIGN_CATALOGUE.md, PERFORMANCE.md |
| Used by | AGENT_DESIGN.md, SYSTEM_PROMPT.md, API_SPECIFICATION.md, DATABASE_SCHEMA.md, GOLDEN_SCENARIOS.md, TEST_PLAN.md, FRD.md |
| Owner of | Edit Intent, Edit Plan, Operation, Result, Error, Rollback schemas; the operation vocabulary; Target Resolution; Property Classes; Locked Keys; tool contracts; AI-xxx requirements |
| ID range | AI-001 … AI-099 |

## 1. Principles

- **AI-001** The LLM never enforces invariants. Deterministic code validates, orders, resolves conflicts and mutates state (brief §8.3).
- **AI-002** Every Creator action becomes a typed Edit Intent. Nothing reaches an agent as loose prose except the Creator's own chat message, and even that is wrapped in a typed envelope with context.
- **AI-003** Fully specified intents are compiled without an LLM (brief §16: "selecting a known font size should create a typed operation directly").
- **AI-004** The Creator's **Execute** is the only gate that mutates the Composition Model from a plan. Deterministic picks that compile directly are applied immediately but are still recorded in the Intent Queue and create a Composition Version (so they are undoable and visible).
- **AI-005** Provider responses are untrusted input: parsed with Zod, rejected on failure, retried with the validation error at most twice, then surfaced as `EM-4xxx`.
- **AI-006** Agents call narrow Tools; no shell, no filesystem, no network tools exist in the registry.
- **AI-007** Never silently replace unrelated styling, audio, timing or Creator-selected properties (brief §8.4): Locked Keys + Property Classes + diff preview.

## 2. The 14-step pipeline (brief §8.3) mapped to modules

| Step | What happens | Module | Deterministic? |
|---|---|---|---|
| 1 Capture | UI emits a Design Pick / chat message / handoff | Editor | yes |
| 2 Typed intent | `EditIntent` built with Zod | `intents` | yes |
| 3 Attach references | projectId, sequenceId, selection, playhead, assetIds, baseVersion | `intents` | yes |
| 4 Validate against catalogue | presetId exists, params within schema, hardware/licence flags | `catalogue` | yes |
| 5 Resolve conflicts | Target Resolution + Property Class rules; supersede/append/exclusive | `intents` | yes |
| 6 Rewrite | if `needsInterpretation`, build the complete instruction envelope (intents + context + capabilities) | `intents` | yes |
| 7 Generate plan | Compile (no LLM) or Editor Agent returns `EditPlan` JSON | `intents` / `agents` | compile yes; agent no |
| 8 Validate plan | Zod schema, op vocabulary, Locked Keys, capability rules, `baseVersion`, dry-run `applyOps` on a copy | `composition` | yes |
| 9 Preview/confirm | Plan Card shows steps + expected diff + risks; Execute enabled | Editor | human |
| 10 Execute via tools | `composition.applyOps` inside one DB transaction | `composition`, `db` | yes |
| 11 Update state | new Composition Version; Timeline View and Player refresh via SSE | `http` | yes |
| 12 Validate result | `validate(model)` post-conditions; duration/overlap/asset checks | `composition` | yes |
| 13 Report | `ExecutionResult` with `EM-` codes on failure; rollback automatic | `http` | yes |
| 14 Persist | intents, plan, ops, result, usage saved | `db` | yes |

## 3. Schemas (Zod; TypeScript names in `packages/agents/src/schemas.ts`)

```ts
// Identifiers
const PresetId = z.string().regex(/^preset:[a-z]+\.[a-z0-9-]+$/);      // from DESIGN_CATALOGUE.md
const OpName   = z.string().regex(/^op:[a-z]+\.[a-zA-Z]+$/);           // from §5
const ElementRef = z.object({ kind: z.enum(['sequence','clip','cut','text','caption','audio','shape','background','effect','project','selection','playhead']), id: z.string().optional(), index: z.number().int().optional() });
// Cuts are addressed by 0-based index (cut 0 = between video[0] and video[1]); the UI displays them 1-based ("cut 1").
// Property keys use the 0-based form: "cut:0.transition".

// Edit Intent (step 2)
export const EditIntent = z.object({
  id: z.string(),                       // ulid
  projectId: z.string(),
  source: z.enum(['ui','brainstorm','chat','system']),
  createdAt: z.string().datetime(),
  category: z.enum(['transition','caption','background','motion','shape','easing','effect','audio','text','layout','output','asset','generate']),
  presetId: PresetId.optional(),        // when the pick is a Design Preset
  params: z.record(z.unknown()).default({}),
  target: ElementRef,                   // as given by the UI (may be 'selection' or 'playhead')
  resolvedTargets: z.array(ElementRef).default([]), // after Target Resolution
  propertyKey: z.string(),              // e.g. "cut:2.transition" (0-based), "project.captionStyle", "clip:abc.effects", "theme.textDefaults.fontSize"
  parentIntentId: z.string().optional(),// set on per-target children expanded from a multi-target pick (see §6 expansion rule)
  propertyClass: z.enum(['scalar','list','exclusive-group']),
  needsInterpretation: z.boolean(),     // false => Compile path
  instruction: z.string().optional(),   // free text from chat/brainstorm, if any
  status: z.enum(['queued','superseded','compiled','planned','executed','rejected','removed','held']), // removed = Creator removed it from the queue; Restore sets a superseded intent back to 'queued' and stamps restoredAt; held = the preset needs a model that is not installed (EM-2104, FR-037): persisted, ignored by supersession and planning, set to 'queued' and compiled when model.installed arrives
  restoredAt: z.string().datetime().optional(),
  appliedVersion: z.number().int().min(1).optional(),   // 1-based ordinal of the Composition Version that applied it ("Applied in v{n}" grouping, Stage 3)
  appliedHash: z.string().optional(),                   // hash of that Composition Version; the "Applied directly" line shows it short (FR-085). Absent for zero-op settings intents
  supersedes: z.array(z.string()).default([]),
  baseVersion: z.string(),              // Composition Version hash at capture time
});

// Operation (closed vocabulary, §5)
export const Operation = z.object({
  op: OpName,
  target: ElementRef.optional(),
  args: z.record(z.unknown()),
  intentId: z.string().optional(),      // provenance
});

// Edit Plan (step 7)
export const EditPlan = z.object({
  id: z.string(),
  projectId: z.string(),
  baseVersion: z.string(),
  origin: z.enum(['compile','editor-agent']),
  goal: z.string().max(300),
  steps: z.array(z.object({
    n: z.number().int().min(1),
    tool: z.string(),                   // "composition.applyOps" | "tts.generate" | "captions.generate" (ADR-030 generator steps: args, no ops)
    ops: z.array(Operation).default([]),// for composition.applyOps
    args: z.record(z.unknown()).default({}),
    expectedDiff: z.string().max(200),  // human-readable, shown in Plan Card
    dependsOn: z.array(z.number().int()).default([]),
  })).min(1).max(40),
  touchesLockedKeys: z.array(z.string()).default([]), // must be empty to be valid
  risks: z.array(z.object({ code: z.string(), message: z.string(), severity: z.enum(['info','warn','block']) })).default([]),
  notes: z.string().max(1000).optional(), // Creator-editable free text; never parsed
  status: z.enum(['draft','valid','invalid','stale','executing','executed','failed','cancelled']),
  validation: z.array(z.object({ path: z.string(), message: z.string(), code: z.string() })).default([]),
  usage: z.object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable(), approximate: z.boolean() }).optional(),
});

// Execution result (step 13)
export const ExecutionResult = z.object({
  planId: z.string(),
  ok: z.boolean(),
  fromVersion: z.string(),
  toVersion: z.string().optional(),
  appliedOps: z.number().int(),
  diff: z.array(z.object({ elementId: z.string(), change: z.enum(['added','removed','modified']), fields: z.array(z.string()) })),
  error: z.object({ code: z.string().regex(/^EM-\d{4}$/), message: z.string(), step: z.number().int().optional(), path: z.string().optional() }).optional(),
  rollback: z.object({ performed: z.boolean(), toVersion: z.string() }).optional(),
  durationMs: z.number(),
});
```

Constraints: `EditPlan.steps[*].ops` length ≤ 200 per plan; a plan is one transaction; `notes` is never sent to the model as an instruction (only as `creatorNotes` context in the next turn).

## 4. Target Resolution (step 5)

Applied when `target.kind` is `selection` or `playhead`, or when a category needs a default scope.

| Category | Creator selected a Timeline Element | Nothing selected | Multiple selected |
|---|---|---|---|
| transition | the Cut adjacent (after) the selected Clip; if a Cut is selected, that Cut | **all Cuts** in the Sequence (expanded into one child intent per Cut, see §6) | each selected Clip's following Cut |
| motion, effect | selected Clip or Text Layer | Clip under the playhead; if none, **reject** with `EM-2201` "Select a clip or move the playhead onto one" | each selected element |
| text (font, size, colour, align, variant, effect) | selected Text Layer | sets the **Theme default for new text** via `op:theme.setTextDefaults` (propertyKey `theme.textDefaults.<field>`) and shows "applies to new text"; if a Text Layer exists under the playhead, offer "apply to this text" | each selected Text Layer |
| caption (style) | — | **project** (one caption style per project) | — |
| background | — | **project** background layer | — |
| audio (bed, ducking, fade) | selected Audio Layer | project audio bed | each selected Audio Layer |
| shape | — | new Shape at playhead, centred, default size | — |
| easing | selected Clip/Text motion | Theme default easing | each selected |
| layout (ratio, resolution, palette, font pair) | — | **project** Output Profile or Theme (`op:output.*`, `op:theme.set`); palette and font-pair Design Picks use category `layout` because they change the whole project look | — |
| output (profile) | — | project: a **zero-op settings intent** (FR-090/FR-097): `propertyKey` `project.performanceProfile`, scalar, never interpreted; Compile emits no operation; the Local Service applies it to Settings (`defaultPerformanceProfile`), marks it `executed` (no Composition Version, no plan) and keeps the replaced value in `params.__previous`; Restore of the superseded predecessor applies that profile again (Undo) | — |
| asset (insert, trim) | the Asset/Clip given explicitly | reject | explicit list |
| element edit (ADR-027 Timeline drag / trim / lane change / layer key on a text, image, shape or audio layer; pick field `elementEdit {kind, id, atMs?, durationMs?, trimBeforeMs?, layer?, move?}`) | the element given explicitly; EM-2203 when it no longer exists, EM-2102 when the edit changes nothing | reject | — (one element per gesture) |
| *Compile of an element edit* | timing given (± `layer`) → `op:element.setTiming` (the untouched side of a trim comes from the model); only `move` or `layer` → `op:element.setLayer`; category text / shape / audio / asset (image) by kind; `needsInterpretation: false`; propertyKey = the op's keys joined (`text:<id>.timing\|text:<id>.layer`); never sent to the Editor Agent | — | — |
| split (ADR-028 cut at the playhead: toolbar scissors / S; pick field `splitEdit {atMs, items: [{kind, id}]}`) | each listed clip / text / image / shape / audio that contains `atMs` (the Editor sends the selection; with nothing selected the clip under the playhead) | reject EM-2201 "Move the playhead onto the clip" | one child per item (expansion rule, §6), one Composition Version |
| *Compile of a split* | `op:element.split {atMs}` per item; category asset (clip, image) / text / shape / audio; propertyKey `list:split:<kind>:<id>:<atMs>:<unique>` (a split never supersedes another pick and is not a Locked Key); `needsInterpretation: false` | — | — |
| transform (ADR-028 Player handles / Inspector fields on a clip, image or shape; pick field `transformEdit {kind, id, x?, y?, scale?, rotation?}`) | the element given explicitly; EM-2203 when gone, EM-2102 when no field is given | reject | — (one element per gesture) |
| *Compile of a transform* | `op:element.setTransform` with the fields given (the Player sends all four, so supersession keeps the newest full state); propertyKey `<kind>:<id>.transform`; category asset (clip, image) / shape | — | — |
| items (ADR-031 manual Delete / Duplicate: Delete / Backspace, inspector Delete, item menu; pick field `itemsEdit {action: 'remove' \| 'duplicate', items: [{kind, id?, index?}]}`, kinds clip / text / image / shape / audio / cut / effect (`<clipId>\|<presetId>`) / background / caption) | the listed items that still exist; a deleted scene clip adds its own texts / images / shapes (fully inside its window); Duplicate keeps clips, texts, images and shapes only | reject EM-2201 (nothing listed / nothing duplicable) or EM-2203 (all gone) | one child per op (expansion rule, §6), one Composition Version |
| items paste (FR-256, ADR-035: Ctrl+V / item menu Paste; pick field `itemsEdit {action: 'paste', items: [], paste: {atMs, entries: [{kind: clip \| scene \| text \| image \| shape \| audio, offsetMs, durationMs, op}]}}`, entries = in-app clipboard snapshots from `copySnapshot`) | one synthetic target `{kind: 'project', index: n}` per entry (`pasteSteps`; the originals may be gone after Cut) | reject EM-2201 (no usable entry); the Local Service refuses > 50 entries, > 64 KB or an op that is not the add op of its kind (400) | one child per entry, clips first at the cut at / after `atMs`, ONE Composition Version |
| *Compile of an items pick* | `removalSteps` / `duplicationSteps` (packages/composition-model `items.ts`): Delete → `op:transition.clear`, `op:effect.remove`, `op:background.clear`, one `op:caption.setPages` without the pages, `op:text.remove` / `op:overlay.remove` / `op:shape.remove`, `op:audio.remove`, `op:clip.remove` (in that order); Duplicate → texts / images / shapes first (`op:text.add` / `op:overlay.addImage` / `op:shape.add` starting where the original ends), then clips from the last to the first (`op:clip.insert` / `op:scene.add` at `i + 1` with every field of the clip — volume, fades, rate, fit, crop, transform, motion, effects — scene copies with copies of their items), voice / sfx audio layers as `op:audio.addLayer` with every field, starting where the original ends (round 2); category by kind (asset when mixed); propertyKey `list:remove:<kind>:<id or index>:<unique>` / `list:duplicate:…` (events: never supersede, never Locked Keys); `needsInterpretation: false` | — | — |
| generate (voice, music, thumbnail, captions, hashtags) | — | project; result inserted at playhead or as new layer | — |

The resolved target is written to `resolvedTargets` and displayed on the Intent Queue item ("Transition · Fade → all 3 cuts").

**Scene anchoring (ADR-031, applyOperations).** A text, image or shape whose span lies completely inside the window of a scene clip (a clip without media, ADR-030) belongs to that scene clip (the latest-starting one where windows overlap at a transition). After every op that can move clip starts (`op:clip.insert`, `op:clip.remove`, `op:clip.move`, `op:clip.setTrim`, `op:clip.setPlaybackRate`, `op:scene.add`, `op:transition.set`, `op:transition.clear`, `op:element.split`) those items move by the change of their clip's start, earliest first, with the lane rule. Media clips anchor nothing; items across a cut or over the whole video keep their absolute times; the items of a removed clip stay (a Delete pick removes them explicitly).

## 5. Operation vocabulary (closed; adding an op requires an ADR note and a catalogue/test update)

| op | target | args (Zod summary) | Property class | Notes |
|---|---|---|---|---|
| `op:clip.insert` | sequence | `{assetId, atIndex?, trimBeforeMs?, durationMs?, volume? (0..1), muted?, fadeInMs?, fadeOutMs?, objectFit? (cover\|contain), crop? {left, right, top, bottom} (0..0.9, < 0.95 per axis), transform? {x?, y?, scale? (0.1..10), rotation?}, playbackRate? (0.25..4), motion? {presetId, durationMs?, delayMs?, easingId?, exit?, params?}, effects? [{presetId, params?}] (≤ 3, CM-006 per tier)}` | list | from Insert; durationMs defaults to asset duration; FR-261 / ADR-038: sound, fit, crop and frame position can be given at insert (the scene composer cannot target a clip it has not created yet); round 2 (2026-10-30): `playbackRate`, `motion` and `effects` too, so Duplicate / Copy-Paste rebuild a clip with every field; absent = the defaults before (volume 1, cover, no crop, identity transform, rate 1, no motion, no effects) |
| `op:clip.remove` | clip | `{}` | — | destructive → confirmation in a plan (the Creator's own Delete, ADR-031, applies directly with Undo); ADR-031 scene anchoring: later scene clips' own texts / images / shapes move with their clips (this op does not remove the removed scene's items; a Delete pick removes them explicitly) |
| `op:clip.move` | clip | `{toIndex}` | — | P1 reordering (FR-068 Timeline drag); the cut count is unchanged, so transitions stay on their cut positions and re-attach to the new neighbours; a Creator drag records key `clip:<id>.order` |
| `op:clip.setTrim` | clip | `{trimBeforeMs, durationMs}` | scalar | validator: within asset duration |
| `op:clip.setPlaybackRate` | clip | `{rate: 0.25..4}` | scalar | no reverse |
| `op:clip.setVolume` | clip | `{volume: 0..1, fadeInMs?, fadeOutMs?}` | scalar | |
| `op:clip.setFit` | clip | `{objectFit: 'cover'|'contain', crop?}` | scalar | |
| `op:transition.set` | cut | `{presetId, durationMs, timing: 'linear'|'spring', params?}` | exclusive-group | validator recomputes total duration |
| `op:transition.clear` | cut | `{}` | — | |
| `op:text.add` | playhead/absolute | `{text, variant, atMs, durationMs, position?, styleOverrides?, layer?, maxWidth? (u), valign? ('center'\|'top'), motion? {presetId, durationMs?, delayMs?, easingId?, exit?, params?}, effect? {presetId, params?}}` | list | uses Theme defaults; layer by the ADR-027 lane rule (front of everything it overlaps unless `layer` is given). ADR-034: without `motion` the variant's default entrance + exit applies (`preset:motion.none` = static); without `position` the text goes to its variant position unless another text playing at the same time is painted there, then it is stacked below (or above) it inside the safe area (QA 2026-10-28 #19) |
| `op:scene.add` | sequence | `{durationMs (500..120000), background? = preset:background.gradient (a background preset id), backgroundParams?, atIndex?, title? (≤ 200), text? (≤ 500), titleVariant? = preset:text.title, textVariant? = preset:text.subtitle (title when there is no title), motionId? (motion preset for the texts; default the variant's), transition? (transition preset into this scene from the previous one), transitionMs? = 500, + the clip look of `op:clip.insert` (volume?, muted?, fadeInMs?, fadeOutMs?, objectFit?, crop?, transform?, playbackRate?, motion?, effects?; round 2, so a scene copy keeps its look)}` | list | ADR-030 (videos without media, FR-188): appends (or inserts at `atIndex`) a **scene clip** — a clip without media that shows its background preset for `durationMs` — and its title / body text over it (from the clip start plus the incoming transition, to the clip end), and sets the transition on the cut before it; cuts, transitions, effects, split, trim, Undo, Timeline and render treat it like any clip; total duration = Σ scenes − transitions; keys as `op:clip.insert` |
| `op:scene.setBackground` | clip (scene clip) | `{presetId (background), params?}` | scalar | ADR-030: changes a scene clip's background; on a media clip → EM-2102; key `clip:<id>.scene` |
| `op:text.setContent` | text | `{text}` | scalar | |
| `op:text.setStyle` | text | `{fontFamily?, fontSize? (16..600 u), weight?, italic?, colour?, align?, opacity?, lineHeight? (0.8..2.5), box? {colour, padX, padY, radius} (u; ADR-034 pill / chip), variant?}` | scalar per field | each field its own Locked Key; `variant` (FR-025) sets `variantId`, moves the layer to the variant position and drops its size/weight/align overrides |
| `op:text.setEffect` | text | `{presetId, params?}` | exclusive-group | text effects |
| `op:text.setTiming` | text | `{atMs, durationMs}` | scalar | kept for compatibility; same key and lane rule as `op:element.setTiming` |
| `op:text.remove` | text | `{}` | — | |
| `op:caption.importSrt` | project | `{assetId}` | — | P0 caption display path |
| `op:caption.setStyle` | project | `{presetId, params?}` | exclusive-group | |
| `op:caption.setPages` | project | `{pages: Caption pages}` | scalar | produced by Caption sub-agent (P1) |
| `op:caption.clear` | project | `{}` | — | |
| `op:caption.replaceText` | project | `{find (1..200), replace (0..200), atMs?, pageIndex?, all? = false, caseSensitive? = false}` | scalar | ADR-033: fixes words in one caption page without rewriting the track. `atMs` = the page whose [startMs, endMs) holds it, else the nearest page within 1500 ms that contains `find`; `pageIndex` = `composition.captions.list[].i`; neither = first page containing it. One occurrence unless `all` (that page, or every page without an address). Only the tokens holding the match are re-split over their own time span (in proportion to characters); page start / duration unchanged; a page left empty is removed. Not found / no page there / both addresses → EM-2102 (message quotes the nearby page text). Locked Key `project.captionPages.<i>.text` (`.@<atMs>.text` by time, `.text` without address) |
| `op:caption.editPage` | project | `{text (1..500), atMs? \| pageIndex?}` (exactly one address) | scalar | ADR-033: the whole text of one page; same start / duration, tokens re-timed over the page's span; same addressing, codes and Locked Key as `op:caption.replaceText` |
| `op:background.set` | project | `{presetId, params?}` | exclusive-group | |
| `op:background.clear` | project | `{}` | — | |
| `op:motion.set` | clip/text | `{presetId, params?: {durationMs?, delayMs?, easingId?}}` | exclusive-group per element | enter/exit motion |
| `op:motion.clear` | clip/text | `{}` | — | |
| `op:easing.setDefault` | project | `{easingId}` | scalar | Theme |
| `op:effect.add` | clip/text/background | `{presetId, params?}` | list (dedupe by presetId) | max 3 per element (T0: 2) |
| `op:effect.remove` | clip/text/background | `{presetId}` | — | |
| `op:effect.setParams` | element+preset | `{params}` | scalar | |
| `op:shape.add` | absolute | `{presetId, atMs, durationMs, position, size, height? (u; w × h box, ADR-034), fill, stroke?, strokeWidth?, opacity?, motionId?, motion? {…as op:text.add}, params?, layer?, scale? (0.05…20), rotation? (°)}` | list | layer as `op:text.add`; ADR-034: without motion a default entrance (pop; line wipe-reveal; ring / check / chevron draw-on) |
| `op:shape.remove` | shape | `{}` | — | |
| `op:overlay.addImage` | absolute | `{assetId, atMs, durationMs?=5000, position?, size? (width in u; height from the image aspect), objectFit?='contain', opacity?=1, layer?, motion?, scale? (0.05…20), rotation? (°)}` | list | ADR-020 addition (FR-029 Insert Image); layer as `op:text.add`; ADR-034: default entrance scale-in; `scale` / `rotation` stored as `op:element.setTransform` does (review 2026-10-29: Duplicate / Paste copy every field of a text / image / shape) |
| `op:overlay.remove` | image | `{}` | — | ADR-020 addition |
| `op:overlay.setOpacity` | image/shape | `{opacity: 0..1}` | scalar | ADR-020 addition (FR-028 opacity of an overlay image or Shape); key `<kind>:<id>.opacity` |
| `op:element.setTiming` | text/image/shape/audio | `{atMs, durationMs, trimBeforeMs? (audio only: source offset of a left-edge trim), layer? (0..999)}` | scalar | ADR-027 (FR-068 Timeline drag/trim): start and length of any text, image, shape or audio layer; the item keeps its lane when it is free at the new time, else goes to the lane above (or a new lane inserted there); with `layer` it asks for that lane by the same rule (one op per drag gesture); audio: within the source unless looping (EM-2306), fades clamped to half the length; keys `<kind>:<id>.timing` (+ `<kind>:<id>.layer` with `layer`) |
| `op:element.setLayer` | text/image/shape/audio | exactly one of `{layer: 0..999}` or `{move: 'up'\|'down'\|'front'\|'back'}` | scalar | ADR-027 stacking order ("put the title above the image" = `move: 'front'` on the title): `up`/`down` one lane (passing the item there when that lane is busy at this time), `front`/`back` in front of / behind every item it overlaps; audio has lanes but no stacking (`layer` or `up` = towards the video Track / `down`; `front`/`back` → EM-2102); key `<kind>:<id>.layer` |
| `op:element.split` | clip/text/image/shape/audio | `{atMs}` (composition time, ms; ≥ 100 ms from both ends of the item) | — | ADR-028 (FR-179 cut / split): two adjacent parts; the target keeps its id and becomes the first part, the second part gets a new id and continues the source (clip `trimBeforeMs + d × playbackRate`, image clips stay 0; audio `trimBeforeMs + d`, wrapped by the source length when looping; an open-ended audio layer stays open); the first part keeps the fade-in and the motion (exit off), the second part the fade-out and no motion; effects, volume, fit, crop and transform go to both; a clip split inserts a cut without transition, the transition after the clip moves to the second part (cut indexes after it shift +1) and the transitions next to the parts are re-clamped to half the shorter clip (EM-2305 warn, removed below 100 ms); visual items and audio keep their lane; outside the item → EM-2102; keys `clip:<id>.trim` + `sequence.order` (clip) or `<kind>:<id>.timing` |
| `op:element.setTransform` | clip/image/shape/text (text: x / y only, ADR-034 quality-gate re-flow) | at least one of `{x?: -2..2, y?: -2..2, scale?, rotation?: -360..360}` | scalar | ADR-028 (FR-180 canvas transform): absolute values, omitted fields keep theirs. `x` / `y` = centre offset as a fraction of the frame width / height (0 = centred, −0.25 = a quarter of the frame to the left / up); `scale` 1 = the `objectFit` result for a clip (0.1..10, else EM-2102) or the stored `size` for an image / shape (0.05..20); `rotation` degrees clockwise, stored in [0, 360). Clip → `transform` (removed again at identity, so a reset restores the old hash); image / shape → `position` (u = x × frame width) + `scale` / `rotation` (removed at 1 / 0); key `<kind>:<id>.transform` |
| `op:audio.addBed` | project | `{assetId, volume, loop, duckingPresetId?, duckingParams?, fadeInMs?, fadeOutMs?}` | list | background music; FR-266: `duckingParams` (e.g. `{volume, duckTo, rampMs}` of `preset:audio.duck-voice`) set with the bed |
| `op:audio.addLayer` | absolute | `{assetId, atMs, volume, role? = voice (voice\|sfx), fadeInMs?, fadeOutMs?, trimBeforeMs? (< asset length, else EM-2306), durationMs? (≥ 100; default the asset length, minus the trim when one is given), loop? = false, ducking? {presetId: preset:audio.duck-voice, params?}}` | list | voice, sfx; round 2 (2026-10-30): trim / length / loop / ducking so Duplicate and Copy-Paste rebuild a layer exactly (audio voice / sfx layers are duplicable; beds are not) |
| `op:audio.setDucking` | audio | `{presetId, params?}` | exclusive-group | |
| `op:audio.setFades` | audio | `{fadeInMs?, fadeOutMs?}` (integers, ms, ≤ half the layer duration each) | scalar per field | applies `preset:audio.fade-in-out`; added 2026-10-24 (ADR-020) |
| `op:audio.remove` | audio | `{}` | — | |
| `op:theme.set` | project | `{paletteId?, fontPairId?, defaultEasingId?}` | scalar per field | |
| `op:theme.setTextDefaults` | project | `{fontFamily?, fontSize? (16..200 u), weight?, italic?, colour?, align?, opacity?}` | scalar per field | Theme defaults for new Text Layers; propertyKey `theme.textDefaults.<field>` |
| `op:output.setRatio` | project | `{ratio}` | scalar | 16:9 … custom |
| `op:output.setResolution` | project | `{preset}` | scalar | gated by tier |
| `op:output.setAutoRatio` | project | `{on}` | scalar | FR-088: on = ratio follows the first Clip's probe (nearest supported ratio) now and whenever the first Clip changes; `op:output.setRatio` turns it off; key `project.ratioAuto` |
| `op:project.setFps` | project | `{fps}` | scalar | re-derives frames |
| `op:project.setDurationPolicy` | project | `{policy: 'fit-content'|'fixed', fixedMs?}` | scalar | |
| `op:generated.insert` | project | `{kind: 'voice'|'music'|'thumbnail'|'captions', jobId, atMs?}` | list | result of a generator job (thumbnail: the chosen candidate as an image overlay at `atMs`, FR-103) |

Ops never reference file paths; they reference `assetId`/`jobId`. Ops never contain code.

## 6. Property Classes and conflict rules (step 5, brief §8.4)

| Class | On new intent with same `propertyKey` | Intent Queue display |
|---|---|---|
| scalar | new intent supersedes the old (`status: superseded`, `supersedes: [old]`); old stays visible struck through with **Restore** | "Font size 72 (replaced 64)" |
| list | both kept; duplicates by `presetId` on the same target are merged (params of the newest win) | "Effects: Vignette, Film grain" |
| exclusive-group | same as scalar within the group (one transition per Cut, one caption style per project) | "Transition on cut 2: Slide (replaced Fade)" |

**Expansion rule (multi-target picks).** When Target Resolution yields N targets (for example "all Cuts"), the pick is stored as one parent intent (displayed as one queue item, "Fade → all 3 cuts") plus N child intents with `parentIntentId` and per-target `propertyKey` (`cut:0.transition`, `cut:1.transition`, …). Supersession works on the children: a later pick for one Cut supersedes only that child ("Fade → cuts 1, 3 · cut 2 replaced by Slide"). A parent is `superseded` only when all its children are.

**Mixed queues.** Compile-able intents are compiled and applied immediately (AI-004) and their keys locked; when the Editor Agent is invoked for the remaining interpretive intents (including a Brainstorming hand-off that mixes both kinds), it receives the already-applied state and the Locked Keys, so one plan covers only what still needs interpretation.

Conflict matrix for the brief's example "two operations modify the same clip boundary":

| Situation | Resolution |
|---|---|
| Two `setTrim` on the same clip in one plan | second one wins; plan validator emits `warn` "duplicate trim on clip X, keeping last" |
| `setTrim` makes a Cut's transition longer than the shorter adjacent clip | validator clamps the transition to 50 % of the shorter clip and emits `warn`; if < 100 ms, `block` |
| `clip.remove` while an intent targets that clip | dependent intents are marked `rejected` with reason; shown in queue |
| Plan `baseVersion` ≠ current head | plan `stale`; UI shows "Composition changed; re-plan"; never force-applied |
| Compiled (locked) key appears in an agent op | plan `invalid` with `touchesLockedKeys`; Editor Agent is re-prompted once with the list; if it persists, the op is dropped and the Creator told |
| Total duration < 1 s or > 30 min after ops | `block` |
| Caption pages extend past the end | pages trimmed; `warn` |
| A move, trim or add puts a text/image/shape/audio layer over another item on the same lane | ADR-027 lane rule in `applyOps`: the item goes to the lane above (a new lane is inserted there when that one is busy too); lanes never hold overlapping items (CM-012) and stay dense |
| A split puts a clip part next to a transition longer than half of it | ADR-028: `applyOps` re-clamps that transition to half the shorter clip (EM-2305 warn) or removes it below 100 ms |

Idempotency: every plan execution is keyed by `planId`; re-sending the same `Execute` is a no-op returning the first result. Retries of provider calls never re-execute ops.

## 7. Compile vs Rewrite decision

`needsInterpretation = false` (Compile) when: `presetId` or every required arg is present; target resolves to ≥ 1 element without ambiguity; no `instruction` text. Compile maps category → ops using DESIGN_CATALOGUE defaults (one table in code, tested per preset).

`needsInterpretation = true` (Rewrite → Editor Agent) when: free-text instruction exists; the pick needs creative placement (e.g. "add a title" without text); generation is requested; or Target Resolution yields a choice the rules do not settle.

Rewrite envelope sent to the Editor Agent (JSON, not prose):

```json
{
  "task": "produce EditPlan",
  "project": { "id": "...", "fps": 30, "ratio": "9:16", "resolution": "1080p", "durationMs": 42000, "theme": {...} },
  "composition": { "version": "v12-ab12", "tracks": [...compact summary, ≤ 4k tokens...] },
  "assets": [{ "id": "...", "kind": "video", "durationMs": 15000, "name": "clip1.mp4", "hasAudio": true }],
  "intents": [ ...queued EditIntents, with resolvedTargets... ],
  "lockedKeys": ["cut:1.transition", "project.captionStyle"],
  "creatorMessage": "buat judul pembuka yang kuat, nuansa energik",
  "creatorNotes": "...from the previous Plan Card notes, if any...",
  "selection": [{ "kind": "clip", "id": "..." }],   // FR-080: Timeline selection at send time (omitted when empty)
  "playheadMs": 3000,                              // FR-080: playhead at send time (chat messages)
  "attachments": ["logo.png"],                     // FR-072: names only; images go as image parts to image-input models
  "targets": [{ "kind": "asset", "id": "...", "label": "Reels 14.m4a", "facts": { "assetKind": "audio", "durationMs": 14000, "onTimeline": [] } }],   // FR-189: chat chips (omitted when none)
  "capabilities": { "ops": [...names...], "opArgs": { "op:text.add": "{text: string, variant: preset id, atMs: int 0.., durationMs: int 100.., …} target: none", ... },
                    "presets": {...ids by category, with hardware flags...}, "maxOpsPerPlan": 200,
                    "stepTools": { "tts.generate": { "available": true, "model": "…" }, "captions.generate": { "script": true, "sequence": false } } },
  "constraints": ["never touch lockedKeys", "times in ms", "respond with EditPlan JSON only"]
}
```

### 7.1 Reading a model-authored plan (ADR-030, QA 2026-10-26)

Real models (Claude Haiku 4.5 on Windows) produced plans that a strict parser rejected three times. `parseModelReply` therefore first applies `normalizeModelReply` (`packages/agents/src/plan-normalize.ts`), which repairs only **unambiguous** slips and lists each repair (`fixes`, logged as counts and kinds, never content):

| Slip | Repair |
|---|---|
| prose / ```json fence around the JSON; `{plan: …}` / `{editPlan: …}` wrapper; a top-level `ops` array; a step that is itself one op | parsed / unwrapped / wrapped into one `composition.applyOps` step |
| missing `n`, `expectedDiff`, `dependsOn`, `risks`; risks as strings; `questions` | numbered from 1; empty; `[]`; `{code:'note', severity:'info'}`; one `needs-input` risk |
| `goal` > 300 or `expectedDiff` > 200 characters | clipped with "…" |
| `baseVersion` missing or different | replaced by the runtime's base (staleness is checked against the head by the Local Service, AI-013) |
| `tool` "applyOps", "composition.apply", "tts", "voice.generate", "captions" … | the plan step tool it names |
| op name without `op:`, wrong case, known alias (`op:transition.add` → `op:transition.set`, `op:clip.trim` → `op:clip.setTrim`, `op:clip.split` → `op:element.split`, …) | the vocabulary name |
| args in `params` / `arguments` / at the op's top level | moved into `args` |
| near-miss arg names that the op does not have (`startMs`/`start` → `atMs`, `duration` → `durationMs`, `content` → `text`, `preset` → `presetId`, `color` → `colour`, `speed` → `rate`, `zoom` → `scale`, …); `endMs` with `atMs` | renamed / `durationMs = endMs − atMs` |
| numbers as strings; fractional ms; volume 0–100; scale in percent | numbers; rounded; ÷ 100 |
| short preset ids (`"fade"` for a transition, `"title"` for a variant) | `preset:<category>.<name>` when that preset exists |
| forgotten fields with one obvious value (`op:text.add` variant / atMs / durationMs, `op:transition.set` durationMs, `op:audio.addLayer` volume, `op:shape.add` atMs / durationMs) | `preset:text.title` / 0 / 3000; 500; 1; 0 / 3000 |
| target as a bare id or number; kind alias (`video`, `title`, `music`, `logo`); extra keys; the id of an **asset** where its one clip / layer / image is meant; a target inside args (`clipId`, `cutIndex`) | the element's real `{kind, id}` / `{kind:'cut', index}` (left as is when ambiguous) |
| unknown arg keys | dropped and named in the correction message |
| mismatched / missing JSON closers (`…]}]}` for `…]}}`, live nemotron-3-ultra) | the closer the innermost open bracket needs; ≤ 2 missing closers appended after a complete value (`repairJsonClosers`, never inside a string) |
| plan step tool args: `captions.generate {stylePreset | style | preset …}`, `{script | content}`; `tts.generate {script | narration, voice}`; unknown keys | renamed to `presetId` / `text` / `voiceId` (short caption ids completed), unknown keys dropped; captions with no script and no voice-over take the on-screen texts the plan adds (scene titles / texts in order); nothing to caption → the step is left out with a `step-dropped` warn risk |
| reasoning in the answer text (`<think>…</think>`, `<thinking>`, `<reasoning>`, an unclosed leading `<think>`; Entry 25b) | removed before parsing (`stripReasoning`); JSON inside the reasoning is never the plan |
| several JSON objects in one reply (examples, a tool call next to the plan) | the first object with `steps` / `ops` / `intents` (`extractPlanJson`) |
| preset params (`backgroundParams` of `op:scene.add`; `params` of `op:background.set`, `op:scene.setBackground`, `op:transition.set`, `op:motion.set`, `op:caption.setStyle`, `op:text.setEffect`, `op:effect.*`, `op:shape.add`, `op:audio.setDucking`) checked against the preset's own schema (`repairPresetParams`) | a preset param written at the op's top level moves into the params object; a name that matches a param up to case / separators / colour spelling is renamed, any other unknown name is dropped; numbers as strings converted and **clamped** into range; near-miss enum values mapped (`left` → `from-left`, case); `#abc` → `#aabbcc`; a value that still does not fit an **optional** param is dropped (the preset default applies). A required param that is still wrong goes to validation |
| `intents` instead of a plan | intents with a preset id compile deterministically (no extra model call); otherwise one correction asking for ops |

Everything else goes to validation; a rejection is sent back (max `maxCorrections` = 2) as one line per blocking issue with the **step, op index and op name** and that op's exact args signature from `capabilities.opArgs` (`correctionMessage`); an unknown preset id (EM-2101) adds the valid ids of its category, a params error (EM-2102 on `…params…`) adds that preset's params with types and ranges. A reply cut off at the output limit (finish reason `length`) is answered with "reply again with a SHORTER plan", not "invalid JSON". Two replies in a row **without any JSON** end the run (EM-4301) without a third call. The Editor reply budget is `EDITOR_MAX_TOKENS` = 8192 output tokens (reasoning models count their thinking there) unless the Model Assignment sets `maxTokens`. Every attempt streams when the adapter can (OpenRouter), so the limit is silence, not total answer time (§12). When the Creator pointed at elements (FR-189) and no valid plan results, the run returns a zero-step plan with one `needs-input` question about those elements instead of EM-4301.

## 8. Tools (registry; permissions in AGENT_DESIGN.md)

| Tool | Input | Output | Side effects | Who may call |
|---|---|---|---|---|
| `composition.get` | `{projectId, version?}` | Composition Model summary or full | none | both agents |
| `composition.validateOps` | `{baseVersion, ops}` | `{ok, issues, predictedDiff, predictedDurationMs}` | none (dry run) | Editor Agent |
| `composition.applyOps` | `{planId}` | `ExecutionResult` | mutates (only during Execute) | runtime only (not callable by the model directly) |
| `catalogue.search` | `{query, category?}` | presets with params schema | none | both |
| `assets.list` | `{projectId}` | asset metadata | none | both |
| `assets.probe` | `{assetId}` | detailed probe | none | Editor Agent |
| `captions.generate` | plan step args `{source: 'script' \| 'voice' \| 'sequence', text?, atMs?, durationMs?, presetId?, language?}` | `script`: pages from the text over the window (no model; becomes `op:caption.setPages` in the plan's own version); `voice`: after the step's voice job, script pages timed over the voice layer; `sequence`: `{jobId}` → pages (whisper) | `sequence` spawns whisper | Editor Agent via plan step (ADR-030) |
| `tts.generate` | plan step args `{text (≤ 2000), atMs?, voiceId?, language?, speed?}` | `{jobId}` → voice Asset inserted at `atMs` as a later Composition Version | spawns sherpa-onnx | Editor Agent via plan step (ADR-030); without an installed voice model the step is `needs-model` + a `model-missing` warn risk (Model Manager link), the other steps run |
| `music.generate` | plan step args `{prompt (mood / style words), durationMs? (default: the planned video length), volume? (0.02..1, default 0.2), trackId?}` | after Execute: the best-fit CC0 library track (FR-247; downloaded + verified on first use), looped and faded to `durationMs`, ONE `op:audio.addBed` with `duckingPresetId: preset:audio.duck-voice` + `duckingParams {volume, duckTo ≈ 0.35 × volume, rampMs 400}` (FR-266, ADR-038); Private Mode without a downloaded track → EM-8202 notice | none (download only) | Editor Agent via plan step, or `music` in a VideoSpec |
| `scene.compose` | plan step args = **VideoSpec** (`packages/agents/src/auto-motion-spec.ts`; signature in `capabilities.sceneCompose`): `{title?, ratio?, fps?, mood?, style? {background, fontFamily, colors, safeArea, sourceBottomPx, transition}, voice? {clips [{id, text, assetId?, durationMs?}], gapMs?, tailMs?, generate?}, captions?, captionStyle?, music? {mood?, prompt?, volume?}, scenes [{role, clips?, durationMs?, holdMs?, narration?, kicker?, headline?, sub?, bullets?, stats?, bars?, note?, quote?, handle?, action?, pill?, keywords?, assetId?, source?, topPx?, footage? {assetId, fromMs?, toMs?, volume?, muted?, fit?, focus?}, lowerThird? {name, title?, at?, ms?}, overlay?, side?}]}` (FR-261 roles `footage` / `footage-split` / `footage-pip`; anchors also `{footageMs}` and `{say}`); also accepted as an op `op:scene.compose {…VideoSpec}` inside `composition.applyOps` | expanded BEFORE validation by the deterministic scene composer (`composeScenes`, ADR-034) into one `composition.applyOps` step (theme, background, `op:scene.add` per scene, `op:transition.set` per cut, `op:text.add` / `op:shape.add` / `op:overlay.addImage` with positions, motions and effects, `op:audio.addLayer` for clips with an asset) + one `tts.generate` step per voice clip without an asset (+ `captions.generate` when `captions`: source `voice` with a voice-over, else `sequence` with `captionStyle` / `preset:caption.karaoke` when the footage has sound) (+ `music.generate` when `music`); footage scenes become `op:clip.insert` with the source trim, sound (1.0, or 0.2 under a voice-over), crop / transform for split / pip, and overlays only in the top / bottom third for a few seconds each (ADR-038); the quality gate runs on the result; risks: `timing-estimated`, `no-source`, `no-figure`, `bars-scaled`, `scene-tight`, `quality`, `too-long`, `unknown-clip` / `unknown-anchor`, `footage-missing`, `footage-short`, `footage-shorter`, `footage-trim`, `footage-dense`, `say-not-found`, `captions-nothing` | none until Execute | Editor Agent via plan step (ADR-034) |
| `music.generate` | `{prompt, durationMs, style}` | `{jobId}` → asset | spawns ACE-Step (P2) | plan step |
| `thumbnail.generate` | `{prompt?, frameMs?, titleText?}` | `{jobId}` → image | spawns sd.cpp / renderStill (P2) | plan step |
| `render.estimate` | `{versionId, outputProfile, performanceProfile}` | `{seconds, bytes, warnings}` | none | both |
| `render.start` | `{versionId, ...}` | `{jobId}` | enqueues | **Creator only** (Export dialog); agents may only suggest |
| `hardware.profile` | `{}` | tier, RAM, GPU | none | both |
| `project.settings.get` | `{projectId}` | settings | none | both |
| `web.search` | `{query (2…300)}` | `{summary (≤ 6 000 chars), sources: [{url, title}], queries?}` | outbound: one search on the SAME provider connection (§8.2) | both, when research is allowed and the provider has no server-side search |
| `web.fetch` | `{url}` | `{url, title, text (≤ 20 000 chars), truncated}` or `{error: EM-4406}` | outbound through egress `research` (SEC-140) | both, same condition; only URLs from the conversation (SEC-141) |
| `web.images` | `{query}` | `{candidates: [{source, id, title, creator, license, width, height}]}` (no URLs) | outbound to Openverse / Wikimedia (`research-api`) | both, when research is allowed; the Creator imports (R-089) |

Editor Agent tool loop (FR-080): the same JSON-mode protocol as the Brainstorming Agent (`{"tool","input"}` → `{"toolResult"}`, at most 4 calls per run, not counted as corrections) over `composition.get`, `assets.list`, `catalogue.search`, `hardware.profile`, `project.settings.get`, `render.estimate`, `composition.validateOps` and `assets.probe`. Editor Chat messages become `EditIntent { source: 'chat', category: 'layout', propertyKey: 'chat:<messageId>', needsInterpretation: true, instruction }` in the Intent Queue before the run. Tools called by the model are read-only or produce proposals; all mutations happen through Execute. Tool inputs are Zod-validated; failures return `{error: {code, message}}` so the model can correct itself (max 2 corrections).

### 8.1 Native tool calling and the JSON-mode fallback (FR-211, ADR-032, Entry 30, QA 2026-10-27)

The read-only tools above go through the provider's own tools API when it has one; the JSON-mode protocol stays as the fallback.

| Provider | Tools sent as | Calls come back as | Results go back as | Replay of the calling turn |
|---|---|---|---|---|
| Anthropic (Messages API) | `tools: [{name, description, input_schema}]`, `tool_choice: {type: auto}` (`none` for the answer-now call; forced `any` / `tool` is never used — current models refuse it) | `tool_use` blocks (`input_json_delta` while streaming) | one user message, `tool_result` blocks first (`is_error` for failures) | the turn's content blocks unchanged, thinking blocks with their signatures first |
| OpenAI (Chat Completions) | `tools: [{type: function, function: {name, description, parameters}}]`, `tool_choice` | `tool_calls` (streamed fragments by index) | one `role: tool` message per call | `role: assistant` with `tool_calls` |
| Gemini | `tools: [{functionDeclarations: [{name, description, parametersJsonSchema}]}]`, `toolConfig.functionCallingConfig.mode` AUTO / NONE | `functionCall` parts | `functionResponse` parts | the model's parts unchanged (thought signatures kept) |
| OpenRouter | AI SDK tools without `execute`, only when the Capability Table row says `toolCalling: true` | `tool-call` stream parts | `role: tool` tool-result parts | the SDK's response messages |

Rules: wire names are `[A-Za-z0-9_-]{1,64}` (`catalogue.search` → `catalogue_search`; mapped back, also from near spellings); every input is still validated by Zod in `runTool` and a refused call is a tool result (EM-4501…EM-4506), never a failed run; at most 4 rounds per answer, then one call with tool choice `none` (extra calls get error results); the system prompt's tool block then only says when to use the tools and that tool syntax must never be written into the answer (`toolsPromptBlock(…, 'native')`). A model that refuses the `tools` parameter (HTTP 400 naming tools) is retried once without it and stays on the JSON-mode protocol for the session (`toolsRefused`).

JSON-mode fallback (models without a tools API): `{"tool","input"}` → `{"toolResult"}` as before. In both modes, tool calls a model writes as markup into its text (Claude imitated the JSON protocol in its own style: `<invoke><parameter name="input">…</parameter><parameter name="tool">catalogue.search</parameter></invoke>`; also `<function_calls>`, namespaced tags, `<tool_call>{json}</tool_call>`, `<function=name>{json}</function>`) are parsed as tool calls (`parseToolMarkup`) and run; markup is removed from everything the Creator sees (`stripToolMarkup`: the stored reply, the streamed text — a trailing partial tag is held back — and messages stored by older builds when they are shown or sent back to the model as history).

Progress (FR-214): the adapters report wire activity (`thinking`, `tool` name, `text`), which becomes `agent.run.progress` phases `thinking`, `tool` and `writing` besides `reading`, `planning`, `checking`, `correcting`, `waiting`.

### 8.2 Internet research (FR-216 … FR-218, ADR-033, QA 2026-10-28 #1)

Availability (`researchConfigFor`, Service): Private Mode → off ("private"); setting `webResearch` false → off ("setting"); custom / no provider → off ("provider"); an Anthropic account that refused the web tools this session → off ("org-disabled", EM-4403); Anthropic → `native`; OpenAI, Gemini, OpenRouter → `tools`. Every run's system prompt ends with the research block (SYSTEM_PROMPT P-8): "You CAN research the internet …" with the tool names, or "Internet research is NOT available … because <reason> … say exactly that reason and how to change it". Never "I cannot browse" when research is on.

| Provider | Search | Read a page | Results in the answer |
|---|---|---|---|
| Anthropic (`native`) | server tool `web_search_20260209` (`allowed_callers: ["direct"]`, `max_uses` 5 Diskusi / 3 Editor) for Claude 4.6+ and 5.x, `web_search_20250305` otherwise or when a model refuses the newer version | server tool `web_fetch_20260209` (citations on, `max_content_tokens` 20 000, `max_uses` 3 / 2) | `server_tool_use` + `web_search_tool_result` / `web_fetch_tool_result` blocks (replayed unchanged within the turn; `encrypted_content` kept), text blocks with `web_search_result_location` citations (streamed as `citations_delta`); `stop_reason: pause_turn` → the paused content is sent back as an assistant message, ≤ 4 times; a 400 / 403 naming the web tools → basic versions, then no web tools + EM-4403 / EM-4404 notice and a system note telling the model why |
| OpenAI (`tools`) | `web.search` → Chat Completions `gpt-5-search-api` with `web_search_options: {}` (the only Chat Completions search model) | `web.fetch` (egress) | `url_citation` annotations → `sources` |
| Gemini (`tools`) | `web.search` → `generateContent` with `tools: [{google_search: {}}]` on the assigned model | `web.fetch` | `groundingMetadata.groundingChunks[].web` |
| OpenRouter (`tools`) | `web.search` → chat completion with `plugins: [{id: "web", max_results: 5}]` on the assigned model | `web.fetch` | `url_citation` annotations |

The run collects sources (provider citations first, then search results / fetched pages; ≤ 12, deduplicated) into a `sources` block `{items: [{url, title?, citedText?, pageAge?, cited?}], queries?}` under the answer; picture candidates into an `image_candidates` block; why research did not run into a `notice` block. Progress: `agent.run.progress {phase: 'tool', tool: 'web.search' | 'web.fetch' | 'web.images', query? | url?}` for both the client tools and the Anthropic server tool (from the streamed `server_tool_use` input). The thread history gives later turns "(sources used: …)" so follow-up questions can cite them and web.fetch may read them.

## 9. Brainstorming → Editor hand-off

The Brainstorming Agent's output schema includes an optional `proposedIntents: ProposedIntent[]` (`{category, presetId?, params (default {}), target?, needsInterpretation, instruction?, source: 'brainstorm'}`, `packages/agents/src/schemas.ts`; FR-212: normalised before storing — `params` defaulted, plural / catalogue categories mapped, invalid preset ids and targets dropped, empty items dropped — and normalised again whenever a stored message is read). The Editor shows a handoff card; on "Apply to video" ("Kerjakan di video", since 2026-10-26; was "Send to Editor Agent") the intents enter the Intent Queue and the assistant chat switches to Edit mode. A Diskusi answer without proposals can be applied too: its text becomes the Editor Agent's request (FR-183). The Brainstorming Agent has no mutation tools and no `composition.validateOps`; its set is `composition.get` (summary), `assets.list`, `catalogue.search`, `hardware.profile`, `project.settings.get`, `render.estimate` (same list as §8 and AGENT_DESIGN.md §2.1).

## 10. Context management (brief §8.1)

- Each agent keeps a thread per project. The request to the provider contains: system prompt (versioned, cached where the provider supports prompt caching), a compact project state block (≤ 4k tokens), the last N messages such that total ≤ 60 % of the model's context length, older messages summarised by the deterministic summariser (no LLM: keeps decisions, rejects, intents) into a `threadSummary` block.
- Tool results older than two turns are replaced by one-line stubs.
- Attachments (images from the Creator, FR-213) are sent as image parts unless the Capability Table says the model has no image input (`imageInput: false`); then the message goes with the file name only and the chat says so; unknown capability is tried, and a provider that refuses the image part gets the request again with the name only (the cached row then learns `imageInput: false`). The thread history carries `(attached image "name", asset id …)` lines.
- The chat header shows `usedTokens / contextLength` of the current mode's last request (`agent.chat.usage`).

### 10.1 Shared context between the two chats (Operator decision 2026-10-26; two separate chats again since 2026-10-28, ADR-033)

ADR-033: Diskusi and Editor are two separate chats again (tabs, each with its own thread); the shared context below is unchanged. Hand-off: "Kirim ke Editor" (R-083b) sends the whole Diskusi draft (answer text + proposed changes as a numbered list, with "build it exactly, do not ask back unless something essential is missing") as the Editor's `creatorMessage`; the Editor envelope also carries `discussion` as before; the draft's `handoff` block follows the Editor run. "buatkan videonya" (MAKE_VIDEO_RE) after an answer with `suggestedNextStep: send-to-editor` starts the same hand-off automatically. An Editor question (needs-input plan) can be sent to Diskusi ("Editor butuh info ini untuk membuat video: …").


Until 2026-10-28 the Agent Panel showed ONE assistant chat with two modes: "Diskusi" (Brainstorming Agent) and "Edit" (Editor Agent). Storage stays per agent (one conversation each, R-080…R-085, permissions unchanged); the thread merges both in time order. So that both agents see the same conversation, the Local Service adds a compact, deterministic block from the other agent when it builds a request (`packages/agents/src/shared-context.ts` decides what fits; `apps/service/src/s3/shared-context.ts` only reads rows):

| Request | Block | Content | Budget |
|---|---|---|---|
| Editor Agent (Rewrite envelope §7, chat or queue-started) | `discussion` | the newest Brainstorming messages, newest first, `{from: creator \| brainstorm, text}`, each clipped to 900 characters, proposed changes as "(proposed N change(s); state)"; older messages counted and summarised in one line (`summary`, `omitted`) | 10 % of the Editor model's context (≈ 4 chars per token), 1 000 … 4 000 characters; at most 12 items; omitted when the Diskusi is empty |
| Brainstorming Agent (CONTEXT block, P-1) | `recentEdits` | the newest Edit Plans (not drafts), newest first, `{goal, status: applied \| undone \| cancelled \| failed \| proposed, by: picks \| editor, changes?}`; `undone` = executed but its version left the head's lineage (FR-167) | at most 8 items and 1 600 characters |

Rules: both blocks are data, never instructions (a constraint line in the envelope and the prompts say so; SYSTEM_PROMPT v1.3.0); they never add work — the Editor Agent plans only what the intents and the `creatorMessage` ask, and uses `discussion` to resolve "do what we discussed"; the Brainstorming Agent never claims a change is in the video unless `recentEdits` says `applied`. The existing limits stay: the envelope's composition summary ≤ ~4k tokens, the Brainstorming thread window ≤ 60 % of the context (the CONTEXT block is part of the system prompt, so it is counted in that window). Private Mode blocks both agents as before.

## 11. Usage and budget

- Every provider call records `inputTokens`, `outputTokens`, `costUsd` (OpenRouter `usage.cost`; otherwise computed from the Capability Table's price per million tokens if present, flagged `approximate: true`; otherwise `null` and shown as "n/a").
- Per-project and per-month budget limits per Provider Connection (Creator-set; FR-117, `project_connection_budgets` + `provider_connections.budget_month_usd`) stop new agent runs with `EM-4201` when exceeded; a warning at 80 %.
- No hidden calls: the Editor shows a spinner with "Asking <model>…" for every provider request.

## 12. Failure handling

| Failure | Behaviour |
|---|---|
| Provider timeout (120 s for a non-streamed answer; a streamed answer ≤ 360 s total and ≤ 90 s without a chunk, SEC-084) | retry once (not after streamed text); then `EM-4101` with "Try again / switch model" |
| Rate limit (429, e.g. a `:free` model "rate-limited upstream") | the adapter retries up to **2** times within **20 s** in total (`withRateLimitRetry`: `Retry-After` seconds / date or OpenRouter's `X-RateLimit-Reset`, else 3 s then 6 s; no wait when the hint is beyond the budget or the provider reason is a daily quota ("free-models-per-day" → `details.daily`, own chat copy); never after streamed text or a cancel); agent runs show `agent.run.progress {phase:'waiting', attempt, of}` ("Penyedia sibuk, mencoba lagi (1/2)…"); the provider test uses the same adapter. Then `EM-4102` with `details.retries` (the runner does not retry again); the chat card says "Model gratis sedang dibatasi penyedia…" for `:free` models and offers Try again / Switch model |
| Invalid JSON / schema | unambiguous slips repaired first (§7.1); otherwise re-prompt with the Zod error / validation lines naming step, op and its args signature (max 2); then `EM-4301` (details: last issue codes / paths) as an error bubble with "Ubah kalimat" / "Ganti model" — a run that produced no plan is never shown as a reply; with pointed targets a short question instead (§7.1) |
| Model lacks tool calling | JSON-mode prompting (tools described in the prompt, output is the EditPlan / BrainstormTurn JSON); providers with a tools API use native tool calling (§8.1); markup tool calls are read in both modes |
| Streamed answer (FR-210) | Anthropic / OpenAI / Gemini / OpenRouter stream every agent call: no 120 s cap, the SEC-084 stream bounds apply; mid-stream `error` events map to their code (overloaded → EM-4103, rate limit → EM-4102); a streamed output budget below the model's limit is retried once with the caller's budget |
| `touchesLockedKeys` non-empty | one re-prompt listing the keys; then drop those ops with notice: a `locked-key` info risk plus one `validation` entry per affected step `{ code: 'EM-2302', path: 'droppedSteps[<n>]', message: '<n>. <expectedDiff> (<locked keys>)' }`, which the Plan Card lists struck through (FR-081) |
| Execute fails mid-transaction | SQLite rollback; `ExecutionResult.rollback.performed = true`; version unchanged |
| Service restart during agent run | run marked `cancelled`; Plan Card shows "interrupted, re-run" |
| Private Mode on | agent composer disabled with inline notice (`EM-4401`); any egress attempt is refused by the single egress module (`EM-8202`); deterministic picks keep working |

## 13. Evaluation

Golden scenarios (GOLDEN_SCENARIOS.md) run against (a) the Compile path (pure unit tests), (b) a fake provider replaying recorded EditPlans, and (c) optionally live models on demand. Acceptance: ≥ 90 % valid plans on first attempt with a mid-tier model; 100 % of Locked Key violations caught; 0 unvalidated mutations.

## 14. Requirements list

| ID | Requirement | Verification |
|---|---|---|
| AI-001…007 | principles above | design review + tests |
| AI-010 | All UI picks produce `EditIntent` objects persisted before any processing | unit + DB inspection |
| AI-011 | Compile path covers every P0 preset without provider calls | unit tests per preset |
| AI-012 | Plans are Zod-validated and dry-run before Execute is enabled | integration test |
| AI-013 | Stale plans cannot execute | test: mutate head then Execute → 409 |
| AI-014 | Locked Keys are never modified by agent ops | golden scenarios GS-09, GS-11 |
| AI-015 | Each agent has an independent Model Assignment and usage display | UI test |
| AI-016 | Budget limits enforced | unit |
| AI-017 | Private Mode blocks provider calls at the egress module | network test |
| AI-018 | Superseded intents are visible and restorable | UI test |
| AI-019 | Hand-off from Brainstorming Agent is explicit (card) | UI test |
| AI-020 | No tool can execute shell, filesystem or network actions from model input | code review + registry test |
| AI-022 | Lenient reading of model plans (§7.1): only unambiguous repairs; the runtime owns `baseVersion`; correction messages name step, op and args signature; `capabilities.opArgs` lists every op's args | unit (packages/agents leniency.test.ts) |
| AI-023 | Videos without media (ADR-030): `op:scene.add` / `op:scene.setBackground`, generator plan steps `tts.generate` / `captions.generate` with model-missing handling; no "insert an asset first" gate for the Editor Agent | GS-23 (packages/agents golden/faceless.test.ts, packages/engine faceless.test.tsx, apps/service s3/faceless-pointing.test.ts, render smoke) |
| AI-028 | Footage + automatic motion (ADR-038): footage scenes play source trims in story order with designed scenes intercut and a transition on every cut; overlays on full-frame footage only in the top / bottom third, ≤ 6 s each, never over the centre band; lower-thirds anchored to speech; footage sound ducked under a voice-over; kinetic captions from the footage audio; a ducked CC0 music bed; the envelope carries footage transcripts | golden (packages/agents auto-motion-footage.test.ts, 9:16 + 16:9) + service footage-music-voices.test.ts + stills (process.md Entry 34) |
| AI-026 | Scene composer (ADR-034): a `scene.compose` VideoSpec becomes ops deterministically — no overlap within a scene, inside the safe area, an entrance on every element, a transition on every cut, scene length = voice clips + gaps (or the ~150 wpm narration estimate), explicit values win, figures only from the spec | unit + golden (packages/agents auto-motion.test.ts: "Peluang Bisnis Data Center di Indonesia" in 9:16 / 16:9 / 1:1 / 4:5, the "Ekspor Nikel" explicit spec) + stills (process.md Entry 31) |
| AI-027 | Quality gate (ADR-034): `qualityCheck` (overlap, outside safe area / frame, text overflow, contrast < 4.5:1 (3:1 large), no entrance, hard cuts, dead air > 2.5 s, missing font) after the composer and after every validated plan; `autoFixOps` repairs the unambiguous findings (re-flow, move inside, contrast colour, theme font) by rewriting the plan's own add ops or one extra step; the rest becomes `quality` risks (checklist in the plan preview) | unit (auto-motion.test.ts) |
| AI-024 | Pointed targets (FR-189) resolve with facts in the envelope / CONTEXT; a vague pointed request asks one question | unit + service test |
| AI-025 | One diagnostic log line per agent run and `agent.run.progress` phases (FR-190); never prompt text, Creator text or keys | service test |
| AI-021 | Shared chat context (§10.1): the Editor envelope carries `discussion`, the Brainstorming CONTEXT carries `recentEdits`, both within their budgets and as data only | unit (packages/agents shared-context.test.ts) + integration (apps/service s3/shared-context.test.ts) |
