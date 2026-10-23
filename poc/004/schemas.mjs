// POC-004: Zod schemas transcribed from docs/AI_WORKFLOW.md §3 (the doc is the owner; this file is throwaway).
import { z } from 'zod';
export const ElementRef = z.object({ kind: z.enum(['sequence','clip','cut','text','caption','audio','shape','background','effect','project','selection','playhead']), id: z.string().optional(), index: z.number().int().optional() });
export const Operation = z.object({ op: z.string().regex(/^op:[a-z]+\.[a-zA-Z]+$/), target: ElementRef.optional(), args: z.record(z.string(), z.unknown()), intentId: z.string().optional() });
export const EditPlan = z.object({
  id: z.string().optional(), projectId: z.string().optional(), baseVersion: z.string(),
  goal: z.string().max(300),
  steps: z.array(z.object({ n: z.number().int().min(1), tool: z.string(), ops: z.array(Operation).default([]), args: z.record(z.string(), z.unknown()).default({}), expectedDiff: z.string().max(200), dependsOn: z.array(z.number().int()).default([]) })).max(40),
  risks: z.array(z.object({ code: z.string(), message: z.string(), severity: z.enum(['info','warn','block']) })).default([]),
  notes: z.string().max(1000).optional(),
}).strict();
