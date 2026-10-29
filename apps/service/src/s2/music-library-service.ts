// CC0 music library (FR-247, ADR-035; QA 2026-10-28 #9 / #10): a curated list of public-domain tracks (packages/models
// music-library.ts), each downloaded on demand like a Model Download — the egress module's `model-download` purpose (Hugging
// Face hosts only, Private Mode → EM-7006 / EM-8202), resume from `.part`, sha256 + exact size verified (SEC-074), retries with
// backoff (FR-245). Files live in `<models>/music-library/<id>.mp3`; Insert copies one into the project as an Asset and adds it as
// the music bed (preset:audio.bed-soft defaults) in one Composition Version.
import fs from 'node:fs';
import path from 'node:path';
import { EmError } from '@expertmotion/shared';
import { MUSIC_LIBRARY, MUSIC_LIBRARY_LICENCE, downloadFile, musicTrack, rankTracks, sha256File, type FetchLike, type MusicTrack } from '@expertmotion/models';
import type { ServiceContext } from '../context.js';
import { em, emit, freeBytes } from './common.js';
import { modelsServiceOf } from './models-service.js';

export interface TrackDto extends MusicTrack { status: 'not-downloaded' | 'downloading' | 'ready' | 'failed'; bytesDone: number; errorCode: string | null; licence: typeof MUSIC_LIBRARY_LICENCE }

export class MusicLibraryService {
  private readonly live = new Map<string, { bytesDone: number; ac: AbortController }>();
  private readonly failed = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly ctx: ServiceContext) {}
  dir(): string { return path.join(this.ctx.paths.models, 'music-library'); }
  filePath(t: MusicTrack): string { return path.join(this.dir(), t.file); }
  private partPath(t: MusicTrack): string { return path.join(this.dir(), '.partial', `${t.file}.part`); }
  isReady(t: MusicTrack): boolean { try { return fs.statSync(this.filePath(t)).size === t.bytes; } catch { return false; } }
  dto(t: MusicTrack): TrackDto {
    const l = this.live.get(t.id);
    let part = 0; try { part = fs.statSync(this.partPath(t)).size; } catch { /* none */ }
    const status = this.isReady(t) ? 'ready' : l ? 'downloading' : this.failed.has(t.id) ? 'failed' : 'not-downloaded';
    return { ...t, status, bytesDone: status === 'ready' ? t.bytes : l?.bytesDone ?? part, errorCode: this.failed.get(t.id) ?? null, licence: MUSIC_LIBRARY_LICENCE };
  }
  list(o: { mood?: string; q?: string } = {}): TrackDto[] {
    const base = o.mood ? MUSIC_LIBRARY.filter((t) => t.mood === o.mood) : MUSIC_LIBRARY;
    return (o.q ? rankTracks(o.q, base) : [...base]).map((t) => this.dto(t));
  }
  require(id: string): MusicTrack { const t = musicTrack(id); if (!t) throw em('EM-9003', 'Not found.'); return t; }

  /** Starts (or joins) the download of one track; resolves when it is verified on disk. One track at a time. */
  download(id: string): Promise<TrackDto> {
    const t = this.require(id);
    if (this.isReady(t)) return Promise.resolve(this.dto(t));
    if (this.ctx.settings.get().privateMode) return Promise.reject(em('EM-8202', 'Private Mode is on, so the music was not downloaded.', { details: { action: 'music download' } }));
    if (this.live.has(t.id)) return new Promise((resolve, reject) => { const h = setInterval(() => { if (!this.live.has(t.id)) { clearInterval(h); const d = this.dto(t); if (d.status === 'ready') resolve(d); else reject(em((d.errorCode ?? 'EM-7002') as 'EM-7002', 'The music download failed.')); } }, 200); h.unref?.(); });
    const entry = { bytesDone: 0, ac: new AbortController() };
    this.live.set(t.id, entry); this.failed.delete(t.id);
    const ctx = this.ctx;
    const fetchLike: FetchLike = (url, init) => ctx.egress.for('model-download')(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
    const run = async (): Promise<TrackDto> => {
      try {
        await downloadFile({ name: t.file, url: t.url, bytes: t.bytes, bytesExact: true, sha256: t.sha256, modelKey: `music:${t.id}` }, { partPath: this.partPath(t), destPath: this.filePath(t) }, {
          fetch: fetchLike, freeBytes, signal: entry.ac.signal, allowedHosts: modelsServiceOf(ctx).downloadHosts(), privateMode: () => ctx.settings.get().privateMode, minFreeBytes: 200_000_000,
          onProgress: (p) => { entry.bytesDone = p.bytesDone; emit(ctx, 'service.notice', { kind: 'music-library', trackId: t.id, status: 'downloading', percent: Math.floor((p.bytesDone / t.bytes) * 100) }); },
          onRetry: (r) => ctx.log.info({ track: t.id, attempt: r.attempt, reason: r.reason, httpStatus: r.httpStatus ?? null, netCode: r.netCode ?? null }, 'music download retrying'),
        });
        emit(ctx, 'service.notice', { kind: 'music-library', trackId: t.id, status: 'ready', percent: 100, done: true });
        return this.dto(t);
      } catch (e) {
        const code = e instanceof EmError ? e.code : 'EM-7002';
        const d = (e instanceof EmError && e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
        this.failed.set(t.id, code);
        ctx.log.warn({ track: t.id, code, reason: d['reason'] ?? null, httpStatus: d['httpStatus'] ?? null, netCode: d['netCode'] ?? null, host: d['host'] ?? null }, 'music download failed');
        emit(ctx, 'service.notice', { kind: 'music-library', trackId: t.id, status: 'failed', code, done: true, ...(d['reason'] ? { reason: d['reason'] } : {}) });
        throw e;
      } finally { this.live.delete(t.id); }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
  cancel(id: string): void { this.live.get(id)?.ac.abort(); }
  /** A verified file (re-hashed on demand when its size matches but it was never verified in this session). */
  /** track id → `size:mtime` of the file whose sha256 last verified (a few dozen short strings at most). */
  private readonly verified = new Map<string, string>();
  async readyFile(id: string): Promise<string> {
    const t = this.require(id);
    if (!this.isReady(t)) throw em('EM-7001', 'Download this track first.', { details: { trackId: id, bytes: t.bytes } });
    // A8: the hash is checked once per file version (size + mtime), not on every Range request of the audio route
    const file = this.filePath(t); const st = fs.statSync(file); const stamp = `${st.size}:${st.mtimeMs}`;
    if (this.verified.get(id) === stamp) return file;
    if ((await sha256File(file)) !== t.sha256) { this.verified.delete(id); fs.rmSync(file, { force: true }); throw em('EM-7108', 'The downloaded track is damaged; download it again.', { details: { trackId: id } }); }
    this.verified.set(id, stamp);
    return file;
  }
  /** The best downloaded track for a description, else the best one overall (downloaded first, FR-102 / FR-247). */
  async pickFor(description: string): Promise<MusicTrack> {
    const ranked = rankTracks(description);
    const ready = ranked.find((t) => this.isReady(t));
    if (ready) return ready;
    await this.download(ranked[0]!.id);
    return ranked[0]!;
  }
}
const services = new WeakMap<ServiceContext, MusicLibraryService>();
export const musicLibraryOf = (ctx: ServiceContext): MusicLibraryService => { let s = services.get(ctx); if (!s) { s = new MusicLibraryService(ctx); services.set(ctx, s); } return s; };
