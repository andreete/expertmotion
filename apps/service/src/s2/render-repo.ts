// `render_jobs` / `outputs` rows (DATABASE_SCHEMA §3) and their DTOs (API_SPECIFICATION §3).
import os from 'node:os';
import path from 'node:path';
import { resolveDimensions } from '@expertmotion/engine/formats';
import type { ServiceContext } from '../context.js';

export interface OutputProfileT {
  ratio: '16:9' | '9:16' | '1:1' | '4:5' | '5:4' | '4:3' | '3:4' | 'custom'; customRatio?: { w: number; h: number } | undefined;
  resolution: '720p' | '1080p' | '2k' | '2160p'; fps: 24 | 25 | 30 | 50 | 60; format: 'mp4' | 'webm' | 'gif' | 'png' | 'wav';
  codec?: 'h264' | 'vp9' | 'gif' | 'png' | 'pcm' | undefined; crf?: number | undefined; alpha: boolean; stillAtMs?: number | undefined;
}
export interface RenderJobRow {
  id: string; project_id: string; version_id: string; output_profile_json: string; performance_profile: 'standard' | 'accelerated' | 'turbo';
  status: 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled'; progress: number; rendered_frames: number | null; total_frames: number | null; eta_ms: number | null;
  output_id: string | null; error_code: string | null; error_detail: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}
export interface OutputRow {
  id: string; project_id: string; render_job_id: string; path: string; thumb_path: string | null; kind: 'video' | 'gif' | 'still' | 'audio'; bytes: number;
  width: number | null; height: number | null; fps: number | null; duration_ms: number | null; validated: number; watermarked: number; created_at: string;
}

export const getJob = (ctx: ServiceContext, id: string): RenderJobRow | undefined => ctx.db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(id) as RenderJobRow | undefined;
export const getOutput = (ctx: ServiceContext, id: string): OutputRow | undefined => ctx.db.prepare('SELECT * FROM outputs WHERE id = ?').get(id) as OutputRow | undefined;

/** Where Outputs may live: the app outputs folder and the user profile (TR-081; Creator-chosen folders). */
export const outputRoots = (ctx: ServiceContext): string[] => [ctx.paths.outputs, os.homedir()];
/** outputs.path is relative to the outputs root; files in a Creator-chosen folder elsewhere are stored absolute. */
export const outputAbsPath = (ctx: ServiceContext, p: string): string => (path.isAbsolute(p) ? p : path.resolve(ctx.paths.outputs, p));
export const outputRelPath = (ctx: ServiceContext, abs: string): string => {
  const r = path.relative(ctx.paths.outputs, abs);
  return r.startsWith('..') || path.isAbsolute(r) ? abs : r.split(path.sep).join('/');
};

export function profileDims(p: OutputProfileT): { width: number; height: number } {
  return resolveDimensions(p.ratio, p.resolution, p.ratio === 'custom' ? p.customRatio : undefined);
}
export function toJobDto(r: RenderJobRow): Record<string, unknown> {
  const profile = JSON.parse(r.output_profile_json) as OutputProfileT;
  let dims: { width: number | null; height: number | null } = { width: null, height: null };
  try { dims = profileDims(profile); } catch { /* invalid custom ratio */ }
  return { id: r.id, projectId: r.project_id, versionId: r.version_id, outputProfile: profile, performanceProfile: r.performance_profile, status: r.status, progress: r.progress,
    renderedFrames: r.rendered_frames, totalFrames: r.total_frames, etaMs: r.eta_ms, outputId: r.output_id, errorCode: r.error_code, width: dims.width, height: dims.height,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at };
}
export function toOutputDto(ctx: ServiceContext, o: OutputRow): Record<string, unknown> {
  return { id: o.id, projectId: o.project_id, renderJobId: o.render_job_id, kind: o.kind, fileName: path.basename(o.path), bytes: o.bytes, width: o.width, height: o.height, fps: o.fps,
    durationMs: o.duration_ms, validated: o.validated === 1, watermarked: o.watermarked === 1, path: outputAbsPath(ctx, o.path), media: { file: true, thumb: !!o.thumb_path }, createdAt: o.created_at };
}
