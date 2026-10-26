// QA 2026-10-26 #3: pasted provider keys and newly created keys.
// normalizeKey: a key never contains whitespace, so every space, tab, CR/LF (anywhere, not only at the ends), no-break space
// and zero-width / BOM character a copy from a web page or a chat can carry is removed before the key is sent.
// keyRetryDelay: a brand-new key can be refused (EM-4002) for a minute or two while the provider activates it; such a refusal
// is retried automatically after ~20 s, at most 3 times (the Creator can always press "Coba lagi" at once).
const INVISIBLE = /[\s ​-‍⁠﻿]+/g;
export const normalizeKey = (s: string): string => s.replace(INVISIBLE, '');

export const KEY_RETRY_MS = 20_000;
export const KEY_RETRY_MAX = 3;
/** Milliseconds until the next automatic retry, or null when none should happen. `attempts` = automatic retries already made. */
export function keyRetryDelay(attempts: number, code: string | null | undefined, recentKey: boolean | undefined): number | null {
  if (code !== 'EM-4002' || recentKey !== true) return null;
  return attempts < KEY_RETRY_MAX ? KEY_RETRY_MS : null;
}
/** True when the error details say the key was pasted / saved / replaced within the last 5 minutes. */
export const isRecentKey = (details: unknown): boolean => !!details && typeof details === 'object' && (details as { recentKey?: unknown }).recentKey === true;
