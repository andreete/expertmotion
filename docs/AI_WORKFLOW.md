# AI Workflow: edit-intent pipeline, schemas, operations, agents and tools

| Field | Value |
|---|---|
| Status | baseline |
| Owner | AI agent architect |
| Last updated | 2026-10-24 |
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
  status: z.enum(['queued','superseded','compiled','planned','executed','rejected','removed','restored']), // removed = Creator removed it from the queue
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
    tool: z.string(),                   // "composition.applyOps" | "captions.generate" | ...
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
| layout (ratio, resolution) | — | **project** Output Profile | — |
| output (profile) | — | project | — |
| asset (insert, trim) | the Asset/Clip given explicitly | reject | explicit list |
| generate (voice, music, thumbnail, captions, hashtags) | — | project; result inserted at playhead or as new layer | — |

The resolved target is written to `resolvedTargets` and displayed on the Intent Queue item ("Transition · Fade → all 3 cuts").

## 5. Operation vocabulary (closed; adding an op requires an ADR note and a catalogue/test update)

| op | target | args (Zod summary) | Property class | Notes |
|---|---|---|---|---|
| `op:clip.insert` | sequence | `{assetId, atIndex?, trimBeforeMs?, durationMs?}` | list | from Insert; durationMs defaults to asset duration |
| `op:clip.remove` | clip | `{}` | — | destructive → confirmation |
| `op:clip.move` | clip | `{toIndex}` | — | P1 reordering |
| `op:clip.setTrim` | clip | `{trimBeforeMs, durationMs}` | scalar | validator: within asset duration |
| `op:clip.setPlaybackRate` | clip | `{rate: 0.25..4}` | scalar | no reverse |
| `op:clip.setVolume` | clip | `{volume: 0..1, fadeInMs?, fadeOutMs?}` | scalar | |
| `op:clip.setFit` | clip | `{objectFit: 'cover'|'contain', crop?}` | scalar | |
| `op:transition.set` | cut | `{presetId, durationMs, timing: 'linear'|'spring', params?}` | exclusive-group | validator recomputes total duration |
| `op:transition.clear` | cut | `{}` | — | |
| `op:text.add` | playhead/absolute | `{text, variant, atMs, durationMs, position, styleOverrides?}` | list | uses Theme defaults |
| `op:text.setContent` | text | `{text}` | scalar | |
| `op:text.setStyle` | text | `{fontFamily?, fontSize?, weight?, colour?, align?, opacity?}` | scalar per field | each field its own Locked Key |
| `op:text.setEffect` | text | `{presetId, params?}` | exclusive-group | text effects |
| `op:text.setTiming` | text | `{atMs, durationMs}` | scalar | |
| `op:text.remove` | text | `{}` | — | |
| `op:caption.importSrt` | project | `{assetId}` | — | P0 caption display path |
| `op:caption.setStyle` | project | `{presetId, params?}` | exclusive-group | |
| `op:caption.setPages` | project | `{pages: Caption pages}` | scalar | produced by Caption sub-agent (P1) |
| `op:caption.clear` | project | `{}` | — | |
| `op:background.set` | project | `{presetId, params?}` | exclusive-group | |
| `op:background.clear` | project | `{}` | — | |
| `op:motion.set` | clip/text | `{presetId, params?: {durationMs?, delayMs?, easingId?}}` | exclusive-group per element | enter/exit motion |
| `op:motion.clear` | clip/text | `{}` | — | |
| `op:easing.setDefault` | project | `{easingId}` | scalar | Theme |
| `op:effect.add` | clip/text/background | `{presetId, params?}` | list (dedupe by presetId) | max 3 per element (T0: 2) |
| `op:effect.remove` | clip/text/background | `{presetId}` | — | |
| `op:effect.setParams` | element+preset | `{params}` | scalar | |
| `op:shape.add` | absolute | `{presetId, atMs, durationMs, position, size, fill, stroke?}` | list | |
| `op:shape.remove` | shape | `{}` | — | |
| `op:audio.addBed` | project | `{assetId, volume, loop, duckingPresetId?}` | list | background music |
| `op:audio.addLayer` | absolute | `{assetId, atMs, volume, fadeInMs?, fadeOutMs?}` | list | voice, sfx |
| `op:audio.setDucking` | audio | `{presetId, params?}` | exclusive-group | |
| `op:audio.remove` | audio | `{}` | — | |
| `op:theme.set` | project | `{paletteId?, fontPairId?, defaultEasingId?}` | scalar per field | |
| `op:theme.setTextDefaults` | project | `{fontFamily?, fontSize?, weight?, colour?, align?, opacity?}` | scalar per field | Theme defaults for new Text Layers; propertyKey `theme.textDefaults.<field>` |
| `op:output.setRatio` | project | `{ratio}` | scalar | 16:9 … custom |
| `op:output.setResolution` | project | `{preset}` | scalar | gated by tier |
| `op:project.setFps` | project | `{fps}` | scalar | re-derives frames |
| `op:project.setDurationPolicy` | project | `{policy: 'fit-content'|'fixed', fixedMs?}` | scalar | |
| `op:generated.insert` | project | `{kind: 'voice'|'music'|'thumbnail'|'captions', jobId}` | list | result of a generator job |

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
  "capabilities": { "ops": [...names...], "presets": {...ids by category, with hardware flags...}, "maxOpsPerPlan": 200 },
  "constraints": ["never touch lockedKeys", "times in ms", "respond with EditPlan JSON only"]
}
```

## 8. Tools (registry; permissions in AGENT_DESIGN.md)

| Tool | Input | Output | Side effects | Who may call |
|---|---|---|---|---|
| `composition.get` | `{projectId, version?}` | Composition Model summary or full | none | both agents |
| `composition.validateOps` | `{baseVersion, ops}` | `{ok, issues, predictedDiff, predictedDurationMs}` | none (dry run) | Editor Agent |
| `composition.applyOps` | `{planId}` | `ExecutionResult` | mutates (only during Execute) | runtime only (not callable by the model directly) |
| `catalogue.search` | `{query, category?}` | presets with params schema | none | both |
| `assets.list` | `{projectId}` | asset metadata | none | both |
| `assets.probe` | `{assetId}` | detailed probe | none | Editor Agent |
| `captions.generate` | `{assetId, language}` | `{jobId}` → pages | spawns whisper (P1) | Editor Agent via plan step |
| `tts.generate` | `{text, voiceId, language}` | `{jobId}` → asset | spawns sherpa-onnx (P1) | plan step |
| `music.generate` | `{prompt, durationMs, style}` | `{jobId}` → asset | spawns ACE-Step (P2) | plan step |
| `thumbnail.generate` | `{prompt?, frameMs?, titleText?}` | `{jobId}` → image | spawns sd.cpp / renderStill (P2) | plan step |
| `render.estimate` | `{versionId, outputProfile, performanceProfile}` | `{seconds, bytes, warnings}` | none | both |
| `render.start` | `{versionId, ...}` | `{jobId}` | enqueues | **Creator only** (Export dialog); agents may only suggest |
| `hardware.profile` | `{}` | tier, RAM, GPU | none | both |
| `project.settings.get` | `{projectId}` | settings | none | both |

Tools called by the model are read-only or produce proposals; all mutations happen through Execute. Tool inputs are Zod-validated; failures return `{error: {code, message}}` so the model can correct itself (max 2 corrections).

## 9. Brainstorming → Editor hand-off

The Brainstorming Agent's output schema includes an optional `proposedIntents: EditIntent[]` (source `brainstorm`, `needsInterpretation` true or false). The Editor shows a handoff card; on "Send to Editor Agent" the intents enter the Intent Queue. The Brainstorming Agent has no mutation tools and no `composition.validateOps`; its set is `composition.get` (summary), `assets.list`, `catalogue.search`, `hardware.profile`, `project.settings.get`, `render.estimate` (same list as §8 and AGENT_DESIGN.md §2.1).

## 10. Context management (brief §8.1)

- Each agent keeps a thread per project. The request to the provider contains: system prompt (versioned, cached where the provider supports prompt caching), a compact project state block (≤ 4k tokens), the last N messages such that total ≤ 60 % of the model's context length, older messages summarised by the deterministic summariser (no LLM: keeps decisions, rejects, intents) into a `threadSummary` block.
- Tool results older than two turns are replaced by one-line stubs.
- Attachments (images from the Creator) are sent only to models with image input capability; otherwise a text description is requested from the Creator.
- The chat footer shows `usedTokens / contextLength` from the last request's usage.

## 11. Usage and budget

- Every provider call records `inputTokens`, `outputTokens`, `costUsd` (OpenRouter `usage.cost`; otherwise computed from the Capability Table's price per million tokens if present, flagged `approximate: true`; otherwise `null` and shown as "n/a").
- Per-project and per-month budget limits (Creator-set) stop new agent runs with `EM-4201` when exceeded; a warning at 80 %.
- No hidden calls: the Editor shows a spinner with "Asking <model>…" for every provider request.

## 12. Failure handling

| Failure | Behaviour |
|---|---|
| Provider timeout (30 s first token, 120 s total) | retry once with backoff; then `EM-4101` with "Try again / switch model" |
| Rate limit (429) | wait per `Retry-After` up to 20 s, once; then `EM-4102` |
| Invalid JSON / schema | re-prompt with the Zod error (max 2); then `EM-4301` and the raw text is shown collapsed for transparency |
| Model lacks tool calling | Capability Table routes to JSON-mode prompting (tools described in prompt, output is the EditPlan JSON) |
| `touchesLockedKeys` non-empty | one re-prompt listing the keys; then drop those ops with notice |
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
