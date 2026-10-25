// First-run wizard (scr.onboarding.*, ONBOARDING_TOUR.md §2; FR-004…FR-008). The 10-step in-app tour (§3) lives in Tour.tsx.
// The welcome step can switch onboarding + tour copy to Indonesian independently of the UI language (I18N-09).
// Steps: Welcome, Provider, Models, Hardware, Tour, Done; every step but Welcome can be skipped ("Lewati"). The Licence Key is
// activated before onboarding starts (licence screen, no Trial Mode), so there is no Licence step. The record
// {completed, skippedSteps[]} is stored server-side (settings.onboardingDone / onboardingSkippedSteps, R-171) and mirrored in
// prefs; the wizard can be resumed from Help ▸ Resume onboarding. Done opens scr.project.new prefilled "Untitled" (FR-008).
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useStore } from '../state/store.js';
import { Button, cx } from '../components/ui.js';
import { AssignForm, ConnectForm } from './Providers.js';
import type { OnboardingStep } from '../api/types.js';
import { formatBytes, translate, type Lang } from '../i18n/index.js';

const STEPS = ['welcome', 'provider', 'models', 'hardware', 'tour', 'done'] as const;
type Step = (typeof STEPS)[number];
const SKIPPABLE: readonly Step[] = ['provider', 'models', 'hardware'];
/** The progress indicator counts the five working steps; Done is the closing screen. */
const PROGRESS = STEPS.length - 1;

export function Onboarding({ onClose }: { onClose: () => void }) {
  const { state, prefs, setPrefs, actions, runtime, dispatch } = useStore();
  const [step, setStep] = useState(Math.min(prefs.onboardingStep, STEPS.length - 1));
  const [providerDone, setProviderDone] = useState(state.connections.some((c) => c.status === 'valid'));
  const [skipped, setSkipped] = useState<OnboardingStep[]>(state.settings?.onboardingSkippedSteps ?? []);
  const [checking, setChecking] = useState(false);
  const ol: Lang = prefs.onboardingLang;
  const o = (k: string, v?: Record<string, string | number>) => translate(ol, k, v);
  const go = (n: number) => { setStep(n); setPrefs({ onboardingStep: n }); };
  const skip = (...ids: OnboardingStep[]) => { const next = [...new Set([...skipped, ...ids])]; setSkipped(next); return next; };
  const record = (skippedSteps: OnboardingStep[]) => { void actions.putSettings({ onboardingDone: true, onboardingSkippedSteps: skippedSteps }); setPrefs({ onboardingDone: true, onboardingStep: 0 }); };
  /** Done (or "Skip setup"): record completion, then the tour on the sample project or the New dialog prefilled "Untitled". */
  const finish = (tour: boolean, skippedSteps: OnboardingStep[] = skipped) => {
    record(skippedSteps);
    onClose();
    if (tour) window.dispatchEvent(new CustomEvent('em:tour', { detail: { source: 'onboarding' } }));
    else actions.setScreen({ kind: 'project.new' });
  };
  const id = STEPS[step]!;
  const hw = state.hardware, tick = state.tick;
  // FR-006: the Hardware step shows free disk too; pull one live reading when it opens.
  useEffect(() => {
    if (id !== 'hardware' || tick) return;
    void runtime.api.hardwareLive().then((x) => dispatch({ type: 'tick', tick: x })).catch(() => undefined);
  }, [id, tick, runtime, dispatch]);
  const recheck = async () => {
    setChecking(true);
    try {
      const [profile, live] = await Promise.all([runtime.api.refreshHardware(), runtime.api.hardwareLive().catch(() => null)]);
      dispatch({ type: 'globals', hardware: profile });
      if (live) dispatch({ type: 'tick', tick: live });
    } catch (e) { actions.error(e); } finally { setChecking(false); }
  };
  const ramGb = Math.round((hw?.ramTotalMb ?? 0) / 1024);
  return (
    <div data-el="scr.onboarding" role="dialog" aria-modal="true" aria-labelledby="onb-title" className="fixed inset-0 z-[65] overflow-auto bg-em-bg">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col gap-4 px-6 py-10">
        <div className="flex items-center gap-3">
          <ol className="flex flex-1 gap-1" aria-label={o('onb.progress', { n: Math.min(step + 1, PROGRESS), total: PROGRESS })}>
            {STEPS.slice(0, PROGRESS).map((s, i) => <li key={s} className={cx('h-1 flex-1 rounded-full', i <= step ? 'bg-em-accent' : 'bg-em-panel-2')} aria-current={i === step ? 'step' : undefined} />)}
          </ol>
          <span className="t-mono text-em-muted">{Math.min(step + 1, PROGRESS)} / {PROGRESS}</span>
          {SKIPPABLE.includes(id) && <Button el="scr.onboarding.skip" variant="ghost" size={28} onClick={() => { skip(id as OnboardingStep); go(step + 1); }}>{o('onb.skip.step')}</Button>}
          {step >= 1 && id !== 'done' && <Button variant="ghost" size={28} onClick={() => finish(false, skip(...STEPS.slice(step, PROGRESS).filter((s): s is OnboardingStep => s !== 'welcome')))}>{o('onb.skip')}</Button>}
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
          {id === 'provider' && (
            <>
              {/* FR-007: the add-connection flow of the Providers screen, OpenRouter preselected; a valid key advances. */}
              <ConnectForm onConnected={(ok) => { setProviderDone(ok); if (ok) go(STEPS.indexOf('models')); }} />
              <div className="flex gap-2">
                <Button variant="primary" disabledReason={providerDone ? null : o('onb.provider.validatefirst')} onClick={() => go(STEPS.indexOf('models'))}>{o('onb.next')}</Button>
                <Button variant="ghost" onClick={() => { skip('provider', 'models'); go(STEPS.indexOf('hardware')); }}>{o('onb.provider.skip')}</Button>
              </div>
              <p data-el="scr.onboarding.provider.consequence" className="text-[12px] text-em-muted">{o('onb.provider.skip.consequence')}</p>
            </>
          )}
          {id === 'models' && (
            <>
              {providerDone ? <AssignForm onSaved={() => go(STEPS.indexOf('hardware'))} /> : <p className="text-em-muted">{o('onb.models.skipped')}</p>}
              <Button variant="ghost" onClick={() => go(STEPS.indexOf('hardware'))}>{o('onb.models.defaults')}</Button>
            </>
          )}
          {id === 'hardware' && (
            <>
              <div className="rounded-[8px] border border-em-line p-3">
                <div className="font-semibold">{o('onb.hardware.card', { tier: hw?.tier ?? 'T0', ram: ramGb, gpu: hw?.gpuModel ?? o('onb.hardware.nogpu') })}</div>
                <div data-el="scr.onboarding.hardware.disk" className="text-em-text-2">{o('onb.hardware.disk', { free: tick?.diskFreeMb != null ? formatBytes(tick.diskFreeMb * 1048576, ol) : '—' })}</div>
                <div className="text-em-text-2">{o(`onb.hardware.${hw?.tier ?? 'T0'}`)}</div>
                {hw && hw.ramTotalMb < 8192 && <div className="mt-1 text-em-warn">{o('err.EM-8305.body', { ram: ramGb })} <span className="t-mono text-[11px]">EM-8305</span></div>}
                {hw && !hw.gpuModel && <div className="mt-1 text-em-warn">{o('err.EM-3402.body')} <span className="t-mono text-[11px]">EM-3402</span></div>}
                {tick?.diskFreeMb != null && tick.diskFreeMb < 10_240 && <div className="mt-1 text-em-warn">{o('onb.hardware.lowdisk')}</div>}
              </div>
              <p className="text-[12px] text-em-muted">{o('onb.hardware.later')}</p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => go(STEPS.indexOf('tour'))}>{o('onb.next')}</Button>
                <Button el="scr.onboarding.hardware.recheck" icon={<RefreshCw size={14} />} loading={checking} onClick={() => void recheck()}>{o('onb.hardware.recheck')}</Button>
              </div>
            </>
          )}
          {id === 'tour' && (
            <div className="flex gap-2">
              <Button variant="primary" size={36} onClick={() => finish(true)}>{o('onb.tour.start')}</Button>
              <Button variant="ghost" onClick={() => { skip('tour'); go(STEPS.indexOf('done')); }}>{o('onb.tour.skip')}</Button>
            </div>
          )}
          {id === 'done' && (
            <div className="flex flex-col gap-2">
              {skipped.length > 0 && <p className="text-[12px] text-em-muted">{o('onb.done.skipped', { steps: skipped.map((s) => o(`onb.${s}.title`)).join(', ') })}</p>}
              <div><Button el="scr.onboarding.done.open" variant="primary" size={36} onClick={() => finish(false)}>{o('onb.done.open')}</Button></div>
            </div>
          )}
        </section>
        {step > 0 && <div><Button variant="ghost" size={28} onClick={() => go(step - 1)}>{o('onb.back')}</Button></div>}
      </div>
    </div>
  );
}
