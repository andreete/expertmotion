// Typed fetch client for every route of docs/API_SPECIFICATION.md §4 (R-001 … R-190). Bearer token on every /api/v1 call,
// error envelope → EmError (code + status + details), Idempotency-Key helper, media URL builder for media grants (§2.2).
import { z } from 'zod';
import { EmError, EM_CODE_RE, type EmCode } from '@expertmotion/shared';
import type { ElementRefT, OperationT, ProjectSettingsT } from '@expertmotion/composition-model';
import type {
  AgentKind, AgentRunDto, AssetDto, AssignmentDto, AssignmentsDto, CapabilityRow, CatalogueItemDto, ChatTarget, CheckpointDto, CompositionHeadResponse, ConnectionDto,
  ChatDocumentDto, ConversationDto, DesignPickInput, DiskUsageDto, ElementDiff, ExecutionResult, GeneratorCardDto, GeneratorJobDto, GeneratorKind, HardwareProfileDto, HardwareTickDto, HealthDto, Id,
  IntentCreateResponse, IntentQueueDto, LicenseDto, MediaGrantDto, MediaVariant, MessageDto, ModelRegistrySource, ModelStateDto, OpenProjectResponse, OutputDto, Page, PlanDto,
  ProbeResultDto, ProjectCreateInput, ProjectDto, ProjectSettingsExtras, ProjectUiState, ProviderKind, ProviderKindInfo, RecentCodeDto, RecoverySummaryDto, RenderCreateInput, RenderEstimate, RenderJobDto, SettingsDto, VersionDto, VoiceListDto, MusicTrackDto, TranscriptCueDto,
} from './types.js';

export interface Bootstrap { baseUrl: string; token: string }
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type MediaResolver = (grant: MediaGrantDto, assetId: string, variant: MediaVariant | 'file' | 'thumb', kind: 'asset' | 'output') => string | null;

const ErrorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional(), path: z.string().optional() }) });

/** Shape the Desktop Shell preload exposes (BLUEPRINT.md §3.8). Everything optional: the browser dev build has no bridge. */
export interface ShellBridge {
  getBootstrap?: () => { port: number; token: string } | Promise<{ port: number; token: string }>;
  pickFiles?: (options?: { filters?: { name: string; extensions: string[] }[]; multiple?: boolean }) => Promise<string[]>;
  pickFolder?: (options?: { defaultPath?: string }) => Promise<string | null>;
  pickSavePath?: (options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  openFolder?: (path: string) => Promise<void> | void;
  openExternal?: (url: string) => Promise<void> | void;
  /** R1: research citation / picture source page (public https; the Shell refuses in Private Mode with EM-8202). */
  openSource?: (url: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  getPathsForFiles?: (files: readonly File[]) => string[];
  /** Service up/down + re-bootstrap push after a restart (FR-171); returns an unsubscribe function. */
  onServiceState?: (cb: (state: unknown) => void) => (() => void) | void;
  /** FR-152 updater (Desktop Shell): state push, current state, and the Creator's consent actions. */
  onUpdateState?: (cb: (state: UpdateState) => void) => (() => void) | void;
  getUpdateState?: () => Promise<UpdateState | null>;
  updateAction?: (action: 'download' | 'restart' | 'later' | 'check') => Promise<void> | void;
  /** FR-146 Play: opens a rendered Output with the system player (Output paths only, checked in main). */
  openPath?: (path: string) => Promise<void> | void;
  /** Clipboard through the Shell (the renderer's own clipboard permission is denied). */
  copyText?: (text: string) => Promise<boolean>;
  readClipboardText?: () => Promise<string>;
  /** FR-185: Editor errors to the Shell log (validated, rate-limited, size-capped in main). */
  logError?: (entry: { level: 'warn' | 'error'; code?: string; message: string; stack?: string; source: 'error-boundary' | 'window-error' | 'unhandled-rejection' }) => Promise<void> | void;
  /** FR-184: the splash's "Try again" after EM-8002; resolves true when the Shell restarts the Service. */
  retryStartup?: () => Promise<boolean>;
}

const shellBridge = (): ShellBridge | undefined => (typeof window !== 'undefined' ? window.expertmotion : undefined);
/** Copies text; resolves true only when it really reached the clipboard (Shell bridge, else the browser API in development). */
export async function copyText(text: string): Promise<boolean> {
  try {
    const b = shellBridge();
    if (b?.copyText) return await b.copyText(text);
    if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  return false;
}
/** Reads clipboard text for an explicit Paste click; '' when unavailable. */
export async function readClipboardText(): Promise<string> {
  try {
    const b = shellBridge();
    if (b?.readClipboardText) return await b.readClipboardText();
    if (typeof navigator !== 'undefined' && navigator.clipboard) return await navigator.clipboard.readText();
  } catch { /* fall through */ }
  return '';
}
/** Shell updater state (FR-152, FR-162). */
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'deferred' | 'paused' | 'error';
  version?: string; percent?: number; code?: string;
}
declare global { interface Window { expertmotion?: ShellBridge } }

/** Storefront for Purchase (LICENSE_OPERATIONS §11). Set by the Operator at build time; must be on the Shell's EXTERNAL_HOSTS. */
export const STORE_URL: string = (import.meta.env as Record<string, string | undefined>)['VITE_EM_STORE_URL'] ?? 'https://expertmotion.app/buy';
/** Online documentation (FR-148), also on EXTERNAL_HOSTS; the offline help ships inside the Editor (scr.help). */
export const DOCS_URL: string = (import.meta.env as Record<string, string | undefined>)['VITE_EM_DOCS_URL'] ?? 'https://expertmotion.app/docs';

const Boot = z.object({ port: z.number().int().min(1).max(65535), token: z.string().min(8) });

/** Startup steps shown on the splash (FR-184). The Shell pushes the first three; `project` is the Editor's first project load. */
export const STARTUP_PHASES = ['integrity', 'keyring', 'service', 'project'] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];
/** Shell → Editor service state (preload `ServiceState`, FR-171): `ready` may carry a fresh endpoint; `failed` carries EM-8002/EM-6001;
 *  `starting` carries the startup phase, its progress (0…1) and the time since the Shell started (FR-184). */
export const ServiceStatePush = z.object({
  status: z.enum(['starting', 'ready', 'offline', 'failed']),
  bootstrap: Boot.optional(),
  code: z.string().regex(EM_CODE_RE).optional(),
  logsDir: z.string().max(1024).optional(),
  phase: z.enum(STARTUP_PHASES).optional(),
  progress: z.number().min(0).max(1).optional(),
  sinceMs: z.number().int().min(0).max(3_600_000).optional(),
});
export type ServiceStatePushT = z.infer<typeof ServiceStatePush>;
export const bootstrapFromPush = (b: { port: number; token: string }): Bootstrap => ({ baseUrl: `http://127.0.0.1:${b.port}`, token: b.token });

/** Electron: preload bootstrap. Dev: VITE_EM_API (e.g. http://127.0.0.1:4110) + VITE_EM_TOKEN. Returns null when neither exists. */
export async function resolveBootstrap(env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
  bridge: ShellBridge | undefined = typeof window !== 'undefined' ? window.expertmotion : undefined): Promise<Bootstrap | null> {
  if (bridge?.getBootstrap) {
    const parsed = Boot.safeParse(await bridge.getBootstrap());
    if (parsed.success) return { baseUrl: `http://127.0.0.1:${parsed.data.port}`, token: parsed.data.token };
  }
  const api = env['VITE_EM_API'], token = env['VITE_EM_TOKEN'];
  if (api && token) return { baseUrl: api.replace(/\/+$/, '').replace(/\/api\/v1$/, ''), token };
  return null;
}

export const toEmCode = (code: string): EmCode => (EM_CODE_RE.test(code) ? (code as EmCode) : 'EM-9001');

interface ReqOpts { query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string>; body?: unknown; form?: FormData; /** raw request body (Content-Type set by the caller) */ raw?: Blob }

export class ApiClient {
  private base: string;
  private token: string;
  private readonly fetchImpl: FetchLike;
  private readonly mediaResolver: MediaResolver | undefined;

  constructor(opts: { baseUrl: string; token: string; fetch?: FetchLike; mediaResolver?: MediaResolver }) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.mediaResolver = opts.mediaResolver;
  }

  /** The Shell pushes a new token after a Service restart (API_SPECIFICATION.md §2.1 Rotation). */
  setToken(token: string): void { this.token = token; }
  /** FR-171: after a Service restart the Shell pushes a new port + token (onServiceState); every later call and the SSE URL use them. */
  setEndpoint(baseUrl: string, token: string): void { this.base = baseUrl.replace(/\/+$/, ''); this.token = token; }
  get baseUrl(): string { return this.base; }
  get serviceToken(): string { return this.token; }

  private url(path: string, query?: ReqOpts['query']): string {
    const q = query ? Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
    return `${this.baseUrl}/api/v1${path}${q ? `?${q}` : ''}`;
  }

  async request<T>(method: string, path: string, opts: ReqOpts = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.raw) body = opts.raw;
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json; charset=utf-8'; body = JSON.stringify(opts.body); }
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), { method, headers, ...(body === undefined ? {} : { body }) });
    } catch (cause) {
      throw new EmError('EM-8001', 'The local service is not responding.', { status: 0, cause });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = undefined;
    if (text) { try { json = JSON.parse(text); } catch { json = undefined; } }
    if (!res.ok) {
      const env = ErrorEnvelope.safeParse(json);
      if (env.success) {
        const e = env.data.error;
        throw new EmError(toEmCode(e.code), e.message, { status: res.status, ...(e.details === undefined ? {} : { details: e.details }), ...(e.path === undefined ? {} : { path: e.path }) });
      }
      throw new EmError(res.status === 401 ? 'EM-8004' : 'EM-9001', `HTTP ${res.status}`, { status: res.status });
    }
    return json as T;
  }
  private get<T>(path: string, query?: ReqOpts['query']) { return this.request<T>('GET', path, query ? { query } : {}); }
  private post<T>(path: string, body: unknown = {}, headers?: Record<string, string>) { return this.request<T>('POST', path, headers ? { body, headers } : { body }); }
  private put<T>(path: string, body: unknown) { return this.request<T>('PUT', path, { body }); }
  private patch<T>(path: string, body: unknown) { return this.request<T>('PATCH', path, { body }); }
  private del<T>(path: string, query?: ReqOpts['query']) { return this.request<T>('DELETE', path, query ? { query } : {}); }

  // ── 6.1 health / service ──
  health(): Promise<HealthDto> { return this.get('/health'); }                                                          // R-001
  shutdown(reason: 'window-closed' | 'update' | 'uninstall', force = false) { return this.post<{ acceptedAt: string }>('/service/shutdown', { reason, force }, { 'X-Expertmotion-Caller': 'shell' }); } // R-002
  // ── 6.2 projects ──
  listProjects(query: { limit?: number; cursor?: string; includeDeleted?: boolean } = {}): Promise<Page<ProjectDto>> { return this.get('/projects', query); }   // R-010
  createProject(body: ProjectCreateInput): Promise<ProjectDto> { return this.post('/projects', body); }                    // R-011
  recentProjects(): Promise<{ items: ProjectDto[] }> { return this.get('/projects/recent'); }                                // R-012
  getProject(id: Id): Promise<ProjectDto> { return this.get(`/projects/${id}`); }                                          // R-013
  patchProject(id: Id, body: { name?: string; language?: 'id' | 'en'; uiState?: ProjectUiState }): Promise<ProjectDto> { return this.patch(`/projects/${id}`, body); } // R-014 (uiState: FR-012)
  /** R-015: soft delete by default; `permanent` (Open ▸ Delete, FR-178) removes rows, media and checkpoints now, Outputs unless `keepOutputs`. */
  deleteProject(id: Id, opts: { permanent?: boolean; keepOutputs?: boolean } = {}): Promise<void> {
    return this.del(`/projects/${id}`, opts.permanent ? { permanent: true, keepOutputs: opts.keepOutputs !== false } : undefined);
  }
  diskUsage(projectId?: Id): Promise<DiskUsageDto> { return this.get('/projects/disk-usage', projectId ? { projectId } : undefined); } // R-026
  /** R-027: Open dialog thumbnail as a Blob (null when there is none). Fetched with the token header, never an <img src> with the token. */
  async projectThumbnail(id: Id): Promise<Blob | null> {
    try { const r = await this.fetchImpl(this.url(`/projects/${id}/thumbnail`), { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } }); return r.status === 200 ? await r.blob() : null; } catch { return null; }
  }
  getRecovery(): Promise<RecoverySummaryDto> { return this.get('/service/recovery'); }                                     // R-003
  openProject(id: Id): Promise<OpenProjectResponse> { return this.post(`/projects/${id}/open`); }                          // R-016
  getProjectSettings(id: Id): Promise<ProjectSettingsT> { return this.get(`/projects/${id}/settings`); }                    // R-017
  putProjectSettings(id: Id, settings: ProjectSettingsT & ProjectSettingsExtras): Promise<{ settings: ProjectSettingsT; version: VersionDto | null; warnings: unknown[] }> { return this.put(`/projects/${id}/settings`, settings); } // R-018
  duplicateProject(id: Id, name: string, copyMedia = true): Promise<ProjectDto> { return this.post(`/projects/${id}/duplicate`, { name, copyMedia }); } // R-019
  backupProject(id: Id, body: { folder: string; passphrase?: string; includeOutputs?: boolean }): Promise<{ jobId: Id }> { return this.post(`/projects/${id}/backup`, body); } // R-020
  /** R-025: the tour's sample project (201 created, 200 existing); clips are ingested and inserted in the background, then `service.notice {kind:'sample', ready:true}`. */
  createSampleProject(body: { language: 'id' | 'en' }): Promise<ProjectDto> { return this.post('/projects/sample', body); }        // R-025
  restoreProject(body: { path: string; passphrase?: string; onConflict?: 'copy' | 'replace' }): Promise<{ jobId: Id }> { return this.post('/projects/restore', body, { 'X-Expertmotion-Caller': 'shell' }); } // R-021
  // ── 6.3 checkpoints ──
  listCheckpoints(id: Id): Promise<{ items: CheckpointDto[]; notice?: string }> { return this.get(`/projects/${id}/checkpoints`); } // R-022
  createCheckpoint(id: Id): Promise<CheckpointDto> { return this.post(`/projects/${id}/checkpoints`, { reason: 'manual' }); }       // R-023
  restoreCheckpoint(id: Id, checkpointId: Id): Promise<{ version: VersionDto }> { return this.post(`/projects/${id}/checkpoints/${checkpointId}/restore`); } // R-024
  // ── 6.4 assets ──
  /** `origin`: Shell file picker or drag-and-drop (QA P1 2026-10-29: Windows network paths only from the picker). */
  importAssetPaths(id: Id, paths: string[], copy = true, origin?: 'picker' | 'drop'): Promise<{ items: AssetDto[]; notices: Array<{ code: string; assetId?: Id }> }> {   // R-030 (Shell)
    return this.post(`/projects/${id}/assets`, { paths, copy, ...(origin ? { origin } : {}) }, { 'X-Expertmotion-Caller': 'shell' });
  }
  /**
   * R-030 browser upload (development builds only; the packaged Editor imports by path through the Shell, importAssetPaths). The
   * Service takes one raw body per file (application/octet-stream + X-Expertmotion-Filename); multipart is refused with EM-9002,
   * which is what the chat attachment hit in the QA of 2026-10-27.
   */
  async uploadAssets(id: Id, files: readonly File[]): Promise<{ items: AssetDto[]; notices: Array<{ code: string; assetId?: Id }> }> {
    const items: AssetDto[] = []; const notices: Array<{ code: string; assetId?: Id }> = [];
    for (const f of files) {
      const r = await this.request<{ items: AssetDto[]; notices: Array<{ code: string; assetId?: Id }> }>('POST', `/projects/${id}/assets`,
        { raw: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Expertmotion-Filename': encodeURIComponent(f.name) } });
      items.push(...(r?.items ?? [])); notices.push(...(r?.notices ?? []));
    }
    return { items, notices };
  }
  listAssets(id: Id, query: { kind?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<Page<AssetDto>> { return this.get(`/projects/${id}/assets`, query); } // R-031
  getAsset(id: Id, assetId: Id, probe = false): Promise<AssetDto> { return this.get(`/projects/${id}/assets/${assetId}`, probe ? { probe: true } : undefined); } // R-032
  deleteAsset(id: Id, assetId: Id, confirm = false): Promise<{ version: VersionDto } | undefined> { return this.del(`/projects/${id}/assets/${assetId}`, confirm ? { confirm: true } : undefined); } // R-033
  setSequenceBadge(id: Id, assetId: Id, badge: number | null): Promise<{ items: AssetDto[] }> { return this.put(`/projects/${id}/assets/${assetId}/sequence-badge`, { badge }); } // R-034
  insertAssets(id: Id, body: { assetIds: Id[]; order?: 'badge' | 'given'; atIndex?: number; asOverlay?: boolean; atMs?: number; playheadMs?: number }): Promise<{ version: VersionDto; ops: OperationT[]; warnings: unknown[]; intentId?: Id | null }> {
    return this.post(`/projects/${id}/assets/insert`, body);                                                              // R-035
  }
  relocateAsset(id: Id, assetId: Id, path: string, reingest = false): Promise<AssetDto> { return this.post(`/projects/${id}/assets/${assetId}/relocate`, { path, reingest }, { 'X-Expertmotion-Caller': 'shell' }); } // R-036
  // ── 6.5 media ──
  issueMediaGrant(id: Id): Promise<MediaGrantDto> { return this.post(`/projects/${id}/media-grants`); }                    // R-042
  revokeMediaGrant(grant: string): Promise<void> { return this.del(`/media-grants/${grant}`); }                            // R-043
  /** R-040 URL: `${grant.baseUrl}/${assetId}/${variant}` (no Bearer; the grant is the credential, SEC-010). */
  mediaUrl(grant: MediaGrantDto, assetId: Id, variant: MediaVariant): string {
    return this.mediaResolver?.(grant, assetId, variant, 'asset') ?? `${grant.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(assetId)}/${variant}`;
  }
  /** R-041 URL. */
  outputMediaUrl(grant: MediaGrantDto, outputId: Id, variant: 'file' | 'thumb'): string {
    return this.mediaResolver?.(grant, outputId, variant, 'output') ?? `${grant.baseUrl.replace(/\/+$/, '')}/outputs/${encodeURIComponent(outputId)}/${variant}`;
  }
  // ── 6.6 composition ──
  getComposition(id: Id, model = true): Promise<CompositionHeadResponse> { return this.get(`/projects/${id}/composition`, { model }); } // R-050
  listVersions(id: Id, query: { limit?: number; cursor?: string } = {}): Promise<Page<VersionDto>> { return this.get(`/projects/${id}/composition/versions`, query); } // R-051
  getVersion(id: Id, versionId: Id): Promise<VersionDto> { return this.get(`/projects/${id}/composition/versions/${versionId}`); } // R-052
  undo(id: Id): Promise<{ head: VersionDto; canUndo: boolean; canRedo: boolean }> { return this.post(`/projects/${id}/composition/undo`); } // R-053
  redo(id: Id): Promise<{ head: VersionDto; canUndo: boolean; canRedo: boolean }> { return this.post(`/projects/${id}/composition/redo`); } // R-054
  diff(id: Id, from: string, to: string): Promise<{ from: string; to: string; diff: ElementDiff[]; ops: OperationT[] }> { return this.get(`/projects/${id}/composition/diff`, { from, to }); } // R-055
  validateOps(id: Id, baseVersion: string, ops: OperationT[]): Promise<{ ok: boolean; issues: unknown[]; predictedDiff: ElementDiff[]; predictedDurationMs: number }> {
    return this.post(`/projects/${id}/composition/validate`, { baseVersion, ops });                                        // R-056
  }
  // ── 6.7 intents ──
  createIntent(id: Id, body: DesignPickInput): Promise<IntentCreateResponse> { return this.post(`/projects/${id}/intents`, body); } // R-060
  createIntentBatch(id: Id, body: { baseVersion: string; picks: Array<Omit<DesignPickInput, 'baseVersion'>> }): Promise<IntentCreateResponse & { intents: IntentCreateResponse['intent'][] }> { return this.post(`/projects/${id}/intents/batch`, body); } // R-065
  listIntents(id: Id, query: { status?: string; limit?: number } = {}): Promise<IntentQueueDto> { return this.get(`/projects/${id}/intents`, query); } // R-061
  restoreIntent(id: Id, intentId: Id): Promise<IntentCreateResponse> { return this.post(`/projects/${id}/intents/${intentId}/restore`); } // R-062
  removeIntent(id: Id, intentId: Id): Promise<IntentQueueDto> { return this.del(`/projects/${id}/intents/${intentId}`); }   // R-063
  clearIntents(id: Id, status: 'queued' | 'superseded' = 'queued'): Promise<IntentQueueDto> { return this.del(`/projects/${id}/intents`, { status }); } // R-064
  // ── 6.8 plans ──
  createPlan(id: Id, body: { intentIds?: Id[]; message?: string; baseVersion: string; mode?: 'auto' | 'compile-only' | 'agent' }): Promise<PlanDto | { plan: PlanDto; runId: Id }> {
    return this.post(`/projects/${id}/plans`, body);                                                                     // R-070
  }
  listPlans(id: Id, query: { status?: string; limit?: number } = {}): Promise<Page<PlanDto>> { return this.get(`/projects/${id}/plans`, query); } // R-071
  getPlan(planId: Id): Promise<PlanDto> { return this.get(`/plans/${planId}`); }                                           // R-072
  executePlan(planId: Id, opts: { confirmDestructive?: boolean; idempotencyKey?: string } = {}): Promise<ExecutionResult> {  // R-073
    return this.post(`/plans/${planId}/execute`, { confirmDestructive: opts.confirmDestructive ?? false }, { 'Idempotency-Key': opts.idempotencyKey ?? idempotencyKey(`exec-${planId}`) });
  }
  cancelPlan(planId: Id): Promise<PlanDto> { return this.post(`/plans/${planId}/cancel`); }                                // R-074
  setPlanNotes(planId: Id, notes: string): Promise<PlanDto> { return this.patch(`/plans/${planId}/notes`, { notes }); }    // R-075
  // ── 6.9 agents ──
  getConversation(id: Id, agent: AgentKind, query: { limit?: number; cursor?: string } = {}): Promise<ConversationDto> { return this.get(`/projects/${id}/conversations/${agent}`, query); } // R-080
  sendMessage(id: Id, agent: AgentKind, body: { text: string; attachments?: Array<{ assetId: Id }>; documents?: Array<{ documentId: Id }>; intentIds?: Id[]; baseVersion: string; target?: ElementRefT; selection?: ElementRefT[]; playheadMs?: number; targets?: ChatTarget[] }): Promise<{ message: MessageDto; runId: Id; planId?: Id }> {
    return this.post(`/projects/${id}/conversations/${agent}/messages`, body);                                          // R-081
  }
  handoff(id: Id, body: { messageId: Id; intentIds?: Id[]; baseVersion: string }): Promise<{ queue: IntentQueueDto; accepted: Id[]; rejected: Array<{ id: Id; code: string }>; planId: Id | null }> {
    return this.post(`/projects/${id}/conversations/brainstorm/handoff`, body);                                         // R-082
  }
  /** R-083b (FR-219): "Kirim ke Editor" — the Brainstorm draft becomes an Editor request (run + Plan Card). */
  sendDraftToEditor(id: Id, messageId: Id, baseVersion: string): Promise<{ message: MessageDto; runId: Id; brainstormMessage: MessageDto }> {
    return this.post(`/projects/${id}/conversations/brainstorm/messages/${messageId}/send-to-editor`, { baseVersion });
  }
  /** R-088 (FR-221): attach a document to the chat (Shell: by path; development browser: raw body). */
  attachDocumentPath(id: Id, path: string): Promise<{ document: ChatDocumentDto }> { return this.post(`/projects/${id}/chat-documents`, { paths: [path] }, { 'X-Expertmotion-Caller': 'shell' }); }
  async attachDocumentFile(id: Id, f: File): Promise<{ document: ChatDocumentDto }> {
    return this.request<{ document: ChatDocumentDto }>('POST', `/projects/${id}/chat-documents`, { raw: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Expertmotion-Filename': encodeURIComponent(f.name) } });
  }
  /** R-089 (FR-217): import an openly licensed picture the Creator confirmed (attribution stored with the asset). */
  importResearchImage(id: Id, body: { messageId: Id; source: 'openverse' | 'wikimedia'; id: string }): Promise<{ assetId: Id; attribution: string | null; duplicate: boolean }> {
    return this.post(`/projects/${id}/research/images/import`, body);
  }
  clearConversation(id: Id, agent: AgentKind): Promise<void> { return this.del(`/projects/${id}/conversations/${agent}`); } // R-083
  getAgentRun(runId: Id): Promise<AgentRunDto> { return this.get(`/agent-runs/${runId}`); }                                // R-084
  cancelAgentRun(runId: Id): Promise<AgentRunDto> { return this.post(`/agent-runs/${runId}/cancel`); }                     // R-085
  getUsage(id: Id, month?: string): Promise<Record<string, unknown>> { return this.get(`/projects/${id}/usage`, month ? { month } : undefined); } // R-086
  // ── 6.10 providers ──
  listConnections(): Promise<{ items: ConnectionDto[] }> { return this.get('/providers/connections'); }                    // R-090
  addConnection(body: { provider: ProviderKind; label: string; secret: string; baseUrl?: string; budgetMonthUsd?: number | null; validateNow?: boolean }): Promise<ConnectionDto> {
    return this.post('/providers/connections', body);                                                                    // R-091
  }
  patchConnection(connId: Id, body: { label?: string; secret?: string; baseUrl?: string; budgetMonthUsd?: number | null }): Promise<ConnectionDto> { return this.patch(`/providers/connections/${connId}`, body); } // R-092
  deleteConnection(connId: Id, force = false): Promise<void> { return this.del(`/providers/connections/${connId}`, force ? { force: true } : undefined); } // R-093
  validateConnection(connId: Id): Promise<{ status: 'valid' | 'invalid'; validatedAt: string; errorCode?: string }> { return this.post(`/providers/connections/${connId}/validate`); } // R-094
  validateDraft(provider: ProviderKind, secret: string): Promise<{ status: 'valid'; validatedAt: string; models: CapabilityRow[]; modelsCode?: string }> { return this.post('/providers/validate', { provider, secret }); } // R-101 (dry run, nothing stored)
  testProviders(body: { connectionId?: Id; draft?: { provider: ProviderKind; secret: string }; brainstorm?: string | null; editor?: string | null }): Promise<{ items: ProbeResultDto[] }> { return this.post('/providers/test', body); } // R-102
  providerKinds(): Promise<{ items: ProviderKindInfo[] }> { return this.get('/providers/kinds'); }                          // R-103
  connectionModels(connId: Id): Promise<{ items: CapabilityRow[]; fetchedAt: string | null; stale: boolean; notice?: string }> { return this.get(`/providers/connections/${connId}/models`); } // R-095
  refreshConnectionModels(connId: Id): Promise<{ items: CapabilityRow[]; fetchedAt: string }> { return this.post(`/providers/connections/${connId}/models/refresh`); } // R-096
  getAssignments(): Promise<AssignmentsDto> { return this.get('/providers/assignments'); }                                  // R-097
  putAssignments(body: { brainstorm?: AssignmentDto | null; editor?: AssignmentDto | null; defaultConnectionId?: Id | null }): Promise<AssignmentsDto> { return this.put('/providers/assignments', body); } // R-098
  getBudget(): Promise<{ connections: Array<{ connectionId: Id; budgetMonthUsd: number | null; spentMonthUsd: number; approximate: boolean }>; projects: Array<{ projectId: Id; connectionId: Id | null; limitUsd: number | null; spentUsd: number }>; month: string }> {
    return this.get('/providers/budget');                                                                                // R-099
  }
  putBudget(body: { connections?: Array<{ connectionId: Id; budgetMonthUsd: number | null }>; projects?: Array<{ projectId: Id; connectionId?: Id | null; limitUsd: number | null }> }) { return this.put<unknown>('/providers/budget', body); } // R-100
  // ── 6.11 renders ──
  estimateRender(body: RenderCreateInput): Promise<RenderEstimate> { return this.post('/renders/estimate', body); }         // R-110
  createRender(body: RenderCreateInput, key: string = idempotencyKey(`export-${body.projectId}`)): Promise<RenderJobDto> { return this.post('/renders', body, { 'Idempotency-Key': key }); } // R-111
  listRenders(query: { projectId?: Id; status?: string; limit?: number; cursor?: string } = {}): Promise<Page<RenderJobDto>> { return this.get('/renders', query); } // R-112
  getRender(jobId: Id): Promise<RenderJobDto> { return this.get(`/renders/${jobId}`); }                                     // R-113
  cancelRender(jobId: Id): Promise<RenderJobDto> { return this.post(`/renders/${jobId}/cancel`); }                          // R-114
  renderEventsUrl(jobId: Id): string { return this.url(`/renders/${jobId}/events`); }   // R-115 (read with FetchEventSource: token in the header)
  listOutputs(id: Id): Promise<Page<OutputDto>> { return this.get(`/projects/${id}/outputs`); }                            // R-116
  getOutput(outputId: Id): Promise<OutputDto> { return this.get(`/outputs/${outputId}`); }                                 // R-117
  deleteOutput(outputId: Id): Promise<void> { return this.del(`/outputs/${outputId}`); }                                   // R-118
  revealOutput(outputId: Id): Promise<{ path: string; folder: string }> { return this.post(`/outputs/${outputId}/reveal`); } // R-119
  // ── 6.12 catalogue ──
  getCatalogue(query: { category?: string; priority?: string } = {}): Promise<{ items: CatalogueItemDto[]; catalogueVersion: string }> { return this.get('/catalogue', query); } // R-120
  searchCatalogue(q: string, query: { category?: string; lang?: 'en' | 'id' } = {}): Promise<{ items: Array<CatalogueItemDto & { score: number }>; suggestions?: string[] }> {
    return this.get('/catalogue/search', { q, ...query });                                                               // R-121
  }
  // ── 6.13 generators ──
  createGeneratorJob(id: Id, kind: GeneratorKind, body: Record<string, unknown>): Promise<GeneratorJobDto> { return this.post(`/projects/${id}/generators/${kind}`, body); } // R-130
  listGeneratorJobs(id: Id, query: { kind?: GeneratorKind; limit?: number } = {}): Promise<Page<GeneratorJobDto>> { return this.get(`/projects/${id}/generator-jobs`, query); } // R-131
  getGeneratorJob(jobId: Id): Promise<GeneratorJobDto> { return this.get(`/generator-jobs/${jobId}`); }                    // R-132
  cancelGeneratorJob(jobId: Id): Promise<GeneratorJobDto> { return this.post(`/generator-jobs/${jobId}/cancel`); }         // R-133
  insertGeneratorResult(jobId: Id, body?: { pages?: unknown[]; assetId?: Id; atMs?: number }): Promise<{ versionId: Id; notice?: string }> { return this.post(`/generator-jobs/${jobId}/insert`, body ?? {}); } // R-134
  listGenerators(): Promise<{ items: GeneratorCardDto[] }> { return this.get('/generators'); }                                // R-135
  saveGeneratorOutput(jobId: Id, assetId: Id): Promise<OutputDto> { return this.post(`/generator-jobs/${jobId}/save-output`, { assetId }); } // R-136
  deleteGeneratorJob(jobId: Id): Promise<void> { return this.del(`/generator-jobs/${jobId}`); }                            // R-137
  // ── 6.14 models ──
  listModels(): Promise<{ items: ModelStateDto[]; tier: string; totalInstalledBytes: number; diskFreeBytes: number; registry?: ModelRegistrySource }> { return this.get('/models'); } // R-140
  getModel(key: string): Promise<ModelStateDto> { return this.get(`/models/${encodeURIComponent(key)}`); }                 // R-141
  // ── FR-246 … FR-251 voices, transcripts, CC0 music library (R-138, R-139, R-215 … R-222) ──
  listVoices(language: 'id' | 'en', refresh = false): Promise<VoiceListDto> { return this.get('/voices', { language, ...(refresh ? { refresh: '1' } : {}) }); }
  /** The preview sample as a Blob (an <audio> element cannot send the Service Token; the Editor plays it from an object URL). */
  async voicePreview(voiceId: string, language: 'id' | 'en'): Promise<Blob> {
    const r = await this.fetchImpl(this.url(`/voices/${encodeURIComponent(voiceId)}/preview`, { language }), { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } });
    if (r.status !== 200) { let code = 'EM-9001'; try { code = (JSON.parse(await r.text()) as { error: { code: string } }).error.code; } catch { /* not json */ } throw new EmError(toEmCode(code), 'Preview failed', { status: r.status }); }
    return r.blob();
  }
  setElevenLabsKey(key: string): Promise<{ provider: 'elevenlabs'; secretHint: string; status: 'valid' }> { return this.put('/voice-keys/elevenlabs', { key }); }
  deleteElevenLabsKey(): Promise<void> { return this.del('/voice-keys/elevenlabs'); }
  /** FR-269 (R-217b / R-217c): Azure AI Speech key + region, Google Cloud Text-to-Speech key (checked by the Service before storing). */
  setAzureKey(key: string, region: string): Promise<{ provider: 'azure'; secretHint: string; region: string; status: 'valid' }> { return this.put('/voice-keys/azure', { key, region }); }
  deleteAzureKey(): Promise<void> { return this.del('/voice-keys/azure'); }
  setGoogleCloudKey(key: string): Promise<{ provider: 'google-cloud'; secretHint: string; status: 'valid' }> { return this.put('/voice-keys/google-cloud', { key }); }
  deleteGoogleCloudKey(): Promise<void> { return this.del('/voice-keys/google-cloud'); }
  createVoiceBatch(id: Id, body: Record<string, unknown>): Promise<GeneratorJobDto> { return this.post(`/projects/${id}/generators/voice-batch`, body); }   // R-138
  voiceTranscript(id: Id, assetId: Id): Promise<{ cues: TranscriptCueDto[]; method: string; spoken: string; written: string; durationMs: number }> { return this.get(`/projects/${id}/assets/${assetId}/transcript`); }   // R-139
  voiceTranscriptSrtUrl(id: Id, assetId: Id): string { return this.url(`/projects/${id}/assets/${assetId}/transcript`, { format: 'srt' }); }
  listMusicLibrary(query: { mood?: string; q?: string } = {}): Promise<{ items: MusicTrackDto[]; moods: string[] }> { return this.get('/music-library', query); }   // R-219
  downloadMusicTrack(trackId: string): Promise<MusicTrackDto> { return this.post(`/music-library/${encodeURIComponent(trackId)}/download`); }   // R-220
  async musicTrackAudio(trackId: string): Promise<Blob> {   // R-221
    const r = await this.fetchImpl(this.url(`/music-library/${encodeURIComponent(trackId)}/audio`), { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } });
    if (r.status !== 200) { let code = r.status === 204 ? 'EM-9001' : 'EM-7001'; try { code = (JSON.parse(await r.text()) as { error: { code: string } }).error.code; } catch { /* not json */ } throw new EmError(toEmCode(code), 'Track audio failed', { status: r.status }); }   // the Service's own code, not always "not downloaded"
    return r.blob();
  }
  insertMusicTrack(id: Id, trackId: string): Promise<{ assetId: Id; versionId: Id }> { return this.post(`/projects/${id}/music-library/${encodeURIComponent(trackId)}/insert`); }   // R-222
  installModel(key: string): Promise<ModelStateDto> { return this.post(`/models/${encodeURIComponent(key)}/install`); }    // R-142
  cancelModel(key: string, discard = false): Promise<ModelStateDto> { return this.post(`/models/${encodeURIComponent(key)}/cancel${discard ? '?discard=true' : ''}`); } // R-143 (Pause keeps the .part)
  revealModelsFolder(engine: string): Promise<{ path: string }> { return this.post(`/models/engines/${encodeURIComponent(engine)}/reveal`); } // R-146
  removeModel(key: string): Promise<void> { return this.del(`/models/${encodeURIComponent(key)}`); }                       // R-144
  // ── 6.15 hardware ──
  hardwareProfile(): Promise<HardwareProfileDto> { return this.get('/hardware/profile'); }                                  // R-150
  refreshHardware(): Promise<HardwareProfileDto> { return this.post('/hardware/profile/refresh'); }                        // R-151
  hardwareLive(): Promise<HardwareTickDto> { return this.get('/hardware/live'); }                                          // R-152
  // ── 6.16 licence ──
  getLicense(): Promise<LicenseDto> { return this.get('/license'); }                                                       // R-160
  activateLicense(key: string): Promise<LicenseDto> { return this.post('/license/activate', { key }); }                    // R-161
  deactivateLicense(): Promise<LicenseDto> { return this.post('/license/deactivate', { confirm: true }); }                 // R-162
  // ── 6.17 settings ──
  getSettings(): Promise<SettingsDto> { return this.get('/settings'); }                                                    // R-170
  putSettings(body: Partial<SettingsDto>): Promise<SettingsDto> { return this.put('/settings', body); }                    // R-171
  clearCaches(scope?: Array<'proxies' | 'thumbs' | 'stills' | 'filmstrips' | 'waveforms'>): Promise<{ freedBytes: number }> { return this.post('/settings/caches/clear', scope ? { scope } : {}); } // R-172
  // ── 6.18 diagnostics ──
  diagnosticsBundle(includeStructure = false): Promise<{ path: string; bytes: number; contents: string[] }> { return this.post('/diagnostics/bundle', { includeStructure }); } // R-180
  diagnosticsLogs(lines = 200, level = 'warn'): Promise<{ lines: string[] }> { return this.get('/diagnostics/logs', { lines, level }); } // R-181
  diagnosticsCodes(limit = 50): Promise<{ items: RecentCodeDto[] }> { return this.get('/diagnostics/codes', { limit }); }  // R-182
  // ── 7 events ──
  /** R-190 URL. SEC-016 (round 2): never carries the token; the stream is read with FetchEventSource and the Bearer header. */
  eventsUrl(opts: { projectId?: Id; hardware?: boolean } = {}): string {
    const q: string[] = [];
    if (opts.projectId) q.push(`projectId=${encodeURIComponent(opts.projectId)}`);
    if (opts.hardware) q.push('hardware=1');
    return q.length ? `${this.url('/events')}?${q.join('&')}` : this.url('/events');
  }
}

let keyCounter = 0;
/** Idempotency-Key ≤ 128 chars (API_SPECIFICATION.md §1). Stable per call site + time + counter. */
export function idempotencyKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${keyCounter}`.slice(0, 128);
}

/** Target shorthand used by the Editor when sending Design Picks. */
export const selectionTarget: ElementRefT = { kind: 'selection' };
