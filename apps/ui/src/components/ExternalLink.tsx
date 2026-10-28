// Outbound links (Purchase FR-132, online docs FR-148): open in the system browser through the Shell, or, while Private Mode is on,
// show EM-8202 with the URL to copy instead (nothing leaves the computer from the app).
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { useStore } from '../state/store.js';
import { Button } from './ui.js';
import { copyText } from '../api/client.js';

/** True when the link may be opened now; false means "show the copyable URL" (Private Mode). */
export const canOpenExternal = (privateMode: boolean | undefined): boolean => !privateMode;
/** FR-216: opens a web source in the system browser (Shell); development browsers get a new tab. http(s) only. */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const shell = typeof window !== 'undefined' ? window.expertmotion : undefined;
  if (shell?.openExternal) { void shell.openExternal(url); return; }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
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
