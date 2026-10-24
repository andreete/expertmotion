// Editor Chat (agent.editor.*): Intent Queue, thread, Plan Card + Execute, composer with target chip (IX-10, IX-14…IX-17).
import { useEffect, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { useStore } from '../state/store.js';
import { Button } from '../components/ui.js';
import { AgentErrorBubble, Bubble, Composer, StreamingBubble, Thread } from './Chat.js';
import { IntentQueue } from './IntentQueue.js';
import { PlanCard, executeDisabledReason } from './PlanCard.js';

export function EditorChat() {
  const { state, actions, dispatch, t } = useStore();
  const [value, setValue] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const [showPrev, setShowPrev] = useState(false);
  const draft = state.editorDraft;
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
  const send = async () => {
    const text = value.trim();
    setValue('');
    const ok = await actions.send('editor', text);
    if (!ok) setValue(text); else { setChip(null); dispatch({ type: 'editorDraft', draft: null }); }
  };
  const plan = state.plan;
  return (
    <section data-el="agent.editor.panel" aria-label={t('ui.agent.editor.title')} className="flex min-h-0 flex-[1.5] flex-col"
      onKeyDown={(e) => { if (e.key === 'Escape' && (state.streaming.editor || plan?.status === 'draft')) { e.stopPropagation(); void actions.cancelPlan(); } }}>
      <div className="flex items-center gap-1 px-3 pt-2">
        <span className="t-label flex-1">{t('ui.agent.editor.title')}</span>
        <span title={t('ui.agent.editor.help')} aria-label={t('ui.agent.editor.help')} className="text-em-muted"><CircleHelp size={14} /></span>
      </div>
      <IntentQueue />
      <Thread agent="editor" label={t('a11y.agent.editor.thread')}>
        {state.messages.editor.map((m) => <Bubble key={m.id} m={m} agent="editor" />)}
        <StreamingBubble agent="editor" />
        <AgentErrorBubble agent="editor" onRetry={() => void actions.plan()} />
        {state.previousPlans.length > 0 && (
          <div className="text-[12px] text-em-muted">
            <button type="button" className="underline" onClick={() => setShowPrev((s) => !s)}>{t('ui.agent.plan.previous', { count: state.previousPlans.length })}</button>
            {showPrev && <ul className="mt-1 flex flex-col gap-0.5">{state.previousPlans.map((p) => <li key={p.id} className="truncate">· {p.goal} — {t(`ui.agent.plan.status.${p.status}`)}</li>)}</ul>}
          </div>
        )}
        {plan && <PlanCard plan={plan} />}
      </Thread>
      <Composer agent="editor" placeholder={t('ui.agent.editor.placeholder')} chip={chip} onClearChip={() => { setChip(null); setValue(''); dispatch({ type: 'editorDraft', draft: null }); }}
        value={value} setValue={setValue} onSend={() => void send()}
        extra={!plan || plan.status === 'executed' || plan.status === 'cancelled' || plan.status === 'stale' ? (
          <Button el="agent.editor.execute" variant="primary" size={28} disabledReason={executeDisabledReason(plan, state.head?.hash, t)} aria-label={t('a11y.agent.editor.execute')}>{t('ui.agent.editor.execute')}</Button>
        ) : null} />
    </section>
  );
}
