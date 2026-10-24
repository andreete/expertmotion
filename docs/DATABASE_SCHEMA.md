# Database Schema and Composition Model

| Field | Value |
|---|---|
| Status | baseline |
| Owner | Database and security engineer |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-001, 002, 006), ARCHITECTURE.md, AI_WORKFLOW.md, DESIGN_CATALOGUE.md, PERFORMANCE.md |
| Used by | API_SPECIFICATION.md, BLUEPRINT.md, SECURITY.md, TEST_PLAN.md, GOLDEN_SCENARIOS.md |
| Owner of | SQLite DDL, migrations policy, encryption/key wrapping, the Composition Model JSON Schema, checkpoint/backup formats |

## 1. Storage design

| Store | Technology | Content | Why |
|---|---|---|---|
| Relational index | SQLite via `better-sqlite3-multiple-ciphers` (ChaCha20-Poly1305, WAL) at `%APPDATA%\Expertmotion\data\expertmotion.db` | everything listed in §3 except media bytes | single file, transactional, encrypted, zero admin |
| Media | filesystem `%APPDATA%\Expertmotion\media\<projectId>\<assetId>\` | originals, transcodes, proxies, thumbnails, waveforms | large files do not belong in the DB (brief §11) |
| Outputs | `%APPDATA%\Expertmotion\outputs\<projectId>\` | rendered files + thumbs | same |
| Checkpoints | `%APPDATA%\Expertmotion\data\checkpoints\<projectId>\<versionHash>.json` | Composition Model snapshots (also stored in DB; files are the crash-recovery fallback) | recoverable even if the DB is locked |
| Models | `%APPDATA%\Expertmotion\models\` | weights + manifests | see LOCAL_AI_MODELS.md |
| Secrets | DB fields encrypted with a per-install data key; Database Key wrapped by Electron `safeStorage` (DPAPI) in `data\keyring.bin` | provider credentials, licence token | key never beside the data (ADR-006) |

Encryption: on first run the Local Service generates a random 256-bit Database Key, asks the Desktop Shell to wrap it (`safeStorage.encryptString`), and stores only the wrapped blob. Each start: unwrap → `PRAGMA key = "x'<hex>'"`; `PRAGMA cipher = 'chacha20'`. Provider keys are additionally encrypted field-level with AES-256-GCM using a key derived (HKDF) from the Database Key with the label `provider-secrets`, so a leaked DB page cache still does not expose keys. Backup zips are encrypted with a Creator passphrase (Argon2id) by default.

Boundary (stated in every Creator-facing place that mentions encryption): the device owner or an administrator can recover the key; encryption protects against other users, stolen disks and out-of-session malware.

## 2. Conventions

- IDs: ULID strings (`01J...`), prefixed in logs by table for readability (`prj_`, `ast_`, `ver_`…). Prefixes are not stored.
- Timestamps: ISO-8601 UTC strings; durations in integer milliseconds.
- JSON columns are TEXT validated by Zod before write; `CHECK(json_valid(col))` on every JSON column.
- Foreign keys ON (`PRAGMA foreign_keys = ON`); cascading deletes only from `projects`.
- Soft delete for projects (`deleted_at`) with a 30-day purge; hard delete elsewhere.
- Every write that changes the Composition Model happens in one transaction together with its `composition_versions` row, `operations_history` rows and the `projects.head_version_id` update.

## 3. Tables (DDL)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version      INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  applied_at   TEXT NOT NULL
);

CREATE TABLE settings (                       -- app-wide preferences (non-secret)
  key          TEXT PRIMARY KEY,
  value_json   TEXT NOT NULL CHECK(json_valid(value_json)),
  updated_at   TEXT NOT NULL
);

CREATE TABLE license (
  id                 INTEGER PRIMARY KEY CHECK(id = 1),
  token_enc          BLOB,                    -- encrypted licence token (NULL = trial)
  status             TEXT NOT NULL CHECK(status IN ('trial','active','revoked','invalid','updates-expired')),
  tier               TEXT,
  licensee_hash      TEXT,
  updates_until      TEXT,
  last_seen_at       TEXT NOT NULL,           -- clock-tamper reference
  fingerprint_hash   TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE hardware_profiles (
  id             TEXT PRIMARY KEY,
  detected_at    TEXT NOT NULL,
  tier           TEXT NOT NULL CHECK(tier IN ('T0','T1','T2')),
  cpu_model      TEXT, cpu_threads INTEGER, ram_total_mb INTEGER,
  gpu_vendor     TEXT, gpu_model TEXT, vram_mb INTEGER, nvenc INTEGER,
  benchmark_json TEXT CHECK(benchmark_json IS NULL OR json_valid(benchmark_json)),
  is_current     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE provider_connections (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK(provider IN ('openrouter','openai','anthropic','google','custom')),
  label          TEXT NOT NULL,
  base_url       TEXT,                        -- only for 'custom' (https) 
  secret_enc     BLOB NOT NULL,               -- AES-256-GCM(provider key)
  secret_hint    TEXT NOT NULL,               -- last 4 chars for display
  status         TEXT NOT NULL CHECK(status IN ('unvalidated','valid','invalid')),
  validated_at   TEXT,
  models_json    TEXT CHECK(models_json IS NULL OR json_valid(models_json)), -- cached Capability Table rows
  models_fetched_at TEXT,
  budget_month_usd REAL,                      -- NULL = no limit
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE model_assignments (
  agent          TEXT PRIMARY KEY CHECK(agent IN ('brainstorm','editor')),
  connection_id  TEXT NOT NULL REFERENCES provider_connections(id),
  model_id       TEXT NOT NULL,               -- provider model identifier
  settings_json  TEXT NOT NULL CHECK(json_valid(settings_json)), -- temperature, effort, maxTokens
  updated_at     TEXT NOT NULL
);

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  settings_json    TEXT NOT NULL CHECK(json_valid(settings_json)),   -- ProjectSettings (§4.2)
  head_version_id  TEXT,                     -- current Composition Version (FK added after versions table)
  language         TEXT NOT NULL DEFAULT 'id' CHECK(language IN ('id','en')),
  created_at       TEXT NOT NULL, updated_at TEXT NOT NULL, opened_at TEXT, deleted_at TEXT
);

CREATE TABLE assets (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK(kind IN ('video','image','audio','subtitle')),
  name           TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  original_path  TEXT NOT NULL,              -- relative to media root
  playable_path  TEXT,                       -- transcode or original
  proxy_path     TEXT, thumb_path TEXT, filmstrip_path TEXT, waveform_path TEXT,
  probe_json     TEXT CHECK(probe_json IS NULL OR json_valid(probe_json)),
  duration_ms    INTEGER, width INTEGER, height INTEGER, fps REAL, has_audio INTEGER,
  status         TEXT NOT NULL CHECK(status IN ('ingesting','ready','failed')),
  error_code     TEXT,
  sequence_badge INTEGER,                    -- Creator's ordering before Insert (NULL = unordered)
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_assets_project ON assets(project_id, created_at);
CREATE UNIQUE INDEX idx_assets_hash ON assets(project_id, sha256);

CREATE TABLE composition_versions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES composition_versions(id),
  hash           TEXT NOT NULL,              -- sha256 of canonical JSON
  model_json     TEXT NOT NULL CHECK(json_valid(model_json)),   -- Composition Model (§4)
  cause          TEXT NOT NULL CHECK(cause IN ('insert','compile','execute','undo','redo','restore','system')),
  plan_id        TEXT,                       -- when cause = execute/compile
  duration_ms    INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_versions_project ON composition_versions(project_id, created_at);
CREATE UNIQUE INDEX idx_versions_hash ON composition_versions(project_id, hash);

CREATE TABLE edit_intents (                   -- schema: AI_WORKFLOW.md §3 EditIntent
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  intent_json    TEXT NOT NULL CHECK(json_valid(intent_json)),
  status         TEXT NOT NULL,              -- mirrors intent_json.status for indexing
  property_key   TEXT NOT NULL,
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_intents_project_status ON edit_intents(project_id, status, created_at);

CREATE TABLE edit_plans (                     -- schema: AI_WORKFLOW.md §3 EditPlan
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_version_id TEXT NOT NULL REFERENCES composition_versions(id),
  origin         TEXT NOT NULL CHECK(origin IN ('compile','editor-agent')),
  plan_json      TEXT NOT NULL CHECK(json_valid(plan_json)),
  status         TEXT NOT NULL,
  agent_run_id   TEXT,
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_plans_project ON edit_plans(project_id, created_at);

CREATE TABLE operations_history (             -- one row per applied Operation
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id     TEXT NOT NULL REFERENCES composition_versions(id),
  plan_id        TEXT REFERENCES edit_plans(id),
  intent_id      TEXT REFERENCES edit_intents(id),
  seq            INTEGER NOT NULL,
  op_json        TEXT NOT NULL CHECK(json_valid(op_json)),
  applied_at     TEXT NOT NULL
);
CREATE INDEX idx_ops_version ON operations_history(version_id, seq);

CREATE TABLE conversations (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent          TEXT NOT NULL CHECK(agent IN ('brainstorm','editor')),
  summary_json   TEXT CHECK(summary_json IS NULL OR json_valid(summary_json)), -- deterministic thread summary
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_conv_project_agent ON conversations(project_id, agent);

CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  blocks_json    TEXT NOT NULL CHECK(json_valid(blocks_json)),  -- text | tool_call | tool_result | proposed_intents | attachment
  agent_run_id   TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE agent_runs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent          TEXT NOT NULL,
  connection_id  TEXT REFERENCES provider_connections(id),
  model_id       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK(status IN ('running','done','failed','cancelled')),
  error_code     TEXT,
  started_at     TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE usage_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id   TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL,
  provider       TEXT NOT NULL, model_id TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cost_usd       REAL,                        -- NULL when provider does not report and no price table
  approximate    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_usage_project_month ON usage_records(project_id, created_at);

CREATE TABLE render_jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id     TEXT NOT NULL REFERENCES composition_versions(id),
  output_profile_json TEXT NOT NULL CHECK(json_valid(output_profile_json)),  -- ratio, resolution, fps, codec, crf, format
  performance_profile TEXT NOT NULL CHECK(performance_profile IN ('standard','accelerated','turbo')),
  status         TEXT NOT NULL CHECK(status IN ('queued','rendering','done','failed','cancelled')),
  progress       REAL NOT NULL DEFAULT 0,
  rendered_frames INTEGER, total_frames INTEGER, eta_ms INTEGER,
  output_id      TEXT,
  error_code     TEXT, error_detail TEXT,
  created_at     TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX idx_renders_project ON render_jobs(project_id, created_at DESC);

CREATE TABLE outputs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  render_job_id  TEXT NOT NULL REFERENCES render_jobs(id),
  path           TEXT NOT NULL,               -- relative to outputs root
  thumb_path     TEXT,
  kind           TEXT NOT NULL CHECK(kind IN ('video','gif','still','audio')),
  bytes          INTEGER NOT NULL, width INTEGER, height INTEGER, fps REAL, duration_ms INTEGER,
  validated      INTEGER NOT NULL DEFAULT 0,  -- ffprobe check passed
  watermarked    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE generator_jobs (                 -- voice / music / thumbnail / captions (P1/P2)
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK(kind IN ('voice','music','thumbnail','captions','hashtags')),
  input_json     TEXT NOT NULL CHECK(json_valid(input_json)),
  model_key      TEXT,                        -- LOCAL_AI_MODELS registry key or provider model
  status         TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
  progress       REAL NOT NULL DEFAULT 0,
  result_asset_id TEXT REFERENCES assets(id),
  result_json    TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code     TEXT,
  created_at     TEXT NOT NULL, started_at TEXT, finished_at TEXT
);

CREATE TABLE models (                         -- Model Manager state
  key            TEXT PRIMARY KEY,            -- e.g. 'whisper.large-v3-turbo'
  engine         TEXT NOT NULL,
  version        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK(status IN ('not-installed','downloading','verifying','installed','failed')),
  bytes_total    INTEGER, bytes_done INTEGER,
  sha256         TEXT, path TEXT,
  installed_at   TEXT, error_code TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE recovery_checkpoints (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id     TEXT NOT NULL,
  file_path      TEXT NOT NULL,               -- checkpoints/<projectId>/<hash>.json
  reason         TEXT NOT NULL CHECK(reason IN ('autosave','pre-execute','pre-render','manual')),
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_ckpt_project ON recovery_checkpoints(project_id, created_at DESC);

CREATE TABLE audit_log (                      -- security-relevant events, no secrets
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  event          TEXT NOT NULL,               -- 'license.activated','provider.added','privatemode.on','export.started',...
  project_id     TEXT, details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json))
);
```

`projects.head_version_id` references `composition_versions(id)`; SQLite cannot add the FK after the fact, so migration 001 creates `composition_versions` first and `projects` with the FK declared (the DDL above is ordered for reading, not execution).

## 4. Composition Model (JSON Schema, Zod in `packages/composition-model/src/schema.ts`)

### 4.1 Top level

```ts
export const CompositionModel = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string(),
  settings: ProjectSettings,
  theme: Theme,
  tracks: z.object({
    video:   z.array(Clip),                 // ordered; adjacent clips define Cuts
    overlay: z.array(OverlayElement),       // images, shapes, generated stills
    text:    z.array(TextLayer),
    caption: CaptionTrack,                  // style + pages
    audio:   z.array(AudioLayer),
  }),
  transitions: z.array(Transition),         // keyed by cutIndex (0 = between video[0] and video[1])
  background: Background.nullable(),
  durationPolicy: z.enum(['fit-content','fixed']),
  fixedDurationMs: z.number().int().positive().optional(),
});
```

### 4.2 Sub-schemas

```ts
export const ProjectSettings = z.object({
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]),
  ratio: z.enum(['16:9','9:16','1:1','4:5','5:4','4:3','3:4','custom']),
  customRatio: z.object({ w: z.number().int().min(1), h: z.number().int().min(1) }).optional(),
  resolution: z.enum(['720p','1080p','2k','2160p']),
  autoRatio: z.boolean(),
  language: z.enum(['id','en']),
});

export const Theme = z.object({
  paletteId: PresetId,                        // preset:palette.*
  fontPairId: PresetId,                       // preset:fontpair.*
  defaultEasingId: PresetId,                  // preset:easing.* (op:theme.set)
  textDefaults: z.object({ fontFamily: z.string().optional(), fontSize: z.number(), weight: z.number(), colour: Hex, align: z.enum(['left','center','right']), opacity: z.number().min(0).max(1) }), // op:theme.setTextDefaults
});

const Position = z.object({ x: z.number(), y: z.number() });      // in u (layout units), origin centre of frame
const Size = z.object({ w: z.number(), h: z.number() });          // in u
const Timing = z.object({ atMs: z.number().int().min(0), durationMs: z.number().int().min(100) });

export const Clip = z.object({
  id: z.string(), assetId: z.string(),
  trimBeforeMs: z.number().int().min(0), durationMs: z.number().int().min(100),
  playbackRate: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(1).default(1), muted: z.boolean().default(false),
  fadeInMs: z.number().int().min(0).default(0), fadeOutMs: z.number().int().min(0).default(0),
  objectFit: z.enum(['cover','contain']).default('cover'),
  crop: z.object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() }).optional(), // 0..1
  motion: Motion.nullable(),
  effects: z.array(EffectInstance).max(3),
});

export const Transition = z.object({ cutIndex: z.number().int().min(0), presetId: PresetId, durationMs: z.number().int().min(100).max(2000), timing: z.enum(['linear','spring']), params: z.record(z.unknown()).default({}) });

export const Motion = z.object({ presetId: PresetId, durationMs: z.number().int(), delayMs: z.number().int().default(0), easingId: PresetId.optional(), exit: z.boolean().default(true), params: z.record(z.unknown()).default({}) });
export const EffectInstance = z.object({ presetId: PresetId, params: z.record(z.unknown()).default({}), motion: z.enum(['static','in','out']).default('static') });

export const TextLayer = z.object({
  id: z.string(), variantId: PresetId,          // preset:text.*
  text: z.string().min(1).max(500),
  timing: Timing, position: Position, maxWidth: z.number().optional(),
  style: z.object({ fontFamily: z.string().optional(), fontSize: z.number().optional(), weight: z.number().optional(), colour: Hex.optional(), align: z.enum(['left','center','right']).optional(), opacity: z.number().optional() }),
  effect: z.object({ presetId: PresetId, params: z.record(z.unknown()).default({}) }).nullable(),
  motion: Motion.nullable(),
});

export const OverlayElement = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), id: z.string(), assetId: z.string(), timing: Timing, position: Position, size: Size, objectFit: z.enum(['cover','contain']), opacity: z.number(), motion: Motion.nullable(), effects: z.array(EffectInstance).max(3) }),
  z.object({ kind: z.literal('shape'), id: z.string(), presetId: PresetId, timing: Timing, position: Position, size: Size, fill: Hex, stroke: Hex.optional(), strokeWidth: z.number().optional(), params: z.record(z.unknown()).default({}), motion: Motion.nullable() }),
]);

export const CaptionPage = z.object({ text: z.string(), startMs: z.number().int(), durationMs: z.number().int(), tokens: z.array(z.object({ text: z.string(), fromMs: z.number().int(), toMs: z.number().int() })) });
export const CaptionTrack = z.object({ styleId: PresetId.nullable(), params: z.record(z.unknown()).default({}), pages: z.array(CaptionPage), sourceAssetId: z.string().optional(), language: z.enum(['id','en']).optional() });

export const AudioLayer = z.object({
  id: z.string(), assetId: z.string(), role: z.enum(['bed','voice','sfx']),
  atMs: z.number().int().min(0), durationMs: z.number().int().min(100).optional(), // bed: loop to project end
  trimBeforeMs: z.number().int().min(0).default(0), volume: z.number().min(0).max(1), loop: z.boolean().default(false),
  fadeInMs: z.number().int().default(0), fadeOutMs: z.number().int().default(0),
  ducking: z.object({ presetId: PresetId, params: z.record(z.unknown()).default({}) }).nullable(),
});

export const Background = z.object({ presetId: PresetId, params: z.record(z.unknown()).default({}) });
```

### 4.3 Derived values (never stored)

- `durationMs = durationPolicy === 'fixed' ? fixedDurationMs : Σ video[i].durationMs − Σ transitions[j].durationMs` (clamped ≥ 1000). Overlay/text/audio elements beyond the end are clipped at render; the validator warns.
- Frames: `frames(ms) = Math.round(ms / 1000 * fps)`; width/height from the PERFORMANCE.md table.
- Cut positions: `cutStartMs[k] = Σ_{i≤k} video[i].durationMs − Σ_{j≤k} transitions[j].durationMs`.

### 4.4 Invariants checked by `validate(model)`

| Code | Rule | Severity |
|---|---|---|
| CM-001 | every `assetId` exists in `assets` with status `ready` | block |
| CM-002 | `trimBeforeMs + durationMs × playbackRate ≤ asset.duration_ms` for video/audio (a Clip played at rate 2 consumes twice its timeline duration of source media; corrected 2026-10-24 from `÷`) | block |
| CM-003 | `transitions[*].cutIndex < video.length − 1`, unique per cut | block |
| CM-004 | transition `durationMs ≤ 0.5 × min(adjacent clip durations)` | warn → auto-clamp; block if < 100 ms |
| CM-005 | total duration 1 000 … 1 800 000 ms | block |
| CM-006 | ≤ 3 effects per element (≤ 2 on T0) | block |
| CM-007 | preset ids exist in the Design Catalogue, params pass the preset schema, hardware flags satisfied or warned | block / warn |
| CM-008 | text fits: `fitText` result ≥ minimum size (34u) at the current ratio | warn |
| CM-009 | caption pages ordered, non-overlapping, within duration | warn → trim |
| CM-010 | `settings.resolution` allowed for the current Hardware Tier | warn (UI disables higher presets; Export preflight reports EM-3105 and offers the highest allowed preset) |
| CM-011 | ids unique across all elements | block |

### 4.5 Versioning and hashing

Canonical JSON (sorted keys, no whitespace) → sha256 → `composition_versions.hash`. `baseVersion` in plans is this hash. Undo moves `projects.head_version_id` to `parent_id` and records a new version row with `cause = 'undo'` (history is never deleted). Checkpoints: debounced autosave (2 s after the last edit, at most every 5 s while dirty; NFR-020), before Execute, before render, max 20 files per project (oldest pruned).

## 5. Migrations

- Migrations are TypeScript modules in `apps/service/src/db/migrations/` (`001_init.ts` = §3; ranges `010–019` projects/composition/intents, `020–029` assets/renders/models, `030–039` providers/agents/licence) so the bundled service needs no SQL files on disk; each is applied in a transaction at startup; `schema_migrations` records them. Down migrations are not supported; forward-only with a pre-migration backup copy of the DB file (`expertmotion.db.bak-<version>`).
- Composition Model `schemaVersion` migrations are code (`migrateModel(v1 → v2)`) run lazily when a version is loaded; a migrated model gets a new version row with `cause = 'system'`.
- Any schema change requires: ADR note, migration file, Zod update, `migrateModel` step with a golden fixture (old JSON → expected new JSON), test fixture update (DEFINITION_OF_DONE.md D-OP, STAGE_MANAGEMENT.md §9).

### 5.1 Applied migrations

| Version | Name | Adds |
|---|---|---|
| 1 | init | the §3 DDL |
| 10 | s1_versions_plans | replaces the unique index on `composition_versions(project_id, hash)` with a plain index (undo/redo append a row that copies an earlier model, so hashes repeat); `edit_plans` gains `intent_ids_json`, `message`, `result_json`, `idempotency_key`. Note: `projects.head_version_id` is not declared as a foreign key in §3 (circular reference); the service keeps it consistent in the commit transaction |
| 30 | s3_budgets_defaults_handoffs | `project_budgets(project_id, limit_usd, updated_at)` (per-project AI cap per calendar month, NULL or 0 = no limit, FR-117); `provider_defaults(default_connection_id)` (R-097); `brainstorm_handoffs(id, project_id, message_id, intents_json, status pending/enqueued, created_at)` (R-082 payloads until the intents module enqueues them); `agent_runs.plan_id`; indexes on runs and `usage_records` |

Later migrations append rows here.

## 6. Backup, restore, portability

- **Backup** (`hdr.action.backup`): zip containing `project.json` (project row + settings), `versions/*.json` (last 50 versions), `intents.json`, `plans.json`, `media/` (originals only; proxies regenerated), `outputs/` optional, `manifest.json` with hashes. Encrypted with Argon2id-derived key from a passphrase (default) or plain with warning. Provider keys and licence are never included.
- **Restore** (`hdr.action.restore`): validates manifest hashes, imports as a new project (never overwrites), re-runs ingestion for missing derived files.
- **Portability**: the same zip opens on another machine; media paths are relative.

## 7. Crash recovery (brief §11)

| Event | Recovery |
|---|---|
| Service killed during Execute | SQLite transaction rolled back automatically; plan stays `valid`; Editor re-fetches head |
| Service killed during render | on start, `render_jobs` with status `rendering` → `failed` (EM-3xxx "interrupted"), partial file deleted |
| Service killed during agent run | `agent_runs.running` → `cancelled`; message thread shows interruption |
| DB file corrupt | open fails → try `.bak` → else offer checkpoint JSON import into a fresh DB |
| Disk full | writes fail with EM-6xxx; autosave suspended with banner |

## 8. Retention and disk management

- Versions: unlimited rows (small); checkpoints 20 files/project; outputs kept until the Creator deletes; proxies/thumbs regenerable (cache; "Clear caches" in Settings).
- Deleted projects purged after 30 days (`deleted_at`), media removed with them.
- Disk check before ingest/render (PERFORMANCE.md §7); Model Manager shows per-model size and total.

## 9. Example (abbreviated) Composition Model

```json
{
  "schemaVersion": 1, "projectId": "01JAZ…",
  "settings": { "fps": 30, "ratio": "9:16", "resolution": "1080p", "autoRatio": false, "language": "id" },
  "theme": { "paletteId": "preset:palette.editorial-dark", "fontPairId": "preset:fontpair.jakarta-inter", "defaultEasingId": "preset:easing.out-cubic", "textDefaults": { "fontSize": 64, "weight": 700, "colour": "#F4EFE6", "align": "center", "opacity": 1 } },
  "tracks": {
    "video": [
      { "id": "clip1", "assetId": "ast1", "trimBeforeMs": 0, "durationMs": 8000, "playbackRate": 1, "volume": 1, "muted": false, "fadeInMs": 0, "fadeOutMs": 0, "objectFit": "cover", "motion": { "presetId": "preset:motion.zoom-drift", "durationMs": 8000, "delayMs": 0, "exit": false, "params": {} }, "effects": [] },
      { "id": "clip2", "assetId": "ast2", "trimBeforeMs": 2000, "durationMs": 6000, "playbackRate": 1, "volume": 1, "muted": false, "fadeInMs": 0, "fadeOutMs": 0, "objectFit": "cover", "motion": null, "effects": [{ "presetId": "preset:effect.vignette", "params": { "intensity": 0.4 }, "motion": "static" }] }
    ],
    "overlay": [],
    "text": [{ "id": "t1", "variantId": "preset:text.title", "text": "Harga cabai naik lagi", "timing": { "atMs": 300, "durationMs": 3000 }, "position": { "x": 0, "y": -200 }, "style": {}, "effect": { "presetId": "preset:texteffect.highlight", "params": {} }, "motion": { "presetId": "preset:motion.rise", "durationMs": 600, "delayMs": 0, "exit": true, "params": {} } }],
    "caption": { "styleId": "preset:caption.karaoke", "params": {}, "pages": [], "language": "id" },
    "audio": [{ "id": "a1", "assetId": "ast3", "role": "bed", "atMs": 0, "trimBeforeMs": 0, "volume": 0.2, "loop": true, "fadeInMs": 1000, "fadeOutMs": 1000, "ducking": { "presetId": "preset:audio.duck-voice", "params": {} } }]
  },
  "transitions": [{ "cutIndex": 0, "presetId": "preset:transition.fade", "durationMs": 500, "timing": "linear", "params": {} }],
  "background": { "presetId": "preset:background.video-dim", "params": {} },
  "durationPolicy": "fit-content"
}
```
Derived: `durationMs = 8000 + 6000 − 500 = 13 500`; at 30 fps `durationInFrames = 405`; 9:16 1080p → 1080×1920.
