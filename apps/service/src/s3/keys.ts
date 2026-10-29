// FR-191 (QA 2026-10-26 #3): provider keys as pasted. Keys never contain whitespace, so every space, tab, CR/LF (anywhere, not
// only at the ends), no-break space and zero-width / BOM character is removed before a key is validated or stored.
import type { ServiceContext } from '../context.js';

const INVISIBLE = /[\s ​-‍⁠﻿]/g;
export const normalizeKey = (s: string): string => s.replace(INVISIBLE, '');

/** A key counts as new for 5 minutes after it was added or replaced: providers can take a short while to activate new keys. */
export const NEW_KEY_WINDOW_MS = 5 * 60_000;
const changedAt = new WeakMap<ServiceContext, Map<string, number>>();
export function markKeyChanged(ctx: ServiceContext, connectionId: string): void {
  let m = changedAt.get(ctx); if (!m) { m = new Map(); changedAt.set(ctx, m); }
  m.set(connectionId, Date.now());
}
export function keyIsRecent(ctx: ServiceContext, connectionId: string | null | undefined): boolean {
  if (!connectionId) return false;
  const t = changedAt.get(ctx)?.get(connectionId);
  if (t !== undefined) return Date.now() - t < NEW_KEY_WINDOW_MS;
  const r = ctx.db.prepare('SELECT created_at FROM provider_connections WHERE id = ?').get(connectionId) as { created_at: string } | undefined;
  return !!r && Date.now() - Date.parse(r.created_at) < NEW_KEY_WINDOW_MS;
}
/** QA P1 2026-10-29: the EM-4002 text. The provider's own reason ("invalid x-api-key") is always named; the "new keys can take
 *  1–2 minutes" hint only for a key added / replaced in the last 5 minutes AND only next to that reason, never on its own. */
export function keyRefusedMessage(provider: string, reason: string | undefined, recentKey: boolean): string {
  const r = (reason ?? '').trim();
  return `${provider} says this key is not valid${r ? `: "${r}"` : ''}. Check that it was copied completely and is still active.${recentKey && r ? ' New keys can take 1–2 minutes to become active.' : ''}`;
}
