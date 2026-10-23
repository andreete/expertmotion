// POC-005 shared DB layer: encrypted SQLite (ChaCha20-Poly1305), WAL, subset of docs/DATABASE_SCHEMA.md. Throwaway.
import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  head_version_id TEXT REFERENCES composition_versions(id), language TEXT NOT NULL DEFAULT 'id' CHECK(language IN ('id','en')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, opened_at TEXT, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS composition_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES composition_versions(id), hash TEXT NOT NULL, model_json TEXT NOT NULL CHECK(json_valid(model_json)),
  cause TEXT NOT NULL CHECK(cause IN ('insert','compile','execute','undo','redo','restore','system')), plan_id TEXT, duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_hash ON composition_versions(project_id, hash);
CREATE TABLE IF NOT EXISTS edit_plans (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_version_id TEXT NOT NULL REFERENCES composition_versions(id), origin TEXT NOT NULL CHECK(origin IN ('compile','editor-agent')),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), status TEXT NOT NULL, agent_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations_history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES composition_versions(id), plan_id TEXT REFERENCES edit_plans(id), intent_id TEXT, seq INTEGER NOT NULL,
  op_json TEXT NOT NULL CHECK(json_valid(op_json)), applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS render_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES composition_versions(id), output_profile_json TEXT NOT NULL CHECK(json_valid(output_profile_json)),
  performance_profile TEXT NOT NULL CHECK(performance_profile IN ('standard','accelerated','turbo')),
  status TEXT NOT NULL CHECK(status IN ('queued','rendering','done','failed','cancelled')), progress REAL NOT NULL DEFAULT 0,
  output_path TEXT, error_code TEXT, error_detail TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE TABLE IF NOT EXISTS recovery_checkpoints (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL, file_path TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('autosave','pre-execute','pre-render','manual')), created_at TEXT NOT NULL);
`;

export const now = () => new Date().toISOString();
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const canon = (o) => JSON.stringify(o, Object.keys(o).sort());

export function keyFor(dir) {                       // POC only: the product wraps the key with DPAPI (ADR-006)
  const f = path.join(dir, 'key.hex');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
export function openDb(file, keyHex) {
  const db = new Database(file);
  db.pragma("cipher='chacha20'");
  db.pragma(`key="x'${keyHex}'"`);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.prepare('SELECT count(*) FROM sqlite_master').get();           // throws SQLITE_NOTADB on wrong key / corruption
  return db;
}
export function migrate(db) {
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (1,?,?)').run('init', now());
}

// Open with the recovery ladder from docs/DATABASE_SCHEMA.md §7: main → .bak → fresh DB + newest checkpoint import.
export function openWithRecovery(dir) {
  const file = path.join(dir, 'expertmotion.db'), bak = file + '.bak-1', key = keyFor(dir);
  try { const db = openDb(file, key); return { db, path: 'main' }; } catch (e1) {
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext + '.corrupt', { force: true });
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(file + ext)) fs.renameSync(file + ext, file + ext + '.corrupt');
    if (fs.existsSync(bak)) {
      try { fs.copyFileSync(bak, file); const db = openDb(file, key); return { db, path: 'bak', cause: String(e1.code ?? e1.message) }; } catch { fs.rmSync(file, { force: true }); }
    }
    const db = openDb(file, key); migrate(db);
    const ck = path.join(dir, 'checkpoints');
    const files = fs.existsSync(ck) ? fs.readdirSync(ck).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: fs.statSync(path.join(ck, f)).mtimeMs })).sort((a, b) => b.t - a.t) : [];
    let imported = 0;
    for (const { f } of files.slice(0, 1)) {
      const c = JSON.parse(fs.readFileSync(path.join(ck, f), 'utf8'));
      db.transaction(() => {
        db.prepare('INSERT OR REPLACE INTO projects(id,name,settings_json,head_version_id,created_at,updated_at) VALUES (?,?,?,NULL,?,?)').run(c.projectId, 'Recovered', '{}', now(), now());
        db.prepare('INSERT INTO composition_versions(id,project_id,parent_id,hash,model_json,cause,duration_ms,created_at) VALUES (?,?,NULL,?,?,?,?,?)').run(c.versionId, c.projectId, sha(canon(c.model)), JSON.stringify(c.model), 'restore', c.model.durationMs ?? 0, now());
        db.prepare('UPDATE projects SET head_version_id=? WHERE id=?').run(c.versionId, c.projectId);
      })(); imported++;
    }
    return { db, path: imported ? 'checkpoint-import' : 'fresh', cause: String(e1.code ?? e1.message), imported };
  }
}

// Startup sweep: interrupted renders → failed (EM-3203) and partial output removed (docs/DATABASE_SCHEMA.md §7).
export function sweepInterrupted(db) {
  const rows = db.prepare("SELECT id, output_path FROM render_jobs WHERE status='rendering'").all();
  for (const r of rows) {
    if (r.output_path) fs.rmSync(r.output_path, { force: true });
    db.prepare("UPDATE render_jobs SET status='failed', error_code='EM-3203', finished_at=? WHERE id=?").run(now(), r.id);
  }
  return rows.length;
}
export function writeCheckpoint(db, dir, projectId, versionId, model, reason = 'autosave') {
  const ck = path.join(dir, 'checkpoints'); fs.mkdirSync(ck, { recursive: true });
  const name = `${Date.now()}-${sha(canon(model)).slice(0, 12)}.json`, final = path.join(ck, name), tmp = final + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ projectId, versionId, model, at: now() })); fs.renameSync(tmp, final);   // atomic
  db.prepare('INSERT INTO recovery_checkpoints VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), projectId, versionId, final, reason, now());
  const all = fs.readdirSync(ck).filter((f) => f.endsWith('.json')).sort();       // keep newest 20
  for (const f of all.slice(0, Math.max(0, all.length - 20))) fs.rmSync(path.join(ck, f));
  return final;
}
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
