// Model Manager state for R-140…R-144 on top of packages/models (registry, installModel, readInstallState, removeModel):
// one download at a time through the single egress fetch (Private Mode gate, host allow-list), hash-verified, resumable.
import { EmError, errorMessage } from '@expertmotion/shared';
import { TIERS, allowedHosts, getModel, installModel, isCancelled, isPinned, modelDir, readInstallState, registry, removeModel, requiredInstallBytes,
  type FetchLike, type ModelDef } from '@expertmotion/models';
import type { ServiceContext } from '../context.js';
import { SerialQueue, em, emit, freeBytes, throttle } from './common.js';
import { s2 } from './state.js';

export interface ModelsOptions {
  /** Registry source (tests inject pinned fakes; the shipped registry has TO_PIN hashes until the Operator pins them). */
  registry?: () => readonly ModelDef[];
  freeBytes?: (dir: string) => Promise<number>;
}
type Status = 'not-installed' | 'downloading' | 'verifying' | 'installed' | 'failed';
const RANK = { T0: 0, T1: 1, T2: 2 } as const;

export class ModelsService {
  private readonly queue = new SerialQueue();
  private readonly live = new Map<string, { status: 'downloading' | 'verifying'; bytesDone: number; bytesTotal: number; ac: AbortController }>();
  constructor(private readonly ctx: ServiceContext, private readonly opts: ModelsOptions = {}) {}

  defs(): ModelDef[] { return (this.opts.registry?.() ?? Object.values(registry)).filter((d) => d.availability === 'download'); }
  def(key: string): ModelDef | undefined { const list = this.defs(); return list.find((d) => d.key === key) ?? (this.opts.registry ? undefined : (() => { const d = getModel(key); return d && d.availability === 'download' ? d : undefined; })()); }
  require(key: string): ModelDef { const d = this.def(key); if (!d) throw em('EM-9003', 'Not found.'); return d; }

  async isInstalled(key: string): Promise<boolean> { const d = this.def(key); if (!d) return false; return (await readInstallState(d, this.ctx.paths.models)).manifest?.state === 'installed'; }
  async installedFlags(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const d of this.defs()) if (d.flag && (await readInstallState(d, this.ctx.paths.models).catch(() => null))?.manifest?.state === 'installed') out.add(d.flag);
    return out;
  }
  dirOf(def: ModelDef): string { return modelDir(this.ctx.paths.models, def); }

  async dto(def: ModelDef): Promise<Record<string, unknown>> {
    const st = await readInstallState(def, this.ctx.paths.models).catch(() => ({ manifest: null, partialBytes: 0 }));
    const row = this.ctx.db.prepare('SELECT status, error_code FROM models WHERE key = ?').get(def.key) as { status: Status; error_code: string | null } | undefined;
    const l = this.live.get(def.key);
    const installed = st.manifest?.state === 'installed';
    const status: Status = l ? l.status : installed ? 'installed' : row?.status === 'failed' ? 'failed' : 'not-installed';
    return { key: def.key, engine: def.engine, version: def.version, task: def.task === 'library' ? 'music' : def.task, label: def.label, licence: { name: def.licence.name, url: def.licence.url },
      tiers: TIERS.filter((t) => RANK[t] >= RANK[def.minTier]), bytesTotal: def.bytes, bytesDone: l ? l.bytesDone : installed ? def.bytes : st.partialBytes, status,
      errorCode: status === 'failed' ? row?.error_code ?? null : null, installedAt: installed ? st.manifest!.installedAt : null };
  }

  private upsert(def: ModelDef, status: Status, extra: { bytesDone?: number; errorCode?: string | null; installedAt?: string | null } = {}): void {
    this.ctx.db.prepare(`INSERT INTO models (key, engine, version, status, bytes_total, bytes_done, path, installed_at, error_code, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET status = excluded.status, bytes_total = excluded.bytes_total, bytes_done = excluded.bytes_done, installed_at = excluded.installed_at,
      error_code = excluded.error_code, updated_at = excluded.updated_at`).run(def.key, def.engine, def.version, status, def.bytes, extra.bytesDone ?? 0, this.dirOf(def),
      extra.installedAt ?? null, extra.errorCode ?? null, this.ctx.now());
  }

  /** Restart: downloads in flight are no longer running (partials are kept for resume). */
  recover(): void { this.ctx.db.prepare("UPDATE models SET status = 'not-installed', updated_at = ? WHERE status IN ('downloading','verifying')").run(this.ctx.now()); }

  async install(key: string): Promise<Record<string, unknown>> {
    const ctx = this.ctx; const def = this.require(key);
    if (ctx.settings.get().privateMode) throw em('EM-8202', 'Private Mode is on, so the model download was not started.', { details: { action: 'model download' } });
    if (this.live.has(def.key) || this.queue.has(def.key)) throw em('EM-7104', `${def.label} is already being downloaded.`, { status: 409, details: { modelId: def.key } });
    if (!isPinned(def)) throw em('EM-7110', `${def.label} has no pinned checksum yet, so it cannot be verified.`, { details: { modelId: def.key, reason: 'unpinned' } });
    const st = await readInstallState(def, ctx.paths.models);
    if (st.manifest?.state === 'installed') return this.dto(def);
    const free = await (this.opts.freeBytes ?? freeBytes)(ctx.paths.models);
    const need = requiredInstallBytes(Math.max(0, def.bytes - st.partialBytes));
    if (free < need) throw em('EM-7004', `${def.label} needs more free disk space.`, { details: { modelId: def.key, needBytes: need, freeBytes: free } });
    const entry = { status: 'downloading' as const, bytesDone: st.partialBytes, bytesTotal: def.bytes, ac: new AbortController() };
    this.live.set(def.key, entry);
    this.upsert(def, 'downloading', { bytesDone: st.partialBytes });
    this.queue.enqueue(def.key, () => this.download(def, entry));
    return this.dto(def);
  }

  private async download(def: ModelDef, entry: { status: 'downloading' | 'verifying'; bytesDone: number; bytesTotal: number; ac: AbortController }): Promise<void> {
    const ctx = this.ctx; const tick = throttle(500);
    const fetchLike: FetchLike = (url, init) => ctx.egress.fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
    try {
      if (entry.ac.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'CancelledError' });
      const manifest = await installModel(def, {
        modelsDir: ctx.paths.models, fetch: fetchLike, freeBytes: this.opts.freeBytes ?? freeBytes, signal: entry.ac.signal, allowedHosts: allowedHosts(),
        privateMode: () => ctx.settings.get().privateMode,
        onProgress: (p) => {
          entry.bytesDone = p.bytesDone; entry.status = p.bytesDone >= p.bytesTotal ? 'verifying' : 'downloading';
          if (tick(entry.status === 'verifying')) emit(ctx, 'model.progress', { key: def.key, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, status: entry.status });
        },
      });
      this.live.delete(def.key);
      this.upsert(def, 'installed', { bytesDone: def.bytes, installedAt: manifest.installedAt });
      emit(ctx, 'model.installed', { model: await this.dto(def) });
    } catch (e) {
      this.live.delete(def.key);
      if (isCancelled(e) || entry.ac.signal.aborted || (e as Error)?.name === 'CancelledError') { this.upsert(def, 'not-installed', { bytesDone: entry.bytesDone }); return; }
      const code = e instanceof EmError ? e.code : 'EM-7002';
      if (code === 'EM-7006') this.upsert(def, 'not-installed', { bytesDone: entry.bytesDone });
      else this.upsert(def, 'failed', { bytesDone: entry.bytesDone, errorCode: code });
      ctx.log.warn({ model: def.key, code, err: errorMessage(e).slice(0, 300) }, 'model download failed');
      emit(ctx, 'model.failed', { key: def.key, code });
    }
  }

  /** R-143: aborts; the `.part` file stays for resume. */
  async cancel(key: string): Promise<Record<string, unknown>> {
    const def = this.require(key);
    const l = this.live.get(def.key);
    if (l) { l.ac.abort(); if (this.queue.remove(def.key)) { this.live.delete(def.key); this.upsert(def, 'not-installed', { bytesDone: l.bytesDone }); } }
    const deadline = Date.now() + 5000;
    while (this.live.has(def.key) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return this.dto(def);
  }

  /** R-144: EM-7104 while a generator job uses the model; a running download is cancelled first. */
  async remove(key: string): Promise<void> {
    const def = this.require(key);
    if ((s2(this.ctx).modelsInUse.get(def.key) ?? 0) > 0) throw em('EM-7104', `${def.label} is being used by a running task.`, { status: 409, details: { modelId: def.key } });
    if (this.live.has(def.key)) await this.cancel(def.key);
    await removeModel(def, this.ctx.paths.models);
    this.ctx.db.prepare('DELETE FROM models WHERE key = ?').run(def.key);
  }
  idle(): Promise<void> { return this.queue.idle(); }
}

export const modelsServiceOf = (ctx: ServiceContext, opts?: ModelsOptions): ModelsService => (s2(ctx).models ??= new ModelsService(ctx, opts));
