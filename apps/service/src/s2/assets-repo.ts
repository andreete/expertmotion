// `assets` table access (DATABASE_SCHEMA §3 owns the DDL) and the AssetDto mapping (API_SPECIFICATION §3).
import type { AssetFacts, CaptionPageT } from '@expertmotion/composition-model';
import type { ServiceContext } from '../context.js';
import { em } from './common.js';
import type { AssetKind } from './probe.js';

export interface AssetRow {
  id: string; project_id: string; kind: AssetKind; name: string; sha256: string; bytes: number; original_path: string; playable_path: string | null;
  proxy_path: string | null; thumb_path: string | null; filmstrip_path: string | null; waveform_path: string | null; probe_json: string | null;
  duration_ms: number | null; width: number | null; height: number | null; fps: number | null; has_audio: number | null; status: 'ingesting' | 'ready' | 'failed';
  error_code: string | null; sequence_badge: number | null; created_at: string; updated_at: string;
  /** FR-052 soft delete (migration 21): set by Remove Asset while Composition Versions still reference the asset. */
  deleted_at?: string | null;
  /** FR-041 path-import identity digest (migration 21). */
  source_key?: string | null;
  /** FR-300 … FR-307 (migration 35): credit (author / site / URL) and licence text of a picture, clip or screenshot imported from the internet. */
  credit?: string | null;
  licence?: string | null;
}
export const VARIANTS = ['original', 'playable', 'proxy', 'thumb', 'filmstrip', 'waveform'] as const;
export type Variant = (typeof VARIANTS)[number];
export const variantColumn: Record<Variant, keyof AssetRow> = { original: 'original_path', playable: 'playable_path', proxy: 'proxy_path', thumb: 'thumb_path', filmstrip: 'filmstrip_path', waveform: 'waveform_path' };

export function getAsset(ctx: ServiceContext, id: string, projectId?: string): AssetRow | undefined {
  const r = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
  return r && (projectId === undefined || r.project_id === projectId) ? r : undefined;
}
export function requireAsset(ctx: ServiceContext, projectId: string, id: string): AssetRow {
  const r = getAsset(ctx, id, projectId);
  if (!r || r.deleted_at) throw em('EM-9003', 'Not found.');
  return r;
}
/** Live assets of a project; `includeDeleted` adds soft-deleted rows (FR-052: their facts stay valid for Undo). */
export function listAssets(ctx: ServiceContext, projectId: string, opts: { includeDeleted?: boolean } = {}): AssetRow[] {
  return ctx.db.prepare(`SELECT * FROM assets WHERE project_id = ?${opts.includeDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY created_at, id`).all(projectId) as AssetRow[];
}

const CODEC_LABEL: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', prores: 'ProRes', mpeg4: 'MPEG-4', mjpeg: 'JPEG', png: 'PNG', webp: 'WebP', gif: 'GIF',
  aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', pcm_s16le: 'PCM', pcm_s24le: 'PCM' };
/** FR-043: human codec label of the first video stream (else the first audio stream) from the stored ffprobe JSON. */
export function codecOf(probeJson: string | null): string | null {
  if (!probeJson) return null;
  try {
    const j = JSON.parse(probeJson) as { streams?: Array<{ codec_type?: string; codec_name?: string; disposition?: { attached_pic?: number } }> };
    const s = j.streams?.find((x) => x.codec_type === 'video' && !x.disposition?.attached_pic) ?? j.streams?.find((x) => x.codec_type === 'audio');
    return s?.codec_name ? (CODEC_LABEL[s.codec_name] ?? s.codec_name.toUpperCase()) : null;
  } catch { return null; }
}

/** `missing` (FR-048): the stored original is not on disk; computed by the caller, which knows the media root. */
export function toAssetDto(r: AssetRow, progress: number | undefined, withProbe = false, missing = false): Record<string, unknown> {
  let probe: unknown;
  if (withProbe && r.probe_json) { try { probe = JSON.parse(r.probe_json); } catch { probe = undefined; } }
  return {
    id: r.id, projectId: r.project_id, kind: r.kind, name: r.name, bytes: r.bytes, sha256: r.sha256.startsWith('pending-') || r.sha256.startsWith('failed-') ? '' : r.sha256, status: r.status,
    progress: r.status === 'ready' ? 1 : (progress ?? 0), errorCode: r.error_code, durationMs: r.duration_ms, width: r.width, height: r.height, fps: r.fps,
    hasAudio: r.has_audio === null ? null : r.has_audio === 1, sequenceBadge: r.sequence_badge, codec: codecOf(r.probe_json), missing,
    media: { original: true, playable: !!r.playable_path, proxy: !!r.proxy_path, thumb: !!r.thumb_path, filmstrip: !!r.filmstrip_path, waveform: !!r.waveform_path },
    ...(probe === undefined ? {} : { probe }), ...(r.credit ? { credit: r.credit } : {}), ...(r.licence ? { licence: r.licence } : {}), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Subtitle assets keep their parsed pages in probe_json `{ subtitle: { pages } }` (no ffprobe for text files). */
function captionPagesOf(r: AssetRow): CaptionPageT[] | undefined {
  if (r.kind !== 'subtitle' || !r.probe_json) return undefined;
  try { const j = JSON.parse(r.probe_json) as { subtitle?: { pages?: CaptionPageT[] } }; return j.subtitle?.pages; } catch { return undefined; }
}
export function toFacts(r: AssetRow): AssetFacts {
  const f: AssetFacts = { id: r.id, kind: r.kind, status: r.status, name: r.name };
  if (r.duration_ms !== null) f.durationMs = r.duration_ms;
  if (r.width !== null) f.width = r.width;
  if (r.height !== null) f.height = r.height;
  if (r.has_audio !== null) f.hasAudio = r.has_audio === 1;
  const pages = captionPagesOf(r); if (pages) f.captionPages = pages;
  return f;
}

/**
 * FR-261: what a video / audio asset says, in SOURCE time, from the newest finished transcription that covered it (Generate
 * Captions on the asset, captions of the Sequence, the footage read of an Editor run): `sources` in the job result. Pages →
 * segments, their tokens → words. Older jobs without `sources` are ignored. At most ~4000 words per asset.
 */
export function withTranscripts(ctx: ServiceContext, projectId: string, facts: AssetFacts[]): AssetFacts[] {
  if (!facts.some((f) => f.kind === 'video' || f.kind === 'audio')) return facts;
  let rows: Array<{ result_json: string | null }> = [];
  try { rows = ctx.db.prepare("SELECT result_json FROM generator_jobs WHERE project_id = ? AND kind = 'captions' AND status = 'done' ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 30").all(projectId) as typeof rows; } catch { return facts; }
  const found = new Map<string, NonNullable<AssetFacts['transcript']>>();
  for (const r of rows) {
    let res: { language?: string; sources?: Array<{ assetId?: string; pages?: Array<{ text?: string; startMs?: number; durationMs?: number; tokens?: Array<{ text?: string; fromMs?: number; toMs?: number }> }> }> } = {};
    try { res = JSON.parse(r.result_json ?? '{}'); } catch { continue; }
    for (const src of res.sources ?? []) {
      if (!src.assetId || found.has(src.assetId) || !Array.isArray(src.pages)) continue;
      const segments: Array<{ text: string; fromMs: number; toMs: number }> = []; const words: Array<{ text: string; fromMs: number; toMs: number }> = [];
      for (const p of src.pages) {
        if (typeof p.text !== 'string' || typeof p.startMs !== 'number') continue;
        segments.push({ text: p.text.trim(), fromMs: p.startMs, toMs: p.startMs + (p.durationMs ?? 0) });
        for (const t of p.tokens ?? []) if (typeof t.text === 'string' && t.text.trim() && typeof t.fromMs === 'number' && typeof t.toMs === 'number' && words.length < 4000) words.push({ text: t.text.trim(), fromMs: t.fromMs, toMs: t.toMs });
      }
      if (segments.length) found.set(src.assetId, { ...(res.language === 'id' || res.language === 'en' ? { language: res.language } : {}), segments, ...(words.length ? { words } : {}) });
    }
  }
  return found.size ? facts.map((f) => (found.has(f.id) ? { ...f, transcript: found.get(f.id)! } : f)) : facts;
}

/**
 * Sequence Badges (FR-044, R-034): unique per project, contiguous from 1. Assigning an occupied number shifts the holder and
 * everything after it up; clearing renumbers. Returns the ids whose badge changed.
 */
export function setBadge(ctx: ServiceContext, projectId: string, assetId: string, badge: number | null): string[] {
  const before = new Map((ctx.db.prepare('SELECT id, sequence_badge FROM assets WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as Array<{ id: string; sequence_badge: number | null }>).map((r) => [r.id, r.sequence_badge]));
  const ordered = [...before.entries()].filter(([id, b]) => b !== null && id !== assetId).sort((a, b) => (a[1]! - b[1]!)).map(([id]) => id);
  if (badge !== null) ordered.splice(Math.min(badge - 1, ordered.length), 0, assetId);
  return writeBadges(ctx, projectId, before, ordered);
}
/** Clears the badges of `ids` and renumbers the rest. */
export function clearBadges(ctx: ServiceContext, projectId: string, ids: readonly string[]): string[] {
  const before = new Map((ctx.db.prepare('SELECT id, sequence_badge FROM assets WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as Array<{ id: string; sequence_badge: number | null }>).map((r) => [r.id, r.sequence_badge]));
  const drop = new Set(ids);
  const ordered = [...before.entries()].filter(([id, b]) => b !== null && !drop.has(id)).sort((a, b) => (a[1]! - b[1]!)).map(([id]) => id);
  return writeBadges(ctx, projectId, before, ordered);
}
function writeBadges(ctx: ServiceContext, projectId: string, before: Map<string, number | null>, ordered: string[]): string[] {
  const next = new Map<string, number | null>([...before.keys()].map((id) => [id, null]));
  ordered.forEach((id, i) => next.set(id, i + 1));
  const changed = [...next.entries()].filter(([id, b]) => before.get(id) !== b).map(([id]) => id);
  const now = ctx.now();
  const up = ctx.db.prepare('UPDATE assets SET sequence_badge = ?, updated_at = ? WHERE id = ? AND project_id = ?');
  ctx.db.transaction(() => { for (const id of changed) up.run(next.get(id) ?? null, now, id, projectId); })();
  return changed;
}
