// ADR-031 / FR-192…FR-194 / IX-29 / IX-30: manual Delete and Duplicate of Timeline items, as ONE deterministic `itemsEdit` pick
// (Compile path, no LLM; one Composition Version, so Ctrl+Z restores everything at once). The same path as drag / trim / split:
// actions.itemsEdit → R-060 → Intent Queue → Compile → Execute. Pure helpers (tested without the DOM) plus the runners the
// Delete key, the context menu and the inspector share.
import { CLIPBOARD_MAX_ENTRIES, COPYABLE_KINDS, DUPLICABLE_KINDS, ITEM_KINDS, copySnapshot, type CompositionModelT, type ElementRefT, type ItemKind } from '@expertmotion/composition-model';
import { timelineClipboard } from './clipboard.js';
import type { IntentCategory, ItemsEdit } from '../api/types.js';

export type ItemRef = ItemsEdit['items'][number];
const KINDS = new Set<string>(ITEM_KINDS);

/** The selection as item refs (clips incl. scene clips, texts, images, shapes, audio, transitions, effects, the background, caption pages). */
export function itemRefs(selection: readonly ElementRefT[]): ItemRef[] {
  const out: ItemRef[] = [];
  for (const s of selection) {
    if (!KINDS.has(s.kind)) continue;
    const kind = s.kind as ItemKind;
    const r: ItemRef = { kind, ...(s.id !== undefined ? { id: s.id } : {}), ...(s.index !== undefined ? { index: s.index } : {}) };
    if ((kind === 'cut' || kind === 'caption') && r.index === undefined) continue;
    if (kind !== 'cut' && kind !== 'caption' && kind !== 'background' && !r.id) continue;
    if (!out.some((x) => x.kind === r.kind && x.id === r.id && x.index === r.index)) out.push(r);
  }
  return out;
}
/** The part of the selection Duplicate can copy (clips, scene clips, texts, images, shapes). */
export const duplicableRefs = (selection: readonly ElementRefT[]): ItemRef[] => itemRefs(selection).filter((r) => DUPLICABLE_KINDS.has(r.kind));

const CATEGORY: Partial<Record<ItemKind, IntentCategory>> = { text: 'text', shape: 'shape', audio: 'audio', cut: 'transition', effect: 'effect', background: 'background', caption: 'caption' };
/** Intent category of an items pick: the kind's category when all items share it, else asset. */
export function itemsCategory(items: readonly ItemRef[]): IntentCategory {
  const cats = [...new Set(items.map((x) => CATEGORY[x.kind] ?? 'asset'))];
  return cats.length === 1 ? cats[0]! : 'asset';
}
/** True when the selection still names something in the model (used to drop stale chips and selections). */
export function refExists(model: CompositionModelT | null | undefined, r: { kind: string; id?: string | undefined; index?: number | undefined }): boolean {
  if (!model) return false;
  switch (r.kind) {
    case 'clip': return model.tracks.video.some((c) => c.id === r.id);
    case 'text': return model.tracks.text.some((x) => x.id === r.id);
    case 'image': case 'shape': return model.tracks.overlay.some((o) => o.kind === r.kind && o.id === r.id);
    case 'audio': return model.tracks.audio.some((a) => a.id === r.id);
    case 'cut': return r.index !== undefined && r.index < Math.max(0, model.tracks.video.length - 1);
    case 'caption': return r.index !== undefined && r.index < model.tracks.caption.pages.length;
    default: return true;
  }
}

type Toast = (kind: 'info', key: string, vars?: Record<string, string | number>) => void;
type T = (k: string, v?: Record<string, string | number>) => string;
/** Delete key, context menu "Delete", inspector Delete: one pick for every deletable selected item; nothing selected → nothing sent. */
export function runDelete(o: { selection: readonly ElementRefT[]; itemsEdit: (edit: ItemsEdit, label: string) => Promise<boolean>; toast: Toast; t: T }): boolean {
  const items = itemRefs(o.selection);
  if (!items.length) { if (o.selection.length) o.toast('info', 'ui.stage.timeline.delete.nothing'); return false; }
  void o.itemsEdit({ action: 'remove', items }, o.t('ui.stage.timeline.delete.done', { count: items.length }));
  return true;
}
/** Context menu "Duplicate": one pick for every duplicable selected item (audio, captions, transitions and effects are skipped). */
export function runDuplicate(o: { selection: readonly ElementRefT[]; itemsEdit: (edit: ItemsEdit, label: string) => Promise<boolean>; toast: Toast; t: T }): boolean {
  const items = duplicableRefs(o.selection);
  if (!items.length) { o.toast('info', 'ui.stage.itemmenu.duplicate.none'); return false; }
  void o.itemsEdit({ action: 'duplicate', items }, o.t('ui.stage.timeline.duplicate.done', { count: items.length }));
  return true;
}

// ───────────── FR-255 / FR-256: Copy, Cut, Paste (context menu and Ctrl+C / Ctrl+X / Ctrl+V) ─────────────
/** The part of the selection Copy / Cut can put on the clipboard (clips, scene clips, texts, images, shapes, audio voice / sfx). */
export const copyableRefs = (selection: readonly ElementRefT[]): ItemRef[] => itemRefs(selection).filter((r) => COPYABLE_KINDS.has(r.kind));
/** Copy: snapshots of the selection onto the in-app clipboard (no Composition change, no version). */
export function runCopy(o: { model: CompositionModelT | null | undefined; projectId?: string | null; selection: readonly ElementRefT[]; toast: Toast; cut?: boolean }): number {
  const refs = copyableRefs(o.selection);
  if (!o.model || !refs.length) { o.toast('info', 'ui.stage.itemmenu.copy.none'); return 0; }
  const { entries, skipped } = copySnapshot(o.model, refs);
  if (!entries.length) { o.toast('info', 'ui.stage.itemmenu.copy.none'); return 0; }
  timelineClipboard.set({ entries, projectId: o.projectId ?? null, copiedAt: Date.now(), cut: Boolean(o.cut) });
  if (!o.cut) o.toast('info', skipped || itemRefs(o.selection).length > refs.length ? 'ui.stage.itemmenu.copy.partial' : 'ui.stage.itemmenu.copy.done', { count: entries.length });
  return entries.length;
}
/** Cut: Copy, then the Delete pick for the copied items (one version, one Undo; the clipboard keeps the snapshots). */
export function runCut(o: { model: CompositionModelT | null | undefined; projectId?: string | null; selection: readonly ElementRefT[]; itemsEdit: (edit: ItemsEdit, label: string) => Promise<boolean>; toast: Toast; t: T }): boolean {
  // Review U7: Cut removes only what reaches the clipboard. Music beds are never copied (they stay on the timeline), and a selection
  // the clipboard cannot hold whole (CLIPBOARD_MAX_ENTRIES) is not cut at all — nothing disappears that Paste cannot bring back.
  const all = copyableRefs(o.selection);
  const items = o.model ? cutRefs(o.model, all) : [];
  if (!o.model || !items.length) { o.toast('info', 'ui.stage.itemmenu.copy.none'); return false; }
  if (copySnapshot(o.model, items).entries.length >= CLIPBOARD_MAX_ENTRIES) { o.toast('info', 'ui.stage.itemmenu.cut.toomany', { max: CLIPBOARD_MAX_ENTRIES }); return false; }
  const n = runCopy({ ...o, selection: items, cut: true });
  if (!n) return false;
  void o.itemsEdit({ action: 'remove', items }, o.t('ui.stage.itemmenu.cut.done', { count: items.length }));
  if (items.length < all.length) o.toast('info', 'ui.stage.itemmenu.cut.partial', { count: items.length });
  return true;
}
/** Review U7: the refs Cut may remove — the copyable ones whose snapshot goes onto the clipboard (music beds stay). */
export function cutRefs(model: CompositionModelT, refs: readonly ItemRef[]): ItemRef[] {
  return refs.filter((r) => !(r.kind === 'audio' && model.tracks.audio.find((a) => a.id === r.id)?.role === 'bed'));
}
/** Paste: the clipboard at the playhead as ONE pick (one version, one Undo). Empty clipboard → a hint, nothing sent. */
export function runPaste(o: { playheadMs: number; itemsEdit: (edit: ItemsEdit, label: string) => Promise<boolean>; toast: Toast; t: T }): boolean {
  const c = timelineClipboard.get();
  if (!c?.entries.length) { o.toast('info', 'ui.stage.itemmenu.paste.empty'); return false; }
  void o.itemsEdit({ action: 'paste', items: [], paste: { atMs: Math.max(0, Math.round(o.playheadMs)), entries: c.entries } }, o.t('ui.stage.itemmenu.paste.done', { count: c.entries.length }));
  return true;
}
