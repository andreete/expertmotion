// ServiceProvider + project state (BLUEPRINT.md §3.7 state/service.tsx, state/project.tsx in one provider): owns the
// reducer, the SSE subscription, the follow-up REST calls that events require, and the Creator-facing actions.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { EmError } from '@expertmotion/shared';
import type { ElementRefT, ProjectSettingsT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import { createEventStream, type EventStream } from '../api/events.js';
import type {
  AgentKind, DesignPickInput, EditIntent, IntentCategory, MessageDto, OutputProfile, PerformanceProfile, PlanDto, ProjectCreateInput, ProviderKind, Ratio, RenderCreateInput,
  Resolution, ServiceEvent, SettingsDto,
} from '../api/types.js';
import { initialState, reducer, type Action, type AppState, type Screen, type ToastKind, type LibMode } from './reducer.js';
import type { Runtime } from './runtime.js';
import { loadPrefs, savePrefs, type Prefs } from '../prefs.js';
import { translate, type Lang } from '../i18n/index.js';

export interface Actions {
  openProject(id: string): Promise<void>;
  createProject(input: ProjectCreateInput): Promise<void>;
  renameProject(name: string): Promise<boolean>;
  refreshHead(): Promise<void>;
  save(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  pick(presetId: string, opts?: { params?: Record<string, unknown>; target?: ElementRefT }): Promise<void>;
  textPick(params: Record<string, unknown>): Promise<void>;
  addText(text: string, variantId: string): Promise<void>;
  layoutPick(params: { ratio?: Ratio; customRatio?: { w: number; h: number }; resolution?: Resolution }): Promise<void>;
  setAutoRatio(on: boolean): Promise<void>;
  updateProjectSettings(patch: Partial<ProjectSettingsT>): Promise<void>;
  upload(files: readonly File[]): Promise<void>;
  setBadge(assetId: string, badge: number | null): Promise<void>;
  insert(assetIds: string[]): Promise<void>;
  removeAsset(assetId: string, confirm?: boolean): Promise<void>;
  setAssetSelection(ids: string[]): void;
  captionsFromAsset(assetId: string): Promise<void>;
  restoreIntent(id: string): Promise<void>;
  removeIntent(id: string): Promise<void>;
  clearIntents(): Promise<void>;
  plan(message?: string): Promise<void>;
  execute(): Promise<void>;
  cancelPlan(): Promise<void>;
  setNotes(notes: string): Promise<void>;
  send(agent: AgentKind, text: string, attachments?: string[]): Promise<boolean>;
  handoff(message: MessageDto, intentIds: string[]): Promise<void>;
  dismissHandoff(message: MessageDto): void;
  stopStreaming(agent: AgentKind): void;
  setPrivateMode(on: boolean): Promise<void>;
  setLanguage(lang: Lang): Promise<void>;
  setProfile(p: PerformanceProfile): Promise<void>;
  putSettings(patch: Partial<SettingsDto>): Promise<void>;
  resetOutput(): Promise<void>;
  startRender(input: Omit<RenderCreateInput, 'projectId'>): Promise<string | null>;
  cancelRender(jobId: string): Promise<void>;
  loadProviders(): Promise<void>;
  addConnection(provider: ProviderKind, secret: string, label: string): Promise<boolean>;
  loadModels(): Promise<void>;
  reloadState(): Promise<void>;
  error(err: unknown): void;
  toast(kind: ToastKind, textKey: string, vars?: Record<string, string | number>, opts?: { code?: string; action?: { labelKey: string; run: () => void }; sticky?: boolean }): void;
  announce(text: string): void;
  setScreen(screen: Screen | null): void;
  setLibMode(mode: LibMode): void;
  select(sel: ElementRefT[]): void;
  seek(ms: number): void;
  preview(presetId: string | null): void;
}

export interface Store { state: AppState; dispatch: (a: Action) => void; runtime: Runtime; actions: Actions; prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void; t: (k: string, v?: Record<string, string | number>) => string; lang: Lang }

const StoreContext = createContext<Store | null>(null);
export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

export const errCode = (e: unknown): string => (e instanceof EmError ? e.code : 'EM-9001');
const PRESET_CATEGORY_TO_INTENT: Record<string, IntentCategory> = {
  transition: 'transition', caption: 'caption', background: 'background', motion: 'motion', shape: 'shape', easing: 'easing', effect: 'effect', audio: 'audio',
  text: 'text', texteffect: 'text', font: 'text', palette: 'layout', fontpair: 'layout',
};

export function StoreProvider({ runtime, children, initialPrefs }: { runtime: Runtime; children: ReactNode; initialPrefs?: Partial<Prefs> }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatch = useCallback((a: Action) => rawDispatch(a), []);
  const prefsRef = useRef<Prefs>({ ...loadPrefs(), ...(initialPrefs ?? {}) });
  const [, forcePrefs] = useReducer((x: number) => x + 1, 0);
  const setPrefs = useCallback((p: Partial<Prefs>) => { prefsRef.current = { ...prefsRef.current, ...p }; savePrefs(prefsRef.current); forcePrefs(); }, []);
  const api = runtime.api;
  const lang: Lang = state.settings?.uiLanguage ?? 'en';
  const t = useCallback((k: string, v?: Record<string, string | number>) => translate(lang, k, v), [lang]);
  const pid = () => stateRef.current.project?.id ?? null;
  const headHash = () => stateRef.current.head?.hash ?? stateRef.current.project?.headHash ?? '';

  const actions = useMemo<Actions>(() => {
    const toast: Actions['toast'] = (kind, textKey, vars, opts = {}) => dispatch({ type: 'toast', toast: { kind, textKey, ...(vars ? { vars } : {}), ...(opts.code ? { code: opts.code } : {}), ...(opts.action ? { action: opts.action } : {}), sticky: opts.sticky ?? kind === 'danger' } });
    const announce = (text: string) => dispatch({ type: 'announce', text });
    const error = (err: unknown) => {
      const code = errCode(err);
      if (code === 'EM-8001' && stateRef.current.stream === 'offline') return;     // sys.offline suppresses other error toasts (§10)
      toast(code.startsWith('EM-5') || code === 'EM-4401' || code === 'EM-4007' || code === 'EM-2403' || code === 'EM-9004' || code === 'EM-7001' ? 'info' : 'danger', `err.${code}.title`, undefined, { code });
    };
    const refreshHead = async () => {
      const id = pid(); if (!id) return;
      try { const c = await api.getComposition(id); if (pid() === id) dispatch({ type: 'head', head: c.head, canUndo: c.canUndo, canRedo: c.canRedo }); } catch (e) { error(e); }
    };
    const openProject = async (id: string) => {
      try {
        const open = await api.openProject(id);
        const [assets, brainstorm, editor] = await Promise.all([
          api.listAssets(id, { limit: 200 }).then((p) => p.items),
          api.getConversation(id, 'brainstorm').catch(() => null),
          api.getConversation(id, 'editor').catch(() => null),
        ]);
        dispatch({ type: 'projectOpened', open, assets, messages: { brainstorm: brainstorm?.messages.items ?? [], editor: editor?.messages.items ?? [] }, contextUsage: { brainstorm: brainstorm?.contextUsage ?? null, editor: editor?.contextUsage ?? null } });
        if (!open.head.model) await refreshHead();
        api.listOutputs(id).then((o) => dispatch({ type: 'outputs', outputs: o.items })).catch(() => undefined);
        if (open.checkpointNewerThanSave) dispatch({ type: 'screen', screen: { kind: 'project.recover' } });
      } catch (e) { error(e); }
    };
    const reloadState = async () => { const id = pid(); if (id) await openProject(id); };
    const createIntent = async (body: Omit<DesignPickInput, 'baseVersion' | 'selection' | 'playheadMs'>, label: string) => {
      const id = pid(); if (!id) { toast('info', 'err.EM-2202.title', undefined, { code: 'EM-2202' }); return; }
      const s = stateRef.current;
      const optimistic: EditIntent = {
        id: `pending-${Date.now()}`, projectId: id, source: body.source, createdAt: new Date().toISOString(), category: body.category, params: body.params ?? {}, target: body.target,
        resolvedTargets: [], propertyKey: label, propertyClass: 'scalar', needsInterpretation: false, status: 'queued', supersedes: [], baseVersion: headHash(), ...(body.presetId ? { presetId: body.presetId } : {}),
      };
      dispatch({ type: 'optimisticIntent', intent: optimistic });
      try {
        const res = await api.createIntent(id, { ...body, baseVersion: headHash(), selection: s.selection, playheadMs: s.playheadMs });
        dispatch({ type: 'queue', queue: res.queue });
        for (const n of res.notices) if (n.code === 'EM-2403') toast('info', 'err.EM-2403.title', undefined, { code: 'EM-2403' });
        if (res.intent.status === 'rejected') {
          const code = (res.intent.rejectionReason ?? '').split(':')[0] ?? 'EM-2201';
          announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', `err.${code}.title`));
        }
        if (res.appliedVersion) {
          await refreshHead();
          toast('success', 'ui.sys.toast.applieddirect', { label }, { action: { labelKey: 'ui.sys.toast.undo', run: () => { void undo(); } } });
          announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', 'ui.sys.live.applied', { version: res.appliedVersion.hash.slice(0, 6) }));
        }
      } catch (e) {
        dispatch({ type: 'dropOptimistic', id: optimistic.id });
        if (e instanceof EmError && e.code === 'EM-2301') { await refreshHead(); }
        error(e);
      }
    };
    const undo = async () => { const id = pid(); if (!id) return; try { await api.undo(id); await refreshHead(); } catch (e) { error(e); } };
    const redo = async () => { const id = pid(); if (!id) return; try { await api.redo(id); await refreshHead(); } catch (e) { error(e); } };
    const setScreen = (screen: Screen | null) => dispatch({ type: 'screen', screen });
    const self: Actions = {
      openProject, refreshHead, reloadState, error, toast, announce, undo, redo, setScreen,
      async createProject(input) {
        try { const p = await api.createProject(input); await openProject(p.id); } catch (e) { error(e); }
      },
      async renameProject(name) {
        const id = pid(); if (!id) return false;
        try { const p = await api.patchProject(id, { name }); dispatch({ type: 'project', project: { ...p, dirty: stateRef.current.project?.dirty ?? p.dirty } }); return true; } catch (e) { error(e); return false; }
      },
      async save() {
        const id = pid(); if (!id) return;
        try { await api.createCheckpoint(id); const p = stateRef.current.project; if (p) dispatch({ type: 'project', project: { ...p, dirty: false } }); toast('info', 'ui.sys.toast.saved'); } catch (e) { error(e); }
      },
      async pick(presetId, opts = {}) {
        const p = getPreset(presetId);
        if (!p) return;
        await createIntent({ source: 'ui', category: PRESET_CATEGORY_TO_INTENT[p.category] ?? 'effect', presetId, params: opts.params ?? {}, target: opts.target ?? { kind: 'selection' }, plan: 'auto' }, p.label[stateRef.current.settings?.uiLanguage ?? 'en']);
      },
      async textPick(params) { await createIntent({ source: 'ui', category: 'text', params, target: { kind: 'selection' }, plan: 'auto' }, Object.keys(params).join(', ')); },
      async addText(text, variantId) { await createIntent({ source: 'ui', category: 'text', presetId: variantId, params: { text }, target: { kind: 'playhead' }, plan: 'auto' }, text); },
      async layoutPick(params) { await createIntent({ source: 'ui', category: 'layout', params, target: { kind: 'project' }, plan: 'auto' }, params.ratio ?? params.resolution ?? 'layout'); },
      async setAutoRatio(on) {
        const id = pid(), s = stateRef.current.head?.model?.settings; if (!id || !s) return;
        try { await api.putProjectSettings(id, { ...s, autoRatio: on }); await refreshHead(); } catch (e) { error(e); }
      },
      async updateProjectSettings(patch) {
        const id = pid(), s = stateRef.current.head?.model?.settings; if (!id || !s) return;
        try { await api.putProjectSettings(id, { ...s, ...patch }); await refreshHead(); } catch (e) { error(e); }
      },
      async upload(files) {
        const id = pid(); if (!id || !files.length) return;
        try {
          const paths = files.map((f) => (f as File & { path?: string }).path).filter((x): x is string => typeof x === 'string' && x.length > 0);
          const res = runtime.mode === 'live' && paths.length === files.length && window.expertmotion ? await api.importAssetPaths(id, paths) : await api.uploadAssets(id, files);
          dispatch({ type: 'assetsUpsert', assets: res.items });
          for (const n of res.notices) if (n.code) toast('info', `err.${n.code}.title`, undefined, { code: n.code });
        } catch (e) { error(e); }
      },
      async setBadge(assetId, badge) {
        const id = pid(); if (!id) return;
        try {
          const res = await api.setSequenceBadge(id, assetId, badge);
          dispatch({ type: 'assetsUpsert', assets: res.items });
          if (badge !== null && !stateRef.current.assetSelection.includes(assetId)) dispatch({ type: 'assetSelection', ids: [...stateRef.current.assetSelection, assetId] });
        } catch (e) { error(e); }
      },
      async insert(assetIds) {
        const id = pid(); if (!id || !assetIds.length) return;
        const first = !(stateRef.current.head?.model?.tracks.video.length);
        try {
          await api.insertAssets(id, { assetIds, order: 'badge' });
          const assets = await api.listAssets(id, { limit: 200 });
          dispatch({ type: 'assets', assets: assets.items });
          dispatch({ type: 'assetSelection', ids: [] });
          await refreshHead();
          toast('success', first ? 'ui.sys.toast.firstinsert' : 'ui.sys.toast.inserted', { count: assetIds.length }, first ? { action: { labelKey: 'ui.hdr.menu.design', run: () => dispatch({ type: 'libMode', mode: 'design' }) } } : {});
        } catch (e) { error(e); }
      },
      async removeAsset(assetId, confirm = false) {
        const id = pid(); if (!id) return;
        try {
          await api.deleteAsset(id, assetId, confirm);
          dispatch({ type: 'assetRemoved', assetId });
          if (confirm) await refreshHead();
        } catch (e) {
          if (e instanceof EmError && e.code === 'EM-1101') {
            const a = stateRef.current.assets.find((x) => x.id === assetId);
            setScreen({ kind: 'confirm', titleKey: 'ui.modal.remove.asset.title', bodyKey: 'ui.modal.remove.asset.body', vars: { name: a?.name ?? '' }, confirmKey: 'ui.common.remove', danger: true, onConfirm: () => { void self.removeAsset(assetId, true); } });
            return;
          }
          error(e);
        }
      },
      setAssetSelection: (ids) => dispatch({ type: 'assetSelection', ids }),
      async captionsFromAsset(assetId) {
        const a = stateRef.current.assets.find((x) => x.id === assetId);
        await createIntent({ source: 'ui', category: 'caption', params: { assetId }, target: { kind: 'project' }, plan: 'auto' }, a?.name ?? 'captions');
      },
      async restoreIntent(intentId) {
        const id = pid(); if (!id) return;
        try { const res = await api.restoreIntent(id, intentId); dispatch({ type: 'queue', queue: res.queue }); if (res.appliedVersion) await refreshHead(); } catch (e) { error(e); }
      },
      async removeIntent(intentId) {
        const id = pid(); if (!id) return;
        try {
          const q = await api.removeIntent(id, intentId);
          dispatch({ type: 'queue', queue: q });
          toast('info', 'ui.sys.toast.removed', undefined, { action: { labelKey: 'ui.sys.toast.undo', run: () => { void api.restoreIntent(id, intentId).then((r) => dispatch({ type: 'queue', queue: r.queue })).catch(error); } } });
        } catch (e) { error(e); }
      },
      async clearIntents() {
        const id = pid(); if (!id) return;
        try { await api.clearIntents(id, 'queued'); const q = await api.clearIntents(id, 'superseded'); dispatch({ type: 'queue', queue: q }); } catch (e) { error(e); }
      },
      async plan(message) {
        const id = pid(); if (!id) return;
        try {
          const res = await api.createPlan(id, { baseVersion: headHash(), ...(message ? { message } : {}) });
          const plan: PlanDto = 'plan' in res ? res.plan : res;
          dispatch({ type: 'plan', plan });
        } catch (e) { error(e); }
      },
      async execute() {
        const plan = stateRef.current.plan;
        if (!plan || plan.status !== 'valid') return;
        const destructive = plan.steps.some((s) => s.ops.some((o) => ['op:clip.remove', 'op:caption.clear', 'op:background.clear', 'op:text.remove', 'op:shape.remove', 'op:audio.remove'].includes(o.op)));
        const run = async () => {
          dispatch({ type: 'plan', plan: { ...plan, status: 'executing' } });
          try {
            const r = await api.executePlan(plan.id, { confirmDestructive: destructive });
            if (r.ok) {
              dispatch({ type: 'plan', plan: { ...plan, status: 'executed' } });
              await refreshHead();
              const v = (r.toVersion ?? '').slice(0, 6);
              toast('success', 'ui.sys.toast.applied', { count: r.appliedOps, version: v }, { action: { labelKey: 'ui.sys.toast.undo', run: () => { void undo(); } } });
              announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', 'ui.sys.live.applied', { version: v }));
            } else {
              dispatch({ type: 'plan', plan: { ...plan, status: 'failed', errorCode: r.error?.code ?? 'EM-2307' } });
            }
          } catch (e) {
            if (e instanceof EmError && e.code === 'EM-2301') { dispatch({ type: 'plan', plan: { ...plan, status: 'stale' } }); return; }
            dispatch({ type: 'plan', plan: { ...plan, status: 'valid' } });
            error(e);
          }
        };
        if (destructive) setScreen({ kind: 'confirm', titleKey: 'ui.modal.destructive.title', bodyKey: 'ui.modal.destructive.body', confirmKey: 'ui.agent.editor.execute', danger: true, onConfirm: () => { void run(); } });
        else await run();
      },
      async cancelPlan() {
        const s = stateRef.current, plan = s.plan;
        try {
          const run = s.streaming.editor;
          if (run) await api.cancelAgentRun(run.runId).catch(() => undefined);
          if (plan && plan.status !== 'executed') { const p = await api.cancelPlan(plan.id); dispatch({ type: 'plan', plan: { ...plan, ...p, status: 'cancelled' } }); }
          dispatch({ type: 'agentError', agent: 'editor', code: null });
          const id = pid(); if (id) dispatch({ type: 'queue', queue: await api.listIntents(id) });
        } catch (e) { error(e); }
      },
      async setNotes(notes) {
        const plan = stateRef.current.plan; if (!plan) return;
        try { const p = await api.setPlanNotes(plan.id, notes); dispatch({ type: 'plan', plan: { ...plan, notes: p.notes ?? notes } }); } catch (e) { error(e); }
      },
      async send(agent, text, attachments = []) {
        const id = pid(); if (!id) return false;
        try {
          dispatch({ type: 'agentError', agent, code: null });
          const res = await api.sendMessage(id, agent, { text, attachments: attachments.map((assetId) => ({ assetId })), baseVersion: headHash() });
          dispatch({ type: 'messageAdded', agent, message: res.message });
          dispatch({ type: 'streamingStart', agent, runId: res.runId, modelId: stateRef.current.assignments?.[agent]?.modelId ?? '' });
          return true;
        } catch (e) {
          dispatch({ type: 'agentError', agent, code: errCode(e) });
          return false;
        }
      },
      async handoff(message, intentIds) {
        const id = pid(); if (!id) return;
        try {
          const res = await api.handoff(id, { messageId: message.id, intentIds, baseVersion: headHash() });
          dispatch({ type: 'queue', queue: res.queue });
          const msgs = stateRef.current.messages.brainstorm.map((m) => (m.id === message.id ? { ...m, blocks: m.blocks.map((b) => (b.type === 'proposed_intents' ? { ...b, handoffState: 'sent' as const } : b)) } : m));
          dispatch({ type: 'messages', agent: 'brainstorm', messages: msgs });
          await refreshHead();
          for (const r of res.rejected) toast('warn', `err.${r.code}.title`, undefined, { code: r.code });
          announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', 'ui.agent.brainstorm.handoff.sent', { count: res.accepted.length }));
        } catch (e) { error(e); }
      },
      dismissHandoff(message) {
        const msgs = stateRef.current.messages.brainstorm.map((m) => (m.id === message.id ? { ...m, blocks: m.blocks.map((b) => (b.type === 'proposed_intents' ? { ...b, handoffState: b.handoffState === 'dismissed' ? 'pending' as const : 'dismissed' as const } : b)) } : m));
        dispatch({ type: 'messages', agent: 'brainstorm', messages: msgs });
      },
      async setPrivateMode(on) { try { dispatch({ type: 'settings', settings: await api.putSettings({ privateMode: on }) }); } catch (e) { error(e); } },
      async setLanguage(l) { try { dispatch({ type: 'settings', settings: await api.putSettings({ uiLanguage: l }) }); } catch (e) { error(e); } },
      async putSettings(patch) { try { dispatch({ type: 'settings', settings: await api.putSettings(patch) }); } catch (e) { error(e); } },
      async setProfile(p) {
        dispatch({ type: 'performanceProfile', profile: p });
        setPrefs({ draft: p !== 'turbo' });
        try { dispatch({ type: 'settings', settings: await api.putSettings({ defaultPerformanceProfile: p }) }); } catch (e) { error(e); }
      },
      async resetOutput() {
        const id = pid(), s = stateRef.current.head?.model?.settings; if (!id || !s) return;
        try {
          await api.putProjectSettings(id, { ...s, ratio: '16:9', resolution: '1080p', autoRatio: false });
          dispatch({ type: 'performanceProfile', profile: 'standard' });
          await api.putSettings({ defaultPerformanceProfile: 'standard' }).then((x) => dispatch({ type: 'settings', settings: x }));
          await refreshHead();
        } catch (e) { error(e); }
      },
      async startRender(input) {
        const id = pid(); if (!id) return null;
        try { const job = await api.createRender({ ...input, projectId: id }); dispatch({ type: 'renders', renders: [job, ...stateRef.current.renders.filter((j) => j.id !== job.id)] }); return job.id; } catch (e) { error(e); return null; }
      },
      async cancelRender(jobId) { try { const j = await api.cancelRender(jobId); dispatch({ type: 'renders', renders: stateRef.current.renders.map((x) => (x.id === j.id ? j : x)) }); } catch (e) { error(e); } },
      async loadProviders() {
        try { const [c, a] = await Promise.all([api.listConnections(), api.getAssignments()]); dispatch({ type: 'providers', connections: c.items, assignments: a }); } catch (e) { error(e); }
      },
      async addConnection(provider, secret, label) {
        try {
          const c = await api.addConnection({ provider, secret, label, validateNow: true });
          const models = await api.connectionModels(c.id).catch(() => ({ items: [] }));
          dispatch({ type: 'capabilities', connectionId: c.id, rows: models.items });
          await self.loadProviders();
          return c.status === 'valid';
        } catch (e) { error(e); await self.loadProviders(); return false; }
      },
      async loadModels() { try { dispatch({ type: 'models', models: (await api.listModels()).items }); } catch (e) { error(e); } },
      stopStreaming: (agent) => dispatch({ type: 'streamingStop', agent }),
      setLibMode: (mode) => dispatch({ type: 'libMode', mode }),
      select: (sel) => dispatch({ type: 'select', selection: sel }),
      seek: (ms) => dispatch({ type: 'playhead', ms }),
      preview: (presetId) => dispatch({ type: 'preview', presetId }),
    };
    return self;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, dispatch, runtime.mode, setPrefs]);

  // ── follow-ups that SSE events require (REST refetches, toasts, live announcements) ──
  const onEvent = useCallback((ev: ServiceEvent) => {
    dispatch({ type: 'event', event: ev });
    const L = stateRef.current.settings?.uiLanguage ?? 'en';
    switch (ev.name) {
      case 'composition.updated':
        if (stateRef.current.project && ev.data.projectId === stateRef.current.project.id && ev.data.version.id !== stateRef.current.head?.id) void actions.refreshHead();
        break;
      case 'render.done':
        actions.toast('success', 'ui.sys.toast.exportdone', { name: ev.data.output.fileName });
        actions.announce(translate(L, 'ui.sys.live.exportdone', { name: ev.data.output.fileName }));
        break;
      case 'render.failed':
        actions.toast('danger', `err.${ev.data.code}.title`, undefined, { code: ev.data.code, action: { labelKey: 'ui.hdr.action.export', run: () => actions.setScreen({ kind: 'export' }) } });
        actions.announce(translate(L, 'ui.sys.live.exportfailed'));
        break;
      case 'ingest.done': actions.announce(translate(L, 'ui.sys.live.ingested', { name: ev.data.asset.name })); break;
      case 'plan.ready':
        if (ev.data.plan.status === 'valid' && ev.data.plan.origin === 'editor-agent') actions.announce(translate(L, 'ui.sys.live.planready', { goal: ev.data.plan.goal }));
        break;
      case 'agent.run.failed': if (ev.data.code === 'EM-8202') actions.toast('info', 'err.EM-8202.title', undefined, { code: 'EM-8202' }); break;
      case 'service.notice':
        if (ev.data.kind === 'resync') void actions.reloadState();
        if (ev.data.kind === 'low-disk' || ev.data.kind === 'low-memory') actions.toast('warn', `err.${ev.data.code ?? 'EM-6402'}.title`, undefined, { code: ev.data.code ?? 'EM-6402' });
        if (ev.data.kind === 'restore' && ev.data.done && typeof ev.data.projectId === 'string') void actions.openProject(ev.data.projectId);
        break;
      default: break;
    }
  }, [actions, dispatch]);

  // ── boot ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [health, settings, licence, hardware] = await Promise.all([
          runtime.api.health(), runtime.api.getSettings(), runtime.api.getLicense(), runtime.api.hardwareProfile().catch(() => null),
        ]);
        if (cancelled) return;
        dispatch({ type: 'globals', health, settings, licence, hardware });
        await actions.loadProviders();
        await actions.loadModels();
        const recent = await runtime.api.recentProjects().catch(() => ({ items: [] }));
        const target = recent.items[0]?.id ?? runtime.seededProjectId ?? (await runtime.api.listProjects({ limit: 1 }).catch(() => ({ items: [] }))).items[0]?.id;
        if (target) await actions.openProject(target);
        if (!cancelled) {
          dispatch({ type: 'boot', boot: 'ready' });
          if (!prefsRef.current.onboardingDone) dispatch({ type: 'screen', screen: { kind: 'onboarding' } });
        }
      } catch (e) {
        if (!cancelled) { dispatch({ type: 'boot', boot: 'no-service' }); actions.error(e); }
      }
    })();
    return () => { cancelled = true; };
  }, [runtime, actions, dispatch]);

  // ── SSE: one stream per open project (projectId filter), reopened on project change ──
  const projectId = state.project?.id;
  const streamRef = useRef<EventStream | null>(null);
  useEffect(() => {
    if (state.boot !== 'ready') return;
    const stream = createEventStream({
      url: runtime.api.eventsUrl(projectId ? { projectId } : {}),
      ...(runtime.createSource ? { createSource: runtime.createSource } : {}),
      onEvent,
      onStatus: (status, attempt) => dispatch({ type: 'stream', status, attempt }),
      onResync: () => { void actions.reloadState(); void runtime.api.listRenders(projectId ? { projectId } : {}).then((p) => dispatch({ type: 'renders', renders: p.items })).catch(() => undefined); },
      healthCheck: runtime.healthCheck,
      storageKey: `expertmotion.seq.${projectId ?? 'global'}`,
    });
    streamRef.current = stream;
    return () => { stream.close(); streamRef.current = null; };
  }, [state.boot, projectId, runtime, onEvent, actions, dispatch]);

  const value = useMemo<Store>(() => ({ state, dispatch, runtime, actions, prefs: prefsRef.current, setPrefs, t, lang }), [state, dispatch, runtime, actions, setPrefs, t, lang]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** Output profile for the Export dialog from the current project settings. */
export function currentOutputProfile(s: AppState): OutputProfile {
  const st = s.head?.model?.settings ?? s.project?.settings;
  return { ratio: st?.ratio ?? '16:9', ...(st?.customRatio ? { customRatio: st.customRatio } : {}), resolution: st?.resolution ?? '1080p', fps: st?.fps ?? 30, format: 'mp4', codec: 'h264', crf: 18, alpha: false };
}
