/** Word/segment-level caption (shape-compatible with Remotion's `Caption` from @remotion/captions). */
export interface Caption {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
  pageBreakAfter?: boolean;
}
/** Shape-compatible with `CaptionToken` / `CaptionPage` in packages/composition-model (DATABASE_SCHEMA.md §4). */
export interface CaptionToken { text: string; fromMs: number; toMs: number }
export interface CaptionPage { text: string; startMs: number; durationMs: number; tokens: CaptionToken[] }
