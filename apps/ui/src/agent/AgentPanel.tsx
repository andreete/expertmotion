// Agent Panel (agent.*): Model Bar, Brainstorming Chat, Editor Chat, Output Settings.
// FR-099: the two chats share the panel height (no outer scroll) with a draggable `agent.chat.divider`; either chat can be
// maximized (the other keeps only its header bar); ratio, maximized chat and Output Settings collapse persist in prefs.
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { useStore } from '../state/store.js';
import { BrainstormChat } from './BrainstormChat.js';
import { EditorChat } from './EditorChat.js';
import { OutputSettings } from './OutputSettings.js';
import { cx } from '../components/ui.js';
import { useModelNames } from '../state/use-model-names.js';
import { Splitter } from '../components/Splitter.js';
import { LAYOUT, chatRatioFor, resolveChatSplit } from '../layout.js';
import type { ChatAgent } from '../prefs.js';
import type { ChatLayoutProps, ChatView } from './Chat.js';

export function ModelBar() {
  const { state, actions, t } = useStore();
  const names = useModelNames();
  const def = state.connections.find((c) => c.id === state.assignments?.defaultConnectionId) ?? state.connections[0];
  // Label of the Editor Agent's model (e.g. "Anthropic: Claude Haiku 5.5"), else the Brainstorming Agent's.
  const model = state.assignments?.editor ? names.agent('editor') : state.assignments?.brainstorm ? names.agent('brainstorm') : undefined;
  const priv = Boolean(state.settings?.privateMode);
  // FR-071: the last provider failure of either agent (agent.run.failed) wins over a stale "valid"; its code is shown as is.
  const runCode = [state.agentError.editor, state.agentError.brainstorm].find((c): c is string => !!c && /^EM-4[0-2]\d\d$/.test(c)) ?? null;
  const code = runCode ?? (def?.status === 'invalid' ? 'EM-4002' : null);
  const status = priv ? 'private' : !def ? 'none' : code ? 'error' : def.status === 'valid' ? 'valid' : 'unvalidated';
  const provider = def ? t(`ui.scr.providers.provider.${def.provider}`) : '';
  const statusText = t(`ui.agent.modelbar.status.${status}`);
  return (
    <button type="button" data-el="agent.modelbar" onClick={() => actions.setScreen({ kind: 'providers' })}
      aria-label={def ? t('a11y.agent.modelbar', { provider, model: model ?? '—', status: statusText }) : t('ui.agent.modelbar.connect')}
      className="flex h-11 w-full shrink-0 items-center gap-2 border-b border-em-line px-3 text-left hover:bg-em-panel-2">
      <span data-el="agent.modelbar.status" data-status={status} title={status === 'error' && code ? `${statusText} · ${code} · ${t(`err.${code}.title`)}` : statusText} className="flex items-center">
        {priv ? <ShieldCheck size={14} className="text-em-private" /> : <span className={cx('h-2 w-2 rounded-full', status === 'valid' ? 'bg-em-success' : status === 'error' ? 'bg-em-danger' : status === 'none' ? 'border border-em-muted bg-transparent' : 'bg-em-muted')} />}
      </span>
      {def ? <span className="min-w-0 flex-1 truncate">{t('ui.agent.modelbar.label', { provider, model: model ?? t('ui.agent.footer.nomodel') })}</span>
        : <span className="flex-1 font-medium text-em-accent">{t('ui.agent.modelbar.connect')}</span>}
      <ChevronRight size={14} className="text-em-muted" aria-hidden />
    </button>
  );
}

/** Height of the chat area (ResizeObserver; 0 until measured, e.g. in jsdom). */
function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setH(el.clientHeight);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

export function AgentPanel() {
  const { t, prefs, setPrefs } = useStore();
  const area = useRef<HTMLDivElement>(null);
  const height = useHeight(area);
  const [live, setLive] = useState<number | null>(null);                     // ratio while dragging, persisted on release
  const ratio = live ?? prefs.chatSplit;
  const split = resolveChatSplit(height, ratio);
  const maxed: ChatAgent | null = prefs.chatMaximized === 'brainstorm' || prefs.chatMaximized === 'editor' ? prefs.chatMaximized : null;
  const share = split.size / split.area;
  const viewOf = (a: ChatAgent): ChatView => (!maxed ? 'split' : maxed === a ? 'max' : 'min');
  const styleOf = (a: ChatAgent): CSSProperties => {
    const v = viewOf(a);
    if (v === 'min') return { flex: '0 0 auto' };
    if (v === 'max') return { flex: '1 1 0px' };
    return { flex: `${a === 'brainstorm' ? share : 1 - share} 1 0px` };
  };
  const restore = () => setPrefs({ chatMaximized: null });
  const toggleMax = (a: ChatAgent) => () => setPrefs({ chatMaximized: maxed === a ? null : a });
  // A request to focus a collapsed chat's composer (inspector "Ask the Editor", tour) brings the split view back.
  useEffect(() => {
    const on = (e: Event) => { const a = (e as CustomEvent<{ agent: ChatAgent }>).detail?.agent; if (maxed && a && a !== maxed) setPrefs({ chatMaximized: null }); };
    window.addEventListener('em:focus-composer', on);
    return () => window.removeEventListener('em:focus-composer', on);
  }, [maxed, setPrefs]);
  const props = (a: ChatAgent): ChatLayoutProps => ({ view: viewOf(a), style: styleOf(a), onToggleMax: toggleMax(a), onRestore: restore });
  return (
    <aside aria-label={t('a11y.region.agent')} data-region="agent" className="flex h-full min-h-0 flex-col overflow-hidden bg-em-panel">
      <ModelBar />
      <div ref={area} data-el="agent.chats" data-maximized={maxed ?? undefined} className="flex min-h-0 flex-1 flex-col">
        <BrainstormChat {...props('brainstorm')} />
        {!maxed && (
          <Splitter el="agent.chat.divider" orientation="horizontal" value={split.size} min={split.min} max={split.max} label={t('a11y.layout.divider.chats')}
            onChange={(px, commit) => { const r = chatRatioFor(px, height); if (commit) { setLive(null); setPrefs({ chatSplit: r }); } else setLive(r); }}
            onReset={() => { setLive(null); setPrefs({ chatSplit: LAYOUT.chat.defaultSplit }); }} />
        )}
        <EditorChat {...props('editor')} />
      </div>
      <OutputSettings />
    </aside>
  );
}
