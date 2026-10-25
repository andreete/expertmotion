// Output Settings (agent.output.*): Performance Profile, Aspect Ratio (+ Auto, Custom), Resolution with tier gating,
// Private Mode, Reset to Defaults (IX-18 … IX-20). Pixel sublabels come from PERFORMANCE.md §3 via resolveDimensions.
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleHelp, RotateCcw, ShieldCheck } from 'lucide-react';
import { resolveDimensions } from '@expertmotion/engine/formats';
import { RATIOS, RESOLUTIONS, aspectOf, type Ratio, type Resolution } from '@expertmotion/composition-model';
import { outputDefaults, useStore } from '../state/store.js';
import { Button, Popover, Segmented, Toggle, cx } from '../components/ui.js';
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
/** FR-087: the full PERFORMANCE §3 pixel table (computed, never hard-coded: FR-096), current resolution highlighted. */
function RatioHelp({ current, customRatio }: { current: Resolution; customRatio: { w: number; h: number } | undefined }) {
  const { t } = useStore();
  const [open, setOpen] = useState(false);
  const rows = RATIOS.filter((r) => r !== 'custom' || customRatio);
  return (
    <span className="relative inline-flex">
      <button type="button" data-el="agent.output.ratio.help" data-popover-trigger="" aria-expanded={open} aria-label={t('ui.agent.output.ratio.help')} title={t('ui.agent.output.ratio.help')}
        className="inline-flex cursor-help text-em-muted hover:text-em-text" onClick={() => setOpen((o) => !o)}><CircleHelp size={14} /></button>
      {open && (
        <Popover onClose={() => setOpen(false)} width={340} label={t('ui.agent.output.ratio.help.title')}>
          <p className="mb-1.5 text-[12px] text-em-text-2">{t('ui.agent.output.ratio.help')}</p>
          <table data-el="agent.output.ratio.help.table" className="t-mono w-full text-[11px]">
            <thead><tr className="text-em-muted"><th className="text-left font-normal">{t('ui.agent.output.ratio.help.ratio')}</th>{RESOLUTIONS.map((rs) => <th key={rs} className={cx('text-right font-normal', rs === current && 'text-em-accent')}>{RES_LABEL[rs]}</th>)}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r}><td>{r === 'custom' && customRatio ? `${customRatio.w}:${customRatio.h}` : r}</td>
                {RESOLUTIONS.map((rs) => { const d = resolveDimensions(r, rs, customRatio); return <td key={rs} className={cx('text-right', rs === current && 'text-em-accent')}>{d.width}×{d.height}</td>; })}</tr>
            ))}</tbody>
          </table>
        </Popover>
      )}
    </span>
  );
}
/** PERFORMANCE §2 in plain words: what each profile actually changes (shown in Help ▸ Performance profiles). */
export function ProfileTable() {
  const { t } = useStore();
  const rows = ['concurrency', 'preview', 'memory', 'availability'] as const;
  return (
    <table data-el="scr.help.performance.table" className="mt-1.5 w-full text-[11px]">
      <thead><tr className="text-em-muted"><th />{(['standard', 'accelerated', 'turbo'] as const).map((p) => <th key={p} className="text-left font-normal">{t(`ui.agent.output.profile.${p}`)}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r}><td className="pr-1 text-em-muted">{t(`ui.agent.output.profile.learn.${r}`)}</td>{(['standard', 'accelerated', 'turbo'] as const).map((p) => <td key={p}>{t(`ui.agent.output.profile.learn.${r}.${p}`)}</td>)}</tr>)}</tbody>
    </table>
  );
}
/** FR-091: the PERFORMANCE §2 tooltip copy verbatim, plus "Learn more", which opens the offline Help at Performance profiles. */
function ProfileHelp() {
  const { t, actions } = useStore();
  return (
    <span className="relative inline-flex items-center gap-1">
      <Help el="agent.output.profile.help" text={t('ui.agent.output.profile.help')} />
      <button type="button" data-el="agent.output.profile.help.learnmore" className="text-[11px] font-normal text-em-accent underline" onClick={() => actions.setScreen({ kind: 'help', topic: 'performance' })}>{t('ui.agent.output.profile.learnmore')}</button>
    </span>
  );
}
function Row({ label, help, right, children }: { label: string; help?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return <div className="flex flex-col gap-1.5"><div className="flex items-center gap-1.5 text-[12px] font-medium text-em-text-2">{label}{help}<span className="flex-1" />{right}</div>{children}</div>;
}

export function OutputSettings() {
  const { state, actions, t, prefs, setPrefs } = useStore();
  const open = !prefs.outputCollapsed;                                         // FR-099: collapsed state persisted with the layout
  const setOpen = (f: (o: boolean) => boolean) => setPrefs({ outputCollapsed: !f(open) });
  const s = state.head?.model?.settings ?? state.project?.settings;
  const tier = state.hardware?.tier ?? 'T0';
  const profile = state.performanceProfile;
  const ratio = s?.ratio ?? '16:9';
  const res = s?.resolution ?? '1080p';
  const noProject = !s;
  const dims = (r: Ratio, rs: Resolution) => { if (r === 'custom' && !s?.customRatio) return '—'; const d = resolveDimensions(r, rs, s?.customRatio); return `${d.width}×${d.height}`; };
  const profileReason = (p: PerformanceProfile) => (p === 'accelerated' && tier === 'T0') || (p === 'turbo' && tier === 'T0') ? t('ui.agent.output.profile.needsgpu') : null;
  const resReason = (r: Resolution) => (tier === 'T0' && (r === '2k' || r === '2160p') ? t('ui.agent.output.resolution.needsgpu') : null);
  const summary = `${ratio} · ${res} · ${t(`ui.agent.output.profile.${profile}`)}`;
  const auto = Boolean(s?.autoRatio);
  const hasClip = (state.head?.model?.tracks.video.length ?? 0) > 0;
  const defaults = outputDefaults(state);
  // FR-094: switching Private Mode on stops a running agent request or model download, so ask first.
  const busy = Boolean(state.streaming.brainstorm || state.streaming.editor) || state.plan?.status === 'draft' || state.models.some((m) => m.status === 'downloading' || m.status === 'verifying');
  const togglePrivate = (on: boolean) => {
    if (on && busy) actions.setScreen({ kind: 'confirm', titleKey: 'ui.agent.output.private.confirm.title', bodyKey: 'ui.agent.output.private.confirm.body', confirmKey: 'ui.agent.output.private.confirm.ok', danger: true, onConfirm: () => { void actions.setPrivateMode(true); } });
    else void actions.setPrivateMode(on);
  };
  return (
    <section data-el="agent.output" aria-label={t('ui.agent.output.title')} className="shrink-0 border-t border-em-line">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="t-label flex-1 text-left">{t('ui.agent.output.title')}</span>
        {!open && <span className="t-mono text-em-muted">{summary}</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          <Row label={t('ui.agent.output.profile')} help={<ProfileHelp />}>
            <Segmented<PerformanceProfile> label={t('ui.agent.output.profile')} value={profile} onChange={(p) => void actions.setProfile(p)}
              options={(['standard', 'accelerated', 'turbo'] as const).map((p) => ({ value: p, el: `agent.output.profile.${p}`, label: t(`ui.agent.output.profile.${p}`), sub: t(`ui.agent.output.profile.${p}.sub`), disabledReason: profileReason(p), warn: p === 'turbo' && tier === 'T1' ? t('ui.agent.output.profile.turbowarn') : null }))} />
          </Row>
          <Row label={t('ui.agent.output.ratio')} help={<RatioHelp current={res} customRatio={s?.customRatio} />}
            right={<span className="flex items-center gap-1 text-[11px]" title={t('ui.agent.output.ratio.auto.tooltip')}><span>{t('ui.agent.output.ratio.auto')}</span><Toggle el="agent.output.ratio.auto" label={t('ui.agent.output.ratio.auto')} checked={auto} onChange={(v) => void actions.setAutoRatio(v)} disabledReason={noProject ? t('ui.common.noproject') : null} /></span>}>
            {auto && !hasClip && <span data-el="agent.output.ratio.auto.hint" role="status" className="text-[11px] text-em-muted">{t('ui.agent.output.ratio.auto.armed')}</span>}
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
                value: r, el: `agent.output.resolution.${r}`, label: <span className="inline-flex items-center gap-0.5">{RES_LABEL[r]}</span>,
                sub: resReason(r) ?? dims(ratio, r), disabledReason: noProject ? t('ui.common.noproject') : resReason(r), warn: r === '2160p' && tier === 'T1' ? t('ui.agent.output.resolution.warn') : null,
              }))} />
            <button type="button" className="text-left text-[12px] text-em-text-2 hover:text-em-text" onClick={() => actions.setScreen({ kind: 'project.settings' })}>{t('ui.agent.output.fps', { fps: s?.fps ?? 30 })}</button>
          </Row>
          <div className="flex items-center gap-2">
            <span className={cx('flex items-center gap-1.5 text-[12px] font-medium', state.settings?.privateMode ? 'text-em-private' : 'text-em-text-2')}>{state.settings?.privateMode && <ShieldCheck size={14} />}{t('ui.agent.output.private')}</span>
            <Help el="agent.output.private.help" text={t('ui.agent.output.private.help')} />
            <span className="flex-1" />
            <Toggle el="agent.output.private" tone="private" label={t('ui.agent.output.private')} checked={Boolean(state.settings?.privateMode)} onChange={togglePrivate} />
          </div>
          <Button el="agent.output.reset" variant="ghost" icon={<RotateCcw size={14} />} disabledReason={noProject ? t('ui.common.noproject') : null}
            onClick={() => actions.setScreen({ kind: 'confirm', titleKey: 'ui.agent.output.reset', bodyKey: 'ui.modal.reset.output', vars: { ratio: defaults.ratio, resolution: RES_LABEL[defaults.resolution], profile: t('ui.agent.output.profile.standard') }, confirmKey: 'ui.agent.output.reset', onConfirm: () => { void actions.resetOutput(); } })}>
            {t('ui.agent.output.reset')}
          </Button>
        </div>
      )}
    </section>
  );
}
