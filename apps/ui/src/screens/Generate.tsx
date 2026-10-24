// Generator sheets (scr.generate.*): forms that call R-130 and show "needs model", running, done, failed states (IX-08).
// FR-101…FR-108: per-kind inputs (voice picker + speed + audio preview; music duration, instrumental, CC0 loop library; 1–4 thumbnail
// candidates saved to Outputs; editable caption preview; hashtag platform/count with copyable caption), the required model with
// inline Install (Model Download, FR-124), jobs that survive closing the sheet (R-131 on open) and the 7-day "Generated" list.
// Insert is deterministic (no Editor Agent plan): R-134 applies the finished job's proposed ops (no re-run); a generated Asset
// without proposed ops falls back to R-035.
import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Trash2 } from 'lucide-react';
import { EmError } from '@expertmotion/shared';
import { useStore } from '../state/store.js';
import type { GeneratorJobDto, GeneratorKind, GeneratorModelDto } from '../api/types.js';
import { Badge, Button, ErrorBox, Field, Modal, Progress, cx, inputCls } from '../components/ui.js';
import { GENERATOR_MODEL, useGeneratorCards } from '../library/Generators.js';
import { formatBytes, formatDuration } from '../i18n/index.js';

type Page = { text: string; startMs: number; durationMs: number; tokens: Array<{ text: string; fromMs: number; toMs: number }> };
const WEEK_MS = 7 * 24 * 3_600_000;
const TASK: Record<GeneratorKind, string | null> = { voice: 'tts', captions: 'stt', thumbnail: 'image', music: 'music', hashtags: null };

/** FR-104: an edited page keeps its timing; word tokens are re-spread evenly over the page when the words changed. */
export function retimePage(p: Page, text: string): Page {
  if (text === p.text) return p;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const step = words.length ? p.durationMs / words.length : 0;
  return { ...p, text, tokens: words.map((w, i) => ({ text: w, fromMs: Math.round(p.startMs + i * step), toMs: Math.round(p.startMs + (i + 1) * step) })) };
}
/** FR-108: finished, not inserted, younger than 7 days. */
export function generatedList(jobs: GeneratorJobDto[], now = Date.now()): GeneratorJobDto[] {
  return jobs.filter((j) => j.status === 'done' && typeof j.result?.['versionId'] !== 'string' && now - Date.parse(j.createdAt) < WEEK_MS);
}

export function GenerateSheet({ kind, onClose }: { kind: GeneratorKind; onClose: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  const p = `scr.generate.${kind}`;
  const cards = useGeneratorCards();
  const card = cards?.find((c) => c.kind === kind) ?? null;
  const priv = Boolean(state.settings?.privateMode);
  const [input, setInput] = useState('');
  const [language, setLanguage] = useState<'id' | 'en'>(state.head?.model?.settings.language ?? 'id');
  // models: the service card is the source of truth; the Model Manager list fills in live download progress
  const fallback: GeneratorModelDto[] = state.models.filter((m) => m.task === TASK[kind]).map((m) => ({ key: m.key, label: m.label, bytes: m.bytesTotal, installed: m.status === 'installed', languages: [], minTier: m.tiers[0] ?? 'T0', belowTier: false, cc0: false }));
  const options = card ? card.models : fallback;
  const defaultKey = card?.model?.key ?? GENERATOR_MODEL[kind] ?? options[0]?.key ?? '';
  const [model, setModel] = useState<string>('');
  const chosenKey = model || (options.find((m) => m.installed)?.key ?? defaultKey);
  const chosen = options.find((m) => m.key === chosenKey) ?? (card?.model?.key === chosenKey ? card.model : null);
  const live = state.models.find((m) => m.key === chosenKey);
  const installed = kind === 'hashtags' || chosenKey === 'frame-composite' || Boolean(live ? live.status === 'installed' : chosen?.installed);
  const downloading = live && (live.status === 'downloading' || live.status === 'verifying');
  const notEnabled = card ? !card.enabled : false;
  // per-kind inputs
  const [speed, setSpeed] = useState(1);
  const [durationS, setDurationS] = useState(30);
  const [instrumental, setInstrumental] = useState(true);
  const [count, setCount] = useState(kind === 'hashtags' ? 15 : 1);
  const [prompt, setPrompt] = useState('');
  const [platform, setPlatform] = useState<'tiktok' | 'instagram' | 'youtube'>('tiktok');
  const [pages, setPages] = useState<Page[] | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // job
  const [job, setJob] = useState<GeneratorJobDto | null>(null);
  const [history, setHistory] = useState<GeneratorJobDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const [insertJobId, setInsertJobId] = useState<string | null>(null);
  const pid = state.project?.id;
  const loadHistory = useMemo(() => async () => {
    if (!pid) return;
    try {
      const r = await runtime.api.listGeneratorJobs(pid, { kind, limit: 50 });
      setHistory(r.items);
      // FR-107: a job started earlier keeps running after the sheet closed; reopening adopts it
      setJob((cur) => cur ?? r.items.find((j) => j.status === 'running' || j.status === 'queued') ?? null);
    } catch { /* list optional */ }
  }, [pid, kind, runtime]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => { if (!state.models.length) void actions.loadModels(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!job || (job.status !== 'running' && job.status !== 'queued')) return;
    const h = setInterval(() => { void runtime.api.getGeneratorJob(job.id).then((j) => { setJob(j); if (j.status !== 'running' && j.status !== 'queued') void loadHistory(); }).catch(() => undefined); }, 500);
    return () => clearInterval(h);
  }, [job, runtime, loadHistory]);
  useEffect(() => {
    if (job?.status === 'done' && kind === 'captions' && Array.isArray(job.result?.['pages'])) setPages(job.result['pages'] as Page[]);
    if (job?.status === 'done' && kind === 'thumbnail') setCandidate(((job.result?.['candidates'] as Array<{ assetId: string }> | undefined)?.[0]?.assetId) ?? job.resultAssetId);
    if (job?.status === 'failed' && job.errorCode) setError(job.errorCode);
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const install = async () => {
    if (!chosenKey) return;
    try { await runtime.api.installModel(chosenKey); await actions.loadModels(); } catch (e) { setError(e instanceof EmError ? e.code : 'EM-7002'); }
  };
  const run = async () => {
    if (!state.project) return;
    setError(null); setSaved(null); setPages(null);
    const assetId = state.assets.find((a) => a.kind === 'video' && a.status === 'ready' && a.hasAudio !== false)?.id ?? state.assets.find((a) => a.kind === 'video' && a.status === 'ready')?.id;
    const modelKey = chosenKey && chosenKey !== 'frame-composite' ? { modelKey: chosenKey } : {};
    const body: Record<string, unknown> = kind === 'captions' ? { assetId, language, ...modelKey }
      : kind === 'voice' ? { text: input, voiceId: chosenKey, language, speed, atMs: state.playheadMs }
        : kind === 'music' ? { prompt: input, durationMs: durationS * 1000, instrumental, ...modelKey }
          : kind === 'thumbnail' ? { frameMs: state.playheadMs, ...(input.trim() ? { titleText: input } : {}), ...(prompt.trim() ? { prompt } : {}), count }
            : { language, platform, count };
    try { const j = await runtime.api.createGeneratorJob(state.project.id, kind, body); setJob(j); return j; } catch (e) { setError(e instanceof EmError ? e.code : 'EM-9001'); return null; }
  };
  const inserted = () => { void actions.refreshHead(); actions.toast('success', 'ui.scr.generate.inserted', { kind: t(`ui.lib.generator.${kind}.title`) }); onClose(); };
  useEffect(() => {
    if (!insertJobId || !job || job.id !== insertJobId || job.status === 'running' || job.status === 'queued') return;
    setInserting(false); setInsertJobId(null);
    if (job.status === 'done' && job.result?.['versionId']) inserted();
  }, [job, insertJobId]); // eslint-disable-line react-hooks/exhaustive-deps
  const insertJob = async (j: GeneratorJobDto, editedPages?: Page[] | null) => {
    if (!state.project) return;
    if (j.result?.['versionId']) { inserted(); return; }                     // already applied by an insert:true run
    try {
      if (Array.isArray(j.result?.['proposedOps']) && (j.result!['proposedOps'] as unknown[]).length) await runtime.api.insertGeneratorResult(j.id, editedPages ? { pages: editedPages } : undefined);
      else if (j.resultAssetId) await runtime.api.insertAssets(state.project.id, { assetIds: [j.resultAssetId], order: 'given', ...(kind === 'voice' ? { atMs: state.playheadMs } : {}) });
      else { setError('EM-9002'); return; }
      inserted();
    } catch (e) { setError(e instanceof EmError ? e.code : 'EM-9001'); }
  };
  const remove = async (j: GeneratorJobDto) => { try { await runtime.api.deleteGeneratorJob(j.id); setHistory((h) => h.filter((x) => x.id !== j.id)); if (job?.id === j.id) setJob(null); } catch (e) { actions.error(e); } };
  const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); setCopied(what); };
  const saveOutput = async () => {
    if (!job || !candidate) return;
    try { const o = await runtime.api.saveGeneratorOutput(job.id, candidate); setSaved(o.fileName); actions.toast('success', 'ui.scr.generate.saved', { name: o.fileName }); } catch (e) { setError(e instanceof EmError ? e.code : 'EM-9001'); }
  };
  const media = (assetId: string) => {
    const a = state.assets.find((x) => x.id === assetId);
    return state.grant ? runtime.api.mediaUrl(state.grant, assetId, a?.media.playable ? 'playable' : 'original') : null;
  };
  const hashtags = Array.isArray(job?.result?.['hashtags']) ? (job!.result!['hashtags'] as unknown[]).map(String) : [];
  const caption = typeof job?.result?.['caption'] === 'string' ? String(job.result['caption']) : '';
  const candidates = (job?.result?.['candidates'] as Array<{ assetId: string; frameMs?: number }> | undefined) ?? (kind === 'thumbnail' && job?.resultAssetId ? [{ assetId: job.resultAssetId }] : []);
  const running = job?.status === 'running' || job?.status === 'queued';
  const textMissing = (kind === 'voice' || kind === 'music') && !input.trim();
  const runReason = notEnabled ? t('err.EM-9004.title') : !installed ? t('ui.lib.generator.needsmodel') : kind === 'hashtags' && priv ? t('err.EM-8202.title')
    : textMissing ? t('ui.scr.generate.input.required') : kind === 'voice' && [...input].length > 2000 ? t('err.EM-7106.title') : null;
  const generated = generatedList(history).filter((j) => j.id !== job?.id);

  return (
    <Modal el={p} sheet width={520} title={t(`ui.lib.generator.${kind}.title`)} onClose={onClose}
      footer={<>
        {running && job && <Button variant="ghost" onClick={() => void runtime.api.cancelGeneratorJob(job.id).then(setJob).catch(actions.error)}>{t('ui.common.cancel')}</Button>}
        <Button el={`${p}.run`} variant="primary" loading={running} disabledReason={runReason} onClick={() => void run()}>{t('ui.scr.generate.run')}</Button>
      </>}>
      <p className="mb-3 text-em-muted">{t(`ui.lib.generator.${kind}.subtitle`)}</p>
      {notEnabled && <div className="mb-3"><ErrorBox code="EM-9004" vars={{ feature: t(`ui.lib.generator.${kind}.title`) }} /></div>}

      {kind !== 'hashtags' && (
        <div data-el={`${p}.model`} className="mb-3 flex flex-col gap-1 rounded-[8px] border border-em-line p-2">
          <div className="flex items-center gap-2">
            <label htmlFor="em-gen-model" className="t-label flex-1">{kind === 'voice' ? t('ui.scr.generate.voice') : t('ui.scr.generate.model')}</label>
            {chosen && <span className="t-mono text-[12px] text-em-muted">{chosen.bytes ? formatBytes(chosen.bytes, lang) : t('ui.lib.generator.nodownload')}</span>}
            <Badge tone={installed ? 'success' : 'info'}>{installed ? t('ui.lib.generator.installed') : t('ui.lib.generator.needsmodel')}</Badge>
          </div>
          <select id="em-gen-model" data-el={kind === 'voice' ? `${p}.voice` : undefined} className={inputCls} value={chosenKey} onChange={(e) => setModel(e.target.value)}>
            {options.length === 0 && <option value={defaultKey}>{chosenKey === 'frame-composite' ? t('ui.scr.generate.thumbnail.frame') : t('ui.scr.generate.nomodel')}</option>}
            {options.map((m) => <option key={m.key} value={m.key}>{m.label}{m.cc0 ? ' · CC0' : ''}{m.installed ? '' : ` · ${t('ui.lib.generator.needsmodel')}`}</option>)}
          </select>
          {chosen?.belowTier && <p className="text-[12px] text-em-warn">{t('err.EM-7005.body', { model: chosen.label })}</p>}
          {kind === 'music' && (card?.tier === 'T0' || chosen?.cc0) && <p data-el={`${p}.cc0`} className="text-[12px] text-em-text-2">{t('ui.scr.generate.music.cc0')}</p>}
          {!installed && !downloading && chosenKey && chosenKey !== 'frame-composite' && (
            <Button el={`${p}.install`} size={28} icon={<Download size={14} />} disabledReason={priv ? t('err.EM-8202.title') : null} onClick={() => void install()}>
              {t('ui.scr.generate.installsize', { size: formatBytes(chosen?.bytes ?? live?.bytesTotal ?? 0, lang) })}
            </Button>
          )}
          {live?.errorCode === 'EM-7006' && !downloading && <p className="text-[12px] text-em-private">{t('err.EM-7006.title')}</p>}
          {downloading && live && (
            <div className="flex items-center gap-2">
              <Progress value={live.bytesTotal ? live.bytesDone / live.bytesTotal : null} label={live.label} />
              <span className="t-mono shrink-0 text-[11px] text-em-muted">{formatBytes(live.bytesDone, lang)} / {formatBytes(live.bytesTotal, lang)}</span>
              <Button size={28} variant="ghost" onClick={() => void runtime.api.cancelModel(live.key).then(() => actions.loadModels()).catch(actions.error)}>{t('ui.common.cancel')}</Button>
            </div>
          )}
        </div>
      )}

      {(kind === 'voice' || kind === 'music' || kind === 'thumbnail') && (
        <Field label={t(`ui.scr.generate.input.${kind}`)} htmlFor="em-gen-input" hint={kind === 'voice' ? t('ui.scr.generate.chars', { n: [...input].length, max: 2000 }) : undefined}>
          <textarea id="em-gen-input" data-el={`${p}.input`} rows={kind === 'thumbnail' ? 2 : 4} maxLength={kind === 'voice' ? 2000 : kind === 'music' ? 300 : 500} className={`${inputCls} h-auto py-1.5`} value={input} onChange={(e) => setInput(e.target.value)} />
        </Field>
      )}
      {(kind === 'captions' || kind === 'hashtags') && <div data-el={`${p}.input`} className="mb-3 text-[12px] text-em-text-2">{t(`ui.scr.generate.input.${kind}`)}</div>}

      <div className="grid grid-cols-2 gap-2">
        {kind !== 'music' && kind !== 'thumbnail' && (
          <Field label={t('ui.scr.generate.language')} htmlFor="em-gen-lang"><select id="em-gen-lang" data-el={`${p}.language`} className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value as 'id' | 'en')}><option value="id">{t('ui.common.lang.id')}</option><option value="en">{t('ui.common.lang.en')}</option></select></Field>
        )}
        {kind === 'voice' && (
          <Field label={t('ui.scr.generate.speed', { speed: speed.toFixed(2) })} htmlFor="em-gen-speed">
            <input id="em-gen-speed" data-el={`${p}.speed`} type="range" min={0.8} max={1.2} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full" />
          </Field>
        )}
        {kind === 'music' && <>
          <Field label={t('ui.scr.generate.duration', { s: durationS })} htmlFor="em-gen-dur">
            <input id="em-gen-dur" data-el={`${p}.duration`} type="range" min={10} max={120} step={5} value={durationS} onChange={(e) => setDurationS(Number(e.target.value))} className="w-full" />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2"><input data-el={`${p}.instrumental`} type="checkbox" checked={instrumental} onChange={(e) => setInstrumental(e.target.checked)} />{t('ui.scr.generate.instrumental')}</label>
        </>}
        {kind === 'thumbnail' && <>
          <Field label={t('ui.scr.generate.thumbnail.prompt')} htmlFor="em-gen-prompt" hint={t('ui.scr.generate.thumbnail.prompt.hint', { time: formatDuration(state.playheadMs) })}>
            <input id="em-gen-prompt" data-el={`${p}.prompt`} className={inputCls} value={prompt} maxLength={1000} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
          <Field label={t('ui.scr.generate.count')} htmlFor="em-gen-count">
            <select id="em-gen-count" data-el={`${p}.count`} className={inputCls} value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
        </>}
        {kind === 'hashtags' && <>
          <Field label={t('ui.scr.generate.platform')} htmlFor="em-gen-platform">
            <select id="em-gen-platform" data-el={`${p}.platform`} className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}><option value="tiktok">TikTok</option><option value="instagram">Instagram</option><option value="youtube">YouTube</option></select>
          </Field>
          <Field label={t('ui.scr.generate.hashtags.count', { n: count })} htmlFor="em-gen-count">
            <input id="em-gen-count" data-el={`${p}.count`} type="range" min={10} max={20} step={1} value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-full" />
          </Field>
          <div className="col-span-2 text-[12px] text-em-text-2">{t('ui.scr.generate.hashtags.model', { model: state.assignments?.brainstorm?.modelId ?? t('ui.agent.footer.nomodel') })}</div>
        </>}
      </div>

      {job && running && <div data-el={`${p}.progress`} className="mt-2"><Progress value={job.progress} label={t('ui.scr.generate.running')} /><span className="text-[12px] text-em-muted">{t('ui.scr.generate.keeprunning')}</span></div>}
      {error && <div className="mt-2"><ErrorBox code={error} /></div>}

      {job?.status === 'done' && (
        <div data-el={`${p}.result`} className="mt-3 flex flex-col gap-2 rounded-[8px] border border-em-line p-2">
          {kind === 'voice' && job.resultAssetId && media(job.resultAssetId) && <audio data-el={`${p}.preview`} controls src={media(job.resultAssetId)!} className="w-full" />}
          {kind === 'music' && job.resultAssetId && media(job.resultAssetId) && <audio data-el={`${p}.preview`} controls src={media(job.resultAssetId)!} className="w-full" />}
          {kind === 'hashtags' && <>
            {caption && <p className="whitespace-pre-wrap">{caption}</p>}
            {hashtags.length > 0 && <div className="flex flex-wrap gap-1">{hashtags.map((h) => <span key={h} className="rounded-full border border-em-line px-2 text-[12px]">{h}</span>)}</div>}
            <div className="flex gap-2">
              {caption && <Button el={`${p}.copycaption`} size={28} icon={<Copy size={14} />} onClick={() => copy(`${caption}\n\n${hashtags.join(' ')}`, 'caption')}>{copied === 'caption' ? t('ui.common.copied') : t('ui.scr.generate.copycaption')}</Button>}
              {hashtags.length > 0 && <Button size={28} icon={<Copy size={14} />} onClick={() => copy(hashtags.join(' '), 'tags')}>{copied === 'tags' ? t('ui.common.copied') : t('ui.scr.generate.copytags')}</Button>}
            </div>
          </>}
          {kind === 'captions' && pages && (
            <div data-el={`${p}.pages`} className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {pages.map((pg, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="t-mono w-12 shrink-0 text-[12px] text-em-muted">{(pg.startMs / 1000).toFixed(1)}s</span>
                  <input aria-label={t('ui.scr.generate.captions.page', { n: i + 1 })} className={inputCls} value={pg.text} onChange={(e) => setPages((cur) => cur!.map((x, k) => (k === i ? retimePage(x, e.target.value) : x)))} />
                </div>
              ))}
            </div>
          )}
          {kind === 'thumbnail' && candidates.length > 0 && <>
            <div role="radiogroup" aria-label={t('ui.scr.generate.candidates')} className="grid grid-cols-2 gap-2">
              {candidates.map((c, i) => (
                <button key={c.assetId} type="button" role="radio" aria-checked={candidate === c.assetId} data-el={`${p}.candidate`} onClick={() => setCandidate(c.assetId)}
                  className={cx('overflow-hidden rounded-[6px] border-2', candidate === c.assetId ? 'border-em-accent' : 'border-em-line')}>
                  {media(c.assetId) ? <img src={media(c.assetId)!} alt={t('ui.scr.generate.candidate', { n: i + 1 })} className="block w-full" /> : <span className="block p-4">{t('ui.scr.generate.candidate', { n: i + 1 })}</span>}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button el={`${p}.saveoutput`} variant="primary" size={28} disabledReason={candidate ? null : t('ui.scr.generate.candidates')} onClick={() => void saveOutput()}>{t('ui.scr.generate.saveoutput')}</Button>
              <span className="text-[12px] text-em-muted">{saved ? t('ui.scr.generate.saved', { name: saved }) : t('ui.scr.generate.thumbnail.asset')}</span>
            </div>
          </>}
          {kind !== 'hashtags' && kind !== 'thumbnail' && <Button el={`${p}.insert`} variant="primary" size={28} loading={inserting} onClick={() => void insertJob(job, kind === 'captions' ? pages : null)}>{t('ui.scr.generate.insert')}</Button>}
        </div>
      )}

      {generated.length > 0 && (
        <div data-el={`${p}.generated`} className="mt-3">
          <div className="t-label mb-1">{t('ui.scr.generate.generated')}</div>
          <ul className="flex flex-col gap-1">
            {generated.map((j) => (
              <li key={j.id} className="flex items-center gap-2 rounded-[6px] border border-em-line px-2 py-1">
                <span className="flex-1 truncate text-[12px]">{new Date(j.createdAt).toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB')}{typeof j.result?.['caption'] === 'string' ? ` · ${String(j.result['caption']).slice(0, 40)}` : ''}</span>
                {kind === 'hashtags' || kind === 'thumbnail'
                  ? <Button size={28} variant="ghost" onClick={() => setJob(j)}>{t('ui.scr.generate.show')}</Button>
                  : <Button el={`${p}.generated.insert`} size={28} onClick={() => void insertJob(j)}>{t('ui.scr.generate.insert')}</Button>}
                <Button el={`${p}.generated.delete`} size={28} variant="danger-ghost" icon={<Trash2 size={14} />} onClick={() => void remove(j)}>{t('ui.common.remove')}</Button>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-em-muted">{t('ui.scr.generate.generated.note')}</p>
        </div>
      )}
      {kind === 'hashtags' && priv && <p className="mt-2 text-em-private">{t('err.EM-8202.title')}</p>}
    </Modal>
  );
}
