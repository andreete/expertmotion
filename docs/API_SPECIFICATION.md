# API Specification: the Local Service contract (REST + SSE)

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Local Service lead |
| Last updated | 2026-10-25 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-002, 005, 006, 010, 013, 014, 015), ARCHITECTURE.md §4–§7, BLUEPRINT.md §3–§4, SECURITY.md (SEC-002, SEC-008, SEC-010), DATABASE_SCHEMA.md (tables, Composition Model), AI_WORKFLOW.md §3, §5, §6, §8, §12, AGENT_DESIGN.md, DESIGN_CATALOGUE.md, PERFORMANCE.md §2, §3, §7, ERROR_CATALOGUE.md, SECURITY.md (SEC-), TRD.md §3.2 |
| Used by | apps/ui (client), apps/service (routes), apps/desktop (lifecycle calls), TEST_PLAN.md (contract tests), FRD.md (FR- acceptance), MCP_AND_TOOLING.md |
| Owner of | route table, request/response DTOs named here, HTTP status ↔ `EM-` mapping, pagination, idempotency, media grant lifecycle (API side; control in SEC-010), SSE event names and payloads, reconnection semantics |

Schemas owned elsewhere are referenced by their Zod names: `CompositionModel`, `ProjectSettings`, `Theme` (DATABASE_SCHEMA.md §4); `EditIntent`, `EditPlan`, `Operation`, `ExecutionResult`, `ElementRef`, `PresetId`, `OpName` (AI_WORKFLOW.md §3); `BrainstormTurn` (AGENT_DESIGN.md §2.1). DTOs defined in this document live in `apps/service/src/http/dto.ts` and are re-exported as types from `@expertmotion/shared/dto`.

## 1. Conventions

| Item | Rule |
|---|---|
| Base URL | `http://127.0.0.1:<port>/api/v1`. `<port>` is chosen by the Desktop Shell at random among free ports in 42300–42399 (SEC-008) and handed to the Editor through the preload bootstrap; in development it is `EM_PORT` (fixed 4110 on the shared Linux server, with the Vite Editor on 4120). Media files are served from `http://127.0.0.1:<port>/media/<grant>/…` (outside `/api/v1`, §2.2 and §6.5). |
| Transport | HTTP/1.1 over loopback only; no TLS (loopback, token-authenticated, ADR-005). |
| Content types | Requests: `application/json; charset=utf-8` (≤ 2 MB), `multipart/form-data` for browser-dev uploads only. Responses: `application/json`, `text/event-stream` (SSE), `video/*`, `image/*`, `audio/*`, `application/json` (waveform), `application/zip` (backup, diagnostics). |
| Encoding | UTF-8; ids are ULIDs; timestamps ISO-8601 UTC; durations integer milliseconds; money `number` USD with `approximate: boolean`. |
| Field naming | `camelCase` in JSON (DB `snake_case` is mapped in repositories). |
| Versioning | path version `/api/v1`. Additive changes (new optional fields, new routes, new SSE events) do not bump the version; removing or changing a field does (`/api/v2` alongside `/api/v1` for one release). The Editor and the Service ship together, so the version is a safety net, not a compatibility programme. Every response carries `X-Expertmotion-Version: <app semver>`. |
| Time limits | no request blocks > 30 s (TR-027); long work is a job (`202 Accepted` + SSE). |
| Pagination | list routes accept `?limit=` (default 50, max 200) and `?cursor=` (opaque, from the previous `nextCursor`); response `Page<T> = { items: T[]; nextCursor: string | null; total?: number }`. Ordered newest-first unless stated. |
| Idempotency | `POST /plans/:planId/execute` and `POST /renders` accept `Idempotency-Key: <string ≤ 128>`. A repeat with the same key (and same project) within 24 h returns the first response with status `200` and `notice: 'EM-2308'` in the body. Execute is additionally idempotent on `planId` itself (AI_WORKFLOW.md §6): an executed plan returns its stored `ExecutionResult`. |
| Concurrency | `409` when a resource is busy or stale (§2.6). Clients retry on `EM-2309`, `EM-6004` after 500 ms, never on `EM-2301` (re-plan instead). |
| Caching | `Cache-Control: no-store` on `/api/v1/*`; media routes `Cache-Control: private, max-age=31536000, immutable` (ids are unique per file). |

## 2. Authentication and request guards

### 2.1 Service Token

| Rule | Detail |
|---|---|
| Header | `Authorization: Bearer <ServiceToken>` on every `/api/v1/*` request except `GET /api/v1/health` (which answers a reduced body without a token, §6.1). |
| Exceptions | Exactly two, both documented in ADR-005 and both loopback-only and read-only: (1) **EventSource**: `GET /api/v1/events?token=<ServiceToken>` and `GET /api/v1/renders/:jobId/events?token=…` accept the Service Token in the query string because `EventSource` cannot set headers; the Service never logs the query string of these routes (SEC-100 redacts `token=`). (2) **Media grants**: `GET /media/<grant>/…` carries a media grant token in the path because Chrome Headless Shell and the Player fetch media with plain URLs (§2.2, SEC-010). No other route accepts credentials outside the header. |
| Source of the token | Desktop Shell → preload `window.expertmotion.getBootstrap()` → `{port, token}`. Development: `EM_TOKEN` (TRD.md §4). |
| Missing or wrong token | `401` `EM-8004` with `WWW-Authenticate: Bearer realm="expertmotion"`; the body never says which of the two it was. |
| Rotation | one token per Service lifetime; a Service restart issues a new one and the Editor re-bootstraps (the Shell pushes it through `onServiceState`). Push shape `{status:'starting'|'ready'|'offline'|'failed', bootstrap?:{port,token}, code?:EM-code, logsDir?}`; the Shell re-sends the last state when the Editor (re)loads. On `ready` with a new endpoint the Editor re-points every call and the SSE URL, reconnects and refetches project + head (FR-171); `failed` (EM-8002, EM-6001) shows `sys.fatal`; `ready` with `code:'EM-6001'` means the Creator chose Restore backup and empty storage was created. |

### 2.2 Media grants (SEC-010)

A **media grant** is a random 256-bit token (base64url, 43 chars) that authorises read access to the media variants of **one project** for **one purpose**. It is the only credential ever placed in a URL path.

| Property | Preview grant | Render grant |
|---|---|---|
| Purpose | Player and Catalogue live preview in the Editor | Chrome Headless Shell during one Render Job (and `renderStill` for its thumbnail) |
| Issued by | `POST /projects/:id/open` (R-016, returned as `mediaGrant`) or explicitly `POST /projects/:id/media-grants` (R-042) | the render queue when the job leaves `queued`; never returned over the API |
| Scope | `{ projectId, kind: 'preview' }`: every asset of that project, all variants | `{ projectId, kind: 'render', jobId }`: assets referenced by the job's Composition Version only |
| Lifetime | sliding 12 h from last use (`EM_MEDIA_GRANT_TTL_H`); renewed by every R-016; revoked by R-043, by a Service restart, by Private Mode changes (no: Private Mode does not affect loopback media), and when the project is soft-deleted | from job start to the final `render.done|failed|cancelled` event, then revoked immediately (VC-12: a request with a finished job's grant → `404`) |
| Storage | in memory only (`media/grants.ts`), never in the database or logs (`grant=` redacted, SEC-100) | same |
| Validation | grant exists and is not expired → scope matches `assetId`'s project (and job's asset set for render grants) → variant exists → path looked up in the DB (never derived from the request) | same |
| Failure | `404 EM-9003` for unknown, expired, revoked or out-of-scope grants (no distinction is disclosed); `400` for malformed ids (ULID/base64url regex) | same |

URL shape: `http://127.0.0.1:<port>/media/<grant>/<assetId>/<variant>` and `http://127.0.0.1:<port>/media/<grant>/outputs/<outputId>/<file|thumb>`. The Service builds these URLs itself when it assembles `EngineInputProps.assets` for a render; the Editor builds them from `AssetDto.media` availability flags and the current preview grant (`mediaUrl(grant, assetId, variant)` helper in `apps/ui/src/api/client.ts`). A client whose grant expired receives `404` from the Player's media loads and simply calls R-042 to obtain a new one.

### 2.3 Shell-only routes

`POST /service/shutdown` and the `paths[]` form of `POST /projects/:id/assets` are **trusted-caller** routes: they require the header `X-Expertmotion-Caller: shell` in addition to the token. In production the Editor's preload sets this header only for calls that originate from a Shell dialog result (the path list comes from `pickFiles`); in browser development the header is accepted when `EM_TOKEN` is set. This is a labelling control, not a second secret; the real protection is path canonicalisation and the allowed-roots check (TR-081).

### 2.3a Licence gate (no Trial Mode)

Until a Licence Key verifies as `licensed` (LICENSE_OPERATIONS.md §7), every `/api/v1` route answers `403` `{ error: { code: "EM-5010", details: { status } } }` (`status` = `unlicensed` | `invalid` | `revoked` | `machine-mismatch`) except: `GET /health`, `GET /version`, `GET /license` (R-160), `POST /license/activate` (R-161), `GET /settings`, `PUT /settings` whose body has only `uiLanguage` and/or `theme`, `GET /events`, `GET /renders` and `POST /service/shutdown` (Shell close/update checks). The gate runs after the Service Token guard and before every module's routes (also for unknown paths, so it reveals no route list). It opens the moment R-161 succeeds; no restart.

### 2.4 Host and Origin

| Check | Allowed | Otherwise |
|---|---|---|
| `Host` | `127.0.0.1:<port>`, `localhost:<port>` | `403` `EM-8005` |
| `Origin` (on `POST`, `PUT`, `PATCH`, `DELETE`) | absent (same-origin fetch from `app://`, curl), `app://expertmotion`, or `EM_UI_ORIGIN` in development | `403` `EM-8005` |
| `Sec-Fetch-Site` | if present: `same-origin`, `none`; `cross-site` is refused unless `Origin` is an allow-listed Editor origin (`app://expertmotion`; the dev UI origin in development) | `403` `EM-8005` |
| Cookies | none are set or read | — |
| CORS preflight | answered (`204`, `Access-Control-Max-Age: 600`) for `app://expertmotion`, the packaged Editor, whose calls to `http://127.0.0.1:<port>` are cross-origin, and for `EM_UI_ORIGIN` in development; refused (`403`) for every other origin | — |

### 2.5 Request limits

| Limit | Value | Error |
|---|---|---|
| JSON body | 2 MB | `413` `EM-8006` |
| Multipart file (dev) | per kind, ASSET_INGESTION.md (video 4 GB, image 100 MB, audio 500 MB, subtitle 2 MB) | `413` `EM-1002` |
| `paths[]` per import | 50 | `413` `EM-1010` |
| Ops per plan / steps per plan | 200 / 40 | `422` `EM-2304` |
| SSE connections per token | 8 | `429` `EM-9005` (closes the oldest) |
| Requests per second (burst) | 50 | `429` `EM-9005` |

### 2.6 Error envelope and status mapping

```json
{ "error": { "code": "EM-2301", "message": "The composition changed after this plan was made. Ask the Editor Agent to plan again; nothing was applied.",
             "details": { "baseVersion": "a1f3…", "headVersion": "9c0e…" }, "path": "body.baseVersion" } }
```

`message` is the English body copy of ERROR_CATALOGUE.md (the Editor re-renders by `code` with the UI language). `details` is code-specific and documented in ERROR_CATALOGUE.md "Log fields"; it never contains stack traces, SQL, file paths of the installation or provider payloads. `path` is a JSON pointer-like location for validation errors (`body.settings.fps`, `query.limit`).

| HTTP | Meaning | Typical codes |
|---|---|---|
| 400 | request does not parse or fails the Zod request schema; a parameter is outside its range | `EM-9002` (schema), `EM-2102` (preset param range), `EM-2402` (custom ratio) |
| 401 | Service Token missing or wrong | `EM-8004` |
| 403 | Host/Origin refused; path outside allowed roots; Shell-only route without the caller header; product not activated (§2.3a) | `EM-8005`, `EM-8302`, `EM-1007`, `EM-5010` |
| 404 | resource does not exist (or is soft-deleted) | `EM-9003` (generic), `EM-6101` (project), `EM-2401` (version), `EM-1301` (asset file missing on disk, on media routes) |
| 409 | state conflict: stale plan, busy resource, duplicate name, already running | `EM-2301`, `EM-2309`, `EM-4305`, `EM-6004`, `EM-6103`, `EM-6303`, `EM-7104` |
| 413 | too large | `EM-8006`, `EM-1002`, `EM-1008`, `EM-1010` |
| 422 | well-formed but semantically rejected (validation of the Composition Model, intents, plans, preflight, licence keys, provider keys) | `EM-2001`, `EM-2002`, `EM-2101`, `EM-2104`, `EM-2105`, `EM-2201`, `EM-2202`, `EM-2302`, `EM-2303`, `EM-2304`, `EM-2306`, `EM-3101`…`EM-3106`, `EM-1001`, `EM-1003`, `EM-1009`, `EM-4002`, `EM-4004`, `EM-5002`…`EM-5008`, `EM-7004`, `EM-7105`, `EM-7106` |
| 423 | locked by Private Mode (any outbound action) or agents unavailable | `EM-8202`, `EM-4401` |
| 429 | rate or connection limit; licence activation lockout | `EM-9005`, `EM-5011` |
| 500 | unexpected failure (logged with stack, Creator sees "Something went wrong") | `EM-9001` |
| 502 | provider returned an error | `EM-4103`, `EM-4104` |
| 503 | storage unavailable, offline, engine missing | `EM-6001`, `EM-6002`, `EM-6005`, `EM-8201`, `EM-3001`, `EM-4003` |
| 504 | provider or operation timeout | `EM-4101`, `EM-9005` (operation) |

Successful responses: `200` (read/synchronous write), `201` (created, with `Location`), `202` (job accepted; body has the job), `204` (deleted). Warnings that do not fail a request appear as `warnings: Issue[]` in the body (`Issue` from `@expertmotion/shared`: `{code, path, message, severity}`).

## 3. Common DTOs (Zod, `http/dto.ts`)

```ts
const Id = z.string().ulid();
const Iso = z.string().datetime();
export const Page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.number().int().optional() });

export const Ratio = z.enum(['16:9','9:16','1:1','4:5','5:4','4:3','3:4','custom']);     // GLOSSARY Aspect Ratio
export const Resolution = z.enum(['720p','1080p','2k','2160p']);
export const Fps = z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]);
export const PerformanceProfile = z.enum(['standard','accelerated','turbo']);           // PERFORMANCE.md §2
export const OutputProfile = z.object({                                                 // GLOSSARY Output Profile; pixels from PERFORMANCE.md §3
  ratio: Ratio, customRatio: z.object({ w: z.number().int().min(1), h: z.number().int().min(1) }).optional(),
  resolution: Resolution, fps: Fps,
  format: z.enum(['mp4','webm','gif','png','wav']),                                     // outputs.kind: video | video(alpha) | gif | still | audio
  codec: z.enum(['h264','vp9','gif','png','pcm']).optional(),                           // derived from format when absent
  crf: z.number().int().min(1).max(51).optional(),                                      // ignored with hardware acceleration
  alpha: z.boolean().default(false),                                                    // webm + png frames only
  stillAtMs: z.number().int().min(0).optional(),                                        // format png
});

export const ProjectDto = z.object({ id: Id, name: z.string(), settings: ProjectSettings, language: z.enum(['id','en']), headVersionId: Id.nullable(),
  headHash: z.string().nullable(), durationMs: z.number().int(), assetCount: z.number().int(), createdAt: Iso, updatedAt: Iso, openedAt: Iso.nullable(), dirty: z.boolean(),   // FR-173: unsaved UI-level state only (a rename until Save/autosave); never set by a new Composition Version
  isSample: z.literal(true).optional(),                                                  // only on the onboarding Sample Project (R-025)
  uiState: z.record(z.string(), z.unknown()).optional() });                            // FR-012: Editor UI state written by Save (R-014), absent until first saved
export const VersionDto = z.object({ id: Id, projectId: Id, parentId: Id.nullable(), hash: z.string(), cause: z.enum(['insert','compile','execute','undo','redo','restore','system']),
  planId: Id.nullable(), durationMs: z.number().int(), createdAt: Iso, model: CompositionModel.optional() });
export const AssetDto = z.object({ id: Id, projectId: Id, kind: z.enum(['video','image','audio','subtitle']), name: z.string(), bytes: z.number().int(), sha256: z.string(),
  status: z.enum(['ingesting','ready','failed']), progress: z.number().min(0).max(1), errorCode: z.string().nullable(),
  durationMs: z.number().int().nullable(), width: z.number().int().nullable(), height: z.number().int().nullable(), fps: z.number().nullable(), hasAudio: z.boolean().nullable(),
  sequenceBadge: z.number().int().nullable(),
  codec: z.string().nullable(),                                                         // FR-043 label of the first video (else audio) stream, e.g. "H.264"
  missing: z.boolean(),                                                                  // FR-048 the stored original is not on disk (Locate via R-036, or Remove)
  media: z.object({ original: z.literal(true), playable: z.boolean(), proxy: z.boolean(), thumb: z.boolean(),
  filmstrip: z.boolean(), waveform: z.boolean() }),                                     // which variants exist; URL = /media/<grant>/<assetId>/<variant> (§2.2)
  probe: z.record(z.unknown()).optional(), createdAt: Iso, updatedAt: Iso });
export const RenderJobDto = z.object({ id: Id, projectId: Id, versionId: Id, outputProfile: OutputProfile, performanceProfile: PerformanceProfile,
  status: z.enum(['queued','rendering','done','failed','cancelled']), progress: z.number().min(0).max(1), renderedFrames: z.number().int().nullable(), totalFrames: z.number().int().nullable(),
  etaMs: z.number().int().nullable(), outputId: Id.nullable(), errorCode: z.string().nullable(), failedFrame: z.number().int().min(0).nullable() /* FR-143: frame a failed job stopped at (renderer error, else last progress); null = unknown */, width: z.number().int().nullable(), height: z.number().int().nullable(),
  createdAt: Iso, startedAt: Iso.nullable(), finishedAt: Iso.nullable() });
export const OutputDto = z.object({ id: Id, projectId: Id, renderJobId: Id, kind: z.enum(['video','gif','still','audio']), fileName: z.string(), bytes: z.number().int(),
  width: z.number().int().nullable(), height: z.number().int().nullable(), fps: z.number().nullable(), durationMs: z.number().int().nullable(), validated: z.boolean(),   /* `watermarked` removed 2026-10-25 (no Trial Mode) */
  path: z.string() /* absolute, for Reveal */, media: z.object({ file: z.literal(true), thumb: z.boolean() }) /* URL = /media/<grant>/outputs/<outputId>/<file|thumb> */, createdAt: Iso });
export const MediaGrantDto = z.object({ grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/), projectId: Id, kind: z.literal('preview'), expiresAt: Iso, baseUrl: z.string().url() /* http://127.0.0.1:<port>/media/<grant> */ });
export const IntentQueueDto = z.object({ projectId: Id, headHash: z.string(), items: z.array(EditIntent), lockedKeys: z.array(z.string()) });
export const PlanDto = EditPlan;                                                         // AI_WORKFLOW.md §3, plus server-set `id`, `status`, `validation`
export const CheckpointDto = z.object({ id: Id, projectId: Id, versionId: Id, reason: z.enum(['autosave','pre-execute','pre-render','manual']), createdAt: Iso, durationMs: z.number().int(),
  hash: z.string(), bytes: z.number().int() });                                         // FR-016: version (integrity) hash and file size
export const ConnectionDto = z.object({ id: Id, provider: z.enum(['openrouter','openai','anthropic','google','custom']), label: z.string(), baseUrl: z.string().url().nullable(),
  secretHint: z.string(), status: z.enum(['unvalidated','valid','invalid']), validatedAt: Iso.nullable(), modelsFetchedAt: Iso.nullable(), modelCount: z.number().int().nullable() /* FR-109; null = never fetched */, budgetMonthUsd: z.number().nullable(), createdAt: Iso, updatedAt: Iso });
// GLOSSARY Capability Table. Capability facts are tri-state (FR-114): null = not reported by the provider, shown as "?" and never guessed.
export const CapabilityRow = z.object({ modelId: z.string(), label: z.string(), contextLength: z.number().int().nullable(), toolCalling: z.boolean().nullable(), structuredOutput: z.boolean().nullable(),
  streaming: z.boolean().nullable(), imageInput: z.boolean().nullable(), pricePerMInput: z.number().nullable(), pricePerMOutput: z.number().nullable() });
export const AssignmentDto = z.object({ agent: z.enum(['brainstorm','editor']), connectionId: Id, modelId: z.string(), settings: z.object({ temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().optional(), effort: z.enum(['low','medium','high']).optional() }) });
export const AgentRunDto = z.object({ id: Id, projectId: Id, agent: z.enum(['brainstorm','editor']), status: z.enum(['running','done','failed','cancelled']), modelId: z.string(),
  connectionId: Id.nullable(), planId: Id.nullable(), errorCode: z.string().nullable(), usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number().nullable(),
  approximate: z.boolean(), contextLength: z.number().int().nullable() }).nullable(), startedAt: Iso, finishedAt: Iso.nullable() });
export const MessageDto = z.object({ id: Id, role: z.enum(['user','assistant','system','tool']), blocks: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('tool_call'), name: z.string(), input: z.unknown() }), z.object({ type: z.literal('tool_result'), name: z.string(), output: z.unknown() }),
  z.object({ type: z.literal('proposed_intents'), intents: z.array(EditIntent), handoffState: z.enum(['pending','sent','dismissed']) }),
  z.object({ type: z.literal('attachment'), assetId: Id.optional(), mime: z.string(), name: z.string() }) ])), agentRunId: Id.nullable(), createdAt: Iso });
export const HardwareProfileDto = z.object({ tier: z.enum(['T0','T1','T2']), cpuModel: z.string().nullable(), cpuThreads: z.number().int(), ramTotalMb: z.number().int(), gpuVendor: z.string().nullable(),
  gpuModel: z.string().nullable(), vramMb: z.number().int().nullable(), nvenc: z.boolean(), detectedAt: Iso, warnings: z.array(z.string()) });
export const HardwareTickDto = z.object({ at: Iso, cpuPercent: z.number(), ramFreeMb: z.number().int(), ramTotalMb: z.number().int(), processMb: z.number().int(), chromeMb: z.number().int().nullable(), shellMb: z.number().int().nullable() /* FR-127 Shell (Electron) processes */,
  diskFreeMb: z.number().int().nullable(), outputDiskFreeMb: z.number().int().nullable() /* FR-127 output drive */, gpuPercent: z.number().nullable(),
  workload: z.object({ rendering: z.boolean(), ingesting: z.number().int(), downloading: z.number().int(), agentRuns: z.number().int(),
    items: z.array(z.object({ kind: z.enum(['render','download','ingest','generator','agent']), id: z.string(), label: z.string() /* project name, model label, asset name, generator kind or agent */,
      status: z.string(), progress: z.number().min(0).max(1).nullable(), cancellable: z.boolean(), pausedReason: z.enum(['render']).nullable() })) /* FR-130 */ }) });
// chromeMb = resident memory of the Service's descendant processes (Chrome Headless Shell, FFmpeg, engines); /proc on Linux; on Windows one
// `tasklist /fo csv /nh` at most every 30 s while the meter is read, matched by Engine image name (approximate; never PowerShell/WMI per tick, NFR-009).
// shellMb = Electron main/renderer/GPU working set pushed by the Shell over parentPort every 30 s ({type:'metrics', shellMb}); null when absent or older than 90 s.
// Expertmotion process memory (FR-127) = shellMb + processMb + chromeMb.
export const LicenseDto = z.object({ status: z.enum(['licensed','unlicensed','invalid','revoked','machine-mismatch']),   // only `licensed` opens the §2.3a gate
  code: z.string().regex(/^EM-\d{4}$/).nullable(), clockAnomaly: z.boolean(), warnings: z.array(z.object({ code: z.literal('EM-5007'), lastSeen: Iso, now: Iso })), licenseeName: z.string().nullable(), tier: z.string().nullable(), licenseeHash: z.string().nullable(), updatesUntil: Iso.nullable(),
  updatesEligible: z.boolean(), machineCode: z.string() });   // `limits` removed 2026-10-25: single edition, no Trial Mode limits; `tier` kept for compatibility, never gates a feature
export const SettingsDto = z.object({ privateMode: z.boolean(), outputFolder: z.string(), autoPlan: z.boolean(), uiLanguage: z.enum(['en','id']), theme: z.enum(['dark','light','system']),
  defaultPerformanceProfile: PerformanceProfile, defaultRatio: Ratio, defaultResolution: Resolution, defaultFps: Fps, checkUpdates: z.boolean(), diagnosticsIncludeStructure: z.boolean(),
  onboardingDone: z.boolean(), onboardingSkippedSteps: z.array(z.enum(['license','provider','models','hardware','tour'])),   // FR-004 onboarding record ('license' only in records written before 2026-10-25; there is no Licence step any more)
  layout: z.object({ panelSizes: z.record(z.enum(['narrow','standard','wide']), z.object({ lib, agent, timeline }).partial()), libCollapsed: z.boolean(), agentCollapsed: z.boolean(), outputCollapsed: z.boolean() }).optional() });   // FR-099/FR-155 Editor layout (the settings.json state), absent until first saved
export const ModelStateDto = z.object({ key: z.string(), engine: z.string(), version: z.string(), task: z.enum(['stt','tts','image','music']), label: z.string() /* upstream name */,
  displayName: z.object({ en: z.string(), id: z.string() }) /* Creator-facing product name (FR-120, 2026-10-25); the Editor picks by UI language */, flag: z.string().nullable() /* Catalogue flag, e.g. 'model:whisper' */,
  licence: z.object({ name: z.string(), url: z.string() }),
  tiers: z.array(z.enum(['T0','T1','T2'])), bytesTotal: z.number().int(), bytesDone: z.number().int(), status: z.enum(['not-installed','downloading','verifying','paused','installed','failed']), errorCode: z.string().nullable(), installedAt: Iso.nullable(),
  // FR-120…FR-124: paused = waiting for a Standard/Accelerated render; model card and marks
  pausedReason: z.enum(['render']).nullable(), recommended: z.boolean() /* registry recommendedFor includes the current tier */, priority: z.enum(['P1','P2']), languages: z.array(z.string()), notes: z.array(z.string()),
  commercialUse: z.enum(['yes','conditional','no']), licenceDetail: z.object({ spdx: z.string().nullable(), redistribution: z.enum(['yes','no','verify']), useRestrictions: z.string().nullable() }),
  /* no download source (Operator decision 2026-10-25); licence.url is the SPDX licence text page when the licence has an SPDX id */ hashes: z.array(z.object({ name: z.string(), sha256: z.string().nullable() /* null = TO_PIN */ })), pathLabel: z.string(),
  usedBy: z.object({ generators: z.array(z.string()), presets: z.array(z.string()) }), engineNotices: z.array(z.object({ label: z.string(), licence: z.string(), spdx: z.string().nullable(), url: z.string() })),
  ramBytes: z.number().int(), vramBytes: z.number().int().nullable() });
export const GeneratorJobDto = z.object({ id: Id, projectId: Id, kind: z.enum(['voice','music','thumbnail','captions','hashtags']), status: z.enum(['queued','running','done','failed','cancelled']),
  progress: z.number(), modelKey: z.string().nullable(), resultAssetId: Id.nullable(), result: z.record(z.unknown()).nullable(), errorCode: z.string().nullable(), createdAt: Iso, startedAt: Iso.nullable(), finishedAt: Iso.nullable() });
```

## 4. Route table (summary)

Auth column: **T** = Service Token, **T+S** = token + Shell caller header, **grant** = media grant in the path (§2.2), **–** = none (loopback + Host guard only). Rows carry a stable id `R-nnn` used by the generated contract tests (TR-122).

| Id | Method | Path | Auth | Purpose | § |
|---|---|---|---|---|---|
| R-001 | GET | `/health` | – / T | liveness, mode, version, tier, licence, Private Mode | 6.1 |
| R-002 | POST | `/service/shutdown` | T+S | checkpoint all, cancel renders, exit | 6.1 |
| R-003 | GET | `/service/recovery` | T | what start-up recovery corrected this run (FR-171, FR-172) | 6.1 |
| R-010 | GET | `/projects` | T | list projects | 6.2 |
| R-011 | POST | `/projects` | T | create project | 6.2 |
| R-012 | GET | `/projects/recent` | T | recent projects (max 10) | 6.2 |
| R-013 | GET | `/projects/:id` | T | get project | 6.2 |
| R-014 | PATCH | `/projects/:id` | T | rename, language | 6.2 |
| R-015 | DELETE | `/projects/:id` | T | soft delete (30-day purge), or permanent with "keep Outputs" | 6.2 |
| R-016 | POST | `/projects/:id/open` | T | mark opened, lazily migrate, return head | 6.2 |
| R-017 | GET | `/projects/:id/settings` | T | Project Settings | 6.2 |
| R-018 | PUT | `/projects/:id/settings` | T | Project Settings (creates a version when the model changes) | 6.2 |
| R-019 | POST | `/projects/:id/duplicate` | T | copy project (Save As) | 6.2 |
| R-020 | POST | `/projects/:id/backup` | T | write backup zip | 6.2 |
| R-021 | POST | `/projects/restore` | T+S | import backup zip as a new project | 6.2 |
| R-022 | GET | `/projects/:id/checkpoints` | T | list checkpoints | 6.3 |
| R-023 | POST | `/projects/:id/checkpoints` | T | manual checkpoint (Save) | 6.3 |
| R-024 | POST | `/projects/:id/checkpoints/:checkpointId/restore` | T | restore as a new version | 6.3 |
| R-025 | POST | `/projects/sample` | T | create (or return) the onboarding Sample Project | 6.2 |
| R-026 | GET | `/projects/disk-usage` | T | disk use per project + total + free space; backup size estimate | 6.2 |
| R-027 | GET | `/projects/:id/thumbnail` | T | Open dialog thumbnail (image bytes or 204) | 6.2 |
| R-030 | POST | `/projects/:id/assets` | T+S / T | import by paths (Shell) or multipart (dev) | 6.4 |
| R-031 | GET | `/projects/:id/assets` | T | list assets | 6.4 |
| R-032 | GET | `/projects/:id/assets/:assetId` | T | get asset | 6.4 |
| R-033 | DELETE | `/projects/:id/assets/:assetId` | T | delete asset (and dependent clips, with confirmation flag) | 6.4 |
| R-034 | PUT | `/projects/:id/assets/:assetId/sequence-badge` | T | set or clear the Sequence Badge | 6.4 |
| R-035 | POST | `/projects/:id/assets/insert` | T | Insert ordered selection → ops → version | 6.4 |
| R-036 | POST | `/projects/:id/assets/:assetId/relocate` | T+S | point a missing asset at a new path (EM-1301 recovery) | 6.4 |
| R-040 | GET | `/media/:grant/:assetId/:variant` | grant | original, playable, proxy, thumb, filmstrip, waveform (Range) | 6.5 |
| R-041 | GET | `/media/:grant/outputs/:outputId/:variant` | grant | `file`, `thumb` of a rendered Output | 6.5 |
| R-042 | POST | `/projects/:id/media-grants` | T | issue (or renew) the preview media grant for a project | 6.5 |
| R-043 | DELETE | `/media-grants/:grant` | T | revoke a preview grant | 6.5 |
| R-050 | GET | `/projects/:id/composition` | T | head Composition Version with model | 6.6 |
| R-051 | GET | `/projects/:id/composition/versions` | T | version history | 6.6 |
| R-052 | GET | `/projects/:id/composition/versions/:versionId` | T | one version | 6.6 |
| R-053 | POST | `/projects/:id/composition/undo` | T | move head to parent | 6.6 |
| R-054 | POST | `/projects/:id/composition/redo` | T | move head forward | 6.6 |
| R-055 | GET | `/projects/:id/composition/diff` | T | diff between two versions | 6.6 |
| R-056 | POST | `/projects/:id/composition/validate` | T | dry-run ops against a version | 6.6 |
| R-060 | POST | `/projects/:id/intents` | T | create Edit Intent from a Design Pick or chat | 6.7 |
| R-061 | GET | `/projects/:id/intents` | T | Intent Queue | 6.7 |
| R-062 | POST | `/projects/:id/intents/:intentId/restore` | T | restore a superseded intent | 6.7 |
| R-063 | DELETE | `/projects/:id/intents/:intentId` | T | remove a queued intent | 6.7 |
| R-064 | DELETE | `/projects/:id/intents` | T | clear queued intents | 6.7 |
| R-065 | POST | `/projects/:id/intents/batch` | T | several fully specified picks as one unit (Reset to Defaults) | 6.7 |
| R-070 | POST | `/projects/:id/plans` | T | create plan: Compile or Editor Agent | 6.8 |
| R-071 | GET | `/projects/:id/plans` | T | list plans | 6.8 |
| R-072 | GET | `/plans/:planId` | T | get plan | 6.8 |
| R-073 | POST | `/plans/:planId/execute` | T | Execute (idempotent) | 6.8 |
| R-074 | POST | `/plans/:planId/cancel` | T | cancel planning run or discard plan | 6.8 |
| R-075 | PATCH | `/plans/:planId/notes` | T | Creator notes on the Plan Card | 6.8 |
| R-080 | GET | `/projects/:id/conversations/:agent` | T | thread (paged) | 6.9 |
| R-081 | POST | `/projects/:id/conversations/:agent/messages` | T | send a message → run | 6.9 |
| R-082 | POST | `/projects/:id/conversations/brainstorm/handoff` | T | send proposed intents to the Intent Queue | 6.9 |
| R-083 | DELETE | `/projects/:id/conversations/:agent` | T | clear thread | 6.9 |
| R-084 | GET | `/agent-runs/:runId` | T | run status | 6.9 |
| R-085 | POST | `/agent-runs/:runId/cancel` | T | cancel run | 6.9 |
| R-086 | GET | `/projects/:id/usage` | T | usage summary | 6.9 |
| R-090 | GET | `/providers/connections` | T | list connections | 6.10 |
| R-091 | POST | `/providers/connections` | T | add connection | 6.10 |
| R-092 | PATCH | `/providers/connections/:connId` | T | label, key, budget, baseUrl | 6.10 |
| R-093 | DELETE | `/providers/connections/:connId` | T | remove connection | 6.10 |
| R-094 | POST | `/providers/connections/:connId/validate` | T | validate key (outbound) | 6.10 |
| R-095 | GET | `/providers/connections/:connId/models` | T | cached Capability Table | 6.10 |
| R-096 | POST | `/providers/connections/:connId/models/refresh` | T | refresh models (outbound) | 6.10 |
| R-097 | GET | `/providers/assignments` | T | Model Assignments | 6.10 |
| R-098 | PUT | `/providers/assignments` | T | set Model Assignments | 6.10 |
| R-099 | GET | `/providers/budget` | T | budgets and month-to-date spend | 6.10 |
| R-100 | PUT | `/providers/budget` | T | set budgets | 6.10 |
| R-101 | POST | `/providers/validate` | T | dry-run validate a key + list its models; nothing stored (outbound) | 6.10 |
| R-102 | POST | `/providers/test` | T | fixed probe per agent: latency, tokens, cost, EM code (outbound) | 6.10 |
| R-103 | GET | `/providers/kinds` | T | providers with build availability, terms link, key shape | 6.10 |
| R-110 | POST | `/renders/estimate` | T | estimate seconds, bytes, warnings; preflight result | 6.11 |
| R-111 | POST | `/renders` | T | create Render Job (idempotent) | 6.11 |
| R-112 | GET | `/renders` | T | list jobs | 6.11 |
| R-113 | GET | `/renders/:jobId` | T | job | 6.11 |
| R-114 | POST | `/renders/:jobId/cancel` | T | cancel job | 6.11 |
| R-115 | GET | `/renders/:jobId/events` | T (query) | SSE for one job | 6.11 |
| R-116 | GET | `/projects/:id/outputs` | T | list outputs | 6.11 |
| R-117 | GET | `/outputs/:outputId` | T | output | 6.11 |
| R-118 | DELETE | `/outputs/:outputId` | T | delete file + row | 6.11 |
| R-119 | POST | `/outputs/:outputId/reveal` | T | absolute path for the Shell to open in Explorer | 6.11 |
| R-120 | GET | `/catalogue` | T | presets with availability for this machine | 6.12 |
| R-121 | GET | `/catalogue/search` | T | search presets | 6.12 |
| R-130 | POST | `/projects/:id/generators/:kind` | T | create generator job (P1/P2) | 6.13 |
| R-131 | GET | `/projects/:id/generator-jobs` | T | list jobs | 6.13 |
| R-132 | GET | `/generator-jobs/:jobId` | T | job | 6.13 |
| R-133 | POST | `/generator-jobs/:jobId/cancel` | T | cancel | 6.13 |
| R-134 | POST | `/generator-jobs/:jobId/insert` | T | insert a finished job's result later: applies its proposed ops as one version without re-running the engine; idempotent (second call → same `versionId` + notice EM-2308); 422 EM-9002 when not done or nothing to insert | 6.13 |
| R-135 | GET | `/generators` | T | Generator Cards: kind, enabled in this build, priority, required model with installed state, size and tier hint (FR-100, FR-107) | 6.13 |
| R-136 | POST | `/generator-jobs/:jobId/save-output` | T | save a chosen thumbnail candidate as an Output (kind `still`) in the Project output folder (FR-103) | 6.13 |
| R-137 | DELETE | `/generator-jobs/:jobId` | T | remove a result from the 7-day "Generated" list (a running job is cancelled first) (FR-108) | 6.13 |
| R-140 | GET | `/models` | T | Model Manager list | 6.14 |
| R-141 | GET | `/models/:key` | T | one model with progress | 6.14 |
| R-142 | POST | `/models/:key/install` | T | start download (outbound) | 6.14 |
| R-143 | POST | `/models/:key/cancel` | T | cancel download | 6.14 |
| R-144 | DELETE | `/models/:key` | T | remove weights | 6.14 |
| R-146 | POST | `/models/engines/:engine/reveal` | T | per-engine models folder for the Shell to open | 6.14 |
| R-147 | POST | `/models/registry/refresh` | T | check the Operator model CDN for a newer signed model list now (outbound) | 6.14 |
| R-150 | GET | `/hardware/profile` | T | tier and static facts | 6.15 |
| R-151 | POST | `/hardware/profile/refresh` | T | re-detect | 6.15 |
| R-152 | GET | `/hardware/live` | T | latest cheap-meter tick | 6.15 |
| R-160 | GET | `/license` | T | licence status | 6.16 |
| R-161 | POST | `/license/activate` | T | verify and store key | 6.16 |
| R-162 | POST | `/license/deactivate` | T | remove key (the product locks again) | 6.16 |
| R-170 | GET | `/settings` | T | settings | 6.17 |
| R-171 | PUT | `/settings` | T | settings incl. Private Mode | 6.17 |
| R-172 | POST | `/settings/caches/clear` | T | delete proxies/thumbs/stills caches | 6.17 |
| R-180 | POST | `/diagnostics/bundle` | T | build diagnostics zip | 6.18 |
| R-181 | GET | `/diagnostics/logs` | T | tail of the service log (redacted) | 6.18 |
| R-182 | GET | `/diagnostics/codes` | T | recent EM codes with timestamps and job/run ids (no content) (FR-150) | 6.18 |
| R-190 | GET | `/events` | T (query) | global SSE stream | 7 |

105 routes.

## 5. Route detail conventions

Each route below lists: request (params, query, body as Zod or a field table), response, errors (beyond the universal `400 EM-9002`, `401 EM-8004`, `403 EM-8005`, `429`, `500 EM-9001`), SSE events emitted, and one example. Examples omit the `Authorization` header for brevity; it is always present.

## 6. Routes

### 6.1 Health and service

**R-001 `GET /health`** — auth optional.

| Response (no token) | Response (token) |
|---|---|
| `{ status: 'ok', version: '1.0.0', mode: 'production'|'development', uptimeMs }` | adds `{ tier: 'T0'|'T1'|'T2', licence: LicenseDto.pick(status, tier, updatesEligible), privateMode: boolean, engine: { bundleVersion, remotionVersion, browserReady: boolean, ffmpeg: boolean }, db: { schemaVersion, ok: boolean }, workload: { rendering, ingesting, agentRuns, downloading }, seq: number }` |

With the token the body also carries `buildDate` (YYYY-MM-DD, the licence eligibility date, FR-151) and `engine.ok` / `engine.code` (`EM-3001`/`EM-3003`, FR-140); `engine.bundleVersion` is `ok`, `mismatch` or `unverified` (no manifest in development). Errors: `503 EM-6001|EM-6002` when the DB is not open (the Shell shows the fatal dialog). `seq` is the current global SSE sequence so a client can detect missed events before opening the stream.

```http
GET /api/v1/health
→ 200 { "status":"ok","version":"1.0.0","mode":"production","uptimeMs":5120,"tier":"T0","licence":{"status":"licensed","tier":"standard","updatesEligible":true},
        "privateMode":false,"engine":{"bundleVersion":"6b1d…","remotionVersion":"4.0.535","browserReady":true,"ffmpeg":true},"db":{"schemaVersion":1,"ok":true},
        "workload":{"rendering":false,"ingesting":0,"agentRuns":0,"downloading":0},"seq":418 }
```

**R-002 `POST /service/shutdown`** — T+S. Body `{ reason: 'window-closed'|'update'|'uninstall', timeoutMs?: 1000..10000 }`. Checkpoints every dirty project (reason `manual`), cancels running Render Jobs and agent runs, emits `service.notice {kind:'shutting-down'}`, answers `202 { acceptedAt }`, then exits. Errors: `409 EM-8304` when a render is running and `body.force !== true` (the Shell asks the Creator first).

**R-003 `GET /service/recovery`** — T. What the start-up recovery steps corrected in this Service run (FR-171, FR-172), computed once on the first call: `{ startedAt, unclean, renders: [{jobId, projectId}], agentRuns: [{runId, projectId, agent}], ingests: [{assetId, projectId, name}], plans: [{planId, projectId}], checkpoints: { offered: Id[], imported: Id[] } }` (rows marked `EM-3203`, `EM-4304`, `EM-1201` or plans failed by recovery within 60 s of `startedAt`; `unclean` = the running flag of the previous run was left behind). The Editor shows one toast per `startedAt` (`EM-8003` after a restart) with a link to the affected items. Before exiting (also on SIGTERM), R-002 additionally checkpoints every project changed in this run whose head has no checkpoint yet (FR-165).

### 6.2 Projects

**R-010 `GET /projects`** — query `limit`, `cursor`, `includeDeleted=false`. Response `Page<ProjectDto>` ordered by `updatedAt` desc.

**R-011 `POST /projects`** — body:

```ts
z.object({ name: z.string().min(1).max(120), settings: ProjectSettings.partial().optional(), language: z.enum(['id','en']).default('id'), theme: Theme.partial().optional(),
  durationPolicy: z.enum(['fit-content','fixed']).optional(), fixedDurationMs: z.number().int().min(1000).max(1_800_000).optional(),   // FR-009
  outputFolder: z.string().min(1).max(1024).optional() })                                                                                  // FR-009, stored with the project settings
```

Creates the project, an empty Composition Model (`createEmptyModel`) as version 1 (`cause: 'system'`; `durationPolicy`/`fixedDurationMs` set on it when given, `fixed` requires `fixedDurationMs` else `400 EM-9002`), and the media folder. `outputFolder` must be inside the user profile (`403 EM-8302`, same check as R-171) and becomes this project's export folder. Response `201 ProjectDto` + `Location: /api/v1/projects/<id>`. Errors: `409 EM-6103` duplicate name, `503 EM-6005` disk full. Events: `composition.updated`.

```http
POST /api/v1/projects
{ "name":"Promo Kopi Agustus","settings":{"fps":30,"ratio":"9:16","resolution":"1080p"} }
→ 201 { "id":"01JAZK…","name":"Promo Kopi Agustus","settings":{"fps":30,"ratio":"9:16","customRatio":null,"resolution":"1080p","autoRatio":false,"language":"id"},
        "language":"id","headVersionId":"01JAZK…V1","headHash":"3f9a…","durationMs":1000,"assetCount":0,"createdAt":"2026-10-24T03:00:00Z","updatedAt":"…","openedAt":null,"dirty":false }
```

**R-025 `POST /projects/sample`** — body `{ language?: 'id'|'en' = 'id' }` (strict). Creates the onboarding tour's Sample Project (ONBOARDING_TOUR.md §2) named "Contoh · Kafe Senja" (`id`) or "Sample · Kafe Senja" (`en`; a ` (2)` suffix if a Creator project already uses the name), with `isSample: true` in every `ProjectDto` (list, recent, get, open). Idempotent: if a sample project exists (not deleted) it is returned with `200`; otherwise `201 ProjectDto` + `Location`. The response returns immediately; the bundled files of `resources/sample` (`clip-1.mp4`, `clip-2.mp4`, `clip-3.mp4`, `kafe-senja.srt`, CC0, generated by `packages/engine/scripts/build-sample.mjs`) ingest in the background through the R-030 pipeline. When ingest settles the Service applies one Composition Version (`cause:'insert'`): the three clips in order (`op:clip.insert`), the SRT as captions (`op:caption.importSrt`) and `op:theme.set {paletteId:'preset:palette.editorial-dark'}`, then emits `service.notice {kind:'sample', projectId, ready:true}` (`ready:false` with `failed[]` or `code` if a file could not be ingested). The sample is **hard-deleted** (rows, media folder, checkpoints; no 30-day retention) as soon as R-011 creates or R-016 opens another project; Save As (R-019) keeps a normal copy. Errors: `503 EM-3001` when `resources/sample` (or one of its files) is missing, `400 EM-9002`. Events: `composition.updated`, `ingest.progress|done|failed`, `service.notice {kind:'sample'}`.

**R-012 `GET /projects/recent`** — response `{ items: ProjectDto[] }` (≤ 10, by `openedAt`), skipping projects whose media folder is missing (flagged `warnings: ['EM-6102']` per item instead of omitted).

**R-013 `GET /projects/:id`** — response `ProjectDto`. Errors: `404 EM-6101`.

**R-014 `PATCH /projects/:id`** — body `{ name?: string, language?: 'id'|'en', uiState?: Record<string, unknown> }` (strict). `uiState` (FR-012) is the Editor's per-project UI state that Save writes next to settings, head pointer and title — Library mode, playhead, selection, Player toggles; JSON ≤ 16 KB (`400 EM-9002` above), stored in `projects.ui_state_json` (migration 13), returned as `ProjectDto.uiState`, never part of the Composition Model. Response `ProjectDto`. Errors: `404 EM-6101`, `409 EM-6103`.

**R-015 `DELETE /projects/:id`** — query `permanent=false`, `keepOutputs=true`. Default: soft delete (`deleted_at`), media kept 30 days. `permanent=true` (Open ▸ Delete, FR-178): rows, media folder and checkpoint files are removed now; Output files are kept unless `keepOutputs=false` (their rows go with the project). Response `204`. Errors: `409 EM-2309` when a render or agent run for the project is active, `EM-6401` when the files could not be removed.

**R-026 `GET /projects/disk-usage`** — query `projectId?`. Response `{ items: Array<{ projectId, mediaBytes, checkpointBytes, outputsBytes, outputCount, totalBytes, backupBytes, backupOutputsBytes }>, totalBytes, freeBytes }`: `totalBytes` = media folder + checkpoint files + Output files; `backupBytes` estimates an FR-017 backup without Outputs (original media + the last 50 versions' JSON + manifest), `backupOutputsBytes` is added when Outputs are included; `freeBytes` is free space on the data drive. Errors: `404 EM-6101`.

**R-027 `GET /projects/:id/thumbnail`** — the head version's first clip thumbnail (else the first asset thumbnail) as `image/jpeg` (or png/webp), `Cache-Control: private, max-age=60`; `204` when the project has none. Bearer token required (the Editor fetches it and shows a blob URL; no media grant). Errors: `404 EM-6101`.

**R-016 `POST /projects/:id/open`** — marks `openedAt`, runs `migrateModel` lazily (new version `cause:'system'` if migrated), returns `{ project: ProjectDto, head: VersionDto (with model), mediaGrant: MediaGrantDto, checkpointNewerThanSave: CheckpointDto | null, intentQueue: IntentQueueDto, latestPlan: PlanDto | null, renderJobs: RenderJobDto[] }` — one call restores the Editor state and hands out the preview media grant (§2.2). Errors: `404 EM-6101`, `422 EM-2001` when the stored model fails validation (the response then carries the last good checkpoint in `recovered`).

**R-017 `GET /projects/:id/settings`** — response `ProjectSettings & { durationPolicy: 'fit-content'|'fixed', fixedDurationMs?: number, outputFolder: string | null }` (the policy is read from the head model; `outputFolder` null = the app default R-171).

**R-018 `PUT /projects/:id/settings`** — body `ProjectSettings`. Changes to `fps`, `ratio`, `customRatio`, `resolution`, `autoRatio` are compiled into `op:project.setFps`, `op:output.setRatio`, `op:output.setResolution`, `op:output.setAutoRatio` (FR-088; Auto lives in the Composition Model, so Undo restores it) and applied as one Compile-path version (recorded as a `system`-source EditIntent so UX-010 holds). Response `{ settings, version: VersionDto | null, warnings }`. The body may also carry `durationPolicy`, `fixedDurationMs` (1000…1 800 000; required for `fixed` unless the model already has one) and `outputFolder` (string inside the user profile, or `null` to clear): a policy change is compiled into `op:project.setDurationPolicy` in the same version (FR-015); the folder is stored with the project settings and used by R-111 when no `folder` is given. Errors: `400 EM-2402` (custom ratio bounds), `400 EM-9002` (fixed without a length), `403 EM-8302` (folder outside the profile), `422 EM-3105` resolution not allowed on this tier (the setting is stored, rendering blocks). Events: `intent.updated`, `composition.updated`.

**R-019 `POST /projects/:id/duplicate`** — body `{ name: string, copyMedia: boolean = true }`. Copies settings, UI state, assets, all Composition Versions, intents, plans and both conversations (messages; ids inside blocks follow the copied assets/intents; FR-013). Response `201 ProjectDto` (new ids; media hard-linked or copied). Errors: `409 EM-6103`, `503 EM-6005`.

**R-020 `POST /projects/:id/backup`** — body `{ folder: string, passphrase?: string (min 8), includeOutputs: boolean = false }`. The archive holds `conversations.json` (both threads, messages only; provider connections and keys are never read) beside project, assets (removed assets excluded), versions, intents and plans (FR-017). Job: `202 { jobId }`; progress on `service.notice {kind:'backup', jobId, percent}`; result `service.notice {kind:'backup', jobId, done: true, path}`. Errors: `403 EM-8302` folder outside allowed roots, `422 EM-6304` not enough space, `EM-6301` write failure (via notice).

**R-021 `POST /projects/restore`** — T+S. Body `{ path: string, passphrase?: string, onConflict: 'copy'|'replace' = 'copy' }`. Response `202 { jobId }`; completion `service.notice {kind:'restore', jobId, projectId}` (with `code:'EM-6303', name` when restored as a renamed copy; the Editor shows EM-6303 with "Open restored project"). Conversations are restored when the archive has `conversations.json` (older archives have none); restored assets stay `ready` and are re-ingested in the background so proxies, thumbnails, filmstrip and waveform are regenerated (FR-018). Errors: `422 EM-6302` invalid backup, `409 EM-6303` project exists and `onConflict` not set.

### 6.3 Checkpoints

**R-022 `GET /projects/:id/checkpoints`** — response `{ items: CheckpointDto[] }` newest first (≤ 20), each with `hash` (the version hash the file holds, its integrity hash) and `bytes` (file size) for FR-016. Empty list carries `notice: 'EM-6202'`.

**R-023 `POST /projects/:id/checkpoints`** — body `{ reason: 'manual' }`. Writes the head model to `checkpoints/<projectId>/<hash>.json`, clears `dirty`. Response `201 CheckpointDto`. Errors: `503 EM-6005`, `EM-6104`.

**R-024 `POST /projects/:id/checkpoints/:checkpointId/restore`** — creates a new version from the checkpoint file (`cause:'restore'`), never overwrites history. Response `{ version: VersionDto }`. Errors: `404 EM-9003`, `422 EM-6201` damaged file. Events: `composition.updated`.

### 6.4 Assets

**R-030 `POST /projects/:id/assets`** — two request forms:

| Form | Auth | Body | Use |
|---|---|---|---|
| JSON | T+S | `{ paths: z.array(z.string().min(1)).min(1).max(50), copy: z.boolean().default(true) }` | production: paths returned by the Shell's `pickFiles`/drop handler |
| `multipart/form-data` | T | one or more `file` parts, each with the original filename | browser development only; refused in production (`403 EM-8005`) |

Each path is canonicalised and must be inside the user profile, removable drives or the drop-source list (`403 EM-1007`); extension and magic bytes must match PRD-005 kinds (`422 EM-1001`); size limits (`413 EM-1002`), image dimensions (`413 EM-1008`). In a batch (and for a single path) a file refused with `EM-1001`/`EM-1002`/`EM-1008` becomes a `failed` asset row with that `errorCode` (no file kept), returned in `items` and listed for 24 h (FR-050); other per-file errors are notices only. Duplicates are not re-added: the same source file (canonical path + size + mtime, stored as the digest `assets.source_key`, migration 21) — also twice in one request — answers `notice {code:'EM-1006', assetId}` (the existing asset) without a new row; a different path with the same content is caught after hashing (`ingest.failed {code:'EM-1006', existingAssetId}`, the new row is dropped). Response `202 { items: AssetDto[] (status 'ingesting', or 'failed' for refused files), notices: [{code, name, index, assetId?}] }`. Ingest runs two jobs in parallel (FFmpeg steps still one at a time under the heavy lock) and waits between stages while a Standard/Accelerated render is queued or running (`ingest.progress {stage:'paused'}`, FR-042). Events: `ingest.progress`, `ingest.done`, `ingest.failed` per asset.

```http
POST /api/v1/projects/01JAZK…/assets
X-Expertmotion-Caller: shell
{ "paths": ["C:\\Users\\septi\\Videos\\kopi-1.mp4", "C:\\Users\\septi\\Videos\\kopi-2.mov"] }
→ 202 { "items":[{"id":"01JAZM…A","kind":"video","name":"kopi-1.mp4","status":"ingesting","progress":0,"sequenceBadge":null,"media":{"original":true,"playable":false,"proxy":false,"thumb":false,"filmstrip":false,"waveform":false},…},
                 {"id":"01JAZM…B","kind":"video","name":"kopi-2.mov","status":"ingesting",…}], "notices":[] }
```

**R-031 `GET /projects/:id/assets`** — query `kind?`, `status?`, `limit`, `cursor`. Response `Page<AssetDto>` ordered by `createdAt` asc (import order); removed (soft-deleted) assets are not listed. Failed (unsupported) assets stay listed for 24 h after they failed, then the listing removes them and their folder (FR-050); removed assets that no Composition Version references any more are purged with their media (FR-052).

**R-032 `GET /projects/:id/assets/:assetId`** — query `probe=true` adds the full ffprobe JSON. Response `AssetDto`. Errors: `404 EM-9003`.

**R-033 `DELETE /projects/:id/assets/:assetId`** — query `confirm=true` required when Clips or layers reference the asset; without it the response is `409 { error: { code: 'EM-1101', details: { clips: n } } }`. With it, dependent elements are removed via `op:clip.remove`/`op:audio.remove`/`op:overlay.remove` in one version (`cause:'system'`). FR-052: while any Composition Version still references the asset the row is soft-deleted (`assets.deleted_at`, migration 21) and its media kept, so Undo restores the Clips with playable media; when a new head uses it again (Undo/Redo) it is listed again and `service.notice {kind:'assets-restored', projectId, assetIds}` is sent; an asset no version references is deleted with its files at once. Response `204` or `{ version: VersionDto }`. Events: `composition.updated`.

**R-034 `PUT /projects/:id/assets/:assetId/sequence-badge`** — body `{ badge: z.number().int().min(1).max(200).nullable() }`. Badges are unique per project: assigning an existing number shifts the others up. Response `{ items: AssetDto[] }` (all assets whose badge changed).

**R-035 `POST /projects/:id/assets/insert`** — body:

```ts
z.object({ assetIds: z.array(Id).min(1).max(50), order: z.enum(['badge','given']).default('badge'), atIndex: z.number().int().min(0).optional(), asOverlay: z.boolean().default(false), atMs: z.number().int().min(0).optional(),
  playheadMs: z.number().int().min(0).optional() })                 // FR-049: audio layers start at the playhead
```

Builds one `op:clip.insert` per video/image asset (images get `durationMs` 5000 by default; `asOverlay` places images on the overlay track with `op:overlay.addImage` at `atMs`, FR-029; `atIndex` inserts after the selected Clip, FR-030/FR-049), `op:audio.addLayer` for audio assets at `playheadMs` (else `atMs`, else 0; FR-049), in Sequence Badge order (unbadged assets after badged, by import order). FR-049: the Insert is recorded as ONE `ui`-source EditIntent (`category:'asset'`, `propertyKey: list:asset.insert:<id>`, `params.targetLabel` "Insert N clips") that is compiled, validated and executed through the Compile path as one Composition Version (the Intent Queue shows it "applied directly"); clears the used badges, and, when `settings.autoRatio` and this is the first Clip, sets the ratio by `detectRatio`. Response `{ version: VersionDto, ops: Operation[], warnings, intentId }`. Errors: `422 EM-1301` asset not `ready`, `422 EM-2002` duration out of range. Events: `intent.updated`, `composition.updated`.

**R-036 `POST /projects/:id/assets/:assetId/relocate`** — T+S. Body `{ path: string, reingest?: boolean = false }`. Used by the Locate action of a missing asset card (FR-048). The new file must hash to the stored `sha256` (`422 EM-1302` otherwise, then re-ingested as a new asset when `body.reingest = true`). Response `AssetDto`.

### 6.5 Media serving and media grants

Routes live at `http://127.0.0.1:<port>/media/<grant>/…` (no `/api/v1`, no Bearer header: Chrome Headless Shell and the Player fetch them with plain URLs). Protection is the loopback bind, the Host guard, the per-session or per-job media grant in the path (§2.2, SEC-010), DB-only path lookup, and read-only semantics (`GET`/`HEAD` only; every other method → `405`). The Editor assembles URLs as `${mediaGrant.baseUrl}/${assetId}/${variant}`; the Service assembles them for renders.

**R-042 `POST /projects/:id/media-grants`** — body `{}`. Issues a new preview grant for the project and revokes the caller's previous preview grant for the same project (one active preview grant per project per Service lifetime is enough: the Editor is the only consumer). Response `201 MediaGrantDto`. Errors: `404 EM-6101`. R-016 calls this internally and returns the same object.

**R-043 `DELETE /media-grants/:grant`** — revokes a preview grant (render grants cannot be addressed over the API). Response `204`; `204` also for unknown grants (idempotent, no disclosure).

**R-040 `GET /media/:grant/:assetId/:variant`** — `variant ∈ original | playable | proxy | thumb | filmstrip | waveform`.

| Variant | Content | Notes |
|---|---|---|
| `original` | the imported file | `Accept-Ranges: bytes`, `206` for `Range` |
| `playable` | H.264/AAC MP4 transcode when the original is not browser-playable (HEVC MOV, MKV, …), otherwise the original | Range |
| `proxy` | 720p-row H.264 proxy (Draft quality) | Range |
| `thumb` | JPEG poster | `image/jpeg` |
| `filmstrip` | JPEG sprite (N frames) | `image/jpeg`; `X-Filmstrip-Frames: N` |
| `waveform` | `{ sampleRate, peaks: number[] }` | `application/json` |

Errors: `404 EM-9003` unknown/expired/revoked/out-of-scope grant, unknown id, or variant not produced (one answer for all, SEC-010), `404 EM-1301` file missing on disk (DB row exists, grant valid), `409 EM-6004` while the variant is still being written, `400 EM-9002` malformed grant or id. Headers: `Content-Type` from the stored probe, `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Cross-Origin-Resource-Policy: same-site`.

```http
GET /media/Qm9vdHN0cmFwLWdyYW50LWV4YW1wbGUtNDNjaGFyc19fX18/01JAZM…A/proxy
Range: bytes=0-1048575
→ 206 Partial Content   Content-Type: video/mp4   Content-Range: bytes 0-1048575/18340211
```

**R-041 `GET /media/:grant/outputs/:outputId/:variant`** — `variant ∈ file | thumb`. Same rules; the grant must be a preview grant of the output's project; `file` honours `Range`. Used by the Export dialog's done state and the Outputs list.

### 6.6 Composition

**R-050 `GET /projects/:id/composition`** — query `model=true` (default) includes `CompositionModel`. Response `{ head: VersionDto, canUndo: boolean, canRedo: boolean, timing: { durationMs, cutStartMs: number[] }, issues: Issue[] }` (issues from `validate(model)`; blocks are impossible here because blocked models are never stored). Errors: `404 EM-6101`.

**R-051 `GET /projects/:id/composition/versions`** — query `limit`, `cursor`. Response `Page<VersionDto>` without `model`.

**R-052 `GET /projects/:id/composition/versions/:versionId`** — response `VersionDto` with `model`. Errors: `404 EM-2401`.

**R-053 `POST /projects/:id/composition/undo`** / **R-054 `…/redo`** — body `{}`. Undo moves the head to `parentId` and records a `cause:'undo'` version; redo moves to the most recent child that the undo came from (the redo stack is kept in memory per project and cleared by any other mutation). Response `{ head: VersionDto, canUndo, canRedo }`. Errors: `409 EM-2309` another mutation in flight, `422 EM-2401` nothing to undo/redo (details `{reason:'at-root'|'no-redo'}`). Queued plans become `stale` (`plan.invalid` with `EM-2301`). Settings intents stamped with the undone (redone) version are reverted to `params.__previous` (re-applied) — see R-065. Events: `composition.updated`; `settings.changed` when a profile moved with the version.

**R-055 `GET /projects/:id/composition/diff?from=<versionId|hash>&to=<versionId|hash>`** — response `{ from, to, diff: ExecutionResult.shape.diff, ops: Operation[] (operations_history between the two when linear) }`. Errors: `404 EM-2401`.

**R-056 `POST /projects/:id/composition/validate`** — body `{ baseVersion: z.string() (hash), ops: z.array(Operation).max(200) }`. Pure dry run of `applyOperations` + `validate` (the `composition.validateOps` tool over HTTP, for the inspector's "Details" param sheet). Response `{ ok: boolean, issues: Issue[], predictedDiff, predictedDurationMs }`. Never mutates; `409 EM-2301` when `baseVersion` is not the head (the result would be meaningless).

### 6.7 Intents

**R-060 `POST /projects/:id/intents`** — body `DesignPickInput`:

```ts
export const DesignPickInput = z.object({
  source: z.enum(['ui','chat']),                                   // 'brainstorm' arrives only via R-082; 'system' is server-only
  category: EditIntent.shape.category,
  presetId: PresetId.optional(), params: z.record(z.unknown()).default({}),
  target: ElementRef,                                              // kind ∈ sequence|clip|cut|text|caption|audio|shape|background|effect|project|selection|playhead; {kind:'selection'}/{kind:'playhead'} let the server resolve; cut indexes are 0-based
  selection: z.array(ElementRef).default([]), playheadMs: z.number().int().min(0).default(0),
  instruction: z.string().max(2000).optional(),                    // chat text → needsInterpretation
  baseVersion: z.string(),                                         // head hash the UI saw; mismatch → 409
  plan: z.enum(['auto','none']).default('auto'),                   // auto: compile immediately or start a plan when autoPlan is on
  // Deterministic Text Panel / Output picks (Compile path, no LLM):
  field: z.enum(['fontFamily','fontSize','weight','italic','colour','align','opacity','content']).optional(), value: z.unknown().optional(),   // FR-020…FR-028; content → op:text.setContent, opacity on shape/image → op:overlay.setOpacity
  output: z.object({ kind: z.enum(['ratio','resolution','fps','autoRatio','performanceProfile']), value: z.unknown(), customRatio: z.object({ w, h }).optional() }).optional(),   // performanceProfile: value ∈ PerformanceProfile, zero-op settings intent (FR-090)
  assetId: z.string().optional(),                                  // music bed / sfx asset
  text: z.string().min(1).max(500).optional(),                     // FR-027 Add Text content with a `preset:text.*` variant; without it a variant pick re-styles the selected Text Layer (FR-025)
});
```

Pipeline steps 2–7 (AI_WORKFLOW.md §2): capture, catalogue validation (`422 EM-2101`, `400 EM-2102`, `422 EM-2103` warn, `EM-2104`, `EM-2105`), Target Resolution (`422 EM-2201`, `EM-2202`), queue reduction (supersede/merge), then: if `needsInterpretation` is false and `plan='auto'`, the intent is compiled and applied immediately (new version, intent `status:'executed'`, plan row `origin:'compile'`); otherwise it stays `queued` and, when `settings.autoPlan` is on, a plan run starts (R-070 semantics) and `planId` is returned. Response `201 { intent: EditIntent, queue: IntentQueueDto, superseded: string[], appliedVersion: VersionDto | null, planId: Id | null, notices: [{code}] }` (`EM-2403` when a text pick with nothing selected compiled to `op:theme.setTextDefaults`, i.e. applied to the Theme defaults for new text). An executed intent carries `appliedVersion` (ordinal) and `appliedHash` (the version hash, FR-085). `output.kind:'performanceProfile'` (FR-090/FR-097) is a zero-op settings intent: it is applied to Settings `defaultPerformanceProfile` at once regardless of `plan`, recorded `executed` with `params.__previous` (the replaced profile), and answers `appliedVersion: null, planId: null`; R-062 Restore of the superseded profile intent applies that profile again (Undo); an unknown value answers `400 EM-9002`. FR-037: when the preset carries a `model:<id>` flag for a model that is not installed, the intent(s) are persisted with `status:'held'` (`params.__heldFor` = the flag; not superseding, not planned, removable with R-064) and the response is `201` with `notices:[{code:'EM-2104'}]`, `appliedVersion: null`; when the Model Manager installs that model (`model.installed`) every held pick for it becomes `queued` and runs the path above (Compile + apply). Errors: `409 EM-2301` when `baseVersion` is not the head. Events: `intent.updated`; `composition.updated` when applied; `settings.changed {scope:'settings'}` for a profile intent; `plan.ready`/`plan.invalid` when a plan was started.

```http
POST /api/v1/projects/01JAZK…/intents
{ "source":"ui","category":"transition","presetId":"preset:transition.fade","params":{},"target":{"kind":"selection"},"selection":[],"playheadMs":0,"baseVersion":"3f9a…","plan":"auto" }
→ 201 { "intent":{"id":"01JAZN…","projectId":"01JAZK…","source":"ui","category":"transition","presetId":"preset:transition.fade","params":{},"target":{"kind":"selection"},
          "resolvedTargets":[{"kind":"cut","index":0},{"kind":"cut","index":1}],"propertyKey":"cut:*.transition","propertyClass":"exclusive-group","needsInterpretation":false,
          "status":"executed","supersedes":[],"baseVersion":"3f9a…","createdAt":"…"},
        "queue":{"projectId":"01JAZK…","headHash":"b77c…","items":[…],"lockedKeys":["cut:0.transition","cut:1.transition"]},
        "superseded":[], "appliedVersion":{"id":"01JAZN…V","hash":"b77c…","cause":"compile","durationMs":13000,…}, "planId":"01JAZN…P", "notices":[] }
```

**R-065 `POST /projects/:id/intents/batch`** — body `{ baseVersion, picks: DesignPickInput[] (1–8, each without its own baseVersion) }`. Every pick goes through the R-060 pipeline and is recorded in the Intent Queue (superseding its predecessor), but all of them must be fully specified (`422 EM-2303` when one needs the Editor Agent). The Composition Model intents compile into one plan (`origin:'compile'`) and one Composition Version; zero-op settings intents (`output.kind:'performanceProfile'`) are applied to Settings, recorded `executed` and stamped with that version's `appliedHash`. R-053 Undo of that version re-applies their `params.__previous` and R-054 Redo their value, so one Undo restores the whole unit (FR-095, FR-097: Reset to Defaults = ratio + resolution + Auto off + profile Standard). Response as R-060 plus `intents: EditIntent[]`. Errors: `409 EM-2301`, R-060 validation errors. Events: `intent.updated`, `composition.updated`, `settings.changed {scope:'settings'}`.

**R-061 `GET /projects/:id/intents`** — query `status?` (comma list), `limit` (default 100). Response `IntentQueueDto` (all non-removed intents incl. `superseded`, newest first; `lockedKeys` computed from `compiled|executed` intents). An applied intent (`compiled|executed`) whose `appliedHash` is no longer in the head's parent chain (after Undo, R-053) carries `undone: true`; the queue chip then reads "undone" / "dibatalkan" (FR-167). Redo removes the flag.

**R-062 `POST /projects/:id/intents/:intentId/restore`** — sets a `superseded` intent back to `status: 'queued'` and stamps `restoredAt`; the intent that superseded it becomes `superseded` in turn (exclusive-group/scalar). There is no separate `restored` status. If the restored intent compiles directly and `settings.autoPlan`, it is applied. Response as R-060. Errors: `409 EM-2309`, `422 EM-2203` target gone.

**R-063 `DELETE /projects/:id/intents/:intentId`** — removes any non-executed intent (`queued`, `superseded`, `rejected`, `planned`, `compiled`; FR-079) (executed ones are history and cannot be removed; `422 EM-9002` with `details.reason:'executed'`). Response `IntentQueueDto`. Any `valid` plan becomes `stale`. Events: `intent.updated`, `plan.invalid`.

**R-064 `DELETE /projects/:id/intents`** — query `status=queued` (default; `superseded` also allowed). Response `IntentQueueDto`. Events: `intent.updated`.

### 6.8 Plans

**R-070 `POST /projects/:id/plans`** — body:

```ts
export const PlanCreateInput = z.object({ intentIds: z.array(Id).default([]) /* empty = all queued */, message: z.string().max(4000).optional(), baseVersion: z.string(), mode: z.enum(['auto','compile-only','agent']).default('auto') });
```

Decision (AI_WORKFLOW.md §7): if every selected intent has `needsInterpretation=false` and no `message` → Compile (`origin:'compile'`, synchronous, `status:'valid'`; applied immediately only through R-060's auto path — a plan created here waits for Execute so the Creator can review a multi-intent batch). Otherwise → Rewrite envelope → Editor Agent run (`202`, `status:'draft'`, `agentRunId`), result validated (`validatePlan`) → `plan.ready` (`valid`) or `plan.invalid` (`invalid` with `validation[]`, `touchesLockedKeys`). Response `201 PlanDto` (compile) or `202 { plan: PlanDto (draft), runId }` (agent). Errors: `409 EM-2301` base mismatch, `409 EM-4305` an Editor Agent run is active, `423 EM-4401` Private Mode (agent path only; compile still works), `422 EM-4007` no model assigned, `422 EM-4201` budget, `422 EM-2202` no clips, `503 EM-4001` no provider (agent path). Events: `agent.run.started/delta/done/failed`, `plan.ready`, `plan.invalid`.

**R-071 `GET /projects/:id/plans`** — query `status?`, `limit`. Response `Page<PlanDto>` without `steps[].ops` (use R-072). Every `PlanDto` carries `result: { ok, toVersion, appliedOps, added, removed, modified } | null` once executed (FR-086 diff summary in the Editor thread).

**R-072 `GET /plans/:planId`** — response `PlanDto` with full steps, plus `{ stale: boolean, headHash }`. Errors: `404 EM-9003`.

**R-073 `POST /plans/:planId/execute`** — header `Idempotency-Key` optional. Body `{ confirmDestructive: z.boolean().default(false) }` (required `true` when a step contains `op:clip.remove`, `op:caption.clear`, `op:background.clear`; otherwise `422 EM-9002` with `details.destructive: [ops]`, UX-015). Executes all steps in one transaction (AI-004), runs post-validation, writes a pre-execute checkpoint first. Response `200 ExecutionResult` (`ok:false` carries `error.code` such as `EM-2307`, `EM-2306`, `EM-2002`, with `rollback.performed:true`; the HTTP status is still `200` because the request itself succeeded and the result is the Creator-facing report). Errors: `409 EM-2301` stale (`plan.status` set to `stale`), `409 EM-2309` another Execute in flight, `409 EM-4303` cancelled (R-074) before the transaction started (FR-084), `422 EM-2302` plan touches Locked Keys, `422 EM-2303` plan invalid, `404 EM-9003`. Repeat: `200` with the stored result and `notice:'EM-2308'`. Events: `composition.updated`, `intent.updated` (intents → `executed`), `plan.ready` (status `executed`).

```http
POST /api/v1/plans/01JAZP…/execute
Idempotency-Key: 7c1b…
{ "confirmDestructive": false }
→ 200 { "planId":"01JAZP…","ok":true,"fromVersion":"b77c…","toVersion":"e012…","appliedOps":3,
        "diff":[{"elementId":"t1","change":"added","fields":["text","timing","position"]},{"elementId":"cut:0","change":"modified","fields":["transition"]}],
        "durationMs":41 }
```

**R-074 `POST /plans/:planId/cancel`** — cancels a running agent run (plan → `cancelled`, run → `cancelled`, `EM-4303` notice) or discards a `valid|invalid|stale` plan; a chat intent (FR-080) of that plan is removed. FR-084: an Execute that is accepted (`executing`) but has not yet entered its transaction is aborted too — the plan → `cancelled`, R-073 answers `409 EM-4303`, no Composition Version is written. Response `PlanDto`. Errors: `409 EM-2309` once the transaction is running (it is atomic, so a Cancel can never leave a partial version).

**R-075 `PATCH /plans/:planId/notes`** — body `{ notes: z.string().max(1000) }` (never parsed; forwarded as `creatorNotes` next turn). Response `PlanDto`.

### 6.9 Agents (conversations and runs)

`:agent ∈ brainstorm | editor`.

**R-080 `GET /projects/:id/conversations/:agent`** — query `limit` (default 50), `cursor`. Response `{ conversationId, agent, summary: ThreadSummary | null, assignment: AssignmentDto | null, contextUsage: { usedTokens, contextLength } | null, messages: Page<MessageDto> }` (messages oldest first within the page). Creates the conversation row on first access.

**R-081 `POST /projects/:id/conversations/:agent/messages`** — body:

```ts
z.object({ text: z.string().min(1).max(8000), attachments: z.array(z.object({ assetId: Id })).max(4).default([]), intentIds: z.array(Id).optional() /* editor: scope to these intents */, baseVersion: z.string(),
  target: ElementRef.optional()            /* editor, FR-067: the element "Ask Editor Agent" referenced */,
  selection: z.array(ElementRef).max(50).optional(), playheadMs: z.number().int().min(0).optional() /* editor, FR-080: Timeline state at send time */ })
```

Stores the user message, starts an agent run (`agent_runs`), answers `202 { message: MessageDto, runId }`. Brainstorming: the run ends with an assistant `MessageDto` whose blocks may include `proposed_intents` (handoff card) and one `tool_result` block per read-only tool the agent used (FR-075: `composition.get`, `assets.list`, `catalogue.search`, `hardware.profile`, `project.settings.get`, `render.estimate`; JSON-mode protocol `{"tool","input"}` → `{"toolResult"}`, at most 4 per answer). The thread window is 60 % of the model's context length; older turns are condensed by the deterministic summariser into `conversations.summary_json` (returned as `summary` by R-080). Editor (FR-080): the message is first enqueued as a chat Edit Intent (`source:'chat'`, `category:'layout'`, `propertyKey:'chat:<messageId>'`, `needsInterpretation:true`, `instruction` = text, `target`/`resolvedTargets` from `target` or `selection`), then the run produces a plan exactly like R-070 agent mode over every queued intent (the response also carries `planId`); `selection` and `playheadMs` go into the Rewrite envelope, and the Editor Agent has the read-only tools of the Brainstorming Agent plus `composition.validateOps` (dry run, AI_WORKFLOW §8). Cancelling the run (R-085 / R-074) removes that chat intent. Attachments (FR-072): image Assets are sent to the model as image parts (base64 of the original, ≤ 10 MB, PNG/JPEG/WebP/GIF) only when the assigned model's Capability Table row has `imageInput: true`; otherwise (including an unknown capability) `422 EM-4307`; non-image Assets travel as names only. `422 EM-2202` (editor) when the project has no clip. Errors: `423 EM-4401` Private Mode, `409 EM-4305` run active, `422 EM-4007` no model, `422 EM-4306` message too long for the model's context, `422 EM-4307` attachment image to a text-only model, `422 EM-4201` budget, `503 EM-4001` no provider, `409 EM-2301` (editor). Events: `agent.run.started`, `agent.run.delta` (streamed reply text only, coalesced to ≥ 40 chars or 80 ms; a JSON turn streams only its `reply` value — for the Editor Agent the plan's `goal` value (FR-084) — tool requests stream nothing), `agent.run.done`, `agent.run.failed`, then `plan.ready|plan.invalid` (editor).

```http
POST /api/v1/projects/01JAZK…/conversations/editor/messages
{ "text":"buat judul pembuka yang kuat, nuansa energik", "attachments":[], "baseVersion":"e012…" }
→ 202 { "message":{"id":"01JAZQ…M","role":"user","blocks":[{"type":"text","text":"buat judul pembuka yang kuat, nuansa energik"}],"agentRunId":"01JAZQ…R","createdAt":"…"}, "runId":"01JAZQ…R", "planId":"01JAZQ…P" }
```

**R-082 `POST /projects/:id/conversations/brainstorm/handoff`** — body `{ messageId: Id, intentIds: z.array(Id).optional() /* subset */, baseVersion: z.string() }`. Validates the `proposed_intents` like UI picks (steps 2–5), enqueues them with `source:'brainstorm'`, marks the block `handoffState:'sent'`. Response `{ queue: IntentQueueDto, accepted: Id[], rejected: [{id, code}], planId: Id | null }`. Errors: `409 EM-2301`, `404 EM-9003`. Events: `intent.updated`.

**R-083 `DELETE /projects/:id/conversations/:agent`** — clears messages (keeps usage records). Response `204`. Errors: `409 EM-4305`.

**R-084 `GET /agent-runs/:runId`** — response `AgentRunDto`. Errors: `404 EM-9003`.

**R-085 `POST /agent-runs/:runId/cancel`** — aborts the provider stream; run → `cancelled`; a draft plan → `cancelled`. Response `AgentRunDto`. Idempotent on finished runs (`200`, unchanged).

**R-086 `GET /projects/:id/usage`** — query `month=YYYY-MM` (default current). Response `{ project: { inputTokens, outputTokens, costUsd, approximate, runs }, byAgent: Record<'brainstorm'|'editor', same>, byModel: Array<{connectionId, modelId, …}>, budget: { projectLimitUsd: number|null, monthLimitUsd: number|null, spentMonthUsd, warn80: boolean, exceeded: boolean } }`.

### 6.10 Providers

**R-090 `GET /providers/connections`** — response `{ items: ConnectionDto[] }` (secrets never returned; `secretHint` only).

**R-091 `POST /providers/connections`** — body:

```ts
z.object({ provider: ConnectionDto.shape.provider, label: z.string().min(1).max(60), secret: z.string().min(8).max(512), baseUrl: z.string().url().startsWith('https://').optional() /* custom only */, budgetMonthUsd: z.number().positive().nullable().default(null), validateNow: z.boolean().default(true) })
```

Encrypts the secret (AES-256-GCM, TRD TR-031), stores `status:'unvalidated'`, then when `validateNow` and not Private Mode runs R-094 inline (≤ 15 s) and R-096 in the background. Response `201 ConnectionDto`. Errors: `422 EM-4402` secure storage unavailable, `422 EM-4002` key rejected (connection still stored as `invalid`), `423 EM-8202` Private Mode with `validateNow` (stored unvalidated, `notices:['EM-8202']`, status `201`).

**R-092 `PATCH /providers/connections/:connId`** — body `{ label?, secret?, baseUrl?, budgetMonthUsd? }`; a new secret resets `status` to `unvalidated`. Response `ConnectionDto`.

**R-093 `DELETE /providers/connections/:connId`** — refuses while an assignment uses it unless `?force=true` (then assignments are cleared, `EM-4007` applies). Response `204`. Errors: `409 EM-2309` (details `{assignments:['editor']}`).

**R-094 `POST /providers/connections/:connId/validate`** — outbound. Response `{ status: 'valid'|'invalid', validatedAt, errorCode? }`. Errors: `423 EM-8202`, `503 EM-4003`, `504 EM-4101`, `422 EM-4002`. Events: `settings.changed {scope:'providers'}`.

**R-095 `GET /providers/connections/:connId/models`** — response `{ items: CapabilityRow[], fetchedAt: Iso | null, stale: boolean (> 7 days) }` from the cache; empty with `notice:'EM-4006'` if never fetched.

**R-096 `POST /providers/connections/:connId/models/refresh`** — outbound (OpenRouter `GET /api/v1/models` with `supported_parameters`; other providers per adapter). Response `{ items: CapabilityRow[], fetchedAt }`. Errors: `423 EM-8202`, `503 EM-4003`, `502 EM-4006`.

**R-097 `GET /providers/assignments`** — response `{ brainstorm: AssignmentDto | null, editor: AssignmentDto | null, defaultConnectionId: Id | null }`.

**R-098 `PUT /providers/assignments`** — body `{ brainstorm?: AssignmentDto | null, editor?: AssignmentDto | null, defaultConnectionId?: Id | null }`. Refuses models whose `CapabilityRow.structuredOutput` is false (`422 EM-9002`, `details.reason:'no-json-output'`, AGD-004); returns `warnings` for context < 32k (`EM-4005` when tool calling is missing → JSON mode). Response as R-097 + `warnings`. Events: `settings.changed {scope:'assignments'}`.

**R-099 `GET /providers/budget`** — response `{ connections: Array<{connectionId, budgetMonthUsd, spentMonthUsd, approximate}>, projects: Array<{projectId, connectionId: string|null, limitUsd, spentUsd}>, month }`. FR-117: a `projects` row with `connectionId` is the per-Project cap on that Provider Connection (`spentUsd` = this month's spend of the project on that connection); `connectionId: null` is the older project-wide cap across all connections (kept for compatibility; migration 31 copies existing ones onto every connection).

**R-100 `PUT /providers/budget`** — body `{ connections?: Array<{connectionId, budgetMonthUsd: number|null}>, projects?: Array<{projectId, connectionId?: string|null, limitUsd: number|null}> }` (amounts 0…10 000; 0 or null = unlimited). Response as R-099. Errors: `404` unknown project or connection, `400 EM-9002` out of range. Events: `settings.changed {scope:'budget'}`. EM-4201 details: `{scope:'project'|'month', limitUsd, spentUsd, connectionId?, connection?}`; the Editor's "Change budget" opens Providers on that connection's field (AI-016).

**R-101 `POST /providers/validate`** (FR-113, FR-118) — body `{ provider, secret }` (secret trimmed, 8…512 chars). Calls the provider's cheapest authenticated endpoint (15 s timeout) and then its model list; **stores nothing** (the Add form saves with R-091 on Save). Response `{ status: 'valid', validatedAt, models: CapabilityRow[], modelsCode?: 'EM-4006' }` (a failed model list still returns `valid` with `modelsCode`). Errors: `422 EM-4002` (key rejected), `423 EM-8202`, `503 EM-8201` (offline), `503 EM-4003`, `504 EM-4101`, `422 EM-9004` (provider not in this build). The key never appears in responses, logs or SSE.

**R-102 `POST /providers/test`** (FR-116) — body `{ connectionId?: Id, draft?: { provider, secret }, brainstorm?: modelId | null, editor?: modelId | null }`. Runs one fixed probe per agent ("Reply with the word OK as JSON", temperature 0, ≤ 20 output tokens) through the same ChatProvider adapters as the chats: `draft` tests an unsaved form; otherwise the given (or assigned) connection; an omitted model id falls back to the saved assignment, `null` skips the agent. Response `{ items: Array<{ agent, modelId, ok, latencyMs, inputTokens, outputTokens, costUsd: number | null, approximate, code?: EmCode }> }` — per-agent failures are reported in `code` (EM-4002, EM-4004, EM-4101, EM-4102, EM-4103, EM-4301 when the answer is not the expected JSON, EM-8201 offline), never thrown. Cost: provider-reported, else Capability Table price (approximate), else `null` (tokens only). The probe records no Usage Record. Errors: `423 EM-8202`, `422 EM-4007` (nothing to test), `422 EM-9004`.

**R-103 `GET /providers/kinds`** (FR-111, FR-112) — response `{ items: Array<{ provider, enabled: boolean, priority: 'P0'|'P1'|'P2', termsUrl: string | null, keyPattern: string | null /* regex source, warn only */, keyExample: string | null }> }`. Providers not enabled in this build answer `422 EM-9004` (details `{ feature: 'provider.<kind>', plannedPriority }`) on R-091/R-101/R-102; the default (P0) build enables `openrouter` only; the OpenAI, Anthropic and Gemini adapters are enabled for P1 with `createProvidersModule({ enabledProviders })`.

R-093 detail (FR-119): with `force=true`, each affected agent moves to the oldest other **validated** connection whose cached Capability Table offers the same model id; otherwise its assignment is cleared (`EM-4007` applies). A removed default connection hands the default to that connection or to none. Usage Records are kept.

### 6.11 Render and outputs

**R-110 `POST /renders/estimate`** — body:

```ts
export const RenderCreateInput = z.object({ projectId: Id, versionId: Id.optional() /* default head */, outputProfile: OutputProfile, performanceProfile: PerformanceProfile, fileName: z.string().max(80).optional(), folder: z.string().optional() /* default settings.outputFolder */ });
```

Runs the Export preflight (PERFORMANCE.md §7) and an estimate (frames × measured ms/frame for the tier, bitrate heuristic). Response `{ ok: boolean, dimensions: {width, height}, totalFrames, durationMs, estimate: { seconds: number | null, bytes: number | null, confidence: 'low'|'medium'|'high' }, checks: Array<{ check: 'disk'|'memory'|'dimensions'|'duration'|'assets'|'engine'|'folder', ok: boolean, code?: string, details? }>, effectiveProfile: OutputProfile /* after the GIF cap */, warnings: Issue[], notices: string[] /* EM-3208 */, defaultFileName: string, privateMode: boolean, queue: { active: Id | null, queued: number } }`. Never `4xx` for a failed check (the Export dialog renders the list); `404 EM-6101|EM-2401` only.

Additions (FR-137…FR-140, FR-147, FR-163): `defaultFileName` is the stem `<project>-<ratio>-<res>-<yyyymmdd-hhmm>` (sanitised; R-111 uses it when `fileName` is absent and adds `-2`, `-3`… on collision); the `folder` check reports `EM-8302` (outside the allowed roots) or `EM-3206` (not writable, nearest existing parent tested); the `engine` check covers Chrome Headless Shell, the compositor FFmpeg (`binariesDirectory/ffmpeg[.exe]`) and the Engine bundle hash against `resources/engine-manifest.json` (hashed once at service start; mismatch → `EM-3003`, missing → `EM-3001`, `details: { missing[], mismatched[] }`); GIF is capped to 720p with an info warning `EM-3103` and encoded from an H.264 intermediate with FFmpeg `palettegen`/`paletteuse` at ≤ 15 fps, `-loop 0`; `privateMode` lets the dialog show "Private Mode on".

**R-111 `POST /renders`** — header `Idempotency-Key` recommended. Body `RenderCreateInput`. Re-runs preflight (blocking checks → `422` with the first failing code: `EM-3101`, `EM-3102`, `EM-3103`, `EM-3104`, `EM-1301`; `503 EM-3001` engine missing; `403 EM-8302` folder not allowed; `422 EM-3206` folder not writable), writes a pre-render checkpoint, enqueues. When the job starts, the queue issues a render media grant scoped to the job's assets and revokes it on the final event (§2.2). No licence-based cap or watermark exists (single edition); while not licensed the route answers `403 EM-5010` (§2.3a). Response `202 RenderJobDto` (`status:'queued'`; `notices:['EM-3208']` when another job is rendering). Events: `render.queued`, then `render.progress`…, `render.done|failed|cancelled`.

```http
POST /api/v1/renders
Idempotency-Key: export-01JAZK-e012-1
{ "projectId":"01JAZK…","outputProfile":{"ratio":"9:16","resolution":"1080p","fps":30,"format":"mp4","codec":"h264","crf":18,"alpha":false},"performanceProfile":"standard","fileName":"promo-kopi" }
→ 202 { "id":"01JAZR…J","projectId":"01JAZK…","versionId":"01JAZQ…V","outputProfile":{…},"performanceProfile":"standard","status":"queued","progress":0,"renderedFrames":null,
        "totalFrames":405,"etaMs":null,"outputId":null,"errorCode":null,"width":1080,"height":1920,"createdAt":"…","startedAt":null,"finishedAt":null }
```

**R-112 `GET /renders`** — query `projectId?`, `status?`, `limit`, `cursor`. Response `Page<RenderJobDto>`.

**R-113 `GET /renders/:jobId`** — response `RenderJobDto`. Errors: `404 EM-9003`.

**R-114 `POST /renders/:jobId/cancel`** — cancels queued or rendering (Chrome killed, partial file removed, `EM-3202` notice). Response `RenderJobDto`; `200` unchanged for finished jobs. Events: `render.cancelled`.

**R-115 `GET /renders/:jobId/events?token=…`** — SSE for one job: emits the current state immediately, then `render.progress`/`render.done|failed|cancelled`, and closes after the final event (ported predecessor behaviour). `404 EM-9003` before the stream opens.

**R-116 `GET /projects/:id/outputs`** — response `Page<OutputDto>` newest first.

**R-117 `GET /outputs/:outputId`** — response `OutputDto`. Errors: `404 EM-9003`.

**R-118 `DELETE /outputs/:outputId`** — deletes the file and thumbnail; row removed. Response `204`. Errors: `404`, `409 EM-6004` file locked.

**R-119 `POST /outputs/:outputId/reveal`** — response `{ path: string, folder: string }` (absolute); the Editor passes `folder`/`path` to `window.expertmotion.revealPath()`; the Service never launches Explorer (`EM-8303` is raised by the Shell when that fails). Errors: `404 EM-1301` file gone.

### 6.12 Catalogue

**R-120 `GET /catalogue`** — each item's `preview` is a path relative to the Editor origin (`catalogue/<category>/<name>.webm`; empty when the card draws a generated swatch); the Editor loads it from its own origin (`app://expertmotion/…`, dev: Vite public dir), never from the Local Service. Query `category?`, `priority?` (default `p0` in v1.0 builds; `p0,p1` later). Response:

```ts
z.object({ items: z.array(z.object({ id: PresetId, category, label: { en, id }, tags: z.array(z.string()), propertyClass, priority, flags: z.array(z.string()), preview: z.string() /* app:// or dev URL of the loop */,
  paramsSchema: z.record(z.unknown()) /* JSON Schema */, defaults: z.record(z.unknown()), availability: z.object({ ok: z.boolean(), reason: z.enum(['gpu','webgpu','model-missing','licence']).optional(), code: z.string().optional() /* EM-2103, EM-2104, EM-7001 */ }) })),
  catalogueVersion: z.string() })
```

Served from `packages/engine/catalogue` plus per-machine availability (tier, installed models). `ETag` = `catalogueVersion + tier + installedModelsHash`; `304` on `If-None-Match`.

**R-121 `GET /catalogue/search?q=&category=&lang=`** — response `{ items: [...as above, score] }` ordered by score (`searchPresets`). Empty `q` → suggested queries list in `suggestions: string[]`.

### 6.13 Generators (P1/P2)

`:kind ∈ voice | music | thumbnail | captions | hashtags`. In v1.0 (P0) every call answers `422 EM-9004` with `details.feature`.

**R-130 `POST /projects/:id/generators/:kind`** — body per kind:

| kind | Body | Engine | Result |
|---|---|---|---|
| `captions` | `{ source?: 'asset'|'sequence', assetId?: Id, language: 'id'|'en', modelKey?: string }` (`source: 'sequence'` or no `assetId` = the Sequence audio) | whisper.cpp (`model:whisper`) | `result.pages: CaptionPage[]` + proposed `op:caption.setPages` (+ `op:caption.setStyle {presetId: 'preset:caption.editorial'}` when the project has no caption style at Insert) |
| `voice` | `{ text: z.string().min(1).max(2000), voiceId: string, language: 'id'|'en', atMs?: number }` | sherpa-onnx + Piper | `resultAssetId` (audio) + proposed `op:audio.addLayer` |
| `music` | `{ prompt: string, durationMs: 5000..300000, style?: string, language?: 'id'|'en' }` | ACE-Step (T1/T2) or loop library (T0) | `resultAssetId` + proposed `op:audio.addBed` with the `preset:audio.bed-soft` Compile defaults (volume 0.2, loop, fade in/out 1000 ms) |
| `thumbnail` | `{ frameMs?: number, titleText?: string, prompt?: string, style?: 'bold'|'clean'|'cinematic'|'playful', language?: 'id'|'en', size?: {w,h} }` | `renderStill` / sd.cpp | `resultAssetId` (image) + proposed `op:overlay.addImage {assetId, atMs: frameMs}` (preview of the overlay); R-134 Insert applies it as `op:generated.insert {kind: 'thumbnail', jobId, atMs}` with the chosen candidate as the job result |
| `hashtags` | `{ language: 'id'|'en', platform: 'tiktok'|'instagram'|'youtube', tone?: 'casual'|'professional'|'energetic'|'informative'|'funny', count: 5..30 }` | connected LLM (ADR-009) | `result.caption, result.hashtags[], result.tone` |

Response `202 GeneratorJobDto`. Errors: `422 EM-7001` model not installed (details `{modelKey, bytes}`), `422 EM-7004|7105|7106`, `423 EM-8202` (hashtags), `409 EM-7104`. Events: `generator.progress|done|failed` (carried as `service.notice {kind:'generator', …}` to keep the SSE table closed; see §7).

Body additions (FR-101…FR-105): `voice.speed` 0.8–1.2; `music.instrumental?: boolean` (default true; appended to the prompt) and `modelKey: 'loop-library-cc0'` selects the bundled CC0 loop library on any tier (`result.cc0: true`); `thumbnail.count?: 1..4` returns `result.candidates: [{ assetId, frameMs? | seed }]` (frame mode: the chosen frame first, then frames spread over the Sequence; prompt mode: one seed each), `result.assetId` = the first candidate. FR-103: `thumbnail.style` picks the title Text Layer variant in frame mode (bold → title, clean → subtitle, cinematic → quote, playful → callout) and adds style wording to the prompt in prompt mode; in prompt mode `titleText` is part of the diffusion prompt. FR-104 Sequence mode transcribes each video Clip's audio segment (trim, playback rate) and moves its pages onto the Clip's window.

**R-131 `GET /projects/:id/generator-jobs`** — `Page<GeneratorJobDto>`; query `kind?` filters one generator. Jobs older than 7 days (not queued/running) are purged on service start and on every list call (FR-108); imported result Assets stay in the Asset Panel. **R-132 `GET /generator-jobs/:jobId`** — `GeneratorJobDto`. **R-133 `POST /generator-jobs/:jobId/cancel`** — kills the engine process; `GeneratorJobDto`.

**R-134** body (optional) `{ pages?: CaptionPage[], assetId?: Id, atMs?: int ≥ 0 }` (strict); for a `thumbnail` job `assetId` picks the candidate (400 EM-9002 if it is not one) and `atMs` the overlay start (the playhead) of "Insert as overlay" (FR-103), applied as one `op:generated.insert {kind: 'thumbnail', jobId, atMs}` (an image overlay of the chosen candidate); for a `captions` job the Creator's edited pages replace the engine's in `op:caption.setPages` (FR-104; the Editor keeps timings and re-spreads word tokens over an edited page); validated by `applyOperations` like any op.

**R-135 `GET /generators`** — response `{ items: Array<{ kind, enabled: boolean, priority: 'P1'|'P2', llm: boolean, tierHint: 'ok'|'slow', tier, model: GeneratorModel | null, models: GeneratorModel[] }> }` with `GeneratorModel = { key, label, displayName: { en, id }, bytes, installed, languages, minTier, belowTier, cc0 }` (`displayName` = the product name shown to the Creator, FR-120). `enabled` mirrors the build's `enabledKinds` (a disabled kind answers R-130 with `422 EM-9004`, so the Editor's "Coming later" badge always matches the Service); `model` is the tier default (LOCAL_AI_MODELS §5; `frame-composite` = no download), `models` every registry entry for the task (music includes the CC0 loop library). `hashtags` has `llm: true` and no model.

**R-136 `POST /generator-jobs/:jobId/save-output`** — body `{ assetId: Id }` (strict; must be the job's result or one of its `candidates`). Copies the PNG to `<outputFolder | outputs/<projectId>>/<project>-thumbnail-<yyyymmdd-hhmm>.png` and records an Output (`kind: 'still'`, with a synthetic `done` Render Job row so `outputs.render_job_id` stays valid). Response `OutputDto`. Errors: `400 EM-9002` foreign asset, `422 EM-9002` not done, `422 EM-1301` file missing, `422 EM-3206` folder not writable, `404 EM-9003`.

**R-137 `DELETE /generator-jobs/:jobId`** — `204`; `404 EM-9003` when unknown.

### 6.14 Models (Model Manager)

**R-140 `GET /models`** — response `{ items: ModelStateDto[], tier, totalInstalledBytes, diskFreeBytes }`. Hardware workload `download` items (R-152 / `hardware.tick`) also carry `displayName: { en, id }`.

**R-141 `GET /models/:key`** — `ModelStateDto` (with live `bytesDone`). Errors: `404 EM-9003`.

**R-142 `POST /models/:key/install`** — outbound, resumable, hash-verified. Response `202 ModelStateDto` (`downloading`). Errors: `423 EM-8202` (or `EM-7006` notice when offline), `422 EM-7004` disk, `409 EM-7104`. Events: `model.progress`, `model.installed`, `model.failed` (`EM-7002`, `EM-7003`).

**R-143 `POST /models/:key/cancel`** — Pause: keeps the partial file for resume. Response `ModelStateDto` (`not-installed`, `bytesDone` kept). With `?discard=true` (Cancel, FR-124) the partial files are deleted (`bytesDone: 0`).

Downloads also pause by themselves while a Standard or Accelerated Render Job is `rendering` (FR-124; checked every 2 s with one indexed query): status `paused`, `pausedReason: 'render'`, `model.progress {status:'paused', pausedReason:'render'}`; they resume from the `.part` file when the render ends.

R-140 also returns `registry: { source: 'built-in' | 'signed', seq, code: 'EM-7111' | null, reason }` (SEC-072): a `models.json` + `models.json.sig` in the models folder is used only after its Ed25519 signature verifies against an embedded manifest public key and its `seq` is not older than the last accepted one; otherwise the built-in registry is used and `code` is `EM-7111`.

With an Operator model CDN in the build (LOCAL_AI_MODELS §4.5) R-140 first checks `<cdn>/models.json` + `.sig` when the last answered check is older than 24 h (a network failure is retried after 15 min; at most 10 s), and returns `registryUpdate: { cdn: string | null, checkedAt: string | null, outcome: 'updated' | 'unchanged' | 'refused' | 'failed' | 'skipped' | null, code: 'EM-7111' | 'EM-8201' | 'EM-8202' | 'EM-8203' | null, reason: string | null, seq: number | null }` (`reason: 'no-cdn'` in development builds). A refused or failed check never replaces the accepted list.

**R-147 `POST /models/registry/refresh`** — the same check without the 24 h interval (Model Manager Refresh). Response `{ registry, registryUpdate }` as in R-140; never fails because of the CDN (the outcome is in `registryUpdate`; Private Mode → `outcome: 'skipped', code: 'EM-8202'`, no request made).

**R-146 `POST /models/engines/:engine/reveal`** (FR-126) — response `{ path }`: the absolute `<models>\<engine>\` folder (created if missing) for the Shell's `openFolder`; the Editor shows `EM-8303` with the path when the Shell cannot open it. Errors: `404 EM-9003` unknown engine.

**R-144 `DELETE /models/:key`** — removes weights and partials. Response `204`. Errors: `409 EM-7104` in use.

### 6.15 Hardware

**R-150 `GET /hardware/profile`** — response `HardwareProfileDto` (cached from startup; `systeminformation`). **R-151 `POST /hardware/profile/refresh`** — re-detects (rate-limited to once per 30 s; `429 EM-9005` otherwise). Response `HardwareProfileDto`. Events: `settings.changed {scope:'hardware'}` when the tier changes.

**R-152 `GET /hardware/live`** — the latest cheap-meter sample. Response `HardwareTickDto`. The Hardware Monitor popover uses `hardware.tick` over SSE while open and this route for its first paint.

FR-128: the hardware module checks the data drive with one `statfs` call ~10 s after start, then every 60 s and on every tick; below 2 GB free it emits `service.notice {kind:'low-disk', code:'EM-6402', freeBytes, have}` **once per session**. FR-129: `HardwareProfileDto.warnings` carries `EM-3402` for T0 and `EM-8305` below 8 GB RAM; the Editor shows each once per install.

### 6.16 Licence

**R-160 `GET /license`** — open while not licensed (§2.3a). Response `LicenseDto` (`machineCode` is the Creator-facing short form of the Machine Fingerprint the Operator binds the key to, LICENSE_OPERATIONS.md).

**R-161 `POST /license/activate`** — open while not licensed (§2.3a). Body `{ key: z.string().min(40).max(4096) }`. Offline Ed25519 verification, fingerprint match (constant-time), revocation list, `updatesUntil` vs build date, clock check. Response `LicenseDto` with `status:'licensed'`; the gate opens immediately. Errors (`422`, `details.status` = the state the key would give): `EM-5006` format, `EM-5002` signature, `EM-5009` unknown key id, `EM-5003` other machine (`machine-mismatch`), `EM-5004` revoked, `EM-5005` the build postdates `updatesUntil` (`details.date`; key not stored). A rejected key is never stored. Rate limit: 5 failed attempts within 60 s → `429 EM-5011` with `Retry-After` and `details.retryAfterSeconds`; each further lockout doubles (60 s, 120 s, … up to 1 h); a success resets it. Events: `license.changed`.

**R-162 `POST /license/deactivate`** — body `{ confirm: true }`. Removes the stored key; the state becomes `unlicensed` and the §2.3a gate closes again. Response `LicenseDto`. Events: `license.changed`.

### 6.17 Settings

**R-170 `GET /settings`** — response `SettingsDto`.

**R-171 `PUT /settings`** — body `SettingsDto.partial()`. Turning `privateMode` on aborts in-flight provider calls and model downloads (`EM-8202` notices) and emits `settings.changed {scope:'privateMode', privateMode:true}` to every client; `outputFolder` is canonicalised and checked (`403 EM-8302`). Response `SettingsDto`. Events: `settings.changed`.

**R-172 `POST /settings/caches/clear`** — body `{ scope: z.array(z.enum(['proxies','thumbs','stills','filmstrips','waveforms'])).default(['proxies','thumbs','stills','filmstrips','waveforms']) }`. Regenerable files only; assets keep `status:'ready'` and variants are rebuilt lazily. Response `{ freedBytes }`. Errors: `409 EM-2309` while rendering.

### 6.18 Diagnostics

**R-180 `POST /diagnostics/bundle`** — body `{ includeStructure: z.boolean().default(false) }`. Builds the zip described in TRD.md TR-103 into `logs\diagnostics-<ts>.zip`. Response `{ path, bytes, contents: string[] }`. Errors: `500 EM-9006`.

**R-181 `GET /diagnostics/logs?lines=200&level=warn`** — response `{ lines: string[] }` (JSON lines, redacted, max 2000).

**R-182 `GET /diagnostics/codes?limit=50`** (FR-150) — response `{ items: Array<{ at: Iso, code: EmCode, source: 'render'|'generator'|'agent'|'log', ref: Id | null }> }`, newest first, de-duplicated by code + ref: failed Render Jobs, generator jobs and agent runs plus coded lines of the last two log files. Never message text or content.

## 7. Server-Sent Events

### 7.1 Streams

| Stream | Route | Scope |
|---|---|---|
| Global | `GET /api/v1/events?token=…&projectId=<id>` | every event; `projectId` filters project-scoped events to one project (global events always pass) |
| Per render job | `GET /api/v1/renders/:jobId/events?token=…` | `render.*` for one job; closes after the final event |

### 7.2 Wire format

```
retry: 2000

id: 419
event: render.progress
data: {"seq":419,"at":"2026-10-24T03:05:12.410Z","projectId":"01JAZK…","jobId":"01JAZR…J","progress":0.42,"renderedFrames":170,"totalFrames":405,"etaMs":31000}

: ping
```

| Rule | Detail |
|---|---|
| Headers | `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no` (ported `openSse`) |
| `retry: 2000` | first line of every stream; the browser waits 2 s before reconnecting |
| Heartbeat | `: ping` comment every 15 s; the Editor treats 35 s of silence as a dead connection and reconnects (`sys.offline` after the third failure, UX-032) |
| `seq` | one monotonic counter per Service lifetime, shared by both streams; sent as the SSE `id:` and inside `data.seq`; resets to 1 when the Service restarts (clients detect `seq < lastSeen` and do a full refresh via R-016) |
| Replay | on reconnect the browser sends `Last-Event-ID`; the Service replays events with `seq > lastEventId` from a 500-event ring buffer (filtered by `projectId` when given); if the gap exceeds the buffer, the first event is `service.notice {kind:'resync', from, to}` and the client reloads state with R-016 and R-112 |
| Dedupe | clients keep `lastSeq` and drop any event with `seq ≤ lastSeq` |
| Payload envelope | every `data` has `seq`, `at`, and `projectId` when project-scoped; event-specific fields follow |
| Ordering | events for one project are emitted in causal order (`intent.updated` before `composition.updated` before `plan.*`) |
| Size | payloads ≤ 64 KB; `composition.updated` carries the version header and diff, never the model (clients fetch R-050) |

### 7.3 Event table

| Event | Payload (besides `seq`, `at`, `projectId?`) | When emitted |
|---|---|---|
| `intent.updated` | `{ queue: IntentQueueDto, changed: Id[], reason: 'created'|'superseded'|'restored'|'removed'|'cleared'|'compiled'|'executed'|'rejected' }` | any change to the Intent Queue (R-060…R-064, R-082, Insert, Execute) |
| `plan.ready` | `{ plan: PlanDto (without ops), runId?: Id }` | a plan reached `valid` (compile or agent) or changed status to `executing|executed` |
| `plan.invalid` | `{ planId, status: 'invalid'|'stale'|'failed'|'cancelled', code: 'EM-2301'|'EM-2302'|'EM-2303'|'EM-2304'|'EM-4301'|'EM-4303'|'EM-4304' or the provider code that ended the run (EM-41xx, EM-4201, EM-8202), validation: Issue[], touchesLockedKeys: string[] }` | validation failed, base moved, run failed or cancelled |
| `composition.updated` | `{ version: VersionDto (no model), previousHash, diff: ExecutionResult.diff, cause, canUndo, canRedo, durationMs, issues: Issue[] }` | a new head version exists (Insert, Compile, Execute, undo, redo, restore, settings, asset removal) |
| `render.queued` | `{ job: RenderJobDto }` | R-111 accepted |
| `render.progress` | `{ jobId, progress, renderedFrames, totalFrames, etaMs: number|null, stage: 'preparing'|'rendering'|'encoding'|'validating' }` | ≤ 4× per second per job (ported 250 ms throttle); `etaMs` null until ≥ 5 % and 3 samples |
| `render.done` | `{ jobId, output: OutputDto, notices: string[] }` | ffprobe validation passed, row written |
| `render.failed` | `{ jobId, code: 'EM-3201'|'EM-3203'|'EM-3204'|'EM-3205'|'EM-3207'|'EM-3002', percent, frame: number | null }` (`frame` = FR-143 failure frame, as `RenderJobDto.failedFrame`) | job failed; partial file removed (kept under `_failed\` for EM-3205) |
| `render.cancelled` | `{ jobId, percent }` | R-114 or shutdown |
| `ingest.progress` | `{ assetId, stage: 'probe'|'transcode'|'proxy'|'thumbs'|'filmstrip'|'waveform'|'hash'|'paused', progress }` | per asset, ≤ 4× per second; `paused` once when the job waits for a Standard/Accelerated render (FR-042) |
| `ingest.done` | `{ asset: AssetDto }` | asset `ready`; `media.*` URLs populated |
| `ingest.failed` | `{ assetId, code: 'EM-1001'|'EM-1003'|'EM-1004'|'EM-1005'|'EM-1006'|'EM-1008'|'EM-1009'|'EM-1201', name, existingAssetId? }` | ingest error (`EM-1005` leaves the asset `ready` with a missing variant; `EM-1006` = same content already in the project: the row is dropped and the Editor removes the card and shows a toast) |
| `agent.run.started` | `{ run: AgentRunDto, agent, modelId, planId? }` | R-070 (agent mode), R-081 |
| `agent.run.delta` | `{ runId, agent, delta: string, toolCall?: { name, input } }` | streamed assistant text or a tool call (for "Asking <model>…" and transparency, UX-016) |
| `agent.run.done` | `{ run: AgentRunDto, message: MessageDto, usage, contextUsage: { usedTokens, contextLength } }` | provider stream finished and output validated |
| `agent.run.failed` | `{ runId, agent, code: 'EM-4101'|'EM-4102'|'EM-4103'|'EM-4104'|'EM-4301'|'EM-4303'|'EM-4304'|'EM-4201'|'EM-8202', retryable: boolean }` | run failed, cancelled or interrupted |
| `model.progress` | `{ key, bytesDone, bytesTotal, status: 'downloading'|'verifying' }` | ≤ 2× per second |
| `model.installed` | `{ model: ModelStateDto }` | hash verified, manifest written |
| `model.failed` | `{ key, code: 'EM-7002'|'EM-7003'|'EM-7004'|'EM-7108' }` | download or verification failed |
| `hardware.tick` | `HardwareTickDto` | every 2 s **only while at least one client subscribed with `?hardware=1`** (the Hardware Monitor popover); otherwise suppressed to save bandwidth |
| `license.changed` | `{ licence: LicenseDto }` | R-161, R-162, revocation detected at startup |
| `settings.changed` | `{ scope: 'settings'|'privateMode'|'providers'|'assignments'|'budget'|'hardware', settings?: SettingsDto, privateMode?: boolean }` | any settings/provider mutation; Private Mode changes always include `privateMode` |
| `service.notice` | `{ kind: 'shutting-down'|'resync'|'backup'|'restore'|'generator'|'update'|'offline'|'low-disk'|'low-memory'|'checkpoint'|'sample'|'media-missing'|'media-changed'|'assets-restored', code?: string, …kind-specific }` | lifecycle and cross-cutting notices: `EM-8003` after restart, `EM-6402` low disk, `EM-8305` low memory, `EM-8105` update available, backup/restore/generator job progress (`{jobId, percent, done, projectId}`), autosave status (`EM-6203`), Sample Project prepared (`{projectId, ready}`, R-025), media check on open and before render (FR-048: `media-missing {projectId, code:'EM-1301', assetIds}`, `media-changed {projectId, code:'EM-1302', assetId, name}` when a changed original is re-ingested in place), removed assets back in use after Undo/Redo (FR-052: `assets-restored {projectId, assetIds}`) |

`hardware.tick` subscription: `GET /events?token=…&hardware=1`; a client without the flag never receives ticks. All other events are always delivered (subject to `projectId` filtering).

### 7.4 Client reconnection algorithm (reference for `apps/ui/src/api/events.ts`)

1. Open `EventSource(base + '/events?token=' + token + (projectId ? '&projectId=' + projectId : ''))`; store `lastSeq` in memory (and `sessionStorage` for a reload).
2. On each event: if `data.seq <= lastSeq` → drop; else dispatch and set `lastSeq`.
3. On `error`: the browser auto-reconnects after `retry` (2 s) sending `Last-Event-ID`; count attempts; after 3 consecutive failures within 30 s show `sys.offline` (`EM-8001`) and poll `GET /health` every 2 s (no token needed) until `status:'ok'`.
4. On reconnect: if the first event is `service.notice {kind:'resync'}` or `health.seq < lastSeq` (Service restarted) → call R-016 for the open project and R-112 for jobs, then continue.
5. On `settings.changed {scope:'privateMode'}` or `license.changed` → update global state immediately (banner, composer state; a licence state other than `licensed` shows the licence screen).

## 8. Examples of composed flows

| Flow | Calls (in order) | Events observed |
|---|---|---|
| F1 First project to first export (P0 slice, BLUEPRINT.md §7) | R-011 → R-030 → R-035 ×2 → R-060 (fade) → R-110 → R-111 | `composition.updated`, `ingest.progress/done`, `composition.updated` ×2, `intent.updated` + `composition.updated` + `plan.ready`, `render.queued` → `render.progress`… → `render.done` |
| F2 Chat-driven title | R-081 (editor, text) → (wait) → R-072 → R-073 | `agent.run.started/delta/done`, `plan.ready`, `composition.updated`, `intent.updated` |
| F3 Brainstorm hand-off | R-081 (brainstorm) → R-082 → R-070 → R-073 | `agent.run.*`, `intent.updated`, `agent.run.*`, `plan.ready`, `composition.updated` |
| F4 Stale plan | R-070 → R-053 (undo) → R-073 | `plan.ready`, `composition.updated` + `plan.invalid {EM-2301}`, then `409 EM-2301` |
| F5 Private Mode on | R-171 `{privateMode:true}` → R-081 | `settings.changed {privateMode:true}`; R-081 → `423 EM-4401` |
| F6 Crash during render | (Service restarts) → R-016 → R-112 | `service.notice {EM-8003}`, job `failed EM-3203` in the list |

## 9. Open points

| # | Point | Owner | Resolve by |
|---|---|---|---|
| 1 | Preview grant lifetime: a sliding 12 h TTL vs. explicit revocation on project close (would need a `POST /projects/:id/close` route); the TTL is simpler and the Editor transparently re-issues via R-042 | Security reviewer | Stage 3 (SECURITY.md) |
| 2 | Generator events as `service.notice {kind:'generator'}` vs dedicated `generator.*` events; dedicated events are cleaner but widen the closed table before P1 | Local Service lead | Stage 5 |
| 3 | `GET /catalogue` from the Service vs the Editor importing the registry directly and asking only for availability; the former keeps one source of truth across processes | Principal architect | Stage 3 |
| 4 | Multipart upload limits in browser development vs the Shell path hand-off; multipart may be removed entirely once the Electron e2e harness exists | Service lead | Stage 4 |
