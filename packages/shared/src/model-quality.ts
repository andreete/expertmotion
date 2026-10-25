// Model quality hint (Operator decision 2026-10-25): every model of a Capability Table may be assigned, none is refused or
// disabled, but a model that is likely to give poor results carries a warning so the Creator is nudged towards a stronger
// one. Pure and deterministic: reads only Capability Table facts and the model id/label (docs/FRD.md FR-115).
//
// Rules (reason codes, never prose; the UI maps them to en/id text):
//  - 'no-json'       structuredOutput === false: the agents need JSON (EditPlan / BrainstormTurn); level 'unsupported'.
//                    Unknown (null) is not flagged: OpenAI, Anthropic and Gemini list endpoints report no capability facts.
//  - 'small-name'    the id or label names a small variant: nano, tiny, lite, micro, mini (as a word or `-mini`, `flash-lite`, …).
//  - 'small-params'  the largest parameter count in the id/label is ≤ 9B (`8b`, `7b`, `3b`, `1.5b`, `360m`, `e4b`; MoE active
//                    counts such as `-a3b` are ignored, so `30b-a3b` counts as 30B).
//  - 'small-context' a reported context length below 32K tokens.
//  - 'small-family'  an open-weight family that only ships small models (SMALL_FAMILIES).
// Any of the last four → level 'weak'. Price plays no part: a free model is weak only by the same rules.
import type { TierAgent } from './model-tiers.js';

export type ModelQualityLevel = 'ok' | 'weak' | 'unsupported';
export type ModelQualityReason = 'no-json' | 'small-name' | 'small-params' | 'small-context' | 'small-family';
export interface ModelQuality { level: ModelQualityLevel; reasons: ModelQualityReason[] }
/** The Capability Table fields the assessment reads. */
export interface QualityCapabilityRow { modelId: string; label: string; contextLength: number | null; structuredOutput: boolean | null }

/** Context below this many tokens is flagged (AGENT_DESIGN §2.3: ≥ 32k recommended / required). */
export const MIN_GOOD_CONTEXT = 32_000;
/** Parameter counts at or below this many billions are flagged. */
export const MAX_SMALL_PARAMS_B = 9;
/** Name hints of a small variant. */
// `mini` / `lite` variants of mainstream models (GPT-4o mini, o4-mini, Gemini Flash-Lite) are capable enough: not flagged.
export const SMALL_NAME_HINT = /(^|[^a-z0-9])(nano|tiny|micro)(?![a-z])/;
/** Open-weight families that only ship small models (checked on the model part after `vendor/`). */
export const SMALL_FAMILIES = /(^|[^a-z0-9])(phi|smollm\d*|tinyllama|ministral|gemma-?3n)(?![a-z])/;

/** Largest parameter count (billions) named in the text, or null when none is named. */
export function parameterCountB(text: string): number | null {
  const s = text.toLowerCase();
  let max: number | null = null;
  // a separator (or start) before the number, optional `e` (effective, Gemma 3n "e4b"); `-a3b` (MoE active) is skipped
  // millions only with three digits (`135m`, `360m`), so a context suffix such as `-1m` is not read as a size
  for (const m of s.matchAll(/(?:^|[^a-z0-9.])e?(?:(\d+(?:\.\d+)?)b|(\d{3})m)(?![a-z0-9])/g)) {
    const n = m[1] !== undefined ? Number(m[1]) : Number(m[2]) / 1000;
    if (Number.isFinite(n) && n > 0) max = max === null ? n : Math.max(max, n);
  }
  return max;
}

/** Quality hint for one row; `agent` is accepted for symmetry with model-tiers (the rules are the same for both agents). */
export function assessModelQuality(row: QualityCapabilityRow, agent?: TierAgent): ModelQuality {
  void agent;
  const text = `${row.modelId} ${row.label}`.toLowerCase();
  const reasons: ModelQualityReason[] = [];
  if (row.structuredOutput === false) reasons.push('no-json');
  if (SMALL_NAME_HINT.test(text)) reasons.push('small-name');
  const b = parameterCountB(text);
  if (b !== null && b <= MAX_SMALL_PARAMS_B) reasons.push('small-params');
  if (row.contextLength !== null && row.contextLength > 0 && row.contextLength < MIN_GOOD_CONTEXT) reasons.push('small-context');
  if (SMALL_FAMILIES.test(text)) reasons.push('small-family');
  return { level: reasons.includes('no-json') ? 'unsupported' : reasons.length ? 'weak' : 'ok', reasons };
}
