// Library Panel (lib.*): Catalogue Search, mode header, mode-dependent area (Design/Home/Tools), Asset Panel.
// FR-034 search from 2 characters, FR-035 rotating registry suggestions (placeholder + list on focus; choosing one opens its
// tab), FR-054 the Asset Panel stays visible in every mode and the search filters it in Home/Tools mode.
import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Category } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import { Catalogue, MIN_QUERY, SUGGESTIONS, activeQuery } from './Catalogue.js';
import { TextPanel } from './TextPanel.js';
import { Generators } from './Generators.js';
import { AssetPanel } from './Assets.js';
import { IconButton } from '../components/ui.js';

export function targetLabel(t: (k: string, v?: Record<string, string | number>) => string, kind: string, index: number): string {
  return t(`ui.common.target.${kind}`, { n: index + 1 });
}
const ROTATE_MS = 4000;

export function LibraryPanel() {
  const { state, t } = useStore();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tab, setTab] = useState<Category>('transition');
  const [showSuggest, setShowSuggest] = useState(false);
  const [rot, setRot] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = setTimeout(() => setDebounced(query), 100); return () => clearTimeout(h); }, [query]);
  useEffect(() => { const h = setInterval(() => setRot((r) => (r + 1) % SUGGESTIONS.length), ROTATE_MS); return () => clearInterval(h); }, []);
  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener('em:focus-search', focus);
    return () => window.removeEventListener('em:focus-search', focus);
  }, []);
  useEffect(() => { headerRef.current?.focus({ preventScroll: true }); }, [state.libMode]);
  const sel = state.selection[0];
  const model = state.head?.model;
  const selLabel = sel ? (sel.kind === 'clip' ? targetLabel(t, 'clip', Math.max(0, model?.tracks.video.findIndex((c) => c.id === sel.id) ?? 0))
    : sel.kind === 'cut' ? targetLabel(t, 'cut', sel.index ?? 0) : sel.kind === 'text' ? t('ui.common.target.text') : t(`ui.common.target.${sel.kind}`, { n: 1 })) : null;
  const modeKey = state.libMode === 'design' ? 'ui.lib.mode.design' : state.libMode === 'home' ? 'ui.lib.mode.home' : 'ui.lib.mode.tools';
  const suggest = (q: string, category: Category) => { setTab(category); setQuery(q); setDebounced(q); setShowSuggest(false); };
  const clear = () => { setQuery(''); setDebounced(''); searchRef.current?.focus(); };
  const tooShort = query.trim().length > 0 && query.trim().length < MIN_QUERY;
  const assetFilter = state.libMode === 'design' ? '' : activeQuery(debounced);
  return (
    <aside aria-label={t('a11y.region.library')} data-region="library" className="flex h-full min-h-0 flex-col bg-em-panel">
      <div className="relative p-3 pb-2">
        <Search size={16} className="pointer-events-none absolute left-5 top-5 text-em-muted" aria-hidden />
        <input ref={searchRef} data-el="lib.search.input" type="search" role="searchbox" aria-label={t('a11y.lib.search.input')} value={query}
          placeholder={t('ui.lib.search.placeholder.suggest', { q: SUGGESTIONS[rot]?.query ?? '' })} onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setShowSuggest(true)} onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setQuery(''); (e.target as HTMLInputElement).blur(); } }}
          className="h-9 w-full text-ellipsis rounded-[6px] border border-em-line bg-em-panel-2 pl-8 pr-8 text-[13px] outline-none placeholder:text-em-muted focus:border-em-line-strong" />
        {query && <span className="absolute right-4 top-3.5"><IconButton label={t('ui.common.clear')} icon={<X size={14} />} size={28} onClick={clear} /></span>}
        {tooShort && <p className="mt-1 text-[11px] text-em-muted">{t('ui.lib.search.minchars', { n: MIN_QUERY })}</p>}
        {showSuggest && !query && (
          <div role="listbox" aria-label={t('ui.lib.search.suggestions')} className="mt-1.5 flex flex-wrap gap-1">{SUGGESTIONS.map((s) => <button key={s.query} type="button" role="option" aria-selected={false} data-el="lib.search.suggestion" onMouseDown={(e) => e.preventDefault()} onClick={() => suggest(s.query, s.category)} className="rounded-full border border-em-line px-2 text-[12px] text-em-text-2 hover:border-em-line-strong">{s.query}</button>)}</div>
        )}
        <span className="sr-only" aria-live="polite">{activeQuery(debounced) ? t('a11y.lib.search.results') : ''}</span>
      </div>
      {/* Entry 36: programmatic focus target (screen readers hear the mode), not a control — the global focus ring drew an orange box
          around "PREVIEW" on every launch */}
      <div ref={headerRef} tabIndex={-1} data-el="lib.mode.header" className="flex items-center gap-2 px-3 py-1" style={{ outline: 'none' }}>
        <span className="t-label flex-1">{t(modeKey)}</span>
        {selLabel && <span className="rounded-full border border-em-accent/50 px-2 text-[11px] text-em-accent">{t('ui.lib.mode.appliesto', { target: selLabel })}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {state.libMode === 'design' && <Catalogue query={debounced} tab={tab} onTab={setTab} onSuggest={suggest} onClear={clear} />}
        {state.libMode === 'home' && <TextPanel />}
        {state.libMode === 'tools' && <Generators />}
      </div>
      <div className="flex max-h-[48%] min-h-[160px] flex-col"><AssetPanel filter={assetFilter} /></div>
    </aside>
  );
}
