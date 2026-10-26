// The assistant chat (agent.chat, Operator decision 2026-10-26): ONE thread per Project with two modes, like common AI tools.
// "Diskusi" (Brainstorming Agent: questions, ideas, scripts, hooks, captions; answers in text) and "Edit" (Editor Agent:
// changes the video through a Plan Card the Creator executes). Both conversations stay stored per agent (R-080…R-085); the
// thread shows them merged in time order, each message tagged with its agent. The Service shares context between them
// (AI_WORKFLOW §10.1). Mode: Ctrl+1 / Ctrl+2, Tab in an empty composer, or the composer switch; remembered per Project.
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useStore } from '../state/store.js';
import { visibleQueue } from '../state/reducer.js';
import { chatModeFor, chatModePatch } from '../prefs.js';
import type { AgentKind, EditIntent, MessageDto, PlanDto } from '../api/types.js';
import { AgentErrorBubble, Bubble, ChatHeader, Composer, ModeTag, StreamingBubble, Thread, messageText, type ChatLayoutProps } from './Chat.js';
import { IntentQueue, targetText } from './IntentQueue.js';
import { PlanCard, PlanSummary } from './PlanCard.js';
import { ProposalCard, intentTitle } from './proposals.js';

/** FR-085: picks that compiled and applied without any model (Compile path), shown as a compact system line. */
export function appliedDirectly(items: readonly EditIntent[]): EditIntent[] {
  return items.filter((i) => !i.parentIntentId && (i.status === 'executed' || i.status === 'compiled') && !i.needsInterpretation && (i.source === 'ui' || i.source === 'brainstorm' || i.params['__output'] !== undefined));
}
const planIdOf = (m: MessageDto): string | null => {
  for (const b of m.blocks) if (b.type === 'tool_result' && b.name === 'plan' && b.output && typeof (b.output as { planId?: unknown }).planId === 'string') return (b.output as { planId: string }).planId;
  return null;
};
/** An Editor plan that is only a question (no steps, `needs-input` risks): its questions, shown as a normal assistant message. */
export function editorQuestions(plan: PlanDto | undefined | null): string | null {
  if (!plan || plan.steps.length) return null;
  const q = plan.risks.filter((r) => r.code === 'needs-input').map((r) => r.message.trim()).filter(Boolean);
  return q.length ? q.join('\n') : null;
}
/** The longest Diskusi answer "Apply to video" sends to the Editor Agent (SendBody allows 8 000 characters). */
export const APPLY_MAX_CHARS = 4000;
/** The Editor request "Apply to video" sends for a Diskusi answer without proposed changes. */
export function applyRequest(answer: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const a = answer.trim();
  return t('ui.agent.chat.apply.request', { text: a.length > APPLY_MAX_CHARS ? `${a.slice(0, APPLY_MAX_CHARS - 1)}…` : a });
}

export function AssistantChat({ layout }: { layout: ChatLayoutProps }) {
  const { state, actions, dispatch, t, lang, runtime, prefs, setPrefs } = useStore();
  const projectId = state.project?.id;
  const mode: AgentKind = chatModeFor(prefs, projectId);
  const setMode = useCallback((m: AgentKind) => {
    if (m === chatModeFor(prefs, projectId)) return;
    setPrefs(chatModePatch(prefs, projectId, m));
    actions.announce(t('ui.agent.chat.mode.changed', { mode: t(`ui.agent.mode.${m}`) }));
  }, [prefs, projectId, setPrefs, actions, t]);
  const [value, setValue] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, PlanDto>>({});
  const [lastSent, setLastSent] = useState<{ text: string; att: string[] } | null>(null);
  const draft = state.editorDraft;
  useEffect(() => {                                                  // FR-086: plans referenced by a restored thread
    if (!projectId) return;
    let live = true;
    runtime.api.listPlans(projectId, { limit: 50 }).then((p) => { if (live) setPlans(Object.fromEntries(p.items.map((x) => [x.id, x]))); }).catch(() => undefined);
    return () => { live = false; };
  }, [projectId, runtime, state.messages.editor.length]);
  useEffect(() => {                                                  // FR-067: "Ask the Editor" from the inspector → Edit mode
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
  // FR-067 / FR-072: the inspector's typed target and the attachments travel with the next Edit message.
  const send = async (attachments: string[]) => {
    const text = value.trim();
    const agent = mode;
    setValue('');
    if (agent === 'brainstorm') setLastSent({ text, att: attachments });
    const ok = await actions.send(agent, text, attachments, agent === 'editor' && chip ? draft?.target ?? null : null);
    if (!ok) setValue(text);                                         // composer restored on failure (IX-12 point 9)
    else if (agent === 'editor') { setChip(null); dispatch({ type: 'editorDraft', draft: null }); }
  };
  /** "Apply to video" on a Diskusi answer without pending proposals: the answer becomes the Edit request. */
  const applyToVideo = async (m: MessageDto) => {
    const request = applyRequest(messageText(m), t);
    setMode('editor');
    const ok = await actions.send('editor', request);
    if (!ok) setValue(request);
  };
  const plan = state.plan;
  // FR-085/FR-086: one thread in creation order: both agents' messages, the plan each Edit reply produced (inline), and
  // "Applied directly" lines.
  const thread = useMemo(() => {
    const known: Record<string, PlanDto> = { ...plans };
    for (const p of state.previousPlans) known[p.id] = { ...known[p.id], ...p };
    const rows: Array<{ at: string; key: string; node: ReactNode }> = [];
    let current = false;
    state.messages.brainstorm.forEach((m, idx) => {
      const pending = m.blocks.some((b) => b.type === 'proposed_intents' && b.handoffState === 'pending');
      const canApply = m.role === 'assistant' && !pending && Boolean(messageText(m).trim());
      rows.push({ at: m.createdAt, key: `b-${m.id}`, node: (
        <Bubble key={`b-${m.id}`} m={m} agent="brainstorm" onApply={canApply ? () => void applyToVideo(m) : undefined} onRetry={m.role === 'system' ? () => {
          // FR-077: a restored failure re-sends the request it answered
          const prev = state.messages.brainstorm.slice(0, idx).reverse().find((x) => x.role === 'user');
          const text = prev?.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') ?? '';
          if (text) void actions.send('brainstorm', text, prev?.blocks.flatMap((b) => (b.type === 'attachment' && b.assetId ? [b.assetId] : [])) ?? []);
        } : undefined}>
          {m.blocks.map((b, i) => (b.type === 'proposed_intents' ? <ProposalCard key={i} message={m} intents={b.intents} handoffState={b.handoffState} onApplied={() => setMode('editor')} /> : null))}
        </Bubble>
      ) });
    });
    for (const m of state.messages.editor) {
      const pid = planIdOf(m);
      const isCurrent = pid !== null && plan?.id === pid;
      current ||= isCurrent;
      const p = isCurrent ? plan : pid ? known[pid] : undefined;
      const questions = m.role === 'assistant' ? editorQuestions(p) : null;
      rows.push({ at: m.createdAt, key: `e-${m.id}`, node: (
        <Bubble key={`e-${m.id}`} m={m} agent="editor" onRetry={() => void actions.plan()} text={questions ?? undefined} hideText={m.role === 'assistant' && Boolean(p) && !questions}>
          {questions ? null : isCurrent && plan ? <PlanCard plan={plan} /> : p ? <PlanSummary plan={p} /> : null}
        </Bubble>
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
  }, [state.messages, state.queue, state.pending, state.previousPlans, state.head?.model, plan, plans, t, lang, setMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = state.messages.brainstorm.length + state.messages.editor.length === 0 && !plan
    ? <div className="mx-auto max-w-[90%] text-center text-[12px] text-em-muted">{t(mode === 'brainstorm' ? 'ui.agent.brainstorm.first' : 'ui.agent.editor.first')}</div> : null;
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === '1' || e.key === '2')) { e.preventDefault(); e.stopPropagation(); setMode(e.key === '1' ? 'brainstorm' : 'editor'); return; }
    if (e.key === 'Escape' && (state.streaming.editor || plan?.status === 'draft')) { e.stopPropagation(); void actions.cancelPlan(); }
    else if (e.key === 'Escape' && state.streaming.brainstorm) { e.stopPropagation(); void runtime.api.cancelAgentRun(state.streaming.brainstorm.runId).catch(() => undefined); actions.stopStreaming('brainstorm'); }
  };
  return (
    <section data-el="agent.chat" data-mode={mode} data-maximized={layout.maximized ? 'true' : undefined} aria-label={t('ui.agent.chat.title')} className="flex min-h-0 flex-1 flex-col overflow-hidden" onKeyDown={onKeyDown}>
      <ChatHeader mode={mode} setMode={setMode} layout={layout} />
      <Thread label={t('a11y.agent.chat.thread')} empty={empty}>
        {thread.rows.map((r) => r.node)}
        <StreamingBubble agent="brainstorm" />
        <StreamingBubble agent="editor" />
        <AgentErrorBubble agent="brainstorm" onRetry={() => { if (lastSent) { setMode('brainstorm'); setValue(lastSent.text); } }} />
        <AgentErrorBubble agent="editor" onRetry={() => void actions.plan()} />
        {plan && !thread.current && <div className="flex flex-col items-start gap-1"><ModeTag agent="editor" /><PlanCard plan={plan} /></div>}
      </Thread>
      <IntentQueue hidden={mode !== 'editor'} />
      <Composer mode={mode} setMode={setMode} placeholder={t(mode === 'brainstorm' ? 'ui.agent.brainstorm.placeholder' : 'ui.agent.editor.placeholder')} chip={chip}
        onClearChip={() => { setChip(null); setValue(''); dispatch({ type: 'editorDraft', draft: null }); }} value={value} setValue={setValue} onSend={(att) => void send(att)} />
    </section>
  );
}
