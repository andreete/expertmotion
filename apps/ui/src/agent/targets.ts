// QA 2026-10-26 #6 (pointing): the assets and Timeline elements the Creator points the assistant at. They show as chips in the
// composer ("@Klip 2", "@Reels 14.m4a") and travel with the next message as `targets` (ids + kind + friendly label), so the
// agents can resolve "ini / itu / klip ini". Pure helpers; the chips themselves live in AssistantChat / Chat.
import type { CompositionModelT, ElementRefT } from '@expertmotion/composition-model';
import type { AssetDto, ChatTarget, ChatTargetKind } from '../api/types.js';

export const MAX_TARGETS = 12;
const KINDS: readonly ChatTargetKind[] = ['asset', 'clip', 'text', 'image', 'shape', 'audio', 'cut'];
type T = (k: string, v?: Record<string, string | number>) => string;

export const targetKey = (x: Pick<ChatTarget, 'kind' | 'id' | 'index'>): string => `${x.kind}:${x.id ?? `#${x.index ?? ''}`}`;
const clip80 = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
/** The first words of a text layer (≤ 4 words, ≤ 28 characters). */
export function firstWords(text: string): string {
  const w = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
  return w.length > 28 ? `${w.slice(0, 27)}…` : w;
}

/** A friendly label for a Timeline element ("Klip 2", the text's first words, an asset name, "Potongan 1"); null when unknown. */
export function elementTarget(ref: ElementRefT, model: CompositionModelT | null | undefined, assets: readonly AssetDto[], t: T): ChatTarget | null {
  const kind = ref.kind as ChatTargetKind;
  if (!KINDS.includes(kind) || kind === 'asset') return null;
  const name = (assetId: string) => assets.find((a) => a.id === assetId)?.name;
  if (kind === 'cut') return ref.index === undefined ? null : { kind, index: ref.index, label: t('ui.agent.chat.target.cut', { n: ref.index + 1 }) };
  if (!ref.id) return null;
  let label: string | undefined;
  if (model) {
    if (kind === 'clip') { const i = model.tracks.video.findIndex((c) => c.id === ref.id); if (i >= 0) label = t(model.tracks.video[i]!.assetId === undefined ? 'ui.agent.chat.target.scene' : 'ui.agent.chat.target.clip', { n: i + 1 }); }   // ADR-030 scene clips: "Adegan N"
    if (kind === 'text') { const x = model.tracks.text.find((y) => y.id === ref.id); if (x) label = firstWords(x.text); }
    if (kind === 'image') { const o = model.tracks.overlay.find((y) => y.id === ref.id); if (o?.kind === 'image') label = name(o.assetId) ?? t('ui.agent.chat.target.image'); }
    if (kind === 'shape') { const i = model.tracks.overlay.filter((y) => y.kind === 'shape').findIndex((y) => y.id === ref.id); if (i >= 0) label = t('ui.agent.chat.target.shape', { n: i + 1 }); }
    if (kind === 'audio') { const a = model.tracks.audio.find((y) => y.id === ref.id); if (a) label = name(a.assetId) ?? t('ui.agent.chat.target.audio'); }
  }
  return label ? { kind, id: ref.id, label: clip80(label) } : null;
}
export const assetTarget = (a: Pick<AssetDto, 'id' | 'name'>): ChatTarget => ({ kind: 'asset', id: a.id, label: clip80(a.name || a.id) });

/** Explicit chips first, then the selection's chips (minus the dismissed ones); no duplicates; at most 12. */
export function mergeTargets(explicit: readonly ChatTarget[], fromSelection: readonly ChatTarget[], dismissed: ReadonlySet<string> = new Set()): ChatTarget[] {
  const seen = new Set<string>(); const out: ChatTarget[] = [];
  for (const x of [...explicit, ...fromSelection.filter((s) => !dismissed.has(targetKey(s)))]) {
    const k = targetKey(x); if (seen.has(k)) continue; seen.add(k); out.push(x);
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}
export const selectionTargets = (selection: readonly ElementRefT[], model: CompositionModelT | null | undefined, assets: readonly AssetDto[], t: T): ChatTarget[] =>
  selection.flatMap((r) => { const x = elementTarget(r, model, assets, t); return x ? [x] : []; });
