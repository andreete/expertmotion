// Intent Queue (agent.editor.intentqueue.*, CMP-15, UI_UX_SPECIFICATION.md §11.3): receipts for every pick; superseded
// items stay visible struck through with Restore; parent/child expansion ("Fade → all 3 cuts"); IX-17 restore/remove/clear.
// Since 2026-10-26 (one assistant chat) it is the compact "Your picks" strip above the composer in Edit mode: a toggle with a
// count badge (`.toggle`, `.count`) expands the list and its Plan / Clear / Cancel actions (prefs.picksOpen).
import { useState, type ReactNode } from 'react';
import { Bookmark, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, DownloadCloud, History, Lightbulb, MessageCircle, OctagonAlert, Undo2, X } from 'lucide-react';
import type { CompositionModelT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import { localModelByRef, localModelName } from '../state/model-names.js';
import { visibleQueue } from '../state/reducer.js';
import type { EditIntent } from '../api/types.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { categoryIcon } from '../library/presetVisual.js';
import { intentTitle } from './proposals.js';

type T = (k: string, v?: Record<string, string | number>) => string;

export function targetText(i: EditIntent, model: CompositionModelT | undefined, t: T): string {
  const r = i.resolvedTargets;
  if (!r.length) return i.category === 'text' && i.presetId ? t('ui.agent.target.newtext') : i.status === 'rejected' ? '?' : t('ui.agent.target.auto');
  if (r.every((x) => x.kind === 'cut')) {
    const total = Math.max(0, (model?.tracks.video.length ?? 0) - 1);
    if (r.length > 1 && r.length === total) return t('ui.agent.target.allcuts', { count: r.length });
    return r.length === 1 ? t('ui.common.target.cut', { n: (r[0]!.index ?? 0) + 1 }) : t('ui.agent.target.cuts', { list: r.map((x) => (x.index ?? 0) + 1).join(', ') });
  }
  const one = r[0]!;
  if (one.kind === 'project') return t('ui.agent.target.project');
  if (one.kind === 'clip') { const n = model?.tracks.video.findIndex((c) => c.id === one.id) ?? -1; return n >= 0 ? t('ui.common.target.clip', { n: n + 1 }) : t('ui.common.target.clip', { n: '?' }); }
  if (one.kind === 'text') { const x = model?.tracks.text.find((y) => y.id === one.id); return x ? t('ui.agent.target.textnamed', { text: x.text.slice(0, 24) }) : t('ui.common.target.text'); }
  if (one.kind === 'sequence') return t('ui.agent.target.sequence');
  return t(`ui.common.target.${one.kind}`, { n: (one.index ?? 0) + 1 });
}

/** One row of the queue: a single top-level item, or the executed items of an older version collapsed under "Applied in v5 (3)". */
export type QueueRow = { kind: 'item'; intent: EditIntent } | { kind: 'group'; version: number; items: EditIntent[] };

/**
 * Grouping (UI_UX_SPECIFICATION.md §11.3): top-level items executed in the same version collapse under one row. The newest
 * applied version stays expanded as individual rows (it is what the Creator just did); older versions group. Items with a
 * superseded or rejected child stay ungrouped so their Restore stays visible.
 */
export function groupQueue(top: EditIntent[], all: EditIntent[]): QueueRow[] {
  const groupable = (i: EditIntent) => i.status === 'executed' && typeof i.appliedVersion === 'number' && all.every((c) => c.parentIntentId !== i.id || c.status === 'executed');
  const versions = top.filter(groupable).map((i) => i.appliedVersion!);
  const newest = versions.length ? Math.max(...versions) : -1;
  const rows: QueueRow[] = [];
  const groups = new Map<number, { kind: 'group'; version: number; items: EditIntent[] }>();
  for (const i of top) {
    if (!groupable(i) || i.appliedVersion === newest) { rows.push({ kind: 'item', intent: i }); continue; }
    const v = i.appliedVersion!;
    const g = groups.get(v);
    if (g) g.items.push(i); else { const ng = { kind: 'group' as const, version: v, items: [i] }; groups.set(v, ng); rows.push(ng); }
  }
  return rows;
}

export function IntentQueue({ hidden }: { hidden?: boolean } = {}) {
  const { state, actions, t, prefs, setPrefs } = useStore();
  const expanded = prefs.picksOpen;
  const all = visibleQueue(state).filter((i) => i.source !== 'system' || i.params['__output'] !== undefined);   // FR-097: Output Settings changes (incl. Reset) stay visible
  const top = all.filter((i) => !i.parentIntentId);
  const queuedCount = top.filter((i) => i.status === 'queued' || i.status === 'superseded' || i.status === 'rejected').length;
  const needsAgent = all.some((i) => i.status === 'queued' && (i.needsInterpretation || !i.parentIntentId));
  const [open, setOpen] = useState<Set<number>>(new Set());
  const rows = groupQueue(top, all);
  const running = Boolean(state.streaming.editor) || state.plan?.status === 'draft' || state.plan?.status === 'executing';
  return (
    <div data-el="agent.editor.picks" data-open={expanded ? 'true' : undefined} hidden={hidden} className={cx('flex shrink-0 flex-col border-t border-em-line', expanded && 'max-h-[40%]')}>
      <div className="flex items-center gap-1.5 px-3 py-1">
        <button type="button" data-el="agent.editor.intentqueue.toggle" aria-expanded={expanded} aria-controls="em-picks" onClick={() => setPrefs({ picksOpen: !expanded })}
          className="flex flex-1 items-center gap-1.5 text-left text-[12px] text-em-text-2 hover:text-em-text">
          {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronUp size={12} aria-hidden />}
          <span className="t-label">{t('ui.agent.chat.picks')}</span>
          <span data-el="agent.editor.intentqueue.count" className={cx('rounded-full px-1.5 text-[10px] font-semibold', queuedCount ? 'bg-em-accent text-white' : 'bg-em-panel-2 text-em-muted')}>{top.length}</span>
        </button>
        <span hidden={!expanded} className="contents">
        <Button el="agent.editor.plan" size={28} disabledReason={needsAgent ? null : t('ui.agent.editor.plan.disabled')} onClick={() => void actions.plan()}>{t('ui.agent.editor.plan')}</Button>
        <Button el="agent.editor.intentqueue.clear" size={28} variant="ghost" disabledReason={queuedCount ? null : t('ui.agent.editor.intentqueue.clear.disabled')}
          onClick={() => actions.setScreen({ kind: 'confirm', titleKey: 'ui.modal.clear.intents', vars: { count: queuedCount }, confirmKey: 'ui.agent.editor.intentqueue.clear', danger: true, onConfirm: () => { void actions.clearIntents(); } })}>{t('ui.agent.editor.intentqueue.clear')}</Button>
        <Button el="agent.editor.cancel" size={28} variant="ghost" disabledReason={running ? null : t('ui.agent.editor.cancel.disabled')} onClick={() => void actions.cancelPlan()}>{t('ui.common.cancel')}</Button>
        </span>
      </div>
      <ul id="em-picks" hidden={!expanded} data-el="agent.editor.intentqueue" aria-label={t('a11y.agent.editor.intentqueue', { count: top.length })} className="flex min-h-0 flex-col gap-1 overflow-y-auto px-3 pb-2">
        {top.length === 0 && <li className="py-2 text-center text-[12px] text-em-muted">{t('ui.agent.editor.intentqueue.empty')}</li>}
        {rows.map((row) => {
          if (row.kind === 'group') {
            const expanded = open.has(row.version);
            const gid = `em-q-group-${row.version}`;
            return (
              <li key={`g${row.version}`} className="flex shrink-0 flex-col gap-0.5">
                <button type="button" data-el="agent.editor.intentqueue.group" aria-expanded={expanded} aria-controls={gid}
                  onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(row.version)) n.delete(row.version); else n.add(row.version); return n; })}
                  className="flex items-center gap-1 rounded-[6px] px-1 py-0.5 text-left text-[12px] text-em-success hover:bg-em-panel-2">
                  {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}<CheckCircle2 size={12} aria-hidden />
                  {t('ui.agent.editor.intentqueue.group', { version: row.version, count: row.items.length })}
                </button>
                <ul id={gid} hidden={!expanded} className="ml-3 flex flex-col gap-0.5">
                  {row.items.map((i) => <li key={i.id}><IntentItem intent={i} all={all} /></li>)}
                </ul>
              </li>
            );
          }
          const i = row.intent;
          const kids = all.filter((c) => c.parentIntentId === i.id);
          return (
            <li key={i.id} className="flex shrink-0 flex-col gap-0.5">
              <IntentItem intent={i} all={all} />
              {kids.length > 0 && kids.some((k) => k.status !== i.status) && (
                <ul className="ml-5 flex flex-col gap-0.5 border-l border-em-line pl-2">
                  {kids.filter((k) => k.status === 'superseded' || k.status === 'rejected').map((k) => <li key={k.id}><IntentItem intent={k} all={all} child /></li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IntentItem({ intent: i, all, child }: { intent: EditIntent; all: EditIntent[]; child?: boolean }) {
  const { state, actions, t, lang } = useStore();
  const model = state.head?.model;
  const pending = i.id.startsWith('pending-');
  const superseded = i.status === 'superseded';
  const mine = new Set([i.id, ...all.filter((c) => c.parentIntentId === i.id).map((c) => c.id)]);
  const replacedBy = all.find((x) => !x.parentIntentId && x.supersedes.some((s) => mine.has(s))) ?? all.find((x) => x.supersedes.some((s) => mine.has(s)));
  const replacedLabel = replacedBy ? (replacedBy.presetId ? getPreset(replacedBy.presetId)?.label[lang] ?? '' : intentTitle(replacedBy, t, lang)) : '';
  const title = `${child ? '' : `${intentTitle(i, t, lang)} → `}${targetText(i, model, t)}`;
  const rejectionCode = i.status === 'held' ? 'EM-2104' : i.rejectionReason?.match(/EM-\d{4}/)?.[0];
  const heldName = (flag: string) => { const m = localModelByRef(state.models, flag); return m ? localModelName(m, lang) : flag.replace(/^model:/, ''); };
  const version = i.appliedVersion !== undefined ? String(i.appliedVersion) : '';
  const viaCompile = i.status === 'executed' && (i.source === 'ui' || i.source === 'brainstorm') && !i.needsInterpretation;
  let chip: { icon: ReactNode; text: string; tone: string };
  switch (i.status) {
    case 'queued': chip = i.needsInterpretation && state.settings?.privateMode ? { icon: <Bot size={12} />, text: t('ui.agent.intent.waiting'), tone: 'text-em-private' }   // FR-160
      : i.needsInterpretation ? { icon: <Bot size={12} />, text: t('ui.agent.intent.needsagent'), tone: 'text-em-text-2' } : { icon: <Bookmark size={12} />, text: pending ? t('ui.agent.intent.sending') : t('ui.agent.intent.queued'), tone: 'text-em-muted' }; break;
    case 'compiled': chip = { icon: <Check size={12} />, text: t('ui.agent.intent.applieddirect', { version }), tone: 'text-em-accent-2' }; break;
    case 'planned': chip = { icon: <Lightbulb size={12} />, text: t('ui.agent.intent.inplan'), tone: 'text-em-accent' }; break;
    case 'executed': chip = viaCompile ? { icon: <Check size={12} />, text: t('ui.agent.intent.applieddirect', { version }), tone: 'text-em-accent-2' } : { icon: <CheckCircle2 size={12} />, text: t('ui.agent.intent.applied', { version }), tone: 'text-em-success' }; break;
    case 'rejected': chip = { icon: <OctagonAlert size={12} />, text: rejectionCode ? t(`err.${rejectionCode}.title`) : t('ui.agent.intent.rejected'), tone: 'text-em-danger' }; break;
    case 'superseded': chip = { icon: <History size={12} />, text: t('ui.agent.intent.replacedby', { label: replacedLabel || '…' }), tone: 'text-em-muted' }; break;
    // FR-037: held until the model is installed (EM-2104); it applies by itself after the Model Manager installs it.
    case 'held': chip = { icon: <DownloadCloud size={12} />, text: t('ui.agent.intent.held', { model: heldName(String(i.params['__heldFor'] ?? '')) }), tone: 'text-em-info' }; break;
    default: chip = { icon: null, text: i.status, tone: 'text-em-muted' };
  }
  if (i.undone && (i.status === 'executed' || i.status === 'compiled')) chip = { icon: <Undo2 size={12} />, text: t('ui.agent.intent.undone'), tone: 'text-em-muted' };   // FR-167
  const accessible = superseded ? `${title}. ${t('a11y.agent.intent.superseded', { label: replacedLabel || '…' })}` : `${title}. ${chip.text}`;
  const canRemove = i.status !== 'executed' && i.status !== 'removed';                       // FR-079: any non-executed item
  const focusElement = () => {
    const r = i.resolvedTargets[0];
    if (i.status === 'executed' && r && (r.kind === 'clip' || r.kind === 'cut' || r.kind === 'text')) actions.select([r]);
  };
  return (
    <div data-el={superseded ? 'agent.editor.intentqueue.item.superseded' : 'agent.editor.intentqueue.item'} data-intent-id={i.id} data-status={i.status} data-waiting={i.status === 'queued' && i.needsInterpretation && state.settings?.privateMode ? 'true' : undefined} role="listitem" aria-label={accessible}
      title={`${i.propertyKey}${viaCompile ? ` · ${t('ui.agent.intent.noai')}` : ''}`}
      className={cx('flex items-center gap-1.5 rounded-[6px] border border-em-line bg-em-panel px-2 py-1', superseded && 'opacity-60', i.status === 'rejected' && 'border-em-danger/60')}>
      <span className="text-em-muted">{i.source === 'brainstorm' ? <MessageCircle size={14} aria-hidden /> : i.source === 'chat' ? <Bot size={14} aria-hidden /> : categoryIcon(i.category, 14)}</span>
      <button type="button" onClick={focusElement} className={cx('min-w-0 flex-1 truncate text-left text-[12px]', superseded && 'line-through')}>{title}</button>
      <span className={cx('flex shrink-0 items-center gap-1 text-[11px]', chip.tone)}>{chip.icon}{chip.text}{rejectionCode && <span className="t-mono text-em-muted">{rejectionCode}</span>}</span>
      {i.restoredAt && i.status === 'queued' && <span className="flex items-center gap-0.5 text-[11px] text-em-muted"><History size={12} />{t('ui.agent.intent.restored')}</span>}
      {superseded && <Button el="agent.editor.intentqueue.item.restore" size={28} variant="ghost" onClick={() => void actions.restoreIntent(i.id)}>{t('ui.agent.intent.restore')}</Button>}
      {canRemove && !pending && <IconButton el="agent.editor.intentqueue.item.remove" label={t('ui.agent.intent.remove', { title })} icon={<X size={12} />} size={28} onClick={() => void actions.removeIntent(i.id)} />}
    </div>
  );
}
