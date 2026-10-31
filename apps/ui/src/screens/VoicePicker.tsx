// FR-246 voice picker (scr.generate.voice.*; QA 2026-10-28 #8 "belum bisa memilih suara narator"): every narrator voice for the
// language — local voices (offline) and cloud voices of the Creator's own connections — with a description search ("suara
// perempuan hangat"), gender / local / cloud filters, a preview sample per voice, why a voice cannot run yet (install the model /
// connect the provider / Private Mode), the ElevenLabs / Azure / Google Cloud keys (FR-269), and a cost estimate for the current text.
// FR-268: the Service sorts the list by naturalness for the language (what can run now first) and marks ONE recommended voice,
// which is the default choice.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pause, Play } from 'lucide-react';
import { EmError } from '@expertmotion/shared';
import { useStore } from '../state/store.js';
import type { VoiceDto, VoiceListDto } from '../api/types.js';
import { Badge, Button, cx, inputCls } from '../components/ui.js';
import { formatNumber } from '../i18n/index.js';

type Filter = 'all' | 'female' | 'male' | 'local' | 'cloud';
/** Same scoring idea as packages/models rankVoices, kept tiny for the search box (the Service resolves descriptions for plans). */
export function matchVoice(v: VoiceDto, q: string): number {
  const words = q.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = [v.name, v.provider, ...v.traits.id, ...v.traits.en, v.gender === 'female' ? 'perempuan wanita female' : v.gender === 'male' ? 'laki pria male' : 'netral'].join(' ').toLowerCase();
  return words.filter((w) => hay.includes(w)).length;
}
/** Estimated cost of `chars` characters with `v` (USD), null for local voices. */
export const voiceCost = (v: VoiceDto, chars: number): number | null => (v.cloud && v.usdPer1kChars ? (chars / 1000) * v.usdPer1kChars : null);

export function VoicePicker({ language, value, onChange, chars }: { language: 'id' | 'en'; value: string; onChange: (v: VoiceDto | null) => void; chars: number }) {
  const { runtime, actions, t, lang, state } = useStore();
  const [list, setList] = useState<VoiceListDto | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<{ id: string; code: string } | null>(null);
  const [elKey, setElKey] = useState('');
  const [elBusy, setElBusy] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<string, string>());
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Review U6: reload when a model is installed / removed (not on every download progress tick); only the newest answer is used
  // (switching id → en while a request is out never shows the other language's list). A failed load says so with Try again.
  const seq = useRef(0);
  const load = useMemo(() => (refresh = false) => {
    const n = ++seq.current;
    return runtime.api.listVoices(language, refresh).then((l) => { if (seq.current === n) { setList(l); setLoadErr(null); } })
      .catch((e: unknown) => { if (seq.current === n) { setList({ items: [], privateMode: false, elevenLabsKey: null }); setLoadErr(e instanceof EmError ? e.code : 'EM-9001'); } });
  }, [runtime, language]);
  const installedKey = state.models.filter((m) => m.status === 'installed').map((m) => m.key).sort().join('|');
  useEffect(() => { void load(); }, [load, installedKey]);
  useEffect(() => () => { audio.current?.pause(); for (const u of urls.current.values()) URL.revokeObjectURL(u); }, []);
  const items = list?.items ?? [];
  const selected = items.find((v) => v.id === value) ?? null;
  // FR-268: the recommended voice (most natural that can run now) is the default; older Services: the first that can run
  useEffect(() => { if (!value && items.length) onChange(items.find((v) => v.recommended) ?? items.find((v) => v.availability === 'ready') ?? items[0]!); }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Operator 2026-10-31 ("gratis model selalu di atas"): free offline voices come first, then cloud voices that can run now, then
  // cloud voices still needing a key; inside a group the Service order (naturalness) is kept; a search only moves better matches up.
  const group = (v: VoiceDto) => (!v.cloud ? 0 : v.availability === 'ready' ? 1 : 2);
  const shown = items.map((v, i) => ({ v, i })).filter(({ v }) => (filter === 'all' || (filter === 'local' ? !v.cloud : filter === 'cloud' ? v.cloud : v.gender === filter)))
    .map((x) => ({ ...x, s: matchVoice(x.v, q) })).filter((x) => !q.trim() || x.s > 0).sort((a, b) => b.s - a.s || group(a.v) - group(b.v) || a.i - b.i).map((x) => x.v);
  const firstPaid = shown.findIndex((v) => v.cloud);
  // "Hubungkan" on a cloud voice without a key opens that provider's key field (voice-only keys here; chat providers on their screen)
  const [openKey, setOpenKey] = useState<'elevenlabs' | 'azure' | 'google' | null>(null);
  const keysRef = useRef<HTMLDivElement | null>(null);
  const connect = (v: VoiceDto) => {
    if (v.provider === 'elevenlabs' || v.provider === 'azure' || v.provider === 'google') { setOpenKey(v.provider); setTimeout(() => keysRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0); }
    else actions.setScreen({ kind: 'providers' });
  };
  const play = async (v: VoiceDto) => {
    if (playing === v.id) { audio.current?.pause(); setPlaying(null); return; }
    setPreviewErr(null);
    try {
      let url = urls.current.get(v.id);
      if (!url) { url = URL.createObjectURL(await runtime.api.voicePreview(v.id, language)); urls.current.set(v.id, url); }
      audio.current?.pause();
      const a = new Audio(url); audio.current = a; a.onended = () => setPlaying(null);
      setPlaying(v.id); await a.play().catch(() => setPlaying(null));
    } catch (e) { setPlaying(null); setPreviewErr({ id: v.id, code: e instanceof EmError ? e.code : 'EM-9001' }); }
  };
  const install = (v: VoiceDto) => { if (v.modelKey) void runtime.api.installModel(v.modelKey).then(() => actions.loadModels()).catch(actions.error); };
  const saveKey = async () => {
    setElBusy(true);
    try { await runtime.api.setElevenLabsKey(elKey); setElKey(''); await load(true); actions.toast('success', 'ui.scr.generate.voice.el.saved'); } catch (e) { actions.error(e); } finally { setElBusy(false); }
  };
  const cost = selected ? voiceCost(selected, chars) : null;
  const local = (v: VoiceDto) => (lang === 'id' ? v.traits.id : v.traits.en).slice(0, 3).join(', ');
  const status = (v: VoiceDto) => (v.availability === 'ready' ? null : t(`ui.scr.generate.voice.avail.${v.availability}`, { provider: t(`ui.scr.generate.voice.provider.${v.provider}`) }));
  return (
    <div data-el="scr.generate.voice.picker" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input data-el="scr.generate.voice.search" aria-label={t('ui.scr.generate.voice.search')} placeholder={t('ui.scr.generate.voice.search')} className={cx(inputCls, '!h-7 flex-1')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div role="radiogroup" aria-label={t('ui.scr.generate.voice.filter')} data-el="scr.generate.voice.filter" className="flex overflow-hidden rounded-[6px] border border-em-line text-[12px]">
          {(['all', 'female', 'male', 'local', 'cloud'] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)} className={cx('px-2 py-0.5', filter === f ? 'bg-em-accent text-em-accent-ink' : 'bg-em-panel-2 text-em-text-2')}>{t(`ui.scr.generate.voice.filter.${f}`)}</button>
          ))}
        </div>
      </div>
      {list?.privateMode && <p data-el="scr.generate.voice.private" className="text-[12px] text-em-private">{t('ui.scr.generate.voice.privatemode')}</p>}
      <ul data-el="scr.generate.voice.list" role="listbox" aria-label={t('ui.scr.generate.voice')} className="flex max-h-56 flex-col gap-1 overflow-y-auto">
        {!list && <li className="text-[12px] text-em-muted">{t('ui.scr.generate.voice.loading')}</li>}
        {loadErr && <li data-el="scr.generate.voice.error" role="alert" className="flex items-center gap-2 text-[12px] text-em-danger">{t(`err.${loadErr}.title`)} · {loadErr}
          <button type="button" className="font-semibold text-em-accent underline" onClick={() => { setList(null); void load(true); }}>{t('ui.lib.assets.error.retry')}</button></li>}
        {list && !loadErr && shown.length === 0 && <li className="text-[12px] text-em-muted">{t('ui.scr.generate.voice.none')}</li>}
        {list && !loadErr && shown.length > 0 && !shown[0]!.cloud && <li data-el="scr.generate.voice.group.free" className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-em-success">{t('ui.scr.generate.voice.group.free')}</li>}
        {shown.map((v, idx) => (<Fragment key={v.id}>
          {idx === firstPaid && firstPaid >= 0 && <li data-el="scr.generate.voice.group.paid" className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-em-muted">{t('ui.scr.generate.voice.group.paid')}</li>}
          <li role="option" aria-selected={v.id === value} data-el="scr.generate.voice.row" data-voice-id={v.id} data-free={!v.cloud}
            className={cx('flex items-center gap-2 rounded-[6px] border px-2 py-1', v.id === value ? 'border-em-accent' : 'border-em-line')}>
            <button type="button" data-el="scr.generate.voice.preview" aria-label={t('ui.scr.generate.voice.preview', { name: v.name })} title={status(v) ?? t('ui.scr.generate.voice.preview', { name: v.name })}
              disabled={v.availability !== 'ready'} onClick={() => void play(v)} className="text-em-text-2 disabled:opacity-40">
              {playing === v.id ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => onChange(v)}>
              <span className="truncate text-[13px]">{v.name} <span className="text-[11px] text-em-muted">· {t(`ui.scr.generate.voice.gender.${v.gender}`)}{local(v) ? ` · ${local(v)}` : ''}</span></span>
              {status(v) && <span className="text-[11px] text-em-warn">{status(v)}</span>}
              {previewErr?.id === v.id && <span className="text-[11px] text-em-danger">{t(`err.${previewErr.code}.title`)} · {previewErr.code}</span>}
            </button>
            {v.recommended && <Badge el="scr.generate.voice.recommended" tone="accent" title={t('ui.scr.generate.voice.recommended.tip')}>{t('ui.scr.generate.voice.recommended')}</Badge>}
            <Badge tone={v.cloud ? 'warn' : 'success'} title={v.cloud ? t('ui.scr.generate.voice.group.paid') : t('ui.scr.generate.voice.group.free')}>{v.cloud ? `${t('ui.scr.generate.voice.paid')} · ${t(`ui.scr.generate.voice.provider.${v.provider}`)}` : t('ui.scr.generate.voice.free')}</Badge>
            {v.cloud && v.usdPer1kChars ? <span className="t-mono shrink-0 text-[11px] text-em-muted" title={t('ui.scr.generate.voice.cost.hint')}>${formatNumber(v.usdPer1kChars, lang, 3)}/1k</span> : null}
            {v.cloud && v.availability === 'no-connection' && <Button el="scr.generate.voice.connect" size={28} title={t('ui.scr.generate.voice.connect.tip')} onClick={() => connect(v)}>{t('ui.scr.generate.voice.connect')}</Button>}
            {v.availability === 'model-missing' && <Button el="scr.generate.voice.install" size={28} icon={<Download size={12} />} loading={state.models.some((m) => m.key === v.modelKey && (m.status === 'downloading' || m.status === 'verifying'))} onClick={() => install(v)}>{t('ui.scr.generate.voice.install')}</Button>}
          </li>
        </Fragment>))}
      </ul>
      {selected && (
        <div data-el="scr.generate.voice.selected" className="text-[12px] text-em-text-2">
          {t('ui.scr.generate.voice.chosen', { name: selected.name })}
          {selected.note ? ` · ${lang === 'id' ? selected.note.id : selected.note.en}` : ''}
          {cost !== null && <span data-el="scr.generate.voice.cost"> · {t('ui.scr.generate.voice.cost', { usd: formatNumber(cost, lang, 4), chars })}</span>}
        </div>
      )}
      <div ref={keysRef} data-el="scr.generate.voice.keys" className="mt-1 flex flex-col gap-1 rounded-[6px] border border-em-line bg-em-panel-2 px-2 py-1.5">
        <p className="text-[12px] font-semibold text-em-text">{t('ui.scr.generate.voice.keys.title')}</p>
        <p className="text-[11px] text-em-muted">{t('ui.scr.generate.voice.keys.hint')}</p>
      <details data-el="scr.generate.voice.el" className="text-[12px]" open={openKey === 'elevenlabs' || undefined}>
        <summary className="cursor-pointer text-em-text-2">{list?.elevenLabsKey ? t('ui.scr.generate.voice.el.connected', { hint: list.elevenLabsKey }) : t('ui.scr.generate.voice.el.add')}</summary>
        <div className="mt-1 flex items-center gap-2">
          <input type="password" autoComplete="off" aria-label={t('ui.scr.generate.voice.el.key')} placeholder={t('ui.scr.generate.voice.el.key')} className={cx(inputCls, '!h-7 flex-1')} value={elKey} onChange={(e) => setElKey(e.target.value)} />
          <Button size={28} loading={elBusy} disabledReason={elKey.trim().length < 10 ? t('ui.scr.generate.voice.el.key') : list?.privateMode ? t('err.EM-8202.title') : null} onClick={() => void saveKey()}>{t('ui.common.save')}</Button>
          {list?.elevenLabsKey && <Button size={28} variant="danger-ghost" onClick={() => void runtime.api.deleteElevenLabsKey().then(() => load(true)).catch(actions.error)}>{t('ui.common.remove')}</Button>}
        </div>
        <p className="mt-1 text-em-muted">{t('ui.scr.generate.voice.el.note')}</p>
      </details>
      <CloudKeyForm el="scr.generate.voice.azure" hint={list?.azureKey ?? null} detail={list?.azureRegion ?? null} region privateMode={list?.privateMode === true} open={openKey === 'azure'}
        save={(k, r) => runtime.api.setAzureKey(k, r ?? '')} remove={() => runtime.api.deleteAzureKey()} done={() => load(true)} provider="azure" />
      <CloudKeyForm el="scr.generate.voice.google" hint={list?.googleCloudKey ?? null} detail={null} privateMode={list?.privateMode === true} open={openKey === 'google'}
        save={(k) => runtime.api.setGoogleCloudKey(k)} remove={() => runtime.api.deleteGoogleCloudKey()} done={() => load(true)} provider="google" />
      </div>
    </div>
  );
}

/** FR-269: a voice-only key (Azure AI Speech key + region, Google Cloud Text-to-Speech key): checked by the Service, hint only. */
function CloudKeyForm({ el, hint, detail, region, privateMode, save, remove, done, provider, open }: { el: string; hint: string | null; detail: string | null; region?: boolean; privateMode: boolean;
  save: (key: string, region?: string) => Promise<unknown>; remove: () => Promise<void>; done: () => Promise<void>; provider: 'azure' | 'google'; open?: boolean }) {
  const prefix = `ui.scr.generate.voice.${provider}`;
  const { actions, t } = useStore();
  const [key, setKey] = useState(''); const [reg, setReg] = useState(detail ?? 'southeastasia'); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await save(key, region ? reg : undefined); setKey(''); await done(); actions.toast('success', `${prefix}.saved`); } catch (e) { actions.error(e); } finally { setBusy(false); }
  };
  const why = key.trim().length < 10 ? t(`${prefix}.key`) : region && !/^[a-z][a-z0-9]{2,30}$/.test(reg.trim().toLowerCase()) ? t(`${prefix}.region`) : privateMode ? t('err.EM-8202.title') : null;
  return (
    <details data-el={el} className="text-[12px]" open={open || undefined}>
      <summary className="cursor-pointer text-em-text-2">{hint ? t(`${prefix}.connected`, { hint: detail ? `${hint} · ${detail}` : hint }) : t(`${prefix}.add`)}</summary>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input type="password" autoComplete="off" data-el={`${el}.key`} aria-label={t(`${prefix}.key`)} placeholder={t(`${prefix}.key`)} className={cx(inputCls, '!h-7 min-w-[180px] flex-1')} value={key} onChange={(e) => setKey(e.target.value)} />
        {region && <input data-el={`${el}.region`} aria-label={t(`${prefix}.region`)} title={t(`${prefix}.region`)} placeholder="southeastasia" className={cx(inputCls, '!h-7 w-[140px]')} value={reg} onChange={(e) => setReg(e.target.value)} />}
        <Button el={`${el}.save`} size={28} loading={busy} disabledReason={why} onClick={() => void submit()}>{t('ui.common.save')}</Button>
        {hint && <Button el={`${el}.remove`} size={28} variant="danger-ghost" onClick={() => void remove().then(done).catch(actions.error)}>{t('ui.common.remove')}</Button>}
      </div>
      <p className="mt-1 text-em-muted">{t(`${prefix}.note`)}</p>
    </details>
  );
}
