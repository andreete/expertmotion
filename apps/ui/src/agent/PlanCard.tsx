// Plan Card (agent.editor.plancard, CMP-14, UI_UX_SPECIFICATION.md §11.2): read-only Edit Plan with notes, stale state +
// Re-plan, Execute (Ctrl+Enter), Cancel while running, Discard. States: draft/valid/invalid/stale/executing/executed/failed/cancelled.
import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, History, Lightbulb, Loader, OctagonAlert, TriangleAlert, Info, XCircle } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { PlanDto } from '../api/types.js';
import { Button, cx } from '../components/ui.js';
import { formatMoney, formatTokens } from '../i18n/index.js';

export function executeDisabledReason(plan: PlanDto | null, headHash: string | undefined, t: (k: string) => string): string | null {
  if (!plan || plan.status === 'draft' || plan.status === 'cancelled' || plan.status === 'executed') return t('ui.agent.editor.execute.noplan');
  if (plan.status === 'stale' || (headHash && plan.baseVersion !== headHash)) return t('ui.agent.editor.execute.stale');
  if (plan.status === 'invalid' || plan.status === 'failed' || plan.risks.some((r) => r.severity === 'block')) return t('ui.agent.editor.execute.blocked');
  if (plan.status !== 'valid') return t('ui.agent.editor.execute.noplan');
  return null;
}

export function PlanCard({ plan }: { plan: PlanDto }) {
  const { state, actions, t, lang } = useStore();
  const [notes, setNotes] = useState(plan.notes ?? '');
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setNotes(plan.notes ?? ''); }, [plan.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (plan.status !== 'executed') { setCollapsed(false); return; } const h = setTimeout(() => setCollapsed(true), 10_000); return () => clearTimeout(h); }, [plan.status]);
  const headHash = state.head?.hash;
  const stale = plan.status === 'stale' || (plan.status === 'valid' && headHash !== undefined && plan.baseVersion !== headHash);
  const status = stale ? 'stale' : plan.status;
  const reason = executeDisabledReason(plan, headHash, t);
  const base = plan.baseVersion.slice(0, 6);
  const header: Record<string, { icon: ReactNode; text: string; tone: string; border: string }> = {
    draft: { icon: <Loader size={14} className="em-spin" />, text: t('ui.agent.plan.state.draft'), tone: 'text-em-muted', border: 'border-dashed border-em-line-strong' },
    valid: { icon: <Lightbulb size={14} />, text: t('ui.agent.plan.state.valid'), tone: 'text-em-accent', border: 'border-dashed border-em-accent' },
    invalid: { icon: <OctagonAlert size={14} />, text: t('ui.agent.plan.state.invalid'), tone: 'text-em-danger', border: 'border-dashed border-em-danger' },
    stale: { icon: <History size={14} />, text: t('ui.agent.plan.state.stale'), tone: 'text-em-warn', border: 'border-dashed border-em-warn' },
    executing: { icon: <Loader size={14} className="em-spin" />, text: t('ui.agent.plan.state.executing', { step: 1, total: Math.max(1, plan.steps.length) }), tone: 'text-em-accent', border: 'border-solid border-em-accent' },
    executed: { icon: <CheckCircle2 size={14} />, text: t('ui.agent.plan.state.executed', { version: headHash?.slice(0, 6) ?? '' }), tone: 'text-em-success', border: 'border-solid border-em-success' },
    failed: { icon: <XCircle size={14} />, text: t('ui.agent.plan.state.failed', { code: plan.errorCode ?? 'EM-2307' }), tone: 'text-em-danger', border: 'border-solid border-em-danger' },
    cancelled: { icon: <XCircle size={14} />, text: plan.errorCode === 'EM-4304' ? t('ui.agent.plan.state.interrupted') : t('ui.agent.plan.state.cancelled'), tone: 'text-em-muted', border: 'border-solid border-em-line' },
  };
  const h = header[status] ?? header['draft']!;
  if (collapsed) {
    return <div data-el="agent.editor.plancard" className="flex items-center gap-2 rounded-[8px] border border-em-success px-2 py-1 text-[12px] text-em-success"><CheckCircle2 size={14} />{plan.goal}<span className="flex-1" /><button type="button" className="underline" onClick={() => setCollapsed(false)}>{t('ui.common.details')}</button></div>;
  }
  return (
    <section data-el="agent.editor.plancard" data-status={status} role="region" aria-label={t('a11y.agent.editor.plancard', { goal: plan.goal, status: h.text, version: base })}
      className={cx('flex flex-col gap-2 rounded-[8px] border bg-em-panel p-2.5', h.border)}>
      <div className="flex items-center gap-1.5 text-[12px]">
        <span className={cx('flex items-center gap-1 font-semibold', h.tone)}>{h.icon}{h.text}</span>
        <span className="text-em-muted">· {plan.origin === 'compile' ? t('ui.agent.plan.origin.compile') : t('ui.agent.plan.origin.agent')} ·</span>
        <span data-el={stale ? 'agent.editor.plancard.baseversion.stale' : 'agent.editor.plancard.baseversion'} className={cx('t-mono', stale ? 'text-em-warn' : 'text-em-muted')} title={t('ui.agent.plan.basedon', { version: base })}>{t('ui.agent.plan.basedon', { version: base })}</span>
        <span className="flex-1" />
        <button type="button" aria-label={t('ui.agent.plan.history')} title={t('ui.agent.plan.history')} onClick={() => actions.setScreen({ kind: 'history' })} className="text-em-muted hover:text-em-text"><History size={14} /></button>
      </div>
      <div data-el="agent.editor.plancard.goal" className="text-[16px] font-semibold leading-[22px]">{plan.goal || t('ui.agent.plan.goal.pending')}</div>
      {plan.steps.length > 0 && (
        <ol className="flex flex-col gap-1 border-t border-em-line pt-2">
          {plan.steps.map((s) => (
            <li key={s.n} data-el="agent.editor.plancard.step" className={cx('flex items-start gap-1.5 text-[12px]', s.dependsOn.length > 0 && 'ml-4')}>
              <span className="t-mono text-em-muted">{s.n}</span>
              <span data-el="agent.editor.plancard.step.tool" className="t-mono shrink-0 rounded-[4px] border border-em-line px-1 text-[10px] text-em-muted">{s.tool}</span>
              <span data-el="agent.editor.plancard.step.diff" className="flex-1">{s.expectedDiff}</span>
            </li>
          ))}
        </ol>
      )}
      {(plan.risks.length > 0 || plan.validation.length > 0 || plan.touchesLockedKeys.length > 0) && (
        <ul className="flex flex-col gap-1 border-t border-em-line pt-2" aria-label={t('ui.agent.plan.risks')}>
          {plan.risks.map((r, i) => (
            <li key={`r${i}`} data-el="agent.editor.plancard.risk" className="flex items-start gap-1.5 text-[12px]">
              <span className={r.severity === 'block' ? 'text-em-danger' : r.severity === 'warn' ? 'text-em-warn' : 'text-em-info'}>{r.severity === 'block' ? <OctagonAlert size={14} /> : r.severity === 'warn' ? <TriangleAlert size={14} /> : <Info size={14} />}</span>
              <span className="flex-1">{r.message} <span className="text-em-muted">· {t(`ui.agent.plan.severity.${r.severity}`)}</span></span>
            </li>
          ))}
          {plan.validation.map((v, i) => <li key={`v${i}`} data-el="agent.editor.plancard.risk" className="flex gap-1.5 text-[12px] text-em-danger"><OctagonAlert size={14} />{v.message}<span className="t-mono text-em-muted">{v.code}</span></li>)}
          {plan.touchesLockedKeys.map((k) => <li key={k} data-el="agent.editor.plancard.risk" className="flex gap-1.5 text-[12px] text-em-warn"><OctagonAlert size={14} />{t('ui.agent.plan.locked', { key: k })}</li>)}
        </ul>
      )}
      <textarea data-el="agent.editor.plancard.notes" value={notes} maxLength={1000} rows={2} placeholder={t('ui.agent.plan.notes.placeholder')} aria-label={t('ui.agent.plan.notes.placeholder')}
        onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== (plan.notes ?? '')) void actions.setNotes(notes); }}
        className="resize-none rounded-[6px] border border-em-line bg-em-panel-2 px-2 py-1 text-[12px] outline-none placeholder:text-em-muted" />
      {plan.usage && (
        <div className="t-mono text-[11px] text-em-muted" title={plan.usage.approximate ? t('ui.agent.common.cost.approx') : plan.usage.costUsd === null ? t('ui.agent.common.cost.na') : undefined}>
          {t('ui.agent.plan.usage', { input: formatTokens(plan.usage.inputTokens, lang), output: formatTokens(plan.usage.outputTokens, lang), cost: formatMoney(plan.usage.costUsd, plan.usage.approximate, lang) })}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-em-line pt-2">
        {status !== 'executed' && status !== 'executing' && <Button size={28} variant="ghost" onClick={() => void actions.cancelPlan()}>{t('ui.agent.plan.discard')}</Button>}
        <span className="flex-1" />
        {(status === 'stale' || status === 'invalid' || status === 'failed' || status === 'cancelled') && (
          <Button el="agent.editor.plancard.replan" size={32} variant={status === 'stale' ? 'primary' : 'secondary'} onClick={() => void actions.plan()}>{status === 'cancelled' ? t('ui.agent.plan.rerun') : t('ui.agent.plan.replan')}</Button>
        )}
        {status === 'executed' && <Button size={32} onClick={() => void actions.undo()}>{t('ui.sys.toast.undo')}</Button>}
        {status !== 'executed' && status !== 'stale' && status !== 'cancelled' && (
          <Button el="agent.editor.execute" variant="primary" size={36} disabledReason={reason} loading={status === 'executing'} title={t('ui.agent.editor.execute.tooltip')}
            aria-label={t('a11y.agent.editor.execute')} onClick={() => void actions.execute()}>{t('ui.agent.editor.execute')} <span className="t-mono text-[10px] opacity-70">⌃↵</span></Button>
        )}
      </div>
    </section>
  );
}
