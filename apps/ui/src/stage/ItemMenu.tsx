// ADR-031 / FR-193 / IX-30: the context menu of a Timeline item (right-click, Shift+F10, the ContextMenu key) and of the selected
// element on the Player canvas: Copy, Cut, Paste (FR-255 / FR-256, in-app clipboard), Delete, Split at the playhead, Duplicate, Ask Editor Agent. A WAI-ARIA menu (role=menu,
// ↑/↓/Home/End move, Enter/Space run, Esc / Tab / click outside close and return focus). Every action is the same deterministic
// pick as its shortcut (Delete key, S, …); "Ask Editor Agent" points the Edit-mode chat at the items (chips) and focuses it.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Bot, ClipboardPaste, Copy, CopyPlus, Scissors, ScissorsLineDashed, Trash2 } from 'lucide-react';
import type { ElementRefT } from '@expertmotion/composition-model';
import { useStore } from '../state/store.js';
import { mergeTargets, selectionTargets } from '../agent/targets.js';
import { formatTimecode } from '../i18n/index.js';
import { splitPlayheadMs, splitTargets } from './split.js';
import { copyableRefs, duplicableRefs, itemRefs, runCopy, runCut, runDelete, runDuplicate, runPaste } from './items.js';
import { timelineClipboard } from './clipboard.js';
import { playerBus } from './playerBus.js';
import { cx } from '../components/ui.js';

export interface ItemMenuAnchor { x: number; y: number; refs: ElementRefT[]; source: 'timeline' | 'canvas'; returnFocus?: HTMLElement | null }
type ItemAction = 'copy' | 'cut' | 'paste' | 'delete' | 'split' | 'duplicate' | 'ask';
/** Ctrl on Windows / Linux, ⌘ on macOS (shown next to Copy / Cut / Paste). */
const MOD = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '') ? '⌘' : 'Ctrl+';

/** Which menu entries are available for these refs, and why not (pure; the menu renders a disabled item with the reason). */
export function itemMenuState(o: { refs: readonly ElementRefT[]; model: Parameters<typeof splitTargets>[0] | undefined; playheadMs: number; privateMode: boolean; clipboard?: number; t: (k: string) => string }): Record<ItemAction, string | null> {
  const split = o.model ? splitTargets(o.model, o.refs, o.playheadMs) : { reason: 'nothing' as const };
  const copy = copyableRefs(o.refs).length ? null : o.t('ui.stage.itemmenu.copy.none');
  return {
    copy, cut: copy,
    paste: (o.clipboard ?? 0) > 0 ? null : o.t('ui.stage.itemmenu.paste.empty'),
    delete: itemRefs(o.refs).length ? null : o.t('ui.stage.timeline.delete.nothing'),
    split: 'edit' in split ? null : o.t('ui.stage.itemmenu.split.outside'),
    duplicate: duplicableRefs(o.refs).length ? null : o.t('ui.stage.itemmenu.duplicate.none'),
    ask: o.privateMode ? o.t('err.EM-4401.title') : o.refs.length ? null : o.t('ui.stage.timeline.delete.nothing'),
  };
}

export function ItemMenu({ anchor, onClose }: { anchor: ItemMenuAnchor; onClose: () => void }) {
  const { state, actions, t } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const model = state.head?.model;
  const fps = model?.settings.fps ?? 30;
  const playheadMs = splitPlayheadMs(state.playheadMs);
  const clip = useSyncExternalStore(timelineClipboard.subscribe, () => timelineClipboard.get());
  const off = itemMenuState({ refs: anchor.refs, model, playheadMs, privateMode: Boolean(state.settings?.privateMode), clipboard: clip?.entries.length ?? 0, t });
  const close = (refocus = true) => { onClose(); if (refocus && anchor.returnFocus?.isConnected) anchor.returnFocus.focus(); };
  const run = (a: ItemAction) => {
    if (off[a]) return;
    close(a !== 'ask');
    if (a === 'copy') runCopy({ model, projectId: state.project?.id ?? null, selection: anchor.refs, toast: actions.toast });
    else if (a === 'cut') runCut({ model, projectId: state.project?.id ?? null, selection: anchor.refs, itemsEdit: actions.itemsEdit, toast: actions.toast, t });
    else if (a === 'paste') runPaste({ playheadMs: playerBus.get()?.currentMs() ?? state.playheadMs, itemsEdit: actions.itemsEdit, toast: actions.toast, t });   // review U13: the live playhead, like Ctrl+V
    else if (a === 'delete') runDelete({ selection: anchor.refs, itemsEdit: actions.itemsEdit, toast: actions.toast, t });
    else if (a === 'duplicate') runDuplicate({ selection: anchor.refs, itemsEdit: actions.itemsEdit, toast: actions.toast, t });
    else if (a === 'split' && model) {
      const r = splitTargets(model, anchor.refs, playheadMs);
      if ('edit' in r) void actions.splitEdit(r.edit, t('ui.stage.timeline.split.done', { count: r.edit.items.length, time: formatTimecode(r.edit.atMs, fps) }));
    } else if (a === 'ask') {
      // FR-194: every item becomes a chip; the chat switches to Edit and the composer gets the focus.
      actions.setChatTargets(mergeTargets(state.chatTargets, selectionTargets(anchor.refs, model, state.assets, t)));
      window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: { agent: 'editor' } }));
    }
  };
  const items = (): HTMLElement[] => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  useLayoutEffect(() => {                                             // keep inside the window, then focus the first available entry
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    el.style.left = `${Math.max(4, Math.min(anchor.x, vw - (r.width || 200) - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(anchor.y, vh - (r.height || 160) - 4))}px`;
    (items().find((x) => x.getAttribute('aria-disabled') !== 'true') ?? items()[0])?.focus();
  }, [anchor]);
  useEffect(() => {                                                   // click / right-click outside closes (without stealing that click)
    const down = (e: PointerEvent | MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('pointerdown', down, true); window.addEventListener('contextmenu', down, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('contextmenu', down, true); };
  }, [onClose]);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items(); const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); run('delete'); }
    else return;
    e.stopPropagation();                                              // the menu owns these keys (the global Esc would clear the selection)
  };
  const entry = (a: ItemAction, icon: ReactNode, label: string, keys?: string) => (
    <button key={a} type="button" role="menuitem" data-el={`stage.itemmenu.${a}`} aria-disabled={off[a] ? true : undefined} title={off[a] ?? undefined}
      aria-keyshortcuts={keys} onClick={() => run(a)}
      className={cx('flex w-full items-center gap-2 rounded-[4px] px-2 py-1 text-left text-[12px] outline-none focus:bg-em-panel-2', off[a] ? 'cursor-not-allowed text-em-muted' : 'hover:bg-em-panel-2', a === 'delete' && !off[a] && 'text-em-danger')}>
      <span aria-hidden className="shrink-0">{icon}</span><span className="flex-1">{label}</span>
      {keys && <span aria-hidden className="t-mono text-[10px] text-em-muted">{keys === 'Delete' ? 'Del' : keys}</span>}
      {off[a] && <span className="sr-only">{off[a]}</span>}
    </button>
  );
  return (
    <div ref={ref} data-el="stage.itemmenu" data-source={anchor.source} role="menu" aria-label={t('ui.stage.itemmenu.title', { count: anchor.refs.length })} onKeyDown={onKey}
      className="fixed z-50 flex min-w-[200px] flex-col rounded-[8px] border border-em-line-strong bg-em-panel p-1 shadow-lg" style={{ left: anchor.x, top: anchor.y }}>
      {entry('copy', <Copy size={14} />, t('ui.stage.itemmenu.copy'), `${MOD}C`)}
      {entry('cut', <ScissorsLineDashed size={14} />, t('ui.stage.itemmenu.cut'), `${MOD}X`)}
      {entry('paste', <ClipboardPaste size={14} />, t('ui.stage.itemmenu.paste'), `${MOD}V`)}
      <div role="separator" className="my-1 h-px bg-em-line" />
      {entry('delete', <Trash2 size={14} />, t('ui.stage.itemmenu.delete'), 'Delete')}
      {entry('split', <Scissors size={14} />, t('ui.stage.itemmenu.split'), 'S')}
      {entry('duplicate', <CopyPlus size={14} />, t('ui.stage.itemmenu.duplicate'))}
      {entry('ask', <Bot size={14} />, t('ui.stage.itemmenu.ask'))}
    </div>
  );
}
/** Shift+F10 or the ContextMenu key (keyboard path to the item menu). */
export const isMenuKey = (e: { key: string; shiftKey: boolean }): boolean => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
