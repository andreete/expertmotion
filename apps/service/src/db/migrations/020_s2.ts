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
];
