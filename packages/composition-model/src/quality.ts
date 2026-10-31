// ADR-034 quality gate: deterministic checks of what a viewer will SEE (QA 2026-10-28: "very messy, raw, everything stacked in
// the middle"), run after the scene composer and after every Editor Agent plan, before the Creator sees the result. Pure.
// `autoFixOps` turns the unambiguous findings into ordinary operations (so they are one Undo with the plan); the rest is reported
// as a short checklist in the plan preview.
import { getPreset, listPresets } from '@expertmotion/catalogue';
import type { OperationT } from './operations.js';
import type { CompositionModelT, OverlayElementT, TextLayerT } from './schema.js';
import { deriveTiming } from './timing.js';
import { boxesOverlap, MIN_FIT_U, textGeometry, type BoxU } from './text-box.js';
import { frameInUnits } from './units.js';

export type QualityCode = 'overlap' | 'outside-safe-area' | 'text-overflow' | 'low-contrast' | 'no-entrance' | 'no-transition' | 'dead-air' | 'font-missing' | 'off-frame';
export interface QualityIssue {
  code: QualityCode; severity: 'warn' | 'info';
  /** Element ids involved (texts, shapes, images; cut index as `cut:<i>`). */
  ids: string[];
  atMs: number; message: { en: string; id: string };
  /** True when autoFixOps can repair it without a judgement call. */
  fixable: boolean;
}
export interface QualityOptions {
  /** Content padding (u) that replaces the ratio's default safe area (a scene spec's explicit safe zone). */
  safeArea?: { top: number; right: number; bottom: number; left: number };
  /** Longest stretch without any visible change before `dead-air` is reported (default 2500 ms). */
  deadAirMs?: number;
}

/**
 * The zones a platform covers for sure (status bar, caption / buttons, like rail): the default boundary of the quality gate.
 * Narrower than the layout safe area (units.ts safeAreaU), so a Creator's explicit safe zone (e.g. top 120 on 9:16) is respected.
 */
export function coveredZonesU(ratio: CompositionModelT['settings']['ratio']): { top: number; right: number; bottom: number; left: number } {
  if (ratio === '9:16') return { top: 96, right: 72, bottom: 260, left: 48 };
  return { top: 36, right: 36, bottom: 36, left: 36 };
}
type Item = { id: string; kind: 'text' | 'shape' | 'image' | 'video'; from: number; to: number; box: BoxU; el: TextLayerT | OverlayElementT };
const BUNDLED = new Set(listPresets({ category: 'font' }).map((p) => String(p.data?.['family'])));
const hexOk = (c: unknown): c is string => typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c);
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
/** WCAG 2.x contrast ratio of two #RRGGBB colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function shapeBox(o: OverlayElementT, f: { w: number; h: number }): BoxU {
  const s = o.scale ?? 1, w = o.size.w * s, h = o.size.h * s, cx = f.w / 2 + o.position.x, cy = f.h / 2 + o.position.y;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}
function items(m: CompositionModelT): Item[] {
  const f = frameInUnits(m.settings.ratio, m.settings.customRatio);
  return [
    ...m.tracks.text.map((t): Item => ({ id: t.id, kind: 'text', from: t.timing.atMs, to: t.timing.atMs + t.timing.durationMs, box: textGeometry(t, m.settings.ratio, m.theme.textDefaults, m.settings.customRatio).box, el: t })),
    ...m.tracks.overlay.map((o): Item => ({ id: o.id, kind: o.kind, from: o.timing.atMs, to: o.timing.atMs + o.timing.durationMs, box: shapeBox(o, f), el: o })),
  ];
}
const contains = (outer: BoxU, inner: BoxU) => { const cx = (inner.x0 + inner.x1) / 2, cy = (inner.y0 + inner.y1) / 2; return cx > outer.x0 && cx < outer.x1 && cy > outer.y0 && cy < outer.y1; };
/** Background colour behind a moment: the scene clip's colourA, else the project background, else the palette background. */
function backgroundAt(m: CompositionModelT, ms: number): string {
  const t = deriveTiming(m);
  const pal = String(getPreset(m.theme.paletteId)?.data?.['bg'] ?? '#14120F');
  const i = m.tracks.video.findIndex((c, k) => ms >= t.clipStartMs[k]! && ms < t.clipStartMs[k]! + c.durationMs);
  const clip = i >= 0 ? m.tracks.video[i] : undefined;
  if (clip?.scene) { const a = clip.scene.params['colourA']; return hexOk(a) ? a : pal; }
  if (clip?.assetId) return '#000000';
  const a = m.background?.params?.['colourA'];
  return hexOk(a) ? a : pal;
}
/** Time spans (ms) in which an element visibly changes: entrance, exit, idle loops, count-ups. */
function activity(m: CompositionModelT): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const add = (from: number, to: number) => { if (to > from) out.push([from, to]); };
  for (const x of [...m.tracks.text, ...m.tracks.overlay]) {
    const s = x.timing.atMs, e = s + x.timing.durationMs, mo = x.motion;
    add(s, s + 120);                                                       // appearing is a change even without motion
    if (mo) {
      add(s + mo.delayMs, s + mo.delayMs + mo.durationMs);
      if (mo.exit) add(e - Number(mo.params['exitMs'] ?? mo.durationMs), e);
      if (mo.params['loop'] && mo.params['loop'] !== 'none') add(s, e);
    }
    if ('effect' in x && x.effect?.presetId === 'preset:texteffect.counter') { const p = x.effect.params; const d = Number(p['delayMs'] ?? 0); add(s + d, s + d + Number(p['durationMs'] ?? 1200)); }
  }
  const t = deriveTiming(m);
  m.tracks.video.forEach((c, i) => {
    if (c.scene && (c.scene.presetId === 'preset:background.moving-gradient' || c.scene.presetId === 'preset:background.noise-clouds' || c.scene.params['animate'] === true)) add(t.clipStartMs[i]!, t.clipStartMs[i]! + c.durationMs);
    if (c.assetId) add(t.clipStartMs[i]!, t.clipStartMs[i]! + c.durationMs);    // media moves by itself
  });
  for (const tr of m.transitions) { const s = t.cutStartMs[tr.cutIndex]; if (s !== undefined) add(s, s + tr.durationMs); }
  for (const p of m.tracks.caption.styleId ? m.tracks.caption.pages : []) add(p.startMs, p.startMs + p.durationMs);
  return out.sort((a, b) => a[0] - b[0]);
}

export function qualityCheck(m: CompositionModelT, opts: QualityOptions = {}): QualityIssue[] {
  const out: QualityIssue[] = [];
  const f = frameInUnits(m.settings.ratio, m.settings.customRatio);
  const safe = opts.safeArea ?? coveredZonesU(m.settings.ratio);
  const all = items(m);
  const push = (code: QualityCode, severity: QualityIssue['severity'], ids: string[], atMs: number, en: string, id: string, fixable: boolean) => out.push({ code, severity, ids, atMs, message: { en, id }, fixable });
  const label = (x: Item) => (x.kind === 'text' ? `"${(x.el as TextLayerT).text.slice(0, 28)}"` : x.kind === 'shape' ? `shape ${(x.el as OverlayElementT & { presetId: string }).presetId.replace('preset:shape.', '')}` : x.kind === 'video' ? 'video bubble' : 'image');

  // overlap: two elements on screen together for > 600 ms (crossfades between scenes are shorter) whose painted boxes intersect;
  // a shape that holds a text / another shape (pill behind a label, ring around a number, bar under its value) is intended.
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i]!, b = all[j]!;
    const shared = Math.min(a.to, b.to) - Math.max(a.from, b.from);
    if (shared <= 600 || !boxesOverlap(a.box, b.box, -2)) continue;
    if ((a.kind !== 'text' && contains(a.box, b.box)) || (b.kind !== 'text' && contains(b.box, a.box))) continue;
    if (a.kind !== 'text' && b.kind !== 'text') continue;                 // decorative shapes may overlap each other
    push('overlap', 'warn', [a.id, b.id], Math.max(a.from, b.from), `${label(a)} overlaps ${label(b)}.`, `${label(a)} menumpuk dengan ${label(b)}.`, a.kind === 'text' && b.kind === 'text');
  }
  for (const x of all) {
    const tol = 4;
    const offFrame = x.box.x0 < -tol || x.box.y0 < -tol || x.box.x1 > f.w + tol || x.box.y1 > f.h + tol;
    const outside = x.box.x0 < safe.left - tol || x.box.y0 < safe.top - tol || x.box.x1 > f.w - safe.right + tol || x.box.y1 > f.h - safe.bottom + tol;
    if (offFrame) push('off-frame', 'warn', [x.id], x.from, `${label(x)} is partly outside the frame.`, `${label(x)} sebagian di luar bingkai.`, true);
    else if (outside && x.kind === 'text') push('outside-safe-area', 'warn', [x.id], x.from, `${label(x)} reaches into the area covered by app buttons / captions.`, `${label(x)} masuk ke area yang tertutup tombol / caption aplikasi.`, true);
    if (x.kind === 'text') {
      const t = x.el as TextLayerT;
      const g = textGeometry(t, m.settings.ratio, m.theme.textDefaults, m.settings.customRatio);
      if (g.overflow) push('text-overflow', 'warn', [x.id], x.from, `${label(x)} is too long to fit even at ${MIN_FIT_U} u.`, `${label(x)} terlalu panjang, tidak muat meski diperkecil.`, false);
      const fam = t.style.fontFamily;
      if (fam && !BUNDLED.has(fam)) push('font-missing', 'warn', [x.id], x.from, `Font "${fam}" is not bundled; a fallback font would be used.`, `Font "${fam}" tidak tersedia; font cadangan akan dipakai.`, true);
      const colour = t.style.colour ?? m.theme.textDefaults.colour;
      const bg = t.style.box?.colour ?? backgroundAt(m, x.from + 1);
      const ratio = contrastRatio(colour, bg), large = g.fontSizeU >= 64 || (g.fontSizeU >= 48 && g.weight >= 700);
      if (ratio < (large ? 3 : 4.5)) push('low-contrast', 'warn', [x.id], x.from, `${label(x)} has low contrast (${ratio.toFixed(1)}:1).`, `${label(x)} kontrasnya rendah (${ratio.toFixed(1)}:1).`, true);
    }
    if (!x.el.motion) push('no-entrance', 'info', [x.id], x.from, `${label(x)} appears without animation.`, `${label(x)} muncul tanpa animasi.`, false);
  }
  const cuts = Math.max(0, m.tracks.video.length - 1);
  for (let c = 0; c < cuts; c++) if (!m.transitions.some((t) => t.cutIndex === c)) push('no-transition', 'info', [`cut:${c}`], deriveTiming(m).cutStartMs[c] ?? 0, `Cut ${c + 1} is a hard cut.`, `Potongan ${c + 1} tanpa transisi.`, false);
  // dead air: the longest stretch of the video in which nothing on screen changes
  const total = deriveTiming(m).durationMs, limit = opts.deadAirMs ?? 2500;
  let cursor = 0;
  for (const [s, e] of [...activity(m), [total, total] as [number, number]]) {
    if (s - cursor > limit) push('dead-air', 'info', [], cursor, `Nothing moves for ${((s - cursor) / 1000).toFixed(1)} s from ${(cursor / 1000).toFixed(1)} s.`, `Tidak ada gerakan selama ${((s - cursor) / 1000).toFixed(1).replace('.', ',')} dtk mulai ${(cursor / 1000).toFixed(1).replace('.', ',')} dtk.`, false);
    cursor = Math.max(cursor, e);
  }
  return out;
}

/**
 * Operations that repair the unambiguous findings: a text that overlaps a text starting earlier moves below it (or above when
 * there is no room) and shrinks a little when neither fits; anything outside the safe area / frame moves inside; low contrast
 * switches to the palette text colour (or black / white, whichever reads better); a missing font returns to the theme font.
 */
export function autoFixOps(m: CompositionModelT, issues: readonly QualityIssue[], opts: QualityOptions = {}): OperationT[] {
  const f = frameInUnits(m.settings.ratio, m.settings.customRatio);
  const safe = opts.safeArea ?? coveredZonesU(m.settings.ratio);
  const ops: OperationT[] = [];
  const all = new Map(items(m).map((x) => [x.id, x]));
  const moved = new Map<string, BoxU>();
  const boxOf = (id: string) => moved.get(id) ?? all.get(id)!.box;
  const moveTo = (x: Item, box: BoxU) => {
    const cx = (box.x0 + box.x1) / 2 - (x.box.x0 + x.box.x1) / 2, cy = (box.y0 + box.y1) / 2 - (x.box.y0 + x.box.y1) / 2;
    const pos = x.el.position;
    moved.set(x.id, box);
    ops.push({ op: 'op:element.setTransform', target: { kind: x.kind, id: x.id }, args: { x: round4((pos.x + cx) / f.w), y: round4((pos.y + cy) / f.h) } });
  };
  const inside = (b: BoxU): BoxU => {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    const x0 = Math.min(Math.max(b.x0, safe.left), Math.max(safe.left, f.w - safe.right - w)), y0 = Math.min(Math.max(b.y0, safe.top), Math.max(safe.top, f.h - safe.bottom - h));
    return { x0, y0, x1: x0 + w, y1: y0 + h };
  };
  for (const i of issues) {
    if (!i.fixable) continue;
    const x = all.get(i.ids[0] ?? '');
    switch (i.code) {
      case 'outside-safe-area': case 'off-frame': if (x && !moved.has(x.id)) moveTo(x, inside(x.box)); break;
      case 'overlap': {
        const [a, b] = i.ids.map((id) => all.get(id)!);
        if (!a || !b) break;
        const later = a.from > b.from || (a.from === b.from && a.box.y0 > b.box.y0) ? a : b, other = later === a ? b : a;
        if (moved.has(later.id)) break;
        const ob = boxOf(other.id), h = later.box.y1 - later.box.y0, gap = 24;
        const below = { ...later.box, y0: ob.y1 + gap, y1: ob.y1 + gap + h }, above = { ...later.box, y0: ob.y0 - gap - h, y1: ob.y0 - gap };
        if (below.y1 <= f.h - safe.bottom) moveTo(later, below);
        else if (above.y0 >= safe.top) moveTo(later, above);
        else {
          const t = later.el as TextLayerT, g = textGeometry(t, m.settings.ratio, m.theme.textDefaults, m.settings.customRatio);
          ops.push({ op: 'op:text.setStyle', target: { kind: 'text', id: later.id }, args: { fontSize: Math.max(MIN_FIT_U, Math.round(g.fontSizeU * 0.8)) } });
        }
        break;
      }
      case 'low-contrast': {
        const t = x?.el as TextLayerT | undefined; if (!t) break;
        const bg = t.style.box?.colour ?? backgroundAt(m, x!.from + 1);
        const pal = String(getPreset(m.theme.paletteId)?.data?.['text'] ?? '#FFFFFF');
        const pick = [pal, '#FFFFFF', '#000000'].sort((p, q) => contrastRatio(q, bg) - contrastRatio(p, bg))[0]!;
        ops.push({ op: 'op:text.setStyle', target: { kind: 'text', id: t.id }, args: { colour: pick } });
        break;
      }
      case 'font-missing': {
        const fam = String(getPreset(String(getPreset(m.theme.fontPairId)?.data?.['heading']))?.data?.['family'] ?? 'Inter');
        if (x) ops.push({ op: 'op:text.setStyle', target: { kind: 'text', id: x.id }, args: { fontFamily: fam } });
        break;
      }
      default: break;
    }
  }
  return ops;
}
const round4 = (v: number) => Math.max(-2, Math.min(2, Math.round(v * 10_000) / 10_000));

/** A short checklist of what is left (plan preview), in the Creator's language; at most `max` lines. */
export function qualityChecklist(issues: readonly QualityIssue[], language: 'id' | 'en', max = 5): string[] {
  const rank = (i: QualityIssue) => (i.severity === 'warn' ? 0 : 1);
  return [...issues].sort((a, b) => rank(a) - rank(b) || a.atMs - b.atMs).slice(0, max).map((i) => `${(i.atMs / 1000).toFixed(1)}s · ${i.message[language]}`);
}
