// Encrypted SQLite (ADR-006): ChaCha20-Poly1305 via better-sqlite3-multiple-ciphers, WAL, FK on, busy_timeout 5 s (POC-005).
// Recovery ladder (DATABASE_SCHEMA §7, verified in POC-005): main → newest .bak → fresh DB (checkpoint import is offered by the projects module).
import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import path from 'node:path';
import { EmError } from '@expertmotion/shared';
import { MIGRATIONS, type Migration } from './migrations/index.js';

export type DB = Database.Database;

export function openRaw(file: string, keyHex: string): DB {
  const db = new Database(file);
  db.pragma("cipher='chacha20'");
  db.pragma(`key="x'${keyHex}'"`);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.prepare('SELECT count(*) FROM sqlite_master').get();
  return db;
}

export function listMigrations(list: readonly Migration[] = MIGRATIONS): Migration[] {
  const seen = new Set<number>();
  for (const m of list) { if (seen.has(m.version)) throw new EmError('EM-6003', `Duplicate migration ${m.version}.`); seen.add(m.version); }
  return [...list].sort((a, b) => a.version - b.version);
}

export function migrate(db: DB, file?: string, list: readonly Migration[] = MIGRATIONS): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
  const pending = listMigrations(list).filter((m) => !done.has(m.version));
  if (pending.length && file && fs.existsSync(file)) {        // pre-migration backup copy (DATABASE_SCHEMA §5)
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(file, `${file}.bak-${Math.max(0, ...done)}`);
  }
  const applied: number[] = [];
  for (const m of pending) {
    try {
      db.transaction(() => { db.exec(m.sql); db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(m.version, m.name, new Date().toISOString()); })();
      applied.push(m.version);
    } catch (e) { throw new EmError('EM-6003', `Database update ${m.version} failed.`, { cause: e }); }
  }
  return applied;
}

export function openDatabase(file: string, keyHex: string): { db: DB; openedVia: 'main' | 'bak' | 'fresh'; migrated: number[] } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { const db = openRaw(file, keyHex); return { db, openedVia: 'main', migrated: migrate(db, file) }; } catch (e1) {
    if (e1 instanceof EmError) throw e1;
    const dir = path.dirname(file), base = path.basename(file);
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(file + ext)) fs.renameSync(file + ext, `${file}${ext}.corrupt-${Date.now()}`);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`)).sort((a, b) => Number(b.split('.bak-')[1]) - Number(a.split('.bak-')[1]));
    for (const b of baks) {
      try { fs.copyFileSync(path.join(dir, b), file); const db = openRaw(file, keyHex); return { db, openedVia: 'bak', migrated: migrate(db, file) }; } catch { fs.rmSync(file, { force: true }); }
    }
    const db = openRaw(file, keyHex);
    return { db, openedVia: 'fresh', migrated: migrate(db, file) };
  }
}
