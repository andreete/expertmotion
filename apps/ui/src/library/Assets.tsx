// Asset Panel (lib.assets.*): drag-and-drop import (IX-05), Sequence Badges (IX-06), multi-select, Insert (IX-07).
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AudioLines, FileText, Film, Image as ImageIcon, ListPlus, MoreHorizontal, Upload, X } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { AssetDto } from '../api/types.js';
import { Badge, Button, IconButton, Popover, Progress, cx } from '../components/ui.js';
import { formatBytes, formatDuration } from '../i18n/index.js';

const ACCEPT = '.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.aac,.m4a,.ogg,.srt,.vtt';
const KIND_ICON = { video: <Film size={14} />, image: <ImageIcon size={14} />, audio: <AudioLines size={14} />, subtitle: <FileText size={14} /> } as const;

export function AssetPanel() {
  const { state, actions, t, runtime } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [accept, setAccept] = useState(ACCEPT);
  const [errorDismissed, setErrorDismissed] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const assets = state.assets;
  const selected = state.assetSelection.filter((id) => assets.some((a) => a.id === id && a.status === 'ready' && a.kind !== 'subtitle'));
  const failed = assets.filter((a) => a.status === 'failed' && !errorDismissed.includes(a.id));
  const usedIds = new Set([...(state.head?.model?.tracks.video ?? []).map((c) => c.assetId), ...(state.head?.model?.tracks.audio ?? []).map((a) => a.assetId)]);

  const pick = async (acc?: string) => {
    const shell = window.expertmotion;
    if (runtime.mode === 'live' && shell?.pickFiles && state.project) {
      const exts = (acc ?? ACCEPT).split(',').map((x) => x.trim().replace(/^\./, '')).filter(Boolean);
      const paths = await shell.pickFiles({ filters: [{ name: t('ui.lib.assets.title'), extensions: exts }], multiple: true });
      if (paths.length) {
        try { const r = await runtime.api.importAssetPaths(state.project.id, paths); actions.toast('info', 'ui.lib.assets.importing', { count: r.items.length }); }
        catch (e) { actions.error(e); }
      }
      return;
    }
    setAccept(acc ?? ACCEPT);
    setTimeout(() => input.current?.click(), 0);
  };
  useEffect(() => {
    const onImport = (e: Event) => { void pick((e as CustomEvent<{ accept?: string }>).detail?.accept); };
    window.addEventListener('em:import', onImport);
    return () => window.removeEventListener('em:import', onImport);
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    if (dragId) { setDragId(null); return; }
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    // Packaged app: dropped files are imported by path (trusted-caller route); the raw upload exists only in development.
    const shell = window.expertmotion;
    const paths = runtime.mode === 'live' && shell?.getPathsForFiles ? shell.getPathsForFiles(files) : [];
    if (paths.length && state.project) { void runtime.api.importAssetPaths(state.project.id, paths).then((r) => actions.toast('info', 'ui.lib.assets.importing', { count: r.items.length })).catch((err) => actions.error(err)); return; }
    void actions.upload(files);
  };
  const toggle = (id: string) => actions.setAssetSelection(state.assetSelection.includes(id) ? state.assetSelection.filter((x) => x !== id) : [...state.assetSelection, id]);
  const cycleBadge = (a: AssetDto) => {
    const badged = assets.filter((x) => x.sequenceBadge !== null).length;
    if (a.sequenceBadge === null) void actions.setBadge(a.id, badged + 1);
    else if (a.sequenceBadge < badged) void actions.setBadge(a.id, a.sequenceBadge + 1);
    else void actions.setBadge(a.id, null);
  };

  return (
    <section data-el="lib.assets.panel" aria-label={t('ui.lib.assets.title')} className="flex min-h-[160px] flex-col border-t border-em-line">
      <div data-el="lib.assets.drop" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        className={cx('relative flex min-h-0 flex-1 flex-col gap-2 p-3', over && 'shadow-[inset_0_0_0_2px_var(--em-accent)]')}>
        <div className="flex items-center gap-2">
          <span className="t-label flex-1">{t('ui.lib.assets.title')} <span className="t-mono">{assets.length}</span></span>
          <IconButton label={t('ui.lib.assets.import')} icon={<Upload size={16} />} size={28} onClick={() => void pick()} disabledReason={state.project ? null : t('ui.common.noproject')} />
        </div>
        <input ref={input} type="file" multiple accept={accept} hidden aria-hidden tabIndex={-1} data-testid="asset-input"
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) void actions.upload(files); }} />
        {over && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-em-bg/70 text-[14px] font-semibold">{t('ui.lib.assets.drop')}</div>}
        {failed.length > 0 && (
          <div data-el="lib.assets.error" role="alert" className="flex items-center gap-2 rounded-[6px] border-l-2 border-em-danger bg-em-panel-2 px-2 py-1.5">
            <span className="flex-1">{t('ui.lib.assets.error', { count: failed.length })}</span>
            <IconButton label={t('ui.common.dismiss')} icon={<X size={14} />} size={28} onClick={() => setErrorDismissed((d) => [...d, ...failed.map((f) => f.id)])} />
          </div>
        )}
        {assets.length === 0 ? (
          <div data-el="lib.assets.empty" className="flex flex-col items-center gap-1.5 rounded-[8px] border border-dashed border-em-line p-3 text-center">
            <Upload size={24} className="text-em-muted" aria-hidden />
            <span className="font-semibold">{t('ui.lib.assets.empty.title')}</span>
            <span className="text-[11px] text-em-muted">{t('ui.lib.assets.empty.formats')}</span>
            <Button size={28} onClick={() => void pick()} disabledReason={state.project ? null : t('ui.common.noproject')}>{t('ui.lib.assets.empty.button')}</Button>
            <span className="text-[11px] text-em-muted">{t('ui.lib.assets.empty.footnote')}</span>
          </div>
        ) : (
          <ul className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto" aria-label={t('ui.lib.assets.title')}>
            {assets.map((a) => (
              <AssetCard key={a.id} asset={a} selected={state.assetSelection.includes(a.id)} inTimeline={usedIds.has(a.id)} onToggle={() => toggle(a.id)} onBadge={() => cycleBadge(a)}
                onDragStart={() => setDragId(a.id)} onDropOn={() => { if (dragId && dragId !== a.id) void actions.setBadge(dragId, a.sequenceBadge ?? assets.filter((x) => x.sequenceBadge !== null).length + 1); setDragId(null); }} />
            ))}
          </ul>
        )}
        <Button el="lib.assets.insert" variant="primary" size={36} icon={<ListPlus size={16} />} className="w-full"
          aria-label={t('a11y.lib.assets.insert', { count: selected.length })}
          disabledReason={selected.length ? null : t('ui.lib.assets.insert.disabled')} onClick={() => void actions.insert(selected)}>
          {selected.length ? t('ui.lib.assets.insert.count', { count: selected.length }) : t('ui.lib.assets.insert')}
        </Button>
      </div>
    </section>
  );
}

function AssetCard({ asset: a, selected, inTimeline, onToggle, onBadge, onDragStart, onDropOn }: { asset: AssetDto; selected: boolean; inTimeline: boolean; onToggle: () => void; onBadge: () => void; onDragStart: () => void; onDropOn: () => void }) {
  const { state, actions, t, runtime } = useStore();
  const [menu, setMenu] = useState(false);
  const grant = state.grant;
  const thumb = grant && a.media.thumb ? runtime.api.mediaUrl(grant, a.id, 'thumb') : null;
  const playable = grant && a.media.playable && a.kind === 'video' ? runtime.api.mediaUrl(grant, a.id, a.media.proxy ? 'proxy' : 'playable') : null;
  const meta = [a.width && a.height ? `${a.width}×${a.height}` : null, a.fps ? `${a.fps} fps` : null, a.durationMs ? formatDuration(a.durationMs) : null, a.hasAudio ? t('ui.lib.assets.meta.audio') : null, a.bytes ? formatBytes(a.bytes) : null].filter(Boolean).join(' · ');
  const stage = state.ingestStage[a.id];
  const name = [a.name, a.kind, a.durationMs ? formatDuration(a.durationMs) : '', a.sequenceBadge ? t('a11y.lib.assets.order', { n: a.sequenceBadge }) : '', a.status === 'ingesting' ? t('a11y.lib.assets.preparing', { percent: Math.round(a.progress * 100) }) : '', a.status === 'failed' ? t(`err.${a.errorCode ?? 'EM-1001'}.title`) : ''].filter(Boolean).join(', ');
  return (
    <li data-el="lib.assets.card" data-asset-id={a.id} role="group" aria-label={name} draggable onDragStart={onDragStart} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.stopPropagation(); e.preventDefault(); onDropOn(); }}
      className={cx('relative flex flex-col overflow-hidden rounded-[8px] border bg-em-panel', selected ? 'border-em-accent' : a.status === 'failed' ? 'border-em-danger' : 'border-em-line')}>
      <div className="relative aspect-video w-full bg-em-panel-2">
        {thumb ? <img src={thumb} alt={a.name} className="h-full w-full object-cover" /> : playable ? <video src={playable} muted preload="metadata" aria-hidden className="h-full w-full object-cover" />
          : <span className="flex h-full items-center justify-center text-em-muted">{KIND_ICON[a.kind]}</span>}
        <button type="button" data-el="lib.assets.card.badge.sequence" onClick={onBadge} aria-label={a.sequenceBadge ? t('a11y.lib.assets.badge', { n: a.sequenceBadge }) : t('a11y.lib.assets.badge.none')} title={t('ui.lib.assets.badge.hint')}
          className={cx('absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full border px-1 text-[11px] font-bold', a.sequenceBadge ? 'border-em-accent bg-em-accent text-em-accent-ink' : 'border-em-line bg-black/60 text-em-text')}>
          {a.sequenceBadge ?? '+'}
        </button>
        <input type="checkbox" data-el="lib.assets.card.select" checked={selected} onChange={onToggle} aria-label={t('a11y.lib.assets.select', { name: a.name })} disabled={a.status !== 'ready'} className="absolute right-1 top-1 h-4 w-4 accent-[var(--em-accent)]" />
        {inTimeline && <span className="absolute bottom-1 left-1"><Badge tone="accent-2">{t('ui.lib.assets.intimeline')}</Badge></span>}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <span className="text-em-muted">{KIND_ICON[a.kind]}</span>
        <span data-el="lib.assets.card.meta" title={meta || a.name} className="min-w-0 flex-1 truncate text-[12px]">{a.name}</span>
        {a.durationMs ? <span className="t-mono text-[10px] text-em-muted">{formatDuration(a.durationMs)}</span> : null}
        <span className="relative">
          <IconButton label={t('ui.lib.assets.card.menu')} icon={<MoreHorizontal size={14} />} size={28} data-popover-trigger="" onClick={() => setMenu((m) => !m)} />
          {menu && (
            <Popover onClose={() => setMenu(false)} role="menu" align="right" width={200}>
              {a.kind === 'subtitle' && (
                <button type="button" role="menuitem" data-el="lib.assets.card.action.usecaptions" className="w-full rounded-[6px] px-2 py-1.5 text-left hover:bg-em-panel-2"
                  onClick={() => { setMenu(false); void actions.captionsFromAsset(a.id); }}>{t('ui.lib.assets.usecaptions')}</button>
              )}
              <button type="button" role="menuitem" data-el="lib.assets.card.action.remove" className="w-full rounded-[6px] px-2 py-1.5 text-left text-em-danger hover:bg-em-panel-2"
                onClick={() => { setMenu(false); void actions.removeAsset(a.id); }}>{t('ui.common.remove')}</button>
            </Popover>
          )}
        </span>
      </div>
      {a.status === 'ingesting' && (
        <div data-el="lib.assets.card.state.ingesting" className="flex flex-col gap-1 px-1.5 pb-1.5">
          <Progress value={a.progress} label={t('a11y.lib.assets.preparing', { percent: Math.round(a.progress * 100) })} />
          <span className="text-[11px] text-em-muted">{t(`ui.lib.assets.stage.${stage ?? 'probe'}`)}</span>
        </div>
      )}
      {a.status === 'failed' && (
        <div data-el="lib.assets.card.state.unsupported" className="px-1.5 pb-1.5 text-[11px] text-em-danger">
          {t(`err.${a.errorCode ?? 'EM-1001'}.title`)} <span className="t-mono text-em-muted">{a.errorCode}</span>
        </div>
      )}
    </li>
  );
}
