// Footage analysis types (FR-280 … FR-284, ADR-039): the result of the Footage prep job — pure data, stored as JSON on
// `footage_analyses` and handed to the composer. Times are RECORDING time (the voice recorder's clock) in ms unless named.

export interface SyncPoint { atMs: number; offsetMs: number; r: number }
/** Camera ↔ recorder offset. Positive `offsetMs` = `other` (the camera) started before `ref` (the recorder). */
export interface SyncResult {
  offsetMs: number;
  /** Refined offsets at evenly spread points with speech (1 ms resolution); `r` = normalised correlation. */
  points: SyncPoint[];
  /** Spread of the refined offsets (max − min); large values mean the two clocks drift. */
  driftMs: number;
  /** 0..1 — coarse correlation peak against the background plus agreement of the points. */
  confidence: number;
  coarse: { offsetMs: number; r: number };
}

export interface Phrase { index: number; fromMs: number; toMs: number; durationMs: number }
export interface TimedWord { text: string; fromMs: number; toMs: number; conf?: number }
export interface VoicedRange { fromMs: number; toMs: number }

export interface ScriptLine { index: number; text: string; source: 'script' | 'extra' }
/** One candidate take of a line: a run of consecutive phrases whose words cover the line. */
export interface TakeCandidate {
  phraseFrom: number; phraseTo: number;
  startMs: number; endMs: number;
  /** Share of the line's words found in the take (0..1). */
  coverage: number;
  /** Share of the take's words that belong to the line (0..1). */
  precision: number;
  /** Line word indices of the first / last matched word (−1 when nothing matched). */
  firstMatched: number; lastMatched: number;
  /** The take reaches the line's ending (and starts near its beginning): a candidate that stops early is a false start, whatever its coverage. */
  complete: boolean;
  words: TimedWord[];
}
export interface TakeGroup { lineIndex: number; line: ScriptLine; candidates: TakeCandidate[] }

export interface Cut {
  id: string; lineIndex: number; startMs: number; endMs: number;
  /** What the viewer reads: the script line's words (script spelling, spoken times) plus confidently heard extra words. */
  text: string; words: TimedWord[];
  /** The raw recognition of the take (for review); `words` is derived from it by alignCutWords. */
  spoken: TimedWord[];
  /** Loudest 10 ms frame (dB) of the 100 ms window just OUTSIDE each edge: how quiet the cut points are (target ≤ −43). */
  quietStartDb: number; quietEndDb: number;
  /** `coverage` of the chosen candidate; `low` = passed only the 60 % fallback; `weak` = best run ≥ 40 % inside the script-order window (check by ear). */
  coverage: number; confidence: 'ok' | 'low' | 'weak';
}
export type DropReason = 'adlib' | 'false-start' | 'retake' | 'length' | 'unclean-end';
export interface Dropped { startMs: number; endMs: number; text: string; reason: DropReason; lineIndex?: number }

export interface FootageAnalysis {
  version: 1; voiceAssetId: string; cameraAssetId?: string; masterAssetId?: string; proxyAssetId?: string;
  offsetMs: number; sync?: SyncResult; rotation: 0 | 90 | 180 | 270; rotationSource: 'metadata' | 'heuristic' | 'creator' | 'none';
  phrases: Phrase[]; words: TimedWord[];
  lines: ScriptLine[]; takes: TakeGroup[]; cuts: Cut[]; dropped: Dropped[];
  loudness?: { inputI: number; inputTp: number; outputI?: number }; durationMs: number; model: string; warnings: string[];
}
