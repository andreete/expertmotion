// FR-219 / FR-223 (QA 2026-10-28 #3, #20): the hand-off from Diskusi to the Editor is never silent. Both chats show the same progress:
// phases (membaca draf → menyusun adegan → memeriksa → siap) with the elapsed seconds and the attempt count, then the plan state
// (ready to check and apply / applied / failed) with a jump to the other chat.
import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Clapperboard, Loader, XCircle } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { AgentKind, MessageBlock } from '../api/types.js';
import { cx } from '../components/ui.js';
import { PENDING_RUN } from '../state/reducer.js';

export const HANDOFF_PHASES = ['reading', 'planning', 'checking', 'ready'] as const;
/** The stepper index of a run phase (provider stream phases count as "menyusun adegan"). */
export function phaseIndex(phase: string | undefined): number {
  if (!phase || phase === 'sending' || phase === 'reading') return 0;
  if (phase === 'checking' || phase === 'correcting') return 2;
  return 1;
}

function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!since) return; const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, [since]);
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

/** The four-phase stepper with seconds and "percobaan n/m" (shown in the Editor's working bubble and the Diskusi hand-off card). */
export function PhaseStepper({ agent = 'editor', done = false }: { agent?: AgentKind; done?: boolean }) {
  const { state, t } = useStore();
  const s = state.streaming[agent];
  const idx = done ? 3 : phaseIndex(s?.phase);
  const secs = useElapsed(s?.since);
  const pct = done ? 100 : Math.round(((idx + (s?.attempt && s.of ? Math.min(0.9, (s.attempt - 1) / s.of) : 0.4)) / 4) * 100);
  return (
    <div data-el="agent.chat.phases" data-phase-index={idx} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('ui.agent.handoff.progress')} className="flex w-full flex-col gap-1">
      <ol className="flex items-center gap-1 text-[11px]">
        {HANDOFF_PHASES.map((p, i) => (
          <li key={p} data-el="agent.chat.phase" data-state={i < idx ? 'done' : i === idx ? 'active' : 'todo'} className={cx('flex items-center gap-1', i < idx ? 'text-em-success' : i === idx ? 'font-semibold text-em-accent' : 'text-em-muted')}>
            {i < idx ? <CheckCircle2 size={11} aria-hidden /> : i === idx && !done ? <Loader size={11} className="em-spin" aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            {t(`ui.agent.handoff.phase.${p}`)}{i < HANDOFF_PHASES.length - 1 && <ArrowRight size={10} className="text-em-muted" aria-hidden />}
          </li>))}
      </ol>
      <div className="h-1 w-full overflow-hidden rounded-full bg-em-line"><div className="h-full bg-em-accent transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
      {!done && s && <span data-el="agent.chat.phases.meta" className="t-mono text-[10px] text-em-muted">{t('ui.agent.progress.elapsed', { s: secs })}{s.attempt && s.of ? ` · ${t('ui.agent.handoff.attempt', { n: s.attempt, of: s.of })}` : ''}</span>}
    </div>
  );
}

/** The hand-off card on a Diskusi draft: live progress of the Editor run it started, then its result, with "Lihat di Editor". */
export function HandoffCard({ block, onOpenEditor }: { block: Extract<MessageBlock, { type: 'handoff' }>; onOpenEditor: () => void }) {
  const { state, t } = useStore();
  const live = state.streaming.editor;
  const running = block.state === 'planning' && Boolean(live) && (live?.runId === block.editorRunId || live?.runId === PENDING_RUN);
  const st = running ? 'planning' : block.state === 'planning' && !live ? (state.agentError.editor ? 'failed' : 'ready') : block.state;
  const plan = state.plan;
  return (
    <div data-el="agent.brainstorm.handoff.card" data-state={st} role="status" aria-live="polite" className={cx('flex w-full flex-col gap-1.5 rounded-[8px] border p-2 text-[12px]', st === 'failed' ? 'border-em-danger' : st === 'applied' ? 'border-em-success' : 'border-em-accent')}>
      <div className="flex items-center gap-1.5 font-semibold">
        {st === 'applied' ? <CheckCircle2 size={14} className="text-em-success" /> : st === 'failed' ? <XCircle size={14} className="text-em-danger" /> : <Clapperboard size={14} className="text-em-accent" />}
        <span className="min-w-0 flex-1 truncate">{t(`ui.agent.handoff.state.${st}`, { title: block.draftTitle, n: block.scenes ?? plan?.steps.length ?? 0 })}</span>
      </div>
      {running && <PhaseStepper />}
      {st === 'ready' && plan && plan.status === 'valid' && <span className="text-em-text-2">{t('ui.agent.handoff.ready.hint')}</span>}
      <button type="button" data-el="agent.brainstorm.handoff.open" className="self-start font-semibold text-em-accent underline" onClick={onOpenEditor}>{t('ui.agent.handoff.open')}</button>
    </div>
  );
}
