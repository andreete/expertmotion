// Creator-facing names for models (Operator decision 2026-10-25): Local Models show their product name (`displayName`, en/id)
// instead of the upstream name; LLM assignments show the tier ("Fast" / "Balanced" / "Best") resolved from the connection's
// Capability Table (packages/shared model-tiers), else the provider's model label. Keys and model ids stay internal.
import { tierOfModel, type ModelTier } from '@expertmotion/shared';
import type { AgentKind, CapabilityRow, DisplayNameDto, ModelStateDto } from '../api/types.js';
import type { Lang } from '../i18n/index.js';

type Named = { label: string; displayName?: DisplayNameDto | undefined };
/** Product name of a Local Model in the UI language (older services without `displayName`: the label). */
export const localModelName = (m: Named, lang: Lang): string => m.displayName?.[lang] ?? m.label;

/** A Local Model named by key or by Catalogue flag (`model:whisper` / `whisper`): installed first, then recommended. */
export function localModelByRef(models: readonly ModelStateDto[], ref: string): ModelStateDto | undefined {
  const bare = ref.replace(/^model:/, '');
  const hits = models.filter((m) => m.key === bare || m.flag === `model:${bare}` || (!m.flag && m.key.startsWith(`${bare}-`)));
  return hits.find((m) => m.key === bare) ?? hits.find((m) => m.status === 'installed') ?? hits.find((m) => m.recommended) ?? hits[0];
}

/** Display name of an LLM model id on a connection: tier name when it is a tier's model, else the provider's label, else the id. */
export function llmModelName(t: (k: string, v?: Record<string, string | number>) => string, rows: readonly CapabilityRow[], modelId: string | null | undefined, agent?: AgentKind): string {
  if (!modelId) return '';
  const tier: ModelTier | null = tierOfModel(rows, modelId, agent);
  if (tier) return t(`ui.scr.providers.tier.${tier}`);
  const r = rows.find((x) => x.modelId === modelId);
  return r?.label || modelId;
}
