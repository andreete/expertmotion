// Migrations owned by S3 (providers, conversations, usage, settings, hardware, licence, diagnostics): versions 30-39. Append { version, name, sql } entries; never edit an applied one.
import type { Migration } from './types.js';
export const migrations: Migration[] = [
  { version: 30, name: 's3_budgets_defaults_handoffs', sql: `
CREATE TABLE IF NOT EXISTS project_budgets (                -- per-project AI budget (FR-117); monthly cap, NULL = no limit
  project_id     TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  limit_usd      REAL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_defaults (              -- R-097 defaultConnectionId
  id             INTEGER PRIMARY KEY CHECK(id = 1),
  default_connection_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS brainstorm_handoffs (            -- R-082 payloads (kept until the intents module enqueues them)
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  intents_json   TEXT NOT NULL CHECK(json_valid(intents_json)),   -- EditIntent[] (AI_WORKFLOW §3), source 'brainstorm'
  status         TEXT NOT NULL CHECK(status IN ('pending','enqueued')),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_project ON brainstorm_handoffs(project_id, status, created_at);
ALTER TABLE agent_runs ADD COLUMN plan_id TEXT;              -- AgentRunDto.planId (editor runs)
CREATE INDEX IF NOT EXISTS idx_runs_project_agent ON agent_runs(project_id, agent, status);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_records(agent_run_id);
` },
  { version: 31, name: 's3_project_connection_budgets', sql: `
CREATE TABLE IF NOT EXISTS project_connection_budgets (     -- FR-117: per-project cap per Provider Connection (calendar month, NULL = no limit)
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connection_id  TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  limit_usd      REAL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_project_conn ON agent_runs(project_id, connection_id);
-- existing project-wide caps become the same cap on every connection (FRD shape); the project-wide row stays for R-100 without connectionId
INSERT OR IGNORE INTO project_connection_budgets(project_id, connection_id, limit_usd, updated_at)
  SELECT b.project_id, c.id, b.limit_usd, b.updated_at FROM project_budgets b CROSS JOIN provider_connections c WHERE b.limit_usd IS NOT NULL AND b.limit_usd > 0;
UPDATE project_budgets SET limit_usd = NULL WHERE limit_usd IS NOT NULL;
` },
  // Trial Mode removed (Operator decision 2026-10-25): licence states become licensed / unlicensed / invalid / revoked /
  // machine-mismatch. SQLite cannot alter a CHECK, so the one-row table is rebuilt; the status is re-derived at every start anyway.
  { version: 32, name: 's3_license_states_no_trial', sql: `
CREATE TABLE license_new (
  id                 INTEGER PRIMARY KEY CHECK(id = 1),
  token_enc          BLOB,                    -- encrypted licence token (NULL = no key: unlicensed)
  status             TEXT NOT NULL CHECK(status IN ('licensed','unlicensed','invalid','revoked','machine-mismatch')),
  tier               TEXT,                    -- payload tier, kept for compatibility; never gates features
  licensee_hash      TEXT,
  updates_until      TEXT,
  last_seen_at       TEXT NOT NULL,           -- clock-tamper reference
  fingerprint_hash   TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
INSERT INTO license_new(id, token_enc, status, tier, licensee_hash, updates_until, last_seen_at, fingerprint_hash, updated_at)
  SELECT id, token_enc, CASE status WHEN 'active' THEN 'licensed' WHEN 'trial' THEN 'unlicensed' WHEN 'updates-expired' THEN 'invalid' ELSE status END,
         tier, licensee_hash, updates_until, last_seen_at, fingerprint_hash, updated_at FROM license;
DROP TABLE license;
ALTER TABLE license_new RENAME TO license;
` },
  // FR-217 / SEC-142: attribution of pictures imported from openly licensed catalogues (Openverse, Wikimedia Commons).
  { version: 33, name: 's3_asset_attributions', sql: `
CREATE TABLE IF NOT EXISTS asset_attributions (
  asset_id     TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK(source IN ('openverse','wikimedia')),
  source_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  creator      TEXT,
  license      TEXT NOT NULL CHECK(license IN ('cc0','pdm','by','by-sa')),
  license_version TEXT,
  license_url  TEXT,
  landing_url  TEXT,
  attribution  TEXT NOT NULL,              -- the line to credit (shown in the Library and exported with the project)
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attr_project ON asset_attributions(project_id);
` },
  // FR-221: documents attached in the chat (PDF / DOCX / TXT / MD / scripts): the extracted text only (the file is not kept), sent to
  // the agent as context. Lives in the encrypted database like the messages.
  { version: 34, name: 's3_chat_documents', sql: `
CREATE TABLE IF NOT EXISTS chat_documents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('pdf','docx','text')),
  bytes       INTEGER NOT NULL,
  chars       INTEGER NOT NULL,
  truncated   INTEGER NOT NULL DEFAULT 0,
  pages       INTEGER,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_docs_project ON chat_documents(project_id, created_at);
` },
  // FR-300 … FR-307 (ADR-041, internet assets): every imported picture / clip / screenshot carries its credit (author, site or URL)
  // and licence text on the asset row (CREDITS.txt reads them; `asset_attributions` keeps the structured CC record of the open
  // catalogues). `research_keys`: the Creator's own Pexels API key, sealed like the voice keys (label 'research-secrets', AAD
  // `research_keys:pexels`); only the hint is ever returned.
  { version: 35, name: 's3_asset_credit_research_keys', sql: `
ALTER TABLE assets ADD COLUMN credit TEXT;
ALTER TABLE assets ADD COLUMN licence TEXT;
CREATE TABLE IF NOT EXISTS research_keys (
  provider     TEXT PRIMARY KEY CHECK(provider IN ('pexels')),
  secret_enc   BLOB NOT NULL,
  secret_hint  TEXT NOT NULL,
  created_at   TEXT NOT NULL, updated_at TEXT NOT NULL
);
` },
];
