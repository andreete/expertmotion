// Schemas of docs/AI_WORKFLOW.md §3 (the owner). Operation and ElementRef come from composition-model (one definition).
import { z } from 'zod';
import { ElementRef, Operation } from '@expertmotion/composition-model';

export const PresetIdRe = /^preset:[a-z]+\.[a-z0-9-]+$/;
export const INTENT_CATEGORIES = ['transition', 'caption', 'background', 'motion', 'shape', 'easing', 'effect', 'audio', 'text', 'layout', 'output', 'asset', 'generate'] as const;
export type IntentCategory = (typeof INTENT_CATEGORIES)[number];
/** `held` (FR-037): a pick whose preset needs a model that is not installed (EM-2104); it becomes `queued` when `model.installed` arrives. */
export const INTENT_STATUSES = ['queued', 'superseded', 'compiled', 'planned', 'executed', 'rejected', 'removed', 'held'] as const;

export const EditIntent = z.object({
  id: z.string(), projectId: z.string(),
  source: z.enum(['ui', 'brainstorm', 'chat', 'system']),
  createdAt: z.string().datetime(),
  category: z.enum(INTENT_CATEGORIES),
  presetId: z.string().regex(PresetIdRe).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  target: ElementRef,
  resolvedTargets: z.array(ElementRef).default([]),
  propertyKey: z.string(),
  parentIntentId: z.string().optional(),
  propertyClass: z.enum(['scalar', 'list', 'exclusive-group']),
  needsInterpretation: z.boolean(),
  instruction: z.string().max(2000).optional(),
  status: z.enum(INTENT_STATUSES),
  restoredAt: z.string().datetime().optional(),
  appliedVersion: z.number().int().min(1).optional(),   // ordinal of the Composition Version that applied it (Intent Queue grouping)
  appliedHash: z.string().optional(),                   // hash of that Composition Version (FR-085 "Applied directly" line shows it short)
  rejectionReason: z.string().optional(),
  supersedes: z.array(z.string()).default([]),
  baseVersion: z.string(),
});
export type EditIntentT = z.infer<typeof EditIntent>;

export const PlanStep = z.object({
  n: z.number().int().min(1), tool: z.string(), ops: z.array(Operation).default([]), args: z.record(z.string(), z.unknown()).default({}),
  expectedDiff: z.string().max(200), dependsOn: z.array(z.number().int()).default([]),
});
export const Risk = z.object({ code: z.string(), message: z.string(), severity: z.enum(['info', 'warn', 'block']) });
export const Usage = z.object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable(), approximate: z.boolean() });
export const EditPlan = z.object({
  id: z.string(), projectId: z.string(), baseVersion: z.string(),
  origin: z.enum(['compile', 'editor-agent']),
  goal: z.string().max(300),
  steps: z.array(PlanStep).max(40),            // §3 says min(1); a zero-step plan is allowed only as a needs-input reply (SYSTEM_PROMPT P-2 rule 6), checked in validatePlan
  touchesLockedKeys: z.array(z.string()).default([]),
  risks: z.array(Risk).default([]),
  notes: z.string().max(1000).optional(),
  status: z.enum(['draft', 'valid', 'invalid', 'stale', 'executing', 'executed', 'failed', 'cancelled']),
  validation: z.array(z.object({ path: z.string(), message: z.string(), code: z.string() })).default([]),
  usage: Usage.optional(),
});
export type EditPlanT = z.infer<typeof EditPlan>;

/**
 * Plan step tools (AI_WORKFLOW §8, ADR-030): composition changes go through `composition.applyOps`; generator steps ask the
 * Local Service to run a local model after Execute (`tts.generate` voice-over from a script, `captions.generate` captions from a
 * script, the voice-over or the Sequence audio). Generator steps carry `args`, never ops.
 */
export const PLAN_STEP_TOOLS = ['composition.applyOps', 'tts.generate', 'captions.generate'] as const;
export type PlanStepTool = (typeof PLAN_STEP_TOOLS)[number];
export const TtsStepArgs = z.object({ text: z.string().min(1).max(2000), atMs: z.number().int().min(0).optional(), voiceId: z.string().min(1).max(64).optional(), language: z.enum(['id', 'en']).optional(), speed: z.number().min(0.8).max(1.2).optional() }).strict();
export const CaptionsStepArgs = z.object({ source: z.enum(['script', 'voice', 'sequence']).default('script'), text: z.string().min(1).max(5000).optional(), atMs: z.number().int().min(0).optional(), durationMs: z.number().int().min(500).optional(),
  presetId: z.string().regex(PresetIdRe).optional(), language: z.enum(['id', 'en']).optional() }).strict();

/** What the model is asked to return (SYSTEM_PROMPT.md P-2 output schema): the runtime fills id, projectId, origin, status. */
export const ModelPlanReply = z.object({
  goal: z.string().max(300),
  steps: z.array(z.object({ n: z.number().int().min(1), tool: z.enum(PLAN_STEP_TOOLS), ops: z.array(Operation).default([]), args: z.record(z.string(), z.unknown()).default({}), expectedDiff: z.string().max(200), dependsOn: z.array(z.number().int()).default([]) })).max(40),
  risks: z.array(Risk).default([]),
  baseVersion: z.string(),
}).strict();
export type ModelPlanReplyT = z.infer<typeof ModelPlanReply>;

export const ExecutionResult = z.object({
  planId: z.string(), ok: z.boolean(), fromVersion: z.string(), toVersion: z.string().optional(), appliedOps: z.number().int(),
  diff: z.array(z.object({ elementId: z.string(), change: z.enum(['added', 'removed', 'modified']), fields: z.array(z.string()) })),
  error: z.object({ code: z.string().regex(/^EM-\d{4}$/), message: z.string(), step: z.number().int().optional(), path: z.string().optional() }).optional(),
  rollback: z.object({ performed: z.boolean(), toVersion: z.string() }).optional(),
  durationMs: z.number(),
});

/**
 * A change the Brainstorming Agent proposes (AGENT_DESIGN §2.1 / SYSTEM_PROMPT P-1): only what the model may fill. `params`
 * defaults to {} (QA 2026-10-27: Claude sent proposals without params; the stored message then crashed the chat on every open).
 */
export const ProposedIntent = z.object({
  category: z.enum(INTENT_CATEGORIES), presetId: z.string().regex(PresetIdRe).optional(), params: z.record(z.string(), z.unknown()).default({}),
  target: ElementRef.optional(), needsInterpretation: z.boolean(), instruction: z.string().max(2000).optional(), source: z.literal('brainstorm'),
});
export type ProposedIntentT = z.infer<typeof ProposedIntent>;
/** Brainstorming Agent reply (AGENT_DESIGN §2.1 / SYSTEM_PROMPT P-1). */
export const BrainstormTurn = z.object({
  reply: z.string().max(4000),
  questions: z.array(z.string()).max(2).optional(),
  proposedIntents: z.array(ProposedIntent).max(12).optional(),
  suggestedNextStep: z.enum(['send-to-editor', 'import-assets', 'none']).optional(),
});

/** Catalogue categories that are not Intent categories, mapped like the Compile table (AI_WORKFLOW §4). */
const CATEGORY_ALIASES: Record<string, IntentCategory> = { texteffect: 'text', font: 'text', palette: 'layout', fontpair: 'layout', scene: 'layout', image: 'asset', music: 'audio', voice: 'generate' };
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** An Intent category from a model's spelling (case, plural, catalogue category), else from the preset id, else null. */
export function intentCategoryOf(raw: unknown, presetId?: string): IntentCategory | null {
  const c = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s_-]+/g, '') : '';
  const direct = (INTENT_CATEGORIES as readonly string[]).find((x) => x === c || `${x}s` === c) ?? CATEGORY_ALIASES[c] ?? CATEGORY_ALIASES[c.replace(/s$/, '')];
  if (direct) return direct as IntentCategory;
  const fromPreset = presetId ? /^preset:([a-z]+)\./.exec(presetId)?.[1] : undefined;
  return fromPreset ? ((INTENT_CATEGORIES as readonly string[]).includes(fromPreset) ? fromPreset as IntentCategory : CATEGORY_ALIASES[fromPreset] ?? null) : null;
}
/**
 * QA 2026-10-27: proposed intents from any model answer (or a stored message) made schema-valid before they are stored or shown.
 * `params` becomes {} when missing or not an object; an invalid preset id is dropped (the proposal then needs interpretation);
 * an unknown target is dropped (the Service resolves it); a category is mapped from plural / catalogue spellings or the preset
 * id; items that are not objects, have no category, or carry nothing to do (no preset, instruction or params) are dropped.
 */
export function normalizeProposedIntents(raw: unknown, max = 12): ProposedIntentT[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedIntentT[] = [];
  for (const x of raw) {
    if (!plainObject(x) || out.length >= max) continue;
    const presetId = typeof x['presetId'] === 'string' && PresetIdRe.test(x['presetId'].trim()) ? x['presetId'].trim() : undefined;
    const category = intentCategoryOf(x['category'], presetId ?? (typeof x['presetId'] === 'string' ? x['presetId'] : undefined));
    if (!category) continue;
    const params = plainObject(x['params']) ? x['params'] : {};
    const instruction = typeof x['instruction'] === 'string' && x['instruction'].trim() ? x['instruction'].trim().slice(0, 2000) : undefined;
    if (!presetId && !instruction && !Object.keys(params).length) continue;
    const target = ElementRef.safeParse(x['target']);
    const v = ProposedIntent.safeParse({ category, ...(presetId ? { presetId } : {}), params, ...(target.success ? { target: target.data } : {}),
      needsInterpretation: typeof x['needsInterpretation'] === 'boolean' ? x['needsInterpretation'] || !presetId : !presetId, ...(instruction ? { instruction } : {}), source: 'brainstorm' });
    if (v.success) out.push(v.data);
  }
  return out;
}
