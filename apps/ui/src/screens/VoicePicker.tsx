// FR-246 voice picker (scr.generate.voice.*; QA 2026-10-28 #8 "belum bisa memilih suara narator"): every narrator voice for the
// language — local voices (offline) and cloud voices of the Creator's own connections — with a description search ("suara
// perempuan hangat"), gender / local / cloud filters, a preview sample per voice, why a voice cannot run yet (install the model /
// connect the provider / Private Mode), the ElevenLabs key, and a cost estimate for the current text.
import { useEffect, useMemo, useRef, useState } from 'react';
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
  const load = useMemo(() => (refresh = false) => runtime.api.listVoices(language, refresh).then(setList).catch(() => setList({ items: [], privateMode: false, elevenLabsKey: null })), [runtime, language]);
  useEffect(() => { void load(); }, [load, state.models]);
  useEffect(() => () => { audio.current?.pause(); for (const u of urls.current.values()) URL.revokeObjectURL(u); }, []);
  const items = list?.items ?? [];
  const selected = items.find((v) => v.id === value) ?? null;
  // the first voice that can run now becomes the default (local first: no cost, offline)
  useEffect(() => { if (!value && items.length) onChange(items.find((v) => v.availability === 'ready' && !v.cloud) ?? items.find((v) => v.availability === 'ready') ?? items[0]!); }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = items.filter((v) => (filter === 'all' || (filter === 'local' ? !v.cloud : filter === 'cloud' ? v.cloud : v.gender === filter)))
    .map((v) => ({ v, s: matchVoice(v, q) })).filter((x) => !q.trim() || x.s > 0).sort((a, b) => b.s - a.s || Number(b.v.availability === 'ready') - Number(a.v.availability === 'ready')).map((x) => x.v);
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
        {list && shown.length === 0 && <li className="text-[12px] text-em-muted">{t('ui.scr.generate.voice.none')}</li>}
        {shown.map((v) => (
          <li key={v.id} role="option" aria-selected={v.id === value} data-el="scr.generate.voice.row" data-voice-id={v.id}
            className={cx('flex items-center gap-2 rounded-[6px] border px-2 py-1', v.id === value ? 'border-em-accent' : 'border-em-line')}>
            <button type="button" data-el="scr.generate.voice.preview" aria-label={t('ui.scr.generate.voice.preview', { name: v.name })} title={t('ui.scr.generate.voice.preview', { name: v.name })}
              disabled={v.availability !== 'ready'} onClick={() => void play(v)} className="text-em-text-2 disabled:opacity-40">
              {playing === v.id ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => onChange(v)}>
              <span className="truncate text-[13px]">{v.name} <span className="text-[11px] text-em-muted">· {t(`ui.scr.generate.voice.gender.${v.gender}`)}{local(v) ? ` · ${local(v)}` : ''}</span></span>
              {status(v) && <span className="text-[11px] text-em-warn">{status(v)}</span>}
              {previewErr?.id === v.id && <span className="text-[11px] text-em-danger">{t(`err.${previewErr.code}.title`)} · {previewErr.code}</span>}
            </button>
            <Badge tone={v.cloud ? 'info' : 'success'}>{v.cloud ? t(`ui.scr.generate.voice.provider.${v.provider}`) : t('ui.scr.generate.voice.offline')}</Badge>
            {v.cloud && v.usdPer1kChars ? <span className="t-mono shrink-0 text-[11px] text-em-muted" title={t('ui.scr.generate.voice.cost.hint')}>${formatNumber(v.usdPer1kChars, lang, 3)}/1k</span> : null}
            {v.availability === 'model-missing' && <Button el="scr.generate.voice.install" size={28} icon={<Download size={12} />} onClick={() => install(v)}>{t('ui.scr.generate.voice.install')}</Button>}
          </li>
        ))}
      </ul>
      {selected && (
        <div data-el="scr.generate.voice.selected" className="text-[12px] text-em-text-2">
          {t('ui.scr.generate.voice.chosen', { name: selected.name })}
          {selected.note ? ` · ${lang === 'id' ? selected.note.id : selected.note.en}` : ''}
          {cost !== null && <span data-el="scr.generate.voice.cost"> · {t('ui.scr.generate.voice.cost', { usd: formatNumber(cost, lang, 4), chars })}</span>}
        </div>
      )}
      <details data-el="scr.generate.voice.el" className="text-[12px]">
        <summary className="cursor-pointer text-em-text-2">{list?.elevenLabsKey ? t('ui.scr.generate.voice.el.connected', { hint: list.elevenLabsKey }) : t('ui.scr.generate.voice.el.add')}</summary>
        <div className="mt-1 flex items-center gap-2">
          <input type="password" autoComplete="off" aria-label={t('ui.scr.generate.voice.el.key')} placeholder={t('ui.scr.generate.voice.el.key')} className={cx(inputCls, '!h-7 flex-1')} value={elKey} onChange={(e) => setElKey(e.target.value)} />
          <Button size={28} loading={elBusy} disabledReason={elKey.trim().length < 10 ? t('ui.scr.generate.voice.el.key') : list?.privateMode ? t('err.EM-8202.title') : null} onClick={() => void saveKey()}>{t('ui.common.save')}</Button>
          {list?.elevenLabsKey && <Button size={28} variant="danger-ghost" onClick={() => void runtime.api.deleteElevenLabsKey().then(() => load(true)).catch(actions.error)}>{t('ui.common.remove')}</Button>}
        </div>
        <p className="mt-1 text-em-muted">{t('ui.scr.generate.voice.el.note')}</p>
      </details>
    </div>
  );
}
