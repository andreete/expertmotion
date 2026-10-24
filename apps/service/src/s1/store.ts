// Composition store: project rows, Composition Versions, the head pointer and the one commit path every model change takes
// (DATABASE_SCHEMA §2: version row + operations_history + head update in one transaction). Keeps only the current head of the
// most recently used projects in memory (small LRU), never whole histories.
import { applyOperations, deriveTiming, diffModels, hashModel, migrateModel, validate, type AssetFacts, type CompositionModelT, type ElementDiff, type OperationT } from '@expertmotion/composition-model';
import { EmError, EM_CODE_RE, issue, statusForCode, type EmCode, type Issue } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { PROJECT_SELECT, projectDto, versionDto, type ProjectListRow, type ProjectRow, type VersionCause, type VersionRow } from './dto.js';

export interface Head { versionId: string; hash: string; parentId: string | null; model: CompositionModelT }
export interface CommitOptions {
  cause: VersionCause; planId?: string | null; ops?: readonly OperationT[]; parentId?: string | null; keepRedo?: boolean;
  /** Extra writes in the same transaction (intents, plan rows). Receives the new version id. */
  inTx?: (versionId: string, hash: string) => void;
  /** Runs after the commit, before `composition.updated` is emitted (causal order: intent.updated first). */
  beforeEvent?: () => void;
  diff?: ElementDiff[];
}
export interface Committed { version: ReturnType<typeof versionDto>; previousHash: string | null; changed: boolean; diff: ElementDiff[]; issues: Issue[] }

const HEAD_CACHE = 4;
const CM_TO_EM: Record<string, EmCode> = { 'CM-001': 'EM-1301', 'CM-002': 'EM-2306', 'CM-005': 'EM-2002', 'CM-006': 'EM-2105', 'CM-007': 'EM-2101' };
/** Maps a blocking Issue (EM- or CM- code) to an EmError for the HTTP layer. Composition rejections are 422. */
export function issueError(i: Issue, extra: Record<string, unknown> = {}): EmError {
  const code = (EM_CODE_RE.test(i.code) ? i.code : CM_TO_EM[i.code] ?? 'EM-2307') as EmCode;
  const status = code === 'EM-1301' ? 422 : statusForCode(code);
  return new EmError(code, i.message, { status, path: i.path, details: { issue: i.code, ...extra } });
}
const blockingOnly = (issues: readonly Issue[]) => issues.filter((i) => i.severity === 'block');

export class CompositionStore {
  private readonly heads = new Map<string, Head>();
  private readonly afterCommit: Array<(projectId: string, head: Head, cause: VersionCause) => void> = [];
  constructor(private readonly ctx: ServiceContext) {}

  onCommit(fn: (projectId: string, head: Head, cause: VersionCause) => void): void { this.afterCommit.push(fn); }

  // ───────────── projects ─────────────
  projectRow(id: string, opts: { includeDeleted?: boolean } = {}): ProjectRow {
    const r = this.ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!r || (r.deleted_at && !opts.includeDeleted)) throw new EmError('EM-6101', 'This project no longer exists.', { details: { projectId: id } });
    return r;
  }
  projectDto(id: string, opts: { includeDeleted?: boolean } = {}) {
    const r = this.ctx.db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(id) as ProjectListRow | undefined;
    if (!r || (r.deleted_at && !opts.includeDeleted)) throw new EmError('EM-6101', 'This project no longer exists.', { details: { projectId: id } });
    return projectDto(r);
  }
  assertNameFree(name: string, exceptId?: string): void {
    const hit = this.ctx.db.prepare('SELECT id FROM projects WHERE deleted_at IS NULL AND lower(trim(name)) = lower(trim(?)) AND id != ?').get(name, exceptId ?? '') as { id: string } | undefined;
    if (hit) throw new EmError('EM-6103', `A project named "${name}" already exists. Choose a different name.`, { details: { name } });
  }
  facts(projectId: string): AssetFacts[] { try { return this.ctx.hooks.assetFacts(projectId); } catch { return []; } }

  // ───────────── versions ─────────────
  versionRow(projectId: string, versionId: string): VersionRow {
    const r = this.ctx.db.prepare('SELECT * FROM composition_versions WHERE id = ? AND project_id = ?').get(versionId, projectId) as VersionRow | undefined;
    if (!r) throw new EmError('EM-2401', 'That version of the project no longer exists.', { details: { projectId, versionId } });
    return r;
  }
  /** A version by id or by hash (newest row with that hash). */
  versionByRef(projectId: string, ref: string): VersionRow {
    const r = (this.ctx.db.prepare('SELECT * FROM composition_versions WHERE project_id = ? AND id = ?').get(projectId, ref)
      ?? this.ctx.db.prepare('SELECT * FROM composition_versions WHERE project_id = ? AND hash = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(projectId, ref)) as VersionRow | undefined;
    if (!r) throw new EmError('EM-2401', 'That version of the project no longer exists.', { details: { projectId, versionId: ref } });
    return r;
  }
  parseModel(r: VersionRow): CompositionModelT {
    let json: unknown;
    try { json = JSON.parse(r.model_json); } catch { throw new EmError('EM-2001', 'The composition could not be checked.', { details: { projectId: r.project_id, versionId: r.id } }); }
    const m = migrateModel(json);
    if (!m.ok) throw new EmError('EM-2001', 'The composition could not be checked.', { details: { projectId: r.project_id, versionId: r.id, issues: m.issues.slice(0, 5) } });
    return m.value;
  }

  /** Current head (cached). EM-6101 for unknown projects; EM-2001 when the stored model is unreadable. */
  head(projectId: string): Head {
    const cached = this.heads.get(projectId);
    const row = this.ctx.db.prepare('SELECT head_version_id, deleted_at FROM projects WHERE id = ?').get(projectId) as { head_version_id: string | null; deleted_at: string | null } | undefined;
    if (!row || row.deleted_at) throw new EmError('EM-6101', 'This project no longer exists.', { details: { projectId } });
    if (cached && cached.versionId === row.head_version_id) { this.touch(projectId, cached); return cached; }
    if (!row.head_version_id) throw new EmError('EM-2001', 'The composition could not be checked.', { details: { projectId } });
    const v = this.versionRow(projectId, row.head_version_id);
    const h: Head = { versionId: v.id, hash: v.hash, parentId: v.parent_id, model: this.parseModel(v) };
    this.touch(projectId, h);
    return h;
  }
  private touch(projectId: string, h: Head) {
    this.heads.delete(projectId); this.heads.set(projectId, h);
    while (this.heads.size > HEAD_CACHE) { const k = this.heads.keys().next().value; if (k === undefined) break; this.heads.delete(k); }
  }
  forget(projectId: string): void { this.heads.delete(projectId); }

  canUndo(projectId: string): boolean { try { return this.head(projectId).parentId !== null; } catch { return false; } }
  canRedo(projectId: string): boolean { return this.redoStack(projectId).length > 0; }
  clearRedo(projectId: string): void { this.setRedo(projectId, []); }
  /** FR-168: the redo stack lives in projects.redo_json (migration 12) so Redo survives a Service restart. Newest last. */
  redoStack(projectId: string): string[] {
    const r = this.ctx.db.prepare('SELECT redo_json FROM projects WHERE id = ?').get(projectId) as { redo_json: string | null } | undefined;
    if (!r?.redo_json) return [];
    try { const a = JSON.parse(r.redo_json) as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
  }
  private setRedo(projectId: string, stack: readonly string[]): void {
    this.ctx.db.prepare('UPDATE projects SET redo_json = ? WHERE id = ?').run(stack.length ? JSON.stringify(stack.slice(-200)) : null, projectId);
  }

  /** Dry run: apply ops to a model and report only the blocking problems the ops introduce (like validatePlan). */
  tryApply(projectId: string, model: CompositionModelT, ops: readonly OperationT[]): { ok: true; model: CompositionModelT; diff: ElementDiff[]; warnings: Issue[] } | { ok: false; issues: Issue[] } {
    const assets = this.facts(projectId), tier = this.ctx.hooks.tier();
    const r = applyOperations(model, ops, { assets, tier, newId: this.ctx.newId });
    if (!r.ok) return { ok: false, issues: r.issues };
    const before = new Set(validate(model, { assets, tier }).map((i) => `${i.code}|${i.path}|${i.message}`));
    const fresh = validate(r.value.model, { assets, tier }).filter((i) => !before.has(`${i.code}|${i.path}|${i.message}`));
    const blocks = blockingOnly(fresh);
    if (blocks.length) return { ok: false, issues: blocks };
    return { ok: true, model: r.value.model, diff: r.value.diff, warnings: [...r.warnings, ...fresh] };
  }

  /** Inserts a new version row (unless the hash equals the head's) and moves the head, in one transaction. */
  commit(projectId: string, model: CompositionModelT, o: CommitOptions): Committed {
    const prev = (() => { try { return this.head(projectId); } catch (e) { if (e instanceof EmError && e.code === 'EM-2001') return undefined; throw e; } })();
    const hash = hashModel(model);
    const now = this.ctx.now();
    const durationMs = deriveTiming(model).durationMs;
    const diff = o.diff ?? [];
    const changed = !prev || prev.hash !== hash || o.cause === 'undo' || o.cause === 'redo' || o.cause === 'restore';
    let row: VersionRow;
    const db = this.ctx.db;
    db.transaction(() => {
      if (changed) {
        const id = this.ctx.newId();
        row = { id, project_id: projectId, parent_id: o.parentId !== undefined ? o.parentId : prev?.versionId ?? null, hash, model_json: JSON.stringify(model), cause: o.cause, plan_id: o.planId ?? null, duration_ms: durationMs, created_at: now };
        db.prepare('INSERT INTO composition_versions (id, project_id, parent_id, hash, model_json, cause, plan_id, duration_ms, created_at) VALUES (@id, @project_id, @parent_id, @hash, @model_json, @cause, @plan_id, @duration_ms, @created_at)').run(row);
        if (o.ops?.length) {
          const ins = db.prepare('INSERT INTO operations_history (project_id, version_id, plan_id, intent_id, seq, op_json, applied_at) VALUES (?,?,?,?,?,?,?)');
          o.ops.forEach((op, seq) => ins.run(projectId, id, o.planId ?? null, op.intentId ?? null, seq, JSON.stringify(op), now));
        }
        const p = db.prepare('SELECT settings_json FROM projects WHERE id = ?').get(projectId) as { settings_json: string };
        const s = { ...(JSON.parse(p.settings_json) as Record<string, unknown>) };
        s['fps'] = model.settings.fps; s['ratio'] = model.settings.ratio; s['resolution'] = model.settings.resolution;
        if (model.settings.customRatio) s['customRatio'] = model.settings.customRatio; else delete s['customRatio'];
        if (prev && prev.model.settings.autoRatio !== model.settings.autoRatio) s['autoRatio'] = model.settings.autoRatio;
        db.prepare('UPDATE projects SET head_version_id = ?, settings_json = ?, updated_at = ? WHERE id = ?').run(id, JSON.stringify(s), now, projectId);
        if (!o.keepRedo) this.setRedo(projectId, []);
      } else {
        row = this.versionRow(projectId, prev!.versionId);
      }
      o.inTx?.(row.id, hash);
    })();
    const r = row!;
    const head: Head = { versionId: r.id, hash, parentId: r.parent_id, model };
    this.touch(projectId, head);
    const issues = validate(model, { assets: this.facts(projectId), tier: this.ctx.hooks.tier() });
    o.beforeEvent?.();
    if (changed) {
      this.ctx.bus.emit('composition.updated', { at: now, projectId, version: versionDto(r), previousHash: prev?.hash ?? null, diff, cause: o.cause,
        canUndo: r.parent_id !== null, canRedo: this.canRedo(projectId), durationMs, issues });
      for (const fn of this.afterCommit) { try { fn(projectId, head, o.cause); } catch (e) { this.ctx.log.error({ err: String(e) }, 'afterCommit failed'); } }
      try { this.ctx.hooks.headChanged(projectId, r.id); } catch (e) { this.ctx.log.error({ err: String(e) }, 'headChanged hook failed'); }
    }
    return { version: versionDto(r), previousHash: prev?.hash ?? null, changed, diff, issues };
  }

  /** hooks.applyOps / internal: validate + commit; throws the first blocking problem as an EmError. */
  applyOps(projectId: string, ops: readonly OperationT[], o: Omit<CommitOptions, 'ops' | 'diff'>): Committed {
    const h = this.head(projectId);
    const r = this.tryApply(projectId, h.model, ops);
    if (!r.ok) throw issueError(r.issues[0] ?? issue('EM-2307', 'The change could not be applied.'));
    return this.commit(projectId, r.model, { ...o, ops, diff: r.diff });
  }

  /** R-053: a new row with the parent's model that inherits the parent's parent (so repeated undo walks back). */
  undo(projectId: string): Committed {
    const h = this.head(projectId);
    if (!h.parentId) throw new EmError('EM-2401', 'Nothing to undo.', { status: 422, details: { reason: 'at-root' } });
    const target = this.versionRow(projectId, h.parentId);
    const model = this.parseModel(target);
    const stack = [...this.redoStack(projectId), h.versionId];
    return this.commit(projectId, model, { cause: 'undo', parentId: target.parent_id, keepRedo: true, diff: diffSafe(h.model, model), inTx: () => this.setRedo(projectId, stack) });
  }
  /** R-054: re-applies the most recently undone version (persisted stack, cleared by any other mutation; written in the commit transaction). */
  redoOnce(projectId: string): Committed {
    const stack = this.redoStack(projectId);
    const id = stack[stack.length - 1];
    if (!id) throw new EmError('EM-2401', 'Nothing to redo.', { status: 422, details: { reason: 'no-redo' } });
    const h = this.head(projectId);
    const target = this.versionRow(projectId, id);
    const model = this.parseModel(target);
    return this.commit(projectId, model, { cause: 'redo', parentId: target.parent_id, keepRedo: true, diff: diffSafe(h.model, model), inTx: () => this.setRedo(projectId, stack.slice(0, -1)) });
  }
}

function diffSafe(a: CompositionModelT, b: CompositionModelT): ElementDiff[] { try { return diffModels(a, b); } catch { return []; } }
