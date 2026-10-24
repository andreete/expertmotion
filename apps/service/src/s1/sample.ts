// Onboarding-tour Sample Project (ONBOARDING_TOUR §2, API R-025): "Contoh · Kafe Senja" / "Sample · Kafe Senja" made from the
// bundled CC0 files in ctx.resources.sampleDir (packages/engine/scripts/build-sample.mjs). Created on demand (idempotent), the
// files go through the normal S2 ingest path, and once ingest settles one Composition Version inserts the three clips in order,
// imports the SRT as captions and sets the palette. The sample is hard-deleted (rows + media, no 30-day retention) as soon as the
// Creator creates or opens another project.
import fs from 'node:fs';
import path from 'node:path';
import type { OperationT } from '@expertmotion/composition-model';
import { EmError, errorMessage } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { canonicalImportPath } from '../modules/assets.js';
import { ingestOf, inspectSource } from '../s2/ingest.js';
import type { AssetRow } from '../s2/assets-repo.js';
import type { Projects } from './projects-svc.js';
import type { CompositionStore } from './store.js';

export const SAMPLE_FILES = ['clip-1.mp4', 'clip-2.mp4', 'clip-3.mp4', 'kafe-senja.srt'] as const;
export const SAMPLE_NAMES = { id: 'Contoh · Kafe Senja', en: 'Sample · Kafe Senja' } as const;
export const SAMPLE_PALETTE = 'preset:palette.editorial-dark';

export class SampleProjects {
  /** Preparation in flight per sample project (aborted when the sample is deleted). */
  private readonly preparing = new Map<string, AbortController>();
  constructor(private readonly ctx: ServiceContext, private readonly store: CompositionStore, private readonly projects: Projects) {}

  /** The live (not deleted) sample project id, if any. */
  current(): string | null {
    const r = this.ctx.db.prepare('SELECT id FROM projects WHERE is_sample = 1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1').get() as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** R-025. Returns the existing sample (created=false) or creates one and queues its preparation (created=true). */
  async create(language: 'id' | 'en'): Promise<{ created: boolean; project: ReturnType<CompositionStore['projectDto']> }> {
    const existing = this.current();
    if (existing) return { created: false, project: this.store.projectDto(existing) };
    const dir = this.ctx.resources.sampleDir;
    const missing = SAMPLE_FILES.filter((f) => !isFile(path.join(dir, f)));
    if (missing.length) {
      throw new EmError('EM-3001', 'Parts of Expertmotion needed for the sample project are missing. Reinstall Expertmotion to repair them.', { details: { missing, expectedPath: dir } });
    }
    // Everything up to the first await is synchronous, so a concurrent second request sees the row and answers 200.
    const p = this.projects.create({ name: this.freeName(SAMPLE_NAMES[language]), language, theme: { paletteId: SAMPLE_PALETTE } });
    this.ctx.db.prepare('UPDATE projects SET is_sample = 1 WHERE id = ?').run(p.id);
    const ac = new AbortController();
    this.preparing.set(p.id, ac);
    let rows: AssetRow[];
    try { rows = await this.importAll(p.id); } catch (e) {
      this.preparing.delete(p.id);
      this.remove(p.id);
      throw e;
    }
    void this.prepare(p.id, rows, ac.signal).catch(() => {}).finally(() => { if (this.preparing.get(p.id) === ac) this.preparing.delete(p.id); });
    return { created: true, project: this.store.projectDto(p.id) };
  }

  /** Service stop: abandon preparations in flight (the next start sees the sample with whatever ingest recovery produced). */
  shutdown(): void { for (const ac of this.preparing.values()) ac.abort(); this.preparing.clear(); }

  /** Hard-deletes every sample project except `keepId` (R-011 create, R-016 open of another project). */
  removeExcept(keepId: string): string[] {
    const ids = (this.ctx.db.prepare('SELECT id FROM projects WHERE is_sample = 1 AND id != ?').all(keepId) as Array<{ id: string }>).map((r) => r.id);
    return ids.filter((id) => this.remove(id));
  }

  private remove(id: string): boolean {
    this.preparing.get(id)?.abort();
    this.preparing.delete(id);
    const ingest = ingestOf(this.ctx);
    const assetIds = (this.ctx.db.prepare('SELECT id FROM assets WHERE project_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id);
    const settling = assetIds.map((a) => { const w = ingest.whenSettled(a); ingest.cancel(a); return w; });
    const ok = this.projects.hardDelete(id);
    // A cancelled FFmpeg step may still write into the asset folder for a moment: sweep the project folder once ingest settled.
    if (ok && settling.length) void Promise.race([Promise.all(settling), new Promise((r) => setTimeout(r, 30_000).unref())])
      .then(() => fs.promises.rm(path.join(this.ctx.paths.media, id), { recursive: true, force: true })).catch(() => {});
    return ok;
  }

  private freeName(base: string): string {
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base} (${i})`;
      try { this.store.assertNameFree(name); return name; } catch (e) { if (!(e instanceof EmError) || e.code !== 'EM-6103' || i > 50) throw e; }
    }
  }

  /** Same checks as R-030 (import root, type sniffing, capacity), then the ingest queue (copy + hash → probe → variants). */
  private async importAll(projectId: string): Promise<AssetRow[]> {
    const ingest = ingestOf(this.ctx);
    const rows: AssetRow[] = [];
    for (const name of SAMPLE_FILES) {
      const file = canonicalImportPath(path.join(this.ctx.resources.sampleDir, name), [this.ctx.resources.sampleDir]);
      const s = await inspectSource(file, name);
      await ingest.checkCapacity(projectId, s.bytes);
      rows.push(ingest.importFile({ projectId, source: file, name, kind: s.kind, bytes: s.bytes, ext: s.ext }));
    }
    return rows;
  }

  /** Waits for ingest, then one version: clips 1–3 in order, captions from the SRT, palette; then `service.notice {kind:'sample'}`. */
  private async prepare(projectId: string, rows: AssetRow[], signal: AbortSignal): Promise<void> {
    const ingest = ingestOf(this.ctx);
    const aborted = new Promise<'aborted'>((r) => { if (signal.aborted) r('aborted'); else signal.addEventListener('abort', () => r('aborted'), { once: true }); });
    const outcome = await Promise.race([Promise.all(rows.map((r) => ingest.whenSettled(r.id))), aborted]);
    if (outcome === 'aborted' || signal.aborted) return;
    try {
      const ready = outcome.map((o, i) => (o.status === 'ready' || o.status === 'duplicate') && o.row ? { ...o.row, file: SAMPLE_FILES[i]! } : null);
      const failed = outcome.flatMap((o, i) => (o.status === 'ready' || o.status === 'duplicate' ? [] : [{ name: SAMPLE_FILES[i]!, code: o.row?.error_code ?? null }]));
      const ops: OperationT[] = [];
      for (const r of ready) if (r && r.kind === 'video') ops.push({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: r.id } });
      for (const r of ready) if (r && r.kind === 'subtitle') ops.push({ op: 'op:caption.importSrt', target: { kind: 'project' }, args: { assetId: r.id } });
      ops.push({ op: 'op:theme.set', target: { kind: 'project' }, args: { paletteId: SAMPLE_PALETTE } });
      if (this.current() !== projectId) return;
      this.ctx.hooks.applyOps(projectId, ops, { kind: 'asset', summary: 'Sample project: Kafe Senja' });
      this.ctx.bus.emit('service.notice', { at: this.ctx.now(), kind: 'sample', projectId, ready: failed.length === 0, ...(failed.length ? { failed } : {}) });
    } catch (e) {
      if (signal.aborted) return;
      try { if (this.current() !== projectId) return; } catch { return; }
      this.ctx.log.warn({ projectId, err: errorMessage(e) }, 'sample project preparation failed');
      this.ctx.bus.emit('service.notice', { at: this.ctx.now(), kind: 'sample', projectId, ready: false, code: e instanceof EmError ? e.code : 'EM-9001' });
    }
  }
}

function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
