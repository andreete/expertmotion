// Preview Catalogue (lib.catalogue.*): category tabs, Catalogue Cards (CMP-04, §11.1), hover → live preview (IX-01),
// click → Design Pick (IX-02). Labels and tags come from packages/catalogue; availability and loop URLs from GET /catalogue.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Cpu, DownloadCloud } from 'lucide-react';
import { listPresets, searchPresets, type Category, type PresetDef } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import type { CatalogueItemDto } from '../api/types.js';
import { PresetSwatch } from './presetVisual.js';
import { Empty, cx } from '../components/ui.js';

export const CATALOGUE_TABS: Category[] = ['transition', 'caption', 'background', 'motion', 'shape', 'easing', 'effect', 'audio'];
export const SUGGESTIONS = ['fade', 'karaoke', 'transisi halus', 'judul besar', 'gradient', 'zoom'];

export function Catalogue({ query, onSuggest }: { query: string; onSuggest: (q: string) => void }) {
  const { state, runtime, t, lang } = useStore();
  const [tab, setTab] = useState<Category>('transition');
  const [showUpcoming, setShowUpcoming] = useState(false);
  const [avail, setAvail] = useState<Map<string, CatalogueItemDto>>(new Map());
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let alive = true;
    runtime.api.getCatalogue({ priority: 'p0,p1,p2' }).then((r) => { if (alive) setAvail(new Map(r.items.map((i) => [i.id, i]))); }).catch(() => undefined);
    return () => { alive = false; };
  }, [runtime, state.hardware?.tier, state.models]);

  const presets = useMemo<PresetDef[]>(() => {
    const base = query.trim() ? searchPresets(query, lang).filter((p) => (CATALOGUE_TABS as string[]).includes(p.category)) : listPresets({ category: tab });
    const ordered = [...base.filter((p) => p.priority === 'p0'), ...base.filter((p) => p.priority !== 'p0')];
    return showUpcoming ? ordered : ordered.filter((p) => p.priority === 'p0');
  }, [query, tab, showUpcoming, lang]);

  const selectedIds = useMemo(() => new Set((state.queue?.items ?? []).filter((i) => i.presetId && ['queued', 'planned', 'executed', 'compiled'].includes(i.status) && !i.parentIntentId).map((i) => i.presetId!)), [state.queue]);
  const counts = useMemo(() => Object.fromEntries(CATALOGUE_TABS.map((c) => [c, listPresets({ category: c, priority: ['p0'] }).length])), []);

  return (
    <div data-el="lib.catalogue" className="flex flex-col gap-2">
      {!query.trim() && (
        <div role="tablist" aria-label={t('ui.lib.catalogue.tabs')} className="flex gap-1 overflow-x-auto pb-1"
          onKeyDown={(e) => {
            const i = CATALOGUE_TABS.indexOf(tab);
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const n = (i + d + CATALOGUE_TABS.length) % CATALOGUE_TABS.length;
            setTab(CATALOGUE_TABS[n]!); tabRefs.current[n]?.focus();
          }}>
          {CATALOGUE_TABS.map((c, i) => (
            <button key={c} ref={(r) => { tabRefs.current[i] = r; }} type="button" role="tab" aria-selected={tab === c} tabIndex={tab === c ? 0 : -1} data-el="lib.catalogue.tab" data-category={c} onClick={() => setTab(c)}
              className={cx('h-7 shrink-0 whitespace-nowrap border-b-2 px-2 text-[12px] font-medium', tab === c ? 'border-em-accent text-em-text' : 'border-transparent text-em-muted hover:text-em-text')}>
              {t(`ui.lib.catalogue.tab.${c}`)} <span className="t-mono text-em-muted">{counts[c]}</span>
            </button>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2 text-[12px] text-em-muted">
        <input type="checkbox" checked={showUpcoming} onChange={(e) => setShowUpcoming(e.target.checked)} />{t('ui.lib.catalogue.showupcoming')}
      </label>
      {presets.length === 0 ? (
        <div data-el="lib.catalogue.empty">
          <Empty title={t('ui.lib.catalogue.empty', { q: query })} action={
            <div className="flex flex-wrap justify-center gap-1">{SUGGESTIONS.slice(0, 3).map((s) => <button key={s} type="button" data-el="lib.search.suggestion" className="rounded-full border border-em-line px-2 text-[12px]" onClick={() => onSuggest(s)}>{s}</button>)}</div>
          } />
        </div>
      ) : (
        <div role="grid" aria-label={t('ui.lib.mode.design')} className="grid grid-cols-2 gap-2 [@media(min-width:1600px)]:grid-cols-3">
          {presets.map((p) => (
            <CatalogueCard key={p.id} preset={p} item={avail.get(p.id)} selected={selectedIds.has(p.id)} />
          ))}
        </div>
      )}
      {state.previewPresetId && <span className="sr-only" aria-live="polite">{t('ui.stage.player.previewing', { preset: '' })}</span>}
    </div>
  );
}

export function CatalogueCard({ preset, item, selected, compact }: { preset: PresetDef; item: CatalogueItemDto | undefined; selected: boolean; compact?: boolean }) {
  const { state, actions, t, lang, runtime } = useStore();
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upcoming = preset.priority !== 'p0';
  const tier = state.hardware?.tier ?? 'T0';
  const gpu = preset.flags.includes('gpu') && tier === 'T0';
  const modelFlag = preset.flags.find((f) => f.startsWith('model:'));
  const modelKey = modelFlag?.slice(6);
  const modelMissing = Boolean(modelKey && !state.models.some((m) => m.key === modelKey && m.status === 'installed'));
  const unavailable = item ? !item.availability.ok : preset.flags.includes('webgpu') && tier !== 'T2';
  const label = preset.label[lang];
  // Loops ship with the Editor (API_SPECIFICATION R-120): resolved against the Editor's own origin, never the Local Service.
  const [loopFailed, setLoopFailed] = useState(false);
  const loopUrl = item?.preview && !loopFailed ? new URL(item.preview.replace(/^\/+/, ''), typeof document === 'undefined' ? 'http://localhost/' : document.baseURI).href : '';
  const enter = () => {
    setHover(true);
    if (upcoming || unavailable) return;
    timer.current = setTimeout(() => actions.preview(preset.id), 150);
  };
  const leave = () => {
    setHover(false);
    if (timer.current) clearTimeout(timer.current);
    if (state.previewPresetId === preset.id) actions.preview(null);
  };
  const name = [label, t(`ui.lib.catalogue.tab.${preset.category}`), selected ? t('a11y.lib.catalogue.card.inpicks') : '', gpu ? t('ui.lib.catalogue.badge.gpu') : '', modelMissing ? t('ui.lib.catalogue.badge.model', { model: modelKey ?? '' }) : ''].filter(Boolean).join(', ');
  const reason = upcoming ? t('ui.lib.catalogue.comingsoon') : unavailable ? t('ui.lib.catalogue.unavailable') : null;
  return (
    <div role="gridcell">
      <button type="button" data-el="lib.catalogue.card" data-preset-id={preset.id} data-selected={selected || undefined} aria-pressed={selected} aria-label={name} aria-disabled={reason ? true : undefined}
        title={reason ?? undefined}
        onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave}
        onClick={() => { if (reason) return; if (modelMissing) { actions.setScreen({ kind: 'models' }); return; } void actions.pick(preset.id); }}
        className={cx('group relative flex w-full flex-col overflow-hidden rounded-[8px] border bg-em-panel text-left em-trans', selected ? 'border-em-accent shadow-[inset_0_0_0_2px_var(--em-accent)]' : 'border-em-line hover:border-em-line-strong',
          hover && !reason && '-translate-y-0.5', reason && 'opacity-50 cursor-not-allowed')} style={hover ? { boxShadow: 'var(--sh-2)' } : undefined}>
        <div data-el="lib.catalogue.card.thumb" className={cx('relative w-full', compact ? 'aspect-[16/7]' : 'aspect-video')}>
          {loopUrl ? <video src={loopUrl} muted loop playsInline preload="metadata" aria-hidden onError={() => setLoopFailed(true)} className="h-full w-full object-cover" ref={(v) => { if (!v) return; if (hover) void v.play().catch(() => undefined); else v.pause(); }} />
            : <PresetSwatch id={preset.id} category={preset.category} playing={hover} />}
          {selected && <span className="absolute left-1 top-1 text-em-accent" title={t('ui.lib.catalogue.inpicks')}><Bookmark size={14} fill="currentColor" /></span>}
          <span className="absolute right-1 top-1 flex gap-1">
            {gpu && <span data-el="lib.catalogue.card.badge.gpu" title={t('ui.lib.catalogue.badge.gpu')} className="rounded-[4px] bg-black/60 px-1 text-em-warn"><Cpu size={12} /></span>}
            {modelMissing && <span data-el="lib.catalogue.card.badge.model" title={t('ui.lib.catalogue.badge.model', { model: modelKey ?? '' })} className="rounded-[4px] bg-black/60 px-1 text-em-info"><DownloadCloud size={12} /></span>}
          </span>
          {upcoming && <span className="absolute bottom-1 left-1 rounded-[4px] bg-black/60 px-1 text-[10px]">{t('ui.lib.catalogue.comingsoon')}</span>}
          {hover && !reason && typeof preset.defaults['durationMs'] === 'number' && <span className="t-mono absolute bottom-1 left-1 rounded-[4px] bg-black/60 px-1">{String(preset.defaults['durationMs'])} ms</span>}
        </div>
        <span data-el="lib.catalogue.card.label" className="truncate px-2 py-1 text-[13px] font-medium">{label}</span>
      </button>
    </div>
  );
}
