// Blank project on launch (FR-260; Operator 2026-10-29: "langsung membuka proyek baru yang kosong seperti editor video lain").
// A launch (and closing the open project) lands in an EMPTY project, never on the Start screen and never in the last project.
// That blank project is a "scratch" project: it is created once and remembered here; while it is untouched (no Composition
// change, no asset, no chat message, not renamed) it
//   • is reused by the next launch instead of creating another "Tanpa judul" (an untouched project never piles up),
//   • is hidden from Recent projects / File ▸ Open recent / the "Terakhir dibuka" row,
//   • is deleted (permanently) when the Creator switches to another project.
// The first real edit promotes it to an ordinary project (the record is dropped; it then shows up in Recent like any other).
// Window-local state in localStorage; every access is guarded (storage may be blocked → a new blank project per launch).
import type { ProjectDto } from '../api/types.js';

export const SCRATCH_KEY = 'expertmotion.scratch.v1';
export interface ScratchRecord { projectId: string; headHash: string | null; name: string; createdAt: number }

const store = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function loadScratch(): ScratchRecord | null {
  try {
    const raw = JSON.parse(store()?.getItem(SCRATCH_KEY) ?? 'null') as Partial<ScratchRecord> | null;
    if (!raw || typeof raw.projectId !== 'string' || typeof raw.name !== 'string') return null;
    return { projectId: raw.projectId, headHash: typeof raw.headHash === 'string' ? raw.headHash : null, name: raw.name, createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0 };
  } catch { return null; }
}
export function saveScratch(p: Pick<ProjectDto, 'id' | 'headHash' | 'name'>, now = Date.now()): void {
  try { store()?.setItem(SCRATCH_KEY, JSON.stringify({ projectId: p.id, headHash: p.headHash ?? null, name: p.name, createdAt: now } satisfies ScratchRecord)); } catch { /* storage blocked */ }
}
export function clearScratch(): void { try { store()?.removeItem(SCRATCH_KEY); } catch { /* storage blocked */ } }
export function isScratchId(id: string | null | undefined): boolean { return !!id && loadScratch()?.projectId === id; }

/** True while the project is exactly as it was created (cheap check on the project row; messages are checked by the caller). */
export function isUntouched(p: Pick<ProjectDto, 'id' | 'headHash' | 'name' | 'assetCount' | 'durationMs'>, s: ScratchRecord | null = loadScratch()): boolean {
  // durationMs is not compared: an empty project may report a default length (the head hash says whether anything changed)
  return !!s && p.id === s.projectId && (p.headHash ?? null) === s.headHash && p.name === s.name && p.assetCount === 0;
}
/** Recent / Open lists without the untouched blank project (it is not something the Creator made). */
export function withoutScratch<T extends Pick<ProjectDto, 'id'> & Partial<Pick<ProjectDto, 'headHash' | 'name' | 'assetCount' | 'durationMs'>>>(items: readonly T[]): T[] {
  const s = loadScratch();
  if (!s) return [...items];
  return items.filter((p) => p.id !== s.projectId || (p.headHash !== undefined && p.assetCount !== undefined && p.name !== undefined && p.durationMs !== undefined && !isUntouched(p as Pick<ProjectDto, 'id' | 'headHash' | 'name' | 'assetCount' | 'durationMs'>, s)));
}
/**
 * Called on every state change of the open project: the first edit (another head, an asset, a chat message, a rename) makes the
 * blank project an ordinary one. Returns true when it promoted.
 */
export function promoteIfTouched(open: { id: string; name: string; headHash: string | null; assets: number; messages: number } | null): boolean {
  const s = loadScratch();
  if (!s || !open || open.id !== s.projectId) return false;
  if (open.headHash === s.headHash && open.assets === 0 && open.messages === 0 && open.name === s.name) return false;
  clearScratch();
  return true;
}
