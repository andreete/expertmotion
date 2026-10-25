// Agent Panel (agent.*): Model Bar, Brainstorming Chat, Editor Chat, Output Settings.
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { useStore } from '../state/store.js';
import { BrainstormChat } from './BrainstormChat.js';
import { EditorChat } from './EditorChat.js';
import { OutputSettings } from './OutputSettings.js';
import { cx } from '../components/ui.js';
import { useModelNames } from '../state/use-model-names.js';

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
