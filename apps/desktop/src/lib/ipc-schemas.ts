/**
 * Zod schemas for every IPC handler argument (SECURITY.md SEC-030). The renderer is untrusted input: anything that fails to
 * parse is ignored by main (the handler returns its "nothing" value) — no partial or coerced options reach `dialog`/`shell`.
 * Pure module: no `electron` import (unit-tested on Linux).
 */
import { z } from 'zod';
import { UPDATE_ACTIONS } from './constants.js';

/** Bounded path string: no NUL, no URL scheme (paths only), ≤ 1024 chars (Windows long paths are not used by the Editor). */
export const IpcPath = z.string().min(1).max(1024).refine((p) => !p.includes('\0') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p), 'not a local path');

/** Dialog file filter: a short label and plain extensions (no dots, wildcards only as the single `*`). */
export const IpcFileFilter = z.object({
  name: z.string().max(256),
  extensions: z.array(z.string().regex(/^(\*|[A-Za-z0-9]{1,10})$/)).min(1).max(32),
}).strict();

export const PickFilesArgs = z.object({ filters: z.array(IpcFileFilter).max(16).optional(), multiple: z.boolean().optional() }).strict();
export const PickFolderArgs = z.object({ defaultPath: IpcPath.optional() }).strict();
export const PickSaveArgs = z.object({ defaultPath: IpcPath.optional(), filters: z.array(IpcFileFilter).max(16).optional() }).strict();
export const OpenUrlArg = z.string().min(1).max(2048);
export const UpdateActionArg = z.enum(UPDATE_ACTIONS);

/** Parses `raw` or returns null (the handler then does nothing). `undefined` options mean `{}`. */
export function parseIpc<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  const r = schema.safeParse(raw === undefined ? {} : raw);
  return r.success ? r.data : null;
}
