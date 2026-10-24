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
];
