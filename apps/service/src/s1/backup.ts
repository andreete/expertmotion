// Project backup and restore (DATABASE_SCHEMA §6, FR-017, FR-018, FR-177, SEC-052). A backup is a store-only zip:
//   manifest.json (format, versions, project id, sha256 + size of every other entry), project.json, assets.json,
//   versions/<id>.json (newest 50 incl. head), intents.json, plans.json, conversations.json (Brainstorming/Editor threads, never
//   provider secrets), media/<assetId>/original.<ext> (+ playable when it
//   differs), outputs/<outputId>/<file> when asked. Encrypted by default with a passphrase (crypto-box.ts) or plain.
// Restore validates the archive (zip.ts), the manifest and every hash before anything is imported, then imports as a project
// that never overwrites an existing one (ids that already exist are re-issued; the name gets " (restored)", EM-6303).
// Both are background jobs reporting through `service.notice {kind:'backup'|'restore', jobId, percent, done}`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { deriveTiming, hashModel, migrateModel, type CompositionModelT } from '@expertmotion/composition-model';
import { EditIntent, EditPlan, type EditIntentT } from '@expertmotion/agents';
import { EmError, sanitizeFilename, timestamp } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { BoxError, decryptFile, encryptFile } from './crypto-box.js';
import { allowedRoots, confine } from './fsguard.js';
import type { PlanRow, ProjectRow, VersionRow } from './dto.js';
import type { CompositionStore } from './store.js';
import { ZipError, ZipReader, ZipWriter, isZipFile, type ZipEntry } from './zip.js';

export const BACKUP_FORMAT = 'expertmotion-backup', BACKUP_FORMAT_VERSION = 1, MAX_VERSIONS = 50;
const JSON_MAX = 64 * 1024 ** 2;
const ManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT), formatVersion: z.number().int().min(1), appVersion: z.string().max(64), modelSchemaVersion: z.number().int(),
  projectId: z.string().max(64), projectName: z.string().max(200), createdAt: z.string().max(64), form: z.enum(['encrypted', 'plain']),
  files: z.array(z.object({ path: z.string().max(512), bytes: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(20_000),
});
type Manifest = z.infer<typeof ManifestSchema>;
const AssetJson = z.object({
  id: z.string().max(64), kind: z.enum(['video', 'image', 'audio', 'subtitle']), name: z.string().max(500), sha256: z.string().max(128), bytes: z.number().int().min(0),
  probe_json: z.string().nullable().optional(), duration_ms: z.number().int().nullable().optional(), width: z.number().int().nullable().optional(), height: z.number().int().nullable().optional(),
  fps: z.number().nullable().optional(), has_audio: z.number().int().nullable().optional(), sequence_badge: z.number().int().nullable().optional(), created_at: z.string().max(64),
  files: z.object({ original: z.string().max(512), playable: z.string().max(512).optional() }),
});
const VersionJson = z.object({ id: z.string().max(64), parentId: z.string().max(64).nullable(), hash: z.string().max(128), cause: z.enum(['insert', 'compile', 'execute', 'undo', 'redo', 'restore', 'system']), planId: z.string().max(64).nullable(), createdAt: z.string().max(64), model: z.unknown() });
const ProjectJson = z.object({ id: z.string().max(64), name: z.string().min(1).max(200), settings: z.record(z.string(), z.unknown()), language: z.enum(['id', 'en']), headVersionId: z.string().max(64), createdAt: z.string().max(64) });
const ConversationJson = z.object({ agent: z.enum(['brainstorm', 'editor']), summary: z.unknown().optional(), createdAt: z.string().max(64),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system', 'tool']), blocks: z.array(z.unknown()).max(200), createdAt: z.string().max(64) })).max(20_000) });
const PlanJson = z.object({ id: z.string().max(64), baseVersionId: z.string().max(64), origin: z.enum(['compile', 'editor-agent']), status: z.string().max(32), plan: z.unknown(), intentIds: z.array(z.string().max(64)).max(500), message: z.string().max(4000).nullable(), createdAt: z.string().max(64) });

interface AssetRow { id: string; project_id: string; kind: 'video' | 'image' | 'audio' | 'subtitle'; name: string; sha256: string; bytes: number; original_path: string; playable_path: string | null; probe_json: string | null; duration_ms: number | null; width: number | null; height: number | null; fps: number | null; has_audio: number | null; status: string; sequence_badge: number | null; created_at: string }

const extOf = (p: string) => { const e = path.extname(p).slice(1).toLowerCase(); return /^[a-z0-9]{1,8}$/.test(e) ? `.${e}` : ''; };
const relFile = (root: string, rel: string) => { const abs = path.resolve(root, rel); return abs.startsWith(path.resolve(root) + path.sep) ? abs : null; };

export class Backups {
  constructor(private readonly ctx: ServiceContext, private readonly store: CompositionStore) {}
  private notice(kind: 'backup' | 'restore', jobId: string, data: Record<string, unknown>) { this.ctx.bus.emit('service.notice', { at: this.ctx.now(), kind, jobId, ...data }); }
  private freeBytes(dir: string): number | null { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; } }

  // ───────────────────────────── backup ─────────────────────────────
  /** R-020: validates synchronously (folder, space), then runs as a job. Returns the job id and the job promise (tests). */
  startBackup(projectId: string, input: { folder: string; passphrase?: string | undefined; includeOutputs: boolean }): { jobId: string; done: Promise<string | null> } {
    const p = this.store.projectRow(projectId);
    const folder = confine(input.folder, allowedRoots(this.ctx.cfg.dataDir), 'dir');
    const assets = this.ctx.db.prepare('SELECT * FROM assets WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as AssetRow[];   // FR-052: removed assets stay out
    const media: Array<{ name: string; abs: string }> = [];
    for (const a of assets) {
      const orig = relFile(this.ctx.paths.media, a.original_path);
      if (orig && fs.existsSync(orig)) media.push({ name: `media/${a.id}/original${extOf(a.original_path)}`, abs: orig });
      if (a.playable_path && a.playable_path !== a.original_path) { const pl = relFile(this.ctx.paths.media, a.playable_path); if (pl && fs.existsSync(pl)) media.push({ name: `media/${a.id}/playable${extOf(a.playable_path)}`, abs: pl }); }
    }
    const outputs: Array<{ name: string; abs: string }> = [];
    if (input.includeOutputs) {
      for (const o of this.ctx.db.prepare('SELECT id, path FROM outputs WHERE project_id = ?').all(projectId) as Array<{ id: string; path: string }>) {
        const abs = relFile(this.ctx.paths.outputs, o.path);
        if (abs && fs.existsSync(abs)) outputs.push({ name: `outputs/${o.id}/${sanitizeFilename(path.basename(o.path, path.extname(o.path)), 'output')}${extOf(o.path)}`, abs });
      }
    }
    const bytes = [...media, ...outputs].reduce((s, f) => s + fs.statSync(f.abs).size, 0) + 8 * 1024 ** 2;
    const free = this.freeBytes(folder), freeTmp = this.freeBytes(this.ctx.paths.tmp);
    const need = bytes * (input.passphrase ? 2 : 1);
    if ((free !== null && free < need) || (input.passphrase && freeTmp !== null && freeTmp < bytes))
      throw new EmError('EM-6304', `The backup needs about ${(need / 1024 ** 3).toFixed(1)} GB.`, { status: 422, details: { estimatedBytes: need, freeBytes: free } });
    const jobId = this.ctx.newId();
    const base = `${sanitizeFilename(p.name, 'project')}-${timestamp()}`;
    const target = path.join(folder, input.passphrase ? `${base}.emproj` : `${base}.zip`);
    const done = this.runBackup(jobId, p, assets, media, outputs, target, input.passphrase, bytes).then(() => target, (e) => {
      this.ctx.log.error({ projectId, jobId, err: String(e) }, 'backup failed');
      this.notice('backup', jobId, { projectId, done: true, code: (e as { code?: string }).code === 'ENOSPC' ? 'EM-6304' : 'EM-6301' });
      return null;
    });
    return { jobId, done };
  }

  private async runBackup(jobId: string, p: ProjectRow, assets: AssetRow[], media: Array<{ name: string; abs: string }>, outputs: Array<{ name: string; abs: string }>, target: string, passphrase: string | undefined, totalBytes: number) {
    const db = this.ctx.db; const projectId = p.id;
    const zipPath = passphrase ? path.join(this.ctx.paths.tmp, `backup-${jobId}.zip`) : `${target}.part`;
    const files: Manifest['files'] = [];
    let doneBytes = 0, lastPct = -1;
    const progress = (n: number) => { doneBytes += n; const pct = Math.min(99, Math.floor((doneBytes / totalBytes) * 100)); if (pct >= lastPct + 5) { lastPct = pct; this.notice('backup', jobId, { projectId, percent: pct, done: false }); } };
    const w = await ZipWriter.create(zipPath);
    try {
      const addJson = async (name: string, v: unknown) => { const b = Buffer.from(JSON.stringify(v), 'utf8'); files.push({ path: name, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }); await w.addBuffer(name, b); progress(b.length); };
      await addJson('project.json', { id: p.id, name: p.name, settings: JSON.parse(p.settings_json), language: p.language, headVersionId: p.head_version_id, createdAt: p.created_at });
      await addJson('assets.json', assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, sha256: a.sha256, bytes: a.bytes, probe_json: a.probe_json, duration_ms: a.duration_ms, width: a.width, height: a.height, fps: a.fps,
        has_audio: a.has_audio, sequence_badge: a.sequence_badge, created_at: a.created_at,
        files: { original: `media/${a.id}/original${extOf(a.original_path)}`, ...(a.playable_path && a.playable_path !== a.original_path ? { playable: `media/${a.id}/playable${extOf(a.playable_path)}` } : {}) } })));
      const versions = db.prepare(`SELECT * FROM composition_versions WHERE project_id = ? AND (id = ? OR id IN (SELECT id FROM composition_versions WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ${MAX_VERSIONS}))`).all(projectId, p.head_version_id, projectId) as VersionRow[];
      for (const v of versions) await addJson(`versions/${v.id}.json`, { id: v.id, parentId: v.parent_id, hash: v.hash, cause: v.cause, planId: v.plan_id, createdAt: v.created_at, model: JSON.parse(v.model_json) });
      await addJson('intents.json', (db.prepare("SELECT intent_json FROM edit_intents WHERE project_id = ? AND status != 'removed' ORDER BY created_at").all(projectId) as Array<{ intent_json: string }>).map((r) => JSON.parse(r.intent_json)));
      await addJson('plans.json', (db.prepare("SELECT * FROM edit_plans WHERE project_id = ? AND status NOT IN ('draft','executing') ORDER BY created_at").all(projectId) as PlanRow[])
        .map((r) => ({ id: r.id, baseVersionId: r.base_version_id, origin: r.origin, status: r.status, plan: JSON.parse(r.plan_json), intentIds: r.intent_ids_json ? JSON.parse(r.intent_ids_json) : [], message: r.message, createdAt: r.created_at })));
      // FR-017: conversations go into the backup (messages only; provider connections and keys live elsewhere and are never read here).
      await addJson('conversations.json', (db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at').all(projectId) as Array<{ id: string; agent: string; summary_json: string | null; created_at: string }>)
        .map((c) => ({ agent: c.agent, ...(c.summary_json ? { summary: JSON.parse(c.summary_json) as unknown } : {}), createdAt: c.created_at,
          messages: (db.prepare('SELECT role, blocks_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, id').all(c.id) as Array<{ role: string; blocks_json: string; created_at: string }>)
            .map((m) => ({ role: m.role, blocks: JSON.parse(m.blocks_json) as unknown[], createdAt: m.created_at })) })));
      for (const f of [...media, ...outputs]) {
        const h = crypto.createHash('sha256'); let n = 0;
        await w.addFile(f.name, f.abs, (b) => { h.update(b); n += b.length; progress(b.length); });
        files.push({ path: f.name, bytes: n, sha256: h.digest('hex') });
      }
      const manifest: Manifest = { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, appVersion: this.ctx.cfg.version, modelSchemaVersion: 1, projectId, projectName: p.name, createdAt: this.ctx.now(), form: passphrase ? 'encrypted' : 'plain', files };
      await w.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
      await w.close();
      if (passphrase) await encryptFile(zipPath, `${target}.part`, passphrase);
      await fsp.rename(`${target}.part`, target);
      this.ctx.db.prepare('INSERT INTO audit_log (at, event, project_id, details_json) VALUES (?,?,?,?)').run(this.ctx.now(), 'project.backup', projectId, JSON.stringify({ form: manifest.form, files: files.length }));
      this.notice('backup', jobId, { projectId, percent: 100, done: true, path: target });
    } catch (e) {
      await w.abort(); await fsp.rm(`${target}.part`, { force: true });
      throw e;
    } finally { if (passphrase) await fsp.rm(zipPath, { force: true }); }
  }

  // ───────────────────────────── restore ─────────────────────────────
  /** R-021: synchronous checks (path, format, passphrase presence); the import runs as a job. */
  startRestore(input: { path: string; passphrase?: string | undefined; onConflict: 'copy' | 'replace' }): { jobId: string; done: Promise<string | null> } {
    const file = confine(input.path, allowedRoots(this.ctx.cfg.dataDir), 'file');
    const fd = fs.openSync(file, 'r'); const magic = Buffer.alloc(4);
    try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
    const encrypted = magic.toString('latin1') === 'EMBK';
    if (!encrypted && !isZipFile(file)) throw new EmError('EM-6302', 'This file is not an Expertmotion backup.', { status: 422, details: { reason: 'format' } });
    if (encrypted && !input.passphrase) throw new EmError('EM-6305', 'This backup is encrypted; enter its passphrase.', { status: 422, details: { needsPassphrase: true } });
    const jobId = this.ctx.newId();
    const done = this.runRestore(jobId, file, encrypted, input.passphrase).catch((e) => {
      const code = e instanceof EmError ? e.code : 'EM-6302';
      this.ctx.log.warn({ jobId, code, err: String(e) }, 'restore failed');
      this.notice('restore', jobId, { done: true, code });
      return null;
    });
    return { jobId, done };
  }

  private async runRestore(jobId: string, file: string, encrypted: boolean, passphrase: string | undefined): Promise<string> {
    const staging = path.join(this.ctx.paths.tmp, `restore-${jobId}`);
    await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
    let zipFile = file; let reader: ZipReader | undefined; let finalMedia: string | undefined;
    try {
      if (encrypted) {
        zipFile = path.join(staging, 'backup.zip');
        try { await decryptFile(file, zipFile, passphrase ?? ''); } catch (e) {
          if (e instanceof BoxError) throw new EmError(e.reason === 'wrong-passphrase' ? 'EM-6305' : 'EM-6302', e.reason === 'wrong-passphrase' ? 'The passphrase does not open this backup.' : 'This file is not an Expertmotion backup.', { cause: e });
          throw e;
        }
      }
      try { reader = await ZipReader.open(zipFile); } catch (e) { throw new EmError('EM-6302', 'This file is not an Expertmotion backup.', { cause: e, details: { reason: e instanceof ZipError ? e.message : 'zip' } }); }
      const r = reader;
      const bad = (reason: string) => new EmError('EM-6302', 'This file is not an Expertmotion backup.', { details: { reason } });
      const me = r.get('manifest.json'); if (!me) throw bad('manifest missing');
      let manifest: Manifest;
      try { manifest = ManifestSchema.parse(JSON.parse((await r.readBuffer(me, 4 * 1024 ** 2)).toString('utf8'))); } catch (e) { if (e instanceof ZipError) throw bad(e.message); throw bad('manifest invalid'); }
      if (manifest.formatVersion > BACKUP_FORMAT_VERSION || manifest.modelSchemaVersion > 1) throw new EmError('EM-6302', `This backup was made by a newer version (${manifest.appVersion}).`, { details: { version: manifest.appVersion } });
      const listed = new Map(manifest.files.map((f) => [f.path, f]));
      for (const e of r.entries) if (e.name !== 'manifest.json' && !listed.has(e.name)) throw bad(`unlisted entry ${e.name}`);
      const entry = (name: string): ZipEntry => { const e = r.get(name); const f = listed.get(name); if (!e || !f || e.size !== f.bytes) throw bad(`missing ${name}`); return e; };
      const readJson = async (name: string): Promise<unknown> => {
        const b = await r.readBuffer(entry(name), JSON_MAX);
        if (crypto.createHash('sha256').update(b).digest('hex') !== listed.get(name)!.sha256) throw bad(`hash mismatch ${name}`);
        try { return JSON.parse(b.toString('utf8')); } catch { throw bad(`unreadable ${name}`); }
      };
      const parse = <T>(s: z.ZodType<T>, v: unknown, what: string): T => { const x = s.safeParse(v); if (!x.success) throw bad(`invalid ${what}`); return x.data; };
      const proj = parse(ProjectJson, await readJson('project.json'), 'project');
      const assets = parse(z.array(AssetJson).max(5000), await readJson('assets.json'), 'assets');
      const versions = [];
      for (const f of manifest.files.filter((x) => /^versions\/[A-Za-z0-9]+\.json$/.test(x.path))) versions.push(parse(VersionJson, await readJson(f.path), f.path));
      if (!versions.some((v) => v.id === proj.headVersionId)) throw bad('head version missing');
      const intents = parse(z.array(EditIntent).max(20_000), listed.has('intents.json') ? await readJson('intents.json') : [], 'intents');
      const plans = parse(z.array(PlanJson).max(5000), listed.has('plans.json') ? await readJson('plans.json') : [], 'plans');
      const conversations = parse(z.array(ConversationJson).max(2), listed.has('conversations.json') ? await readJson('conversations.json') : [], 'conversations');   // older backups have none
      this.notice('restore', jobId, { percent: 10, done: false });

      // Extract and verify media into staging before anything is imported.
      const mediaStage = path.join(staging, 'media'); await fsp.mkdir(mediaStage);
      const staged = new Map<string, string>();                      // zip path → staged file
      let k = 0;
      for (const a of assets) {
        for (const zp of [a.files.original, a.files.playable].filter((x): x is string => !!x)) {
          if (!zp.startsWith(`media/${a.id}/`)) throw bad('asset path');
          const e = entry(zp); const h = crypto.createHash('sha256');
          const dest = path.join(mediaStage, `${k++}${extOf(zp)}`);
          await r.extractTo(e, dest, (b) => h.update(b));
          if (h.digest('hex') !== listed.get(zp)!.sha256) throw bad(`hash mismatch ${zp}`);
          staged.set(zp, dest);
        }
      }
      this.notice('restore', jobId, { percent: 80, done: false });

      // Id mapping: keep ids unless they already exist (never overwrite).
      const db = this.ctx.db;
      const exists = (table: string, id: string) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
      const conflict = exists('projects', proj.id) || fs.existsSync(path.join(this.ctx.paths.media, proj.id));
      const pid = conflict ? this.ctx.newId() : proj.id;
      const map = (table: string) => { const m = new Map<string, string>(); return (old: string) => { let v = m.get(old); if (!v) { v = conflict || exists(table, old) ? this.ctx.newId() : old; m.set(old, v); } return v; }; };
      const aid = map('assets'), vid = map('composition_versions'), iid = map('edit_intents'), plid = map('edit_plans');
      const nameTaken = (n: string) => !!db.prepare('SELECT 1 FROM projects WHERE deleted_at IS NULL AND lower(trim(name)) = lower(trim(?))').get(n);
      let name = proj.name; const renamed = conflict || nameTaken(name);
      if (renamed) { let cand = `${proj.name} (restored)`; let i = 1; while (nameTaken(cand)) cand = `${proj.name} (restored ${++i})`; name = cand; }
      const assetIds = new Map(assets.map((a) => [a.id, aid(a.id)]));
      const remapModel = (raw: unknown): CompositionModelT => {
        const m = migrateModel(raw); if (!m.ok) throw bad('model invalid');
        const x = structuredClone(m.value); x.projectId = pid;
        const ma = (id: string) => assetIds.get(id) ?? id;
        for (const c of x.tracks.video) if (c.assetId !== undefined) c.assetId = ma(c.assetId);
        for (const o of x.tracks.overlay) if (o.kind === 'image') o.assetId = ma(o.assetId);
        for (const a of x.tracks.audio) a.assetId = ma(a.assetId);
        if (x.tracks.caption.sourceAssetId) x.tracks.caption.sourceAssetId = ma(x.tracks.caption.sourceAssetId);
        return x;
      };
      const vrows = versions.map((v) => { const model = remapModel(v.model); return { id: vid(v.id), oldId: v.id, parentOld: v.parentId, hash: hashModel(model), model, cause: v.cause, createdAt: v.createdAt, planOld: v.planId }; });
      const keptVersions = new Set(versions.map((v) => v.id));
      const keptPlans = plans.filter((p) => keptVersions.has(p.baseVersionId));
      const planIds = new Set(keptPlans.map((p) => p.id));
      finalMedia = path.join(this.ctx.paths.media, pid);
      if (fs.existsSync(finalMedia)) throw new EmError('EM-6303', 'A project with this identity already exists.', { details: { projectId: pid } });
      await fsp.mkdir(finalMedia, { recursive: true });
      const now = this.ctx.now();
      const assetRows: Array<z.infer<typeof AssetJson> & { nid: string; original: string; playable: string }> = [];
      for (const a of assets) {
        const nid = assetIds.get(a.id)!;
        await fsp.mkdir(path.join(finalMedia, nid), { recursive: true });
        const place = async (zp: string | undefined, kind: string) => {
          if (!zp) return null;
          const rel = `${pid}/${nid}/${kind}${extOf(zp)}`;
          await fsp.rename(staged.get(zp)!, path.join(this.ctx.paths.media, rel));
          return rel;
        };
        const original = (await place(a.files.original, 'original'))!;
        const playable = (await place(a.files.playable, 'playable')) ?? original;
        assetRows.push({ ...a, nid, original, playable });
      }
      const intentRows = intents.map((i): EditIntentT => ({ ...i, id: iid(i.id), projectId: pid, ...(i.parentIntentId ? { parentIntentId: iid(i.parentIntentId) } : {}), supersedes: i.supersedes.map(iid) }));
      db.transaction(() => {
        db.prepare('INSERT INTO projects (id, name, settings_json, head_version_id, language, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(pid, name, JSON.stringify(proj.settings), null, proj.language, proj.createdAt, now);
        const ia = db.prepare(`INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, playable_path, probe_json, duration_ms, width, height, fps, has_audio, status, sequence_badge, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?)`);
        for (const a of assetRows) ia.run(a.nid, pid, a.kind, a.name, a.sha256, a.bytes, a.original, a.playable, a.probe_json ?? null, a.duration_ms ?? null, a.width ?? null, a.height ?? null, a.fps ?? null, a.has_audio ?? null, a.sequence_badge ?? null, a.created_at, now);
        const iv = db.prepare('INSERT INTO composition_versions (id, project_id, parent_id, hash, model_json, cause, plan_id, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
        for (const v of vrows) iv.run(v.id, pid, null, v.hash, JSON.stringify(v.model), v.cause, null, deriveTiming(v.model).durationMs, v.createdAt);
        const up = db.prepare('UPDATE composition_versions SET parent_id = ?, plan_id = ? WHERE id = ?');
        for (const v of vrows) up.run(v.parentOld && keptVersions.has(v.parentOld) ? vid(v.parentOld) : null, v.planOld && planIds.has(v.planOld) ? plid(v.planOld) : null, v.id);
        db.prepare('UPDATE projects SET head_version_id = ? WHERE id = ?').run(vid(proj.headVersionId), pid);
        const ii = db.prepare('INSERT INTO edit_intents (id, project_id, intent_json, status, property_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
        for (const i of intentRows) ii.run(i.id, pid, JSON.stringify(i), i.status, i.propertyKey, i.createdAt, now);
        const ip = db.prepare('INSERT INTO edit_plans (id, project_id, base_version_id, origin, plan_json, status, agent_run_id, created_at, updated_at, intent_ids_json, message) VALUES (?,?,?,?,?,?,NULL,?,?,?,?)');
        for (const p of keptPlans) {
          const pl = EditPlan.safeParse(p.plan); if (!pl.success) continue;
          const status = p.status === 'executed' ? 'executed' : p.status === 'valid' ? 'stale' : p.status;
          ip.run(plid(p.id), pid, vid(p.baseVersionId), p.origin, JSON.stringify({ ...pl.data, id: plid(p.id), projectId: pid, status }), status, p.createdAt, now, JSON.stringify(p.intentIds.map(iid)), p.message);
        }
        const intentIdSet = new Set(intents.map((i) => i.id));
        const remapIds = (v: unknown): unknown => typeof v === 'string' ? assetIds.get(v) ?? (intentIdSet.has(v) ? iid(v) : v) : Array.isArray(v) ? v.map(remapIds)
          : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, remapIds(x)])) : v;
        const ic = db.prepare('INSERT INTO conversations (id, project_id, agent, summary_json, created_at, updated_at) VALUES (?,?,?,?,?,?)');
        const im = db.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, agent_run_id, created_at) VALUES (?,?,?,?,NULL,?)');
        for (const c of conversations) {
          const cid = this.ctx.newId();
          ic.run(cid, pid, c.agent, c.summary === undefined ? null : JSON.stringify(c.summary), c.createdAt, now);
          for (const m of c.messages) im.run(this.ctx.newId(), cid, m.role, JSON.stringify(remapIds(m.blocks)), m.createdAt);
        }
        db.prepare('INSERT INTO audit_log (at, event, project_id, details_json) VALUES (?,?,?,?)').run(now, 'project.restore', pid, JSON.stringify({ form: manifest.form, renamed }));
      })();
      finalMedia = undefined;                                         // committed: keep the media
      // FR-018: derived files (proxy, thumbnails, filmstrip, waveform) are not in the backup; ingest regenerates them from the originals.
      try { this.ctx.hooks.reingest?.(pid, assetRows.map((a) => a.nid)); } catch (e) { this.ctx.log.warn({ projectId: pid, err: String(e) }, 'restore: re-ingest not queued'); }
      this.notice('restore', jobId, { projectId: pid, percent: 100, done: true, ...(renamed ? { code: 'EM-6303', name } : {}) });
      return pid;
    } finally {
      await reader?.close().catch(() => {});
      if (finalMedia) await fsp.rm(finalMedia, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}
