// Licence screen (scr.license): status, Machine Code + copy, key entry, activate, trial, buy, deactivate, rebind, errors.
// Formal "Anda" register is allowed here (licence text, GLOSSARY "Words to avoid").
// FR-132 buy link (EM-8202 copyable URL in Private Mode), FR-134 status states + clock-changed badge, FR-135 re-bind steps.
import { STORE_URL } from '../api/client.js';
import { useState, type DragEvent } from 'react';
import { Copy } from 'lucide-react';
import { EmError } from '@expertmotion/shared';
import { useStore } from '../state/store.js';
import type { LicenseDto } from '../api/types.js';
import { Badge, Button, ErrorBox, Field, Modal, inputCls } from '../components/ui.js';
import { ExternalLink } from '../components/ExternalLink.js';

type Tone = 'success' | 'warn' | 'danger' | 'neutral';
/** FR-134 popover/status line per licence state. */
export function licenceView(l: LicenseDto | null): { status: string; tone: Tone; bodyKey: string; vars: Record<string, string>; code: string | null; clock: boolean } {
  const status = l?.status ?? 'trial';
  const vars = { name: l?.licenseeName ?? '—', tier: l?.tier ?? '—', date: l?.updatesUntil?.slice(0, 10) ?? '—' };
  const clock = Boolean(l?.clockAnomaly || l?.warnings?.includes('EM-5007'));
  switch (status) {
    case 'active': return { status, tone: 'success', bodyKey: 'ui.scr.license.active.full', vars, code: null, clock };
    case 'updates-expired': return { status, tone: 'warn', bodyKey: 'ui.scr.license.expired.body', vars, code: 'EM-5005', clock };
    case 'revoked': return { status, tone: 'danger', bodyKey: 'ui.scr.license.revoked.body', vars, code: 'EM-5004', clock };
    case 'invalid': return { status, tone: 'danger', bodyKey: 'ui.scr.license.invalid.body', vars, code: l?.code ?? 'EM-5003', clock };
    default: return { status: 'trial', tone: 'warn', bodyKey: 'ui.scr.license.trial.body', vars, code: null, clock };
  }
}

function ClockBadge() {
  const { t } = useStore();
  return <span title={t('err.EM-5007.body')}><Badge el="scr.license.clock" tone="neutral">{t('err.EM-5007.title')} · EM-5007</Badge></span>;
}

/** Header licence popover body (hdr.action.license). */
export function LicenceStatus({ onAction }: { onAction: (screen: 'license') => void }) {
  const { state, t } = useStore();
  const v = licenceView(state.licence);
  return (
    <div className="flex flex-col gap-2 p-2" data-licence-status={v.status}>
      <div className="flex flex-wrap items-center gap-2"><Badge tone={v.tone}>{t(`ui.scr.license.status.${v.status}`)}</Badge>{v.code && <span className="t-mono text-[11px] text-em-muted">{v.code}</span>}{v.clock && <ClockBadge />}</div>
      <p>{t(v.bodyKey, v.vars)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size={28} onClick={() => onAction('license')}>{t('ui.hdr.license.enterkey')}</Button>
        {v.status !== 'active' && <ExternalLink el="scr.license.buy" url={STORE_URL} label={t('ui.hdr.action.purchase')} action={t('ui.hdr.action.purchase')} />}
      </div>
    </div>
  );
}

/** FR-131: a dropped `.emlicense` file is a UTF-8 text file holding the key (LICENSE_OPERATIONS §3); bounded before reading. */
export const LICENCE_FILE_MAX_BYTES = 8 * 1024;
export async function readLicenceFile(f: File): Promise<string | null> {
  if (!/\.emlicense$/i.test(f.name) && f.type !== 'text/plain') return null;
  if (f.size === 0 || f.size > LICENCE_FILE_MAX_BYTES) return null;
  const text = typeof f.text === 'function' ? await f.text()
    : await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result ?? '')); r.onerror = () => rej(r.error); r.readAsText(f); });
  return text.replace(/^\uFEFF/, '').trim() || null;
}

export function LicenseForm({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { state, runtime, dispatch, actions, t } = useStore();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [dragging, setDragging] = useState(false);
  const lic = state.licence;
  const v = licenceView(lic);
  const activate = async (value = key) => {
    setBusy(true); setError(null);
    try {
      const l = await runtime.api.activateLicense(value.trim());
      dispatch({ type: 'licence', licence: l });
      if (l.warnings?.includes('EM-5005')) actions.toast('info', 'err.EM-5005.title', undefined, { code: 'EM-5005' });
      actions.toast('success', 'ui.scr.license.activated');
      setRemoved(false);
      onDone?.();
    } catch (e) { setError(e instanceof EmError ? e.code : 'EM-9001'); } finally { setBusy(false); }
  };
  const remove = async () => {
    try { dispatch({ type: 'licence', licence: await runtime.api.deactivateLicense() }); setConfirmRemove(false); setRemoved(true); setKey(''); } catch (e) { actions.error(e); }
  };
  const onDrop = async (e: DragEvent<HTMLElement>) => {                    // FR-131: drop the .emlicense file → fill and activate
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const text = await readLicenceFile(f).catch(() => null);
    if (!text) { setError('EM-5006'); return; }
    setKey(text);
    await activate(text);
  };
  const dragProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) { e.preventDefault(); setDragging(true); } },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent<HTMLElement>) => { void onDrop(e); },
  };
  const showRebind = removed || lic?.status === 'invalid' || error === 'EM-5003';
  const copyCode = () => { void navigator.clipboard?.writeText(lic?.machineCode ?? '').catch(() => undefined); setCopied(true); };
  return (
    <div className="flex flex-col gap-3">
      {!compact && (
        <div data-el="scr.license.status" data-status={v.status} className="flex flex-wrap items-center gap-2 rounded-[8px] border border-em-line p-3">
          <Badge tone={v.tone}>{t(`ui.scr.license.status.${v.status}`)}</Badge>
          <span className="flex-1 text-em-text-2">{t(v.bodyKey, v.vars)}</span>
          {v.code && <span className="t-mono text-[11px] text-em-muted">{v.code}</span>}
          {v.clock && <ClockBadge />}
        </div>
      )}
      {compact && v.status === 'trial' && (                                      /* FR-133: EM-5001 at first launch (onboarding) */
        <div data-el="scr.license.trial.notice" data-code="EM-5001" role="status" className="rounded-[6px] border-l-2 border-em-info bg-em-panel-2 px-3 py-2">
          <div className="flex items-center gap-2"><span className="flex-1 font-semibold">{t('err.EM-5001.title')}</span><span className="t-mono text-em-muted">EM-5001</span></div>
          <div className="text-em-text-2">{t('err.EM-5001.body')}</div>
        </div>
      )}
      <Field label={t('ui.scr.license.machinecode')} hint={t('ui.scr.license.machinecode.hint')}>
        <div className="flex gap-2">
          <code data-el="scr.license.machinecode" className="t-mono flex-1 rounded-[6px] border border-em-line bg-em-panel-2 px-2 py-1.5 select-all">{lic?.machineCode ?? '…'}</code>
          <Button el="scr.license.machinecode.copy" icon={<Copy size={14} />} onClick={copyCode}>{copied ? t('ui.common.copied') : t('ui.common.copy')}</Button>
        </div>
      </Field>
      <Field label={t('ui.scr.license.input')} htmlFor="em-license-key" hint={t('ui.scr.license.input.drop')}>
        <div className={`flex gap-2 rounded-[6px] ${dragging ? 'outline outline-2 outline-em-accent' : ''}`} data-dropping={dragging || undefined} {...dragProps}>
          <input id="em-license-key" data-el="scr.license.input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={inputCls} placeholder="EM1.…" />
          <Button size={32} onClick={() => void navigator.clipboard?.readText().then(setKey).catch(() => undefined)}>{t('ui.common.paste')}</Button>
        </div>
      </Field>
      {error && <ErrorBox el="scr.license.error" code={error} />}
      {showRebind && (
        <div data-el="scr.license.rebind" className="flex flex-col gap-1 rounded-[8px] border border-em-warn p-2 text-[12px]">
          <span className="font-semibold">{removed ? t('ui.scr.license.removed') : t('ui.scr.license.rebind')}</span>
          <ol className="ml-4 list-decimal">
            <li>{t('ui.scr.license.rebind.step1')}</li>
            <li>{t('ui.scr.license.rebind.step2')}</li>
            <li>{t('ui.scr.license.rebind.step3')}</li>
          </ol>
          <span className="text-em-muted">{t('ui.scr.license.rebind.limit')}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button el="scr.license.activate" variant="primary" loading={busy} disabledReason={key.trim().length < 40 ? t('ui.scr.license.input.short') : null} onClick={() => void activate()}>{t('ui.scr.license.activate')}</Button>
        {lic?.status !== 'active' && <Button el="scr.license.trial.continue" variant="ghost" onClick={() => onDone?.()}>{t('ui.scr.license.trial.continue')}</Button>}
        {lic?.status !== 'active' && <ExternalLink el="scr.license.buy" url={STORE_URL} label={t('ui.scr.license.buy')} action={t('ui.scr.license.buy')} />}
        <span className="flex-1" />
        {(lic?.status === 'active' || lic?.status === 'updates-expired') && !compact && (confirmRemove
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
