// Keyboard shortcuts (EDITOR_INTERACTION_MODEL.md §7). Never fire inside text inputs except Ctrl+S, Ctrl+Enter and Esc.
import { useEffect } from 'react';
import { useStore } from './state/store.js';
import { playerBus } from './stage/playerBus.js';
import { requestImport } from './header/Header.js';
import { guardUnsaved } from './screens/Lifecycle.js';

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || el.isContentEditable) return true;
  if (tag === 'input') { const type = (el as HTMLInputElement).type; return !['checkbox', 'radio', 'range', 'button'].includes(type); }
  return tag === 'select';
}

export function useShortcuts(collapse: { toggleLibrary: () => void; toggleAgent: () => void }) {
  const { state, actions, t } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTyping(e.target);
      const ctrl = e.ctrlKey || e.metaKey;
      const player = playerBus.get();
      const k = e.key;
      if (ctrl && k.toLowerCase() === 's' && !e.shiftKey) { e.preventDefault(); void actions.save(); return; }
      // FR-153: Ctrl+Enter in a chat composer sends (Composer handles it); elsewhere it Executes a valid plan (EDITOR_INTERACTION_MODEL §7)
      if (ctrl && k === 'Enter') { if (!typing && state.plan?.status === 'valid') { e.preventDefault(); void actions.execute(); } return; }
      if (k === 'Escape') {
        if (state.screen) return;                                         // modal handles its own Esc
        if (state.streaming.editor || state.plan?.status === 'draft') { void actions.cancelPlan(); return; }
        if (document.fullscreenElement) { void document.exitFullscreen(); return; }
        if (state.selection.length) { actions.select([]); return; }
        return;
      }
      if (typing || state.screen) return;
      if (ctrl) {
        const l = k.toLowerCase();
        if (l === 'z' && !e.shiftKey) { e.preventDefault(); void actions.undo(); }
        else if (l === 'y' || (l === 'z' && e.shiftKey)) { e.preventDefault(); void actions.redo(); }
        else if (l === 's' && e.shiftKey) { e.preventDefault(); if (state.project) actions.setScreen({ kind: 'project.new', saveAs: true }); }
        else if (l === 'e') { e.preventDefault(); if (state.head?.model?.tracks.video.length) actions.setScreen({ kind: 'export' }); else actions.toast('info', 'ui.hdr.export.disabled'); }
        else if (l === 'i') { e.preventDefault(); requestImport(); }
        else if (l === 'n') { e.preventDefault(); guardUnsaved({ state, actions }, () => actions.setScreen({ kind: 'project.new' })); }
        else if (l === 'o') { e.preventDefault(); actions.setScreen({ kind: 'project.open' }); }
        else if (l === 'b') { e.preventDefault(); if (e.shiftKey) collapse.toggleAgent(); else collapse.toggleLibrary(); }
        return;
      }
      if (e.altKey && ['1', '2', '3'].includes(k)) {
        e.preventDefault();
        const region = k === '1' ? 'library' : k === '2' ? 'stage' : 'agent';
        document.querySelector<HTMLElement>(`[data-region="${region}"] button, [data-region="${region}"] input`)?.focus();
        return;
      }
      switch (k) {
        case ' ': e.preventDefault(); player?.toggle(); break;
        case 'ArrowLeft': if ((e.target as HTMLElement).getAttribute?.('role') === 'radio' || (e.target as HTMLElement).getAttribute?.('role') === 'tab') return; e.preventDefault(); if (e.shiftKey) player?.seekMs(player.currentMs() - 1000); else player?.stepFrames(-1); break;
        case 'ArrowRight': if ((e.target as HTMLElement).getAttribute?.('role') === 'radio' || (e.target as HTMLElement).getAttribute?.('role') === 'tab') return; e.preventDefault(); if (e.shiftKey) player?.seekMs(player.currentMs() + 1000); else player?.stepFrames(1); break;
        case 'Home': player?.seekMs(0); break;
        case 'End': player?.seekMs(player.durationMs()); break;
        case 'j': case 'J': player?.seekMs(player.currentMs() - 1000); break;
        case 'k': case 'K': player?.pause(); break;
        case 'l': case 'L': player?.play(); break;
        case 'f': case 'F': player?.fullscreen(); break;
        case '/': e.preventDefault(); window.dispatchEvent(new CustomEvent('em:focus-search')); break;
        case '1': actions.setLibMode('home'); break;
        case '2': actions.setLibMode('design'); break;
        case '3': actions.setLibMode('tools'); break;
        case '?': actions.setScreen({ kind: 'shortcuts' }); break;
        case 'a': case 'A': {
          const sel = state.selection[0];
          if (sel) document.querySelector<HTMLButtonElement>('[data-el="stage.timeline.inspector"] button')?.click();
          break;
        }
        case 'Delete': if (state.selection.length) actions.toast('info', 'ui.stage.timeline.delete.agent'); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.plan, state.screen, state.streaming.editor, state.selection, state.head, actions, collapse, t]);
}
