// Chat header model popover (agent.chat.model.*; FR-073 / FR-115, Operator decision 2026-10-26): a clean list, not a table.
// Search box, then the sections "Disarankan" (Recommended), "Gratis" (Free) and "Berbayar" (Paid); each row = model name,
// provider (short), a price chip ("$0.30/1M" or "Free") and ⚠ for models likely to give poor results (assessModelQuality via
// qualityOf: weak, or no JSON output). Filtering and ordering reuse the ModelPicker helpers (pickerRows, recommendedIds,
// isFreeModel); every row can be picked (Operator 2026-10-25). A pick is that agent's Model Assignment (putAssignments) and
// closes the popover, unless the model carries a warning: then the warning stays with "Use recommended instead".
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { AgentKind, CapabilityRow } from '../api/types.js';
import { useStore } from '../state/store.js';
import { useModelNames } from '../state/use-model-names.js';
import { Popover, cx, inputCls } from '../components/ui.js';
import { betterPick, isFreeModel, pickerRows, qualityOf, recommendedIds } from '../components/ModelPicker.js';

export type ModelSection = 'recommended' | 'free' | 'paid';
export const MODEL_SECTIONS: readonly ModelSection[] = ['recommended', 'free', 'paid'];
/** Rows shown per section before "More" (OpenRouter lists ~450 models). */
export const SECTION_PAGE = 20;

/** Rows of the popover per section (pure; exported for tests): search over name and id; recommended rows are not repeated. */
export function modelSections(rows: readonly CapabilityRow[], agent: AgentKind, query: string): Record<ModelSection, CapabilityRow[]> {
  const ordered = pickerRows(rows, agent, { query, category: 'all', json: false, images: false }, { sort: 'recommended', dir: 'asc' });
  const rec = new Set(recommendedIds(rows, agent));
  return {
    recommended: ordered.filter((r) => rec.has(r.modelId)),
    free: ordered.filter((r) => !rec.has(r.modelId) && isFreeModel(r)),
    paid: ordered.filter((r) => !rec.has(r.modelId) && !isFreeModel(r)),
  };
}

/** "$0.30/1M" (input price per million tokens), "Free", or null when the provider lists no price. */
export function priceChip(r: CapabilityRow, freeLabel: string): string | null {
  if (isFreeModel(r)) return freeLabel;
  if (r.pricePerMInput === null) return null;
  const v = r.pricePerMInput;
  return `$${v >= 10 ? v.toFixed(0) : v.toFixed(2)}/1M`;
}
/** Short provider of a model id ("anthropic/claude-…" → "anthropic"), else the connection's provider name. */
export const providerShort = (modelId: string, fallback: string): string => (modelId.includes('/') ? modelId.split('/')[0]! : fallback);
/** The model name without a "Provider: " prefix (the provider is shown on its own). */
const shortName = (label: string): string => label.replace(/^[^:]{1,30}:\s+/, '');

export function ModelPopover({ agent, onClose }: { agent: AgentKind; onClose: () => void }) {
  const { state, runtime, dispatch, actions, t } = useStore();
  const names = useModelNames();
  const valid = state.connections.filter((c) => c.status === 'valid');
  const cur = state.assignments?.[agent];
  const [connId, setConnId] = useState<string | null>(cur && valid.some((c) => c.id === cur.connectionId) ? cur.connectionId : valid[0]?.id ?? null);
  const [query, setQuery] = useState('');
  const [more, setMore] = useState<Record<ModelSection, number>>({ recommended: SECTION_PAGE, free: SECTION_PAGE, paid: SECTION_PAGE });
  const [loading, setLoading] = useState(false);
  const [warned, setWarned] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (connId ? state.capabilities[connId] ?? [] : []), [connId, state.capabilities]);
  const conn = valid.find((c) => c.id === connId);
  const fallbackProvider = conn ? t(`ui.scr.providers.provider.${conn.provider}`) : '';
  useEffect(() => {                                                                     // cached Capability Table (R-095, no provider call)
    if (!connId || state.capabilities[connId]) return;
    setLoading(true);
    runtime.api.connectionModels(connId).then((r) => dispatch({ type: 'capabilities', connectionId: connId, rows: r.items })).catch(() => undefined).finally(() => setLoading(false));
  }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => modelSections(rows, agent, query), [rows, agent, query]);
  const shown = MODEL_SECTIONS.flatMap((s) => sections[s].slice(0, more[s]));
  useEffect(() => { setActive(0); }, [query, connId]);
  const value = cur?.connectionId === connId ? cur?.modelId ?? '' : '';
  const refresh = async () => {
    if (!connId) return;
    setLoading(true);
    try { const r = await runtime.api.refreshConnectionModels(connId); dispatch({ type: 'capabilities', connectionId: connId, rows: r.items }); } catch (e) { actions.error(e); }
    setLoading(false);
  };
  const pick = async (modelId: string) => {
    if (!connId) return;
    try {
      const a = await runtime.api.putAssignments({ [agent]: { agent, connectionId: connId, modelId, settings: cur?.connectionId === connId ? cur.settings : {} } });
      dispatch({ type: 'providers', assignments: a });
      actions.announce(t('ui.agent.footer.model.changed', { model: names.llm(modelId, agent, connId) }));
      const row = rows.find((r) => r.modelId === modelId);
      if (!row || qualityOf(row, agent).level === 'ok') onClose(); else setWarned(modelId);   // a warned pick keeps the popover open
    } catch (e) { actions.error(e); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!shown.length) return;
      const next = e.key === 'ArrowDown' ? Math.min(shown.length - 1, active + 1) : Math.max(0, active - 1);
      setActive(next);
      listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); const r = shown[active]; if (r) void pick(r.modelId); }
  };
  const warnRow = warned ? rows.find((r) => r.modelId === warned) : undefined;
  const better = warned ? betterPick(rows, agent, warned) : null;
  let index = -1;
  return (
    <Popover el="agent.chat.model.popover" onClose={onClose} width={340} label={t('ui.agent.chat.model.title', { agent: t(`ui.agent.mode.${agent}`) })}>
      {valid.length === 0 || !connId ? <div className="p-2 text-em-muted">{t('ui.agent.composer.noprovider')}</div> : (
        <div className="flex flex-col gap-1.5 p-1">
          <div className="flex items-center gap-1">
            <input data-el="agent.chat.model.search" role="combobox" aria-expanded="true" aria-controls="em-model-list" aria-label={t('ui.agent.chat.model.search')} placeholder={t('ui.agent.chat.model.search')}
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} className={cx(inputCls, '!h-7 flex-1')} />
            <button type="button" data-el="agent.chat.model.refresh" aria-label={t('ui.scr.providers.refresh')} title={t('ui.scr.providers.refresh')} disabled={Boolean(state.settings?.privateMode) || loading}
              onClick={() => void refresh()} className="rounded-[6px] p-1 text-em-muted hover:text-em-text disabled:opacity-40"><RefreshCw size={14} className={loading ? 'em-spin' : undefined} /></button>
          </div>
          {valid.length > 1 && (
            <select data-el="agent.chat.model.connection" aria-label={t('ui.agent.footer.model.connection')} className={cx(inputCls, '!h-7')} value={connId} onChange={(e) => setConnId(e.target.value)}>
              {valid.map((c) => <option key={c.id} value={c.id}>{c.label || t(`ui.scr.providers.provider.${c.provider}`)}</option>)}
            </select>
          )}
          {warnRow && (
            <div data-el="agent.chat.model.warning" role="status" className="flex items-start gap-1.5 rounded-[6px] border-l-2 border-em-warn bg-em-panel-2 px-2 py-1 text-[12px]">
              <TriangleAlert size={12} className="mt-0.5 shrink-0 text-em-warn" />
              <span className="flex-1">{t('ui.agent.chat.model.weak', { model: shortName(warnRow.label || warnRow.modelId) })}</span>
              {better && <button type="button" data-el="agent.chat.model.warning.recommended" className="shrink-0 text-em-accent underline" onClick={() => void pick(better)}>{t('ui.modelpicker.warn.userec')}</button>}
            </div>
          )}
          <div ref={listRef} id="em-model-list" data-el="agent.chat.model.list" role="listbox" aria-label={t('ui.agent.chat.model.title', { agent: t(`ui.agent.mode.${agent}`) })} className="flex max-h-[340px] flex-col overflow-y-auto">
            {rows.length === 0 && !loading && (
              <div data-el="agent.chat.model.empty" className="flex items-center gap-2 p-2 text-[12px] text-em-muted"><span className="flex-1">{t('ui.modelpicker.empty')}</span>
                <button type="button" data-el="agent.chat.model.fetch" className="text-em-accent underline" disabled={Boolean(state.settings?.privateMode)} onClick={() => void refresh()}>{t('ui.modelpicker.fetch')}</button></div>
            )}
            {rows.length > 0 && !shown.length && <div data-el="agent.chat.model.nomatch" className="p-2 text-[12px] text-em-muted">{t('ui.modelpicker.nomatch')}</div>}
            {MODEL_SECTIONS.map((sec) => {
              const list = sections[sec];
              if (!list.length) return null;
              return (
                <div key={sec} data-el="agent.chat.model.section" data-section={sec} role="group" aria-label={t(`ui.agent.chat.model.section.${sec}`)} className="flex flex-col">
                  <div className="t-label px-2 pb-0.5 pt-1.5">{t(`ui.agent.chat.model.section.${sec}`)} <span className="text-em-muted">{list.length}</span></div>
                  {list.slice(0, more[sec]).map((r) => {
                    index++;
                    const i = index;
                    const q = qualityOf(r, agent);
                    const price = priceChip(r, t('ui.agent.chat.model.free'));
                    const selected = r.modelId === value;
                    return (
                      <div key={r.modelId} role="option" tabIndex={-1} aria-selected={selected} data-el="agent.chat.model.row" data-model-id={r.modelId} data-quality={q.level} data-index={i}
                        onClick={() => void pick(r.modelId)} onMouseEnter={() => setActive(i)} title={r.modelId}
                        className={cx('flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-[13px]', i === active ? 'bg-em-panel-2' : 'hover:bg-em-panel-2', selected && 'text-em-accent')}>
                        <span className="min-w-0 flex-1 truncate">{shortName(r.label || r.modelId)}</span>
                        <span className="shrink-0 text-[11px] text-em-muted">{providerShort(r.modelId, fallbackProvider)}</span>
                        {price && <span data-el="agent.chat.model.row.price" className={cx('t-mono shrink-0 rounded-[4px] border px-1 text-[10px]', isFreeModel(r) ? 'border-em-success/60 text-em-success' : 'border-em-line text-em-text-2')}>{price}</span>}
                        {q.level !== 'ok' && <span data-el="agent.chat.model.row.warn" data-reasons={q.reasons.join(' ')} title={t('ui.agent.chat.model.weak.tip')} aria-label={t('ui.agent.chat.model.weak.tip')} className="shrink-0 text-em-warn"><TriangleAlert size={12} /></span>}
                      </div>
                    );
                  })}
                  {list.length > more[sec] && (
                    <button type="button" data-el="agent.chat.model.more" className="px-2 py-0.5 text-left text-[11px] text-em-accent underline" onClick={() => setMore((m) => ({ ...m, [sec]: m[sec] + SECTION_PAGE * 3 }))}>
                      {t('ui.agent.chat.model.more', { count: list.length - more[sec] })}</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <button type="button" data-el="agent.chat.model.manage" className="mt-1 w-full px-2 py-1 text-left text-[11px] text-em-accent underline" onClick={() => { onClose(); actions.setScreen({ kind: 'providers' }); }}>{t('ui.agent.footer.model.manage')}</button>
    </Popover>
  );
}
