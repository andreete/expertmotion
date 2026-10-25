// Creator-facing names for models (Operator decisions 2026-10-25): Local Models show their product name (`displayName`, en/id)
// instead of the upstream name; LLM models show the provider's model label from the connection's Capability Table
// (e.g. "Anthropic: Claude Haiku 5.5"), never a tier name; the raw model id only when the table has no row for it.
import type { CapabilityRow, DisplayNameDto, ModelStateDto } from '../api/types.js';
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

/** Display name of an LLM model id on a connection: the provider's label, else the id ('' when none). */
export function llmModelName(rows: readonly CapabilityRow[], modelId: string | null | undefined): string {
  if (!modelId) return '';
  return rows.find((x) => x.modelId === modelId)?.label || modelId;
}
