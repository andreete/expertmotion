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
];
