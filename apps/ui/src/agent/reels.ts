// FR-280 … FR-299 (Reels pipeline, DESIGN §E) — pure helpers of the Reels UI, React-free so they can be unit-tested:
// the time a Creator types into the Editor composer ("perbaiki di 0:23"), the PRD closing line of a Diskusi answer, the
// ratio a channel profile implies, the Indonesian stage order of the prep job and the cut table rows.
import type { FootageAnalysisDto, FootageCutDto, PrepStage, Ratio } from '../api/types.js';
import { PREP_STAGES } from '../api/types.js';

/** "0:23", "1:05", "01:02:03" or "0:23.5" anywhere in the text → milliseconds of the FIRST match; null when none. */
export function parseTimestamp(text: string): { ms: number; label: string } | null {
  const m = /(?:^|[^\d:])((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)(?!\d|:)/.exec(text);
  if (!m) return null;
  const raw = m[1]!;
  const [intPart, fracPart] = raw.split(/[.,]/);
  const parts = intPart!.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n)) || parts[parts.length - 1]! >= 60 || (parts.length === 3 && parts[1]! >= 60)) return null;
  const secs = parts.reduce((acc, n) => acc * 60 + n, 0);
  const frac = fracPart ? Number(`0.${fracPart}`) : 0;
  return { ms: Math.round((secs + frac) * 1000), label: raw };
}

/** "0:23" for 23 000 ms (m:ss, hours only when needed). */
export const fmtMs = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

/** A Diskusi answer that ends with the PRD's closing line "PRD siap." (SYSTEM_PROMPT P-1) offers "Setujui & kirim ke Editor". */
export const prdReady = (text: string): boolean => /PRD siap\.?\s*$/i.test(text.trim());

/** The channel profile names a vertical format (Reels / Shorts / TikTok / 9:16) → 9:16; a landscape one (YouTube / 16:9) → 16:9; else null. */
export function channelProfileRatio(profile: string | null | undefined): Ratio | null {
  const p = (profile ?? '').toLowerCase();
  if (!p.trim()) return null;
  if (/\b(reels?|shorts?|tiktok)\b|9\s*[:x]\s*16|vertikal|vertical|portrait|potret/.test(p)) return '9:16';
  if (/16\s*[:x]\s*9|\byoutube\b(?!\s*shorts)|landscape|lanskap|mendatar/.test(p)) return '16:9';
  if (/\b1\s*[:x]\s*1\b|\bsquare\b|persegi/.test(p)) return '1:1';
  return null;
}

/** Stage index for the stepper (unknown / `done` → past the last stage). */
export function prepStageIndex(stage: string | undefined): number {
  if (!stage) return 0;
  const i = PREP_STAGES.indexOf(stage as PrepStage);
  return i >= 0 ? i : PREP_STAGES.length;
}

export interface CutRow { no: number; id: string; range: string; startMs: number; endMs: number; words: number; text: string }
/** The cut table of the prep card: no · time range (recording time) · words · spoken text. */
export function cutRows(analysis: Pick<FootageAnalysisDto, 'cuts'> | null | undefined): CutRow[] {
  return (analysis?.cuts ?? []).map((c: FootageCutDto, i) => ({ no: i + 1, id: c.id, range: `${fmtMs(c.startMs)}–${fmtMs(c.endMs)}`, startMs: c.startMs, endMs: c.endMs, words: c.words?.length || c.text.split(/\s+/).filter(Boolean).length, text: c.text }));
}

/** Total kept length of the cuts (what the final video will roughly last). */
export const cutsTotalMs = (analysis: Pick<FootageAnalysisDto, 'cuts'> | null | undefined): number => (analysis?.cuts ?? []).reduce((n, c) => n + Math.max(0, c.endMs - c.startMs), 0);

/** The grid of a contact sheet with `count` cells: columns = ceil(√count), rows to fit. */
export const sheetGrid = (count: number): { cols: number; rows: number } => { const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count)))); return { cols, rows: Math.max(1, Math.ceil(count / cols)) }; };

/** The first ready video and audio Assets of a project ("Siapkan rekaman" needs both). */
export function footagePair(assets: ReadonlyArray<{ id: string; kind: string; status: string; name: string; missing?: boolean }>, preferIds: readonly string[] = []): { video: string; audio: string } | null {
  const ready = assets.filter((a) => a.status === 'ready' && !a.missing && !/· master$/.test(a.name));
  const pick = (kind: string) => ready.find((a) => a.kind === kind && preferIds.includes(a.id)) ?? ready.find((a) => a.kind === kind);
  const video = pick('video'), audio = pick('audio');
  return video && audio ? { video: video.id, audio: audio.id } : null;
}
