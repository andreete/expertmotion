// Projects (API §6.2; FR-009…FR-019, FR-175, FR-178): create with Composition Version v1, list, recent, rename, soft delete
// with a 30-day purge, open (lazy migration, preview media grant, Editor state), settings as Compile-path ops, duplicate.
import fs from 'node:fs';
import path from 'node:path';
import { createEmptyModel, defaultTheme, deriveTiming, hashModel, type CompositionModelT, type ProjectSettingsT, type ThemeT } from '@expertmotion/composition-model';
import { createIntents, enqueue, type DesignPick, type EditIntentT } from '@expertmotion/agents';
import { EmError } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { PROJECT_SELECT, decodeCursor, encodeCursor, planDto, projectDto, versionDto, type PlanRow, type ProjectListRow, type VersionRow } from './dto.js';
import type { Checkpoints } from './checkpoints.js';
import type { CompositionStore } from './store.js';
import type { Workflow } from './workflow.js';
import { checkOutputFolder } from '../modules/settings.js';
import { outputAbsPath } from '../s2/render-repo.js';
import { freeBytes } from '../s2/common.js';

export const PURGE_AFTER_MS = 30 * 24 * 3_600_000;
/** R-017/R-018 fields beside ProjectSettings: duration policy (model) and the per-project output folder (FR-009, FR-015). */
export interface ProjectExtras { durationPolicy: 'fit-content' | 'fixed'; fixedDurationMs?: number; outputFolder: string | null }
const ASSET_PATH_COLS = ['original_path', 'playable_path', 'proxy_path', 'thumb_path', 'filmstrip_path', 'waveform_path'] as const;

export class Projects {
  constructor(private readonly ctx: ServiceContext, private readonly store: CompositionStore, private readonly ckpt: Checkpoints, private readonly wf: Workflow) {}

  create(input: { name: string; settings?: object | undefined; language: 'id' | 'en'; theme?: object | undefined; durationPolicy?: 'fit-content' | 'fixed' | undefined; fixedDurationMs?: number | undefined; outputFolder?: string | undefined }) {
    this.store.assertNameFree(input.name);
    const id = this.ctx.newId(), now = this.ctx.now();
    const defined = (o: object | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
    const settings = { language: input.language, ...defined(input.settings) } as Partial<ProjectSettingsT>;
    const t = defined(input.theme) as Partial<ThemeT>;
    const base = defaultTheme(t.paletteId);
    const theme: ThemeT = { ...base, ...t, textDefaults: { ...base.textDefaults, ...defined(t.textDefaults) } };
    let model: CompositionModelT;
    try { model = createEmptyModel(id, settings, theme); } catch (e) { throw new EmError('EM-9002', 'Invalid request: project settings.', { status: 400, path: 'body.settings', cause: e }); }
    this.checkCustomRatio(model.settings);
    // FR-009: duration policy and output folder are chosen in the New dialog (v1 carries the policy; the folder is a project setting).
    if (input.durationPolicy === 'fixed') {
      if (!input.fixedDurationMs) throw new EmError('EM-9002', 'Invalid request: a fixed duration needs fixedDurationMs.', { status: 400, path: 'body.fixedDurationMs' });
      model.durationPolicy = 'fixed'; model.fixedDurationMs = input.fixedDurationMs;
    }
    const folder = input.outputFolder ? checkOutputFolder(input.outputFolder) : null;
    this.insertProject(id, input.name.trim(), model, input.language, now, folder ? () => {
      this.ctx.db.prepare("UPDATE projects SET settings_json = json_set(settings_json, '$.outputFolder', ?) WHERE id = ?").run(folder, id);
    } : undefined);
    try { fs.mkdirSync(path.join(this.ctx.paths.media, id), { recursive: true }); } catch (e) {
      throw new EmError((e as NodeJS.ErrnoException).code === 'ENOSPC' ? 'EM-6005' : 'EM-6401', 'The project media folder could not be created.', { cause: e });
    }
    const v = this.store.versionRow(id, this.store.projectRow(id).head_version_id!);
    this.ctx.bus.emit('composition.updated', { at: now, projectId: id, version: versionDto(v), previousHash: null, diff: [], cause: 'system', canUndo: false, canRedo: false, durationMs: v.duration_ms, issues: [] });
    try { this.ctx.hooks.headChanged(id, v.id); } catch { /* ignore */ }
    return this.store.projectDto(id);
  }
  private insertProject(id: string, name: string, model: CompositionModelT, language: 'id' | 'en', now: string, extra?: () => void): string {
    const vid = this.ctx.newId();
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare('INSERT INTO projects (id, name, settings_json, head_version_id, language, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, name, JSON.stringify(model.settings), null, language, now, now);
      this.ctx.db.prepare("INSERT INTO composition_versions (id, project_id, parent_id, hash, model_json, cause, plan_id, duration_ms, created_at) VALUES (?,?,NULL,?,?,'system',NULL,?,?)")
        .run(vid, id, hashModel(model), JSON.stringify(model), deriveTiming(model).durationMs, now);
      this.ctx.db.prepare('UPDATE projects SET head_version_id = ? WHERE id = ?').run(vid, id);
      extra?.();
    })();
    return vid;
  }
  /** PERFORMANCE §3 / EM-2402: custom ratio between 1:3 and 3:1 and each side ≥ 240 px. */
  checkCustomRatio(s: Pick<ProjectSettingsT, 'ratio' | 'customRatio'>): void {
    if (s.ratio !== 'custom') return;
    const c = s.customRatio, r = c ? c.w / c.h : 0;
    if (!c || r < 1 / 3 || r > 3 || Math.min(c.w, c.h) < 240) throw new EmError('EM-2402', 'A custom ratio must be between 1:3 and 3:1, and each side at least 240 pixels.', { path: 'body.customRatio', details: { width: c?.w ?? null, height: c?.h ?? null } });
  }

  list(q: { limit: number; cursor?: string | undefined; includeDeleted: boolean }) {
    const c = decodeCursor(q.cursor);
    const where = [q.includeDeleted ? '1=1' : 'p.deleted_at IS NULL']; const args: Record<string, unknown> = { limit: q.limit + 1 };
    if (c?.['u'] && c['id']) { where.push('(p.updated_at < @u OR (p.updated_at = @u AND p.id < @id))'); args['u'] = c['u']; args['id'] = c['id']; }
    const rows = this.ctx.db.prepare(`${PROJECT_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC, p.id DESC LIMIT @limit`).all(args) as ProjectListRow[];
    const total = (this.ctx.db.prepare(`SELECT count(*) AS n FROM projects p WHERE ${q.includeDeleted ? '1=1' : 'p.deleted_at IS NULL'}`).get() as { n: number }).n;
    const page = rows.slice(0, q.limit), last = page[page.length - 1];
    return { items: page.map(projectDto), nextCursor: rows.length > q.limit && last ? encodeCursor({ u: last.updated_at, id: last.id }) : null, total };
  }
  recent() {
    const rows = this.ctx.db.prepare(`${PROJECT_SELECT} WHERE p.deleted_at IS NULL AND p.opened_at IS NOT NULL ORDER BY p.opened_at DESC, p.id DESC LIMIT 10`).all() as ProjectListRow[];
    return { items: rows.map((r) => ({ ...projectDto(r), ...(fs.existsSync(path.join(this.ctx.paths.media, r.id)) ? {} : { warnings: ['EM-6102'] }) })) };
  }
  patch(id: string, b: { name?: string | undefined; language?: 'id' | 'en' | undefined }) {
    const p = this.store.projectRow(id);
    if (b.name !== undefined && b.name.trim() !== p.name) this.store.assertNameFree(b.name, id);
    const settings = JSON.parse(p.settings_json) as Record<string, unknown>;
    if (b.language) settings['language'] = b.language;
    this.ctx.db.prepare('UPDATE projects SET name = ?, language = ?, settings_json = ?, updated_at = ? WHERE id = ?').run(b.name?.trim() ?? p.name, b.language ?? p.language, JSON.stringify(settings), this.ctx.now(), id);
    return this.store.projectDto(id);
  }
  softDelete(id: string): void {
    this.store.projectRow(id);
    const busy = this.ctx.db.prepare("SELECT (SELECT count(*) FROM render_jobs WHERE project_id = ? AND status IN ('queued','rendering')) + (SELECT count(*) FROM agent_runs WHERE project_id = ? AND status = 'running') AS n").get(id, id) as { n: number };
    if (busy.n > 0 || this.wf.activeRun(id)) throw new EmError('EM-2309', 'A render or agent request is running for this project. Wait for it to finish, then try again.', { details: { projectId: id } });
    this.ctx.db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?').run(this.ctx.now(), this.ctx.now(), id);
    this.ctx.grants.revokeProject(id);
    this.ckpt.autosave.cancel(id);
    this.store.forget(id);
  }
  /** FR-175/178 housekeeping: projects soft-deleted more than 30 days ago lose their rows, media and checkpoints. */
  purge(): string[] {
    const cutoff = new Date(Date.now() - PURGE_AFTER_MS).toISOString();
    const ids = (this.ctx.db.prepare('SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) this.hardDelete(id);
    return ids;
  }

  /**
   * Removes a project for good: rows (children first: operations_history / edit_plans reference versions without cascade between
   * them), media folder and checkpoint files. Used by the 30-day purge and for the Sample Project (R-025). Returns false (and
   * keeps the project) when a render or agent run is active or the delete fails.
   */
  hardDelete(id: string, opts: { keepOutputs?: boolean } = {}): boolean {
    if (this.busy(id)) { this.ctx.log.warn({ projectId: id }, 'hard delete skipped: project busy'); return false; }
    // Output files are kept unless the Creator chose otherwise (FR-175: Outputs until deleted by the Creator; FR-178 option).
    const outFiles = opts.keepOutputs === false ? (this.ctx.db.prepare('SELECT path, thumb_path FROM outputs WHERE project_id = ?').all(id) as Array<{ path: string; thumb_path: string | null }>)
      .flatMap((o) => [o.path, ...(o.thumb_path ? [o.thumb_path] : [])].map((x) => outputAbsPath(this.ctx, x))) : [];
    try {
      this.ctx.db.transaction(() => {
        for (const t of ['operations_history', 'usage_records', 'outputs', 'render_jobs', 'generator_jobs', 'edit_plans', 'recovery_checkpoints', 'edit_intents', 'messages', 'conversations', 'agent_runs']) {
          if (t === 'messages') this.ctx.db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)').run(id);
          else this.ctx.db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
        }
        this.ctx.db.prepare('UPDATE composition_versions SET parent_id = NULL WHERE project_id = ?').run(id);
        this.ctx.db.prepare('DELETE FROM composition_versions WHERE project_id = ?').run(id);
        this.ctx.db.prepare('DELETE FROM assets WHERE project_id = ?').run(id);
        this.ctx.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      })();
      this.ctx.grants.revokeProject(id);
      this.ckpt.autosave.cancel(id);
      this.store.forget(id);
      fs.rmSync(path.join(this.ctx.paths.media, id), { recursive: true, force: true });
      this.ckpt.removeProjectFiles(id);
      for (const f of outFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
      if (opts.keepOutputs === false) { try { fs.rmSync(path.join(this.ctx.paths.outputs, id), { recursive: true, force: true }); } catch { /* ignore */ } }
      return true;
    } catch (e) { this.ctx.log.warn({ projectId: id, err: String(e) }, 'hard delete failed'); return false; }
  }

  private busy(id: string): boolean {
    const busy = this.ctx.db.prepare("SELECT (SELECT count(*) FROM render_jobs WHERE project_id = ? AND status IN ('queued','rendering')) + (SELECT count(*) FROM agent_runs WHERE project_id = ? AND status = 'running') AS n").get(id, id) as { n: number };
    return busy.n > 0 || this.wf.activeRun(id) !== undefined;
  }

  /** R-015 `permanent=true` (FR-178, Open ▸ Delete): rows, media and checkpoints now; Output files only when keepOutputs is false. */
  deletePermanently(id: string, keepOutputs: boolean): void {
    this.store.projectRow(id, { includeDeleted: true });
    if (this.busy(id)) throw new EmError('EM-2309', 'A render or agent request is running for this project. Wait for it to finish, then try again.', { details: { projectId: id } });
    if (!this.hardDelete(id, { keepOutputs })) throw new EmError('EM-6401', 'The project could not be deleted.', { details: { projectId: id } });
  }

  /**
   * R-026 (FR-178, FR-017): disk use per project (media folder, checkpoints, Output files) with a backup size estimate
   * (original media + Outputs listed separately, plus the JSON parts), the total, and free space on the data drive.
   */
  async diskUsage(projectId?: string) {
    const db = this.ctx.db;
    const ids = projectId ? [this.store.projectRow(projectId).id]
      : (db.prepare('SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC').all() as Array<{ id: string }>).map((r) => r.id);
    const items = ids.map((id) => {
      const mediaBytes = dirBytes(path.join(this.ctx.paths.media, id));
      const checkpointBytes = dirBytes(path.join(this.ctx.paths.checkpoints, id));
      const o = db.prepare('SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM outputs WHERE project_id = ?').get(id) as { n: number; b: number };
      const originals = (db.prepare('SELECT coalesce(sum(bytes), 0) AS b FROM assets WHERE project_id = ?').get(id) as { b: number }).b;
      const json = (db.prepare('SELECT coalesce(sum(length(model_json)), 0) AS b FROM (SELECT model_json FROM composition_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 50)').get(id) as { b: number }).b;
      return { projectId: id, mediaBytes, checkpointBytes, outputsBytes: o.b, outputCount: o.n, totalBytes: mediaBytes + checkpointBytes + o.b, backupBytes: originals + json + 64_000, backupOutputsBytes: o.b };
    });
    return { items, totalBytes: items.reduce((n, i) => n + i.totalBytes, 0), freeBytes: await freeBytes(this.ctx.paths.data) };
  }

  /** R-027 (FR-010): the Open dialog thumbnail: the first clip's thumbnail of the head version, else any asset thumbnail. */
  thumbnailFile(id: string): string | null {
    this.store.projectRow(id);
    let first: string | undefined;
    try { first = this.store.head(id).model.tracks.video[0]?.assetId; } catch { /* unreadable head: fall back */ }
    const rows = this.ctx.db.prepare('SELECT id, thumb_path FROM assets WHERE project_id = ? AND thumb_path IS NOT NULL ORDER BY created_at').all(id) as Array<{ id: string; thumb_path: string }>;
    const pick = rows.find((r) => r.id === first) ?? rows[0];
    if (!pick) return null;
    const root = path.resolve(this.ctx.paths.media), abs = path.resolve(root, pick.thumb_path);
    return abs.startsWith(root + path.sep) && fs.existsSync(abs) ? abs : null;
  }

  /** R-016: one call restores the Editor state. Lazy model migration; corrupt head → newest valid checkpoint (FR-166). */
  open(id: string) {
    this.store.projectRow(id);
    const now = this.ctx.now();
    let head;
    try { head = this.store.head(id); } catch (e) {
      if (!(e instanceof EmError) || e.code !== 'EM-2001') throw e;
      const n = this.ckpt.newestValid(id);
      let recovered = null;
      if (n) { const c = this.store.commit(id, n.body.model, { cause: 'restore', parentId: null }); recovered = { checkpointId: n.row.id, version: c.version }; }
      throw new EmError('EM-2001', 'The composition could not be checked. Expertmotion restored the last good checkpoint.', { details: { projectId: id, recovered } });
    }
    const row = this.store.versionRow(id, head.versionId);
    if (hashModel(head.model) !== row.hash) this.store.commit(id, head.model, { cause: 'system' });       // lazily migrated (DATABASE_SCHEMA §5)
    this.ctx.db.prepare('UPDATE projects SET opened_at = ? WHERE id = ?').run(now, id);
    const g = this.ctx.grants.issuePreview(id);
    const latest = this.ctx.db.prepare("SELECT * FROM edit_plans WHERE project_id = ? AND status != 'cancelled' ORDER BY created_at DESC, id DESC LIMIT 1").get(id) as PlanRow | undefined;
    const jobs = this.ctx.db.prepare('SELECT * FROM render_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(id) as Array<Record<string, unknown>>;
    const h = this.store.head(id);
    return {
      project: this.store.projectDto(id),
      head: versionDto(this.store.versionRow(id, h.versionId), true),
      mediaGrant: { grant: g.token, projectId: id, kind: 'preview' as const, expiresAt: new Date(g.expiresAt).toISOString(), baseUrl: `http://127.0.0.1:${this.ctx.cfg.port}/media/${g.token}` },
      checkpointNewerThanSave: this.ckpt.offerFor(id),
      intentQueue: this.wf.queueDto(id),
      latestPlan: latest ? planDto(latest, { withOps: true }) : null,
      renderJobs: jobs.map(renderJobDto),
    };
  }

  getSettings(id: string): ProjectSettingsT & ProjectExtras {
    const p = this.store.projectRow(id);
    const h = this.store.head(id);
    const s = JSON.parse(p.settings_json) as ProjectSettingsT & { outputFolder?: string };
    const m = h.model.settings;
    // FR-015: the duration policy lives on the model (op:project.setDurationPolicy); the output folder is a stored project setting.
    const out: ProjectSettingsT & ProjectExtras = { durationPolicy: h.model.durationPolicy, ...(h.model.fixedDurationMs ? { fixedDurationMs: h.model.fixedDurationMs } : {}), outputFolder: s.outputFolder ?? null, ...s, fps: m.fps, ratio: m.ratio, resolution: m.resolution, autoRatio: m.autoRatio, language: s.language ?? p.language };
    if (m.customRatio) out.customRatio = m.customRatio; else delete out.customRatio;
    return out;
  }

  /** R-018: fps / ratio / resolution changes become system-source intents compiled into ops (UX-010); others are stored. */
  putSettings(id: string, body: ProjectSettingsT & { durationPolicy?: ProjectExtras['durationPolicy'] | undefined; fixedDurationMs?: number | undefined; outputFolder?: string | null | undefined }) {
    this.store.projectRow(id);
    this.checkCustomRatio(body);
    const head = this.store.head(id), cur = head.model.settings;
    const picks: DesignPick[] = [];
    if (body.fps !== cur.fps) picks.push({ projectId: id, source: 'system', output: { kind: 'fps', value: body.fps } });
    if (body.ratio !== cur.ratio || JSON.stringify(body.customRatio ?? null) !== JSON.stringify(cur.ratio === 'custom' ? cur.customRatio ?? null : null))
      picks.push({ projectId: id, source: 'system', output: { kind: 'ratio', value: body.ratio, ...(body.ratio === 'custom' && body.customRatio ? { customRatio: body.customRatio } : {}) } });
    if (body.resolution !== cur.resolution) picks.push({ projectId: id, source: 'system', output: { kind: 'resolution', value: body.resolution } });
    // FR-088/FR-095: Auto is a model setting; a ratio change turns it off, so compare against what the ratio op leaves behind.
    const autoAfterRatio = picks.some((pk) => pk.output?.kind === 'ratio') ? false : cur.autoRatio;
    if (body.autoRatio !== undefined && body.autoRatio !== autoAfterRatio) picks.push({ projectId: id, source: 'system', output: { kind: 'autoRatio', value: body.autoRatio } });
    // FR-015: output / project.durationPolicy / scalar → op:project.setDurationPolicy (Edit Intent, Compile path).
    if (body.durationPolicy !== undefined) {
      if (body.durationPolicy === 'fixed' && !body.fixedDurationMs && !head.model.fixedDurationMs) throw new EmError('EM-9002', 'Invalid request: a fixed duration needs fixedDurationMs.', { status: 400, path: 'body.fixedDurationMs' });
      const fixedMs = body.durationPolicy === 'fixed' ? body.fixedDurationMs ?? head.model.fixedDurationMs : undefined;
      if (body.durationPolicy !== head.model.durationPolicy || (fixedMs !== undefined && fixedMs !== head.model.fixedDurationMs))
        picks.push({ projectId: id, source: 'system', output: { kind: 'durationPolicy', value: body.durationPolicy, ...(fixedMs !== undefined ? { fixedMs } : {}) } });
    }
    const folder = body.outputFolder === undefined ? undefined : body.outputFolder === null || body.outputFolder === '' ? null : checkOutputFolder(body.outputFolder);
    let version = null;
    if (picks.length) {
      const incoming: EditIntentT[] = [];
      for (const pk of picks) { const r = createIntents(pk, { model: head.model, baseVersion: head.hash, newId: this.ctx.newId, now: this.ctx.now }); if (!r.ok) throw new EmError('EM-9002', r.issues[0]!.message, { status: 400, path: 'body' }); incoming.push(...r.value); }
      const before = this.wf.loadQueue(id);
      const after = enqueue(before, incoming);
      this.wf.saveQueue(id, before, after);
      version = this.wf.applyNow(id, incoming.map((i) => i.id), { reason: 'compiled', goal: 'Project settings' }).version;
    }
    const p = this.store.projectRow(id);
    const stored: Record<string, unknown> = { ...(JSON.parse(p.settings_json) as Record<string, unknown>), language: body.language };
    if (folder === null) delete stored['outputFolder']; else if (folder !== undefined) stored['outputFolder'] = folder;
    this.ctx.db.prepare('UPDATE projects SET settings_json = ?, language = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(stored), body.language, this.ctx.now(), id);
    const warnings = this.ctx.hooks.tier() === 'T0' && (body.resolution === '2k' || body.resolution === '2160p')
      ? [{ code: 'EM-3105', path: 'settings.resolution', message: `${body.resolution} is not available on this computer; export will offer 1080p.`, severity: 'warn' }] : [];
    return { settings: this.getSettings(id), version, warnings };
  }

  /** R-019 Save As: settings, assets (media hard-linked or copied, or shared when copyMedia=false), all versions, intents, plans. */
  duplicate(id: string, b: { name: string; copyMedia: boolean }) {
    const src = this.store.projectRow(id);
    this.store.assertNameFree(b.name);
    const db = this.ctx.db, now = this.ctx.now(), nid = this.ctx.newId();
    const assets = db.prepare('SELECT * FROM assets WHERE project_id = ?').all(id) as Array<Record<string, unknown> & { id: string }>;
    const amap = new Map(assets.map((a) => [a.id, this.ctx.newId()]));
    const remapPath = (p: unknown, oldA: string, newA: string): string | null => {
      if (typeof p !== 'string' || !p) return null;
      return p.split(/[\\/]/).map((seg) => (seg === id ? nid : seg === oldA ? newA : seg)).join('/');
    };
    const copied: string[] = [];
    try {
      fs.mkdirSync(path.join(this.ctx.paths.media, nid), { recursive: true });
      if (b.copyMedia) for (const a of assets) for (const col of ASSET_PATH_COLS) {
        const from = typeof a[col] === 'string' ? path.resolve(this.ctx.paths.media, a[col] as string) : null;
        const to = remapPath(a[col], a.id, amap.get(a.id)!);
        if (!from || !to || !from.startsWith(path.resolve(this.ctx.paths.media) + path.sep) || !fs.existsSync(from)) continue;
        const dest = path.resolve(this.ctx.paths.media, to);
        if (!dest.startsWith(path.resolve(this.ctx.paths.media) + path.sep) || fs.existsSync(dest)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try { fs.linkSync(from, dest); } catch { fs.copyFileSync(from, dest); }
        copied.push(dest);
      }
    } catch (e) {
      fs.rmSync(path.join(this.ctx.paths.media, nid), { recursive: true, force: true });
      throw new EmError((e as NodeJS.ErrnoException).code === 'ENOSPC' ? 'EM-6005' : 'EM-6401', 'The project copy could not be written.', { cause: e });
    }
    const versions = db.prepare('SELECT * FROM composition_versions WHERE project_id = ? ORDER BY created_at, id').all(id) as VersionRow[];
    const vmap = new Map(versions.map((v) => [v.id, this.ctx.newId()]));
    const remapModel = (json: string): CompositionModelT => {
      const m = JSON.parse(json) as CompositionModelT; m.projectId = nid;
      const ma = (x: string) => amap.get(x) ?? x;
      for (const c of m.tracks.video) c.assetId = ma(c.assetId);
      for (const o of m.tracks.overlay) if (o.kind === 'image') o.assetId = ma(o.assetId);
      for (const a of m.tracks.audio) a.assetId = ma(a.assetId);
      if (m.tracks.caption.sourceAssetId) m.tracks.caption.sourceAssetId = ma(m.tracks.caption.sourceAssetId);
      return m;
    };
    const intents = db.prepare("SELECT * FROM edit_intents WHERE project_id = ? AND status != 'removed'").all(id) as Array<{ id: string; intent_json: string; status: string; property_key: string; created_at: string }>;
    const imap = new Map(intents.map((i) => [i.id, this.ctx.newId()]));
    const plans = db.prepare("SELECT * FROM edit_plans WHERE project_id = ? AND status NOT IN ('draft','executing')").all(id) as PlanRow[];
    const pmap = new Map(plans.map((p) => [p.id, this.ctx.newId()]));
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO projects (id, name, settings_json, head_version_id, language, created_at, updated_at) VALUES (?,?,?,NULL,?,?,?)').run(nid, b.name.trim(), src.settings_json, src.language, now, now);
        for (const a of assets) {
          const row: Record<string, unknown> = { ...a, id: amap.get(a.id), project_id: nid, created_at: now, updated_at: now };
          if (b.copyMedia) for (const col of ASSET_PATH_COLS) row[col] = remapPath(a[col], a.id, amap.get(a.id)!) ?? a[col] ?? null;
          const cols = Object.keys(row);
          db.prepare(`INSERT INTO assets (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`).run(row);
        }
        const iv = db.prepare('INSERT INTO composition_versions (id, project_id, parent_id, hash, model_json, cause, plan_id, duration_ms, created_at) VALUES (?,?,NULL,?,?,?,NULL,?,?)');
        for (const v of versions) { const m = remapModel(v.model_json); iv.run(vmap.get(v.id), nid, hashModel(m), JSON.stringify(m), v.cause, v.duration_ms, v.created_at); }
        const up = db.prepare('UPDATE composition_versions SET parent_id = ?, plan_id = ? WHERE id = ?');
        for (const v of versions) up.run(v.parent_id ? vmap.get(v.parent_id) ?? null : null, v.plan_id ? pmap.get(v.plan_id) ?? null : null, vmap.get(v.id));
        db.prepare('UPDATE projects SET head_version_id = ? WHERE id = ?').run(src.head_version_id ? vmap.get(src.head_version_id) ?? null : null, nid);
        const ii = db.prepare('INSERT INTO edit_intents (id, project_id, intent_json, status, property_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
        for (const r of intents) {
          const i = JSON.parse(r.intent_json) as EditIntentT;
          const n: EditIntentT = { ...i, id: imap.get(i.id)!, projectId: nid, supersedes: i.supersedes.map((s) => imap.get(s) ?? s), ...(i.parentIntentId ? { parentIntentId: imap.get(i.parentIntentId) ?? i.parentIntentId } : {}) };
          ii.run(n.id, nid, JSON.stringify(n), r.status, r.property_key, r.created_at, now);
        }
        const ip = db.prepare('INSERT INTO edit_plans (id, project_id, base_version_id, origin, plan_json, status, agent_run_id, created_at, updated_at, intent_ids_json, message, result_json) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)');
        for (const p of plans) {
          const pj = { ...(JSON.parse(p.plan_json) as Record<string, unknown>), id: pmap.get(p.id), projectId: nid };
          const status = p.status === 'valid' ? 'stale' : p.status;
          ip.run(pmap.get(p.id), nid, vmap.get(p.base_version_id), p.origin, JSON.stringify(pj), status, p.created_at, now,
            JSON.stringify((p.intent_ids_json ? (JSON.parse(p.intent_ids_json) as string[]) : []).map((x) => imap.get(x) ?? x)), p.message, null);
        }
      })();
    } catch (e) {
      fs.rmSync(path.join(this.ctx.paths.media, nid), { recursive: true, force: true });
      throw e;
    }
    const h = this.store.head(nid);
    this.ctx.bus.emit('composition.updated', { at: now, projectId: nid, version: versionDto(this.store.versionRow(nid, h.versionId)), previousHash: null, diff: [], cause: 'system', canUndo: h.parentId !== null, canRedo: false, durationMs: deriveTiming(h.model).durationMs, issues: [] });
    try { this.ctx.hooks.headChanged(nid, h.versionId); } catch { /* ignore */ }
    return this.store.projectDto(nid);
  }
}

/** Bytes under a folder (no symlinks, bounded depth); 0 when missing. */
export function dirBytes(p: string, depth = 0): number {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    if (depth > 8) return 0;
    return fs.readdirSync(p).reduce((n, f) => n + dirBytes(path.join(p, f), depth + 1), 0);
  } catch { return 0; }
}

function renderJobDto(r: Record<string, unknown>) {
  const json = (v: unknown) => { try { return typeof v === 'string' ? JSON.parse(v) as unknown : null; } catch { return null; } };
  return { id: r['id'], projectId: r['project_id'], versionId: r['version_id'], outputProfile: json(r['output_profile_json']), performanceProfile: r['performance_profile'], status: r['status'],
    progress: r['progress'], renderedFrames: r['rendered_frames'] ?? null, totalFrames: r['total_frames'] ?? null, etaMs: r['eta_ms'] ?? null, outputId: r['output_id'] ?? null,
    errorCode: r['error_code'] ?? null, failedFrame: r['failed_frame'] ?? null, width: null, height: null, createdAt: r['created_at'], startedAt: r['started_at'] ?? null, finishedAt: r['finished_at'] ?? null };
}
