// Providers screen (scr.providers): Provider Connections, key validation, Capability Table, Model Assignments, budgets.
import { useEffect, useState } from 'react';
import { Check, Minus, RefreshCw, Trash2 } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { AgentKind, AssignmentDto, CapabilityRow, ProviderKind } from '../api/types.js';
import { Badge, Button, ErrorBox, Field, IconButton, Modal, inputCls } from '../components/ui.js';
import { formatMoney } from '../i18n/index.js';
import { EmError } from '@expertmotion/shared';

const PROVIDERS: ProviderKind[] = ['openrouter', 'openai', 'anthropic', 'google', 'custom'];

export function ConnectForm({ onConnected }: { onConnected?: (ok: boolean) => void }) {
  const { state, actions, t } = useStore();
  const [provider, setProvider] = useState<ProviderKind>('openrouter');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const validate = async () => {
    setBusy(true); setResult(null);
    const ok = await actions.addConnection(provider, key.trim(), t(`ui.scr.providers.provider.${provider}`));
    setBusy(false);
    setResult(ok ? 'ok' : 'fail');
    if (ok) setKey('');
    onConnected?.(ok);
  };
  return (
    <div data-el="scr.providers.add" className="flex flex-col gap-1 rounded-[8px] border border-em-line p-3">
      <Field label={t('ui.scr.providers.provider')} htmlFor="em-provider">
        <select id="em-provider" data-el="scr.providers.provider.select" className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value as ProviderKind)}>
          {PROVIDERS.map((p) => <option key={p} value={p}>{t(`ui.scr.providers.provider.${p}`)}{p !== 'openrouter' ? ` (${t('ui.common.p1')})` : ''}</option>)}
        </select>
      </Field>
      <Field label={t('ui.scr.providers.key')} htmlFor="em-key" hint={t('ui.scr.providers.key.where')}>
        <input id="em-key" data-el="scr.providers.key.input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={inputCls} />
      </Field>
      <div className="flex items-center gap-2">
        <Button el="scr.providers.validate" variant="primary" loading={busy} disabledReason={key.trim().length < 8 ? t('ui.scr.providers.key.short') : state.settings?.privateMode ? t('err.EM-8202.title') : null} onClick={() => void validate()}>
          {busy ? t('ui.scr.providers.validating') : t('ui.scr.providers.validate')}
        </Button>
        {result === 'ok' && <span className="flex items-center gap-1 text-em-success"><Check size={14} />{t('ui.scr.providers.valid')}</span>}
      </div>
    </div>
  );
}

export function AssignForm({ onSaved, showBudgets = true }: { onSaved?: () => void; showBudgets?: boolean }) {
  const { state, runtime, actions, dispatch, t, lang } = useStore();
  const conn = state.connections.find((c) => c.id === state.assignments?.defaultConnectionId) ?? state.connections[0];
  const rows: CapabilityRow[] = conn ? state.capabilities[conn.id] ?? [] : [];
  const [assign, setAssign] = useState<Record<AgentKind, string>>({ brainstorm: state.assignments?.brainstorm?.modelId ?? '', editor: state.assignments?.editor?.modelId ?? '' });
  const [month, setMonth] = useState(conn?.budgetMonthUsd != null ? String(conn.budgetMonthUsd) : '');
  const [projectBudget, setProjectBudget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  useEffect(() => {
    if (!conn || state.capabilities[conn.id]) return;
    runtime.api.connectionModels(conn.id).then((r) => dispatch({ type: 'capabilities', connectionId: conn.id, rows: r.items })).catch(() => undefined);
  }, [conn, runtime, dispatch, state.capabilities]);
  useEffect(() => {
    if (!rows.length) return;
    setAssign((a) => ({ brainstorm: a.brainstorm || rows[0]!.modelId, editor: a.editor || (rows.find((r) => r.structuredOutput && r.toolCalling) ?? rows[0]!).modelId }));
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!conn) return <p className="text-em-muted">{t('ui.scr.providers.none')}</p>;
  const save = async () => {
    setError(null);
    const mk = (agent: AgentKind): AssignmentDto | null => (assign[agent] ? { agent, connectionId: conn.id, modelId: assign[agent], settings: {} } : null);
    try {
      const a = await runtime.api.putAssignments({ brainstorm: mk('brainstorm'), editor: mk('editor'), defaultConnectionId: conn.id });
      dispatch({ type: 'providers', assignments: a });
      if (showBudgets) {
        await runtime.api.putBudget({ connections: [{ connectionId: conn.id, budgetMonthUsd: month ? Number(month) || null : null }], ...(state.project ? { projects: [{ projectId: state.project.id, limitUsd: projectBudget ? Number(projectBudget) || null : null }] } : {}) });
      }
      await actions.loadProviders();
      onSaved?.();
    } catch (e) { setError(e instanceof EmError ? e.code : 'EM-9001'); }
  };
  const refresh = async () => { try { const r = await runtime.api.refreshConnectionModels(conn.id); dispatch({ type: 'capabilities', connectionId: conn.id, rows: r.items }); } catch (e) { actions.error(e); } };
  const yes = (b: boolean) => (b ? <Check size={14} className="text-em-success" aria-label={t('ui.common.yes')} /> : <Minus size={14} className="text-em-muted" aria-label={t('ui.common.no')} />);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2"><span className="t-label flex-1">{t('ui.scr.providers.models')}</span><IconButton label={t('ui.scr.providers.refresh')} icon={<RefreshCw size={14} />} size={28} onClick={() => void refresh()} /></div>
      <div className="max-h-48 overflow-auto rounded-[6px] border border-em-line">
        <table data-el="scr.providers.models.list" className="w-full text-[12px]">
          <thead className="sticky top-0 bg-em-panel-2 text-em-muted"><tr>
            <th className="px-2 py-1 text-left">{t('ui.scr.providers.col.model')}</th><th className="px-1">{t('ui.scr.providers.col.context')}</th><th className="px-1">{t('ui.scr.providers.col.tools')}</th>
            <th className="px-1">{t('ui.scr.providers.col.structured')}</th><th className="px-1">{t('ui.scr.providers.col.streaming')}</th><th className="px-2 text-right">{t('ui.scr.providers.col.price')}</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="px-2 py-2 text-em-muted">{t('err.EM-4006.title')}</td></tr>}
            {rows.map((r) => (
              <tr key={r.modelId} className="border-t border-em-line">
                <td className="px-2 py-1">{r.label}<div className="t-mono text-[10px] text-em-muted">{r.modelId}</div></td>
                <td className="t-mono px-1 text-center">{r.contextLength ? `${Math.round(r.contextLength / 1000)}k` : 'n/a'}</td>
                <td className="px-1"><span className="flex justify-center">{yes(r.toolCalling)}</span></td><td className="px-1"><span className="flex justify-center">{yes(r.structuredOutput)}</span></td><td className="px-1"><span className="flex justify-center">{yes(r.streaming)}</span></td>
                <td className="t-mono px-2 text-right">{r.pricePerMInput === null ? 'n/a' : `${formatMoney(r.pricePerMInput, true, lang)} · ${formatMoney(r.pricePerMOutput, false, lang)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(['brainstorm', 'editor'] as const).map((agent) => (
        <Field key={agent} label={t(`ui.scr.providers.assign.${agent}`)} htmlFor={`em-assign-${agent}`} hint={agent === 'editor' ? t('ui.scr.providers.assign.editor.hint') : undefined}>
          <select id={`em-assign-${agent}`} data-el={`scr.providers.assign.${agent}`} className={inputCls} value={assign[agent]} onChange={(e) => setAssign((a) => ({ ...a, [agent]: e.target.value }))}>
            <option value="">{t('ui.scr.providers.assign.none')}</option>
            {rows.map((r) => <option key={r.modelId} value={r.modelId} disabled={agent === 'editor' && !r.structuredOutput}>{r.label}{agent === 'editor' && !r.structuredOutput ? ` — ${t('ui.scr.providers.assign.nojson')}` : ''}</option>)}
          </select>
        </Field>
      ))}
      {showBudgets && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('ui.scr.providers.budget.project')} htmlFor="em-bp" hint={t('ui.scr.providers.budget.hint')}><input id="em-bp" data-el="scr.providers.budget.project" type="number" min={0} step="0.5" value={projectBudget} onChange={(e) => setProjectBudget(e.target.value)} className={inputCls} placeholder="0" /></Field>
          <Field label={t('ui.scr.providers.budget.month')} htmlFor="em-bm"><input id="em-bm" data-el="scr.providers.budget.month" type="number" min={0} step="1" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} placeholder="0" /></Field>
        </div>
      )}
      {error && <ErrorBox code={error} />}
      <div className="flex items-center gap-2">
        <Button el="scr.providers.test" onClick={() => setTested(state.settings?.privateMode ? 'EM-8202' : 'ok')}>{t('ui.scr.providers.test')}</Button>
        {tested === 'ok' && <span className="text-em-success">{t('ui.scr.providers.test.ok')}</span>}
        {tested && tested !== 'ok' && <span className="text-em-warn">{t(`err.${tested}.title`)}</span>}
        <span className="flex-1" />
        <Button el="scr.providers.save" variant="primary" onClick={() => void save()}>{t('ui.common.save')}</Button>
      </div>
    </div>
  );
}

export function ProvidersScreen({ onClose }: { onClose: () => void }) {
  const { state, runtime, actions, t } = useStore();
  useEffect(() => { void actions.loadProviders(); }, [actions]);
  return (
    <Modal el="scr.providers" sheet width={560} title={t('ui.scr.providers.title')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ul data-el="scr.providers.list" className="flex flex-col gap-1">
          {state.connections.length === 0 && <li className="text-em-muted">{t('ui.scr.providers.none')}</li>}
          {state.connections.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-[6px] border border-em-line px-2 py-1.5">
              <span className="flex-1">{c.label} <span className="t-mono text-em-muted">{c.secretHint}</span></span>
              <Badge tone={c.status === 'valid' ? 'success' : c.status === 'invalid' ? 'danger' : 'neutral'}>{t(`ui.scr.providers.status.${c.status}`)}</Badge>
              <Button size={28} variant="ghost" onClick={() => void runtime.api.validateConnection(c.id).then(() => actions.loadProviders()).catch(actions.error)}>{t('ui.scr.providers.validate')}</Button>
              <IconButton label={t('ui.common.remove')} icon={<Trash2 size={14} />} size={28} onClick={() => void runtime.api.deleteConnection(c.id, true).then(() => actions.loadProviders()).catch(actions.error)} />
            </li>
          ))}
        </ul>
        <ConnectForm />
        <AssignForm onSaved={() => actions.toast('success', 'ui.scr.providers.saved')} />
      </div>
    </Modal>
  );
}
