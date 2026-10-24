// Preview Catalogue (lib.catalogue.*): category tabs, Catalogue Cards (CMP-04, §11.1), hover → live preview (IX-01),
// click → Design Pick (IX-02). Labels and tags come from packages/catalogue; availability and loop URLs from GET /catalogue.
// FR-034 search (≥ 2 characters), FR-035 registry suggestions, FR-037 model badge + held pick (EM-2104), FR-038 GPU badge
// with EM-2103 once per session, FR-040 empty state with Clear search and EM-9004 for categories this build lacks.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Cpu, DownloadCloud, Info } from 'lucide-react';
import { PresetParams } from './PresetParams.js';
import { SUGGESTED_QUERIES, listPresets, searchPresets, type Category, type PresetDef } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import type { CatalogueItemDto, EditIntent } from '../api/types.js';
import type { ElementRefT } from '@expertmotion/composition-model';
import { PresetSwatch } from './presetVisual.js';
import { Button, Empty, cx } from '../components/ui.js';

export const CATALOGUE_TABS: Category[] = ['transition', 'caption', 'background', 'motion', 'shape', 'easing', 'effect', 'audio'];
/** FR-035: suggested queries come from the Design Catalogue registry (DESIGN_CATALOGUE §13). */
export const SUGGESTIONS = SUGGESTED_QUERIES;
/** FR-034: the search filters only from 2 characters on. */
export const MIN_QUERY = 2;
export const activeQuery = (q: string): string => (q.trim().length >= MIN_QUERY ? q.trim() : '');

/** FR-038: EM-2103 is shown once per session (page lifetime), then GPU picks apply silently. */
let gpuWarned = false;
export const resetGpuWarning = (): void => { gpuWarned = false; };

const LIVE = new Set(['queued', 'planned', 'executed', 'compiled']);
const sameRef = (a: ElementRefT, b: ElementRefT) => a.kind === b.kind && (a.id ?? null) === (b.id ?? null) && (a.index ?? null) === (b.index ?? null);
/**
 * FR-039: presets whose pick holds the current target — queued or applied (head state), not superseded/removed/held.
 * With a selection the current target is the selected elements (a selected Clip also stands for the Cut after it, as Target
 * Resolution does for transitions); project-wide picks always count. Without a selection it is the default target, i.e. picks
 * made without an explicit element. Supersession keeps one live pick per property key, so an exclusive group shows one card.
 */
export function selectedPresetIds(items: readonly EditIntent[], selection: readonly ElementRefT[], clips: ReadonlyArray<{ id: string }>): Set<string> {
  const out = new Set<string>();
  const live = items.filter((i) => i.presetId && LIVE.has(i.status));
  if (!selection.length) {
    for (const i of live) if (!i.parentIntentId && ['selection', 'playhead', 'project', 'sequence'].includes(i.target.kind)) out.add(i.presetId!);
    return out;
  }
  const refs: ElementRefT[] = [...selection];
  for (const s of selection) if (s.kind === 'clip') { const k = clips.findIndex((c) => c.id === s.id); if (k >= 0 && k < clips.length - 1) refs.push({ kind: 'cut', index: k }); }
  for (const i of live) {
    if (i.propertyKey.startsWith('group:')) continue;                                   // parents: their children carry the targets
    const ts = i.resolvedTargets;
    if (!ts.length || ts.every((x) => x.kind === 'project')) { out.add(i.presetId!); continue; }
    if (ts.some((x) => refs.some((r) => sameRef(r, x)))) out.add(i.presetId!);
  }
  return out;
}

export function Catalogue({ query, tab, onTab, onSuggest, onClear }: { query: string; tab: Category; onTab: (c: Category) => void; onSuggest: (q: string, category: Category) => void; onClear: () => void }) {
  const { state, runtime, t, lang } = useStore();
  const [showUpcoming, setShowUpcoming] = useState(false);
  const [avail, setAvail] = useState<Map<string, CatalogueItemDto>>(new Map());
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const q = activeQuery(query);

  useEffect(() => {
    let alive = true;
    runtime.api.getCatalogue({ priority: 'p0,p1,p2' }).then((r) => { if (alive) setAvail(new Map(r.items.map((i) => [i.id, i]))); }).catch(() => undefined);
    return () => { alive = false; };
  }, [runtime, state.hardware?.tier, state.models]);

  const presets = useMemo<PresetDef[]>(() => {
    const base = q ? searchPresets(q, lang).filter((p) => (CATALOGUE_TABS as string[]).includes(p.category)) : listPresets({ category: tab });
    const ordered = [...base.filter((p) => p.priority === 'p0'), ...base.filter((p) => p.priority !== 'p0')];
    return showUpcoming ? ordered : ordered.filter((p) => p.priority === 'p0');
  }, [q, tab, showUpcoming, lang]);

  const selectedIds = useMemo(() => selectedPresetIds(state.queue?.items ?? [], state.selection, state.head?.model?.tracks.video ?? []), [state.queue, state.selection, state.head?.model?.tracks.video]);
  const counts = useMemo(() => Object.fromEntries(CATALOGUE_TABS.map((c) => [c, listPresets({ category: c, priority: ['p0'] }).length])), []);
  const tabLabel = t(`ui.lib.catalogue.tab.${tab}`);
  // FR-040: a tab whose presets are all P1/P2 in this build shows EM-9004 copy instead of "no matches".
  const lacksCategory = !q && !showUpcoming && counts[tab] === 0;

  return (
    <div data-el="lib.catalogue" className="flex flex-col gap-2">
      {!q && (
        <div role="tablist" aria-label={t('ui.lib.catalogue.tabs')} className="flex gap-1 overflow-x-auto pb-1"
          onKeyDown={(e) => {
            const i = CATALOGUE_TABS.indexOf(tab);
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const n = (i + d + CATALOGUE_TABS.length) % CATALOGUE_TABS.length;
            onTab(CATALOGUE_TABS[n]!); tabRefs.current[n]?.focus();
          }}>
          {CATALOGUE_TABS.map((c, i) => (
            <button key={c} ref={(r) => { tabRefs.current[i] = r; }} type="button" role="tab" aria-selected={tab === c} tabIndex={tab === c ? 0 : -1} data-el="lib.catalogue.tab" data-category={c} onClick={() => onTab(c)}
              className={cx('h-7 shrink-0 whitespace-nowrap border-b-2 px-2 text-[12px] font-medium', tab === c ? 'border-em-accent text-em-text' : 'border-transparent text-em-muted hover:text-em-text')}>
              {t(`ui.lib.catalogue.tab.${c}`)} <span className="t-mono text-em-muted">{counts[c]}</span>
            </button>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2 text-[12px] text-em-muted">
        <input type="checkbox" checked={showUpcoming} onChange={(e) => setShowUpcoming(e.target.checked)} />{t('ui.lib.catalogue.showupcoming')}
      </label>
      {lacksCategory ? (
        <div data-el="lib.catalogue.empty" data-reason="EM-9004">
          <Empty title={t('err.EM-9004.title')} body={t('err.EM-9004.body', { feature: tabLabel })} />
        </div>
      ) : presets.length === 0 ? (
        <div data-el="lib.catalogue.empty">
          <Empty title={t('ui.lib.catalogue.empty', { q: query.trim() })} action={
            <div className="flex flex-col items-center gap-2">
              <Button el="lib.catalogue.empty.clear" size={28} onClick={onClear}>{t('ui.lib.catalogue.empty.clear')}</Button>
              <div className="flex flex-wrap justify-center gap-1">{SUGGESTIONS.slice(0, 3).map((s) => <button key={s.query} type="button" data-el="lib.search.suggestion" className="rounded-full border border-em-line px-2 text-[12px]" onClick={() => onSuggest(s.query, s.category)}>{s.query}</button>)}</div>
            </div>
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
  const { state, actions, t, lang } = useStore();
  const [hover, setHover] = useState(false);
  const [details, setDetails] = useState(false);
  const infoRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upcoming = preset.priority !== 'p0';
  const tier = state.hardware?.tier ?? 'T0';
  // FR-038: `gpu` presets show the GPU badge on T0, `webgpu` presets on T0 and T1.
  const gpu = (preset.flags.includes('gpu') && tier === 'T0') || (preset.flags.includes('webgpu') && tier !== 'T2');
  const modelFlag = preset.flags.find((f) => f.startsWith('model:'));
  const modelKey = modelFlag?.slice(6);
  const modelMissing = Boolean(modelKey && !state.models.some((m) => m.key === modelKey && m.status === 'installed'));
  // Service availability decides, except the reasons that only add a badge (gpu, missing model: the pick is held instead).
  const unavailable = item ? !item.availability.ok && item.availability.reason !== 'model-missing' : preset.flags.includes('webgpu') && tier !== 'T2';
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
  const openModel = () => actions.setScreen({ kind: 'models', ...(modelKey ? { focus: modelKey } : {}) });
  const click = () => {
    if (reason) return;
    // FR-037: with the model missing the card stays clickable; the Service holds the pick (status `held`, EM-2104, persisted) and
    // applies it when the model is installed — the store shows the EM-2104 toast with "Open Model Manager".
    if (modelMissing && modelKey) { void actions.pick(preset.id); return; }
    if (gpu && !gpuWarned) { gpuWarned = true; actions.toast('warn', 'err.EM-2103.title', undefined, { code: 'EM-2103' }); }
    void actions.pick(preset.id);
  };
  const gpuLabel = preset.flags.includes('webgpu') ? t('ui.lib.catalogue.badge.webgpu') : t('ui.lib.catalogue.badge.gpu');
  const name = [label, t(`ui.lib.catalogue.tab.${preset.category}`), selected ? t('a11y.lib.catalogue.card.inpicks') : '', gpu ? gpuLabel : '', modelMissing ? t('ui.lib.catalogue.badge.model', { model: modelKey ?? '' }) : ''].filter(Boolean).join(', ');
  const reason = upcoming ? t('ui.lib.catalogue.comingsoon') : unavailable ? t('ui.lib.catalogue.unavailable') : null;
  return (
    <div role="gridcell" className="relative">
      <button type="button" data-el="lib.catalogue.card" data-preset-id={preset.id} data-selected={selected || undefined} aria-pressed={selected} aria-label={name} aria-disabled={reason ? true : undefined}
        title={reason ?? undefined}
        onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave}
        onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); setDetails(true); } }}
        onKeyUp={(e) => { if (e.key === ' ') e.preventDefault(); }}
        onClick={click}
        className={cx('group relative flex w-full flex-col overflow-hidden rounded-[8px] border bg-em-panel text-left em-trans', selected ? 'border-em-accent shadow-[inset_0_0_0_2px_var(--em-accent)]' : 'border-em-line hover:border-em-line-strong',
          hover && !reason && '-translate-y-0.5', reason && 'opacity-50 cursor-not-allowed')} style={hover ? { boxShadow: 'var(--sh-2)' } : undefined}>
        <div data-el="lib.catalogue.card.thumb" className={cx('relative w-full', compact ? 'aspect-[16/7]' : 'aspect-video')}>
          {loopUrl ? <video src={loopUrl} muted loop playsInline preload="metadata" aria-hidden onError={() => setLoopFailed(true)} className="h-full w-full object-cover" ref={(v) => { if (!v) return; if (hover) void v.play().catch(() => undefined); else v.pause(); }} />
            : <PresetSwatch id={preset.id} category={preset.category} playing={hover} />}
          {selected && <span className="absolute left-1 top-1 text-em-accent" title={t('ui.lib.catalogue.inpicks')}><Bookmark size={14} fill="currentColor" /></span>}
          {gpu && <span className="absolute right-1 top-1"><span data-el="lib.catalogue.card.badge.gpu" title={gpuLabel} className="rounded-[4px] bg-black/60 px-1 text-em-warn"><Cpu size={12} /></span></span>}
          {upcoming && <span className="absolute bottom-1 left-1 rounded-[4px] bg-black/60 px-1 text-[10px]">{t('ui.lib.catalogue.comingsoon')}</span>}
          {hover && !reason && typeof preset.defaults['durationMs'] === 'number' && <span className="t-mono absolute bottom-1 left-1 rounded-[4px] bg-black/60 px-1">{String(preset.defaults['durationMs'])} ms</span>}
        </div>
        <span data-el="lib.catalogue.card.label" className="truncate py-1 pl-2 pr-14 text-[13px] font-medium">{label}</span>
      </button>
      {modelMissing && (
        // FR-037: the badge is its own control (deep link to the model in the Model Manager), outside the card button.
        <button type="button" data-el="lib.catalogue.card.badge.model" aria-label={t('ui.lib.catalogue.badge.model', { model: modelKey ?? '' })} title={t('ui.lib.catalogue.badge.model', { model: modelKey ?? '' })}
          onClick={openModel} className={cx('absolute top-1 flex h-5 items-center rounded-[4px] bg-black/60 px-1 text-em-info', gpu ? 'right-7' : 'right-1')}>
          <DownloadCloud size={12} aria-hidden />
        </button>
      )}
      <button ref={infoRef} type="button" data-el="lib.catalogue.card.details" aria-haspopup="dialog" aria-expanded={details} aria-label={t('ui.lib.params.open', { preset: label })} title={t('ui.lib.params.open', { preset: label })}
        onClick={() => setDetails((d) => !d)} className="absolute bottom-0.5 right-1 flex h-6 w-6 items-center justify-center rounded-[4px] text-em-muted hover:bg-em-panel-2 hover:text-em-text">
        <Info size={14} aria-hidden />
      </button>
      {details && <PresetParams preset={preset} anchor={infoRef.current} onClose={() => setDetails(false)} disabledReason={reason} />}
    </div>
  );
}
