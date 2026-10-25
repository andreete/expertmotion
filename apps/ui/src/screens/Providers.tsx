// Providers screen (scr.providers, FR-109…FR-119): Provider Connections list (status, model count, default, usage/budget,
// Edit / Test / Set default / Remove), and the Add connection form whose sections unlock in order: provider + key →
// Validate (R-101 dry run, nothing stored) → model table (ModelPicker, one pick per agent) → budget → Test (R-102 fixed probe) → Save.
import { useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff, Trash2 } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { AgentKind, AssignmentDto, CapabilityRow, ConnectionDto, ProbeResultDto, ProviderKind, ProviderKindInfo } from '../api/types.js';
import { Badge, Button, ErrorBox, Field, IconButton, Modal, cx, inputCls } from '../components/ui.js';
import { formatMoney, formatNumber, formatTokens } from '../i18n/index.js';
import { EmError, recommendedFor } from '@expertmotion/shared';
import { ModelPicker, defaultModelFor, type PickerCategory } from '../components/ModelPicker.js';
import type { BudgetFocus } from '../state/reducer.js';
import { llmModelName } from '../state/model-names.js';

const PROVIDERS: ProviderKind[] = ['openrouter', 'openai', 'anthropic', 'google', 'custom'];
const AGENTS: AgentKind[] = ['brainstorm', 'editor'];
/** Fallback when R-103 is unavailable (older service): OpenRouter only (P0), the rest shown as later (FR-111). */
const FALLBACK_KINDS: ProviderKindInfo[] = PROVIDERS.map((p) => ({ provider: p, enabled: p !== 'custom', priority: p === 'openrouter' ? 'P0' : p === 'custom' ? 'P2' : 'P1', termsUrl: null, keyPattern: null, keyExample: null }));
type Budget = Awaited<ReturnType<ReturnType<typeof useStore>['runtime']['api']['getBudget']>>;
const codeOf = (e: unknown) => (e instanceof EmError ? e.code : 'EM-9001');
const toLimit = (v: string): number | null => { const n = Number(v); return v.trim() && Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : null; };

/** Deterministic "recommended for" hint from the Capability Table (unknown facts never qualify); lives in @expertmotion/shared. */
export { recommendedFor };
/** The default model for an agent when nothing is assigned yet (Balanced resolution), or '' when the table has no JSON-capable model. */
const defaultModel = (rows: readonly CapabilityRow[], agent: AgentKind): string => defaultModelFor(rows, agent);

function useKinds(): ProviderKindInfo[] {
  const { runtime } = useStore();
  const [kinds, setKinds] = useState<ProviderKindInfo[]>(FALLBACK_KINDS);
  useEffect(() => { let alive = true; runtime.api.providerKinds().then((r) => { if (alive) setKinds(r.items); }).catch(() => undefined); return () => { alive = false; }; }, [runtime]);
  return kinds;
}

function useBudget(): [Budget | null, () => void] {
  const { runtime } = useStore();
  const [budget, setBudget] = useState<Budget | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { let alive = true; runtime.api.getBudget().then((b) => { if (alive) setBudget(b); }).catch(() => undefined); return () => { alive = false; }; }, [runtime, n]);
  return [budget, () => setN((x) => x + 1)];
}

/** Inline info/warn note with its EM code (copy from err.<code>). */
function Note({ code, el, tone = 'warn', vars }: { code: string; el?: string; tone?: 'warn' | 'info'; vars?: Record<string, string | number> }) {
  const { t } = useStore();
  return <p data-el={el} data-code={code} role="status" className={cx('text-[12px]', tone === 'warn' ? 'text-em-warn' : 'text-em-text-2')}>{t(`err.${code}.title`, vars)} · {t(`err.${code}.body`, vars)} <span className="t-mono text-em-muted">{code}</span></p>;
}

/** Provider select + disclosure + terms (FR-111) and the masked key with show/hide and the expected shape (FR-112). */
function ProviderKeyFields({ provider, setProvider, secret, setSecret, kinds }: { provider: ProviderKind; setProvider: (p: ProviderKind) => void; secret: string; setSecret: (s: string) => void; kinds: ProviderKindInfo[] }) {
  const { t } = useStore();
  const [show, setShow] = useState(false);
  const info = kinds.find((k) => k.provider === provider);
  const shapeOk = !info?.keyPattern || !secret.trim() || new RegExp(info.keyPattern).test(secret.trim());
  return (
    <>
      <Field label={t('ui.scr.providers.provider')} htmlFor="em-provider">
        <select id="em-provider" data-el="scr.providers.provider.select" className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value as ProviderKind)}>
          {kinds.map((k) => <option key={k.provider} value={k.provider} disabled={!k.enabled}>{t(`ui.scr.providers.provider.${k.provider}`)}{k.enabled ? '' : ` — ${t('err.EM-9004.title')}`}</option>)}
        </select>
      </Field>
      {provider !== 'custom' && (
        <p data-el="scr.providers.provider.disclosure" className="-mt-2 mb-3 text-[12px] text-em-text-2">
          {t(`ui.scr.providers.disclosure.${provider}`)}{' '}
          {info?.termsUrl && <a href={info.termsUrl} target="_blank" rel="noreferrer" className="text-em-accent underline">{t('ui.scr.providers.terms')}</a>}
        </p>
      )}
      <Field label={t('ui.scr.providers.key')} htmlFor="em-key"
        hint={!shapeOk ? <span data-el="scr.providers.key.shape" className="text-em-warn">{t('ui.scr.providers.key.shape.warn', { example: info?.keyExample ?? '' })}</span>
          : <span data-el="scr.providers.key.shape">{info?.keyExample ? `${t('ui.scr.providers.key.shape', { example: info.keyExample })} · ` : ''}{t('ui.scr.providers.key.where')}</span>}>
        <div className="flex gap-1">
          <input id="em-key" data-el="scr.providers.key.input" type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={secret} className={inputCls}
            onChange={(e) => setSecret(e.target.value)} onPaste={(e) => { const v = e.clipboardData.getData('text'); if (v) { e.preventDefault(); setSecret(v.trim()); } }} />
          <IconButton el="scr.providers.key.toggle" label={show ? t('ui.scr.providers.key.hide') : t('ui.scr.providers.key.show')} icon={show ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setShow((v) => !v)} />
        </div>
      </Field>
    </>
  );
}

/** Onboarding Provider step (FR-007): validates and stores in one go; the Providers screen uses AddConnectionForm instead. */
export function ConnectForm({ onConnected }: { onConnected?: (ok: boolean) => void }) {
  const { state, actions, t } = useStore();
  const kinds = useKinds();
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
      <ProviderKeyFields provider={provider} setProvider={setProvider} secret={key} setSecret={setKey} kinds={kinds} />
      <div className="flex items-center gap-2">
        <Button el="scr.providers.validate" variant="primary" loading={busy} disabledReason={key.trim().length < 8 ? t('ui.scr.providers.key.short') : state.settings?.privateMode ? t('err.EM-8202.title') : null} onClick={() => void validate()}>
          {busy ? t('ui.scr.providers.validating') : t('ui.scr.providers.validate')}
        </Button>
        {result === 'ok' && <span className="flex items-center gap-1 text-em-success"><Check size={14} />{t('ui.scr.providers.valid')}</span>}
      </div>
    </div>
  );
}

/** Model choice (FR-114, FR-115; Operator feedback 2026-10-25): one searchable ModelPicker over the Capability Table with a
 *  two-option toggle "Brainstorming Agent | Editor Agent" above it; a row click assigns the model to the agent shown. Defaults
 *  (both agents) = the Balanced resolution of @expertmotion/shared (the free pick while the Free category is shown), so Save
 *  works without touching anything; the exact model id is what gets stored. Nothing is refused (Operator decision 2026-10-25):
 *  weak or no-JSON models carry the ModelPicker quality warning; unknown tool calling / structured output shows EM-4005; a
 *  model without image input gets a note. */
function ModelAssign({ rows, assign, setAssign, onRefresh, loading }: { rows: CapabilityRow[]; assign: Record<AgentKind, string>; setAssign: (f: (a: Record<AgentKind, string>) => Record<AgentKind, string>) => void; onRefresh?: () => void; loading?: boolean }) {
  const { state, t } = useStore();
  const [agent, setAgent] = useState<AgentKind>('brainstorm');
  const touched = useRef<Record<AgentKind, boolean>>({ brainstorm: false, editor: false });
  const other: AgentKind = agent === 'brainstorm' ? 'editor' : 'brainstorm';
  const pick = (id: string) => { touched.current[agent] = true; setAssign((a) => ({ ...a, [agent]: id })); };
  const onCategoryChange = (c: PickerCategory) => setAssign((a) => {                  // untouched defaults follow the Free category
    const next = { ...a };
    for (const x of AGENTS) if (!touched.current[x]) next[x] = defaultModelFor(rows, x, c === 'free') || next[x];
    return next;
  });
  const cap = rows.find((r) => r.modelId === assign[agent]);
  const name = llmModelName(rows, assign[agent]);
  const canShare = !!assign[agent] && assign[other] !== assign[agent];
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t('ui.scr.providers.assign.for')} data-el="scr.providers.assign.agent" className="grid grid-cols-2 gap-1">
        {AGENTS.map((a) => {
          const on = a === agent;
          return (
            <button key={a} type="button" role="radio" aria-checked={on} data-el={`scr.providers.assign.agent.${a}`} data-model-id={assign[a] || undefined} onClick={() => setAgent(a)}
              className={cx('flex min-w-0 flex-col items-start rounded-[6px] border px-2 py-1 text-left', on ? 'border-em-accent bg-em-accent/10' : 'border-em-line hover:bg-em-panel-2')}>
              <span className={cx('text-[12px] font-medium', on && 'text-em-accent')}>{t(`ui.scr.providers.assign.${a}`)}</span>
              <span className="w-full truncate text-[11px] text-em-text-2" title={assign[a] || undefined}>{assign[a] ? llmModelName(rows, assign[a]) : t('ui.scr.providers.assign.none')}</span>
            </button>
          );
        })}
      </div>
      <ModelPicker el="scr.providers.models" rows={rows} agent={agent} value={assign[agent]} onSelect={pick} onCategoryChange={onCategoryChange} loading={loading}
        {...(onRefresh ? { onRefresh, refreshDisabledReason: state.settings?.privateMode ? t('err.EM-8202.title') : null } : {})} />
      <div className="flex flex-wrap items-center gap-2">
        {agent === 'editor' && <p className="flex-1 text-[12px] text-em-muted">{t('ui.scr.providers.assign.editor.hint')}</p>}
        {canShare && <Button el="scr.providers.assign.both" size={28} variant="ghost" className="ml-auto" onClick={() => { touched.current[other] = true; setAssign((a) => ({ ...a, [other]: a[agent] })); }}>{t(`ui.scr.providers.assign.both.${other}`)}</Button>}
      </div>
      {cap && agent === 'editor' && cap.structuredOutput !== false && (cap.toolCalling !== true || cap.structuredOutput !== true) && <Note el="scr.providers.assign.note" code="EM-4005" tone="info" vars={{ model: name }} />}
      {cap && cap.imageInput !== true && <p data-el="scr.providers.assign.note" className="text-[12px] text-em-muted">{t(cap.imageInput === false ? 'ui.scr.providers.assign.noimage' : 'ui.scr.providers.assign.imageunknown')}</p>}
    </div>
  );
}

/** Per-Project and per-month caps (FR-117) with the 80 % warning (EM-4202). */
function BudgetFields({ connectionId, month, setMonth, project, setProject, budget }: { connectionId: string | null; month: string; setMonth: (v: string) => void; project: string; setProject: (v: string) => void; budget: Budget | null }) {
  const { state, t, lang } = useStore();
  const c = budget?.connections.find((x) => x.connectionId === connectionId);
  const p = state.project ? budget?.projects.find((x) => x.projectId === state.project!.id && x.connectionId === connectionId) : undefined;
  const warn = (spent: number, limit: number | null) => limit !== null && limit > 0 && spent >= 0.8 * limit;
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('ui.scr.providers.budget.project')} htmlFor="em-bp" hint={state.project ? t('ui.scr.providers.budget.hint') : t('ui.common.noproject')}>
          <input id="em-bp" data-el="scr.providers.budget.project" type="number" min={0} max={10000} step="0.5" value={project} disabled={!state.project} onChange={(e) => setProject(e.target.value)} className={inputCls} placeholder="0" />
        </Field>
        <Field label={t('ui.scr.providers.budget.month')} htmlFor="em-bm"><input id="em-bm" data-el="scr.providers.budget.month" type="number" min={0} max={10000} step="1" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} placeholder="0" /></Field>
      </div>
      {p && warn(p.spentUsd, p.limitUsd) && <Note el="scr.providers.budget.warn" code="EM-4202" vars={{ spent: formatMoney(p.spentUsd, false, lang), limit: formatMoney(p.limitUsd, false, lang) }} />}
      {c && warn(c.spentMonthUsd, c.budgetMonthUsd) && <Note el="scr.providers.budget.warn" code="EM-4202" vars={{ spent: formatMoney(c.spentMonthUsd, c.approximate, lang), limit: formatMoney(c.budgetMonthUsd, false, lang) }} />}
    </div>
  );
}

/** Test (FR-116): rows "OK · 1.2 s · 38 tokens · ≈ $0.0001", or the EM code as the chats would show it. */
function TestResults({ items }: { items: ProbeResultDto[] }) {
  const { t, lang } = useStore();
  return (
    <ul data-el="scr.providers.test.result" className="flex flex-col gap-0.5 text-[12px]">
      {items.map((r) => (
        <li key={r.agent} data-agent={r.agent} data-code={r.code} className={r.ok ? 'text-em-success' : 'text-em-warn'}>
          {t(`ui.scr.providers.assign.${r.agent}`)}: {r.ok
            ? t('ui.scr.providers.test.row', { seconds: formatNumber(r.latencyMs / 1000, lang, 1), tokens: formatTokens(r.inputTokens + r.outputTokens, lang), cost: r.costUsd === null ? t('ui.scr.providers.test.nocost') : formatMoney(r.costUsd, r.approximate, lang) })
            : <>{t(`err.${r.code ?? 'EM-9001'}.title`)} <span className="t-mono text-em-muted">{r.code}</span>{r.reason ? <span data-el="scr.providers.test.reason" className="block text-[12px] text-em-text-2">{r.reason}</span> : null}</>}
        </li>
      ))}
    </ul>
  );
}

/** Assignments + budgets + Test for a stored connection (onboarding Models step and the Providers screen). */
export function AssignForm({ onSaved, showBudgets = true, connectionId, focusField }: { onSaved?: () => void; showBudgets?: boolean; connectionId?: string; focusField?: BudgetFocus['field'] }) {
  const { state, runtime, actions, dispatch, t } = useStore();
  const conn = state.connections.find((c) => c.id === (connectionId ?? state.assignments?.defaultConnectionId)) ?? state.connections[0];
  const rows: CapabilityRow[] = conn ? state.capabilities[conn.id] ?? [] : [];
  const [assign, setAssign] = useState<Record<AgentKind, string>>({ brainstorm: state.assignments?.brainstorm?.modelId ?? '', editor: state.assignments?.editor?.modelId ?? '' });
  const [budget, reloadBudget] = useBudget();
  const [month, setMonth] = useState(conn?.budgetMonthUsd != null ? String(conn.budgetMonthUsd) : '');
  const [projectBudget, setProjectBudget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<ProbeResultDto[] | string | null>(null);
  const [fetching, setFetching] = useState(false);
  useEffect(() => {                                                                                     // FR-117: prefill the project cap
    const p = state.project ? budget?.projects.find((x) => x.projectId === state.project!.id && x.connectionId === conn?.id) : undefined;
    if (p?.limitUsd != null) setProjectBudget((v) => v || String(p.limitUsd));
  }, [budget, state.project, conn?.id]);
  useEffect(() => {                                                                                     // AI-016: EM-4201 "Change budget" lands on the field
    if (!showBudgets || !focusField || !conn) return;
    const h = setTimeout(() => {                                                                        // after the Modal's own initial focus
      const el = document.getElementById(focusField === 'project' && state.project ? 'em-bp' : 'em-bm') as HTMLInputElement | null;
      el?.scrollIntoView?.({ block: 'center' }); el?.focus(); el?.select?.();
    }, 60);
    return () => clearTimeout(h);
  }, [focusField, showBudgets, conn?.id, state.project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Empty table = not loaded: read the cache, and when the cache is empty too ask the provider once (not in Private Mode).
  const autoFetched = useRef<string | null>(null);
  useEffect(() => {
    if (!conn || state.capabilities[conn.id]?.length) return;
    void runtime.api.connectionModels(conn.id).then(async (r) => {
      let rows = r.items;
      if (!rows.length && autoFetched.current !== conn.id && !state.settings?.privateMode && conn.status === 'valid') {
        autoFetched.current = conn.id;
        setFetching(true);
        rows = (await runtime.api.refreshConnectionModels(conn.id).catch(() => ({ items: [] as typeof rows }))).items;
        setFetching(false);
      }
      if (rows.length) dispatch({ type: 'capabilities', connectionId: conn.id, rows });
    }).catch(() => undefined);
  }, [conn, runtime, dispatch, state.capabilities, state.settings?.privateMode]);
  useEffect(() => {
    if (!rows.length) return;
    setAssign((a) => ({ brainstorm: a.brainstorm || defaultModel(rows, 'brainstorm'), editor: a.editor || defaultModel(rows, 'editor') }));
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!conn) return <p className="text-em-muted">{t('ui.scr.providers.none')}</p>;
  const save = async () => {
    setError(null);
    const mk = (agent: AgentKind): AssignmentDto | null => (assign[agent] ? { agent, connectionId: conn.id, modelId: assign[agent], settings: {} } : null);
    try {
      const a = await runtime.api.putAssignments({ brainstorm: mk('brainstorm'), editor: mk('editor'), defaultConnectionId: state.assignments?.defaultConnectionId ?? conn.id });
      dispatch({ type: 'providers', assignments: a });
      if (showBudgets) {
        await runtime.api.putBudget({ connections: [{ connectionId: conn.id, budgetMonthUsd: toLimit(month) }], ...(state.project ? { projects: [{ projectId: state.project.id, connectionId: conn.id, limitUsd: toLimit(projectBudget) }] } : {}) });
        reloadBudget();
      }
      await actions.loadProviders();
      onSaved?.();
    } catch (e) { setError(codeOf(e)); }
  };
  const test = async () => {
    setTesting(true); setTested(null);
    try { setTested((await runtime.api.testProviders({ connectionId: conn.id, brainstorm: assign.brainstorm || null, editor: assign.editor || null })).items); }
    catch (e) { setTested(codeOf(e)); }
    setTesting(false);
  };
  const refresh = async () => {
    setFetching(true);
    try { const r = await runtime.api.refreshConnectionModels(conn.id); dispatch({ type: 'capabilities', connectionId: conn.id, rows: r.items }); } catch (e) { actions.error(e); }
    setFetching(false);
  };
  return (
    <div className="flex flex-col gap-3">
      <section aria-label={t('ui.scr.providers.section.assign')}><ModelAssign rows={rows} assign={assign} setAssign={setAssign} onRefresh={() => void refresh()} loading={fetching} /></section>
      {showBudgets && <BudgetFields connectionId={conn.id} month={month} setMonth={setMonth} project={projectBudget} setProject={setProjectBudget} budget={budget} />}
      {error && <ErrorBox code={error} />}
      {typeof tested === 'string' && <ErrorBox code={tested} />}
      {Array.isArray(tested) && <TestResults items={tested} />}
      <div className="flex items-center gap-2">
        <Button el="scr.providers.test" loading={testing} disabledReason={state.settings?.privateMode ? t('err.EM-8202.title') : !assign.brainstorm && !assign.editor ? t('err.EM-4007.title', { agent: t('ui.scr.providers.agents') }) : null} onClick={() => void test()}>{t('ui.scr.providers.test')}</Button>
        <span className="flex-1" />
        <Button el="scr.providers.save" variant="primary" onClick={() => void save()}>{t('ui.common.save')}</Button>
      </div>
    </div>
  );
}

/** FR-110: a single screen whose sections unlock in order; nothing is stored before Save (FR-118). */
function AddConnectionForm({ onDone }: { onDone: () => void }) {
  const { state, runtime, actions, dispatch, t } = useStore();
  const kinds = useKinds();
  const [provider, setProvider] = useState<ProviderKind>('openrouter');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [rows, setRows] = useState<CapabilityRow[] | null>(null);
  const [modelsCode, setModelsCode] = useState<string | null>(null);
  const [assign, setAssign] = useState<Record<AgentKind, string>>({ brainstorm: '', editor: '' });
  const [month, setMonth] = useState('');
  const [project, setProject] = useState('');
  const [busy, setBusy] = useState<'validate' | 'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<ProbeResultDto[] | null>(null);
  const reset = () => { setRows(null); setTested(null); setModelsCode(null); };
  const validate = async () => {
    setBusy('validate'); setError(null); reset();
    try {
      const r = await runtime.api.validateDraft(provider, secret.trim());
      setRows(r.models); setModelsCode(r.modelsCode ?? null);
      setAssign({ brainstorm: defaultModel(r.models, 'brainstorm'), editor: defaultModel(r.models, 'editor') });
    } catch (e) { const c = codeOf(e); setError(c); if (c === 'EM-4002') document.getElementById('em-key')?.focus(); }
    setBusy(null);
  };
  const test = async () => {
    setBusy('test'); setError(null);
    try { setTested((await runtime.api.testProviders({ draft: { provider, secret: secret.trim() }, brainstorm: assign.brainstorm || null, editor: assign.editor || null })).items); }
    catch (e) { setError(codeOf(e)); }
    setBusy(null);
  };
  const save = async () => {
    setBusy('save'); setError(null);
    try {
      const c = await runtime.api.addConnection({ provider, label: label.trim() || t(`ui.scr.providers.provider.${provider}`), secret: secret.trim(), validateNow: true });
      dispatch({ type: 'capabilities', connectionId: c.id, rows: rows ?? [] });
      const body: Parameters<typeof runtime.api.putAssignments>[0] = {};
      for (const a of AGENTS) if (assign[a]) body[a] = { agent: a, connectionId: c.id, modelId: assign[a], settings: {} };
      if (Object.keys(body).length) dispatch({ type: 'providers', assignments: await runtime.api.putAssignments(body) });
      await runtime.api.putBudget({ connections: [{ connectionId: c.id, budgetMonthUsd: toLimit(month) }], ...(state.project && project.trim() ? { projects: [{ projectId: state.project.id, connectionId: c.id, limitUsd: toLimit(project) }] } : {}) });
      await actions.loadProviders();
      actions.toast('success', 'ui.scr.providers.saved');
      onDone();
    } catch (e) { setError(codeOf(e)); }
    setBusy(null);
  };
  const validated = rows !== null;
  return (
    <div data-el="scr.providers.add" className="flex flex-col gap-2 rounded-[8px] border border-em-line p-3">
      <section aria-label={t('ui.scr.providers.section.key')}>
        <ProviderKeyFields provider={provider} setProvider={(p) => { setProvider(p); reset(); }} secret={secret} setSecret={(v) => { setSecret(v); reset(); }} kinds={kinds} />
        <Field label={t('ui.scr.providers.label')} htmlFor="em-conn-label">
          <input id="em-conn-label" data-el="scr.providers.label.input" maxLength={60} value={label} placeholder={t(`ui.scr.providers.provider.${provider}`)} onChange={(e) => setLabel(e.target.value)} className={inputCls} />
        </Field>
        <div className="flex items-center gap-2">
          <Button el="scr.providers.validate" variant="primary" loading={busy === 'validate'}
            disabledReason={secret.trim().length < 8 ? t('ui.scr.providers.key.short') : state.settings?.privateMode ? t('err.EM-8202.title') : !kinds.find((k) => k.provider === provider)?.enabled ? t('err.EM-9004.title') : null}
            onClick={() => void validate()}>{busy === 'validate' ? t('ui.scr.providers.validating') : t('ui.scr.providers.validate')}</Button>
          {validated && <span className="flex items-center gap-1 text-em-success"><Check size={14} />{t('ui.scr.providers.valid')}</span>}
        </div>
      </section>
      {validated ? (
        <>
          <section aria-label={t('ui.scr.providers.section.assign')}>{modelsCode && <Note code={modelsCode} vars={{ provider: t(`ui.scr.providers.provider.${provider}`) }} />}<ModelAssign rows={rows} assign={assign} setAssign={setAssign} /></section>
          <section aria-label={t('ui.scr.providers.section.budget')}><BudgetFields connectionId={null} month={month} setMonth={setMonth} project={project} setProject={setProject} budget={null} /></section>
          {tested && <TestResults items={tested} />}
        </>
      ) : <p data-el="scr.providers.locked" className="text-[12px] text-em-muted">{t('ui.scr.providers.locked')}</p>}
      {error && <ErrorBox code={error} vars={{ provider: t(`ui.scr.providers.provider.${provider}`), action: t('ui.scr.providers.validate') }} />}
      <div className="flex items-center gap-2">
        <Button el="scr.providers.test" loading={busy === 'test'} disabledReason={!validated ? t('ui.scr.providers.locked') : !assign.brainstorm && !assign.editor ? t('err.EM-4007.title', { agent: t('ui.scr.providers.agents') }) : null} onClick={() => void test()}>{t('ui.scr.providers.test')}</Button>
        <span className="flex-1" />
        <Button el="scr.providers.cancel" variant="ghost" onClick={onDone}>{t('ui.common.cancel')}</Button>
        <Button el="scr.providers.save" variant="primary" loading={busy === 'save'} disabledReason={!validated ? t('ui.scr.providers.locked') : null} onClick={() => void save()}>{t('ui.common.save')}</Button>
      </div>
    </div>
  );
}

/** Edit: label and replace key (a new key needs Test/Validate again). */
function EditConnection({ conn, onDone }: { conn: ConnectionDto; onDone: () => void }) {
  const { runtime, actions, t } = useStore();
  const [label, setLabel] = useState(conn.label);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try { await runtime.api.patchConnection(conn.id, { label: label.trim() || conn.label, ...(secret.trim() ? { secret: secret.trim() } : {}) }); await actions.loadProviders(); onDone(); }
    catch (e) { setError(codeOf(e)); }
  };
  return (
    <div data-el="scr.providers.edit" className="mt-1 flex flex-col gap-1 rounded-[6px] border border-em-line p-2">
      <Field label={t('ui.scr.providers.label')} htmlFor={`em-edit-label-${conn.id}`}><input id={`em-edit-label-${conn.id}`} data-el="scr.providers.label.input" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} /></Field>
      <Field label={t('ui.scr.providers.key.replace')} htmlFor={`em-edit-key-${conn.id}`}><input id={`em-edit-key-${conn.id}`} data-el="scr.providers.key.input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} onPaste={(e) => { const v = e.clipboardData.getData('text'); if (v) { e.preventDefault(); setSecret(v.trim()); } }} className={inputCls} /></Field>
      {error && <ErrorBox code={error} />}
      <div className="flex justify-end gap-2"><Button variant="ghost" size={28} onClick={onDone}>{t('ui.common.cancel')}</Button><Button el="scr.providers.edit.save" variant="primary" size={28} onClick={() => void save()}>{t('ui.common.save')}</Button></div>
    </div>
  );
}

/** FR-109 row: provider, label, status, model count, default marker, usage of budget; Edit, Test, Set default, Remove (FR-119 confirm). */
function ConnectionRow({ c, budget, onChanged }: { c: ConnectionDto; budget: Budget | null; onChanged: () => void }) {
  const { state, runtime, actions, dispatch, t, lang } = useStore();
  const [mode, setMode] = useState<'edit' | 'confirm' | null>(null);
  const [rowTest, setRowTest] = useState<string | null>(null);
  const isDefault = state.assignments?.defaultConnectionId === c.id;
  const b = budget?.connections.find((x) => x.connectionId === c.id);
  const usage = b ? (b.budgetMonthUsd ? t('ui.scr.providers.usage.of', { spent: formatMoney(b.spentMonthUsd, b.approximate, lang), limit: formatMoney(b.budgetMonthUsd, false, lang) })
    : t('ui.scr.providers.usage.nolimit', { spent: formatMoney(b.spentMonthUsd, b.approximate, lang) })) : null;
  const test = async () => {
    setRowTest(null);
    try { const r = await runtime.api.validateConnection(c.id); setRowTest(r.status === 'valid' ? 'ok' : r.errorCode ?? 'EM-4002'); } catch (e) { setRowTest(codeOf(e)); }
    await actions.loadProviders();
  };
  const setDefault = async () => { try { dispatch({ type: 'providers', assignments: await runtime.api.putAssignments({ defaultConnectionId: c.id }) }); } catch (e) { actions.error(e); } };
  const remove = async () => {
    const used = AGENTS.filter((a) => state.assignments?.[a]?.connectionId === c.id);
    try {
      await runtime.api.deleteConnection(c.id, true);
      await actions.loadProviders();
      const after = await runtime.api.getAssignments().catch(() => null);
      if (used.some((a) => !after?.[a])) actions.toast('info', 'err.EM-4007.title', { agent: t('ui.scr.providers.agents') }, { code: 'EM-4007' });
      onChanged();
    } catch (e) { actions.error(e); }
    setMode(null);
  };
  return (
    <li data-el="scr.providers.row" data-connection-id={c.id} className="rounded-[6px] border border-em-line px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="font-medium">{c.label}</span> <span className="text-em-muted">{t(`ui.scr.providers.provider.${c.provider}`)}</span> <span className="t-mono text-em-muted">{c.secretHint}</span>
          <span data-el="scr.providers.row.usage" className="block text-[11px] text-em-muted">
            {c.modelCount != null ? t('ui.scr.providers.models.count', { count: c.modelCount }) : t('ui.scr.providers.models.notloaded')}{usage ? ` · ${usage}` : ''}
          </span>
        </span>
        {isDefault && <Badge el="scr.providers.row.isdefault" tone="accent">{t('ui.scr.providers.default')}</Badge>}
        <Badge tone={c.status === 'valid' ? 'success' : c.status === 'invalid' ? 'danger' : 'neutral'}>{t(`ui.scr.providers.status.${c.status}`)}</Badge>
        <Button el="scr.providers.row.edit" size={28} variant="ghost" onClick={() => setMode(mode === 'edit' ? null : 'edit')}>{t('ui.scr.providers.edit')}</Button>
        <Button el="scr.providers.row.test" size={28} variant="ghost" disabledReason={state.settings?.privateMode ? t('err.EM-8202.title') : null} onClick={() => void test()}>{t('ui.scr.providers.rowtest')}</Button>
        {!isDefault && <Button el="scr.providers.row.default" size={28} variant="ghost" disabledReason={c.status !== 'valid' ? t('ui.scr.providers.status.unvalidated') : null} onClick={() => void setDefault()}>{t('ui.scr.providers.setdefault')}</Button>}
        <IconButton el="scr.providers.row.remove" label={t('ui.common.remove')} icon={<Trash2 size={14} />} size={28} onClick={() => setMode('confirm')} />
      </div>
      {rowTest && <p className={cx('text-[12px]', rowTest === 'ok' ? 'text-em-success' : 'text-em-warn')}>{rowTest === 'ok' ? t('ui.scr.providers.valid') : `${t(`err.${rowTest}.title`, { provider: c.label })} · ${rowTest}`}</p>}
      {mode === 'edit' && <EditConnection conn={c} onDone={() => { setMode(null); onChanged(); }} />}
      {mode === 'confirm' && (
        <div data-el="scr.providers.row.remove.confirm" role="alertdialog" aria-label={t('ui.scr.providers.remove.confirm', { label: c.label })} className="mt-1 flex items-center gap-2 rounded-[6px] bg-em-panel-2 p-2 text-[12px]">
          <span className="flex-1">{t('ui.scr.providers.remove.confirm', { label: c.label })}</span>
          <Button size={28} variant="ghost" onClick={() => setMode(null)}>{t('ui.common.cancel')}</Button>
          <Button el="scr.providers.row.remove.yes" size={28} variant="danger" onClick={() => void remove()}>{t('ui.common.remove')}</Button>
        </div>
      )}
    </li>
  );
}

/** The connection an EM-4201 focus points at: the one in the error details, else the first whose cap is used up (FR-117). */
export function breachedConnection(budget: Budget | null, projectId: string | null, focus: BudgetFocus): string | undefined {
  if (focus.connectionId) return focus.connectionId;
  if (!budget) return undefined;
  const over = (spent: number, limit: number | null) => limit !== null && limit > 0 && spent >= limit;
  if (focus.field === 'month') return budget.connections.find((c) => over(c.spentMonthUsd, c.budgetMonthUsd))?.connectionId;
  return budget.projects.find((p) => p.projectId === projectId && p.connectionId && over(p.spentUsd, p.limitUsd))?.connectionId ?? undefined;
}

export function ProvidersScreen({ onClose, focus }: { onClose: () => void; focus?: BudgetFocus }) {
  const { state, actions, t } = useStore();
  const [adding, setAdding] = useState(false);
  const [budget, reloadBudget] = useBudget();
  const focusConn = focus ? breachedConnection(budget, state.project?.id ?? null, focus) : undefined;
  useEffect(() => { void actions.loadProviders(); }, [actions]);
  const showAdd = adding || state.connections.length === 0;
  return (
    <Modal el="scr.providers" sheet width={680} title={t('ui.scr.providers.title')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ul data-el="scr.providers.list" className="flex flex-col gap-1">
          {state.connections.length === 0 && <li className="text-em-muted">{t('ui.scr.providers.none')}</li>}
          {state.connections.map((c) => <ConnectionRow key={c.id} c={c} budget={budget} onChanged={reloadBudget} />)}
        </ul>
        {showAdd ? <AddConnectionForm onDone={() => { setAdding(false); reloadBudget(); }} />
          : <div><Button el="scr.providers.add.open" onClick={() => setAdding(true)}>{t('ui.scr.providers.add')}</Button></div>}
        {state.connections.length > 0 && !adding && <AssignForm key={focusConn ?? 'default'} {...(focusConn ? { connectionId: focusConn } : {})} {...(focus ? { focusField: focus.field } : {})} onSaved={() => { reloadBudget(); actions.toast('success', 'ui.scr.providers.saved'); }} />}
      </div>
    </Modal>
  );
}
