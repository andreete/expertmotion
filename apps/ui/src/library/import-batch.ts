// FR-186: "Mengimpor 2/5…" in the Asset Panel header while a batch of files is being prepared. A batch is every asset seen
// ingesting since the panel last had none; it ends (and the line disappears) when nothing is ingesting any more.
import type { AssetDto } from '../api/types.js';

export interface ImportBatch { seen: ReadonlySet<string>; done: number; total: number }
export const emptyBatch: ImportBatch = { seen: new Set(), done: 0, total: 0 };

export function nextImportBatch(prev: ImportBatch, assets: readonly Pick<AssetDto, 'id' | 'status'>[]): ImportBatch {
  const ingesting = assets.filter((a) => a.status === 'ingesting');
  if (ingesting.length === 0) return emptyBatch;
  const present = new Set(assets.map((a) => a.id));
  const seen = new Set([...prev.seen].filter((id) => present.has(id)));     // a removed card leaves the batch
  for (const a of ingesting) seen.add(a.id);
  return { seen, done: seen.size - ingesting.length, total: seen.size };
}
