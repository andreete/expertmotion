// Model Manager state for R-140…R-144 on top of packages/models (registry, installModel, readInstallState, removeModel):
// one download at a time through the single egress fetch (Private Mode gate, host allow-list), hash-verified, resumable,
// paused while a Standard/Accelerated render runs (FR-124, PERFORMANCE profiles). SEC-072: a signed `models.json` in the
// models folder overlays pinned files onto the registry after its Ed25519 signature verifies; otherwise the built-in copy is used.
// With an Operator model CDN in the build (services/model-cdn.ts) the manifest is fetched from `<cdn>/models.json` + `.sig`
// through the egress module (at most once per 24 h, on demand from R-140 / R-147), verified, then saved atomically into the
// models folder; downloads are then allowed from the CDN host only (SEC-071).
import fs from 'node:fs';
import path from 'node:path';
import { EmError, errorMessage } from '@expertmotion/shared';
import { ALL_PRESETS } from '@expertmotion/catalogue';
import { SIGNED_REGISTRY_FILE, SIGNED_REGISTRY_SIG_FILE, TIERS, applySignedRegistry, embeddedManifestKeys, getModel, installModel, isCancelled, isPinned, modelDir, partPath, readInstallState,
  registry, removeModel, requiredInstallBytes, verifySignedRegistry, type FetchLike, type ManifestKeyEntry, type ModelDef } from '@expertmotion/models';
import type { ServiceContext } from '../context.js';
import { MODEL_CDN_URL, manifestUrls, modelDownloadHosts } from '../services/model-cdn.js';
import { SerialQueue, em, emit, freeBytes, throttle } from './common.js';
import { s2 } from './state.js';

export interface ModelsOptions {
  /** Registry source (tests inject pinned fakes; the shipped registry has TO_PIN hashes until the Operator pins them). */
  registry?: () => readonly ModelDef[];
  freeBytes?: (dir: string) => Promise<number>;
  /** SEC-072 manifest public keys (tests inject a dev key; default: the embedded table, empty until the Operator sets it). */
  manifestKeys?: () => readonly ManifestKeyEntry[];
  /** FR-124: is a Standard/Accelerated render running? Default: render_jobs query. Polled every `pausePollMs` during a download. */
  renderBusy?: () => boolean;
  pausePollMs?: number;
  /** Operator model CDN base URL (default: the build's EM_MODEL_CDN_URL; null = none, built-in hosts). */
  cdnUrl?: string | null;
  now?: () => number;
}
type Status = 'not-installed' | 'downloading' | 'verifying' | 'paused' | 'installed' | 'failed';
type Live = { status: 'downloading' | 'verifying' | 'paused'; pausedReason?: 'render' | null; bytesDone: number; bytesTotal: number; ac: AbortController; paused?: boolean };
const RANK = { T0: 0, T1: 1, T2: 2 } as const;
/** Generator Cards that use a model, by task (FR-120 "used by"). */
const GENERATOR_OF: Record<string, string> = { stt: 'captions', tts: 'voice', image: 'thumbnail', music: 'music', library: 'music' };
export interface RegistrySource { source: 'built-in' | 'signed'; seq: number; code: 'EM-7111' | null; reason: string | null }
/** Last CDN manifest check (R-140 `registryUpdate`, R-147). */
export interface RegistryUpdate {
  cdn: string | null;
  /** Last check that got an answer from the CDN (persisted; the 24 h interval counts from here). */
  checkedAt: string | null;
  outcome: 'updated' | 'unchanged' | 'refused' | 'failed' | 'skipped' | null;
  code: 'EM-7111' | 'EM-8201' | 'EM-8202' | 'EM-8203' | null;
  reason: string | null;
  seq: number | null;
}
export const REGISTRY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a network failure or Private Mode, an automatic check is retried no sooner than this. */
export const REGISTRY_RETRY_MS = 15 * 60 * 1000;
export const REGISTRY_FETCH_TIMEOUT_MS = 10_000;
export const REGISTRY_MAX_BYTES = 2 * 1024 * 1024;
export const REGISTRY_SIG_MAX_BYTES = 4 * 1024;
const CHECKED_FILE = '.registry-checked';
class FetchProblem extends Error { constructor(readonly code: RegistryUpdate['code'], readonly reason: string) { super(reason); } }

export class ModelsService {
  private readonly queue = new SerialQueue();
  private readonly live = new Map<string, Live>();
  private signed: { source: RegistrySource; overlay: ((defs: readonly ModelDef[]) => ModelDef[]) | null } | null = null;
  /** FR-161: downloads paused by Private Mode (EM-7006); resumed automatically when it turns off. */
  private readonly paused = new Set<string>();
  private update: RegistryUpdate | null = null;
  private updating: Promise<RegistryUpdate> | null = null;
  private lastAttemptMs = -Infinity;
  constructor(private readonly ctx: ServiceContext, private readonly opts: ModelsOptions = {}) {}

  /** SEC-071: the CDN host only when the build has one, else the built-in allow-list. */
  cdnUrl(): string | null { return this.opts.cdnUrl === undefined ? MODEL_CDN_URL : this.opts.cdnUrl; }
  downloadHosts(): string[] { return modelDownloadHosts(this.cdnUrl()); }
  private nowMs(): number { return this.opts.now?.() ?? Date.now(); }

  pausedKeys(): string[] { return [...this.paused]; }
  /** Private Mode on: running downloads stop with EM-7006 (the `.part` stays); off: every paused download resumes from its `.part`. */
  onPrivateMode(on: boolean): void {
    if (on) { for (const [key, l] of this.live) { this.paused.add(key); l.paused = true; l.ac.abort(); } return; }
    const keys = [...this.paused]; this.paused.clear();
    for (const key of keys) {
      void this.install(key).then(() => this.ctx.log.info({ model: key }, 'paused download resumed'))
        .catch((e: unknown) => this.ctx.log.warn({ model: key, code: e instanceof EmError ? e.code : 'EM-7002' }, 'paused download could not resume'));
    }
  }

  /** SEC-072: reads `<models>/models.json` + `.sig` once (and on `reloadSignedRegistry`); refusals are logged with EM-7111. */
  private signedRegistry(): NonNullable<ModelsService['signed']> {
    if (this.signed) return this.signed;
    const dir = this.ctx.paths.models; const file = path.join(dir, SIGNED_REGISTRY_FILE); const seqFile = path.join(dir, '.registry-seq');
    const builtIn = (code: 'EM-7111' | null, reason: string | null) => ({ source: { source: 'built-in' as const, seq: 0, code, reason }, overlay: null });
    let bytes: Buffer;
    try { bytes = fs.readFileSync(file); } catch { return (this.signed = builtIn(null, null)); }
    let sig = ''; try { sig = fs.readFileSync(path.join(dir, SIGNED_REGISTRY_SIG_FILE), 'utf8'); } catch { /* unsigned */ }
    let lastSeq = 0; try { lastSeq = Number(fs.readFileSync(seqFile, 'utf8').trim()) || 0; } catch { /* first manifest */ }
    const r = sig ? verifySignedRegistry(bytes, sig, { ...(this.opts.manifestKeys ? { keys: this.opts.manifestKeys() } : {}), lastSeq }) : { ok: false as const, reason: 'unsigned' };
    if (!r.ok) {
      this.ctx.log.warn({ code: 'EM-7111', reason: r.reason }, 'model manifest not trusted; using the built-in registry');
      return (this.signed = builtIn('EM-7111', r.reason));
    }
    if (r.registry.seq > lastSeq) { try { fs.writeFileSync(seqFile, String(r.registry.seq)); } catch { /* read-only: the check still holds this session */ } }
    const reg = r.registry;
    return (this.signed = { source: { source: 'signed', seq: reg.seq, code: null, reason: null }, overlay: (defs) => applySignedRegistry(defs, reg, this.downloadHosts()) });
  }
  registrySource(): RegistrySource { return this.signedRegistry().source; }
  reloadSignedRegistry(): RegistrySource { this.signed = null; return this.registrySource(); }

  registryUpdate(): RegistryUpdate {
    if (!this.update) {
      let checkedAt: string | null = null;
      try { const t = fs.readFileSync(path.join(this.ctx.paths.models, CHECKED_FILE), 'utf8').trim(); if (!Number.isNaN(Date.parse(t))) checkedAt = t; } catch { /* never checked */ }
      this.update = { cdn: this.cdnUrl(), checkedAt, outcome: null, code: null, reason: null, seq: null };
    }
    return { ...this.update };
  }

  /**
   * Fetches `<cdn>/models.json` + `.sig` through the egress module (purpose model-download: Private Mode → EM-8202, host
   * allow-list, https), each capped (2 MB / 4 KB) within a 10 s budget; verifies with verifySignedRegistry (embedded manifest
   * keys, `seq` never older than the last accepted one); saves both files atomically into the models folder and reloads.
   * Without `force` it runs at most once per 24 h (and retries a network failure after 15 min). Every failure keeps the last
   * accepted manifest (or the built-in registry) and is logged; never throws.
   */
  async refreshRegistry(opts: { force?: boolean } = {}): Promise<RegistryUpdate> {
    const cur = this.registryUpdate();
    const cdn = this.cdnUrl();
    if (!cdn) return this.setUpdate({ ...cur, outcome: 'skipped', code: null, reason: 'no-cdn', seq: null });
    if (this.updating) return this.updating;
    if (!opts.force) {
      const now = this.nowMs();
      if (cur.checkedAt && now - Date.parse(cur.checkedAt) < REGISTRY_CHECK_INTERVAL_MS) return cur;
      if (now - this.lastAttemptMs < REGISTRY_RETRY_MS) return cur;
    }
    this.lastAttemptMs = this.nowMs();
    this.updating = this.fetchRegistry(cdn).finally(() => { this.updating = null; });
    return this.updating;
  }

  private setUpdate(u: RegistryUpdate): RegistryUpdate { this.update = u; return { ...u }; }

  private markChecked(): string {
    const at = new Date(this.nowMs()).toISOString();
    try { fs.mkdirSync(this.ctx.paths.models, { recursive: true }); fs.writeFileSync(path.join(this.ctx.paths.models, CHECKED_FILE), at); } catch { /* read-only: in memory for this session */ }
    return at;
  }

  private async fetchBody(url: string, max: number, signal: AbortSignal): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.ctx.egress.for('model-download')(url, { method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, redirect: 'manual', signal });
    } catch (e) {
      if (e instanceof EmError && (e.code === 'EM-8202' || e.code === 'EM-8203')) throw new FetchProblem(e.code, e.code === 'EM-8202' ? 'private' : 'host-not-allowed');
      throw new FetchProblem('EM-8201', signal.aborted ? 'timeout' : 'network');
    }
    if (res.status !== 200) { void res.body?.cancel().catch(() => undefined); throw new FetchProblem('EM-7111', `http-${res.status}`); }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) { void res.body?.cancel().catch(() => undefined); throw new FetchProblem('EM-7111', 'too-large'); }
    if (!res.body) return Buffer.alloc(0);
    const chunks: Buffer[] = []; let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) { void reader.cancel().catch(() => undefined); throw new FetchProblem('EM-7111', 'too-large'); }
        chunks.push(Buffer.from(value));
      }
    } catch (e) {
      if (e instanceof FetchProblem) throw e;
      throw new FetchProblem('EM-8201', signal.aborted ? 'timeout' : 'network');
    }
    return Buffer.concat(chunks, total);
  }

  private async fetchRegistry(cdn: string): Promise<RegistryUpdate> {
    const log = this.ctx.log; const cur = this.registryUpdate();
    const keys = this.opts.manifestKeys?.() ?? embeddedManifestKeys();
    if (!keys.length) {
      log.warn({ code: 'EM-7111', reason: 'no-keys' }, 'model manifest check skipped: no manifest public key in this build');
      return this.setUpdate({ ...cur, cdn, outcome: 'skipped', code: 'EM-7111', reason: 'no-keys', seq: null });
    }
    const urls = manifestUrls(cdn);
    const signal = AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS);
    let bytes: Buffer; let sig: Buffer;
    try {
      bytes = await this.fetchBody(urls.manifest, REGISTRY_MAX_BYTES, signal);
      sig = await this.fetchBody(urls.signature, REGISTRY_SIG_MAX_BYTES, signal);
    } catch (e) {
      const p = e instanceof FetchProblem ? e : new FetchProblem('EM-8201', 'network');
      const answered = p.code === 'EM-7111';                                   // the CDN answered (HTTP status, oversize): counts as a check
      const at = answered ? this.markChecked() : cur.checkedAt;
      (p.code === 'EM-8202' ? log.info.bind(log) : log.warn.bind(log))({ code: p.code, reason: p.reason, host: new URL(cdn).hostname }, 'model manifest check failed; keeping the current model list');
      return this.setUpdate({ ...cur, cdn, checkedAt: at, outcome: p.code === 'EM-8202' ? 'skipped' : 'failed', code: p.code, reason: p.reason, seq: null });
    }
    const dir = this.ctx.paths.models;
    let lastSeq = 0; try { lastSeq = Number(fs.readFileSync(path.join(dir, '.registry-seq'), 'utf8').trim()) || 0; } catch { /* none accepted yet */ }
    const source = this.registrySource();
    if (source.source === 'signed') lastSeq = Math.max(lastSeq, source.seq);
    const r = verifySignedRegistry(bytes, sig.toString('utf8'), { keys, lastSeq });
    const checkedAt = this.markChecked();
    if (!r.ok) {
      log.warn({ code: 'EM-7111', reason: r.reason, lastSeq }, 'model manifest from the CDN not trusted; keeping the current model list');
      return this.setUpdate({ ...cur, cdn, checkedAt, outcome: 'refused', code: 'EM-7111', reason: r.reason, seq: null });
    }
    if (source.source === 'signed' && r.registry.seq <= source.seq) {
      return this.setUpdate({ ...cur, cdn, checkedAt, outcome: 'unchanged', code: null, reason: null, seq: source.seq });
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(path.join(dir, SIGNED_REGISTRY_FILE + tmp), bytes);
      fs.writeFileSync(path.join(dir, SIGNED_REGISTRY_SIG_FILE + tmp), sig);
      fs.renameSync(path.join(dir, SIGNED_REGISTRY_FILE + tmp), path.join(dir, SIGNED_REGISTRY_FILE));      // a crash between the two renames leaves
      fs.renameSync(path.join(dir, SIGNED_REGISTRY_SIG_FILE + tmp), path.join(dir, SIGNED_REGISTRY_SIG_FILE)); // a pair that fails to verify → built-in, next check repairs it
    } catch (e) {
      log.warn({ code: 'EM-7111', reason: 'save-failed', err: errorMessage(e).slice(0, 200) }, 'model manifest could not be saved; keeping the current model list');
      return this.setUpdate({ ...cur, cdn, checkedAt, outcome: 'failed', code: 'EM-7111', reason: 'save-failed', seq: null });
    }
    const now = this.reloadSignedRegistry();
    if (now.source !== 'signed') return this.setUpdate({ ...cur, cdn, checkedAt, outcome: 'refused', code: 'EM-7111', reason: now.reason, seq: null });
    log.info({ seq: now.seq, kid: r.kid }, 'model manifest updated from the CDN');
    return this.setUpdate({ ...cur, cdn, checkedAt, outcome: 'updated', code: null, reason: null, seq: now.seq });
  }

  defs(): ModelDef[] {
    const base = (this.opts.registry?.() ?? Object.values(registry)).filter((d) => d.availability === 'download');
    const o = this.signedRegistry().overlay;
    return o ? o(base) : base;
  }
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
      errorCode: status === 'failed' ? row?.error_code ?? null : this.paused.has(def.key) && status === 'not-installed' ? 'EM-7006' : null, installedAt: installed ? st.manifest!.installedAt : null,
      ...this.card(def, l) };
  }

  /** FR-121 model card, FR-123 recommended mark, FR-120 used-by, FR-124 pause reason. */
  private card(def: ModelDef, l: Live | undefined): Record<string, unknown> {
    // Bundled rows of the same engine/task, e.g. espeak-ng (GPL-3) inside the sherpa-onnx TTS engine (ADR-009).
    const engineNotices = Object.values(registry).filter((b) => b.availability === 'bundled' && b.engine === def.engine && b.task === def.task)
      .map((b) => ({ label: b.label, licence: b.licence.name, spdx: b.licence.spdx ?? null, url: b.licence.url }));
    const flag = def.flag;
    const presets = flag ? ALL_PRESETS.filter((p) => (p.flags as readonly string[]).includes(flag)).map((p) => p.id) : [];
    return { pausedReason: l?.pausedReason ?? null, recommended: def.recommendedFor.includes(this.ctx.hooks.tier()), priority: def.priority, languages: [...def.languages], notes: [...def.notes],
      commercialUse: def.commercialUse, licenceDetail: { spdx: def.licence.spdx ?? null, redistribution: def.licence.redistribution, useRestrictions: def.licence.useRestrictions ?? null },
      sourceUrl: def.files[0]?.url ?? def.licence.url, hashes: def.files.map((f) => ({ name: f.name, sha256: /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : null })),
      pathLabel: `models\\${def.engine}\\${def.key}\\`, usedBy: { generators: GENERATOR_OF[def.task] ? [GENERATOR_OF[def.task]!] : [], presets }, engineNotices,
      ramBytes: def.ramBytes, vramBytes: def.vramBytes ?? null };
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
    const ctx = this.ctx; let def = this.require(key);
    if (!isPinned(def) && !ctx.settings.get().privateMode && this.cdnUrl()) { await this.refreshRegistry(); def = this.require(key); }   // not pinned yet: the CDN list may pin it
    if (ctx.settings.get().privateMode) throw em('EM-8202', 'Private Mode is on, so the model download was not started.', { details: { action: 'model download' } });
    if (this.live.has(def.key) || this.queue.has(def.key)) throw em('EM-7104', `${def.label} is already being downloaded.`, { status: 409, details: { modelId: def.key } });
    if (!isPinned(def)) throw em('EM-7110', `${def.label} has no pinned checksum yet, so it cannot be verified.`, { details: { modelId: def.key, reason: 'unpinned' } });
    const st = await readInstallState(def, ctx.paths.models);
    if (st.manifest?.state === 'installed') return this.dto(def);
    const free = await (this.opts.freeBytes ?? freeBytes)(ctx.paths.models);
    const need = requiredInstallBytes(Math.max(0, def.bytes - st.partialBytes));
    if (free < need) throw em('EM-7004', `${def.label} needs more free disk space.`, { details: { modelId: def.key, needBytes: need, freeBytes: free } });
    const entry: Live = { status: 'downloading', pausedReason: null, bytesDone: st.partialBytes, bytesTotal: def.bytes, ac: new AbortController() };
    this.live.set(def.key, entry);
    this.upsert(def, 'downloading', { bytesDone: st.partialBytes });
    this.queue.enqueue(def.key, () => this.download(def, entry));
    return this.dto(def);
  }

  /** FR-124: background downloads give way to Standard/Accelerated renders (Turbo leaves them running). */
  renderBusy(): boolean {
    if (this.opts.renderBusy) return this.opts.renderBusy();
    try { return !!this.ctx.db.prepare("SELECT 1 FROM render_jobs WHERE status = 'rendering' AND performance_profile IN ('standard','accelerated') LIMIT 1").get(); } catch { return false; }
  }

  private async download(def: ModelDef, entry: Live): Promise<void> {
    const ctx = this.ctx; const tick = throttle(500); const pollMs = this.opts.pausePollMs ?? 2000;
    const fetchLike: FetchLike = (url, init) => ctx.egress.for('model-download')(url, init as RequestInit) as unknown as ReturnType<FetchLike>;   // SEC-080: model hosts only
    const cancelled = () => Object.assign(new Error('cancelled'), { name: 'CancelledError' });
    const progress = () => emit(ctx, 'model.progress', { key: def.key, bytesDone: entry.bytesDone, bytesTotal: entry.bytesTotal, status: entry.status, ...(entry.pausedReason ? { pausedReason: entry.pausedReason } : {}) });
    try {
      let manifest: Awaited<ReturnType<typeof installModel>> | null = null;
      while (!manifest) {
        if (entry.ac.signal.aborted) throw cancelled();
        if (this.renderBusy()) {                                                    // FR-124 paused during render; resumes from the .part file
          entry.status = 'paused'; entry.pausedReason = 'render'; progress();
          await new Promise<void>((resolve) => { const h = setInterval(() => { if (entry.ac.signal.aborted || !this.renderBusy()) { clearInterval(h); resolve(); } }, pollMs); h.unref?.(); });
          if (entry.ac.signal.aborted) throw cancelled();
          entry.status = 'downloading'; entry.pausedReason = null; progress();
          continue;
        }
        const sub = new AbortController(); const link = () => sub.abort(); let yielded = false;
        entry.ac.signal.addEventListener('abort', link, { once: true });
        const watch = setInterval(() => { if (this.renderBusy()) { yielded = true; sub.abort(); } }, pollMs); watch.unref?.();
        try {
          manifest = await installModel(def, {
            modelsDir: ctx.paths.models, fetch: fetchLike, freeBytes: this.opts.freeBytes ?? freeBytes, signal: sub.signal, allowedHosts: this.downloadHosts(),
            privateMode: () => ctx.settings.get().privateMode,
            onProgress: (p) => {
              entry.bytesDone = p.bytesDone; entry.status = p.bytesDone >= p.bytesTotal ? 'verifying' : 'downloading';
              if (tick(entry.status === 'verifying')) emit(ctx, 'model.progress', { key: def.key, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, status: entry.status });
            },
          });
        } catch (e) {
          if (yielded && !entry.ac.signal.aborted) continue;                       // a render started: loop back into the pause
          throw e;
        } finally { clearInterval(watch); entry.ac.signal.removeEventListener('abort', link); }
      }
      this.live.delete(def.key);
      this.upsert(def, 'installed', { bytesDone: def.bytes, installedAt: manifest.installedAt });
      // FR-037: picks held for this model resume first, so the queue the Editor sees after `model.installed` is already current.
      if (def.flag) { try { ctx.hooks.onModelInstalled?.(def.flag); } catch (e) { ctx.log.warn({ model: def.key, err: String(e) }, 'held picks could not resume'); } }
      emit(ctx, 'model.installed', { model: await this.dto(def) });
    } catch (e) {
      this.live.delete(def.key);
      if ((entry as { paused?: boolean }).paused) {
        this.upsert(def, 'not-installed', { bytesDone: entry.bytesDone });
        emit(ctx, 'model.failed', { key: def.key, code: 'EM-7006', paused: true });
        return;
      }
      if (isCancelled(e) || entry.ac.signal.aborted || (e as Error)?.name === 'CancelledError') { this.upsert(def, 'not-installed', { bytesDone: entry.bytesDone }); return; }
      const code = e instanceof EmError ? e.code : 'EM-7002';
      if (code === 'EM-7006') { this.paused.add(def.key); this.upsert(def, 'not-installed', { bytesDone: entry.bytesDone }); }
      else this.upsert(def, 'failed', { bytesDone: entry.bytesDone, errorCode: code });
      ctx.log.warn({ model: def.key, code, err: errorMessage(e).slice(0, 300) }, 'model download failed');
      emit(ctx, 'model.failed', { key: def.key, code });
    }
  }

  /** R-143: aborts; the `.part` file stays for resume (Pause), or is deleted with `discard` (Cancel, FR-124). */
  async cancel(key: string, discard = false): Promise<Record<string, unknown>> {
    const def = this.require(key);
    this.paused.delete(def.key);
    const l = this.live.get(def.key);
    if (l) { l.ac.abort(); if (this.queue.remove(def.key)) { this.live.delete(def.key); this.upsert(def, 'not-installed', { bytesDone: l.bytesDone }); } }
    const deadline = Date.now() + 5000;
    while (this.live.has(def.key) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (discard && def.files[0] && !(await this.isInstalled(def.key))) {
      await fs.promises.rm(path.dirname(partPath(this.ctx.paths.models, def, def.files[0].name)), { recursive: true, force: true });
      this.upsert(def, 'not-installed', { bytesDone: 0 });
    }
    return this.dto(def);
  }

  /** FR-130 workload rows for running, paused and queued downloads. */
  workload(): Array<{ key: string; label: string; status: Live['status']; pausedReason: 'render' | null; bytesDone: number; bytesTotal: number }> {
    const labels = new Map(this.defs().map((d) => [d.key, d.label]));
    return [...this.live.entries()].map(([key, l]) => ({ key, label: labels.get(key) ?? key, status: l.status, pausedReason: l.pausedReason ?? null, bytesDone: l.bytesDone, bytesTotal: l.bytesTotal }));
  }

  /** FR-126 per-engine models folder (created on demand) for the Shell to open in Explorer. */
  engineDir(engine: string): string {
    if (!this.defs().some((d) => d.engine === engine)) throw em('EM-9003', 'Not found.');
    const dir = path.join(path.resolve(this.ctx.paths.models), engine);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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
