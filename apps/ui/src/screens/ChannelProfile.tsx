// FR-28x (Reels, DESIGN §E): the channel profile editor (scr.channel) — the channel's standing rules (format, tone, caption
// style, CTA, handle …) as one text of at most 6 000 characters, saved as the app setting `channelProfile` (R-171) and loaded
// into both agents' prompts. Reachable from the chat header menu, Help ▸ Profil kanal and "Jadikan profil kanal" on an attached
// .md / .txt (the dialog then opens with that text as the draft). Copy per UI_UX_SPECIFICATION §12: labels, one hint.
import { useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { useStore } from '../state/store.js';
import { CHANNEL_PROFILE_MAX } from '../api/types.js';
import { Button, Modal, cx } from '../components/ui.js';
import { channelProfileRatio } from '../agent/reels.js';
import { readFileText } from '../agent/Chat.js';

export function ChannelProfileDialog({ onClose, draft }: { onClose: () => void; draft?: string | undefined }) {
  const { state, actions, t } = useStore();
  const saved = state.settings?.channelProfile ?? '';
  const [text, setText] = useState(draft ?? saved);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const chars = [...text].length, tooLong = chars > CHANNEL_PROFILE_MAX, dirty = text !== saved;
  const ratio = channelProfileRatio(text);
  const save = async () => { if (busy || tooLong) return; setBusy(true); try { await actions.putSettings({ channelProfile: text.trim() }); actions.announce(t('ui.scr.channel.saved')); onClose(); } finally { setBusy(false); } };
  const importFile = async (f: File | undefined) => { if (!f) return; const text = await readFileText(f); if (text === undefined) actions.toast('warn', 'err.EM-1003.title', { name: f.name }, { code: 'EM-1003' }); else setText(text.slice(0, CHANNEL_PROFILE_MAX)); };
  return (
    <Modal el="scr.channel" width={560} title={t('ui.scr.channel.title')} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button>
        {saved && <Button el="scr.channel.clear" variant="ghost" onClick={() => setText('')}>{t('ui.scr.channel.clear')}</Button>}
        <Button el="scr.channel.save" variant="primary" loading={busy} disabledReason={tooLong ? t('ui.scr.channel.toolong', { max: CHANNEL_PROFILE_MAX }) : !dirty ? t('ui.scr.channel.unchanged') : null} onClick={() => void save()}>{t('ui.common.save')}</Button>
      </>}>
      <p className="mb-2 text-[12px] text-em-text-2">{t('ui.scr.channel.hint')}</p>
      <textarea data-el="scr.channel.text" value={text} rows={12} maxLength={CHANNEL_PROFILE_MAX + 200} aria-label={t('ui.scr.channel.title')} placeholder={t('ui.scr.channel.placeholder')}
        onChange={(e) => setText(e.target.value)} className="w-full resize-y rounded-[6px] border border-em-line bg-em-panel-2 px-2 py-1.5 text-[13px] leading-5 outline-none placeholder:text-em-muted focus:border-em-line-strong" />
      <div className="mt-1 flex items-center gap-2 text-[11px]">
        <span data-el="scr.channel.count" role="status" className={cx('t-mono', tooLong ? 'text-em-danger' : 'text-em-muted')}>{chars.toLocaleString()} / {CHANNEL_PROFILE_MAX.toLocaleString()}</span>
        {ratio && <span data-el="scr.channel.ratio" data-ratio={ratio} className="rounded-[4px] border border-em-accent/50 px-1 text-em-accent">{t('ui.scr.channel.ratio', { ratio })}</span>}
        <span className="flex-1" />
        <Button el="scr.channel.import" size={28} variant="ghost" icon={<FileText size={12} />} onClick={() => file.current?.click()}>{t('ui.scr.channel.import')}</Button>
        <input ref={file} data-el="scr.channel.import.input" type="file" accept=".md,.markdown,.txt" hidden aria-hidden tabIndex={-1} onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    </Modal>
  );
}
