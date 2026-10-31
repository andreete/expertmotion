// Migrations owned by S2 (assets, media, renders, outputs, generators, models): versions 20-29. Append { version, name, sql } entries; never edit an applied one.
import type { Migration } from './types.js';
export const migrations: Migration[] = [
  {
    version: 20,
    name: 's2_render_failed_frame',
    // FR-143: a failed, stalled or interrupted Render Job records the frame it stopped at (from the renderer error, else the last
    // progress report) so the failure dialog can show it. NULL = unknown (failed before the first frame, or never started).
    sql: `
ALTER TABLE render_jobs ADD COLUMN failed_frame INTEGER CHECK(failed_frame IS NULL OR failed_frame >= 0);
`,
  },
  {
    version: 21,
    name: 's2_asset_soft_delete_source_key',
    // FR-052: Remove Asset soft-deletes the row (`deleted_at`) and keeps its media while any Composition Version still references
    // it, so Undo restores the removed Clips with playable media; unreferenced removed assets are purged later.
    // FR-041: `source_key` = sha256(canonical source path, size, mtime) of a path import, so importing the same file again is
    // recognised before it is copied (EM-1006, no new card). It is a digest, never the path itself.
    sql: `
ALTER TABLE assets ADD COLUMN deleted_at TEXT;
ALTER TABLE assets ADD COLUMN source_key TEXT;
CREATE INDEX IF NOT EXISTS idx_assets_source_key ON assets(project_id, source_key) WHERE source_key IS NOT NULL;
`,
  },
  {
    version: 22,
    name: 's2_voice_keys_transcripts',
    // FR-246: the ElevenLabs key (AES-256-GCM sealed like provider keys, label 'voice-secrets'; only the hint is ever returned).
    // FR-249: the timed transcript of every generated voice clip (built from the known script; JSON + SubRip), one per Asset.
    sql: `
CREATE TABLE IF NOT EXISTS voice_keys (
  provider     TEXT PRIMARY KEY CHECK(provider IN ('elevenlabs')),
  secret_enc   BLOB NOT NULL,
  secret_hint  TEXT NOT NULL,
  created_at   TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_transcripts (
  asset_id     TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  voice_id     TEXT NOT NULL,
  method       TEXT NOT NULL CHECK(method IN ('engine','aligned','proportional','srt')),
  json         TEXT NOT NULL CHECK(json_valid(json)),
  srt          TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_transcripts_project ON voice_transcripts(project_id);
`,
  },
  {
    version: 23,
    name: 's2_voice_keys_azure_google',
    // FR-269: voice-only keys for Azure AI Speech ("<region>|<key>") and Google Cloud Text-to-Speech besides ElevenLabs (the CHECK
    // list grows, so the table is rebuilt; rows are kept).
    sql: `
CREATE TABLE voice_keys_new (
  provider     TEXT PRIMARY KEY CHECK(provider IN ('elevenlabs','azure','google-cloud')),
  secret_enc   BLOB NOT NULL,
  secret_hint  TEXT NOT NULL,
  created_at   TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO voice_keys_new (provider, secret_enc, secret_hint, created_at, updated_at) SELECT provider, secret_enc, secret_hint, created_at, updated_at FROM voice_keys;
DROP TABLE voice_keys;
ALTER TABLE voice_keys_new RENAME TO voice_keys;
`,
  },
  {
    version: 24,
    name: 's2_footage_prep',
    // FR-285 … FR-289 (Reels production pipeline): the footage prep generator (`kind = 'prep'`, a job that may stop at
    // `needs-input` for the rotation confirmation) and the stored FootageAnalysis per project. SQLite cannot alter a CHECK, so
    // generator_jobs is rebuilt (rows kept).
    sql: `
CREATE TABLE generator_jobs_new (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK(kind IN ('voice','music','thumbnail','captions','hashtags','prep')),
  input_json     TEXT NOT NULL CHECK(json_valid(input_json)),
  model_key      TEXT,
  status         TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled','needs-input')),
  progress       REAL NOT NULL DEFAULT 0,
  result_asset_id TEXT REFERENCES assets(id),
  result_json    TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code     TEXT,
  created_at     TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
INSERT INTO generator_jobs_new (id, project_id, kind, input_json, model_key, status, progress, result_asset_id, result_json, error_code, created_at, started_at, finished_at)
  SELECT id, project_id, kind, input_json, model_key, status, progress, result_asset_id, result_json, error_code, created_at, started_at, finished_at FROM generator_jobs;
DROP TABLE generator_jobs;
ALTER TABLE generator_jobs_new RENAME TO generator_jobs;
CREATE INDEX IF NOT EXISTS idx_generator_jobs_project ON generator_jobs(project_id, created_at);
CREATE TABLE IF NOT EXISTS footage_analyses (               -- FootageAnalysis JSON (packages/models analysis types) per prep job
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  voice_asset_id TEXT NOT NULL REFERENCES assets(id),
  camera_asset_id TEXT REFERENCES assets(id),
  master_asset_id TEXT REFERENCES assets(id),
  json           TEXT NOT NULL CHECK(json_valid(json)),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_footage_analyses_project ON footage_analyses(project_id, created_at);
`,
  },
];
