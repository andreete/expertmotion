// QA UX round 1 (P1-6): every screen / dialog shows its own errors inline, with what happened and the next action. An error or
// warning toast raised while a screen is open is moved into the screen (and leaves the toast stack, so it is never shown twice);
// it stays until the Creator dismisses it, takes its action, or closes the screen. Rendered by Modal and by the onboarding screen.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useStoreOptional } from '../state/store.js';
import type { Toast } from '../state/reducer.js';
import { toastActionFor, toastBodyOf } from '../state/toast-actions.js';

/** The topmost mounted ScreenErrors owns new errors (a confirm over a dialog takes them, the dialog under it does not). */
const OWNERS: object[] = [];

export function ScreenErrors({ el = 'sys.screen.error' }: { el?: string }) {
  const store = useStoreOptional();
  const [items, setItems] = useState<Toast[]>([]);
  const seen = useRef<Set<string> | null>(null);
  const me = useRef({});
  useEffect(() => { const m = me.current; OWNERS.push(m); return () => { const i = OWNERS.indexOf(m); if (i >= 0) OWNERS.splice(i, 1); }; }, []);
  const toasts = store?.state.toasts;
  useEffect(() => {
    if (!store || !toasts) return;
    if (seen.current === null) { seen.current = new Set(toasts.map((x) => x.id)); return; }   // only errors raised while the screen is open
    const fresh = toasts.filter((x) => !seen.current!.has(x.id) && (x.kind === 'danger' || x.kind === 'warn'));
    for (const x of toasts) seen.current.add(x.id);
    if (!fresh.length || OWNERS[OWNERS.length - 1] !== me.current) return;
    setItems((cur) => [...cur.filter((c) => !fresh.some((f) => f.code && f.code === c.code)), ...fresh].slice(-3));
    for (const f of fresh) store.dispatch({ type: 'dismissToast', id: f.id });
  }, [toasts, store]);
  if (!store || !items.length) return null;
  const { t, lang, actions } = store;
  const drop = (id: string) => setItems((cur) => cur.filter((c) => c.id !== id));
  return (
    <div className="mb-2 flex flex-col gap-1">
      {items.map((x) => {
        const body = toastBodyOf(x, lang);
        const fallback = x.action ? null : x.code ? toastActionFor(x.code, lang) : null;
        return (
          <div key={x.id} data-el={el} data-code={x.code} role="alert" className={x.kind === 'danger' ? 'flex items-start gap-2 rounded-[8px] border border-em-danger/60 bg-em-danger/10 px-3 py-2' : 'flex items-start gap-2 rounded-[8px] border border-em-warn/60 bg-em-warn/10 px-3 py-2'}>
            <AlertTriangle size={16} className={x.kind === 'danger' ? 'mt-0.5 shrink-0 text-em-danger' : 'mt-0.5 shrink-0 text-em-warn'} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{t(x.textKey, x.vars)}</div>
              {body && <div className="text-[12px] text-em-text-2">{body}</div>}
              {x.code && <div className="t-mono text-[11px] text-em-muted select-all">{x.code}</div>}
            </div>
            {x.action && <button type="button" data-el={`${el}.action`} className="shrink-0 font-semibold text-em-accent" onClick={() => { x.action!.run(); drop(x.id); }}>{t(x.action.labelKey)}</button>}
            {fallback && fallback.label && fallback.step.kind !== 'dismiss' && (
              <button type="button" data-el={`${el}.action`} data-step={fallback.step.kind} className="shrink-0 font-semibold text-em-accent" onClick={() => {
                const st = fallback.step;
                if (st.kind === 'screen') actions.setScreen(st.screen); else if (st.kind === 'privateOff') void actions.setPrivateMode(false); else if (st.kind === 'reload') window.location.reload();
                drop(x.id);
              }}>{fallback.label}</button>
            )}
            <button type="button" aria-label={t('ui.common.dismiss')} className="shrink-0 text-em-muted" onClick={() => drop(x.id)}><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
