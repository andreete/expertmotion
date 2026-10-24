// All migrations in version order. Bundled as code (no filesystem reads) so the packaged service is one file.
import type { Migration } from './types.js';
import init from './001_init.js';
import { migrations as s1 } from './010_s1.js';
import { migrations as s2 } from './020_s2.js';
import { migrations as s3 } from './030_s3.js';

export type { Migration };
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'init', sql: init }, ...s1, ...s2, ...s3].sort((a, b) => a.version - b.version);
