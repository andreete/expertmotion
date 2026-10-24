// Edit-intent pipeline steps 2–7 (docs/AI_WORKFLOW.md §2, §4, §6, §7): typed intents from Design Picks, Target Resolution,
// multi-target expansion, the Intent Queue reducer (supersede / restore / remove) and the deterministic Compile path.
import { compileDefaults, getPreset, type Category } from '@expertmotion/catalogue';
import { deriveTiming, propertyKeysOf, type CompositionModelT, type ElementRefT, type OperationT } from '@expertmotion/composition-model';
import { fail, issue, ok, type Result } from '@expertmotion/shared';
import type { EditIntentT, IntentCategory } from './schemas.js';

export type TextField = 'fontFamily' | 'fontSize' | 'weight' | 'colour' | 'align' | 'opacity';
/** What the Editor sends when the Creator picks something (a Catalogue Card, a Text Panel value, an Output Setting, or a chat request). */
export interface DesignPick {
  projectId: string;
  source: EditIntentT['source'];
  presetId?: string;                         // catalogue card
  field?: TextField; value?: unknown;        // Text Panel value (deterministic)
  output?: { kind: 'ratio' | 'resolution' | 'fps'; value: unknown; customRatio?: { w: number; h: number } };
  category?: IntentCategory;                 // required for instruction-only picks (chat / brainstorm)
  params?: Record<string, unknown>;
  instruction?: string;
  selection?: ElementRefT[];                 // selected Timeline Elements (clip, cut, text, audio, shape)
  playheadMs?: number;
  assetId?: string;                          // music bed / sfx asset
  text?: string;                             // content for a text variant
}
export interface IntentContext { model: CompositionModelT; baseVersion: string; newId: () => string; now?: () => string }

const CATEGORY_OF: Record<Category, IntentCategory> = {
  transition: 'transition', caption: 'caption', background: 'background', motion: 'motion', shape: 'shape', easing: 'easing', effect: 'effect',
  audio: 'audio', text: 'text', texteffect: 'text', font: 'text', palette: 'layout', fontpair: 'layout',
};

function elementsAt(model: CompositionModelT, ms: number) {
  const t = deriveTiming(model);
  const clipIdx = model.tracks.video.findIndex((c) => { const w = t.elementWindows[c.id]!; return ms >= w.fromMs && ms < w.toMs; });
  const text = model.tracks.text.find((x) => ms >= x.timing.atMs && ms < x.timing.atMs + x.timing.durationMs);
  return { clip: clipIdx >= 0 ? model.tracks.video[clipIdx] : undefined, text };
}

/** Builds the operation an intent stands for on one resolved target (used both for Compile and for the property key). */
function opFor(pick: DesignPick, target: ElementRefT | undefined, model: CompositionModelT): { op: OperationT; complete: boolean } | null {
  if (pick.output) {
    const o = pick.output;
    if (o.kind === 'ratio') return { op: { op: 'op:output.setRatio', target: { kind: 'project' }, args: { ratio: o.value, ...(o.customRatio ? { customRatio: o.customRatio } : {}) } }, complete: true };
    if (o.kind === 'resolution') return { op: { op: 'op:output.setResolution', target: { kind: 'project' }, args: { preset: o.value } }, complete: true };
    return { op: { op: 'op:project.setFps', target: { kind: 'project' }, args: { fps: o.value } }, complete: true };
  }
  if (pick.field) {
    if (target?.kind === 'text') return { op: { op: 'op:text.setStyle', target, args: { [pick.field]: pick.value } }, complete: true };
    return { op: { op: 'op:theme.setTextDefaults', target: { kind: 'project' }, args: { [pick.field]: pick.value } }, complete: true };
  }
  if (!pick.presetId) return null;
  const d = compileDefaults(pick.presetId); const p = getPreset(pick.presetId);
  if (!d || !p) return null;
  const params = { ...(pick.params ?? {}) };
  let args: Record<string, unknown> = { ...d.args };
  if ('params' in args) args['params'] = { ...(args['params'] as object), ...params };
  else args = { ...args, ...params };
  if (p.category === 'text') { args = { ...args, text: pick.text, atMs: Math.round(pick.playheadMs ?? 0) }; if (target?.kind === 'text') return { op: { op: 'op:text.setStyle', target, args: { ...(p.data?.['fontSize'] ? { fontSize: p.data['fontSize'] } : {}) } }, complete: true }; }
  if (p.category === 'shape') {
    // size/fill/stroke/strokeWidth are first-class op:shape.add args; everything else stays in params.
    const { size, fill, stroke, strokeWidth, ...rest } = (args['params'] ?? {}) as Record<string, unknown>;
    args = { ...args, ...(size !== undefined ? { size } : {}), ...(fill !== undefined ? { fill } : {}), ...(stroke !== undefined ? { stroke } : {}), ...(strokeWidth !== undefined ? { strokeWidth } : {}), params: rest, atMs: Math.round(pick.playheadMs ?? 0) };
  }
  if (p.category === 'font' && target?.kind === 'text') return { op: { op: 'op:text.setStyle', target, args: { fontFamily: args['fontFamily'] } }, complete: true };
  if (pick.assetId) args['assetId'] = pick.assetId;
  if (p.id === 'preset:audio.sfx-hit') args['atMs'] = Math.round(pick.playheadMs ?? 0);
  const missing = d.requires.filter((r) => (r === 'target' ? !target : args[r] === undefined || args[r] === ''));
  const op: OperationT = { op: d.op, args, ...(target ? { target } : d.op.startsWith('op:theme') || d.op.startsWith('op:caption') || d.op.startsWith('op:background') || d.op.startsWith('op:easing') || d.op === 'op:audio.addBed' ? { target: { kind: 'project' as const } } : {}) };
  void model;
  return { op, complete: missing.length === 0 };
}

/** Target Resolution table (AI_WORKFLOW §4). Returns the concrete targets, or an EM issue when the pick cannot be placed. */
export function resolveTargets(pick: DesignPick, model: CompositionModelT): Result<{ targets: Array<ElementRefT | undefined>; label: string }> {
  const sel = pick.selection ?? [];
  const p = pick.presetId ? getPreset(pick.presetId) : undefined;
  const cat: Category | 'field' | 'output' | 'instruction' = pick.output ? 'output' : pick.field ? 'field' : p ? p.category : 'instruction';
  const v = model.tracks.video;
  const at = elementsAt(model, pick.playheadMs ?? 0);
  switch (cat) {
    case 'transition': {
      if (v.length < 2) return fail([issue('EM-2202', 'Add at least two clips before choosing a transition.', 'block', 'target')]);
      const cuts = sel.flatMap((s) => (s.kind === 'cut' && s.index !== undefined ? [s.index] : s.kind === 'clip' ? (() => { const i = v.findIndex((c) => c.id === s.id); return i >= 0 && i < v.length - 1 ? [i] : []; })() : []));
      const list = cuts.length ? [...new Set(cuts)].sort((a, b) => a - b) : v.slice(0, -1).map((_, i) => i);
      return ok({ targets: list.map((index) => ({ kind: 'cut' as const, index })), label: cuts.length ? list.map((i) => `cut ${i + 1}`).join(', ') : `all ${list.length} cut${list.length === 1 ? '' : 's'}` });
    }
    case 'motion': case 'effect': case 'texteffect': {
      const kinds = cat === 'effect' ? ['clip'] : cat === 'texteffect' ? ['text'] : ['clip', 'text', 'shape'];
      const chosen = sel.filter((s) => kinds.includes(s.kind) && s.id);
      if (chosen.length) return ok({ targets: chosen.map((s) => ({ kind: s.kind, id: s.id! })), label: chosen.length === 1 ? `selected ${chosen[0]!.kind}` : `${chosen.length} selected elements` });
      const under = cat === 'texteffect' ? (at.text ? { kind: 'text' as const, id: at.text.id } : undefined) : at.clip ? { kind: 'clip' as const, id: at.clip.id } : cat === 'motion' && at.text ? { kind: 'text' as const, id: at.text.id } : undefined;
      if (!under) return fail([issue('EM-2201', 'Select a clip or move the playhead onto one.', 'block', 'target')]);
      return ok({ targets: [under], label: `${under.kind} under the playhead` });
    }
    case 'field': case 'font': case 'text': {
      const texts = sel.filter((s) => s.kind === 'text' && s.id);
      if (cat !== 'text' && texts.length) return ok({ targets: texts.map((s) => ({ kind: 'text' as const, id: s.id! })), label: texts.length === 1 ? 'selected text' : `${texts.length} texts` });
      return ok({ targets: [undefined], label: cat === 'text' ? 'new text at the playhead' : 'new text (theme default)' });
    }
    case 'audio': {
      if (p?.id === 'preset:audio.bed-soft' || p?.id === 'preset:audio.sfx-hit') return ok({ targets: [undefined], label: 'project audio' });
      const layers = sel.filter((s) => s.kind === 'audio' && s.id);
      if (layers.length) return ok({ targets: layers.map((s) => ({ kind: 'audio' as const, id: s.id! })), label: `${layers.length} audio layer(s)` });
      const bed = model.tracks.audio.find((a) => a.role === 'bed');
      if (!bed) return fail([issue('EM-2201', 'Add music first, then choose how it behaves under voice.', 'block', 'target')]);
      return ok({ targets: [{ kind: 'audio', id: bed.id }], label: 'music bed' });
    }
    default: return ok({ targets: [undefined], label: cat === 'shape' ? 'new shape at the playhead' : 'whole project' });
  }
}

/**
 * Step 2–6: one parent intent per pick plus one child per resolved target when there is more than one (expansion rule, §6).
 * Children carry the concrete propertyKey used for supersession and Locked Keys.
 */
export function createIntents(pick: DesignPick, ctx: IntentContext): Result<EditIntentT[]> {
  const now = ctx.now ?? (() => new Date().toISOString());
  const p = pick.presetId ? getPreset(pick.presetId) : undefined;
  if (pick.presetId && !p) return fail([issue('EM-2101', `Unknown design preset ${pick.presetId}.`, 'block', 'presetId')]);
  const category: IntentCategory = pick.output ? 'layout' : pick.field ? 'text' : p ? CATEGORY_OF[p.category] : (pick.category ?? 'layout');
  const instructionOnly = !p && !pick.field && !pick.output;
  // Persisted intents must be recompilable without the original pick: stash its deterministic inputs under `__` keys.
  const stash: Record<string, unknown> = { ...(pick.params ?? {}),
    ...(pick.field ? { __field: pick.field, __value: pick.value } : {}), ...(pick.output ? { __output: pick.output } : {}),
    ...(pick.text !== undefined ? { __text: pick.text } : {}), ...(pick.assetId ? { __assetId: pick.assetId } : {}), ...(pick.playheadMs !== undefined ? { __playheadMs: pick.playheadMs } : {}) };
  const base = (over: Partial<EditIntentT>): EditIntentT => ({
    id: ctx.newId(), projectId: pick.projectId, source: pick.source, createdAt: now(), category,
    ...(pick.presetId ? { presetId: pick.presetId } : {}), params: stash,
    target: pick.selection?.[0] ?? (pick.playheadMs !== undefined ? { kind: 'playhead' } : { kind: 'project' }),
    resolvedTargets: [], propertyKey: '', propertyClass: p?.propertyClass ?? 'scalar', needsInterpretation: false,
    ...(pick.instruction ? { instruction: pick.instruction } : {}), status: 'queued', supersedes: [], baseVersion: ctx.baseVersion, ...over,
  });
  if (instructionOnly) return ok([base({ propertyKey: `instruction:${ctx.newId()}`, propertyClass: 'list', needsInterpretation: true })]);
  const r = resolveTargets(pick, ctx.model);
  if (!r.ok) return r;
  const { targets, label } = r.value;
  const built = targets.map((t) => ({ t, o: opFor(pick, t, ctx.model) }));
  const keyOf = (o: OperationT | undefined, t: ElementRefT | undefined) => {
    const keys = o ? propertyKeysOf(o) : [];
    if (keys.length) return keys.join('|');
    return `list:${category}:${pick.presetId ?? pick.field ?? 'x'}:${t ? `${t.kind}:${t.id ?? t.index}` : 'project'}`;
  };
  const interpret = !!pick.instruction || built.some((b) => !b.o || !b.o.complete);
  if (built.length === 1) {
    const b = built[0]!;
    return ok([base({ resolvedTargets: b.t ? [b.t] : [], propertyKey: keyOf(b.o?.op, b.t), needsInterpretation: interpret, params: { ...stash, targetLabel: label } })]);
  }
  const parent = base({ resolvedTargets: built.flatMap((b) => (b.t ? [b.t] : [])), propertyKey: `group:${category}:${pick.presetId ?? ''}`, needsInterpretation: interpret, params: { ...stash, targetLabel: label } });
  const children = built.map((b) => base({ parentIntentId: parent.id, resolvedTargets: b.t ? [b.t] : [], propertyKey: keyOf(b.o?.op, b.t), needsInterpretation: interpret }));
  return ok([parent, ...children]);
}

const ACTIVE = new Set(['queued', 'compiled', 'planned', 'executed']);
/** Intent Queue reducer (§6): newest pick wins for scalar / exclusive-group keys and for duplicate list entries; nothing is deleted. */
export function enqueue(queue: readonly EditIntentT[], incoming: readonly EditIntentT[]): EditIntentT[] {
  const q = queue.map((i) => ({ ...i }));
  for (const n of incoming) {
    const add = { ...n, supersedes: [...n.supersedes] };
    if (!n.propertyKey.startsWith('group:') && !n.propertyKey.startsWith('instruction:')) {
      for (const old of q) if (old.propertyKey === n.propertyKey && ACTIVE.has(old.status) && old.id !== n.id) { old.status = 'superseded'; add.supersedes.push(old.id); }
    }
    q.push(add);
  }
  return settleParents(q);
}
function settleParents(q: EditIntentT[]): EditIntentT[] {
  for (const parent of q.filter((i) => i.propertyKey.startsWith('group:'))) {
    const kids = q.filter((c) => c.parentIntentId === parent.id);
    if (kids.length && kids.every((c) => c.status === 'superseded' || c.status === 'removed')) parent.status = kids.every((c) => c.status === 'removed') ? 'removed' : 'superseded';
    else if (kids.length && parent.status === 'superseded') parent.status = 'queued';
  }
  return q;
}
/** Restore a superseded intent: it becomes queued again (restoredAt stamped) and the intent that replaced it is superseded in turn. */
export function restore(queue: readonly EditIntentT[], id: string, now: () => string = () => new Date().toISOString()): Result<EditIntentT[]> {
  const q = queue.map((i) => ({ ...i }));
  const target = q.find((i) => i.id === id);
  if (!target || target.status !== 'superseded') return fail([issue('EM-9003', 'Only a replaced pick can be restored.', 'block', 'id')]);
  const ids = target.parentIntentId === undefined && target.propertyKey.startsWith('group:') ? q.filter((c) => c.parentIntentId === target.id).map((c) => c.id) : [target.id];
  for (const kidId of ids) {
    const kid = q.find((i) => i.id === kidId)!;
    for (const other of q) if (other.propertyKey === kid.propertyKey && other.id !== kid.id && ACTIVE.has(other.status)) { other.status = 'superseded'; }
    kid.status = 'queued'; kid.restoredAt = now();
  }
  target.status = 'queued'; target.restoredAt = now();
  return ok(settleParents(q));
}
export function remove(queue: readonly EditIntentT[], id: string): Result<EditIntentT[]> {
  const q = queue.map((i) => ({ ...i }));
  const t = q.find((i) => i.id === id);
  if (!t) return fail([issue('EM-9003', 'Pick not found.', 'block', 'id')]);
  if (t.status === 'executed' || t.status === 'compiled') return fail([issue('EM-2203', 'Applied picks stay in history; use Undo to revert them.', 'block', 'id')]);
  for (const i of q) if (i.id === id || i.parentIntentId === id) if (i.status !== 'executed' && i.status !== 'compiled') i.status = 'removed';
  return ok(settleParents(q));
}
export function clearQueue(queue: readonly EditIntentT[]): EditIntentT[] {
  return queue.map((i) => (i.status === 'queued' || i.status === 'superseded' ? { ...i, status: 'removed' as const } : { ...i }));
}

/** Locked Keys: keys decided by deterministic picks (compiled or executed UI intents that are still current). */
export function lockedKeysFromQueue(queue: readonly EditIntentT[]): string[] {
  return [...new Set(queue.filter((i) => i.source === 'ui' && (i.status === 'compiled' || i.status === 'executed') && !i.needsInterpretation && !i.propertyKey.startsWith('group:') && !i.propertyKey.startsWith('list:'))
    .flatMap((i) => i.propertyKey.split('|')))];
}

/** Compile (§7): the operations for intents that need no interpretation. Children are compiled; parents are skipped. */
export function compileIntents(intents: readonly EditIntentT[], pickOf: (i: EditIntentT) => DesignPick, model: CompositionModelT): Result<OperationT[]> {
  const ops: OperationT[] = [];
  for (const i of intents) {
    if (i.propertyKey.startsWith('group:')) continue;
    if (i.needsInterpretation) return fail([issue('EM-2303', `Intent ${i.id} needs the Editor Agent.`, 'block', i.id)]);
    const b = opFor(pickOf(i), i.resolvedTargets[0], model);
    if (!b || !b.complete) return fail([issue('EM-2303', `Intent ${i.id} cannot be compiled.`, 'block', i.id)]);
    ops.push({ ...b.op, intentId: i.id });
  }
  return ok(ops);
}
/** Rebuilds the pick an intent came from (intents are persisted; picks are not). */
export function pickFromIntent(i: EditIntentT, extra: Partial<DesignPick> = {}): DesignPick {
  const p = { ...(i.params ?? {}) } as Record<string, unknown>; delete p['targetLabel'];
  const field = p['__field'] as TextField | undefined; const value = p['__value'];
  const output = p['__output'] as DesignPick['output'] | undefined;
  const text = p['__text'] as string | undefined; const assetId = p['__assetId'] as string | undefined; const playheadMs = p['__playheadMs'] as number | undefined;
  for (const k of Object.keys(p)) if (k.startsWith('__')) delete p[k];
  return { projectId: i.projectId, source: i.source, ...(i.presetId ? { presetId: i.presetId } : {}), ...(field ? { field, value } : {}), ...(output ? { output } : {}),
    ...(Object.keys(p).length ? { params: p } : {}), ...(text !== undefined ? { text } : {}), ...(assetId ? { assetId } : {}), ...(playheadMs !== undefined ? { playheadMs } : {}), ...extra };
}
