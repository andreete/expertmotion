// Checkpoints and autosave (DATABASE_SCHEMA §1, §4.5, §7; FR-016, FR-165, FR-166, FR-170; NFR-020).
// A checkpoint is the head Composition Model as a JSON file under data/checkpoints/<projectId>/<hash>.json plus a
// recovery_checkpoints row; files are the crash-recovery fallback when the database is lost. Autosave is a debounce:
// 2 s after the last head change, at the latest 5 s after the first unsaved one (settings.autosaveDebounceMs / autosaveMaxMs).
import fs from 'node:fs';
import path from 'node:path';
import { deriveTiming, hashModel, migrateModel, type CompositionModelT } from '@expertmotion/composition-model';
import { EmError } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { checkpointDto, type CheckpointRow, type VersionRow } from './dto.js';
import type { CompositionStore } from './store.js';

export const MAX_CHECKPOINTS = 20;
export const RUNNING_FLAG = '.service-running';
export interface CheckpointFile { format: 'expertmotion-checkpoint'; formatVersion: 1; projectId: string; projectName: string; language: 'id' | 'en'; versionId: string; hash: string; settings: unknown; createdAt: string; model: CompositionModelT }

// ───────────────────────────── debouncer ─────────────────────────────
export interface Timers { now(): number; set(fn: () => void, ms: number): unknown; clear(t: unknown): void }
export const realTimers: Timers = { now: () => Date.now(), set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (t) => clearTimeout(t as NodeJS.Timeout) };

/** Per-key debounce with a maximum delay: fires `debounce` ms after the last touch, but never later than `max` ms after the first. */
export class Debouncer {
  private readonly pending = new Map<string, { first: number; timer: unknown }>();
  constructor(private readonly fire: (key: string) => void, private readonly delays: () => { debounce: number; max: number }, private readonly t: Timers = realTimers) {}
  touch(key: string): void {
    const now = this.t.now(); const { debounce, max } = this.delays();
    const p = this.pending.get(key);
    const first = p?.first ?? now;
    if (p) this.t.clear(p.timer);
    const due = Math.min(now + debounce, first + max);
    const timer = this.t.set(() => { this.pending.delete(key); this.fire(key); }, Math.max(0, due - now));
    this.pending.set(key, { first, timer });
  }
  has(key: string): boolean { return this.pending.has(key); }
  cancel(key: string): void { const p = this.pending.get(key); if (p) { this.t.clear(p.timer); this.pending.delete(key); } }
  /** Fires every pending key now (shutdown). */
  flush(): void { for (const [k, p] of [...this.pending]) { this.t.clear(p.timer); this.pending.delete(k); this.fire(k); } }
  get size(): number { return this.pending.size; }
}

// ───────────────────────────── checkpoints ─────────────────────────────
export class Checkpoints {
  readonly autosave: Debouncer;
  private failures = 0;
  /** Projects whose newest checkpoint is newer than the stored head after an unclean shutdown (R-016 checkpointNewerThanSave). */
  readonly offers = new Map<string, string>();
  /** Start of this Service run: projects changed since then are checked for a missing checkpoint at shutdown (R-002). */
  readonly bootAt: string;
  /** Result of recoverOnStart (R-003 recovery summary). */
  lastRecovery: { unclean: boolean; offered: string[]; imported: string[] } = { unclean: false, offered: [], imported: [] };
  constructor(private readonly ctx: ServiceContext, private readonly store: CompositionStore, timers: Timers = realTimers) {
    this.bootAt = ctx.now();
    this.autosave = new Debouncer((pid) => this.autosaveNow(pid), () => { const s = ctx.settings.get(); return { debounce: s.autosaveDebounceMs, max: Math.max(s.autosaveMaxMs, s.autosaveDebounceMs) }; }, timers);
  }

  private rel(projectId: string, hash: string) { return path.posix.join('checkpoints', projectId, `${hash}.json`); }
  private abs(rel: string) {
    const p = path.resolve(this.ctx.paths.data, rel);
    if (!p.startsWith(path.resolve(this.ctx.paths.checkpoints) + path.sep)) throw new EmError('EM-6201', 'This checkpoint is damaged. Choose an earlier one.', { status: 422 });
    return p;
  }

  private autosaveNow(projectId: string): void {
    try {
      const row = this.ctx.db.prepare('SELECT head_version_id, deleted_at FROM projects WHERE id = ?').get(projectId) as { head_version_id: string | null; deleted_at: string | null } | undefined;
      if (!row || row.deleted_at || !row.head_version_id) return;
      const last = this.ctx.db.prepare('SELECT version_id FROM recovery_checkpoints WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(projectId) as { version_id: string } | undefined;
      if (last?.version_id === row.head_version_id) { this.store.uiDirty.delete(projectId); return; }   // rename only: already persisted
      this.write(projectId, 'autosave');
    } catch (e) {
      this.ctx.log.warn({ projectId, err: String(e) }, 'autosave failed');
    }
  }

  /** Writes the head as a checkpoint (atomic file write + row) and prunes to the newest 20. */
  write(projectId: string, reason: CheckpointRow['reason']): ReturnType<typeof checkpointDto> {
    const h = this.store.head(projectId);
    const p = this.store.projectRow(projectId);
    const v = this.store.versionRow(projectId, h.versionId);
    const now = this.ctx.now();
    const rel = this.rel(projectId, h.hash), file = this.abs(rel);
    const body: CheckpointFile = { format: 'expertmotion-checkpoint', formatVersion: 1, projectId, projectName: p.name, language: p.language, versionId: h.versionId, hash: h.hash, settings: JSON.parse(p.settings_json), createdAt: now, model: h.model };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      this.failures++;
      if (this.failures === 3) this.ctx.bus.emit('service.notice', { at: now, projectId, kind: 'checkpoint', code: 'EM-6203', minutes: 0 });
      const code = (e as NodeJS.ErrnoException).code;
      throw new EmError(code === 'ENOSPC' ? 'EM-6005' : 'EM-6104', code === 'ENOSPC' ? 'The disk is full, so the project could not be saved.' : 'The project could not be saved.', { cause: e, details: { projectId } });
    }
    this.failures = 0;
    const row: CheckpointRow = { id: this.ctx.newId(), project_id: projectId, version_id: h.versionId, file_path: rel, reason, created_at: now };
    this.ctx.db.prepare('INSERT INTO recovery_checkpoints (id, project_id, version_id, file_path, reason, created_at) VALUES (@id, @project_id, @version_id, @file_path, @reason, @created_at)').run(row);
    this.offers.delete(projectId);
    this.store.uiDirty.delete(projectId);                                 // FR-173: Save / autosave clears the dirty dot
    this.prune(projectId);
    return checkpointDto(row, v.duration_ms, this.fileMeta(row));
  }
  private fileMeta(r: CheckpointRow): { bytes: number } {
    try { return { bytes: fs.statSync(this.abs(r.file_path)).size }; } catch { return { bytes: 0 }; }
  }

  private prune(projectId: string): void {
    const old = this.ctx.db.prepare(`SELECT * FROM recovery_checkpoints WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ${MAX_CHECKPOINTS}`).all(projectId) as CheckpointRow[];
    if (!old.length) return;
    const del = this.ctx.db.prepare('DELETE FROM recovery_checkpoints WHERE id = ?');
    this.ctx.db.transaction(() => { for (const r of old) del.run(r.id); })();
    const still = this.ctx.db.prepare('SELECT 1 FROM recovery_checkpoints WHERE project_id = ? AND file_path = ? LIMIT 1');
    for (const r of old) if (!still.get(projectId, r.file_path)) { try { fs.rmSync(this.abs(r.file_path), { force: true }); } catch { /* ignore */ } }
  }

  /** FR-175 housekeeping at start: keep the newest 20 rows and remove checkpoint files no row references any more. */
  private pruneAtStart(projectId: string): void {
    try {
      this.prune(projectId);
      const dir = path.join(this.ctx.paths.checkpoints, projectId);
      const referenced = new Set((this.ctx.db.prepare('SELECT file_path FROM recovery_checkpoints WHERE project_id = ?').all(projectId) as Array<{ file_path: string }>)
        .map((r) => path.basename(r.file_path)));
      for (const f of fs.readdirSync(dir)) if (/^[0-9a-f]{64}\.json$/.test(f) && !referenced.has(f)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* in use */ } }
    } catch (e) { this.ctx.log.warn({ projectId, err: String(e) }, 'checkpoint prune at start failed'); }
  }

  list(projectId: string) {
    const rows = this.ctx.db.prepare(`SELECT c.*, v.duration_ms AS duration_ms FROM recovery_checkpoints c LEFT JOIN composition_versions v ON v.id = c.version_id
      WHERE c.project_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT ${MAX_CHECKPOINTS}`).all(projectId) as Array<CheckpointRow & { duration_ms: number | null }>;
    return rows.map((r) => checkpointDto(r, r.duration_ms ?? 0, this.fileMeta(r)));
  }
  row(projectId: string, id: string): CheckpointRow {
    const r = this.ctx.db.prepare('SELECT * FROM recovery_checkpoints WHERE id = ? AND project_id = ?').get(id, projectId) as CheckpointRow | undefined;
    if (!r) throw new EmError('EM-9003', 'The item you asked for no longer exists.', { details: { route: 'checkpoint', id } });
    return r;
  }

  /** Reads and verifies a checkpoint file (integrity hash = model hash); EM-6201 when damaged. */
  readFile(file: string, expectProject?: string): CheckpointFile {
    let body: CheckpointFile;
    try { body = JSON.parse(fs.readFileSync(file, 'utf8')) as CheckpointFile; } catch (e) { throw new EmError('EM-6201', 'This checkpoint is damaged. Choose an earlier one.', { status: 422, cause: e }); }
    const m = body && body.format === 'expertmotion-checkpoint' ? migrateModel(body.model) : undefined;
    if (!m || !m.ok || hashModel(m.value) !== body.hash || (expectProject && (body.projectId !== expectProject || m.value.projectId !== expectProject)))
      throw new EmError('EM-6201', 'This checkpoint is damaged. Choose an earlier one.', { status: 422, details: { file: path.basename(file) } });
    return { ...body, model: m.value };
  }

  /** R-024: restore as a new head version (cause restore); history is never overwritten. */
  restore(projectId: string, checkpointId: string) {
    const r = this.row(projectId, checkpointId);
    const body = this.readFile(this.abs(r.file_path), projectId);
    const c = this.store.commit(projectId, body.model, { cause: 'restore' });
    this.offers.delete(projectId);
    return c;
  }

  newestValid(projectId: string): { row: CheckpointRow; body: CheckpointFile } | undefined {
    const rows = this.ctx.db.prepare(`SELECT * FROM recovery_checkpoints WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ${MAX_CHECKPOINTS}`).all(projectId) as CheckpointRow[];
    for (const row of rows) { try { return { row, body: this.readFile(this.abs(row.file_path), projectId) }; } catch { /* try older */ } }
    return undefined;
  }

  offerFor(projectId: string): ReturnType<typeof checkpointDto> | null {
    const id = this.offers.get(projectId);
    if (!id) return null;
    const r = this.ctx.db.prepare('SELECT c.*, v.duration_ms AS duration_ms FROM recovery_checkpoints c LEFT JOIN composition_versions v ON v.id = c.version_id WHERE c.id = ?').get(id) as (CheckpointRow & { duration_ms: number | null }) | undefined;
    return r ? checkpointDto(r, r.duration_ms ?? 0, this.fileMeta(r)) : null;
  }

  removeProjectFiles(projectId: string): void { fs.rmSync(path.join(this.ctx.paths.checkpoints, projectId), { recursive: true, force: true }); }

  // ───────────────────────────── crash recovery (DATABASE_SCHEMA §7, FR-166, FR-172) ─────────────────────────────
  /**
   * Called once at start. Detects an unclean shutdown through the running flag, then:
   *  - for every project whose newest valid checkpoint differs from the head, offers it on the next open (R-016);
   *  - checkpoint folders whose project row is gone (database recovered from .bak or fresh) are imported as projects
   *    with cause 'restore' (never overwriting anything), and a service.notice lists them.
   */
  recoverOnStart(): { unclean: boolean; offered: string[]; imported: string[] } {
    const flag = path.join(this.ctx.paths.data, RUNNING_FLAG);
    const unclean = fs.existsSync(flag);
    try { fs.writeFileSync(flag, String(process.pid), { mode: 0o600 }); } catch (e) { this.ctx.log.warn({ err: String(e) }, 'cannot write running flag'); }
    const offered: string[] = [], imported: string[] = [];
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(this.ctx.paths.checkpoints, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
    const known = new Set((this.ctx.db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((r) => r.id));
    for (const pid of dirs) {
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(pid)) continue;
      if (!known.has(pid)) { if (this.importOrphan(pid)) imported.push(pid); continue; }
      this.pruneAtStart(pid);
      if (!unclean) continue;
      try {
        const p = this.ctx.db.prepare('SELECT p.deleted_at, v.hash FROM projects p LEFT JOIN composition_versions v ON v.id = p.head_version_id WHERE p.id = ?').get(pid) as { deleted_at: string | null; hash: string | null };
        if (p.deleted_at) continue;
        const n = this.newestValid(pid);
        if (n && n.body.hash !== p.hash) { this.offers.set(pid, n.row.id); offered.push(pid); }
      } catch (e) { this.ctx.log.warn({ projectId: pid, err: String(e) }, 'recovery scan failed'); }
    }
    if (unclean) this.ctx.bus.emit('service.notice', { at: this.ctx.now(), kind: 'checkpoint', code: 'EM-8003', offered, imported });
    else if (imported.length) this.ctx.bus.emit('service.notice', { at: this.ctx.now(), kind: 'checkpoint', imported });
    this.lastRecovery = { unclean, offered, imported };
    return this.lastRecovery;
  }

  private importOrphan(pid: string): boolean {
    const dir = path.join(this.ctx.paths.checkpoints, pid);
    let best: CheckpointFile | undefined;
    for (const f of fs.readdirSync(dir).filter((x) => /^[0-9a-f]{64}\.json$/.test(x))) {
      try { const b = this.readFile(path.join(dir, f), pid); if (!best || b.createdAt > best.createdAt) best = b; } catch { /* skip damaged */ }
    }
    if (!best) return false;
    const b = best, now = this.ctx.now();
    let name = b.projectName || 'Recovered project';
    const taken = (n: string) => !!this.ctx.db.prepare('SELECT 1 FROM projects WHERE deleted_at IS NULL AND lower(name) = lower(?)').get(n);
    if (taken(name)) { let i = 1; let cand = `${name} (recovered)`; while (taken(cand)) cand = `${name} (recovered ${++i})`; name = cand; }
    const vid = this.ctx.newId();
    const v: VersionRow = { id: vid, project_id: pid, parent_id: null, hash: b.hash, model_json: JSON.stringify(b.model), cause: 'restore', plan_id: null, duration_ms: deriveTiming(b.model).durationMs, created_at: now };
    try {
      this.ctx.db.transaction(() => {
        this.ctx.db.prepare('INSERT INTO projects (id, name, settings_json, head_version_id, language, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(pid, name, JSON.stringify(b.model.settings), null, b.language === 'en' ? 'en' : 'id', now, now);
        this.ctx.db.prepare('INSERT INTO composition_versions (id, project_id, parent_id, hash, model_json, cause, plan_id, duration_ms, created_at) VALUES (@id, @project_id, @parent_id, @hash, @model_json, @cause, @plan_id, @duration_ms, @created_at)').run(v);
        this.ctx.db.prepare('UPDATE projects SET head_version_id = ? WHERE id = ?').run(vid, pid);
        this.ctx.db.prepare('INSERT INTO recovery_checkpoints (id, project_id, version_id, file_path, reason, created_at) VALUES (?,?,?,?,?,?)').run(this.ctx.newId(), pid, vid, this.rel(pid, b.hash), 'manual', now);
      })();
      fs.mkdirSync(path.join(this.ctx.paths.media, pid), { recursive: true });
      return true;
    } catch (e) { this.ctx.log.warn({ projectId: pid, err: String(e) }, 'orphan checkpoint import failed'); return false; }
  }

  /**
   * R-002 / FR-165 "immediately before close": every project changed during this Service run whose head has no checkpoint yet
   * gets one (reason manual). Failures are logged; shutdown continues.
   */
  checkpointDirty(): string[] {
    const rows = this.ctx.db.prepare(`SELECT p.id FROM projects p WHERE p.deleted_at IS NULL AND p.head_version_id IS NOT NULL AND p.updated_at >= ?
      AND p.head_version_id IS NOT (SELECT c.version_id FROM recovery_checkpoints c WHERE c.project_id = p.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1)`).all(this.bootAt) as Array<{ id: string }>;
    const done: string[] = [];
    for (const r of rows) { try { this.write(r.id, 'manual'); done.push(r.id); } catch (e) { this.ctx.log.warn({ projectId: r.id, err: String(e) }, 'shutdown checkpoint failed'); } }
    return done;
  }

  /** Clean shutdown: flush pending autosaves, checkpoint what is still dirty, clear the running flag. */
  shutdown(): void {
    try { this.autosave.flush(); } catch (e) { this.ctx.log.warn({ err: String(e) }, 'autosave flush failed'); }
    try { this.checkpointDirty(); } catch (e) { this.ctx.log.warn({ err: String(e) }, 'shutdown checkpoints failed'); }
    try { fs.rmSync(path.join(this.ctx.paths.data, RUNNING_FLAG), { force: true }); } catch { /* ignore */ }
  }
}
