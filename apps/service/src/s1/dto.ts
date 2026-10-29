// Request schemas and response mappers for the S1 routes (API_SPECIFICATION §3, §6.2–6.3, §6.6–6.8). Names follow the spec.
import { z } from 'zod';
import { CLIPBOARD_MAX_ENTRIES, ElementRef, Operation, PASTE_OPS, ProjectSettings, Theme, type CompositionModelT } from '@expertmotion/composition-model';
import { EditIntent, INTENT_CATEGORIES, type EditIntentT, type EditPlanT } from '@expertmotion/agents';
import { ULID_RE } from '@expertmotion/shared';

export const Id = z.string().regex(ULID_RE, 'must be an id');
export const ProjectParams = z.object({ id: Id });
export const PlanParams = z.object({ planId: Id });

const boolQ = z.enum(['true', 'false']).optional().transform((v) => v === 'true');
export const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(400).optional() });

export const ProjectCreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  settings: ProjectSettings.partial().optional(),
  language: z.enum(['id', 'en']).default('id'),
  theme: Theme.partial().optional(),
  // FR-009: chosen in the New dialog. durationPolicy lands on v1; outputFolder is stored with the project settings (R-017).
  durationPolicy: z.enum(['fit-content', 'fixed']).optional(),
  fixedDurationMs: z.number().int().min(1000).max(1_800_000).optional(),
  outputFolder: z.string().min(1).max(1024).optional(),
}).strict();
/** R-018 body: ProjectSettings plus the duration policy (op:project.setDurationPolicy) and the per-project output folder (null clears). */
export const ProjectSettingsInput = ProjectSettings.extend({
  durationPolicy: z.enum(['fit-content', 'fixed']).optional(),
  fixedDurationMs: z.number().int().min(1000).max(1_800_000).optional(),
  outputFolder: z.string().max(1024).nullable().optional(),
}).strict();
export const ProjectDeleteQuery = z.object({ permanent: z.enum(['true', 'false']).optional().transform((v) => v === 'true'), keepOutputs: z.enum(['true', 'false']).optional().transform((v) => v !== 'false') });
export const DiskUsageQuery = z.object({ projectId: Id.optional() });
export const SampleCreateInput = z.object({ language: z.enum(['id', 'en']).default('id') }).strict();
/** FR-012: `uiState` is the Editor's per-project UI state written by Save (Library mode, playhead, selection, Player toggles; ≤ 16 KB JSON). */
export const UiStateInput = z.record(z.string().max(64), z.unknown()).refine((v) => JSON.stringify(v).length <= 16_384, 'uiState is larger than 16 KB');
export const ProjectPatchInput = z.object({ name: z.string().trim().min(1).max(120).optional(), language: z.enum(['id', 'en']).optional(), uiState: UiStateInput.optional() }).strict();
export const ProjectListQuery = PageQuery.extend({ includeDeleted: boolQ });
export const DuplicateInput = z.object({ name: z.string().trim().min(1).max(120), copyMedia: z.boolean().default(true) }).strict();
export const BackupInput = z.object({ folder: z.string().min(1).max(1024), passphrase: z.string().min(8).max(1024).optional(), includeOutputs: z.boolean().default(false) }).strict();
export const RestoreInput = z.object({ path: z.string().min(1).max(1024), passphrase: z.string().min(1).max(1024).optional(), onConflict: z.enum(['copy', 'replace']).default('copy') }).strict();
export const CheckpointInput = z.object({ reason: z.literal('manual').default('manual') }).strict();
export const CheckpointParams = z.object({ id: Id, checkpointId: Id });

export const CompositionQuery = z.object({ model: z.enum(['true', 'false']).default('true').transform((v) => v === 'true') });
export const VersionParams = z.object({ id: Id, versionId: Id });
export const DiffQuery = z.object({ from: z.string().min(1).max(128), to: z.string().min(1).max(128) });
export const ValidateInput = z.object({ baseVersion: z.string().min(1).max(128), ops: z.array(Operation).max(200) }).strict();

/** API §6.7 DesignPickInput, plus the deterministic Text Panel / Output fields of the agents package DesignPick (field/value, output, assetId, text). */
/** FR-256: one clipboard snapshot of R-060 `itemsEdit.paste` (the add op of its kind; args are checked again by applyOperations). */
const ClipboardEntryInput = z.object({ kind: z.enum(['clip', 'scene', 'text', 'image', 'shape', 'audio']), offsetMs: z.number().int().min(0).max(86_400_000), durationMs: z.number().int().min(0).max(86_400_000),
  op: z.object({ op: z.string().max(64), target: z.object({ kind: z.literal('sequence') }).strict().optional(), args: z.record(z.string(), z.unknown()) }).strict(),
  clip: z.object({ index: z.number().int().min(0).max(49), offsetMs: z.number().int().min(0).max(86_400_000) }).strict().optional() }).strict()
  .refine((e) => PASTE_OPS[e.kind] === e.op.op, { message: 'clipboard op does not match its kind' });
export const DesignPickInput = z.object({
  source: z.enum(['ui', 'chat']),
  category: z.enum(INTENT_CATEGORIES),
  presetId: z.string().regex(/^preset:[a-z]+\.[a-z0-9-]+$/).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  target: ElementRef.default({ kind: 'selection' }),
  selection: z.array(ElementRef).max(200).default([]),
  playheadMs: z.number().int().min(0).default(0),
  instruction: z.string().max(2000).optional(),
  baseVersion: z.string().min(1).max(128),
  plan: z.enum(['auto', 'none']).default('auto'),
  field: z.enum(['fontFamily', 'fontSize', 'weight', 'italic', 'colour', 'align', 'opacity', 'content']).optional(),
  value: z.unknown().optional(),
  output: z.object({ kind: z.enum(['ratio', 'resolution', 'fps', 'autoRatio', 'performanceProfile']), value: z.unknown(), customRatio: z.object({ w: z.number().int().min(1), h: z.number().int().min(1) }).optional() }).optional(),
  assetId: z.string().max(64).optional(),
  text: z.string().min(1).max(500).optional(),
  /** FR-068 (P1): Timeline drag on the video Track (op:clip.move / op:clip.setTrim). */
  clipEdit: z.object({ clipId: z.string().min(1).max(64), toIndex: z.number().int().min(0).optional(), trimBeforeMs: z.number().int().min(0).optional(), durationMs: z.number().int().min(100).optional() }).strict().optional(),
  /** ADR-027 / FR-068: Timeline drag / trim / lane change / layer key on a text, image, shape or audio layer (op:element.setTiming / op:element.setLayer). */
  elementEdit: z.object({ kind: z.enum(['text', 'image', 'shape', 'audio']), id: z.string().min(1).max(64), atMs: z.number().int().min(0).optional(), durationMs: z.number().int().min(100).optional(),
    trimBeforeMs: z.number().int().min(0).optional(), layer: z.number().int().min(0).max(999).optional(), move: z.enum(['up', 'down', 'front', 'back']).optional() }).strict().optional(),
  /** ADR-028 / FR-179: cut at the playhead (op:element.split per listed item that contains atMs; empty list = the clip under the playhead). */
  splitEdit: z.object({ atMs: z.number().int().min(0), items: z.array(z.object({ kind: z.enum(['clip', 'text', 'image', 'shape', 'audio']), id: z.string().min(1).max(64) }).strict()).max(50) }).strict().optional(),
  /** ADR-028 / FR-180: Player handles / Inspector fields (op:element.setTransform). */
  transformEdit: z.object({ kind: z.enum(['clip', 'image', 'shape']), id: z.string().min(1).max(64), x: z.number().min(-2).max(2).optional(), y: z.number().min(-2).max(2).optional(),
    scale: z.number().min(0.05).max(20).optional(), rotation: z.number().min(-360).max(360).optional() }).strict().optional(),
  /** ADR-031 / FR-192 / FR-193: Delete or Duplicate Timeline items (one op per item, one Composition Version). Effect ids are `<clipId>|<presetId>`. */
  /** FR-256: `paste` carries in-app clipboard snapshots (untrusted: ≤ 50 entries, add ops of their kind only, ≤ 64 KB; applyOperations validates the args). */
  itemsEdit: z.object({ action: z.enum(['remove', 'duplicate', 'paste']), items: z.array(z.object({ kind: z.enum(['clip', 'text', 'image', 'shape', 'audio', 'cut', 'effect', 'background', 'caption']),
    id: z.string().min(1).max(160).optional(), index: z.number().int().min(0).optional() }).strict()).max(200),
    paste: z.object({ atMs: z.number().int().min(0).max(86_400_000), entries: z.array(ClipboardEntryInput).min(1).max(CLIPBOARD_MAX_ENTRIES) }).strict().optional() }).strict()
    .refine((e) => (e.action === 'paste' ? e.paste !== undefined && e.items.length === 0 : e.items.length >= 1 && e.paste === undefined), { message: 'paste needs `paste` and no items; remove / duplicate need items' })
    .refine((e) => e.paste === undefined || JSON.stringify(e.paste).length <= 65_536, { message: 'clipboard too large' }).optional(),
}).strict();
export type DesignPickInputT = z.infer<typeof DesignPickInput>;
/** R-065 (FR-095 / FR-097): fully specified picks applied as one unit (one Composition Version); each pick's own baseVersion is ignored. */
export const IntentBatchInput = z.object({ baseVersion: z.string().min(1).max(128), picks: z.array(DesignPickInput.omit({ baseVersion: true }).extend({ baseVersion: z.string().max(128).optional() })).min(1).max(8) }).strict();
export const IntentParams = z.object({ id: Id, intentId: Id });
const statusList = z.string().max(200).optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined));
export const IntentListQuery = z.object({ status: statusList, limit: z.coerce.number().int().min(1).max(500).default(100) });
export const IntentClearQuery = z.object({ status: z.enum(['queued', 'superseded']).default('queued') });

export const PlanCreateInput = z.object({
  intentIds: z.array(Id).max(200).default([]), message: z.string().max(4000).optional(), baseVersion: z.string().min(1).max(128),
  mode: z.enum(['auto', 'compile-only', 'agent']).default('auto'),
  /** Entry 35: re-plan of this plan — the Editor Agent gets the Creator's ORIGINAL chat message of that plan's run (up to 8 000
   *  characters), not the plan's one-line goal; `message` is the fallback when that message is gone. */
  replanOf: Id.optional(),
}).strict();
export const PlanListQuery = PageQuery.extend({ status: statusList });
export const ExecuteInput = z.object({ confirmDestructive: z.boolean().default(false) }).strict();
export const NotesInput = z.object({ notes: z.string().max(1000) }).strict();

// ───────────────────────────── rows and DTOs ─────────────────────────────
export interface ProjectRow { id: string; name: string; settings_json: string; head_version_id: string | null; language: 'id' | 'en'; created_at: string; updated_at: string; opened_at: string | null; deleted_at: string | null; is_sample?: number; ui_state_json?: string | null }
export interface ProjectListRow extends ProjectRow { head_hash: string | null; head_duration: number | null; head_parent: string | null; asset_count: number; ckpt_version: string | null }
export interface VersionRow { id: string; project_id: string; parent_id: string | null; hash: string; model_json: string; cause: VersionCause; plan_id: string | null; duration_ms: number; created_at: string }
export type VersionCause = 'insert' | 'compile' | 'execute' | 'undo' | 'redo' | 'restore' | 'system';
export interface CheckpointRow { id: string; project_id: string; version_id: string; file_path: string; reason: 'autosave' | 'pre-execute' | 'pre-render' | 'manual'; created_at: string }
export interface PlanRow { id: string; project_id: string; base_version_id: string; origin: 'compile' | 'editor-agent'; plan_json: string; status: EditPlanT['status']; agent_run_id: string | null; created_at: string; updated_at: string; intent_ids_json: string | null; message: string | null; result_json: string | null; idempotency_key: string | null }

export const PROJECT_SELECT = `SELECT p.*, v.hash AS head_hash, v.duration_ms AS head_duration, v.parent_id AS head_parent,
  (SELECT count(*) FROM assets a WHERE a.project_id = p.id AND a.deleted_at IS NULL) AS asset_count,
  (SELECT c.version_id FROM recovery_checkpoints c WHERE c.project_id = p.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS ckpt_version
  FROM projects p LEFT JOIN composition_versions v ON v.id = p.head_version_id`;

/**
 * FR-173: `dirty` is unsaved UI-level state only (title/name changes not yet covered by Save or autosave). Composition Versions
 * are persisted when they are created and never make a Project "unsaved" (Execute shows no dirty dot).
 */
export function projectDto(r: ProjectListRow, dirty = false) {
  return { id: r.id, name: r.name, settings: JSON.parse(r.settings_json) as unknown, language: r.language, headVersionId: r.head_version_id, headHash: r.head_hash,
    durationMs: r.head_duration ?? 0, assetCount: r.asset_count, createdAt: r.created_at, updatedAt: r.updated_at, openedAt: r.opened_at, dirty,
    ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}), ...(r.is_sample === 1 ? { isSample: true as const } : {}), ...(r.ui_state_json ? { uiState: parseUiState(r.ui_state_json) } : {}) };
}
function parseUiState(j: string): Record<string, unknown> {
  try { const v = JSON.parse(j) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
export type ProjectDto = ReturnType<typeof projectDto>;

export function versionDto(r: VersionRow, withModel = false) {
  return { id: r.id, projectId: r.project_id, parentId: r.parent_id, hash: r.hash, cause: r.cause, planId: r.plan_id, durationMs: r.duration_ms, createdAt: r.created_at,
    ...(withModel ? { model: JSON.parse(r.model_json) as CompositionModelT } : {}) };
}
export type VersionDto = ReturnType<typeof versionDto>;

/** FR-016: `hash` is the Composition Version hash the checkpoint file holds (its integrity hash); `bytes` the file size (0 if missing). */
export function checkpointDto(r: CheckpointRow, durationMs: number, file?: { bytes: number }) {
  const hash = r.file_path.split('/').pop()?.replace(/\.json$/, '') ?? '';
  return { id: r.id, projectId: r.project_id, versionId: r.version_id, reason: r.reason, createdAt: r.created_at, durationMs, hash, bytes: file?.bytes ?? 0 };
}

export function planDto(r: PlanRow, opts: { withOps?: boolean } = {}) {
  const p = JSON.parse(r.plan_json) as EditPlanT;
  const steps = opts.withOps === false ? p.steps.map((s) => ({ ...s, ops: [], opCount: s.ops.length })) : p.steps.map((s) => ({ ...s, opCount: s.ops.length }));
  return { ...p, steps, id: r.id, status: r.status, origin: r.origin, baseVersionId: r.base_version_id, agentRunId: r.agent_run_id,
    intentIds: r.intent_ids_json ? (JSON.parse(r.intent_ids_json) as string[]) : [], createdAt: r.created_at, updatedAt: r.updated_at,
    // FR-086: the execution result summary so a reopened Editor thread shows "3 added, 1 modified" and the version hash.
    result: r.result_json ? resultSummary(JSON.parse(r.result_json) as { ok: boolean; toVersion?: string; appliedOps: number; diff?: Array<{ change: 'added' | 'removed' | 'modified' }> }) : null };
}
function resultSummary(x: { ok: boolean; toVersion?: string; appliedOps: number; diff?: Array<{ change: 'added' | 'removed' | 'modified' }> }) {
  const n = (c: string) => (x.diff ?? []).filter((d) => d.change === c).length;
  return { ok: x.ok, toVersion: x.toVersion ?? null, appliedOps: x.appliedOps, added: n('added'), removed: n('removed'), modified: n('modified') };
}
export type PlanDto = ReturnType<typeof planDto>;

export const parseIntent = (json: string): EditIntentT => EditIntent.parse(JSON.parse(json));

/** Opaque cursors: base64url JSON of the last row's sort key. */
export const encodeCursor = (o: Record<string, string>): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
export function decodeCursor(c: string | undefined): Record<string, string> | undefined {
  if (!c) return undefined;
  try { const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown; if (o && typeof o === 'object') return o as Record<string, string>; } catch { /* fall through */ }
  return undefined;
}
