// ADR-039 (Reels infographics): data-driven shape presets drawn with the theme fonts and palette roles — flat two-colour icons,
// badge rows, a day strip, a browser-window card, a typing DM box, tag pills, a muted source tag and horizontal bars. Every
// preset is a pure function of its params and the frame (springs, no randomness); no project strings live here.
// QA A16 "no cut-off text": no preset truncates. A text run first shrinks from its preferred size to a floor (one line), then
// wraps to at most N lines (`fitRun`, the shared estimator of composition-model so the quality gate sees the same lines); pills,
// rows, bars and the card grow with their text (height auto, the stored box is the minimum).
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { balancedLineTexts, fitTextWidth, textWidthEm } from '@expertmotion/composition-model';
import { useTheme, type ThemeTokens } from '../theme.js';
import { fontStack, symbolRuns } from '../font-stack.js';
import type { ShapeProps } from './shapes.js';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
type Tone = 'info' | 'warn' | 'opinion' | 'illustration' | 'positive' | 'negative' | 'neutral';
/** Tone → fill colour (pills, badges, bar fills) and the text colour that reads on it. */
export function toneColours(tone: string | undefined, t: ThemeTokens): { fill: string; text: string; outline?: boolean } {
  switch (tone as Tone) {
    case 'warn': return { fill: t.warn, text: t.bg };
    case 'opinion': return { fill: t.accent, text: t.bg };
    case 'illustration': return { fill: t.muted, text: t.text, outline: true };
    case 'positive': return { fill: t.accent2, text: t.bg };
    case 'negative': return { fill: t.negative, text: t.text };
    case 'neutral': return { fill: t.muted, text: t.bg };
    default: return { fill: t.accent2, text: t.bg };
  }
}
/** A spring entrance 0…1 for item `i` of a staggered list (delay i × staggerMs). */
function useStagger(i: number, staggerMs: number): number {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  return spring({ frame: frame - Math.round((i * staggerMs / 1000) * fps), fps, config: { damping: 14 }, durationInFrames: Math.round(0.6 * fps) });
}
/** Largest font size (px) at which `text` fits `width` px on one line, between min and max. */
export function fitOneLine(text: string, width: number, max: number, min: number, weight: number, family?: string): number {
  const em = textWidthEm(text, weight, family);
  if (em <= 0) return max;
  return Math.max(min, Math.min(max, width / em));
}
export interface FittedRun { fontSize: number; lines: string[]; height: number; overflow: boolean }
export const RUN_LINE_HEIGHT = 1.15;
/**
 * QA A16: a text run that is never truncated. Shrinks from `maxPx` to `minPx` on ONE line (2 px steps, as fitTextWidth); when
 * the floor still overflows, wraps at the floor into at most `maxLines` balanced lines (explicit breaks, bound groups glued);
 * `overflow` is true only when even that does not fit — the lines are still returned whole (the box grows, nothing is cut).
 * Uses the shared estimator (textGeometry's fitTextWidth / balancedLineTexts), so the quality gate and the picture agree.
 */
export function fitRun(text: string, widthPx: number, maxPx: number, minPx: number, maxLines: number, weight: number, family?: string, letterSpacingEm = 0): FittedRun {
  const clean = text.trim();
  const width = Math.max(10, widthPx);
  const lo = Math.max(4, Math.min(minPx, maxPx)), hi = Math.max(lo, maxPx);
  const ls = (size: number) => letterSpacingEm * size * Math.max(0, [...clean].length - 1);           // CSS letter-spacing adds up per gap
  const one = fitTextWidth(clean, { width: Math.max(10, width - ls(hi)), height: Number.MAX_SAFE_INTEGER, maxSize: hi, minSize: lo, lineHeight: RUN_LINE_HEIGHT, maxLines: 1, weight, family });
  if (!clean) return { fontSize: hi, lines: [''], height: hi * RUN_LINE_HEIGHT, overflow: false };
  if (!one.overflow) return { fontSize: one.fontSize, lines: [clean], height: one.fontSize * RUN_LINE_HEIGHT, overflow: false };
  const inner = Math.max(10, width - ls(lo) / Math.max(1, maxLines));
  const laid = balancedLineTexts(clean, lo, inner, weight, family).filter((l) => !l.cont).map((l) => l.text);
  const overflow = laid.length > maxLines || laid.some((l) => textWidthEm(l, weight, family) * lo > inner + 0.5);
  return { fontSize: lo, lines: laid, height: laid.length * lo * RUN_LINE_HEIGHT, overflow };
}
/** The fitted run as a block: explicit line breaks, no truncation, the font stack falls back per glyph (symbols, §Poppins). */
const Run: React.FC<{ run: FittedRun; family: string; weight: number; colour: string; align?: 'left' | 'center' | 'right'; upper?: boolean | undefined; letterSpacing?: string | undefined; style?: React.CSSProperties; mark?: string }> = ({ run, family, weight, colour, align, upper, letterSpacing, style, mark }) => (
  <div data-em-run={mark} data-em-lines={run.lines.length} style={{ fontFamily: fontStack(family), fontWeight: weight, fontSize: run.fontSize, lineHeight: RUN_LINE_HEIGHT, color: colour, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textAlign: align ?? 'left', ...(letterSpacing ? { letterSpacing } : {}), ...style }}>
    {symbolRuns(upper ? run.lines.join('\n').toUpperCase() : run.lines.join('\n'))}
  </div>
);

// ───────────────────────────── preset:shape.icon ─────────────────────────────
type IconDraw = (main: string, accent: string) => React.ReactNode;
const rays = (cx: number, cy: number, r1: number, r2: number, n: number, colour: string, sw: number) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2; return <line key={i} x1={cx + Math.cos(a) * r1} y1={cy + Math.sin(a) * r1} x2={cx + Math.cos(a) * r2} y2={cy + Math.sin(a) * r2} stroke={colour} strokeWidth={sw} strokeLinecap="round" />;
});
/** Flat two-colour pictograms in a 100 × 100 box: `main` = the shape's fill, `accent` = params.accent (default theme accent2). */
export const ICONS: Record<string, IconDraw> = {
  reactor: (m, a) => <><path d="M30 92 L38 30 Q50 22 62 30 L70 92 Z" fill={m} /><circle cx="42" cy="18" r="7" fill={a} /><circle cx="56" cy="12" r="9" fill={a} /><circle cx="68" cy="22" r="6" fill={a} /></>,
  'chip-ai': (m, a) => <><rect x="22" y="22" width="56" height="56" rx="10" fill={m} />{[30, 44, 58, 70].map((p) => <React.Fragment key={p}><rect x={p - 3} y="8" width="6" height="12" rx="2" fill={m} /><rect x={p - 3} y="80" width="6" height="12" rx="2" fill={m} /><rect x="8" y={p - 3} width="12" height="6" rx="2" fill={m} /><rect x="80" y={p - 3} width="12" height="6" rx="2" fill={m} /></React.Fragment>)}<rect x="36" y="36" width="28" height="28" rx="6" fill={a} /></>,
  bolt: (m, a) => <><circle cx="50" cy="50" r="42" fill={a} opacity="0.25" /><path d="M56 6 L24 56 L46 56 L40 94 L76 42 L54 42 Z" fill={m} /></>,
  atom: (m, a) => <><g fill="none" stroke={m} strokeWidth="6"><ellipse cx="50" cy="50" rx="44" ry="17" /><ellipse cx="50" cy="50" rx="44" ry="17" transform="rotate(60 50 50)" /><ellipse cx="50" cy="50" rx="44" ry="17" transform="rotate(120 50 50)" /></g><circle cx="50" cy="50" r="9" fill={a} /></>,
  'data-center': (m, a) => <><rect x="20" y="8" width="60" height="84" rx="8" fill={m} />{[22, 42, 62].map((y) => <React.Fragment key={y}><rect x="28" y={y} width="44" height="12" rx="3" fill={a} opacity="0.9" /><circle cx="66" cy={y + 6} r="3" fill={m} /></React.Fragment>)}</>,
  shield: (m, a) => <><path d="M50 6 L86 20 V50 Q86 80 50 94 Q14 80 14 50 V20 Z" fill={m} /><path d="M32 50 L45 63 L70 36" fill="none" stroke={a} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" /></>,
  check: (m, a) => <><circle cx="50" cy="50" r="44" fill={m} /><path d="M28 52 L44 68 L74 36" fill="none" stroke={a} strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" /></>,
  sun: (m, a) => <>{rays(50, 50, 32, 44, 8, m, 7)}<circle cx="50" cy="50" r="22" fill={a} /></>,
  cloud: (m, a) => <><ellipse cx="62" cy="40" rx="24" ry="18" fill={a} opacity="0.5" /><path d="M28 78 H74 A16 16 0 0 0 72 46 A22 22 0 0 0 30 50 A14 14 0 0 0 28 78 Z" fill={m} /></>,
  moon: (m, a) => <><path d="M62 8 A42 42 0 1 0 92 60 A32 32 0 1 1 62 8 Z" fill={m} /><path d="M24 20 L28 30 L38 34 L28 38 L24 48 L20 38 L10 34 L20 30 Z" fill={a} /></>,
  'solar-panel': (m, a) => <><circle cx="78" cy="22" r="12" fill={a} />{rays(78, 22, 15, 20, 8, a, 3)}<path d="M14 46 L70 46 L84 84 L8 84 Z" fill={m} /><g stroke={a} strokeWidth="3" opacity="0.9"><line x1="33" y1="46" x2="34" y2="84" /><line x1="52" y1="46" x2="60" y2="84" /><line x1="12" y1="65" x2="78" y2="65" /></g><rect x="40" y="84" width="12" height="10" fill={m} /></>,
  factory: (m, a) => <><path d="M8 92 V40 L32 56 V40 L56 56 V40 L80 56 V20 H92 V92 Z" fill={m} /><circle cx="86" cy="12" r="5" fill={a} /><circle cx="76" cy="8" r="4" fill={a} opacity="0.7" />{[24, 48, 72].map((x) => <rect key={x} x={x - 4} y="68" width="10" height="12" rx="2" fill={a} />)}</>,
  'card-ace': (m, a) => <><rect x="22" y="6" width="56" height="88" rx="8" fill={m} /><path d="M50 32 Q62 44 62 54 A8 8 0 0 1 52 60 L55 70 H45 L48 60 A8 8 0 0 1 38 54 Q38 44 50 32 Z" fill={a} /><rect x="28" y="12" width="6" height="12" rx="1" fill={a} /><rect x="66" y="76" width="6" height="12" rx="1" fill={a} /></>,
  qr: (m, a) => <>{[[8, 8], [62, 8], [8, 62]].map(([x, y]) => <React.Fragment key={`${x}${y}`}><rect x={x} y={y} width="30" height="30" rx="4" fill={a} /><rect x={x! + 9} y={y! + 9} width="12" height="12" fill={m} /></React.Fragment>)}{[[62, 62], [78, 62], [62, 78], [84, 84], [70, 84], [84, 70]].map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="8" height="8" fill={m} />)}{[[44, 8], [44, 24], [44, 40], [8, 44], [24, 44], [40, 44]].map(([x, y]) => <rect key={`${x}_${y}`} x={x} y={y} width="8" height="8" fill={m} />)}</>,
  play: (m, a) => <><rect x="8" y="8" width="84" height="84" rx="20" fill={m} /><path d="M40 30 L72 50 L40 70 Z" fill={a} /></>,
  globe: (m, a) => <><circle cx="50" cy="50" r="42" fill={m} /><g fill="none" stroke={a} strokeWidth="4"><ellipse cx="50" cy="50" rx="18" ry="42" /><line x1="8" y1="50" x2="92" y2="50" /><path d="M14 30 Q50 42 86 30" /><path d="M14 70 Q50 58 86 70" /></g></>,
  chat: (m, a) => <><path d="M14 16 H86 A8 8 0 0 1 94 24 V62 A8 8 0 0 1 86 70 H40 L20 88 V70 H14 A8 8 0 0 1 6 62 V24 A8 8 0 0 1 14 16 Z" fill={m} />{[34, 50, 66].map((x) => <circle key={x} cx={x} cy="43" r="5" fill={a} />)}</>,
  money: (m, a) => <><rect x="6" y="24" width="88" height="52" rx="8" fill={m} /><circle cx="50" cy="50" r="15" fill={a} /><rect x="14" y="32" width="10" height="36" rx="3" fill={a} opacity="0.6" /><rect x="76" y="32" width="10" height="36" rx="3" fill={a} opacity="0.6" /></>,
  clock: (m, a) => <><circle cx="50" cy="50" r="44" fill={m} /><g stroke={a} strokeWidth="7" strokeLinecap="round"><line x1="50" y1="50" x2="50" y2="24" /><line x1="50" y1="50" x2="68" y2="60" /></g><circle cx="50" cy="50" r="5" fill={a} /></>,
  warning: (m, a) => <><path d="M50 8 L94 88 H6 Z" fill={m} /><rect x="45" y="36" width="10" height="28" rx="4" fill={a} /><circle cx="50" cy="74" r="6" fill={a} /></>,
};
export const ICON_IDS: readonly string[] = Object.freeze(Object.keys(ICONS));
const Icon: React.FC<ShapeProps> = (p) => {
  const t = useTheme();
  const draw = ICONS[str(p.params['icon'], 'bolt')] ?? ICONS['bolt']!;
  const accent = str(p.params['accent']) || t.accent2;
  return <svg data-em-icon={str(p.params['icon'], 'bolt')} width={p.w} height={p.h} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>{draw(p.fill, accent)}</svg>;
};
/** The icon glyph as an inline SVG for other presets (day strip, browser card). */
const InlineIcon: React.FC<{ name: string; size: number; main: string; accent: string }> = ({ name, size, main, accent }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: 'block', flex: 'none' }}>{(ICONS[name] ?? ICONS['bolt']!)(main, accent)}</svg>
);

// ───────────────────────────── preset:shape.rows ─────────────────────────────
type Row = { badge?: string; title: string; sub?: string; right?: string; rightSub?: string; tone?: string };
/** Floors (u) of the shrink-then-wrap rule per text role (QA A16). */
export const TEXT_FLOORS_U = Object.freeze({ tag: 22, sourceTag: 22, rowTitle: 30, rowSub: 20, rowRight: 24, barLabel: 24, dayLabel: 22, cardCaption: 22, cardTitle: 30 });
const RowView: React.FC<{ r: Row; i: number; h: number; w: number; u: number; stagger: number; radius: number; t: ThemeTokens; fill: string }> = ({ r, i, h, w, u, stagger, radius, t, fill }) => {
  const s = useStagger(i, stagger);
  const pad = h * 0.16, badge = h * 0.62, gap = pad, tone = toneColours(r.tone, t);
  const hasRight = !!r.right;
  // the title column keeps ≥ 55 % of the row; the right column takes what is left (≤ 30 %) and shrinks / wraps itself
  const innerW = w - 2 * pad - (r.badge ? badge + gap : 0);
  const rightW = hasRight ? Math.min(innerW * 0.3, innerW - innerW * 0.55 - gap) : 0;
  const titleW = innerW - (hasRight ? rightW + gap : 0);
  const title = fitRun(r.title, titleW, h * 0.34, TEXT_FLOORS_U.rowTitle * u, 2, 700, t.headingFont);
  const sub = r.sub ? fitRun(r.sub, titleW, h * 0.22, TEXT_FLOORS_U.rowSub * u, 2, 500, t.bodyFont) : null;
  const right = hasRight ? fitRun(r.right!, rightW, h * 0.36, TEXT_FLOORS_U.rowRight * u, 2, 800, t.headingFont) : null;
  const rightSub = hasRight && r.rightSub ? fitRun(r.rightSub, rightW, h * 0.2, TEXT_FLOORS_U.rowSub * u, 2, 500, t.bodyFont) : null;
  return (
    <div data-em-row={i} style={{ display: 'flex', alignItems: 'center', gap, minHeight: h, width: w, boxSizing: 'border-box', padding: `${pad * 0.6}px ${pad}px`, borderRadius: radius, background: fill, opacity: s, translate: `0px ${(1 - s) * h * 0.4}px` }}>
      {r.badge ? <div style={{ flex: 'none', width: badge, height: badge, borderRadius: radius * 0.6, background: r.tone ? tone.fill : t.accent, color: r.tone ? tone.text : t.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontStack(t.headingFont), fontWeight: 800, fontSize: badge * 0.55 }}>{r.badge}</div> : null}
      <div data-em-row-title style={{ flex: `1 1 ${titleW}px`, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: h * 0.04 }}>
        <Run run={title} family={t.headingFont} weight={700} colour={t.text} mark="row-title" />
        {sub ? <Run run={sub} family={t.bodyFont} weight={500} colour={t.muted} mark="row-sub" /> : null}
      </div>
      {right ? <div style={{ flex: `0 1 ${rightW}px`, width: rightW, textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <Run run={right} family={t.headingFont} weight={800} colour={r.tone ? tone.fill : t.accent} align="right" mark="row-right" />
        {rightSub ? <Run run={rightSub} family={t.bodyFont} weight={500} colour={t.muted} align="right" mark="row-right-sub" /> : null}
      </div> : null}
    </div>
  );
};
const Rows: React.FC<ShapeProps> = (p) => {
  const t = useTheme();
  const rows = arr<Row>(p.params['rows']).filter((r) => r && typeof r.title === 'string');
  if (!rows.length) return null;
  const gap = Math.min(p.h * 0.04, 14 * p.u), rowH = (p.h - gap * (rows.length - 1)) / rows.length;
  const fill = p.fill === t.accent ? t.bg2 : p.fill;                       // the palette accent is a poor panel colour: default to the panel role
  return <div data-em-rows style={{ width: p.w, minHeight: p.h, display: 'flex', flexDirection: 'column', gap }}>{rows.map((r, i) => <RowView key={i} r={r} i={i} h={rowH} w={p.w} u={p.u} stagger={num(p.params['staggerMs'], 120)} radius={num(p.params['radiusU'], 28) * p.u} t={t} fill={fill} />)}</div>;
};

// ───────────────────────────── preset:shape.day-strip ─────────────────────────────
type DayBar = { label: string; fromH: number; toH: number; colour?: string; icon?: string };
const DayStrip: React.FC<ShapeProps> = (p) => {
  const t = useTheme(); const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const hours = arr<number>(p.params['hours']).filter((h) => typeof h === 'number');
  const bars = arr<DayBar>(p.params['bars']).filter((b) => b && typeof b.fromH === 'number' && typeof b.toH === 'number');
  const note = str(p.params['note']);
  const axisH = p.h * 0.16, noteH = note ? p.h * 0.16 : 0, gap = p.h * 0.03;
  const barsH = p.h - axisH - noteH - gap, barH = bars.length ? (barsH - gap * (bars.length - 1)) / bars.length : 0;
  const x = (h: number) => (Math.max(0, Math.min(24, h)) / 24) * p.w;
  const grow = spring({ frame, fps, config: { damping: 200 }, durationInFrames: Math.round(0.9 * fps) });
  const fontMain = Math.min(barH * 0.42, p.w * 0.04);
  const noteRun = note ? fitRun(note, p.w, noteH * 0.45, TEXT_FLOORS_U.dayLabel * p.u, 2, 500, t.bodyFont) : null;
  return (
    <div data-em-day-strip style={{ width: p.w, minHeight: p.h, display: 'flex', flexDirection: 'column', gap, fontFamily: fontStack(t.bodyFont), color: t.text }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap }}>
        {bars.map((b, i) => {
          const left = x(b.fromH), full = x(b.toH) - x(b.fromH), colour = b.colour ?? (i % 2 ? t.accent2 : t.accent);
          const icon = b.icon ? barH * 0.5 : 0, padX = barH * 0.3;
          // the label fits inside the bar's FULL length (shrink to the floor, then 2 lines; the row grows); a label that still does
          // not fit runs past the coloured bar over the track in the text colour (never clipped, never cut)
          const iconW = icon ? icon + barH * 0.2 : 0;
          let run = fitRun(b.label, Math.max(10, full - 2 * padX - iconW), fontMain, TEXT_FLOORS_U.dayLabel * p.u, 2, 700, t.bodyFont);
          const outside = run.overflow;
          if (outside) run = fitRun(b.label, Math.max(10, p.w - left - 2 * padX - iconW), fontMain, TEXT_FLOORS_U.dayLabel * p.u, 2, 700, t.bodyFont);
          const rowH = Math.max(barH, run.height + barH * 0.45);
          const width = Math.max(rowH * 0.5, full * grow);
          return (
            <div key={i} data-em-day-bar={i} style={{ position: 'relative', height: rowH }}>
              <div style={{ position: 'absolute', left: 0, top: rowH * 0.1, width: p.w, height: rowH * 0.8, borderRadius: rowH * 0.4, background: t.bg2 }} />
              <div style={{ position: 'absolute', left, top: rowH * 0.1, width, height: rowH * 0.8, borderRadius: rowH * 0.4, background: colour }} />
              <div style={{ position: 'absolute', left, top: rowH * 0.1, width: outside ? p.w - left : width, height: rowH * 0.8, display: 'flex', alignItems: 'center', gap: barH * 0.2, padding: `0 ${padX}px`, boxSizing: 'border-box', color: outside ? t.text : t.bg }}>
                {b.icon ? <InlineIcon name={b.icon} size={icon} main={outside ? colour : t.bg} accent={outside ? t.bg : colour} /> : null}
                <Run run={run} family={t.bodyFont} weight={700} colour={outside ? t.text : t.bg} mark="day-label" />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'relative', width: p.w, height: axisH }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: axisH * 0.2, height: Math.max(1, 2 * p.u), background: t.muted }} />
        {hours.map((h) => <div key={h} style={{ position: 'absolute', left: x(h), top: axisH * 0.2, transform: 'translateX(-50%)', textAlign: 'center' }}>
          <div style={{ width: Math.max(1, 2 * p.u), height: axisH * 0.22, background: t.muted, margin: '0 auto' }} />
          <div style={{ fontSize: axisH * 0.42, color: t.muted, fontWeight: 600, marginTop: axisH * 0.05 }}>{String(h).padStart(2, '0')}</div>
        </div>)}
      </div>
      {noteRun ? <div style={{ minHeight: noteH, display: 'flex', alignItems: 'center' }}><Run run={noteRun} family={t.bodyFont} weight={500} colour={t.muted} mark="day-note" /></div> : null}
    </div>
  );
};

// ───────────────────────────── preset:shape.browser-card ─────────────────────────────
const BrowserCard: React.FC<ShapeProps> = (p) => {
  const t = useTheme(); const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const url = str(p.params['urlText'], 'example.com'), title = str(p.params['title']), from = str(p.params['fromLabel']), to = str(p.params['toLabel']), caption = str(p.params['caption']);
  const inner = str(p.params['inner'], 'none');
  const target = Math.max(0, Math.min(1, num(p.params['progress'], 0.6)));
  const k = spring({ frame: frame - Math.round(0.3 * fps), fps, config: { damping: 200 }, durationInFrames: Math.round(1.2 * fps) }) * target;
  const r = Math.min(p.w, p.h) * 0.06, barH = p.h * 0.14, pad = p.w * 0.05;
  const panel = p.fill === t.accent ? t.bg2 : p.fill;
  const bodyH = p.h - barH, innerW = p.w - 2 * pad;
  const iconS = Math.min(bodyH * 0.3, p.w * 0.18);
  const titleRun = title ? fitRun(title, innerW, bodyH * 0.2, TEXT_FLOORS_U.cardTitle * p.u, 2, 800, t.headingFont) : null;
  const captionRun = caption ? fitRun(caption, innerW, bodyH * 0.12, TEXT_FLOORS_U.cardCaption * p.u, 2, 500, t.bodyFont) : null;
  // the card grows with its content (title + pictograms + bar + caption): the stored box is the minimum, nothing is clipped
  return (
    <div data-em-browser-card style={{ width: p.w, minHeight: p.h, borderRadius: r, background: panel, overflow: 'hidden', fontFamily: fontStack(t.bodyFont), color: t.text, boxShadow: `0 ${8 * p.u}px ${30 * p.u}px rgba(0,0,0,0.35)`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: barH, flex: 'none', display: 'flex', alignItems: 'center', gap: barH * 0.25, padding: `0 ${pad}px`, background: 'rgba(0,0,0,0.25)' }}>
        {[t.negative, t.warn, t.accent2].map((c, i) => <div key={i} style={{ width: barH * 0.3, height: barH * 0.3, borderRadius: '50%', background: c }} />)}
        <div style={{ flex: 1, marginLeft: barH * 0.3, height: barH * 0.6, borderRadius: barH * 0.3, background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', padding: `0 ${barH * 0.4}px`, fontSize: fitOneLine(url, innerW - barH * 2.6, barH * 0.36, barH * 0.2, 500, t.bodyFont), color: t.muted, whiteSpace: 'nowrap', overflow: 'hidden' }}>{url}</div>
      </div>
      <div style={{ flex: '1 0 auto', minHeight: bodyH, padding: `${pad * 0.8}px ${pad}px`, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-evenly', gap: bodyH * 0.06 }}>
        {titleRun ? <Run run={titleRun} family={t.headingFont} weight={800} colour={t.text} mark="card-title" /> : null}
        {inner === 'reactor-datacenter' ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: iconS * 0.4 }}>
          <InlineIcon name="reactor" size={iconS} main={t.accent} accent={t.text} />
          <div style={{ width: iconS * 1.2, height: Math.max(2, 4 * p.u), background: t.muted, borderRadius: 2 * p.u, position: 'relative' }}><div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${k * 100}%`, background: t.accent2, borderRadius: 2 * p.u }} /></div>
          <InlineIcon name="data-center" size={iconS} main={t.accent2} accent={t.bg} />
        </div> : null}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: bodyH * 0.11, color: t.muted, fontWeight: 600, marginBottom: bodyH * 0.03 }}><span>{from}</span><span>{to}</span></div>
          <div style={{ height: bodyH * 0.09, borderRadius: bodyH * 0.045, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}><div data-em-progress style={{ width: `${k * 100}%`, height: '100%', background: t.accent, borderRadius: bodyH * 0.045 }} /></div>
        </div>
        {captionRun ? <Run run={captionRun} family={t.bodyFont} weight={500} colour={t.muted} mark="card-caption" /> : null}
      </div>
    </div>
  );
};

// ───────────────────────────── preset:shape.typing-box ─────────────────────────────
export const TYPING_CPS = 18;
/** Characters of `text` shown at `ms` into the element when `typing` (TYPING_CPS per second after a 250 ms pause); all when not typing. */
export function typedChars(text: string, ms: number, typing: boolean): number {
  if (!typing) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(((ms - 250) / 1000) * TYPING_CPS)));
}
const TypingBox: React.FC<ShapeProps> = (p) => {
  const t = useTheme(); const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const text = str(p.params['text']), badge = str(p.params['prefixBadge'], 'DM'), typing = p.params['typing'] !== false;
  const sendAt = typeof p.params['sendAt'] === 'number' ? p.params['sendAt'] : undefined;
  const sent = sendAt !== undefined && ms >= sendAt;
  const shown = typedChars(text, ms, typing);
  const caret = !sent && shown < text.length && Math.floor(frame / Math.max(1, Math.round(fps / 2))) % 2 === 0;
  const sendK = sent ? spring({ frame: frame - Math.round((sendAt! / 1000) * fps), fps, config: { damping: 12 } }) : 0;
  const r = p.h * 0.5, pad = p.h * 0.22, font = p.h * 0.34;
  const panel = p.fill === t.accent ? t.bg2 : p.fill;
  // the full text decides the size (shrink to the floor, then up to 2 lines) so the box does not change while typing
  const run = fitRun(text || ' ', p.w - p.h * 2.4, font, TEXT_FLOORS_U.tag * p.u, 2, 500, t.bodyFont);
  const visible = text.slice(0, shown);
  return (
    <div data-em-typing-box data-em-sent={sent ? 'true' : undefined} style={{ width: p.w, minHeight: p.h, borderRadius: r, background: panel, display: 'flex', alignItems: 'center', gap: pad * 0.6, padding: `${pad * 0.3}px ${pad * 0.5}px`, boxSizing: 'border-box', fontFamily: fontStack(t.bodyFont), color: t.text, boxShadow: sent ? `0 0 0 ${3 * p.u}px ${t.accent2}` : 'none', scale: `${1 + 0.04 * Math.sin(Math.min(1, sendK) * Math.PI)}` }}>
      <div style={{ flex: 'none', height: p.h * 0.6, padding: `0 ${pad * 0.5}px`, borderRadius: p.h * 0.3, background: t.accent, color: t.bg, fontFamily: fontStack(t.headingFont), fontWeight: 800, fontSize: font * 0.8, display: 'flex', alignItems: 'center' }}>{badge}</div>
      <div style={{ flex: 1, minWidth: 0, fontSize: run.fontSize, lineHeight: RUN_LINE_HEIGHT, fontWeight: 500, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{visible}{caret ? <span style={{ color: t.accent }}>|</span> : null}</div>
      <div style={{ flex: 'none', width: p.h * 0.6, height: p.h * 0.6, borderRadius: '50%', background: sent ? t.accent2 : 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width={p.h * 0.34} height={p.h * 0.34} viewBox="0 0 100 100">{sent ? <path d="M22 52 L42 72 L80 30" fill="none" stroke={t.bg} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M10 50 L90 12 L70 90 L50 58 Z" fill={t.muted} />}</svg>
      </div>
    </div>
  );
};

// ───────────────────────────── preset:shape.tag / source-tag ─────────────────────────────
/**
 * A pill that never cuts its text: the run shrinks to the floor on one line, then wraps (tag 2 lines, source tag 3); the pill's
 * height follows the text (the stored box is the minimum). `maxWidth` lets a source tag widen up to 90 % of the frame.
 */
const Pill: React.FC<{ w: number; h: number; u: number; text: string; fill: string; colour: string; outline?: boolean | undefined; weight: number; family: string; upper?: boolean; maxFont: number; minFont: number; maxLines: number; maxWidth?: number; mark: string }> = ({ w, h, u, text, fill, colour, outline, weight, family, upper, maxFont, minFont, maxLines, maxWidth, mark }) => {
  const padX = Math.min(h * 0.45, 28 * u), padY = Math.min(h * 0.18, 10 * u);
  const shown = upper ? text.toUpperCase() : text;
  const spacing = upper ? 0.04 : 0;
  let width = w;
  let run = fitRun(shown, w - 2 * padX, maxFont, minFont, maxLines, weight, family, spacing);
  if (run.overflow && maxWidth && maxWidth > w) {                            // a source tag may widen (up to 90 % of the frame) before it adds a line
    width = maxWidth;
    run = fitRun(shown, width - 2 * padX, maxFont, minFont, maxLines, weight, family, spacing);
  }
  const radius = Math.min(h, run.height + 2 * padY) / 2 + padY;
  return (
    <div data-em-pill={mark} data-em-lines={run.lines.length} style={{ width, minHeight: h, borderRadius: radius, background: outline ? 'transparent' : fill, boxShadow: outline ? `inset 0 0 0 ${Math.max(1, Math.min(h * 0.06, 3 * u))}px ${fill}` : 'none', color: colour, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `${padY}px ${padX}px`, boxSizing: 'border-box' }}>
      <Run run={run} family={family} weight={weight} colour={colour} align="center" upper={upper} {...(spacing ? { letterSpacing: `${spacing}em` } : {})} mark={mark} />
    </div>
  );
};
const Tag: React.FC<ShapeProps> = (p) => {
  const t = useTheme(); const tone = toneColours(str(p.params['tone'], 'info'), t);
  return <div data-em-tag={str(p.params['tone'], 'info')}><Pill w={p.w} h={p.h} u={p.u} text={str(p.params['text'], 'INFO')} fill={tone.fill} colour={tone.outline ? tone.fill : tone.text} outline={tone.outline} weight={800} family={t.headingFont} upper maxFont={p.h * 0.5} minFont={TEXT_FLOORS_U.tag * p.u} maxLines={2} mark="tag" /></div>;
};
const SourceTag: React.FC<ShapeProps> = (p) => {
  const t = useTheme(); const { width } = useVideoConfig();
  return <div data-em-source-tag><Pill w={p.w} h={p.h} u={p.u} text={str(p.params['text'])} fill={t.bg2} colour={t.muted} weight={500} family={t.bodyFont} maxFont={Math.min(p.h * 0.42, 28 * p.u)} minFont={TEXT_FLOORS_U.sourceTag * p.u} maxLines={3} maxWidth={width * 0.9} mark="source-tag" /></div>;
};

// ───────────────────────────── preset:shape.bars-h ─────────────────────────────
type HBar = { label: string; value: number; unit?: string; tone?: string };
const HBarRow: React.FC<{ b: HBar; i: number; h: number; w: number; u: number; max: number; showValue: boolean; t: ThemeTokens; fallback: string }> = ({ b, i, h, w, u, max, showValue, t, fallback }) => {
  const s = useStagger(i, 150);
  const gap = h * 0.2;
  const labelW = w * 0.3, valueW = showValue ? w * 0.2 : 0, trackW = w - labelW - valueW - gap * (showValue ? 2 : 1);
  const fill = b.tone ? toneColours(b.tone, t).fill : fallback;
  const value = `${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(b.value)}${b.unit ? ` ${b.unit}` : ''}`;
  const label = fitRun(b.label, labelW, h * 0.4, TEXT_FLOORS_U.barLabel * u, 2, 600, t.bodyFont);
  const val = showValue ? fitRun(value, valueW, h * 0.4, TEXT_FLOORS_U.barLabel * u, 2, 800, t.headingFont) : null;
  return (
    <div data-em-bar={i} style={{ display: 'flex', alignItems: 'center', minHeight: h, width: w, gap }}>
      <div style={{ width: labelW, flex: 'none' }}><Run run={label} family={t.bodyFont} weight={600} colour={t.text} mark="bar-label" /></div>
      <div style={{ width: trackW, height: h * 0.55, borderRadius: h * 0.275, background: t.bg2, overflow: 'hidden' }}><div style={{ width: `${(max > 0 ? Math.min(1, b.value / max) : 0) * s * 100}%`, height: '100%', background: fill, borderRadius: h * 0.275 }} /></div>
      {val ? <div style={{ width: valueW, flex: 'none', opacity: interpolate(s, [0.5, 1], [0, 1], clamp) }}><Run run={val} family={t.headingFont} weight={800} colour={fill} mark="bar-value" /></div> : null}
    </div>
  );
};
const BarsH: React.FC<ShapeProps> = (p) => {
  const t = useTheme();
  const bars = arr<HBar>(p.params['bars']).filter((b) => b && typeof b.value === 'number');
  if (!bars.length) return null;
  const max = num(p.params['max'], Math.max(...bars.map((b) => b.value)));
  const gap = p.h * 0.05, rowH = (p.h - gap * (bars.length - 1)) / bars.length;
  return <div data-em-bars-h style={{ width: p.w, minHeight: p.h, display: 'flex', flexDirection: 'column', gap }}>{bars.map((b, i) => <HBarRow key={i} b={b} i={i} h={rowH} w={p.w} u={p.u} max={max} showValue={p.params['showValues'] !== false} t={t} fallback={p.fill} />)}</div>;
};

export const INFOGRAPHICS: Record<string, React.FC<ShapeProps>> = {
  'preset:shape.icon': Icon, 'preset:shape.rows': Rows, 'preset:shape.day-strip': DayStrip, 'preset:shape.browser-card': BrowserCard,
  'preset:shape.typing-box': TypingBox, 'preset:shape.tag': Tag, 'preset:shape.source-tag': SourceTag, 'preset:shape.bars-h': BarsH,
};
