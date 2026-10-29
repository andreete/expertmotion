// Export dialog (scr.export): setup with preflight (R-110), start (R-111), progress/ETA/elapsed via SSE, cancel (R-114), done with
// thumbnail, Open folder (R-119 + Shell revealPath), Play, Copy path. IX-21, USER_FLOWS F8, FR-136…FR-147, FR-163.
import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Info, Play, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { useStore, currentOutputProfile } from '../state/store.js';
import type { OutputProfile, PreflightCheckName, RenderEstimate } from '../api/types.js';
import { Button, ErrorBox, Field, Modal, Progress, Segmented, inputCls } from '../components/ui.js';
import { formatBytes, formatDuration } from '../i18n/index.js';
import { copyText } from '../api/client.js';
import { RATIOS, RESOLUTIONS, type Ratio, type Resolution } from '@expertmotion/composition-model';

const RES_LABEL: Record<Resolution, string> = { '720p': '720p', '1080p': '1080p', '2k': '2K', '2160p': '2160p (4K)' };

type Format = 'mp4' | 'webm' | 'gif' | 'png';
/** FR-138: WebM with alpha (VP9 + PNG frames) only when the Composition has no background or `preset:background.none`. */
export function alphaAllowed(model: { background?: { presetId: string } | null } | null | undefined): boolean {
  return !model?.background || model.background.presetId === 'preset:background.none';
}
/** FR-138: Standard = CRF 18, Smaller = CRF 23 (H.264, AAC 192 kbps). */
export const QUALITY_CRF = { standard: 18, smaller: 23 } as const;
export type Quality = keyof typeof QUALITY_CRF;
export type Recovery = 'folder' | 'standard' | 'settings' | 'assets' | 'diagnostics' | 'license' | 'progress' | 'recheck';

/** FR-139: the recovery button of a failed or noted preflight check (label = the ERROR_CATALOGUE action copy). */
export function recoveryFor(c: { check: PreflightCheckName; ok: boolean; code?: string }, profile: string): Recovery | null {
  if (!c.code) return null;
  switch (c.code) {
    case 'EM-3102': case 'EM-3206': case 'EM-8302': return 'folder';
    case 'EM-3101': return profile !== 'standard' ? 'standard' : 'recheck';
    case 'EM-3103': return 'settings';
    case 'EM-2202': case 'EM-1301': return 'assets';
    case 'EM-3001': case 'EM-3003': return 'diagnostics';
    case 'EM-5010': return 'license';
    case 'EM-3208': return 'progress';
    default: return c.ok ? null : 'recheck';
  }
}
const RECOVERY_LABEL: Record<Recovery, string> = {
  folder: 'ui.scr.export.fix.folder', standard: 'ui.scr.export.fix.standard', settings: 'ui.scr.export.fix.settings', assets: 'ui.scr.export.fix.assets',
  diagnostics: 'ui.scr.export.fix.diagnostics', license: 'ui.scr.export.fix.license', progress: 'ui.scr.export.fix.progress', recheck: 'ui.scr.export.recheck',
};

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  const [format, setFormat] = useState<Format>('mp4');
  const [quality, setQuality] = useState<Quality>('standard');
  const [fileName, setFileName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [folder, setFolder] = useState(state.settings?.outputFolder ?? '');
  const [stillMs, setStillMs] = useState(state.playheadMs);
  const [est, setEst] = useState<RenderEstimate | null>(null);
  const [recheck, setRecheck] = useState(0);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [jobId, setJobId] = useState<string | null>(state.renders.find((j) => j.status === 'rendering' || j.status === 'queued')?.id ?? null);
  const job = state.renders.find((j) => j.id === jobId) ?? null;
  const output = job?.outputId ? state.outputs.find((o) => o.id === job.outputId) : undefined;
  const durationMs = state.head?.durationMs ?? 0;
  const alphaOk = alphaAllowed(state.head?.model as { background?: { presetId: string } | null } | undefined);
  useEffect(() => { if (format === 'webm' && !alphaOk) setFormat('mp4'); }, [format, alphaOk]);
  const profile: OutputProfile = { ...currentOutputProfile(state), format, codec: format === 'mp4' ? 'h264' : format === 'webm' ? 'vp9' : format,
    ...(format === 'mp4' || format === 'webm' ? { crf: QUALITY_CRF[quality] } : {}), ...(format === 'webm' ? { alpha: true } : {}),
    ...(format === 'png' ? { stillAtMs: Math.max(0, Math.min(stillMs, Math.max(0, durationMs - 1))) } : {}) };
  const name = nameTouched ? fileName : (est?.defaultFileName ?? fileName);
  const body = { outputProfile: profile, performanceProfile: state.performanceProfile, ...(nameTouched && fileName.trim() ? { fileName: fileName.trim() } : {}), ...(folder ? { folder } : {}) };
  const priv = est?.privateMode ?? Boolean(state.settings?.privateMode);
  const tierT0 = (state.hardware?.tier ?? 'T0') === 'T0';

  useEffect(() => {
    if (!state.project || jobId) return;
    let alive = true;
    setEst(null);
    runtime.api.estimateRender({ projectId: state.project.id, ...body }).then((e) => { if (alive) setEst(e); }).catch(actions.error);
    return () => { alive = false; };
  }, [format, quality, folder, stillMs, recheck, state.performanceProfile, state.project?.id, state.head?.id, profile.ratio, profile.resolution, jobId]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = Boolean(job && (job.status === 'queued' || job.status === 'rendering'));
  useEffect(() => { if (!running) return; const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, [running]);

  const start = async () => { const id = await actions.startRender(body); if (id) setJobId(id); };
  const outPath = async (): Promise<string | null> => { if (!output) return null; try { return (await runtime.api.revealOutput(output.id)).path; } catch (e) { actions.error(e); return null; } };
  const reveal = async () => { const p = await outPath(); if (p) await window.expertmotion?.openFolder?.(p); };
  const play = async () => { const p = await outPath(); if (p) await (window.expertmotion?.openPath ?? window.expertmotion?.openFolder)?.(p); };
  const copyPath = async () => { const p = output?.path ?? (await outPath()); if (!p) return; const ok = await copyText(p); if (ok) setCopied(true); };
  const pickFolder = () => void window.expertmotion?.pickFolder?.({ ...(folder ? { defaultPath: folder } : {}) }).then((f) => { if (f) setFolder(f); });
  const fix = (r: Recovery) => {
    if (r === 'folder') pickFolder();
    else if (r === 'standard') void actions.setProfile('standard');
    else if (r === 'settings') actions.setScreen({ kind: 'project.settings' });
    else if (r === 'assets') { onClose(); window.dispatchEvent(new CustomEvent('em:focus-assets')); }
    else if (r === 'diagnostics') actions.setScreen({ kind: 'diagnostics' });
    else if (r === 'license') actions.setScreen({ kind: 'license' });
    else if (r === 'progress') { const a = state.renders.find((j) => j.status === 'rendering' || j.status === 'queued'); if (a) setJobId(a.id); }
    else setRecheck((n) => n + 1);
  };
  const elapsedMs = job?.startedAt ? Math.max(0, (job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt)) : 0;
  const thumb = output?.media.thumb && state.grant ? runtime.api.outputMediaUrl(state.grant, output.id, 'thumb') : output?.kind === 'still' && state.grant ? runtime.api.outputMediaUrl(state.grant, output.id, 'file') : null;
  const summary = `${est ? `${est.dimensions.width}×${est.dimensions.height}` : '…'} · ${format === 'png' ? t('ui.scr.export.still') : `${format === 'gif' ? Math.min(15, profile.fps) : profile.fps} fps`} · ${formatDuration(format === 'png' ? 0 : durationMs)} · ${t(`ui.agent.output.profile.${state.performanceProfile}`)}`
    + ` · ≈ ${est?.estimate.bytes != null ? formatBytes(est.estimate.bytes, lang) : '…'} · ≈ ${est?.estimate.seconds != null ? formatDuration(est.estimate.seconds * 1000) : '…'}`;
  const notices = (est?.notices ?? []).filter((n) => n === 'EM-3208');

  return (
    <Modal el="scr.export" title={t('ui.scr.export.title')} onClose={onClose}
      footer={!job ? <>
        <Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button>
        <Button el="scr.export.start" variant="primary" disabledReason={!est ? t('ui.common.loading') : est.ok ? null : t('ui.scr.export.blocked')} onClick={() => void start()}>{t('ui.scr.export.start')}</Button>
      </> : running ? <Button el="scr.export.cancel" variant="danger-ghost" onClick={() => void actions.cancelRender(job.id)}>{t('ui.common.cancel')}</Button>
        : <><Button el="scr.export.again" variant="ghost" onClick={() => { setJobId(null); setCopied(false); }}>{t('ui.scr.export.again')}</Button>{output && <Button el="scr.export.open.folder" variant="primary" onClick={() => void reveal()}>{t('ui.scr.export.openfolder')}</Button>}</>}>
      {!job && (
        <div className="flex flex-col gap-3">
          <div data-el="scr.export.profile.summary" className="t-mono rounded-[6px] border border-em-line px-2 py-1.5">{summary}</div>
          {/* QA UX round 1: the frame shape and size are chosen here too (they were only in the Output panel); a change is the same
              Output Settings pick (one undoable version), and the estimate / preflight above refresh with it. */}
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('ui.agent.output.ratio')} htmlFor="em-ex-ratio">
              <select id="em-ex-ratio" data-el="scr.export.ratio" className={inputCls} value={profile.ratio}
                onChange={(e) => { const r = e.target.value as Ratio; if (r === 'custom') actions.setScreen({ kind: 'ratio.custom' }); else void actions.layoutPick({ ratio: r }); }}>
                {RATIOS.map((r) => <option key={r} value={r}>{r === 'custom' ? (profile.ratio === 'custom' && profile.customRatio ? `${t('ui.agent.output.ratio.custom')} ${profile.customRatio.w}:${profile.customRatio.h}` : t('ui.agent.output.ratio.custom')) : r}</option>)}
              </select>
            </Field>
            <Field label={t('ui.agent.output.resolution')} htmlFor="em-ex-res" {...(tierT0 && (profile.resolution === '2k' || profile.resolution === '2160p') ? { hint: t('ui.agent.output.resolution.needsgpu') } : {})}>
              <select id="em-ex-res" data-el="scr.export.resolution" className={inputCls} value={profile.resolution} onChange={(e) => void actions.layoutPick({ resolution: e.target.value as Resolution })}>
                {RESOLUTIONS.map((r) => <option key={r} value={r} disabled={tierT0 && (r === '2k' || r === '2160p')}>{RES_LABEL[r]}</option>)}
              </select>
            </Field>
          </div>
          <div data-el="scr.export.codec"><Segmented<Format> label={t('ui.scr.export.codec')} value={format} onChange={setFormat}
            options={[{ value: 'mp4', label: 'MP4 (H.264)', el: 'scr.export.codec.mp4' },
              { value: 'webm', label: t('ui.scr.export.codec.webm'), el: 'scr.export.codec.webm', disabledReason: alphaOk ? null : t('ui.scr.export.alpha.needsnone') },
              { value: 'gif', label: 'GIF', el: 'scr.export.codec.gif' }, { value: 'png', label: t('ui.scr.export.still'), el: 'scr.export.codec.png' }]} /></div>
          {!alphaOk && <p data-el="scr.export.codec.webm.reason" className="-mt-1 text-[12px] text-em-muted">{t('ui.scr.export.alpha.needsnone')}</p>}
          <div className="grid grid-cols-2 gap-2">
            {(format === 'mp4' || format === 'webm') && (
              <Field label={t('ui.scr.export.quality')} htmlFor="em-ex-q"><select id="em-ex-q" data-el="scr.export.quality" className={inputCls} value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                <option value="standard">{t('ui.scr.export.quality.standard')}</option><option value="smaller">{t('ui.scr.export.quality.smaller')}</option></select></Field>
            )}
            {format === 'gif' && <p data-el="scr.export.quality" className="self-end pb-1 text-[12px] text-em-text-2">{t('ui.scr.export.gif.note')}</p>}
            {format === 'png' && (
              <Field label={t('ui.scr.export.still.time')} htmlFor="em-ex-t" hint={t('ui.scr.export.still.hint', { time: formatDuration(durationMs) })}>
                <div className="flex gap-2">
                  <input id="em-ex-t" data-el="scr.export.still.time" type="number" min={0} step={0.1} max={durationMs / 1000} className={inputCls} value={(stillMs / 1000).toFixed(1)} onChange={(e) => setStillMs(Math.round(Number(e.target.value) * 1000) || 0)} />
                  <Button size={32} onClick={() => setStillMs(state.playheadMs)}>{t('ui.scr.export.still.playhead')}</Button>
                </div>
              </Field>
            )}
            <Field label={t('ui.scr.export.filename')} htmlFor="em-ex-f" hint={`.${format}`}><input id="em-ex-f" data-el="scr.export.filename" className={inputCls} value={name} maxLength={80} onChange={(e) => { setNameTouched(true); setFileName(e.target.value); }} /></Field>
          </div>
          <Field label={t('ui.scr.export.folder')} htmlFor="em-ex-d" hint={folder ? undefined : t('ui.scr.export.folder.default')}>
            <div className="flex gap-2"><input id="em-ex-d" data-el="scr.export.folder" className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} />
              <Button onClick={pickFolder}>{t('ui.scr.project.open.browse')}</Button></div>
          </Field>
          <ul data-el="scr.export.preflight" aria-label={t('ui.scr.export.preflight')} className="flex flex-col gap-1">
            {!est && <li className="text-em-muted">{t('ui.scr.export.checking')}</li>}
            {(() => {
              // Operator 2026-10-26 (less wordy): passed checks without a note collapse into one "N checks passed" line.
              const row = (c: NonNullable<typeof est>['checks'][number]) => {
                const info = c.ok && c.code;
                const r = recoveryFor(c, state.performanceProfile);
                return (
                  <li key={c.check} data-check={c.check} data-ok={String(c.ok)} className="flex items-center gap-2">
                    {!c.ok ? <TriangleAlert size={14} className="text-em-danger" /> : info ? <Info size={14} className="text-em-info" /> : <CheckCircle2 size={14} className="text-em-success" />}
                    <span className="w-24 shrink-0">{t(`ui.scr.export.check.${c.check}`)}</span>
                    <span className="flex-1 text-em-text-2" title={c.code ? t(`err.${c.code}.body`, { name: state.project?.name ?? '', folder: folder || '…', feature: '' }) : undefined}>{c.code ? t(`err.${c.code}.title`) : t('ui.scr.export.check.ok')}</span>
                    {c.code && <span className="t-mono text-em-muted">{c.code}</span>}
                    {r && <Button el="scr.export.preflight.fix" size={28} variant={c.ok ? 'ghost' : 'secondary'} onClick={() => fix(r)}>{t(RECOVERY_LABEL[r])}</Button>}
                  </li>
                );
              };
              const checks = est?.checks ?? [];
              const quiet = checks.filter((c) => c.ok && !c.code && !recoveryFor(c, state.performanceProfile));
              return <>
                {checks.filter((c) => !quiet.includes(c)).map(row)}
                {quiet.length > 0 && (
                  <li data-el="scr.export.preflight.passed"><details>
                    <summary className="flex cursor-pointer items-center gap-2"><CheckCircle2 size={14} className="text-em-success" /><span className="text-em-text-2">{t('ui.scr.export.check.allok', { count: quiet.length })}</span></summary>
                    <ul className="mt-1 flex flex-col gap-1 pl-5">{quiet.map(row)}</ul>
                  </details></li>
                )}
              </>;
            })()}
            {notices.map((code) => (
              <li key={code} className="flex items-center gap-2"><Info size={14} className="text-em-info" /><span className="w-24 shrink-0">{t('ui.scr.export.check.queue')}</span>
                <span className="flex-1 text-em-text-2">{t(`err.${code}.title`)}</span><span className="t-mono text-em-muted">{code}</span>
                <Button el="scr.export.preflight.fix" size={28} variant="ghost" onClick={() => fix('progress')}>{t(RECOVERY_LABEL.progress)}</Button></li>
            ))}
            {est?.warnings.map((w) => <li key={`${w.code}-${w.path}`} className="flex items-center gap-2 text-[12px] text-em-text-2"><Info size={14} className="text-em-info" /><span className="flex-1">{w.code === 'EM-3103' && format === 'gif' ? t('ui.scr.export.gif.capped') : t(`err.${w.code}.title`)}</span><span className="t-mono text-em-muted">{w.code}</span></li>)}
            {priv && <li data-el="scr.export.private" className="flex items-center gap-2 text-em-private"><ShieldCheck size={14} /><span className="flex-1">{t('ui.scr.export.private')}</span></li>}
          </ul>
          {est && (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-em-muted">{t('ui.scr.export.estimate', { time: est.estimate.seconds !== null ? formatDuration(est.estimate.seconds * 1000) : '…', size: est.estimate.bytes !== null ? formatBytes(est.estimate.bytes, lang) : '…' })}</p>
              <Button el="scr.export.preflight.recheck" size={28} variant="ghost" onClick={() => fix('recheck')}>{t('ui.scr.export.recheck')}</Button>
            </div>
          )}
        </div>
      )}
      {job && running && (
        <div className="flex flex-col gap-2">
          {/* QA UX round 1: after the last frame the phase is named (encoding / checking), not "Frame 330/330" while the bar still moves */}
          <Progress el="scr.export.progress" value={job.progress} label={job.stage === 'encoding' || job.stage === 'validating' || (job.totalFrames && (job.renderedFrames ?? 0) >= job.totalFrames && job.progress < 0.995)
            ? `${t(job.stage === 'validating' ? 'ui.scr.export.stage.validating' : 'ui.scr.export.stage.encoding')} · ${Math.round(job.progress * 100)} %`
            : t('ui.scr.export.progress', { frame: job.renderedFrames ?? 0, total: job.totalFrames ?? 0, percent: Math.round(job.progress * 100) })} />
          {/* FR-204: say what is happening — waiting for memory (EM-3107), another render first (EM-3208), engine start, encoding, checking. */}
          {job.status === 'queued' && job.notices?.includes('EM-3107') ? (
            <div data-el="scr.export.waiting.memory" role="status" className="flex flex-col gap-0.5"><span className="font-semibold">{t('err.EM-3107.title')}</span><span className="text-[12px] text-em-text-2">{t('err.EM-3107.body')}</span>
              {job.memoryWait && <span data-el="scr.export.waiting.memory.detail" className="t-mono text-[12px] text-em-muted">{t('ui.scr.export.waiting.memory.detail', { s: Math.round(job.memoryWait.waitedMs / 1000), free: job.memoryWait.freeMb, need: job.memoryWait.needMb, left: Math.max(0, Math.round(((job.memoryWait.maxWaitMs ?? 0) - job.memoryWait.waitedMs) / 1000)) })}</span>}</div>
          ) : (
            <span data-el="scr.export.stage">{job.status === 'queued' ? (state.renders.some((j) => j.id !== job.id && j.status === 'rendering') ? t('err.EM-3208.title') : t('ui.scr.export.stage.preparing'))
              : job.stage === 'preparing' || (job.progress === 0 && !job.renderedFrames) ? t('ui.scr.export.stage.preparing')
                : job.stage === 'encoding' ? t('ui.scr.export.stage.encoding') : job.stage === 'validating' ? t('ui.scr.export.stage.validating')
                  : t('ui.scr.export.progress', { frame: job.renderedFrames ?? 0, total: job.totalFrames ?? 0, percent: Math.round(job.progress * 100) })}</span>
          )}
          <div className="flex gap-4">
            <span data-el="scr.export.eta" className="text-em-muted">{job.etaMs ? t('ui.scr.export.eta', { time: formatDuration(job.etaMs) }) : t('ui.scr.export.estimating')}</span>
            <span data-el="scr.export.elapsed" className="text-em-muted">{t('ui.scr.export.elapsed', { time: formatDuration(elapsedMs) })}</span>
          </div>
          <p className="text-[12px] text-em-muted">{t('ui.scr.export.keepediting')}</p>
        </div>
      )}
      {job && job.status === 'done' && (
        <div data-el="scr.export.done" className="flex flex-col items-center gap-2 py-4 text-center">
          {thumb ? <img data-el="scr.export.done.thumb" src={thumb} alt={output?.fileName ?? ''} className="max-h-40 rounded-[6px] border border-em-line" /> : <CheckCircle2 size={32} className="text-em-success" />}
          <div className="text-[20px] font-semibold">{t('ui.scr.export.done')}</div>
          {output && <div className="text-em-text-2">{t('ui.scr.export.done.body', { name: output.fileName, duration: formatDuration(output.durationMs ?? 0), w: output.width ?? 0, h: output.height ?? 0, size: formatBytes(output.bytes, lang) })}</div>}
          {output && (
            <div className="flex gap-2">
              <Button el="scr.export.done.play" size={28} icon={<Play size={14} />} onClick={() => void play()}>{t('ui.scr.export.play')}</Button>
              <Button el="scr.export.done.copypath" size={28} icon={<Copy size={14} />} onClick={() => void copyPath()}>{copied ? t('ui.common.copied') : t('ui.scr.export.copypath')}</Button>
            </div>
          )}
          {output && <code className="t-mono max-w-full truncate text-[11px] text-em-muted select-all">{output.path}</code>}
        </div>
      )}
      {job && job.status === 'failed' && <ErrorBox code={job.errorCode ?? 'EM-3201'} vars={{ percent: Math.round(job.progress * 100), name, folder: folder || '…', need: '…', have: '…' }} actions={<>
        <Button el="scr.export.failed.retry" size={28} onClick={() => setJobId(null)}>{t('ui.sys.toast.tryagain')}</Button>
        <Button el="scr.export.diagnostics" size={28} variant="ghost" onClick={() => actions.setScreen({ kind: 'diagnostics' })}>{t('ui.scr.export.fix.diagnostics')}</Button>
      </>} />}
      {job && job.status === 'failed' && typeof job.failedFrame === 'number' && (   // FR-143: the frame the render stopped at
        <div data-el="scr.export.failed.frame" className="t-mono text-[12px] text-em-muted">{job.totalFrames ? t('ui.scr.export.failed.frameof', { frame: job.failedFrame, total: job.totalFrames, time: formatDuration(Math.round((job.failedFrame / job.outputProfile.fps) * 1000)) }) : t('ui.scr.export.failed.frame', { frame: job.failedFrame })}</div>
      )}
      {job && job.status === 'cancelled' && <div className="flex items-center gap-2 text-em-muted"><XCircle size={16} />{t('ui.scr.export.cancelled')}</div>}
    </Modal>
  );
}
