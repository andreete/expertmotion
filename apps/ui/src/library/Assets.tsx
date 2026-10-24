// Asset Panel (lib.assets.*): drag-and-drop import (IX-05), Sequence Badges (IX-06), multi-select, Insert (IX-07).
// FR-029/FR-030 import-then-insert from the Text Panel, FR-043 metadata tooltip with codec, FR-045 checkbox assigns the next
// badge and Shift-click selects a range, FR-046 live reorder preview + sys.live, FR-048 missing state with Locate / Remove,
// FR-053 import-level error banner with a recovery action, FR-054 filter by the Catalogue Search.
// FR-014 / FR-041: the packaged path import (picker, drag-and-drop) shows the cards at once (store.importPaths), each with its
// ingest stage; FR-042 EM-1201 cards offer "Import again"; FR-045 select all (button, Ctrl+A while the panel has focus).
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { AudioLines, CheckSquare, File as FileIcon, FileText, Film, Image as ImageIcon, ListPlus, MoreHorizontal, Upload, X } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { AssetDto } from '../api/types.js';
import { Badge, Button, IconButton, Popover, Progress, cx } from '../components/ui.js';
import { formatBytes, formatDuration } from '../i18n/index.js';

const ACCEPT = '.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.aac,.m4a,.ogg,.srt,.vtt';
const KIND_ICON = { video: <Film size={14} />, image: <ImageIcon size={14} />, audio: <AudioLines size={14} />, subtitle: <FileText size={14} /> } as const;
type PendingInsert = { insert: 'overlay' | 'clip'; atMs: number };

/** FR-046: the badge order after dropping `dragId` onto `targetId` (both must be badged or the dragged one gets the target's place). */
export function reorderPreview(assets: readonly AssetDto[], dragId: string, targetId: string): string[] {
  const order = assets.filter((a) => a.sequenceBadge !== null).sort((a, b) => a.sequenceBadge! - b.sequenceBadge!).map((a) => a.id);
  const target = assets.find((a) => a.id === targetId);
  if (!target || target.sequenceBadge === null || dragId === targetId) return order;
  const without = order.filter((id) => id !== dragId);
  without.splice(Math.min(target.sequenceBadge - 1, without.length), 0, dragId);
  return without;
}
const selectable = (a: AssetDto) => a.status === 'ready' && !a.missing && a.kind !== 'subtitle';
/** FR-045: the ready assets "select all" marks, in panel order (ingesting, failed, missing and caption files are skipped). */
export const selectAllTargets = (shown: readonly AssetDto[]): AssetDto[] => shown.filter(selectable);

export function AssetPanel({ filter = '' }: { filter?: string }) {
  const { state, actions, t, runtime } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [accept, setAccept] = useState(ACCEPT);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const lastClicked = useRef<string | null>(null);
  const pending = useRef(new Map<string, PendingInsert>());       // FR-029/FR-030: assets to insert once ready
  const nextInsert = useRef<PendingInsert | null>(null);
  const assets = state.assets;
  const q = filter.trim().toLowerCase();
  const shown = q ? assets.filter((a) => a.name.toLowerCase().includes(q)) : assets;
  const selected = state.assetSelection.filter((id) => assets.some((a) => a.id === id && selectable(a)));
  const usedIds = new Set([...(state.head?.model?.tracks.video ?? []).map((c) => c.assetId), ...(state.head?.model?.tracks.audio ?? []).map((a) => a.assetId),
    ...(state.head?.model?.tracks.overlay ?? []).flatMap((o) => (o.kind === 'image' ? [o.assetId] : []))]);

  const assetsRef = useRef(assets); assetsRef.current = assets;
  // FR-029 / FR-030: insert imported files as soon as their ingest is ready (image → overlay at the playhead, video → Clip).
  const flushPending = () => {
    for (const [id, p] of [...pending.current]) {
      const a = assetsRef.current.find((x) => x.id === id);
      if (!a || a.status === 'ingesting') continue;
      pending.current.delete(id);
      if (a.status !== 'ready') continue;
      void actions.insert([id], p.insert === 'overlay' && a.kind === 'image' ? { asOverlay: true, atMs: p.atMs } : undefined);
    }
  };
  const remember = (items: readonly AssetDto[], ins: PendingInsert | null) => { if (!ins) return; for (const a of items) pending.current.set(a.id, ins); setTimeout(flushPending, 0); };
  const pick = async (acc?: string, ins: PendingInsert | null = null) => {
    const shell = window.expertmotion;
    if (runtime.mode === 'live' && shell?.pickFiles && state.project) {
      const exts = (acc ?? ACCEPT).split(',').map((x) => x.trim().replace(/^\./, '')).filter(Boolean);
      const paths = await shell.pickFiles({ filters: [{ name: t('ui.lib.assets.title'), extensions: exts }], multiple: !ins });
      if (paths.length) remember(await actions.importPaths(paths), ins);      // cards appear now, then follow ingest (FR-014)
      return;
    }
    nextInsert.current = ins;
    setAccept(acc ?? ACCEPT);
    setTimeout(() => input.current?.click(), 0);
  };
  useEffect(() => {
    const onImport = (e: Event) => {
      const d = (e as CustomEvent<{ accept?: string; insert?: 'overlay' | 'clip'; atMs?: number }>).detail;
      void pick(d?.accept, d?.insert ? { insert: d.insert, atMs: d.atMs ?? 0 } : null);
    };
    const onErr = (e: Event) => setImportErr((e as CustomEvent<{ code: string }>).detail.code);
    window.addEventListener('em:import', onImport);
    window.addEventListener('em:import-error', onErr);
    return () => { window.removeEventListener('em:import', onImport); window.removeEventListener('em:import-error', onErr); };
  });
  useEffect(flushPending, [assets]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    if (dragId) { setDragId(null); setPreview(null); return; }
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    // Packaged app: dropped files are imported by path (trusted-caller route); the raw upload exists only in development.
    const shell = window.expertmotion;
    const paths = runtime.mode === 'live' && shell?.getPathsForFiles ? shell.getPathsForFiles(files) : [];
    if (paths.length && state.project) { void actions.importPaths(paths); return; }                     // FR-041: same immediate cards as the picker
    void actions.upload(files);
  };
  const badgedCount = () => assets.filter((x) => x.sequenceBadge !== null).length;
  // FR-045: select every ready asset (next badges in panel order); when all are selected already, clear the selection.
  const pool = selectAllTargets(shown);
  const allSelected = pool.length > 0 && pool.every((a) => state.assetSelection.includes(a.id));
  const selectAll = async () => {
    if (!pool.length) return;
    if (allSelected) {
      actions.setAssetSelection(state.assetSelection.filter((id) => !pool.some((a) => a.id === id)));
      for (const a of pool) if (a.sequenceBadge !== null) await actions.setBadge(a.id, null);
      return;
    }
    actions.setAssetSelection([...new Set([...state.assetSelection, ...pool.map((a) => a.id)])]);
    let n = badgedCount();
    for (const a of pool) if (a.sequenceBadge === null) await actions.setBadge(a.id, ++n);
    actions.announce(t('ui.lib.assets.selectall.done', { count: pool.length }));
  };
  // FR-042: "Import again" on an interrupted (EM-1201) card: the failed card goes, the picker opens for that kind of file.
  const importAgain = async (a: AssetDto) => {
    await actions.removeAsset(a.id);
    const ext = a.name.includes('.') ? `.${a.name.split('.').pop()!.toLowerCase()}` : undefined;
    void pick(ext && ACCEPT.split(',').includes(ext) ? ext : undefined);
  };
  // FR-045: checking assigns the next free badge, unchecking clears it (the rest renumber); Shift-click selects the range.
  const toggle = async (a: AssetDto, e: MouseEvent) => {
    const on = state.assetSelection.includes(a.id);
    if (e.shiftKey && lastClicked.current && !on) {
      const ids = shown.map((x) => x.id);
      const [i, j] = [ids.indexOf(lastClicked.current), ids.indexOf(a.id)].sort((x, y) => x - y) as [number, number];
      const range = i >= 0 ? shown.slice(i, j + 1).filter((x) => selectable(x) && !state.assetSelection.includes(x.id)) : [a];
      actions.setAssetSelection([...state.assetSelection, ...range.map((x) => x.id)]);
      let n = badgedCount();
      for (const x of range) if (x.sequenceBadge === null) await actions.setBadge(x.id, ++n);
      lastClicked.current = a.id;
      return;
    }
    lastClicked.current = a.id;
    if (on) {
      actions.setAssetSelection(state.assetSelection.filter((x) => x !== a.id));
      if (a.sequenceBadge !== null) await actions.setBadge(a.id, null);
    } else {
      actions.setAssetSelection([...state.assetSelection, a.id]);
      if (a.sequenceBadge === null) await actions.setBadge(a.id, badgedCount() + 1);
    }
  };
  const cycleBadge = (a: AssetDto) => {
    const badged = badgedCount();
    if (a.sequenceBadge === null) void actions.setBadge(a.id, badged + 1);
    else if (a.sequenceBadge < badged) void actions.setBadge(a.id, a.sequenceBadge + 1);
    else void actions.setBadge(a.id, null);
  };
  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? '';
  const dragOver = (target: AssetDto) => {
    if (!dragId) return;
    const next = reorderPreview(assets, dragId, target.id);
    if (preview && next.join() === preview.join()) return;
    setPreview(next);
    actions.announce(t('ui.lib.assets.order.live', { names: next.map(nameOf).join(', ') }));
  };
  const drop = async (target: AssetDto) => {
    const d = dragId; setDragId(null);
    const order = preview; setPreview(null);
    if (!d || d === target.id) return;
    await actions.setBadge(d, target.sequenceBadge ?? badgedCount() + 1);
    if (order) actions.announce(t('ui.lib.assets.order.done', { names: order.map(nameOf).join(', ') }));
  };
  const previewBadge = (a: AssetDto) => (preview ? (preview.indexOf(a.id) >= 0 ? preview.indexOf(a.id) + 1 : null) : a.sequenceBadge);
  // FR-053: the banner's recovery actions follow ERROR_CATALOGUE (EM-6401 Try again · Open Diagnostics; EM-6005 retry the import;
  // EM-1401 / EM-1010 "OK": the body says what to do — remove assets or start a new project / import at most 50).
  const errAction = importErr === 'EM-6401' || importErr === 'EM-6005'
    ? <><Button el="lib.assets.error.action" size={28} onClick={() => { setImportErr(null); void pick(); }}>{t('ui.lib.assets.error.retry')}</Button>
      {importErr === 'EM-6401' && <Button el="lib.assets.error.diagnostics" size={28} variant="ghost" onClick={() => { setImportErr(null); actions.setScreen({ kind: 'diagnostics' }); }}>{t('ui.lib.assets.error.diagnostics')}</Button>}</>
    : <Button el="lib.assets.error.action" size={28} onClick={() => setImportErr(null)}>{importErr ? t(`err.${importErr}.action`) : t('ui.lib.assets.error.ok')}</Button>;
  const onPanelKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); e.stopPropagation(); void selectAll(); }
  };

  return (
    <section data-el="lib.assets.panel" aria-label={t('ui.lib.assets.title')} onKeyDown={onPanelKey} className="flex min-h-[160px] flex-col border-t border-em-line">
      <div data-el="lib.assets.drop" onDragOver={(e) => { e.preventDefault(); if (!dragId) setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        className={cx('relative flex min-h-0 flex-1 flex-col gap-2 p-3', over && 'shadow-[inset_0_0_0_2px_var(--em-accent)]')}>
        <div className="flex items-center gap-2">
          <span className="t-label flex-1">{t('ui.lib.assets.title')} <span className="t-mono">{assets.length}</span></span>
          <IconButton el="lib.assets.selectall" label={allSelected ? t('ui.lib.assets.selectall.clear') : t('ui.lib.assets.selectall')} icon={<CheckSquare size={16} />} size={28} aria-pressed={allSelected}
            onClick={() => void selectAll()} disabledReason={pool.length ? null : t('ui.lib.assets.selectall.none')} />
          <IconButton label={t('ui.lib.assets.import')} icon={<Upload size={16} />} size={28} onClick={() => void pick()} disabledReason={state.project ? null : t('ui.common.noproject')} />
        </div>
        <input ref={input} type="file" multiple accept={accept} hidden aria-hidden tabIndex={-1} data-testid="asset-input"
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; const ins = nextInsert.current; nextInsert.current = null; if (files.length) void actions.upload(files).then((items) => remember(items, ins)); }} />
        {over && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-em-bg/70 text-[14px] font-semibold">{t('ui.lib.assets.drop')}</div>}
        {importErr && (
          <div data-el="lib.assets.error" data-code={importErr} role="alert" className="flex flex-col gap-1 rounded-[6px] border-l-2 border-em-danger bg-em-panel-2 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-semibold">{t(`err.${importErr}.title`)} <span className="t-mono text-[11px] text-em-muted">{importErr}</span></span>
              <IconButton label={t('ui.common.dismiss')} icon={<X size={14} />} size={28} onClick={() => setImportErr(null)} />
            </div>
            <span className="text-[12px] text-em-text-2">{t(`err.${importErr}.body`, { count: 50, name: '' })}</span>
            <div>{errAction}</div>
          </div>
        )}
        {q && <p className="text-[11px] text-em-muted" aria-live="polite">{t('ui.lib.assets.filtered', { count: shown.length, total: assets.length, q: filter.trim() })}</p>}
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
            {shown.map((a) => (
              <AssetCard key={a.id} asset={a} badge={previewBadge(a)} previewing={preview !== null} selected={state.assetSelection.includes(a.id)} inTimeline={usedIds.has(a.id)} onToggle={(e) => void toggle(a, e)} onBadge={() => cycleBadge(a)} onImportAgain={() => void importAgain(a)}
                onDragStart={() => { setDragId(a.id); setPreview(null); }} onDragEnd={() => { setDragId(null); setPreview(null); }} onDragOverCard={() => dragOver(a)} onDropOn={() => void drop(a)} />
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

function AssetCard({ asset: a, badge, previewing, selected, inTimeline, onToggle, onBadge, onImportAgain, onDragStart, onDragEnd, onDragOverCard, onDropOn }: {
  asset: AssetDto; badge: number | null; previewing: boolean; selected: boolean; inTimeline: boolean; onToggle: (e: MouseEvent) => void; onBadge: () => void; onImportAgain: () => void;
  onDragStart: () => void; onDragEnd: () => void; onDragOverCard: () => void; onDropOn: () => void;
}) {
  const { state, actions, t, runtime, lang } = useStore();
  const [menu, setMenu] = useState(false);
  const grant = state.grant;
  const missing = Boolean(a.missing);
  const thumb = grant && a.media.thumb && !missing ? runtime.api.mediaUrl(grant, a.id, 'thumb') : null;
  const playable = grant && a.media.playable && a.kind === 'video' && !missing ? runtime.api.mediaUrl(grant, a.id, a.media.proxy ? 'proxy' : 'playable') : null;
  const audio = a.hasAudio === null ? null : a.hasAudio ? t('ui.lib.assets.meta.audio') : t('ui.lib.assets.meta.noaudio');
  const meta = [a.width && a.height ? `${a.width}×${a.height}` : null, a.fps ? `${a.fps} fps` : null, a.durationMs ? formatDuration(a.durationMs) : null, audio, a.codec ?? null, a.bytes ? formatBytes(a.bytes, lang) : null].filter(Boolean).join(' · ');
  const stage = state.ingestStage[a.id];
  const name = [a.name, a.kind, a.durationMs ? formatDuration(a.durationMs) : '', badge ? t('a11y.lib.assets.order', { n: badge }) : '', a.status === 'ingesting' ? t('a11y.lib.assets.preparing', { percent: Math.round(a.progress * 100) }) : '',
    a.status === 'failed' ? t(`err.${a.errorCode ?? 'EM-1001'}.title`) : '', missing ? t('ui.lib.assets.missing') : ''].filter(Boolean).join(', ');
  return (
    <li data-el="lib.assets.card" data-asset-id={a.id} data-missing={missing || undefined} data-status={a.status} tabIndex={-1} role="group" aria-label={name} title={meta || a.name} draggable={a.sequenceBadge !== null || selectable(a)}
      onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={(e) => { e.preventDefault(); onDragOverCard(); }} onDrop={(e) => { e.stopPropagation(); e.preventDefault(); onDropOn(); }}
      className={cx('relative flex flex-col overflow-hidden rounded-[8px] border bg-em-panel', selected ? 'border-em-accent' : a.status === 'failed' || missing ? 'border-em-danger' : 'border-em-line')}>
      <div className="relative aspect-video w-full bg-em-panel-2">
        {thumb ? <img src={thumb} alt={a.name} className="h-full w-full object-cover" /> : playable ? <video src={playable} muted preload="metadata" aria-hidden className="h-full w-full object-cover" />
          : <span className="flex h-full items-center justify-center text-em-muted">{a.status === 'failed' ? <FileIcon size={14} /> : KIND_ICON[a.kind]}</span>}
        <button type="button" data-el="lib.assets.card.badge.sequence" onClick={onBadge} aria-label={badge ? t('a11y.lib.assets.badge', { n: badge }) : t('a11y.lib.assets.badge.none')} title={t('ui.lib.assets.badge.hint')}
          className={cx('absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full border px-1 text-[11px] font-bold', badge ? 'border-em-accent bg-em-accent text-em-accent-ink' : 'border-em-line bg-black/60 text-em-text', previewing && badge !== a.sequenceBadge && 'ring-2 ring-em-accent-2')}>
          {badge ?? '+'}
        </button>
        <input type="checkbox" data-el="lib.assets.card.select" checked={selected} onChange={() => undefined} onClick={(e) => onToggle(e)} aria-label={t('a11y.lib.assets.select', { name: a.name })} disabled={!selectable(a)} className="absolute right-1 top-1 h-4 w-4 accent-[var(--em-accent)]" />
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
          <span data-stage={stage ?? 'queued'} className="text-[11px] text-em-muted">{t(`ui.lib.assets.stage.${stage ?? 'queued'}`)}</span>
        </div>
      )}
      {a.status === 'failed' && (
        <div data-el="lib.assets.card.state.unsupported" data-code={a.errorCode ?? 'EM-1001'} className="flex flex-col gap-1 px-1.5 pb-1.5 text-[11px] text-em-danger">
          <span>{t(`err.${a.errorCode ?? 'EM-1001'}.title`)} <span className="t-mono text-em-muted">{a.errorCode}</span></span>
          {a.errorCode === 'EM-1201'
            ? <Button el="lib.assets.card.action.importagain" size={28} onClick={onImportAgain}>{t('err.EM-1201.action')}</Button>
            : <Button size={28} onClick={() => void actions.removeAsset(a.id)}>{t('ui.common.remove')}</Button>}
        </div>
      )}
      {missing && (
        <div data-el="lib.assets.card.state.missing" className="flex flex-col gap-1 px-1.5 pb-1.5 text-[11px]">
          <span className="text-em-danger">{t('err.EM-1301.title')} <span className="t-mono text-em-muted">EM-1301</span></span>
          <div className="flex gap-1">
            <Button el="lib.assets.card.action.locate" size={28} onClick={() => void actions.locateAsset(a.id)} disabledReason={window.expertmotion?.pickFiles ? null : t('ui.lib.assets.locate.unavailable')}>{t('ui.lib.assets.locate')}</Button>
            <Button size={28} onClick={() => void actions.removeAsset(a.id)}>{t('ui.common.remove')}</Button>
          </div>
        </div>
      )}
    </li>
  );
}
