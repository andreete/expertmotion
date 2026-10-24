// Request/response DTO fragments of API_SPECIFICATION §3 used by the S3 modules (providers, agents, usage, settings, hardware, licence).
import { z } from 'zod';
import { EmError, ULID_RE } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';

export const Id = z.string().regex(ULID_RE, 'expected an id');
export const Agent = z.enum(['brainstorm', 'editor']);
export type AgentT = z.infer<typeof Agent>;
export const ProviderKind = z.enum(['openrouter', 'openai', 'anthropic', 'google', 'custom']);
export type ProviderKindT = z.infer<typeof ProviderKind>;

/** Capability Table row (FR-114): capability facts are tri-state, `null` = the provider did not report it (shown as unknown, never guessed). */
export const CapabilityRow = z.object({ modelId: z.string(), label: z.string(), contextLength: z.number().int().nullable(), toolCalling: z.boolean().nullable(), structuredOutput: z.boolean().nullable(),
  streaming: z.boolean().nullable(), imageInput: z.boolean().nullable(), pricePerMInput: z.number().nullable(), pricePerMOutput: z.number().nullable() });
export type CapabilityRowT = z.infer<typeof CapabilityRow>;

export const AssignmentSettings = z.object({ temperature: z.number().min(0).max(2).optional(), maxTokens: z.number().int().min(64).max(64_000).optional(), effort: z.enum(['low', 'medium', 'high']).optional() }).strict();
export const AssignmentDto = z.object({ agent: Agent, connectionId: Id, modelId: z.string().min(1).max(200), settings: AssignmentSettings.default({}) });
export type AssignmentDtoT = z.infer<typeof AssignmentDto>;

export const ProjectParams = z.object({ id: Id });

/** Data envelope of every SSE payload: `at` and, when project-scoped, `projectId` (API_SPECIFICATION §7.2). */
export function emit(ctx: ServiceContext, name: string, data: Record<string, unknown>): void { ctx.bus.emit(name, { at: ctx.now(), ...data }); }

export function audit(ctx: ServiceContext, event: string, details: Record<string, unknown> = {}, projectId: string | null = null): void {
  try { ctx.db.prepare('INSERT INTO audit_log(at, event, project_id, details_json) VALUES (?,?,?,?)').run(ctx.now(), event, projectId, JSON.stringify(details)); } catch (e) { ctx.log.warn({ event, err: String(e) }, 'audit write failed'); }
}

export function requireProject(ctx: ServiceContext, projectId: string): { id: string; language: 'id' | 'en'; name: string } {
  const row = ctx.db.prepare('SELECT id, language, name FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId) as { id: string; language: 'id' | 'en'; name: string } | undefined;
  if (!row) throw new EmError('EM-6101', 'This project no longer exists.');
  return row;
}

export const monthOf = (iso: string): string => iso.slice(0, 7);
export const MonthQuery = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
