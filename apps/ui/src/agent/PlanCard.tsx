// Plan Card (agent.editor.plancard, CMP-14, UI_UX_SPECIFICATION.md §11.2): read-only Edit Plan with notes, stale state +
// Re-plan, Execute (Ctrl+Enter), Cancel while running, Discard. States: draft/valid/invalid/stale/executing/executed/failed/cancelled.
import { useEffect, useState, type ReactNode } from 'react';
import { Captions, CheckCircle2, Clapperboard, History, Lightbulb, Loader, Mic, OctagonAlert, Pencil, Shapes, Trash2, TriangleAlert, Type, Info, X, XCircle, Music, ArrowRightLeft, Image as ImageIcon, Clock, LocateFixed } from 'lucide-react';
import type { ElementRefT, CompositionModelT } from '@expertmotion/composition-model';
import { fmtTime, previewDurationMs, previewRows, type PreviewKind, type PreviewRow } from './plan-preview.js';
import { useStore } from '../state/store.js';
import { ModelText } from './ModelText.js';
import { useModelNames } from '../state/use-model-names.js';
import type { PlanDto } from '../api/types.js';
import { Button, cx } from '../components/ui.js';
import { formatMoney, formatTokens } from '../i18n/index.js';
import { conflictsWithLocked, propertyKeysOf, type OperationT } from '@expertmotion/composition-model';
import { StageButtons } from './Reels.js';

/** FR-083: Execute needs a valid plan on the head, no block risk, no run in progress and at least one Clip; else the reason. */
export function executeDisabledReason(plan: PlanDto | null, headHash: string | undefined, t: (k: string) => string, ctx: { hasClip?: boolean; running?: boolean } = {}): string | null {
  if (!plan || plan.status === 'draft' || plan.status === 'cancelled' || plan.status === 'executed') return t('ui.agent.editor.execute.noplan');
  if (plan.status === 'stale' || (headHash && plan.baseVersion !== headHash)) return t('ui.agent.editor.execute.stale');
  if (plan.status === 'invalid' || plan.status === 'failed' || plan.risks.some((r) => r.severity === 'block')) return t('ui.agent.editor.execute.blocked');
  if (plan.status !== 'valid') return t('ui.agent.editor.execute.noplan');
  if (ctx.running) return t('ui.agent.editor.execute.running');
  if (ctx.hasClip === false) return t('ui.agent.editor.execute.noclip');
  return null;
}
/** FR-086: "3 added, 1 modified" from an execution result. */
export function diffSummary(r: PlanDto['result'], t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!r) return '';
  const parts = (['added', 'modified', 'removed'] as const).filter((k) => r[k] > 0).map((k) => t(`ui.agent.plan.diff.${k}`, { count: r[k] }));
  return parts.length ? parts.join(', ') : t('ui.agent.plan.diff.none');
}
export const stepOps = (s: PlanDto['steps'][number]): number => (s.ops.length || s.opCount) ?? 0;
/** Generator steps (tts.generate / captions.generate) run after the Composition Version is committed; they carry no ops. */
export const isToolStep = (s: PlanDto['steps'][number]): boolean => s.tool === 'tts.generate' || s.tool === 'captions.generate' || s.tool === 'music.generate';
const excerpt = (v: unknown, n = 60): string => { const x = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
/** Readable line for a generator step ("Suara narasi: \"…\"" / "Teks layar dari naskah"). */
export function toolStepText(s: PlanDto['steps'][number], t: (k: string, v?: Record<string, string | number>) => string): string {
  const a = s.args ?? {};
  if (s.tool === 'tts.generate') return t('ui.agent.plan.tool.tts', { text: excerpt(a['text']) });
  const src = a['source'] === 'voice' || a['source'] === 'sequence' ? a['source'] : 'script';
  return t(`ui.agent.plan.tool.captions.${src}`);
}
/** Ops of a plan (Execute's "Applying N changes…"); generator steps count as one change each. */
export const planChanges = (plan: PlanDto): number => plan.steps.reduce((n, s) => n + (isToolStep(s) ? 1 : stepOps(s)), 0);
/** Friendly op names for the step tooltip (ADR-030 scene ops have their own labels). */
const OP_LABEL: Record<string, string> = { 'op:scene.add': 'ui.agent.plan.op.scene.add', 'op:scene.setBackground': 'ui.agent.plan.op.scene.setBackground' };

/**
 * FR-081: steps that EM-2302 removed (runner validation entries `droppedSteps[n]`, AI_WORKFLOW §12) and, for a plan that still
 * touches Locked Keys, the steps whose operations change them. Both are listed struck through on the Plan Card.
 */
export function lockedSteps(plan: PlanDto): { dropped: Array<{ n: number; text: string }>; touching: Set<number> } {
  const dropped = plan.validation.flatMap((v) => { const m = /^droppedSteps\[(\d+)\]$/.exec(v.path); return v.code === 'EM-2302' && m ? [{ n: Number(m[1]), text: v.message.replace(/^\d+\.\s*/, '') }] : []; });
  const touching = new Set<number>();
  if (plan.touchesLockedKeys.length) for (const st of plan.steps) {
    try { if (st.ops.some((o) => conflictsWithLocked(propertyKeysOf(o as OperationT), plan.touchesLockedKeys).length > 0)) touching.add(st.n); } catch { /* summary ops without args */ }
  }
  return { dropped, touching };
}

const KIND_ICON: Record<PreviewKind, ReactNode> = { scene: <Clapperboard size={12} />, text: <Type size={12} />, shape: <Shapes size={12} />, transition: <ArrowRightLeft size={12} />, background: <ImageIcon size={12} />,
  voice: <Mic size={12} />, captions: <Captions size={12} />, audio: <Music size={12} />, clip: <Clapperboard size={12} />, remove: <Trash2 size={12} />, 'caption-fix': <Captions size={12} />, timing: <Clock size={12} />, other: <Info size={12} /> };
/** FR-222 (QA 2026-10-28 #4): what the plan will do, readable — scenes with start / length, texts, shapes, transitions, voice-over, removals. */
export function PlanPreview({ plan }: { plan: PlanDto }) {
  const { state, t, lang } = useStore();
  const rows = previewRows(plan, state.head?.model, lang, { assets: state.assets });
  if (!rows.length) return null;
  const total = previewDurationMs(rows);
  const scenes = rows.filter((r) => r.kind === 'scene').length;
  const counts = (['text', 'shape', 'voice', 'transition', 'remove'] as const).map((k) => [k, rows.filter((r) => r.kind === k).length] as const).filter(([, n]) => n > 0);
  return (
    <div data-el="agent.editor.plancard.preview" className="flex flex-col gap-1 border-t border-em-line pt-2">
      <div data-el="agent.editor.plancard.preview.summary" className="flex flex-wrap items-center gap-x-2 text-[12px] font-semibold">
        {scenes > 0 && <span>{t('ui.agent.plan.preview.scenes', { n: scenes })}</span>}
        {counts.map(([k, n]) => <span key={k} className="font-normal text-em-text-2">{t(`ui.agent.plan.preview.count.${k}`, { n })}</span>)}
        {total !== null && <span data-el="agent.editor.plancard.preview.total" className="t-mono font-normal text-em-muted">· {t('ui.agent.plan.preview.total', { time: fmtTime(total) })}</span>}
      </div>
      <ol className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto pr-1">
        {rows.map((r: PreviewRow, i) => (
          <li key={i} data-el="agent.editor.plancard.preview.row" data-kind={r.kind} className={cx('flex items-start gap-1.5 text-[12px]', r.kind === 'remove' && 'text-em-danger', r.kind !== 'scene' && r.kind !== 'voice' && r.kind !== 'captions' && 'pl-3')}>
            <span className="mt-0.5 shrink-0 text-em-muted" aria-hidden>{KIND_ICON[r.kind]}</span>
            <span className="min-w-0 flex-1"><span className={r.kind === 'scene' ? 'font-semibold' : undefined}><ModelText inline text={r.title} /></span>{r.count && r.count > 1 ? ` ×${r.count}` : ''}{r.detail ? <span className="text-em-text-2"> · <ModelText inline text={r.detail} /></span> : null}</span>
            {r.startMs !== undefined && <span className="t-mono shrink-0 text-[10px] text-em-muted">{fmtTime(r.startMs)}{r.durationMs !== undefined ? `–${fmtTime(r.startMs + r.durationMs)}` : ''}</span>}
          </li>))}
      </ol>
    </div>
  );
}
/** FR-224: voice clips a scene.compose plan still generates on Execute (its scene timing is an estimate until then). */
/** Plan step statuses with their own words (service.notice plan-step); any other status reads as "working…". */
const STEP_STATUS = new Set(['done', 'failed', 'skipped', 'started', 'needs-model', 'resumed']);
export function voicePending(plan: PlanDto): number {
  for (const st of plan.steps) {
    const spec = st.args?.['sceneCompose'] as { voice?: { clips?: Array<{ assetId?: string }>; generate?: boolean } } | undefined;
    if (spec && st.args?.['measured'] !== true && spec.voice?.generate !== false) return (spec.voice?.clips ?? []).filter((c) => !c.assetId).length;
  }
  return 0;
}
/** FR-222: the refs of the elements a plan added (from the execution diff ids), so "Lihat di timeline" selects them. */
export function addedRefs(model: CompositionModelT | null | undefined, ids: readonly string[]): ElementRefT[] {
  if (!model || !ids.length) return [];
  const set = new Set(ids); const out: ElementRefT[] = [];
  for (const c of model.tracks.video) if (set.has(c.id)) out.push({ kind: 'clip', id: c.id });
  for (const x of model.tracks.text) if (set.has(x.id)) out.push({ kind: 'text', id: x.id });
  for (const o of model.tracks.overlay) if (set.has(o.id)) out.push({ kind: o.kind === 'image' ? 'image' : 'shape', id: o.id });
  for (const a of model.tracks.audio) if (set.has(a.id)) out.push({ kind: 'audio', id: a.id });
  return out;
}
function ShowInTimeline({ plan }: { plan: PlanDto }) {
  const { state, actions, t } = useStore();
  const refs = addedRefs(state.head?.model, plan.result?.addedIds ?? []);
  if (!refs.length) return null;
  return <button type="button" data-el="agent.editor.plancard.showtimeline" className="inline-flex shrink-0 items-center gap-1 font-semibold text-em-accent underline" onClick={() => {
    actions.select(refs.slice(0, 50));
    window.dispatchEvent(new CustomEvent('em:focus-timeline', { detail: { refs } }));
  }}><LocateFixed size={12} aria-hidden />{t('ui.agent.plan.showtimeline')}</button>;
}

/** Undo for an executed plan whose version is still the head (the one-line summary after Execute, 2026-10-26). */
function UndoPlan({ plan }: { plan: PlanDto }) {
  const { state, actions, t } = useStore();
  const to = plan.result?.toVersion;
  if (plan.status !== 'executed' || !to || to !== state.head?.hash || !state.canUndo) return null;
  return <button type="button" data-el="agent.editor.plancard.undo" className="shrink-0 font-semibold text-em-accent underline" onClick={() => void actions.undo()}>{t('ui.sys.toast.undo')}</button>;
}

/** FR-086: an older plan inline in the chat thread, collapsed: goal, status, version hash, diff summary (+ Undo while it is the head). */
export function PlanSummary({ plan }: { plan: PlanDto }) {
  const { t } = useStore();
  const v = plan.result?.toVersion?.slice(0, 6);
  return (
    <div data-el="agent.editor.plancard" data-plan-id={plan.id} data-status={plan.status} data-collapsed="true" className={cx('flex w-full max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[8px] border px-2 py-1 text-[12px]', plan.status === 'executed' ? 'border-em-success/70 text-em-success' : 'border-em-line text-em-muted')}>
      {plan.status === 'executed' ? <CheckCircle2 size={14} /> : <History size={14} />}
      <span className="min-w-0 flex-1 basis-[60%] truncate text-em-text" title={plan.goal}><ModelText inline text={plan.goal} /></span>
      <span>{t(`ui.agent.plan.status.${plan.status}`)}{v ? ` · v${v}` : ''}</span>
      {plan.result && <span className="text-em-muted">· {diffSummary(plan.result, t)}</span>}
      <UndoPlan plan={plan} />
    </div>
  );
}

export function PlanCard({ plan }: { plan: PlanDto }) {
  const { state, actions, t, lang } = useStore();
  const names = useModelNames();
  const [notes, setNotes] = useState(plan.notes ?? '');
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setNotes(plan.notes ?? ''); }, [plan.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 2026-10-26: after Execute the card becomes a one-line summary with Undo right away ("Details" expands it again).
  useEffect(() => { setCollapsed(plan.status === 'executed'); }, [plan.status]);
  const headHash = state.head?.hash;
  const stale = plan.status === 'stale' || (plan.status === 'valid' && headHash !== undefined && plan.baseVersion !== headHash);
  const status = stale ? 'stale' : plan.status;
  // QA 2026-10-26 #2: a plan may build a video from nothing (scene clips, texts), so an empty video track no longer blocks Execute.
  // FR-195: a stale plan's Execute stays available — it re-plans on the current head ("Timeline berubah — rencana disusun ulang").
  const reason = stale ? (state.streaming.editor ? t('ui.agent.editor.execute.running') : null)
    : executeDisabledReason(plan, headHash, t, { hasClip: (state.head?.model?.tracks.video.length ?? 1) > 0 || plan.steps.length > 0, running: Boolean(state.streaming.editor) });
  const toolNote = plan.result?.toolSteps?.some((x) => x.tool === 'tts.generate' && x.status === 'started') ? t('ui.agent.plan.toolnote.tts')
    : plan.result?.toolSteps?.some((x) => x.status === 'started') ? t('ui.agent.plan.toolnote.other') : null;
  const modelMissing = plan.risks.some((r) => r.code === 'model-missing') || plan.steps.some((x) => isToolStep(x) && x.args?.['status'] === 'needs-model');
  const base = plan.baseVersion.slice(0, 6);
  const header: Record<string, { icon: ReactNode; text: string; tone: string; border: string }> = {
    draft: { icon: <Loader size={14} className="em-spin" />, text: t('ui.agent.plan.state.draft'), tone: 'text-em-muted', border: 'border-dashed border-em-line-strong' },
    valid: { icon: <Lightbulb size={14} />, text: t('ui.agent.plan.state.valid'), tone: 'text-em-accent', border: 'border-dashed border-em-accent' },
    invalid: { icon: <OctagonAlert size={14} />, text: t('ui.agent.plan.state.invalid'), tone: 'text-em-danger', border: 'border-dashed border-em-danger' },
    stale: { icon: <History size={14} />, text: t('ui.agent.plan.state.stale'), tone: 'text-em-warn', border: 'border-dashed border-em-warn' },
    executing: { icon: <Loader size={14} className="em-spin" />, text: t('ui.agent.plan.state.executing.changes', { n: Math.max(1, planChanges(plan)) }), tone: 'text-em-accent', border: 'border-solid border-em-accent' },
    executed: { icon: <CheckCircle2 size={14} />, text: t('ui.agent.plan.state.executed', { version: (plan.result?.toVersion ?? headHash)?.slice(0, 6) ?? '' }), tone: 'text-em-success', border: 'border-solid border-em-success' },
    failed: { icon: <XCircle size={14} />, text: t('ui.agent.plan.state.failed', { code: plan.errorCode ?? 'EM-2307' }), tone: 'text-em-danger', border: 'border-solid border-em-danger' },
    cancelled: { icon: <XCircle size={14} />, text: plan.errorCode === 'EM-4304' ? t('ui.agent.plan.state.interrupted') : t('ui.agent.plan.state.cancelled'), tone: 'text-em-muted', border: 'border-solid border-em-line' },
  };
  const h = header[status] ?? header['draft']!;
  const locked = lockedSteps(plan);
  const lockedNotice = locked.dropped.length > 0 || locked.touching.size > 0;
  const otherValidation = plan.validation.filter((v) => !(v.code === 'EM-2302' && v.path.startsWith('droppedSteps[')));
  if (collapsed) {
    return <div data-el="agent.editor.plancard" data-plan-id={plan.id} data-status="executed" data-collapsed="true" className="flex w-full max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[8px] border border-em-success px-2 py-1 text-[12px] text-em-success"><CheckCircle2 size={14} /><span className="min-w-0 flex-1 basis-[60%] truncate" title={plan.goal}><ModelText inline text={plan.goal} /></span>
      <span className="shrink-0">{t('ui.agent.plan.status.executed')} · v{(plan.result?.toVersion ?? headHash ?? '').slice(0, 6)}</span>{plan.result && <span data-el="agent.editor.plancard.result" className="shrink-0 text-em-text-2">· {diffSummary(plan.result, t)}</span>}
      <ShowInTimeline plan={plan} /><UndoPlan plan={plan} /><button type="button" className="shrink-0 underline" onClick={() => setCollapsed(false)}>{t('ui.common.details')}</button>
      {toolNote && <span data-el="agent.editor.plancard.toolnote" className="shrink-0 text-em-text-2">· {toolNote}</span>}
      {/* FR-28x: Final (1080p) stays reachable after the preview collapsed the card */}
      {(state.assets.some((a) => a.kind === 'video') || state.analysis) && <span className="basis-full"><StageButtons plan={plan} /></span>}</div>;
  }
  return (
    <section data-el="agent.editor.plancard" data-plan-id={plan.id} data-status={status} role="region" aria-label={t('a11y.agent.editor.plancard', { goal: plan.goal, status: h.text, version: base })}
      className={cx('flex w-full min-w-0 max-w-full flex-col gap-2 rounded-[8px] border bg-em-panel p-2.5', h.border)}>
      <div className="flex items-center gap-1.5 text-[12px]">
        <span data-el={status === 'executing' ? 'agent.chat.progress' : undefined} data-phase={status === 'executing' ? 'executing' : undefined} role={status === 'executing' ? 'status' : undefined} className={cx('flex items-center gap-1 font-semibold', h.tone)}>{h.icon}{h.text}</span>
        <span className="text-em-muted">· {plan.origin === 'compile' ? t('ui.agent.plan.origin.compile') : t('ui.agent.plan.origin.agent')} ·</span>
        <span data-el={stale ? 'agent.editor.plancard.baseversion.stale' : 'agent.editor.plancard.baseversion'} className={cx('t-mono', stale ? 'text-em-warn' : 'text-em-muted')} title={t('ui.agent.plan.basedon', { version: base })}>{t('ui.agent.plan.basedon', { version: base })}</span>
        <span className="flex-1" />
        <button type="button" aria-label={t('ui.agent.plan.history')} title={t('ui.agent.plan.history')} onClick={() => actions.setScreen({ kind: 'history' })} className="text-em-muted hover:text-em-text"><History size={14} /></button>
        {/* QA 2026-10-28 #16: the card can always be closed from its header (the footer may be scrolled away in a narrow panel). */}
        <button type="button" data-el="agent.editor.plancard.close" aria-label={status === 'executed' ? t('ui.common.close') : t('ui.agent.plan.discard')} title={status === 'executed' ? t('ui.common.close') : status === 'executing' ? t('ui.agent.plan.close.executing') : t('ui.agent.plan.discard')}
          onClick={() => { if (status === 'executed') setCollapsed(true); else if (status !== 'executing') void actions.cancelPlan(); }} className="text-em-muted hover:text-em-text" disabled={status === 'executing'}><X size={14} /></button>
      </div>
      <div data-el="agent.editor.plancard.goal" className="text-[16px] font-semibold leading-[22px]">{plan.goal ? <ModelText inline text={plan.goal} /> : t('ui.agent.plan.goal.pending')}</div>
      {status !== 'draft' && <PlanPreview plan={plan} />}
      {plan.confirmRemoval && plan.confirmRemoval.length > 0 && (
        <div data-el="agent.editor.plancard.confirmremoval" role="alertdialog" aria-label={t('ui.agent.plan.confirmremoval.sentence', { n: plan.confirmRemoval.length })} className="rounded-[6px] border border-em-danger bg-em-panel-2 p-2 text-[12px]">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-em-danger"><Trash2 size={13} />{/* QA: plain sentence, the code stays in data-code (was "…item(s): EM-4310 Adegan 1") */}<span data-code="EM-4310">{t('ui.agent.plan.confirmremoval.sentence', { n: plan.confirmRemoval.length })}</span></div>
          <ul className="mb-2 list-disc pl-4 text-em-text-2">{plan.confirmRemoval.slice(0, 10).map((x, i) => <li key={i}>{x.label}</li>)}</ul>
          <div className="flex gap-2">
            <Button el="agent.editor.plancard.confirmremoval.yes" variant="danger" size={28} onClick={() => void actions.execute(true)}>{t('ui.agent.plan.confirmremoval.yes')}</Button>
            <Button size={28} variant="ghost" onClick={() => actions.dismissRemoval()}>{t('ui.common.cancel')}</Button>
          </div>
        </div>
      )}
      {(plan.steps.length > 0 || locked.dropped.length > 0) && (
        <ol className="flex flex-col gap-1 border-t border-em-line pt-2">
          {plan.steps.map((s) => {
            const off = locked.touching.has(s.n);
            if (isToolStep(s)) {
              const needs = s.args?.['status'] === 'needs-model';
              return (
                <li key={s.n} data-el="agent.editor.plancard.toolstep" data-tool={s.tool} data-status={needs ? 'needs-model' : 'ready'} className={cx('flex items-start gap-1.5 text-[12px]', s.dependsOn.length > 0 && 'ml-4', needs && 'text-em-muted')}>
                  <span className="t-mono text-em-muted">{s.n}</span>
                  <span className="shrink-0 text-em-accent" aria-hidden>{s.tool === 'tts.generate' ? <Mic size={13} /> : <Captions size={13} />}</span>
                  <span className="flex-1">{toolStepText(s, t)}{needs && <span className="text-em-warn"> · {t('ui.agent.plan.tool.needsmodel', { model: String(s.args?.['modelLabel'] ?? s.args?.['modelKey'] ?? '') })}</span>}</span>
                </li>
              );
            }
            return (
              <li key={s.n} data-el="agent.editor.plancard.step" data-locked={off ? 'true' : undefined} className={cx('flex items-start gap-1.5 text-[12px]', s.dependsOn.length > 0 && 'ml-4', off && 'text-em-muted line-through')}>
                <span className="t-mono text-em-muted">{s.n}</span>
                {/* Entry 36: "composition.applyOps" is an internal tool name — not shown to the Creator (kept in the DOM for tests / support) */}
                <span data-el="agent.editor.plancard.step.tool" className={cx('t-mono shrink-0 rounded-[4px] border border-em-line px-1 text-[10px] text-em-muted', s.tool === 'composition.applyOps' && 'hidden')}>{s.tool}</span>
                <span data-el="agent.editor.plancard.step.diff" className="min-w-0 flex-1 break-words"><ModelText inline text={s.expectedDiff} /></span>
                <span data-el="agent.editor.plancard.step.ops" className="t-mono shrink-0 whitespace-nowrap text-[10px] text-em-muted" title={[...new Set(s.ops.map((o) => (OP_LABEL[o.op] ? t(OP_LABEL[o.op]!) : o.op)))].join(', ') || undefined}>{t('ui.agent.plan.step.ops', { count: stepOps(s) })}</span>
              </li>
            );
          })}
          {locked.dropped.map((d) => (
            <li key={`d${d.n}`} data-el="agent.editor.plancard.step.dropped" className="flex items-start gap-1.5 text-[12px] text-em-muted line-through" aria-label={t('ui.agent.plan.step.dropped', { n: d.n, text: d.text })}>
              <span className="t-mono">{d.n}</span><span className="flex-1">{d.text}</span><span className="t-mono text-[10px] no-underline">EM-2302</span>
            </li>
          ))}
        </ol>
      )}
      {lockedNotice && (
        <div data-el="agent.editor.plancard.locked" role="note" className="rounded-[6px] border-l-2 border-em-warn bg-em-panel-2 px-2 py-1 text-[12px]">
          <div className="flex items-center gap-1.5"><TriangleAlert size={12} className="text-em-warn" /><span className="flex-1 font-semibold">{t('err.EM-2302.title')}</span><span className="t-mono text-em-muted">EM-2302</span></div>
          <div className="text-em-text-2">{t('err.EM-2302.body', { keys: plan.touchesLockedKeys.length ? plan.touchesLockedKeys.join(', ') : [...new Set(locked.dropped.flatMap((d) => /\(([^()]*)\)$/.exec(d.text)?.[1]?.split(', ') ?? []))].join(', ') })}</div>
        </div>
      )}
      {(plan.risks.length > 0 || otherValidation.length > 0 || plan.touchesLockedKeys.length > 0) && (
        <ul className="flex flex-col gap-1 border-t border-em-line pt-2" aria-label={t('ui.agent.plan.risks')}>
          {plan.risks.map((r, i) => (
            <li key={`r${i}`} data-el="agent.editor.plancard.risk" className="flex items-start gap-1.5 text-[12px]">
              <span className={r.severity === 'block' ? 'text-em-danger' : r.severity === 'warn' ? 'text-em-warn' : 'text-em-info'}>{r.severity === 'block' ? <OctagonAlert size={14} /> : r.severity === 'warn' ? <TriangleAlert size={14} /> : <Info size={14} />}</span>
              <span className="flex-1"><ModelText inline text={r.message} /> <span className="text-em-muted">· {t(`ui.agent.plan.severity.${r.severity}`)}</span></span>
            </li>
          ))}
          {otherValidation.map((v, i) => <li key={`v${i}`} data-el="agent.editor.plancard.risk" className="flex gap-1.5 text-[12px] text-em-danger"><OctagonAlert size={14} />{v.message}<span className="t-mono text-em-muted">{v.code}</span></li>)}
          {plan.touchesLockedKeys.map((k) => <li key={k} data-el="agent.editor.plancard.risk" className="flex gap-1.5 text-[12px] text-em-warn"><OctagonAlert size={14} />{t('ui.agent.plan.locked', { key: k })}</li>)}
        </ul>
      )}
      {modelMissing && (
        <button type="button" data-el="agent.editor.plancard.models" className="self-start text-[12px] font-semibold text-em-accent underline" onClick={() => actions.setScreen({ kind: 'models' })}>{t('ui.agent.plan.openmodels')}</button>
      )}
      <textarea data-el="agent.editor.plancard.notes" value={notes} maxLength={1000} rows={2} placeholder={t('ui.agent.plan.notes.placeholder')} aria-label={t('ui.agent.plan.notes.placeholder')}
        onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== (plan.notes ?? '')) void actions.setNotes(notes); }}
        className="resize-none rounded-[6px] border border-em-line bg-em-panel-2 px-2 py-1 text-[12px] outline-none placeholder:text-em-muted" />
      {status === 'executed' && plan.result && <div data-el="agent.editor.plancard.result" className="text-[12px] text-em-success">{diffSummary(plan.result, t)}</div>}
      {status === 'executed' && toolNote && <div data-el="agent.editor.plancard.toolnote" className="text-[12px] text-em-text-2">{toolNote}</div>}
      {status === 'executed' && plan.steps.some(isToolStep) && (
        <ul data-el="agent.editor.plancard.steps.live" className="flex flex-col gap-0.5 text-[12px]">
          {plan.steps.filter(isToolStep).map((s) => { const st = plan.stepStatus?.[s.n]?.status ?? plan.result?.toolSteps?.find((x) => x.n === s.n)?.status ?? 'started'; const code = plan.stepStatus?.[s.n]?.code;
            return <li key={s.n} data-el="agent.editor.plancard.step.live" data-status={st} className={cx('flex items-center gap-1.5', st === 'failed' ? 'text-em-danger' : st === 'done' ? 'text-em-success' : 'text-em-text-2')}>
              {/* review U5: only a step that is really working spins; a step waiting for its model says so and opens the Model Manager */}
              {st === 'done' ? <CheckCircle2 size={12} /> : st === 'failed' ? <XCircle size={12} /> : st === 'skipped' || st === 'needs-model' ? <Info size={12} /> : <Loader size={12} className="em-spin" />}
              {toolStepText(s, t)} · {t(`ui.agent.plan.step.status.${STEP_STATUS.has(st) ? st : 'started'}`)}{code ? <span className="t-mono text-[10px]"> {code}</span> : null}
              {st === 'needs-model' && !modelMissing && <button type="button" data-el="agent.editor.plancard.models" className="ml-1 font-semibold text-em-accent underline" onClick={() => actions.setScreen({ kind: 'models' })}>{t('ui.agent.plan.openmodels')}</button>}</li>; })}
        </ul>
      )}
      {status === 'executed' && <div className="flex gap-3 text-[12px]"><ShowInTimeline plan={plan} /></div>}
      {plan.usage && (
        <div className="t-mono text-[11px] text-em-muted" title={plan.usage.approximate ? t('ui.agent.common.cost.approx') : plan.usage.costUsd === null ? t('ui.agent.common.cost.na') : undefined}>
          <span data-el="agent.editor.plancard.model" title={plan.usage.model}>{names.llm(plan.usage.model, 'editor')}</span> · {t('ui.agent.plan.usage', { input: formatTokens(plan.usage.inputTokens, lang), output: formatTokens(plan.usage.outputTokens, lang), cost: formatMoney(plan.usage.costUsd, plan.usage.approximate, lang) })}
          {!!plan.usage.cacheReadTokens && plan.usage.inputTokens > 0 && <span data-el="agent.editor.plancard.cache" title={t('ui.agent.plan.usage.cache.tip')}> · {t('ui.agent.plan.usage.cache', { pct: Math.round((100 * plan.usage.cacheReadTokens) / plan.usage.inputTokens) })}</span>}
        </div>
      )}
      {status === 'executing' && (
        <div data-el="agent.editor.plancard.executing" data-phase={plan.execPhase?.phase ?? 'apply'} className="flex flex-col gap-1">
          <span role="status" className="text-[12px] text-em-text-2">{plan.execPhase ? t(`ui.agent.plan.exec.${plan.execPhase.phase}${plan.execPhase.phase === 'voice' && (plan.execPhase.done ?? 0) > 0 ? '.progress' : ''}`, { done: plan.execPhase.done ?? 0, total: plan.execPhase.total ?? 0, n: Math.max(1, planChanges(plan)), time: plan.execPhase.totalMs ? fmtTime(plan.execPhase.totalMs) : '' }) : t('ui.agent.plan.state.executing.changes', { n: Math.max(1, planChanges(plan)) })}</span>
          <div role="progressbar" aria-label={t('ui.agent.plan.state.executing.changes', { n: Math.max(1, planChanges(plan)) })} className="h-1 w-full overflow-hidden rounded-full bg-em-line"><div className="em-indeterminate h-full w-1/3 bg-em-accent" /></div>
        </div>)}
      {status !== 'executing' && voicePending(plan) > 0 && <div data-el="agent.editor.plancard.estimate" role="note" className="text-[11px] text-em-warn">{t('ui.agent.plan.preview.estimate', { n: voicePending(plan) })}</div>}
      {/* FR-28x (Reels): the footage path's three Creator actions on a project with a recording (prep · 720p preview · 1080p final) */}
      {(state.assets.some((a) => a.kind === 'video') || state.analysis) && status !== 'executing' && status !== 'draft' && <StageButtons plan={plan} />}
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-em-line bg-em-panel pt-2">
        {status !== 'executed' && status !== 'executing' && <Button size={28} variant="ghost" onClick={() => void actions.cancelPlan()}>{t('ui.agent.plan.discard')}</Button>}
        {(status === 'valid' || status === 'stale') && <Button el="agent.editor.plancard.revise" size={28} variant="ghost" icon={<Pencil size={12} />} title={t('ui.agent.plan.revise.tip')} onClick={() => { window.dispatchEvent(new CustomEvent('em:ask-editor', { detail: { text: t('ui.agent.plan.revise.prefix') } })); }}>{t('ui.agent.plan.revise')}</Button>}
        {status === 'executing' && <Button size={28} variant="ghost" aria-label={t('ui.agent.plan.cancelexecute')} onClick={() => void actions.cancelPlan()}>{t('ui.common.cancel')}</Button>}
        <span className="flex-1" />
        {(status === 'stale' || status === 'invalid' || status === 'failed' || status === 'cancelled') && (
          <Button el="agent.editor.plancard.replan" size={32} variant={status === 'stale' ? 'primary' : 'secondary'} onClick={() => void actions.replan()}>{status === 'cancelled' ? t('ui.agent.plan.rerun') : t('ui.agent.plan.replan')}</Button>
        )}
        {status === 'executed' && <Button el="agent.editor.plancard.undo" size={32} onClick={() => void actions.undo()}>{t('ui.sys.toast.undo')}</Button>}
        {status !== 'executed' && status !== 'cancelled' && (   /* stale: shown disabled with its reason next to Re-plan */
          <Button el="agent.editor.execute" variant="primary" size={36} disabledReason={reason} loading={status === 'executing'} title={stale ? t('ui.agent.editor.execute.stale') : t('ui.agent.editor.execute.tooltip')}
            aria-label={t('a11y.agent.editor.execute')} onClick={() => void actions.execute()}>{t('ui.agent.editor.execute')} <span className="t-mono text-[10px] opacity-70">⌃↵</span></Button>
        )}
      </div>
    </section>
  );
}
