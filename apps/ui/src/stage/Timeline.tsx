// Timeline View (stage.timeline.*): read-only Tracks, ruler, playhead, selection and inspector (IX-09, IX-10).
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Bot, Minus, Plus, Sparkles } from 'lucide-react';
import { deriveTiming, type CompositionModelT, type ElementRefT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { playerBus } from './playerBus.js';
import { formatTimecode } from '../i18n/index.js';

type Track = 'video' | 'overlay' | 'text' | 'caption' | 'audio';
interface Bar { id: string; ref: ElementRefT; kind: string; label: string; fromMs: number; toMs: number; track: Track; diffId: string }

export function buildBars(model: CompositionModelT, assetName: (id: string) => string, lang: 'en' | 'id'): Bar[] {
  const t = deriveTiming(model);
  const bars: Bar[] = [];
  model.tracks.video.forEach((c, i) => {
    const w = t.elementWindows[c.id]!;
    bars.push({ id: c.id, ref: { kind: 'clip', id: c.id }, kind: 'clip', label: `${i + 1} · ${assetName(c.assetId)}`, fromMs: w.fromMs, toMs: w.toMs, track: 'video', diffId: c.id });
  });
  for (const tr of model.transitions) {
    const at = t.cutStartMs[tr.cutIndex];
    if (at === undefined) continue;
    bars.push({ id: `cut:${tr.cutIndex}`, ref: { kind: 'cut', index: tr.cutIndex }, kind: 'transition', label: getPreset(tr.presetId)?.label[lang] ?? tr.presetId, fromMs: at, toMs: at + tr.durationMs, track: 'video', diffId: `cut:${tr.cutIndex}` });
  }
  for (const o of model.tracks.overlay) bars.push({ id: o.id, ref: { kind: o.kind === 'shape' ? 'shape' : 'clip', id: o.id }, kind: o.kind === 'shape' ? 'shape' : 'clip', label: o.kind === 'shape' ? (getPreset(o.presetId)?.label[lang] ?? o.presetId) : assetName(o.assetId), fromMs: o.timing.atMs, toMs: o.timing.atMs + o.timing.durationMs, track: 'overlay', diffId: o.id });
  for (const x of model.tracks.text) bars.push({ id: x.id, ref: { kind: 'text', id: x.id }, kind: 'text', label: x.text, fromMs: x.timing.atMs, toMs: x.timing.atMs + x.timing.durationMs, track: 'text', diffId: x.id });
  model.tracks.caption.pages.forEach((p, i) => bars.push({ id: `caption:${i}`, ref: { kind: 'caption', index: i }, kind: 'caption', label: p.text, fromMs: p.startMs, toMs: p.startMs + p.durationMs, track: 'caption', diffId: `caption:${i}` }));
  for (const a of model.tracks.audio) { const w = t.elementWindows[a.id]; bars.push({ id: a.id, ref: { kind: 'audio', id: a.id }, kind: 'audio', label: assetName(a.assetId), fromMs: w?.fromMs ?? a.atMs, toMs: w?.toMs ?? a.atMs + (a.durationMs ?? 1000), track: 'audio', diffId: a.id }); }
  return bars;
}

const KIND_COLOUR: Record<string, string> = { clip: 'var(--em-accent)', shape: 'var(--em-accent-2)', text: '#F4F5F7', caption: 'var(--em-info)', audio: '#8FB3FF', transition: 'var(--em-warn)' };
const TRACKS: Track[] = ['video', 'overlay', 'text', 'caption', 'audio'];

export function TimelineView({ height = 240 }: { height?: number } = {}) {
  const { state, actions, t, lang, prefs, dispatch } = useStore();
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
  const bars = useMemo(() => (model ? buildBars(model, assetName, lang) : []), [model, state.assets, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const durationMs = model ? deriveTiming(model).durationMs : 1000;
  const pxPerMs = (zoom ?? (width - 8) / (durationMs / 1000)) / 1000;
  const fps = model?.settings.fps ?? 30;
  const hasClip = (model?.tracks.video.length ?? 0) > 0;
  const pulseIds = state.pulse && Date.now() - state.pulse.at < 5000 ? new Set(state.pulse.diff.map((d) => d.elementId)) : new Set<string>();
  const isSelected = (b: Bar) => state.selection.some((s) => s.kind === b.ref.kind && (s.id !== undefined ? s.id === b.ref.id : s.index === b.ref.index));
  const select = (b: Bar, e: ReactMouseEvent) => {
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
        <IconButton label={t('ui.stage.timeline.zoomout')} icon={<Minus size={14} />} size={28} onClick={() => setZoom(Math.max(10, (zoom ?? pxPerMs * 1000) / 1.5))} />
        <button type="button" className="t-mono text-em-muted" onClick={() => setZoom(null)}>{t('ui.stage.timeline.fit')}</button>
        <IconButton label={t('ui.stage.timeline.zoomin')} icon={<Plus size={14} />} size={28} onClick={() => setZoom(Math.min(1000, (zoom ?? pxPerMs * 1000) * 1.5))} />
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
              const own = bars.filter((b) => b.track === tr && b.kind !== 'transition');
              const count = own.length;
              return (
                <div key={tr} data-el={`stage.timeline.track.${tr}`} role="row" aria-label={t(`a11y.stage.timeline.track.${tr}`, { n: count })} className="relative h-9 border-b border-em-line"
                  onClick={(e) => { if (e.target === e.currentTarget) actions.select([]); }}>
                  {bars.filter((b) => b.track === tr).map((b) => {
                    const sel = isSelected(b);
                    const left = b.fromMs * pxPerMs, w = Math.max(b.kind === 'transition' ? 12 : 6, (b.toMs - b.fromMs) * pxPerMs);
                    const pulse = pulseIds.has(b.diffId);
                    return (
                      <button key={b.id} type="button" role="gridcell" data-el="stage.timeline.element" data-kind={b.kind} data-element-id={b.id} aria-selected={sel}
                        aria-label={t('a11y.stage.timeline.element', { kind: t(`ui.stage.timeline.kind.${b.kind}`), label: b.label, start: formatTimecode(b.fromMs, fps), end: formatTimecode(b.toMs, fps) })}
                        title={`${b.label} · ${formatTimecode(b.fromMs, fps)}–${formatTimecode(b.toMs, fps)}`}
                        onClick={(e) => { e.stopPropagation(); select(b, e); }}
                        className={cx('absolute truncate rounded-[4px] border px-1 text-left text-[11px] em-trans', b.kind === 'transition' ? 'top-1 h-7 z-10 bg-em-panel-2' : 'top-1 h-7 bg-em-panel-2',
                          sel ? 'border-em-accent shadow-[0_0_0_2px_var(--em-accent)]' : 'border-em-line hover:border-em-line-strong', pulse && 'em-pulse')}
                        style={{ left: b.kind === 'transition' ? left - 6 : left, width: b.kind === 'transition' ? 12 : w, borderTop: `3px solid ${KIND_COLOUR[b.kind] ?? 'var(--em-line)'}` }}>
                        {b.kind === 'transition' ? <span aria-hidden>◆</span> : <>{b.kind === 'clip' && model?.tracks.video.find((c) => c.id === b.id)?.effects.length ? <Sparkles size={10} className="mr-0.5 inline" aria-hidden /> : null}{b.label}</>}
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

function Inspector({ bars, model, onAsk }: { bars: Bar[]; model: CompositionModelT; onAsk: (b: Bar) => void }) {
  const { t, lang, state } = useStore();
  const b = bars[0]!;
  const fps = model.settings.fps;
  const rows: Array<[string, string]> = [];
  if (bars.length > 1) rows.push([t('ui.stage.timeline.inspector.multiple'), String(bars.length)]);
  rows.push([t('ui.stage.timeline.inspector.start'), formatTimecode(b.fromMs, fps)], [t('ui.stage.timeline.inspector.duration'), formatTimecode(b.toMs - b.fromMs, fps)]);
  if (b.kind === 'clip' && b.track === 'video') {
    const c = model.tracks.video.find((x) => x.id === b.id);
    const i = model.tracks.video.findIndex((x) => x.id === b.id);
    if (c) {
      const tin = model.transitions.find((x) => x.cutIndex === i - 1), tout = model.transitions.find((x) => x.cutIndex === i);
      rows.push([t('ui.stage.timeline.inspector.trim'), formatTimecode(c.trimBeforeMs, fps)], [t('ui.stage.timeline.inspector.rate'), `${c.playbackRate}×`],
        [t('ui.stage.timeline.inspector.volume'), `${Math.round(c.volume * 100)} %`], [t('ui.stage.timeline.inspector.fit'), c.objectFit],
        [t('ui.stage.timeline.inspector.motion'), c.motion ? getPreset(c.motion.presetId)?.label[lang] ?? c.motion.presetId : '—'],
        [t('ui.stage.timeline.inspector.effects'), c.effects.map((e) => getPreset(e.presetId)?.label[lang] ?? e.presetId).join(', ') || '—'],
        [t('ui.stage.timeline.inspector.transitionin'), tin ? getPreset(tin.presetId)?.label[lang] ?? '' : '—'], [t('ui.stage.timeline.inspector.transitionout'), tout ? getPreset(tout.presetId)?.label[lang] ?? '' : '—']);
    }
  }
  if (b.kind === 'text') {
    const x = model.tracks.text.find((y) => y.id === b.id);
    if (x) rows.push([t('ui.stage.timeline.inspector.text'), x.text], [t('ui.stage.timeline.inspector.variant'), getPreset(x.variantId)?.label[lang] ?? x.variantId], [t('ui.stage.timeline.inspector.size'), String(x.style.fontSize ?? model.theme.textDefaults.fontSize)]);
  }
  if (b.kind === 'transition') {
    const x = model.transitions.find((y) => `cut:${y.cutIndex}` === b.id);
    if (x) rows.push([t('ui.stage.timeline.inspector.preset'), getPreset(x.presetId)?.label[lang] ?? x.presetId], [t('ui.stage.timeline.inspector.timing'), x.timing]);
  }
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
