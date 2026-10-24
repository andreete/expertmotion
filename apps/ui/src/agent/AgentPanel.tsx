// Agent Panel (agent.*): Model Bar, Brainstorming Chat, Editor Chat, Output Settings.
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { useStore } from '../state/store.js';
import { BrainstormChat } from './BrainstormChat.js';
import { EditorChat } from './EditorChat.js';
import { OutputSettings } from './OutputSettings.js';
import { cx } from '../components/ui.js';

export function ModelBar() {
  const { state, actions, t } = useStore();
  const def = state.connections.find((c) => c.id === state.assignments?.defaultConnectionId) ?? state.connections[0];
  const model = state.assignments?.editor?.modelId ?? state.assignments?.brainstorm?.modelId;
  const priv = Boolean(state.settings?.privateMode);
  const status = priv ? 'private' : !def ? 'none' : def.status === 'valid' ? 'valid' : def.status === 'invalid' ? 'error' : 'unvalidated';
  const provider = def ? t(`ui.scr.providers.provider.${def.provider}`) : '';
  const statusText = t(`ui.agent.modelbar.status.${status}`);
  return (
    <button type="button" data-el="agent.modelbar" onClick={() => actions.setScreen({ kind: 'providers' })}
      aria-label={def ? t('a11y.agent.modelbar', { provider, model: model ?? '—', status: statusText }) : t('ui.agent.modelbar.connect')}
      className="flex h-11 w-full shrink-0 items-center gap-2 border-b border-em-line px-3 text-left hover:bg-em-panel-2">
      <span data-el="agent.modelbar.status" title={status === 'error' ? `${statusText} · EM-4002` : statusText} className="flex items-center">
        {priv ? <ShieldCheck size={14} className="text-em-private" /> : <span className={cx('h-2 w-2 rounded-full', status === 'valid' ? 'bg-em-success' : status === 'error' ? 'bg-em-danger' : 'bg-em-muted')} />}
      </span>
      {def ? <span className="min-w-0 flex-1 truncate">{t('ui.agent.modelbar.label', { provider, model: model ?? t('ui.agent.footer.nomodel') })}</span>
        : <span className="flex-1 font-medium text-em-accent">{t('ui.agent.modelbar.connect')}</span>}
      <ChevronRight size={14} className="text-em-muted" aria-hidden />
    </button>
  );
}

export function AgentPanel() {
  const { t } = useStore();
  return (
    <aside aria-label={t('a11y.region.agent')} data-region="agent" className="flex h-full min-h-0 flex-col overflow-y-auto bg-em-panel">
      <ModelBar />
      <BrainstormChat />
      <EditorChat />
      <OutputSettings />
    </aside>
  );
}
