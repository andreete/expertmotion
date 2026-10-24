// First-run wizard (scr.onboarding.*, ONBOARDING_TOUR.md §2). The 10-step in-app tour (§3) lives in Tour.tsx.
// The welcome step can switch onboarding + tour copy to Indonesian independently of the UI language (I18N-09).
import { useState } from 'react';
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
    if (tour) window.dispatchEvent(new CustomEvent('em:tour', { detail: { source: 'onboarding' } }));
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
