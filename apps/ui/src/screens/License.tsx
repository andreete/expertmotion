// Licence screen (scr.license): status, Machine Code + copy, key entry, activate, trial, buy, deactivate, rebind, errors.
// Formal "Anda" register is allowed here (licence text, GLOSSARY "Words to avoid").
import { STORE_URL } from '../api/client.js';
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { EmError } from '@expertmotion/shared';
import { useStore } from '../state/store.js';
import { Badge, Button, ErrorBox, Field, Modal, inputCls } from '../components/ui.js';

export function LicenseForm({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { state, runtime, dispatch, actions, t } = useStore();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const lic = state.licence;
  const activate = async () => {
    setBusy(true); setError(null);
    try {
      const l = await runtime.api.activateLicense(key.trim());
      dispatch({ type: 'licence', licence: l });
      if (l.warnings?.includes('EM-5005')) actions.toast('info', 'err.EM-5005.title', undefined, { code: 'EM-5005' });
      actions.toast('success', 'ui.scr.license.activated');
      onDone?.();
    } catch (e) { setError(e instanceof EmError ? e.code : 'EM-9001'); } finally { setBusy(false); }
  };
  const remove = async () => {
    try { dispatch({ type: 'licence', licence: await runtime.api.deactivateLicense() }); setConfirmRemove(false); } catch (e) { actions.error(e); }
  };
  return (
    <div className="flex flex-col gap-3">
      {!compact && (
        <div data-el="scr.license.status" className="flex items-center gap-2 rounded-[8px] border border-em-line p-3">
          <Badge tone={lic?.status === 'active' ? 'success' : 'warn'}>{t(`ui.scr.license.status.${lic?.status ?? 'trial'}`)}</Badge>
          <span className="text-em-text-2">{lic?.status === 'active' ? t('ui.scr.license.active.body', { date: lic.updatesUntil?.slice(0, 10) ?? '—' }) : t('ui.scr.license.trial.body')}</span>
        </div>
      )}
      <Field label={t('ui.scr.license.machinecode')} hint={t('ui.scr.license.machinecode.hint')}>
        <div className="flex gap-2">
          <code data-el="scr.license.machinecode" className="t-mono flex-1 rounded-[6px] border border-em-line bg-em-panel-2 px-2 py-1.5 select-all">{lic?.machineCode ?? '…'}</code>
          <Button el="scr.license.machinecode.copy" icon={<Copy size={14} />} onClick={() => { void navigator.clipboard?.writeText(lic?.machineCode ?? '').catch(() => undefined); setCopied(true); }}>{copied ? t('ui.common.copied') : t('ui.common.copy')}</Button>
        </div>
      </Field>
      <Field label={t('ui.scr.license.input')} htmlFor="em-license-key">
        <div className="flex gap-2">
          <input id="em-license-key" data-el="scr.license.input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={inputCls} placeholder="EM1.…" />
          <Button size={32} onClick={() => void navigator.clipboard?.readText().then(setKey).catch(() => undefined)}>{t('ui.common.paste')}</Button>
        </div>
      </Field>
      {error && <ErrorBox el="scr.license.error" code={error} />}
      {lic?.status === 'invalid' && (
        <div data-el="scr.license.rebind" className="rounded-[8px] border border-em-warn p-2 text-[12px]">{t('ui.scr.license.rebind')}</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button el="scr.license.activate" variant="primary" loading={busy} disabledReason={key.trim().length < 40 ? t('ui.scr.license.input.short') : null} onClick={() => void activate()}>{t('ui.scr.license.activate')}</Button>
        {lic?.status !== 'active' && <Button el="scr.license.trial.continue" variant="ghost" onClick={() => onDone?.()}>{t('ui.scr.license.trial.continue')}</Button>}
        <button type="button" data-el="scr.license.buy" className="text-em-accent underline" onClick={() => void window.expertmotion?.openExternal?.(STORE_URL)}>{t('ui.scr.license.buy')}</button>
        <span className="flex-1" />
        {lic?.status === 'active' && !compact && (confirmRemove
          ? <><span className="text-[12px]">{t('ui.scr.license.remove.confirm')}</span><Button variant="danger" size={28} onClick={() => void remove()}>{t('ui.common.confirm')}</Button></>
          : <Button el="scr.license.remove" variant="danger-ghost" size={28} onClick={() => setConfirmRemove(true)}>{t('ui.scr.license.remove')}</Button>)}
      </div>
    </div>
  );
}

export function LicenseScreen({ onClose }: { onClose: () => void }) {
  const { t } = useStore();
  return <Modal el="scr.license" title={t('ui.scr.license.title')} onClose={onClose}><LicenseForm onDone={onClose} /></Modal>;
}
