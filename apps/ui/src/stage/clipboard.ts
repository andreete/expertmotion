// FR-255 / FR-256: the Editor's in-app clipboard for Timeline items (never the operating system clipboard, so text fields keep
// their native Ctrl+C / Ctrl+V). It holds SNAPSHOTS taken at Copy / Cut time (packages/composition-model copySnapshot), so Paste
// works after Cut and after the originals changed. Lives for the session of the Editor window; one clipboard for every project.
import type { ClipboardEntry } from '@expertmotion/composition-model';

export interface ClipboardContent { entries: ClipboardEntry[]; projectId: string | null; copiedAt: number; cut: boolean }
let content: ClipboardContent | null = null;
const listeners = new Set<() => void>();
export const timelineClipboard = {
  get(): ClipboardContent | null { return content; },
  set(c: ClipboardContent | null): void { content = c && c.entries.length ? { ...c, entries: c.entries.map((e) => structuredClone(e)) } : null; for (const l of listeners) l(); },
  clear(): void { timelineClipboard.set(null); },
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
