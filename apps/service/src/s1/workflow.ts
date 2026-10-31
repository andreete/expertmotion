// Edit-intent pipeline in the Local Service (AI_WORKFLOW §2–§7, §12; API §6.7–6.8): Design Pick → createIntents → Intent Queue
// (edit_intents) → Compile (no LLM) or Editor Agent → validatePlan → Execute as one transaction with rollback.
// The LLM never mutates: every model change goes through CompositionStore.commit after deterministic validation (AI-001, AI-004).
import {
  EditIntent, buildCompilePlan, buildRewriteEnvelope, chatIntent, compileIntents, createIntents, enqueue, lockedKeysFromQueue, pickFromIntent, planOps, remove, restore,
  runEditorAgent, settingsPatchOf, validatePlan, type ChatImage, type PointedTarget, type RunProgress, type ToolModel, type EditorRunDiagnostics, type ChatUsage, type DesignPick, type EditIntentT, type EditPlanT,
} from '@expertmotion/agents';
import { validateParams } from '@expertmotion/catalogue';
import { OPERATIONS, type CompositionModelT, type ElementRefT, type OperationT } from '@expertmotion/composition-model';
import { EmError, issue, type EmCode, type Issue } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { parseIntent, planDto, versionDto, type DesignPickInputT, type PlanRow, type VersionDto } from './dto.js';
import type { Checkpoints } from './checkpoints.js';
import { issueError, type CompositionStore } from './store.js';
import { brainstormTools, deltaEmitter, researchToolsFor } from '../modules/agents.js';
import { composeScenes, type VideoSpecT } from '@expertmotion/agents';
import { latestAnalysis } from '../s2/reels/footage-prep.js';
import { getAssignment } from '../modules/providers.js';
import { cachedModels } from '../s3/usage-store.js';
import { discussionFor } from '../s3/shared-context.js';

/** FR-262: an Editor message about making a video from the Creator's own footage / clips / recordings. */
export const FOOTAGE_REQUEST_RE = /(footage|rekaman|klip (saya|ini|ku)|video (saya|ini|ku|yang (saya )?(upload|impor|unggah))|dari (video|klip|rekaman)|b-?roll|from (this|my|these) (footage|video|clips?)|my (footage|clips?|recordings?))/i;

/** FR-080 / FR-072: what an Editor Chat message adds to the Rewrite envelope and the provider request. */
export interface AgentPlanExtras { selection?: ElementRefT[] | undefined; playheadMs?: number | undefined; images?: ChatImage[] | undefined; attachments?: string[] | undefined; onDelta?: ((d: string) => void) | undefined;
  chat?: { messageId: string; target?: ElementRefT | undefined } | undefined;
  /** FR-189 pointed targets (chat chips); FR-190 run phases. */
  targets?: PointedTarget[] | undefined; onProgress?: ((p: RunProgress) => void) | undefined;
  /** FR-216: web sources the Editor used (the S3 chat stores them under its reply). */ onSources?: ((s: { sources: Array<{ url: string; title?: string }>; images: unknown[] }) => void) | undefined;
  /** FR-286: the Creator's channel profile for the envelope (default: the `channelProfile` setting). */ channelProfile?: string | undefined }

type Reason = 'created' | 'superseded' | 'restored' | 'removed' | 'cleared' | 'compiled' | 'executed' | 'rejected';
export interface ExecutionResultT {
  planId: string; ok: boolean; fromVersion: string; toVersion?: string; appliedOps: number;
  diff: Array<{ elementId: string; change: 'added' | 'removed' | 'modified'; fields: string[] }>;
  error?: { code: string; message: string; step?: number; path?: string }; rollback?: { performed: boolean; toVersion: string }; durationMs: number;
  /** ADR-030: generator steps started after the commit (voice-over, captions over it), or skipped (model not installed). */
  toolSteps?: Array<{ n: number; tool: string; status: 'started' | 'skipped' | 'failed' | 'done'; jobId?: string; code?: string }>;
}
export interface PickResult { intent: EditIntentT; queue: ReturnType<Workflow['queueDto']>; superseded: string[]; appliedVersion: VersionDto | null; planId: string | null; notices: Array<{ code: string }> }
interface Run { ac: AbortController; runId: string; projectId: string; planId: string; external: boolean }

/** Ops that need `confirmDestructive` (API R-073 list ∪ OPERATIONS[*].destructive). */
/** FR-224: the scene.compose step of a plan whose voice clips still need generating (and the tts steps standing for them). */
export function voiceFirstOf(plan: EditPlanT): { stepN: number; spec: VideoSpecT; ttsSteps: number[] } | null {
  for (const s of plan.steps) {
    const spec = s.tool === 'composition.applyOps' ? s.args['sceneCompose'] as VideoSpecT | undefined : undefined;
    if (!spec || s.args['measured'] === true || !spec.voice?.clips?.some((c) => !c.assetId) || spec.voice.generate === false) continue;
    const tts = plan.steps.filter((x) => x.tool === 'tts.generate' && (x.dependsOn.includes(s.n) || typeof x.args['clipId'] === 'string')).map((x) => x.n);
    return { stepN: s.n, spec, ttsSteps: tts };
  }
  return null;
}
const DESTRUCTIVE = new Set(['op:clip.remove', 'op:caption.clear', 'op:background.clear', ...Object.entries(OPERATIONS).filter(([, d]) => d.destructive).map(([k]) => k)]);
/** API: baseVersion may be the head hash or the head version id. */
export const isHeadRef = (head: { hash: string; versionId: string }, ref: string): boolean => ref === head.hash || ref === head.versionId;
const stale = (headHash: string, baseVersion: string) => new EmError('EM-2301', 'The composition changed after this plan was made. Ask the Editor Agent to plan again; nothing was applied.', { details: { baseVersion, headVersion: headHash }, path: 'body.baseVersion' });
const notFound = (route: string, id: string) => new EmError('EM-9003', 'The item you asked for no longer exists.', { details: { route, id } });

export class Workflow {
  private readonly runs = new Map<string, Run>();
  private readonly executing = new Set<string>();
  /** FR-084: Executes accepted but not yet inside their transaction (a Cancel may still abort them), and the ones cancelled. */
  private readonly pendingExec = new Set<string>();
  private readonly cancelledExec = new Set<string>();
  /** Review A1: plans in the voice-first phase of Execute (voices are generated before the commit); Cancel aborts the voice batch. */
  private readonly voiceExec = new Map<string, AbortController>();
  /** Review A2: projects with a voice-first Execute in its voice phase (a second Execute waits: EM-2309, it would only go stale). */
  private readonly voicing = new Set<string>();
  constructor(private readonly ctx: ServiceContext, private readonly store: CompositionStore, private readonly checkpoints: Checkpoints) {
    store.onCommit((pid, head) => this.markStale(pid, (r) => r.baseVersion !== head.hash));
  }

  // ───────────────────────────── Intent Queue persistence ─────────────────────────────
  loadQueue(projectId: string): EditIntentT[] {
    const rows = this.ctx.db.prepare("SELECT intent_json FROM edit_intents WHERE project_id = ? AND status != 'removed' ORDER BY created_at, id").all(projectId) as Array<{ intent_json: string }>;
    return rows.map((r) => parseIntent(r.intent_json));
  }
  /** Upserts intents whose JSON changed; returns the changed ids. */
  saveQueue(projectId: string, before: readonly EditIntentT[], after: readonly EditIntentT[]): string[] {
    const prev = new Map(before.map((i) => [i.id, JSON.stringify(i)]));
    const now = this.ctx.now(); const changed: string[] = [];
    const up = this.ctx.db.prepare(`INSERT INTO edit_intents (id, project_id, intent_json, status, property_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET intent_json = excluded.intent_json, status = excluded.status, property_key = excluded.property_key, updated_at = excluded.updated_at`);
    this.ctx.db.transaction(() => {
      for (const i of after) { const j = JSON.stringify(i); if (prev.get(i.id) === j) continue; up.run(i.id, projectId, j, i.status, i.propertyKey, i.createdAt, now); changed.push(i.id); }
    })();
    return changed;
  }
  queueDto(projectId: string, opts: { status?: string[] | undefined; limit?: number } = {}) {
    const all = this.loadQueue(projectId);
    const head = this.store.head(projectId);
    const headHash = head.hash;
    const live = this.lineageHashes(projectId, head.versionId);
    // FR-167: an applied intent whose version left the head's lineage (Undo, or a branch after Undo) shows "undone" in the queue.
    const items = all.filter((i) => !opts.status || opts.status.includes(i.status)).reverse().slice(0, opts.limit ?? 100)
      .map((i) => ((i.status === 'executed' || i.status === 'compiled') && i.appliedHash && !live.has(i.appliedHash) ? { ...i, undone: true } : i));
    return { projectId, headHash, items, lockedKeys: lockedKeysFromQueue(all) };
  }
  /** Hashes of the head and its parent chain (Undo/Redo commit with the target's parent, so undone versions drop out). */
  private lineageHashes(projectId: string, headVersionId: string): Set<string> {
    const rows = this.ctx.db.prepare(`WITH RECURSIVE chain(id, parent_id, hash, depth) AS (
        SELECT id, parent_id, hash, 0 FROM composition_versions WHERE id = ? AND project_id = ?
        UNION ALL SELECT v.id, v.parent_id, v.hash, c.depth + 1 FROM composition_versions v JOIN chain c ON v.id = c.parent_id WHERE c.depth < 5000)
      SELECT hash FROM chain`).all(headVersionId, projectId) as Array<{ hash: string }>;
    return new Set(rows.map((r) => r.hash));
  }
  private emitQueue(projectId: string, changed: string[], reason: Reason): void {
    if (!changed.length) return;
    this.ctx.bus.emit('intent.updated', { at: this.ctx.now(), projectId, queue: this.queueDto(projectId), changed, reason });
  }
  private setIntentStatus(projectId: string, ids: readonly string[], status: EditIntentT['status'], extra: Partial<EditIntentT> = {}): string[] {
    if (!ids.length) return [];
    const before = this.loadQueue(projectId);
    const set = new Set(ids);
    const after = before.map((i) => (set.has(i.id) ? { ...i, status, ...extra } : i));
    return this.saveQueue(projectId, before, after);
  }

  // ───────────────────────────── R-060 Design Pick ─────────────────────────────
  createIntent(projectId: string, b: DesignPickInputT, opts: { holdFor?: string | null } = {}): PickResult {
    const head = this.store.head(projectId);
    if (!isHeadRef(head, b.baseVersion)) throw stale(head.hash, b.baseVersion);
    const r = this.intentsFromPick(projectId, b, head);
    if (opts.holdFor) return this.holdIntents(projectId, r, opts.holdFor);      // FR-037: the preset's model is not installed
    return this.enqueueAndMaybeApply(projectId, r, { auto: b.plan === 'auto', reason: 'created' });
  }

  /** Design Pick → validated Edit Intents (catalogue params, Target Resolution); settings intents remember the replaced value. */
  private intentsFromPick(projectId: string, b: DesignPickInputT, head: { model: CompositionModelT; hash: string }): EditIntentT[] {
    if (b.presetId && b.presetId.length && Object.keys(b.params).length) {
      const v = validateParams(b.presetId, b.params);
      if (!v.ok) throw issueError({ ...v.issues[0]!, path: `body.${v.issues[0]!.path}` });
    }
    const explicit = !['selection', 'playhead', 'project'].includes(b.target.kind);
    const pick: DesignPick = {
      projectId, source: b.source, category: b.category, params: b.params, playheadMs: b.playheadMs,
      selection: explicit ? [b.target, ...b.selection] : b.selection,
      ...(b.presetId ? { presetId: b.presetId } : {}), ...(b.instruction ? { instruction: b.instruction } : {}),
      ...(b.field ? { field: b.field, value: b.value } : {}), ...(b.output ? { output: { kind: b.output.kind, value: b.output.value, ...(b.output.customRatio ? { customRatio: b.output.customRatio } : {}) } } : {}),
      ...(b.assetId ? { assetId: b.assetId } : {}), ...(b.text ? { text: b.text } : {}),
      ...(b.elementEdit ? { elementEdit: Object.fromEntries(Object.entries(b.elementEdit).filter(([, v]) => v !== undefined)) as unknown as NonNullable<DesignPick['elementEdit']> } : {}),
      ...(b.splitEdit ? { splitEdit: { atMs: b.splitEdit.atMs, items: b.splitEdit.items.map((x) => ({ kind: x.kind, id: x.id })) } } : {}),
      ...(b.itemsEdit ? { itemsEdit: { action: b.itemsEdit.action, items: b.itemsEdit.items.map((x) => ({ kind: x.kind, ...(x.id !== undefined ? { id: x.id } : {}), ...(x.index !== undefined ? { index: x.index } : {}) })),
        ...(b.itemsEdit.paste ? { paste: { atMs: b.itemsEdit.paste.atMs, entries: b.itemsEdit.paste.entries.map((e) => ({ kind: e.kind, offsetMs: e.offsetMs, durationMs: e.durationMs, op: { op: e.op.op, ...(e.op.target ? { target: e.op.target } : {}), args: e.op.args }, ...(e.clip ? { clip: e.clip } : {}) })) } } : {}) } } : {}),
      ...(b.transformEdit ? { transformEdit: Object.fromEntries(Object.entries(b.transformEdit).filter(([, v]) => v !== undefined)) as unknown as NonNullable<DesignPick['transformEdit']> } : {}),
      ...(b.clipEdit ? { clipEdit: { clipId: b.clipEdit.clipId, ...(b.clipEdit.toIndex !== undefined ? { toIndex: b.clipEdit.toIndex } : {}), ...(b.clipEdit.trimBeforeMs !== undefined ? { trimBeforeMs: b.clipEdit.trimBeforeMs } : {}), ...(b.clipEdit.durationMs !== undefined ? { durationMs: b.clipEdit.durationMs } : {}) } } : {}),
    };
    const r = createIntents(pick, { model: head.model, baseVersion: head.hash, newId: this.ctx.newId, now: this.ctx.now });
    if (!r.ok) throw issueError(r.issues[0] ?? issue('EM-2303', 'This pick cannot be used.'));
    // FR-090: a settings intent remembers the value it replaces, so Undo can put it back even without a queued predecessor.
    if (settingsPatchOf(r.value[0]!)) r.value[0]!.params = { ...r.value[0]!.params, __previous: this.ctx.settings.get().defaultPerformanceProfile };
    return r.value;
  }

  /**
   * R-065 (FR-095 / FR-097): several fully specified picks as ONE unit — every intent is recorded in the Intent Queue (superseding its
   * predecessor), the Composition Model ones compile into one plan and one Composition Version, and zero-op settings intents
   * (Performance Profile) are applied to Settings and stamped with that version's hash so Undo/Redo of it restores them too.
   */
  createIntentBatch(projectId: string, b: { baseVersion: string; picks: DesignPickInputT[] }): PickResult & { intents: EditIntentT[] } {
    const head = this.store.head(projectId);
    if (!isHeadRef(head, b.baseVersion)) throw stale(head.hash, b.baseVersion);
    const incoming = b.picks.flatMap((p) => this.intentsFromPick(projectId, { ...p, baseVersion: b.baseVersion }, head));
    const interpret = incoming.find((i) => i.needsInterpretation);
    if (interpret) throw new EmError('EM-2303', 'These picks need the Editor Agent; they cannot be applied as one change.', { status: 422, details: { intentIds: [interpret.id] } });
    const before = this.loadQueue(projectId);
    const after = enqueue(before, incoming);
    const wasSup = new Set(before.filter((i) => i.status === 'superseded').map((i) => i.id));
    const superseded = after.filter((i) => i.status === 'superseded' && !wasSup.has(i.id)).map((i) => i.id);
    const changed = this.saveQueue(projectId, before, after);
    const settingsIntents = incoming.filter((i) => settingsPatchOf(i));
    const modelIds = incoming.filter((i) => !settingsPatchOf(i)).map((i) => i.id);
    let appliedVersion: VersionDto | null = null, planId: string | null = null; const notices: Array<{ code: string }> = [];
    if (modelIds.length) {
      const res = this.applyNow(projectId, modelIds, { reason: 'created', changedBefore: changed, goal: 'Reset Output Settings' });
      appliedVersion = res.version; planId = res.planId; notices.push(...res.notices);
    }
    if (settingsIntents.length) {
      const hash = appliedVersion?.hash;            // no new version (already at the defaults) → nothing to stamp, Restore still undoes it
      const ids = new Set(settingsIntents.map((i) => i.id));
      const mid = this.loadQueue(projectId);
      const done = this.saveQueue(projectId, mid, mid.map((i) => (ids.has(i.id) ? { ...i, status: 'executed' as const, ...(hash ? { appliedHash: hash } : {}) } : i)));
      let next = this.ctx.settings.get();
      for (const i of settingsIntents) next = this.ctx.settings.update({ defaultPerformanceProfile: settingsPatchOf(i)!.performanceProfile });
      this.emitQueue(projectId, [...new Set([...(modelIds.length ? [] : changed), ...done])], 'executed');
      this.ctx.bus.emit('settings.changed', { at: this.ctx.now(), scope: 'settings', settings: next });
    }
    const queue = this.loadQueue(projectId);
    const intents = incoming.map((i) => queue.find((q) => q.id === i.id) ?? i);
    return { intent: intents[0]!, intents, queue: this.queueDto(projectId), superseded, appliedVersion, planId, notices };
  }

  /**
   * FR-095 / FR-097: Undo or Redo of a Composition Version also moves the zero-op settings intents stamped with it — Undo puts
   * back `params.__previous`, Redo re-applies the value — so one Undo of a Reset restores ratio, resolution and profile together.
   */
  syncSettingsWithVersion(projectId: string, kind: 'undo' | 'redo', hash: string): void {
    const hits = this.loadQueue(projectId).filter((i) => i.status === 'executed' && i.appliedHash === hash && settingsPatchOf(i));
    if (!hits.length) return;
    const i = hits[hits.length - 1]!;
    const value = kind === 'undo' ? i.params['__previous'] : settingsPatchOf(i)!.performanceProfile;
    if (value !== 'standard' && value !== 'accelerated' && value !== 'turbo') return;
    const next = this.ctx.settings.update({ defaultPerformanceProfile: value });
    this.ctx.bus.emit('settings.changed', { at: this.ctx.now(), scope: 'settings', settings: next });
  }

  /** Enqueue (supersede), then apply directly when fully specified (AI-004) or start a plan run when autoPlan is on. */
  private enqueueAndMaybeApply(projectId: string, incoming: EditIntentT[], o: { auto: boolean; reason: Reason; restoredId?: string; before?: EditIntentT[]; after?: EditIntentT[] }): PickResult {
    const before = o.before ?? this.loadQueue(projectId);
    const after = o.after ?? enqueue(before, incoming);
    const wasSup = new Set(before.filter((i) => i.status === 'superseded').map((i) => i.id));
    const superseded = after.filter((i) => i.status === 'superseded' && !wasSup.has(i.id)).map((i) => i.id);
    const changed = this.saveQueue(projectId, before, after);
    const top = incoming[0]!;
    const notices: Array<{ code: string }> = [];
    let appliedVersion: VersionDto | null = null, planId: string | null = null;
    const settingsPatch = settingsPatchOf(top);
    if (settingsPatch) {
      // FR-090 / FR-097: zero-op settings intent (no Composition Model op): applied to Settings at once, recorded as executed.
      const mid = this.loadQueue(projectId);
      const done = this.saveQueue(projectId, mid, mid.map((i) => (i.id === top.id ? { ...i, status: 'executed' as const } : i)));
      const next = this.ctx.settings.update({ defaultPerformanceProfile: settingsPatch.performanceProfile });
      this.emitQueue(projectId, [...new Set([...changed, ...done])], 'executed');
      this.ctx.bus.emit('settings.changed', { at: this.ctx.now(), scope: 'settings', settings: next });
    } else if (!top.needsInterpretation && o.auto) {
      const res = this.applyNow(projectId, incoming.map((i) => i.id), { reason: o.reason, changedBefore: changed });
      appliedVersion = res.version; planId = res.planId; notices.push(...res.notices);
    } else {
      this.emitQueue(projectId, changed, o.reason);
      if (top.needsInterpretation && o.auto && this.ctx.settings.get().autoPlan) {
        try {
          const head = this.store.head(projectId);
          const started = this.createPlan(projectId, { intentIds: incoming.map((i) => i.id), baseVersion: head.hash, mode: 'agent' });
          planId = started.plan.id;
          started.done.catch(() => {});
        } catch (e) { if (e instanceof EmError) notices.push({ code: e.code }); else throw e; }
      }
    }
    const intent = this.loadQueue(projectId).find((i) => i.id === top.id) ?? top;
    return { intent, queue: this.queueDto(projectId), superseded, appliedVersion, planId, notices };
  }

  /** Compile + Execute in one go for fully specified intents (R-060 auto path, R-062, R-018). Rejects the intents on failure. */
  applyNow(projectId: string, intentIds: string[], o: { reason: Reason; changedBefore?: string[]; goal?: string; ops?: readonly OperationT[] }): { version: VersionDto | null; planId: string; notices: Array<{ code: string }> } {
    const queue = this.loadQueue(projectId);
    const ids = new Set(intentIds);
    const intents = queue.filter((i) => ids.has(i.id));
    const head = this.store.head(projectId);
    const reject = (iss: Issue) => {
      const ch = this.setIntentStatus(projectId, intents.map((i) => i.id), 'rejected', { rejectionReason: iss.message.slice(0, 300) });
      this.emitQueue(projectId, [...new Set([...(o.changedBefore ?? []), ...ch])], 'rejected');
      return issueError(iss);
    };
    // `ops`: intents whose operations were built by their owning module (FR-049 asset Insert), validated and executed the same way.
    const comp = o.ops ? { ok: true as const, value: o.ops.map((op) => ({ ...op, intentId: intents[0]?.id ?? op.intentId })) } : compileIntents(intents, (i) => pickFromIntent(i), head.model);
    if (!comp.ok) throw reject(comp.issues[0]!);
    const planId = this.ctx.newId();
    const label = String(intents[0]?.params['targetLabel'] ?? intents[0]?.propertyKey ?? 'pick');
    const plan = buildCompilePlan(comp.value, { id: planId, projectId, baseVersion: head.hash, goal: o.goal ?? `${intents[0]?.category ?? 'pick'}${intents[0]?.presetId ? ` · ${intents[0].presetId}` : ''} → ${label}`, expectedDiff: label });
    // Locked Keys protect the Creator's picks from agent-authored changes (ADR-002); the Creator's own direct edits (UI drag,
    // Output Settings) are never blocked by them — the newest pick wins through supersession (AI-018, FR-068).
    const creatorOnly = intents.every((i) => i.source === 'ui' || i.source === 'system');
    const v = validatePlan(plan, { model: head.model, baseVersion: head.hash, assets: this.store.facts(projectId), tier: this.ctx.hooks.tier(), lockedKeys: creatorOnly ? [] : lockedKeysFromQueue(queue), newId: this.ctx.newId, ...this.reels(projectId) });
    if (v.plan.status !== 'valid') throw reject(v.issues.find((i) => i.severity === 'block') ?? issue('EM-2303', 'The change could not be applied.'));
    this.insertPlan({ plan: v.plan, baseVersionId: head.versionId, intentIds, message: null, agentRunId: null });
    const notices = comp.value.some((op) => op.op === 'op:theme.setTextDefaults') && intents.some((i) => i.category === 'text') ? [{ code: 'EM-2403' }] : [];
    const res = this.executeRow(this.planRow(planId), { checkpoint: false, extraChanged: o.changedBefore ?? [] });
    if (!res.result.ok) throw reject(issue(res.result.error?.code ?? 'EM-2307', res.result.error?.message ?? 'The change could not be applied.'));
    return { version: res.version, planId, notices };
  }

  // ───────────────────────────── R-062 / R-063 / R-064 ─────────────────────────────
  restoreIntent(projectId: string, intentId: string): PickResult {
    const before = this.loadQueue(projectId);
    const t = before.find((i) => i.id === intentId);
    if (!t) throw notFound('intent', intentId);
    const r = restore(before, intentId, this.ctx.now);
    if (!r.ok) throw issueError(r.issues[0]!);
    const head = this.store.head(projectId);
    const family = r.value.filter((i) => i.id === intentId || i.parentIntentId === intentId);
    for (const i of family) for (const ref of i.resolvedTargets) if (!targetExists(head.model, ref))
      throw new EmError('EM-2203', 'This pick targeted an element that was removed, so it can no longer be restored.', { status: 422, details: { intentId, targetId: ref.id ?? ref.index } });
    const restored = r.value.find((i) => i.id === intentId)!;
    return this.enqueueAndMaybeApply(projectId, [restored, ...family.filter((i) => i.id !== intentId)], { auto: this.ctx.settings.get().autoPlan, reason: 'restored', before, after: r.value });
  }

  removeIntent(projectId: string, intentId: string) {
    const before = this.loadQueue(projectId);
    const t = before.find((i) => i.id === intentId);
    if (!t) throw notFound('intent', intentId);
    if (t.status === 'executed') throw new EmError('EM-9002', 'Applied picks stay in history; use Undo to revert them.', { status: 422, details: { reason: 'executed' } });
    const r = remove(before, intentId);
    if (!r.ok) throw issueError(r.issues[0]!);
    this.emitQueue(projectId, this.saveQueue(projectId, before, r.value), 'removed');
    this.markStale(projectId, () => true);
    return this.queueDto(projectId);
  }

  clearIntents(projectId: string, status: 'queued' | 'superseded') {
    const before = this.loadQueue(projectId);
    const after = before.map((i) => (i.status === status ? { ...i, status: 'removed' as const } : { ...i }));
    for (const p of after.filter((i) => i.propertyKey.startsWith('group:') && i.status !== 'removed')) {
      const kids = after.filter((c) => c.parentIntentId === p.id);
      if (kids.length && kids.every((c) => c.status === 'removed')) p.status = 'removed';
    }
    this.emitQueue(projectId, this.saveQueue(projectId, before, after), 'cleared');
    this.markStale(projectId, () => true);
    return this.queueDto(projectId);
  }

  // ───────────────────────────── plans: persistence ─────────────────────────────
  planRow(planId: string): PlanRow {
    const r = this.ctx.db.prepare('SELECT * FROM edit_plans WHERE id = ?').get(planId) as PlanRow | undefined;
    if (!r) throw notFound('plan', planId);
    return r;
  }
  private insertPlan(p: { plan: EditPlanT; baseVersionId: string; intentIds: string[]; message: string | null; agentRunId: string | null }): void {
    const now = this.ctx.now();
    this.ctx.db.prepare(`INSERT INTO edit_plans (id, project_id, base_version_id, origin, plan_json, status, agent_run_id, created_at, updated_at, intent_ids_json, message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(p.plan.id, p.plan.projectId, p.baseVersionId, p.plan.origin, JSON.stringify(p.plan), p.plan.status, p.agentRunId, now, now, JSON.stringify(p.intentIds), p.message);
  }
  private updatePlan(planId: string, plan: EditPlanT | null, status: EditPlanT['status'], extra: { result?: ExecutionResultT; idempotencyKey?: string } = {}): void {
    const sets = ['status = @status', 'updated_at = @now'];
    if (plan) sets.push('plan_json = @plan');
    if (extra.result) sets.push('result_json = @result');
    if (extra.idempotencyKey) sets.push('idempotency_key = @key');
    this.ctx.db.prepare(`UPDATE edit_plans SET ${sets.join(', ')} WHERE id = @id`).run({ id: planId, status, now: this.ctx.now(), plan: plan ? JSON.stringify({ ...plan, status }) : null,
      result: extra.result ? JSON.stringify(extra.result) : null, key: extra.idempotencyKey ?? null });
  }
  planDtoFor(planId: string, withOps = true) {
    const r = this.planRow(planId);
    const dto = planDto(r, { withOps });
    let headHash: string | null = null;
    try { headHash = this.store.head(r.project_id).hash; } catch { /* deleted project */ }
    return { ...dto, stale: dto.status === 'stale' || ((dto.status === 'valid' || dto.status === 'draft') && headHash !== null && headHash !== dto.baseVersion), headHash };
  }
  private emitPlanReady(planId: string, runId?: string): void {
    const r = this.planRow(planId);
    this.ctx.bus.emit('plan.ready', { at: this.ctx.now(), projectId: r.project_id, plan: planDto(r, { withOps: true }), ...(runId ? { runId } : {}) });   // QA 2026-10-28 #4 / #17: the Plan Card previews the ops and the destructive check needs them
  }
  private emitPlanInvalid(projectId: string, plan: Pick<EditPlanT, 'id' | 'validation' | 'touchesLockedKeys'>, status: string, code: string): void {
    this.ctx.bus.emit('plan.invalid', { at: this.ctx.now(), projectId, planId: plan.id, status, code, validation: plan.validation.map((v) => ({ ...v, severity: 'block' })), touchesLockedKeys: plan.touchesLockedKeys });
  }
  /** Valid plans whose base moved become stale (AI-013); emitted as plan.invalid EM-2301. */
  markStale(projectId: string, pred: (r: { baseVersion: string }) => boolean): void {
    const rows = this.ctx.db.prepare("SELECT * FROM edit_plans WHERE project_id = ? AND status = 'valid'").all(projectId) as PlanRow[];
    for (const r of rows) {
      const p = JSON.parse(r.plan_json) as EditPlanT;
      if (!pred({ baseVersion: p.baseVersion })) continue;
      this.updatePlan(r.id, null, 'stale');
      this.emitPlanInvalid(projectId, p, 'stale', 'EM-2301');
    }
  }
  listPlans(projectId: string, q: { status?: string[] | undefined; limit: number; cursor?: string | undefined }, cursor?: Record<string, string>) {
    const where = ['project_id = @pid']; const args: Record<string, unknown> = { pid: projectId, limit: q.limit + 1 };
    if (q.status?.length) { where.push(`status IN (${q.status.map((_, i) => `@s${i}`).join(',')})`); q.status.forEach((s, i) => { args[`s${i}`] = s; }); }
    if (cursor?.['c'] && cursor['id']) { where.push('(created_at < @cc OR (created_at = @cc AND id < @cid))'); args['cc'] = cursor['c']; args['cid'] = cursor['id']; }
    const rows = this.ctx.db.prepare(`SELECT * FROM edit_plans WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT @limit`).all(args) as PlanRow[];
    const more = rows.length > q.limit; const page = rows.slice(0, q.limit);
    return { rows: page, more };
  }

  // ───────────────────────────── R-070 create plan ─────────────────────────────
  /** ADR-039: the project's SFX asset ids (made by the Editor run of a talking-head project; `hooks.sfxAssets`), for the sync validate / Execute paths. */
  private readonly sfx = new Map<string, Record<string, string>>();
  /** ADR-039 (FR-285 … FR-288): the latest footage analysis and the SFX assets for validatePlan / composeScenes of a talking-head plan. */
  private reels(projectId: string): { footageAnalysis?: NonNullable<ReturnType<typeof latestAnalysis>>; sfxAssets?: Record<string, string> } {
    const fa = latestAnalysis(this.ctx, projectId); const sfx = this.sfx.get(projectId);
    return { ...(fa ? { footageAnalysis: fa } : {}), ...(sfx ? { sfxAssets: sfx } : {}) };
  }
  createPlan(projectId: string, input: { intentIds: string[]; message?: string | undefined; baseVersion: string; mode: 'auto' | 'compile-only' | 'agent'; signal?: AbortSignal | undefined; runId?: string | undefined; extras?: AgentPlanExtras | undefined })
    : { plan: ReturnType<Workflow['planDtoFor']>; runId?: string; done: Promise<ReturnType<Workflow['planDtoFor']>> } {
    const head = this.store.head(projectId);
    if (!isHeadRef(head, input.baseVersion)) throw stale(head.hash, input.baseVersion);
    const queue = this.loadQueue(projectId);
    let selected: EditIntentT[];
    if (input.intentIds.length) {
      selected = [];
      for (const id of input.intentIds) {
        const i = queue.find((x) => x.id === id);
        if (!i || i.status !== 'queued') throw new EmError('EM-9003', 'The item you asked for no longer exists.', { details: { route: 'intent', id } });
        selected.push(i);
        for (const kid of queue) if (kid.parentIntentId === i.id && kid.status === 'queued' && !input.intentIds.includes(kid.id)) selected.push(kid);
      }
    } else selected = queue.filter((i) => i.status === 'queued');
    const message = input.message?.trim() || undefined;
    const needAgent = !!message || selected.some((i) => i.needsInterpretation);
    if (!message && !selected.length) throw new EmError('EM-9002', 'There is nothing to plan: the Intent Queue is empty and no message was given.', { status: 422, details: { reason: 'empty' } });
    if (input.mode === 'compile-only' && needAgent) throw new EmError('EM-2303', 'These picks need the Editor Agent; they cannot be compiled directly.', { details: { intentIds: selected.filter((i) => i.needsInterpretation).map((i) => i.id) } });
    if (input.mode === 'agent' || needAgent) return this.startAgentPlan(projectId, selected, message, input.signal, input.runId, input.extras);

    const comp = compileIntents(selected, (i) => pickFromIntent(i), head.model);
    if (!comp.ok) throw issueError(comp.issues[0]!);
    const planId = this.ctx.newId();
    const plan = buildCompilePlan(comp.value, { id: planId, projectId, baseVersion: head.hash, goal: `Apply ${selected.filter((i) => !i.propertyKey.startsWith('group:')).length} pick(s)`, expectedDiff: selected.map((i) => i.category).join(', ') });
    const v = validatePlan(plan, { model: head.model, baseVersion: head.hash, assets: this.store.facts(projectId), tier: this.ctx.hooks.tier(), lockedKeys: lockedKeysFromQueue(queue), newId: this.ctx.newId, ...this.reels(projectId) });
    this.insertPlan({ plan: v.plan, baseVersionId: head.versionId, intentIds: selected.map((i) => i.id), message: null, agentRunId: null });
    if (v.plan.status === 'valid') this.emitPlanReady(planId);
    else this.emitPlanInvalid(projectId, v.plan, v.plan.status, v.plan.touchesLockedKeys.length ? 'EM-2302' : v.issues.find((i) => i.severity === 'block' && /^EM-23\d\d$/.test(i.code))?.code ?? 'EM-2303');
    const dto = this.planDtoFor(planId);
    return { plan: dto, done: Promise.resolve(dto) };
  }

  activeRun(projectId: string): Run | undefined { for (const r of this.runs.values()) if (r.projectId === projectId) return r; return undefined; }

  /** `externalRunId`: the caller (S3 editor chat) owns that agent_runs row, its events and usage; only plan_id is linked here. */
  private startAgentPlan(projectId: string, selectedIntents: EditIntentT[], message: string | undefined, signal?: AbortSignal, externalRunId?: string, extras: AgentPlanExtras = {}) {
    if (this.ctx.settings.get().privateMode) throw new EmError('EM-4401', 'Agents are off while Private Mode is on. Designs and exports keep working.');
    const active = this.activeRun(projectId);
    if (active) throw new EmError('EM-4305', 'Wait for the current answer to finish, or cancel it, before sending another message.', { details: { agent: 'editor', activeRunId: active.runId } });
    const head = this.store.head(projectId);
    // QA 2026-10-26 #2/#4: no "insert an asset first" gate — an empty project is built from scenes (ADR-030), and assets that are
    // only in the Library are in the envelope for op:clip.insert.
    const provider = this.ctx.hooks.providerFor('editor', projectId);
    this.ctx.hooks.budgetCheck(projectId);
    let intents = selectedIntents;
    if (extras.chat && message) {
      // FR-080: the chat message becomes an Edit Intent (source chat, propertyKey chat:<messageId>) once the run can start.
      const ci = chatIntent({ projectId, messageId: extras.chat.messageId, text: message, target: extras.chat.target, selection: extras.selection, baseVersion: head.hash, newId: this.ctx.newId, now: this.ctx.now });
      const before = this.loadQueue(projectId);
      this.emitQueue(projectId, this.saveQueue(projectId, before, enqueue(before, [ci])), 'created');
      intents = [...intents, ci];
    }
    const external = !!externalRunId;
    const planId = this.ctx.newId(), runId = externalRunId ?? this.ctx.newId(), now = this.ctx.now();
    const draft: EditPlanT = { id: planId, projectId, baseVersion: head.hash, origin: 'editor-agent', goal: (message ?? 'Plan the queued picks').slice(0, 300), steps: [], touchesLockedKeys: [], risks: [], status: 'draft', validation: [] };
    if (!external) this.ctx.db.prepare("INSERT INTO agent_runs (id, project_id, agent, connection_id, model_id, status, started_at) VALUES (?,?,'editor',NULL,?,'running',?)").run(runId, projectId, provider.model, now);
    this.insertPlan({ plan: draft, baseVersionId: head.versionId, intentIds: intents.map((i) => i.id), message: message ?? null, agentRunId: runId });
    try { this.ctx.db.prepare('UPDATE agent_runs SET plan_id = ? WHERE id = ?').run(planId, runId); } catch { /* column from migration 30 */ }
    const ac = new AbortController();
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }); }
    const run: Run = { ac, runId, projectId, planId, external };
    this.runs.set(planId, run);
    if (!external) this.ctx.bus.emit('agent.run.started', { at: now, projectId, run: this.runDto(runId), agent: 'editor', modelId: provider.model, planId });

    const done = (async () => {
      const queue = this.loadQueue(projectId);
      let assets = this.store.facts(projectId);
      const tier = this.ctx.hooks.tier(), lockedKeys = lockedKeysFromQueue(queue);
      // FR-262: "buat video dari footage ini": transcribe the footage first (video assets with sound and no transcript yet), so the
      // plan trims to what is said; bounded (≤ 8 clips, ≤ 10 min of footage, 150 s), skipped without a transcription model.
      const unread = assets.filter((a) => a.kind === 'video' && a.status === 'ready' && a.hasAudio === true && !a.transcript);
      if (message && unread.length && FOOTAGE_REQUEST_RE.test(message) && this.ctx.hooks.readFootage && unread.reduce((n, a) => n + (a.durationMs ?? 0), 0) <= 600_000) {
        const say = extras.onProgress ?? (external ? undefined : (p: RunProgress) => this.ctx.bus.emit('agent.run.progress', { at: this.ctx.now(), projectId, runId, agent: 'editor', ...p }));
        say?.({ phase: 'tool', tool: 'footage.read' });
        try { const read = await this.ctx.hooks.readFootage(projectId, unread.slice(0, 8).map((a) => a.id), { signal: ac.signal }); if (read.length) assets = this.store.facts(projectId); }
        catch (e) { this.ctx.log.info({ projectId, code: e instanceof EmError ? e.code : 'EM-7101' }, 'footage read failed'); }
      }
      const notes = (this.ctx.db.prepare("SELECT json_extract(plan_json, '$.notes') AS n FROM edit_plans WHERE project_id = ? AND id != ? AND json_extract(plan_json, '$.notes') IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(projectId, planId) as { n: string } | undefined)?.n;
      // FR-286: the channel profile (Settings ▸ Profil kanal); ADR-039: the footage analysis of a talking-head project and its SFX
      // assets (made once here, cached for the sync validate / Execute paths; never made for projects without an analysis)
      const channelProfile = (extras.channelProfile ?? this.ctx.settings.get().channelProfile ?? '').trim();
      const footageAnalysis = latestAnalysis(this.ctx, projectId);
      if (footageAnalysis && this.ctx.hooks.sfxAssets && !this.sfx.has(projectId)) { try { this.sfx.set(projectId, await this.ctx.hooks.sfxAssets(projectId)); assets = this.store.facts(projectId); } catch (e) { this.ctx.log.warn({ projectId, err: String(e).slice(0, 200) }, 'sfx assets not made'); } }
      const env = buildRewriteEnvelope({ model: head.model, baseVersion: head.hash, assets, intents, lockedKeys, tier, ...(message ? { creatorMessage: message } : {}), ...(notes ? { creatorNotes: notes } : {}),
        ...(extras.selection?.length ? { selection: extras.selection } : {}), ...(extras.playheadMs !== undefined ? { playheadMs: extras.playheadMs } : {}), ...(extras.attachments?.length ? { attachments: extras.attachments } : {}),
        discussion: discussionFor(this.ctx, projectId, this.editorContextLength()),   // AI_WORKFLOW §10.1: shared chat context
        ...(extras.targets?.length ? { targets: extras.targets } : {}), ...(channelProfile ? { channelProfile } : {}), ...(footageAnalysis ? { footageAnalysis } : {}) });
      // ADR-030: generator plan steps (voice-over, captions) and whether their local models are installed.
      let toolModels: { tts: ToolModel | null; stt: ToolModel | null } | undefined;
      try { toolModels = await this.ctx.hooks.planToolModels?.(head.model.settings.language); } catch { toolModels = undefined; }
      if (toolModels) env.capabilities.stepTools = { 'tts.generate': { available: !!toolModels.tts?.installed, ...(toolModels.tts ? { model: toolModels.tts.label } : {}) }, 'captions.generate': { script: true, sequence: !!toolModels.stt?.installed },
        'music.generate': { available: !this.ctx.settings.get().privateMode, tracks: 28 } };   // FR-266: CC0 library (Private Mode blocks the download)
      const t0 = Date.now();
      let usage: ChatUsage[] = [];
      // FR-084: plan deltas stream as agent.run.delta (the S3 chat passes its own emitter for its run; queue-started runs use one here).
      const own = extras.onDelta || external ? null : deltaEmitter(this.ctx, projectId, runId, 'editor');   // an external run owns its events
      const onDelta = extras.onDelta ?? (own ? (d: string) => own.push(d) : null);
      try {
        const progress = extras.onProgress ?? (external ? undefined : (p: RunProgress) => this.ctx.bus.emit('agent.run.progress', { at: this.ctx.now(), projectId, runId, agent: 'editor', ...p }));
        const research = researchToolsFor(this.ctx, 'editor', projectId, ac.signal, message ?? '');
        const r = await runEditorAgent(env, provider, { model: head.model, baseVersion: head.hash, assets, tier, lockedKeys, newId: this.ctx.newId, planId, projectId, language: head.model.settings.language, ...(toolModels ? { toolModels } : {}), ...this.reels(projectId) },
          { signal: ac.signal, budgetCheck: () => this.ctx.hooks.budgetCheck(projectId), tools: { ...brainstormTools(this.ctx, projectId, head.model.settings.language), ...research.handlers }, research: research.cfg, ...(progress ? { onProgress: progress } : {}),
            ...(onDelta ? { onDelta: (d: string) => { if (!ac.signal.aborted) onDelta(d); } } : {}), ...(extras.images?.length ? { images: extras.images } : {}) }).finally(() => own?.flush());
        usage = r.usage;
        if (r.ok && (r.sources?.length || research.images.length)) { try { extras.onSources?.({ sources: r.sources ?? [], images: research.images }); } catch { /* chat hint only */ } }
        // Usage is recorded under the run that made the request (the S3 chat's run when external, FR-074).
        if (usage.length) { try { this.ctx.hooks.recordUsage(projectId, 'editor', runId, usage); } catch (e) { this.ctx.log.warn({ err: String(e) }, 'recordUsage failed'); } }
        const current = this.planRow(planId);
        if (current.status === 'cancelled' || ac.signal.aborted) { this.finishCancelled(run); return this.planDtoFor(planId); }
        const agg = aggregate(usage);
        this.logRun({ projectId, runId, planId, provider: provider.id, model: provider.model, durationMs: Date.now() - t0, diagnostics: r.diagnostics, targets: extras.targets?.length ?? 0,
          ...(r.ok ? { status: r.plan.status, steps: r.plan.steps.length, ops: planOps(r.plan).length, toolSteps: r.plan.steps.filter((x) => x.tool !== 'composition.applyOps').map((x) => `${x.tool}:${String(x.args['status'] ?? '')}`), risks: r.plan.risks.map((x) => x.code), validation: r.plan.validation.map((x) => `${x.code}@${x.path}`).slice(0, 10) }
            : { status: 'failed', error: r.error } ) });
        if (r.ok) {
          let status: EditPlanT['status'] = 'valid';
          try { if (this.store.head(projectId).hash !== head.hash) status = 'stale'; } catch { status = 'cancelled'; }
          const plan: EditPlanT = { ...r.plan, ...(agg ? { usage: agg } : {}), ...(JSON.parse(current.plan_json).notes ? { notes: JSON.parse(current.plan_json).notes as string } : {}) };
          this.updatePlan(planId, plan, status);
          if (!external) this.finishRun(runId, 'done', null);
          if (!external) this.ctx.bus.emit('agent.run.done', { at: this.ctx.now(), projectId, run: this.runDto(runId), usage: agg, contextUsage: this.editorContextUsage(usage), planId });
          if (status === 'valid') this.emitPlanReady(planId, runId); else this.emitPlanInvalid(projectId, plan, status, 'EM-2301');
        } else {
          const code = r.error.code;
          const status: EditPlanT['status'] = code === 'EM-2301' ? 'stale' : code === 'EM-4301' ? 'invalid' : 'failed';
          // QA P1 2026-10-29: a refused key keeps the provider's own reason ("invalid x-api-key") for the chat failure card
          const why = code === 'EM-4002' ? (r.error.details as { reason?: unknown } | undefined)?.reason : undefined;
          const message = typeof why === 'string' && why ? `${r.error.message.replace(/\.$/, '')}: "${why}".` : r.error.message;
          const plan: EditPlanT = { ...JSON.parse(current.plan_json) as EditPlanT, validation: [{ path: '', message, code }], ...(agg ? { usage: agg } : {}) };
          this.updatePlan(planId, plan, status);
          if (!external) {
            this.finishRun(runId, 'failed', code);
            this.ctx.bus.emit('agent.run.failed', { at: this.ctx.now(), projectId, runId, agent: 'editor', code, retryable: code !== 'EM-4002' && code !== 'EM-4201' });
          }
          this.emitPlanInvalid(projectId, plan, status, code);
        }
      } catch (e) {
        const em = e instanceof EmError ? e : new EmError('EM-9001', 'Something went wrong.', { cause: e });
        if (ac.signal.aborted) this.finishCancelled(run);
        else {
          const cur = JSON.parse(this.planRow(planId).plan_json) as EditPlanT;
          const plan: EditPlanT = { ...cur, validation: [{ path: '', message: em.message, code: em.code }] };
          this.updatePlan(planId, plan, 'failed');
          if (!external) { this.finishRun(runId, 'failed', em.code); this.ctx.bus.emit('agent.run.failed', { at: this.ctx.now(), projectId, runId, agent: 'editor', code: em.code, retryable: true }); }
          this.emitPlanInvalid(projectId, plan, 'failed', em.code);
          this.logRun({ projectId, runId, planId, provider: provider.id, model: provider.model, durationMs: Date.now() - t0, status: 'failed', error: em, targets: extras.targets?.length ?? 0 });
        }
      } finally { this.runs.delete(planId); }
      return this.planDtoFor(planId);
    })();
    return { plan: this.planDtoFor(planId), runId, done };
  }

  /**
   * FR-190: one line per Editor Agent run in the service log — agent, provider, model id, duration, plan size, the repairs the
   * lenient parser made, validation codes / paths, provider error code / HTTP status / the provider's own reason. Never prompt
   * text, Creator text or keys (the logger redacts secrets as well).
   */
  private logRun(x: { projectId: string; runId: string; planId: string; provider: string; model: string; durationMs: number; status: string; diagnostics?: EditorRunDiagnostics; error?: EmError; steps?: number; ops?: number; toolSteps?: string[]; risks?: string[]; validation?: string[]; targets: number }): void {
    const d = x.diagnostics;
    const det = (x.error?.details ?? {}) as Record<string, unknown>;
    const line = { agent: 'editor', mode: 'edit', projectId: x.projectId, runId: x.runId, planId: x.planId, provider: x.provider, model: x.model, durationMs: x.durationMs, status: x.status, targets: x.targets,
      ...(x.steps !== undefined ? { steps: x.steps, ops: x.ops, toolSteps: x.toolSteps, risks: x.risks, validation: x.validation } : {}),
      ...(d ? { attempts: d.attempts, toolRounds: d.toolRounds, repairs: d.repairs, repairKinds: d.repairKinds, parseFailures: d.parseFailures, intentsReturned: d.intentsReturned, fallbackQuestion: !!d.fallbackQuestion, lastIssues: d.lastIssues.map((i) => `${i.code}@${i.path}`) } : {}),
      ...(x.error ? { code: x.error.code, ...(typeof det['status'] === 'number' ? { providerStatus: det['status'] } : {}), ...(typeof det['reason'] === 'string' ? { providerReason: det['reason'] } : {}) } : {}) };
    if (x.error) this.ctx.log.warn(line, 'agent run failed'); else this.ctx.log.info(line, 'agent run');
  }

  /** FR-074: the counter is the last request's input + output tokens over the assigned model's context length (Capability Table). */
  private editorContextUsage(usage: readonly ChatUsage[]): { usedTokens: number; contextLength: number | null } {
    const last = usage[usage.length - 1];
    return { usedTokens: last ? last.inputTokens + last.outputTokens : 0, contextLength: this.editorContextLength() };
  }
  /** The Editor Agent model's context length (Capability Table), null when unknown. */
  private editorContextLength(): number | null {
    try { const a = getAssignment(this.ctx, 'editor'); return a ? cachedModels(this.ctx, a.connectionId)?.find((m) => m.modelId === a.modelId)?.contextLength ?? null : null; } catch { return null; /* providers module absent */ }
  }
  private finishRun(runId: string, status: 'done' | 'failed' | 'cancelled', code: string | null): void {
    this.ctx.db.prepare("UPDATE agent_runs SET status = ?, error_code = ?, finished_at = ? WHERE id = ? AND status = 'running'").run(status, code, this.ctx.now(), runId);
  }
  /** FR-084: cancelling a chat request withdraws it: its chat Edit Intent (FR-080) is removed so the next message does not repeat it. */
  private withdrawChatIntents(projectId: string, planId: string): void {
    const row = this.planRow(planId);
    const ids = new Set(row.intent_ids_json ? (JSON.parse(row.intent_ids_json) as string[]) : []);
    const chat = this.loadQueue(projectId).filter((i) => ids.has(i.id) && i.source === 'chat' && i.status === 'queued').map((i) => i.id);
    this.emitQueue(projectId, this.setIntentStatus(projectId, chat, 'removed'), 'removed');
  }
  private finishCancelled(run: Run): void {
    this.withdrawChatIntents(run.projectId, run.planId);
    const r = this.planRow(run.planId);
    const p = JSON.parse(r.plan_json) as EditPlanT;
    if (r.status !== 'cancelled') this.updatePlan(run.planId, p, 'cancelled');
    if (run.external) { if (r.status !== 'cancelled') this.emitPlanInvalid(run.projectId, p, 'cancelled', 'EM-4303'); return; }
    if ((this.ctx.db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(run.runId) as { status: string } | undefined)?.status === 'running') {
      this.finishRun(run.runId, 'cancelled', 'EM-4303');
      this.ctx.bus.emit('agent.run.failed', { at: this.ctx.now(), projectId: run.projectId, runId: run.runId, agent: 'editor', code: 'EM-4303', retryable: true });
      this.emitPlanInvalid(run.projectId, p, 'cancelled', 'EM-4303');
    }
  }
  runDto(runId: string) {
    const r = this.ctx.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as { id: string; project_id: string; agent: string; status: string; model_id: string; connection_id: string | null; error_code: string | null; started_at: string; finished_at: string | null } | undefined;
    if (!r) return null;
    const plan = this.ctx.db.prepare('SELECT id FROM edit_plans WHERE agent_run_id = ?').get(runId) as { id: string } | undefined;
    return { id: r.id, projectId: r.project_id, agent: r.agent, status: r.status, modelId: r.model_id, connectionId: r.connection_id, planId: plan?.id ?? null, errorCode: r.error_code, usage: null, startedAt: r.started_at, finishedAt: r.finished_at };
  }

  // ───────────────────────────── R-073 Execute ─────────────────────────────
  async execute(planId: string, o: { confirmDestructive: boolean; idempotencyKey?: string | undefined }): Promise<ExecutionResultT & { notice?: string }> {
    const row = this.planRow(planId);
    if (o.idempotencyKey) {
      const prior = this.ctx.db.prepare("SELECT result_json FROM edit_plans WHERE project_id = ? AND idempotency_key = ? AND result_json IS NOT NULL AND updated_at > ? ORDER BY updated_at DESC LIMIT 1")
        .get(row.project_id, o.idempotencyKey, new Date(Date.now() - 24 * 3_600_000).toISOString()) as { result_json: string } | undefined;
      if (prior) return { ...(JSON.parse(prior.result_json) as ExecutionResultT), notice: 'EM-2308' };
    }
    if (row.status === 'executed' && row.result_json) return { ...(JSON.parse(row.result_json) as ExecutionResultT), notice: 'EM-2308' };
    if (row.status === 'executing' || row.status === 'draft' || this.executing.has(row.project_id) || this.voicing.has(row.project_id)) throw new EmError('EM-2309', 'Another change is being applied. Wait for it to finish, then try again.', { details: { projectId: row.project_id, activePlanId: planId } });
    const plan = JSON.parse(row.plan_json) as EditPlanT;
    if (row.status === 'stale') throw stale(this.store.head(row.project_id).hash, plan.baseVersion);
    if (row.status === 'cancelled' || row.status === 'invalid') throw new EmError('EM-2303', 'This plan cannot be executed.', { details: { planId, status: row.status } });
    const destructive = [...new Set(planOps(plan).filter((op) => DESTRUCTIVE.has(op.op)).map((op) => op.op))];
    // QA 2026-10-28 #17: was EM-9002 "Request not valid", which hid the reason. EM-4310 names what will be removed; the Plan Card asks
    // inline and executes again with confirmDestructive: true.
    if (destructive.length && !o.confirmDestructive) {
      const items = planOps(plan).filter((op) => DESTRUCTIVE.has(op.op)).slice(0, 20).map((op) => ({ op: op.op, ...(op.target ? { target: op.target } : {}) }));
      throw new EmError('EM-4310', `This plan removes ${items.length} item(s) from the video; confirm the removal to continue.`, { status: 409, path: 'body.confirmDestructive', details: { destructive, items } });
    }
    // FR-084: the plan is `executing` from here; a Cancel that arrives before the transaction starts aborts it (nothing is committed).
    // Inside the transaction the commit is atomic (SQLite), so a later Cancel can never leave a partial Composition Version.
    this.updatePlan(planId, plan, 'executing');
    this.pendingExec.add(planId);
    await new Promise<void>((r) => setImmediate(r));
    this.pendingExec.delete(planId);
    if (this.cancelledExec.delete(planId)) throw new EmError('EM-4303', 'The change was cancelled before it was applied. Nothing changed.', { status: 409, details: { planId } });
    // FR-224: a scene.compose plan with voice clips → voices FIRST, measure them, compose again with the real durations, then one
    // Composition Version. A failed voice-over stops Execute with the reason (never invented timing; nothing is applied).
    const vf = voiceFirstOf(plan);
    if (vf && this.ctx.hooks.voiceBatch) {
      const t0 = performance.now(); const head = this.store.head(row.project_id);
      // Review A2: a plan whose base already moved is never voiced (paid) first: stale now, re-planned by the Editor.
      if (plan.baseVersion !== head.hash) { this.updatePlan(planId, plan, 'stale'); this.emitPlanInvalid(row.project_id, plan, 'stale', 'EM-2301'); throw stale(head.hash, plan.baseVersion); }
      const ac = new AbortController(); this.voiceExec.set(planId, ac); this.voicing.add(row.project_id);
      try {
        const next = await this.prepareVoiceFirst(row.project_id, planId, plan, vf, ac.signal);
        if (ac.signal.aborted) throw new EmError('EM-4303', 'cancelled');
        this.updatePlan(planId, next, 'valid');
      } catch (e) {
        // Review A1: Cancel during the voice phase: cancel() already marked the plan cancelled; the batch's clips were removed (A3).
        if (ac.signal.aborted) throw new EmError('EM-4303', 'The change was cancelled before it was applied. Nothing changed.', { status: 409, details: { planId } });
        const em = e instanceof EmError ? e : new EmError('EM-7101', 'The voice-over could not be generated.', { cause: e });
        this.ctx.log.warn({ projectId: row.project_id, planId, code: em.code }, 'voice-first execute stopped: voice-over failed');
        const result: ExecutionResultT = { planId, ok: false, fromVersion: head.hash, appliedOps: 0, diff: [], error: { code: /^EM-\d{4}$/.test(em.code) ? em.code : 'EM-7101', message: `${em.message} Nothing was changed: the scene timing needs the real voice clips.` }, durationMs: Math.round(performance.now() - t0) };
        this.updatePlan(planId, plan, 'failed', { result });
        this.emitPlanInvalid(row.project_id, { ...plan, validation: [{ path: '', message: result.error!.message, code: result.error!.code }] }, 'failed', result.error!.code as EmCode);
        this.planProgress(row.project_id, planId, 'failed', {});
        return result;
      } finally { this.voiceExec.delete(planId); this.voicing.delete(row.project_id); }
    }
    return this.executeRow(this.planRow(planId), { checkpoint: true, ...(o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : {}) }).result;
  }

  /** FR-223: Execute phases for the Plan Card (voices n/m → measure → compose → apply). */
  private planProgress(projectId: string, planId: string, phase: 'voice' | 'measure' | 'compose' | 'apply' | 'failed', extra: { done?: number; total?: number; totalMs?: number }) {
    this.ctx.bus.emit('plan.progress', { at: this.ctx.now(), projectId, planId, phase, ...extra });
  }

  /** FR-224: generates the plan's voice clips (one batch job), fills their asset ids / measured durations into the VideoSpec and composes again. */
  private async prepareVoiceFirst(projectId: string, planId: string, plan: EditPlanT, vf: NonNullable<ReturnType<typeof voiceFirstOf>>, signal?: AbortSignal): Promise<EditPlanT> {
    const spec = vf.spec;
    const clips = (spec.voice?.clips ?? []).filter((c) => !c.assetId);
    const language = spec.language ?? this.store.head(projectId).model.settings.language;
    this.planProgress(projectId, planId, 'voice', { done: 0, total: clips.length });
    const tts = plan.steps.find((s) => s.tool === 'tts.generate' && typeof s.args['voiceId'] === 'string');
    const voiceId = spec.voice?.voiceId ?? (tts?.args['voiceId'] as string | undefined) ?? (language === 'en' ? 'natural, warm, clear voice' : 'suara natural, hangat, jelas');
    const r = await this.ctx.hooks.voiceBatch!(projectId, { clips: clips.map((c) => ({ id: c.id, text: c.text })), voiceId, language, ...(spec.voice?.speed ? { speed: spec.voice.speed } : {}),
      ...(spec.maxDurationMs ? { maxTotalMs: spec.maxDurationMs } : {}), ...(spec.voice?.gapMs !== undefined ? { gapMs: spec.voice.gapMs } : {}), ...(spec.voice?.tailMs !== undefined ? { sceneGapMs: spec.voice.tailMs } : {}), insert: false },
      { ...(signal ? { signal } : {}), onClip: (done, total) => this.planProgress(projectId, planId, 'voice', { done, total }) });   // QA UX round 1: n of N clips
    const got = new Map(r.clips.map((c) => [c.id, c] as const));
    const missing = clips.filter((c) => !got.get(c.id)?.assetId);
    if (missing.length) throw new EmError('EM-7101', `The voice clips ${missing.map((c) => c.id).join(', ')} were not generated.`);
    this.planProgress(projectId, planId, 'measure', { done: clips.length, total: clips.length, totalMs: r.totalMs });
    const filled: VideoSpecT = { ...spec, voice: { ...spec.voice!, clips: spec.voice!.clips.map((c) => { const g = got.get(c.id); return g ? { ...c, assetId: g.assetId, durationMs: Math.max(100, Math.round(g.durationMs)) } : c; }) } };
    this.planProgress(projectId, planId, 'compose', { totalMs: r.totalMs });
    const head = this.store.head(projectId);
    const c = composeScenes(filled, { model: head.model, assets: this.store.facts(projectId), tier: this.ctx.hooks.tier(), language, ...this.reels(projectId) });
    if (!c.ok) throw new EmError('EM-2102', `The scenes could not be composed with the measured voice: ${c.problem}`);
    const ttsN = new Set(vf.ttsSteps);
    const secs = (c.totalMs / 1000).toFixed(1);
    const steps = plan.steps.filter((s) => !ttsN.has(s.n)).map((s) => (s.n === vf.stepN ? { ...s, ops: c.ops, args: { ...s.args, sceneCompose: filled, measured: true } } : s));
    const note = language === 'en' ? `Scene lengths follow the generated voice: ${c.scenes.length} scenes, ${secs} s in total.` : `Durasi adegan mengikuti suara yang dibuat: ${c.scenes.length} adegan, total ${secs.replace('.', ',')} dtk.`;
    this.planProgress(projectId, planId, 'apply', { totalMs: c.totalMs });
    return { ...plan, steps, risks: [...plan.risks.filter((x) => x.code !== 'voice-measured'), { code: 'voice-measured', message: note, severity: 'info' }] };
  }

  /** The Execute core shared by R-073 and the compile-now path. One transaction; rollback reported as ExecutionResult ok:false. */
  private executeRow(row: PlanRow, o: { checkpoint: boolean; idempotencyKey?: string; extraChanged?: string[] }): { result: ExecutionResultT; version: VersionDto | null } {
    const projectId = row.project_id, planId = row.id;
    const t0 = performance.now();
    const plan = JSON.parse(row.plan_json) as EditPlanT;
    const head = this.store.head(projectId);
    if (plan.baseVersion !== head.hash) {
      this.updatePlan(planId, plan, 'stale'); this.emitPlanInvalid(projectId, plan, 'stale', 'EM-2301');
      throw stale(head.hash, plan.baseVersion);
    }
    const intentIds = row.intent_ids_json ? (JSON.parse(row.intent_ids_json) as string[]) : [];
    const own = new Set(intentIds);
    const queue = this.loadQueue(projectId);
    const mine = queue.filter((i) => own.has(i.id));
    const creatorOnly = plan.origin === 'compile' && mine.length > 0 && mine.every((i) => i.source === 'ui' || i.source === 'system');   // see applyNow
    const v = validatePlan({ ...plan, status: 'draft' }, { model: head.model, baseVersion: head.hash, assets: this.store.facts(projectId), tier: this.ctx.hooks.tier(), lockedKeys: creatorOnly ? [] : lockedKeysFromQueue(queue.filter((i) => !own.has(i.id))), newId: this.ctx.newId, ...this.reels(projectId) });
    if (v.plan.status !== 'valid' || (!v.predicted && planOps(plan).length > 0)) {
      const st = v.plan.status === 'stale' ? 'stale' : 'invalid';
      this.updatePlan(planId, v.plan, st);
      const code: EmCode = v.plan.touchesLockedKeys.length ? 'EM-2302' : 'EM-2303';
      this.emitPlanInvalid(projectId, v.plan, st, code);
      const first = v.issues.find((i) => i.severity === 'block');
      throw new EmError(code, code === 'EM-2302' ? `The plan would change settings you already picked (${v.plan.touchesLockedKeys.join(', ')}).` : first?.message ?? 'The plan is not valid.', { details: { planId, touchesLockedKeys: v.plan.touchesLockedKeys, validation: v.plan.validation.slice(0, 10) } });
    }
    this.executing.add(projectId);
    try {
      this.updatePlan(planId, v.plan, 'executing');
      if (o.checkpoint) { try { this.checkpoints.write(projectId, 'pre-execute'); } catch (e) { this.ctx.log.warn({ projectId, err: String(e) }, 'pre-execute checkpoint failed'); } }
      const ops: OperationT[] = planOps(v.plan);
      const predicted = v.predicted ?? { model: head.model, diff: [] };
      let result!: ExecutionResultT; let intentChanged: string[] = [];
      try {
        const c = this.store.commit(projectId, predicted.model, {
          cause: v.plan.origin === 'compile' ? 'compile' : 'execute', planId, ops, diff: predicted.diff,
          inTx: (_versionId, hash) => {
            result = { planId, ok: true, fromVersion: head.hash, toVersion: hash, appliedOps: ops.length, diff: predicted.diff, durationMs: Math.round(performance.now() - t0) };
            const before = this.loadQueue(projectId);
            // Version ordinal (1-based, counting every version row of the project incl. this one) for "Applied in v{n}" grouping.
            const ordinal = (this.ctx.db.prepare('SELECT count(*) AS n FROM composition_versions WHERE project_id = ?').get(projectId) as { n: number }).n;
            const after = before.map((i) => (own.has(i.id) && (i.status === 'queued' || i.status === 'planned' || i.status === 'compiled') ? { ...i, status: 'executed' as const, appliedVersion: ordinal, appliedHash: hash } : i));
            intentChanged = this.saveQueue(projectId, before, after);
            this.updatePlan(planId, v.plan, 'executed', { result, ...(o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : {}) });
          },
          beforeEvent: () => this.emitQueue(projectId, [...new Set([...(o.extraChanged ?? []), ...intentChanged])], 'executed'),
        });
        this.emitPlanReady(planId);
        // ADR-030: generator steps run after the commit (they need the committed head) as Local Service jobs; each inserts its
        // result as a later Composition Version. A step whose model is missing is reported as skipped (the Plan Card says so).
        const gen = v.plan.steps.filter((st) => st.tool !== 'composition.applyOps');
        if (gen.length) {
          const runnable = gen.filter((st) => st.args['status'] !== 'needs-model');
          let started: NonNullable<ExecutionResultT['toolSteps']> = [];
          try { started = runnable.length && this.ctx.hooks.runPlanSteps ? this.ctx.hooks.runPlanSteps(projectId, planId, runnable.map((st) => ({ n: st.n, tool: st.tool, args: st.args, dependsOn: st.dependsOn }))) : runnable.map((st) => ({ n: st.n, tool: st.tool, status: 'skipped' as const, code: 'EM-9004' })); }
          catch (e) { started = runnable.map((st) => ({ n: st.n, tool: st.tool, status: 'failed' as const, code: e instanceof EmError ? e.code : 'EM-7101' })); }
          result.toolSteps = [...started, ...gen.filter((st) => st.args['status'] === 'needs-model').map((st) => ({ n: st.n, tool: st.tool, status: 'skipped' as const, code: 'EM-7001' }))].sort((x, y) => x.n - y.n);
          this.updatePlan(planId, v.plan, 'executed', { result });
        }
        return { result, version: c.changed ? c.version : versionDto(this.store.versionRow(projectId, c.version.id)) };
      } catch (e) {
        // SQLite rolled the transaction back: head, intents and history are unchanged (AI_WORKFLOW §12).
        this.ctx.log.error({ projectId, planId, err: String(e) }, 'execute failed; rolled back');
        result = { planId, ok: false, fromVersion: head.hash, appliedOps: 0, diff: [], error: { code: 'EM-2307', message: 'A step failed, so the whole change was undone. Your project is unchanged.', step: 1 },
          rollback: { performed: true, toVersion: head.hash }, durationMs: Math.round(performance.now() - t0) };
        this.updatePlan(planId, v.plan, 'failed', { result });
        this.emitPlanInvalid(projectId, { ...v.plan, validation: [{ path: '', message: result.error!.message, code: 'EM-2307' }] }, 'failed', 'EM-2307');
        return { result, version: null };
      }
    } finally { this.executing.delete(projectId); }
  }

  // ───────────────────────────── R-074 / R-075 ─────────────────────────────
  cancel(planId: string) {
    const row = this.planRow(planId);
    if (row.status === 'executing' && this.pendingExec.has(planId)) {
      this.pendingExec.delete(planId); this.cancelledExec.add(planId);
      const p = JSON.parse(row.plan_json) as EditPlanT;
      this.withdrawChatIntents(row.project_id, planId);
      this.updatePlan(planId, p, 'cancelled');
      this.emitPlanInvalid(row.project_id, p, 'cancelled', 'EM-4303');
      return this.planDtoFor(planId);
    }
    const voicing = this.voiceExec.get(planId);
    if (row.status === 'executing' && voicing) {                       // review A1: still generating the voices; nothing is committed yet
      voicing.abort();
      const p = JSON.parse(row.plan_json) as EditPlanT;
      this.withdrawChatIntents(row.project_id, planId);
      this.updatePlan(planId, p, 'cancelled');
      this.emitPlanInvalid(row.project_id, p, 'cancelled', 'EM-4303');
      return this.planDtoFor(planId);
    }
    if (row.status === 'executing') throw new EmError('EM-2309', 'Another change is being applied. Wait for it to finish, then try again.', { details: { projectId: row.project_id, activePlanId: planId } });
    if (row.status === 'executed') throw new EmError('EM-9002', 'An executed plan cannot be cancelled; use Undo.', { status: 422, details: { reason: 'executed' } });
    if (row.status === 'cancelled') return this.planDtoFor(planId);
    const run = this.runs.get(planId);
    if (run) { run.ac.abort(); this.finishCancelled(run); return this.planDtoFor(planId); }
    const p = JSON.parse(row.plan_json) as EditPlanT;
    this.withdrawChatIntents(row.project_id, planId);
    this.updatePlan(planId, p, 'cancelled');
    if (row.agent_run_id) this.finishRun(row.agent_run_id, 'cancelled', 'EM-4303');
    this.emitPlanInvalid(row.project_id, p, 'cancelled', 'EM-4303');
    return this.planDtoFor(planId);
  }
  setNotes(planId: string, notes: string) {
    const row = this.planRow(planId);
    const p = JSON.parse(row.plan_json) as EditPlanT;
    this.updatePlan(planId, { ...p, notes }, row.status);
    return this.planDtoFor(planId);
  }

  // ───────────────────────────── Brainstorm hand-off (hooks.enqueueIntents) ─────────────────────────────
  /**
   * Enqueues already-built intents (Brainstorm hand-off, AI_WORKFLOW §6/§9). They are normalised to this project, the current
   * head and status 'queued'; an intent whose key is a Locked Key is kept but 'rejected' so it never supersedes the Creator's pick.
   */
  // ───────────────────────────── FR-037 held picks / FR-049 asset Insert ─────────────────────────────
  /** FR-037: the pick is persisted as `held` (EM-2104): visible in the Intent Queue, ignored by supersession and planning. */
  private holdIntents(projectId: string, incoming: EditIntentT[], modelFlag: string): PickResult {
    const before = this.loadQueue(projectId);
    const held = incoming.map((i) => ({ ...i, status: 'held' as const, params: { ...i.params, __heldFor: modelFlag } }));
    this.emitQueue(projectId, this.saveQueue(projectId, before, [...before, ...held]), 'created');
    return { intent: held[0]!, queue: this.queueDto(projectId), superseded: [], appliedVersion: null, planId: null, notices: [{ code: 'EM-2104' }] };
  }

  /** FR-037: `model.installed` → every pick held for that model becomes `queued` and goes through the normal path (Compile + apply). */
  resumeHeld(modelFlag: string): string[] {
    const projects = this.ctx.db.prepare("SELECT DISTINCT project_id FROM edit_intents WHERE status = 'held'").all() as Array<{ project_id: string }>;
    const resumedIds: string[] = [];
    for (const { project_id: pid } of projects) {
      const before = this.loadQueue(pid);
      const held = before.filter((i) => i.status === 'held' && i.params['__heldFor'] === modelFlag);
      if (!held.length) continue;
      const ids = new Set(held.map((i) => i.id));
      const resumed = held.map((i) => { const params = { ...i.params }; delete params['__heldFor']; return { ...i, status: 'queued' as const, params }; });
      resumedIds.push(...ids);
      const top = resumed.filter((i) => !i.parentIntentId);
      try {
        for (const t of top) {
          const family = resumed.filter((i) => i.id === t.id || i.parentIntentId === t.id);
          const cur = this.loadQueue(pid).filter((i) => !family.some((f) => f.id === i.id));
          this.enqueueAndMaybeApply(pid, family, { auto: true, reason: 'restored', before: this.loadQueue(pid), after: enqueue(cur, family) });
        }
      } catch (e) { this.ctx.log.warn({ projectId: pid, modelFlag, err: String(e) }, 'held pick could not be applied'); }
    }
    return resumedIds;
  }

  /** FR-049: an asset Insert is one Edit Intent ("Insert N clips", a list key that is never superseded), applied directly. */
  insertIntent(projectId: string, ops: readonly OperationT[], meta: { label: string; assetIds: string[]; playheadMs?: number }): { versionId: string; intentId: string } {
    const head = this.store.head(projectId);
    const id = this.ctx.newId();
    const intent: EditIntentT = {
      id, projectId, source: 'ui', createdAt: this.ctx.now(), category: 'asset', params: { targetLabel: meta.label, __insert: { count: meta.assetIds.length, assetIds: meta.assetIds, ...(meta.playheadMs !== undefined ? { playheadMs: meta.playheadMs } : {}) } },
      target: { kind: 'sequence' }, resolvedTargets: [{ kind: 'sequence' }], propertyKey: `list:asset.insert:${id}`, propertyClass: 'list', needsInterpretation: false, status: 'queued', supersedes: [], baseVersion: head.hash,
    };
    const before = this.loadQueue(projectId);
    const changed = this.saveQueue(projectId, before, [...before, intent]);
    const res = this.applyNow(projectId, [id], { reason: 'created', changedBefore: changed, ops, goal: meta.label });
    if (!res.version) throw new EmError('EM-2307', 'The change could not be applied.');
    return { versionId: res.version.id, intentId: id };
  }

  enqueueExternal(projectId: string, raw: readonly unknown[]): { queue: EditIntentT[] } {
    const head = this.store.head(projectId);
    const before = this.loadQueue(projectId);
    const locked = lockedKeysFromQueue(before);
    const taken = (id: string) => !!this.ctx.db.prepare('SELECT 1 FROM edit_intents WHERE id = ?').get(id);
    const idMap = new Map<string, string>();
    const parsed = raw.map((x) => EditIntent.parse(x));
    for (const i of parsed) idMap.set(i.id, taken(i.id) || idMap.has(i.id) ? this.ctx.newId() : i.id);
    const incoming: EditIntentT[] = [], rejected: EditIntentT[] = [];
    for (const i of parsed) {
      const n: EditIntentT = { ...i, id: idMap.get(i.id)!, projectId, status: 'queued', baseVersion: head.hash, supersedes: [], ...(i.parentIntentId ? { parentIntentId: idMap.get(i.parentIntentId) ?? i.parentIntentId } : {}) };
      const keys = n.propertyKey.split('|');
      if (keys.some((k) => locked.includes(k))) rejected.push({ ...n, status: 'rejected', rejectionReason: 'This setting is one you picked yourself, so the suggestion was not applied.' });
      else incoming.push(n);
    }
    const after = [...enqueue(before, incoming), ...rejected];
    const changed = this.saveQueue(projectId, before, after);
    this.emitQueue(projectId, changed, 'created');
    return { queue: this.loadQueue(projectId) };
  }
  /** Drains R-082 hand-offs that S3 stored before hooks.enqueueIntents existed (table from migration 30). */
  drainHandoffs(): void {
    let rows: Array<{ id: string; project_id: string; intents_json: string }> = [];
    try { rows = this.ctx.db.prepare("SELECT id, project_id, intents_json FROM brainstorm_handoffs WHERE status = 'pending' ORDER BY created_at").all() as typeof rows; } catch { return; }
    for (const r of rows) {
      try {
        this.enqueueExternal(r.project_id, JSON.parse(r.intents_json) as unknown[]);
        this.ctx.db.prepare("UPDATE brainstorm_handoffs SET status = 'enqueued' WHERE id = ?").run(r.id);
      } catch (e) { this.ctx.log.warn({ projectId: r.project_id, err: String(e) }, 'handoff drain failed'); }
    }
  }

  // ───────────────────────────── lifecycle ─────────────────────────────
  /** FR-172: plans left `executing` → failed (the transaction was rolled back); planning runs → cancelled (EM-4304). */
  recoverOnStart(): void {
    const db = this.ctx.db, now = this.ctx.now();
    const rows = db.prepare("SELECT * FROM edit_plans WHERE status IN ('executing','draft')").all() as PlanRow[];
    for (const r of rows) {
      const p = JSON.parse(r.plan_json) as EditPlanT;
      const status = r.status === 'executing' ? 'failed' : 'cancelled';
      const code = r.status === 'executing' ? 'EM-2307' : 'EM-4304';
      this.updatePlan(r.id, { ...p, validation: [{ path: '', message: code === 'EM-4304' ? 'Expertmotion restarted during the agent request. Send it again.' : 'Execute was interrupted; nothing was applied.', code }] }, status);
      if (r.agent_run_id) db.prepare("UPDATE agent_runs SET status = 'cancelled', error_code = 'EM-4304', finished_at = ? WHERE id = ? AND status = 'running'").run(now, r.agent_run_id);
    }
  }
  stop(): void { for (const r of this.runs.values()) r.ac.abort(); }
}

function aggregate(usage: ChatUsage[]): EditPlanT['usage'] | undefined {
  if (!usage.length) return undefined;
  const cost = usage.every((u) => u.costUsd !== null) ? usage.reduce((s, u) => s + (u.costUsd ?? 0), 0) : null;
  const read = usage.reduce((s, u) => s + (u.cacheReadTokens ?? 0), 0), write = usage.reduce((s, u) => s + (u.cacheWriteTokens ?? 0), 0);
  return { model: usage[usage.length - 1]!.model, inputTokens: usage.reduce((s, u) => s + u.inputTokens, 0), outputTokens: usage.reduce((s, u) => s + u.outputTokens, 0), costUsd: cost, approximate: usage.some((u) => u.approximate),
    ...(read ? { cacheReadTokens: read } : {}), ...(write ? { cacheWriteTokens: write } : {}) };
}

export function targetExists(m: CompositionModelT, ref: ElementRefT): boolean {
  switch (ref.kind) {
    case 'clip': return m.tracks.video.some((c) => c.id === ref.id);
    case 'text': return m.tracks.text.some((t) => t.id === ref.id);
    case 'audio': return m.tracks.audio.some((a) => a.id === ref.id);
    case 'shape': return m.tracks.overlay.some((o) => o.id === ref.id);
    case 'cut': return ref.index !== undefined && ref.index < m.tracks.video.length - 1;
    default: return true;
  }
}
