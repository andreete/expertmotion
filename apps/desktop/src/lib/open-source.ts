/**
 * R1 (FR-216, SEC-140, SEC-031): research citations and picture source pages open in the system browser through their own IPC
 * route `openSource`, separate from `openExternal` (storefront host only). Rules: a public `https:` URL (http is upgraded, like
 * the research fetch), no credentials, the standard port, a DNS host name (no IP literal, no localhost / .local / .internal /
 * .lan / .home.arpa), ≤ 2048 characters. Private Mode refuses (EM-8202) — main reads it from the Local Service and fails
 * closed. Pure module: no `electron` import (unit-tested on Linux).
 */
import { z } from 'zod';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Why `raw` may not be opened as a source page, or null. */
export function sourceUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a URL'; }
  if (u.protocol !== 'https:') return 'only https:// pages can be opened';
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  if (u.port && u.port !== '443') return 'only the standard https port is allowed';
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return 'a local host name is not allowed';
  if (IPV4.test(h) || h.startsWith('[') || h.includes(':')) return 'an IP address is not allowed';
  if (!h.includes('.')) return 'a full host name is required';
  return null;
}
const upgrade = (s: string): string => (/^http:\/\//i.test(s) ? `https://${s.slice(7)}` : s);
/** The IPC argument: a bounded string that is a public https source URL once http:// is upgraded. */
export const OpenSourceArg = z.string().trim().min(1).max(2048).transform(upgrade).refine((s) => sourceUrlProblem(s) === null, 'not a public https source');

export type OpenSourceResult = { ok: true } | { ok: false; code: 'EM-8202' | 'EM-8203'; message: string };
/** Indonesian refusal texts (the Editor shows its own i18n text by `code`; `message` is for logs and older Editors). */
export const OPEN_SOURCE_REFUSED = {
  private: 'Private Mode aktif, jadi tautan sumber tidak dibuka di browser. Salin alamatnya bila perlu.',
  invalid: 'Tautan ini tidak bisa dibuka: hanya halaman https publik yang diizinkan.',
} as const;

/** The decision for one `openSource` call: the URL to open, or the refusal. Private Mode is checked only for a valid URL. */
export async function decideOpenSource(raw: unknown, privateModeOn: () => Promise<boolean>): Promise<{ ok: true; url: string } | Extract<OpenSourceResult, { ok: false }>> {
  const p = OpenSourceArg.safeParse(raw);
  if (!p.success) return { ok: false, code: 'EM-8203', message: OPEN_SOURCE_REFUSED.invalid };
  if (await privateModeOn()) return { ok: false, code: 'EM-8202', message: OPEN_SOURCE_REFUSED.private };
  return { ok: true, url: new URL(p.data).href };
}
