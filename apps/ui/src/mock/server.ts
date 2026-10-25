// Mock mode (VITE_EM_MOCK=1): an in-memory fake of the Local Service behind a fetch-compatible function, so the Editor's
// real ApiClient and SSE client run unchanged. Composition changes go through packages/composition-model applyOperations
// (Design Picks really change the model); Compile uses packages/catalogue compileDefaults. Agent runs are scripted (no LLM).
// This is a development and test harness, not a specification: the Local Service (apps/service) is the source of truth.
import {
  applyOperations, createEmptyModel, deriveTiming, hashModel, DEFAULT_SETTINGS,
  type AssetFacts, type CompositionModelT, type ElementRefT, type OperationT, type ProjectSettingsT,
} from '@expertmotion/composition-model';
import { compileDefaults, getPreset, listPresets, type Category } from '@expertmotion/catalogue';
import { newId } from '@expertmotion/shared';
import { resolveDimensions } from '@expertmotion/engine/formats';
import type {
  AgentKind, AssetDto, AssignmentDto, CapabilityRow, CatalogueItemDto, CheckpointDto, ConnectionDto, DesignPickInput, EditIntent, ExecutionResult,
  GeneratorJobDto, HardwareProfileDto, IntentCategory, IntentQueueDto, LicenseDto, MediaGrantDto, MessageBlock, MessageDto, ModelStateDto, OutputDto,
  PlanDto, ProjectDto, RenderCreateInput, RenderJobDto, SettingsDto, VersionCause, VersionDto,
} from '../api/types.js';
import type { MediaResolver } from '../api/client.js';
import { MockBus } from './MockEventSource.js';

export const MOCK_TOKEN = 'mock-service-token-0000';
export const MOCK_BASE = 'http://127.0.0.1:4110';

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
const nowIso = () => new Date().toISOString();

interface ProjectState {
  dto: ProjectDto;
  versions: Map<string, VersionDto & { model: CompositionModelT }>;
  chain: string[];           // linear head history (version ids)
  pointer: number;           // index of the head in chain
  assets: AssetDto[];
  intents: EditIntent[];
  plans: PlanDto[];
  results: Map<string, ExecutionResult>;
  messages: Record<AgentKind, MessageDto[]>;
  usage: Record<AgentKind, { usedTokens: number; contextLength: number } | null>;
  checkpoints: CheckpointDto[];
  outputs: OutputDto[];
  /** Head not yet covered by a checkpoint (drives checkpointNewerThanSave; FR-173 keeps it out of `dto.dirty`). */
  headUnsaved?: boolean;
  genJobs: GeneratorJobDto[];
  grant: MediaGrantDto;
  /** FR-052: removed (soft-deleted) assets kept while a version still uses them; Undo brings them back. */
  removed?: AssetDto[];
}

export interface MockOptions { seed?: 'sample' | 'empty'; delays?: boolean; bus?: MockBus; onboardingDone?: boolean;
  /** start licensed (default true, so Editor tests boot straight in); false = first launch, licence screen only (no Trial Mode) */
  licensed?: boolean;
  /** FR-037 test seam: the `model:<id>` flag of a preset (no P0 preset carries one yet). */
  modelFlagOf?: (presetId: string) => string | undefined }
export interface MockServer { fetch: (input: string, init?: RequestInit) => Promise<Response>; mediaResolver: MediaResolver; bus: MockBus; token: string; baseUrl: string; firstProjectId: () => string | null }

// ───────────────────────── sample media (SVG data URLs, so the Player shows something without files) ─────────────────────────
function sampleImage(label: string, a: string, b: string, w = 1080, h = 1920): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" font-family="Inter, sans-serif" font-size="${Math.round(w / 9)}" font-weight="700" fill="#ffffff" fill-opacity="0.85" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const KIND_BY_EXT: Record<string, AssetDto['kind']> = {
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
  mp3: 'audio', wav: 'audio', aac: 'audio', m4a: 'audio', ogg: 'audio', srt: 'subtitle', vtt: 'subtitle',
};

const CAPABILITIES: CapabilityRow[] = [
  { modelId: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', contextLength: 200_000, toolCalling: true, structuredOutput: true, streaming: true, imageInput: true, pricePerMInput: 3, pricePerMOutput: 15 },
  { modelId: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini', contextLength: 1_000_000, toolCalling: true, structuredOutput: true, streaming: true, imageInput: true, pricePerMInput: 0.4, pricePerMOutput: 1.6 },
  { modelId: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextLength: 1_000_000, toolCalling: true, structuredOutput: true, streaming: true, imageInput: true, pricePerMInput: 0.3, pricePerMOutput: 2.5 },
  { modelId: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', contextLength: 131_072, toolCalling: false, structuredOutput: false, streaming: true, imageInput: false, pricePerMInput: null, pricePerMOutput: null },
  { modelId: 'qwen/qwen-2.5-7b-instruct', label: 'Qwen 2.5 7B', contextLength: 32_768, toolCalling: true, structuredOutput: true, streaming: true, imageInput: false, pricePerMInput: 0.04, pricePerMOutput: 0.1 },   // text-only (EM-4307)
  { modelId: 'mistralai/mistral-small', label: 'Mistral Small', contextLength: 32_000, toolCalling: null, structuredOutput: null, streaming: true, imageInput: null, pricePerMInput: 0.1, pricePerMOutput: 0.3 },   // capabilities not reported (FR-114)
];

export function createMockServer(opts: MockOptions = {}): MockServer {
  const bus = opts.bus ?? new MockBus();
  const delays = opts.delays ?? true;
  const later = (ms: number, fn: () => void) => { if (delays) setTimeout(fn, ms); else queueMicrotask(fn); };

  const projects = new Map<string, ProjectState>();
  const media = new Map<string, string>();                       // assetId/outputId → URL
  const renders: RenderJobDto[] = [];
  const cancelledRenders = new Set<string>();
  let settings: SettingsDto = {
    privateMode: false, outputFolder: 'C:\\Users\\septi\\Videos\\Expertmotion', autoPlan: false, uiLanguage: 'en', theme: 'dark', defaultPerformanceProfile: 'standard',
    defaultRatio: '9:16', defaultResolution: '1080p', defaultFps: 30, checkUpdates: true, diagnosticsIncludeStructure: false,
  };
  const UNLICENSED: LicenseDto = { status: 'unlicensed', tier: null, licenseeHash: null, licenseeName: null, updatesUntil: null, updatesEligible: false, machineCode: 'MC1-7Q4K-2M9X-HV3T-8PZD', clockAnomaly: false };
  const licensedDto = (): LicenseDto => ({ ...UNLICENSED, status: 'licensed', tier: 'standard', licenseeHash: 'a1b2c3', licenseeName: 'Septianus Angga', updatesUntil: new Date(Date.now() + 365 * 86400_000).toISOString(), updatesEligible: true });
  let license: LicenseDto = opts.licensed === false ? UNLICENSED : licensedDto();
  const hardware: HardwareProfileDto = { tier: 'T0', cpuModel: 'Intel Core i5-1135G7', cpuThreads: 8, ramTotalMb: 16_384, gpuVendor: 'Intel', gpuModel: 'Iris Xe (shared)', vramMb: null, nvenc: false, detectedAt: nowIso(), warnings: [] };
  const connections: ConnectionDto[] = [];
  const assignments: { brainstorm: AssignmentDto | null; editor: AssignmentDto | null; defaultConnectionId: string | null } = { brainstorm: null, editor: null, defaultConnectionId: null };
  const projectBudgets = new Map<string, number | null>();   // key `${projectId}|${connectionId ?? ''}` (FR-117 per connection)
  const models: ModelStateDto[] = [
    { key: 'whisper-small', engine: 'whisper.cpp', version: '1.7', task: 'stt', label: 'Whisper small (captions)', displayName: { en: 'Auto Captions — Fast', id: 'Teks Otomatis — Cepat' }, licence: { name: 'MIT', url: 'https://github.com/openai/whisper' }, tiers: ['T0', 'T1', 'T2'], bytesTotal: 488_000_000, bytesDone: 0, status: 'not-installed', errorCode: null, installedAt: null, recommended: true, languages: ['id', 'en'], commercialUse: 'yes', usedBy: { generators: ['captions'], presets: [] }, pathLabel: 'models\\whisper.cpp\\whisper-small\\' },
    { key: 'whisper-large-v3-turbo', engine: 'whisper.cpp', version: '1.7', task: 'stt', label: 'Whisper large v3 turbo', displayName: { en: 'Auto Captions — Accurate', id: 'Teks Otomatis — Akurat' }, licence: { name: 'MIT', url: 'https://github.com/openai/whisper' }, tiers: ['T1', 'T2'], bytesTotal: 1_620_000_000, bytesDone: 0, status: 'not-installed', errorCode: null, installedAt: null },
    { key: 'piper-id-news', engine: 'sherpa-onnx', version: '1.10', task: 'tts', label: 'Piper Indonesian voice', displayName: { en: 'Indonesian Voice', id: 'Suara Indonesia' }, licence: { name: 'MIT', url: 'https://github.com/rhasspy/piper' }, tiers: ['T0', 'T1', 'T2'], bytesTotal: 63_000_000, bytesDone: 0, status: 'not-installed', errorCode: null, installedAt: null, recommended: true, languages: ['id'], commercialUse: 'yes',
      licenceDetail: { spdx: 'MIT', redistribution: 'verify', useRestrictions: null }, hashes: [{ name: 'id_ID-news_tts-medium.onnx', sha256: null }],
      pathLabel: 'models\\sherpa-onnx\\piper-id-news\\', usedBy: { generators: ['voice'], presets: [] }, notes: ['dataset licence unverified (RISK-002)'],
      engineNotices: [{ label: 'espeak-ng phonemiser data', licence: 'GPL-3.0-or-later (espeak-ng)', spdx: 'GPL-3.0-or-later', url: 'https://github.com/espeak-ng/espeak-ng' }] },
    { key: 'sd15-q8', engine: 'stable-diffusion.cpp', version: '0.4', task: 'image', label: 'Stable Diffusion 1.5 (thumbnails)', displayName: { en: 'Image Generator — Standard', id: 'Generator Gambar — Standar' }, licence: { name: 'CreativeML OpenRAIL-M', url: 'https://huggingface.co/runwayml' }, tiers: ['T0', 'T1', 'T2'], bytesTotal: 2_100_000_000, bytesDone: 0, status: 'not-installed', errorCode: null, installedAt: null },
  ];
  const cancelledDownloads = new Set<string>();
  const captionStore = new Map<string, Array<{ text: string; startMs: number; durationMs: number; tokens: [] }>>();   // subtitle assetId → parsed pages
  const startedAt = Date.now();

  // ───────────────────────── helpers ─────────────────────────
  const emit = (name: string, payload: Record<string, unknown>) => bus.emit(name, payload);
  const proj = (id: string): ProjectState => {
    const p = projects.get(id);
    if (!p) throw new HttpError(404, 'EM-6101', 'This project could not be found.');
    return p;
  };
  const head = (p: ProjectState) => p.versions.get(p.chain[p.pointer]!)!;
  const facts = (p: ProjectState): AssetFacts[] => p.assets.map((a) => ({
    id: a.id, kind: a.kind, status: a.status, name: a.name,
    ...(a.durationMs === null ? {} : { durationMs: a.durationMs }), ...(a.width === null ? {} : { width: a.width }),
    ...(a.height === null ? {} : { height: a.height }), ...(a.hasAudio === null ? {} : { hasAudio: a.hasAudio }),
    ...(a.kind === 'subtitle' ? { captionPages: captionStore.get(a.id) ?? [{ text: a.name.replace(/\.(srt|vtt)$/i, ''), startMs: 0, durationMs: 2000, tokens: [] }] } : {}),
  }));
  const strip = (v: VersionDto & { model: CompositionModelT }): VersionDto => { const { model: _m, ...rest } = v; return rest; };
  const queueDto = (p: ProjectState): IntentQueueDto => {
    const live = new Set(p.chain.slice(0, p.pointer + 1).map((id) => p.versions.get(id)?.hash));
    // FR-167: applied items whose version is past the head (after Undo) are marked undone.
    const items = p.intents.filter((i) => i.status !== 'removed').slice().reverse()
      .map((i) => ((i.status === 'executed' || i.status === 'compiled') && i.appliedHash && !live.has(i.appliedHash) ? { ...i, undone: true } : i));
    const lockedKeys = [...new Set(p.intents.filter((i) => (i.status === 'compiled' || i.status === 'executed') && !i.propertyKey.includes('*')).map((i) => i.propertyKey))];
    return { projectId: p.dto.id, headHash: head(p).hash, items, lockedKeys };
  };
  const touch = (p: ProjectState) => { p.dto.updatedAt = nowIso(); };

  function commit(p: ProjectState, model: CompositionModelT, cause: VersionCause, diff: unknown, planId: string | null = null): VersionDto & { model: CompositionModelT } {
    const prev = head(p);
    const timing = deriveTiming(model);
    const v = { id: newId(), projectId: p.dto.id, parentId: prev.id, hash: hashModel(model).slice(0, 16), cause, planId, durationMs: timing.durationMs, createdAt: nowIso(), model };
    p.versions.set(v.id, v);
    p.chain = [...p.chain.slice(0, p.pointer + 1), v.id];
    p.pointer = p.chain.length - 1;
    p.dto.headVersionId = v.id; p.dto.headHash = v.hash; p.dto.durationMs = v.durationMs; p.headUnsaved = true; p.dto.settings = model.settings; touch(p);
    staleOtherPlans(p, v.hash, planId);
    emit('composition.updated', { projectId: p.dto.id, version: strip(v), previousHash: prev.hash, diff, cause, canUndo: p.pointer > 0, canRedo: false, durationMs: v.durationMs, issues: timing.warnings });
    return v;
  }
  function moveHead(p: ProjectState, pointer: number, cause: 'undo' | 'redo') {
    const prev = head(p);
    p.pointer = pointer;
    const v = head(p);
    p.dto.headVersionId = v.id; p.dto.headHash = v.hash; p.dto.durationMs = v.durationMs; p.headUnsaved = true; p.dto.settings = v.model.settings;
    staleOtherPlans(p, v.hash, null);
    emit('composition.updated', { projectId: p.dto.id, version: strip(v), previousHash: prev.hash, diff: [], cause, canUndo: p.pointer > 0, canRedo: p.pointer < p.chain.length - 1, durationMs: v.durationMs, issues: [] });
    // FR-052: an Undo/Redo head that uses removed assets brings them back into the Asset Panel
    const used = new Set([...v.model.tracks.video.map((c) => c.assetId), ...v.model.tracks.audio.map((a) => a.assetId), ...v.model.tracks.overlay.flatMap((o) => (o.kind === 'image' ? [o.assetId] : []))]);
    const back = (p.removed ?? []).filter((a) => used.has(a.id));
    if (back.length) {
      p.removed = (p.removed ?? []).filter((a) => !used.has(a.id)); p.assets.push(...back); p.dto.assetCount = p.assets.length;
      emit('service.notice', { projectId: p.dto.id, kind: 'assets-restored', assetIds: back.map((a) => a.id) });
    }
  }
  function staleOtherPlans(p: ProjectState, hash: string, except: string | null) {
    for (const pl of p.plans) {
      if (pl.id === except || pl.baseVersion === hash) continue;
      if (pl.status === 'valid' || pl.status === 'invalid' || pl.status === 'draft') {
        pl.status = 'stale';
        for (const i of p.intents) if (i.status === 'planned') i.status = 'queued';     // a stale plan releases its intents for re-planning
        emit('plan.invalid', { projectId: p.dto.id, planId: pl.id, status: 'stale', code: 'EM-2301', validation: [], touchesLockedKeys: [] });
      }
    }
  }

  function makeProject(name: string, settingsIn: Partial<ProjectSettingsT> = {}): ProjectState {
    const id = newId();
    const settingsFull: ProjectSettingsT = { ...DEFAULT_SETTINGS, ...settingsIn };
    const model = createEmptyModel(id, settingsFull);
    const t = deriveTiming(model);
    const v = { id: newId(), projectId: id, parentId: null, hash: hashModel(model).slice(0, 16), cause: 'system' as const, planId: null, durationMs: t.durationMs, createdAt: nowIso(), model };
    const grant: MediaGrantDto = { grant: randomGrant(), projectId: id, kind: 'preview', expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(), baseUrl: `${MOCK_BASE}/media/` };
    grant.baseUrl = `${MOCK_BASE}/media/${grant.grant}`;
    const p: ProjectState = {
      dto: { id, name, settings: settingsFull, language: settingsFull.language, headVersionId: v.id, headHash: v.hash, durationMs: t.durationMs, assetCount: 0, createdAt: nowIso(), updatedAt: nowIso(), openedAt: null, dirty: false },
      versions: new Map([[v.id, v]]), chain: [v.id], pointer: 0, assets: [], intents: [], plans: [], results: new Map(),
      messages: { brainstorm: [], editor: [] }, usage: { brainstorm: null, editor: null }, checkpoints: [], outputs: [], genJobs: [], grant,
    };
    projects.set(id, p);
    return p;
  }

  function addAsset(p: ProjectState, a: Partial<AssetDto> & Pick<AssetDto, 'name' | 'kind'>, url: string | null): AssetDto {
    const asset: AssetDto = {
      id: newId(), projectId: p.dto.id, bytes: 0, sha256: newId().toLowerCase(), status: 'ingesting', progress: 0, errorCode: null, durationMs: null, width: null, height: null,
      fps: null, hasAudio: null, sequenceBadge: null, media: { original: true, playable: false, proxy: false, thumb: false, filmstrip: false, waveform: false }, createdAt: nowIso(), updatedAt: nowIso(), ...a,
    };
    if (url) media.set(asset.id, url);
    p.assets.push(asset);
    p.dto.assetCount = p.assets.length;
    return asset;
  }

  function seedSample(): ProjectState {
    const p = makeProject('Sample · Kafe Senja', { ratio: '9:16', autoRatio: false });
    const shots: Array<[string, string, string]> = [['Kafe Senja', '#E8913A', '#3A1F0B'], ['Kopi susu', '#4FD1A5', '#0D2A4A'], ['Sampai jumpa', '#B48CFF', '#14120F']];
    const ids = shots.map(([label, a, b], i) => addAsset(p, {
      name: `kafe-${i + 1}.png`, kind: 'image', status: 'ready', progress: 1, durationMs: 5000, width: 1080, height: 1920, bytes: 240_000 + i * 10_000,
      media: { original: true, playable: true, proxy: false, thumb: true, filmstrip: false, waveform: false },
    }, sampleImage(label, a, b)).id);
    const r = applyOperations(head(p).model, ids.map((assetId) => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId } })), { assets: facts(p), tier: hardware.tier, newId });
    if (r.ok) {
      const v = commit(p, r.value.model, 'insert', r.value.diff);
      p.dto.dirty = false;
      for (const id of ids) p.intents.push(systemIntent(p, id, v.hash));
    }
    p.dto.dirty = false;
    return p;
  }
  function systemIntent(p: ProjectState, assetId: string, baseVersion: string): EditIntent {
    return { id: newId(), projectId: p.dto.id, source: 'system', createdAt: nowIso(), category: 'asset', params: { assetId }, target: { kind: 'sequence' }, resolvedTargets: [{ kind: 'sequence' }],
      propertyKey: 'sequence.clips', propertyClass: 'list', needsInterpretation: false, status: 'executed', supersedes: [], baseVersion };
  }

  // ───────────────────────── Target Resolution + Compile (AI_WORKFLOW §4, §6, §7; simplified) ─────────────────────────
  interface Leaf { target: ElementRefT; key: string; ops: OperationT[] | null }
  interface Resolution { leaves: Leaf[]; parentKey: string; needsInterpretation: boolean; reject?: { code: string; message: string }; notices: string[] }

  function elementAt(model: CompositionModelT, kind: 'clip' | 'text', ms: number): string | undefined {
    const t = deriveTiming(model);
    if (kind === 'clip') return model.tracks.video.find((c) => { const w = t.elementWindows[c.id]; return w !== undefined && ms >= w.fromMs && ms < w.toMs; })?.id;
    return model.tracks.text.find((x) => ms >= x.timing.atMs && ms < x.timing.atMs + x.timing.durationMs)?.id;
  }

  function resolve(p: ProjectState, body: DesignPickInput): Resolution {
    const model = head(p).model;
    const sel = body.selection ?? [];
    const playhead = body.playheadMs ?? 0;
    const preset = body.presetId ? getPreset(body.presetId) : undefined;
    const notices: string[] = [];
    const interp = Boolean(body.instruction);
    const project: ElementRefT = { kind: 'project' };
    const cd = preset ? compileDefaults(preset.id) : undefined;
    // Catalogue params (ⓘ Details): keys the Compile rule lifts to the top level (transition durationMs/timing) stay there; the rest go to args.params.
    const withParams = (args: Record<string, unknown>) => {
      if (!body.params || !Object.keys(body.params).length) return args;
      const top = Object.fromEntries(Object.entries(body.params).filter(([k]) => k !== 'params' && k in args));
      const rest = Object.fromEntries(Object.entries(body.params).filter(([k]) => !(k in args)));
      return { ...args, ...top, ...(Object.keys(rest).length ? { params: { ...((args['params'] as Record<string, unknown> | undefined) ?? {}), ...rest } } : {}) };
    };
    const one = (target: ElementRefT, key: string, op: OperationT | null): Resolution => ({ leaves: [{ target, key, ops: op ? [op] : null }], parentKey: key, needsInterpretation: interp || op === null, notices });

    if (body.clipEdit) {                                                                  // FR-068 Timeline drag, as the Local Service
      const e = body.clipEdit; const clip: ElementRefT = { kind: 'clip', id: e.clipId };
      const c = model.tracks.video.find((x) => x.id === e.clipId);
      if (!c) return { leaves: [], parentKey: '?', needsInterpretation: false, notices, reject: { code: 'EM-2203', message: 'That clip no longer exists.' } };
      if (e.toIndex !== undefined) return one(clip, `clip:${e.clipId}.order`, { op: 'op:clip.move', target: clip, args: { toIndex: e.toIndex } });
      return one(clip, `clip:${e.clipId}.trim`, { op: 'op:clip.setTrim', target: clip, args: { trimBeforeMs: e.trimBeforeMs ?? c.trimBeforeMs, durationMs: e.durationMs ?? c.durationMs } });
    }
    if (body.output) {                                                                    // Output Settings picks (FR-087…FR-097), as the Local Service
      const o = body.output;
      if (o.kind === 'ratio') return one(project, 'project.ratio', { op: 'op:output.setRatio', target: project, args: { ratio: o.value, ...(o.customRatio ? { customRatio: o.customRatio } : {}) } });
      if (o.kind === 'resolution') return one(project, 'project.resolution', { op: 'op:output.setResolution', target: project, args: { preset: o.value } });
      if (o.kind === 'autoRatio') return one(project, 'project.ratioAuto', { op: 'op:output.setAutoRatio', target: project, args: { on: o.value === true } });
      return one(project, 'project.fps', { op: 'op:project.setFps', target: project, args: { fps: o.value } });
    }
    if (body.category === 'layout') {
      const prm = body.params ?? {};
      if (typeof prm['ratio'] === 'string') return one(project, 'project.ratio', { op: 'op:output.setRatio', target: project, args: { ratio: prm['ratio'], ...(prm['customRatio'] ? { customRatio: prm['customRatio'] } : {}) } });
      if (typeof prm['resolution'] === 'string') return one(project, 'project.resolution', { op: 'op:output.setResolution', target: project, args: { preset: prm['resolution'] } });
      if (preset?.category === 'palette') return one(project, 'theme.paletteId', { op: 'op:theme.set', target: project, args: { paletteId: preset.id } });
      if (preset?.category === 'fontpair') return one(project, 'theme.fontPairId', { op: 'op:theme.set', target: project, args: { fontPairId: preset.id } });
      return one(project, 'project.layout', null);
    }
    if (body.category === 'text' && !preset) {                                              // Text Panel style pick (IX-03)
      const fields = body.field ? [[body.field, body.value] as [string, unknown]] : Object.entries(body.params ?? {}).filter(([k]) => ['fontFamily', 'fontSize', 'weight', 'italic', 'colour', 'align', 'opacity'].includes(k));
      const field = fields[0]?.[0] ?? 'style';
      const selText = sel.find((s) => s.kind === 'text');
      if (field === 'content') return selText?.id ? one(selText, `text:${selText.id}.content`, { op: 'op:text.setContent', target: { kind: 'text', id: selText.id }, args: { text: fields[0]![1] } })
        : { leaves: [], parentKey: '', needsInterpretation: false, reject: { code: 'EM-2201', message: 'Select a text first.' }, notices };
      const overlaySel = sel.find((s) => (s.kind === 'shape' || s.kind === 'image') && s.id);
      if (field === 'opacity' && !selText && overlaySel) return one(overlaySel, `${overlaySel.kind}:${overlaySel.id}.opacity`, { op: 'op:overlay.setOpacity', target: overlaySel, args: { opacity: fields[0]![1] } });
      if (selText?.id) return one(selText, `text:${selText.id}.${field}`, { op: 'op:text.setStyle', target: { kind: 'text', id: selText.id }, args: Object.fromEntries(fields) });
      notices.push('EM-2403');
      return one(project, `theme.textDefaults.${field}`, { op: 'op:theme.setTextDefaults', target: project, args: Object.fromEntries(fields) });
    }
    if (!preset && body.category === 'caption' && typeof body.params?.['assetId'] === 'string') return one(project, 'project.captionPages', { op: 'op:caption.importSrt', target: project, args: { assetId: body.params['assetId'] } });
    if (!preset || !cd) {
      if (interp) return { leaves: [{ target: body.target, key: 'chat', ops: null }], parentKey: 'chat', needsInterpretation: true, notices };
      return { leaves: [], parentKey: '', needsInterpretation: false, reject: { code: 'EM-2101', message: 'Unknown design preset.' }, notices };
    }
    const cat: Category = preset.category;
    const baseArgs = withParams(cd.args);
    if (model.tracks.video.length === 0 && ['transition', 'motion', 'effect'].includes(cat)) return { leaves: [], parentKey: '', needsInterpretation: false, reject: { code: 'EM-2202', message: 'Insert at least one asset first.' }, notices };
    switch (cat) {
      case 'transition': {
        const n = model.tracks.video.length;
        let cuts: number[] = [];
        const selClips = sel.filter((s) => s.kind === 'clip' && s.id).map((s) => model.tracks.video.findIndex((c) => c.id === s.id)).filter((i) => i >= 0 && i < n - 1);
        const selCut = sel.find((s) => s.kind === 'cut' && s.index !== undefined);
        if (selCut?.index !== undefined) cuts = [selCut.index];
        else if (selClips.length) cuts = selClips;
        else cuts = Array.from({ length: Math.max(0, n - 1) }, (_, i) => i);
        if (!cuts.length) return { leaves: [], parentKey: '', needsInterpretation: false, reject: { code: 'EM-2202', message: 'Transitions need at least two clips.' }, notices };
        const leaves = cuts.map((i) => ({ target: { kind: 'cut' as const, index: i }, key: `cut:${i}.transition`, ops: [{ op: cd.op, target: { kind: 'cut' as const, index: i }, args: baseArgs }] }));
        return { leaves, parentKey: cuts.length > 1 ? 'cut:*.transition' : leaves[0]!.key, needsInterpretation: interp, notices };
      }
      case 'caption': return one(project, 'project.captionStyle', { op: cd.op, target: project, args: baseArgs });
      case 'background': return one(project, 'project.background', { op: cd.op, target: project, args: baseArgs });
      case 'easing': return one(project, 'theme.defaultEasingId', { op: cd.op, target: project, args: baseArgs });
      case 'palette': return one(project, 'theme.paletteId', { op: cd.op, target: project, args: baseArgs });
      case 'fontpair': return one(project, 'theme.fontPairId', { op: cd.op, target: project, args: baseArgs });
      case 'font': return one(project, 'theme.textDefaults.fontFamily', { op: cd.op, target: project, args: baseArgs });
      case 'motion': case 'effect': {
        const picked = sel.filter((s) => (s.kind === 'clip' || (cat === 'motion' && (s.kind === 'text' || s.kind === 'shape'))) && s.id);
        const targets: ElementRefT[] = picked.length ? picked : (() => { const id = elementAt(model, 'clip', playhead); return id ? [{ kind: 'clip' as const, id }] : []; })();
        if (!targets.length) return { leaves: [], parentKey: '', needsInterpretation: false, reject: { code: 'EM-2201', message: 'Select a clip or move the playhead onto one.' }, notices };
        const leaves = targets.map((t) => ({ target: t, key: `${t.kind}:${t.id}.${cat === 'motion' ? 'motion' : `effects.${preset.id}`}`, ops: [{ op: cd.op, target: t, args: baseArgs }] }));
        return { leaves, parentKey: leaves.length > 1 ? `selection.${cat}` : leaves[0]!.key, needsInterpretation: interp, notices };
      }
      case 'texteffect': {
        const t = sel.find((s) => s.kind === 'text' && s.id);
        if (!t?.id) return one(project, `text:new.effect.${preset.id}`, null);              // FR-026: no selection → queued for the Editor Agent
        return one(t, `text:${t.id}.effect`, { op: cd.op, target: { kind: 'text', id: t.id }, args: baseArgs });
      }
      case 'text': {
        const text = typeof body.text === 'string' ? body.text.trim() : typeof body.params?.['text'] === 'string' ? String(body.params['text']).trim() : '';
        const selText = sel.find((s) => s.kind === 'text' && s.id);
        if (!text && selText?.id) return one(selText, `text:${selText.id}.variant`, { op: 'op:text.setStyle', target: { kind: 'text', id: selText.id }, args: { variant: preset.id } });   // FR-025
        if (!text) return one(project, 'text:new', null);
        if (model.tracks.video.length === 0) return { leaves: [], parentKey: '', needsInterpretation: false, reject: { code: 'EM-2202', message: 'Insert at least one clip before adding text.' }, notices };
        const { text: _t, ...styleParams } = body.params ?? {};
        return one(project, 'text:new', { op: cd.op, args: { ...cd.args, ...(Object.keys(styleParams).length ? { styleOverrides: { ...(cd.args['styleOverrides'] as object), ...styleParams } } : {}), text, atMs: playhead } });
      }
      case 'shape': return one(project, 'project.shapes', { op: cd.op, args: { ...cd.args, atMs: playhead } });
      case 'audio': {
        const a = sel.find((s) => s.kind === 'audio' && s.id) ?? (model.tracks.audio[0] ? { kind: 'audio' as const, id: model.tracks.audio[0].id } : undefined);
        if (!a?.id || cd.requires.includes('assetId')) return one(project, 'project.audioBed', null);
        return one(a, `audio:${a.id}.${preset.id.endsWith('fade-in-out') ? 'fades' : 'ducking'}`, { op: cd.op, target: { kind: 'audio', id: a.id }, args: baseArgs });
      }
      default: return one(project, `project.${cat}`, null);
    }
  }

  const ACTIVE = new Set(['queued', 'compiled', 'planned', 'executed']);
  const modelInstalled = (flag: string) => models.some((x) => x.status === 'installed' && (`model:${x.key}` === flag || x.key === flag.slice(6) || x.key.startsWith(`${flag.slice(6)}-`)));
  /** FR-037: model.installed → held picks for that model become queued and apply (same Compile path as a fresh pick). */
  function resumeHeld() {
    for (const p of projects.values()) {
      const held = p.intents.filter((i) => i.status === 'held' && modelInstalled(String(i.params['__heldFor'] ?? '')));
      if (!held.length) continue;
      for (const i of held) { i.status = 'queued'; const { __heldFor: _drop, ...rest } = i.params; i.params = rest; }
      const leaves = held.filter((i) => i.parentIntentId || !held.some((c) => c.parentIntentId === i.id));
      for (const l of leaves) l.supersedes = supersedeFor(p, l);
      compileAndApply(p, leaves, opsStore);
      for (const parent of held.filter((i) => !i.parentIntentId && held.some((c) => c.parentIntentId === i.id))) parent.status = leaves.filter((l) => l.parentIntentId === parent.id).every((l) => l.status === 'executed') ? 'executed' : 'queued';
      settleParents(p);
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: held.map((i) => i.id), reason: 'compiled' });
    }
  }
  function supersedeFor(p: ProjectState, intent: EditIntent): string[] {
    if (intent.propertyClass === 'list' && !intent.presetId) return [];
    const out: string[] = [];
    for (const old of p.intents) {
      if (old.id === intent.id || old.parentIntentId === intent.id || !ACTIVE.has(old.status) || old.propertyKey !== intent.propertyKey) continue;
      if (old.id === intent.parentIntentId) continue;
      if (intent.propertyClass === 'list' && old.presetId !== intent.presetId) continue;
      old.status = 'superseded';
      out.push(old.id);
    }
    return out;
  }
  function settleParents(p: ProjectState) {
    for (const parent of p.intents.filter((i) => p.intents.some((c) => c.parentIntentId === i.id))) {
      const kids = p.intents.filter((c) => c.parentIntentId === parent.id && c.status !== 'removed');
      if (kids.length && kids.every((k) => k.status === 'superseded')) parent.status = 'superseded';
      else if (parent.status === 'superseded' && kids.some((k) => k.status !== 'superseded')) parent.status = kids.some((k) => k.status === 'executed') ? 'executed' : 'queued';
    }
  }

  /** Applies compile-able leaf intents in one version. Returns the version or throws the first blocking issue as a rejection. */
  function compileAndApply(p: ProjectState, leaves: EditIntent[], opsByIntent: Map<string, OperationT[]>): VersionDto | null {
    const ops = leaves.flatMap((i) => (opsByIntent.get(i.id) ?? []).map((o) => ({ ...o, intentId: i.id })));
    if (!ops.length) return null;
    const r = applyOperations(head(p).model, ops, { assets: facts(p), tier: hardware.tier, newId });
    if (!r.ok) {
      const first = r.issues[0];
      for (const l of leaves) { l.status = 'rejected'; l.rejectionReason = `${first?.code ?? 'EM-2001'}: ${first?.message ?? 'Rejected'}`; }
      return null;
    }
    const planId = newId();
    const v = commit(p, r.value.model, 'compile', r.value.diff, planId);
    for (const l of leaves) { l.status = 'executed'; l.appliedVersion = p.pointer + 1; l.appliedHash = v.hash; }
    p.plans.push({ id: planId, projectId: p.dto.id, baseVersion: v.hash, origin: 'compile', goal: 'Compiled Design Pick', steps: [{ n: 1, tool: 'composition.applyOps', ops, args: {}, expectedDiff: `${ops.length} change(s)`, dependsOn: [] }], touchesLockedKeys: [], risks: [], status: 'executed', validation: [] });
    return strip(v);
  }

  const opsStore = new Map<string, OperationT[]>();               // intentId → compiled ops (for restore / plans)

  /** FR-090 / FR-097: zero-op settings intent (Performance Profile), applied to Settings and recorded as executed, as the Local Service. */
  const PROFILES = ['standard', 'accelerated', 'turbo'];
  const settingsValueOf = (i: EditIntent) => { const o = i.params['__output'] as { kind?: string; value?: unknown } | undefined; return o?.kind === 'performanceProfile' && PROFILES.includes(String(o.value)) ? String(o.value) as SettingsDto['defaultPerformanceProfile'] : null; };
  function applySettingsIntent(it: EditIntent) {
    const v = settingsValueOf(it); if (!v) return;
    it.status = 'executed';
    settings = { ...settings, defaultPerformanceProfile: v };
    emit('settings.changed', { scope: 'settings', settings });
  }

  /** Undo/Redo of a version moves the settings intents stamped with it (R-053/R-054 note, FR-095). */
  function syncSettings(p: ProjectState, kind: 'undo' | 'redo', hash: string) {
    const it = [...p.intents].reverse().find((i) => i.status === 'executed' && i.appliedHash === hash && settingsValueOf(i));
    if (!it) return;
    const v = kind === 'undo' ? String(it.params['__previous'] ?? '') : settingsValueOf(it)!;
    if (!PROFILES.includes(v)) return;
    settings = { ...settings, defaultPerformanceProfile: v as SettingsDto['defaultPerformanceProfile'] };
    emit('settings.changed', { scope: 'settings', settings });
  }

  function createIntent(p: ProjectState, body: DesignPickInput, source: EditIntent['source']) {
    if (body.baseVersion !== head(p).hash) throw new HttpError(409, 'EM-2301', 'The composition changed after this pick was made.', { baseVersion: body.baseVersion, headVersion: head(p).hash });
    if (body.output?.kind === 'performanceProfile') {
      if (!PROFILES.includes(String(body.output.value))) throw new HttpError(400, 'EM-9002', 'Unknown performance profile.');
      const it: EditIntent = { id: newId(), projectId: p.dto.id, source, createdAt: nowIso(), category: 'output', params: { __output: body.output, __previous: settings.defaultPerformanceProfile, targetLabel: String(body.output.value) },
        target: { kind: 'project' }, resolvedTargets: [{ kind: 'project' }], propertyKey: 'project.performanceProfile', propertyClass: 'scalar', needsInterpretation: false, status: 'queued', supersedes: [], baseVersion: body.baseVersion };
      p.intents.push(it);
      const superseded = supersedeFor(p, it); it.supersedes = superseded;
      applySettingsIntent(it);
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [it.id, ...superseded], reason: 'executed' });
      return { intent: it, queue: queueDto(p), superseded, appliedVersion: null, planId: null, notices: [] };
    }
    const res = resolve(p, body);
    const preset = body.presetId ? getPreset(body.presetId) : undefined;
    const propertyClass = (preset?.propertyClass ?? (body.category === 'shape' ? 'list' : body.category === 'text' && body.presetId ? 'list' : 'scalar')) as EditIntent['propertyClass'];
    const base = {
      projectId: p.dto.id, source, createdAt: nowIso(), category: body.category, params: { ...(body.params ?? {}), ...(body.output ? { __output: body.output } : {}) }, target: body.target, propertyClass,
      baseVersion: body.baseVersion, supersedes: [] as string[], ...(body.presetId ? { presetId: body.presetId } : {}), ...(body.instruction ? { instruction: body.instruction } : {}),
    };
    if (res.reject) {
      const rejected: EditIntent = { ...base, id: newId(), resolvedTargets: [], propertyKey: '?', needsInterpretation: false, status: 'rejected', rejectionReason: `${res.reject.code}: ${res.reject.message}` };
      p.intents.push(rejected);
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [rejected.id], reason: 'rejected' });
      return { intent: rejected, queue: queueDto(p), superseded: [], appliedVersion: null, planId: null, notices: [{ code: res.reject.code }] };
    }
    const multi = res.leaves.length > 1;
    const parent: EditIntent = { ...base, id: newId(), resolvedTargets: res.leaves.map((l) => l.target), propertyKey: res.parentKey, needsInterpretation: res.needsInterpretation, status: 'queued' };
    const leaves: EditIntent[] = multi ? res.leaves.map((l) => ({ ...base, id: newId(), parentIntentId: parent.id, resolvedTargets: [l.target], target: l.target, propertyKey: l.key, needsInterpretation: res.needsInterpretation, status: 'queued' as const })) : [parent];
    p.intents.push(parent, ...(multi ? leaves : []));
    res.leaves.forEach((l, i) => { if (l.ops) opsStore.set(leaves[i]!.id, l.ops); });
    // FR-037: the preset needs a model that is not installed → the pick is held (EM-2104) until model.installed resumes it.
    const heldFor = body.presetId ? opts.modelFlagOf?.(body.presetId) : undefined;
    if (heldFor && !modelInstalled(heldFor)) {
      for (const i of [parent, ...(multi ? leaves : [])]) { i.status = 'held'; i.params = { ...i.params, __heldFor: heldFor }; }
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [parent.id], reason: 'created' });
      return { intent: parent, queue: queueDto(p), superseded: [], appliedVersion: null, planId: null, notices: [{ code: 'EM-2104' }] };
    }
    const superseded = leaves.flatMap((l) => { const s = supersedeFor(p, l); l.supersedes = s; return s; });
    if (multi) parent.supersedes = superseded;
    let appliedVersion: VersionDto | null = null;
    let planId: string | null = null;
    if (!res.needsInterpretation && (body.plan ?? 'auto') === 'auto') {
      appliedVersion = compileAndApply(p, leaves, opsStore);
      if (multi) parent.status = leaves.every((l) => l.status === 'executed') ? 'executed' : leaves[0]!.status;
      if (appliedVersion) { parent.appliedVersion = leaves[0]!.appliedVersion ?? p.pointer + 1; planId = p.plans[p.plans.length - 1]!.id; }
    } else if (res.needsInterpretation && settings.autoPlan && assignments.editor && !settings.privateMode) {
      planId = startAgentPlan(p, [parent.id], body.instruction).id;
    }
    settleParents(p);
    emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [parent.id, ...superseded], reason: appliedVersion ? 'compiled' : superseded.length ? 'superseded' : 'created' });
    return { intent: parent, queue: queueDto(p), superseded, appliedVersion, planId, notices: res.notices.map((code) => ({ code })) };
  }

  // ───────────────────────── scripted Editor Agent ─────────────────────────
  function agentChecks() {
    if (settings.privateMode) throw new HttpError(423, 'EM-4401', 'Agents are off in Private Mode.');
    if (!connections.length) throw new HttpError(503, 'EM-4001', 'No AI provider is connected.');
  }
  let lastEditorRunId = '';
  function startAgentPlan(p: ProjectState, intentIds: string[], message: string | undefined): PlanDto {
    const intents = p.intents.filter((i) => intentIds.includes(i.id));
    const words = (message ?? intents.map((i) => i.instruction ?? '').join(' ')).trim();
    const title = (words.replace(/^(buat|add|make|tambahkan)\s+/i, '').slice(0, 40) || 'Judul pembuka').replace(/^./, (c) => c.toUpperCase());
    const plan: PlanDto = { id: newId(), projectId: p.dto.id, baseVersion: head(p).hash, origin: 'editor-agent', goal: words ? `Do: ${words.slice(0, 120)}` : 'Interpret the queued picks', steps: [], touchesLockedKeys: [], risks: [], status: 'draft', validation: [] };
    p.plans.push(plan);
    for (const i of intents) if (i.status === 'queued') i.status = 'planned';
    const runId = newId(), modelId = assignments.editor?.modelId ?? 'mock-model';
    lastEditorRunId = runId;
    emit('agent.run.started', { projectId: p.dto.id, run: run(p, runId, 'editor', 'running', plan.id), agent: 'editor', modelId, planId: plan.id });
    later(400, () => emit('agent.run.delta', { projectId: p.dto.id, runId, agent: 'editor', delta: 'Reading the composition and your picks… ' }));
    later(900, () => {
      if (plan.status !== 'draft') return;
      const hasClips = head(p).model.tracks.video.length > 0;
      const ops: OperationT[] = [{ op: 'op:text.add', args: { text: title, variant: 'preset:text.title', atMs: 0, durationMs: 3000 } }];
      plan.steps = [{ n: 1, tool: 'composition.applyOps', ops, args: {}, expectedDiff: `Add Title '${title}' 0.0–3.0 s`, dependsOn: [] }];
      if (hasClips) plan.steps.push({ n: 2, tool: 'composition.applyOps', ops: [], args: {}, expectedDiff: 'Rise motion on the title (variant default)', dependsOn: [1] });
      plan.risks = [{ code: 'EM-2305', message: 'Title may overlap the caption area for a moment.', severity: 'info' }];
      plan.usage = { model: modelId, inputTokens: 1240, outputTokens: 310, costUsd: 0.004, approximate: true };
      plan.status = 'valid';
      p.usage.editor = { usedTokens: 1550, contextLength: 200_000 };
      const msg: MessageDto = { id: newId(), role: 'assistant', blocks: [{ type: 'text', text: `I prepared a plan: ${plan.goal}. Nothing changes until you press Execute.` }], agentRunId: runId, createdAt: nowIso() };
      p.messages.editor.push(msg);
      emit('agent.run.done', { projectId: p.dto.id, run: run(p, runId, 'editor', 'done', plan.id), message: msg, usage: { inputTokens: 1240, outputTokens: 310, costUsd: 0.004, approximate: true, contextLength: 200_000 }, contextUsage: p.usage.editor });
      emit('plan.ready', { projectId: p.dto.id, plan, runId });
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: intentIds, reason: 'created' });
    });
    return plan;
  }
  function run(p: ProjectState, id: string, agent: AgentKind, status: 'running' | 'done' | 'failed' | 'cancelled', planId: string | null) {
    const a = assignments[agent];
    return { id, projectId: p.dto.id, agent, status, modelId: a?.modelId ?? 'mock-model', connectionId: a?.connectionId ?? null, planId, errorCode: null, usage: null, startedAt: nowIso(), finishedAt: status === 'running' ? null : nowIso() };
  }

  function executePlan(planId: string): ExecutionResult {
    for (const p of projects.values()) {
      const plan = p.plans.find((x) => x.id === planId);
      if (!plan) continue;
      const stored = p.results.get(planId);
      if (stored) return { ...stored, notice: 'EM-2308' };
      if (plan.baseVersion !== head(p).hash || plan.status === 'stale') {
        plan.status = 'stale';
        throw new HttpError(409, 'EM-2301', 'The composition changed after this plan was made. Ask the Editor Agent to plan again; nothing was applied.');
      }
      if (plan.status !== 'valid') throw new HttpError(422, 'EM-2303', 'This plan cannot be executed.');
      const ops = plan.steps.flatMap((s) => s.ops);
      const from = head(p).hash;
      plan.status = 'executing';
      emit('plan.ready', { projectId: p.dto.id, plan });
      const r = applyOperations(head(p).model, ops, { assets: facts(p), tier: hardware.tier, newId });
      if (!r.ok) {
        plan.status = 'failed';
        const first = r.issues[0];
        plan.errorCode = first?.code ?? 'EM-2307';
        const res: ExecutionResult = { planId, ok: false, fromVersion: from, appliedOps: 0, diff: [], error: { code: first?.code ?? 'EM-2307', message: first?.message ?? 'Not applied' }, rollback: { performed: true, toVersion: from }, durationMs: 12 };
        p.results.set(planId, res);
        emit('plan.invalid', { projectId: p.dto.id, planId, status: 'failed', code: 'EM-2303', validation: r.issues, touchesLockedKeys: [] });
        return res;
      }
      const v = commit(p, r.value.model, 'execute', r.value.diff, planId);
      plan.status = 'executed';
      for (const i of p.intents) if (i.status === 'planned') { i.status = 'executed'; i.appliedVersion = p.pointer + 1; }
      settleParents(p);
      const res: ExecutionResult = { planId, ok: true, fromVersion: from, toVersion: v.hash, appliedOps: ops.length, diff: r.value.diff, durationMs: 41 };
      p.results.set(planId, res);
      const count = (c: string) => r.value.diff.filter((d) => d.change === c).length;
      plan.result = { ok: true, toVersion: v.hash, appliedOps: ops.length, added: count('added'), removed: count('removed'), modified: count('modified') };   // FR-086
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [], reason: 'executed' });
      emit('plan.ready', { projectId: p.dto.id, plan });
      return res;
    }
    throw new HttpError(404, 'EM-9003', 'Not found.');
  }

  // ───────────────────────── renders ─────────────────────────
  function estimate(body: RenderCreateInput) {
    const p = proj(body.projectId);
    const m = head(p).model;
    const effectiveProfile = { ...body.outputProfile };
    const dims = resolveDimensions(effectiveProfile.ratio, effectiveProfile.resolution, effectiveProfile.customRatio);
    const t = deriveTiming(m);
    const totalFrames = Math.round((t.durationMs / 1000) * body.outputProfile.fps);
    const hasClips = m.tracks.video.length > 0;
    const checks: Array<{ check: 'disk' | 'memory' | 'dimensions' | 'duration' | 'assets' | 'engine' | 'folder'; ok: boolean; code?: string }> = [
      { check: 'folder' as const, ok: true },
      { check: 'disk' as const, ok: true }, { check: 'memory' as const, ok: true }, { check: 'dimensions' as const, ok: true },
      { check: 'duration' as const, ok: hasClips, ...(hasClips ? {} : { code: 'EM-2202' }) },
      { check: 'assets' as const, ok: p.assets.every((a) => a.status !== 'ingesting'), ...(p.assets.some((a) => a.status === 'ingesting') ? { code: 'EM-1301' } : {}) },
      { check: 'engine' as const, ok: true },
    ];
    const active = renders.find((j) => j.status === 'rendering' || j.status === 'queued');
    const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0');
    const defaultFileName = `${p.dto.name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-${effectiveProfile.ratio.replace(':', 'x')}-${effectiveProfile.resolution}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    return { ok: checks.every((c) => c.ok), dimensions: dims, totalFrames, durationMs: t.durationMs, estimate: { seconds: Math.round(totalFrames * 0.08), bytes: Math.round(t.durationMs * 900), confidence: 'low' as const }, checks, effectiveProfile, warnings: [],
      notices: [...(active ? ['EM-3208'] : [])], defaultFileName, privateMode: settings.privateMode, queue: { active: active?.id ?? null, queued: renders.filter((j) => j.status === 'queued').length } };
  }
  function startRender(body: RenderCreateInput): RenderJobDto {
    const e = estimate(body);
    if (!e.ok) { const f = e.checks.find((c) => !c.ok); throw new HttpError(422, f?.code ?? 'EM-3104', 'Export preflight failed.'); }
    const p = proj(body.projectId);
    const job: RenderJobDto = { id: newId(), projectId: p.dto.id, versionId: head(p).id, outputProfile: e.effectiveProfile, performanceProfile: body.performanceProfile, status: 'queued', progress: 0, renderedFrames: null, totalFrames: e.totalFrames, etaMs: null, outputId: null, errorCode: null, width: e.dimensions.width, height: e.dimensions.height, createdAt: nowIso(), startedAt: null, finishedAt: null };
    renders.unshift(job);
    emit('render.queued', { projectId: p.dto.id, job });
    let step = 0;
    const tick = () => {
      if (cancelledRenders.has(job.id)) return;
      step += 1;
      job.status = 'rendering'; job.startedAt ??= nowIso();
      job.progress = Math.min(1, step / 10); job.renderedFrames = Math.round(job.progress * e.totalFrames); job.etaMs = step >= 2 ? (10 - step) * 400 : null;
      if (step < 10) { emit('render.progress', { projectId: p.dto.id, jobId: job.id, progress: job.progress, renderedFrames: job.renderedFrames, totalFrames: e.totalFrames, etaMs: job.etaMs, stage: 'rendering' }); later(400, tick); return; }
      const fileName = `${(body.fileName ?? p.dto.name).replace(/[^A-Za-z0-9._-]+/g, '-')}.${body.outputProfile.format}`;
      const out: OutputDto = { id: newId(), projectId: p.dto.id, renderJobId: job.id, kind: body.outputProfile.format === 'gif' ? 'gif' : body.outputProfile.format === 'png' ? 'still' : 'video', fileName, bytes: e.estimate.bytes ?? 0, width: e.dimensions.width, height: e.dimensions.height, fps: body.outputProfile.fps, durationMs: e.durationMs, validated: true, path: `${settings.outputFolder}\\${fileName}`, media: { file: true, thumb: false }, createdAt: nowIso() };
      p.outputs.unshift(out);
      job.status = 'done'; job.progress = 1; job.outputId = out.id; job.finishedAt = nowIso(); job.etaMs = 0;
      emit('render.done', { projectId: p.dto.id, jobId: job.id, output: out, notices: [] });
    };
    later(300, tick);
    return job;
  }

  // ───────────────────────── seed ─────────────────────────
  if (opts.seed === 'sample') seedSample();
  else if (opts.seed === 'empty') makeProject('Untitled');

  // ───────────────────────── router ─────────────────────────
  type Handler = (m: RegExpMatchArray, body: unknown, q: URLSearchParams, init: RequestInit) => unknown;
  const routes: Array<[string, RegExp, Handler]> = [];
  const r = (method: string, pattern: string, h: Handler) => routes.push([method, new RegExp(`^${pattern.replace(/:(\w+)/g, '([^/]+)')}$`), h]);
  const obj = (b: unknown): Record<string, unknown> => (typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {});
  const created = (body: unknown) => ({ __status: 201, body });
  const accepted = (body: unknown) => ({ __status: 202, body });

  r('GET', '/health', () => ({ status: 'ok', version: '0.0.0-mock', mode: 'development', uptimeMs: Date.now() - startedAt, buildDate: '2026-10-24', tier: hardware.tier, licence: { status: license.status, tier: license.tier, updatesEligible: license.updatesEligible }, privateMode: settings.privateMode, engine: { bundleVersion: 'mock', remotionVersion: '4.0.535', browserReady: true, ffmpeg: true }, db: { schemaVersion: 1, ok: true }, workload: { rendering: renders.some((j) => j.status === 'rendering'), ingesting: 0, agentRuns: 0, downloading: models.filter((x) => x.status === 'downloading').length }, seq: bus.currentSeq() }));
  r('POST', '/service/shutdown', () => accepted({ acceptedAt: nowIso() }));
  // projects
  r('GET', '/projects', () => ({ items: [...projects.values()].map((p) => p.dto).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), nextCursor: null, total: projects.size }));
  r('POST', '/projects', (_m, b) => {
    const body = obj(b);
    const name = String(body['name'] ?? '').trim();
    if (!name) throw new HttpError(400, 'EM-9002', 'Name is required.', undefined);
    if ([...projects.values()].some((p) => p.dto.name === name)) throw new HttpError(409, 'EM-6103', 'A project with this name already exists.');
    const p = makeProject(name, obj(body['settings']) as Partial<ProjectSettingsT>);
    emit('composition.updated', { projectId: p.dto.id, version: strip(head(p)), previousHash: null, diff: [], cause: 'system', canUndo: false, canRedo: false, durationMs: p.dto.durationMs, issues: [] });
    return created(p.dto);
  });
  // R-025 sample project for the tour: assets ingest in the background, then 3 clips + captions + palette, then service.notice {kind:'sample', ready:true}.
  r('POST', '/projects/sample', (_m, b) => {
    const existing = [...projects.values()].find((x) => x.dto.isSample);
    if (existing) return existing.dto;
    const language = obj(b)['language'] === 'en' ? 'en' : 'id';
    const p = makeProject(language === 'id' ? 'Contoh · Kafe Senja' : 'Sample · Kafe Senja', { ratio: '9:16', autoRatio: false, language });
    p.dto.isSample = true;
    const shots: Array<[string, string, string]> = [['Kafe Senja', '#E8913A', '#3A1F0B'], ['Kopi susu', '#4FD1A5', '#0D2A4A'], ['Sampai jumpa', '#B48CFF', '#14120F']];
    const clips = shots.map(([label, c1, c2], i) => { const url = sampleImage(label, c1, c2); const a = addAsset(p, { name: `kafe-senja-${i + 1}.png`, kind: 'image', bytes: 240_000 + i * 10_000 }, url); void ingest(p, a, url); return a; });
    const srt = addAsset(p, { name: 'kafe-senja.srt', kind: 'subtitle', bytes: 180 }, null);
    captionStore.set(srt.id, [
      { text: 'Selamat datang di Kafe Senja', startMs: 0, durationMs: 2500, tokens: [] },
      { text: 'Kopi susu favorit kota', startMs: 5000, durationMs: 2500, tokens: [] },
      { text: 'Sampai jumpa sore ini', startMs: 10_000, durationMs: 2500, tokens: [] },
    ]);
    void ingest(p, srt, null);
    const finish = () => {
      if (!projects.has(p.dto.id)) return;
      if (p.assets.some((a) => a.status === 'ingesting')) { setTimeout(finish, delays ? 100 : 0); return; }
      const ops: OperationT[] = [
        ...clips.map((a): OperationT => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: a.id } })),
        { op: 'op:caption.importSrt', target: { kind: 'project' }, args: { assetId: srt.id } },
        { op: 'op:theme.set', target: { kind: 'project' }, args: { paletteId: 'preset:palette.editorial-dark' } },
      ];
      const res = applyOperations(head(p).model, ops, { assets: facts(p), tier: hardware.tier, newId });
      if (!res.ok) { emit('service.notice', { projectId: p.dto.id, kind: 'sample', ready: false, code: res.issues[0]?.code ?? 'EM-9001' }); return; }
      const v = commit(p, res.value.model, 'system', res.value.diff);
      for (const a of clips) p.intents.push(systemIntent(p, a.id, v.hash));
      p.dto.dirty = false;
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [], reason: 'compiled' });
      emit('service.notice', { projectId: p.dto.id, kind: 'sample', ready: true });
    };
    setTimeout(finish, delays ? 100 : 0);
    return created(p.dto);
  });
  r('GET', '/projects/recent', () => ({ items: [...projects.values()].map((p) => p.dto).filter((d) => d.openedAt).sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? '')).slice(0, 10) }));
  // R-026 disk usage (mock: assets' bytes as media, outputs' bytes) and R-003 recovery summary (clean start), R-027 thumbnail (none in the mock)
  r('GET', '/projects/disk-usage', () => {
    const items = [...projects.values()].map((p) => {
      const mediaBytes = p.assets.reduce((n, a) => n + a.bytes, 0), outputsBytes = p.outputs.reduce((n, o) => n + o.bytes, 0), checkpointBytes = p.checkpoints.length * 4000;
      return { projectId: p.dto.id, mediaBytes, checkpointBytes, outputsBytes, outputCount: p.outputs.length, totalBytes: mediaBytes + checkpointBytes + outputsBytes, backupBytes: mediaBytes + 64_000, backupOutputsBytes: outputsBytes };
    });
    return { items, totalBytes: items.reduce((n, i) => n + i.totalBytes, 0), freeBytes: 120_000_000_000 };
  });
  r('GET', '/service/recovery', () => ({ startedAt: new Date(startedAt).toISOString(), unclean: false, renders: [], agentRuns: [], ingests: [], plans: [], checkpoints: { offered: [], imported: [] } }));
  r('GET', '/projects/:id/thumbnail', (m) => { proj(m[1]!); return undefined; });
  r('GET', '/projects/:id', (m) => proj(m[1]!).dto);
  r('PATCH', '/projects/:id', (m, b) => {
    const p = proj(m[1]!), body = obj(b);
    if (typeof body['name'] === 'string') {
      if (!body['name'].trim()) throw new HttpError(400, 'EM-9002', 'Name cannot be empty.');
      // FR-173: a rename is UI-level state → dirty until Save or autosave (10 s, FR-165)
      if (p.dto.name !== body['name'].trim()) { p.dto.dirty = true; setTimeout(() => { p.dto.dirty = false; }, 10_000); }
      p.dto.name = body['name'].trim();
    }
    if (body['language'] === 'id' || body['language'] === 'en') p.dto.language = body['language'];
    if (body['uiState'] && typeof body['uiState'] === 'object') p.dto.uiState = structuredClone(body['uiState']) as NonNullable<ProjectDto['uiState']>;   // FR-012
    touch(p); return p.dto;
  });
  r('DELETE', '/projects/:id', (m) => { proj(m[1]!); projects.delete(m[1]!); return undefined; });
  r('POST', '/projects/:id/open', (m) => {
    const p = proj(m[1]!);
    p.dto.openedAt = nowIso();
    return { project: p.dto, head: head(p), mediaGrant: p.grant, checkpointNewerThanSave: p.headUnsaved && p.checkpoints[0] ? p.checkpoints[0] : null, intentQueue: queueDto(p), latestPlan: p.plans.filter((x) => x.origin === 'editor-agent').slice(-1)[0] ?? null, renderJobs: renders.filter((j) => j.projectId === p.dto.id) };
  });
  r('GET', '/projects/:id/settings', (m) => { const md = head(proj(m[1]!)).model; return { ...md.settings, durationPolicy: md.durationPolicy, ...(md.fixedDurationMs ? { fixedDurationMs: md.fixedDurationMs } : {}), outputFolder: null }; });
  r('PUT', '/projects/:id/settings', (m, b) => {
    const p = proj(m[1]!), s = obj(b) as Partial<ProjectSettingsT>;
    const cur = head(p).model;
    const ops: OperationT[] = [];
    const project: ElementRefT = { kind: 'project' };
    if (s.fps && s.fps !== cur.settings.fps) ops.push({ op: 'op:project.setFps', target: project, args: { fps: s.fps } });
    if (s.ratio && (s.ratio !== cur.settings.ratio || s.ratio === 'custom')) ops.push({ op: 'op:output.setRatio', target: project, args: { ratio: s.ratio, ...(s.customRatio ? { customRatio: s.customRatio } : {}) } });
    if (s.resolution && s.resolution !== cur.settings.resolution) ops.push({ op: 'op:output.setResolution', target: project, args: { preset: s.resolution } });
    const autoAfter = ops.some((o) => o.op === 'op:output.setRatio') ? false : cur.settings.autoRatio;
    if (s.autoRatio !== undefined && s.autoRatio !== autoAfter) ops.push({ op: 'op:output.setAutoRatio', target: project, args: { on: s.autoRatio } });
    const dp = obj(b) as { durationPolicy?: 'fit-content' | 'fixed'; fixedDurationMs?: number };
    if (dp.durationPolicy && (dp.durationPolicy !== cur.durationPolicy || (dp.durationPolicy === 'fixed' && dp.fixedDurationMs !== cur.fixedDurationMs)))
      ops.push({ op: 'op:project.setDurationPolicy', target: project, args: { policy: dp.durationPolicy, ...(dp.durationPolicy === 'fixed' && dp.fixedDurationMs ? { fixedMs: dp.fixedDurationMs } : {}) } });
    let model = cur, version: VersionDto | null = null;
    if (ops.length) {
      const res = applyOperations(cur, ops, { assets: facts(p), tier: hardware.tier, newId });
      if (!res.ok) throw new HttpError(400, res.issues[0]?.code ?? 'EM-9002', res.issues[0]?.message ?? 'Invalid settings.');
      model = res.value.model;
    }
    if (s.language && s.language !== model.settings.language) model = { ...model, settings: { ...model.settings, language: s.language } };
    if (model !== cur) version = strip(commit(p, model, 'system', []));
    // As the Local Service: each output change is a system-source intent in the queue (FR-097), superseding the previous pick.
    if (version) {
      for (const o of ops) {
        const kind = o.op === 'op:output.setRatio' ? 'ratio' : o.op === 'op:output.setResolution' ? 'resolution' : o.op === 'op:output.setAutoRatio' ? 'autoRatio' : 'fps';
        const value = kind === 'ratio' ? o.args['ratio'] : kind === 'resolution' ? o.args['preset'] : kind === 'autoRatio' ? o.args['on'] : o.args['fps'];
        const key = kind === 'ratio' ? 'project.ratio' : kind === 'resolution' ? 'project.resolution' : kind === 'autoRatio' ? 'project.ratioAuto' : 'project.fps';
        const it: EditIntent = { id: newId(), projectId: p.dto.id, source: 'system', createdAt: nowIso(), category: 'layout', params: { __output: { kind, value } }, target: project, resolvedTargets: [project],
          propertyKey: key, propertyClass: 'scalar', needsInterpretation: false, status: 'executed', supersedes: [], baseVersion: head(p).hash, appliedVersion: p.pointer + 1 };
        it.supersedes = supersedeFor(p, it);
        p.intents.push(it);
      }
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [], reason: 'compiled' });
    }
    return { settings: model.settings, version, warnings: [] };
  });
  r('POST', '/projects/:id/duplicate', (m, b) => {
    const src = proj(m[1]!), name = String(obj(b)['name'] ?? `${src.dto.name} copy`);
    const p = makeProject(name, head(src).model.settings);
    for (const a of src.assets) { const url = media.get(a.id) ?? null; const copy = addAsset(p, { ...a, id: newId(), projectId: p.dto.id }, url); copy.status = a.status; }
    const idMap = new Map(src.assets.map((a, i) => [a.id, p.assets[i]!.id]));
    const model = structuredClone(head(src).model);
    model.projectId = p.dto.id;
    for (const c of model.tracks.video) c.assetId = idMap.get(c.assetId) ?? c.assetId;
    commit(p, model, 'system', []);
    p.dto.dirty = false;
    return created(p.dto);
  });
  r('POST', '/projects/:id/backup', (m, b) => {
    const p = proj(m[1]!), jobId = newId(), body = obj(b);
    [25, 60, 100].forEach((percent, i) => later(250 * (i + 1), () => emit('service.notice', { projectId: p.dto.id, kind: 'backup', jobId, percent, ...(percent === 100 ? { done: true, path: `${String(body['folder'] ?? settings.outputFolder)}\\${p.dto.name}.emproj` } : {}) })));
    return accepted({ jobId });
  });
  r('POST', '/projects/restore', (_m, b) => {
    const path = String(obj(b)['path'] ?? '');
    if (!path.toLowerCase().endsWith('.emproj') && !path.toLowerCase().endsWith('.zip')) throw new HttpError(422, 'EM-6302', 'This file is not an Expertmotion backup.');
    const jobId = newId();
    later(600, () => { const p = makeProject(`${path.split(/[\\/]/).pop()?.replace(/\.(em)?zip$/i, '') ?? 'Restored'} (restored)`); emit('service.notice', { kind: 'restore', jobId, percent: 100, done: true, projectId: p.dto.id }); });
    return accepted({ jobId });
  });
  // checkpoints
  r('GET', '/projects/:id/checkpoints', (m) => { const p = proj(m[1]!); return p.checkpoints.length ? { items: p.checkpoints } : { items: [], notice: 'EM-6202' }; });
  r('POST', '/projects/:id/checkpoints', (m) => {
    const p = proj(m[1]!);
    const c: CheckpointDto = { id: newId(), projectId: p.dto.id, versionId: head(p).id, reason: 'manual', createdAt: nowIso(), durationMs: p.dto.durationMs, hash: head(p).hash, bytes: 4000 };
    p.checkpoints.unshift(c); p.checkpoints = p.checkpoints.slice(0, 20); p.dto.dirty = false; p.headUnsaved = false;
    emit('service.notice', { projectId: p.dto.id, kind: 'checkpoint', code: 'EM-6203' });
    return created(c);
  });
  r('POST', '/projects/:id/checkpoints/:cid/restore', (m) => {
    const p = proj(m[1]!), c = p.checkpoints.find((x) => x.id === m[2]);
    if (!c) throw new HttpError(404, 'EM-9003', 'Not found.');
    const v = p.versions.get(c.versionId)!;
    return { version: strip(commit(p, structuredClone(v.model), 'restore', [])) };
  });
  // assets
  r('POST', '/projects/:id/assets', (m, b, _q, init) => {
    const p = proj(m[1]!);
    const form = init.body as unknown;
    const files: File[] = form && typeof (form as FormData).getAll === 'function' ? ((form as FormData).getAll('file').filter((f) => typeof f === 'object') as File[]) : [];
    const paths = Array.isArray(obj(b)['paths']) ? (obj(b)['paths'] as unknown[]).map(String) : [];
    const entries: Array<{ name: string; bytes: number; url: string | null; type: string }> = [
      ...files.map((f) => ({ name: f.name, bytes: f.size, url: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : null, type: f.type })),
      ...paths.map((path) => ({ name: path.split(/[\\/]/).pop() ?? path, bytes: 0, url: null, type: '' })),
    ];
    if (!entries.length) throw new HttpError(400, 'EM-9002', 'No files.');
    if (entries.length > 50) throw new HttpError(413, 'EM-1010', 'You can import up to 50 files at a time.');
    if (p.assets.length + entries.length > 200) throw new HttpError(422, 'EM-1401', 'A project can hold up to 200 assets.');
    const items = entries.map((e) => {
      const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
      const kind = KIND_BY_EXT[ext];
      const a = addAsset(p, { name: e.name, kind: kind ?? 'video', bytes: e.bytes }, e.url);
      if (!kind) { a.status = 'failed'; a.errorCode = 'EM-1001'; later(50, () => emit('ingest.failed', { projectId: p.dto.id, assetId: a.id, code: 'EM-1001', name: a.name })); return a; }
      void ingest(p, a, e.url);
      return a;
    });
    touch(p);
    return accepted({ items, notices: [] });
  });
  async function probe(url: string | null, kind: AssetDto['kind']): Promise<{ w: number; h: number; ms: number }> {
    const fallback = { w: kind === 'image' ? 1080 : 1920, h: kind === 'image' ? 1920 : 1080, ms: 5000 };
    if (!url || typeof document === 'undefined' || !delays || kind === 'subtitle') return fallback;
    return new Promise((resolveP) => {
      const done = (v: typeof fallback) => { clearTimeout(timer); resolveP(v); };
      const timer = setTimeout(() => resolveP(fallback), 4000);
      if (kind === 'image') { const img = new Image(); img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight, ms: 5000 }); img.onerror = () => done(fallback); img.src = url; return; }
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.preload = 'metadata';
      el.onloadedmetadata = () => done({ w: (el as HTMLVideoElement).videoWidth || fallback.w, h: (el as HTMLVideoElement).videoHeight || fallback.h, ms: Number.isFinite(el.duration) ? Math.max(100, Math.round(el.duration * 1000)) : 5000 });
      el.onerror = () => done(fallback);
      el.src = url;
    });
  }
  async function ingest(p: ProjectState, a: AssetDto, url: string | null) {
    const stages = ['probe', 'transcode', 'proxy', 'thumbs'];
    stages.forEach((stage, i) => later(200 * (i + 1), () => { a.progress = (i + 1) / (stages.length + 1); emit('ingest.progress', { projectId: p.dto.id, assetId: a.id, stage, progress: a.progress }); }));
    const meta = await probe(url, a.kind);
    later(200 * (stages.length + 1), () => {
      a.status = 'ready'; a.progress = 1; a.updatedAt = nowIso();
      a.durationMs = a.kind === 'image' || a.kind === 'subtitle' ? (a.kind === 'image' ? 5000 : null) : meta.ms;
      if (a.kind === 'video' || a.kind === 'image') { a.width = meta.w; a.height = meta.h; }
      a.hasAudio = a.kind === 'video' || a.kind === 'audio';
      a.fps = a.kind === 'video' ? 30 : null;
      a.media = { original: true, playable: Boolean(url), proxy: false, thumb: a.kind === 'image' && Boolean(url), filmstrip: false, waveform: false };
      emit('ingest.done', { projectId: p.dto.id, asset: a });
    });
  }
  r('GET', '/projects/:id/assets', (m) => ({ items: proj(m[1]!).assets, nextCursor: null, total: proj(m[1]!).assets.length }));
  r('GET', '/projects/:id/assets/:aid', (m) => { const a = proj(m[1]!).assets.find((x) => x.id === m[2]); if (!a) throw new HttpError(404, 'EM-9003', 'Not found.'); return a; });
  r('DELETE', '/projects/:id/assets/:aid', (m, _b, q) => {
    const p = proj(m[1]!), a = p.assets.find((x) => x.id === m[2]);
    if (!a) throw new HttpError(404, 'EM-9003', 'Not found.');
    const model = head(p).model;
    const clips = model.tracks.video.filter((c) => c.assetId === a.id);
    const audio = model.tracks.audio.filter((x) => x.assetId === a.id);
    if ((clips.length || audio.length) && q.get('confirm') !== 'true') throw new HttpError(409, 'EM-1101', 'This asset is used in the timeline.', { clips: clips.length });
    p.assets = p.assets.filter((x) => x.id !== a.id); p.dto.assetCount = p.assets.length;
    // FR-052: an asset a version still uses is kept (soft delete) so Undo restores its Clips with media
    if ([...p.versions.values()].some((v) => JSON.stringify(v.model).includes(`"${a.id}"`))) p.removed = [...(p.removed ?? []), { ...a, sequenceBadge: null }];
    if (clips.length || audio.length) {
      const ops: OperationT[] = [...clips.map((c) => ({ op: 'op:clip.remove', target: { kind: 'clip' as const, id: c.id }, args: {} })), ...audio.map((x) => ({ op: 'op:audio.remove', target: { kind: 'audio' as const, id: x.id }, args: {} }))];
      const res = applyOperations(model, ops, { assets: facts(p).concat([{ id: a.id, kind: a.kind, status: 'ready' }]), tier: hardware.tier, newId });
      if (res.ok) return { version: strip(commit(p, res.value.model, 'system', res.value.diff)) };
    }
    return undefined;
  });
  r('PUT', '/projects/:id/assets/:aid/sequence-badge', (m, b) => {
    const p = proj(m[1]!), a = p.assets.find((x) => x.id === m[2]);
    if (!a) throw new HttpError(404, 'EM-9003', 'Not found.');
    const before = new Map(p.assets.map((x) => [x.id, x.sequenceBadge]));
    const badge = obj(b)['badge'];
    const want = typeof badge === 'number' ? Math.max(1, Math.min(200, Math.round(badge))) : null;
    a.sequenceBadge = null;
    const ordered = p.assets.filter((x) => x.sequenceBadge !== null).sort((x, y) => x.sequenceBadge! - y.sequenceBadge!);
    if (want !== null) ordered.splice(Math.min(want - 1, ordered.length), 0, a);
    ordered.forEach((x, i) => { x.sequenceBadge = i + 1; });                       // unique and gapless (IX-06)
    return { items: p.assets.filter((x) => before.get(x.id) !== x.sequenceBadge) };
  });
  r('POST', '/projects/:id/assets/insert', (m, b) => {
    const p = proj(m[1]!), body = obj(b);
    const ids = Array.isArray(body['assetIds']) ? (body['assetIds'] as unknown[]).map(String) : [];
    if (!ids.length) throw new HttpError(400, 'EM-9002', 'assetIds required.');
    const chosen = ids.map((id) => p.assets.find((a) => a.id === id)).filter((a): a is AssetDto => Boolean(a));
    const notReady = chosen.find((a) => a.status !== 'ready');
    if (notReady) throw new HttpError(422, 'EM-1301', `${notReady.name} is not ready yet.`);
    const ordered = body['order'] === 'given' ? chosen : [...chosen.filter((a) => a.sequenceBadge !== null).sort((x, y) => x.sequenceBadge! - y.sequenceBadge!), ...chosen.filter((a) => a.sequenceBadge === null)];
    let atIndex = typeof body['atIndex'] === 'number' ? body['atIndex'] : undefined;          // FR-030 / FR-049 after the selected Clip
    const atMs = typeof body['atMs'] === 'number' ? body['atMs'] : 0;
    const playheadMs = typeof body['playheadMs'] === 'number' ? body['playheadMs'] : atMs;        // FR-049: audio at the playhead
    const ops: OperationT[] = ordered.flatMap((a): OperationT[] => a.kind === 'audio' ? [{ op: 'op:audio.addLayer', args: { assetId: a.id, atMs: playheadMs, volume: 1, role: 'voice' } }]
      : a.kind === 'subtitle' ? [] : a.kind === 'image' && body['asOverlay'] === true ? [{ op: 'op:overlay.addImage', args: { assetId: a.id, atMs } }]   // FR-029
      : [{ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: a.id, ...(atIndex === undefined ? {} : { atIndex: atIndex++ }) } }]);
    const res = applyOperations(head(p).model, ops, { assets: facts(p), tier: hardware.tier, newId });
    if (!res.ok) throw new HttpError(422, res.issues[0]?.code ?? 'EM-2002', res.issues[0]?.message ?? 'Insert failed.');
    const v = commit(p, res.value.model, 'insert', res.value.diff);
    for (const a of ordered) a.sequenceBadge = null;
    // FR-049: one Edit Intent "Insert N clips", applied directly (Compile path), visible in the Intent Queue
    const it: EditIntent = { id: newId(), projectId: p.dto.id, source: 'ui', createdAt: nowIso(), category: 'asset', params: { targetLabel: `Insert ${ordered.length} clips`, __insert: { count: ordered.length, assetIds: ordered.map((a) => a.id) } },
      target: { kind: 'sequence' }, resolvedTargets: [{ kind: 'sequence' }], propertyKey: `list:asset.insert:${v.id}`, propertyClass: 'list', needsInterpretation: false, status: 'executed', supersedes: [], baseVersion: v.hash, appliedVersion: p.pointer + 1, appliedHash: v.hash };
    p.intents.push(it);
    emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [it.id], reason: 'compiled' });
    return { version: strip(v), ops, warnings: res.warnings, intentId: it.id };
  });
  r('POST', '/projects/:id/assets/:aid/relocate', () => { throw new HttpError(422, 'EM-1302', 'This file is different from the original.'); });
  r('POST', '/projects/:id/media-grants', (m) => { const p = proj(m[1]!); p.grant = { ...p.grant, grant: randomGrant() }; p.grant.baseUrl = `${MOCK_BASE}/media/${p.grant.grant}`; return created(p.grant); });
  r('DELETE', '/media-grants/:g', () => undefined);
  // composition
  r('GET', '/projects/:id/composition', (m, _b, q) => {
    const p = proj(m[1]!), v = head(p), t = deriveTiming(v.model);
    return { head: q.get('model') === 'false' ? strip(v) : v, canUndo: p.pointer > 0, canRedo: p.pointer < p.chain.length - 1, timing: { durationMs: t.durationMs, cutStartMs: t.cutStartMs }, issues: t.warnings };
  });
  r('GET', '/projects/:id/composition/versions', (m) => { const p = proj(m[1]!); const items = p.chain.map((id) => strip(p.versions.get(id)!)).reverse(); return { items, nextCursor: null, total: items.length }; });
  r('GET', '/projects/:id/composition/versions/:vid', (m) => { const v = proj(m[1]!).versions.get(m[2]!); if (!v) throw new HttpError(404, 'EM-2401', 'Version not found.'); return v; });
  r('POST', '/projects/:id/composition/undo', (m) => { const p = proj(m[1]!); if (p.pointer === 0) throw new HttpError(422, 'EM-2401', 'Nothing to undo.', { reason: 'at-root' }); const undone = head(p).hash; moveHead(p, p.pointer - 1, 'undo'); syncSettings(p, 'undo', undone); return { head: strip(head(p)), canUndo: p.pointer > 0, canRedo: true }; });
  r('POST', '/projects/:id/composition/redo', (m) => { const p = proj(m[1]!); if (p.pointer >= p.chain.length - 1) throw new HttpError(422, 'EM-2401', 'Nothing to redo.', { reason: 'no-redo' }); moveHead(p, p.pointer + 1, 'redo'); syncSettings(p, 'redo', head(p).hash); return { head: strip(head(p)), canUndo: true, canRedo: p.pointer < p.chain.length - 1 }; });
  r('GET', '/projects/:id/composition/diff', (m, _b, q) => ({ from: q.get('from'), to: q.get('to'), diff: [], ops: [] }));
  r('POST', '/projects/:id/composition/validate', (m, b) => {
    const p = proj(m[1]!), body = obj(b);
    if (body['baseVersion'] !== head(p).hash) throw new HttpError(409, 'EM-2301', 'Base version is not the head.');
    const res = applyOperations(head(p).model, (body['ops'] as OperationT[]) ?? [], { assets: facts(p), tier: hardware.tier, newId });
    return res.ok ? { ok: true, issues: res.warnings, predictedDiff: res.value.diff, predictedDurationMs: deriveTiming(res.value.model).durationMs } : { ok: false, issues: res.issues, predictedDiff: [], predictedDurationMs: 0 };
  });
  // intents
  r('POST', '/projects/:id/intents', (m, b) => created(createIntent(proj(m[1]!), obj(b) as unknown as DesignPickInput, obj(b)['source'] === 'chat' ? 'chat' : 'ui')));
  r('GET', '/projects/:id/intents', (m) => queueDto(proj(m[1]!)));
  // R-065 (FR-095 / FR-097): several fully specified picks as one unit — one Composition Version; settings intents stamped with it.
  r('POST', '/projects/:id/intents/batch', (m, b) => {
    const p = proj(m[1]!); const body = obj(b);
    const base = String(body['baseVersion'] ?? '');
    if (base !== head(p).hash) throw new HttpError(409, 'EM-2301', 'The composition changed after this pick was made.', { baseVersion: base, headVersion: head(p).hash });
    const picks = (Array.isArray(body['picks']) ? body['picks'] : []) as DesignPickInput[];
    const model: EditIntent[] = [], settingsOnes: EditIntent[] = []; const superseded: string[] = [];
    for (const pick of picks) {
      const r0 = createIntent(p, { ...pick, baseVersion: base, plan: 'none' }, 'ui');
      superseded.push(...r0.superseded);
      if (r0.intent.status === 'rejected') throw new HttpError(422, r0.notices[0]?.code ?? 'EM-2303', 'This pick cannot be used.');
      (pick.output?.kind === 'performanceProfile' ? settingsOnes : model).push(r0.intent);
    }
    if (model.some((i) => i.needsInterpretation)) throw new HttpError(422, 'EM-2303', 'These picks need the Editor Agent.');
    const leaves = model.flatMap((i) => { const kids = p.intents.filter((k) => k.parentIntentId === i.id); return kids.length ? kids : [i]; });
    const appliedVersion = compileAndApply(p, leaves, opsStore);
    settleParents(p);
    if (appliedVersion) for (const i of settingsOnes) i.appliedHash = appliedVersion.hash;
    emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [...model, ...settingsOnes].map((i) => i.id), reason: 'executed' });
    const intents = [...model, ...settingsOnes];
    return created({ intent: intents[0], intents, queue: queueDto(p), superseded, appliedVersion, planId: appliedVersion ? p.plans[p.plans.length - 1]!.id : null, notices: [] });
  });
  r('POST', '/projects/:id/intents/:iid/restore', (m) => {
    const p = proj(m[1]!), it = p.intents.find((i) => i.id === m[2]);
    if (!it) throw new HttpError(404, 'EM-9003', 'Not found.');
    const kids = p.intents.filter((c) => c.parentIntentId === it.id && c.status === 'superseded');
    const targets = kids.length ? kids : [it];
    if (it.status !== 'superseded' && !kids.length) throw new HttpError(409, 'EM-2309', 'Only replaced picks can be restored.');
    const model = head(p).model;
    for (const tgt of targets) {
      const t = tgt.resolvedTargets[0];
      if (t?.kind === 'clip' && !model.tracks.video.some((c) => c.id === t.id)) throw new HttpError(422, 'EM-2203', 'That clip is no longer in the timeline.');
      if (t?.kind === 'cut' && (t.index ?? 0) >= model.tracks.video.length - 1) throw new HttpError(422, 'EM-2203', 'That cut is no longer in the timeline.');
    }
    const superseded: string[] = [];
    for (const tgt of targets) { tgt.status = 'queued'; tgt.restoredAt = nowIso(); superseded.push(...supersedeFor(p, tgt)); }
    if (kids.length) { it.status = 'queued'; it.restoredAt = nowIso(); }
    let appliedVersion: VersionDto | null = null;
    if (settingsValueOf(it)) applySettingsIntent(it);
    else if (!it.needsInterpretation && targets.every((x) => opsStore.has(x.id))) appliedVersion = compileAndApply(p, targets, opsStore);
    if (kids.length && appliedVersion) it.status = 'executed';
    settleParents(p);
    emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [it.id, ...superseded], reason: 'restored' });
    return { intent: it, queue: queueDto(p), superseded, appliedVersion, planId: null, notices: [] };
  });
  r('DELETE', '/projects/:id/intents/:iid', (m) => {
    const p = proj(m[1]!), it = p.intents.find((i) => i.id === m[2]);
    if (!it) throw new HttpError(404, 'EM-9003', 'Not found.');
    if (it.status === 'executed') throw new HttpError(422, 'EM-9002', 'Applied changes are history and cannot be removed.', { reason: 'executed' });
    it.status = 'removed';
    for (const c of p.intents) if (c.parentIntentId === it.id && c.status !== 'executed') c.status = 'removed';
    for (const pl of p.plans) if (pl.status === 'valid') { pl.status = 'stale'; emit('plan.invalid', { projectId: p.dto.id, planId: pl.id, status: 'stale', code: 'EM-2301', validation: [], touchesLockedKeys: [] }); }
    emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [it.id], reason: 'removed' });
    return queueDto(p);
  });
  r('DELETE', '/projects/:id/intents', (m, _b, q) => {
    const p = proj(m[1]!), status = q.get('status') ?? 'queued';
    const changed: string[] = [];
    for (const i of p.intents) if (i.status === status || (status === 'queued' && i.status === 'rejected')) { i.status = 'removed'; changed.push(i.id); }
    emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed, reason: 'cleared' });
    return queueDto(p);
  });
  // plans
  r('POST', '/projects/:id/plans', (m, b) => {
    const p = proj(m[1]!), body = obj(b);
    if (body['baseVersion'] !== head(p).hash) throw new HttpError(409, 'EM-2301', 'Base version is not the head.');
    const ids = Array.isArray(body['intentIds']) && (body['intentIds'] as unknown[]).length ? (body['intentIds'] as unknown[]).map(String) : p.intents.filter((i) => i.status === 'queued').map((i) => i.id);
    const message = typeof body['message'] === 'string' ? body['message'] : undefined;
    const selected = p.intents.filter((i) => ids.includes(i.id));
    const leaves = selected.filter((i) => !p.intents.some((c) => c.parentIntentId === i.id) || i.parentIntentId);
    if (!message && leaves.length && leaves.every((i) => !i.needsInterpretation && opsStore.has(i.id))) {
      const ops = leaves.flatMap((i) => (opsStore.get(i.id) ?? []).map((o) => ({ ...o, intentId: i.id })));
      const plan: PlanDto = { id: newId(), projectId: p.dto.id, baseVersion: head(p).hash, origin: 'compile', goal: `Apply ${leaves.length} queued pick(s)`, steps: [{ n: 1, tool: 'composition.applyOps', ops, args: {}, expectedDiff: `${ops.length} change(s)`, dependsOn: [] }], touchesLockedKeys: [], risks: [], status: 'valid', validation: [] };
      p.plans.push(plan);
      for (const i of leaves) i.status = 'planned';
      emit('plan.ready', { projectId: p.dto.id, plan });
      return created(plan);
    }
    if (body['mode'] === 'compile-only') throw new HttpError(422, 'EM-2303', 'These picks need the Editor Agent.');
    agentChecks();
    if (!assignments.editor) throw new HttpError(422, 'EM-4007', 'The Editor Agent has no model yet.');
    if (p.plans.some((x) => x.status === 'draft')) throw new HttpError(409, 'EM-4305', 'The Editor Agent is still working on the previous request.');
    const plan = startAgentPlan(p, ids, message);
    return accepted({ plan, runId: newId() });
  });
  r('GET', '/projects/:id/plans', (m) => ({ items: proj(m[1]!).plans.slice().reverse(), nextCursor: null }));
  r('GET', '/plans/:pid', (m) => { for (const p of projects.values()) { const pl = p.plans.find((x) => x.id === m[1]); if (pl) return { ...pl, stale: pl.baseVersion !== head(p).hash, headHash: head(p).hash }; } throw new HttpError(404, 'EM-9003', 'Not found.'); });
  r('POST', '/plans/:pid/execute', (m) => executePlan(m[1]!));
  r('POST', '/plans/:pid/cancel', (m) => {
    for (const p of projects.values()) {
      const pl = p.plans.find((x) => x.id === m[1]);
      if (!pl) continue;
      if (pl.status === 'executing') throw new HttpError(409, 'EM-2309', 'Another change is being applied.');
      if (pl.status === 'executed') return pl;
      pl.status = 'cancelled';
      for (const i of p.intents) if (i.status === 'planned') i.status = 'queued';
      emit('plan.invalid', { projectId: p.dto.id, planId: pl.id, status: 'cancelled', code: 'EM-4303', validation: [], touchesLockedKeys: [] });
      emit('intent.updated', { projectId: p.dto.id, queue: queueDto(p), changed: [], reason: 'created' });
      return pl;
    }
    throw new HttpError(404, 'EM-9003', 'Not found.');
  });
  r('PATCH', '/plans/:pid/notes', (m, b) => { for (const p of projects.values()) { const pl = p.plans.find((x) => x.id === m[1]); if (pl) { pl.notes = String(obj(b)['notes'] ?? '').slice(0, 1000); return pl; } } throw new HttpError(404, 'EM-9003', 'Not found.'); });
  // conversations
  r('GET', '/projects/:id/conversations/:agent', (m) => {
    const p = proj(m[1]!), agent = m[2] as AgentKind;
    return { conversationId: `${p.dto.id}-${agent}`, agent, summary: null, assignment: assignments[agent], contextUsage: p.usage[agent], messages: { items: p.messages[agent], nextCursor: null } };
  });
  r('POST', '/projects/:id/conversations/:agent/messages', (m, b) => {
    const p = proj(m[1]!), agent = m[2] as AgentKind, body = obj(b);
    const text = String(body['text'] ?? '').trim();
    if (!text) throw new HttpError(400, 'EM-9002', 'Message is empty.');
    agentChecks();
    if (!assignments[agent]) throw new HttpError(422, 'EM-4007', `The ${agent === 'editor' ? 'Editor Agent' : 'Brainstorming Agent'} has no model yet.`);
    // FR-072: attachments become attachment blocks (images reach the model only with image input; checked in the Service).
    const atts = (Array.isArray(body['attachments']) ? body['attachments'] as Array<{ assetId: string }> : []).flatMap((x) => { const a = p.assets.find((y) => y.id === x.assetId); return a ? [{ type: 'attachment' as const, assetId: a.id, mime: a.kind === 'image' ? 'image/*' : `${a.kind}/*`, name: a.name }] : []; });
    const user: MessageDto = { id: newId(), role: 'user', blocks: [{ type: 'text', text }, ...atts], agentRunId: null, createdAt: nowIso() };
    p.messages[agent].push(user);
    if (agent === 'editor') {
      if (body['baseVersion'] !== head(p).hash) throw new HttpError(409, 'EM-2301', 'Base version is not the head.');
      const target = body['target'] as ElementRefT | undefined;
      const res = createIntent(p, { source: 'chat', category: 'text', target: { kind: 'selection' }, instruction: text, baseVersion: head(p).hash, plan: 'none' }, 'chat');
      // FR-080 / FR-067: the chat message is a chat Edit Intent (propertyKey chat:<id>) carrying the inspector's target.
      Object.assign(res.intent, { category: 'layout', propertyKey: `chat:${user.id}`, needsInterpretation: true, ...(target ? { target, resolvedTargets: [target] } : {}) });
      const plan = startAgentPlan(p, [res.intent.id], text);
      return accepted({ message: user, runId: lastEditorRunId, planId: plan.id });
    }
    const runId = newId();
    emit('agent.run.started', { projectId: p.dto.id, run: run(p, runId, 'brainstorm', 'running', null), agent: 'brainstorm', modelId: assignments.brainstorm?.modelId ?? 'mock' });
    const reply = 'Here is an idea: open with a short energetic title, keep cuts quick, and use readable captions. I can hand these to the Editor Agent.';
    reply.split(/(?<=[.,:]) /).forEach((chunk, i) => later(150 * (i + 1), () => emit('agent.run.delta', { projectId: p.dto.id, runId, agent: 'brainstorm', delta: `${chunk} ` })));
    later(900, () => {
      const pi = (category: IntentCategory, presetId: string | undefined, needs: boolean, instruction?: string): EditIntent => ({ id: newId(), projectId: p.dto.id, source: 'brainstorm', createdAt: nowIso(), category, ...(presetId ? { presetId } : {}), params: {}, target: category === 'transition' ? { kind: 'selection' } : { kind: 'project' }, resolvedTargets: [], propertyKey: '', propertyClass: 'exclusive-group', needsInterpretation: needs, ...(instruction ? { instruction } : {}), status: 'queued', supersedes: [], baseVersion: head(p).hash });
      const blocks: MessageBlock[] = [{ type: 'text', text: reply }, { type: 'proposed_intents', handoffState: 'pending', intents: [pi('caption', 'preset:caption.editorial', false), pi('transition', 'preset:transition.slide', false), pi('text', undefined, true, 'Judul pembuka yang energik')] }];
      const msg: MessageDto = { id: newId(), role: 'assistant', blocks, agentRunId: runId, createdAt: nowIso() };
      p.messages.brainstorm.push(msg);
      p.usage.brainstorm = { usedTokens: 1240 + p.messages.brainstorm.length * 180, contextLength: 200_000 };
      emit('agent.run.done', { projectId: p.dto.id, run: run(p, runId, 'brainstorm', 'done', null), message: msg, usage: { inputTokens: 1240, outputTokens: 220, costUsd: 0.002, approximate: true, contextLength: 200_000 }, contextUsage: p.usage.brainstorm });
    });
    return accepted({ message: user, runId });
  });
  r('POST', '/projects/:id/conversations/brainstorm/handoff', (m, b) => {
    const p = proj(m[1]!), body = obj(b);
    const msg = p.messages.brainstorm.find((x) => x.id === body['messageId']);
    const block = msg?.blocks.find((x): x is Extract<MessageBlock, { type: 'proposed_intents' }> => x.type === 'proposed_intents');
    if (!block) throw new HttpError(404, 'EM-9003', 'Not found.');
    if (body['baseVersion'] !== head(p).hash) throw new HttpError(409, 'EM-2301', 'Base version is not the head.');
    const subset = Array.isArray(body['intentIds']) ? (body['intentIds'] as unknown[]).map(String) : block.intents.map((i) => i.id);
    const accepted: string[] = [], rejected: Array<{ id: string; code: string }> = [];
    const interpret: string[] = [];
    for (const pi of block.intents.filter((i) => subset.includes(i.id))) {
      try {
        const res = createIntent(p, { source: 'ui', category: pi.category, ...(pi.presetId ? { presetId: pi.presetId } : {}), params: pi.params, target: pi.target, ...(pi.instruction ? { instruction: pi.instruction } : {}), baseVersion: head(p).hash, plan: 'auto' }, 'brainstorm');
        if (res.intent.status === 'rejected') rejected.push({ id: pi.id, code: res.notices[0]?.code ?? 'EM-2101' }); else accepted.push(pi.id);
        if (res.intent.needsInterpretation) interpret.push(res.intent.id);
      } catch (e) { rejected.push({ id: pi.id, code: e instanceof HttpError ? e.code : 'EM-9001' }); }
    }
    block.handoffState = 'sent';
    let planId: string | null = null;
    if (interpret.length && assignments.editor && !settings.privateMode) planId = startAgentPlan(p, interpret, undefined).id;
    return { queue: queueDto(p), accepted, rejected, planId };
  });
  r('DELETE', '/projects/:id/conversations/:agent', (m) => { proj(m[1]!).messages[m[2] as AgentKind] = []; return undefined; });
  r('GET', '/agent-runs/:rid', (m) => ({ id: m[1], status: 'done' }));
  r('POST', '/agent-runs/:rid/cancel', (m) => {
    for (const p of projects.values()) for (const pl of p.plans) if (pl.status === 'draft') { pl.status = 'cancelled'; for (const i of p.intents) if (i.status === 'planned') i.status = 'queued'; emit('plan.invalid', { projectId: p.dto.id, planId: pl.id, status: 'cancelled', code: 'EM-4303', validation: [], touchesLockedKeys: [] }); }
    return { id: m[1], status: 'cancelled' };
  });
  r('GET', '/projects/:id/usage', (m) => { proj(m[1]!); return { project: { inputTokens: 0, outputTokens: 0, costUsd: 0, approximate: true, runs: 0 }, byAgent: {}, byModel: [], budget: { projectLimitUsd: [...projectBudgets.entries()].find(([k, v]) => k.startsWith(`${m[1]!}|`) && v)?.[1] ?? null, monthLimitUsd: connections[0]?.budgetMonthUsd ?? null, spentMonthUsd: 0, warn80: false, exceeded: false } }; });
  // providers
  r('GET', '/providers/connections', () => ({ items: connections.map((c) => ({ ...c, modelCount: c.modelsFetchedAt ? CAPABILITIES.length : null })) }));
  r('POST', '/providers/connections', (_m, b) => {
    const body = obj(b), secret = String(body['secret'] ?? '');
    if (secret.length < 8) throw new HttpError(400, 'EM-9002', 'Key is too short.', undefined);
    const c: ConnectionDto = { id: newId(), provider: (body['provider'] as ConnectionDto['provider']) ?? 'openrouter', label: String(body['label'] ?? 'OpenRouter'), baseUrl: typeof body['baseUrl'] === 'string' ? body['baseUrl'] : null, secretHint: `…${secret.slice(-4)}`, status: 'unvalidated', validatedAt: null, modelsFetchedAt: null, budgetMonthUsd: typeof body['budgetMonthUsd'] === 'number' ? body['budgetMonthUsd'] : null, createdAt: nowIso(), updatedAt: nowIso() };
    connections.push(c);
    if (!assignments.defaultConnectionId) assignments.defaultConnectionId = c.id;
    if (body['validateNow'] !== false && !settings.privateMode) {
      if (/bad|invalid/i.test(secret)) { c.status = 'invalid'; throw new HttpError(422, 'EM-4002', 'The key was not accepted by the provider.'); }
      c.status = 'valid'; c.validatedAt = nowIso(); c.modelsFetchedAt = nowIso();
    }
    emit('settings.changed', { scope: 'providers' });
    return created(c);
  });
  const conn = (id: string) => { const c = connections.find((x) => x.id === id); if (!c) throw new HttpError(404, 'EM-9003', 'Not found.'); return c; };
  r('PATCH', '/providers/connections/:cid', (m, b) => { const c = conn(m[1]!), body = obj(b); if (typeof body['label'] === 'string') c.label = body['label']; if (typeof body['secret'] === 'string') { c.secretHint = `…${body['secret'].slice(-4)}`; c.status = 'unvalidated'; } if ('budgetMonthUsd' in body) c.budgetMonthUsd = typeof body['budgetMonthUsd'] === 'number' ? body['budgetMonthUsd'] : null; c.updatedAt = nowIso(); return c; });
  r('DELETE', '/providers/connections/:cid', (m, _b, q) => {
    const c = conn(m[1]!);
    const used = (['brainstorm', 'editor'] as const).filter((a) => assignments[a]?.connectionId === c.id);
    if (used.length && q.get('force') !== 'true') throw new HttpError(409, 'EM-2309', 'This connection is assigned to an agent.', { assignments: used });
    for (const a of used) assignments[a] = null;
    connections.splice(connections.indexOf(c), 1);
    return undefined;
  });
  r('POST', '/providers/connections/:cid/validate', (m) => {
    const c = conn(m[1]!);
    if (settings.privateMode) throw new HttpError(423, 'EM-8202', 'Private Mode is on.');
    if (c.status === 'invalid') return { status: 'invalid', validatedAt: nowIso(), errorCode: 'EM-4002' };
    c.status = 'valid'; c.validatedAt = nowIso(); c.modelsFetchedAt = nowIso();
    return { status: 'valid', validatedAt: c.validatedAt };
  });
  r('GET', '/providers/connections/:cid/models', (m) => { const c = conn(m[1]!); return c.modelsFetchedAt ? { items: CAPABILITIES, fetchedAt: c.modelsFetchedAt, stale: false } : { items: [], fetchedAt: null, stale: false, notice: 'EM-4006' }; });
  r('POST', '/providers/connections/:cid/models/refresh', (m) => { const c = conn(m[1]!); if (settings.privateMode) throw new HttpError(423, 'EM-8202', 'Private Mode is on.'); c.modelsFetchedAt = nowIso(); return { items: CAPABILITIES, fetchedAt: c.modelsFetchedAt }; });
  r('GET', '/providers/assignments', () => assignments);
  r('PUT', '/providers/assignments', (_m, b) => {
    const body = obj(b);
    for (const agent of ['brainstorm', 'editor'] as const) {
      if (!(agent in body)) continue;
      const a = body[agent] as AssignmentDto | null;
      if (a) {
        const cap = CAPABILITIES.find((x) => x.modelId === a.modelId);
        if (cap && cap.structuredOutput === false) throw new HttpError(422, 'EM-9002', 'This model cannot return structured output.', { reason: 'no-json-output' });
      }
      assignments[agent] = a ? { ...a, agent } : null;
    }
    if ('defaultConnectionId' in body) assignments.defaultConnectionId = (body['defaultConnectionId'] as string | null) ?? null;
    emit('settings.changed', { scope: 'assignments' });
    const warnings = (['brainstorm', 'editor'] as const).flatMap((agent) => { const cap = CAPABILITIES.find((x) => x.modelId === assignments[agent]?.modelId); return cap && (cap.toolCalling !== true || cap.structuredOutput !== true) ? [{ code: 'EM-4005', path: `body.${agent}.modelId`, message: 'simple mode', severity: 'info' as const }] : []; });
    return { ...assignments, warnings };
  });
  const budget = () => ({ connections: connections.map((c) => ({ connectionId: c.id, budgetMonthUsd: c.budgetMonthUsd, spentMonthUsd: 0.12, approximate: true })), projects: [...projectBudgets.entries()].map(([k, limitUsd]) => { const [projectId, connectionId] = k.split('|') as [string, string]; return { projectId, connectionId: connectionId || null, limitUsd, spentUsd: 0.01 }; }), month: new Date().toISOString().slice(0, 7) });
  r('GET', '/providers/budget', budget);
  r('PUT', '/providers/budget', (_m, b) => {
    const body = obj(b);
    for (const c of (Array.isArray(body['connections']) ? body['connections'] : []) as Array<{ connectionId: string; budgetMonthUsd: number | null }>) { const x = connections.find((y) => y.id === c.connectionId); if (x) x.budgetMonthUsd = c.budgetMonthUsd; }
    for (const pb of (Array.isArray(body['projects']) ? body['projects'] : []) as Array<{ projectId: string; connectionId?: string | null; limitUsd: number | null }>) projectBudgets.set(`${pb.projectId}|${pb.connectionId ?? ''}`, pb.limitUsd);
    emit('settings.changed', { scope: 'budget' });
    return budget();
  });
  // R-101…R-103 (FR-111, FR-113, FR-116)
  r('GET', '/providers/kinds', () => ({ items: [
    { provider: 'openrouter', enabled: true, priority: 'P0', termsUrl: 'https://openrouter.ai/terms', keyPattern: '^sk-or-v1-[A-Za-z0-9]{20,}$', keyExample: 'sk-or-v1-…' },
    { provider: 'openai', enabled: false, priority: 'P1', termsUrl: 'https://openai.com/policies/terms-of-use', keyPattern: '^sk-[A-Za-z0-9_-]{20,}$', keyExample: 'sk-…' },
    { provider: 'anthropic', enabled: false, priority: 'P1', termsUrl: 'https://www.anthropic.com/legal/commercial-terms', keyPattern: '^sk-ant-[A-Za-z0-9_-]{20,}$', keyExample: 'sk-ant-…' },
    { provider: 'google', enabled: false, priority: 'P1', termsUrl: 'https://ai.google.dev/gemini-api/terms', keyPattern: '^AIza[0-9A-Za-z_-]{30,}$', keyExample: 'AIza…' },
    { provider: 'custom', enabled: false, priority: 'P2', termsUrl: null, keyPattern: null, keyExample: null },
  ] }));
  r('POST', '/providers/validate', (_m, b) => {
    const body = obj(b), secret = String(body['secret'] ?? '').trim();
    if (body['provider'] !== 'openrouter') throw new HttpError(422, 'EM-9004', 'Not available in this version yet.', { feature: `provider.${String(body['provider'])}`, plannedPriority: 'P1' });
    if (settings.privateMode) throw new HttpError(423, 'EM-8202', 'Private Mode is on.');
    if (/bad|invalid/i.test(secret)) throw new HttpError(422, 'EM-4002', 'The key was not accepted by the provider.');
    return { status: 'valid', validatedAt: nowIso(), models: CAPABILITIES };
  });
  r('POST', '/providers/test', (_m, b) => {
    const body = obj(b);
    if (settings.privateMode) throw new HttpError(423, 'EM-8202', 'Private Mode is on.');
    const items = (['brainstorm', 'editor'] as const).flatMap((agent) => {
      const modelId = typeof body[agent] === 'string' ? (body[agent] as string) : body[agent] === null ? null : assignments[agent]?.modelId ?? null;
      if (!modelId) return [];
      const cap = CAPABILITIES.find((x) => x.modelId === modelId);
      return [{ agent, modelId, ok: true, latencyMs: 1200, inputTokens: 30, outputTokens: 8, costUsd: cap?.pricePerMInput != null ? 0.0001 : null, approximate: true }];
    });
    if (!items.length) throw new HttpError(422, 'EM-4007', 'No agent has a model to test yet.');
    return { items };
  });
  // renders
  r('POST', '/renders/estimate', (_m, b) => estimate(obj(b) as unknown as RenderCreateInput));
  r('POST', '/renders', (_m, b) => accepted(startRender(obj(b) as unknown as RenderCreateInput)));
  r('GET', '/renders', (_m, _b, q) => ({ items: renders.filter((j) => !q.get('projectId') || j.projectId === q.get('projectId')), nextCursor: null }));
  r('GET', '/renders/:jid', (m) => { const j = renders.find((x) => x.id === m[1]); if (!j) throw new HttpError(404, 'EM-9003', 'Not found.'); return j; });
  r('POST', '/renders/:jid/cancel', (m) => {
    const j = renders.find((x) => x.id === m[1]);
    if (!j) throw new HttpError(404, 'EM-9003', 'Not found.');
    if (j.status === 'queued' || j.status === 'rendering') { cancelledRenders.add(j.id); j.status = 'cancelled'; j.finishedAt = nowIso(); emit('render.cancelled', { projectId: j.projectId, jobId: j.id, percent: Math.round(j.progress * 100) }); }
    return j;
  });
  const findOutput = (id: string) => { for (const p of projects.values()) { const o = p.outputs.find((x) => x.id === id); if (o) return { p, o }; } throw new HttpError(404, 'EM-9003', 'Not found.'); };
  r('GET', '/projects/:id/outputs', (m) => ({ items: proj(m[1]!).outputs, nextCursor: null }));
  r('GET', '/outputs/:oid', (m) => findOutput(m[1]!).o);
  r('DELETE', '/outputs/:oid', (m) => { const { p, o } = findOutput(m[1]!); p.outputs = p.outputs.filter((x) => x !== o); return undefined; });
  r('POST', '/outputs/:oid/reveal', (m) => { const { o } = findOutput(m[1]!); return { path: o.path, folder: o.path.replace(/[\\/][^\\/]+$/, '') }; });
  // catalogue
  const catItem = (p: ReturnType<typeof listPresets>[number]): CatalogueItemDto => ({
    id: p.id, category: p.category, label: { ...p.label }, tags: [...p.tags], propertyClass: p.propertyClass, priority: p.priority, flags: [...p.flags], preview: '', paramsSchema: {}, defaults: { ...p.defaults },
    availability: p.flags.includes('webgpu') && hardware.tier !== 'T2' ? { ok: false, reason: 'webgpu', code: 'EM-2103' } : p.flags.includes('gpu') && hardware.tier === 'T0' ? { ok: true, reason: 'gpu', code: 'EM-2103' } : { ok: true },
  });
  r('GET', '/catalogue', (_m, _b, q) => ({ items: listPresets({ ...(q.get('category') ? { category: q.get('category') as Category } : {}), priority: (q.get('priority') ?? 'p0').split(',') as Array<'p0' | 'p1' | 'p2'> }).map(catItem), catalogueVersion: 'mock' }));
  r('GET', '/catalogue/search', (_m, _b, q) => ({ items: listPresets().filter((p) => p.label.en.toLowerCase().includes((q.get('q') ?? '').toLowerCase())).map((p) => ({ ...catItem(p), score: 1 })), suggestions: ['fade', 'karaoke', 'transisi halus', 'judul besar', 'latar gradasi', 'zoom pelan'] }));
  // generators
  /** FR-104: caption Insert also sets the default caption style when the project has none (generators-service withCaptionStyle). */
  const withCaptionStyle = (p: Parameters<typeof head>[0], ops: OperationT[]): OperationT[] =>
    ops.some((o) => o.op === 'op:caption.setPages') && !ops.some((o) => o.op === 'op:caption.setStyle') && head(p).model.tracks.caption.styleId === null
      ? [...ops, { op: 'op:caption.setStyle', target: { kind: 'project' }, args: { presetId: 'preset:caption.editorial' } }] : ops;
  r('POST', '/projects/:id/generators/:kind', (m, b) => {
    const p = proj(m[1]!), kind = m[2] as GeneratorJobDto['kind'], body = obj(b);
    if (kind === 'music' || kind === 'thumbnail') throw new HttpError(422, 'EM-9004', 'Coming in a later version.', { feature: kind });
    if (kind === 'hashtags') { if (settings.privateMode) throw new HttpError(423, 'EM-8202', 'Private Mode is on.'); if (!connections.length) throw new HttpError(503, 'EM-4001', 'No AI provider is connected.'); }
    const needed = kind === 'captions' ? 'whisper-small' : kind === 'voice' ? 'piper-id-news' : null;
    const model = needed ? models.find((x) => x.key === (typeof body['modelKey'] === 'string' ? body['modelKey'] : needed)) : null;
    if (needed && model?.status !== 'installed') throw new HttpError(422, 'EM-7001', 'Model not installed.', { modelKey: needed, bytes: model?.bytesTotal ?? 0 });
    const job: GeneratorJobDto = { id: newId(), projectId: p.dto.id, kind, status: 'running', progress: 0, modelKey: model?.key ?? null, resultAssetId: null, result: null, errorCode: null, createdAt: nowIso(), startedAt: nowIso(), finishedAt: null };
    p.genJobs.unshift(job);
    [0.4, 0.8].forEach((pr, i) => later(300 * (i + 1), () => { job.progress = pr; emit('service.notice', { projectId: p.dto.id, kind: 'generator', jobId: job.id, percent: Math.round(pr * 100) }); }));
    later(1000, () => {
      job.status = 'done'; job.progress = 1; job.finishedAt = nowIso();
      const pages = [{ text: 'Selamat datang di Kafe Senja', startMs: 0, durationMs: 2000, tokens: [] }];
      let ops: OperationT[] = [];
      if (kind === 'voice') {                                    // the voice becomes an Asset (generators-service register()), like the real service
        const a = addAsset(p, { name: `voice-${job.id.slice(-6).toLowerCase()}.wav`, kind: 'audio', status: 'ready', progress: 1, durationMs: 3000, hasAudio: true, bytes: 96_000,
          media: { original: true, playable: false, proxy: false, thumb: false, filmstrip: false, waveform: false } }, null);
        job.resultAssetId = a.id;
        emit('ingest.done', { projectId: p.dto.id, asset: a });
        ops = [{ op: 'op:audio.addLayer', args: { assetId: a.id, atMs: typeof body['atMs'] === 'number' ? body['atMs'] : 0, volume: 1, role: 'voice' } }];
      } else if (kind === 'captions') ops = withCaptionStyle(p, [{ op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages } }]);
      job.result = kind === 'hashtags' ? { caption: 'Senja, kopi, dan cerita kecil di Kafe Senja.', hashtags: ['#kafesenja', '#kopisusu', '#ngopi', '#senja', '#kopilokal'], tone: typeof body['tone'] === 'string' ? body['tone'] : 'casual' }
        : kind === 'captions' ? { pages } : { text: String(body['text'] ?? '') };
      if (body['insert'] === true && ops.length) {               // R-130 `insert: true`: deterministic apply, no Editor Agent plan
        const res = applyOperations(head(p).model, ops, { assets: facts(p), tier: hardware.tier, newId });
        if (res.ok) job.result['versionId'] = commit(p, res.value.model, 'system', res.value.diff).id;
      }
      if (ops.length) job.result['proposedOps'] = ops;
      emit('service.notice', { projectId: p.dto.id, kind: 'generator', jobId: job.id, percent: 100, done: true });
    });
    return accepted(job);
  });
  r('POST', '/generator-jobs/:jid/insert', (m, b) => {        // R-134: apply a finished job's proposed ops later, idempotent; captions may carry edited pages
    for (const p of projects.values()) {
      const j = p.genJobs.find((x) => x.id === m[1]); if (!j) continue;
      if (j.status !== 'done') throw new HttpError(422, 'EM-9002', 'This result is not ready yet.');
      if (typeof j.result?.['versionId'] === 'string') return { versionId: j.result['versionId'], notice: 'EM-2308' };
      const pagesOverride = Array.isArray(obj(b)['pages']) ? obj(b)['pages'] : null;
      const ops = withCaptionStyle(p, ((j.result?.['proposedOps'] ?? []) as OperationT[])).map((o) => (pagesOverride && o.op === 'op:caption.setPages' ? { ...o, args: { ...o.args, pages: pagesOverride } } as OperationT : o));
      if (!ops.length) throw new HttpError(422, 'EM-9002', 'This result has nothing to insert.');
      const res = applyOperations(head(p).model, ops, { assets: facts(p), tier: hardware.tier, newId });
      if (!res.ok) throw new HttpError(422, res.issues[0]?.code ?? 'EM-2102', res.issues[0]?.message ?? 'Invalid.');
      const versionId = commit(p, res.value.model, 'system', res.value.diff).id; j.result = { ...(j.result ?? {}), versionId };
      return { versionId };
    }
    throw new HttpError(404, 'EM-9003', 'Not found.');
  });
  r('GET', '/projects/:id/generator-jobs', (m, _b, q) => { const items = proj(m[1]!).genJobs.filter((j) => !q.get('kind') || j.kind === q.get('kind')); return { items, nextCursor: null, total: items.length }; });
  r('DELETE', '/generator-jobs/:jid', (m) => { for (const p of projects.values()) { const n = p.genJobs.length; p.genJobs = p.genJobs.filter((x) => x.id !== m[1]); if (p.genJobs.length !== n) return undefined; } throw new HttpError(404, 'EM-9003', 'Not found.'); });   // R-137
  r('POST', '/generator-jobs/:jid/save-output', () => { throw new HttpError(422, 'EM-9004', 'Coming in a later version.', { feature: 'thumbnail' }); });   // R-136 (thumbnail is off in the mock build)
  r('GET', '/generators', () => {                                                                                 // R-135: the mock build enables P1 generators only
    const card = (kind: GeneratorJobDto['kind'], task: string | null, def: string | null) => {
      const list = task ? models.filter((x) => x.task === task).map((x) => ({ key: x.key, label: x.label, ...(x.displayName ? { displayName: x.displayName } : {}), bytes: x.bytesTotal, installed: x.status === 'installed', languages: [], minTier: x.tiers[0] ?? 'T0', belowTier: !x.tiers.includes(hardware.tier), cc0: false })) : [];
      const model = list.find((x) => x.key === def) ?? list[0] ?? null;
      return { kind, enabled: kind !== 'music' && kind !== 'thumbnail', priority: kind === 'music' || kind === 'thumbnail' ? 'P2' : 'P1', llm: kind === 'hashtags', tierHint: model?.belowTier ? 'slow' : 'ok', model, models: list, tier: hardware.tier };
    };
    return { items: [card('voice', 'tts', 'piper-id-news'), card('music', 'music', null), card('thumbnail', 'image', null), card('captions', 'stt', 'whisper-small'), card('hashtags', null, null)] };
  });
  r('GET', '/generator-jobs/:jid', (m) => { for (const p of projects.values()) { const j = p.genJobs.find((x) => x.id === m[1]); if (j) return j; } throw new HttpError(404, 'EM-9003', 'Not found.'); });
  r('POST', '/generator-jobs/:jid/cancel', (m) => { for (const p of projects.values()) { const j = p.genJobs.find((x) => x.id === m[1]); if (j) { if (j.status === 'running') j.status = 'cancelled'; return j; } } throw new HttpError(404, 'EM-9003', 'Not found.'); });
  // models
  const model = (key: string) => { const x = models.find((y) => y.key === key); if (!x) throw new HttpError(404, 'EM-9003', 'Not found.'); return x; };
  r('GET', '/models', () => ({ items: models, tier: hardware.tier, totalInstalledBytes: models.filter((x) => x.status === 'installed').reduce((s, x) => s + x.bytesTotal, 0), diskFreeBytes: 48_000_000_000 }));
  r('GET', '/models/:key', (m) => model(decodeURIComponent(m[1]!)));
  r('POST', '/models/:key/install', (m) => {
    const x = model(decodeURIComponent(m[1]!));
    if (settings.privateMode) throw new HttpError(423, 'EM-8202', 'Private Mode is on.');
    if (x.status === 'downloading') throw new HttpError(409, 'EM-7104', 'Already downloading.');
    x.status = 'downloading'; cancelledDownloads.delete(x.key);
    const step = () => {
      if (cancelledDownloads.has(x.key) || x.status !== 'downloading') return;
      x.bytesDone = Math.min(x.bytesTotal, x.bytesDone + Math.ceil(x.bytesTotal / 8));
      if (x.bytesDone < x.bytesTotal) { emit('model.progress', { key: x.key, bytesDone: x.bytesDone, bytesTotal: x.bytesTotal, status: 'downloading' }); later(350, step); return; }
      x.status = 'installed'; x.installedAt = nowIso();
      resumeHeld();                                                     // FR-037: before the announcement, like the Service
      emit('model.installed', { model: x });
    };
    later(200, step);
    return accepted(x);
  });
  r('POST', '/models/:key/cancel', (m, _b, q) => { const x = model(decodeURIComponent(m[1]!)); cancelledDownloads.add(x.key); if (x.status === 'downloading') x.status = 'not-installed'; if (q.get('discard') === 'true') x.bytesDone = 0; return x; });
  r('POST', '/models/engines/:engine/reveal', (m) => ({ path: `C:\\Users\\septi\\AppData\\Roaming\\Expertmotion\\models\\${decodeURIComponent(m[1]!)}` }));   // R-146
  r('DELETE', '/models/:key', (m) => { const x = model(decodeURIComponent(m[1]!)); x.status = 'not-installed'; x.bytesDone = 0; x.installedAt = null; return undefined; });
  // hardware, licence, settings, diagnostics
  r('GET', '/hardware/profile', () => hardware);
  r('POST', '/hardware/profile/refresh', () => ({ ...hardware, detectedAt: nowIso() }));
  r('GET', '/hardware/live', () => ({ at: nowIso(), cpuPercent: 18 + Math.round(Math.random() * 20), ramFreeMb: 7400 + Math.round(Math.random() * 300), ramTotalMb: hardware.ramTotalMb, processMb: 580 + Math.round(Math.random() * 60), chromeMb: renders.some((j) => j.status === 'rendering') ? 420 : null, shellMb: 210, diskFreeMb: 48_000, outputDiskFreeMb: 48_000, gpuPercent: null, workload: { rendering: renders.some((j) => j.status === 'rendering'), ingesting: 0, downloading: models.filter((x) => x.status === 'downloading').length, agentRuns: 0,
    items: [
      ...renders.filter((j) => j.status === 'rendering' || j.status === 'queued').map((j) => ({ kind: 'render' as const, id: j.id, label: projects.get(j.projectId)?.dto.name ?? '', status: j.status, progress: j.status === 'rendering' ? j.progress : null, cancellable: true, pausedReason: null })),
      ...models.filter((x) => x.status === 'downloading' || x.status === 'paused').map((x) => ({ kind: 'download' as const, id: x.key, label: x.label, ...(x.displayName ? { displayName: x.displayName } : {}), status: x.status, progress: x.bytesTotal ? x.bytesDone / x.bytesTotal : null, cancellable: true, pausedReason: x.pausedReason ?? null })),
    ] } }));
  r('GET', '/license', () => license);
  r('POST', '/license/activate', (_m, b) => {
    const key = String(obj(b)['key'] ?? '').trim();
    if (key.length < 40 || !/^EM1[-.]/.test(key)) throw new HttpError(422, 'EM-5006', 'This does not look like a licence key.');
    license = licensedDto();
    emit('license.changed', { licence: license });
    return license;
  });
  r('POST', '/license/deactivate', () => { license = UNLICENSED; emit('license.changed', { licence: license }); return license; });
  r('GET', '/settings', () => settings);
  r('PUT', '/settings', (_m, b) => {
    const prevPrivate = settings.privateMode;
    settings = { ...settings, ...(obj(b) as Partial<SettingsDto>) };
    emit('settings.changed', prevPrivate !== settings.privateMode ? { scope: 'privateMode', settings, privateMode: settings.privateMode } : { scope: 'settings', settings });
    return settings;
  });
  r('POST', '/settings/caches/clear', () => ({ freedBytes: 123_000_000 }));
  r('POST', '/diagnostics/bundle', () => ({ path: 'C:\\Users\\septi\\AppData\\Roaming\\Expertmotion\\logs\\diagnostics-mock.zip', bytes: 182_000, contents: ['service.log', 'versions.json', 'hardware.json', 'settings.redacted.json'] }));
  r('GET', '/diagnostics/codes', () => ({ items: renders.filter((j) => j.errorCode).map((j) => ({ at: j.finishedAt ?? j.createdAt, code: j.errorCode!, source: 'render', ref: j.id })) }));   // R-182
  r('GET', '/diagnostics/logs', () => ({ lines: [`{"level":"info","msg":"mock service started","at":"${new Date(startedAt).toISOString()}"}`, '{"level":"warn","msg":"engine: browser download skipped in mock mode"}'] }));

  const respond = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Expertmotion-Version': '0.0.0-mock' } });

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});
    if (path !== '/health' && headers.get('Authorization') !== `Bearer ${MOCK_TOKEN}`) {
      return respond(401, { error: { code: 'EM-8004', message: 'Not authorised.' } });
    }
    let body: unknown;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { return respond(400, { error: { code: 'EM-9002', message: 'Invalid JSON.' } }); } }
    // Licence gate (service: modules/license.ts): only the licence screen's routes answer while unlicensed.
    const open = (method === 'GET' && ['/health', '/version', '/license', '/settings', '/events', '/renders'].includes(path)) || (method === 'POST' && path === '/license/activate')
      || (method === 'PUT' && path === '/settings' && !!body && typeof body === 'object' && Object.keys(body).every((k) => k === 'uiLanguage' || k === 'theme'));
    if (license.status !== 'licensed' && !open) return respond(403, { error: { code: 'EM-5010', message: 'Activate Expertmotion with a Licence Key to continue.', details: { status: license.status } } });
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const match = path.match(re);
      if (!match) continue;
      try {
        const out = h(match, body, url.searchParams, init);
        if (out && typeof out === 'object' && '__status' in out) { const o = out as { __status: number; body: unknown }; return respond(o.__status, o.body); }
        return out === undefined ? new Response(null, { status: 204 }) : respond(200, out);
      } catch (e) {
        if (e instanceof HttpError) return respond(e.status, { error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } });
        // eslint-disable-next-line no-console
        console.error('[mock]', e);
        return respond(500, { error: { code: 'EM-9001', message: 'Something went wrong.' } });
      }
    }
    return respond(404, { error: { code: 'EM-9003', message: `No mock route for ${method} ${path}` } });
  };

  const mediaResolver: MediaResolver = (_grant, id, variant) => {
    const u = media.get(id);
    if (!u) return variant === 'file' || variant === 'thumb' ? sampleImage('Export', '#E8913A', '#16181D', 1080, 1080) : null;
    return u;
  };

  return { fetch: fetchImpl, mediaResolver, bus, token: MOCK_TOKEN, baseUrl: MOCK_BASE, firstProjectId: () => [...projects.keys()][0] ?? null };
}

function randomGrant(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 43);
}
