// FR-280 … FR-299 (Reels pipeline, DESIGN §E): the chat pieces of the footage path. PrepCard = the Footage prep job as a
// progress card (Indonesian stages, "Putar video?" with four thumbnails on needs-input, the cut table when done); CoverPicker =
// contact sheet → cell → POST /cover → the saved still; StageButtons = Siapkan · Pratinjau · Final on the Editor hand-off /
// Plan Card; ChatMenu = the chat header menu (Profil kanal, Siapkan rekaman). Copy per UI_UX_SPECIFICATION §12: short, no names.
import { useEffect, useState } from 'react';
import { CheckCircle2, Clapperboard, Copy, FolderOpen, Image as ImageIcon, Loader, MoreVertical, RotateCw, Scissors, Sparkles, XCircle } from 'lucide-react';
import { useStore } from '../state/store.js';
import { currentOutputProfile } from '../state/store.js';
import type { CoverInput, FootageCutDto, OutputDto, PlanDto, Rotation } from '../api/types.js';
import { PREP_STAGES } from '../api/types.js';
import { Button, IconButton, MenuItem, Popover, cx, inputCls } from '../components/ui.js';
import { copyText } from '../api/client.js';
import { cutRows, cutsTotalMs, fmtMs, footagePair, prepStageIndex, sheetGrid } from './reels.js';

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

/** Thumbnail / media addresses the Service hands out may be relative to its base (`/api/v1/…`). */
function absolute(url: string, base: string): string { return /^(https?:|data:|blob:)/.test(url) ? url : `${base.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`; }

function useElapsed(since: number | undefined, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!since || !live) return; const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, [since, live]);
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

/** agent.chat.prep: the prep job's card (running / needs-input / done / failed). */
export function PrepCard() {
  const { state, actions, t, runtime } = useStore();
  const prep = state.prep;
  const live = Boolean(prep && (prep.job.status === 'running' || prep.job.status === 'queued'));
  const secs = useElapsed(prep?.since, live);
  const [busy, setBusy] = useState<Rotation | null>(null);
  if (!prep) return null;
  const { job, stage, percent } = prep;
  const idx = job.status === 'done' ? PREP_STAGES.length : prepStageIndex(stage);
  const result = (job.result ?? {}) as { needsRotationConfirm?: boolean; thumbnails?: Array<{ rotation: Rotation; url: string }> };
  const analysis = state.analysis ?? ((job.result as { analysis?: typeof state.analysis } | null)?.analysis ?? null);
  const rows = cutRows(analysis);
  const status = job.status === 'needs-input' ? 'needs-input' : job.status === 'done' ? 'done' : job.status === 'failed' || job.status === 'cancelled' ? 'failed' : 'running';
  const code = job.errorCode ?? 'EM-1504';
  const choose = async (r: Rotation) => { setBusy(r); try { await actions.continuePrep(r); } finally { setBusy(null); } };
  return (
    <div data-el="agent.chat.prep" data-status={status} data-stage={stage} role="status" aria-live="polite" className={cx('flex w-full flex-col gap-1.5 rounded-[8px] border p-2 text-[12px]', status === 'failed' ? 'border-em-danger' : status === 'done' ? 'border-em-success' : 'border-em-accent')}>
      <div className="flex items-center gap-1.5 font-semibold">
        {status === 'done' ? <CheckCircle2 size={14} className="text-em-success" /> : status === 'failed' ? <XCircle size={14} className="text-em-danger" /> : status === 'needs-input' ? <RotateCw size={14} className="text-em-warn" /> : <Loader size={14} className="em-spin text-em-accent" />}
        <span className="min-w-0 flex-1 truncate">{t(`ui.agent.prep.title.${status}`)}</span>
        {status === 'running' && <span data-el="agent.chat.prep.percent" className="t-mono text-[11px] text-em-muted">{percent} % · {t('ui.agent.progress.elapsed', { s: secs })}</span>}
      </div>
      {status !== 'failed' && (
        <ol data-el="agent.chat.prep.stages" className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
          {PREP_STAGES.map((s, i) => (
            <li key={s} data-el="agent.chat.prep.stage" data-stage={s} data-state={i < idx ? 'done' : i === idx && status !== 'done' ? 'active' : 'todo'} className={cx('flex items-center gap-0.5', i < idx ? 'text-em-success' : i === idx && status !== 'done' ? 'font-semibold text-em-accent' : 'text-em-muted')}>
              {i < idx ? <CheckCircle2 size={10} aria-hidden /> : i === idx && status === 'running' ? <Loader size={10} className="em-spin" aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
              {t(`ui.agent.prep.stage.${s}`)}
            </li>))}
        </ol>
      )}
      {status === 'running' && <div className="h-1 w-full overflow-hidden rounded-full bg-em-line"><div className="h-full bg-em-accent transition-[width] duration-500" style={{ width: `${percent}%` }} /></div>}
      {status === 'needs-input' && (
        <div data-el="agent.chat.prep.rotate" role="group" aria-label={t('ui.agent.prep.rotate.title')} className="flex flex-col gap-1">
          <span className="font-semibold text-em-warn">{t('ui.agent.prep.rotate.title')}</span>
          <span className="text-em-text-2">{t('ui.agent.prep.rotate.hint')}</span>
          <div className="grid grid-cols-4 gap-1">
            {(result.thumbnails?.length ? result.thumbnails : ROTATIONS.map((rotation) => ({ rotation, url: '' }))).map((x) => (
              <button key={x.rotation} type="button" data-el="agent.chat.prep.rotation" data-rotation={x.rotation} aria-label={t('ui.agent.prep.rotate.option', { deg: x.rotation })} disabled={busy !== null}
                className="flex flex-col items-center gap-0.5 rounded-[6px] border border-em-line p-1 hover:border-em-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-em-accent" onClick={() => void choose(x.rotation)}>
                {x.url ? <img src={absolute(x.url, runtime.api.baseUrl)} alt="" className="h-20 w-full rounded-[4px] object-cover" /> : <span className="flex h-20 w-full items-center justify-center rounded-[4px] bg-em-panel-2 text-em-muted"><RotateCw size={14} /></span>}
                <span className="t-mono text-[11px]">{busy === x.rotation ? <Loader size={11} className="em-spin" aria-hidden /> : `${x.rotation}°`}</span>
              </button>))}
          </div>
        </div>
      )}
      {status === 'done' && analysis && (
        <div className="flex flex-col gap-1">
          <span data-el="agent.chat.prep.summary" className="text-em-text-2">{t('ui.agent.prep.summary', { offset: (analysis.offsetMs / 1000).toFixed(2), n: rows.length, total: fmtMs(cutsTotalMs(analysis)) })}</span>
          {rows.length > 0 && (
            <table data-el="agent.chat.prep.cuts" className="w-full text-[11px]">
              <thead><tr className="text-left text-em-muted"><th className="pr-2 font-normal">{t('ui.agent.prep.cuts.no')}</th><th className="pr-2 font-normal">{t('ui.agent.prep.cuts.time')}</th><th className="pr-2 text-right font-normal">{t('ui.agent.prep.cuts.words')}</th><th className="font-normal">{t('ui.agent.prep.cuts.text')}</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} data-el="agent.chat.prep.cut" data-cut-id={r.id} className="border-t border-em-line/60 align-top">
                  <td className="t-mono pr-2 text-em-muted">{r.no}</td><td className="t-mono whitespace-nowrap pr-2">{r.range}</td><td className="t-mono pr-2 text-right">{r.words}</td><td className="min-w-0 break-words text-em-text-2">{r.text}</td>
                </tr>))}</tbody>
            </table>
          )}
          {analysis.dropped.length > 0 && <span data-el="agent.chat.prep.dropped" className="text-[11px] text-em-muted">{t('ui.agent.prep.dropped', { n: analysis.dropped.length })}</span>}
          {analysis.warnings.map((w, i) => <span key={i} className="text-[11px] text-em-warn">{w}</span>)}
        </div>
      )}
      {status === 'failed' && (
        <div data-el="agent.chat.prep.error" data-code={code} className="flex flex-col gap-1">
          <span className="text-em-text-2">{t(`err.${code}.title`)} <span className="t-mono text-[10px] text-em-muted">{code}</span></span>
          <span className="text-[11px] text-em-muted">{t(`err.${code}.body`)}</span>
          <div><Button el="agent.chat.prep.retry" size={28} onClick={() => { const pair = footagePair(state.assets, state.assetSelection); if (pair) void actions.startPrep({ voiceAssetId: pair.audio, cameraAssetId: pair.video }); else actions.toast('info', 'ui.agent.stage.prep.needsassets'); }}>{t('ui.sys.toast.tryagain')}</Button></div>
        </div>
      )}
    </div>
  );
}

/** A hook word from the cut's text: the first word of four letters or more, capitalised. */
export const hookWordOf = (text: string): string => { const w = text.split(/\s+/).map((x) => x.replace(/[^\p{L}\p{N}-]/gu, '')).find((x) => x.length >= 4) ?? text.split(/\s+/)[0] ?? ''; return w ? w[0]!.toUpperCase() + w.slice(1) : ''; };

/** agent.chat.cover: candidates from the master (one cell per cut) → fields → POST /cover → the saved JPG with Open folder / Copy path. */
export function CoverPicker() {
  const { state, actions, t, runtime } = useStore();
  const analysis = state.analysis;
  const cuts: FootageCutDto[] = analysis?.cuts ?? [];
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<FootageCutDto | null>(null);
  const [hook, setHook] = useState('');
  const [line, setLine] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<OutputDto | null>(null);
  const [copied, setCopied] = useState(false);
  const pid = state.project?.id;
  useEffect(() => () => { if (sheet && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(sheet); }, [sheet]);
  if (!analysis || !cuts.length || !pid) return null;
  const load = async () => {
    setOpen(true); setLoading(true);
    try { const b = await runtime.api.footageFrames(pid, { atMs: cuts[0]!.startMs, count: cuts.length, rotation: analysis.rotation }); setSheet(URL.createObjectURL(b)); } catch (e) { actions.error(e); } finally { setLoading(false); }
  };
  const choose = (c: FootageCutDto) => { setPick(c); setHook((h) => h || hookWordOf(c.text)); setLine(c.text); setOut(null); };
  const render = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      const body: CoverInput = { cutId: pick.id, hookWord: hook.trim() || hookWordOf(pick.text), line: line.trim() || pick.text, ...(handle.trim() ? { handle: handle.trim() } : {}) };
      const o = await runtime.api.renderCover(pid, body);
      setOut(o); actions.announce(t('ui.agent.cover.done', { name: o.fileName }));
    } catch (e) { actions.error(e); } finally { setBusy(false); }
  };
  const reveal = async () => { if (!out) return; try { const p = (await runtime.api.revealOutput(out.id)).path; await window.expertmotion?.openFolder?.(p); } catch (e) { actions.error(e); } };
  const copyPath = async () => { if (!out) return; if (await copyText(out.path)) setCopied(true); };
  const grid = sheetGrid(cuts.length);
  const still = out && state.grant ? runtime.api.outputMediaUrl(state.grant, out.id, 'file') : null;
  return (
    <div data-el="agent.chat.cover" data-state={out ? 'done' : open ? 'open' : 'idle'} className="flex w-full flex-col gap-1.5 rounded-[8px] border border-em-line p-2 text-[12px]">
      <div className="flex items-center gap-1.5 font-semibold"><ImageIcon size={14} className="text-em-accent" aria-hidden /><span className="flex-1">{t('ui.agent.cover.title')}</span>
        {!open && <Button el="agent.chat.cover.open" size={28} variant="secondary" onClick={() => void load()}>{t('ui.agent.cover.open')}</Button>}</div>
      {open && (
        <>
          <span className="text-em-text-2">{t('ui.agent.cover.hint')}</span>
          <div data-el="agent.chat.cover.sheet" className="relative w-full overflow-hidden rounded-[6px] border border-em-line bg-em-panel-2" style={{ aspectRatio: `${grid.cols * 9} / ${grid.rows * 16}` }}>
            {sheet && <img src={sheet} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            {loading && <span className="absolute inset-0 flex items-center justify-center text-em-muted"><Loader size={16} className="em-spin" aria-label={t('ui.common.loading')} /></span>}
            <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${grid.cols}, 1fr)`, gridTemplateRows: `repeat(${grid.rows}, 1fr)` }} role="listbox" aria-label={t('ui.agent.cover.title')}>
              {cuts.map((c, i) => (
                <button key={c.id} type="button" role="option" aria-selected={pick?.id === c.id} data-el="agent.chat.cover.cell" data-cut-id={c.id} title={`${i + 1} · ${fmtMs(c.startMs)} · ${c.text}`} aria-label={t('ui.agent.cover.cell', { n: i + 1, time: fmtMs(c.startMs) })}
                  className={cx('flex items-end justify-start border border-white/20 p-0.5 text-[10px] text-white hover:bg-white/10', pick?.id === c.id && 'bg-em-accent/30 ring-2 ring-inset ring-em-accent')} onClick={() => choose(c)}>
                  <span className="t-mono rounded-[3px] bg-black/60 px-1">{i + 1}</span>
                </button>))}
            </div>
          </div>
          {pick && !out && (
            <div data-el="agent.chat.cover.form" className="flex flex-col gap-1">
              <input data-el="agent.chat.cover.hook" className={inputCls} value={hook} maxLength={24} placeholder={t('ui.agent.cover.hook')} aria-label={t('ui.agent.cover.hook')} onChange={(e) => setHook(e.target.value)} />
              <input data-el="agent.chat.cover.line" className={inputCls} value={line} maxLength={120} placeholder={t('ui.agent.cover.line')} aria-label={t('ui.agent.cover.line')} onChange={(e) => setLine(e.target.value)} />
              <input data-el="agent.chat.cover.handle" className={inputCls} value={handle} maxLength={40} placeholder={t('ui.agent.cover.handle')} aria-label={t('ui.agent.cover.handle')} onChange={(e) => setHandle(e.target.value)} />
              <div className="flex gap-2"><Button el="agent.chat.cover.render" variant="primary" size={28} loading={busy} icon={<Sparkles size={12} />} onClick={() => void render()}>{t('ui.agent.cover.render')}</Button>
                <Button size={28} variant="ghost" onClick={() => { setOpen(false); setPick(null); }}>{t('ui.common.cancel')}</Button></div>
            </div>
          )}
          {out && (
            <div data-el="agent.chat.cover.result" className="flex flex-col items-start gap-1">
              {still && <img data-el="agent.chat.cover.result.image" src={still} alt={out.fileName} className="max-h-48 rounded-[6px] border border-em-line" />}
              <span className="text-em-success">{t('ui.agent.cover.done', { name: out.fileName })}</span>
              <div className="flex flex-wrap gap-2">
                <Button el="agent.chat.cover.reveal" size={28} icon={<FolderOpen size={12} />} onClick={() => void reveal()}>{t('ui.scr.export.openfolder')}</Button>
                <Button el="agent.chat.cover.copypath" size={28} icon={<Copy size={12} />} onClick={() => void copyPath()}>{copied ? t('ui.common.copied') : t('ui.scr.export.copypath')}</Button>
                <Button size={28} variant="ghost" onClick={() => { setOut(null); setPick(null); }}>{t('ui.agent.cover.again')}</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * agent.editor.stage: the three Creator actions of the footage path (DESIGN §D/§E). Siapkan = prep with the project's video + audio;
 * Pratinjau = Execute the plan (when it is still a proposal) and render a 720p preview; Final = render 1080p. Errors are plain
 * sentences (toasts with their EM code), never silent.
 */
export function StageButtons({ plan }: { plan?: PlanDto | null }) {
  const { state, actions, t } = useStore();
  const [busy, setBusy] = useState<'prep' | 'preview' | 'final' | null>(null);
  const pair = footagePair(state.assets, state.assetSelection);
  const prepRunning = state.prep?.job.status === 'running' || state.prep?.job.status === 'queued' || state.prep?.job.status === 'needs-input';
  const rendering = state.renders.some((j) => j.status === 'rendering' || j.status === 'queued');
  const hasClips = (state.head?.model?.tracks.video.length ?? 0) > 0;
  const prep = async () => {
    if (!pair) { actions.toast('info', 'ui.agent.stage.prep.needsassets'); return; }
    setBusy('prep'); try { await actions.startPrep({ voiceAssetId: pair.audio, cameraAssetId: pair.video }); } finally { setBusy(null); }
  };
  const render = async (resolution: '720p' | '1080p', which: 'preview' | 'final') => {
    setBusy(which);
    try {
      // a plan that is still a proposal is applied first (a stale one re-plans and the card says so; the render then shows the current head)
      if (which === 'preview' && plan && (plan.status === 'valid' || plan.status === 'stale')) await actions.execute();
      const clips = hasClips || (plan && plan.status !== 'executed' && plan.steps.length > 0);
      if (!clips) { actions.toast('info', 'ui.agent.stage.render.noclips'); return; }
      const id = await actions.startRender({ outputProfile: { ...currentOutputProfile(state), resolution }, performanceProfile: state.performanceProfile });
      if (id) actions.setScreen({ kind: 'export', jobId: id });                    // the Export dialog follows this job (progress, done, credits)
    } finally { setBusy(null); }
  };
  return (
    <div data-el="agent.editor.stage" role="group" aria-label={t('ui.agent.stage.label')} className="flex flex-wrap items-center gap-1.5">
      <Button el="agent.editor.stage.prep" size={28} icon={<Scissors size={12} />} loading={busy === 'prep'} title={t('ui.agent.stage.prep.tip')} disabledReason={prepRunning ? t('ui.agent.stage.prep.running') : null} onClick={() => void prep()}>{t('ui.agent.stage.prep')}</Button>
      <Button el="agent.editor.stage.preview" size={28} icon={<Clapperboard size={12} />} loading={busy === 'preview'} title={t('ui.agent.stage.preview.tip')} disabledReason={rendering ? t('ui.agent.stage.render.running') : null} onClick={() => void render('720p', 'preview')}>{t('ui.agent.stage.preview')}</Button>
      <Button el="agent.editor.stage.final" size={28} variant="primary" icon={<Sparkles size={12} />} loading={busy === 'final'} title={t('ui.agent.stage.final.tip')} disabledReason={rendering ? t('ui.agent.stage.render.running') : null} onClick={() => void render('1080p', 'final')}>{t('ui.agent.stage.final')}</Button>
    </div>
  );
}

/** agent.chat.menu: the chat header's menu — Profil kanal (settings editor) and Siapkan rekaman. */
export function ChatMenu() {
  const { state, actions, t } = useStore();
  const [open, setOpen] = useState(false);
  const pair = footagePair(state.assets, state.assetSelection);
  return (
    <span className="relative">
      <IconButton el="agent.chat.menu" data-popover-trigger="" label={t('ui.agent.chat.menu')} icon={<MoreVertical size={14} />} size={28} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <Popover onClose={() => setOpen(false)} role="menu" align="right" width={220} label={t('ui.agent.chat.menu')}>
          <MenuItem el="agent.chat.menu.profile" onClick={() => { setOpen(false); actions.setScreen({ kind: 'channel.profile' }); }}>{t('ui.scr.channel.title')}</MenuItem>
          <MenuItem el="agent.chat.menu.prep" disabledReason={pair ? null : t('ui.agent.stage.prep.needsassets')} onClick={() => { setOpen(false); if (pair) void actions.startPrep({ voiceAssetId: pair.audio, cameraAssetId: pair.video }); }}>{t('ui.agent.stage.prep.long')}</MenuItem>
        </Popover>
      )}
    </span>
  );
}
