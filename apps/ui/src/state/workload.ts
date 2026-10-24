// Render queue view (FR-142): one active Render Job, the rest queued in creation order. Shared by the header chip
// (`sys.render.progress`, "1 rendering · 1 queued") and the Hardware Monitor workload list.
import type { RenderJobDto } from '../api/types.js';

export interface RenderQueueView { active: RenderJobDto | null; queued: RenderJobDto[]; size: number }

export function renderQueue(renders: readonly RenderJobDto[]): RenderQueueView {
  const active = renders.find((j) => j.status === 'rendering') ?? null;
  const queued = renders.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { active, queued, size: (active ? 1 : 0) + queued.length };
}
