// FR-247 CC0 music library (scr.generate.music.library.*; QA 2026-10-28 #9 / #10): curated public-domain tracks browsable by mood,
// each downloaded on demand (verified), previewed, and inserted as the music bed in one click. Licence and credit line are shown
// per track. AI music generation is explained (not offered) because this version does not ship its engine.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pause, Play } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { MusicTrackDto } from '../api/types.js';
import { Badge, Button, Progress, cx } from '../components/ui.js';
import { ExternalLink } from '../components/ExternalLink.js';

/** m:ss — rounded to whole seconds FIRST (review U12: 119.6 s showed "1:60"). */
export const mmss = (s: number): string => { const r = Math.max(0, Math.round(s)); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };

export function MusicLibraryPanel({ onInserted }: { onInserted?: () => void }) {
  const { runtime, actions, state, t } = useStore();
  const [mood, setMood] = useState<string>('');
  const [moods, setMoods] = useState<string[]>([]);
  const [items, setItems] = useState<MusicTrackDto[] | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<string, string>());
  const load = useMemo(() => () => runtime.api.listMusicLibrary(mood ? { mood } : {}).then((r) => { setItems(r.items); setMoods(r.moods); }).catch(() => setItems([])), [runtime, mood]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { audio.current?.pause(); for (const u of urls.current.values()) URL.revokeObjectURL(u); }, []);
  // progress / done / failed arrive as service.notice {kind: 'music-library'} → poll the list while something downloads
  useEffect(() => {
    if (!items?.some((x) => x.status === 'downloading')) return;
    const h = setInterval(() => void load(), 700);
    return () => clearInterval(h);
  }, [items, load]);
  const priv = Boolean(state.settings?.privateMode);
  const download = async (x: MusicTrackDto) => { try { await runtime.api.downloadMusicTrack(x.id); await load(); } catch (e) { actions.error(e); } };
  const play = async (x: MusicTrackDto) => {
    if (playing === x.id) { audio.current?.pause(); setPlaying(null); return; }
    try {
      let url = urls.current.get(x.id);
      if (!url) { url = URL.createObjectURL(await runtime.api.musicTrackAudio(x.id)); urls.current.set(x.id, url); }
      audio.current?.pause(); const a = new Audio(url); audio.current = a; a.onended = () => setPlaying(null);
      setPlaying(x.id); await a.play().catch(() => setPlaying(null));
    } catch (e) { setPlaying(null); actions.error(e); }
  };
  const insert = async (x: MusicTrackDto) => {
    if (!state.project) return;
    setBusy(x.id);
    try { await runtime.api.insertMusicTrack(state.project.id, x.id); void actions.refreshHead(); actions.toast('success', 'ui.scr.generate.music.library.inserted', { title: x.title }); onInserted?.(); } catch (e) { actions.error(e); } finally { setBusy(null); }
  };
  return (
    <div data-el="scr.generate.music.library" className="mb-3 flex flex-col gap-2 rounded-[8px] border border-em-line p-2">
      <div className="flex items-center gap-2"><span className="t-label flex-1">{t('ui.scr.generate.music.library')}</span><Badge tone="success">CC0</Badge></div>
      <p className="text-[12px] text-em-text-2">{t('ui.scr.generate.music.library.note')}</p>
      <div data-el="scr.generate.music.library.moods" role="radiogroup" aria-label={t('ui.scr.generate.music.library.mood')} className="flex flex-wrap gap-1 text-[12px]">
        {['', ...moods].map((m) => (
          <button key={m || 'all'} type="button" role="radio" aria-checked={mood === m} onClick={() => setMood(m)}
            className={cx('rounded-full border px-2', mood === m ? 'border-em-accent bg-em-accent text-em-accent-ink' : 'border-em-line text-em-text-2')}>{t(`ui.scr.generate.music.mood.${m || 'all'}`)}</button>
        ))}
      </div>
      {priv && <p className="text-[12px] text-em-private">{t('ui.scr.generate.music.library.private')}</p>}
      <ul data-el="scr.generate.music.library.list" className="flex max-h-56 flex-col gap-1 overflow-y-auto">
        {!items && <li className="text-[12px] text-em-muted">{t('ui.scr.generate.voice.loading')}</li>}
        {items?.map((x) => (
          <li key={x.id} data-el="scr.generate.music.library.track" data-track-id={x.id} className="flex flex-col gap-1 rounded-[6px] border border-em-line px-2 py-1">
            <div className="flex items-center gap-2">
              <button type="button" data-el="scr.generate.music.library.play" aria-label={t('ui.scr.generate.music.library.play', { title: x.title })} title={x.status !== 'ready' ? t('ui.scr.generate.music.library.play.needsdownload') : undefined} disabled={x.status !== 'ready'} onClick={() => void play(x)} className="text-em-text-2 disabled:opacity-40">
                {playing === x.id ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <span className="min-w-0 flex-1 truncate text-[13px]">{x.title} <span className="text-[11px] text-em-muted">· {x.artist} · {t(`ui.scr.generate.music.mood.${x.mood}`)} · {x.genre} · {mmss(x.durationS)}</span></span>
              {x.status !== 'ready' && x.status !== 'downloading' && <Button el="scr.generate.music.library.download" size={28} icon={<Download size={12} />} disabledReason={priv ? t('err.EM-8202.title') : null} onClick={() => void download(x)}>{t('ui.scr.generate.music.library.download', { mb: (x.bytes / 1e6).toFixed(1) })}</Button>}
              {x.status === 'ready' && <Button el="scr.generate.music.library.insert" size={28} variant="primary" loading={busy === x.id} onClick={() => void insert(x)}>{t('ui.scr.generate.music.library.use')}</Button>}
            </div>
            {x.status === 'downloading' && <Progress value={x.bytes ? x.bytesDone / x.bytes : null} label={x.title} />}
            {x.status === 'failed' && <span className="text-[11px] text-em-warn">{t(`err.${x.errorCode ?? 'EM-7002'}.title`)} · {x.errorCode} · {t('ui.scr.generate.music.library.retry')}</span>}
            <span className="text-[11px] text-em-muted">{x.credit} · <ExternalLink el="scr.generate.music.library.licence" url={x.licence.url} label={x.licence.spdx} action={x.licence.name} /></span>
          </li>
        ))}
      </ul>
      <p data-el="scr.generate.music.ai" className="text-[11px] text-em-muted">{t('ui.scr.generate.music.ai.unavailable')}</p>
    </div>
  );
}
