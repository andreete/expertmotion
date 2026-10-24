// SRT / WebVTT parsers for P0 caption import (op:caption.importSrt; docs/SECURITY.md SEC-067: 5 MB cap, 10 000 cues,
// failures → EM-1009 / EM-1002 with a reason, never a crash).
import { emError } from '../errors.js';
import type { Caption } from './types.js';

export const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;
export const SUBTITLE_MAX_CUES = 10_000;

export interface SubtitleParseOptions { fileName?: string; maxBytes?: number; maxCues?: number }

const invalid = (parseError: string, line: number | null, fileName?: string): Error =>
  emError('EM-1009', `Caption file not understood: ${parseError}${line === null ? '' : ` (line ${line})`}`, { fileName: fileName ?? null, line, parseError });

function prepare(input: string, opts: SubtitleParseOptions): string[] {
  const max = opts.maxBytes ?? SUBTITLE_MAX_BYTES;
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > max) throw emError('EM-1002', 'Caption file is too large', { fileName: opts.fileName ?? null, size: bytes, limit: max });
  if (input.includes('\u0000')) throw invalid('binary content', null, opts.fileName);
  return input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
}

/** `HH:MM:SS,mmm`, `HH:MM:SS.mmm`, `MM:SS.mmm` (1–3 fraction digits). Returns ms or null. */
export function parseTimestamp(token: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/.exec(token.trim());
  if (!m) return null;
  const h = Number(m[1] ?? 0), min = Number(m[2]), s = Number(m[3]);
  if (min > 59 || s > 59) return null;
  const frac = m[4] ?? '0';
  const ms = Number(frac.padEnd(3, '0'));
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

const TIMING_RE = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' };
/** Removes HTML-ish tags (<i>, <b>, <font>, <v Speaker>, <c.cls>, <00:00:01.000>) and SSA overrides ({\an8}); decodes basic entities. */
export function cleanCueText(text: string): string {
  return text
    .replace(/<[^>\n]*>/g, '')
    .replace(/\{\\[^}\n]*\}/g, '')
    .replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (all, ent: string) => {
      if (ent.startsWith('#x') || ent.startsWith('#X')) { const cp = parseInt(ent.slice(2), 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : all; }
      if (ent.startsWith('#')) { const cp = Number(ent.slice(1)); return cp <= 0x10ffff ? String.fromCodePoint(cp) : all; }
      return ENTITIES[ent.toLowerCase()] ?? all;
    })
    .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter((l) => l !== '').join('\n');
}

const cue = (startMs: number, endMs: number, text: string): Caption => ({ text, startMs, endMs, timestampMs: (startMs + endMs) / 2, confidence: 1 });

interface Block { start: number; lines: string[] }
function blocks(lines: string[], from = 0): Block[] {
  const out: Block[] = []; let cur: Block | null = null;
  for (let i = from; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === '') { if (cur) { out.push(cur); cur = null; } continue; }
    if (!cur) cur = { start: i + 1, lines: [] };
    cur.lines.push(l);
  }
  if (cur) out.push(cur);
  return out;
}

function timing(line: string, lineNo: number, fileName?: string): { startMs: number; endMs: number } {
  const t = TIMING_RE.exec(line);
  if (!t) throw invalid('expected "start --> end"', lineNo, fileName);
  const startMs = parseTimestamp(t[1]!); const endMs = parseTimestamp(t[2]!);
  if (startMs === null || endMs === null) throw invalid('invalid timestamp', lineNo, fileName);
  if (endMs < startMs) throw invalid('end is earlier than start', lineNo, fileName);
  return { startMs, endMs };
}

function finish(captions: Caption[], opts: SubtitleParseOptions): Caption[] {
  if (captions.length === 0) throw invalid('no timed captions found', null, opts.fileName);
  return captions.map((c, i) => ({ c, i })).sort((a, b) => a.c.startMs - b.c.startMs || a.i - b.i).map(({ c }) => c);
}

/** SubRip (.srt). Tolerates a missing cue index, `.` decimal separators, BOM, CRLF, markup tags; empty cues are skipped. */
export function parseSrt(input: string, opts: SubtitleParseOptions = {}): Caption[] {
  const lines = prepare(input, opts);
  const maxCues = opts.maxCues ?? SUBTITLE_MAX_CUES;
  const out: Caption[] = [];
  for (const b of blocks(lines)) {
    let k = 0;
    if (/^\d+$/.test(b.lines[0]!.trim()) && b.lines.length > 1 && b.lines[1]!.includes('-->')) k = 1;
    if (!b.lines[k]!.includes('-->')) throw invalid('expected "start --> end"', b.start + k, opts.fileName);
    const { startMs, endMs } = timing(b.lines[k]!, b.start + k, opts.fileName);
    const text = cleanCueText(b.lines.slice(k + 1).join('\n'));
    if (text === '') continue;
    if (out.length >= maxCues) throw invalid(`more than ${maxCues} cues`, b.start, opts.fileName);
    out.push(cue(startMs, endMs, text));
  }
  return finish(out, opts);
}

/** WebVTT (.vtt). Requires the WEBVTT signature; skips NOTE/STYLE/REGION blocks, cue identifiers and cue settings. */
export function parseVtt(input: string, opts: SubtitleParseOptions = {}): Caption[] {
  const lines = prepare(input, opts);
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? '')) throw invalid('missing WEBVTT header', 1, opts.fileName);
  const maxCues = opts.maxCues ?? SUBTITLE_MAX_CUES;
  const out: Caption[] = [];
  const all = blocks(lines);
  for (const b of all.slice(1)) {
    const first = b.lines[0]!;
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(first)) continue;
    const k = first.includes('-->') ? 0 : 1;
    if (k === 1 && !(b.lines[1] ?? '').includes('-->')) throw invalid('expected "start --> end"', b.start + 1, opts.fileName);
    const { startMs, endMs } = timing(b.lines[k]!, b.start + k, opts.fileName);
    const text = cleanCueText(b.lines.slice(k + 1).join('\n'));
    if (text === '') continue;
    if (out.length >= maxCues) throw invalid(`more than ${maxCues} cues`, b.start, opts.fileName);
    out.push(cue(startMs, endMs, text));
  }
  return finish(out, opts);
}

/** Picks the parser by extension or content signature. */
export function parseSubtitles(input: string, opts: SubtitleParseOptions = {}): Caption[] {
  const isVtt = /\.vtt$/i.test(opts.fileName ?? '') || /^﻿?WEBVTT/.test(input);
  return isVtt ? parseVtt(input, opts) : parseSrt(input, opts);
}
