// Project lifecycle prompts and notices: Save / Don't save / Cancel before switching or closing with unsaved UI state (FR-174,
// scr.unsaved), "Cancel render and close / Keep rendering" when the window closes during an export (FR-002, scr.close.render,
// EM-8304), and the one-time restart recovery toast (FR-171, FR-172, R-003). The Composition is never at risk in these prompts:
// every Composition Version is stored when it is made (FR-173), and the copy says so.
import { useEffect, useRef } from 'react';
import { useStore, type Store } from '../state/store.js';
import type { Screen } from '../state/reducer.js';
import { Button, Modal } from '../components/ui.js';
import { translate } from '../i18n/index.js';

/** FR-174: run `next` at once, or after Save / Don't save when the open Project has unsaved UI state. */
export function guardUnsaved(store: Pick<Store, 'state' | 'actions'>, next: () => void, opts: { closing?: boolean } = {}): void {
  if (store.state.project?.dirty) store.actions.setScreen({ kind: 'unsaved', then: next, ...(opts.closing ? { closing: true } : {}) });
  else next();
}

export function UnsavedDialog({ screen, onClose }: { screen: Extract<Screen, { kind: 'unsaved' }>; onClose: () => void }) {
  const { state, actions, t } = useStore();
  const go = async (save: boolean) => { if (save) await actions.save(); onClose(); screen.then(); };
  return (
    <Modal el="scr.unsaved" width={460} title={t('ui.scr.unsaved.title', { name: state.project?.name ?? '' })} onClose={onClose}
      footer={<>
        <Button el="scr.unsaved.cancel" variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button>
        <Button el="scr.unsaved.discard" onClick={() => void go(false)}>{t('ui.scr.unsaved.discard')}</Button>
        <Button el="scr.unsaved.save" variant="primary" onClick={() => void go(true)}>{t('ui.common.save')}</Button>
      </>}>
      <p>{t(screen.closing ? 'ui.scr.unsaved.body.close' : 'ui.scr.unsaved.body')}</p>
      <p className="mt-2 text-[12px] text-em-muted">{t('ui.scr.unsaved.safe')}</p>
    </Modal>
  );
}

export function CloseRenderDialog({ screen, onClose }: { screen: Extract<Screen, { kind: 'close.render' }>; onClose: () => void }) {
  const { state, actions, t } = useStore();
  const job = state.renders.find((j) => j.id === screen.jobId);
  const cancelAndClose = async () => { await actions.cancelRender(screen.jobId); onClose(); screen.then(); };
  return (
    <Modal el="scr.close.render" width={460} title={t('err.EM-8304.title')} onClose={onClose}
      footer={<>
        <Button el="scr.close.render.cancel" variant="danger" onClick={() => void cancelAndClose()}>{t('ui.scr.close.render.cancel')}</Button>
        <Button el="scr.close.render.keep" variant="primary" onClick={onClose}>{t('ui.scr.close.render.keep')}</Button>
      </>}>
      <p>{t('err.EM-8304.body', { name: state.project?.name ?? '', percent: Math.round((job?.progress ?? 0) * 100) })}</p>
      <p className="t-mono mt-1 text-[11px] text-em-muted">EM-8304</p>
    </Modal>
  );
}

/** The close sequence after the Creator asked to close: unsaved prompt → running-render prompt → close for real. */
export function startCloseFlow(store: Pick<Store, 'state' | 'actions'>, closeNow: () => void): void {
  const job = store.state.renders.find((j) => j.status === 'rendering' || j.status === 'queued');
  const renderStep = () => { if (job) store.actions.setScreen({ kind: 'close.render', jobId: job.id, then: closeNow }); else closeNow(); };
  guardUnsaved(store, renderStep, { closing: true });
}

/** Lifecycle effects mounted once by App: window-close guard (Desktop Shell only) and the restart recovery toast. */
export function LifecycleEffects() {
  const store = useStore();
  const { state, actions, runtime } = store;
  const ref = useRef(store);
  ref.current = store;
  const allow = useRef(false);

  // FR-002 / FR-174: in the Desktop Shell, a window close with unsaved UI state or a running export is held (returnValue
  // silently cancels the close in Electron) and the in-app prompts run; their final step closes the window again.
  useEffect(() => {
    if (!window.expertmotion) return undefined;
    const closeNow = () => { allow.current = true; window.close(); };
    const needsPrompt = () => { const s = ref.current.state; return Boolean(s.project?.dirty) || s.renders.some((j) => j.status === 'rendering' || j.status === 'queued'); };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (allow.current || !needsPrompt()) return;
      e.preventDefault(); e.returnValue = '';
      if (ref.current.state.screen?.kind !== 'unsaved' && ref.current.state.screen?.kind !== 'close.render') startCloseFlow(ref.current, closeNow);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); };
  }, []);

  // FR-171 / FR-172: after the event stream (re)opens, ask what start-up recovery corrected and tell the Creator once per Service run.
  const open = state.boot === 'ready' && state.stream === 'open';
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void runtime.api.getRecovery().then((r) => {
      if (cancelled) return;
      const key = 'expertmotion.recovery.seen';
      let seen: string | null = null;
      try { seen = sessionStorage.getItem(key); } catch { /* storage blocked */ }
      if (seen === r.startedAt) return;
      try { sessionStorage.setItem(key, r.startedAt); } catch { /* storage blocked */ }
      const n = r.renders.length + r.agentRuns.length + r.ingests.length + r.plans.length;
      const s = ref.current.state;
      const checkpoint = !!s.project && r.checkpoints.offered.includes(s.project.id);
      // QA UX round 1: only when it matters — something was stopped, or this project has a newer automatic copy. A restart (or a
      // killed session) that stopped nothing says nothing (was "Service restarted · EM-8003" after every killed session).
      if (n === 0 && !checkpoint) return;
      const action = r.renders.length ? { labelKey: 'ui.sys.toast.recovered.renders', run: () => ref.current.actions.setScreen({ kind: 'export' }) }
        : checkpoint ? { labelKey: 'ui.sys.toast.recovered.checkpoint', run: () => ref.current.actions.setScreen({ kind: 'project.recover' }) }
          : undefined;
      const L = s.settings?.uiLanguage ?? 'en';
      const parts = ([['renders', r.renders.length], ['runs', r.agentRuns.length], ['imports', r.ingests.length], ['plans', r.plans.length]] as const)
        .filter(([, c]) => c > 0).map(([k, c]) => translate(L, `ui.sys.toast.recovered.part.${k}`, { n: c }));
      if (n === 0) actions.toast('info', 'ui.sys.toast.recovered.copy', undefined, action ? { action } : {});
      else actions.toast('warn', 'ui.sys.toast.recovered.plain', { list: parts.join(', ') }, { ...(action ? { action } : {}), sticky: action !== undefined });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, runtime, actions]);
  return null;
}
