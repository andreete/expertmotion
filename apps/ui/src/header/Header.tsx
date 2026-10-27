// Header (hdr.*): menu tabs, Project Title, header actions, render chip. UI_UX_SPECIFICATION.md §4, EDITOR_INTERACTION_MODEL.md IX-21…IX-25.
import { renderQueue } from '../state/workload.js';
import { LicenceStatus } from '../screens/License.js';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Activity, Archive, ArchiveRestore, BadgeCheck, Boxes, ChevronDown, CircleHelp, Download, Folder, KeyRound, Redo2, Save, Sparkles, Type, Undo2, Wrench,
} from 'lucide-react';
import { OPEN_HARDWARE_EVENT, useStore } from '../state/store.js';
import { Button, IconButton, MenuItem, Popover, Progress, cx } from '../components/ui.js';
import { HardwarePopover } from '../screens/Hardware.js';
import { AppMark } from '../components/AppMark.js';
import type { LibMode } from '../state/reducer.js';
import { formatDuration, translate } from '../i18n/index.js';
import { guardUnsaved } from '../screens/Lifecycle.js';

/** Sample projects (R-025) carry a visible "Sample · " / "Contoh · " marker in the project's language; a name that already starts with it is not doubled. */
export function sampleTitle(name: string, language: 'en' | 'id'): { marker: string; rest: string } {
  const rest = name.replace(/^(Sample|Contoh)\s*·\s*/u, '');
  return { marker: translate(language, 'ui.hdr.title.sample'), rest };
}

export const requestImport = (accept?: string) => window.dispatchEvent(new CustomEvent('em:import', { detail: { accept } }));

export function Header() {
  const { state, actions, t, prefs, setPrefs } = useStore();
  const [menu, setMenu] = useState<'file' | 'help' | 'recent' | 'hardware' | 'license' | null>(null);
  // FR-128: the low-disk banner's "Open Hardware Monitor" action opens the popover.
  useEffect(() => { const open = () => setMenu('hardware'); window.addEventListener(OPEN_HARDWARE_EVENT, open); return () => window.removeEventListener(OPEN_HARDWARE_EVENT, open); }, []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [titleError, setTitleError] = useState(false);
  const p = state.project;
  // QA 2026-10-26 #2: a faceless video (scene clips, texts, shapes) exports too; only a project with nothing on it is blocked.
  const hm = state.head?.model;
  const hasClip = (hm?.tracks.video.length ?? 0) + (hm?.tracks.text.length ?? 0) + (hm?.tracks.overlay.length ?? 0) > 0;
  const exportReason = hasClip ? null : t('ui.hdr.export.disabled');
  const queue = renderQueue(state.renders);
  const rendering = queue.active ?? queue.queued[0];
  const licensed = state.licence?.status === 'licensed';
  const lowResources = state.tick ? state.tick.ramFreeMb < 2048 || (state.tick.diskFreeMb ?? Infinity) < 1024 : false;
  const close = () => setMenu(null);
  const mode = (m: LibMode, el: string, icon: ReactNode, key: string) => (
    <button type="button" role="tab" aria-selected={state.libMode === m} data-el={el} onClick={() => { actions.setLibMode(m); setMenu(null); }}
      className={cx('flex h-12 items-center gap-1.5 px-2.5 text-[13px] font-medium border-b-2 em-trans', state.libMode === m ? 'border-em-accent text-em-text' : 'border-transparent text-em-text-2 hover:text-em-text')}>
      {icon}{t(key)}
    </button>
  );
  const commitTitle = async () => {
    const name = draft.trim();
    if (!name) { setTitleError(true); return; }
    setTitleError(false); setEditing(false);
    if (name !== p?.name) await actions.renameProject(name.slice(0, 80));
  };
  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void commitTitle();
    if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setTitleError(false); }
  };
  const percent = rendering ? Math.round(rendering.progress * 100) : 0;

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center gap-1 border-b border-em-line bg-em-panel px-2">
      <button type="button" data-el="hdr.logo" onClick={() => actions.setScreen({ kind: 'about' })} className="mr-2 flex items-center gap-2 rounded-[6px] px-1 text-[14px] font-bold tracking-tight hover:bg-em-panel-2" aria-label={t('ui.hdr.logo.a11y')}>
        <AppMark size={22} />Expertmotion
      </button>
      <div className="relative">
        <button type="button" data-el="hdr.menu.file" data-popover-trigger="" aria-haspopup="menu" aria-expanded={menu === 'file' || menu === 'recent'} onClick={() => setMenu(menu === 'file' ? null : 'file')}
          className="flex h-12 items-center gap-1 px-2.5 text-[13px] font-medium text-em-text-2 hover:text-em-text"><Folder size={16} aria-hidden />{t('ui.hdr.menu.file')}</button>
        {(menu === 'file' || menu === 'recent') && (
          <Popover onClose={close} role="menu" label={t('ui.hdr.menu.file')} width={280}>
            <MenuItem el="hdr.menu.file.new" shortcut="Ctrl+N" onClick={() => { close(); guardUnsaved({ state, actions }, () => { void actions.newProject(); }); }}>{t('ui.hdr.menu.file.new')}</MenuItem>
            <MenuItem el="hdr.menu.file.newcustom" onClick={() => { close(); guardUnsaved({ state, actions }, () => actions.setScreen({ kind: 'project.new' })); }}>{t('ui.hdr.menu.file.newcustom')}</MenuItem>
            <MenuItem el="hdr.menu.file.open" shortcut="Ctrl+O" onClick={() => { close(); actions.setScreen({ kind: 'project.open' }); }}>{t('ui.hdr.menu.file.open')}</MenuItem>
            <MenuItem el="hdr.menu.file.recent" onClick={() => setMenu(menu === 'recent' ? 'file' : 'recent')}>{t('ui.hdr.menu.file.recent')} ▸</MenuItem>
            {menu === 'recent' && <RecentList onPick={(id) => { close(); if (id !== p?.id) guardUnsaved({ state, actions }, () => { void actions.openProject(id); }); }} />}
            <MenuItem el="hdr.menu.file.save" shortcut="Ctrl+S" disabledReason={p ? null : t('ui.common.noproject')} onClick={() => { close(); void actions.save(); }}>{t('ui.hdr.menu.file.save')}</MenuItem>
            <MenuItem el="hdr.menu.file.saveas" shortcut="Ctrl+Shift+S" disabledReason={p ? null : t('ui.common.noproject')} onClick={() => { close(); actions.setScreen({ kind: 'project.new', saveAs: true }); }}>{t('ui.hdr.menu.file.saveas')}</MenuItem>
            <MenuItem el="hdr.menu.file.import" shortcut="Ctrl+I" disabledReason={p ? null : t('ui.common.noproject')} onClick={() => { close(); requestImport(); }}>{t('ui.hdr.menu.file.import')}</MenuItem>
            <MenuItem el="hdr.menu.file.export" shortcut="Ctrl+E" disabledReason={exportReason} onClick={() => { close(); actions.setScreen({ kind: 'export' }); }}>{t('ui.hdr.menu.file.export')}</MenuItem>
            <MenuItem el="hdr.menu.file.settings" disabledReason={p ? null : t('ui.common.noproject')} onClick={() => { close(); actions.setScreen({ kind: 'project.settings' }); }}>{t('ui.hdr.menu.file.settings')}</MenuItem>
            <div className="my-1 border-t border-em-line" />
            <MenuItem el="hdr.menu.file.recover" disabledReason={p ? null : t('ui.common.noproject')} badge={state.checkpointBadge ? <span className="h-2 w-2 rounded-full bg-em-accent" aria-label={t('ui.hdr.menu.file.recover.badge')} /> : undefined}
              onClick={() => { close(); actions.setScreen({ kind: 'project.recover' }); }}>{t('ui.hdr.menu.file.recover')}</MenuItem>
          </Popover>
        )}
      </div>
      <div role="tablist" aria-label={t('a11y.hdr.menu.tabs')} className="flex">
        {mode('home', 'hdr.menu.home', <Type size={16} aria-hidden />, 'ui.hdr.menu.home')}
        {mode('design', 'hdr.menu.design', <Sparkles size={16} aria-hidden />, 'ui.hdr.menu.design')}
        {mode('tools', 'hdr.menu.tools', <Wrench size={16} aria-hidden />, 'ui.hdr.menu.tools')}
      </div>
      <div className="relative">
        <button type="button" data-el="hdr.menu.help" data-popover-trigger="" aria-haspopup="menu" aria-expanded={menu === 'help'} onClick={() => setMenu(menu === 'help' ? null : 'help')}
          className="flex h-12 items-center gap-1 px-2.5 text-[13px] font-medium text-em-text-2 hover:text-em-text"><CircleHelp size={16} aria-hidden />{t('ui.hdr.menu.help')}</button>
        {menu === 'help' && (
          <Popover onClose={close} role="menu" label={t('ui.hdr.menu.help')} width={240}>
            <MenuItem el="hdr.menu.help.tour" onClick={() => { close(); setPrefs({ tourDone: false }); window.dispatchEvent(new CustomEvent('em:tour', { detail: { source: 'help' } })); }}>{t('ui.hdr.menu.help.tour')}</MenuItem>
            <MenuItem el="hdr.menu.help.onboarding" onClick={() => { close(); actions.setScreen({ kind: 'onboarding' }); }}>{t('ui.hdr.menu.help.onboarding')}</MenuItem>
            <MenuItem el="hdr.menu.help.shortcuts" shortcut="Shift+?" onClick={() => { close(); actions.setScreen({ kind: 'shortcuts' }); }}>{t('ui.hdr.menu.help.shortcuts')}</MenuItem>
            <MenuItem el="hdr.menu.help.diagnostics" onClick={() => { close(); actions.setScreen({ kind: 'diagnostics' }); }}>{t('ui.hdr.menu.help.diagnostics')}</MenuItem>
            <MenuItem el="hdr.menu.help.license" onClick={() => { close(); actions.setScreen({ kind: 'license' }); }}>{t('ui.hdr.menu.help.license')}</MenuItem>
            <MenuItem el="hdr.menu.help.docs" onClick={() => { close(); actions.setScreen({ kind: 'help' }); }}>{t('ui.hdr.menu.help.docs')}</MenuItem>
            <MenuItem el="hdr.menu.help.about" onClick={() => { close(); actions.setScreen({ kind: 'about' }); }}>{t('ui.hdr.menu.help.about')}</MenuItem>
          </Popover>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5">
        {editing ? (
          <span className="flex flex-col">
            <input data-el="hdr.title" aria-label={t('a11y.hdr.title')} autoFocus value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commitTitle()} onKeyDown={onTitleKey}
              className={cx('h-7 w-64 rounded-[6px] border bg-em-panel-2 px-2 text-[14px] font-medium outline-none', titleError ? 'border-em-danger' : 'border-em-line')} />
            {titleError && <span className="absolute top-11 text-[12px] text-em-danger" role="alert">{t('ui.hdr.title.error')}</span>}
          </span>
        ) : (
          <button type="button" data-el="hdr.title" aria-label={t('a11y.hdr.title')} aria-describedby={p?.dirty ? 'em-dirty' : undefined} disabled={!p}
            onClick={() => { setDraft(p?.name ?? ''); setEditing(true); }} className="max-w-[320px] truncate rounded-[6px] px-2 py-1 text-[14px] font-medium hover:bg-em-panel-2">
            {p?.isSample === true ? (() => { const st = sampleTitle(p.name, p.language); return <><span data-el="hdr.title.sample" className="font-semibold text-em-accent">{st.marker}</span>{' · '}{st.rest}</>; })() : (p?.name ?? '')}
          </button>
        )}
        {p?.dirty && <span id="em-dirty" data-el="hdr.title.dirty" title={t('ui.hdr.title.dirty')} className="h-1.5 w-1.5 rounded-full bg-em-accent"><span className="sr-only">{t('ui.hdr.title.dirty')}</span></span>}
        {rendering && (
          <button type="button" data-el="sys.render.progress" onClick={() => actions.setScreen({ kind: 'export' })} aria-label={t('a11y.sys.render.progress', { percent, eta: rendering.etaMs ? formatDuration(rendering.etaMs) : '…' })}
            className="ml-2 flex items-center gap-2 rounded-full border border-em-line bg-em-panel-2 px-2.5 py-0.5 text-[12px]">
            <span>{t('ui.sys.render.progress', { percent, eta: rendering.etaMs ? formatDuration(rendering.etaMs) : '…' })}</span>
            {queue.queued.length > 0 && <span className="text-em-muted">{t('ui.sys.render.queued', { n: queue.queued.length })}</span>}
            <span className="w-16"><Progress value={rendering.progress} label={t('ui.sys.render.progress', { percent, eta: '' })} /></span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <div className="relative">
          <IconButton el="hdr.action.hardware" data-popover-trigger="" label={t('ui.hdr.action.hardware')} icon={<Activity size={16} />} active={menu === 'hardware'} onClick={() => setMenu(menu === 'hardware' ? null : 'hardware')}
            badge={lowResources ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-em-warn" aria-hidden /> : undefined} />
          {menu === 'hardware' && <HardwarePopover onClose={close} />}
        </div>
        <IconButton el="hdr.action.undo" label={t('ui.hdr.action.undo')} icon={<Undo2 size={16} />} disabledReason={state.canUndo ? null : t('ui.hdr.action.undo.none')} onClick={() => void actions.undo()} />
        <IconButton el="hdr.action.redo" label={t('ui.hdr.action.redo')} icon={<Redo2 size={16} />} disabledReason={state.canRedo ? null : t('ui.hdr.action.redo.none')} onClick={() => void actions.redo()} />
        <IconButton el="hdr.action.save" label={t('ui.hdr.action.save')} icon={<Save size={16} />} disabledReason={p ? null : t('ui.common.noproject')} onClick={() => void actions.save()} />
        <IconButton el="hdr.action.backup" label={t('ui.hdr.action.backup')} icon={<Archive size={16} />} disabledReason={p ? null : t('ui.common.noproject')} onClick={() => actions.setScreen({ kind: 'backup' })} />
        <IconButton el="hdr.action.restore" label={t('ui.hdr.action.restore')} icon={<ArchiveRestore size={16} />} onClick={() => actions.setScreen({ kind: 'restore' })} />
        <IconButton el="hdr.action.models" label={t('ui.hdr.action.models')} icon={<Boxes size={16} />} onClick={() => actions.setScreen({ kind: 'models' })}
          badge={state.models.some((m) => m.status === 'downloading') ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-em-info em-pulse" aria-hidden /> : undefined} />
        <div className="relative">
          <IconButton el="hdr.action.license" data-popover-trigger="" label={t('ui.hdr.action.license')} icon={licensed ? <BadgeCheck size={16} className="text-em-success" /> : <KeyRound size={16} className="text-em-warn" />} onClick={() => setMenu(menu === 'license' ? null : 'license')} />
          {menu === 'license' && (
            <Popover onClose={close} align="right" width={300} label={t('ui.hdr.action.license')}>
              <LicenceStatus onAction={(screen) => { close(); actions.setScreen({ kind: screen }); }} />
            </Popover>
          )}
        </div>
        <Button el="hdr.action.export" data-variant={exportReason ? 'disabled' : undefined} variant="primary" icon={<Download size={16} />} className="ml-1" disabledReason={exportReason} onClick={() => actions.setScreen({ kind: 'export' })}>{t('ui.hdr.action.export')}</Button>
      </div>
      {prefs.libCollapsed && <span className="sr-only"><ChevronDown aria-hidden /></span>}
    </header>
  );
}

function RecentList({ onPick }: { onPick: (id: string) => void }) {
  const { runtime, t, state } = useStore();
  const [items, setItems] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => { void runtime.api.recentProjects().then((r) => setItems(r.items.map((x) => ({ id: x.id, name: x.name })))).catch(() => setItems([])); }, [runtime]);
  return (
    <div className="ml-3 border-l border-em-line pl-1">
      {items === null ? <div className="px-2 py-1 text-em-muted">{t('ui.common.loading')}</div>
        : items.length === 0 ? <div className="px-2 py-1 text-em-muted">{t('ui.scr.project.open.empty')}</div>
          : items.map((p) => <MenuItem key={p.id} el="hdr.menu.file.recent.item" onClick={() => onPick(p.id)}>{p.name}{p.id === state.project?.id ? ' ·' : ''}</MenuItem>)}
    </div>
  );
}
