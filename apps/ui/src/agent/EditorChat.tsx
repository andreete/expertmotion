// Editor Chat (agent.editor.*): Intent Queue, thread, Plan Card + Execute, composer with target chip (IX-10, IX-14…IX-17).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useStore } from '../state/store.js';
import { visibleQueue } from '../state/reducer.js';
import type { EditIntent, MessageDto, PlanDto } from '../api/types.js';
import { Button, cx } from '../components/ui.js';
import { AgentErrorBubble, Bubble, ChatHeader, Composer, StreamingBubble, Thread, chatSectionCls, type ChatLayoutProps } from './Chat.js';
import { IntentQueue, targetText } from './IntentQueue.js';
import { PlanCard, PlanSummary, executeDisabledReason } from './PlanCard.js';
import { intentTitle } from './BrainstormChat.js';

/** FR-085: picks that compiled and applied without any model (Compile path), shown as a compact system line. */
export function appliedDirectly(items: readonly EditIntent[]): EditIntent[] {
  return items.filter((i) => !i.parentIntentId && (i.status === 'executed' || i.status === 'compiled') && !i.needsInterpretation && (i.source === 'ui' || i.source === 'brainstorm' || i.params['__output'] !== undefined));
}
const planIdOf = (m: MessageDto): string | null => {
  for (const b of m.blocks) if (b.type === 'tool_result' && b.name === 'plan' && b.output && typeof (b.output as { planId?: unknown }).planId === 'string') return (b.output as { planId: string }).planId;
  return null;
};

export function EditorChat(layout: ChatLayoutProps) {
  const { state, actions, dispatch, t, lang, runtime } = useStore();
  const [value, setValue] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, PlanDto>>({});
  const draft = state.editorDraft;
  const projectId = state.project?.id;
  useEffect(() => {                                                  // FR-086: plans referenced by a restored thread
    if (!projectId) return;
    let live = true;
    runtime.api.listPlans(projectId, { limit: 50 }).then((p) => { if (live) setPlans(Object.fromEntries(p.items.map((x) => [x.id, x]))); }).catch(() => undefined);
    return () => { live = false; };
  }, [projectId, runtime, state.messages.editor.length]);
  useEffect(() => {
    if (!draft) return;
    setValue(draft.text);
    setChip(draft.target ? draft.text.replace(/:\s*$/, '') : null);
    window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: { agent: 'editor' } }));
  }, [draft?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ask = (e: Event) => { const text = (e as CustomEvent<{ text: string }>).detail?.text ?? ''; dispatch({ type: 'editorDraft', draft: { text, target: null, nonce: Date.now() } }); };
    window.addEventListener('em:ask-editor', ask);
    return () => window.removeEventListener('em:ask-editor', ask);
  }, [dispatch]);
  // FR-067 / FR-072: the inspector's typed target and the attachments travel with the next message.
  const send = async (attachments: string[]) => {
    const text = value.trim();
    setValue('');
    const ok = await actions.send('editor', text, attachments, chip ? draft?.target ?? null : null);
    if (!ok) setValue(text); else { setChip(null); dispatch({ type: 'editorDraft', draft: null }); }
  };
  const plan = state.plan;
  // FR-085/FR-086: one thread in creation order: messages, the plan each produced (inline), and "Applied directly" lines.
  const thread = useMemo(() => {
    const known: Record<string, PlanDto> = { ...plans };
    for (const p of state.previousPlans) known[p.id] = { ...known[p.id], ...p };
    const rows: Array<{ at: string; key: string; node: ReactNode }> = [];
    let current = false;
    for (const m of state.messages.editor) {
      const pid = planIdOf(m);
      const isCurrent = pid !== null && plan?.id === pid;
      current ||= isCurrent;
      rows.push({ at: m.createdAt, key: m.id, node: (
        <div key={m.id} className="flex flex-col gap-1">
          <Bubble m={m} agent="editor" onRetry={() => void actions.plan()} />
          {isCurrent && plan ? <PlanCard plan={plan} /> : pid && known[pid] ? <PlanSummary plan={known[pid]!} /> : null}
        </div>
      ) });
    }
    for (const i of appliedDirectly(visibleQueue(state))) {
      const v = i.appliedHash ? ` · ${i.appliedHash.slice(0, 6)}` : i.appliedVersion !== undefined ? ` · v${i.appliedVersion}` : '';   // FR-085: short version hash
      rows.push({ at: i.createdAt, key: `applied-${i.id}`, node: (
        <div key={`applied-${i.id}`} data-el="agent.editor.message.applied" data-role="system" className="mx-auto flex max-w-[95%] items-center gap-1 text-center text-[11px] text-em-muted">
          <Check size={12} className="text-em-accent-2" aria-hidden />{t('ui.agent.editor.applieddirect', { label: `${intentTitle(i, t, lang)} → ${targetText(i, state.head?.model, t)}` })}{v}
        </div>
      ) });
    }
    rows.sort((a, b) => a.at.localeCompare(b.at));
    return { rows, current };
  }, [state.messages.editor, state.queue, state.pending, state.previousPlans, state.head?.model, plan, plans, t, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section data-el="agent.editor.panel" data-view={layout.view} aria-label={t('ui.agent.editor.title')} className={chatSectionCls('editor', layout.view)} style={layout.style}
      onKeyDown={(e) => { if (e.key === 'Escape' && (state.streaming.editor || plan?.status === 'draft')) { e.stopPropagation(); void actions.cancelPlan(); } }}>
      <ChatHeader agent="editor" title={t('ui.agent.editor.title')} help={t('ui.agent.editor.help')} layout={layout} />
      <div className={cx('flex min-h-0 flex-1 flex-col', layout.view === 'min' && 'hidden')}>
      <IntentQueue />
      <Thread agent="editor" label={t('a11y.agent.editor.thread')}>
        {thread.rows.map((r) => r.node)}
        <StreamingBubble agent="editor" />
        <AgentErrorBubble agent="editor" onRetry={() => void actions.plan()} />
        {plan && !thread.current && <PlanCard plan={plan} />}
      </Thread>
      <Composer agent="editor" placeholder={t('ui.agent.editor.placeholder')} chip={chip} onClearChip={() => { setChip(null); setValue(''); dispatch({ type: 'editorDraft', draft: null }); }}
        value={value} setValue={setValue} onSend={(att) => void send(att)}
        extra={!plan || plan.status === 'executed' || plan.status === 'cancelled' || plan.status === 'stale' ? (
          <Button el="agent.editor.execute" variant="primary" size={28} disabledReason={executeDisabledReason(plan, state.head?.hash, t, { hasClip: (state.head?.model?.tracks.video.length ?? 1) > 0, running: Boolean(state.streaming.editor) })} aria-label={t('a11y.agent.editor.execute')}>{t('ui.agent.editor.execute')}</Button>
        ) : null} />
      </div>
    </section>
  );
}
