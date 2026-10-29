// Outbound links (Purchase FR-132, online docs FR-148): open in the system browser through the Shell, or, while Private Mode is on,
// show EM-8202 with the URL to copy instead (nothing leaves the computer from the app).
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { useStore } from '../state/store.js';
import { Button } from './ui.js';
import { copyText } from '../api/client.js';

/** True when the link may be opened now; false means "show the copyable URL" (Private Mode). */
export const canOpenExternal = (privateMode: boolean | undefined): boolean => !privateMode;
/** Outcome of opening a source link: opened, or refused with the EM code (EM-8202 Private Mode, EM-8203 not a public https page). */
export type OpenSourceOutcome = { ok: true } | { ok: false; code: string };
/**
 * FR-216 / R1: opens a research source in the system browser through the Shell's `openSource` route (any public https page;
 * http is upgraded). Private Mode refuses here first and again in the Shell. Development browsers get a new tab.
 */
export async function openSource(raw: string, privateMode: boolean | undefined): Promise<OpenSourceOutcome> {
  const url = /^http:\/\//i.test(raw) ? `https://${raw.slice(7)}` : raw;
  if (!/^https:\/\//i.test(url)) return { ok: false, code: 'EM-8203' };
  if (!canOpenExternal(privateMode)) return { ok: false, code: 'EM-8202' };
  const shell = typeof window !== 'undefined' ? window.expertmotion : undefined;
  if (shell?.openSource) { try { const r = await shell.openSource(url); return r.ok ? r : { ok: false, code: r.code }; } catch { return { ok: false, code: 'EM-8203' }; } }
  if (shell) return { ok: false, code: 'EM-8203' };   // an older Shell without the route: never fall back to the storefront-only openExternal
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
  return { ok: true };
}
/** @deprecated use `useOpenSource` (it honours Private Mode and shows the copyable address when refused). */
export function openExternal(url: string): void { void openSource(url, undefined); }
/** Source-link click handler: opens the page, or shows a toast with the refusal and a Copy button for the address. */
export function useOpenSource(): (url: string) => void {
  const { state, actions } = useStore();
  return (url: string) => {
    void openSource(url, state.settings?.privateMode).then((r) => {
      if (r.ok) return;
      actions.toast('warn', r.code === 'EM-8202' ? 'ui.agent.research.source.private' : 'ui.agent.research.source.refused', { url }, { code: r.code, action: { labelKey: 'ui.common.copy', run: () => { void copyText(url); } } });
    });
  };
}

export function ExternalLink({ url, label, el, action }: { url: string; label: string; el: string; action: string }) {
  const { state, t } = useStore();
  const [blocked, setBlocked] = useState(false);
  const [copied, setCopied] = useState(false);
  const open = () => {
    if (!canOpenExternal(state.settings?.privateMode)) { setBlocked(true); return; }
    void window.expertmotion?.openExternal?.(url);
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" data-el={el} className="text-left text-em-accent underline" onClick={open}>{label}</button>
      {blocked && (
        <span data-el={`${el}.blocked`} role="status" className="flex flex-col gap-1 rounded-[6px] border border-em-private/60 p-2 text-[12px]">
          <span className="font-semibold text-em-private">{t('err.EM-8202.title')}</span>
          <span className="text-em-text-2">{t('err.EM-8202.body', { action })}</span>
          <span className="flex items-center gap-2">
            <code className="t-mono flex-1 select-all break-all">{url}</code>
            <Button size={28} icon={<Copy size={14} />} onClick={() => { void copyText(url).then(setCopied); }}>{copied ? t('ui.common.copied') : t('ui.common.copy')}</Button>
          </span>
        </span>
      )}
    </span>
  );
}
