// Generator sheets (scr.generate.*): forms that call R-130 and show "needs model", running, done, failed states (IX-08).
// In v1.0 (P0) the Local Service answers EM-9004 for every kind; the sheet shows that copy honestly.
// Insert is deterministic (no Editor Agent plan): a generated Asset goes in with R-035; a result without an Asset (captions)
// is re-run with R-130 `insert: true`, which applies the generator's proposed ops directly.
import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { EmError } from '@expertmotion/shared';
import { useStore } from '../state/store.js';
import type { GeneratorJobDto, GeneratorKind } from '../api/types.js';
import { Button, ErrorBox, Field, Modal, Progress, inputCls } from '../components/ui.js';
import { GENERATOR_MODEL } from '../library/Generators.js';

export function GenerateSheet({ kind, onClose }: { kind: GeneratorKind; onClose: () => void }) {
  const { state, runtime, actions, t } = useStore();
  const [input, setInput] = useState('');
  const [language, setLanguage] = useState<'id' | 'en'>(state.head?.model?.settings.language ?? 'id');
  const modelKey = GENERATOR_MODEL[kind];
  const installed = state.models.filter((m) => (kind === 'captions' ? m.task === 'stt' : kind === 'voice' ? m.task === 'tts' : kind === 'thumbnail' ? m.task === 'image' : m.task === 'music') && m.status === 'installed');
  const [model, setModel] = useState(installed[0]?.key ?? modelKey ?? '');
  const [job, setJob] = useState<GeneratorJobDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const [insertJobId, setInsertJobId] = useState<string | null>(null);
  const missing = modelKey ? !state.models.some((m) => m.key === modelKey && m.status === 'installed') : false;
  const p = `scr.generate.${kind}`;
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const h = setInterval(() => { void runtime.api.getGeneratorJob(job.id).then(setJob).catch(() => undefined); }, 500);
    return () => clearInterval(h);
  }, [job, runtime]);
  const run = async (insert = false) => {
    if (!state.project) return;
    setError(null);
    const assetId = state.assets.find((a) => a.kind === 'video' && a.status === 'ready')?.id;
    const body: Record<string, unknown> = kind === 'captions' ? { assetId, language, ...(model ? { modelKey: model } : {}) }
      : kind === 'voice' ? { text: input, voiceId: 'id-news', language, atMs: state.playheadMs }
        : kind === 'music' ? { prompt: input, durationMs: Math.max(5000, state.head?.durationMs ?? 15000) }
          : kind === 'thumbnail' ? { frameMs: state.playheadMs, titleText: input }
            : { language, platform: 'tiktok', count: 10 };
    if (insert && kind !== 'thumbnail' && kind !== 'hashtags') body['insert'] = true;
    try { const j = await runtime.api.createGeneratorJob(state.project.id, kind, body); setJob(j); return j; } catch (e) { setError(e instanceof EmError ? e.code : 'EM-9001'); return null; }
  };
  const inserted = () => { void actions.refreshHead(); actions.toast('success', 'ui.scr.generate.inserted', { kind: t(`ui.lib.generator.${kind}.title`) }); onClose(); };
  useEffect(() => {
    if (!insertJobId || !job || job.id !== insertJobId || job.status === 'running' || job.status === 'queued') return;
    setInserting(false); setInsertJobId(null);
    if (job.status === 'done' && job.result?.['versionId']) inserted();
  }, [job, insertJobId]); // eslint-disable-line react-hooks/exhaustive-deps
  const insert = async () => {
    if (!state.project || !job) return;
    if (job.result?.['versionId']) { inserted(); return; }                  // already applied by an insert:true run
    if (job.resultAssetId) {
      try {
        await runtime.api.insertAssets(state.project.id, { assetIds: [job.resultAssetId], order: 'given', ...(kind === 'voice' ? { atMs: state.playheadMs } : {}) });
        inserted();
      } catch (e) { setError(e instanceof EmError ? e.code : 'EM-9001'); }
      return;
    }
    setInserting(true);
    const j = await run(true);
    if (j) setInsertJobId(j.id); else setInserting(false);
  };
  const hashtags = Array.isArray(job?.result?.['hashtags']) ? (job!.result!['hashtags'] as unknown[]).map(String) : [];
  return (
    <Modal el={p} sheet width={480} title={t(`ui.lib.generator.${kind}.title`)} onClose={onClose}
      footer={<>
        {job?.status === 'running' && <Button variant="ghost" onClick={() => void runtime.api.cancelGeneratorJob(job.id).then(setJob).catch(actions.error)}>{t('ui.common.cancel')}</Button>}
        <Button el={`${p}.run`} variant="primary" loading={job?.status === 'running'} disabledReason={missing ? t('ui.lib.generator.needsmodel') : (kind === 'voice' || kind === 'music') && !input.trim() ? t('ui.scr.generate.input.required') : null} onClick={() => void run()}>{t('ui.scr.generate.run')}</Button>
      </>}>
      <p className="mb-3 text-em-muted">{t(`ui.lib.generator.${kind}.subtitle`)}</p>
      {missing && (
        <div className="mb-3 rounded-[8px] border border-em-info p-2">
          <div className="font-semibold">{t('err.EM-7001.title')}</div>
          <Button size={28} className="mt-1" onClick={() => actions.setScreen({ kind: 'models' })}>{t('ui.scr.generate.install')}</Button>
        </div>
      )}
      {kind !== 'captions' && kind !== 'hashtags' && (
        <Field label={t(`ui.scr.generate.input.${kind}`)} htmlFor="em-gen-input"><textarea id="em-gen-input" data-el={`${p}.input`} rows={4} className={`${inputCls} h-auto py-1.5`} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
      )}
      {(kind === 'captions' || kind === 'hashtags') && <div data-el={`${p}.input`} className="mb-3 text-[12px] text-em-text-2">{t(`ui.scr.generate.input.${kind}`)}</div>}
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('ui.scr.generate.language')} htmlFor="em-gen-lang"><select id="em-gen-lang" data-el={`${p}.language`} className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value as 'id' | 'en')}><option value="id">{t('ui.common.lang.id')}</option><option value="en">{t('ui.common.lang.en')}</option></select></Field>
        <Field label={t('ui.scr.generate.model')} htmlFor="em-gen-model">
          <select id="em-gen-model" data-el={`${p}.model`} className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
            {kind === 'hashtags' ? <option value="">{state.assignments?.brainstorm?.modelId ?? t('ui.agent.footer.nomodel')}</option>
              : installed.length ? installed.map((m) => <option key={m.key} value={m.key}>{m.label}</option>) : <option value="">{t('ui.scr.generate.nomodel')}</option>}
          </select>
        </Field>
      </div>
      {job && (job.status === 'running' || job.status === 'queued') && <div data-el={`${p}.progress`} className="mt-2"><Progress value={job.progress} label={t('ui.scr.generate.running')} /></div>}
      {error && <ErrorBox code={error} />}
      {job?.status === 'done' && (
        <div data-el={`${p}.result`} className="mt-3 flex flex-col gap-2 rounded-[8px] border border-em-line p-2">
          {typeof job.result?.['caption'] === 'string' && <p>{String(job.result['caption'])}</p>}
          {hashtags.length > 0 && <div className="flex flex-wrap gap-1">{hashtags.map((h) => <span key={h} className="rounded-full border border-em-line px-2 text-[12px]">{h}</span>)}</div>}
          {hashtags.length > 0 && <Button size={28} icon={<Copy size={14} />} onClick={() => void navigator.clipboard?.writeText(hashtags.join(' ')).catch(() => undefined)}>{t('ui.common.copy')}</Button>}
          {Array.isArray(job.result?.['pages']) && <table className="text-[12px]"><tbody>{(job.result['pages'] as Array<{ text: string; startMs: number }>).map((pg, i) => <tr key={i}><td className="t-mono pr-2 text-em-muted">{(pg.startMs / 1000).toFixed(1)}s</td><td>{pg.text}</td></tr>)}</tbody></table>}
          {kind !== 'hashtags' && <Button el={`${p}.insert`} variant="primary" size={28} loading={inserting} onClick={() => void insert()}>{t('ui.scr.generate.insert')}</Button>}
        </div>
      )}
    </Modal>
  );
}
