// scr.start (FR-202; QA 2026-10-27 #2 / #6 / #7): what a launch shows instead of silently reopening the last project.
// Recent projects (click = open, "Mode aman" = open with the chat thread and the live preview hidden), "Proyek baru", "Buka…".
// When the crash-loop guard blocked the last project (it stopped the Editor twice right after opening) or the previous
// session ended abnormally, a notice says so and offers safe open / a new project. Nothing here renders project content, so
// no bad record can take this screen down.
import { useEffect, useState } from 'react';
import { AlertTriangle, FilePlus2, FolderOpen, ShieldCheck } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { ProjectDto } from '../api/types.js';
import { Button, Empty, Spinner, cx } from '../components/ui.js';
import { AppMark } from '../components/AppMark.js';
import { formatDate, formatDuration, type Lang } from '../i18n/index.js';
import { ProjectThumb } from './ProjectDialogs.js';
import { lastBootDecision, setSafeMode, type StartNotice } from '../startup/session-guard.js';
import { withoutScratch } from '../startup/scratch.js';
import { guardUnsaved } from './Lifecycle.js';

export function StartScreen() {
  const { actions, runtime, t, lang } = useStore();
  const [items, setItems] = useState<ProjectDto[] | null>(null);
  const [notice, setNotice] = useState<StartNotice>(() => lastBootDecision()?.notice ?? null);
  const [blocked] = useState<string[]>(() => lastBootDecision()?.blocked ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void runtime.api.recentProjects()
      .then(async (r) => withoutScratch(r.items.length ? r.items : (await runtime.api.listProjects({ limit: 20 })).items))   // FR-260
      .then((list) => { if (alive) setItems(list.slice(0, 12)); })
      .catch((e) => { if (alive) { actions.error(e); setItems([]); } });
    return () => { alive = false; };
  }, [runtime, actions]);
  const open = (p: Pick<ProjectDto, 'id'>, safe: boolean) => {
    if (busy) return;
    setBusy(p.id);
    setSafeMode(safe, p.id);
    void actions.openProject(p.id).finally(() => setBusy(null));
  };
  const create = () => { if (busy) return; setBusy('new'); setSafeMode(false); void actions.newProject().finally(() => setBusy(null)); };
  const name = (id: string) => items?.find((p) => p.id === id)?.name ?? '';
  return (
    <div data-el="scr.start" role="main" aria-labelledby="scr-start-title" className="flex min-h-0 flex-1 justify-center overflow-auto bg-em-bg p-8">
      <div className="flex w-[640px] max-w-full flex-col gap-4">
        <div className="flex items-center gap-3">
          <AppMark size={36} />
          <h1 id="scr-start-title" className="flex-1 text-[20px] font-semibold">{t('ui.scr.start.title')}</h1>
        </div>
        {notice && (
          <div data-el="scr.start.notice" data-kind={notice.kind} role="alert" className={cx('rounded-[8px] border-l-2 bg-em-panel px-4 py-3', notice.kind === 'crash-loop' ? 'border-em-danger' : 'border-em-warn')}>
            <div className={cx('flex items-center gap-2 font-semibold', notice.kind === 'crash-loop' ? 'text-em-danger' : 'text-em-warn')}>
              <AlertTriangle size={16} aria-hidden />{t(notice.kind === 'crash-loop' ? 'ui.scr.start.notice.loop.title' : 'ui.scr.start.notice.abnormal.title')}
            </div>
            <p className="mt-1 text-em-text-2">{notice.kind === 'crash-loop' ? t('ui.scr.start.notice.loop.body', { name: name(notice.projectId) || '—' }) : t('ui.scr.start.notice.abnormal.body')}</p>
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <Button el="scr.start.notice.new" icon={<FilePlus2 size={14} />} onClick={create}>{t('ui.scr.start.new')}</Button>
              <Button el="scr.start.notice.safe" variant="primary" icon={<ShieldCheck size={14} />} loading={busy === notice.projectId}
                onClick={() => { setNotice(null); open({ id: notice.projectId }, true); }}>{t('ui.scr.start.safe')}</Button>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <Button el="scr.start.new" variant="primary" size={36} icon={<FilePlus2 size={16} />} loading={busy === 'new'} onClick={create}>{t('ui.scr.start.new')}</Button>
          <Button el="scr.start.open" size={36} icon={<FolderOpen size={16} />} onClick={() => actions.setScreen({ kind: 'project.open' })}>{t('ui.scr.start.open')}</Button>
        </div>
        <section aria-labelledby="scr-start-recent" className="flex flex-col gap-1">
          <h2 id="scr-start-recent" className="text-[12px] font-semibold uppercase tracking-wide text-em-muted">{t('ui.scr.start.recent')}</h2>
          <ul data-el="scr.start.list" className="flex flex-col gap-1">
            {items === null && <li className="text-em-muted">{t('ui.common.loading')}</li>}
            {items?.length === 0 && <li><Empty title={t('ui.scr.start.empty')} /></li>}
            {items?.map((p) => {
              const bad = blocked.includes(p.id);
              return (
                <li key={p.id} data-el="scr.start.item" data-project={p.id} className={cx('flex items-center gap-2 rounded-[6px] border px-2 py-1.5', bad ? 'border-em-danger' : 'border-em-line')}>
                  <button type="button" data-el="scr.start.item.open" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => (bad ? open(p, true) : open(p, false))}>
                    <ProjectThumb id={p.id} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="text-[11px] text-em-muted">{t('ui.scr.project.open.modified', { date: formatDate(p.updatedAt, lang as Lang) })} · {formatDuration(p.durationMs)}</span>
                    </span>
                    {bad && <span data-el="scr.start.item.failed" className="shrink-0 text-[11px] text-em-danger">{t('ui.scr.start.failed')}</span>}
                    {busy === p.id && <span role="status" className="shrink-0 text-[12px]"><Spinner size={14} label={t('ui.scr.project.open.opening')} /></span>}
                  </button>
                  <Button el="scr.start.item.safe" size={28} variant="ghost" icon={<ShieldCheck size={14} />} onClick={() => open(p, true)}>{t('ui.scr.start.safe.short')}</Button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

/** sys.safe.banner: shown while a project is open in safe mode. */
export function SafeModeBanner({ onExit }: { onExit: () => void }) {
  const { t } = useStore();
  return (
    <div data-el="sys.safe.banner" role="status" className="flex items-center gap-2 border-b border-em-line bg-em-panel px-3 py-1.5 text-[12px]">
      <ShieldCheck size={14} className="text-em-warn" aria-hidden /><span className="flex-1">{t('ui.safe.banner')}</span>
      <Button el="sys.safe.exit" size={28} onClick={onExit}>{t('ui.safe.exit')}</Button>
    </div>
  );
}

/** Placeholder for the chat thread / live preview while safe mode hides them. */
export function SafeModePlaceholder({ part, onShow }: { part: 'chat' | 'preview'; onShow: () => void }) {
  const { t } = useStore();
  return (
    <div data-el={`sys.safe.${part}`} className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-em-muted">
      <ShieldCheck size={20} aria-hidden />
      <p>{t(part === 'chat' ? 'ui.safe.chat.hidden' : 'ui.safe.preview.hidden')}</p>
      <Button el={`sys.safe.${part}.show`} size={28} onClick={onShow}>{t(part === 'chat' ? 'ui.safe.chat.show' : 'ui.safe.preview.show')}</Button>
    </div>
  );
}

/**
 * sys.launch.notice (FR-260): a launch opens an empty project; when the last project stopped the Editor twice right after opening
 * (crash-loop guard, FR-202) or the last session ended abnormally, this notice says so INSIDE the empty project and offers safe
 * open / open again. Dismissable; nothing here renders the other project's content.
 */
export function LaunchNotice() {
  const { actions, runtime, t, state } = useStore();
  const [notice, setNotice] = useState<StartNotice>(() => lastBootDecision()?.notice ?? null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!notice) return undefined;
    let alive = true;
    void runtime.api.getProject(notice.projectId).then((p) => { if (alive) setName(p.name); }).catch(() => { if (alive) setNotice(null); });   // gone: nothing to offer
    return () => { alive = false; };
  }, [notice, runtime]);
  if (!notice || state.project?.id === notice.projectId) return null;
  const loop = notice.kind === 'crash-loop';
  const open = (safe: boolean) => {
    if (busy) return;
    setBusy(true);
    setSafeMode(safe, notice.projectId);
    void actions.openProject(notice.projectId).finally(() => { setBusy(false); setNotice(null); });
  };
  return (
    <div data-el="sys.launch.notice" data-kind={notice.kind} role="alert" className={cx('flex items-center gap-2 border-b border-l-2 border-em-line bg-em-panel px-3 py-1.5 text-[12px]', loop ? 'border-l-em-danger' : 'border-l-em-warn')}>
      <AlertTriangle size={14} className={loop ? 'text-em-danger' : 'text-em-warn'} aria-hidden />
      <span className="min-w-0 flex-1 truncate"><b>{t(loop ? 'ui.scr.start.notice.loop.title' : 'ui.scr.start.notice.abnormal.title')}</b>{' · '}{loop ? t('ui.launch.notice.loop', { name: name || '—' }) : t('ui.launch.notice.abnormal', { name: name || '—' })}</span>
      {loop
        ? <Button el="sys.launch.notice.safe" size={28} icon={<ShieldCheck size={14} />} loading={busy} onClick={() => open(true)}>{t('ui.scr.start.safe')}</Button>
        : <Button el="sys.launch.notice.open" size={28} loading={busy} onClick={() => open(false)}>{t('ui.launch.notice.reopen')}</Button>}
      <Button el="sys.launch.notice.dismiss" size={28} variant="ghost" onClick={() => setNotice(null)}>{t('ui.launch.notice.dismiss')}</Button>
    </div>
  );
}

/**
 * stage.recent (FR-260): the small "Terakhir dibuka" row in the empty project — up to three recent projects (the blank project
 * itself is not listed) and "Semua…" (File ▸ Open). Hidden when there is nothing to list.
 */
export function RecentStrip() {
  const { actions, runtime, t, state } = useStore();
  const [items, setItems] = useState<ProjectDto[]>([]);
  useEffect(() => {
    let alive = true;
    void runtime.api.recentProjects().then((r) => { if (alive) setItems(withoutScratch(r.items).filter((p) => p.id !== state.project?.id).slice(0, 3)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [runtime, state.project?.id]);
  if (!items.length) return null;
  return (
    <nav data-el="stage.recent" aria-label={t('ui.stage.recent.title')} className="flex max-w-full flex-wrap items-center justify-center gap-1 text-[12px] text-em-muted">
      <span>{t('ui.stage.recent.title')}:</span>
      {items.map((p) => (
        <button key={p.id} type="button" data-el="stage.recent.item" data-project={p.id} title={p.name}
          className="max-w-[160px] truncate rounded-full border border-em-line px-2 py-0.5 text-em-text-2 hover:border-em-accent hover:text-em-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-em-accent"
          onClick={() => guardUnsaved({ state, actions }, () => { void actions.openProject(p.id); })}>{p.name}</button>
      ))}
      <button type="button" data-el="stage.recent.all" className="rounded-full px-2 py-0.5 text-em-accent hover:underline" onClick={() => actions.setScreen({ kind: 'project.open' })}>{t('ui.stage.recent.all')}</button>
    </nav>
  );
}
