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
  if (!r) throw em('EM-9003', 'Not found.');
  return r;
}
export function listAssets(ctx: ServiceContext, projectId: string): AssetRow[] {
  return ctx.db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at, id').all(projectId) as AssetRow[];
}

export function toAssetDto(r: AssetRow, progress: number | undefined, withProbe = false): Record<string, unknown> {
  let probe: unknown;
  if (withProbe && r.probe_json) { try { probe = JSON.parse(r.probe_json); } catch { probe = undefined; } }
  return {
    id: r.id, projectId: r.project_id, kind: r.kind, name: r.name, bytes: r.bytes, sha256: r.sha256.startsWith('pending-') ? '' : r.sha256, status: r.status,
    progress: r.status === 'ready' ? 1 : (progress ?? 0), errorCode: r.error_code, durationMs: r.duration_ms, width: r.width, height: r.height, fps: r.fps,
    hasAudio: r.has_audio === null ? null : r.has_audio === 1, sequenceBadge: r.sequence_badge,
    media: { original: true, playable: !!r.playable_path, proxy: !!r.proxy_path, thumb: !!r.thumb_path, filmstrip: !!r.filmstrip_path, waveform: !!r.waveform_path },
    ...(probe === undefined ? {} : { probe }), createdAt: r.created_at, updatedAt: r.updated_at,
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
 * Sequence Badges (FR-044, R-034): unique per project, contiguous from 1. Assigning an occupied number shifts the holder and
 * everything after it up; clearing renumbers. Returns the ids whose badge changed.
 */
export function setBadge(ctx: ServiceContext, projectId: string, assetId: string, badge: number | null): string[] {
  const before = new Map((ctx.db.prepare('SELECT id, sequence_badge FROM assets WHERE project_id = ?').all(projectId) as Array<{ id: string; sequence_badge: number | null }>).map((r) => [r.id, r.sequence_badge]));
  const ordered = [...before.entries()].filter(([id, b]) => b !== null && id !== assetId).sort((a, b) => (a[1]! - b[1]!)).map(([id]) => id);
  if (badge !== null) ordered.splice(Math.min(badge - 1, ordered.length), 0, assetId);
  return writeBadges(ctx, projectId, before, ordered);
}
/** Clears the badges of `ids` and renumbers the rest. */
export function clearBadges(ctx: ServiceContext, projectId: string, ids: readonly string[]): string[] {
  const before = new Map((ctx.db.prepare('SELECT id, sequence_badge FROM assets WHERE project_id = ?').all(projectId) as Array<{ id: string; sequence_badge: number | null }>).map((r) => [r.id, r.sequence_badge]));
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
