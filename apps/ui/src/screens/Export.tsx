// Export dialog (scr.export): setup with preflight (R-110), start (R-111), progress/ETA via SSE, cancel (R-114), done with
// open folder (R-119 + Shell revealPath). IX-21, USER_FLOWS F8.
import { useEffect, useState } from 'react';
import { CheckCircle2, Info, TriangleAlert, XCircle } from 'lucide-react';
import { useStore, currentOutputProfile } from '../state/store.js';
import type { OutputProfile, RenderEstimate } from '../api/types.js';
import { Button, ErrorBox, Field, Modal, Progress, Segmented, inputCls } from '../components/ui.js';
import { formatBytes, formatDuration } from '../i18n/index.js';

type Format = 'mp4' | 'gif' | 'png';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  const [format, setFormat] = useState<Format>('mp4');
  const [quality, setQuality] = useState<'standard' | 'high'>('high');
  const [fileName, setFileName] = useState(state.project?.name.replace(/[^\p{L}\p{N}._-]+/gu, '-') ?? 'video');
  const [folder, setFolder] = useState(state.settings?.outputFolder ?? '');
  const [est, setEst] = useState<RenderEstimate | null>(null);
  const [jobId, setJobId] = useState<string | null>(state.renders.find((j) => j.status === 'rendering' || j.status === 'queued')?.id ?? null);
  const job = state.renders.find((j) => j.id === jobId) ?? null;
  const output = job?.outputId ? state.outputs.find((o) => o.id === job.outputId) : undefined;
  const profile: OutputProfile = { ...currentOutputProfile(state), format, codec: format === 'mp4' ? 'h264' : format, crf: quality === 'high' ? 18 : 23 };
  const body = { outputProfile: profile, performanceProfile: state.performanceProfile, fileName, ...(folder ? { folder } : {}) };

  useEffect(() => {
    if (!state.project || jobId) return;
    let alive = true;
    setEst(null);
    runtime.api.estimateRender({ projectId: state.project.id, ...body }).then((e) => { if (alive) setEst(e); }).catch(actions.error);
    return () => { alive = false; };
  }, [format, quality, state.project?.id, state.head?.id, jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => { const id = await actions.startRender(body); if (id) setJobId(id); };
  const reveal = async () => {
    if (!output) return;
    try { const r = await runtime.api.revealOutput(output.id); await window.expertmotion?.revealPath?.(r.path); } catch (e) { actions.error(e); }
  };
  const running = job && (job.status === 'queued' || job.status === 'rendering');
  const s = currentOutputProfile(state);
  const durationMs = state.head?.durationMs ?? 0;

  return (
    <Modal el="scr.export" title={t('ui.scr.export.title')} onClose={onClose}
      footer={!job ? <>
        <Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button>
        <Button el="scr.export.start" variant="primary" disabledReason={!est ? t('ui.common.loading') : est.ok ? null : t('ui.scr.export.blocked')} onClick={() => void start()}>{t('ui.scr.export.start')}</Button>
      </> : running ? <Button el="scr.export.cancel" variant="danger-ghost" onClick={() => void actions.cancelRender(job.id)}>{t('ui.common.cancel')}</Button>
        : <><Button variant="ghost" onClick={() => setJobId(null)}>{t('ui.scr.export.again')}</Button>{output && <Button el="scr.export.open.folder" variant="primary" onClick={() => void reveal()}>{t('ui.scr.export.openfolder')}</Button>}</>}>
      {!job && (
        <div className="flex flex-col gap-3">
          <div data-el="scr.export.profile.summary" className="t-mono rounded-[6px] border border-em-line px-2 py-1.5">
            {`${s.ratio} · ${est ? `${est.dimensions.width}×${est.dimensions.height}` : '…'} · ${s.fps} fps · ${formatDuration(durationMs)} · ${t(`ui.agent.output.profile.${state.performanceProfile}`)}`}
          </div>
          {est?.watermark && <p className="rounded-[6px] border border-em-warn px-2 py-1.5 text-em-warn">{t('ui.scr.export.trial')}</p>}
          <div data-el="scr.export.codec"><Segmented<Format> label={t('ui.scr.export.codec')} value={format} onChange={setFormat}
            options={[{ value: 'mp4', label: 'MP4 (H.264)', el: 'scr.export.codec.mp4' }, { value: 'gif', label: 'GIF', el: 'scr.export.codec.gif' }, { value: 'png', label: t('ui.scr.export.still'), el: 'scr.export.codec.png' }]} /></div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('ui.scr.export.quality')} htmlFor="em-ex-q"><select id="em-ex-q" data-el="scr.export.quality" className={inputCls} value={quality} onChange={(e) => setQuality(e.target.value as 'standard' | 'high')}><option value="standard">{t('ui.scr.export.quality.standard')}</option><option value="high">{t('ui.scr.export.quality.high')}</option></select></Field>
            <Field label={t('ui.scr.export.filename')} htmlFor="em-ex-f"><input id="em-ex-f" data-el="scr.export.filename" className={inputCls} value={fileName} maxLength={80} onChange={(e) => setFileName(e.target.value)} /></Field>
          </div>
          <Field label={t('ui.scr.export.folder')} htmlFor="em-ex-d">
            <div className="flex gap-2"><input id="em-ex-d" data-el="scr.export.folder" className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} />
              <Button onClick={() => void window.expertmotion?.pickFolder?.().then((f) => { if (f) setFolder(f); })}>{t('ui.scr.project.open.browse')}</Button></div>
          </Field>
          <ul data-el="scr.export.preflight" aria-label={t('ui.scr.export.preflight')} className="flex flex-col gap-1">
            {!est && <li className="text-em-muted">{t('ui.scr.export.checking')}</li>}
            {est?.checks.map((c) => {
              const info = c.ok && c.code;
              return (
                <li key={c.check} className="flex items-center gap-2">
                  {!c.ok ? <TriangleAlert size={14} className="text-em-danger" /> : info ? <Info size={14} className="text-em-info" /> : <CheckCircle2 size={14} className="text-em-success" />}
                  <span className="w-24">{t(`ui.scr.export.check.${c.check}`)}</span>
                  <span className="flex-1 text-em-text-2">{c.code ? t(`err.${c.code}.title`) : t('ui.scr.export.check.ok')}</span>
                  {c.code && <span className="t-mono text-em-muted">{c.code}</span>}
                </li>
              );
            })}
          </ul>
          {est && <p className="text-em-muted">{t('ui.scr.export.estimate', { time: est.estimate.seconds !== null ? formatDuration(est.estimate.seconds * 1000) : '…', size: est.estimate.bytes !== null ? formatBytes(est.estimate.bytes, lang) : '…' })}</p>}
        </div>
      )}
      {job && running && (
        <div className="flex flex-col gap-2">
          <Progress el="scr.export.progress" value={job.progress} label={t('ui.scr.export.progress', { frame: job.renderedFrames ?? 0, total: job.totalFrames ?? 0, percent: Math.round(job.progress * 100) })} />
          <span>{t('ui.scr.export.progress', { frame: job.renderedFrames ?? 0, total: job.totalFrames ?? 0, percent: Math.round(job.progress * 100) })}</span>
          <span data-el="scr.export.eta" className="text-em-muted">{job.etaMs ? t('ui.scr.export.eta', { time: formatDuration(job.etaMs) }) : t('ui.scr.export.estimating')}</span>
          <p className="text-[12px] text-em-muted">{t('ui.scr.export.keepediting')}</p>
        </div>
      )}
      {job && job.status === 'done' && (
        <div data-el="scr.export.done" className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2 size={32} className="text-em-success" />
          <div className="text-[20px] font-semibold">{t('ui.scr.export.done')}</div>
          {output && <div className="text-em-text-2">{t('ui.scr.export.done.body', { name: output.fileName, duration: formatDuration(output.durationMs ?? 0), w: output.width ?? 0, h: output.height ?? 0, size: formatBytes(output.bytes, lang) })}</div>}
          {output?.watermarked && <div className="text-em-warn">{t('ui.scr.export.done.trial')}</div>}
        </div>
      )}
      {job && job.status === 'failed' && <ErrorBox code={job.errorCode ?? 'EM-3201'} actions={<Button size={28} onClick={() => setJobId(null)}>{t('ui.sys.toast.tryagain')}</Button>} />}
      {job && job.status === 'cancelled' && <div className="flex items-center gap-2 text-em-muted"><XCircle size={16} />{t('ui.scr.export.cancelled')}</div>}
    </Modal>
  );
}
