// Step 8 (AI_WORKFLOW §2): deterministic validation of any Edit Plan (compiled or model-authored) before Execute is enabled.
import { applyOperations, conflictsWithLocked, diffModels, deriveTiming, hashModel, propertyKeysOf, validate, type ApplyContext, type AssetFacts, type CompositionModelT, type ElementDiff, type OperationT, type Tier } from '@expertmotion/composition-model';
import { balancedObjects, issue, parseLooseJson, stripReasoning, type Issue } from '@expertmotion/shared';
import { CaptionsStepArgs, CoverStepArgs, EditPlan, ModelPlanReply, MusicStepArgs, PLAN_STEP_TOOLS, TtsStepArgs, type EditPlanT } from './schemas.js';
import { normalizeModelReply } from './plan-normalize.js';
import { scriptPages } from './script-captions.js';
import { expandSceneCompose, qualityGatePlan } from './auto-motion-plan.js';
import type { FootageAnalysisLike, SfxAssets } from './reels-types.js';

/** A local model a generator plan step needs (ADR-030): its Model Manager key, display label and whether it is installed. */
export interface ToolModel { installed: boolean; modelKey: string; label: string }
export interface PlanContext { model: CompositionModelT; baseVersion: string; assets: readonly AssetFacts[]; tier: Tier; lockedKeys: readonly string[]; newId: () => string; jobs?: ApplyContext['jobs'];
  /** ADR-030: models behind generator steps (voice: tts, transcription: stt); absent = not checked (tests, compile path). */
  toolModels?: { tts?: ToolModel | null; stt?: ToolModel | null }; language?: 'id' | 'en';
  /** ADR-039: the project's latest footage analysis and the SFX asset ids (`hooks.sfxAssets`), read by the talking-head composer. */
  footageAnalysis?: FootageAnalysisLike; sfxAssets?: SfxAssets }
export interface PlanValidation { plan: EditPlanT; issues: Issue[]; predicted?: { model: CompositionModelT; diff: ElementDiff[]; durationMs?: number } }
export const MAX_OPS = 200, MAX_STEPS = 40;

export const planOps = (plan: Pick<EditPlanT, 'steps'>): OperationT[] => plan.steps.flatMap((s) => s.ops);

export const DEFAULT_CAPTION_STYLE = 'preset:caption.editorial';
const RUNTIME_ARGS = ['status', 'modelKey', 'modelLabel'];
const stripRuntime = (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([k]) => !RUNTIME_ARGS.includes(k)));

/**
 * ADR-030 generator steps, before the composition dry run: argument checks, model availability (a missing model makes the step
 * `needs-model` with a `model-missing` warn risk — the rest of the plan still runs), and captions from a script that need no model
 * become ordinary `op:caption.setPages` steps timed over the predicted video (or the window given). Captions that follow a voice-over
 * step stay a generator step: the Local Service times them over the voice once it exists — also when the voice model is still
 * missing (the voice step is then held, FR-252, and the captions wait with it).
 */
function prepareToolSteps(plan: EditPlanT, ctx: PlanContext): { plan: EditPlanT; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!plan.steps.some((s) => s.tool !== 'composition.applyOps')) return { plan, issues };
  const id = ctx.language !== 'en';
  const risks = [...plan.risks];
  const missing = (m: ToolModel, what: string) => {
    const message = id ? `${what} butuh model "${m.label}" yang belum terpasang. Pasang di Model Manager, lalu jalankan lagi; langkah lain tetap jalan.` : `${what} needs the "${m.label}" model, which is not installed. Install it in the Model Manager and run again; the other steps still run.`;
    if (!risks.some((r) => r.code === 'model-missing' && r.message === message)) risks.push({ code: 'model-missing', message, severity: 'warn' });
  };
  const tts = new Map<number, { text: string; ready: boolean }>();
  let steps = plan.steps.map((s, i) => {
    if (s.tool !== 'tts.generate') return s;
    const r = TtsStepArgs.safeParse(stripRuntime(s.args));
    if (!r.success) { const x = r.error.issues[0]!; issues.push(issue('EM-2102', `Step ${s.n} (tts.generate): ${[...x.path].join('.') || 'args'}: ${x.message}. Expected args {text (≤ 2000 characters, the script to speak), atMs?, voiceId?, language?, speed?}.`, 'block', `steps[${i}].args`)); return s; }
    const m = ctx.toolModels?.tts;
    const ready = !m || m.installed;
    if (m && !ready) missing(m, id ? 'Suara narasi' : 'The voice-over');
    tts.set(s.n, { text: r.data.text, ready });
    return { ...s, args: { ...r.data, status: ready ? 'ready' : 'needs-model', ...(m ? { modelKey: m.modelKey, modelLabel: m.label } : {}) } };
  });
  // Predicted video length from the composition steps alone (for script captions spread over the whole video).
  const compOps = steps.filter((s) => s.tool === 'composition.applyOps').flatMap((s) => s.ops);
  const pre = compOps.length ? applyOperations(ctx.model, compOps, { assets: ctx.assets, tier: ctx.tier, newId: () => 'dry', ...(ctx.jobs ? { jobs: ctx.jobs } : {}) }) : null;
  const predictedModel = pre?.ok ? pre.value.model : ctx.model;
  const videoMs = deriveTiming(predictedModel).durationMs;
  const styled = predictedModel.tracks.caption.styleId !== null;
  steps = steps.map((s, i) => {
    if (s.tool !== 'captions.generate') return s;
    const r = CaptionsStepArgs.safeParse(stripRuntime(s.args));
    if (!r.success) { const x = r.error.issues[0]!; issues.push(issue('EM-2102', `Step ${s.n} (captions.generate): ${[...x.path].join('.') || 'args'}: ${x.message}. Expected args {source: 'script'|'voice'|'sequence', text? (the script), atMs?, durationMs?, presetId? (caption style), language?}.`, 'block', `steps[${i}].args`)); return s; }
    const a = r.data;
    if (a.source === 'sequence') {
      const m = ctx.toolModels?.stt;
      if (m && !m.installed) missing(m, id ? 'Teks dari suara di video' : 'Captions from the video audio');
      return { ...s, args: { ...a, status: !m || m.installed ? 'ready' : 'needs-model', ...(m ? { modelKey: m.modelKey, modelLabel: m.label } : {}) } };
    }
    const voice = [...s.dependsOn, ...(a.source === 'voice' ? [...tts.keys()] : [])].map((n) => tts.get(n)).find(Boolean);
    // ADR-035 voice-first re-validation (ADR-041 E2E run 9): the tts steps were already made and removed from the plan, so no
    // voice step is left to attach to — a {source: 'voice'} step stays a generator step and the Service times its pages over
    // the voice layers of the committed model (one page group per voice). Baking script pages over the whole video here spread the
    // first narration line across 37 s.
    if (a.source === 'voice' && !voice && !tts.size) return { ...s, args: { ...a, source: 'voice', status: 'ready' } };
    // No script and no voice-over: the on-screen texts this plan adds (scene titles / texts, in order) are the script —
    // what the model meant by "captions from the scene texts" (live QA 2026-10-26). Nothing to caption → the step is left out
    // with a warning instead of blocking the whole plan.
    const sceneText = compOps.flatMap((o) => { const x = o.args as Record<string, unknown>; return o.op === 'op:scene.add' ? [x['title'], x['text']] : o.op === 'op:text.add' ? [x['text']] : []; })
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0).join('\n').slice(0, 5000);
    const text = a.text ?? voice?.text ?? (sceneText || undefined);
    if (!text) {
      const message = id ? `Langkah ${s.n} (teks layar) dilewati: tidak ada naskah atau suara untuk dijadikan teks.` : `Step ${s.n} (captions) was left out: there is no script or voice-over to caption.`;
      risks.push({ code: 'step-dropped', message, severity: 'warn' });
      return null;
    }
    if (voice?.ready) return { ...s, args: { ...a, source: 'voice', text, status: 'ready' } };
    // Entry 35 (FR-252): a voice-over whose model is missing is HELD and continues after the install; captions for it stay a voice
    // step that waits with it, so they are timed over the real voice. (Script pages over the whole video, set now, never followed
    // the voice that came later: 40 s of captions over a 6 s voice in the QA run.)
    if (voice && !voice.ready) return { ...s, dependsOn: s.dependsOn.length ? s.dependsOn : [...tts.keys()].slice(0, 1), args: { ...a, source: 'voice', text, status: 'ready' } };
    // Script captions (no model needed): pages over the window, set now in the same Composition Version.
    const from = a.atMs ?? 0, to = a.durationMs !== undefined ? from + a.durationMs : videoMs;
    const pages = scriptPages(text, from, Math.min(to, videoMs));
    const style = a.presetId ?? (styled || compOps.some((o) => o.op === 'op:caption.setStyle') ? undefined : DEFAULT_CAPTION_STYLE);
    return { n: s.n, tool: 'composition.applyOps', args: {}, dependsOn: s.dependsOn, expectedDiff: s.expectedDiff || (id ? 'Teks layar dari naskah' : 'Captions from the script'),
      ops: [{ op: 'op:caption.setPages', target: { kind: 'project' as const }, args: { pages } }, ...(style ? [{ op: 'op:caption.setStyle', target: { kind: 'project' as const }, args: { presetId: style } }] : [])] };
  }).filter((s): s is EditPlanT['steps'][number] => s !== null);
  // FR-266: music.generate needs no local model (CC0 library download, verified); the Service picks the best-fit track.
  steps = steps.map((s, i) => {
    if (s.tool !== 'music.generate') return s;
    const r = MusicStepArgs.safeParse(stripRuntime(s.args));
    if (!r.success) { const x = r.error.issues[0]!; issues.push(issue('EM-2102', `Step ${s.n} (music.generate): ${[...x.path].join('.') || 'args'}: ${x.message}. Expected args {prompt (mood / style words, e.g. "tenang, akustik"), durationMs?, volume? (0.02–1, default 0.2), trackId?}.`, 'block', `steps[${i}].args`)); return s; }
    return { ...s, args: { ...r.data, durationMs: r.data.durationMs ?? Math.max(1000, videoMs), status: 'ready' } };
  });
  // ADR-039: cover.render needs no model (a still of the cover composition through POST /projects/:id/cover); the master must exist.
  steps = steps.map((s, i) => {
    if (s.tool !== 'cover.render') return s;
    const r = CoverStepArgs.safeParse(stripRuntime(s.args));
    if (!r.success) { const x = r.error.issues[0]!; issues.push(issue('EM-2102', `Step ${s.n} (cover.render): ${[...x.path].join('.') || 'args'}: ${x.message}. Expected args {spec: {cutId|atMs, hookWord, kicker?, line, subline?, pills?, icons?, source?, handle}, masterAssetId?}.`, 'block', `steps[${i}].args`)); return s; }
    const master = r.data.masterAssetId ?? ctx.footageAnalysis?.masterAssetId;
    if (master && !ctx.assets.some((a) => a.id === master && a.kind === 'video' && a.status === 'ready')) issues.push(issue('EM-1301', `Step ${s.n} (cover.render): the master asset ${master} is not in the project.`, 'block', `steps[${i}].args.masterAssetId`));
    return { ...s, args: { ...r.data, ...(master ? { masterAssetId: master } : {}), status: 'ready' } };
  });
  return { plan: { ...plan, steps, risks }, issues };
}

/** Validates a plan; returns it with status valid | invalid | stale, the validation rows, touchesLockedKeys and the predicted diff. */
export function validatePlan(input: EditPlanT, ctx: PlanContext): PlanValidation {
  // ADR-034: scene.compose steps become ordinary ops first (auto-motion-plan.ts), then generator steps are prepared.
  const expanded = expandSceneCompose(input, { model: ctx.model, assets: ctx.assets, tier: ctx.tier, lockedKeys: ctx.lockedKeys, ...(ctx.language ? { language: ctx.language } : {}), ...(ctx.footageAnalysis ? { footageAnalysis: ctx.footageAnalysis } : {}), ...(ctx.sfxAssets ? { sfxAssets: ctx.sfxAssets } : {}) });
  const prepared = prepareToolSteps(expanded.plan, ctx);
  let plan = prepared.plan;
  const issues: Issue[] = [...expanded.issues, ...prepared.issues];
  const ops = planOps(plan);
  if (plan.baseVersion !== ctx.baseVersion) issues.push(issue('EM-2301', 'The composition changed after this plan was made; plan again.', 'block', 'baseVersion'));
  if (ops.length > MAX_OPS) issues.push(issue('EM-2304', `The plan has ${ops.length} operations; the limit is ${MAX_OPS}.`, 'block', 'steps'));
  if (plan.steps.length > MAX_STEPS) issues.push(issue('EM-2304', `The plan has ${plan.steps.length} steps; the limit is ${MAX_STEPS}.`, 'block', 'steps'));
  if (plan.steps.length === 0 && !plan.risks.some((r) => r.code === 'needs-input')) issues.push(issue('EM-4302', 'The plan is empty.', 'block', 'steps'));
  plan.steps.forEach((s, i) => {
    if (!(PLAN_STEP_TOOLS as readonly string[]).includes(s.tool)) issues.push(issue('EM-2303', `Step ${s.n}: "${s.tool}" is not a plan tool; use composition.applyOps, scene.compose, tts.generate, captions.generate, music.generate or cover.render.`, 'block', `steps[${i}].tool`));
    else if (s.tool !== 'composition.applyOps' && s.ops.length) issues.push(issue('EM-2303', `Step ${s.n}: operations must go through composition.applyOps.`, 'block', `steps[${i}].tool`));
  });
  const touched = conflictsWithLocked(ops.flatMap(propertyKeysOf), ctx.lockedKeys);
  if (touched.length) issues.push(issue('EM-2302', `The plan changes picks you made yourself: ${touched.join(', ')}.`, 'block', 'steps'));
  let predicted: PlanValidation['predicted'];
  if (!issues.some((i) => i.severity === 'block') && ops.length) {
    const createdBy = new Map<string, number>();                                // C2: which op made which new element
    const r = applyOperations(ctx.model, ops, { assets: ctx.assets, tier: ctx.tier, newId: ctx.newId, ...(ctx.jobs ? { jobs: ctx.jobs } : {}), onNewId: (eid, i) => { createdBy.set(eid, i); } });
    if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: stepPath(plan, i.path) })));
    else {
      issues.push(...r.warnings);
      const after = validate(r.value.model, { assets: ctx.assets, tier: ctx.tier });
      const before = new Set(validate(ctx.model, { assets: ctx.assets, tier: ctx.tier }).map((i) => `${i.code}|${i.path}|${i.message}`));
      for (const i of after) if (!before.has(`${i.code}|${i.path}|${i.message}`)) issues.push(i);     // only problems the plan introduces
      predicted = { model: r.value.model, diff: r.value.diff };
      // ADR-034 quality gate: repairs what the plan made worse on screen (overlap, safe area, contrast, font) and lists the rest
      const g = qualityGatePlan(plan, ctx.model, r.value.model, { assets: ctx.assets, tier: ctx.tier, newId: ctx.newId, ...(ctx.jobs ? { jobs: ctx.jobs } : {}), ...(ctx.language ? { language: ctx.language } : {}), lockedKeys: ctx.lockedKeys, createdBy });
      plan = g.plan;
      if (g.predicted) predicted = { model: g.predicted, diff: diffModels(ctx.model, g.predicted) };
    }
  }
  const blocking = issues.filter((i) => i.severity === 'block');
  const stale = blocking.some((i) => i.code === 'EM-2301');
  const out: EditPlanT = { ...plan, touchesLockedKeys: touched, status: stale ? 'stale' : blocking.length ? 'invalid' : 'valid', validation: issues.map((i) => ({ path: i.path, message: i.message, code: i.code })) };
  return { plan: out, issues, ...(predicted ? { predicted } : {}) };
}

/** `ops[7].args.text` (flat over the plan) → `steps[1].ops[2].args.text`, so a correction names the step and op the model wrote. */
export function stepPath(plan: Pick<EditPlanT, 'steps'>, flat: string): string {
  const m = /^ops\[(\d+)\](.*)$/.exec(flat);
  if (!m) return `steps.${flat}`;
  let k = Number(m[1]);
  for (const [i, s] of plan.steps.entries()) { if (k < s.ops.length) return `steps[${i}].ops[${k}]${m[2]}`; k -= s.ops.length; }
  return `steps.${flat}`;
}

/** Wraps compiled operations into an Edit Plan (origin compile) so the same Execute path applies (AI-004). */
export function buildCompilePlan(ops: OperationT[], opts: { id: string; projectId: string; baseVersion: string; goal: string; expectedDiff: string }): EditPlanT {
  return EditPlan.parse({ id: opts.id, projectId: opts.projectId, baseVersion: opts.baseVersion, origin: 'compile', goal: opts.goal.slice(0, 300),
    steps: [{ n: 1, tool: 'composition.applyOps', ops, expectedDiff: opts.expectedDiff.slice(0, 200) }], status: 'draft' });
}

/**
 * Parses a model reply (string) into an Edit Plan or returns the problems to send back to the model. With `normalize`
 * (the Editor Agent run), unambiguous slips are repaired first (plan-normalize.ts) and `fixes` lists what was repaired;
 * `intents` is set when the model returned intents instead of a plan.
 */
export function parseModelReply(text: string, meta: { id: string; projectId: string }, normalize?: Parameters<typeof normalizeModelReply>[1], o: { truncated?: boolean } = {}): { plan?: EditPlanT; problem?: string; fixes?: string[]; intents?: unknown[]; noJson?: boolean } {
  let json = extractPlanJson(text);
  if (json === undefined) {
    // A reply cut off at the output limit (finish reason "length") is not "invalid JSON": ask for a shorter plan instead.
    if (o.truncated) return { noJson: false, problem: 'Your reply was cut off at the output limit before the JSON was complete. Reply again with a SHORTER EditPlan: no prose, no reasoning, short goal / expectedDiff texts, only the ops that are needed (op:scene.add carries title and text, so one op per scene is enough).' };
    return { noJson: !/[{[]/.test(stripReasoning(text)), problem: 'Your reply was not valid JSON. Reply with the EditPlan JSON object only: {"goal": "...", "steps": [{"n": 1, "tool": "composition.applyOps", "ops": [...], "expectedDiff": "..."}], "risks": []}.' };
  }
  let fixes: string[] = [];
  if (normalize) {
    const n = normalizeModelReply(json, normalize);
    fixes = n.fixes;
    if (n.intents) return { intents: n.intents, fixes };
    if (n.problem) return { problem: n.problem, fixes };
    json = n.value;
  }
  const r = ModelPlanReply.safeParse(json);
  if (!r.success) return { fixes, problem: `The JSON does not match the EditPlan schema: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}. Each op is {"op": "op:<entity>.<verb>", "target"?: {"kind", "id"?, "index"?}, "args": {...}} with the args listed in capabilities.opArgs. Reply with corrected JSON only.` };
  return { fixes, plan: EditPlan.parse({ ...r.data, id: meta.id, projectId: meta.projectId, origin: 'editor-agent', status: 'draft' }) };
}
/**
 * Accepts raw JSON, JSON inside a ```json fence, or the first balanced {...} object in the text; raw newlines inside strings
 * are repaired and double-encoded JSON is unwrapped (parseLooseJson, QA 2026-10-25 #16).
 */
export function extractJson(text: string): unknown {
  return parseLooseJson(text);
}
const PLAN_KEYS = ['steps', 'ops', 'operations', 'intents', 'proposedIntents', 'plan', 'editPlan', 'EditPlan'];
/**
 * extractJson for an Edit Plan reply: when the text holds several JSON objects (a model that "thinks aloud" with JSON examples,
 * or writes a tool call and the plan in one reply), the first object that looks like a plan wins; otherwise extractJson.
 */
export function extractPlanJson(text: string): unknown {
  const t = stripReasoning(text);
  const objs = balancedObjects(t);
  if (objs.length > 1) for (const o of objs) { const v = parseLooseJson(o); if (v && typeof v === 'object' && !Array.isArray(v) && PLAN_KEYS.some((k) => k in (v as object))) return v; }
  return parseLooseJson(t);
}
export { hashModel };
