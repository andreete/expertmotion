// Licence screen (scr.license): status, Machine Code + copy, key entry, activate, help links, deactivate, rebind, errors.
// No Trial Mode (Operator decision 2026-10-25): until a key verifies, `LicenseGate` is the only screen the Editor shows; after
// activation the store continues to onboarding / the Editor without a restart. `LicenseScreen` is the "Manage licence" modal.
// Formal "Anda" register is allowed here (licence text, GLOSSARY "Words to avoid").
// FR-132 key link (EM-8202 copyable URL in Private Mode), FR-134 status states + clock-changed badge, FR-135 re-bind steps.
import { copyText, DOCS_URL, readClipboardText, STORE_URL } from '../api/client.js';
import { useState, type DragEvent } from 'react';
import { Copy } from 'lucide-react';
import { EmError } from '@expertmotion/shared';
import { useStore } from '../state/store.js';
import type { LicenseDto, LicenseStatus } from '../api/types.js';
import { Badge, Button, ErrorBox, Field, Modal, inputCls } from '../components/ui.js';
import { ExternalLink } from '../components/ExternalLink.js';

type Tone = 'success' | 'warn' | 'danger' | 'neutral';
const STATUSES: readonly LicenseStatus[] = ['licensed', 'unlicensed', 'invalid', 'revoked', 'machine-mismatch'];
export const isLicensed = (l: LicenseDto | null | undefined): boolean => l?.status === 'licensed';

/** Short Machine Code for status lines ("MC1-7Q4K…8PZD"); the licensee's name is never shown (Operator 2026-10-26). */
export function shortMachineCode(code: string | null | undefined): string {
  if (!code) return '—';
  const parts = code.split('-');
  return parts.length > 3 ? `${parts[0]}-${parts[1]}…${parts[parts.length - 1]}` : code;
}

/** FR-134 popover/status line per licence state. */
export function licenceView(l: LicenseDto | null): { status: LicenseStatus; tone: Tone; bodyKey: string; vars: Record<string, string>; code: string | null; clock: boolean } {
  const status: LicenseStatus = l && STATUSES.includes(l.status) ? l.status : 'unlicensed';
  const vars = { code: shortMachineCode(l?.machineCode), tier: l?.tier ?? '—', date: l?.updatesUntil?.slice(0, 10) ?? '—' };
  const clock = Boolean(l?.clockAnomaly || l?.warnings?.includes('EM-5007'));
  switch (status) {
    case 'licensed': return { status, tone: 'success', bodyKey: 'ui.scr.license.active.full', vars, code: null, clock };
    case 'revoked': return { status, tone: 'danger', bodyKey: 'ui.scr.license.revoked.body', vars, code: 'EM-5004', clock };
    case 'machine-mismatch': return { status, tone: 'danger', bodyKey: 'ui.scr.license.mismatch.body', vars, code: 'EM-5003', clock };
    case 'invalid': return { status, tone: 'danger', bodyKey: l?.code === 'EM-5005' ? 'ui.scr.license.expired.body' : 'ui.scr.license.invalid.body', vars, code: l?.code ?? 'EM-5002', clock };
    default: return { status, tone: 'neutral', bodyKey: 'ui.scr.license.unlicensed.body', vars, code: null, clock };
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
        <Button size={28} onClick={() => onAction('license')}>{t('ui.hdr.license.manage')}</Button>
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
  return text.replace(/^﻿/, '').trim() || null;
}

/** EM-5011 carries `retryAfterSeconds` ({seconds}), EM-5005 the updates date ({date}); other codes need no placeholder. */
type FormError = { code: string; vars?: Record<string, string | number> };

export function LicenseForm({ onDone, gate }: { onDone?: () => void; gate?: boolean }) {
  const { state, runtime, dispatch, actions, t } = useStore();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
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
      actions.toast('success', 'ui.scr.license.activated');
      setRemoved(false); setKey('');
      onDone?.();
    } catch (e) {
      if (e instanceof EmError) {
        const d = e.details as { retryAfterSeconds?: unknown; date?: unknown } | undefined;
        const vars: Record<string, string | number> = { ...(typeof d?.retryAfterSeconds === 'number' ? { seconds: d.retryAfterSeconds } : {}), ...(typeof d?.date === 'string' ? { date: d.date } : {}) };
        setError({ code: e.code, ...(Object.keys(vars).length ? { vars } : {}) });
      } else setError({ code: 'EM-9001' });
    } finally { setBusy(false); }
  };
  const remove = async () => {
    try { dispatch({ type: 'licence', licence: await runtime.api.deactivateLicense() }); setConfirmRemove(false); setRemoved(true); setKey(''); } catch (e) { actions.error(e); }
  };
  const onDrop = async (e: DragEvent<HTMLElement>) => {                    // FR-131: drop the .emlicense file → fill and activate
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const text = await readLicenceFile(f).catch(() => null);
    if (!text) { setError({ code: 'EM-5006' }); return; }
    setKey(text);
    await activate(text);
  };
  const dragProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) { e.preventDefault(); setDragging(true); } },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent<HTMLElement>) => { void onDrop(e); },
  };
  const showRebind = removed || lic?.status === 'machine-mismatch' || error?.code === 'EM-5003';
  const copyCode = () => { void copyText(lic?.machineCode ?? '').then(setCopied); };
  return (
    <div className="flex flex-col gap-3">
      {!(gate && v.status === 'unlicensed') && (
        <div data-el="scr.license.status" data-status={v.status} className="flex flex-wrap items-center gap-2 rounded-[8px] border border-em-line p-3">
          <Badge tone={v.tone}>{t(`ui.scr.license.status.${v.status}`)}</Badge>
          <span className="flex-1 text-em-text-2">{t(v.bodyKey, v.vars)}</span>
          {v.code && <span className="t-mono text-[11px] text-em-muted">{v.code}</span>}
          {v.clock && <ClockBadge />}
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
          <input id="em-license-key" data-el="scr.license.input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={inputCls} placeholder="EM1-…"
            onKeyDown={(e) => { if (e.key === 'Enter' && key.trim().length >= 40 && !busy) void activate(); }} />
          <Button size={32} onClick={() => void readClipboardText().then((v) => { if (v) setKey(v.trim()); })}>{t('ui.common.paste')}</Button>
        </div>
      </Field>
      {error && <ErrorBox el="scr.license.error" code={error.code} {...(error.vars ? { vars: error.vars } : {})} />}
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
      <div className="flex flex-wrap items-center gap-3">
        <Button el="scr.license.activate" variant="primary" loading={busy} disabledReason={key.trim().length < 40 ? t('ui.scr.license.input.short') : null} onClick={() => void activate()}>{t('ui.scr.license.activate')}</Button>
        {!isLicensed(lic) && <ExternalLink el="scr.license.buy" url={STORE_URL} label={t('ui.scr.license.buy')} action={t('ui.scr.license.buy')} />}
        <ExternalLink el="scr.license.help" url={DOCS_URL} label={t('ui.scr.license.help')} action={t('ui.scr.license.help')} />
        <span className="flex-1" />
        {isLicensed(lic) && !gate && (confirmRemove
          ? <><span className="text-[12px]">{t('ui.scr.license.remove.confirm')}</span><Button variant="danger" size={28} onClick={() => void remove()}>{t('ui.common.confirm')}</Button></>
          : <Button el="scr.license.remove" variant="danger-ghost" size={28} onClick={() => setConfirmRemove(true)}>{t('ui.scr.license.remove')}</Button>)}
      </div>
    </div>
  );
}

/** "Manage licence" (header popover, Help ▸ Licence) while the product is licensed. */
export function LicenseScreen({ onClose }: { onClose: () => void }) {
  const { t } = useStore();
  return <Modal el="scr.license" title={t('ui.scr.license.title')} onClose={onClose}><LicenseForm onDone={onClose} /></Modal>;
}

/** The only screen while the install is not licensed (first launch, revoked, other machine, rejected stored key). */
export function LicenseGate() {
  const { state, actions, lang, t } = useStore();
  return (
    <div data-el="scr.license" data-gate="" role="main" className="h-full overflow-auto bg-em-bg">
      <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center gap-4 px-6 py-10">
        <div className="flex items-center gap-3">
          <h1 className="flex-1 text-[24px] font-bold leading-8">{t('ui.scr.license.gate.title')}</h1>
          <button type="button" data-el="scr.license.lang" className="text-em-accent underline" onClick={() => void actions.setLanguage(lang === 'en' ? 'id' : 'en')}>{lang === 'en' ? 'Bahasa Indonesia' : 'English'}</button>
        </div>
        <p className="text-[14px] text-em-text-2">{t('ui.scr.license.gate.body')}</p>
        <ol data-el="scr.license.steps" className="ml-5 list-decimal text-[13px] text-em-text-2">
          <li>{t('ui.scr.license.gate.step1')}</li>
          <li>{t('ui.scr.license.gate.step2')}</li>
          <li>{t('ui.scr.license.gate.step3')}</li>
        </ol>
        <div className="rounded-[12px] border border-em-line bg-em-panel p-4">
          <LicenseForm gate />
        </div>
        <p className="text-[12px] text-em-muted">{t('ui.scr.license.gate.offline')}{state.health?.version ? ` · Expertmotion ${state.health.version}` : ''}</p>
      </div>
    </div>
  );
}
