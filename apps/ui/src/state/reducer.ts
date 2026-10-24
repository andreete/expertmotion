// Editor state (BLUEPRINT.md §3.7 state/service + state/project): pure reducer, fed by REST responses and SSE events.
// The Editor never computes or mutates the Composition Model itself (ARCHITECTURE.md §3); it only stores what the
// Local Service returns. Kept React-free so it can be unit-tested directly.
import type { ElementRefT } from '@expertmotion/composition-model';
import type {
  AgentKind, AssetDto, AssignmentsDto, UsageNumbers, CapabilityRow, ConnectionDto, EditIntent, ElementDiff, HardwareProfileDto, HardwareTickDto, HealthDto, IntentQueueDto,
  LicenseDto, MediaGrantDto, MessageDto, ModelStateDto, OpenProjectResponse, OutputDto, PerformanceProfile, PlanDto, ProjectDto, RenderJobDto, ServiceEvent,
  SettingsDto, VersionDto,
} from '../api/types.js';
import type { StreamStatus } from '../api/events.js';

export type LibMode = 'home' | 'design' | 'tools';
export type ToastKind = 'info' | 'success' | 'warn' | 'danger';
export interface ToastAction { labelKey: string; run: () => void }
export interface Toast { id: string; kind: ToastKind; textKey: string; vars?: Record<string, string | number>; code?: string; count: number; action?: ToastAction; sticky: boolean }

export type Screen =
  | { kind: 'onboarding' } | { kind: 'license' } | { kind: 'providers' } | { kind: 'models'; focus?: string } | { kind: 'project.new'; saveAs?: boolean } | { kind: 'project.open' }
  | { kind: 'project.settings' } | { kind: 'project.recover' } | { kind: 'export' } | { kind: 'generate'; generator: 'voice' | 'music' | 'thumbnail' | 'captions' | 'hashtags' }
  | { kind: 'diagnostics' } | { kind: 'about' } | { kind: 'help' } | { kind: 'backup' } | { kind: 'restore' } | { kind: 'ratio.custom' } | { kind: 'history' } | { kind: 'shortcuts' }
  | { kind: 'confirm'; titleKey: string; bodyKey?: string; vars?: Record<string, string | number>; confirmKey: string; danger?: boolean; onConfirm: () => void }
  /** FR-174: Save / Don't save / Cancel before switching or closing with unsaved UI state; `then` runs after Save or Don't save. */
  | { kind: 'unsaved'; then: () => void; closing?: boolean }
  /** FR-002: closing while a Render Job runs: "Cancel render and close" / "Keep rendering". */
  | { kind: 'close.render'; jobId: string; then: () => void };

export interface Streaming { runId: string; text: string; modelId: string }

export interface AppState {
  boot: 'loading' | 'ready' | 'no-service';
  stream: StreamStatus;
  streamAttempt: number;
  health: HealthDto | null;
  settings: SettingsDto | null;
  licence: LicenseDto | null;
  hardware: HardwareProfileDto | null;
  tick: HardwareTickDto | null;
  project: ProjectDto | null;
  head: VersionDto | null;
  canUndo: boolean;
  canRedo: boolean;
  grant: MediaGrantDto | null;
  assets: AssetDto[];
  ingestStage: Record<string, string>;
  queue: IntentQueueDto | null;
  /** Optimistic queue items (IX-02 point 2) replaced by the server item on intent.updated. */
  pending: EditIntent[];
  plan: PlanDto | null;
  previousPlans: PlanDto[];
  renders: RenderJobDto[];
  outputs: OutputDto[];
  messages: Record<AgentKind, MessageDto[]>;
  streaming: Record<AgentKind, Streaming | null>;
  contextUsage: Record<AgentKind, { usedTokens: number; contextLength: number } | null>;
  /** FR-074: usage of each agent's last finished run (cost shown in the context counter tooltip). */
  lastUsage: Record<AgentKind, UsageNumbers | null>;
  /** Runs that already finished (agent.run.done / .failed): a late 202 must not restart their "Asking…" state. */
  doneRuns: string[];
  /** FR-061: a newer Composition Version was announced (composition.updated) and its model is still being fetched. */
  headLoading: boolean;
  agentError: Record<AgentKind, string | null>;
  connections: ConnectionDto[];
  assignments: AssignmentsDto | null;
  capabilities: Record<string, CapabilityRow[]>;
  models: ModelStateDto[];
  toasts: Toast[];
  live: { text: string; at: number } | null;
  libMode: LibMode;
  selection: ElementRefT[];
  playheadMs: number;
  previewPresetId: string | null;
  screen: Screen | null;
  pulse: { diff: ElementDiff[]; at: number } | null;
  performanceProfile: PerformanceProfile;
  assetSelection: string[];
  editorDraft: { text: string; target: ElementRefT | null; nonce: number } | null;
  checkpointBadge: boolean;
  /** FR-152 / FR-162 updater state from the Desktop Shell bridge (or a legacy service.notice {kind:'update'}). */
  update: { version: string; downloaded: boolean; status?: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'deferred' | 'paused' | 'error'; percent?: number; code?: string } | null;
  backupJob: { jobId: string; percent: number; done: boolean; path?: string; mode: 'backup' | 'restore'; projectId?: string } | null;
  /** Sample projects whose background preparation settled (`service.notice {kind:'sample', ready}`, R-025; ready:false = partial). */
  sampleReady: string[];
}

export const initialState: AppState = {
  boot: 'loading', stream: 'connecting', streamAttempt: 0, health: null, settings: null, licence: null, hardware: null, tick: null, project: null, head: null,
  canUndo: false, canRedo: false, grant: null, assets: [], ingestStage: {}, queue: null, pending: [], plan: null, previousPlans: [], renders: [], outputs: [],
  messages: { brainstorm: [], editor: [] }, streaming: { brainstorm: null, editor: null }, contextUsage: { brainstorm: null, editor: null }, lastUsage: { brainstorm: null, editor: null }, headLoading: false, doneRuns: [],
  agentError: { brainstorm: null, editor: null }, connections: [], assignments: null, capabilities: {}, models: [], toasts: [], live: null,
  libMode: 'design', selection: [], playheadMs: 0, previewPresetId: null, screen: null, pulse: null, performanceProfile: 'standard', assetSelection: [],
  editorDraft: null, checkpointBadge: false, backupJob: null, update: null, sampleReady: [],
};

export type Action =
  | { type: 'boot'; boot: AppState['boot'] }
  | { type: 'stream'; status: StreamStatus; attempt: number }
  | { type: 'globals'; health?: HealthDto | null; settings?: SettingsDto | null; licence?: LicenseDto | null; hardware?: HardwareProfileDto | null }
  | { type: 'settings'; settings: SettingsDto }
  | { type: 'licence'; licence: LicenseDto }
  | { type: 'tick'; tick: HardwareTickDto }
  | { type: 'projectOpened'; open: OpenProjectResponse; assets: AssetDto[]; messages?: Partial<Record<AgentKind, MessageDto[]>>; contextUsage?: Partial<AppState['contextUsage']> }
  | { type: 'projectClosed' }
  | { type: 'project'; project: ProjectDto }
  | { type: 'head'; head: VersionDto; canUndo: boolean; canRedo: boolean }
  | { type: 'grant'; grant: MediaGrantDto }
  | { type: 'assets'; assets: AssetDto[] }
  | { type: 'assetsUpsert'; assets: AssetDto[] }
  | { type: 'assetRemoved'; assetId: string }
  | { type: 'queue'; queue: IntentQueueDto }
  | { type: 'optimisticIntent'; intent: EditIntent }
  | { type: 'dropOptimistic'; id: string }
  | { type: 'plan'; plan: PlanDto | null }
  | { type: 'renders'; renders: RenderJobDto[] }
  | { type: 'outputs'; outputs: OutputDto[] }
  | { type: 'messages'; agent: AgentKind; messages: MessageDto[]; contextUsage?: AppState['contextUsage'][AgentKind] }
  | { type: 'messageAdded'; agent: AgentKind; message: MessageDto }
  | { type: 'agentError'; agent: AgentKind; code: string | null }
  | { type: 'streamingStart'; agent: AgentKind; runId: string; modelId: string }
  | { type: 'streamingStop'; agent: AgentKind }
  | { type: 'providers'; connections?: ConnectionDto[]; assignments?: AssignmentsDto | null }
  | { type: 'capabilities'; connectionId: string; rows: CapabilityRow[] }
  | { type: 'models'; models: ModelStateDto[] }
  | { type: 'toast'; toast: Omit<Toast, 'id' | 'count'> & { id?: string } }
  | { type: 'dismissToast'; id: string }
  | { type: 'announce'; text: string }
  | { type: 'libMode'; mode: LibMode }
  | { type: 'select'; selection: ElementRefT[] }
  | { type: 'playhead'; ms: number }
  | { type: 'preview'; presetId: string | null }
  | { type: 'screen'; screen: Screen | null }
  | { type: 'performanceProfile'; profile: PerformanceProfile }
  | { type: 'assetSelection'; ids: string[] }
  | { type: 'editorDraft'; draft: AppState['editorDraft'] }
  | { type: 'backupJob'; job: AppState['backupJob'] }
  | { type: 'dismissUpdate' }
  | { type: 'update'; update: { status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'deferred' | 'paused' | 'error'; version?: string; percent?: number; code?: string } }
  | { type: 'event'; event: ServiceEvent };

const MAX_TOASTS = 3;
let toastSeq = 0;

const upsert = <T extends { id: string }>(list: readonly T[], items: readonly T[], front = false): T[] => {
  const map = new Map(list.map((x) => [x.id, x]));
  const fresh: T[] = [];
  for (const it of items) { if (map.has(it.id)) map.set(it.id, it); else fresh.push(it); }
  const merged = list.map((x) => map.get(x.id)!);
  return front ? [...fresh, ...merged] : [...merged, ...fresh];
};

function setPlan(state: AppState, plan: PlanDto | null): AppState {
  if (!plan) return { ...state, plan: null };
  if (plan.origin === 'compile' && plan.status === 'executed') return state;     // compiled plans show as queue items, not Plan Cards (§11.2)
  const cur = state.plan;
  if (cur && cur.id !== plan.id) {
    const prev = [cur, ...state.previousPlans.filter((p) => p.id !== cur.id && p.id !== plan.id)].slice(0, 10);
    return { ...state, plan, previousPlans: prev };
  }
  if (cur && plan.status === 'draft' && cur.status !== 'draft') return state;   // SSE plan.ready can overtake the 202 response: never regress to draft
  return { ...state, plan: cur ? { ...cur, ...plan, steps: plan.steps.length || !cur.steps.length ? plan.steps : cur.steps } : plan };
}

function isCurrentProject(state: AppState, projectId: string | undefined): boolean {
  return !projectId || !state.project || projectId === state.project.id;
}

export function reduceEvent(state: AppState, ev: ServiceEvent): AppState {
  if ('projectId' in ev.data && !isCurrentProject(state, ev.data.projectId)) {
    if (ev.name !== 'render.done' && ev.name !== 'render.failed' && ev.name !== 'service.notice') return state;
  }
  switch (ev.name) {
    case 'intent.updated': return { ...state, queue: ev.data.queue, pending: [] };     // the server item replaces the optimistic one
    case 'plan.ready': return setPlan(state, ev.data.plan);
    case 'plan.invalid': {
      const patch = (p: PlanDto): PlanDto => ({ ...p, status: ev.data.status, validation: ev.data.validation.map((v) => ({ path: v.path, message: v.message, code: v.code })), touchesLockedKeys: ev.data.touchesLockedKeys, errorCode: ev.data.code });
      if (state.plan?.id === ev.data.planId) return { ...state, plan: patch(state.plan) };
      return { ...state, previousPlans: state.previousPlans.map((p) => (p.id === ev.data.planId ? patch(p) : p)) };
    }
    case 'composition.updated': {
      const v = ev.data.version;
      const head = state.head && state.head.id === v.id ? state.head : { ...v, ...(state.head?.model ? { model: state.head.model } : {}) };
      const project = state.project ? { ...state.project, headVersionId: v.id, headHash: v.hash, durationMs: ev.data.durationMs, dirty: true } : null;
      const plan = state.plan && (state.plan.status === 'valid' || state.plan.status === 'invalid') && state.plan.baseVersion !== v.hash && ev.data.cause !== 'execute'
        ? { ...state.plan, status: 'stale' as const } : state.plan;
      return { ...state, head, project, canUndo: ev.data.canUndo, canRedo: ev.data.canRedo, plan, headLoading: state.headLoading || (state.head !== null && state.head.id !== v.id), pulse: ev.data.diff.length ? { diff: ev.data.diff, at: Date.now() } : state.pulse };
    }
    case 'render.queued': return { ...state, renders: upsert(state.renders, [ev.data.job], true) };
    case 'render.progress': return { ...state, renders: state.renders.map((j) => (j.id === ev.data.jobId ? { ...j, status: 'rendering', progress: ev.data.progress, renderedFrames: ev.data.renderedFrames, totalFrames: ev.data.totalFrames, etaMs: ev.data.etaMs } : j)) };
    case 'render.done': return { ...state, renders: state.renders.map((j) => (j.id === ev.data.jobId ? { ...j, status: 'done', progress: 1, outputId: ev.data.output.id, etaMs: 0 } : j)), outputs: upsert(state.outputs, [ev.data.output], true) };
    case 'render.failed': return { ...state, renders: state.renders.map((j) => (j.id === ev.data.jobId ? { ...j, status: 'failed', errorCode: ev.data.code, progress: ev.data.percent / 100, failedFrame: ev.data.frame ?? j.failedFrame ?? null } : j)) };
    case 'render.cancelled': return { ...state, renders: state.renders.map((j) => (j.id === ev.data.jobId ? { ...j, status: 'cancelled' } : j)) };
    case 'ingest.progress': return { ...state, assets: state.assets.map((a) => (a.id === ev.data.assetId ? { ...a, progress: ev.data.progress } : a)), ingestStage: { ...state.ingestStage, [ev.data.assetId]: ev.data.stage } };
    case 'ingest.done': return { ...state, assets: upsert(state.assets, [ev.data.asset]) };
    case 'ingest.failed': return { ...state, assets: state.assets.map((a) => (a.id === ev.data.assetId ? { ...a, status: 'failed', errorCode: ev.data.code } : a)) };
    case 'agent.run.started': return { ...state, streaming: { ...state.streaming, [ev.data.agent]: { runId: ev.data.run.id, text: '', modelId: ev.data.modelId } }, agentError: { ...state.agentError, [ev.data.agent]: null } };
    case 'agent.run.delta': {
      const s = state.streaming[ev.data.agent];
      return { ...state, streaming: { ...state.streaming, [ev.data.agent]: { runId: ev.data.runId, modelId: s?.modelId ?? '', text: `${s?.text ?? ''}${ev.data.delta}` } } };
    }
    case 'agent.run.done': {
      const agent = ev.data.run.agent;
      const msgs = state.messages[agent].some((m) => m.id === ev.data.message.id) ? state.messages[agent] : [...state.messages[agent], ev.data.message];
      return { ...state, doneRuns: [ev.data.run.id, ...state.doneRuns].slice(0, 20), messages: { ...state.messages, [agent]: msgs }, streaming: { ...state.streaming, [agent]: null }, contextUsage: { ...state.contextUsage, [agent]: ev.data.contextUsage ?? state.contextUsage[agent] }, lastUsage: { ...state.lastUsage, [agent]: ev.data.usage ?? state.lastUsage[agent] } };
    }
    case 'agent.run.failed': return { ...state, doneRuns: [ev.data.runId, ...state.doneRuns].slice(0, 20), streaming: { ...state.streaming, [ev.data.agent]: null }, agentError: { ...state.agentError, [ev.data.agent]: ev.data.code } };
    case 'model.progress': return { ...state, models: state.models.map((m) => (m.key === ev.data.key ? { ...m, bytesDone: ev.data.bytesDone, bytesTotal: ev.data.bytesTotal, status: ev.data.status, pausedReason: ev.data.pausedReason ?? null } : m)) };
    case 'model.installed': return { ...state, models: state.models.map((m) => (m.key === ev.data.model.key ? ev.data.model : m)) };
    case 'model.failed': return { ...state, models: state.models.map((m) => (m.key === ev.data.key ? { ...m, status: ev.data.code === 'EM-7006' ? 'not-installed' : 'failed', errorCode: ev.data.code } : m)) };   // EM-7006 = paused (FR-161)
    case 'hardware.tick': return { ...state, tick: ev.data };
    case 'license.changed': return { ...state, licence: ev.data.licence };
    case 'settings.changed': {
      if (ev.data.settings) return { ...state, settings: ev.data.settings, performanceProfile: ev.data.settings.defaultPerformanceProfile ?? state.performanceProfile };
      if (ev.data.privateMode !== undefined && state.settings) return { ...state, settings: { ...state.settings, privateMode: ev.data.privateMode } };
      return state;
    }
    case 'service.notice': {
      const d = ev.data;
      // R-025: ready:true, or ready:false when a bundled file failed to ingest; either way the sample is settled and the tour continues on what is there.
      if (d.kind === 'sample' && typeof d['ready'] === 'boolean' && typeof d.projectId === 'string') return state.sampleReady.includes(d.projectId) ? state : { ...state, sampleReady: [...state.sampleReady, d.projectId] };
      if (d.kind === 'update') return { ...state, update: { version: typeof d['version'] === 'string' ? d['version'] : '', downloaded: Boolean(d['downloaded']) } };
      if ((d.kind === 'backup' || d.kind === 'restore') && typeof d.jobId === 'string' && state.backupJob?.jobId === d.jobId) {
        return { ...state, backupJob: { ...state.backupJob, percent: d.percent ?? state.backupJob.percent, done: Boolean(d.done), ...(typeof d.path === 'string' ? { path: d.path } : {}), ...(typeof d.projectId === 'string' ? { projectId: d.projectId } : {}) } };
      }
      return state;
    }
    default: return state;
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'boot': return { ...state, boot: action.boot };
    case 'stream': return { ...state, stream: action.status, streamAttempt: action.attempt };
    case 'globals': return {
      ...state,
      ...(action.health !== undefined ? { health: action.health } : {}), ...(action.settings !== undefined ? { settings: action.settings } : {}),
      ...(action.licence !== undefined ? { licence: action.licence } : {}), ...(action.hardware !== undefined ? { hardware: action.hardware } : {}),
      ...(action.settings ? { performanceProfile: action.settings.defaultPerformanceProfile } : {}),
    };
    case 'settings': return { ...state, settings: action.settings };
    case 'licence': return { ...state, licence: action.licence };
    case 'tick': return { ...state, tick: action.tick };
    case 'projectOpened': {
      const o = action.open;
      return {
        ...state, project: o.project, head: o.head, grant: o.mediaGrant, queue: o.intentQueue, plan: o.latestPlan && o.latestPlan.status !== 'executed' ? o.latestPlan : null, previousPlans: [],
        renders: o.renderJobs, assets: action.assets, ingestStage: {}, pending: [], selection: [], playheadMs: 0, previewPresetId: null, assetSelection: [],
        canUndo: o.head.parentId !== null, canRedo: false, checkpointBadge: o.checkpointNewerThanSave !== null,
        messages: { brainstorm: action.messages?.brainstorm ?? [], editor: action.messages?.editor ?? [] },
        contextUsage: { brainstorm: action.contextUsage?.brainstorm ?? null, editor: action.contextUsage?.editor ?? null },
        streaming: { brainstorm: null, editor: null }, agentError: { brainstorm: null, editor: null }, outputs: [], pulse: null, headLoading: false, lastUsage: { brainstorm: null, editor: null },
      };
    }
    case 'projectClosed': return { ...state, project: null, head: null, grant: null, assets: [], queue: null, plan: null, previousPlans: [], selection: [], messages: { brainstorm: [], editor: [] } };
    case 'project': return { ...state, project: action.project };
    case 'head': return { ...state, headLoading: false, head: action.head, canUndo: action.canUndo, canRedo: action.canRedo, project: state.project ? { ...state.project, headVersionId: action.head.id, headHash: action.head.hash, durationMs: action.head.durationMs, settings: action.head.model?.settings ?? state.project.settings } : null, selection: pruneSelection(state.selection, action.head) };
    case 'grant': return { ...state, grant: action.grant };
    case 'assets': return { ...state, assets: action.assets };
    // An import response can arrive after its own `ingest.done` event: never let the older `ingesting` snapshot win.
    case 'assetsUpsert': return { ...state, assets: upsert(state.assets, action.assets.map((a) => { const cur = state.assets.find((x) => x.id === a.id); return cur && cur.status !== 'ingesting' && a.status === 'ingesting' && cur.updatedAt >= a.updatedAt ? cur : a; })) };
    case 'assetRemoved': return { ...state, assets: state.assets.filter((a) => a.id !== action.assetId), assetSelection: state.assetSelection.filter((id) => id !== action.assetId) };
    case 'queue': return { ...state, queue: action.queue, pending: [] };
    case 'optimisticIntent': return { ...state, pending: [action.intent, ...state.pending] };
    case 'dropOptimistic': return { ...state, pending: state.pending.filter((p) => p.id !== action.id) };
    case 'plan': return setPlan(state, action.plan);
    case 'renders': return { ...state, renders: action.renders };
    case 'outputs': return { ...state, outputs: action.outputs };
    case 'messages': return { ...state, messages: { ...state.messages, [action.agent]: action.messages }, ...(action.contextUsage !== undefined ? { contextUsage: { ...state.contextUsage, [action.agent]: action.contextUsage } } : {}) };
    case 'messageAdded': {
      const list = state.messages[action.agent], m = action.message;
      if (list.some((x) => x.id === m.id)) return state;
      // The reply's SSE event can overtake the 202 that carries the Creator's own message: keep creation order (FR-086).
      let at = list.findIndex((x) => x.createdAt > m.createdAt || (x.createdAt === m.createdAt && m.role === 'user' && x.role !== 'user' && x.agentRunId !== null));
      if (at < 0) at = list.length;
      return { ...state, messages: { ...state.messages, [action.agent]: [...list.slice(0, at), m, ...list.slice(at)] } };
    }
    case 'agentError': return { ...state, agentError: { ...state.agentError, [action.agent]: action.code }, ...(action.code ? { streaming: { ...state.streaming, [action.agent]: null } } : {}) };
    case 'streamingStart': if (state.doneRuns.includes(action.runId)) return state;
      return { ...state, streaming: { ...state.streaming, [action.agent]: state.streaming[action.agent] ?? { runId: action.runId, text: '', modelId: action.modelId } } };
    case 'streamingStop': return { ...state, streaming: { ...state.streaming, [action.agent]: null } };
    case 'providers': return { ...state, ...(action.connections ? { connections: action.connections } : {}), ...(action.assignments !== undefined ? { assignments: action.assignments } : {}) };
    case 'capabilities': return { ...state, capabilities: { ...state.capabilities, [action.connectionId]: action.rows } };
    case 'models': return { ...state, models: action.models };
    case 'toast': {
      const t = action.toast;
      if (t.code) {
        const same = state.toasts.find((x) => x.code === t.code);
        if (same) return { ...state, toasts: state.toasts.map((x) => (x === same ? { ...x, count: x.count + 1 } : x)) };   // one toast per EM- code (§10)
      }
      toastSeq += 1;
      const next: Toast = { ...t, id: t.id ?? `t${toastSeq}`, count: 1 };
      return { ...state, toasts: [...state.toasts, next].slice(-MAX_TOASTS) };
    }
    case 'dismissToast': return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'announce': return { ...state, live: { text: action.text, at: Date.now() } };
    case 'libMode': return { ...state, libMode: action.mode };
    case 'select': return { ...state, selection: action.selection };
    case 'playhead': return { ...state, playheadMs: Math.max(0, Math.round(action.ms)) };
    case 'preview': return { ...state, previewPresetId: action.presetId };
    case 'screen': return { ...state, screen: action.screen };
    case 'performanceProfile': return { ...state, performanceProfile: action.profile };
    case 'assetSelection': return { ...state, assetSelection: action.ids };
    case 'editorDraft': return { ...state, editorDraft: action.draft };
    case 'dismissUpdate': return { ...state, update: null };
    case 'update': {
      const u = action.update;
      if (u.status === 'idle' || u.status === 'checking') return { ...state, update: null };
      return { ...state, update: { version: u.version ?? '', downloaded: u.status === 'downloaded' || u.status === 'deferred', status: u.status, ...(u.percent !== undefined ? { percent: u.percent } : {}), ...(u.code ? { code: u.code } : {}) } };
    }
    case 'backupJob': return { ...state, backupJob: action.job };
    case 'event': return reduceEvent(state, action.event);
    default: return state;
  }
}

/** Selection is cleared for elements a new version removed (EDITOR_INTERACTION_MODEL.md §6 "Clearing"). */
function pruneSelection(sel: ElementRefT[], head: VersionDto): ElementRefT[] {
  const m = head.model;
  if (!m) return sel;
  return sel.filter((s) => {
    if (s.kind === 'clip') return m.tracks.video.some((c) => c.id === s.id);
    if (s.kind === 'text') return m.tracks.text.some((c) => c.id === s.id);
    if (s.kind === 'audio') return m.tracks.audio.some((c) => c.id === s.id);
    if (s.kind === 'shape') return m.tracks.overlay.some((c) => c.id === s.id);
    if (s.kind === 'cut') return (s.index ?? 0) < Math.max(0, m.tracks.video.length - 1);
    return true;
  });
}

/** Queue items to display: server items plus optimistic ones not yet confirmed. Children are grouped under their parent. */
export function visibleQueue(state: AppState): EditIntent[] {
  const items = state.queue?.items ?? [];
  return [...state.pending.filter((p) => !items.some((i) => i.id === p.id)), ...items];
}
