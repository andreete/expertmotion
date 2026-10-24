// Schemas of docs/AI_WORKFLOW.md §3 (the owner). Operation and ElementRef come from composition-model (one definition).
import { z } from 'zod';
import { ElementRef, Operation } from '@expertmotion/composition-model';

export const PresetIdRe = /^preset:[a-z]+\.[a-z0-9-]+$/;
export const INTENT_CATEGORIES = ['transition', 'caption', 'background', 'motion', 'shape', 'easing', 'effect', 'audio', 'text', 'layout', 'output', 'asset', 'generate'] as const;
export type IntentCategory = (typeof INTENT_CATEGORIES)[number];
export const INTENT_STATUSES = ['queued', 'superseded', 'compiled', 'planned', 'executed', 'rejected', 'removed'] as const;

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

/** What the model is asked to return (SYSTEM_PROMPT.md P-2 output schema): the runtime fills id, projectId, origin, status. */
export const ModelPlanReply = z.object({
  goal: z.string().max(300),
  steps: z.array(z.object({ n: z.number().int().min(1), tool: z.literal('composition.applyOps'), ops: z.array(Operation), expectedDiff: z.string().max(200), dependsOn: z.array(z.number().int()).default([]) })).max(40),
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

/** Brainstorming Agent reply (AGENT_DESIGN §2.1 / SYSTEM_PROMPT P-1). Proposed intents carry only what the model may fill. */
export const BrainstormTurn = z.object({
  reply: z.string().max(4000),
  questions: z.array(z.string()).max(2).optional(),
  proposedIntents: z.array(z.object({
    category: z.enum(INTENT_CATEGORIES), presetId: z.string().regex(PresetIdRe).optional(), params: z.record(z.string(), z.unknown()).optional(),
    target: ElementRef.optional(), needsInterpretation: z.boolean(), instruction: z.string().max(2000).optional(), source: z.literal('brainstorm'),
  })).max(12).optional(),
  suggestedNextStep: z.enum(['send-to-editor', 'import-assets', 'none']).optional(),
});
