// Compact, model-readable signatures of every operation's args, generated from the Zod schemas of the closed vocabulary
// (AI_WORKFLOW §5) so the Editor Agent never has to guess argument names (QA 2026-10-26 #5). Sent in the Rewrite envelope as
// `capabilities.opArgs` and quoted in correction messages.
import { OPERATIONS, type OpName } from '@expertmotion/composition-model';
import type { z } from 'zod';

type AnyDef = { type: string; innerType?: z.ZodType; entries?: Record<string, string>; options?: z.ZodType[]; shape?: Record<string, z.ZodType>; element?: z.ZodType; values?: unknown[]; checks?: Array<{ _zod: { def: { check: string; format?: string; pattern?: RegExp; value?: unknown; inclusive?: boolean } } }> };
const defOf = (s: z.ZodType): AnyDef => (s as unknown as { def: AnyDef }).def;

function range(d: AnyDef): string {
  let lo: unknown, hi: unknown, int = false;
  for (const c of d.checks ?? []) {
    const k = c._zod.def;
    if (k.check === 'number_format') int = true;
    if (k.check === 'greater_than') lo = (c as unknown as { _zod: { def: { value: unknown } } })._zod.def.value;
    if (k.check === 'less_than') hi = (c as unknown as { _zod: { def: { value: unknown } } })._zod.def.value;
  }
  const base = int ? 'int' : 'number';
  return lo !== undefined || hi !== undefined ? `${base} ${lo ?? ''}..${hi ?? ''}` : base;
}
/** One schema as a short type string ("int 0..", "'cover'|'contain'", "preset:*", "{x, y}"). */
export function describeSchema(s: z.ZodType, depth = 0): string {
  const d = defOf(s);
  switch (d.type) {
    case 'optional': case 'default': case 'nullable': return describeSchema(d.innerType!, depth);
    case 'number': return range(d);
    case 'boolean': return 'boolean';
    case 'string': {
      const re = d.checks?.map((c) => c._zod.def).find((k) => k.format === 'regex')?.pattern;
      if (re && String(re).includes('preset:')) return 'preset id';
      if (re && String(re).includes('#')) return '#RRGGBB';
      return 'string';
    }
    case 'enum': return Object.values(d.entries ?? {}).map((v) => `'${v}'`).join('|');
    case 'literal': return (d.values ?? []).map((v) => JSON.stringify(v)).join('|');
    case 'union': return (d.options ?? []).map((o) => describeSchema(o, depth)).join(' or ');
    case 'array': return `${describeSchema(d.element!, depth + 1)}[]`;
    case 'record': return 'object';
    case 'object': return depth > 1 ? 'object' : `{${Object.entries(d.shape ?? {}).map(([k, v]) => `${k}${optional(v) ? '?' : ''}`).join(', ')}}`;
    default: return d.type;
  }
}
const optional = (s: z.ZodType) => { const t = defOf(s).type; return t === 'optional' || t === 'default'; };

/** `op:text.add` → "{text: string, variant: preset id, atMs: int 0.., durationMs: int 100.., position?: …} target: none". */
export function opSignature(name: OpName): string {
  const def = OPERATIONS[name];
  const shape = (defOf(def.args).shape ?? {}) as Record<string, z.ZodType>;
  const args = Object.entries(shape).map(([k, v]) => `${k}${optional(v) ? '?' : ''}: ${describeSchema(v)}`).join(', ');
  return `{${args}} target: ${def.targets ? def.targets.join('|') : 'none'}`;
}
let cache: Record<string, string> | null = null;
export function opArgsTable(): Record<string, string> {
  return (cache ??= Object.fromEntries((Object.keys(OPERATIONS) as OpName[]).map((n) => [n, opSignature(n)])));
}
