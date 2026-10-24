// Migrations owned by S1 (projects, checkpoints, composition, intents, plans): versions 10-19. Append { version, name, sql } entries; never edit an applied one.
import type { Migration } from './types.js';
export const migrations: Migration[] = [
  {
    version: 10,
    name: 's1_versions_plans',
    // 1. DATABASE_SCHEMA §4.5 / API R-053: undo and redo append a version row whose model (and hash) equals an earlier row,
    //    which the UNIQUE (project_id, hash) index of 001 forbids. Replace it with a plain lookup index.
    // 2. edit_plans bookkeeping the EditPlan JSON does not carry: the intents a plan covers, the Creator message, the stored
    //    ExecutionResult (idempotent Execute) and the Idempotency-Key (API §1).
    sql: `
DROP INDEX IF EXISTS idx_versions_hash;
CREATE INDEX IF NOT EXISTS idx_versions_project_hash ON composition_versions(project_id, hash);
ALTER TABLE edit_plans ADD COLUMN intent_ids_json TEXT CHECK(intent_ids_json IS NULL OR json_valid(intent_ids_json));
ALTER TABLE edit_plans ADD COLUMN message TEXT;
ALTER TABLE edit_plans ADD COLUMN result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json));
ALTER TABLE edit_plans ADD COLUMN idempotency_key TEXT;
CREATE INDEX IF NOT EXISTS idx_plans_idem ON edit_plans(project_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_plans_project_status ON edit_plans(project_id, status);
`,
  },
  {
    version: 11,
    name: 's1_sample_project',
    // ONBOARDING_TOUR §2 / API R-025: the tour's Sample Project is flagged so it can be found (idempotent create) and hard-deleted
    // when the Creator creates or opens another project. At most one live sample is kept by the service, not by a constraint.
    sql: `
ALTER TABLE projects ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0 CHECK(is_sample IN (0,1));
CREATE INDEX IF NOT EXISTS idx_projects_sample ON projects(is_sample) WHERE is_sample = 1;
`,
  },
];
