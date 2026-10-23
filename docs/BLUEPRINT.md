# Blueprint: end-to-end product blueprint, monorepo, port list, contracts, P0 slice

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Principal architect |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-001, 002, 004, 005, 011, 013, 015), ARCHITECTURE.md, DATABASE_SCHEMA.md, AI_WORKFLOW.md, AGENT_DESIGN.md, DESIGN_CATALOGUE.md, PERFORMANCE.md, ASSESSMENT.md §1, PRD.md, MASTER_PROJECT_PROMPT.md §5, §10, §12 |
| Used by | TRD.md, API_SPECIFICATION.md, DEPLOYMENT_AND_PACKAGING.md, ROADMAP.md, POC_PLAN.md, DEVELOPMENT_WORKFLOW.md, TEST_PLAN.md, AGENT_DESIGN.md §6 (subagent scopes) |
| Owner of | monorepo layout, package purposes and public API surfaces, dependency rules, the file-by-file port list from `/home/andre/experthinker-studio`, module data contracts (as names; schemas stay with their owners), build and release artefact list, the P0 vertical slice, PRD → package traceability |

This document says **where code lives and what each part exposes**. It never redefines a schema: the Composition Model belongs to DATABASE_SCHEMA.md §4, Edit Intent / Edit Plan / Operation to AI_WORKFLOW.md §3 and §5, presets to DESIGN_CATALOGUE.md, pixel dimensions and Performance Profiles to PERFORMANCE.md, routes and SSE events to API_SPECIFICATION.md, `EM-` codes to ERROR_CATALOGUE.md.

## 1. System summary (one page)

Expertmotion is one installed Windows application (`Expertmotion.exe`) made of three processes and one engine (ARCHITECTURE.md §3):

| Part | Process | Code | Talks to |
|---|---|---|---|
| Desktop Shell | Electron main | `apps/desktop` | spawns the Local Service; hosts the Editor in a `BrowserWindow`; native dialogs, `safeStorage`, updater, tray |
| Local Service | Node.js child process (Electron's embedded Node, `ELECTRON_RUN_AS_NODE=1`) | `apps/service` + `packages/*` | encrypted SQLite, filesystem, Engine, LLM providers (only when configured, never in Private Mode) |
| Editor | React in the Electron renderer (or a browser in development) | `apps/ui` | Local Service only, over `http://127.0.0.1:<port>/api/v1` with the Service Token |
| Engine | prebuilt Remotion bundle + Chrome Headless Shell + FFmpeg | `packages/engine` (bundle) + `resources/engine/` | driven by `@remotion/renderer` from the Local Service; the same `ExpertmotionTimeline` component is imported by the Editor's Player |

### 1.1 The pipeline (brief §10)

```
UI pick / chat message
   │  Design Pick, Sequence Badge, Insert, Output Settings, Text Panel
   ▼
Edit Intent ─────── packages/agents/intents: EditIntent (Zod), catalogue check, Target Resolution, Property Class, Locked Keys
   │
   ├─ fully specified ──► Compile ──────────────────────────────┐
   │                                                            ▼
   └─ needs interpretation ──► Rewrite envelope ──► Editor Agent ──► Edit Plan (Zod) ──► validate + dry-run applyOps
                                                                                               │
                                                                        Creator presses Execute│
                                                                                               ▼
Composition Model ── packages/composition-model: applyOps in one SQLite transaction, validate, new Composition Version, checkpoint
   │
   ▼
Remotion Adapter ── packages/engine: ExpertmotionTimeline, calculateMetadata (ms → frames, ratio × resolution → px), presets
   │
   ├─ Preview: @remotion/player in apps/ui (Draft = proxy URLs, scale 0.5)
   └─ Render:  apps/service/render: RenderQueue → selectComposition → renderMedia (Chrome Headless Shell + FFmpeg)
                 │
                 ▼
Output validation ── ffprobe: duration, dimensions, fps, audio present → outputs row, thumbnail, render.done
```

Every arrow is a typed contract (§4). The LLM appears exactly once (Editor Agent) and twice if the Brainstorming Agent is counted; both only *propose* (ADR-002, AI-001). The Creator never sees the words Remotion, React, Node, Chrome or FFmpeg (GLOSSARY "Engine", UX-040).

### 1.2 What a Creator does, and which package answers

| Step (PRD.md §3) | Package(s) |
|---|---|
| Launch, onboarding, licence | `apps/desktop`, `apps/service/license`, `apps/ui/screens/onboarding` |
| Import, probe, proxy, thumbnails | `apps/service/ingest`, `packages/shared` (ids, hashing) |
| Sequence Badges, Insert | `apps/ui/library/assets`, `apps/service/http/assets`, `packages/composition-model` (`op:clip.insert`) |
| Design Picks, Intent Queue | `apps/ui/library/catalogue`, `packages/agents/intents`, `packages/engine/catalogue` |
| Brainstorming, Edit Plan, Execute | `packages/agents`, `apps/service/agents`, `packages/composition-model` |
| Player, Timeline View | `apps/ui/stage`, `packages/engine` (component), `packages/composition-model` (timing) |
| Output Settings, Export | `apps/ui/agent-panel/output`, `apps/service/render`, `packages/engine/formats` |

## 2. Monorepo layout

npm workspaces, Node 22.x LTS for tooling and development (TRD.md §1), TypeScript project references, one root lockfile.

```
expertmotion/
  package.json                 workspaces: apps/*, packages/*, tools/*
  tsconfig.base.json           strict, ES2022, moduleResolution bundler
  .npmrc                       save-exact=true, engine-strict=true
  apps/
    desktop/                   Electron main + preload (Desktop Shell)
    service/                   Local Service (Express + SSE, SQLite, render queue, ingest, agents runtime host)
    ui/                        Editor (React 19 + Vite 6 + Tailwind v4 + @remotion/player)
  packages/
    composition-model/         Zod schema, applyOps, validate, deriveTiming, diff, hashing, migrations   (React-free)
    engine/                    Remotion compositions, presets, catalogue registry, Root.tsx, formats, build script
    agents/                    schemas, intents compiler, rewrite, provider adapters, tool registry, prompts loader (React-free)
    models/                    Model Manager core + engine adapters (whisper.cpp, sherpa-onnx, sd.cpp)         (React-free)
    shared/                    ids, EmError + EM- code table type, i18n keys, DTO types, logger interface       (React-free)
  tools/
    license-cli/               Operator CLI: issue / revoke / inspect Licence Keys (Ed25519)
    release/                   scripts: build engine bundle + catalogue loops, SBOM, notices, electron-builder, sign
  test/
    fixtures/                  sample media (short, CC0), Composition Model fixtures, recorded provider replies
    golden/                    golden frames per preset × 7 ratios, Golden Scenario expectations
    e2e/                       Playwright specs (Editor against a dev Local Service)
  resources/                   build-time outputs copied into the installer (git-ignored): engine/bundle, engine/chrome, engine/ffmpeg, catalogue/loops
  docs/                        this documentation
```

Package names are scoped `@expertmotion/<name>`; apps are `@expertmotion/desktop`, `@expertmotion/service`, `@expertmotion/ui`.

### 2.1 Dependency rules (who may import whom)

| Package | May import | Must not import | React? |
|---|---|---|---|
| `packages/shared` | nothing internal | anything | no |
| `packages/composition-model` | `shared`, `engine/catalogue` (React-free subpath) | `engine` root, `agents`, apps | no |
| `packages/engine` | `shared`, `composition-model`, `remotion`, `@remotion/*` | `agents`, `models`, apps, `express`, `better-sqlite3` | yes (root); **no** under `src/catalogue/`, `src/formats.ts`, `src/metadata.ts`, `src/text/fit.ts`, `src/text/format-number.ts` |
| `packages/agents` | `shared`, `composition-model`, `engine/catalogue`, `ai`, provider SDKs | `engine` root, apps, `@remotion/renderer` | no |
| `packages/models` | `shared` | everything else internal | no |
| `apps/service` | all packages; `engine` root only inside `render/` (for `@remotion/renderer` types) | `apps/ui`, `apps/desktop`, `electron` | no |
| `apps/ui` | `shared`, `composition-model`, `engine` (component + catalogue), `@remotion/player` | `agents` (except types), `models`, `apps/service`, `express`, `node:*` | yes |
| `apps/desktop` | `shared` (types), `electron` | `apps/service` code (it spawns it), `apps/ui` code (it loads the built bundle), `packages/engine` | no |

Enforced by `eslint-plugin-import` `no-restricted-paths` plus a `tools/release/check-react-free.mjs` script that fails the build if `react` appears in the dependency graph of any React-free entry point (the predecessor convention "keep `schemas.ts` React-free: the server and MCP import it" generalised). `apps/service` never imports `react`; it imports `packages/engine/catalogue` and `packages/engine/metadata` only.

### 2.2 Build outputs

| Package | Build tool | Output | Consumed by |
|---|---|---|---|
| `packages/shared`, `composition-model`, `agents`, `models` | `tsc -b` (ESM, d.ts) | `dist/` | service, ui (type-only or ESM) |
| `packages/engine` | `tsc -b` for the library; `remotion bundle` (`@remotion/bundler` `bundle()`) for the Engine bundle; `renderMedia` loop for catalogue loops | `dist/` (library); `resources/engine/bundle/` (serveUrl folder); `resources/catalogue/loops/<category>/<name>.webm` | service (`serveUrl`), ui (component via `dist/`), ui (loops as static files) |
| `apps/ui` | Vite 6 | `apps/ui/dist/` | desktop (served over the `app://` scheme), dev browser via Vite dev server |
| `apps/service` | esbuild (single ESM file + externals for native modules) | `apps/service/dist/service.mjs` | desktop (spawned as child) |
| `apps/desktop` | electron-vite (main, preload); V8 bytecode only for `license/` and `prompts/` modules (ADR-007) | `apps/desktop/out/` | electron-builder |
| installer | electron-builder (NSIS x64) | `release/Expertmotion-<version>-x64.exe` + `latest.yml` | Creator download, updater |

## 3. Packages: purpose and public API surface

Signatures below are the committed shapes; parameter and result types are defined by their owning document (Zod names in DATABASE_SCHEMA.md §4 and AI_WORKFLOW.md §3). `Result<T>` and `Issue` come from `packages/shared`.

### 3.1 `packages/shared`

Purpose: the small set of types and helpers every other package needs, with zero runtime dependencies beyond Node built-ins.

```ts
// ids.ts  (port of util.ts newId → ULID)
export function newId(): string;                               // ULID, 26 chars
export function shortId(prefix: 'prj'|'ast'|'ver'|'int'|'pln'|'run'|'job'|'out'|'ckp', id: string): string; // log display only, never stored
export function sha256Canonical(value: unknown): string;       // sorted keys, no whitespace → hex (DATABASE_SCHEMA §4.5)
export function sanitizeFilename(input: string, fallback?: string): string;   // ported unchanged (util.ts)
export function timestamp(d?: Date): string;                   // ported (util.ts) YYYYMMDD-HHmmss

// errors.ts  (port of util.ts HttpError, renamed and widened)
export type EmCode = `EM-${number}`;                           // validated against ERROR_CATALOGUE at build (tools/release/check-em-codes.mjs)
export class EmError extends Error {
  constructor(code: EmCode, message: string, opts?: { status?: number; details?: unknown; path?: string; cause?: unknown });
  readonly code: EmCode; readonly status: number; readonly details?: unknown; readonly path?: string;
}
export function errorMessage(err: unknown): string;            // ported (util.ts)
export function truncate(s: string, max?: number): string;     // ported (util.ts)
export const HTTP_STATUS_BY_RANGE: Record<'EM-1'|'EM-2'|…, number>; // default mapping, overridable per code (API_SPECIFICATION §2.5)

// result.ts
export type Issue = { code: string; path: string; message: string; severity: 'info'|'warn'|'block' };   // CM-xxx, AI validation, preset params
export type Result<T> = { ok: true; value: T; warnings: Issue[] } | { ok: false; issues: Issue[] };

// i18n.ts
export type I18nKey = string;                                   // scheme in ACCESSIBILITY_AND_I18N.md
export function emKey(code: EmCode, part: 'title'|'body'|'action'): I18nKey;   // `em.<code>.<part>`

// dto.ts   re-exports the API DTO types generated from the service Zod schemas (API_SPECIFICATION.md); used by apps/ui
// logger.ts
export interface Logger { debug(o: object, msg?: string): void; info(...): void; warn(...): void; error(...): void; child(bindings: object): Logger; }
```

### 3.2 `packages/composition-model`

Purpose: the Composition Model as pure functions. No I/O, no React, no Remotion imports (types only). ≥ 90 % line coverage (TRD.md TR-090).

```ts
export { CompositionModel, ProjectSettings, Theme, Clip, Transition, Motion, EffectInstance, TextLayer, OverlayElement,
         CaptionPage, CaptionTrack, AudioLayer, Background } from './schema';          // Zod, DATABASE_SCHEMA.md §4 verbatim
export type CompositionModelT = z.infer<typeof CompositionModel>;

export function createEmptyModel(projectId: string, settings: ProjectSettingsT, theme?: ThemeT): CompositionModelT;
export function applyOps(model: CompositionModelT, ops: Operation[], ctx: ApplyContext): Result<{ model: CompositionModelT; diff: ElementDiff[] }>;
   // ApplyContext = { assets: AssetFacts[]; tier: 'T0'|'T1'|'T2'; catalogue: CatalogueRegistry; newId: () => string }
   // pure: never mutates `model`; stops at the first blocking Issue (step index in Issue.path = "steps[n].ops[m]")
export function validate(model: CompositionModelT, ctx: ValidateContext): Issue[];   // CM-001 … CM-011 (DATABASE_SCHEMA §4.4)
export function deriveTiming(model: CompositionModelT): Timing;
   // { durationMs, cutStartMs[], elementWindows: Record<id,{fromMs,toMs}>, warnings: Issue[] }   (DATABASE_SCHEMA §4.3)
export function framesOf(ms: number, fps: number): number;      // Math.round(ms / 1000 * fps)
export function hashModel(model: CompositionModelT): string;   // sha256Canonical → composition_versions.hash
export function diffModels(a: CompositionModelT, b: CompositionModelT): ElementDiff[];   // ExecutionResult.diff rows
export function lockedKeysOf(ops: Operation[]): string[];       // propertyKey derivation for Locked Keys (AI_WORKFLOW §6)
export function migrateModel(json: unknown): Result<CompositionModelT>;   // schemaVersion 1 → current, lazy (DATABASE_SCHEMA §5)
export function summarizeForAgent(model: CompositionModelT, assets: AssetFacts[], maxTokens: number): CompactComposition;  // Rewrite envelope block
export const OPERATIONS: Record<OpName, { argsSchema: z.ZodTypeAny; target: TargetKind[]; propertyClass: PropertyClass | null; destructive: boolean }>;  // AI_WORKFLOW §5 table in code
```

`applyOps` is the only function that changes a model; `apps/service` wraps it in a SQLite transaction (DATABASE_SCHEMA.md §2) and never edits `model_json` by hand.

### 3.3 `packages/engine`

Purpose: everything Remotion. One composition, the Design Preset implementations, the catalogue registry (React-free subpath), formats and `calculateMetadata`, fonts, and the build script that produces the Engine bundle and the catalogue loops (ADR-001, ADR-011).

```
packages/engine/
  src/
    Root.tsx                 <Composition id="ExpertmotionTimeline" component={ExpertmotionTimeline} calculateMetadata={calculateMetadata} defaultProps={EMPTY_INPUT}/>
    entry.ts                 registerRoot(RemotionRoot)           (ported pattern)
    index.ts                 React exports: ExpertmotionTimeline, ThemeProvider, useLayout, components
    catalogue/               React-free: index.ts (registry), transition.ts, caption.ts, background.ts, motion.ts, shape.ts, easing.ts, effect.ts, audio.ts, text.ts, theme.ts
    formats.ts               React-free: ratios, resolveDimensions, safe areas, detectRatio          (ported formats.ts, extended)
    metadata.ts              React-free: calculateMetadata(inputProps) → {width,height,fps,durationInFrames,props}
    layout.tsx               useLayout(), useElementDuration()                                       (ported layout.tsx)
    theme.tsx                ThemeProvider/useTheme: palette + font pair tokens from Theme (replaces brand.ts)
    fonts.ts                 loadFonts(fontPairId) via @remotion/fonts + staticFile                   (ported fonts.ts)
    text/fit.ts              fitText estimator + fitTextSafe wrapper                                 (ported fit.ts)
    text/format-number.ts    formatNumber(value, locale, opts)                                        (ported format-number.ts)
    timeline/                ExpertmotionTimeline.tsx, VideoTrack.tsx (TransitionSeries), OverlayTrack.tsx, TextTrack.tsx, CaptionTrack.tsx, AudioTrack.tsx, BackgroundLayer.tsx
    presets/<category>/<name>.tsx   one React component per preset id, props = Zod params
    components/              KineticText.tsx, AnimatedNumber.tsx, charts/ (ported), CaptionPage.tsx, SafeArea.tsx, Watermark.tsx
  public/fonts/*.woff2       Inter, Plus Jakarta Sans, Archivo, JetBrains Mono (OFL)
  public/sfx/*.wav           CC0 pack (P1)
  scripts/build-bundle.ts    bundle({entryPoint: src/entry.ts, publicDir, outDir: resources/engine/bundle})
  scripts/build-loops.ts     for each preset: renderMedia 2 s webm 480 px → resources/catalogue/loops/<category>/<name>.webm (ADR-011)
  scripts/golden-frames.ts   renderStill per preset × 7 ratios → test/golden/
```

Public API (root, React):

```ts
export const ExpertmotionTimeline: React.FC<EngineInputProps>;
export type EngineInputProps = { model: CompositionModelT; assets: Record<string, AssetUrls>; quality: 'draft'|'full'; watermark: boolean };
   // AssetUrls = { playable: string; proxy?: string; durationMs: number; width?: number; height?: number; hasAudio: boolean }
export function useLayout(): Layout;                      // { width, height, ratio, u, safe, contentW, contentH, isLandscape }
export function useElementDuration(): number;             // frames of the enclosing <Sequence>
export const ThemeProvider: React.FC<{ theme: ThemeT; children }>; export function useTheme(): ThemeTokens;
export { KineticText, AnimatedNumber, BarChart, LineChart, CaptionPage, Watermark } from './components';
```

Public API (`@expertmotion/engine/catalogue`, `/formats`, `/metadata`, `/text`; React-free, imported by service and agents):

```ts
// catalogue
export interface PresetDef<P = unknown> { id: PresetId; category: Category; label: { en: string; id: string }; tags: string[]; params: z.ZodType<P>; defaults: P;
  propertyClass: 'scalar'|'list'|'exclusive-group'; priority: 'p0'|'p1'|'p2'; flags: Array<'gpu'|'webgpu'|`model:${string}`|'licence:paid'>; preview: string /* catalogue/<cat>/<name>.webm */; }
export const catalogue: CatalogueRegistry;                 // Map<PresetId, PresetDef>, frozen at module load
export function getPreset(id: string): PresetDef | undefined;
export function listPresets(filter?: { category?: Category; priority?: ('p0'|'p1'|'p2')[]; tier?: 'T0'|'T1'|'T2' }): PresetDef[];
export function searchPresets(query: string, lang: 'en'|'id', category?: Category): PresetDef[];   // labels + tags (DESIGN_CATALOGUE §13)
export function presetParamsJsonSchema(id: PresetId): JsonSchema;   // z.toJSONSchema, for the inspector fallback form
export function compileDefaults(category: Category, presetId: PresetId): Record<string, unknown>;  // Compile table input (AI_WORKFLOW §7)

// formats  (ported formats.ts, extended to 7 ratios + custom)
export type Ratio = '16:9'|'9:16'|'1:1'|'4:5'|'5:4'|'4:3'|'3:4'|'custom';  export type Resolution = '720p'|'1080p'|'2k'|'2160p';
export function resolveDimensions(ratio: Ratio, resolution: Resolution, custom?: { w: number; h: number }): { width: number; height: number };  // PERFORMANCE.md §3 table, even px, clamps
export function safeAreaFor(ratio: Ratio, width: number, height: number): SafeArea;
export function detectRatio(width: number, height: number): Ratio;      // nearest by aspect difference (ported detectFormat); used by Auto ratio
export function isRatio(v: unknown): v is Ratio;

// metadata
export function calculateMetadata(input: { props: EngineInputProps }): { width: number; height: number; fps: number; durationInFrames: number; props: EngineInputProps };
   // uses resolveDimensions + deriveTiming; identical in Player and renderer (ADR-001 "one code path")

// text
export function fitText(text: string, o: FitOptions): FitResult;            // ported unchanged
export function fitTextSafe(text: string, o: FitOptions & { fontFamily: string; weight: number }): FitResult;  // @remotion/layout-utils when `document` exists, estimator otherwise
export function formatNumber(value: number, locale: 'id'|'en', opts?: NumberFormatOptions): string;
```

### 3.4 `packages/agents`

Purpose: the deterministic intent pipeline (steps 2–8 of AI_WORKFLOW.md §2), the provider adapters, the tool registry with permissions, and the prompt loader. No Express, no SQLite; the service injects repositories through `ctx`.

```ts
// schemas.ts  (AI_WORKFLOW.md §3 verbatim)
export { EditIntent, Operation, EditPlan, ExecutionResult, ElementRef, PresetId, OpName } ; export { BrainstormTurn } ; // AGENT_DESIGN §2.1

// intents/
export function captureIntent(input: DesignPickInput | ChatIntentInput, ctx: IntentContext): EditIntent;          // steps 2–3
export function validateIntent(intent: EditIntent, ctx: IntentContext): Result<EditIntent>;                        // step 4 (catalogue, params, flags)
export function resolveTargets(intent: EditIntent, model: CompositionModelT, selection: ElementRef[], playheadMs: number): Result<ElementRef[]>;  // AI_WORKFLOW §4 table; EM-2201 when rejecting
export function reduceQueue(queue: EditIntent[], incoming: EditIntent): { queue: EditIntent[]; superseded: string[]; rejected: string[] };     // Property Class rules (§6)
export function needsInterpretation(intent: EditIntent): boolean;                                                  // §7 decision
export function compileIntent(intent: EditIntent, ctx: CompileContext): Operation[];                               // Compile (no LLM), one table per category
export function compilePlan(intents: EditIntent[], baseVersion: string, ctx: CompileContext): EditPlan;            // origin 'compile'
export function lockedKeys(queue: EditIntent[]): string[];                                                         // compiled/executed propertyKeys
export function buildRewriteEnvelope(args: { project: ProjectFacts; model: CompositionModelT; assets: AssetFacts[]; intents: EditIntent[]; lockedKeys: string[];
    creatorMessage?: string; creatorNotes?: string; tier: HardwareTier; capabilities: Capabilities }): RewriteEnvelope;  // AI_WORKFLOW §7 JSON
export function validatePlan(plan: unknown, ctx: PlanContext): Result<EditPlan>;   // Zod, op vocabulary, Locked Keys, baseVersion, dry-run applyOps on a copy (step 8)
export function summarizeThread(messages: Message[]): ThreadSummary;              // deterministic (AI_WORKFLOW §10)

// providers/
export interface ProviderAdapter { id: ProviderKind; listModels(conn: ConnectionSecret): Promise<CapabilityRow[]>; validate(conn): Promise<Result<void>>;
   generateStructured<T>(req: StructuredRequest<T>, signal: AbortSignal): AsyncIterable<StructuredEvent<T>>; }   // Vercel AI SDK v6 underneath
export function createProvider(kind: ProviderKind, egress: Egress): ProviderAdapter;   // openrouter | openai | anthropic | google | custom
export interface Egress { fetch: typeof fetch; assertAllowed(url: URL): void; }        // the single egress module; Private Mode throws EM-8202 here (AI-017)

// runtime/
export function runEditorAgent(envelope: RewriteEnvelope, provider: ProviderAdapter, tools: ToolRegistry, opts: RunOptions): Promise<RunResult<EditPlan>>;
export function runBrainstormAgent(thread: ThreadInput, provider: ProviderAdapter, tools: ToolRegistry, opts: RunOptions): Promise<RunResult<BrainstormTurn>>;
   // RunResult = { output: T; usage: Usage; toolCalls: ToolCallRecord[]; retries: number } ; emits agent.run.delta via opts.onDelta
export class ToolRegistry { register<I, O>(def: ToolDef<I, O>): void; permitted(agent: 'brainstorm'|'editor'|'runtime'): ToolDef[]; call(agent, name, input, ctx): Promise<ToolResult>; }
   // permission matrix AGENT_DESIGN §2.4 is data in tools/permissions.ts; no shell/fs/network tools can be registered (AI-020: ToolDef has no `exec` escape hatch)
export function loadPrompts(version: string, decrypt: (buf: Buffer) => string): PromptSet;   // SYSTEM_PROMPT.md assets, encrypted at rest (ADR-007)
export function estimateCost(usage: Usage, row: CapabilityRow | undefined, providerCost?: number): { costUsd: number | null; approximate: boolean };  // AI_WORKFLOW §11
```

### 3.5 `packages/models`

Purpose: Model Manager core (registry, download with hash + resume, install state) and engine adapters that run Engine Binaries as child processes with files in / files out. P1/P2 consumers; the package exists from Stage 3 with the registry and download code only.

```ts
export const registry: Record<ModelKey, ModelDef>;   // LOCAL_AI_MODELS.md; { engine, version, bytes, sha256, urls[], licence, tiers, task }
export class ModelManager { constructor(opts: { modelsDir: string; egress: Egress; db: ModelStateStore; emit: (e: ModelEvent) => void });
  list(): ModelState[]; install(key: ModelKey, signal: AbortSignal): Promise<void>; remove(key: ModelKey): Promise<void>; verify(key: ModelKey): Promise<boolean>; }
export interface EngineAdapter<I, O> { kind: 'transcribe'|'synthesize'|'generateImage'|'generateMusic'; run(input: I, opts: { cwd: string; signal: AbortSignal; onProgress: (p: number) => void }): Promise<O>; }
export function whisperAdapter(binDir: string): EngineAdapter<TranscribeInput, Caption[]>;
export function sherpaTtsAdapter(binDir: string): EngineAdapter<TtsInput, { wavPath: string }>;
export function sdCppAdapter(binDir: string): EngineAdapter<ImageInput, { pngPath: string }>;
```

### 3.6 `apps/service` (Local Service)

Purpose: the only stateful process. Module folders mirror ARCHITECTURE.md §4.

```
apps/service/src/
  main.ts                     stdin handshake {token, port, dataDir, dbKey}, open DB, migrations, failInterrupted(), licence, tier, browserReady() in background, listen 127.0.0.1, print "ready <port>"
  config.ts                   resolved paths (ARCHITECTURE §8), EM_* dev overrides (TRD §4)
  http/  app.ts (createApp), guards.ts (Host/Origin/token), sse.ts (openSse + SseHub), errors.ts (EmError → envelope), route.ts (async wrapper), routes/*.ts (one file per API group)
  db/    open.ts (PRAGMA key/cipher), migrations/NNN_*.sql, repositories/*.ts (one per table), tx.ts
  composition/ service.ts     head/version access, executePlan(planId) = transaction{applyOps → validate → version row → ops history → head → checkpoint}
  intents/  service.ts        wraps packages/agents/intents with repositories; emits intent.updated
  plans/    service.ts        compile-or-agent, validate, stale detection, idempotent execute (EM-2308)
  agents/   runs.ts, conversations.ts, usage.ts, egress.ts (Private Mode gate)
  ingest/   pipeline.ts (probe → transcode → proxy → thumbs → filmstrip → waveform → hash), ffprobe.ts, ffmpeg.ts, limits.ts
  render/   queue.ts (ported RenderQueue), bundle.ts (prebuilt serveUrl), browser.ts (ported), stills.ts (ported), preflight.ts, validateOutput.ts (ffprobe), profiles.ts (PERFORMANCE §2 → renderMedia options)
  media/    server.ts         GET /media/:assetId/:variant with Range; path confinement
  models/   manager.ts        ModelManager host; generator-jobs.ts
  hardware/ monitor.ts        cheap meter (2 s), systeminformation (≥ 30 s), tier.ts
  license/  verify.ts, fingerprint.ts, state.ts     (bytecode-protected module in production builds)
  settings/ service.ts        settings table, provider connections (field-level AES-GCM), assignments, Private Mode
  projects/ service.ts, backup.ts, restore.ts, checkpoints.ts
  diagnostics/ bundle.ts, logger.ts (JSON lines, redaction, rotation)
```

Public API: the HTTP contract (API_SPECIFICATION.md). Internal classes worth naming because other documents refer to them:

```ts
export class RenderQueue extends EventEmitter {           // render/queue.ts (ported)
  enqueue(input: { projectId: string; versionId: string; outputProfile: OutputProfile; performanceProfile: PerformanceProfile; filename: string; idempotencyKey?: string }): RenderJob;
  get(id: string): RenderJob | null; list(opts: { projectId?: string; status?: RenderStatus; limit?: number }): RenderJob[];
  cancel(id: string): RenderJob | null; counts(): { queued: number; rendering: number };
  on(event: 'job', listener: (job: RenderJob) => void): this;   // SseHub maps to render.queued/progress/done/failed/cancelled
}
export function ingestAsset(path: string, projectId: string, opts: { source: 'shell-path'|'multipart'; signal?: AbortSignal; emit: (e: IngestEvent) => void }): Promise<Asset>;
export function openSse(req: Request, res: Response, opts: { lastEventId?: number }): { send(event: SseEventName, data: unknown): number; close(): void };   // http/sse.ts
```

### 3.7 `apps/ui` (Editor)

Purpose: presentation only (ARCHITECTURE.md §3 "must not compute or mutate the Composition Model locally").

```
apps/ui/src/
  main.tsx, App.tsx            providers, routes (editor, onboarding, screens as modals)
  api/client.ts                typed fetch with Authorization: Bearer; EmError on error envelope; DTO types from @expertmotion/shared/dto
  api/events.ts                EventSource(/api/v1/events?token=) with seq dedupe + reconnection (ported store pattern)
  state/service.tsx            ServiceProvider/useService: online tri-state, SSE fan-out, toasts (ported store.tsx, renamed)
  state/project.tsx            current project, head version, selection, playhead, intent queue, plan, render jobs (fed by SSE)
  header/                      menus, title, actions (hdr.*)
  library/                     Catalogue (lib.catalogue.*), TextPanel (lib.text.*), Generators (lib.generator.*), Assets (lib.assets.*)
  stage/Player.tsx             Player wrapper (ported Preview): fit-to-box, safe-area overlay, draft/full, ratio/res indicator
  stage/Timeline.tsx           read-only Tracks + elements + inspector (stage.timeline.*)
  stage/inspector/SchemaForm.tsx   ported JSON-Schema form, used as the fallback param sheet
  agent-panel/                 ModelBar, BrainstormChat, EditorChat (IntentQueue, PlanCard, Execute), OutputSettings (agent.*)
  screens/                     onboarding, license, providers, models, hardware, project dialogs, export, diagnostics, about (scr.*)
  components/ui.tsx            ported UI kit
  i18n/ en.json, id.json       every string (UX-041)
```

Exports: none consumed by other packages. Every interactive element carries `data-el="<Element ID>"` from ELEMENT_IDS.md (AGENT_DESIGN §6 `ui-dev`).

### 3.8 `apps/desktop` (Desktop Shell)

```
apps/desktop/src/
  main/index.ts        single-instance lock, safeStorage keyring (wrap/unwrap Database Key), free loopback port 47600–47699, spawn service with stdin handshake, restart backoff 1 s/3 s/9 s (EM-8001/8002), window, app:// protocol for apps/ui/dist, close flow (EM-8304), tray, updater
  main/ipc.ts          handlers: pickFiles(filters) → paths; pickFolder; revealPath(path); openExternal(storeUrl); getBootstrap() → {port, token}
  preload/index.ts     contextBridge.exposeInMainWorld('expertmotion', { getBootstrap, pickFiles, pickFolder, revealPath, openExternal, onServiceState })
  main/license/        bytecode-protected (ADR-007): nothing else lives here; verification itself is in apps/service/license (also bytecode)
```

`window.expertmotion` is the only bridge; `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (ARCHITECTURE.md §3).

## 4. Module boundaries and data contracts

| Contract | Producer → Consumer | Shape owner | Transport | Validation point |
|---|---|---|---|---|
| **Composition Model** | `composition-model` → service DB, engine, ui (read-only) | DATABASE_SCHEMA.md §4 | `model_json` column; `inputProps.model`; `GET /projects/:id/composition` | `CompositionModel.parse` on every DB read and before every write |
| **Composition Version** | service → ui | DATABASE_SCHEMA.md §3 `composition_versions` | DTO `{id, hash, parentId, cause, durationMs, createdAt, model?}` | repository |
| **Edit Intent** | ui / Brainstorming Agent → `agents/intents` → DB → ui (Intent Queue) | AI_WORKFLOW.md §3 `EditIntent` | `POST /projects/:id/intents` body (DesignPickInput subset), SSE `intent.updated` | `captureIntent` + `validateIntent` |
| **Edit Plan** | Compile or Editor Agent → `validatePlan` → DB → ui (Plan Card) | AI_WORKFLOW.md §3 `EditPlan` | `POST /projects/:id/plans`, SSE `plan.ready` / `plan.invalid` | `validatePlan` (schema + dry-run) |
| **Operation** | Compile / Editor Agent → `applyOps` | AI_WORKFLOW.md §3, §5 | inside `EditPlan.steps[].ops`; `operations_history.op_json` | `OPERATIONS[op].argsSchema` |
| **ExecutionResult** | `composition/service.executePlan` → ui, Editor Agent thread | AI_WORKFLOW.md §3 | `POST /plans/:id/execute` response, SSE `composition.updated` | — |
| **Rewrite envelope** | `buildRewriteEnvelope` → provider | AI_WORKFLOW.md §7 | provider request (JSON) | size ≤ 60 % context (AI_WORKFLOW §10) |
| **Tool call** | model → `ToolRegistry.call` | AI_WORKFLOW.md §8, AGENT_DESIGN.md §2.4 | in-process | Zod input; permission table |
| **Engine input** | service / ui → `ExpertmotionTimeline` | this document §3.3 `EngineInputProps` | `inputProps` (≤ 2 MB) | `calculateMetadata` parses |
| **Output Profile** | ui → service → engine | GLOSSARY, PERFORMANCE.md §3; Zod `OutputProfile` in API_SPECIFICATION.md §6.11 | `POST /renders` | `resolveDimensions` + preflight (PERFORMANCE §7) |
| **Performance Profile** | ui → service | PERFORMANCE.md §2 | `'standard'|'accelerated'|'turbo'` | tier availability check (EM-3106) |
| **API DTOs** | service ↔ ui | API_SPECIFICATION.md | JSON over loopback HTTP | Zod at the route boundary; generated TS types in `shared/dto` |
| **SSE events** | service → ui | API_SPECIFICATION.md §7 | `GET /events`, `GET /renders/:id/events` | `seq` monotonic per connection |
| **Shell bootstrap** | desktop → ui | this document §3.8 | preload `getBootstrap()` | — |
| **Service handshake** | desktop → service | ARCHITECTURE.md §5 | one JSON line on stdin `{token, port, dataDir, dbKeyHex}`; `ready <port>` on stdout | Zod in `main.ts` |
| **Asset facts** | service → composition-model, agents | DATABASE_SCHEMA.md `assets` | `AssetFacts { id, kind, durationMs, width, height, fps, hasAudio, status }` | CM-001/002 |
| **Catalogue** | engine/catalogue → agents, service, ui | DESIGN_CATALOGUE.md | module import; `GET /catalogue` adds tier/model availability | registry frozen; lint against DESIGN_CATALOGUE rows |

Rules that follow from the table:

1. The Editor never constructs an `Operation`; it sends Design Picks and Insert requests, and reads back versions.
2. The service never serialises a model that `validate()` marks `block`; a blocked `applyOps` rolls back the transaction (ExecutionResult.rollback).
3. `baseVersion` travels with every plan; `POST /plans/:id/execute` compares it with `projects.head_version_id` and answers `409 EM-2301` when stale (AI-013).
4. Everything crossing a process boundary is validated with Zod at the receiving side; TypeScript types are derived from the Zod schema, never written twice.

## 5. File-by-file port list from `/home/andre/experthinker-studio`

Legend: **keep** = logic retained, **rename** = identifier or file renamed, **remove** = deleted in the port. All exports named below were read in the predecessor source on 2026-10-24. Line counts are the predecessor's.

### 5.1 `apps/server/src` → `apps/service/src`

| Source (lines) | Destination | Keep | Rename / change | Remove |
|---|---|---|---|---|
| `queue.ts` (257) `RenderQueue`, `EnqueueInput`, `CODEC_EXTENSION`, `queue` | `render/queue.ts` | class shape: `active` map mutated in place, `pump()` + `starting` set, `cancelRequested` checkpoints before `selectComposition` and `renderMedia`, `makeCancelSignal`, `view()` ETA (`progress > 0.03`), `onProgress` throttles (emit 250 ms, persist 1 500 ms), `finish()` cleanup, partial-file `rmSync` on failure, thumbnail at 35 % via stills | `Job` → `RenderJob` (DATABASE_SCHEMA `render_jobs`); `EnqueueInput` → `{projectId, versionId, outputProfile, performanceProfile, filename, idempotencyKey?}`; `compositionId` fixed to `'ExpertmotionTimeline'`; `inputProps` built from the version's model + asset URLs; `renderMedia` options from `profiles.ts` (concurrency, `gl`, `hardwareAcceleration`, cache sizes, `disallowParallelEncoding`, `imageFormat`); `codec` from Output Profile (`h264` mp4; `gif`; `png` still via `renderStill`; `vp9`+alpha webm when `preset:background.none`); `getSettings().concurrency` → always 1 job at a time; `error` string → `error_code` + `error_detail` with `EM-32xx`; `saveJob` → `renderJobs` repository; add `preflight.ts` call before enqueue and `validateOutput.ts` (ffprobe duration ± 1 frame, width/height, fps, audio stream) before `done` (EM-3205); write `outputs` row; ETA suppressed until ≥ 5 % and 3 samples (UX-026); stall watchdog 120 s (EM-3207) | `Origin` (`dashboard`/`claude`), `groupId`, `prores` codec, `autoThumbnail` setting, `CODEC_EXTENSION` for prores |
| `bundler.ts` (178) `BundleManager`, `bundles`, `CompositionInfo`, `BundleState` | `render/bundle.ts` | `ensure(): Promise<string>` waiter pattern, `status()`, `CompositionInfo`, `refreshCompositions()` via `getCompositions` as a startup self-check | class → `EngineBundle`; `serveUrl` = `resources/engine/bundle` (production) or `EM_ENGINE_BUNDLE_DIR` (dev); missing or `ExpertmotionTimeline` absent → `EM-3003`; `sourceHash` → `bundleVersion` read from `resources/engine/bundle/manifest.json` (written by `packages/engine/scripts/build-bundle.ts`) | `chokidar` watch, `start()` re-bundling, `schedule()`, `hashSources()`, `walk()`, versioned `BUNDLES_DIR`, `@remotion/bundler` dependency in the service |
| `browser.ts` (59) `browserOpts`, `browserReady`, `browserStatus`, `BrowserStatus` | `render/browser.ts` | all three exports; single `readyPromise` with reset on error | `browserExecutable` always the bundled Chrome Headless Shell path (`resources/engine/chrome/<platform>/`); in production `onBrowserDownload` is replaced by a hard failure `EM-3001` (never download at runtime, ADR-008); in development the download is allowed when `EM_ALLOW_BROWSER_DOWNLOAD=1`; `chromeMode` fixed `'headless-shell'` | `STUDIO_BROWSER_EXECUTABLE`, `STUDIO_CHROME_MODE` env |
| `stills.ts` (64) `renderStillCached`, `StillRequest`, `thumbnailsDir` | `render/stills.ts` | serial chain (`serial()`), disk cache keyed by hash, `scale` clamp 0.1–1, `frame` clamp | key includes `bundleVersion` instead of `sourceHash`; `props` → `EngineInputProps`; `thumbnailsDir` → `outputs/<projectId>/thumbs/` for Outputs and `media/<projectId>/stills/` for the Thumbnail Sub-agent; `imageFormat` jpeg by default (png for stills export) | `getSettings().outputDir` |
| `util.ts` (42) `HttpError`, `newId`, `sha1`, `sanitizeFilename`, `timestamp`, `errorMessage`, `truncate` | `packages/shared/src/{errors,ids}.ts` | `sanitizeFilename` (unchanged; extension strip list extended to gif/png/wav/mp3), `timestamp`, `errorMessage`, `truncate` | `HttpError(status, message, details, code)` → `EmError(code, message, {status, details, path})` with mandatory `EM-` code; `newId(prefix)` → ULID `newId()` + `shortId()` for logs; `sha1` → `sha256Canonical` | — |
| `app.ts` (668) `openSse` (l.153–168), Host guard (l.279–283), Origin guard (l.285–291), `express.json({limit:'2mb'})`, `route()` wrapper, `validated()` | `http/sse.ts`, `http/guards.ts`, `http/route.ts` | `openSse`: headers (`text/event-stream`, `no-cache, no-transform`, `keep-alive`, `X-Accel-Buffering: no`), `retry: 2000`, `: ping` every 15 s, `send(event, data)`, close on `req.close`; Host allow-list (403), Origin check on non-safe methods (403), JSON limit 2 MB; `route()` async wrapper | `openSse` gains `id:` lines with a per-connection `seq`, a 500-event ring buffer in `SseHub` for `Last-Event-ID` replay, and the `?token=` check; guards gain the Service Token bearer check (401 `EM-8004`) and map to `EM-8005`; allow-lists built from the runtime port, not `STUDIO_*`; `/renders/:id/events` and `/events` retained (API_SPECIFICATION §6.11, §7) | all template routes (`/compositions`, `/presets`, `/schema`, `/validate`, `/stills`), `VERSION` constant, `ValidationFailed` (replaced by `EmError` `EM-9002`/`EM-2102`), `cors` package (replaced by explicit Origin middleware; CORS headers only in dev for the Vite origin) |
| `db.ts` (335) `failInterruptedJobs`, `saveJob` upsert, `getSettings`/`saveSettings` | `db/repositories/renderJobs.ts`, `settings/service.ts` | the patterns: mark `queued`/`rendering` → `failed` at startup (`EM-3203`), upsert by id, settings defaults merged on read | table set replaced by DATABASE_SCHEMA.md §3; raw `better-sqlite3` → `better-sqlite3-multiple-ciphers` with `PRAGMA key` | `renders`, `presets` tables, `Preset` CRUD, `Origin`, `jobByOutputPath` |
| `config.ts` (53) | `config.ts` | `HOST = '127.0.0.1'`; allow-list idea | values come from the stdin handshake (port, dataDir) with `EM_*` dev overrides (TRD.md §4); paths follow ARCHITECTURE.md §8, never repo-relative | `REPO_ROOT`, `VIDEO_DIR`, `ENTRY_POINT`, `WATCH_PATHS`, `BUNDLES_DIR`, `STUDIO_PORT`/`DASHBOARD_PORT`, `RENDER_CONCURRENCY` env (now a Performance Profile policy), `VIDEO_EXTENSIONS` (now `ingest/limits.ts` with PRD-005 lists) |
| `index.ts` (39) | `main.ts` | startup order (fail interrupted jobs → warm browser in background → listen loopback), `EADDRINUSE` handling, SIGTERM graceful close with 1.5 s fallback | adds stdin handshake, DB open/migrate, licence + tier detection, `ready` line; `console.log` → structured logger | banner text |

### 5.2 `packages/video/src` → `packages/engine/src` (and `packages/composition-model`)

| Source (lines) | Destination | Keep | Rename / change | Remove |
|---|---|---|---|---|
| `formats.ts` (80) `FORMAT_KEYS`, `FormatKey`, `SafeArea`, `FormatDef`, `formats`, `DEFAULT_FORMAT`, `isFormatKey`, `detectFormat`, `FPS` | `formats.ts` | `SafeArea`, nearest-aspect search in `detectFormat`, the 9:16 safe margins (`top 190, right 120, bottom 340, left 72` at 1080 wide) and the 72/96 px margins for other shapes | keys `vertical/landscape/square/portrait` → `Ratio` (`'16:9'…'3:4'|'custom'`); `formats[key].width/height` → `resolveDimensions(ratio, resolution, custom)` implementing the PERFORMANCE.md §3 table (even px, custom clamp 1:3…3:1, ≥ 240); `detectFormat` → `detectRatio` over the seven ratios; `isFormatKey` → `isRatio`; `label`/`use` → i18n keys | `FPS = 30` (fps is `ProjectSettings.fps`), `DEFAULT_FORMAT` (default is Project Settings) |
| `layout.tsx` (68) `useLayout`, `Layout`, `SceneDurationProvider`, `useSceneDuration`, `blockHeight` | `layout.tsx` | `u = min(width,height)/1080`, safe area scaled from the preset, `contentW/H`, `isLandscape`, `blockHeight` | `key` → `ratio`; `SceneDurationProvider`/`useSceneDuration` → `ElementDurationProvider`/`useElementDuration` (frames of the enclosing `<Sequence>`) | `barH` and `box` (brand bar) |
| `fit.ts` (78) `fitText`, `estimateLines`, `fitSingleLine`, `FitOptions`, `FitResult` | `text/fit.ts` | all, unchanged (deterministic, DOM-free; used by the Layout Sub-agent and CM-008 in the headless Local Service) | add `fitTextSafe()` that calls `@remotion/layout-utils` `fitText`/`measureText` when `typeof document !== 'undefined'` (Player, renderer) and falls back to the estimator headless | — |
| `format-number.ts` (67) `formatId`, `scaleFor`, `formatValue`, `formatAxis`, `NumberFormatOptions` | `text/format-number.ts` | compact scale logic, tabular output | `formatId` → `formatNumber(value, locale, opts)` with `locale: 'id'|'en'` from `ProjectSettings.language`; ribu/juta/miliar/triliun only for `id`, K/M/B/T for `en` | id-ID as the implicit default |
| `fonts.ts` (35) `loadBrandFonts`, `headingFont`, `monoFont` | `fonts.ts` | `loadFont({family, url: staticFile('fonts/…'), weight, format: 'woff2'})` pattern, idempotent `started` flag, warn-not-throw | `loadBrandFonts()` → `loadFonts(fontPairId)`; faces table from DESIGN_CATALOGUE §10 fonts (Inter, Plus Jakarta Sans, Archivo, JetBrains Mono); `headingFont`/`monoFont` → `useTheme().fonts.heading/body/mono` | `brand` import |
| `components/KineticText.tsx` `KineticText`, `stripMarks`, `tokenize` | `components/KineticText.tsx` | `*word*` highlight tokenizer, per-word `spring` with `delay + i × stagger`, props `text, fontSize, fontWeight, delay, stagger, lineHeight, textAlign, fontFamily` | defaults `color = brand.colors.text` → `useTheme().colours.text`, `fontFamily = headingFont` → theme heading; highlight colour → `theme.colours.accent`; `textAlign` gains `'right'`; registered as `preset:texteffect.kinetic` | `brand`, `fonts` imports |
| `components/AnimatedNumber.tsx` `AnimatedNumber` | `components/AnimatedNumber.tsx` | `value × progress` count-up, `fontVariantNumeric: tabular-nums` | `monoFont` → theme mono; `formatValue` → `formatNumber(…, locale)`; registered as `preset:texteffect.counter` (P1) | — |
| `components/BarChart.tsx`, `LineChart.tsx`, `chart-types.ts` (`ChartPoint`, `ChartProps`, `clamp`, `defaultHighlight`) | `components/charts/` | animation and layout logic | `brand.colors.*` → theme tokens (`accent`, `muted`, `grid`, `up`, `down`); not registered in the P0 catalogue (reserved for a P2 `preset:overlay.chart` row) | `format` id-ID default |
| `schemas.ts` (167) `computeMetadata`, `getJsonSchema`, React-free registry convention | `metadata.ts` (engine), `packages/composition-model` | the convention (React-free module shared by server and UI) and the `calculateMetadata` from props idea | `computeMetadata(id, props)` → `calculateMetadata({props})` reading the model; `getJsonSchema` → `presetParamsJsonSchema` via `z.toJSONSchema` | `TEMPLATE_IDS`, `templates[]`, `getTemplate`, `requireTemplate`, `secondsToFrames` (ms-based `framesOf` instead) |
| `validation.ts` (177) `ValidationIssue {path, message}`, `formatPath`, `formatIssues` | `packages/shared/src/result.ts`, `packages/composition-model/src/validate.ts` | the issue shape with `path` strings and `formatIssues` for logs | `ValidationIssue` → `Issue` with `code` and `severity` | `validateTemplateProps`, evidence-first warnings |
| `Root.tsx` (97), `entry.ts` (4) | `Root.tsx`, `entry.ts` | `registerRoot`, `<Composition calculateMetadata>` pattern | one composition `ExpertmotionTimeline`; `defaultProps` = empty model | six `<Composition>` entries, `<Folder>` grouping |
| `test/validation.test.ts` (22 cases via `tsx`) | `packages/composition-model/test/*.test.ts` | case style (fixture → expected issues) | runner → Vitest | all evidence/template cases |

### 5.3 `apps/dashboard/src` → `apps/ui/src`

| Source (lines) | Destination | Keep | Rename / change | Remove |
|---|---|---|---|---|
| `store.tsx` (154) `StudioProvider`, `useStudio`, `Toast` | `state/service.tsx` | context provider, `online: boolean | null` tri-state, toast queue (max 4, 4.5 s / 9 s), `upsertJobs` map, `seenFinal` first-load suppression, SSE subscription with reconnect | `StudioProvider`/`useStudio` → `ServiceProvider`/`useService` (GLOSSARY forbids "Studio"; the brief's working name `studio.tsx` is not used); `bundle`/`browser`/`compositions` state → `health` (mode, tier, licence, privateMode) and `renderJobs`; SSE events renamed per API_SPECIFICATION §7; `seq` dedupe | `refreshCompositions`, `CompositionView` |
| `components/ui.tsx` (144) `Spinner`, `StatusBadge`, `OriginBadge`, `ProgressBar`, `PageHeader`, `Empty`, `ErrorBox`, `ConfirmButton`, `Modal`, `jobSummary`, `Thumb` | `components/ui.tsx` | `Spinner`, `ProgressBar`, `PageHeader`, `Empty`, `ErrorBox`, `ConfirmButton` (UX-015), `Modal`, `Thumb` | `StatusBadge<status>` generic over render/ingest/agent statuses; i18n keys instead of literals; `data-el` prop | `OriginBadge`, `jobSummary` |
| `pages/Editor.tsx` (679) local `Preview` (l.62–133) | `stage/Player.tsx` | `ResizeObserver` fit-to-box sizing (`scale = min(availW/width, availH/height)`), `<Player controls loop clickToPlay acknowledgeRemotionLicense initialFrame>`, `PlayerRef` forwarding, safe-area overlay toggle, size/duration caption | `computeMetadata(id, inputProps)` → `calculateMetadata({props})`; `component={components[id]}` → `component={ExpertmotionTimeline}`; `inputProps = {model, assets, quality, watermark}`; overlay from `safeAreaFor(ratio)`; indicators wired to `stage.player.controls.*` | `JsonEditor`, `RenderDialog`, `SavePresetDialog`, `EditorInner` (template editing), `localStorage` drafts, format switcher |
| `components/SchemaForm.tsx` (448) `SchemaForm`, `ObjectForm`, `blankFor`, `Errors` | `stage/inspector/SchemaForm.tsx` | generic rendering of object/string/number/boolean/enum/array/`oneOf`; error and warning maps keyed by path | consumes `presetParamsJsonSchema(id)`; read-only mode for the inspector; "Details" param sheet for a Design Pick (UX-005) | `LONG_TEXT`, `HINTS` (evidence copy), `seed`, `onSeek` (scenes) |
| `api.ts` | `api/client.ts` | typed fetch wrapper that throws on the error envelope | adds `Authorization: Bearer` from `window.expertmotion.getBootstrap()` (or `EM_TOKEN` in browser dev), `Idempotency-Key` helper | template endpoints |
| `App.tsx`, `main.tsx`, `index.css` | `App.tsx`, `main.tsx`, `index.css` | Vite + Tailwind v4 setup, provider nesting | react-router pages → single Editor route + modal screens | nav for Library/Queue/Outputs/Presets/Settings/Activity |
| `pages/Library.tsx`, `Queue.tsx`, `Outputs.tsx`, `Presets.tsx`, `Settings.tsx`, `Activity.tsx` | — | nothing (template-centric pages) | — | removed; Export dialog (`scr.export`) and Outputs list are new components |

### 5.4 Not ported

| Source | Decision |
|---|---|
| `apps/mcp/*` | removed (ADR-015); an MCP façade is a P2 option over the same Tools |
| `scripts/dev-capped.sh`, `scripts/print-mcp-config.mjs` | removed as-is; a Linux-only `tools/dev/capped.sh` (systemd-run cgroup wrapper) may be re-created for headless tests on the shared server (TRD.md §5) |
| `packages/video/sample-props.json`, `public/logo.png` | removed |

### 5.5 Drop list (with reasons)

| Dropped | Reason |
|---|---|
| `packages/video/src/brand.ts` (`brand`, `Brand`), `components/Logo.tsx` (`Logo`, `Wordmark`), `components/SceneShell.tsx` | Expertmotion has no built-in brand; palette, fonts and spacing come from the Project's Theme (`preset:palette.*`, `preset:fontpair.*`) and are per Creator. Hard-coding a handle or logo would ship the predecessor's identity to every Creator. |
| Evidence-first schemas: `schema-common.ts` (`evidenceFields`, `sourceSchema`, `dateSchema`, `confidenceSchema`, `SAMPLE_SOURCE`, `isSampleSource`), `components/SourceTag.tsx` (`SourceTag`, `ConfidenceBadge`, `SOURCE_FONT`), `PropsError.tsx` | The Studio's non-negotiable "source + date on every number" was a brand editorial rule, not a property of the product. Expertmotion renders what the Creator inserts; it has no factual-claim concept in the Composition Model. |
| The six compositions `Explainer`, `HookIntro`, `DataExplainer`, `KeyFact`, `Contrast`, `ReflectiveOutro` (+ `registry.tsx`, `scene-view.tsx`, `defaults.ts` CONTOH content) | Replaced by the single document-driven `ExpertmotionTimeline` (ADR-001). Fixed templates with props cannot express an arbitrary Clip sequence, and their Indonesian sample content belongs to the predecessor brand. |
| Indonesian number formatting as the default (`formatId`, `formatValue` id-ID) | Kept as a capability, but the locale now follows `ProjectSettings.language`; an English project must not show "1.234,5". |
| `apps/mcp` (`render_video`, `create_preview`, `userApproved` gating) | ADR-015: agents call typed in-process Tools; Remotion's own MCP is deprecated. The approval gate survives as **Execute** (AI-004). |
| `scripts/dev-capped.sh` as-is | It hard-codes the Studio workspace names, ports 4100/5173 and `STUDIO_*` env. The constraint it encodes (900 MB soft / 1.2 GB hard on the shared server) stays in TRD.md §5 as a rule, not a script. |
| `apps/server` bundle watcher (`chokidar`) and runtime `@remotion/bundler` | The Engine bundle is prebuilt at package time (ADR-001, ADR-004); watching sources at runtime is a development-only concern handled by `remotion studio` and Vite. |
| `STUDIO_*` environment variables, repo-relative `data/` and `output/` paths | Replaced by the stdin handshake and the app-data layout (ARCHITECTURE.md §8); `EM_*` dev variables in TRD.md §4. |
| `presets` table and Presets page | A "preset" in the Studio was a saved props set for a template. In Expertmotion the word means Design Preset (closed catalogue); saved Creator favourites are a P2 idea with a different name. |
| `renders.origin` (`dashboard`/`claude`) | There is no external caller; the Creator is the only origin. Provenance of a change is the Intent Queue (`EditIntent.source`). |

## 6. Build and release artefacts

| Artefact | Built by | Contents | Integrity |
|---|---|---|---|
| **Editor bundle** `apps/ui/dist/` | Vite 6 (`vite build`), Tailwind v4 | `index.html`, hashed JS/CSS, fonts (UI), catalogue loops copied from `resources/catalogue/loops/` | served over `app://` by the Shell; CSP `default-src 'self'; connect-src http://127.0.0.1:*; media-src http://127.0.0.1:* 'self'` |
| **Service bundle** `apps/service/dist/service.mjs` (+ `node_modules` externals for native modules) | esbuild, `--platform=node --format=esm --minify --sourcemap=false` | Local Service; `license/` and `prompts/` as V8 bytecode (`.jsc`) loaded by a tiny loader | `asar` integrity fuse; `prompts.enc` decrypted in memory (ADR-007) |
| **Engine bundle** `resources/engine/bundle/` | `packages/engine/scripts/build-bundle.ts` → `@remotion/bundler.bundle()` | webpack output + `public/` (fonts, sfx) + `manifest.json {remotionVersion, bundleVersion (sha256 of files), builtAt}` | hash listed in SBOM; `EngineBundle` verifies `manifest.json` at startup (EM-3003) |
| **Catalogue loops** `resources/catalogue/loops/<category>/<name>.webm` | `packages/engine/scripts/build-loops.ts` (`renderMedia`, vp9, 2 s, 480 px, ≤ 40 MB total) | one loop per preset row in DESIGN_CATALOGUE.md; `index.json` with sizes | build fails if a preset lacks a loop (EM-3302 would otherwise show at runtime) |
| **Golden frames** `test/golden/<preset>/<ratio>.png` | `scripts/golden-frames.ts` (`renderStill`) | one still per preset × 7 ratios | compared in TEST_PLAN parity tests (≤ 1 % diff) |
| **Chrome Headless Shell** `resources/engine/chrome/win64/` | copied from `node_modules/.remotion/chrome-headless-shell/win64/` at package time, version pinned by its `VERSION` file | browser binary | file hash recorded in SBOM; EM-3001 if missing |
| **FFmpeg / ffprobe** `resources/engine/ffmpeg/` | from `@remotion/compositor-win32-x64-msvc` (name to verify, ASSESSMENT.md §4) | binaries used by `@remotion/renderer` (via `binariesDirectory`) and by `ingest/` | SBOM |
| **Engine Binaries** `resources/ai/<engine>/` | release script downloads pinned, hash-checked release archives (whisper.cpp, sherpa-onnx, sd.cpp) | P1/P2 only; absent in P0 builds | SBOM + Third-Party Notices (BRD-020) |
| **Electron installer** `release/Expertmotion-<semver>-x64.exe`, `latest.yml`, blockmap | electron-builder (NSIS, per-user install to `%LOCALAPPDATA%\Expertmotion\app`), signed with the Operator's OV certificate (BRD-015) | Shell + Editor + Service + Engine + resources | Authenticode signature; updater verifies signature (EM-8103) |
| **SBOM + notices** `release/sbom.cdx.json`, `THIRD_PARTY_NOTICES.txt` | `tools/release/sbom.mjs` (CycloneDX) + licence checker | npm tree + binaries + fonts + (later) models | gate: no GPL in bundled JS (BRD-019), no `licence:paid` preset (BRD-017) |
| **Licence CLI** `tools/license-cli` | `tsc` | Operator-only; never shipped | — |

Build order: `shared → composition-model → engine (lib) → agents, models → engine bundle + loops → service → ui → desktop → installer`. `npm run build` at the root runs it; `npm run build:p0` skips Engine Binaries.

## 7. The P0 vertical slice (first implementation target)

**Goal:** on a Windows machine, import one video clip, insert it twice, set a Fade transition on the Cut, render an MP4, and have the output validated, through the real pipeline (no shortcuts), with the Editor driven by the real API. Everything else in P0 is layered on this slice.

### 7.1 Scenario

1. Launch (dev: `npm run dev` starts the Local Service and the Vite Editor; Shell optional until Stage 3 packaging).
2. `POST /projects {name, settings: {fps: 30, ratio: '9:16', resolution: '1080p'}}` → project with an empty head version.
3. Import one MP4 via the Asset Panel (`POST /projects/:id/assets {paths:[…]}` from the Shell dialog, or multipart in the browser) → `ingest.progress` → `ingest.done` with proxy and thumbnail.
4. Sequence Badge 1 and 2 on the same Asset is not possible (one badge per Asset), so the slice inserts the Asset, then inserts it again (`POST /projects/:id/assets/insert` twice) → two `op:clip.insert` versions.
5. Design ▸ Transitions ▸ Fade click → `POST /projects/:id/intents` (Design Pick `preset:transition.fade`, target `selection` = none → Target Resolution "all Cuts") → `intent.updated`.
6. `POST /projects/:id/plans {intentIds}` → `needsInterpretation = false` → `compilePlan` → `plan.ready` (origin `compile`) → applied immediately per AI-004 (Compile path still creates the plan row and a version; UI shows "Applied directly").
7. Player shows the two Clips with the Fade; Timeline View shows video track + transition element.
8. Export → `POST /renders/estimate` → `POST /renders {versionId, outputProfile: {ratio:'9:16', resolution:'1080p', fps:30, codec:'h264', crf:18, format:'mp4'}, performanceProfile:'standard'}` → preflight → `render.queued` → `render.progress` → `render.done {outputId}`.
9. `GET /outputs/:id` shows `validated: true`, dimensions 1080×1920, fps 30, duration = 2 × clip − 500 ms (± 1 frame).

### 7.2 Modules touched (and nothing else)

| Layer | Files (first implementation set) |
|---|---|
| `packages/shared` | `ids.ts`, `errors.ts`, `result.ts` |
| `packages/composition-model` | `schema.ts` (full schema, required by Zod parse), `apply/clip.insert.ts`, `apply/transition.set.ts`, `validate.ts` (CM-001…005, CM-011), `timing.ts`, `hash.ts`, `diff.ts` |
| `packages/engine` | `formats.ts`, `metadata.ts`, `layout.tsx`, `theme.tsx` (default palette only), `fonts.ts`, `timeline/ExpertmotionTimeline.tsx`, `timeline/VideoTrack.tsx` (`<TransitionSeries>` + `@remotion/media` `<Video>`), `presets/transition/fade.tsx`, `catalogue/transition.ts` (fade + none rows), `Root.tsx`, `entry.ts`, `scripts/build-bundle.ts` |
| `packages/agents` | `schemas.ts`, `intents/capture.ts`, `intents/resolveTargets.ts` (transition row only), `intents/reduceQueue.ts` (exclusive-group), `intents/compile.ts` (transition category), `intents/validatePlan.ts` |
| `apps/service` | `main.ts`, `config.ts`, `http/{app,guards,sse,errors,route}.ts`, `routes/{health,projects,assets,media,composition,intents,plans,renders,outputs,events}.ts`, `db/{open,tx}.ts`, migrations `001_init.sql`, repositories `projects, assets, compositionVersions, editIntents, editPlans, operationsHistory, renderJobs, outputs`, `ingest/{pipeline,ffprobe,ffmpeg,limits}.ts`, `render/{queue,bundle,browser,stills,preflight,validateOutput,profiles}.ts`, `media/server.ts`, `composition/service.ts`, `intents/service.ts`, `plans/service.ts`, `diagnostics/logger.ts` |
| `apps/ui` | `api/{client,events}.ts`, `state/{service,project}.tsx`, `header/` (File ▸ New, Export only), `library/assets/*`, `library/catalogue/CatalogueCard.tsx` (transitions tab only), `stage/Player.tsx`, `stage/Timeline.tsx` (video track + transition), `agent-panel/editor/IntentQueue.tsx`, `agent-panel/output/OutputSettings.tsx` (ratio + resolution + profile), `screens/export/*`, `components/ui.tsx` |
| `apps/desktop` | Stage 3: `main/index.ts` (spawn, token, window), `preload/index.ts` (`getBootstrap`, `pickFiles`, `revealPath`); not needed to run the slice in a browser |
| `test` | `fixtures/media/clip-5s-1080p30.mp4` (CC0), `golden/transition.fade/*.png`, `e2e/p0-slice.spec.ts` |

Explicitly **not** in the slice: agents runtime, providers, Brainstorming, captions, text, audio, licence, Model Manager, hardware tiers beyond a stub `T0`, undo/redo UI, backup/restore. Each is added as its own increment against the same API.

### 7.3 Exit criteria

| Check | Evidence |
|---|---|
| `validate(model)` and `applyOps` unit tests for `clip.insert` and `transition.set` pass with ≥ 90 % line coverage of the touched files | Vitest report |
| Compile path produces an `EditPlan` for `preset:transition.fade` with zero provider calls | unit test with a throwing `Egress` |
| Player frame at the Cut midpoint and `renderStill` of the same frame differ ≤ 1 % | parity script (POC-002) |
| Output ffprobe: 1080×1920, 30 fps, duration = expected ± 1 frame, `validated = 1` | e2e assertion |
| Killing Chrome Headless Shell mid-render → job `failed` `EM-3201`, partial file removed, service alive, `/health` 200 | e2e assertion (PRD-015) |
| Linux dev server: unit and service tests run under the cgroup cap; render e2e runs on Windows only | TRD.md §5 |

## 8. Traceability: PRD P0 → packages

| PRD | Requirement (short) | Primary package(s) | Supporting |
|---|---|---|---|
| PRD-001 | packaged Windows app, no manual runtime | `apps/desktop`, `tools/release` | `apps/service` (embedded Node), `resources/engine` |
| PRD-002 | Editor three-column layout, Header menus | `apps/ui` | `packages/shared` (i18n keys) |
| PRD-003 | create/open/save/Save As/recent/autosave/recovery | `apps/service/projects`, `apps/service/db` | `apps/ui/screens/project*`, `apps/desktop` (dialogs) |
| PRD-004 | encrypted SQLite + media folder | `apps/service/db`, `apps/desktop` (`safeStorage`) | `packages/shared` |
| PRD-005 | import video/image/audio, transcode, proxies, thumbnails | `apps/service/ingest` | `apps/ui/library/assets`, `resources/engine/ffmpeg` |
| PRD-006 | asset preview, metadata, Sequence Badges, Insert | `apps/ui/library/assets`, `apps/service/routes/assets` | `packages/composition-model` (`op:clip.insert`) |
| PRD-007 | Composition Model, Tracks, read-only Timeline View | `packages/composition-model`, `apps/ui/stage/Timeline.tsx` | `apps/service/composition` |
| PRD-008 | Output Settings (ratios, resolutions, fps, profiles) | `packages/engine/formats`, `apps/ui/agent-panel/output` | `apps/service/render/profiles.ts` |
| PRD-009 | Player preview with controls and states | `apps/ui/stage/Player.tsx`, `packages/engine` | `apps/service/media` (proxy URLs) |
| PRD-010 | one external provider (OpenRouter), validation, models, budget | `packages/agents/providers`, `apps/service/settings` | `apps/ui/screens/providers` |
| PRD-011 | two agents, independent Model Assignment, visible usage | `packages/agents/runtime`, `apps/service/agents` | `apps/ui/agent-panel` |
| PRD-012 | Edit Intents, Intent Queue, Compile, Edit Plans, Execute gate | `packages/agents/intents`, `packages/composition-model` | `apps/service/{intents,plans,composition}`, `apps/ui/agent-panel/editor` |
| PRD-013 | `ExpertmotionTimeline` + P0 catalogue | `packages/engine` | `packages/engine/catalogue`, `test/golden` |
| PRD-014 | render/export MP4 (+GIF, PNG), progress, ETA, cancel, preflight | `apps/service/render` | `apps/ui/screens/export`, `packages/engine` (bundle) |
| PRD-015 | recoverable errors, render failure never crashes | `packages/shared/errors`, `apps/service/http/errors.ts`, `apps/service/render/queue.ts` | `apps/ui/components` (error cards) |
| PRD-016 | Service Token, Host/Origin, path restrictions, Electron hardening, encrypted credentials, signed installer | `apps/service/http/guards.ts`, `apps/service/media`, `apps/desktop`, `apps/service/settings` | `tools/release` (signing) |
| PRD-017 | offline Ed25519 licence, Trial Mode | `apps/service/license`, `tools/license-cli` | `packages/engine/components/Watermark.tsx`, `apps/service/render/preflight.ts` (720p cap) |
| PRD-018 | onboarding wizard, tour | `apps/ui/screens/onboarding` | `apps/service/settings` |
| PRD-019 | Hardware Monitor, tiers | `apps/service/hardware` | `apps/ui/screens/hardware`, `packages/engine/catalogue` (flags) |
| PRD-020 | Private Mode blocks all outbound calls | `apps/service/agents/egress.ts`, `apps/service/settings` | `packages/agents/providers` (`Egress`), `packages/models` (downloads), `apps/desktop` (updater gate) |
| PRD-021 | continuity docs | `docs/`, `process.md`, `memory.md` | — |

P1/P2 items map to `packages/models` + `apps/service/models` (PRD-031, 033, 051, 052, 053), `packages/engine/presets` (PRD-030, 050), `apps/ui/stage/Timeline.tsx` interactions (PRD-034, 036), `packages/agents/providers` (PRD-032, 037), `apps/service/hardware` benchmark (PRD-035).

## 9. Open points for this blueprint

| # | Point | Owner | Resolve by |
|---|---|---|---|
| 1 | Exact npm name of the Windows FFmpeg compositor package (ASSESSMENT.md §4 marks it unverified) | Engine lead | Stage 2 PoC |
| 2 | Whether `apps/ui` imports `packages/engine` source (Vite transpiles TSX) or `dist/`; source is faster for development, `dist/` guarantees Player = render code | Principal architect | Stage 3 start |
| 3 | `apps/service` as esbuild single file vs. plain `tsc` output with `node_modules` in the ASAR; single file is smaller and harder to read (ADR-007) but complicates native module externals | Service lead | Stage 3 |
| 4 | Catalogue loops: build on the Operator's Windows machine or in CI; the Linux dev server cannot run the full loop build within its memory cap | Operator | Stage 2 |
