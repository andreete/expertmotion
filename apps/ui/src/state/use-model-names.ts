// Hook over the pure helpers in model-names.ts (kept separate so store.tsx can import those without a cycle).
import type { AgentKind, CapabilityRow, DisplayNameDto } from '../api/types.js';
import { useStore } from './store.js';
import { llmModelName, localModelByRef, localModelName } from './model-names.js';

type Named = { label: string; displayName?: DisplayNameDto | undefined };
export function useModelNames() {
  const { state, lang } = useStore();
  const rowsOf = (connectionId: string | null | undefined): CapabilityRow[] => (connectionId ? state.capabilities[connectionId] ?? [] : []);
  return {
    local: (m: Named) => localModelName(m, lang),
    /** Key or Catalogue flag → product name; unknown refs are shown as given. */
    localRef: (ref: string) => { const m = localModelByRef(state.models, ref); return m ? localModelName(m, lang) : ref.replace(/^model:/, ''); },
    /** The assigned model of an agent as the Creator sees it (the model's label), or '' when unassigned. */
    agent: (agent: AgentKind) => { const a = state.assignments?.[agent]; return a ? llmModelName(rowsOf(a.connectionId), a.modelId) : ''; },
    /** Any model id: looked up on the given connection, else on the agent's connection. */
    llm: (modelId: string | null | undefined, agent?: AgentKind, connectionId?: string | null) =>
      llmModelName(rowsOf(connectionId ?? (agent ? state.assignments?.[agent]?.connectionId : null)), modelId),
  };
}
