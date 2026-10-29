// Timeline View (stage.timeline.*): ruler, playhead, selection and inspector (IX-09, IX-10) and CapCut-style editing (ADR-027,
// FR-068, IX-26): one lane per layer with the front-most layer on top, then captions above them all, the video Track, and audio
// lanes at the bottom. Every text, image, shape and audio bar can be dragged in time and across lanes and trimmed at its edges;
// video Clips reorder and trim as before. Snapping to the playhead and other edges (Alt disables), a live ghost, keyboard
// alternatives, and one undoable Compile pick per gesture (op:element.setTiming / op:element.setLayer; no LLM).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Bot, Minus, Plus, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { deriveTiming, type CompositionModelT, type ElementRefT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import type { AppState } from '../state/reducer.js';
import type { ElementEdit, PlanDto } from '../api/types.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { playerBus } from './playerBus.js';
import { QuickParams } from './QuickParams.js';
import { TransformFields } from './TransformFields.js';
import { isTransformKind } from './canvas-transform.js';
import { runSplit } from './split.js';
import { runDelete } from './items.js';
import { ItemMenu, isMenuKey, type ItemMenuAnchor } from './ItemMenu.js';
import { formatTimecode, translate } from '../i18n/index.js';

type Track = 'video' | 'overlay' | 'text' | 'caption' | 'audio';
/** One Timeline row, top to bottom. `layer` rows hold texts/images/shapes of that layer; the extra empty lane above the top layer (and below the last audio lane) is where a drop opens a new lane. */
export interface LaneRow { key: string; kind: 'caption' | 'layer' | 'video' | 'audio'; lane: number; isNew: boolean; /** compact view: the layers this row shows (top → bottom) */ layers?: number[] }
interface Bar { id: string; ref: ElementRefT; kind: string; label: string; fromMs: number; toMs: number; track: Track; row: string; lane?: number; diffId: string; assetId?: string; generated?: boolean; /** ADR-030 scene clip: CSS background of its preset (no media) */ swatch?: string }
type EditableKind = ElementEdit['kind'];
const EDITABLE = new Set(['text', 'image', 'shape', 'audio']);
const isEditable = (b: Pick<Bar, 'kind'>) => EDITABLE.has(b.kind);

/** ADR-030: a CSS background for a scene clip bar from the hex colours in its background params (else an accent gradient). */
export function sceneSwatch(params: Record<string, unknown> | undefined): string {
  const hex = Object.values(params ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v));
  if (hex.length >= 2) return `linear-gradient(90deg, ${hex[0]}, ${hex[1]})`;
  if (hex.length === 1) return hex[0]!;
  return 'linear-gradient(90deg, var(--em-accent), var(--em-panel-2))';
}
/** FR-064: every Timeline Element as a bar; backgrounds span the whole duration; `generated` marks Assets made by a generator. */
export function buildBars(model: CompositionModelT, assetName: (id: string) => string, lang: 'en' | 'id', generatedAssets: ReadonlySet<string> = new Set()): Bar[] {
  const t = deriveTiming(model);
  const bars: Bar[] = [];
  const label = (id: string) => getPreset(id)?.label[lang] ?? id;
  if (model.background) bars.push({ id: 'background', ref: { kind: 'background' }, kind: 'background', label: label(model.background.presetId), fromMs: 0, toMs: Math.max(1, t.durationMs), track: 'video', row: 'video', diffId: 'background' });
  model.tracks.video.forEach((c, i) => {
    const w = t.elementWindows[c.id]!;
    if (c.assetId === undefined) {
      // ADR-030: a scene clip (no media): "Scene N · <background>" with a colour / gradient swatch instead of a thumbnail.
      const bg = c.scene?.presetId;
      bars.push({ id: c.id, ref: { kind: 'clip', id: c.id }, kind: 'clip', label: `${translate(lang, 'ui.stage.timeline.scene', { n: i + 1 })}${bg ? ` · ${label(bg)}` : ''}`, fromMs: w.fromMs, toMs: w.toMs, track: 'video', row: 'video', diffId: c.id, swatch: sceneSwatch(c.scene?.params) });
    } else bars.push({ id: c.id, ref: { kind: 'clip', id: c.id }, kind: 'clip', label: `${i + 1} · ${assetName(c.assetId)}`, fromMs: w.fromMs, toMs: w.toMs, track: 'video', row: 'video', diffId: c.id, assetId: c.assetId, generated: generatedAssets.has(c.assetId) });
    c.effects.forEach((e) => bars.push({ id: `effect:${c.id}:${e.presetId}`, ref: { kind: 'effect', id: `${c.id}|${e.presetId}` }, kind: 'effect', label: label(e.presetId), fromMs: w.fromMs, toMs: w.toMs, track: 'video', row: 'video', diffId: c.id }));
  });
  for (const tr of model.transitions) {
    const at = t.cutStartMs[tr.cutIndex];
    if (at === undefined) continue;
    bars.push({ id: `cut:${tr.cutIndex}`, ref: { kind: 'cut', index: tr.cutIndex }, kind: 'transition', label: getPreset(tr.presetId)?.label[lang] ?? tr.presetId, fromMs: at, toMs: at + tr.durationMs, track: 'video', row: 'video', diffId: `cut:${tr.cutIndex}` });
  }
  for (const o of model.tracks.overlay) bars.push({ id: o.id, ref: { kind: o.kind, id: o.id }, kind: o.kind, label: o.kind === 'shape' ? label(o.presetId) : assetName(o.assetId), fromMs: o.timing.atMs, toMs: o.timing.atMs + o.timing.durationMs, track: 'overlay', row: `layer:${o.layer}`, lane: o.layer, diffId: o.id,
    ...(o.kind === 'image' ? { assetId: o.assetId, generated: generatedAssets.has(o.assetId) } : {}) });
  for (const x of model.tracks.text) bars.push({ id: x.id, ref: { kind: 'text', id: x.id }, kind: 'text', label: x.text, fromMs: x.timing.atMs, toMs: x.timing.atMs + x.timing.durationMs, track: 'text', row: `layer:${x.layer}`, lane: x.layer, diffId: x.id });
  model.tracks.caption.pages.forEach((p, i) => bars.push({ id: `caption:${i}`, ref: { kind: 'caption', index: i }, kind: 'caption', label: p.text, fromMs: p.startMs, toMs: p.startMs + p.durationMs, track: 'caption', row: 'caption', diffId: `caption:${i}` }));
  for (const a of model.tracks.audio) { const w = t.elementWindows[a.id]; bars.push({ id: a.id, ref: { kind: 'audio', id: a.id }, kind: 'audio', label: assetName(a.assetId), fromMs: w?.fromMs ?? a.atMs, toMs: w?.toMs ?? a.atMs + (a.durationMs ?? 1000), track: 'audio', row: `audio:${a.lane}`, lane: a.lane, diffId: a.id, assetId: a.assetId, generated: generatedAssets.has(a.assetId) }); }
  return bars;
}

/** Rows top → bottom (CapCut order): captions, a new-layer lane, layers front → back, the video Track, audio lanes, a new audio lane. */
export function laneRows(model: CompositionModelT): LaneRow[] {
  const top = Math.max(-1, ...model.tracks.overlay.map((o) => o.layer), ...model.tracks.text.map((x) => x.layer));
  const lastAudio = Math.max(-1, ...model.tracks.audio.map((a) => a.lane));
  return [
    { key: 'caption', kind: 'caption', lane: 0, isNew: false },
    ...Array.from({ length: top + 2 }, (_, i): LaneRow => { const lane = top + 1 - i; return { key: `layer:${lane}`, kind: 'layer', lane, isNew: lane === top + 1 }; }),
    { key: 'video', kind: 'video', lane: 0, isNew: false },
    ...Array.from({ length: lastAudio + 2 }, (_, lane): LaneRow => ({ key: `audio:${lane}`, kind: 'audio', lane, isNew: lane === lastAudio + 1 })),
  ];
}

/**
 * QA UX round 1 (36 layer rows after a composed video): the compact view packs consecutive layers into one row when none of
 * their texts / images / shapes overlap in time — then their front/back order cannot be seen, so nothing visible is lost.
 * Only the view changes: every element keeps its own `layer`; a vertical drag onto another packed row moves it to that
 * row's top layer (the lane rule in applyOps still resolves a busy layer). `rowOf` maps an element's own row to its packed row.
 */
export function compactRows(model: CompositionModelT, rows: readonly LaneRow[]): { rows: LaneRow[]; rowOf: Map<string, string> } {
  const spans = new Map<number, Array<[number, number]>>();
  for (const e of [...model.tracks.overlay, ...model.tracks.text]) {
    const list = spans.get(e.layer) ?? []; list.push([e.timing.atMs, e.timing.atMs + e.timing.durationMs]); spans.set(e.layer, list);
  }
  const overlaps = (a: Array<[number, number]>, b: Array<[number, number]>) => a.some(([f1, t1]) => b.some(([f2, t2]) => f1 < t2 && f2 < t1));
  const out: LaneRow[] = []; const rowOf = new Map<string, string>();
  let group: LaneRow[] = []; let used: Array<[number, number]> = [];
  const flush = () => {
    if (!group.length) return;
    const layers = group.map((r) => r.lane);                          // top → bottom
    const key = group.length === 1 ? group[0]!.key : `layers:${layers[0]}-${layers[layers.length - 1]}`;
    for (const r of group) rowOf.set(r.key, key);
    out.push({ key, kind: 'layer', lane: layers[0]!, isNew: false, layers });
    group = []; used = [];
  };
  for (const r of rows) {
    if (r.kind !== 'layer' || r.isNew) { flush(); out.push(r); rowOf.set(r.key, r.key); continue; }
    const mine = spans.get(r.lane) ?? [];
    if (group.length && overlaps(used, mine)) flush();
    group.push(r); used = [...used, ...mine];
  }
  flush();
  return { rows: out, rowOf };
}
/** The compact view is the default once a project has more than this many layers (the toggle shows every layer again). */
export const COMPACT_AFTER_LAYERS = 6;

const KIND_COLOUR: Record<string, string> = { clip: 'var(--em-accent)', image: 'var(--em-accent)', shape: 'var(--em-accent-2)', text: '#F4F5F7', caption: 'var(--em-info)', audio: '#8FB3FF', transition: 'var(--em-warn)', effect: 'var(--em-accent-2)', background: 'var(--em-muted)' };
/** Thin strips inside the video lane: background on top (whole duration), effects under their clip. */
const STRIP: Record<string, string> = { background: 'top-0 h-[5px] z-0', effect: 'top-[29px] h-[6px] z-10' };
const ZOOM_MIN = 10, ZOOM_MAX = 1000;
const EDGE_PX = 6;
/** Row height in px (h-9); a vertical drag of one row height changes the lane by one. */
export const ROW_PX = 36;
/** Snap distance in screen pixels (FR-068: playhead and other items' edges). */
export const SNAP_PX = 8;
export type ClipDragMode = 'move' | 'start' | 'end';

/**
 * FR-068: the clip edit a drag stands for. Move → the index among the other clips' centres; trim → frame-snapped
 * trimBeforeMs/durationMs kept inside the source media (EM-2306 is still enforced by the model). Null when nothing changes.
 */
export function clipDragEdit(model: CompositionModelT, clipId: string, mode: ClipDragMode, deltaMs: number, assetOf: (id: string) => { kind: string; durationMs: number | null } | null): { clipId: string; toIndex?: number; trimBeforeMs?: number; durationMs?: number } | null {
  const v = model.tracks.video, i = v.findIndex((c) => c.id === clipId), c = v[i];
  if (!c) return null;
  const timing = deriveTiming(model);
  if (mode === 'move') {
    const w = timing.elementWindows[c.id]!;
    const centre = (w.fromMs + w.toMs) / 2 + deltaMs;
    const toIndex = v.filter((x) => x.id !== c.id).filter((x) => { const xw = timing.elementWindows[x.id]!; return (xw.fromMs + xw.toMs) / 2 < centre; }).length;
    return toIndex === i ? null : { clipId, toIndex };
  }
  const frame = 1000 / model.settings.fps;
  const snap = (ms: number) => Math.round(Math.round(ms / frame) * frame);
  const a = c.assetId === undefined ? undefined : assetOf(c.assetId);
  const source = a?.kind === 'video' && a.durationMs !== null ? a.durationMs : null;
  if (mode === 'end') {
    const max = source === null ? 1_800_000 : Math.floor((source - c.trimBeforeMs) / c.playbackRate);
    const durationMs = Math.max(100, Math.min(max, snap(c.durationMs + deltaMs)));
    return durationMs === c.durationMs ? null : { clipId, trimBeforeMs: c.trimBeforeMs, durationMs };
  }
  if (source === null) return null;                                      // images have no source offset to trim
  const d = Math.max(-c.trimBeforeMs / c.playbackRate, Math.min(c.durationMs - 100, snap(deltaMs)));
  const trimBeforeMs = Math.max(0, Math.round(c.trimBeforeMs + d * c.playbackRate)), durationMs = Math.max(100, Math.round(c.durationMs - d));
  return trimBeforeMs === c.trimBeforeMs ? null : { clipId, trimBeforeMs, durationMs };
}

export interface ElementDragOptions {
  /** Pixels per millisecond at the current zoom. */
  pxPerMs: number; playheadMs: number;
  /** False while Alt/Option is held: no snapping to the playhead or edges (frame grid only). */
  snap: boolean;
  /** Edges to snap to (other bars' starts/ends, 0, the end of the video). */
  edges: readonly number[];
  assetOf: (id: string) => { durationMs: number | null } | null;
  /** the rows on screen (compact view: packed rows); default laneRows(model) */
  rows?: readonly LaneRow[];
}
export interface ElementDragResult { edit: ElementEdit | null; fromMs: number; toMs: number; row: string; snapMs: number | null }
/**
 * ADR-027 / FR-068: what a drag of a text, image, shape or audio bar stands for. `mode` move shifts it in time and by
 * `rowDelta` rows (lanes; the new lane above the top layer / below the last audio lane opens a lane); start/end trim an edge
 * (audio left-edge trims move the source offset and stay inside the source unless looping). Times snap to the frame grid and,
 * unless `snap` is false, to the playhead and other edges within SNAP_PX. `edit` is null when nothing changes.
 */
export function elementDragEdit(model: CompositionModelT, bar: Pick<Bar, 'id' | 'kind' | 'fromMs' | 'toMs' | 'row'> & { lane?: number }, mode: ClipDragMode, dxPx: number, rowDelta: number, o: ElementDragOptions): ElementDragResult | null {
  if (!isEditable(bar)) return null;
  const kind = bar.kind as EditableKind;
  const audio = kind === 'audio' ? model.tracks.audio.find((a) => a.id === bar.id) : undefined;
  if (kind === 'audio' && !audio) return null;
  const frame = 1000 / model.settings.fps;
  const grid = (ms: number) => Math.round(Math.round(ms / frame) * frame);
  const threshold = SNAP_PX / Math.max(1e-6, o.pxPerMs);
  const edges = o.snap ? [...o.edges, o.playheadMs] : [];
  const nearest = (ms: number): number | null => { let best: number | null = null; for (const e of edges) if (Math.abs(e - ms) <= threshold && (best === null || Math.abs(e - ms) < Math.abs(best - ms))) best = e; return best; };
  const from0 = bar.fromMs, len0 = bar.toMs - bar.fromMs, d = dxPx / Math.max(1e-6, o.pxPerMs);
  const src = audio ? o.assetOf(audio.assetId)?.durationMs ?? null : null;
  const tb0 = audio?.trimBeforeMs ?? 0;
  let from = from0, len = len0, snapMs: number | null = null;
  if (mode === 'move') {
    const raw = from0 + d, s = nearest(raw), e = nearest(raw + len0);
    if (s !== null && (e === null || Math.abs(s - raw) <= Math.abs(e - raw - len0))) { from = s; snapMs = s; }
    else if (e !== null) { from = e - len0; snapMs = e; }
    else from = grid(raw);
    from = Math.max(0, Math.round(from));
    if (snapMs !== null && from !== snapMs && from + len0 !== snapMs) snapMs = null;
  } else if (mode === 'end') {
    const raw = from0 + len0 + d, s = nearest(raw);
    let end = s ?? grid(raw); snapMs = s;
    const max = audio && !audio.loop && src !== null ? from0 + (src - tb0) : Infinity;
    end = Math.min(max, Math.max(from0 + 100, end));
    if (end !== snapMs) snapMs = null;
    len = Math.round(end - from0);
  } else {
    const raw = from0 + d, s = nearest(raw);
    let start = s ?? grid(raw); snapMs = s;
    const min = Math.max(0, audio ? from0 - tb0 : 0);
    start = Math.max(min, Math.min(from0 + len0 - 100, start));
    if (start !== snapMs) snapMs = null;
    from = Math.round(start); len = Math.round(from0 + len0 - start);
  }
  // Lanes (move only): rows of the same family, clamped to it.
  const rows = (o.rows ?? laneRows(model)).filter((r) => (kind === 'audio' ? r.kind === 'audio' : r.kind === 'layer'));
  const at = rows.findIndex((r) => r.key === bar.row);
  const target = mode === 'move' && at >= 0 ? rows[Math.max(0, Math.min(rows.length - 1, at + rowDelta))]! : rows[at];
  const curLane = audio ? audio.lane : bar.lane ?? Number(bar.row.split(':')[1] ?? 0);
  const lane = !target || target.key === bar.row ? curLane : target.lane;   // compact view: staying in the packed row keeps the layer
  const timeChanged = from !== from0 || len !== len0;
  let edit: ElementEdit | null = null;
  if (timeChanged) edit = { kind, id: bar.id, atMs: from, durationMs: Math.max(100, len), ...(audio && mode === 'start' ? { trimBeforeMs: Math.max(0, Math.round(tb0 + (from - from0))) } : {}), ...(lane !== curLane ? { layer: lane } : {}) };
  else if (lane !== curLane) edit = { kind, id: bar.id, layer: lane };
  return { edit, fromMs: from, toMs: from + len, row: target?.key ?? bar.row, snapMs };
}
const TRACK_CHIP: Partial<Record<LaneRow['kind'], 'caption' | 'video'>> = { caption: 'caption', video: 'video' };

export function TimelineView({ height = 240 }: { height?: number } = {}) {
  const { state, actions, t, lang, prefs, dispatch, runtime } = useStore();
  const model = state.head?.model;
  const [zoom, setZoom] = useState<number | null>(null);         // px per second; null = fit
  const [width, setWidth] = useState(600);
  const [liveMs, setLiveMs] = useState(state.playheadMs);
  const lanes = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);                      // FR-254: the one scroll container (both axes); ruler sticks to its top
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => playerBus.subscribe(setLiveMs), []);
  useEffect(() => { setLiveMs(state.playheadMs); }, [state.playheadMs]);
  useEffect(() => {
    const el = lanes.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { if (e) setWidth(Math.max(200, e.contentRect.width)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const assetName = (id: string) => state.assets.find((a) => a.id === id)?.name ?? id.slice(-6);
  const [generated, setGenerated] = useState<ReadonlySet<string>>(new Set());
  const projectId = state.project?.id;
  useEffect(() => {                                                   // FR-064: which Assets came from a generator
    if (!projectId) return;
    let live = true;
    runtime.api.listGeneratorJobs(projectId, { limit: 100 }).then((p) => { if (live) setGenerated(new Set(p.items.flatMap((j) => (j.resultAssetId ? [j.resultAssetId] : [])))); }).catch(() => undefined);
    return () => { live = false; };
  }, [projectId, state.assets.length, runtime]);
  const bars = useMemo(() => (model ? buildBars(model, assetName, lang, generated) : []), [model, state.assets, lang, generated]); // eslint-disable-line react-hooks/exhaustive-deps
  const fullRows = useMemo(() => (model ? laneRows(model) : []), [model]);
  const layerCount = fullRows.filter((r) => r.kind === 'layer' && !r.isNew).length;
  const [compactPref, setCompactPref] = useState<boolean | null>(null);          // null = automatic (compact past COMPACT_AFTER_LAYERS)
  const compact = compactPref ?? layerCount > COMPACT_AFTER_LAYERS;
  const packed = useMemo(() => (model && compact ? compactRows(model, fullRows) : null), [model, compact, fullRows]);
  const rows = packed?.rows ?? fullRows;
  const barsOnScreen = useMemo(() => (packed ? bars.map((b) => ({ ...b, row: packed.rowOf.get(b.row) ?? b.row })) : bars), [bars, packed]);
  const durationMs = model ? deriveTiming(model).durationMs : 1000;
  const pxPerMs = (zoom ?? (width - 8) / (durationMs / 1000)) / 1000;
  const pxRef = useRef(pxPerMs);
  pxRef.current = pxPerMs;
  useEffect(() => {                                                   // FR-063: Ctrl+wheel zooms around the pointer (non-passive so the page does not zoom)
    const el = lanes.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cur = pxRef.current * 1000;
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, e.deltaY < 0 ? cur * 1.2 : cur / 1.2));
      const r = el.getBoundingClientRect();                           // the lanes box moves with the scroll, so this is already content time
      const atMs = (e.clientX - r.left) / pxRef.current;
      setZoom(next);
      requestAnimationFrame(() => { const sc = scroller.current; if (sc) sc.scrollLeft = Math.max(0, sc.scrollLeft + r.left + atMs * (next / 1000) - e.clientX); });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const fps = model?.settings.fps ?? 30;
  const hasClip = (model?.tracks.video.length ?? 0) > 0;
  const showLanes = hasClip || bars.length > 0;                         // FR-069: a project with nothing on it shows only the empty state
  const pulseIds = state.pulse && Date.now() - state.pulse.at < 5000 ? new Set(state.pulse.diff.map((d) => d.elementId)) : new Set<string>();
  const isSelected = (b: Bar) => state.selection.some((s) => s.kind === b.ref.kind && (s.id !== undefined ? s.id === b.ref.id : s.index === b.ref.index));
  const assetOf = (id: string) => state.assets.find((a) => a.id === id) ?? null;
  // FR-068: drag a video Clip to reorder it or its edges to trim; ADR-027: drag any text, image, shape or audio bar in time and
  // across lanes, or its edges to trim. One gesture = one Compile pick through the Intent Queue (undoable).
  const [drag, setDrag] = useState<{ id: string; mode: ClipDragMode; dx: number; dy: number; alt: boolean } | null>(null);
  const suppressClick = useRef(false);
  const refocus = useRef<{ id: string; sig: string } | null>(null);
  const edgesFor = (id: string) => [0, durationMs, ...bars.filter((x) => x.id !== id && x.kind !== 'effect' && x.kind !== 'background').flatMap((x) => [x.fromMs, x.toMs])];
  const dragOpts = (id: string, alt: boolean): ElementDragOptions => ({ pxPerMs: pxRef.current, playheadMs: liveMs, snap: !alt, edges: edgesFor(id), assetOf: (a) => { const x = assetOf(a); return x ? { durationMs: x.durationMs ?? null } : null; }, rows });
  const laneName = (r: LaneRow) => r.kind === 'layer' && r.layers && r.layers.length > 1 ? t('ui.stage.timeline.lane.layers', { from: r.layers[r.layers.length - 1]! + 1, to: r.layers[0]! + 1 }) : r.kind === 'layer' ? (r.isNew ? t('ui.stage.timeline.lane.new') : t('ui.stage.timeline.lane.layer', { n: r.lane + 1 })) : r.kind === 'audio' ? (r.isNew ? t('ui.stage.timeline.lane.newaudio') : t('ui.stage.timeline.lane.audio', { n: r.lane + 1 })) : t(`ui.stage.timeline.track.${r.kind}`);
  const editLabel = (b: Bar, e: ElementEdit, mode: ClipDragMode) => {
    if (e.atMs === undefined) return e.move ? t(`ui.stage.timeline.drag.move.${e.move}`, { label: b.label }) : t('ui.stage.timeline.drag.layer', { label: b.label, n: (e.layer ?? 0) + 1 });
    if (mode !== 'move') return t('ui.stage.timeline.drag.trimmed', { label: b.label });
    return e.layer !== undefined ? t('ui.stage.timeline.drag.retimedlayer', { label: b.label, time: formatTimecode(e.atMs, fps), n: e.layer + 1 }) : t('ui.stage.timeline.drag.retimed', { label: b.label, time: formatTimecode(e.atMs, fps) });
  };
  const startDrag = (b: Bar, e: ReactPointerEvent<HTMLButtonElement>) => {
    const clip = b.kind === 'clip' && b.track === 'video';
    if (!model || (!clip && !isEditable(b)) || e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const mode: ClipDragMode = e.clientX - r.left < EDGE_PX ? 'start' : r.right - e.clientX < EDGE_PX ? 'end' : 'move';
    const x0 = e.clientX, y0 = e.clientY; let dx = 0, dy = 0, alt = e.altKey, started = false;
    const move = (ev: PointerEvent) => {
      dx = ev.clientX - x0; dy = clip || mode !== 'move' ? 0 : (ev.clientY ?? y0) - y0; alt = ev.altKey;
      if (started || Math.abs(dx) >= 4 || Math.abs(dy) >= 4) { started = true; setDrag({ id: b.id, mode, dx, dy, alt }); }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', esc);
      setDrag(null);
      if (!started) return;
      suppressClick.current = true;
      alt = ev.altKey ?? alt;
      if (clip) {
        const edit = clipDragEdit(model, b.id, mode, dx / pxRef.current, (id) => assetOf(id));
        if (edit) void actions.clipEdit(edit, edit.toIndex !== undefined ? t('ui.stage.timeline.drag.moved', { label: b.label, n: edit.toIndex + 1 }) : t('ui.stage.timeline.drag.trimmed', { label: b.label }));
        return;
      }
      const res = elementDragEdit(model, b, mode, dx, Math.round(dy / ROW_PX), dragOpts(b.id, alt));
      if (res?.edit) void actions.elementEdit(res.edit, editLabel(b, res.edit, mode));
    };
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { started = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', esc); setDrag(null); } };   // Esc cancels the drag
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('keydown', esc);
  };
  // Keyboard alternatives (IX-26): ←/→ one frame, Shift+←/→ one second, Alt+↑/↓ one lane up / down.
  const onElementKey = (b: Bar, e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!model || !isEditable(b) || e.ctrlKey || e.metaKey) return;
    let edit: ElementEdit | null;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey) {
      const step = (e.shiftKey ? 1000 : 1000 / fps) * (e.key === 'ArrowLeft' ? -1 : 1);
      const atMs = Math.max(0, Math.round(b.fromMs + step));
      edit = atMs === b.fromMs ? null : { kind: b.kind as EditableKind, id: b.id, atMs, durationMs: Math.max(100, Math.round(b.toMs - b.fromMs)) };
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) edit = { kind: b.kind as EditableKind, id: b.id, move: e.key === 'ArrowUp' ? 'up' : 'down' };
    else return;
    e.preventDefault(); e.stopPropagation();                          // the Player's frame-step shortcut stays for everything else
    if (!edit) return;
    refocus.current = { id: b.id, sig: `${b.row}|${b.fromMs}|${b.toMs}` };
    void actions.elementEdit(edit, edit.move ? t(`ui.stage.timeline.drag.move.${edit.move}`, { label: b.label }) : t('ui.stage.timeline.drag.retimed', { label: b.label, time: formatTimecode(edit.atMs ?? 0, fps) }));
  };
  useEffect(() => {                                                   // keep keyboard focus on the element once its edit landed (a lane change remounts it)
    const r = refocus.current; if (!r) return;
    const b = barsOnScreen.find((x) => x.id === r.id);
    if (b && `${b.row}|${b.fromMs}|${b.toMs}` === r.sig) return;      // not applied yet
    refocus.current = null;
    const n = [...(lanes.current?.querySelectorAll<HTMLElement>('[data-el="stage.timeline.element"]') ?? [])].find((x) => x.getAttribute('data-element-id') === r.id);
    if (n && document.activeElement !== n) n.focus();
  }, [barsOnScreen]);
  const select = (b: Bar, e: ReactMouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    let next: ElementRefT[];
    if (e.ctrlKey || e.metaKey) next = isSelected(b) ? state.selection.filter((s) => !(s.kind === b.ref.kind && s.id === b.ref.id && s.index === b.ref.index)) : [...state.selection, b.ref];
    else if (e.shiftKey && state.selection.length) next = isSelected(b) ? state.selection : [...state.selection, b.ref];   // FR-194: no duplicate chips
    else next = [b.ref];
    actions.select(next);
    const out = liveMs < b.fromMs || liveMs >= b.toMs;
    if (prefs.seekOnSelect && out) playerBus.get()?.seekMs(b.fromMs);
  };
  // ADR-031 / FR-193: right-click, Shift+F10 or the ContextMenu key opens the item menu. An unselected bar becomes the selection
  // first; a bar inside the selection acts on the whole selection (CapCut).
  const [menu, setMenu] = useState<ItemMenuAnchor | null>(null);
  const openMenu = (b: Bar, el: HTMLElement, at?: { x: number; y: number }) => {
    const refs = isSelected(b) ? state.selection : [b.ref];
    if (!isSelected(b)) actions.select([b.ref]);
    const r = el.getBoundingClientRect();
    setMenu({ x: at && (at.x || at.y) ? at.x : r.left, y: at && (at.x || at.y) ? at.y : r.bottom + 2, refs: [...refs], source: 'timeline', returnFocus: el });
  };
  const onBarKey = (b: Bar, e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (isMenuKey(e)) { e.preventDefault(); e.stopPropagation(); openMenu(b, e.currentTarget); return; }
    if (isEditable(b)) onElementKey(b, e);
  };
  // FR-066 / FR-253: press and drag on the ruler, on the playhead line (its whole height) or on empty track space scrubs the
  // playhead (the Player follows through playerBus; no Composition change). The press seeks at once; moves are coalesced to one
  // seek per animation frame and the release applies the last position exactly.
  const pending = useRef<number | null>(null); const frame = useRef<number | null>(null);
  const flushSeek = () => { if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; } const p = pending.current; pending.current = null; if (p !== null) playerBus.get()?.seekMs(p); };
  const seekLive = (ms: number) => {
    if (frame.current === null) { playerBus.get()?.seekMs(ms); frame.current = requestAnimationFrame(() => { frame.current = null; flushSeek(); }); }
    else pending.current = ms;
  };
  const msAt = (clientX: number) => { const r = (content.current ?? lanes.current)?.getBoundingClientRect(); const ms = (clientX - (r?.left ?? 0)) / pxRef.current; return Number.isFinite(ms) ? Math.max(0, Math.min(durationMs, ms)) : 0; };
  const startScrub = (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.button ?? 0) !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* jsdom / released pointer */ }
    playerBus.get()?.seekMs(msAt(e.clientX));
    setScrubbing(true);
    const move = (ev: PointerEvent) => { ev.preventDefault(); seekLive(msAt(ev.clientX)); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); flushSeek(); setScrubbing(false); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  const [scrubbing, setScrubbing] = useState(false);
  // FR-253: a press on empty track space seeks there (and scrubs while held); a plain press also clears the selection, Shift or
  // Ctrl / ⌘ keep it. Right-click there opens the item menu with only Paste available.
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.button ?? 0) !== 0) return;
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) actions.select([]);
    startScrub(e);
  };
  const onTrackMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, refs: [], source: 'timeline', returnFocus: e.currentTarget });
  };
  const tickEvery = pxPerMs * 1000 > 80 ? 1000 : pxPerMs * 1000 > 30 ? 2000 : pxPerMs * 1000 > 12 ? 5000 : 10000;
  const ticks = Array.from({ length: Math.floor(durationMs / tickEvery) + 1 }, (_, i) => i * tickEvery);
  const selectedBars = bars.filter(isSelected);
  const projectChips: Partial<Record<'caption' | 'video', string>> = {
    caption: model?.tracks.caption.styleId ? getPreset(model.tracks.caption.styleId)?.label[lang] ?? '' : '',
    video: model?.background ? getPreset(model.background.presetId)?.label[lang] ?? '' : '',
  };
  const dragBar = drag ? barsOnScreen.find((b) => b.id === drag.id) : undefined;
  const ghost = drag && dragBar && model && isEditable(dragBar) ? elementDragEdit(model, dragBar, drag.mode, drag.dx, Math.round(drag.dy / ROW_PX), dragOpts(dragBar.id, drag.alt)) : null;
  const rowA11y = (r: LaneRow, count: number) => r.kind === 'layer' && r.layers && r.layers.length > 1 ? t('a11y.stage.timeline.lane.layers', { from: r.layers[r.layers.length - 1]! + 1, to: r.layers[0]! + 1, count }) : r.kind === 'layer' ? (r.isNew ? t('a11y.stage.timeline.lane.new') : t('a11y.stage.timeline.lane.layer', { n: r.lane + 1, count })) : r.kind === 'audio' ? (r.isNew ? t('a11y.stage.timeline.lane.newaudio') : t('a11y.stage.timeline.lane.audio', { n: r.lane + 1, count })) : t(`a11y.stage.timeline.track.${r.kind}`, { n: count });
  const rowEl = (r: LaneRow) => r.kind === 'caption' || r.kind === 'video' ? `stage.timeline.track.${r.kind}` : r.isNew ? 'stage.timeline.lane.new' : `stage.timeline.lane.${r.kind}`;

  return (
    <section data-el="stage.timeline" role="region" aria-label={t('a11y.stage.timeline')} className="flex min-h-[220px] shrink-0 flex-col rounded-[12px] border border-em-line bg-em-panel" style={{ height }}>
      <div className="flex h-8 items-center gap-2 border-b border-em-line px-2">
        <span className="t-label flex-1">{t('ui.stage.timeline.title')}</span>
        {/* QA UX round 1: packed rows by default past COMPACT_AFTER_LAYERS layers; the toggle shows every layer */}
        {layerCount > 1 && <button type="button" data-el="stage.timeline.compact" aria-pressed={compact} title={t(compact ? 'ui.stage.timeline.compact.off.tip' : 'ui.stage.timeline.compact.tip')}
          onClick={() => setCompactPref(!compact)} className={cx('rounded-[4px] border px-1.5 text-[11px]', compact ? 'border-em-accent/60 text-em-accent' : 'border-em-line text-em-muted')}>{t(compact ? 'ui.stage.timeline.compact.on' : 'ui.stage.timeline.compact')}</button>}
        {/* ADR-028 / FR-179: split the selected item(s) — or the clip under the playhead — at the playhead (also S). */}
        <IconButton el="stage.timeline.split" label={t('ui.stage.timeline.split')} aria-keyshortcuts="S" icon={<Scissors size={14} />} size={28}
          disabledReason={hasClip || bars.length ? null : t('ui.stage.timeline.split.nothing')}
          onClick={() => runSplit({ model, selection: state.selection, playheadMs: state.playheadMs, fps, splitEdit: actions.splitEdit, toast: actions.toast, t, time: (v) => formatTimecode(v, fps) })} />
        <IconButton label={t('ui.stage.timeline.zoomout')} icon={<Minus size={14} />} size={28} onClick={() => setZoom(Math.max(ZOOM_MIN, (zoom ?? pxPerMs * 1000) / 1.5))} />
        <button type="button" className="t-mono text-em-muted" onClick={() => setZoom(null)}>{t('ui.stage.timeline.fit')}</button>
        <IconButton label={t('ui.stage.timeline.zoomin')} icon={<Plus size={14} />} size={28} onClick={() => setZoom(Math.min(ZOOM_MAX, (zoom ?? pxPerMs * 1000) * 1.5))} />
        <span className="t-mono text-em-muted">{formatTimecode(durationMs, fps)}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={scroller} data-el="stage.timeline.scroll" className="flex min-h-0 min-w-0 flex-1 overflow-auto">
        {showLanes && <div className="sticky left-0 z-40 flex w-24 shrink-0 flex-col self-start border-r border-em-line bg-em-panel">
          <div className="sticky top-0 z-40 h-6 border-b border-em-line bg-em-panel" />
          {rows.map((r) => (
            <div key={r.key} className={cx('flex h-9 items-center gap-1 border-b border-em-line px-2 text-[12px]', r.isNew ? 'text-em-muted' : 'text-em-text-2')}>
              <span className="flex-1 truncate">{laneName(r)}</span>
              {TRACK_CHIP[r.kind] && projectChips[TRACK_CHIP[r.kind]!] && <span className="truncate rounded-full border border-em-line px-1 text-[10px]" title={projectChips[TRACK_CHIP[r.kind]!]}>{projectChips[TRACK_CHIP[r.kind]!]}</span>}
            </div>
          ))}
        </div>}
        <div ref={lanes} role="grid" aria-label={t('a11y.stage.timeline')} className="relative min-w-0 flex-1 self-start"
          onClick={(e) => { if (e.target === e.currentTarget) actions.select([]); }}>
          <div ref={content} className="relative" style={{ width: Math.max(width, durationMs * pxPerMs + 8) }}>
            {showLanes && <>
            <div data-el="stage.timeline.ruler" data-sticky="top" className="sticky top-0 z-30 h-6 cursor-pointer touch-none select-none border-b border-em-line bg-em-panel" onPointerDown={startScrub}>
              {ticks.map((ms) => <span key={ms} className="t-mono pointer-events-none absolute top-1 border-l border-em-line pl-1 text-[10px] text-em-muted" style={{ left: ms * pxPerMs }}>{Math.round(ms / 1000)}s</span>)}
              <span data-el="stage.timeline.head.handle" aria-hidden className="pointer-events-none absolute top-0 -ml-[5px] h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-[var(--em-accent)]" style={{ left: liveMs * pxPerMs }} />
            </div>
            {rows.map((r) => {
              const own = barsOnScreen.filter((b) => b.row === r.key);
              const count = own.filter((b) => b.kind !== 'transition' && b.kind !== 'effect' && b.kind !== 'background').length;
              const dropTarget = ghost && ghost.row === r.key && drag?.mode === 'move' && ghost.row !== dragBar?.row;
              return (
                <div key={r.key} data-el={rowEl(r)} data-row={r.key} {...(r.kind === 'layer' ? { 'data-layer': r.lane, ...(r.layers && r.layers.length > 1 ? { 'data-layers': r.layers.join(',') } : {}) } : r.kind === 'audio' ? { 'data-lane': r.lane } : {})} role="row" aria-label={rowA11y(r, count)}
                  className={cx('relative h-9 border-b border-em-line', r.isNew && 'border-dashed', dropTarget && 'shadow-[inset_0_0_0_2px_var(--em-accent)]')}
                  onPointerDown={onTrackDown} onContextMenu={onTrackMenu}>
                  {r.isNew && drag?.mode === 'move' && <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center px-2 text-[10px] text-em-muted">{r.kind === 'audio' ? t('ui.stage.timeline.lane.newaudio.hint') : t('ui.stage.timeline.lane.new.hint')}</span>}
                  {own.map((b) => {
                    const sel = isSelected(b);
                    let left = b.fromMs * pxPerMs, w = Math.max(b.kind === 'transition' ? 12 : 6, (b.toMs - b.fromMs) * pxPerMs);
                    const dragging = drag?.id === b.id;
                    const clipDrag = b.kind === 'clip' && b.track === 'video';
                    if (dragging && drag && clipDrag) { if (drag.mode === 'move') left += drag.dx; else if (drag.mode === 'end') w = Math.max(6, w + drag.dx); else { left += drag.dx; w = Math.max(6, w - drag.dx); } }
                    const draggable = clipDrag || isEditable(b);
                    const pulse = pulseIds.has(b.diffId);
                    const missing = Boolean(b.assetId && state.assets.find((a) => a.id === b.assetId)?.missing);   // FR-048
                    return (
                      <button key={b.id} type="button" role="gridcell" data-el="stage.timeline.element" data-kind={b.kind} data-element-id={b.id} data-generated={b.generated ? 'true' : undefined} data-missing={missing || undefined} aria-selected={sel}
                        data-editable={isEditable(b) || undefined} {...(b.lane !== undefined ? { 'data-lane': b.lane } : {})}
                        aria-keyshortcuts={isEditable(b) ? 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Alt+ArrowUp Alt+ArrowDown' : undefined}
                        aria-label={t('a11y.stage.timeline.element', { kind: t(`ui.stage.timeline.kind.${b.kind}`), label: b.label, start: formatTimecode(b.fromMs, fps), end: formatTimecode(b.toMs, fps) })}
                        title={`${b.label} · ${formatTimecode(b.fromMs, fps)}–${formatTimecode(b.toMs, fps)}${isEditable(b) ? ` · ${t('ui.stage.timeline.element.keys')}` : ''}`}
                        onClick={(e) => { e.stopPropagation(); if (e.altKey && !suppressClick.current) { playerBus.get()?.seekMs(msAt(e.clientX)); return; } select(b, e); }} onPointerDown={draggable ? (e) => startDrag(b, e) : undefined} onKeyDown={(e) => onBarKey(b, e)} data-dragging={dragging ? drag?.mode : undefined}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(b, e.currentTarget, { x: e.clientX, y: e.clientY }); }} aria-haspopup="menu"
                        className={cx('absolute truncate rounded-[4px] border px-1 text-left text-[11px] em-trans', STRIP[b.kind] ? `${STRIP[b.kind]} rounded-[2px] px-0 text-[0px]` : b.kind === 'transition' ? 'top-1 h-7 z-10 bg-em-panel-2' : 'top-1 h-7 bg-em-panel-2',
                          draggable && 'touch-none', dragging && !clipDrag && 'opacity-40',
                          sel ? 'border-em-accent shadow-[0_0_0_2px_var(--em-accent)]' : missing ? 'border-dashed border-em-danger' : 'border-em-line hover:border-em-line-strong', pulse && 'em-pulse')}
                        data-scene={b.swatch ? 'true' : undefined}
                        style={{ left: b.kind === 'transition' ? left - 6 : left, width: b.kind === 'transition' ? 12 : w, ...(STRIP[b.kind] ? { background: KIND_COLOUR[b.kind] } : { borderTop: `3px solid ${KIND_COLOUR[b.kind] ?? 'var(--em-line)'}` }), ...(b.swatch ? { backgroundImage: b.swatch } : {}) }}>
                        {b.kind === 'transition' ? <span aria-hidden>◆</span> : STRIP[b.kind] ? null : <>{b.kind === 'clip' && model?.tracks.video.find((c) => c.id === b.id)?.effects.length ? <Sparkles size={10} className="mr-0.5 inline" aria-hidden /> : null}
                          {draggable && <><span aria-hidden data-el="stage.timeline.element.handle" data-edge="start" className="absolute bottom-0 left-0 top-0 w-1.5 cursor-ew-resize" /><span aria-hidden data-el="stage.timeline.element.handle" data-edge="end" className="absolute bottom-0 right-0 top-0 w-1.5 cursor-ew-resize" /></>}
                          {b.generated && <span data-el="stage.timeline.element.generated" className="mr-1 rounded-[3px] bg-em-accent-2/30 px-0.5 text-[9px] uppercase">{t('ui.stage.timeline.generated')}</span>}
                          {missing && <span data-el="stage.timeline.element.missing" className="mr-1 rounded-[3px] bg-em-danger/30 px-0.5 text-[9px] uppercase">{t('ui.stage.timeline.missing')}</span>}{b.label}</>}
                      </button>
                    );
                  })}
                  {ghost && dragBar && ghost.row === r.key && (
                    <div data-el="stage.timeline.ghost" data-row={ghost.row} data-from-ms={ghost.fromMs} data-to-ms={ghost.toMs} aria-hidden
                      className="pointer-events-none absolute top-1 z-20 h-7 truncate rounded-[4px] border-2 border-dashed border-em-accent bg-em-accent/15 px-1 text-[11px]"
                      style={{ left: ghost.fromMs * pxPerMs, width: Math.max(6, (ghost.toMs - ghost.fromMs) * pxPerMs) }}>
                      {formatTimecode(ghost.fromMs, fps)} · {dragBar.label}
                    </div>
                  )}
                </div>
              );
            })}
            {ghost?.snapMs !== null && ghost?.snapMs !== undefined && (
              <div data-el="stage.timeline.snap" data-ms={ghost.snapMs} aria-hidden className="pointer-events-none absolute bottom-0 top-6 z-20 w-px bg-em-warn" style={{ left: ghost.snapMs * pxPerMs }} />
            )}
            {/* FR-253: the playhead line is a slider over the whole Timeline height: drag it anywhere, or focus it and use ←/→ (frame),
                Shift+←/→ (1 s), Home / End (global shortcuts). It sits above the bars (12 px grab zone) and below the sticky ruler. */}
            <div data-el="stage.timeline.head" role="slider" tabIndex={0} aria-label={t('a11y.stage.timeline.head')} aria-orientation="horizontal"
              aria-valuemin={0} aria-valuemax={Math.round(durationMs)} aria-valuenow={Math.round(liveMs)} aria-valuetext={formatTimecode(liveMs, fps)}
              aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End" data-scrubbing={scrubbing || undefined}
              title={t('ui.stage.timeline.head.hint')} onPointerDown={startScrub}
              className="absolute bottom-0 top-0 z-[25] -ml-1.5 w-3 cursor-ew-resize touch-none outline-none focus-visible:bg-em-accent/20" style={{ left: liveMs * pxPerMs }}>
              <span aria-hidden className="pointer-events-none absolute bottom-0 left-[5px] top-0 w-0.5 bg-em-accent" />
            </div>
            </>}
            {!hasClip && !bars.length && (
              <div data-el="stage.timeline.empty" className={cx('pointer-events-none flex', showLanes ? 'absolute inset-x-0 bottom-0 top-6' : 'h-full min-h-[160px]', 'items-center justify-center p-4 text-center text-em-muted')}>
                {t('ui.stage.timeline.empty')}
              </div>
            )}
          </div>
        </div>
        </div>
        {menu && <ItemMenu anchor={menu} onClose={() => setMenu(null)} />}
        {selectedBars.length > 0 && model && <Inspector bars={selectedBars} model={model} onAsk={(b) => {
          dispatch({ type: 'editorDraft', draft: { text: t('ui.stage.timeline.inspector.stem', { target: b.label }), target: b.ref, nonce: Date.now() } });
        }} />}
      </div>
    </section>
  );
}

/** FR-067: where an element came from — the newest applied intent and plan that touched it, and the current version. */
export function provenanceOf(ref: ElementRefT, state: Pick<AppState, 'queue' | 'plan' | 'previousPlans' | 'head'>): { intentId: string | null; planId: string | null; version: string | null } {
  const same = (r: ElementRefT) => r.kind === ref.kind && (ref.id !== undefined ? r.id === ref.id : r.index === ref.index);
  const clipOf = ref.kind === 'effect' && ref.id ? ref.id.split('|')[0] : null;
  const hits = (r: ElementRefT | undefined) => !!r && (same(r) || (clipOf !== null && r.kind === 'clip' && r.id === clipOf));
  const intent = [...(state.queue?.items ?? [])].filter((i) => (i.status === 'executed' || i.status === 'compiled') && i.resolvedTargets.some(hits)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const plans = [state.plan, ...state.previousPlans].filter((p): p is PlanDto => !!p && p.status === 'executed');
  const plan = plans.find((p) => p.steps.some((st) => st.ops.some((o) => hits(o.target) || (intent !== undefined && o.intentId === intent.id))));
  return { intentId: intent?.id ?? null, planId: plan?.id ?? null, version: state.head?.hash.slice(0, 6) ?? null };
}

function Inspector({ bars, model, onAsk }: { bars: Bar[]; model: CompositionModelT; onAsk: (b: Bar) => void }) {
  const { t, lang, state, actions } = useStore();
  const b = bars[0]!;
  const missingAsset = b.assetId ? state.assets.find((a) => a.id === b.assetId && a.missing) : undefined;   // FR-048
  const fps = model.settings.fps;
  const label = (id: string | undefined | null) => (id ? getPreset(id)?.label[lang] ?? id : '—');
  const ms = (v: number) => `${formatTimecode(v, fps)} (${v} ms)`;
  const pct = (v: number | undefined) => (v === undefined ? '—' : `${Math.round(v * 100)} %`);
  const params = (p: Record<string, unknown> | undefined) => (p && Object.keys(p).length ? Object.entries(p).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ') : '—');
  const asset = (id: string) => state.assets.find((a) => a.id === id)?.name ?? id;
  const L = (k: string) => t(`ui.stage.timeline.inspector.${k}`);
  const rows: Array<[string, string]> = [];
  if (bars.length > 1) rows.push([L('multiple'), String(bars.length)]);
  if (b.kind !== 'background') rows.push([L('start'), ms(b.fromMs)], [L('duration'), ms(b.toMs - b.fromMs)]);
  if (b.lane !== undefined) rows.push([b.kind === 'audio' ? L('lane') : L('layer'), String(b.lane + 1)]);   // ADR-027
  if (b.kind === 'clip' && b.track === 'video') {
    const c = model.tracks.video.find((x) => x.id === b.id);
    const i = model.tracks.video.findIndex((x) => x.id === b.id);
    if (c && c.assetId === undefined) {
      // ADR-030 scene clip: no media fields, its background preset instead.
      const tin = model.transitions.find((x) => x.cutIndex === i - 1), tout = model.transitions.find((x) => x.cutIndex === i);
      rows.push([L('background'), label(c.scene?.presetId)], [L('params'), params(c.scene?.params)], [L('motion'), c.motion ? label(c.motion.presetId) : '—'],
        [L('transitionin'), tin ? label(tin.presetId) : '—'], [L('transitionout'), tout ? label(tout.presetId) : '—']);
    } else if (c) {
      const tin = model.transitions.find((x) => x.cutIndex === i - 1), tout = model.transitions.find((x) => x.cutIndex === i);
      rows.push([L('asset'), asset(c.assetId ?? '')], [L('trim'), ms(c.trimBeforeMs)], [L('rate'), `${c.playbackRate}×`],
        [L('volume'), c.muted ? L('muted') : pct(c.volume)], [L('fades'), `${c.fadeInMs} / ${c.fadeOutMs} ms`], [L('fit'), c.objectFit],
        [L('motion'), c.motion ? `${label(c.motion.presetId)} · ${c.motion.durationMs} ms` : '—'],
        [L('effects'), c.effects.map((e) => label(e.presetId)).join(', ') || '—'],
        [L('transitionin'), tin ? label(tin.presetId) : '—'], [L('transitionout'), tout ? label(tout.presetId) : '—']);
    }
  }
  if (b.kind === 'image') {
    const o = model.tracks.overlay.find((x) => x.id === b.id);
    if (o?.kind === 'image') rows.push([L('asset'), asset(o.assetId)], [L('position'), `${o.position.x}, ${o.position.y} u`], [L('size'), JSON.stringify(o.size)], [L('fit'), o.objectFit], [L('opacity'), pct(o.opacity)],
      [L('motion'), o.motion ? label(o.motion.presetId) : '—'], [L('effects'), o.effects.map((e) => label(e.presetId)).join(', ') || '—']);
  }
  if (b.kind === 'shape') {
    const o = model.tracks.overlay.find((x) => x.id === b.id);
    if (o?.kind === 'shape') rows.push([L('preset'), label(o.presetId)], [L('position'), `${o.position.x}, ${o.position.y} u`], [L('size'), JSON.stringify(o.size)], [L('fill'), o.fill],
      [L('stroke'), o.stroke ? `${o.stroke} · ${o.strokeWidth ?? 0} u` : '—'], [L('opacity'), pct(o.opacity ?? 1)], [L('motion'), o.motion ? label(o.motion.presetId) : '—'], [L('params'), params(o.params)]);
  }
  if (b.kind === 'text') {
    const x = model.tracks.text.find((y) => y.id === b.id);
    if (x) rows.push([L('text'), x.text], [L('variant'), label(x.variantId)], [L('size'), `${x.style.fontSize ?? model.theme.textDefaults.fontSize} u`],
      [L('font'), x.style.fontFamily ?? '—'], [L('colour'), x.style.colour ?? model.theme.textDefaults.colour], [L('position'), `${x.position.x}, ${x.position.y} u`],
      [L('effect'), x.effect ? label(x.effect.presetId) : '—'], [L('motion'), x.motion ? label(x.motion.presetId) : '—']);
  }
  if (b.kind === 'caption') {
    const i = Number(b.id.split(':')[1] ?? 0); const pg = model.tracks.caption.pages[i];
    if (pg) rows.push([L('text'), pg.text], [L('words'), String(pg.tokens.length)], [L('style'), label(model.tracks.caption.styleId)], [L('params'), params(model.tracks.caption.params)]);
  }
  if (b.kind === 'audio') {
    const a = model.tracks.audio.find((y) => y.id === b.id);
    if (a) rows.push([L('asset'), asset(a.assetId)], [L('role'), t(`ui.stage.timeline.inspector.role.${a.role}`)], [L('trim'), ms(a.trimBeforeMs)], [L('volume'), pct(a.volume)],
      [L('loop'), a.loop ? '✓' : '—'], [L('fades'), `${a.fadeInMs} / ${a.fadeOutMs} ms`], [L('ducking'), a.ducking ? label(a.ducking.presetId) : '—']);
  }
  if (b.kind === 'transition') {
    const x = model.transitions.find((y) => `cut:${y.cutIndex}` === b.id);
    if (x) rows.push([L('preset'), label(x.presetId)], [L('timing'), x.timing], [L('params'), params(x.params)]);
  }
  if (b.kind === 'effect') {
    const [clipId, presetId] = (b.ref.id ?? '').split('|');
    const e = model.tracks.video.find((c) => c.id === clipId)?.effects.find((x) => x.presetId === presetId);
    if (e) rows.push([L('preset'), label(e.presetId)], [L('effectmotion'), e.motion], [L('params'), params(e.params)]);
  }
  if (b.kind === 'background' && model.background) rows.push([L('preset'), label(model.background.presetId)], [L('span'), L('span.all')], [L('params'), params(model.background.params)]);
  const prov = provenanceOf(b.ref, state);
  rows.push([L('intent'), prov.intentId ? prov.intentId.slice(-8) : L('none')], [L('plan'), prov.planId ? prov.planId.slice(-8) : L('none')], [L('version'), prov.version ? `v${prov.version}` : '—']);
  if (b.generated) rows.push([L('origin'), t('ui.stage.timeline.generated')]);
  const header = b.kind === 'clip' && b.track === 'video' ? t('ui.stage.timeline.inspector.clip', { label: b.label }) : b.label;
  return (
    <aside data-el="stage.timeline.inspector" role="complementary" aria-label={t('a11y.stage.timeline.inspector', { label: b.label })} className="flex w-[260px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-em-line p-2">
      <div className="truncate font-semibold" title={header}>{header}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px]">
        {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-em-muted">{k}</dt><dd className="truncate" title={v}>{v}</dd></div>)}
      </dl>
      <div className="flex gap-1">
        <Button el="stage.timeline.inspector.ask" size={28} className="flex-1" icon={<Bot size={14} />} onClick={() => onAsk(b)} disabledReason={state.settings?.privateMode ? t('err.EM-4401.title') : null}>{t('ui.stage.timeline.inspector.ask')}</Button>
        {/* ADR-031 / FR-192: delete every selected item (same pick as the Delete key; Ctrl+Z restores). */}
        <Button el="stage.timeline.inspector.delete" size={28} variant="danger-ghost" icon={<Trash2 size={14} />} aria-keyshortcuts="Delete" title={t('ui.stage.timeline.inspector.delete.tip')}
          onClick={() => runDelete({ selection: state.selection, itemsEdit: actions.itemsEdit, toast: actions.toast, t })}>{t('ui.stage.timeline.inspector.delete')}</Button>
      </div>
      {missingAsset && (
        // FR-048: the element's Asset file is missing — the same Locate (re-link by hash) and Remove as on the Asset card.
        <div data-el="stage.timeline.inspector.missing" className="flex flex-col gap-1 rounded-[6px] border border-dashed border-em-danger p-1.5 text-[12px]">
          <span className="text-em-danger">{t('err.EM-1301.title')} <span className="t-mono text-em-muted">EM-1301</span></span>
          <div className="flex gap-1">
            <Button el="stage.timeline.inspector.locate" size={28} onClick={() => void actions.locateAsset(missingAsset.id)} disabledReason={window.expertmotion?.pickFiles ? null : t('ui.lib.assets.locate.unavailable')}>{t('ui.lib.assets.locate')}</Button>
            <Button el="stage.timeline.inspector.remove" size={28} onClick={() => void actions.removeAsset(missingAsset.id)}>{t('ui.common.remove')}</Button>
          </div>
        </div>
      )}
      {bars.length === 1 && isTransformKind(b.ref.kind) && <TransformFields model={model} target={b.ref} />}
      {bars.length === 1 && <QuickParams model={model} target={b.ref} />}
    </aside>
  );
}
