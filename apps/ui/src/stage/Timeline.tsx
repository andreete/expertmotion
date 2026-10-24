// Timeline View (stage.timeline.*): read-only Tracks, ruler, playhead, selection and inspector (IX-09, IX-10).
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Bot, Minus, Plus, Sparkles } from 'lucide-react';
import { deriveTiming, type CompositionModelT, type ElementRefT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import type { AppState } from '../state/reducer.js';
import type { PlanDto } from '../api/types.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { playerBus } from './playerBus.js';
import { formatTimecode } from '../i18n/index.js';

type Track = 'video' | 'overlay' | 'text' | 'caption' | 'audio';
interface Bar { id: string; ref: ElementRefT; kind: string; label: string; fromMs: number; toMs: number; track: Track; diffId: string; assetId?: string; generated?: boolean }

/** FR-064: every Timeline Element as a bar; backgrounds span the whole duration; `generated` marks Assets made by a generator. */
export function buildBars(model: CompositionModelT, assetName: (id: string) => string, lang: 'en' | 'id', generatedAssets: ReadonlySet<string> = new Set()): Bar[] {
  const t = deriveTiming(model);
  const bars: Bar[] = [];
  const label = (id: string) => getPreset(id)?.label[lang] ?? id;
  if (model.background) bars.push({ id: 'background', ref: { kind: 'background' }, kind: 'background', label: label(model.background.presetId), fromMs: 0, toMs: Math.max(1, t.durationMs), track: 'video', diffId: 'background' });
  model.tracks.video.forEach((c, i) => {
    const w = t.elementWindows[c.id]!;
    bars.push({ id: c.id, ref: { kind: 'clip', id: c.id }, kind: 'clip', label: `${i + 1} · ${assetName(c.assetId)}`, fromMs: w.fromMs, toMs: w.toMs, track: 'video', diffId: c.id, assetId: c.assetId, generated: generatedAssets.has(c.assetId) });
    c.effects.forEach((e) => bars.push({ id: `effect:${c.id}:${e.presetId}`, ref: { kind: 'effect', id: `${c.id}|${e.presetId}` }, kind: 'effect', label: label(e.presetId), fromMs: w.fromMs, toMs: w.toMs, track: 'video', diffId: c.id }));
  });
  for (const tr of model.transitions) {
    const at = t.cutStartMs[tr.cutIndex];
    if (at === undefined) continue;
    bars.push({ id: `cut:${tr.cutIndex}`, ref: { kind: 'cut', index: tr.cutIndex }, kind: 'transition', label: getPreset(tr.presetId)?.label[lang] ?? tr.presetId, fromMs: at, toMs: at + tr.durationMs, track: 'video', diffId: `cut:${tr.cutIndex}` });
  }
  for (const o of model.tracks.overlay) bars.push({ id: o.id, ref: { kind: o.kind === 'shape' ? 'shape' : 'image', id: o.id }, kind: o.kind === 'shape' ? 'shape' : 'clip', label: o.kind === 'shape' ? label(o.presetId) : assetName(o.assetId), fromMs: o.timing.atMs, toMs: o.timing.atMs + o.timing.durationMs, track: 'overlay', diffId: o.id,
    ...(o.kind === 'image' ? { assetId: o.assetId, generated: generatedAssets.has(o.assetId) } : {}) });
  for (const x of model.tracks.text) bars.push({ id: x.id, ref: { kind: 'text', id: x.id }, kind: 'text', label: x.text, fromMs: x.timing.atMs, toMs: x.timing.atMs + x.timing.durationMs, track: 'text', diffId: x.id });
  model.tracks.caption.pages.forEach((p, i) => bars.push({ id: `caption:${i}`, ref: { kind: 'caption', index: i }, kind: 'caption', label: p.text, fromMs: p.startMs, toMs: p.startMs + p.durationMs, track: 'caption', diffId: `caption:${i}` }));
  for (const a of model.tracks.audio) { const w = t.elementWindows[a.id]; bars.push({ id: a.id, ref: { kind: 'audio', id: a.id }, kind: 'audio', label: assetName(a.assetId), fromMs: w?.fromMs ?? a.atMs, toMs: w?.toMs ?? a.atMs + (a.durationMs ?? 1000), track: 'audio', diffId: a.id, assetId: a.assetId, generated: generatedAssets.has(a.assetId) }); }
  return bars;
}

const KIND_COLOUR: Record<string, string> = { clip: 'var(--em-accent)', shape: 'var(--em-accent-2)', text: '#F4F5F7', caption: 'var(--em-info)', audio: '#8FB3FF', transition: 'var(--em-warn)', effect: 'var(--em-accent-2)', background: 'var(--em-muted)' };
/** Thin strips inside the video lane: background on top (whole duration), effects under their clip. */
const STRIP: Record<string, string> = { background: 'top-0 h-[5px] z-0', effect: 'top-[29px] h-[6px] z-10' };
const ZOOM_MIN = 10, ZOOM_MAX = 1000;
const EDGE_PX = 6;
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
  const a = assetOf(c.assetId);
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
const TRACKS: Track[] = ['video', 'overlay', 'text', 'caption', 'audio'];

export function TimelineView({ height = 240 }: { height?: number } = {}) {
  const { state, actions, t, lang, prefs, dispatch, runtime } = useStore();
  const model = state.head?.model;
  const [zoom, setZoom] = useState<number | null>(null);         // px per second; null = fit
  const [width, setWidth] = useState(600);
  const [liveMs, setLiveMs] = useState(state.playheadMs);
  const lanes = useRef<HTMLDivElement>(null);
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
      const r = el.getBoundingClientRect();
      const atMs = (e.clientX - r.left + el.scrollLeft) / pxRef.current;
      setZoom(next);
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, atMs * (next / 1000) - (e.clientX - r.left)); });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const fps = model?.settings.fps ?? 30;
  const hasClip = (model?.tracks.video.length ?? 0) > 0;
  const pulseIds = state.pulse && Date.now() - state.pulse.at < 5000 ? new Set(state.pulse.diff.map((d) => d.elementId)) : new Set<string>();
  const isSelected = (b: Bar) => state.selection.some((s) => s.kind === b.ref.kind && (s.id !== undefined ? s.id === b.ref.id : s.index === b.ref.index));
  // FR-068 (P1): drag a video Clip to reorder it, or drag its edges to trim (frame-snapped); both go through the Intent Queue.
  const [drag, setDrag] = useState<{ id: string; mode: ClipDragMode; dx: number } | null>(null);
  const suppressClick = useRef(false);
  const startDrag = (b: Bar, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!model || b.kind !== 'clip' || b.track !== 'video' || e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const mode: ClipDragMode = e.clientX - r.left < EDGE_PX ? 'start' : r.right - e.clientX < EDGE_PX ? 'end' : 'move';
    const x0 = e.clientX; let dx = 0;
    const move = (ev: PointerEvent) => { dx = ev.clientX - x0; if (Math.abs(dx) >= 4) setDrag({ id: b.id, mode, dx }); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDrag(null);
      if (Math.abs(dx) < 4) return;
      suppressClick.current = true;
      const edit = clipDragEdit(model, b.id, mode, dx / pxRef.current, (id) => state.assets.find((a) => a.id === id) ?? null);
      if (edit) void actions.clipEdit(edit, edit.toIndex !== undefined ? t('ui.stage.timeline.drag.moved', { label: b.label, n: edit.toIndex + 1 }) : t('ui.stage.timeline.drag.trimmed', { label: b.label }));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const select = (b: Bar, e: ReactMouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    let next: ElementRefT[];
    if (e.ctrlKey || e.metaKey) next = isSelected(b) ? state.selection.filter((s) => !(s.kind === b.ref.kind && s.id === b.ref.id && s.index === b.ref.index)) : [...state.selection, b.ref];
    else if (e.shiftKey && state.selection.length) next = [...state.selection, b.ref];
    else next = [b.ref];
    actions.select(next);
    const out = liveMs < b.fromMs || liveMs >= b.toMs;
    if (prefs.seekOnSelect && out) playerBus.get()?.seekMs(b.fromMs);
  };
  const seekFromRuler = (e: ReactMouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    playerBus.get()?.seekMs(Math.max(0, (e.clientX - r.left + e.currentTarget.scrollLeft) / pxPerMs));
  };
  const tickEvery = pxPerMs * 1000 > 80 ? 1000 : pxPerMs * 1000 > 30 ? 2000 : pxPerMs * 1000 > 12 ? 5000 : 10000;
  const ticks = Array.from({ length: Math.floor(durationMs / tickEvery) + 1 }, (_, i) => i * tickEvery);
  const selectedBars = bars.filter(isSelected);
  const projectChips: Partial<Record<Track, string>> = {
    caption: model?.tracks.caption.styleId ? getPreset(model.tracks.caption.styleId)?.label[lang] ?? '' : '',
    video: model?.background ? getPreset(model.background.presetId)?.label[lang] ?? '' : '',
  };

  return (
    <section data-el="stage.timeline" role="region" aria-label={t('a11y.stage.timeline')} className="flex min-h-[220px] shrink-0 flex-col rounded-[12px] border border-em-line bg-em-panel" style={{ height }}>
      <div className="flex h-8 items-center gap-2 border-b border-em-line px-2">
        <span className="t-label flex-1">{t('ui.stage.timeline.title')}</span>
        <IconButton label={t('ui.stage.timeline.zoomout')} icon={<Minus size={14} />} size={28} onClick={() => setZoom(Math.max(ZOOM_MIN, (zoom ?? pxPerMs * 1000) / 1.5))} />
        <button type="button" className="t-mono text-em-muted" onClick={() => setZoom(null)}>{t('ui.stage.timeline.fit')}</button>
        <IconButton label={t('ui.stage.timeline.zoomin')} icon={<Plus size={14} />} size={28} onClick={() => setZoom(Math.min(ZOOM_MAX, (zoom ?? pxPerMs * 1000) * 1.5))} />
        <span className="t-mono text-em-muted">{formatTimecode(durationMs, fps)}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-24 shrink-0 flex-col border-r border-em-line">
          <div className="h-6 border-b border-em-line" />
          {TRACKS.map((tr) => (
            <div key={tr} className="flex h-9 items-center gap-1 border-b border-em-line px-2 text-[12px] text-em-text-2">
              <span className="flex-1 truncate">{t(`ui.stage.timeline.track.${tr}`)}</span>
              {projectChips[tr] && <span className="truncate rounded-full border border-em-line px-1 text-[10px]" title={projectChips[tr]}>{projectChips[tr]}</span>}
            </div>
          ))}
        </div>
        <div ref={lanes} role="grid" aria-label={t('a11y.stage.timeline')} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          onClick={(e) => { if (e.target === e.currentTarget) actions.select([]); }}>
          <div className="relative" style={{ width: Math.max(width, durationMs * pxPerMs + 8) }}>
            <div data-el="stage.timeline.ruler" className="relative h-6 cursor-pointer border-b border-em-line" onMouseDown={seekFromRuler}>
              {ticks.map((ms) => <span key={ms} className="t-mono absolute top-1 border-l border-em-line pl-1 text-[10px] text-em-muted" style={{ left: ms * pxPerMs }}>{Math.round(ms / 1000)}s</span>)}
            </div>
            {TRACKS.map((tr) => {
              const own = bars.filter((b) => b.track === tr && b.kind !== 'transition' && b.kind !== 'effect' && b.kind !== 'background');
              const count = own.length;
              return (
                <div key={tr} data-el={`stage.timeline.track.${tr}`} role="row" aria-label={t(`a11y.stage.timeline.track.${tr}`, { n: count })} className="relative h-9 border-b border-em-line"
                  onClick={(e) => { if (e.target === e.currentTarget) actions.select([]); }}>
                  {bars.filter((b) => b.track === tr).map((b) => {
                    const sel = isSelected(b);
                    let left = b.fromMs * pxPerMs, w = Math.max(b.kind === 'transition' ? 12 : 6, (b.toMs - b.fromMs) * pxPerMs);
                    const dragging = drag?.id === b.id;
                    if (dragging && drag) { if (drag.mode === 'move') left += drag.dx; else if (drag.mode === 'end') w = Math.max(6, w + drag.dx); else { left += drag.dx; w = Math.max(6, w - drag.dx); } }
                    const draggable = b.kind === 'clip' && b.track === 'video';
                    const pulse = pulseIds.has(b.diffId);
                    const missing = Boolean(b.assetId && state.assets.find((a) => a.id === b.assetId)?.missing);   // FR-048
                    return (
                      <button key={b.id} type="button" role="gridcell" data-el="stage.timeline.element" data-kind={b.kind} data-element-id={b.id} data-generated={b.generated ? 'true' : undefined} data-missing={missing || undefined} aria-selected={sel}
                        aria-label={t('a11y.stage.timeline.element', { kind: t(`ui.stage.timeline.kind.${b.kind}`), label: b.label, start: formatTimecode(b.fromMs, fps), end: formatTimecode(b.toMs, fps) })}
                        title={`${b.label} · ${formatTimecode(b.fromMs, fps)}–${formatTimecode(b.toMs, fps)}`}
                        onClick={(e) => { e.stopPropagation(); select(b, e); }} onPointerDown={draggable ? (e) => startDrag(b, e) : undefined} data-dragging={dragging ? drag?.mode : undefined}
                        className={cx('absolute truncate rounded-[4px] border px-1 text-left text-[11px] em-trans', STRIP[b.kind] ? `${STRIP[b.kind]} rounded-[2px] px-0 text-[0px]` : b.kind === 'transition' ? 'top-1 h-7 z-10 bg-em-panel-2' : 'top-1 h-7 bg-em-panel-2',
                          sel ? 'border-em-accent shadow-[0_0_0_2px_var(--em-accent)]' : missing ? 'border-dashed border-em-danger' : 'border-em-line hover:border-em-line-strong', pulse && 'em-pulse')}
                        style={{ left: b.kind === 'transition' ? left - 6 : left, width: b.kind === 'transition' ? 12 : w, ...(STRIP[b.kind] ? { background: KIND_COLOUR[b.kind] } : { borderTop: `3px solid ${KIND_COLOUR[b.kind] ?? 'var(--em-line)'}` }) }}>
                        {b.kind === 'transition' ? <span aria-hidden>◆</span> : STRIP[b.kind] ? null : <>{b.kind === 'clip' && model?.tracks.video.find((c) => c.id === b.id)?.effects.length ? <Sparkles size={10} className="mr-0.5 inline" aria-hidden /> : null}
                          {draggable && <><span aria-hidden className="absolute bottom-0 left-0 top-0 w-1.5 cursor-ew-resize" /><span aria-hidden className="absolute bottom-0 right-0 top-0 w-1.5 cursor-ew-resize" /></>}
                          {b.generated && <span data-el="stage.timeline.element.generated" className="mr-1 rounded-[3px] bg-em-accent-2/30 px-0.5 text-[9px] uppercase">{t('ui.stage.timeline.generated')}</span>}
                          {missing && <span data-el="stage.timeline.element.missing" className="mr-1 rounded-[3px] bg-em-danger/30 px-0.5 text-[9px] uppercase">{t('ui.stage.timeline.missing')}</span>}{b.label}</>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <div data-el="stage.timeline.head" aria-hidden className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-em-accent" style={{ left: liveMs * pxPerMs }}>
              <span className="absolute -left-1 top-0 h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-[var(--em-accent)]" />
            </div>
            {!hasClip && (
              <div data-el="stage.timeline.empty" className="pointer-events-none absolute inset-x-0 bottom-0 top-6 flex items-center justify-center p-4 text-center text-em-muted">
                {t('ui.stage.timeline.empty')}
              </div>
            )}
          </div>
        </div>
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
  const { t, lang, state } = useStore();
  const b = bars[0]!;
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
  if (b.kind === 'clip' && b.track === 'video') {
    const c = model.tracks.video.find((x) => x.id === b.id);
    const i = model.tracks.video.findIndex((x) => x.id === b.id);
    if (c) {
      const tin = model.transitions.find((x) => x.cutIndex === i - 1), tout = model.transitions.find((x) => x.cutIndex === i);
      rows.push([L('asset'), asset(c.assetId)], [L('trim'), ms(c.trimBeforeMs)], [L('rate'), `${c.playbackRate}×`],
        [L('volume'), c.muted ? L('muted') : pct(c.volume)], [L('fades'), `${c.fadeInMs} / ${c.fadeOutMs} ms`], [L('fit'), c.objectFit],
        [L('motion'), c.motion ? `${label(c.motion.presetId)} · ${c.motion.durationMs} ms` : '—'],
        [L('effects'), c.effects.map((e) => label(e.presetId)).join(', ') || '—'],
        [L('transitionin'), tin ? label(tin.presetId) : '—'], [L('transitionout'), tout ? label(tout.presetId) : '—']);
    }
  }
  if (b.kind === 'clip' && b.track === 'overlay') {
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
      <Button size={28} icon={<Bot size={14} />} onClick={() => onAsk(b)} disabledReason={state.settings?.privateMode ? t('err.EM-4401.title') : null}>{t('ui.stage.timeline.inspector.ask')}</Button>
    </aside>
  );
}
