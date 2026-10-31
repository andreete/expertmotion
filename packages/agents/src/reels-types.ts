// ADR-039 (Reels production pipeline, FR-280 … FR-299): the footage-analysis shapes the talking-head composer reads. Structural
// mirrors of `packages/models/src/analysis/types.ts` (`TimedWord`, `Cut`, `FootageAnalysis`); this package does not depend on
// @expertmotion/models, so the Service passes the stored analysis as plain data and TypeScript checks the shape here.
import type { SfxKind } from './auto-motion-spec.js';

export interface TimedWord { text: string; fromMs: number; toMs: number; conf?: number }
/** One kept take of a script line: recording time = master time (the master is the camera shifted by the sync offset). */
export interface AnalysisCut {
  id: string; lineIndex?: number; startMs: number; endMs: number; text: string; words: TimedWord[];
  quietStartDb?: number; quietEndDb?: number; coverage?: number; confidence?: 'ok' | 'low' | 'weak';
}
export interface AnalysisDropped { startMs: number; endMs: number; text: string; reason: string; lineIndex?: number }
/** What the composer and the envelope need from a FootageAnalysis (every other field is passed through untouched). */
export interface FootageAnalysisLike {
  version?: number; voiceAssetId?: string; cameraAssetId?: string; masterAssetId?: string; proxyAssetId?: string;
  offsetMs?: number; durationMs?: number; rotation?: number; model?: string;
  cuts: AnalysisCut[]; dropped?: AnalysisDropped[]; words?: TimedWord[]; warnings?: string[];
  lines?: Array<{ index: number; text: string; source: 'script' | 'extra' }>;
  loudness?: { inputI: number; inputTp: number; outputI?: number };
}
/** Asset ids of the procedural SFX the Service registered for the project (`ctx.hooks.sfxAssets(projectId)`), by kind. */
export type SfxAssets = Partial<Record<SfxKind, string>>;
