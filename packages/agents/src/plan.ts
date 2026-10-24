// Step 8 (AI_WORKFLOW §2): deterministic validation of any Edit Plan (compiled or model-authored) before Execute is enabled.
import { applyOperations, conflictsWithLocked, hashModel, propertyKeysOf, validate, type ApplyContext, type AssetFacts, type CompositionModelT, type ElementDiff, type OperationT, type Tier } from '@expertmotion/composition-model';
import { issue, type Issue } from '@expertmotion/shared';
import { EditPlan, ModelPlanReply, type EditPlanT } from './schemas.js';

export interface PlanContext { model: CompositionModelT; baseVersion: string; assets: readonly AssetFacts[]; tier: Tier; lockedKeys: readonly string[]; newId: () => string; jobs?: ApplyContext['jobs'] }
export interface PlanValidation { plan: EditPlanT; issues: Issue[]; predicted?: { model: CompositionModelT; diff: ElementDiff[]; durationMs?: number } }
export const MAX_OPS = 200, MAX_STEPS = 40;

export const planOps = (plan: Pick<EditPlanT, 'steps'>): OperationT[] => plan.steps.flatMap((s) => s.ops);

/** Validates a plan; returns it with status valid | invalid | stale, the validation rows, touchesLockedKeys and the predicted diff. */
export function validatePlan(plan: EditPlanT, ctx: PlanContext): PlanValidation {
  const issues: Issue[] = [];
  const ops = planOps(plan);
  if (plan.baseVersion !== ctx.baseVersion) issues.push(issue('EM-2301', 'The composition changed after this plan was made; plan again.', 'block', 'baseVersion'));
  if (ops.length > MAX_OPS) issues.push(issue('EM-2304', `The plan has ${ops.length} operations; the limit is ${MAX_OPS}.`, 'block', 'steps'));
  if (plan.steps.length > MAX_STEPS) issues.push(issue('EM-2304', `The plan has ${plan.steps.length} steps; the limit is ${MAX_STEPS}.`, 'block', 'steps'));
  if (plan.steps.length === 0 && !plan.risks.some((r) => r.code === 'needs-input')) issues.push(issue('EM-4302', 'The plan is empty.', 'block', 'steps'));
  for (const s of plan.steps) if (s.tool !== 'composition.applyOps' && s.ops.length) issues.push(issue('EM-2303', `Step ${s.n}: operations must go through composition.applyOps.`, 'block', `steps[${s.n - 1}].tool`));
  const touched = conflictsWithLocked(ops.flatMap(propertyKeysOf), ctx.lockedKeys);
  if (touched.length) issues.push(issue('EM-2302', `The plan changes picks you made yourself: ${touched.join(', ')}.`, 'block', 'steps'));
  let predicted: PlanValidation['predicted'];
  if (!issues.some((i) => i.severity === 'block') && ops.length) {
    const r = applyOperations(ctx.model, ops, { assets: ctx.assets, tier: ctx.tier, newId: ctx.newId, ...(ctx.jobs ? { jobs: ctx.jobs } : {}) });
    if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: `steps.${i.path}` })));
    else {
      issues.push(...r.warnings);
      const after = validate(r.value.model, { assets: ctx.assets, tier: ctx.tier });
      const before = new Set(validate(ctx.model, { assets: ctx.assets, tier: ctx.tier }).map((i) => `${i.code}|${i.path}|${i.message}`));
      for (const i of after) if (!before.has(`${i.code}|${i.path}|${i.message}`)) issues.push(i);     // only problems the plan introduces
      predicted = { model: r.value.model, diff: r.value.diff };
    }
  }
  const blocking = issues.filter((i) => i.severity === 'block');
  const stale = blocking.some((i) => i.code === 'EM-2301');
  const out: EditPlanT = { ...plan, touchesLockedKeys: touched, status: stale ? 'stale' : blocking.length ? 'invalid' : 'valid', validation: issues.map((i) => ({ path: i.path, message: i.message, code: i.code })) };
  return { plan: out, issues, ...(predicted ? { predicted } : {}) };
}

/** Wraps compiled operations into an Edit Plan (origin compile) so the same Execute path applies (AI-004). */
export function buildCompilePlan(ops: OperationT[], opts: { id: string; projectId: string; baseVersion: string; goal: string; expectedDiff: string }): EditPlanT {
  return EditPlan.parse({ id: opts.id, projectId: opts.projectId, baseVersion: opts.baseVersion, origin: 'compile', goal: opts.goal.slice(0, 300),
    steps: [{ n: 1, tool: 'composition.applyOps', ops, expectedDiff: opts.expectedDiff.slice(0, 200) }], status: 'draft' });
}

/** Parses a model reply (string) into an Edit Plan or returns the problems to send back to the model. */
export function parseModelReply(text: string, meta: { id: string; projectId: string }): { plan?: EditPlanT; problem?: string } {
  const json = extractJson(text);
  if (json === undefined) return { problem: 'Your reply was not valid JSON. Reply with the EditPlan JSON object only.' };
  const r = ModelPlanReply.safeParse(json);
  if (!r.success) return { problem: `The JSON does not match the EditPlan schema: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}. Reply with corrected JSON only.` };
  return { plan: EditPlan.parse({ ...r.data, id: meta.id, projectId: meta.projectId, origin: 'editor-agent', status: 'draft' }) };
}
/** Accepts raw JSON, JSON inside a ```json fence, or the first balanced {...} object in the text. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidates = [t, fence?.[1]?.trim()];
  const first = t.indexOf('{');
  if (first >= 0) { let depth = 0, inStr = false, esc = false; for (let i = first; i < t.length; i++) { const c = t[i]!; if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; } if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { candidates.push(t.slice(first, i + 1)); break; } } }
  for (const c of candidates) { if (!c) continue; try { return JSON.parse(c); } catch { /* try next */ } }
  return undefined;
}
export { hashModel };
