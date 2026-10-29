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
import type { AgentKind, ChatTarget, EditIntent, MessageDto, PlanDto } from '../api/types.js';
import type { ElementRefT } from '@expertmotion/composition-model';
import { elementTarget, mergeTargets, selectionTargets, targetKey } from './targets.js';
import { refExists } from '../stage/items.js';
import { AgentErrorBubble, Bubble, ChatHeader, ChatTabs, Composer, ModeTag, StreamingBubble, Thread, messageText, type ChatLayoutProps } from './Chat.js';
import { HandoffCard } from './Handoff.js';
import { HelpCircle, Lightbulb } from 'lucide-react';
import { IntentQueue, targetText } from './IntentQueue.js';
import { PlanCard, PlanSummary } from './PlanCard.js';
import { ProposalCard, intentTitle } from './proposals.js';
import { SectionBoundary } from '../startup/ErrorBoundary.js';

/** FR-085: picks that compiled and applied without any model (Compile path), shown as a compact system line. */
export function appliedDirectly(items: readonly EditIntent[]): EditIntent[] {
  return items.filter((i) => !i.parentIntentId && (i.status === 'executed' || i.status === 'compiled') && !i.needsInterpretation && (i.source === 'ui' || i.source === 'brainstorm' || i.params?.['__output'] !== undefined));
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
  const [draftTarget, setDraftTarget] = useState<ElementRefT | null>(null);
  const [plans, setPlans] = useState<Record<string, PlanDto>>({});
  const [lastSent, setLastSent] = useState<{ agent: AgentKind; text: string; att: string[]; targets: ChatTarget[]; target: ElementRefT | null } | null>(null);
  // QA 2026-10-26 #6: chips = explicit "Ask assistant" picks + the current Timeline selection (minus the ones removed or sent).
  const selKey = JSON.stringify(state.selection);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  useEffect(() => { setDismissed(new Set()); }, [selKey]);
  const selChips = useMemo(() => selectionTargets(state.selection, state.head?.model, state.assets, t), [selKey, state.head?.model, state.assets, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const targets = useMemo(() => mergeTargets(state.chatTargets, selChips, dismissed), [state.chatTargets, selChips, dismissed]);
  const removeTarget = (x: ChatTarget) => {
    const k = targetKey(x);
    if (state.chatTargets.some((y) => targetKey(y) === k)) actions.setChatTargets(state.chatTargets.filter((y) => targetKey(y) !== k));
    setDismissed((d) => new Set([...d, k]));
    if (draftTarget && targetKey({ kind: draftTarget.kind as ChatTarget['kind'], ...(draftTarget.id !== undefined ? { id: draftTarget.id } : {}), ...(draftTarget.index !== undefined ? { index: draftTarget.index } : {}) }) === k) { setDraftTarget(null); dispatch({ type: 'editorDraft', draft: null }); }
  };
  // ADR-031 / FR-192: a chip whose Timeline element is gone (deleted by the Creator, an Undo, a plan) leaves the composer.
  useEffect(() => {
    const model = state.head?.model; if (!model) return;
    const kept = state.chatTargets.filter((x) => x.kind === 'asset' || (x.kind === 'caption' ? (x.index ?? -1) < model.tracks.caption.pages.length : refExists(model, x)));
    if (kept.length !== state.chatTargets.length) actions.setChatTargets(kept);
  }, [state.head?.model]); // eslint-disable-line react-hooks/exhaustive-deps
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
    setDraftTarget(draft.target);
    const chipOf = draft.target ? elementTarget(draft.target, state.head?.model, state.assets, t) : null;
    if (chipOf) actions.pointAt(chipOf);
    window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: { agent: 'editor' } }));
  }, [draft?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ask = (e: Event) => { const text = (e as CustomEvent<{ text: string }>).detail?.text ?? ''; dispatch({ type: 'editorDraft', draft: { text, target: null, nonce: Date.now() } }); };
    window.addEventListener('em:ask-editor', ask);
    return () => window.removeEventListener('em:ask-editor', ask);
  }, [dispatch]);
  // FR-067 / FR-072: the inspector's typed target and the attachments travel with the next Edit message.
  const send = async (attachments: string[], documents: string[] = []) => {
    const text = value.trim();
    const agent = mode;
    setValue('');
    const target = agent === 'editor' ? draftTarget : null;
    const sentTargets = targets;
    setLastSent({ agent, text, att: attachments, targets: sentTargets, target });
    const ok = await actions.send(agent, text, attachments, target, sentTargets, documents);
    if (!ok) setValue(text);                                         // composer restored on failure (IX-12 point 9)
    else {
      actions.setChatTargets([]); setDismissed(new Set(sentTargets.map(targetKey)));   // chips are used up by the message
      if (agent === 'editor') { setDraftTarget(null); dispatch({ type: 'editorDraft', draft: null }); }
    }
  };
  /** Live failure "Coba lagi": the same request again (text, attachments, targets). */
  const retry = (agent: AgentKind) => {
    if (lastSent && lastSent.agent === agent) { void actions.send(agent, lastSent.text, lastSent.att, lastSent.target, lastSent.targets); return; }
    if (agent === 'editor') void actions.plan();
  };
  const rephrase = (agent: AgentKind) => {
    setMode(agent);
    if (lastSent && lastSent.agent === agent) { setValue(lastSent.text); if (lastSent.targets.length) actions.setChatTargets(lastSent.targets); }
    window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: { agent } }));
  };
  /** "Apply to video" on a Diskusi answer without pending proposals: the answer becomes the Edit request. */
  const applyToVideo = async (m: MessageDto) => {
    // FR-219: the whole draft (answer + proposed changes) goes to the Editor as one request; the Editor tab opens with its progress.
    setMode('editor');
    await actions.sendDraftToEditor(m);
  };
  /** FR-219: the Editor asks Diskusi for missing creative information (its question goes to the Brainstorming Agent). */
  const askDiscussion = (question: string) => {
    setMode('brainstorm');
    void actions.send('brainstorm', t('ui.agent.handoff.askdiscussion.request', { question }));
  };
  const plan = state.plan;
  // FR-220 (QA 2026-10-28 #12): the caption page under the playhead can be pointed at like any element ("@Caption 0:17 …").
  const pages = state.head?.model?.tracks.caption.pages ?? [];
  const capIdx = pages.findIndex((p) => state.playheadMs >= p.startMs && state.playheadMs < p.startMs + p.durationMs);
  const capAt = capIdx >= 0 ? { i: capIdx, page: pages[capIdx]! } : null;
  const capChip = (c: NonNullable<typeof capAt>): ChatTarget => {
    const s0 = Math.floor(c.page.startMs / 1000);
    const words = c.page.text.replace(/\s+/g, ' ').trim();
    return { kind: 'caption', index: c.i, startMs: c.page.startMs, endMs: c.page.startMs + c.page.durationMs, label: `${t('ui.agent.chat.target.caption', { time: `${Math.floor(s0 / 60)}:${String(s0 % 60).padStart(2, '0')}` })} “${words.length > 32 ? `${words.slice(0, 31)}…` : words}”` };
  };
  // FR-085/FR-086: one thread in creation order: both agents' messages, the plan each Edit reply produced (inline), and
  // "Applied directly" lines.
  const thread = useMemo(() => {
    const known: Record<string, PlanDto> = { ...plans };
    for (const p of state.previousPlans) known[p.id] = { ...known[p.id], ...p };
    const rows: Array<{ at: string; key: string; node: ReactNode }> = [];
    let current = false;
    // ADR-033: each tab shows only its own chat.
    (mode === 'brainstorm' ? state.messages.brainstorm : []).forEach((m, idx) => {
      // An answer stored by an older build that held only tool-call markup has nothing to show once the markup is removed.
      if (m.role === 'assistant' && !messageText(m).trim() && !m.blocks.some((b) => b.type === 'proposed_intents')) return;
      const handed = m.blocks.find((b): b is Extract<typeof b, { type: 'handoff' }> => b.type === 'handoff');
      const canApply = m.role === 'assistant' && !handed && Boolean(messageText(m).trim());
      rows.push({ at: m.createdAt, key: `b-${m.id}`, node: (
        <Bubble key={`b-${m.id}`} m={m} agent="brainstorm" onApply={canApply ? () => void applyToVideo(m) : undefined} onRetry={m.role === 'system' ? () => {
          // FR-077: a restored failure re-sends the request it answered
          const prev = state.messages.brainstorm.slice(0, idx).reverse().find((x) => x.role === 'user');
          const text = prev?.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') ?? '';
          if (text) void actions.send('brainstorm', text, prev?.blocks.flatMap((b) => (b.type === 'attachment' && b.assetId ? [b.assetId] : [])) ?? []);
        } : undefined}>
          {m.blocks.map((b, i) => (b.type === 'proposed_intents' && !handed ? <ProposalCard key={i} message={m} intents={b.intents} handoffState={b.handoffState} onApplied={() => setMode('editor')} onSendDraft={() => void applyToVideo(m)} /> : null))}
          {handed && <HandoffCard block={handed} onOpenEditor={() => setMode('editor')} />}
        </Bubble>
      ) });
    });
    for (const m of mode === 'editor' ? state.messages.editor : []) {
      const pid = planIdOf(m);
      const isCurrent = pid !== null && plan?.id === pid;
      current ||= isCurrent;
      const p = isCurrent ? plan : pid ? known[pid] : undefined;
      const questions = m.role === 'assistant' ? editorQuestions(p) : null;
      const origin = m.role === 'user' ? m.blocks.find((b): b is Extract<typeof b, { type: 'origin' }> => b.type === 'origin') : undefined;
      rows.push({ at: m.createdAt, key: `e-${m.id}`, node: (
        <Bubble key={`e-${m.id}`} m={m} agent="editor" onRetry={() => void actions.plan()} text={questions ?? undefined} hideText={m.role === 'assistant' && Boolean(p) && !questions} collapsible={Boolean(origin)}>
          {origin && (
            <span data-el="agent.editor.message.origin" className="flex max-w-[92%] items-center gap-1 rounded-full border border-em-warn/50 px-1.5 text-[11px] text-em-warn"><Lightbulb size={11} aria-hidden />{t(origin.auto ? 'ui.agent.handoff.origin.auto' : 'ui.agent.handoff.origin')}</span>
          )}
          {questions && <button type="button" data-el="agent.editor.askdiscussion" className="inline-flex items-center gap-1 text-[11px] font-semibold text-em-warn underline" onClick={() => askDiscussion(questions)}><HelpCircle size={11} aria-hidden />{t('ui.agent.handoff.askdiscussion')}</button>}
          {questions ? null : isCurrent && plan ? <PlanCard plan={plan} /> : p ? <PlanSummary plan={p} /> : null}
        </Bubble>
      ) });
    }
    for (const i of mode === 'editor' ? appliedDirectly(visibleQueue(state)) : []) {
      const v = i.appliedHash ? ` · ${i.appliedHash.slice(0, 6)}` : i.appliedVersion !== undefined ? ` · v${i.appliedVersion}` : '';   // FR-085: short version hash
      rows.push({ at: i.createdAt, key: `applied-${i.id}`, node: (
        <div key={`applied-${i.id}`} data-el="agent.editor.message.applied" data-role="system" className="mx-auto flex max-w-[95%] items-center gap-1 text-center text-[11px] text-em-muted">
          <Check size={12} className="text-em-accent-2" aria-hidden />{t('ui.agent.editor.applieddirect', { label: `${intentTitle(i, t, lang)} → ${targetText(i, state.head?.model, t)}` })}{v}
        </div>
      ) });
    }
    rows.sort((a, b) => a.at.localeCompare(b.at));
    return { rows, current };
  }, [mode, state.messages, state.queue, state.pending, state.previousPlans, state.head?.model, state.streaming.editor, plan, plans, t, lang, setMode]); // eslint-disable-line react-hooks/exhaustive-deps
  // ADR-033: an answer that arrived in the other tab is marked (dot) until that tab is opened.
  const counts = { brainstorm: state.messages.brainstorm.length, editor: state.messages.editor.length };
  const [seen, setSeen] = useState<Record<AgentKind, number>>(counts);
  useEffect(() => { setSeen((x) => ({ ...x, [mode]: counts[mode] })); }, [mode, counts[mode]]); // eslint-disable-line react-hooks/exhaustive-deps
  const unread = { brainstorm: counts.brainstorm > seen.brainstorm, editor: counts.editor > seen.editor };
  // FR-265: an empty thread starts with the automatic path — a one-line hint and example prompts that fill the Editor composer
  const pickExample = (text: string) => { setMode('editor'); setValue(text); window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: { agent: 'editor' } })); };
  const empty = state.messages[mode].length === 0 && !(mode === 'editor' && plan)
    ? <ChatStarter mode={mode} onPick={pickExample} hasFootage={state.assets.some((a) => a.kind === 'video' && a.status === 'ready')} /> : null;
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === '1' || e.key === '2')) { e.preventDefault(); e.stopPropagation(); setMode(e.key === '1' ? 'brainstorm' : 'editor'); return; }
    if (e.key === 'Escape' && (state.streaming.editor || plan?.status === 'draft')) { e.stopPropagation(); void actions.cancelPlan(); }
    else if (e.key === 'Escape' && state.streaming.brainstorm) { e.stopPropagation(); void actions.stopRun('brainstorm'); }   // review U2: also while still sending
  };
  return (
    <section data-el="agent.chat" data-mode={mode} data-maximized={layout.maximized ? 'true' : undefined} aria-label={t('ui.agent.chat.title')} className="flex min-h-0 flex-1 flex-col overflow-hidden" onKeyDown={onKeyDown}>
      <ChatTabs mode={mode} setMode={setMode} unread={unread} />
      <ChatHeader mode={mode} setMode={setMode} layout={layout} />
      <Thread label={t(mode === 'brainstorm' ? 'a11y.agent.chat.thread.brainstorm' : 'a11y.agent.chat.thread.editor')} empty={empty}>
        <SectionBoundary section="chat.thread" className="p-2">{thread.rows.map((r) => r.node)}</SectionBoundary>
        {mode === 'brainstorm' ? <><StreamingBubble agent="brainstorm" /><AgentErrorBubble agent="brainstorm" onRetry={() => retry('brainstorm')} onRephrase={() => rephrase('brainstorm')} /></>
          : <><StreamingBubble agent="editor" /><AgentErrorBubble agent="editor" onRetry={() => retry('editor')} onRephrase={() => rephrase('editor')} /></>}
        {mode === 'editor' && plan && !thread.current && <div className="flex flex-col items-start gap-1"><ModeTag agent="editor" /><PlanCard plan={plan} /></div>}
      </Thread>
      <IntentQueue hidden={mode !== 'editor'} />
      {mode === 'editor' && capAt && !targets.some((x) => x.kind === 'caption' && x.index === capAt.i) && (
        <button type="button" data-el="agent.chat.target.caption.suggest" className="mx-2 mb-0.5 truncate rounded-full border border-dashed border-em-accent/60 px-2 text-left text-[11px] text-em-accent hover:bg-em-accent/10"
          onClick={() => actions.pointAt(capChip(capAt), 'editor')}>{t('ui.agent.chat.target.caption.suggest', { label: capChip(capAt).label })}</button>
      )}
      <Composer mode={mode} setMode={setMode} placeholder={t(mode === 'brainstorm' ? 'ui.agent.brainstorm.placeholder' : 'ui.agent.editor.placeholder')} targets={targets}
        onRemoveTarget={removeTarget} value={value} setValue={setValue} onSend={(att, docs) => void send(att, docs)} />
    </section>
  );
}

/** FR-265: example prompts of the empty chat (Indonesian copy in id.json): a short faceless video, footage, a data video, music. */
export const EXAMPLE_PROMPTS = ['ui.agent.chat.example.faceless', 'ui.agent.chat.example.footage', 'ui.agent.chat.example.data', 'ui.agent.chat.example.music'] as const;
const HINT_NUDGE = 'chat:start-hint';
/**
 * agent.chat.start (FR-265): the first-run hint row ("Tulis ide atau tempel prompt lengkap — Expertmotion membuat videonya otomatis",
 * dismissable, remembered) and example prompts as chips. A chip fills the Editor composer (nothing is sent) so the Creator can
 * edit the placeholders first; the footage chip shows once the project has a video.
 */
export function ChatStarter({ mode, onPick, hasFootage }: { mode: AgentKind; onPick: (text: string) => void; hasFootage: boolean }) {
  const { t, prefs, setPrefs } = useStore();
  const hintOn = !prefs.nudgesDismissed.includes(HINT_NUDGE);
  const chips = EXAMPLE_PROMPTS.filter((k) => k !== 'ui.agent.chat.example.footage' || hasFootage);
  return (
    <div data-el="agent.chat.start" className="mx-auto flex w-full max-w-[96%] flex-col gap-2 text-[12px]">
      {hintOn && (
        <div data-el="agent.chat.start.hint" role="note" className="flex items-start gap-2 rounded-[8px] border border-em-accent/40 bg-em-accent/5 px-2 py-1.5 text-em-text">
          <Lightbulb size={14} className="mt-0.5 shrink-0 text-em-accent" aria-hidden />
          <span className="min-w-0 flex-1">{t('ui.agent.chat.start.hint')}</span>
          <button type="button" data-el="agent.chat.start.hint.dismiss" aria-label={t('ui.agent.chat.start.hint.dismiss')} className="shrink-0 rounded px-1 text-em-muted hover:text-em-text"
            onClick={() => setPrefs({ nudgesDismissed: [...prefs.nudgesDismissed, HINT_NUDGE] })}>×</button>
        </div>
      )}
      <p className="text-center text-em-muted">{t(mode === 'brainstorm' ? 'ui.agent.brainstorm.first' : 'ui.agent.editor.first')}</p>
      <div data-el="agent.chat.examples" role="group" aria-label={t('ui.agent.chat.examples')} className="flex flex-wrap justify-center gap-1">
        {chips.map((k) => (
          <button key={k} type="button" data-el="agent.chat.example" data-key={k} title={t('ui.agent.chat.example.tip')}
            className="max-w-full truncate rounded-full border border-em-line px-2 py-0.5 text-left text-em-text-2 hover:border-em-accent hover:text-em-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-em-accent"
            onClick={() => onPick(t(`${k}.text`))}>{t(k)}</button>
        ))}
      </div>
    </div>
  );
}
