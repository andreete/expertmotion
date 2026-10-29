// ServiceProvider + project state (BLUEPRINT.md §3.7 state/service.tsx, state/project.tsx in one provider): owns the
// reducer, the SSE subscription, the follow-up REST calls that events require, and the Creator-facing actions.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { EmError } from '@expertmotion/shared';
import type { ElementRefT, ProjectSettingsT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import { createEventStream, type EventStream } from '../api/events.js';
import type {
  AgentKind, AssetDto, ChatTarget, IntentCreateResponse, DesignPickInput, EditIntent, ElementEdit, ItemsEdit, SplitEdit, TransformEdit, IntentCategory, MessageDto, OutputProfile, PerformanceProfile, PlanDto, ProjectCreateInput, ProjectUiState, ProviderKind, Ratio, RenderCreateInput,
  Resolution, ServiceEvent, SettingsDto,
} from '../api/types.js';
import { initialState, PENDING_RUN, reducer, safeMessage, type Action, type AppState, type Screen, type ToastKind, type LibMode } from './reducer.js';
import type { Runtime } from './runtime.js';
import { loadPrefs, savePrefs, type Prefs } from '../prefs.js';
/** Window event that opens the Hardware Monitor popover (Header listens; FR-128 low-disk banner action). */
export const OPEN_HARDWARE_EVENT = 'expertmotion:open-hardware';
import { translate, type Lang } from '../i18n/index.js';
import { localModelByRef, localModelName } from './model-names.js';
import { normalizeKey } from './key-retry.js';
import { itemsCategory } from '../stage/items.js';
import { DESTRUCTIVE_OPS, destructiveItems, removalLabel } from '../agent/plan-preview.js';
import { bootDecision, isBlocked, loadGuard, noteProjectClosed, noteProjectOpening } from '../startup/session-guard.js';
import { clearScratch, isUntouched, loadScratch, promoteIfTouched, saveScratch } from '../startup/scratch.js';

export interface Actions {
  openProject(id: string): Promise<void>;
  /** R-025: create (or reuse) the tour's sample project and open it; resolves with its id, or null on error. */
  openSampleProject(language: Lang): Promise<string | null>;
  createProject(input: ProjectCreateInput): Promise<string | null>;
  /** QA #5 / FR-009: File ▸ New Project (Ctrl+N): a Project with the default settings, opened at once; resolves with its id. */
  newProject(): Promise<string | null>;
  /** FR-260: the empty project a launch / Close lands in — the untouched blank project of the last launch, else a new one (quiet). */
  openBlankProject(): Promise<string | null>;
  /** FR-260: File ▸ Close project — the open project closes and an empty project opens (the unsaved prompt runs first, by the caller). */
  closeProject(): Promise<void>;
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
  /** ADR-027: one Timeline gesture or layer key on a text, image, shape or audio layer = one Compile pick (undoable). */
  elementEdit(edit: ElementEdit, label: string): Promise<void>;
  /** ADR-028: one undoable pick per scissors press / S (all listed items in one Composition Version) and per Player gesture / Inspector field. */
  splitEdit(edit: SplitEdit, label: string): Promise<void>;
  transformEdit(edit: TransformEdit, label: string): Promise<void>;
  /** ADR-031 / FR-192 / FR-193: Delete or Duplicate Timeline items as ONE pick (one version, one Undo); resolves true when applied. */
  itemsEdit(edit: ItemsEdit, label: string): Promise<boolean>;
  updateProjectSettings(patch: Partial<ProjectSettingsT>): Promise<void>;
  upload(files: readonly File[]): Promise<AssetDto[]>;
  /** FR-014 / FR-041: packaged path import (picker or drag-and-drop): the cards appear at once (ingesting / failed) and follow ingest. */
  importPaths(paths: string[], origin?: 'picker' | 'drop'): Promise<AssetDto[]>;
  setBadge(assetId: string, badge: number | null): Promise<void>;
  /** FR-049: without `opts`, Clips go after the selected Clip (else at the end); FR-029 `asOverlay` + `atMs` places images on the overlay. */
  insert(assetIds: string[], opts?: { asOverlay?: boolean; atMs?: number; atIndex?: number }): Promise<void>;
  /** FR-048: Locate a missing asset's file (Shell picker → R-036, re-link by hash). */
  locateAsset(assetId: string): Promise<void>;
  removeAsset(assetId: string, confirm?: boolean): Promise<void>;
  setAssetSelection(ids: string[]): void;
  captionsFromAsset(assetId: string): Promise<void>;
  restoreIntent(id: string): Promise<void>;
  removeIntent(id: string): Promise<void>;
  clearIntents(): Promise<void>;
  plan(message?: string): Promise<void>;
  /** Review U1: Re-plan / Run again of the plan on the card — the same picks and message on the current head (not the whole queue). */
  replan(): Promise<void>;
  /** `confirmed`: the Creator confirmed the removals the plan makes (EM-4310 inline confirmation, QA 2026-10-28 #17). */
  execute(confirmed?: boolean): Promise<void>;
  cancelPlan(): Promise<void>;
  /** FR-214 / review U2: Stop of the agent's current run — also while the send is in flight (the run is cancelled once its id is known). */
  stopRun(agent: AgentKind): Promise<void>;
  setNotes(notes: string): Promise<void>;
  /** FR-067 / FR-080: the Editor message carries the inspector target (if any), the selection and the playhead. */
  send(agent: AgentKind, text: string, attachments?: string[], target?: ElementRefT | null, targets?: ChatTarget[], documents?: string[]): Promise<boolean>;
  /** FR-219: "Kirim ke Editor" — hand a Brainstorm draft to the Editor (its own run with progress; the Plan Card previews it). */
  sendDraftToEditor(message: MessageDto): Promise<boolean>;
  /** FR-217: import an openly licensed picture from a research answer into the Library. */
  importResearchImage(message: MessageDto, source: 'openverse' | 'wikimedia', id: string): Promise<string | null>;
  /** QA 2026-10-26 #6: point the assistant at an asset or Timeline element (chip in the composer, composer focused). */
  pointAt(target: ChatTarget, mode?: AgentKind): void;
  setChatTargets(targets: ChatTarget[]): void;
  /** R-082: hands proposed intents to the Intent Queue; resolves true when the Service accepted the hand-off. */
  /** `opts.plan` (review U10): plan exactly the picks this hand-off queued — nothing when none was accepted, never the whole queue. */
  handoff(message: MessageDto, intentIds: string[], opts?: { plan?: boolean }): Promise<boolean>;
  dismissHandoff(message: MessageDto): void;
  /** Closes the removal confirmation of the current plan (nothing is executed). */
  dismissRemoval(): void;
  stopStreaming(agent: AgentKind): void;
  setPrivateMode(on: boolean): Promise<void>;
  setLanguage(lang: Lang): Promise<void>;
  setProfile(p: PerformanceProfile): Promise<void>;
  putSettings(patch: Partial<SettingsDto>): Promise<void>;
  resetOutput(): Promise<void>;
  startRender(input: Omit<RenderCreateInput, 'projectId'>): Promise<string | null>;
  cancelRender(jobId: string): Promise<void>;
  loadProviders(): Promise<void>;
  addConnection(provider: ProviderKind, secret: string, label: string, opts?: { onError?: (e: EmError) => void }): Promise<boolean>;
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

/** The store when rendered inside StoreProvider, else null (shared components such as Modal used in isolated tests). */
export function useStoreOptional(): Store | null { return useContext(StoreContext); }

export const errCode = (e: unknown): string => (e instanceof EmError ? e.code : 'EM-9001');
/** FR-053: import-level errors go to the Asset Panel banner (`lib.assets.error`), per-file errors stay on the card. */
export const IMPORT_LEVEL = new Set(['EM-6401', 'EM-6005', 'EM-1401', 'EM-1010']);
export const importError = (code: string): void => { window.dispatchEvent(new CustomEvent('em:import-error', { detail: { code } })); };
/** FR-041 "Show it" (EM-1006): scrolls to the existing Asset card and focuses it. */
export const focusAssetCard = (assetId: string): void => {
  const el = document.querySelector<HTMLElement>(`[data-el="lib.assets.card"][data-asset-id="${assetId}"]`);
  el?.scrollIntoView?.({ block: 'nearest' }); el?.focus();
};
/** FR-012: the per-project UI state Save writes (R-014 `uiState`). */
export const uiStateOf = (s: Pick<AppState, 'libMode' | 'playheadMs' | 'selection' | 'assetSelection'>): ProjectUiState => ({
  libMode: s.libMode, playheadMs: Math.max(0, Math.round(s.playheadMs)), selection: s.selection.slice(0, 50), assetSelection: s.assetSelection.slice(0, 200),
});
const PRESET_CATEGORY_TO_INTENT: Record<string, IntentCategory> = {
  transition: 'transition', caption: 'caption', background: 'background', motion: 'motion', shape: 'shape', easing: 'easing', effect: 'effect', audio: 'audio',
  text: 'text', texteffect: 'text', font: 'text', palette: 'layout', fontpair: 'layout',
};

export function StoreProvider({ runtime, children, initialPrefs }: { runtime: Runtime; children: ReactNode; initialPrefs?: Partial<Prefs> }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  const providersLoad = useRef<{ running: Promise<void> | null; again: boolean }>({ running: null, again: false });
  const modelsInFlight = useRef(new Set<string>());
  /** Review U2: Stop pressed while the send is still in flight (run id unknown): the run is cancelled as soon as the 202 names it. */
  const stopAsked = useRef<Record<AgentKind, boolean>>({ brainstorm: false, editor: false });
  stateRef.current = state;
  const dispatch = useCallback((a: Action) => { if (a.type === 'projectClosed') noteProjectClosed(); rawDispatch(a); }, []);
  const prefsRef = useRef<Prefs>({ ...loadPrefs(), ...(initialPrefs ?? {}) });
  const [prefsVersion, forcePrefs] = useReducer((x: number) => x + 1, 0);
  const setPrefs = useCallback((p: Partial<Prefs>) => { prefsRef.current = { ...prefsRef.current, ...p }; savePrefs(prefsRef.current); forcePrefs(); }, []);
  const api = runtime.api;
  const lang: Lang = state.settings?.uiLanguage ?? 'en';
  const t = useCallback((k: string, v?: Record<string, string | number>) => translate(lang, k, v), [lang]);
  const pid = () => stateRef.current.project?.id ?? null;
  const headHash = () => stateRef.current.head?.hash ?? stateRef.current.project?.headHash ?? '';

  const actions = useMemo<Actions>(() => {
    const announce = (text: string) => dispatch({ type: 'announce', text });
    const toast: Actions['toast'] = (kind, textKey, vars, opts = {}) => {
      dispatch({ type: 'toast', toast: { kind, textKey, ...(vars ? { vars } : {}), ...(opts.code ? { code: opts.code } : {}), ...(opts.action ? { action: opts.action } : {}), sticky: opts.sticky ?? (kind === 'danger' && opts.action !== undefined) } });   // QA UX round 1: non-blocking warn / error toasts auto-dismiss
      // FR-154: every toast is announced through the shared hidden live region sys.live (the toast itself is not a live region)
      const L = stateRef.current.settings?.uiLanguage ?? 'en';
      announce(`${translate(L, textKey, vars)}${opts.code ? ` · ${opts.code}` : ''}`);
    };
    const error = (err: unknown) => {
      const code = errCode(err);
      if (code === 'EM-8001' && stateRef.current.stream === 'offline') return;     // sys.offline suppresses other error toasts (§10)
      if (code === 'EM-5010') {                                                     // licence gone (revoked / removed): the licence screen takes over
        void api.getLicense().then((licence) => dispatch({ type: 'licence', licence })).catch(() => undefined);
        return;
      }
      if (code === 'EM-4201') {                                                     // FR-117 / AI-016: Change budget → the budget field
        const d = (err instanceof EmError ? err.details : undefined) as { scope?: string; connectionId?: string } | undefined;
        const focus = { field: d?.scope === 'month' ? 'month' as const : 'project' as const, ...(d?.connectionId ? { connectionId: d.connectionId } : {}) };
        toast('danger', 'err.EM-4201.title', undefined, { code, action: { labelKey: 'err.EM-4201.action', run: () => dispatch({ type: 'screen', screen: { kind: 'providers', focus } }) } });
        return;
      }
      toast(code.startsWith('EM-5') || code === 'EM-4401' || code === 'EM-4007' || code === 'EM-2403' || code === 'EM-9004' || code === 'EM-7001' ? 'info' : 'danger', `err.${code}.title`, undefined, { code });
    };
    const refreshHead = async () => {
      const id = pid(); if (!id) return;
      try { const c = await api.getComposition(id); if (pid() === id) dispatch({ type: 'head', head: c.head, canUndo: c.canUndo, canRedo: c.canRedo }); } catch (e) { error(e); }
    };
    // FR-260: leaving the untouched blank project (another project opens) deletes it, so an empty project never piles up.
    const discardBlank = (leaving: string | null, next: string, was: { project: AppState['project']; assets: number; msgs: number }) => {
      const s = loadScratch();
      if (!leaving || leaving === next || s?.projectId !== leaving) return;
      const p = was.project;
      if (!p || p.id !== leaving || !isUntouched(p, s) || was.msgs > 0 || was.assets > 0) { clearScratch(); return; }
      clearScratch();
      void api.deleteProject(leaving, { permanent: true }).catch(() => undefined);
    };
    const openProject = async (id: string, keepView = false) => {
      try {
        if (!keepView) noteProjectOpening(id);                                 // FR-202: crash-loop guard + Reload reopens it
        const leaving = keepView ? null : pid();
        const leavingState = leaving ? { project: stateRef.current.project, assets: stateRef.current.assets.length, msgs: stateRef.current.messages.brainstorm.length + stateRef.current.messages.editor.length } : null;
        const open = await api.openProject(id);
        const [assets, brainstorm, editor] = await Promise.all([
          api.listAssets(id, { limit: 200 }).then((p) => p.items),
          api.getConversation(id, 'brainstorm').catch(() => null),
          api.getConversation(id, 'editor').catch(() => null),
        ]);
        dispatch({ type: 'projectOpened', open, assets, messages: { brainstorm: brainstorm?.messages.items ?? [], editor: editor?.messages.items ?? [] }, contextUsage: { brainstorm: brainstorm?.contextUsage ?? null, editor: editor?.contextUsage ?? null }, keepView });
        if (leavingState) discardBlank(leaving, id, leavingState);
        if (!open.head.model) await refreshHead();
        api.listOutputs(id).then((o) => dispatch({ type: 'outputs', outputs: o.items })).catch(() => undefined);
        if (open.checkpointNewerThanSave) dispatch({ type: 'screen', screen: { kind: 'project.recover' } });
      } catch (e) { error(e); }
    };
    const reloadState = async () => { const id = pid(); if (id) await openProject(id, true); };   // FR-171: keeps selection and playhead
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
        if (res.intent.status === 'held') {
          // FR-037: the Service holds the pick (EM-2104) until the model is installed; it then applies by itself (model.installed).
          const flag = String(res.intent.params?.['__heldFor'] ?? '');
          const model = flag.startsWith('model:') ? flag.slice(6) : '';
          toast('warn', 'err.EM-2104.title', undefined, { code: 'EM-2104', action: { labelKey: 'err.EM-2104.action', run: () => setScreen({ kind: 'models', ...(model ? { focus: model } : {}) }) } });
          const L = stateRef.current.settings?.uiLanguage ?? 'en';
          const row = model ? localModelByRef(stateRef.current.models, model) : undefined;
          announce(translate(L, 'ui.lib.catalogue.model.held', { model: row ? localModelName(row, L) : model }));
        }
        if (res.appliedVersion) {
          await refreshHead();
          toast('success', 'ui.sys.toast.changed', { label }, { action: { labelKey: 'ui.sys.toast.undo', run: () => { void undo(); } } });
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
    // FR-167: Undo/Redo refresh the Intent Queue too, so applied items show "undone" (and back after Redo).
    const refreshQueue = async (id: string) => { try { const queue = await api.listIntents(id); if (pid() === id) dispatch({ type: 'queue', queue }); } catch { /* the next event refreshes it */ } };
    // FR-052: Undo/Redo can bring a removed asset back (its Clips return with the version), so the Asset Panel is re-read too.
    const refreshAssets = async (id: string) => { try { const p = await api.listAssets(id, { limit: 200 }); if (pid() === id) dispatch({ type: 'assets', assets: p.items }); } catch { /* the next event refreshes it */ } };
    const undo = async () => { const id = pid(); if (!id) return; try { await api.undo(id); await refreshHead(); await refreshQueue(id); await refreshAssets(id); } catch (e) { error(e); } };
    const redo = async () => { const id = pid(); if (!id) return; try { await api.redo(id); await refreshHead(); await refreshQueue(id); await refreshAssets(id); } catch (e) { error(e); } };
    /** FR-041 / FR-050 / FR-053: import notices — import-level codes go to the banner, EM-1006 is a toast that can show the existing card,
     *  per-file errors stay on their failed card; anything else is a toast. */
    const importNotices = (notices: ReadonlyArray<{ code: string; assetId?: string; name?: string }>, items: readonly AssetDto[]) => {
      for (const n of notices) {
        if (!n.code) continue;
        if (IMPORT_LEVEL.has(n.code)) { importError(n.code); continue; }
        if (n.code === 'EM-1006') { duplicateToast(n.assetId, n.name); continue; }
        if (n.assetId && items.some((i) => i.id === n.assetId && i.status === 'failed')) continue;
        toast('info', `err.${n.code}.title`, undefined, { code: n.code });
      }
    };
    const duplicateToast = (existingId: string | undefined, name?: string) => {
      const existing = existingId ? stateRef.current.assets.find((a) => a.id === existingId) : undefined;
      toast('info', 'err.EM-1006.title', { name: existing?.name ?? name ?? '' }, { code: 'EM-1006', ...(existingId ? { action: { labelKey: 'err.EM-1006.action', run: () => focusAssetCard(existingId) } } : {}) });
    };
    const setScreen = (screen: Screen | null) => dispatch({ type: 'screen', screen });
    /** A Stop the Service could not apply is said (the run may still be working); "already finished" (EM-9003) is not an error. */
    const stopFailed = (e: unknown) => { if (errCode(e) !== 'EM-9003') error(e); };
    /** Review U2: Stop was pressed before the send answered: cancel the run it started now; true = do not show it as running. */
    const stoppedEarly = (agent: AgentKind, runId: string): boolean => {
      if (!stopAsked.current[agent]) return false;
      stopAsked.current[agent] = false;
      dispatch({ type: 'streamingStop', agent, runId });
      void api.cancelAgentRun(runId).catch(() => undefined);
      return true;
    };
    /** FR-195: a stale plan is never executed; "Timeline berubah — rencana disusun ulang" and a fresh plan on the current head. */
    const replanStale = async (plan: PlanDto) => {
      dispatch({ type: 'plan', plan: { ...plan, status: 'stale' } });
      toast('info', 'ui.agent.plan.stale.replanning');
      const id = pid(); if (!id) return;
      try {
        const c = await api.getComposition(id);                        // plan on the head the Creator sees now (not a cached hash)
        if (pid() !== id) return;
        dispatch({ type: 'head', head: c.head, canUndo: c.canUndo, canRedo: c.canRedo });
        // Review U1: the same request again — the stale plan's own picks and the Creator's message, never the whole queue.
        const res = await api.createPlan(id, { baseVersion: c.head.hash, ...replanRequest(plan, stateRef.current.queue) });
        dispatch({ type: 'plan', plan: 'plan' in res ? res.plan : res });
      } catch (e) { error(e); }
    };
    const createBlank = async (quiet: boolean): Promise<string | null> => {
      // Default settings (FR-009): Settings defaults or 30 fps · 9:16 · 1080p, fit-content, default output folder. The name is
      // "Untitled" ("Tanpa judul"), then "Untitled 2", … while a Project with that name exists (EM-6103, unique per data dir).
      // FR-260: every such project is the blank project until its first edit (reused by the next launch, hidden from Recent).
      const s = stateRef.current;
      const base = translate(s.settings?.uiLanguage ?? 'en', 'ui.hdr.title.untitled');
      const { ratio, resolution } = outputDefaults(s);
      for (let n = 1; n <= 99; n++) {
        try {
          const p = await api.createProject({ name: n === 1 ? base : `${base} ${n}`, settings: { fps: s.settings?.defaultFps ?? 30, ratio, resolution, autoRatio: false } });
          const leaving = pid();
          const prev = loadScratch();
          saveScratch(p);
          // the previous blank project (untouched) is not needed any more: deleted once the new one is open
          const dropPrev = !!leaving && prev?.projectId === leaving && !!stateRef.current.project && isUntouched(stateRef.current.project, prev) && stateRef.current.assets.length === 0
            && stateRef.current.messages.brainstorm.length + stateRef.current.messages.editor.length === 0;
          await openProject(p.id);
          if (dropPrev && leaving) void api.deleteProject(leaving, { permanent: true }).catch(() => undefined);
          if (!quiet) toast('info', 'ui.sys.toast.project.created', { name: p.name });
          return p.id;
        } catch (e) { if (errCode(e) === 'EM-6103') continue; error(e); return null; }
      }
      return null;
    };
    const self: Actions = {
      openProject, openSampleProject, refreshHead, reloadState, error, toast, announce, undo, redo, setScreen,
      async createProject(input) {
        try { const p = await api.createProject(input); await openProject(p.id); return p.id; } catch (e) { error(e); return null; }
      },
      async newProject() { return createBlank(false); },
      async openBlankProject() {
        // FR-260: reuse the blank project of the last launch while it is untouched (and did not crash-loop), else make a new one.
        const s = loadScratch();
        if (s) {
          try {
            const p = await api.getProject(s.projectId);
            const [b, e] = await Promise.all([api.getConversation(p.id, 'brainstorm').catch(() => null), api.getConversation(p.id, 'editor').catch(() => null)]);
            const msgs = (b?.messages.items.length ?? 0) + (e?.messages.items.length ?? 0);
            if (isUntouched(p, s) && msgs === 0 && !isBlocked(loadGuard(), p.id)) { await openProject(p.id); return p.id; }   // (stateRef updates on the next render)
            else if (isUntouched(p, s) && msgs === 0) { clearScratch(); await api.deleteProject(p.id, { permanent: true }).catch(() => undefined); }
            else clearScratch();                                                 // edited (e.g. in another window): an ordinary project now
          } catch { clearScratch(); }                                            // deleted meanwhile
        }
        return createBlank(true);
      },
      async closeProject() {
        // FR-260: like other video editors, closing leaves an empty project open (not the Start screen). An untouched blank project
        // stays as it is (closing it again would only make another one).
        const cur = stateRef.current.project;
        if (cur && loadScratch()?.projectId === cur.id && isUntouched(cur, loadScratch())) return;
        await createBlank(true);
      },
      async renameProject(name) {
        const id = pid(); if (!id) return false;
        try {
          const p = await api.patchProject(id, { name });
          dispatch({ type: 'project', project: { ...p, dirty: true } });             // FR-173: a rename is unsaved UI-level state
          // FR-165: autosave clears it within 10 s; adopt the Service's answer then (Save clears it at once).
          const wait = 11_000;                                                   // FR-165 autosave window (10 s) + margin
          setTimeout(() => { if (pid() !== id || !stateRef.current.project?.dirty) return; void api.getProject(id).then((fresh) => { const cur = stateRef.current.project; if (cur && cur.id === id && !fresh.dirty) dispatch({ type: 'project', project: { ...cur, dirty: false } }); }).catch(() => undefined); }, wait);
          return true;
        } catch (e) { error(e); return false; }
      },
      async save() {
        const id = pid(); if (!id) return;
        // FR-012: Save also stores the UI state of this project (Library mode, playhead, selection) on its row.
        try { await api.patchProject(id, { uiState: uiStateOf(stateRef.current) }); await api.createCheckpoint(id); const p = stateRef.current.project; if (p) dispatch({ type: 'project', project: { ...p, dirty: false } }); toast('info', 'ui.sys.toast.saved'); } catch (e) { error(e); }
      },
      async pick(presetId, opts = {}) {
        const p = getPreset(presetId);
        if (!p) return;
        await createIntent({ source: 'ui', category: PRESET_CATEGORY_TO_INTENT[p.category] ?? 'effect', presetId, params: opts.params ?? {}, target: opts.target ?? { kind: 'selection' }, plan: 'auto' }, p.label[stateRef.current.settings?.uiLanguage ?? 'en']);
      },
      // FR-020…FR-028: each Text Panel value is one deterministic field pick (Compile path, no provider call).
      // QA UX round 1: the toast names what changed in plain words ("Changed: Text"), never the raw field id ("content").
      async textPick(params) { for (const [field, value] of Object.entries(params)) await createIntent({ source: 'ui', category: 'text', field, value, target: { kind: 'selection' }, plan: 'auto' }, translate(stateRef.current.settings?.uiLanguage ?? 'en', `ui.agent.param.${field}`)); },
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
      async elementEdit(edit, label) {
        const category = edit.kind === 'audio' ? 'audio' : edit.kind === 'text' ? 'text' : edit.kind === 'shape' ? 'shape' : 'asset';
        await createIntent({ source: 'ui', category, elementEdit: edit, target: { kind: edit.kind, id: edit.id }, plan: 'auto' }, label);
      },
      async splitEdit(edit, label) {
        const kinds = [...new Set(edit.items.map((x) => x.kind))];
        const category = kinds.length === 1 ? (kinds[0] === 'audio' ? 'audio' : kinds[0] === 'text' ? 'text' : kinds[0] === 'shape' ? 'shape' : 'asset') : 'asset';
        const first = edit.items[0];
        await createIntent({ source: 'ui', category, splitEdit: edit, target: first ? { kind: first.kind, id: first.id } : { kind: 'playhead' }, plan: 'auto' }, label);
      },
      async transformEdit(edit, label) {
        await createIntent({ source: 'ui', category: edit.kind === 'shape' ? 'shape' : 'asset', transformEdit: edit, target: { kind: edit.kind, id: edit.id }, plan: 'auto' }, label);
      },
      async itemsEdit(edit, label) {
        const first = edit.items[0];
        if (edit.action === 'paste') {                                    // FR-256: Paste at the playhead (no item is selected for it)
          if (!edit.paste?.entries.length) return false;
          const res = await createIntent({ source: 'ui', category: 'asset', itemsEdit: edit, target: { kind: 'playhead' }, plan: 'auto' }, label);
          return Boolean(res?.appliedVersion);
        }
        if (!first) return false;
        const res = await createIntent({ source: 'ui', category: itemsCategory(edit.items), itemsEdit: edit, target: { kind: first.kind, ...(first.id !== undefined ? { id: first.id } : {}), ...(first.index !== undefined ? { index: first.index } : {}) }, plan: 'auto' }, label);
        if (!res?.appliedVersion) return false;
        // FR-192: the deleted items leave the selection (and with it their chat chips; AssistantChat drops pointed chips whose element is gone).
        if (edit.action === 'remove') dispatch({ type: 'select', selection: [] });
        return true;
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
          importNotices(res.notices, res.items);
          return res.items;
        } catch (e) { if (IMPORT_LEVEL.has(errCode(e))) importError(errCode(e)); else error(e); return []; }
      },
      async importPaths(paths, origin) {
        const id = pid(); if (!id || !paths.length) return [];
        try {
          const res = await api.importAssetPaths(id, paths, true, origin);
          dispatch({ type: 'assetsUpsert', assets: res.items });              // the cards appear now; ingest.* events move them through the stages
          importNotices(res.notices, res.items);
          const n = res.items.filter((a) => a.status === 'ingesting').length;
          if (n) toast('info', 'ui.lib.assets.importing', { count: n });
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
          // FR-049: audio goes in at the playhead; the Service records the Insert in the Intent Queue ("Insert N clips", applied directly).
          await api.insertAssets(id, { assetIds, order: 'badge', ...place, playheadMs: Math.round(s0.playheadMs) });
          const assets = await api.listAssets(id, { limit: 200 });
          dispatch({ type: 'assets', assets: assets.items });
          dispatch({ type: 'assetSelection', ids: [] });
          await refreshHead();
          await refreshQueue(id);
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
      async replan() {
        const plan = stateRef.current.plan; if (!plan) { await self.plan(); return; }
        const id = pid(); if (!id) return;
        try {
          const res = await api.createPlan(id, { baseVersion: headHash(), ...replanRequest(plan, stateRef.current.queue) });
          dispatch({ type: 'plan', plan: 'plan' in res ? res.plan : res });
        } catch (e) { error(e); }
      },
      async execute(confirmed = false) {
        const plan = stateRef.current.plan;
        if (!plan) return;
        // FR-195 (collaboration safety): the Creator changed the Timeline after this plan was made. The Service would refuse it
        // (EM-2301, AI-013), so the Editor says so and plans again on the current head; the new plan needs its own Execute.
        const head = stateRef.current.head?.hash;
        if (plan.status === 'stale' || (plan.status === 'valid' && head !== undefined && plan.baseVersion !== head)) { await replanStale(plan); return; }
        if (plan.status !== 'valid') return;
        // QA 2026-10-28 #17: the plan now arrives with its ops (plan.ready), so removals are known before Execute; the Plan Card shows
        // them and asks inline. A plan whose ops were not loaded still gets EM-4310 from the Service, which opens the same question.
        const destructive = plan.steps.some((s) => s.ops.some((o) => DESTRUCTIVE_OPS.includes(o.op)));
        if (destructive && !confirmed) { dispatch({ type: 'plan', plan: { ...plan, confirmRemoval: destructiveItems(plan, stateRef.current) } }); return; }
        const run = async () => {
          dispatch({ type: 'plan', plan: { ...plan, status: 'executing', confirmRemoval: undefined } });
          try {
            const r = await api.executePlan(plan.id, { confirmDestructive: destructive || confirmed });
            if (r.ok) {
              const n = (c: string) => r.diff.filter((d) => d.change === c).length;   // FR-086 diff summary on the executed card
              dispatch({ type: 'plan', plan: { ...plan, status: 'executed', result: { ok: true, toVersion: r.toVersion ?? null, appliedOps: r.appliedOps, added: n('added'), removed: n('removed'), modified: n('modified'), addedIds: r.diff.filter((d) => d.change === 'added').map((d) => d.elementId).slice(0, 200), ...(r.toolSteps?.length ? { toolSteps: r.toolSteps } : {}) } } });
              await refreshHead();
              const v = (r.toVersion ?? '').slice(0, 6);
              toast('success', 'ui.sys.toast.applied', { count: r.appliedOps, version: v }, { action: { labelKey: 'ui.sys.toast.undo', run: () => { void undo(); } } });
              announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', 'ui.sys.live.applied', { version: v }));
            } else {
              dispatch({ type: 'plan', plan: { ...plan, status: 'failed', errorCode: r.error?.code ?? 'EM-2307' } });
            }
          } catch (e) {
            if (e instanceof EmError && e.code === 'EM-2301') { await replanStale(plan); return; }
            // FR-084: cancelled before the transaction started; the version is unchanged.
            if (e instanceof EmError && e.code === 'EM-4303') { dispatch({ type: 'plan', plan: { ...plan, status: 'cancelled' } }); toast('info', 'err.EM-4303.title', undefined, { code: 'EM-4303' }); return; }
            if (e instanceof EmError && e.code === 'EM-4310') {
              const items = ((e.details as { items?: Array<{ op: string; target?: { kind: string; id?: string; index?: number } }> } | undefined)?.items ?? []).map((x) => ({ op: x.op, label: removalLabel(x.op, x.target, stateRef.current) }));
              dispatch({ type: 'plan', plan: { ...plan, status: 'valid', confirmRemoval: items.length ? items : destructiveItems(plan, stateRef.current) } }); return;
            }
            dispatch({ type: 'plan', plan: { ...plan, status: 'valid' } });
            error(e);
          }
        };
        await run();
      },
      async sendDraftToEditor(message) {
        const id = pid(); if (!id) return false;
        // Review U3: the Editor is busy — say so (with Stop) instead of sending: an EM-4305 answer used to wipe the live run's progress.
        if (stateRef.current.streaming.editor) { toast('info', 'err.EM-4305.title', undefined, { code: 'EM-4305', action: { labelKey: 'err.EM-4305.action', run: () => { void self.stopRun('editor'); } } }); return false; }
        try {
          dispatch({ type: 'agentError', agent: 'editor', code: null });
          dispatch({ type: 'streamingStart', agent: 'editor', runId: PENDING_RUN, modelId: stateRef.current.assignments?.editor?.modelId ?? '' });
          stopAsked.current.editor = false;
          const res = await api.sendDraftToEditor(id, message.id, headHash());
          dispatch({ type: 'messageAdded', agent: 'editor', message: res.message });
          if (!stoppedEarly('editor', res.runId)) dispatch({ type: 'streamingStart', agent: 'editor', runId: res.runId, modelId: stateRef.current.assignments?.editor?.modelId ?? '' });
          dispatch({ type: 'messages', agent: 'brainstorm', messages: stateRef.current.messages.brainstorm.map((m) => (m.id === res.brainstormMessage.id ? safeMessage(res.brainstormMessage) : m)) });
          announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', 'ui.agent.handoff.sent'));
          return true;
        } catch (e) {
          const detail = e instanceof EmError ? { message: e.message, ...(e.details && typeof e.details === 'object' ? { details: e.details as Record<string, unknown> } : {}) } : null;
          dispatch({ type: 'agentError', agent: 'editor', code: errCode(e), detail });
          return false;
        }
      },
      async importResearchImage(message, source, imageId) {
        const id = pid(); if (!id) return null;
        try {
          const r = await api.importResearchImage(id, { messageId: message.id, source, id: imageId });
          for (const agent of ['brainstorm', 'editor'] as const) {
            if (!stateRef.current.messages[agent].some((m) => m.id === message.id)) continue;
            dispatch({ type: 'messages', agent, messages: stateRef.current.messages[agent].map((m) => (m.id === message.id ? { ...m, blocks: m.blocks.map((b) => (b.type === 'image_candidates' ? { ...b, items: b.items.map((x) => (x.source === source && x.id === imageId ? { ...x, importedAssetId: r.assetId } : x)) } : b)) } : m)) });
          }
          const assets = await api.listAssets(id, { limit: 200 }).catch(() => null);
          if (assets) dispatch({ type: 'assets', assets: assets.items });
          toast('success', 'ui.agent.research.image.imported', r.attribution ? { attribution: r.attribution } : { attribution: '' });
          return r.assetId;
        } catch (e) { error(e); return null; }
      },
      async cancelPlan() {
        const s = stateRef.current, plan = s.plan;
        try {
          const run = s.streaming.editor;
          // Review U2: Stop while the message is still being sent: the run has no id yet. Nothing else is touched (the plan on the card
          // belongs to an earlier run); the run is cancelled as soon as the Service names it (send / SSE).
          if (run?.runId === PENDING_RUN) { stopAsked.current.editor = true; dispatch({ type: 'streamingStop', agent: 'editor' }); return; }
          if (run) { await api.cancelAgentRun(run.runId).catch(stopFailed); dispatch({ type: 'streamingStop', agent: 'editor', runId: run.runId }); }
          const live = stateRef.current.plan;                                          // FR-084: may be `executing` by now
          // Review U2: a running chat only cancels its own plan (or a draft); an earlier valid plan on the card stays.
          const own = !run || !plan || plan.status === 'draft' || plan.status === 'executing' || (!!plan.agentRunId && plan.agentRunId === run.runId);
          if (own && plan && plan.status !== 'executed' && plan.status !== 'cancelled' && live?.status !== 'executed') { const p = await api.cancelPlan(plan.id); dispatch({ type: 'plan', plan: { ...plan, ...p, status: 'cancelled' } }); }
          dispatch({ type: 'agentError', agent: 'editor', code: null });
          const id = pid(); if (id) dispatch({ type: 'queue', queue: await api.listIntents(id) });
        } catch (e) { error(e); }
      },
      async stopRun(agent) {
        if (agent === 'editor') { await self.cancelPlan(); return; }
        const run = stateRef.current.streaming[agent]; if (!run) return;
        if (run.runId === PENDING_RUN) { stopAsked.current[agent] = true; dispatch({ type: 'streamingStop', agent }); return; }
        dispatch({ type: 'streamingStop', agent, runId: run.runId });
        await api.cancelAgentRun(run.runId).catch(stopFailed);
      },
      async setNotes(notes) {
        const plan = stateRef.current.plan; if (!plan) return;
        try { const p = await api.setPlanNotes(plan.id, notes); dispatch({ type: 'plan', plan: { ...plan, notes: p.notes ?? notes } }); } catch (e) { error(e); }
      },
      pointAt(target, mode) {
        const cur = stateRef.current.chatTargets;
        const k = (x: ChatTarget) => `${x.kind}:${x.id ?? `#${x.index ?? ''}`}`;
        if (!cur.some((x) => k(x) === k(target))) dispatch({ type: 'chatTargets', targets: [...cur, target].slice(0, 12) });
        window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: mode ? { agent: mode } : {} }));   // FR-194: "Ask Editor Agent" also switches to Edit
      },
      setChatTargets(targets) { dispatch({ type: 'chatTargets', targets }); },
      async send(agent, text, attachments = [], target = null, targets = [], documents = []) {
        const id = pid(); if (!id) return false;
        try {
          dispatch({ type: 'agentError', agent, code: null });
          // FR-214: the working state shows at once (no silent gap while the Service accepts the message or waits for an image).
          stopAsked.current[agent] = false;
          dispatch({ type: 'streamingStart', agent, runId: PENDING_RUN, modelId: stateRef.current.assignments?.[agent]?.modelId ?? '', ...(attachments.length ? { attaching: true } : {}) });
          const s0 = stateRef.current;
          const editorCtx = agent === 'editor' ? { ...(target ? { target } : {}), ...(s0.selection.length ? { selection: s0.selection.slice(0, 50) } : {}), playheadMs: Math.max(0, Math.round(s0.playheadMs)) } : {};
          const res = await api.sendMessage(id, agent, { text, attachments: attachments.map((assetId) => ({ assetId })), ...(documents.length ? { documents: documents.map((documentId) => ({ documentId })) } : {}), baseVersion: headHash(), ...editorCtx, ...(targets.length ? { targets: targets.slice(0, 12) } : {}) });
          dispatch({ type: 'messageAdded', agent, message: res.message });
          if (!stoppedEarly(agent, res.runId)) dispatch({ type: 'streamingStart', agent, runId: res.runId, modelId: stateRef.current.assignments?.[agent]?.modelId ?? '' });
          return true;
        } catch (e) {
          const detail = e instanceof EmError ? { message: e.message, ...(e.details && typeof e.details === 'object' ? { details: e.details as Record<string, unknown> } : {}) } : null;
          dispatch({ type: 'agentError', agent, code: errCode(e), detail });
          return false;
        }
      },
      async handoff(message, intentIds, opts = {}) {
        const id = pid(); if (!id) return false;
        try {
          const before = new Set((stateRef.current.queue?.items ?? []).map((i) => i.id));
          const res = await api.handoff(id, { messageId: message.id, intentIds, baseVersion: headHash() });
          // QA 2026-10-28 #3/#4: the Service answered with the queue as a bare array, which emptied "Your picks"; read the queue DTO.
          const queue = Array.isArray(res.queue) || !res.queue ? await api.listIntents(id) : res.queue;
          dispatch({ type: 'queue', queue });
          const msgs = stateRef.current.messages.brainstorm.map((m) => (m.id === message.id ? { ...m, blocks: m.blocks.map((b) => (b.type === 'proposed_intents' ? { ...b, handoffState: 'sent' as const } : b)) } : m));
          dispatch({ type: 'messages', agent: 'brainstorm', messages: msgs });
          await refreshHead();
          for (const r of res.rejected) toast('warn', `err.${r.code}.title`, undefined, { code: r.code });
          announce(translate(stateRef.current.settings?.uiLanguage ?? 'en', 'ui.agent.brainstorm.handoff.sent', { count: res.accepted.length }));
          if (opts.plan) {
            const fresh = queue.items.filter((i) => i.status === 'queued' && !before.has(i.id)).map((i) => i.id);
            if (!res.accepted.length || !fresh.length) return res.accepted.length > 0;
            const r = await api.createPlan(id, { baseVersion: headHash(), intentIds: fresh });
            dispatch({ type: 'plan', plan: 'plan' in r ? r.plan : r });
          }
          return true;
        } catch (e) { error(e); return false; }
      },
      dismissRemoval() { const p = stateRef.current.plan; if (p?.confirmRemoval) dispatch({ type: 'plan', plan: { ...p, confirmRemoval: undefined } }); },
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
        // FR-090: Turbo on a T1 machine works but may not be faster — EM-3106 once per install, with "Use Standard".
        if (p === 'turbo' && stateRef.current.hardware?.tier === 'T1' && !prefsRef.current.turboWarned) {
          setPrefs({ turboWarned: true });
          toast('warn', 'err.EM-3106.title', undefined, { code: 'EM-3106', action: { labelKey: 'ui.scr.export.fix.standard', run: () => { void self.setProfile('standard'); } } });
        }
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
        toast('success', 'ui.sys.toast.changed', { label: translate(L, `ui.agent.output.profile.${p}`) }, { action: { labelKey: 'ui.sys.toast.undo', run: () => { void undoProfile(); } } });
      },
      // FR-095: the Project defaults (Settings ▸ default ratio / resolution), profile Standard, Auto off — one Composition Version.
      async resetOutput() {
        const id = pid(), s = stateRef.current.head?.model?.settings; if (!id || !s) return;
        const d = outputDefaults(stateRef.current);
        // R-065: ratio + resolution + Auto off + profile Standard as one unit: every pick recorded in the Intent Queue (superseding
        // the previous one), one Composition Version, and one Undo of that version restores all of it (the profile moves with it).
        const project = { kind: 'project' as const };
        const picks: Array<Omit<DesignPickInput, 'baseVersion'>> = [
          { source: 'ui', category: 'layout', output: { kind: 'ratio', value: d.ratio }, target: project, plan: 'auto' },
          { source: 'ui', category: 'layout', output: { kind: 'resolution', value: d.resolution }, target: project, plan: 'auto' },
          ...(s.autoRatio ? [{ source: 'ui' as const, category: 'layout' as const, output: { kind: 'autoRatio' as const, value: false }, target: project, plan: 'auto' as const }] : []),
          { source: 'ui', category: 'output', output: { kind: 'performanceProfile', value: 'standard' }, target: project, plan: 'auto' },
        ];
        try {
          const res = await api.createIntentBatch(id, { baseVersion: headHash(), picks });
          dispatch({ type: 'queue', queue: res.queue });
          dispatch({ type: 'performanceProfile', profile: 'standard' }); setPrefs({ draft: true });
          await refreshHead();
          const L = stateRef.current.settings?.uiLanguage ?? 'en';
          toast('success', 'ui.sys.toast.changed', { label: translate(L, 'ui.agent.output.reset') }, res.appliedVersion ? { action: { labelKey: 'ui.sys.toast.undo', run: () => { void undo(); } } } : {});
        } catch (e) { if (e instanceof EmError && e.code === 'EM-2301') await refreshHead(); error(e); }
      },
      async startRender(input) {
        const id = pid(); if (!id) return null;
        // QA UX round 1: the 202 answer can arrive after the job's first SSE events (render.queued with EM-3107 + memoryWait, progress);
        // those are newer, so they are kept (the answer used to wipe the "waiting for free memory" line: "Starting…" for 127 s).
        try { const job = await api.createRender({ ...input, projectId: id }); const seen = stateRef.current.renders.find((j) => j.id === job.id); dispatch({ type: 'renders', renders: [seen && (job.status === 'queued' || job.status === 'rendering') ? seen : job, ...stateRef.current.renders.filter((j) => j.id !== job.id)] }); return job.id; } catch (e) { error(e); return null; }
      },
      async cancelRender(jobId) { try { const j = await api.cancelRender(jobId); dispatch({ type: 'renders', renders: stateRef.current.renders.map((x) => (x.id === j.id ? j : x)) }); } catch (e) { error(e); } },
      // Entry 28: one save fires several settings.changed {providers|assignments} events plus explicit reloads. Calls are coalesced:
      // at most one request pair in flight and one trailing reload after it (never a burst of parallel refetches).
      loadProviders() {
        const run = async (): Promise<void> => {
          try {
            const [c, a] = await Promise.all([api.listConnections(), api.getAssignments()]);
            const items = Array.isArray(c?.items) ? c.items : [];
            const assignments = a && typeof a === 'object' ? a : null;
            dispatch({ type: 'providers', connections: items, assignments });
            // Tier names ("Balanced") need the assigned connection's cached Capability Table (R-095 reads the cache, no provider call).
            // Assigned connections plus every connection whose cached table is still empty (an Add may have raced the model fetch).
            for (const cid of new Set([assignments?.brainstorm?.connectionId, assignments?.editor?.connectionId, ...items.map((x) => x.id)].filter((x): x is string => Boolean(x))))
              if (!stateRef.current.capabilities[cid]?.length && !modelsInFlight.current.has(cid)) {
                modelsInFlight.current.add(cid);
                void api.connectionModels(cid).then((r) => { if (Array.isArray(r?.items) && (r.items.length || stateRef.current.capabilities[cid] === undefined)) dispatch({ type: 'capabilities', connectionId: cid, rows: r.items }); })
                  .catch(() => undefined).finally(() => modelsInFlight.current.delete(cid));
              }
          } catch (e) { error(e); }
        };
        const q = providersLoad.current;
        if (q.running) { q.again = true; return q.running; }
        const loop = async (): Promise<void> => { do { q.again = false; await run(); } while (q.again); q.running = null; };
        q.running = loop();
        return q.running;
      },
      async addConnection(provider, secret, label, opts = {}) {
        try {
          const c = await api.addConnection({ provider, secret: normalizeKey(secret), label, validateNow: true });
          const models = await api.connectionModels(c.id).catch(() => ({ items: [] }));
          dispatch({ type: 'capabilities', connectionId: c.id, rows: models.items });
          await self.loadProviders();
          return c.status === 'valid';
        // QA UX round 1 (P1-6): a caller with onError shows the failure inline in its own form (the onboarding / Providers screen);
        // only callers without one get the toast.
        } catch (e) { if (e instanceof EmError && opts.onError) opts.onError(e); else error(e); await self.loadProviders(); return false; }
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
    // Review U2: the run a Stop-while-sending asked to cancel announced itself on the stream before the send answered: cancel it now.
    if (ev.name === 'agent.run.started' || ev.name === 'agent.run.delta' || ev.name === 'agent.run.progress') {
      const agent = ev.data.agent, runId = ev.name === 'agent.run.started' ? ev.data.run.id : ev.data.runId;
      if (stopAsked.current[agent] && !stateRef.current.streaming[agent]) {
        stopAsked.current[agent] = false;
        dispatch({ type: 'streamingStop', agent, runId });
        void runtime.api.cancelAgentRun(runId).catch(() => undefined);
        return;
      }
    }
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
      // FR-041: the same content was already in the project; the card is gone (reducer) and the toast can show the existing one.
      case 'ingest.failed':
        if (ev.data.code === 'EM-1006') {
          const existingId = ev.data.existingAssetId;
          const existing = existingId ? stateRef.current.assets.find((a) => a.id === existingId) : undefined;
          actions.toast('info', 'err.EM-1006.title', { name: existing?.name ?? ev.data.name }, { code: 'EM-1006', ...(existingId ? { action: { labelKey: 'err.EM-1006.action', run: () => focusAssetCard(existingId) } } : {}) });
        }
        break;
      // FR-037: held picks resume on the Service before it announces model.installed; intent.updated / composition.updated carry the result.
      case 'plan.ready':
        if (ev.data.plan.status === 'valid' && ev.data.plan.origin === 'editor-agent') actions.announce(translate(L, 'ui.sys.live.planready', { goal: ev.data.plan.goal }));
        break;
      case 'settings.changed':                                       // FR-093: the Hardware Monitor re-detected; gating follows the new tier
        if (ev.data.scope === 'hardware') void runtime.api.hardwareProfile().then((hardware) => dispatch({ type: 'globals', hardware })).catch(() => undefined);
        if (ev.data.scope === 'providers' || ev.data.scope === 'assignments') void actions.loadProviders();   // FR-071: the status dot follows connection / assignment changes (coalesced)
        break;
      case 'agent.run.failed': if (ev.data.code === 'EM-8202') actions.toast('info', 'err.EM-8202.title', undefined, { code: 'EM-8202' }); break;
      case 'service.notice':
        if (ev.data.kind === 'resync') void actions.reloadState();
        // FR-252: a plan voice step waits for its model — one click installs it, the Service continues the plan by itself afterwards
        if (ev.data.kind === 'plan-step' && ev.data['status'] === 'needs-model' && typeof ev.data['modelKey'] === 'string' && ev.data.projectId === stateRef.current.project?.id) {
          const key = ev.data['modelKey'];
          const m = stateRef.current.models.find((x) => x.key === key);
          actions.toast('warn', 'ui.sys.toast.planstep.needsmodel', { model: m?.displayName?.[stateRef.current.settings?.uiLanguage ?? 'en'] ?? m?.label ?? key }, { code: 'EM-7001', sticky: true,
            action: { labelKey: 'ui.sys.toast.planstep.install', run: () => { void runtime.api.installModel(key).then(() => actions.loadModels()).catch(actions.error); } } });
        }
        if (ev.data.kind === 'plan-step' && ev.data['status'] === 'resumed' && ev.data.projectId === stateRef.current.project?.id) actions.toast('info', 'ui.sys.toast.planstep.resumed');
        // FR-223: a failed generator step is never silent (the QA's voice-over failed with EM-7001 and nothing said so). Review U4: ONE
        // toast per failed step (was two), naming the step's own tool.
        if (ev.data.kind === 'plan-step' && ev.data['status'] === 'failed' && ev.data.projectId === stateRef.current.project?.id) {
          const code = typeof ev.data.code === 'string' ? ev.data.code : 'EM-7101';
          const tool = ev.data['tool'] === 'tts.generate' ? translate(L, 'ui.agent.plan.tool.tts.short') : ev.data['tool'] === 'captions.generate' ? translate(L, 'ui.agent.plan.tool.captions.short') : String(ev.data['tool'] ?? '');
          actions.toast('danger', 'ui.agent.plan.step.failed', { n: Number(ev.data['step'] ?? 0), tool, code }, { code, sticky: true });
        }
        if (ev.data.kind === 'plan-step' && ev.data['status'] === 'done') void actions.refreshHead();
        // FR-128: the Service sends EM-6402 once per session; the banner stays until dismissed and opens the Hardware Monitor.
        if (ev.data.kind === 'low-disk' || ev.data.kind === 'low-memory') actions.toast('warn', `err.${ev.data.code ?? 'EM-6402'}.title`, typeof ev.data['have'] === 'number' ? { have: ev.data['have'] } : undefined,
          { code: ev.data.code ?? 'EM-6402', sticky: true, action: { labelKey: 'ui.scr.hardware.open', run: () => { window.dispatchEvent(new CustomEvent(OPEN_HARDWARE_EVENT)); } } });
        if (ev.data.kind === 'restore' && ev.data.done && typeof ev.data.projectId === 'string') {
          const restoredId = ev.data.projectId;
          void actions.openProject(restoredId);
          // FR-018: a same-identity project was restored as a renamed copy (EM-6303); nothing was overwritten.
          if (ev.data.code === 'EM-6303') actions.toast('info', 'err.EM-6303.title', { name: typeof ev.data['name'] === 'string' ? ev.data['name'] : '' }, { code: 'EM-6303', action: { labelKey: 'err.EM-6303.action', run: () => { void actions.openProject(restoredId); } } });
        }
        // FR-052: removed assets back in use after Undo/Redo reappear in the Asset Panel.
        // Review A3: unused voice clips of a failed / cancelled / replaced batch left the Library (assets-removed): same reload.
        if ((ev.data.kind === 'assets-restored' || ev.data.kind === 'assets-removed') && typeof ev.data.projectId === 'string' && ev.data.projectId === stateRef.current.project?.id) {
          const id = ev.data.projectId;
          void runtime.api.listAssets(id, { limit: 200 }).then((p) => { if (stateRef.current.project?.id === id) dispatch({ type: 'assets', assets: p.items }); }).catch(() => undefined);
        }
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

  // ── Shell service state (FR-171, FR-176): offline banner, new endpoint after a restart, fatal EM-8002 / EM-6001 ──
  const [bootNonce, rebootNow] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const ch = runtime.service;
    if (!ch) return;
    let lastEpoch = ch.current().epoch;
    const apply = (s: ReturnType<typeof ch.current>) => {
      if (s.status === 'offline') dispatch({ type: 'stream', status: 'offline', attempt: Math.max(1, stateRef.current.streamAttempt) });
      const fatal = s.status === 'failed' ? { code: s.code ?? 'EM-8002', ...(s.logsDir ? { logsDir: s.logsDir } : {}) } : null;
      // EM-6001 Restore backup (FR-176): the Shell started empty storage; open Restore once the Service is ready.
      if (s.status === 'ready' && s.code === 'EM-6001') { actions.toast('warn', 'err.EM-6001.title', undefined, { code: 'EM-6001', sticky: true }); dispatch({ type: 'screen', screen: { kind: 'restore' } }); }
      dispatch({ type: 'service', epoch: s.epoch, fatal });
      if (s.status === 'ready' && s.epoch !== lastEpoch) {
        lastEpoch = s.epoch;
        if (stateRef.current.boot !== 'ready') rebootNow();       // first boot failed while the Service was (re)starting
      }
    };
    if (ch.current().status === 'failed') apply(ch.current());
    return ch.subscribe(apply);
  }, [runtime, dispatch, actions]);

  // ── boot ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (runtime.service?.current().status === 'failed') return;   // sys.fatal is shown instead
      try {
        const [health, settings, licence] = await Promise.all([runtime.api.health(), runtime.api.getSettings(), runtime.api.getLicense()]);
        // QA UX round 1: the hardware profile only after the licence verified (before, the Service answers 403 EM-5010: console noise)
        const hardware = licence.status === 'licensed' ? await runtime.api.hardwareProfile().catch(() => null) : null;
        if (cancelled) return;
        dispatch({ type: 'globals', health, settings, licence, hardware });
        // No Trial Mode: without a verified key the Service answers EM-5010 everywhere else, so stop here and show only the
        // licence screen; activation reboots this sequence (effect below) and continues to onboarding / the Editor.
        if (licence.status !== 'licensed') { if (!cancelled) dispatch({ type: 'boot', boot: 'unlicensed' }); return; }
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
        const last = recent.items[0]?.id ?? null;
        // FR-202 (QA 2026-10-27 #7): a launch shows the Start screen; only an in-window Reload of a project that did not crash
        // repeatedly reopens it. Runtimes without `startScreen` (mock, tests, demo) keep opening the most recent / seeded project.
        const fallback = async () => last ?? runtime.seededProjectId ?? (await runtime.api.listProjects({ limit: 1 }).catch(() => ({ items: [] }))).items[0]?.id ?? null;
        const decision = runtime.startScreen ? bootDecision({ seed: null, lastProjectId: last }) : { open: await fallback(), action: null };
        if (decision.open) await actions.openProject(decision.open);
        // FR-260 (Operator 2026-10-29): a launch without a project to restore lands in an EMPTY project (the untouched blank project of
        // the last launch, else a new one), never on the Start screen; a crash-loop / abnormal-end notice is shown inside it.
        else if (runtime.startScreen && decision.action !== 'new') await actions.openBlankProject();
        if (!cancelled) {
          dispatch({ type: 'boot', boot: 'ready' });
          if (decision.action === 'new') void actions.newProject();
          if (decision.action === 'pick') dispatch({ type: 'screen', screen: { kind: 'project.open' } });
          // FR-004: the onboarding record lives server-side (settings.onboardingDone); prefs mirror it for older services and the mock.
          if (!prefsRef.current.onboardingDone && settings.onboardingDone !== true) dispatch({ type: 'screen', screen: { kind: 'onboarding' } });
        }
      } catch (e) {
        if (!cancelled) { dispatch({ type: 'boot', boot: 'no-service' }); actions.error(e); }
      }
    })();
    return () => { cancelled = true; };
  }, [runtime, actions, dispatch, setPrefs, bootNonce]);

  // Activation (or a licence.changed back to licensed) while the boot stopped at the licence screen: continue without a restart.
  // FR-260: the first edit of the blank project (another head, an asset, a chat message, a rename) makes it an ordinary project.
  const openId = state.project?.id ?? null, openName = state.project?.name ?? '', openHead = state.head?.hash ?? null;
  const assetCount = state.assets.length, msgCount = state.messages.brainstorm.length + state.messages.editor.length;
  useEffect(() => {
    if (!openId || openHead === null) return;                                     // head not loaded yet: nothing to compare
    promoteIfTouched({ id: openId, name: openName, headHash: openHead, assets: assetCount, messages: msgCount });
  }, [openId, openName, openHead, assetCount, msgCount]);
  const licensedNow = state.licence?.status === 'licensed';
  useEffect(() => { if (state.boot === 'unlicensed' && licensedNow) rebootNow(); }, [state.boot, licensedNow]);

  // ── SSE: one stream per open project (projectId filter), reopened on project change ──
  const projectId = state.project?.id;
  const serviceEpoch = state.serviceEpoch;
  const streamRef = useRef<EventStream | null>(null);
  const epochSeen = useRef(serviceEpoch);
  useEffect(() => {
    if (state.boot !== 'ready') return;
    // FR-171: a new endpoint (Service restarted with a new port + token) → fresh stream with the new token, then refetch head/project.
    const restarted = epochSeen.current !== serviceEpoch;
    epochSeen.current = serviceEpoch;
    const stream = createEventStream({
      url: runtime.api.eventsUrl(projectId ? { projectId } : {}),
      ...(runtime.createSource ? { createSource: runtime.createSource } : {}),
      token: () => runtime.api.serviceToken,                                          // SEC-016: header, never the URL
      onEvent,
      onStatus: (status, attempt) => dispatch({ type: 'stream', status, attempt }),
      onResync: () => { void actions.reloadState(); void runtime.api.listRenders(projectId ? { projectId } : {}).then((p) => dispatch({ type: 'renders', renders: p.items })).catch(() => undefined); },
      healthCheck: runtime.healthCheck,
      storageKey: `expertmotion.seq.${projectId ?? 'global'}`,
    });
    streamRef.current = stream;
    if (restarted) {
      try { globalThis.sessionStorage?.removeItem(`expertmotion.seq.${projectId ?? 'global'}`); } catch { /* storage blocked */ }
      void actions.reloadState();
      void runtime.api.getSettings().then((settings) => dispatch({ type: 'globals', settings })).catch(() => undefined);
    }
    return () => { stream.close(); streamRef.current = null; };
  }, [state.boot, projectId, serviceEpoch, runtime, onEvent, actions, dispatch]);

  // prefsVersion: a setPrefs call must re-render consumers even when no Service state changed (Ctrl+B, panel sizes).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo<Store>(() => ({ state, dispatch, runtime, actions, prefs: prefsRef.current, setPrefs, t, lang }), [state, dispatch, runtime, actions, setPrefs, t, lang, prefsVersion]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** Review U1: what a re-plan of `plan` asks for — its picks that are still queued, the Creator's message (an agent plan's goal) and
 *  the agent mode, so a stale / cancelled Editor-chat plan is planned again instead of becoming EM-9002 or a plan of the whole queue. */
export function replanRequest(plan: Pick<PlanDto, 'origin' | 'goal' | 'intentIds'>, queue: AppState['queue']): { intentIds?: string[]; message?: string; mode?: 'agent' } {
  const agent = plan.origin === 'editor-agent';
  const message = agent && plan.goal && plan.goal !== 'Plan the queued picks' ? plan.goal : undefined;
  const queued = queue ? new Set(queue.items.filter((i) => i.status === 'queued').map((i) => i.id)) : null;
  const all = plan.intentIds ?? [];
  const left = all.filter((i) => !queued || queued.has(i));
  // nothing of the request is left and there is no message: ask for the old ids so the Service says so (EM-9003), never the whole queue
  const ids = left.length || message ? left : all;
  return { ...(ids.length ? { intentIds: ids } : {}), ...(message ? { message } : {}), ...(agent ? { mode: 'agent' as const } : {}) };
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
