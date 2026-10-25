// ModelPicker (FR-115, FR-073; Operator feedback 2026-10-25): one searchable model table over a connection's Capability
// Table, shared by the Providers screen and the chat footer popover. Search (name or id, case-insensitive), a segmented
// category filter All / Free / Paid, filter chips JSON / Images, sortable columns (name, context, price), a "Recommended" badge
// on 1–3 rows (the tier resolution of packages/shared model-tiers is used only to pre-sort and mark them, never shown as a
// tier name), ↑/↓ + Enter, at most PAGE rows rendered at once with "Show more". Operator decision 2026-10-25: every row can be
// selected; rows that are likely to give poor results (assessModelQuality: weak, or no JSON output) carry a ⚠ badge, and a
// selected one shows an inline warning with "Use recommended instead".
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { assessModelQuality, recommendedFor, resolveFreeModel, resolveModelTiers, type ModelQuality } from '@expertmotion/shared';
import type { AgentKind, CapabilityRow } from '../api/types.js';
import { useStore } from '../state/store.js';
import { formatMoney } from '../i18n/index.js';
import { Button, IconButton, cx, inputCls } from './ui.js';

/** Rows rendered at once (OpenRouter lists ~450 models); "Show more" adds another page. */
export const PAGE = 100;
export type PickerSort = 'recommended' | 'name' | 'price' | 'context';
export type PickerCategory = 'all' | 'free' | 'paid';
export const CATEGORIES: readonly PickerCategory[] = ['all', 'free', 'paid'];
export interface PickerFilters { query: string; category: PickerCategory; json: boolean; images: boolean }
export interface PickerOrder { sort: PickerSort; dir: 'asc' | 'desc' }

export const isFreeModel = (r: CapabilityRow): boolean => r.modelId.endsWith(':free') || (r.pricePerMInput === 0 && r.pricePerMOutput === 0);
/** JSON chip: `structuredOutput === true`; when the provider reports no row as true (OpenAI/Anthropic/Gemini lists), "not known false". */
export const jsonCapable = (rows: readonly CapabilityRow[]): ((r: CapabilityRow) => boolean) => {
  const known = rows.some((r) => r.structuredOutput === true);
  return known ? (r) => r.structuredOutput === true : (r) => r.structuredOutput !== false;
};
/** Quality hint of a row for an agent (packages/shared model-quality); never used to refuse a row. */
export const qualityOf = (r: CapabilityRow, agent: AgentKind): ModelQuality => assessModelQuality(r, agent);

/** 1–3 model ids marked "Recommended" (Balanced, Best, Fast of resolveModelTiers, distinct); the free pick while Free is on.
 *  Picks with a quality warning are left out unless every pick has one. */
export function recommendedIds(rows: readonly CapabilityRow[], agent: AgentKind, freeOn = false): string[] {
  if (freeOn) { const f = resolveFreeModel(rows); return f ? [f] : []; }
  const t = resolveModelTiers(rows, agent);
  const ids = [...new Set([t.balanced, t.best, t.fast].filter((x): x is string => !!x))];
  const ok = ids.filter((id) => { const r = rows.find((x) => x.modelId === id); return !r || qualityOf(r, agent).level === 'ok'; });
  return ok.length ? ok : ids;
}
/** "Use recommended instead": the first recommended model without a quality warning other than `current`, or null. */
export function betterPick(rows: readonly CapabilityRow[], agent: AgentKind, current: string, freeOn = false): string | null {
  const okRow = (id: string) => { const r = rows.find((x) => x.modelId === id); return !!r && qualityOf(r, agent).level === 'ok'; };
  return [...recommendedIds(rows, agent, freeOn), ...(freeOn ? recommendedIds(rows, agent) : [])].find((id) => id !== current && okRow(id)) ?? null;
}
/** The default model for an agent: Balanced (or the free pick when Free is on), '' when the table has no usable model. */
export function defaultModelFor(rows: readonly CapabilityRow[], agent: AgentKind, freeOn = false): string {
  return (freeOn ? resolveFreeModel(rows) : null) ?? resolveModelTiers(rows, agent).balanced ?? '';
}

const priceSum = (r: CapabilityRow): number | null => (isFreeModel(r) ? 0 : r.pricePerMInput === null || r.pricePerMOutput === null ? null : r.pricePerMInput + r.pricePerMOutput);

/** Filter + order (pure; exported for tests). Unknown prices/contexts sort last in both directions; ties keep the provider order. */
export function pickerRows(rows: readonly CapabilityRow[], agent: AgentKind, f: PickerFilters, o: PickerOrder): CapabilityRow[] {
  const q = f.query.trim().toLowerCase();
  const json = jsonCapable(rows);
  const list = rows.filter((r) => (!q || r.label.toLowerCase().includes(q) || r.modelId.toLowerCase().includes(q))
    && (f.category === 'all' || (f.category === 'free') === isFreeModel(r)) && (!f.json || json(r)) && (!f.images || r.imageInput === true));
  const idx = new Map(rows.map((r, i) => [r.modelId, i] as const));
  const sign = o.dir === 'asc' ? 1 : -1;
  const num = (a: number | null, b: number | null) => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : sign * (a - b));
  let cmp: (a: CapabilityRow, b: CapabilityRow) => number;
  if (o.sort === 'name') cmp = (a, b) => sign * (a.label || a.modelId).localeCompare(b.label || b.modelId);
  else if (o.sort === 'price') cmp = (a, b) => num(priceSum(a), priceSum(b));
  else if (o.sort === 'context') cmp = (a, b) => num(a.contextLength, b.contextLength);
  else {
    // Recommended first, then rows that fit the agent, then the rest; rows with a quality warning after those (no JSON last).
    const rec = recommendedIds(rows, agent, f.category === 'free');
    const level = new Map(list.map((r) => [r.modelId, qualityOf(r, agent).level] as const));
    const rank = (r: CapabilityRow) => (rec.includes(r.modelId) ? 0 : level.get(r.modelId) === 'unsupported' ? 4 : level.get(r.modelId) === 'weak' ? 3 : recommendedFor(r).includes(agent) ? 1 : 2);
    cmp = (a, b) => rank(a) - rank(b) || (rank(a) === 0 ? rec.indexOf(a.modelId) - rec.indexOf(b.modelId) : 0);
  }
  return [...list].sort((a, b) => cmp(a, b) || idx.get(a.modelId)! - idx.get(b.modelId)!);
}

/** "128K" / "1M" (binary sizes such as 32 768 read as 32K). */
export function formatContext(n: number | null): string {
  if (!n) return '—';
  if (n >= 1_000_000) { const m = n % 1_000_000 !== 0 && n % 1_048_576 === 0 ? n / 1_048_576 : n / 1_000_000; return `${Number.isInteger(m) ? m : m.toFixed(1)}M`; }
  return `${n % 1000 !== 0 && n % 1024 === 0 ? n / 1024 : Math.round(n / 1000)}K`;
}

const FIRST_DIR: Record<Exclude<PickerSort, 'recommended'>, 'asc' | 'desc'> = { name: 'asc', price: 'asc', context: 'desc' };

export interface ModelPickerProps {
  /** data-el base: `scr.providers.models` or `agent.<agent>.footer.model.picker`; parts are `<base>.search`, `.list`, `.row`, … */
  el: string;
  rows: readonly CapabilityRow[];
  agent: AgentKind;
  /** Selected model id ('' = none). */
  value: string;
  onSelect: (modelId: string) => void;
  /** Refresh / "Fetch models" (empty table) action; omitted for a draft connection. */
  onRefresh?: (() => void) | undefined;
  refreshDisabledReason?: string | null | undefined;
  /** Called when the All / Free / Paid category changes (Providers switches untouched defaults to the free pick on Free). */
  onCategoryChange?: ((category: PickerCategory) => void) | undefined;
  compact?: boolean | undefined;
  loading?: boolean | undefined;
}

export function ModelPicker({ el, rows, agent, value, onSelect, onRefresh, refreshDisabledReason, onCategoryChange, compact, loading }: ModelPickerProps) {
  const { t, lang } = useStore();
  const uid = useId().replace(/:/g, '');
  const [query, setQuery] = useState('');
  const [category, setCategoryState] = useState<PickerCategory>('all');
  const [json, setJson] = useState(false);                                            // off for both agents: nothing is refused
  const [images, setImages] = useState(false);
  const [order, setOrder] = useState<PickerOrder>({ sort: 'recommended', dir: 'asc' });
  const [limit, setLimit] = useState(PAGE);
  const [active, setActive] = useState(-1);
  const free = category === 'free';
  const setCategory = (c: PickerCategory) => { if (c !== category) { setCategoryState(c); onCategoryChange?.(c); } };
  const list = useMemo(() => pickerRows(rows, agent, { query, category, json, images }, order), [rows, agent, query, category, json, images, order]);
  const rec = useMemo(() => new Set(recommendedIds(rows, agent, free)), [rows, agent, free]);
  const quality = useMemo(() => new Map(rows.map((r) => [r.modelId, qualityOf(r, agent)] as const)), [rows, agent]);
  // New query / filter / order: back to the first page, active row = the selected one when visible, else the first.
  const selectedIdx = list.findIndex((r) => r.modelId === value);
  const resetKey = `${query}|${category}|${json}|${images}|${order.sort}|${order.dir}|${agent}|${rows.length}`;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastKey.current === resetKey) return;
    lastKey.current = resetKey;
    setLimit(Math.max(PAGE, selectedIdx >= 0 && !query ? Math.ceil((selectedIdx + 1) / PAGE) * PAGE : PAGE));
    setActive(selectedIdx >= 0 ? selectedIdx : list.length ? 0 : -1);
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = list.slice(0, limit);
  const optId = (i: number) => `${uid}-opt-${i}`;
  useEffect(() => { if (active >= 0) document.getElementById(optId(active))?.scrollIntoView?.({ block: 'nearest' }); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (r: CapabilityRow | undefined) => { if (r) onSelect(r.modelId); };                // every row can be chosen (Operator 2026-10-25)
  const onKey = (e: KeyboardEvent) => {
    const role = (e.target as HTMLElement).getAttribute?.('role');
    if (role !== 'combobox' && role !== 'listbox') return;                            // chips, sort headers, "Show more" keep their own keys
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!list.length) return;
      const next = e.key === 'ArrowDown' ? Math.min(list.length - 1, active + 1) : Math.max(0, active - 1);
      if (next >= limit) setLimit((l) => l + PAGE);
      setActive(next);
    } else if (e.key === 'Enter') {
      if (active >= 0 && list[active]) { e.preventDefault(); e.stopPropagation(); choose(list[active]); }
    }
  };
  const sortBy = (s: Exclude<PickerSort, 'recommended'>) => setOrder((o) => (o.sort !== s ? { sort: s, dir: FIRST_DIR[s] } : o.dir === FIRST_DIR[s] ? { sort: s, dir: FIRST_DIR[s] === 'asc' ? 'desc' : 'asc' } : { sort: 'recommended', dir: 'asc' }));
  const ariaSort = (s: PickerSort) => (order.sort === s ? (order.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  const arrow = (s: PickerSort) => (order.sort === s ? (order.dir === 'asc' ? ' ↑' : ' ↓') : '');
  const chip = (name: 'json' | 'images', on: boolean, set: (v: boolean) => void) => (
    <button key={name} type="button" data-el={`${el}.filter.${name}`} aria-pressed={on} onClick={() => set(!on)}
      className={cx('rounded-full border px-2 text-[11px] leading-[20px]', on ? 'border-em-accent bg-em-accent/10 text-em-accent' : 'border-em-line text-em-text-2 hover:bg-em-panel-2')}>
      {t(`ui.modelpicker.filter.${name}`)}
    </button>
  );
  const cols = compact ? 'grid-cols-[minmax(0,1fr)_44px_92px]' : 'grid-cols-[minmax(0,1fr)_56px_120px_118px]';
  const price = (r: CapabilityRow) => (isFreeModel(r)
    ? <span className="rounded-[4px] border border-em-success/60 px-1 text-[10px] text-em-success">{t('ui.modelpicker.free')}</span>
    : r.pricePerMInput === null || r.pricePerMOutput === null ? <span data-el={`${el}.row.price.unknown`} className="text-em-muted" title={t('ui.scr.providers.unknown.tip')}>{t('ui.modelpicker.price.unknown')}</span>
    : <span>{formatMoney(r.pricePerMInput, false, lang)} · {formatMoney(r.pricePerMOutput, false, lang)}</span>);
  // Quality warning text (en/id): the no-JSON sentence names the agent; weak models get the general sentence; reasons follow.
  const warnText = (qa: ModelQuality) => (qa.level === 'unsupported' ? t('ui.modelpicker.warn.nojson', { agent: t(`ui.scr.providers.assign.${agent}`) }) : t('ui.modelpicker.warn.weak'));
  const whyText = (qa: ModelQuality) => qa.reasons.filter((x) => x !== 'no-json').map((x) => t(`ui.modelpicker.why.${x}`)).join(' · ');
  const selectedRow = value ? rows.find((r) => r.modelId === value) : undefined;
  const selectedQ = selectedRow ? quality.get(selectedRow.modelId) : undefined;
  const better = selectedQ && selectedQ.level !== 'ok' ? betterPick(rows, agent, value, free) : null;
  const badge = (on: boolean | null, key: 'json' | 'tools' | 'image') => (on === false ? null
    : <span key={key} data-cap={key} title={on === null ? t('ui.scr.providers.unknown.tip') : undefined}
      className={cx('rounded-[4px] border px-1 text-[10px] leading-[16px]', on ? 'border-em-line text-em-text-2' : 'border-dashed border-em-line text-em-muted')}>{t(`ui.modelpicker.cap.${key}`)}{on === null ? '?' : ''}</span>);
  const listId = `${uid}-list`;
  return (
    <div data-el={el} className="flex min-w-0 flex-col gap-1.5" onKeyDown={onKey}>
      <div className="flex items-center gap-1.5">
        <input data-el={`${el}.search`} type="search" role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 && active < shown.length ? optId(active) : undefined}
          aria-label={t('ui.modelpicker.search')} placeholder={t('ui.modelpicker.search')} value={query} onChange={(e) => setQuery(e.target.value)} className={cx(inputCls, '!h-7 min-w-0 flex-1')} />
        {onRefresh && <IconButton el={`${el}.refresh`} label={t('ui.scr.providers.refresh')} icon={<RefreshCw size={14} />} size={28} disabledReason={refreshDisabledReason ?? null} onClick={onRefresh} />}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <div role="radiogroup" data-el={`${el}.category`} aria-label={t('ui.modelpicker.category')} className="flex overflow-hidden rounded-full border border-em-line">
          {CATEGORIES.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={category === c} data-el={`${el}.category.${c}`} onClick={() => setCategory(c)}
              className={cx('px-2 text-[11px] leading-[20px]', category === c ? 'bg-em-accent/15 text-em-accent' : 'text-em-text-2 hover:bg-em-panel-2')}>
              {t(`ui.modelpicker.category.${c}`)}
            </button>
          ))}
        </div>
        {chip('json', json, setJson)}{chip('images', images, setImages)}
        <span data-el={`${el}.count`} className="ml-auto text-[11px] text-em-muted">{t('ui.modelpicker.count', { shown: list.length, total: rows.length })}</span>
      </div>
      {rows.length === 0 ? (
        <div data-el={`${el}.empty`} className="flex flex-col items-start gap-1.5 rounded-[6px] border border-em-line p-2 text-[12px] text-em-muted">
          <span>{loading ? t('ui.common.loading') : t('ui.modelpicker.empty')}</span>
          {onRefresh && !loading && <Button el={`${el}.fetch`} size={28} disabledReason={refreshDisabledReason ?? null} onClick={onRefresh}>{t('ui.modelpicker.fetch')}</Button>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[6px] border border-em-line">
          <div role="presentation" className={cx('grid items-center gap-x-2 bg-em-panel-2 px-2 py-0.5 text-[11px] text-em-muted', cols)}>
            <button type="button" data-el={`${el}.sort.name`} aria-sort={ariaSort('name')} className="text-left hover:text-em-text" onClick={() => sortBy('name')}>{t('ui.modelpicker.col.model')}{arrow('name')}</button>
            <button type="button" data-el={`${el}.sort.context`} aria-sort={ariaSort('context')} className="text-right hover:text-em-text" onClick={() => sortBy('context')}>{t('ui.modelpicker.col.context')}{arrow('context')}</button>
            <button type="button" data-el={`${el}.sort.price`} aria-sort={ariaSort('price')} className="text-right hover:text-em-text" title={t('ui.modelpicker.col.price.tip')} onClick={() => sortBy('price')}>{t('ui.modelpicker.col.price')}{arrow('price')}</button>
            {!compact && <span>{t('ui.modelpicker.col.caps')}</span>}
          </div>
          <div id={listId} data-el={`${el}.list`} role="listbox" tabIndex={0}
            aria-activedescendant={active >= 0 && active < shown.length ? optId(active) : undefined} aria-label={t('ui.modelpicker.list', { agent: t(`ui.scr.providers.assign.${agent}`) })}
            className={cx('overflow-y-auto', compact ? 'max-h-64' : 'max-h-72')}>
            {list.length === 0 && (
              <div data-el={`${el}.nomatch`} className="flex items-center gap-2 px-2 py-2 text-[12px] text-em-muted">
                {t('ui.modelpicker.nomatch')}
                <button type="button" className="text-em-accent underline" onClick={() => { setQuery(''); setCategory('all'); setImages(false); setJson(false); }}>{t('ui.modelpicker.clear')}</button>
              </div>
            )}
            {shown.map((r, i) => {
              const qa = quality.get(r.modelId)!;
              const warn = qa.level !== 'ok';
              const tip = warn ? [warnText(qa), whyText(qa)].filter(Boolean).join(' — ') : '';
              const selected = r.modelId === value;
              return (
                <div key={r.modelId} id={optId(i)} role="option" data-el={`${el}.row`} data-model-id={r.modelId} data-quality={qa.level} aria-selected={selected}
                  title={warn ? `${r.modelId} — ${tip}` : r.modelId}
                  onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => { setActive(i); choose(r); }}
                  className={cx('grid cursor-pointer items-center gap-x-2 border-t border-em-line px-2 py-1 text-[12px]', cols,
                    selected ? 'bg-em-accent/15 shadow-[inset_2px_0_0_var(--em-accent,currentColor)]' : i === active ? 'bg-em-panel-2' : 'hover:bg-em-panel-2')}>
                  <span className="min-w-0">
                    <span className={cx('flex min-w-0 items-center gap-1', selected && 'text-em-accent')}>
                      <span className="truncate">{selected ? '✓ ' : ''}{r.label || r.modelId}</span>
                      {rec.has(r.modelId) && !warn && <span data-el={`${el}.row.recommended`} className="shrink-0 rounded-[4px] bg-em-accent/15 px-1 text-[10px] text-em-accent">{t('ui.modelpicker.recommended')}</span>}
                      {warn && <span data-el={`${el}.row.warn`} data-reasons={qa.reasons.join(' ')} title={tip} aria-label={tip}
                        className="shrink-0 rounded-[4px] border border-em-warn/60 px-1 text-[10px] text-em-warn">⚠ {t(qa.level === 'unsupported' ? 'ui.modelpicker.warn.badge.nojson' : 'ui.modelpicker.warn.badge.weak')}</span>}
                    </span>
                    <span className="t-mono block truncate text-[10px] text-em-muted">{r.modelId}</span>
                    {compact && <span className="mt-0.5 flex gap-1">{badge(r.structuredOutput, 'json')}{badge(r.toolCalling, 'tools')}{badge(r.imageInput, 'image')}</span>}
                  </span>
                  <span className="t-mono text-right">{formatContext(r.contextLength)}</span>
                  <span className="t-mono text-right text-[11px]">{price(r)}</span>
                  {!compact && <span className="flex flex-wrap gap-1">{badge(r.structuredOutput, 'json')}{badge(r.toolCalling, 'tools')}{badge(r.imageInput, 'image')}</span>}
                </div>
              );
            })}
            {list.length > shown.length && (
              <button type="button" data-el={`${el}.more`} className="w-full border-t border-em-line px-2 py-1 text-left text-[12px] text-em-accent hover:bg-em-panel-2" onClick={() => setLimit((l) => l + PAGE)}>
                {t('ui.modelpicker.more', { count: Math.min(PAGE, list.length - shown.length), rest: list.length - shown.length })}
              </button>
            )}
          </div>
        </div>
      )}
      {selectedRow && selectedQ && selectedQ.level !== 'ok' && (
        <div data-el={`${el}.warning`} role="status" data-quality={selectedQ.level} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[6px] border border-em-warn/60 bg-em-warn/10 px-2 py-1 text-[12px] text-em-text">
          <span className="min-w-0 flex-1">
            <span className="text-em-warn">⚠ </span>{warnText(selectedQ)}
            {whyText(selectedQ) && <span className="block text-[11px] text-em-muted">{whyText(selectedQ)}</span>}
          </span>
          {better && <Button el={`${el}.warning.recommended`} size={28} variant="ghost" title={rows.find((r) => r.modelId === better)?.label || better} onClick={() => onSelect(better)}>{t('ui.modelpicker.warn.userec')}</Button>}
        </div>
      )}
    </div>
  );
}
