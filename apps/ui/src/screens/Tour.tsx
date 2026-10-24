// In-app tour (ONBOARDING_TOUR.md §3, TOUR-1 … TOUR-8; FR-149 ≤ 8 steps) on the real Editor with the R-025 sample project.
// Each step points at its element id and waits for its "next trigger" (a real action: a click, a pick, Execute, opening
// Export) or Next. The overlay never blocks the Editor: the scrim and spotlight ignore the pointer so the Creator learns by
// doing. Esc skips the tour at once (FR-149); Help ▸ Tour re-runs it (on this project or the sample, §3 "Re-run").
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../state/store.js';
import type { AppState, LibMode } from '../state/reducer.js';
import { Button, ErrorBox, Spinner } from '../components/ui.js';
import { translate } from '../i18n/index.js';

type Signal = (s: AppState) => string | number | null;
export interface TourStep {
  /** Element ids (ELEMENT_IDS.md) tried in order; the first one in the DOM is highlighted. */
  targets: string[];
  /** A click inside this element advances (TOUR-1). */
  click?: string;
  /** State change that counts as the trigger: a number must grow, a string must change to a new non-empty value. */
  signal?: Signal;
  /** Panel the target lives in: expanded when collapsed (§3 "Interruptions"). */
  panel?: 'lib' | 'agent';
  libMode?: LibMode;
  /** i18n key suffix of the "Try it" hint (tour.<n>.try). */
  tryIt?: boolean;
}

const picks = (s: AppState) => (s.queue?.items ?? []).filter((i) => i.source !== 'system');
export const TOUR_STEPS: TourStep[] = [
  { targets: ['hdr.menu.design'], click: 'hdr.menu.design', tryIt: true },                                                                    // TOUR-1 Header
  { targets: ['lib.assets.panel'], panel: 'lib' },                                                                                             // TOUR-2 Asset Panel
  { targets: ['lib.catalogue.card'], panel: 'lib', libMode: 'design', tryIt: true,                                                              // TOUR-3 Library: a pick is applied (Compile)
    signal: (s) => picks(s).filter((i) => !i.parentIntentId && i.status !== 'rejected').length },
  { targets: ['stage.timeline'], tryIt: true, signal: (s) => s.selection.map((x) => `${x.kind}:${x.id ?? x.index ?? ''}`).join(',') || null },  // TOUR-4 Stage
  { targets: ['agent.brainstorm.composer'], panel: 'agent', tryIt: true, signal: (s) => s.messages.brainstorm.length },                       // TOUR-5 Agent Panel
  { targets: ['agent.editor.plancard', 'agent.editor.panel'], panel: 'agent', tryIt: true, signal: (s) => (s.plan?.status === 'executed' ? s.plan.id : null) }, // TOUR-6
  { targets: ['agent.output', 'agent.output.ratio.9x16'], panel: 'agent', tryIt: true,                                                         // TOUR-7 Output Settings + Private Mode
    signal: (s) => { const st = s.head?.model?.settings; return st ? `${st.ratio}|${st.resolution}` : null; } },
  { targets: ['hdr.action.export'], tryIt: true, signal: (s) => (s.screen?.kind === 'export' ? 'export' : null) },                           // TOUR-8
];
/** FR-149: the tour has at most 8 steps. */
export const TOUR_MAX_STEPS = 8;
/** Step indexes with extra content (0-based). */
const BRAINSTORM = 4, EDITOR = 5, OUTPUT = 6;

export function advanced(base: string | number | null, now: string | number | null): boolean {
  if (now === null || now === base) return false;
  if (typeof now === 'number' && typeof base === 'number') return now > base;
  return true;
}

type Phase = { kind: 'idle' } | { kind: 'choose' } | { kind: 'preparing'; projectId: string | null; failed: boolean } | { kind: 'step'; n: number } | { kind: 'done' };
const CARD_W = 320;

export function Tour() {
  const { prefs, setPrefs, actions, state } = useStore();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardH, setCardH] = useState(220);
  const [, bump] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const base = useRef<string | number | null>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const lang = prefs.onboardingLang;
  const o = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const n = phase.kind === 'step' ? phase.n : -1;
  const step = n >= 0 ? TOUR_STEPS[n] : undefined;

  const begin = useCallback(() => { setPhase({ kind: 'step', n: 0 }); setPrefs({ tourDone: false, tourStep: 1 }); }, [setPrefs]);
  const startSample = useCallback(async () => {
    setPhase({ kind: 'preparing', projectId: null, failed: false });
    const id = await actions.openSampleProject(lang);
    setPhase(id ? { kind: 'preparing', projectId: id, failed: false } : { kind: 'preparing', projectId: null, failed: true });
  }, [actions, lang]);
  const end = useCallback(() => { setPhase({ kind: 'idle' }); setRect(null); setPrefs({ tourDone: true }); }, [setPrefs]);
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const next = useCallback(() => {
    const p = phaseRef.current;
    if (p.kind !== 'step') return;
    if (p.n + 1 >= TOUR_STEPS.length) { setPrefs({ tourDone: true, tourStep: 0 }); setPhase({ kind: 'done' }); return; }
    setPrefs({ tourStep: p.n + 2 });
    const nxt: Phase = { kind: 'step', n: p.n + 1 };
    phaseRef.current = nxt;                                   // a second trigger in the same tick must not skip a step
    setPhase(nxt);
  }, [setPrefs]);
  const back = () => setPhase((p) => (p.kind === 'step' && p.n > 0 ? { kind: 'step', n: p.n - 1 } : p));

  // ── start: onboarding (ONB-6) always uses the sample; Help ▸ Tour asks when the current project has clips ──
  useEffect(() => {
    const start = (e: Event) => {
      const source = (e as CustomEvent<{ source?: string }>).detail?.source;
      const s = stateRef.current;
      const hasClip = (s.head?.model?.tracks.video.length ?? 0) > 0;
      if (source === 'help' && s.project?.isSample === true) begin();
      else if (source === 'help' && hasClip) setPhase({ kind: 'choose' });
      else void startSample();
    };
    window.addEventListener('em:tour', start);
    return () => window.removeEventListener('em:tour', start);
  }, [begin, startSample]);

  // ── preparing: wait for service.notice {kind:'sample', ready} (or a complete project), polling in case an event was missed ──
  const prepId = phase.kind === 'preparing' ? phase.projectId : null;
  const clips = state.head?.model?.tracks.video.length ?? 0;
  const ready = Boolean(prepId && state.project?.id === prepId && (state.sampleReady.includes(prepId) || (clips > 0 && state.assets.length > 0 && state.assets.every((a) => a.status !== 'ingesting'))));
  useEffect(() => { if (ready) begin(); }, [ready, begin]);
  useEffect(() => {
    if (!prepId) return;
    const h = setInterval(() => { if (stateRef.current.project?.id === prepId) void actions.reloadState(); else void actions.openProject(prepId); }, 3000);
    return () => clearInterval(h);
  }, [prepId, actions]);

  // ── entering a step: make the target reachable, remember the trigger baseline ──
  useEffect(() => {
    if (!step) return;
    if (step.panel === 'lib' && prefs.libCollapsed) setPrefs({ libCollapsed: false });
    if (step.panel === 'agent' && prefs.agentCollapsed) setPrefs({ agentCollapsed: false });
    if (step.libMode && stateRef.current.libMode !== step.libMode) actions.setLibMode(step.libMode);
    base.current = step.signal ? step.signal(stateRef.current) : null;
    const el = document.querySelector(step.targets.map((t) => `[data-el="${t}"]`).join(', '));
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── triggers ──
  useEffect(() => {
    if (!step?.signal) return;
    if (advanced(base.current, step.signal(state))) next();
  }, [state, step, next]);
  useEffect(() => {
    if (!step?.click) return;
    const sel = `[data-el="${step.click}"]`;
    const on = (e: MouseEvent) => { if ((e.target as Element | null)?.closest?.(sel)) setTimeout(next, 0); };
    document.addEventListener('click', on, true);
    return () => document.removeEventListener('click', on, true);
  }, [step, next]);

  // ── FR-149: Esc skips the tour immediately at any step (§3 mechanics); modals handle their own Esc ──
  useEffect(() => {
    if (phase.kind === 'idle') return;
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || stateRef.current.screen) return;
      e.preventDefault(); e.stopImmediatePropagation();
      end();
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [phase.kind, end]);

  // ── spotlight geometry ──
  useEffect(() => { const on = () => bump((x) => x + 1); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  useLayoutEffect(() => {
    if (!step) { setRect(null); return; }
    const el = step.targets.map((t) => document.querySelector(`[data-el="${t}"]`)).find(Boolean);
    const r = el ? el.getBoundingClientRect() : null;
    setRect((prev) => (r && prev && r.x === prev.x && r.y === prev.y && r.width === prev.width && r.height === prev.height ? prev : r));
    if (card.current) setCardH(card.current.offsetHeight || 220);
  });

  if (phase.kind === 'idle') return null;
  if (phase.kind === 'step' && state.screen) return null;                 // a modal the Creator opened (e.g. Providers) takes over until closed

  const W = window.innerWidth, H = window.innerHeight, gap = 12, pad = 8;
  let top = H / 2 - cardH / 2, left = W / 2 - CARD_W / 2;
  if (phase.kind === 'step' && rect && rect.width > 0) {
    if (rect.height > H * 0.45) {
      top = Math.min(Math.max(16, rect.top), H - cardH - 16);
      left = rect.left - CARD_W - gap >= 16 ? rect.left - CARD_W - gap : Math.min(W - CARD_W - 16, rect.right + gap);
    } else {
      const below = rect.bottom + gap;
      top = below + cardH <= H - 16 ? below : Math.max(16, rect.top - cardH - gap);
      left = Math.min(Math.max(16, rect.left), W - CARD_W - 16);
    }
  }
  const overModal = phase.kind === 'done' && Boolean(state.screen);   // TOUR-8 opened Export: closing card sits beside it
  const style = overModal ? { right: 16, bottom: 16 } : { top, left };
  const provider = state.connections.some((c) => c.status === 'valid') && Boolean(state.assignments?.editor);
  const agentErr = n === BRAINSTORM ? state.agentError.brainstorm : n === EDITOR ? state.agentError.editor : null;
  const onCardKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === 'Enter' && phase.kind === 'step' && !['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) { e.preventDefault(); next(); }
  };
  const label = phase.kind === 'step' ? o('tour.step', { n: n + 1, title: o(`tour.${n + 1}.title`) }) : phase.kind === 'done' ? o('tour.done.title') : o('tour.title');

  return (
    <div className="pointer-events-none fixed inset-0 z-[70]">
      {!overModal && (phase.kind === 'step' && rect && rect.width > 0
        ? <div aria-hidden className="absolute rounded-[8px]" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad, boxShadow: '0 0 0 9999px var(--em-overlay)', outline: '2px solid var(--em-accent)' }} />
        : <div aria-hidden className="absolute inset-0" style={{ background: 'var(--em-overlay)' }} />)}
      <div ref={card} data-el="sys.tour" data-step={n >= 0 ? n + 1 : undefined} data-phase={phase.kind} role="dialog" aria-label={label} onKeyDown={onCardKey}
        className="pointer-events-auto absolute rounded-[8px] border border-em-line bg-em-panel p-3 text-em-text" style={{ ...style, width: CARD_W, boxShadow: 'var(--sh-2)' }}>
        {phase.kind === 'choose' && (
          <>
            <p className="mb-3 font-semibold">{o('tour.rerun.title')}</p>
            <div className="flex flex-wrap gap-2">
              <Button el="sys.tour.choice.current" size={28} autoFocus onClick={begin}>{o('tour.rerun.current')}</Button>
              <Button el="sys.tour.choice.sample" size={28} variant="primary" onClick={() => void startSample()}>{o('tour.rerun.sample')}</Button>
              <span className="flex-1" /><Button el="sys.tour.end" size={28} variant="ghost" onClick={end}>{o('tour.end')}</Button>
            </div>
          </>
        )}
        {phase.kind === 'preparing' && (
          phase.failed ? (
            <>
              <p className="mb-3">{o('tour.preparing.failed')}</p>
              <div className="flex gap-2"><Button size={28} variant="primary" autoFocus onClick={begin}>{o('tour.rerun.current')}</Button><span className="flex-1" /><Button el="sys.tour.end" size={28} variant="ghost" onClick={end}>{o('tour.end')}</Button></div>
            </>
          ) : (
            <div className="flex items-center gap-2" role="status"><Spinner label={o('tour.preparing')} /><span className="flex-1" /><Button el="sys.tour.end" size={28} variant="ghost" onClick={end}>{o('tour.end')}</Button></div>
          )
        )}
        {phase.kind === 'step' && (
          <>
            <div className="mb-1 flex items-center gap-2"><span className="flex-1 font-semibold">{o(`tour.${n + 1}.title`)}</span><span className="t-mono text-em-muted">{n + 1} / {TOUR_STEPS.length}</span></div>
            <p className="mb-2 text-em-text-2">{o(`tour.${n + 1}.body`)}</p>
            {n === BRAINSTORM && !provider && <p className="mb-2 text-em-muted">{o('tour.5.noprovider')}</p>}
            {n === EDITOR && (!provider || !state.plan || state.plan.status === 'cancelled') && (
              <div data-el="sys.tour.sampleplan" className="mb-2 rounded-[6px] border border-dashed border-em-accent p-2">
                <div className="t-label mb-0.5">{o('tour.6.sample.label')}</div>
                <div className="font-medium">{o('tour.6.sample.plan')}</div>
                {!provider && <div className="mt-1 text-[12px] text-em-muted">{o('tour.6.sample.note')}</div>}
              </div>
            )}
            {n === OUTPUT && state.settings?.privateMode && <p className="mb-2 text-em-warn">{o('tour.7.private.on')}</p>}
            {agentErr && <div className="mb-2"><ErrorBox code={agentErr} /></div>}
            {step?.tryIt && <p className="mb-2 text-[12px] text-em-accent">{o(`tour.${n + 1}.try`)}</p>}
            <div className="flex gap-2">
              <Button el="sys.tour.end" size={28} variant="ghost" onClick={end}>{o('tour.end')}</Button><span className="flex-1" />
              {n > 0 && <Button el="sys.tour.back" size={28} onClick={back}>{o('onb.back')}</Button>}
              <Button el="sys.tour.next" size={28} variant="primary" autoFocus onClick={next}>{o('onb.next')}</Button>
            </div>
          </>
        )}
        {phase.kind === 'done' && (
          <>
            <p className="mb-1 font-semibold">{o('tour.done.title')}</p>
            <p className="mb-3 text-em-text-2">{o('tour.done.body')}</p>
            <div className="flex flex-wrap gap-2">
              <Button el="sys.tour.done.keep" size={28} autoFocus onClick={end}>{o('tour.done.keep')}</Button>
              <Button el="sys.tour.done.own" size={28} variant="primary" onClick={() => { end(); actions.setScreen({ kind: 'project.new' }); }}>{o('tour.done.own')}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
