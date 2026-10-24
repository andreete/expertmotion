// Brainstorming Chat (agent.brainstorm.*): ideas only, never mutates (IX-12); hand-off card (IX-13).
import { useState } from 'react';
import { CircleHelp, SendHorizontal } from 'lucide-react';
import { getPreset } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import type { EditIntent, MessageDto } from '../api/types.js';
import { Button } from '../components/ui.js';
import { AgentErrorBubble, Bubble, Composer, StreamingBubble, Thread } from './Chat.js';
import { categoryIcon } from '../library/presetVisual.js';

export function BrainstormChat() {
  const { state, actions, t } = useStore();
  const [value, setValue] = useState('');
  const [lastSent, setLastSent] = useState<{ text: string; att: string[] } | null>(null);
  const send = async (att: string[]) => {
    const text = value.trim();
    setLastSent({ text, att });
    setValue('');
    const ok = await actions.send('brainstorm', text, att);
    if (!ok) setValue(text);                            // composer restored on failure (IX-12 point 9)
  };
  return (
    <section data-el="agent.brainstorm.panel" aria-label={t('ui.agent.brainstorm.title')} className="flex min-h-[11rem] flex-1 flex-col border-b border-em-line">
      <div className="flex items-center gap-1 px-3 pt-2">
        <span className="t-label flex-1">{t('ui.agent.brainstorm.title')}</span>
        <span title={t('ui.agent.brainstorm.help')} aria-label={t('ui.agent.brainstorm.help')} className="text-em-muted"><CircleHelp size={14} /></span>
      </div>
      <Thread agent="brainstorm" label={t('a11y.agent.brainstorm.thread')}
        empty={state.messages.brainstorm.length === 0 ? <div className="mx-auto max-w-[90%] text-center text-[12px] text-em-muted">{t('ui.agent.brainstorm.first')}</div> : null}>
        {state.messages.brainstorm.map((m) => (
          <Bubble key={m.id} m={m} agent="brainstorm">
            {m.blocks.map((b, i) => (b.type === 'proposed_intents' ? <Handoff key={i} message={m} intents={b.intents} handoffState={b.handoffState} /> : null))}
          </Bubble>
        ))}
        <StreamingBubble agent="brainstorm" />
        <AgentErrorBubble agent="brainstorm" onRetry={() => { if (lastSent) { setValue(lastSent.text); } }} />
      </Thread>
      <Composer agent="brainstorm" placeholder={t('ui.agent.brainstorm.placeholder')} value={value} setValue={setValue} onSend={(a) => void send(a)} />
    </section>
  );
}

export function intentTitle(i: Pick<EditIntent, 'category' | 'presetId' | 'instruction' | 'params'>, t: (k: string, v?: Record<string, string | number>) => string, lang: 'en' | 'id'): string {
  const cat = t(`ui.agent.category.${i.category}`);
  if (i.presetId) return `${cat} · ${getPreset(i.presetId)?.label[lang] ?? i.presetId}`;
  if (i.instruction) return `“${i.instruction}”`;
  const p = Object.entries(i.params).filter(([k]) => k !== 'text').map(([k, v]) => `${t(`ui.agent.param.${k}`)} ${String(v)}`).join(', ');
  return p ? `${cat} · ${p}` : cat;
}

function Handoff({ message, intents, handoffState }: { message: MessageDto; intents: EditIntent[]; handoffState: 'pending' | 'sent' | 'dismissed' }) {
  const { actions, t, lang } = useStore();
  const [ticked, setTicked] = useState<string[]>(intents.map((i) => i.id));
  if (handoffState !== 'pending') {
    return (
      <div data-el="agent.brainstorm.handoff" role="group" className="flex w-full items-center gap-2 rounded-[6px] border border-em-line px-2 py-1 text-[12px] text-em-muted">
        <span className="flex-1">{handoffState === 'sent' ? t('ui.agent.brainstorm.handoff.sent', { count: intents.length }) : t('ui.agent.brainstorm.handoff.dismissed')}</span>
        {handoffState === 'dismissed' && <button type="button" className="underline" onClick={() => actions.dismissHandoff(message)}>{t('ui.agent.brainstorm.handoff.show')}</button>}
      </div>
    );
  }
  return (
    <div data-el="agent.brainstorm.handoff" role="group" aria-label={t('a11y.agent.brainstorm.handoff', { count: intents.length })} className="w-full rounded-[8px] border border-dashed border-em-accent p-2">
      <div className="mb-1 font-semibold">{t('ui.agent.brainstorm.handoff.title')}</div>
      <ul className="mb-2 flex flex-col gap-1">
        {intents.map((i) => (
          <li key={i.id}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ticked.includes(i.id)} onChange={(e) => setTicked((x) => (e.target.checked ? [...x, i.id] : x.filter((y) => y !== i.id)))} />
              <span className="text-em-muted">{categoryIcon(i.category, 14)}</span>
              <span className="truncate">{intentTitle(i, t, lang)} → {t(i.target.kind === 'project' ? 'ui.agent.target.project' : 'ui.agent.target.auto')}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="primary" size={28} icon={<SendHorizontal size={14} />} disabledReason={ticked.length ? null : t('ui.agent.brainstorm.handoff.none')} onClick={() => void actions.handoff(message, ticked)}>{t('ui.agent.brainstorm.handoff.send')}</Button>
        <Button variant="ghost" size={28} onClick={() => actions.dismissHandoff(message)}>{t('ui.agent.brainstorm.handoff.dismiss')}</Button>
      </div>
    </div>
  );
}
