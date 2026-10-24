// First-run wizard (scr.onboarding.*, ONBOARDING_TOUR.md §2) and the 10-step in-app tour (§3).
// The welcome step can switch onboarding + tour copy to Indonesian independently of the UI language (I18N-09).
import { useEffect, useLayoutEffect, useState } from 'react';
import { useStore } from '../state/store.js';
import { Button, cx } from '../components/ui.js';
import { LicenseForm } from './License.js';
import { AssignForm, ConnectForm } from './Providers.js';
import { translate, type Lang } from '../i18n/index.js';

const STEPS = ['welcome', 'license', 'provider', 'models', 'hardware', 'tour'] as const;

export function Onboarding({ onClose }: { onClose: () => void }) {
  const { state, prefs, setPrefs, actions } = useStore();
  const [step, setStep] = useState(Math.min(prefs.onboardingStep, STEPS.length - 1));
  const [providerDone, setProviderDone] = useState(state.connections.some((c) => c.status === 'valid'));
  const ol: Lang = prefs.onboardingLang;
  const o = (k: string, v?: Record<string, string | number>) => translate(ol, k, v);
  const go = (n: number) => { setStep(n); setPrefs({ onboardingStep: n }); };
  const finish = (tour: boolean) => {
    setPrefs({ onboardingDone: true, onboardingStep: 0 });
    onClose();
    if (tour) window.dispatchEvent(new CustomEvent('em:tour'));
    else if (!state.project) void actions.createProject({ name: translate(state.settings?.uiLanguage ?? 'en', 'ui.hdr.title.untitled') });
  };
  const id = STEPS[step]!;
  const hw = state.hardware;
  return (
    <div data-el="scr.onboarding" role="dialog" aria-modal="true" aria-labelledby="onb-title" className="fixed inset-0 z-[65] overflow-auto bg-em-bg">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col gap-4 px-6 py-10">
        <div className="flex items-center gap-3">
          <ol className="flex flex-1 gap-1" aria-label={o('onb.progress', { n: step + 1, total: STEPS.length })}>
            {STEPS.map((s, i) => <li key={s} className={cx('h-1 flex-1 rounded-full', i <= step ? 'bg-em-accent' : 'bg-em-panel-2')} aria-current={i === step ? 'step' : undefined} />)}
          </ol>
          <span className="t-mono text-em-muted">{step + 1} / {STEPS.length}</span>
          {step >= 1 && <Button variant="ghost" size={28} onClick={() => finish(false)}>{o('onb.skip')}</Button>}
        </div>
        <section data-el={`scr.onboarding.${id}`} className="flex flex-col gap-3">
          <h1 id="onb-title" className={cx('font-bold', step === 0 ? 'text-[24px] leading-8' : 'text-[20px] leading-7')}>{o(`onb.${id}.title`)}</h1>
          <p className="text-[14px] text-em-text-2">{o(`onb.${id}.body`)}</p>
          {id === 'welcome' && (
            <>
              <div className="flex items-center gap-3">
                <Button variant="primary" size={36} onClick={() => go(1)}>{o('onb.welcome.start')}</Button>
                <button type="button" className="text-em-accent underline" onClick={() => setPrefs({ onboardingLang: ol === 'en' ? 'id' : 'en' })}>{ol === 'en' ? 'Bahasa Indonesia' : 'English'}</button>
              </div>
              <p className="text-[12px] text-em-muted">{o('onb.welcome.footnote')}</p>
            </>
          )}
          {id === 'license' && <LicenseForm compact onDone={() => go(2)} />}
          {id === 'provider' && (
            <>
              <ConnectForm onConnected={(ok) => setProviderDone(ok)} />
              <div className="flex gap-2">
                <Button variant="primary" disabledReason={providerDone ? null : o('onb.provider.validatefirst')} onClick={() => go(3)}>{o('onb.next')}</Button>
                <Button variant="ghost" onClick={() => go(4)}>{o('onb.provider.skip')}</Button>
              </div>
            </>
          )}
          {id === 'models' && (
            <>
              {providerDone ? <AssignForm onSaved={() => go(4)} /> : <p className="text-em-muted">{o('onb.models.skipped')}</p>}
              <Button variant="ghost" onClick={() => go(4)}>{o('onb.models.defaults')}</Button>
            </>
          )}
          {id === 'hardware' && (
            <>
              <div className="rounded-[8px] border border-em-line p-3">
                <div className="font-semibold">{o('onb.hardware.card', { tier: hw?.tier ?? 'T0', ram: Math.round((hw?.ramTotalMb ?? 0) / 1024), gpu: hw?.gpuModel ?? o('onb.hardware.nogpu') })}</div>
                <div className="text-em-text-2">{o(`onb.hardware.${hw?.tier ?? 'T0'}`)}</div>
                {hw && hw.ramTotalMb < 8192 && <div className="mt-1 text-em-warn">{o('onb.hardware.lowram')}</div>}
              </div>
              <p className="text-[12px] text-em-muted">{o('onb.hardware.later')}</p>
              <Button variant="primary" onClick={() => go(5)}>{o('onb.next')}</Button>
            </>
          )}
          {id === 'tour' && (
            <div data-el="scr.onboarding.done" className="flex gap-2">
              <Button variant="primary" size={36} onClick={() => finish(true)}>{o('onb.tour.start')}</Button>
              <Button variant="ghost" onClick={() => finish(false)}>{o('onb.tour.skip')}</Button>
            </div>
          )}
        </section>
        {step > 0 && <div><Button variant="ghost" size={28} onClick={() => go(step - 1)}>{o('onb.back')}</Button></div>}
      </div>
    </div>
  );
}

const TOUR: Array<{ target: string }> = [
  { target: 'hdr.menu.design' }, { target: 'lib.assets.panel' }, { target: 'lib.catalogue.card' }, { target: 'agent.editor.intentqueue' }, { target: 'stage.timeline' },
  { target: 'agent.brainstorm.composer' }, { target: 'agent.editor.panel' }, { target: 'agent.output' }, { target: 'agent.output.private' }, { target: 'hdr.action.export' },
];

export function Tour() {
  const { prefs, setPrefs, actions, state } = useStore();
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const o = (k: string, v?: Record<string, string | number>) => translate(prefs.onboardingLang, k, v);
  useEffect(() => {
    const start = () => { actions.setLibMode('design'); setStep(0); };
    window.addEventListener('em:tour', start);
    return () => window.removeEventListener('em:tour', start);
  }, [actions]);
  useLayoutEffect(() => {
    if (step === null) return;
    const el = document.querySelector(`[data-el="${TOUR[step]!.target}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step, state.libMode]);
  if (step === null) return null;
  const end = () => { setStep(null); setPrefs({ tourDone: true }); };
  const n = step + 1;
  const done = step >= TOUR.length;
  const pad = 8;
  const cardTop = rect ? Math.min(window.innerHeight - 220, rect.bottom + 12) : window.innerHeight / 2 - 100;
  const cardLeft = rect ? Math.max(16, Math.min(window.innerWidth - 336, rect.left)) : window.innerWidth / 2 - 160;
  return (
    <div className="fixed inset-0 z-[70]" onKeyDown={(e) => { if (e.key === 'Escape') end(); if (e.key === 'Enter') setStep(step + 1); }}>
      {rect && !done && <div aria-hidden className="pointer-events-none absolute rounded-[8px]" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad, boxShadow: '0 0 0 9999px var(--em-overlay)' }} />}
      {(!rect || done) && <div aria-hidden className="absolute inset-0" style={{ background: 'var(--em-overlay)' }} />}
      <div role="dialog" aria-label={done ? o('tour.done.title') : o('tour.step', { n, title: o(`tour.${n}.title`) })} className="absolute w-80 rounded-[8px] border border-em-line bg-em-panel p-3" style={{ top: cardTop, left: cardLeft, boxShadow: 'var(--sh-2)' }}>
        {done ? (
          <>
            <p className="mb-3">{o('tour.done.body')}</p>
            <div className="flex gap-2"><Button size={28} onClick={end}>{o('tour.done.keep')}</Button><Button size={28} variant="primary" onClick={() => { end(); actions.setScreen({ kind: 'project.new' }); }}>{o('tour.done.own')}</Button></div>
          </>
        ) : (
          <>
            <div className="mb-1 flex items-center gap-2"><span className="flex-1 font-semibold">{o(`tour.${n}.title`)}</span><span className="t-mono text-em-muted">{n} / {TOUR.length}</span></div>
            <p className="mb-3 text-em-text-2">{o(`tour.${n}.body`)}</p>
            <div className="flex gap-2">
              <Button size={28} variant="ghost" onClick={end}>{o('tour.end')}</Button><span className="flex-1" />
              {step > 0 && <Button size={28} onClick={() => setStep(step - 1)}>{o('onb.back')}</Button>}
              <Button size={28} variant="primary" autoFocus onClick={() => setStep(step + 1)}>{o('onb.next')}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
