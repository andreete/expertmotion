// DTO types of docs/API_SPECIFICATION.md §3 (the owner). The Local Service defines them as Zod in apps/service/src/http/dto.ts
// and BLUEPRINT.md says they are re-exported from @expertmotion/shared/dto; that subpath does not exist yet, so the Editor
// mirrors them here as plain types (structure only, no logic). Replace with the shared import once it exists.
import type { ClipboardEntry, CompositionModelT, ElementRefT, OperationT, ProjectSettingsT, Ratio, Resolution, ThemeT } from '@expertmotion/composition-model';
import type { Issue } from '@expertmotion/shared';

export type { Ratio, Resolution };
export type Iso = string;
export type Id = string;
export type Fps = 24 | 25 | 30 | 50 | 60;
export type PerformanceProfile = 'standard' | 'accelerated' | 'turbo';
export type Tier = 'T0' | 'T1' | 'T2';
export type AgentKind = 'brainstorm' | 'editor';
export type Lang = 'en' | 'id';

export interface Page<T> { items: T[]; nextCursor: string | null; total?: number }

export interface OutputProfile {
  ratio: Ratio; customRatio?: { w: number; h: number }; resolution: Resolution; fps: Fps;
  format: 'mp4' | 'webm' | 'gif' | 'png' | 'wav'; codec?: 'h264' | 'vp9' | 'gif' | 'png' | 'pcm'; crf?: number; alpha?: boolean; stillAtMs?: number;
}

export interface ProjectDto {
  id: Id; name: string; settings: ProjectSettingsT; language: Lang; headVersionId: Id | null; headHash: string | null; durationMs: number;
  assetCount: number; createdAt: Iso; updatedAt: Iso; openedAt: Iso | null; dirty: boolean; warnings?: string[];
  /** R-025 sample project for the tour ("Sample · Kafe Senja" / "Contoh · Kafe Senja"); absent on ordinary projects. */
  isSample?: boolean;
  /** FR-012: Editor UI state stored by Save (R-014 `uiState`); absent until the first Save. */
  uiState?: ProjectUiState;
}
/** FR-012: what Save persists per project besides settings, head and title (not part of the Composition Model). */
export interface ProjectUiState { libMode?: 'home' | 'design' | 'tools'; playheadMs?: number; selection?: ElementRefT[]; assetSelection?: Id[] }
export type VersionCause = 'insert' | 'compile' | 'execute' | 'undo' | 'redo' | 'restore' | 'system';
export interface VersionDto { id: Id; projectId: Id; parentId: Id | null; hash: string; cause: VersionCause; planId: Id | null; durationMs: number; createdAt: Iso; model?: CompositionModelT }

export type AssetKind = 'video' | 'image' | 'audio' | 'subtitle';
export type MediaVariant = 'original' | 'playable' | 'proxy' | 'thumb' | 'filmstrip' | 'waveform';
export interface AssetDto {
  id: Id; projectId: Id; kind: AssetKind; name: string; bytes: number; sha256: string; status: 'ingesting' | 'ready' | 'failed'; progress: number;
  errorCode: string | null; durationMs: number | null; width: number | null; height: number | null; fps: number | null; hasAudio: boolean | null;
  sequenceBadge: number | null;
  /** FR-043 codec label ("H.264"); FR-048 the stored original is missing on disk. Optional: older services omit them. */
  codec?: string | null; missing?: boolean;
  media: { original: true; playable: boolean; proxy: boolean; thumb: boolean; filmstrip: boolean; waveform: boolean };
  probe?: Record<string, unknown>; createdAt: Iso; updatedAt: Iso;
}

export type RenderStatus = 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled';
export interface RenderJobDto {
  id: Id; projectId: Id; versionId: Id; outputProfile: OutputProfile; performanceProfile: PerformanceProfile; status: RenderStatus; progress: number;
  renderedFrames: number | null; totalFrames: number | null; etaMs: number | null; outputId: Id | null; errorCode: string | null; width: number | null; height: number | null;
  createdAt: Iso; startedAt: Iso | null; finishedAt: Iso | null; notices?: string[];
  /** FR-143: frame the job failed at (null = unknown / not failed). */
  failedFrame?: number | null;
  /** FR-204: the last `render.progress` stage (preparing / rendering / encoding / validating), for the progress line. */
  stage?: string;
}
export interface OutputDto {
  id: Id; projectId: Id; renderJobId: Id; kind: 'video' | 'gif' | 'still' | 'audio'; fileName: string; bytes: number; width: number | null; height: number | null;
  fps: number | null; durationMs: number | null; validated: boolean; path: string; media: { file: true; thumb: boolean }; createdAt: Iso;
}
export interface MediaGrantDto { grant: string; projectId: Id; kind: 'preview'; expiresAt: Iso; baseUrl: string }

export type IntentCategory = 'transition' | 'caption' | 'background' | 'motion' | 'shape' | 'easing' | 'effect' | 'audio' | 'text' | 'layout' | 'output' | 'asset' | 'generate';
/** `held` (FR-037): waits for a model that is not installed (EM-2104); resumes on model.installed. */
export type IntentStatus = 'queued' | 'superseded' | 'compiled' | 'planned' | 'executed' | 'rejected' | 'removed' | 'held';
export interface EditIntent {
  id: Id; projectId: Id; source: 'ui' | 'brainstorm' | 'chat' | 'system'; createdAt: Iso; category: IntentCategory; presetId?: string; params: Record<string, unknown>;
  target: ElementRefT; resolvedTargets: ElementRefT[]; propertyKey: string; parentIntentId?: string; propertyClass: 'scalar' | 'list' | 'exclusive-group';
  needsInterpretation: boolean; instruction?: string; status: IntentStatus; restoredAt?: Iso; rejectionReason?: string; supersedes: string[]; baseVersion: string;
  /** AI_WORKFLOW §3: ordinal of the Composition Version that applied the intent ("Applied in v{n}" grouping). */
  appliedVersion?: number;
  /** AI_WORKFLOW §3: hash of that Composition Version (FR-085 shows it short). */
  appliedHash?: string;
  /** FR-167 (R-061): the applying version left the head's lineage (Undo) — the queue chip shows "undone". */
  undone?: boolean;
}
export interface IntentQueueDto { projectId: Id; headHash: string; items: EditIntent[]; lockedKeys: string[] }

export interface PlanStep { n: number; tool: string; ops: OperationT[]; args: Record<string, unknown>; expectedDiff: string; dependsOn: number[]; /** ops omitted (withOps=false) */ opCount?: number }
export interface Risk { code: string; message: string; severity: 'info' | 'warn' | 'block' }
export interface Usage { model: string; inputTokens: number; outputTokens: number; costUsd: number | null; approximate: boolean }
export type PlanStatus = 'draft' | 'valid' | 'invalid' | 'stale' | 'executing' | 'executed' | 'failed' | 'cancelled';
export interface PlanDto {
  id: Id; projectId: Id; baseVersion: string; origin: 'compile' | 'editor-agent'; goal: string; steps: PlanStep[]; touchesLockedKeys: string[]; risks: Risk[];
  notes?: string; status: PlanStatus; validation: Array<{ path: string; message: string; code: string }>; usage?: Usage; stale?: boolean; headHash?: string;
  /** Error code of a failed execution or interrupted run (Editor-side; filled from plan.invalid / ExecutionResult). */
  errorCode?: string;
  /** FR-086: summary of the ExecutionResult once executed (R-071 PlanDto `result`). */
  result?: PlanResultSummary | null;
  /** QA 2026-10-28 #17 (Editor-side): the removals the Creator must confirm before Execute (EM-4310). */
  confirmRemoval?: Array<{ op: string; label: string }> | undefined;
  /** FR-223 (Editor-side): live state of the generator steps after Execute (service.notice kind plan-step). */
  stepStatus?: Record<number, { status: string; code?: string }>;
  /** FR-223 (Editor-side): the current Execute phase (plan.progress). */
  execPhase?: { phase: 'voice' | 'measure' | 'compose' | 'apply' | 'failed'; done?: number; total?: number; totalMs?: number; since: number };
}
export interface PlanResultSummary { ok: boolean; toVersion: string | null; appliedOps: number; added: number; removed: number; modified: number; toolSteps?: ToolStepResult[]; /** FR-222 "Lihat di timeline" */ addedIds?: string[] }
/** R-073: generator steps of a plan (tts.generate, captions.generate) started after the Composition Version was committed. */
export interface ToolStepResult { n: number; tool: string; status: 'started' | 'skipped' | 'done' | 'failed'; jobId?: Id; code?: string }
export interface ExecutionResult {
  planId: Id; ok: boolean; fromVersion: string; toVersion?: string; appliedOps: number; diff: ElementDiff[];
  error?: { code: string; message: string; step?: number; path?: string }; rollback?: { performed: boolean; toVersion: string }; durationMs: number; notice?: string; toolSteps?: ToolStepResult[];
}
export interface ElementDiff { elementId: string; change: 'added' | 'removed' | 'modified'; fields: string[] }
export interface CheckpointDto { id: Id; projectId: Id; versionId: Id; reason: 'autosave' | 'pre-execute' | 'pre-render' | 'manual'; createdAt: Iso; durationMs: number; hash?: string; bytes?: number }
/** R-017/R-018 fields beside ProjectSettings (FR-009, FR-015). */
export interface ProjectSettingsExtras { durationPolicy?: 'fit-content' | 'fixed'; fixedDurationMs?: number; outputFolder?: string | null }
/** R-026 (FR-178, FR-017). */
export interface DiskUsageItem { projectId: Id; mediaBytes: number; checkpointBytes: number; outputsBytes: number; outputCount: number; totalBytes: number; backupBytes: number; backupOutputsBytes: number }
export interface DiskUsageDto { items: DiskUsageItem[]; totalBytes: number; freeBytes: number }
/** R-003 restart recovery summary (FR-171, FR-172). */
export interface RecoverySummaryDto {
  startedAt: Iso; unclean: boolean; renders: Array<{ jobId: Id; projectId: Id }>; agentRuns: Array<{ runId: Id; projectId: Id; agent: string }>;
  ingests: Array<{ assetId: Id; projectId: Id; name: string }>; plans: Array<{ planId: Id; projectId: Id }>; checkpoints: { offered: Id[]; imported: Id[] };
}

export type ProviderKind = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'custom';
export interface ConnectionDto {
  id: Id; provider: ProviderKind; label: string; baseUrl: string | null; secretHint: string; status: 'unvalidated' | 'valid' | 'invalid'; validatedAt: Iso | null;
  modelsFetchedAt: Iso | null; budgetMonthUsd: number | null; createdAt: Iso; updatedAt: Iso;
  /** FR-109: rows in the cached Capability Table (null = never fetched). */
  modelCount?: number | null;
}
/** Capability Table row (FR-114): capability facts are tri-state; `null` = the provider did not report it ("?", never guessed). */
export interface CapabilityRow {
  modelId: string; label: string; contextLength: number | null; toolCalling: boolean | null; structuredOutput: boolean | null; streaming: boolean | null; imageInput: boolean | null;
  pricePerMInput: number | null; pricePerMOutput: number | null;
}
/** R-103 provider facts for the Add form (FR-111, FR-112). */
export interface ProviderKindInfo { provider: ProviderKind; enabled: boolean; priority: 'P0' | 'P1' | 'P2'; termsUrl: string | null; keyPattern: string | null; keyExample: string | null }
/** R-102 one row per agent (FR-116). */
export interface ProbeResultDto { agent: AgentKind; modelId: string; ok: boolean; latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number | null; approximate: boolean; code?: string; reason?: string }
/** FR-130 workload row (inside HardwareTickDto.workload.items). */
export interface WorkloadItemDto { kind: 'render' | 'download' | 'ingest' | 'generator' | 'agent'; id: string; label: string; displayName?: DisplayNameDto; status: string; progress: number | null; cancellable: boolean; pausedReason: 'render' | null }
export interface AssignmentDto { agent: AgentKind; connectionId: Id; modelId: string; settings: { temperature?: number; maxTokens?: number; effort?: 'low' | 'medium' | 'high' } }
export interface AssignmentsDto { brainstorm: AssignmentDto | null; editor: AssignmentDto | null; defaultConnectionId: Id | null; warnings?: Issue[] }
export interface UsageNumbers { inputTokens: number; outputTokens: number; costUsd: number | null; approximate: boolean; contextLength: number | null }
export interface AgentRunDto {
  id: Id; projectId: Id; agent: AgentKind; status: 'running' | 'done' | 'failed' | 'cancelled'; modelId: string; connectionId: Id | null; planId: Id | null;
  errorCode: string | null; usage: UsageNumbers | null; startedAt: Iso; finishedAt: Iso | null;
}
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'proposed_intents'; intents: EditIntent[]; handoffState: 'pending' | 'sent' | 'dismissed' }
  | { type: 'attachment'; assetId?: Id; /** FR-221 */ documentId?: Id; mime: string; name: string; /** FR-213: `name` = the model cannot read images; only the file name was sent; FR-221 `text` = a document's text was sent */ sent?: 'image' | 'name' | 'text'; chars?: number; truncated?: boolean }
  | { type: 'targets'; items: ChatTarget[] }
  /** FR-216: the web sources of an answer (links) and the searches it ran. */
  | { type: 'sources'; items: WebSourceDto[]; queries?: string[] }
  /** FR-217: openly licensed picture candidates; the Creator imports one (R-089). */
  | { type: 'image_candidates'; items: ImageCandidateDto[] }
  /** A notice with its EM code (research could not run, …). */
  | { type: 'notice'; code: string; text: string }
  /** FR-219: an Editor message that came from a Brainstorm draft. */
  | { type: 'origin'; from: 'brainstorm'; messageId: Id; auto?: boolean }
  /** FR-219: a Brainstorm draft handed to the Editor; the state follows the Editor run. */
  | { type: 'handoff'; draftTitle: string; editorMessageId?: Id; editorRunId?: Id; state: 'sent' | 'planning' | 'ready' | 'applied' | 'failed'; scenes?: number };
export interface WebSourceDto { url: string; title?: string; citedText?: string; pageAge?: string; cited?: boolean }
export interface ImageCandidateDto { source: 'openverse' | 'wikimedia'; id: string; title: string; creator: string | null; license: string; licenseVersion: string | null; licenseUrl: string | null; landingUrl: string | null; width: number | null; height: number | null; provider: string | null; importedAssetId?: Id }
export interface ChatDocumentDto { id: Id; name: string; kind: 'pdf' | 'docx' | 'text'; chars: number; truncated: boolean; pages?: number; warnings: string[] }
/** QA 2026-10-26 #6 (pointing): an asset or Timeline element the Creator pointed the assistant at ("@Klip 2"). */
export type ChatTargetKind = 'asset' | 'clip' | 'text' | 'image' | 'shape' | 'audio' | 'cut' | 'caption';
/** FR-220: a `caption` chip is one caption page (`index`) with its time range. */
export interface ChatTarget { kind: ChatTargetKind; id?: string; index?: number; label: string; startMs?: number; endMs?: number }
/** FR-214: `sending` = Send pressed, the Service has not answered yet; `thinking` / `writing` come from the provider stream. */
export type AgentPhase = 'sending' | 'reading' | 'planning' | 'checking' | 'correcting' | 'tool' | 'waiting' | 'thinking' | 'writing';
export interface MessageDto { id: Id; role: 'user' | 'assistant' | 'system' | 'tool'; blocks: MessageBlock[]; agentRunId: Id | null; createdAt: Iso }
export interface ConversationDto {
  conversationId: Id; agent: AgentKind; summary: unknown; assignment: AssignmentDto | null; contextUsage: { usedTokens: number; contextLength: number } | null; messages: Page<MessageDto>;
}
export interface HardwareProfileDto {
  tier: Tier; cpuModel: string | null; cpuThreads: number; ramTotalMb: number; gpuVendor: string | null; gpuModel: string | null; vramMb: number | null; nvenc: boolean;
  detectedAt: Iso; warnings: string[];
}
export interface HardwareTickDto {
  at: Iso; cpuPercent: number; ramFreeMb: number; ramTotalMb: number; processMb: number; chromeMb: number | null; shellMb?: number | null; diskFreeMb: number | null; gpuPercent: number | null;
  /** FR-127: free space on the drive of the output folder. */
  outputDiskFreeMb?: number | null;
  workload: { rendering: boolean; ingesting: number; downloading: number; agentRuns: number; items?: WorkloadItemDto[] };
}
export type LicenseStatus = 'licensed' | 'unlicensed' | 'invalid' | 'revoked' | 'machine-mismatch';
export interface LicenseDto {
  /** no Trial Mode: only `licensed` unlocks the Editor; every other state shows the licence screen alone (EM-5010 from the Service) */
  status: LicenseStatus; tier: string | null; licenseeHash: string | null; updatesUntil: Iso | null; updatesEligible: boolean; machineCode: string;
  warnings?: string[]; code?: string | null; licenseeName?: string | null; clockAnomaly?: boolean;
}
export interface SettingsDto {
  privateMode: boolean; outputFolder: string; autoPlan: boolean; /** FR-216 "Izinkan riset internet" (default on) */ webResearch?: boolean; uiLanguage: Lang; theme: 'dark' | 'light' | 'system'; defaultPerformanceProfile: PerformanceProfile;
  defaultRatio: Ratio; defaultResolution: Resolution; defaultFps: Fps; checkUpdates: boolean; diagnosticsIncludeStructure: boolean;
  /** FR-004 onboarding record (server-side); absent on older services / the mock. */
  onboardingDone?: boolean; onboardingSkippedSteps?: OnboardingStep[];
  /** FR-099 / FR-155: Editor layout (panel sizes per window-width bucket, collapsed panels); absent until first saved. */
  layout?: { panelSizes: Partial<Record<'narrow' | 'standard' | 'wide', { lib?: number; agent?: number; timeline?: number }>>; libCollapsed: boolean; agentCollapsed: boolean; outputCollapsed: boolean; chatSplit?: number; chatMaximized?: 'brainstorm' | 'editor' | null };
}
/** 'license' is no longer a step (licence screen before onboarding); old records may still contain it and are ignored. */
export type OnboardingStep = 'provider' | 'models' | 'hardware' | 'tour';
export type ModelTask = 'stt' | 'tts' | 'image' | 'music';
/** Creator-facing product name of a Local Model (Model Manager rows, Generators, toasts); `label` stays the upstream name. */
export interface DisplayNameDto { en: string; id: string }
export interface ModelStateDto {
  key: string; engine: string; version: string; task: ModelTask; label: string; displayName?: DisplayNameDto; flag?: string | null; licence: { name: string; url: string }; tiers: Tier[]; bytesTotal: number; bytesDone: number;
  status: 'not-installed' | 'downloading' | 'verifying' | 'paused' | 'installed' | 'failed'; errorCode: string | null; installedAt: Iso | null;
  // FR-120…FR-124 model card (optional: older services omit them)
  pausedReason?: 'render' | null; recommended?: boolean; priority?: 'P1' | 'P2'; languages?: string[]; notes?: string[]; commercialUse?: 'yes' | 'conditional' | 'no';
  licenceDetail?: { spdx: string | null; redistribution: 'yes' | 'no' | 'verify'; useRestrictions: string | null }; hashes?: Array<{ name: string; sha256: string | null }>;
  pathLabel?: string; usedBy?: { generators: string[]; presets: string[] }; engineNotices?: Array<{ label: string; licence: string; spdx: string | null; url: string }>;
  /** FR-245 (Editor state only): the running retry and the reason of the last failure. */
  retry?: { attempt: number; reason: string; delayMs: number; at: number } | null; failReason?: string | null;
}
/** R-140 `registry` (SEC-072): which model list is in use. */
export interface ModelRegistrySource { source: 'built-in' | 'signed'; seq: number; code: string | null; reason: string | null }
export type GeneratorKind = 'voice' | 'music' | 'thumbnail' | 'captions' | 'hashtags';
export interface GeneratorJobDto {
  id: Id; projectId: Id; kind: GeneratorKind; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; modelKey: string | null; resultAssetId: Id | null;
  result: Record<string, unknown> | null; errorCode: string | null; createdAt: Iso; startedAt: Iso | null; finishedAt: Iso | null;
}

/** R-215 (FR-246): one narrator voice. `availability` says why it cannot run yet (model-missing → install; no-connection → Providers / ElevenLabs key; private-mode). */
export interface VoiceDto {
  id: string; provider: 'local' | 'openai' | 'gemini' | 'elevenlabs'; name: string; gender: 'female' | 'male' | 'neutral'; traits: { id: string[]; en: string[] }; languages: string[];
  modelKey?: string; pitch?: number; model?: string; voice?: string; cloud: boolean; supports: { speed: boolean; pitch: boolean; style: boolean }; usdPer1kChars?: number;
  note?: { id: string; en: string }; availability: 'ready' | 'model-missing' | 'private-mode' | 'no-connection'; installed: boolean;
}
export interface VoiceListDto { items: VoiceDto[]; privateMode: boolean; elevenLabsKey: string | null }
/** R-219 (FR-247): one CC0 library track. */
export interface MusicTrackDto {
  id: string; title: string; artist: string; mood: string; genre: string; bpm: number; durationS: number; bytes: number; credit: string; status: 'not-downloaded' | 'downloading' | 'ready' | 'failed';
  bytesDone: number; errorCode: string | null; licence: { spdx: string; name: string; url: string; proofUrl: string };
}
/** R-139 (FR-249): a voice clip's timed transcript (times relative to the clip start). */
export interface TranscriptCueDto { index: number; text: string; written: string; fromMs: number; toMs: number; words: Array<{ text: string; fromMs: number; toMs: number }> }
/** R-135 Generator Card (FR-100, FR-107). */
export interface GeneratorModelDto { key: string; label: string; displayName?: DisplayNameDto; bytes: number; installed: boolean; languages: string[]; minTier: Tier; belowTier: boolean; cc0: boolean }
export interface GeneratorCardDto {
  kind: GeneratorKind; enabled: boolean; priority: 'P1' | 'P2'; llm: boolean; tierHint: 'ok' | 'slow'; model: GeneratorModelDto | null; models: GeneratorModelDto[]; tier?: Tier;
}
/** R-182 recent EM codes (FR-150). */
export interface RecentCodeDto { at: Iso; code: string; source: 'render' | 'generator' | 'agent' | 'log'; ref: string | null }

export interface HealthDto {
  status: 'ok'; version: string; mode: 'production' | 'development'; uptimeMs: number; tier?: Tier; licence?: Pick<LicenseDto, 'status' | 'tier' | 'updatesEligible'>;
  privateMode?: boolean; engine?: { bundleVersion: string; remotionVersion: string | null; browserReady: boolean; ffmpeg: boolean; ok?: boolean; code?: string }; db?: { schemaVersion: number | null; ok: boolean };
  buildDate?: string;
  workload?: { rendering: boolean; ingesting: number; agentRuns: number; downloading: number }; seq?: number;
}

// ── request bodies ──
/** ADR-028 / FR-179: cut at the playhead (op:element.split per item). */
export interface SplitEdit { atMs: number; items: Array<{ kind: 'clip' | 'text' | 'image' | 'shape' | 'audio'; id: Id }> }
/** ADR-028 / FR-180: picture position / zoom / rotation (op:element.setTransform); x / y fractions of the frame, scale 1 = fit, degrees. */
export interface TransformEdit { kind: 'clip' | 'image' | 'shape'; id: Id; x?: number; y?: number; scale?: number; rotation?: number }
/** ADR-031 / FR-192 / FR-193: Delete or Duplicate Timeline items (R-060 `itemsEdit`; effect ids `<clipId>|<presetId>`). */
export interface ItemsEdit { action: 'remove' | 'duplicate' | 'paste'; items: Array<{ kind: 'clip' | 'text' | 'image' | 'shape' | 'audio' | 'cut' | 'effect' | 'background' | 'caption'; id?: string; index?: number }>;
  /** FR-256: Paste — in-app clipboard snapshots rebuilt at `atMs` (items empty). */
  paste?: { atMs: number; entries: ClipboardEntry[] } }
export interface ElementEdit { kind: 'text' | 'image' | 'shape' | 'audio'; id: Id; atMs?: number; durationMs?: number; trimBeforeMs?: number; layer?: number; move?: 'up' | 'down' | 'front' | 'back' }
export interface DesignPickInput {
  source: 'ui' | 'chat'; category: IntentCategory; presetId?: string; params?: Record<string, unknown>; target: ElementRefT; selection?: ElementRefT[]; playheadMs?: number;
  instruction?: string; baseVersion: string; plan?: 'auto' | 'none';
  /** Output Settings pick (FR-087…FR-097): compiled to op:output.setRatio / .setResolution / .setAutoRatio; `performanceProfile` is a zero-op settings intent (FR-090). */
  output?: { kind: 'ratio' | 'resolution' | 'fps' | 'autoRatio' | 'performanceProfile'; value: unknown; customRatio?: { w: number; h: number } };
  /** FR-068 (P1): Timeline drag on the video Track. */
  clipEdit?: { clipId: Id; toIndex?: number; trimBeforeMs?: number; durationMs?: number };
  /** ADR-027 / FR-068: Timeline drag / trim / lane change / layer key on a text, image, shape or audio layer. */
  elementEdit?: ElementEdit;
  /** ADR-028: Timeline scissors / S (FR-179) and Player handles / Inspector transform fields (FR-180). */
  splitEdit?: SplitEdit;
  transformEdit?: TransformEdit;
  itemsEdit?: ItemsEdit;
  /** Deterministic Text Panel field pick (FR-020…FR-028; `content` edits the selected text, FR-027). */
  field?: string; value?: unknown;
  /** FR-027 Add Text content (with a `preset:text.*` variant). */
  text?: string;
}
export interface IntentCreateResponse { intent: EditIntent; queue: IntentQueueDto; superseded: string[]; appliedVersion: VersionDto | null; planId: Id | null; notices: Array<{ code: string }> }
export interface OpenProjectResponse {
  project: ProjectDto; head: VersionDto; mediaGrant: MediaGrantDto; checkpointNewerThanSave: CheckpointDto | null; intentQueue: IntentQueueDto; latestPlan: PlanDto | null; renderJobs: RenderJobDto[];
}
export interface CompositionHeadResponse { head: VersionDto; canUndo: boolean; canRedo: boolean; timing: { durationMs: number; cutStartMs: number[] }; issues: Issue[] }
export interface RenderCreateInput { projectId: Id; versionId?: Id; outputProfile: OutputProfile; performanceProfile: PerformanceProfile; fileName?: string; folder?: string }
export type PreflightCheckName = 'disk' | 'memory' | 'dimensions' | 'duration' | 'assets' | 'engine' | 'folder';
export interface RenderEstimate {
  ok: boolean; dimensions: { width: number; height: number }; totalFrames: number; durationMs: number;
  estimate: { seconds: number | null; bytes: number | null; confidence: 'low' | 'medium' | 'high' };
  checks: Array<{ check: PreflightCheckName; ok: boolean; code?: string; details?: unknown }>; effectiveProfile: OutputProfile; warnings: Issue[];
  notices?: string[]; defaultFileName?: string; privateMode?: boolean; queue?: { active: Id | null; queued: number };
}
export interface CatalogueItemDto {
  id: string; category: string; label: { en: string; id: string }; tags: string[]; propertyClass: string; priority: string; flags: string[]; preview: string;
  paramsSchema: Record<string, unknown>; defaults: Record<string, unknown>; availability: { ok: boolean; reason?: 'gpu' | 'webgpu' | 'model-missing' | 'licence'; code?: string };
}
export interface ProjectCreateInput { name: string; settings?: Partial<ProjectSettingsT>; language?: Lang; theme?: Partial<ThemeT>; durationPolicy?: 'fit-content' | 'fixed'; fixedDurationMs?: number; outputFolder?: string }

// ── SSE ──
export interface EventEnvelope { seq: number; at: Iso; projectId?: Id }
export interface EventMap {
  'intent.updated': { queue: IntentQueueDto; changed: Id[]; reason: string };
  'plan.ready': { plan: PlanDto; runId?: Id };
  'plan.invalid': { planId: Id; status: 'invalid' | 'stale' | 'failed' | 'cancelled'; code: string; validation: Issue[]; touchesLockedKeys: string[] };
  'composition.updated': { version: VersionDto; previousHash: string | null; diff: ElementDiff[]; cause: VersionCause; canUndo: boolean; canRedo: boolean; durationMs: number; issues: Issue[] };
  'render.queued': { job: RenderJobDto };
  'render.progress': { jobId: Id; progress: number; renderedFrames: number; totalFrames: number; etaMs: number | null; stage: string };
  'render.done': { jobId: Id; output: OutputDto; notices: string[] };
  'render.failed': { jobId: Id; code: string; percent: number; frame?: number | null };
  'render.cancelled': { jobId: Id; percent: number };
  'ingest.progress': { assetId: Id; stage: string; progress: number };
  'ingest.done': { asset: AssetDto };
  'ingest.failed': { assetId: Id; code: string; name: string; existingAssetId?: Id };
  'agent.run.started': { run: AgentRunDto; agent: AgentKind; modelId: string; planId?: Id };
  'agent.run.delta': { runId: Id; agent: AgentKind; delta: string; toolCall?: { name: string; input: unknown } };
  'agent.run.done': { run: AgentRunDto; message: MessageDto; usage: UsageNumbers | null; contextUsage: { usedTokens: number; contextLength: number } | null };
  'agent.run.progress': { runId: Id; agent: AgentKind; phase: AgentPhase; attempt?: number; of?: number; waitMs?: number; tool?: string; /** FR-216 */ query?: string; url?: string };
  /** FR-223 / FR-224: Execute phases of a plan (voice clips first, measure, compose, apply). */
  'plan.progress': { planId: Id; phase: 'voice' | 'measure' | 'compose' | 'apply' | 'failed'; done?: number; total?: number; totalMs?: number };
  /** FR-219: a stored message changed (a Brainstorm draft's hand-off state). */
  'agent.message.updated': { agent: AgentKind; message: MessageDto };
  'agent.run.failed': { runId: Id; agent: AgentKind; code: string; retryable: boolean; message?: string; details?: Record<string, unknown> };
  'model.progress': { key: string; bytesDone: number; bytesTotal: number; status: 'downloading' | 'verifying' | 'paused'; pausedReason?: 'render'; /** FR-245: an automatic retry is waiting */ retry?: { attempt: number; reason: string; delayMs: number } };
  'model.installed': { model: ModelStateDto };
  'model.failed': { key: string; code: string; /** FR-245 */ reason?: string; httpStatus?: number; percent?: number; resumable?: boolean };
  'hardware.tick': HardwareTickDto;
  'license.changed': { licence: LicenseDto };
  'settings.changed': { scope: string; settings?: SettingsDto; privateMode?: boolean };
  'service.notice': { kind: string; code?: string; jobId?: Id; percent?: number; done?: boolean; path?: string; projectId?: Id; [k: string]: unknown };
}
export type EventName = keyof EventMap;
export const EVENT_NAMES: readonly EventName[] = [
  'intent.updated', 'plan.ready', 'plan.invalid', 'composition.updated', 'render.queued', 'render.progress', 'render.done', 'render.failed', 'render.cancelled',
  'ingest.progress', 'ingest.done', 'ingest.failed', 'agent.run.started', 'agent.run.delta', 'agent.run.progress', 'agent.run.done', 'agent.run.failed', 'agent.message.updated', 'plan.progress', 'model.progress', 'model.installed',
  'model.failed', 'hardware.tick', 'license.changed', 'settings.changed', 'service.notice',
];
export type ServiceEvent = { [K in EventName]: { name: K; data: EventMap[K] & EventEnvelope } }[EventName];
