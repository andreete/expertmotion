// Brainstorming Chat (agent.brainstorm.*): ideas only, never mutates (IX-12); hand-off card (IX-13).
import { useState } from 'react';
import { SendHorizontal } from 'lucide-react';
import { getPreset, validateParams } from '@expertmotion/catalogue';
import type { CompositionModelT } from '@expertmotion/composition-model';
import { useStore } from '../state/store.js';
import type { EditIntent, MessageDto } from '../api/types.js';
import { Button } from '../components/ui.js';
import { AgentErrorBubble, Bubble, ChatHeader, Composer, StreamingBubble, Thread, chatSectionCls, type ChatLayoutProps } from './Chat.js';
import { cx } from '../components/ui.js';
import { categoryIcon } from '../library/presetVisual.js';
import { targetText } from './IntentQueue.js';

export function BrainstormChat(layout: ChatLayoutProps) {
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
    <section data-el="agent.brainstorm.panel" data-view={layout.view} aria-label={t('ui.agent.brainstorm.title')} className={cx(chatSectionCls('brainstorm', layout.view), layout.view === 'min' && 'border-b border-em-line')} style={layout.style}>
      <ChatHeader agent="brainstorm" title={t('ui.agent.brainstorm.title')} help={t('ui.agent.brainstorm.help')} layout={layout} />
      <div className={cx('flex min-h-0 flex-1 flex-col', layout.view === 'min' && 'hidden')}>
      <Thread agent="brainstorm" label={t('a11y.agent.brainstorm.thread')}
        empty={state.messages.brainstorm.length === 0 ? <div className="mx-auto max-w-[90%] text-center text-[12px] text-em-muted">{t('ui.agent.brainstorm.first')}</div> : null}>
        {state.messages.brainstorm.map((m, idx) => (
          <Bubble key={m.id} m={m} agent="brainstorm" onRetry={m.role === 'system' ? () => {
            // FR-077: a restored failure re-sends the request it answered
            const prev = state.messages.brainstorm.slice(0, idx).reverse().find((x) => x.role === 'user');
            const text = prev?.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') ?? '';
            if (text) void actions.send('brainstorm', text, prev?.blocks.flatMap((b) => (b.type === 'attachment' && b.assetId ? [b.assetId] : [])) ?? []);
          } : undefined}>
            {m.blocks.map((b, i) => (b.type === 'proposed_intents' ? <Handoff key={i} message={m} intents={b.intents} handoffState={b.handoffState} /> : null))}
          </Bubble>
        ))}
        <StreamingBubble agent="brainstorm" />
        <AgentErrorBubble agent="brainstorm" onRetry={() => { if (lastSent) { setValue(lastSent.text); } }} />
      </Thread>
      <Composer agent="brainstorm" placeholder={t('ui.agent.brainstorm.placeholder')} value={value} setValue={setValue} onSend={(a) => void send(a)} />
      </div>
    </section>
  );
}

export function intentTitle(i: Pick<EditIntent, 'category' | 'presetId' | 'instruction' | 'params'>, t: (k: string, v?: Record<string, string | number>) => string, lang: 'en' | 'id'): string {
  const cat = t(`ui.agent.category.${i.category}`);
  const out = i.params['__output'] as { kind?: string; value?: unknown; customRatio?: { w: number; h: number } } | undefined;
  if (out?.kind) {                                                              // Output Settings picks (FR-097)
    if (out.kind === 'autoRatio') return t(out.value === true ? 'ui.agent.output.ratio.auto.on' : 'ui.agent.output.ratio.auto.off');
    if (out.kind === 'performanceProfile') return t('ui.agent.intent.output.performanceProfile', { value: t(`ui.agent.output.profile.${String(out.value)}`) });   // FR-090
    const v = out.kind === 'ratio' && out.value === 'custom' && out.customRatio ? `${out.customRatio.w}:${out.customRatio.h}` : String(out.value);
    return t(`ui.agent.intent.output.${out.kind}`, { value: v });
  }
  const sp = i.params['__splitEdit'] as { atMs?: number; items?: unknown[] } | undefined;
  if (sp) return t('ui.agent.intent.element.split', { count: Math.max(1, sp.items?.length ?? 1) });   // ADR-028 cut at the playhead
  if (i.params['__transformEdit']) return t('ui.agent.intent.element.transform');                // ADR-028 Player handles / Inspector fields
  const el = i.params['__elementEdit'] as { atMs?: number; layer?: number; move?: string } | undefined;
  if (el) {                                                                     // ADR-027 Timeline drag / trim / lane / layer key
    if (el.atMs !== undefined) return el.layer !== undefined ? t('ui.agent.intent.element.timinglayer', { n: el.layer + 1 }) : t('ui.agent.intent.element.timing');
    return el.move ? t(`ui.agent.intent.element.move.${el.move}`) : t('ui.agent.intent.element.layer', { n: (el.layer ?? 0) + 1 });
  }
  const ins = i.params['__insert'] as { count?: number } | undefined;
  if (ins && typeof ins.count === 'number') return t('ui.agent.intent.insert', { count: ins.count });   // FR-049 "Insert 3 clips"
  if (i.presetId) return `${cat} · ${getPreset(i.presetId)?.label[lang] ?? i.presetId}`;
  if (i.instruction) return `“${i.instruction}”`;
  const p = Object.entries(i.params).filter(([k]) => k !== 'text' && k !== 'targetLabel' && !k.startsWith('__')).map(([k, v]) => `${t(`ui.agent.param.${k}`)} ${String(v)}`).join(', ');
  return p ? `${cat} · ${p}` : cat;
}

type T = (k: string, v?: Record<string, string | number>) => string;
/**
 * FR-076: the catalogue checks the Service runs on hand-off, ahead of Send, so an invalid proposal is shown greyed with its reason:
 * unknown preset (EM-2101), params outside the preset's schema (EM-2102), no clip yet (EM-2202).
 */
export function proposalIssue(i: Pick<EditIntent, 'presetId' | 'params' | 'category'>, model: CompositionModelT | undefined, t: T): { code: string; reason: string } | null {
  if (i.presetId) {
    if (!getPreset(i.presetId)) return { code: 'EM-2101', reason: t('err.EM-2101.title') };
    const params = Object.fromEntries(Object.entries(i.params ?? {}).filter(([k]) => !k.startsWith('__')));
    if (Object.keys(params).length) { const v = validateParams(i.presetId, params); if (!v.ok) return { code: 'EM-2102', reason: `${t('err.EM-2102.title')}: ${v.issues[0]?.message ?? ''}`.trim() }; }
  }
  if (model && !model.tracks.video.length && i.category !== 'output' && i.category !== 'layout') return { code: 'EM-2202', reason: t('err.EM-2202.title') };
  return null;
}
/** FR-076: where a proposed change lands, in plain words ("all 3 cuts", "Clip 2", "project", "your selection"). */
export function proposalTarget(i: EditIntent, model: CompositionModelT | undefined, t: T): string {
  const k = i.target?.kind;
  if (!k || k === 'selection' || k === 'playhead') {
    if (i.category === 'transition' && model && model.tracks.video.length > 1) return t('ui.agent.target.allcuts', { count: model.tracks.video.length - 1 });
    if (i.category === 'text' && !i.presetId) return t('ui.agent.target.newtext');
    return t(k === 'playhead' ? 'ui.agent.target.playhead' : k === 'selection' ? 'ui.agent.target.selection' : 'ui.agent.target.auto');
  }
  return targetText({ ...i, resolvedTargets: [i.target], status: 'queued' }, model, t);
}

function Handoff({ message, intents, handoffState }: { message: MessageDto; intents: EditIntent[]; handoffState: 'pending' | 'sent' | 'dismissed' }) {
  const { actions, t, lang, state } = useStore();
  const model = state.head?.model;
  const issues = Object.fromEntries(intents.map((i) => [i.id, proposalIssue(i, model, t)]));
  const [ticked, setTicked] = useState<string[]>(intents.filter((i) => !issues[i.id]).map((i) => i.id));
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
        {intents.map((i) => {
          const bad = issues[i.id];
          return (
            <li key={i.id} data-el="agent.brainstorm.handoff.item" data-invalid={bad ? 'true' : undefined} className={bad ? 'opacity-50' : undefined}>
              <label className="flex items-center gap-2">
                <input type="checkbox" disabled={Boolean(bad)} checked={!bad && ticked.includes(i.id)} onChange={(e) => setTicked((x) => (e.target.checked ? [...x, i.id] : x.filter((y) => y !== i.id)))} />
                <span className="text-em-muted">{categoryIcon(i.category, 14)}</span>
                <span className="truncate">{intentTitle(i, t, lang)} → {proposalTarget(i, model, t)}</span>
              </label>
              {bad && <div data-el="agent.brainstorm.handoff.item.reason" className="ml-6 text-[11px] text-em-muted">{t('ui.agent.brainstorm.handoff.invalid', { reason: bad.reason })} <span className="t-mono">{bad.code}</span></div>}
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <Button variant="primary" size={28} icon={<SendHorizontal size={14} />} disabledReason={ticked.length ? null : t('ui.agent.brainstorm.handoff.none')} onClick={() => void actions.handoff(message, ticked.filter((id) => !issues[id]))}>{t('ui.agent.brainstorm.handoff.send')}</Button>
        <Button variant="ghost" size={28} onClick={() => actions.dismissHandoff(message)}>{t('ui.agent.brainstorm.handoff.dismiss')}</Button>
      </div>
    </div>
  );
}
