// LLM model tiers (Operator decision 2026-10-25, beginner audience): per agent the Creator picks "Fast", "Balanced" or "Best";
// each tier resolves deterministically to one model id of the connection's Capability Table. The resolved model id is stored
// as before (model_assignments.model_id), so nothing downstream changes. Pure: no I/O, no clock.
//
// Rules (docs/FRD.md FR-115):
//  1. Candidates are JSON-capable rows: `structuredOutput === true`. When the provider reports no row as true (OpenAI,
//     Anthropic and Gemini list endpoints report no capability facts), rows that are not known to fail (`!== false`) are used.
//  2. Rows that fit the agent (`recommendedFor`) are preferred when at least one candidate fits.
//  3. OpenRouter `:free` variants are dropped when a paid candidate exists (rate-limited, not suitable as a default).
//  4. Ranking: by price (input + output per million tokens) when every candidate has one, otherwise by a name hint
//     (nano/lite < mini/haiku/flash/small < other < pro/opus/ultra/large); ties by context length; then the provider's order.
//     Fast = lowest rank, Best = highest rank, Balanced = the middle of the ranked list.

export type ModelTier = 'fast' | 'balanced' | 'best';
export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'best'];
export type TierAgent = 'brainstorm' | 'editor';

/** The Capability Table fields the resolution reads (FR-114; tri-state facts, `null` = not reported). */
export interface TierCapabilityRow {
  modelId: string; label: string; contextLength: number | null; toolCalling: boolean | null; structuredOutput: boolean | null; imageInput: boolean | null;
  pricePerMInput: number | null; pricePerMOutput: number | null;
}

/** Deterministic "recommended for" hint from the Capability Table (unknown facts never qualify). */
export function recommendedFor(r: TierCapabilityRow): TierAgent[] {
  const ctxOk = r.contextLength === null || r.contextLength >= 32_000;
  const out: TierAgent[] = [];
  if (ctxOk && r.structuredOutput !== false && r.imageInput === true) out.push('brainstorm');
  if (ctxOk && r.structuredOutput === true && r.toolCalling === true) out.push('editor');
  return out;
}

/** JSON-capable candidates of a Capability Table for an agent (rules 1–3), in the provider's order. */
export function tierCandidates<R extends TierCapabilityRow>(rows: readonly R[], agent?: TierAgent): R[] {
  const known = rows.filter((r) => r.structuredOutput === true);
  let c = known.length ? known : rows.filter((r) => r.structuredOutput !== false);
  if (agent) { const fit = c.filter((r) => recommendedFor(r).includes(agent)); if (fit.length) c = fit; }
  const paid = c.filter((r) => !r.modelId.endsWith(':free'));
  return paid.length ? paid : c;
}

const price = (r: TierCapabilityRow): number | null => (r.pricePerMInput === null || r.pricePerMOutput === null ? null : r.pricePerMInput + r.pricePerMOutput);
/** Size hint from the model id/name, used only when prices are missing. */
export function nameHint(r: TierCapabilityRow): number {
  const s = `${r.modelId} ${r.label}`.toLowerCase();
  if (/\b(nano|lite|tiny)\b|-lite|-nano/.test(s)) return 0;
  if (/\b(mini|haiku|flash|small)\b|-mini|-haiku|-flash|-small/.test(s)) return 1;
  if (/\b(pro|opus|ultra|large)\b|-pro|-opus|-ultra|-large/.test(s)) return 3;
  return 2;
}

interface Ranked<R> { r: R; i: number; k: readonly [number, number] }
function ranked<R extends TierCapabilityRow>(candidates: readonly R[]): Ranked<R>[] {
  const priced = candidates.length > 0 && candidates.every((r) => price(r) !== null);
  return candidates.map((r, i) => ({ r, i, k: [priced ? price(r)! : nameHint(r), r.contextLength ?? 0] as const }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i);
}
/** The candidates ranked from cheapest/smallest to most capable/expensive (rule 4); equal keys keep the provider's order. */
export function rankForTiers<R extends TierCapabilityRow>(candidates: readonly R[]): R[] { return ranked(candidates).map((x) => x.r); }

/** Tier → model id for one agent; all null when the table has no JSON-capable model (or was never fetched). */
export function resolveModelTiers(rows: readonly TierCapabilityRow[], agent?: TierAgent): Record<ModelTier, string | null> {
  const list = ranked(tierCandidates(rows, agent));
  if (!list.length) return { fast: null, balanced: null, best: null };
  // Within a group of equal rank the provider's first row wins (most providers list newest first).
  const firstOf = (k: readonly [number, number]) => list.find((x) => x.k[0] === k[0] && x.k[1] === k[1])!.r.modelId;
  return { fast: firstOf(list[0]!.k), balanced: firstOf(list[Math.floor((list.length - 1) / 2)]!.k), best: firstOf(list[list.length - 1]!.k) };
}

/** The tier a stored model id corresponds to (first of balanced, fast, best when tiers share a model), or null (an Advanced pick). */
export function tierOfModel(rows: readonly TierCapabilityRow[], modelId: string | null | undefined, agent?: TierAgent): ModelTier | null {
  if (!modelId) return null;
  const t = resolveModelTiers(rows, agent);
  return (['balanced', 'fast', 'best'] as const).find((k) => t[k] === modelId) ?? null;
}
