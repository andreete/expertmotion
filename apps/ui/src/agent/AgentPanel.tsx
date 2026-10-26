// Agent Panel (agent.*): the assistant chat (one thread, two modes: "Diskusi" = Brainstorming Agent, "Edit" = Editor Agent;
// Operator decision 2026-10-26) and the collapsible Output Settings below it. FR-099: the chat can be maximized (Output
// Settings hidden); the state persists in prefs and Settings `layout.chatMaximized`.
import { useStore } from '../state/store.js';
import { AssistantChat } from './AssistantChat.js';
import { OutputSettings } from './OutputSettings.js';
import { chatModeFor } from '../prefs.js';

export function AgentPanel() {
  const { t, prefs, setPrefs, state } = useStore();
  const maximized = prefs.chatMaximized === 'brainstorm' || prefs.chatMaximized === 'editor';
  const onToggleMax = () => setPrefs({ chatMaximized: maximized ? null : chatModeFor(prefs, state.project?.id) });
  return (
    <aside aria-label={t('a11y.region.agent')} data-region="agent" className="flex h-full min-h-0 flex-col overflow-hidden bg-em-panel">
      <AssistantChat layout={{ maximized, onToggleMax }} />
      <div hidden={maximized} className="contents"><OutputSettings /></div>
    </aside>
  );
}
