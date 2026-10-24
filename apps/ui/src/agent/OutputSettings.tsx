// Output Settings (agent.output.*): Performance Profile, Aspect Ratio (+ Auto, Custom), Resolution with tier gating,
// Private Mode, Reset to Defaults (IX-18 … IX-20). Pixel sublabels come from PERFORMANCE.md §3 via resolveDimensions.
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleHelp, Lock, RotateCcw, ShieldCheck } from 'lucide-react';
import { resolveDimensions } from '@expertmotion/engine/formats';
import { RATIOS, RESOLUTIONS, aspectOf, type Ratio, type Resolution } from '@expertmotion/composition-model';
import { useStore } from '../state/store.js';
import { Button, Segmented, Toggle, cx } from '../components/ui.js';
import type { PerformanceProfile } from '../api/types.js';

const RES_LABEL: Record<Resolution, string> = { '720p': '720p', '1080p': '1080p', '2k': '2K', '2160p': '2160p (4K)' };

function Glyph({ ratio, custom }: { ratio: Ratio; custom?: { w: number; h: number } }) {
  const a = ratio === 'custom' && !custom ? 1 : aspectOf(ratio, custom);
  const w = a >= 1 ? 18 : Math.round(18 * a), h = a >= 1 ? Math.round(18 / a) : 18;
  return <span aria-hidden className={cx('mb-0.5 inline-block border-[1.5px] border-current', ratio === 'custom' && 'border-dashed')} style={{ width: w, height: h }} />;
}
function Help({ el, text }: { el: string; text: string }) {
  return <span data-el={el} tabIndex={0} role="img" aria-label={text} title={text} className="inline-flex cursor-help text-em-muted"><CircleHelp size={14} /></span>;
}
function Row({ label, help, right, children }: { label: string; help?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return <div className="flex flex-col gap-1.5"><div className="flex items-center gap-1.5 text-[12px] font-medium text-em-text-2">{label}{help}<span className="flex-1" />{right}</div>{children}</div>;
}

export function OutputSettings() {
  const { state, actions, t } = useStore();
  const [open, setOpen] = useState(true);
  const s = state.head?.model?.settings ?? state.project?.settings;
  const tier = state.hardware?.tier ?? 'T0';
  const trial = state.licence?.status !== 'active';
  const profile = state.performanceProfile;
  const ratio = s?.ratio ?? '16:9';
  const res = s?.resolution ?? '1080p';
  const noProject = !s;
  const dims = (r: Ratio, rs: Resolution) => { if (r === 'custom' && !s?.customRatio) return '—'; const d = resolveDimensions(r, rs, s?.customRatio); return `${d.width}×${d.height}`; };
  const profileReason = (p: PerformanceProfile) => (p === 'accelerated' && tier === 'T0') || (p === 'turbo' && tier === 'T0') ? t('ui.agent.output.profile.needsgpu') : null;
  const resReason = (r: Resolution) => (tier === 'T0' && (r === '2k' || r === '2160p') ? t('ui.agent.output.resolution.needsgpu') : null);
  const summary = `${ratio} · ${res} · ${t(`ui.agent.output.profile.${profile}`)}`;
  return (
    <section data-el="agent.output" aria-label={t('ui.agent.output.title')} className="shrink-0 border-t border-em-line">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="t-label flex-1 text-left">{t('ui.agent.output.title')}</span>
        {!open && <span className="t-mono text-em-muted">{summary}</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          <Row label={t('ui.agent.output.profile')} help={<Help el="agent.output.profile.help" text={t('ui.agent.output.profile.help')} />}>
            <Segmented<PerformanceProfile> label={t('ui.agent.output.profile')} value={profile} onChange={(p) => void actions.setProfile(p)}
              options={(['standard', 'accelerated', 'turbo'] as const).map((p) => ({ value: p, el: `agent.output.profile.${p}`, label: t(`ui.agent.output.profile.${p}`), sub: t(`ui.agent.output.profile.${p}.sub`), disabledReason: profileReason(p), warn: p === 'turbo' && tier === 'T1' ? t('ui.agent.output.profile.turbowarn') : null }))} />
          </Row>
          <Row label={t('ui.agent.output.ratio')} help={<Help el="agent.output.ratio.help" text={t('ui.agent.output.ratio.help')} />}
            right={<span className="flex items-center gap-1 text-[11px]" title={t('ui.agent.output.ratio.auto.tooltip')}><span>{t('ui.agent.output.ratio.auto')}</span><Toggle el="agent.output.ratio.auto" label={t('ui.agent.output.ratio.auto')} checked={Boolean(s?.autoRatio)} onChange={(v) => void actions.setAutoRatio(v)} disabledReason={noProject ? t('ui.common.noproject') : null} /></span>}>
            <Segmented<Ratio> label={t('a11y.agent.output.ratio')} cols={4} value={s ? ratio : null}
              onChange={(r) => { if (r === 'custom') actions.setScreen({ kind: 'ratio.custom' }); else void actions.layoutPick({ ratio: r }); }}
              options={RATIOS.map((r) => ({
                value: r, el: `agent.output.ratio.${r === 'custom' ? 'custom' : r.replace(':', 'x')}`, label: r === 'custom' ? t('ui.agent.output.ratio.custom') : r, sub: dims(r, res), glyph: <Glyph ratio={r} {...(s?.customRatio ? { custom: s.customRatio } : {})} />,
                aria: r === 'custom' ? t('ui.agent.output.ratio.custom') : t('a11y.agent.output.ratio.option', { w: r.split(':')[0] ?? '', h: r.split(':')[1] ?? '', px: dims(r, res) }), disabledReason: noProject ? t('ui.common.noproject') : null,
              }))} />
          </Row>
          <Row label={t('ui.agent.output.resolution')}>
            <Segmented<Resolution> label={t('ui.agent.output.resolution')} value={s ? res : null} onChange={(r) => void actions.layoutPick({ resolution: r })}
              options={RESOLUTIONS.map((r) => ({
                value: r, el: `agent.output.resolution.${r}`, label: <span className="inline-flex items-center gap-0.5">{trial && r !== '720p' && <Lock size={10} aria-label={t('ui.agent.output.resolution.trial')} />}{RES_LABEL[r]}</span>,
                sub: resReason(r) ?? dims(ratio, r), disabledReason: noProject ? t('ui.common.noproject') : resReason(r), warn: r === '2160p' && tier === 'T1' ? t('ui.agent.output.resolution.warn') : trial && r !== '720p' ? t('ui.agent.output.resolution.trial') : null,
              }))} />
            <button type="button" className="text-left text-[12px] text-em-text-2 hover:text-em-text" onClick={() => actions.setScreen({ kind: 'project.settings' })}>{t('ui.agent.output.fps', { fps: s?.fps ?? 30 })}</button>
          </Row>
          <div className="flex items-center gap-2">
            <span className={cx('flex items-center gap-1.5 text-[12px] font-medium', state.settings?.privateMode ? 'text-em-private' : 'text-em-text-2')}>{state.settings?.privateMode && <ShieldCheck size={14} />}{t('ui.agent.output.private')}</span>
            <Help el="agent.output.private.help" text={t('ui.agent.output.private.help')} />
            <span className="flex-1" />
            <Toggle el="agent.output.private" tone="private" label={t('ui.agent.output.private')} checked={Boolean(state.settings?.privateMode)} onChange={(v) => void actions.setPrivateMode(v)} />
          </div>
          <Button el="agent.output.reset" variant="ghost" icon={<RotateCcw size={14} />} disabledReason={noProject ? t('ui.common.noproject') : null}
            onClick={() => actions.setScreen({ kind: 'confirm', titleKey: 'ui.agent.output.reset', bodyKey: 'ui.modal.reset.output', vars: { ratio: '16:9', resolution: '1080p', profile: t('ui.agent.output.profile.standard') }, confirmKey: 'ui.agent.output.reset', onConfirm: () => { void actions.resetOutput(); } })}>
            {t('ui.agent.output.reset')}
          </Button>
        </div>
      )}
    </section>
  );
}
