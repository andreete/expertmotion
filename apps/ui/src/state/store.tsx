// ServiceProvider + project state (BLUEPRINT.md §3.7 state/service.tsx, state/project.tsx in one provider): owns the
// reducer, the SSE subscription, the follow-up REST calls that events require, and the Creator-facing actions.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { EmError } from '@expertmotion/shared';
import type { ElementRefT, ProjectSettingsT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import { createEventStream, type EventStream } from '../api/events.js';
import type {
  AgentKind, AssetDto, IntentCreateResponse, DesignPickInput, EditIntent, IntentCategory, MessageDto, OutputProfile, PerformanceProfile, PlanDto, ProjectCreateInput, ProviderKind, Ratio, RenderCreateInput,
  Resolution, ServiceEvent, SettingsDto,
} from '../api/types.js';
import { initialState, reducer, type Action, type AppState, type Screen, type ToastKind, type LibMode } from './reducer.js';
import type { Runtime } from './runtime.js';
import { loadPrefs, savePrefs, type Prefs } from '../prefs.js';
/** Window event that opens the Hardware Monitor popover (Header listens; FR-128 low-disk banner action). */
export const OPEN_HARDWARE_EVENT = 'expertmotion:open-hardware';
import { translate, type Lang } from '../i18n/index.js';

export interface Actions {
  openProject(id: string): Promise<void>;
  /** R-025: create (or reuse) the tour's sample project and open it; resolves with its id, or null on error. */
  openSampleProject(language: Lang): Promise<string | null>;
  createProject(input: ProjectCreateInput): Promise<void>;
  renameProject(name: string): Promise<boolean>;
  refreshHead(): Promise<void>;
  save(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  pick(presetId: string, opts?: { params?: Record<string, unknown>; target?: ElementRefT }): Promise<void>;
  textPick(params: Record<string, unknown>): Promise<void>;
  /** FR-027: adds a Text Layer at the playhead and selects it; resolves with the new layer id (null when nothing was applied). */
  addText(text: string, variantId: string): Promise<string | null>;
  layoutPick(params: { ratio?: Ratio; customRatio?: { w: number; h: number }; resolution?: Resolution }): Promise<void>;
  setAutoRatio(on: boolean): Promise<void>;
  /** FR-068 (P1): Timeline drag on the video Track → op:clip.move / op:clip.setTrim through the Intent Queue. */
  clipEdit(edit: { clipId: string; toIndex?: number; trimBeforeMs?: number; durationMs?: number }, label: string): Promise<void>;
  updateProjectSettings(patch: Partial<ProjectSettingsT>): Promise<void>;
  upload(files: readonly File[]): Promise<AssetDto[]>;
  setBadge(assetId: string, badge: number | null): Promise<void>;
  /** FR-049: without `opts`, Clips go after the selected Clip (else at the end); FR-029 `asOverlay` + `atMs` places images on the overlay. */
  insert(assetIds: string[], opts?: { asOverlay?: boolean; atMs?: number; atIndex?: number }): Promise<void>;
  /** FR-048: Locate a missing asset's file (Shell picker → R-036, re-link by hash). */
  locateAsset(assetId: string): Promise<void>;
  /** FR-037: hold a pick whose preset needs a model that is not installed (EM-2104); it runs when `model.installed` arrives. */
  holdPick(presetId: string, modelKey: string): void;
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
/** FR-053: import-level errors go to the Asset Panel banner (`lib.assets.error`), per-file errors stay on the card. */
export const IMPORT_LEVEL = new Set(['EM-6401', 'EM-6005', 'EM-1401', 'EM-1010']);
export const importError = (code: string): void => { window.dispatchEvent(new CustomEvent('em:import-error', { detail: { code } })); };
const PRESET_CATEGORY_TO_INTENT: Record<string, IntentCategory> = {
  transition: 'transition', caption: 'caption', background: 'background', motion: 'motion', shape: 'shape', easing: 'easing', effect: 'effect', audio: 'audio',
  text: 'text', texteffect: 'text', font: 'text', palette: 'layout', fontpair: 'layout',
};

export function StoreProvider({ runtime, children, initialPrefs }: { runtime: Runtime; children: ReactNode; initialPrefs?: Partial<Prefs> }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const heldPicks = useRef(new Map<string, string>());   // FR-037: presetId → model key, held with EM-2104
  const dispatch = useCallback((a: Action) => rawDispatch(a), []);
  const prefsRef = useRef<Prefs>({ ...loadPrefs(), ...(initialPrefs ?? {}) });
  const [prefsVersion, forcePrefs] = useReducer((x: number) => x + 1, 0);
  const setPrefs = useCallback((p: Partial<Prefs>) => { prefsRef.current = { ...prefsRef.current, ...p }; savePrefs(prefsRef.current); forcePrefs(); }, []);
  const api = runtime.api;
  const lang: Lang = state.settings?.uiLanguage ?? 'en';
  const t = useCallback((k: string, v?: Record<string, string | number>) => translate(lang, k, v), [lang]);
  const pid = () => stateRef.current.project?.id ?? null;
  const headHash = () => stateRef.current.head?.hash ?? stateRef.current.project?.headHash ?? '';

  const actions = useMemo<Actions>(() => {
    const toast: Actions['toast'] = (kind, textKey, vars, opts = {}) => dispatch({ type: 'toast', toast: { kind, textKey, ...(vars ? { vars } : {}), ...(opts.code ? { code: opts.code } : {}), ...(opts.action ? { action: opts.action } : {}), sticky: opts.sticky ?? (kind === 'danger' || kind === 'warn') } });
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
    const openSampleProject = async (language: Lang): Promise<string | null> => {
      try {
        const p = await api.createSampleProject({ language });
        if (pid() !== p.id) await openProject(p.id);
        return p.id;
      } catch (e) { error(e); return null; }
    };
    const createIntent = async (body: Omit<DesignPickInput, 'baseVersion' | 'selection' | 'playheadMs'>, label: string): Promise<IntentCreateResponse | null> => {
      const id = pid(); if (!id) { toast('info', 'err.EM-2202.title', undefined, { code: 'EM-2202' }); return null; }
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
        } else if (res.intent.needsInterpretation && res.intent.status !== 'rejected') {
          announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', 'ui.sys.live.queuedforagent', { label }));   // FR-026: queued for the Editor Agent
        }
        return res;
      } catch (e) {
        dispatch({ type: 'dropOptimistic', id: optimistic.id });
        if (e instanceof EmError && e.code === 'EM-2301') { await refreshHead(); }
        error(e);
        return null;
      }
    };
    const undo = async () => { const id = pid(); if (!id) return; try { await api.undo(id); await refreshHead(); } catch (e) { error(e); } };
    const redo = async () => { const id = pid(); if (!id) return; try { await api.redo(id); await refreshHead(); } catch (e) { error(e); } };
    const setScreen = (screen: Screen | null) => dispatch({ type: 'screen', screen });
    const self: Actions = {
      openProject, openSampleProject, refreshHead, reloadState, error, toast, announce, undo, redo, setScreen,
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
      // FR-020…FR-028: each Text Panel value is one deterministic field pick (Compile path, no provider call).
      async textPick(params) { for (const [field, value] of Object.entries(params)) await createIntent({ source: 'ui', category: 'text', field, value, target: { kind: 'selection' }, plan: 'auto' }, field); },
      async addText(text, variantId) {
        const before = new Set((stateRef.current.head?.model?.tracks.text ?? []).map((x) => x.id));
        const res = await createIntent({ source: 'ui', category: 'text', presetId: variantId, text, target: { kind: 'playhead' }, plan: 'auto' }, text);
        const pidNow = pid();
        if (!res?.appliedVersion || !pidNow) return null;
        const head = await api.getComposition(pidNow).catch(() => null);
        const added = (head?.head.model?.tracks.text ?? []).find((x) => !before.has(x.id));
        if (added) dispatch({ type: 'select', selection: [{ kind: 'text', id: added.id }] });
        return added?.id ?? null;
      },
      // FR-087/FR-089/FR-097: Output Settings are typed `output` picks (Compile path, visible + supersedable in the Intent Queue).
      async layoutPick(params) {
        const output = params.ratio ? { kind: 'ratio' as const, value: params.ratio, ...(params.customRatio ? { customRatio: params.customRatio } : {}) } : { kind: 'resolution' as const, value: params.resolution };
        await createIntent({ source: 'ui', category: 'layout', output, target: { kind: 'project' }, plan: 'auto' }, params.ratio === 'custom' && params.customRatio ? `${params.customRatio.w}:${params.customRatio.h}` : params.ratio ?? params.resolution ?? 'layout');
      },
      async clipEdit(edit, label) {
        await createIntent({ source: 'ui', category: 'asset', clipEdit: edit, target: { kind: 'clip', id: edit.clipId }, plan: 'auto' }, label);
      },
      // FR-088: Auto is `op:output.setAutoRatio` in the model (so it can be turned on again and Undo restores it).
      async setAutoRatio(on) {
        await createIntent({ source: 'ui', category: 'layout', output: { kind: 'autoRatio', value: on }, target: { kind: 'project' }, plan: 'auto' }, translate(stateRef.current.settings?.uiLanguage ?? 'en', on ? 'ui.agent.output.ratio.auto.on' : 'ui.agent.output.ratio.auto.off'));
      },
      async updateProjectSettings(patch) {
        const id = pid(), s = stateRef.current.head?.model?.settings; if (!id || !s) return;
        try { await api.putProjectSettings(id, { ...s, ...patch }); await refreshHead(); } catch (e) { error(e); }
      },
      async upload(files) {
        const id = pid(); if (!id || !files.length) return [];
        try {
          const paths = files.map((f) => (f as File & { path?: string }).path).filter((x): x is string => typeof x === 'string' && x.length > 0);
          const res = runtime.mode === 'live' && paths.length === files.length && window.expertmotion ? await api.importAssetPaths(id, paths) : await api.uploadAssets(id, files);
          dispatch({ type: 'assetsUpsert', assets: res.items });
          for (const n of res.notices) if (n.code) { if (IMPORT_LEVEL.has(n.code)) importError(n.code); else toast('info', `err.${n.code}.title`, undefined, { code: n.code }); }
          return res.items;
        } catch (e) { if (IMPORT_LEVEL.has(errCode(e))) importError(errCode(e)); else error(e); return []; }
      },
      async setBadge(assetId, badge) {
        const id = pid(); if (!id) return;
        try {
          const res = await api.setSequenceBadge(id, assetId, badge);
          dispatch({ type: 'assetsUpsert', assets: res.items });
          if (badge !== null && !stateRef.current.assetSelection.includes(assetId)) dispatch({ type: 'assetSelection', ids: [...stateRef.current.assetSelection, assetId] });
        } catch (e) { error(e); }
      },
      async insert(assetIds, opts) {
        const id = pid(); if (!id || !assetIds.length) return;
        const s0 = stateRef.current;
        const first = !(s0.head?.model?.tracks.video.length);
        // FR-049 / FR-030: "after the selected Clip" when one is selected, otherwise at the end of the Sequence.
        const selClip = s0.selection.find((x) => x.kind === 'clip');
        const selIdx = selClip ? (s0.head?.model?.tracks.video.findIndex((c) => c.id === selClip.id) ?? -1) : -1;
        const place = opts ?? (selIdx >= 0 ? { atIndex: selIdx + 1 } : {});
        try {
          await api.insertAssets(id, { assetIds, order: 'badge', ...place });
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
      async locateAsset(assetId) {
        const id = pid(), shell = window.expertmotion; if (!id) return;
        const a = stateRef.current.assets.find((x) => x.id === assetId);
        if (!shell?.pickFiles) { toast('info', 'ui.lib.assets.locate.unavailable'); return; }
        const ext = (a?.name.split('.').pop() ?? '').toLowerCase();
        const paths = await shell.pickFiles({ filters: [{ name: a?.name ?? '', extensions: ext ? [ext] : ['*'] }], multiple: false });
        if (!paths[0]) return;
        try {
          const dto = await api.relocateAsset(id, assetId, paths[0]);
          dispatch({ type: 'assetsUpsert', assets: [dto] });
          announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', 'ui.lib.assets.locate.done', { name: a?.name ?? '' }));
        } catch (e) { error(e); }
      },
      holdPick(presetId, modelKey) { heldPicks.current.set(presetId, modelKey); },
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
              const n = (c: string) => r.diff.filter((d) => d.change === c).length;   // FR-086 diff summary on the executed card
              dispatch({ type: 'plan', plan: { ...plan, status: 'executed', result: { ok: true, toVersion: r.toVersion ?? null, appliedOps: r.appliedOps, added: n('added'), removed: n('removed'), modified: n('modified') } } });
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
      async setPrivateMode(on) {
        try {
          const settings = await api.putSettings({ privateMode: on });
          dispatch({ type: 'settings', settings });
          // FR-160: intents that waited for an agent while Private Mode was on are planned automatically once it is off
          const s = stateRef.current;
          if (!on && settings.autoPlan !== false && !s.streaming.editor && s.plan?.status !== 'draft' && hasWaitingIntents(s)) await self.plan();
        } catch (e) { error(e); }
      },
      async setLanguage(l) { try { dispatch({ type: 'settings', settings: await api.putSettings({ uiLanguage: l }) }); } catch (e) { error(e); } },
      async putSettings(patch) { try { dispatch({ type: 'settings', settings: await api.putSettings(patch) }); } catch (e) { error(e); } },
      // FR-090 / FR-097: a profile pick is a zero-op `output` intent: recorded in the Intent Queue (visible, supersedable, restorable),
      // applied to Settings by the Service, never sent to a model. Undo restores the replaced pick (R-062) or re-picks the previous profile.
      async setProfile(p) {
        const prev = stateRef.current.performanceProfile;
        if (p === prev) return;
        const apply = (x: PerformanceProfile) => { dispatch({ type: 'performanceProfile', profile: x }); setPrefs({ draft: x !== 'turbo' }); };
        apply(p);
        const id = pid();
        if (!id) { try { dispatch({ type: 'settings', settings: await api.putSettings({ defaultPerformanceProfile: p }) }); } catch (e) { error(e); } return; }
        const L = stateRef.current.settings?.uiLanguage ?? 'en';
        const res = await createIntent({ source: 'ui', category: 'output', output: { kind: 'performanceProfile', value: p }, target: { kind: 'project' }, plan: 'auto' }, translate(L, `ui.agent.output.profile.${p}`));
        if (!res || res.intent.status !== 'executed') { apply(prev); return; }
        const replaced = res.superseded[0];
        const undoProfile = async () => {
          if (!replaced) { await self.setProfile(prev); return; }
          try { const r = await api.restoreIntent(id, replaced); dispatch({ type: 'queue', queue: r.queue }); apply(prev); } catch (e) { error(e); }
        };
        toast('success', 'ui.sys.toast.applieddirect', { label: translate(L, `ui.agent.output.profile.${p}`) }, { action: { labelKey: 'ui.sys.toast.undo', run: () => { void undoProfile(); } } });
      },
      // FR-095: the Project defaults (Settings ▸ default ratio / resolution), profile Standard, Auto off — one Composition Version.
      async resetOutput() {
        const id = pid(), s = stateRef.current.head?.model?.settings; if (!id || !s) return;
        const d = outputDefaults(stateRef.current);
        try {
          await api.putProjectSettings(id, { fps: s.fps, language: s.language, ratio: d.ratio, resolution: d.resolution, autoRatio: false });
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
      case 'model.installed': {
        // FR-037: picks held with EM-2104 resume once their model is installed.
        for (const [presetId, key] of [...heldPicks.current]) if (key === ev.data.model.key) { heldPicks.current.delete(presetId); void actions.pick(presetId); }
        break;
      }
      case 'plan.ready':
        if (ev.data.plan.status === 'valid' && ev.data.plan.origin === 'editor-agent') actions.announce(translate(L, 'ui.sys.live.planready', { goal: ev.data.plan.goal }));
        break;
      case 'settings.changed':                                       // FR-093: the Hardware Monitor re-detected; gating follows the new tier
        if (ev.data.scope === 'hardware') void runtime.api.hardwareProfile().then((hardware) => dispatch({ type: 'globals', hardware })).catch(() => undefined);
        if (ev.data.scope === 'providers') void actions.loadProviders();       // FR-071: the status dot follows connection changes
        break;
      case 'agent.run.failed': if (ev.data.code === 'EM-8202') actions.toast('info', 'err.EM-8202.title', undefined, { code: 'EM-8202' }); break;
      case 'service.notice':
        if (ev.data.kind === 'resync') void actions.reloadState();
        // FR-128: the Service sends EM-6402 once per session; the banner stays until dismissed and opens the Hardware Monitor.
        if (ev.data.kind === 'low-disk' || ev.data.kind === 'low-memory') actions.toast('warn', `err.${ev.data.code ?? 'EM-6402'}.title`, typeof ev.data['have'] === 'number' ? { have: ev.data['have'] } : undefined,
          { code: ev.data.code ?? 'EM-6402', sticky: true, action: { labelKey: 'ui.scr.hardware.open', run: () => { window.dispatchEvent(new CustomEvent(OPEN_HARDWARE_EVENT)); } } });
        if (ev.data.kind === 'restore' && ev.data.done && typeof ev.data.projectId === 'string') void actions.openProject(ev.data.projectId);
        // FR-048: media check on open / before render (missing originals; a changed file was re-ingested).
        if ((ev.data.kind === 'media-missing' || ev.data.kind === 'media-changed') && ev.data.projectId === stateRef.current.project?.id) {
          const id = stateRef.current.project?.id;
          if (id) void runtime.api.listAssets(id, { limit: 200 }).then((p) => dispatch({ type: 'assets', assets: p.items })).catch(() => undefined);
          const name = typeof ev.data['name'] === 'string' ? ev.data['name'] : String((ev.data['assetIds'] as unknown[] | undefined)?.length ?? '');
          actions.toast('warn', `err.${ev.data.kind === 'media-missing' ? 'EM-1301' : 'EM-1302'}.title`, { name }, { code: ev.data.kind === 'media-missing' ? 'EM-1301' : 'EM-1302' });
        }
        // R-025: the sample's clips, captions and palette are in; reload so assets, queue and head are complete for the tour.
        if (ev.data.kind === 'sample' && typeof ev.data['ready'] === 'boolean' && ev.data.projectId === stateRef.current.project?.id) {
          if (ev.data['ready'] === false) {
            const code = typeof ev.data.code === 'string' ? ev.data.code : null;
            const failed = Array.isArray(ev.data['failed']) ? (ev.data['failed'] as unknown[]).length : 0;
            actions.toast('danger', 'ui.sys.toast.sample.partial', { count: failed }, code ? { code } : {});
          }
          void actions.reloadState();
        }
        break;
      default: break;
    }
  }, [actions, dispatch, runtime]);

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
        // FR-129: EM-3402 (T0) and EM-8305 (< 8 GB RAM) once per install; the onboarding Hardware step shows them itself.
        const onboardingPending = !prefsRef.current.onboardingDone && settings.onboardingDone !== true;
        const fresh = (['EM-3402', 'EM-8305'] as const).filter((c) => hardware?.warnings.includes(c) && !prefsRef.current.nudgesDismissed.includes(`hw:${c}`));
        if (fresh.length) {
          if (!onboardingPending) for (const c of fresh) actions.toast('warn', `err.${c}.title`, { ram: Math.round((hardware?.ramTotalMb ?? 0) / 1024) }, { code: c });
          setPrefs({ nudgesDismissed: [...prefsRef.current.nudgesDismissed, ...fresh.map((c) => `hw:${c}`)] });
        }
        await actions.loadProviders();
        await actions.loadModels();
        const recent = await runtime.api.recentProjects().catch(() => ({ items: [] }));
        const target = recent.items[0]?.id ?? runtime.seededProjectId ?? (await runtime.api.listProjects({ limit: 1 }).catch(() => ({ items: [] }))).items[0]?.id;
        if (target) await actions.openProject(target);
        if (!cancelled) {
          dispatch({ type: 'boot', boot: 'ready' });
          // FR-004: the onboarding record lives server-side (settings.onboardingDone); prefs mirror it for older services and the mock.
          if (!prefsRef.current.onboardingDone && settings.onboardingDone !== true) dispatch({ type: 'screen', screen: { kind: 'onboarding' } });
        }
      } catch (e) {
        if (!cancelled) { dispatch({ type: 'boot', boot: 'no-service' }); actions.error(e); }
      }
    })();
    return () => { cancelled = true; };
  }, [runtime, actions, dispatch, setPrefs]);

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

  // prefsVersion: a setPrefs call must re-render consumers even when no Service state changed (Ctrl+B, panel sizes).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo<Store>(() => ({ state, dispatch, runtime, actions, prefs: prefsRef.current, setPrefs, t, lang }), [state, dispatch, runtime, actions, setPrefs, t, lang, prefsVersion]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** FR-095: the Project defaults Reset restores (Settings defaults; 9:16 · 1080p when unset). */
export function outputDefaults(s: AppState): { ratio: Ratio; resolution: Resolution } {
  const r = s.settings?.defaultRatio;
  return { ratio: r && r !== 'custom' ? r : '9:16', resolution: s.settings?.defaultResolution ?? '1080p' };
}

/** Output profile for the Export dialog from the current project settings. */
/** FR-160: queued intents that need the Editor Agent (they wait while Private Mode is on). */
export function hasWaitingIntents(s: Pick<AppState, 'queue'>): boolean {
  return (s.queue?.items ?? []).some((i) => i.status === 'queued' && i.needsInterpretation);
}

export function currentOutputProfile(s: AppState): OutputProfile {
  const st = s.head?.model?.settings ?? s.project?.settings;
  return { ratio: st?.ratio ?? '16:9', ...(st?.customRatio ? { customRatio: st.customRatio } : {}), resolution: st?.resolution ?? '1080p', fps: st?.fps ?? 30, format: 'mp4', codec: 'h264', crf: 18, alpha: false };
}
