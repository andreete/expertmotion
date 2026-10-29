// Proposed changes from the Brainstorming Agent (agent.brainstorm.handoff*, IX-13, FR-076) and the plain-words helpers the
// chat, the Intent Queue and the Plan Card share. The card's send = "Apply to video" (Kerjakan di video): it hands the ticked
// proposals to the Intent Queue (R-082) and the chat switches to Edit mode (Operator decision 2026-10-26).
import { useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { getPreset, validateParams } from '@expertmotion/catalogue';
import type { CompositionModelT } from '@expertmotion/composition-model';
import { useStore } from '../state/store.js';
import type { EditIntent, MessageDto } from '../api/types.js';
import { Button } from '../components/ui.js';
import { categoryIcon } from '../library/presetVisual.js';
import { targetText } from './IntentQueue.js';

export function intentTitle(i: Pick<EditIntent, 'category' | 'presetId' | 'instruction' | 'params'>, t: (k: string, v?: Record<string, string | number>) => string, lang: 'en' | 'id'): string {
  const cat = t(`ui.agent.category.${i.category}`);
  // FR-212: a proposal or intent from the Service may lack params (stored by an older build): never read a field of undefined.
  const params: Record<string, unknown> = i.params && typeof i.params === 'object' ? i.params : {};
  const out = params['__output'] as { kind?: string; value?: unknown; customRatio?: { w: number; h: number } } | undefined;
  if (out?.kind) {                                                              // Output Settings picks (FR-097)
    if (out.kind === 'autoRatio') return t(out.value === true ? 'ui.agent.output.ratio.auto.on' : 'ui.agent.output.ratio.auto.off');
    if (out.kind === 'performanceProfile') return t('ui.agent.intent.output.performanceProfile', { value: t(`ui.agent.output.profile.${String(out.value)}`) });   // FR-090
    const v = out.kind === 'ratio' && out.value === 'custom' && out.customRatio ? `${out.customRatio.w}:${out.customRatio.h}` : String(out.value);
    return t(`ui.agent.intent.output.${out.kind}`, { value: v });
  }
  const sp = params['__splitEdit'] as { atMs?: number; items?: unknown[] } | undefined;
  if (sp) return t('ui.agent.intent.element.split', { count: Math.max(1, sp.items?.length ?? 1) });   // ADR-028 cut at the playhead
  const it = params['__itemsEdit'] as { action?: string; items?: unknown[] } | undefined;   // ADR-031 Delete / Duplicate
  if (it) return t(it.action === 'duplicate' ? 'ui.agent.intent.element.duplicate' : 'ui.agent.intent.element.remove', { count: Math.max(1, it.items?.length ?? 1) });
  if (params['__transformEdit']) return t('ui.agent.intent.element.transform');                // ADR-028 Player handles / Inspector fields
  const el = params['__elementEdit'] as { atMs?: number; layer?: number; move?: string } | undefined;
  if (el) {                                                                     // ADR-027 Timeline drag / trim / lane / layer key
    if (el.atMs !== undefined) return el.layer !== undefined ? t('ui.agent.intent.element.timinglayer', { n: el.layer + 1 }) : t('ui.agent.intent.element.timing');
    return el.move ? t(`ui.agent.intent.element.move.${el.move}`) : t('ui.agent.intent.element.layer', { n: (el.layer ?? 0) + 1 });
  }
  const ins = params['__insert'] as { count?: number } | undefined;
  if (ins && typeof ins.count === 'number') return t('ui.agent.intent.insert', { count: ins.count });   // FR-049 "Insert 3 clips"
  if (i.presetId) return `${cat} · ${getPreset(i.presetId)?.label[lang] ?? i.presetId}`;
  if (i.instruction) return `“${i.instruction}”`;
  const p = Object.entries(params).filter(([k]) => k !== 'text' && k !== 'targetLabel' && !k.startsWith('__')).map(([k, v]) => `${t(`ui.agent.param.${k}`)} ${String(v)}`).join(', ');
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
  // QA 2026-10-26 #2/#4: an empty project can be built from proposals (scenes, texts); only transitions need two clips.
  if (model && i.category === 'transition' && model.tracks.video.length < 2) return { code: 'EM-2202', reason: t('err.EM-2202.title') };
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

/** The pending proposals of one Diskusi answer; `onApplied` runs after a successful hand-off (the chat switches to Edit). */
export function ProposalCard({ message, intents, handoffState, onApplied, onSendDraft }: { message: MessageDto; intents: EditIntent[]; handoffState: 'pending' | 'sent' | 'dismissed'; onApplied?: () => void;
  /** FR-219: all valid items ticked → the whole draft goes to the Editor (run + progress + Plan Card); a subset is queued and planned. */ onSendDraft?: () => void }) {
  const { actions, t, lang, state } = useStore();
  const model = state.head?.model;
  const issues = Object.fromEntries(intents.map((i) => [i.id, proposalIssue(i, model, t)]));
  const [ticked, setTicked] = useState<string[]>(intents.filter((i) => !issues[i.id]).map((i) => i.id));
  const [sending, setSending] = useState(false);                        // the hand-off request is out: the button says so (busy)
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
        <Button el="agent.chat.sendtoeditor" variant="primary" size={28} icon={<Clapperboard size={14} />} title={t('ui.agent.handoff.send.tip')} loading={sending} disabledReason={ticked.length ? null : t('ui.agent.brainstorm.handoff.none')} onClick={() => {
          const valid = intents.filter((i) => !issues[i.id]).map((i) => i.id);
          if (onSendDraft && valid.every((id) => ticked.includes(id))) { onSendDraft(); return; }
          // QA 2026-10-28 #3/#4: a hand-off of picks now also starts the Editor run at once (it used to only queue them).
          // Review U10: plans only the picks this hand-off queued (nothing when every pick was refused), never the whole queue.
          setSending(true);
          void actions.handoff(message, ticked.filter((id) => !issues[id]), { plan: true }).then((ok) => { if (ok) onApplied?.(); }).finally(() => setSending(false));
        }}>{t('ui.agent.handoff.send')}</Button>
        <Button variant="ghost" size={28} onClick={() => actions.dismissHandoff(message)}>{t('ui.agent.brainstorm.handoff.dismiss')}</Button>
      </div>
    </div>
  );
}
