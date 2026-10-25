// Model Manager (scr.models, FR-120…FR-126): Local Models grouped by purpose; the row shows the product name (displayName), size,
// tier and used-by; the licence (name + link, engine notices) is in the expanded card;
// expandable model card; filters; install (EM-7005 confirm above the Hardware Tier), pause / resume / cancel, remove with
// confirmation; footer with disk use, free space and per-engine "open folder" (ADR-008, F11). SEC-072 refusals: EM-7111.
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import { useStore } from '../state/store.js';
import type { ModelRegistrySource, ModelStateDto } from '../api/types.js';
import { Badge, Button, Modal, Progress, cx, inputCls } from '../components/ui.js';
import { formatBytes, formatNumber } from '../i18n/index.js';
import { localModelName } from '../state/model-names.js';

const PURPOSES = ['stt', 'tts', 'image', 'music'] as const;
type Purpose = (typeof PURPOSES)[number];
type Summary = { totalInstalledBytes: number; diskFreeBytes: number; registry?: ModelRegistrySource };
const busyStatus = (s: ModelStateDto['status']) => s === 'downloading' || s === 'verifying' || s === 'paused';

/** FR-121 model card: description, languages, licence summary (no download source: Operator decision 2026-10-25) with commercial-use note, hash, disk path label. */
function ModelCard({ m }: { m: ModelStateDto }) {
  const { t } = useStore();
  const commercial = m.commercialUse ?? 'yes';
  return (
    <dl data-el="scr.models.row.card" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-[6px] bg-em-panel-2 p-2 text-[12px]">
      {m.notes && m.notes.length > 0 && <><dt className="text-em-muted">{t('ui.scr.models.card.description')}</dt><dd>{m.notes.join(' · ')}</dd></>}
      <dt className="text-em-muted">{t('ui.scr.models.card.languages')}</dt><dd>{m.languages?.length ? m.languages.map((l) => t(`ui.common.lang.${l}`)).join(', ') : '—'}</dd>
      <dt className="text-em-muted">{t('ui.scr.models.card.licence')}</dt>
      <dd><a data-el="scr.models.row.licence" href={m.licence.url} target="_blank" rel="noreferrer" className="text-em-accent underline">{m.licence.name}</a>{m.licenceDetail?.useRestrictions ? ` · ${m.licenceDetail.useRestrictions}` : ''} · <span className={commercial === 'yes' ? 'text-em-success' : 'text-em-warn'}>{t(`ui.scr.models.card.commercial.${commercial}`)}</span>
        {m.licenceDetail?.redistribution === 'verify' && <> · <span className="text-em-warn">{t('ui.scr.models.card.verify')}</span></>}</dd>
      {m.engineNotices?.map((n) => (
        <Fragment key={n.label}>
          <dt className="text-em-muted">{t('ui.scr.models.card.engine')}</dt>
          <dd data-el="scr.models.row.notice">{t('ui.scr.models.card.enginenotice', { label: n.label, licence: n.licence })} <a href={n.url} target="_blank" rel="noreferrer" className="text-em-accent underline">{t('ui.scr.providers.terms')}</a></dd>
        </Fragment>
      ))}
      <dt className="text-em-muted">{t('ui.scr.models.card.hash')}</dt>
      <dd className="t-mono break-all">{m.hashes?.length ? m.hashes.map((h) => `${h.name}: ${h.sha256 ?? t('ui.scr.models.card.unpinned')}`).join(' · ') : '—'}</dd>
      <dt className="text-em-muted">{t('ui.scr.models.card.path')}</dt><dd className="t-mono">{m.pathLabel ?? '—'}</dd>
    </dl>
  );
}

function ModelRow({ m, focus, onChanged }: { m: ModelStateDto; focus?: string | undefined; onChanged: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<'install' | 'remove' | null>(null);
  const tier = state.hardware?.tier ?? 'T0';
  const priv = Boolean(state.settings?.privateMode);
  const fits = m.tiers.includes(tier);
  const act = (p: Promise<unknown>) => { setConfirm(null); void p.then(() => onChanged()).catch(actions.error); };
  const pct = m.bytesTotal ? Math.round((m.bytesDone / m.bytesTotal) * 100) : 0;
  const partial = m.status === 'not-installed' && m.bytesDone > 0;
  const usedBy = [...(m.usedBy?.generators ?? []).map((g) => t(`ui.scr.models.usedby.${g}`)), ...(m.usedBy?.presets ?? [])];
  const install = () => (fits ? act(runtime.api.installModel(m.key)) : setConfirm('install'));   // FR-123: EM-7005 above the tier
  const name = localModelName(m, lang);                                                             // product name (Operator 2026-10-25); licence stays in the card
  return (
    <div data-el="scr.models.row" data-model-key={m.key} tabIndex={focus === m.key ? -1 : undefined} data-focused={focus === m.key || undefined}
      className={cx('mb-1 flex flex-col gap-1 rounded-[6px] border p-2', focus === m.key ? 'border-em-accent' : 'border-em-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-el="scr.models.row.expand" aria-expanded={open} aria-label={open ? t('ui.common.close') : t('ui.common.expand')} className="text-em-muted" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span data-el="scr.models.row.name" className="flex-1 font-medium">{name}</span>
        {m.recommended && <Badge el="scr.models.row.recommended" tone="success">{t('ui.scr.models.recommended')}</Badge>}
        {m.priority === 'P2' && <Badge>{t('ui.scr.models.p2')}</Badge>}
        <span className="t-mono text-em-muted">{formatBytes(m.bytesTotal, lang)}</span>
        <Badge el="scr.models.row.tier" tone={fits ? 'neutral' : 'warn'}>{fits ? t('ui.scr.models.mintier', { tier: m.tiers[0] ?? 'T0' }) : t('ui.scr.models.needsgpu', { tier: m.tiers[0] ?? 'T1' })}</Badge>
      </div>
      {usedBy.length > 0 && <div className="text-[11px] text-em-muted">{t('ui.scr.models.usedby', { list: usedBy.join(', ') })}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <span data-el="scr.models.row.status" className="flex-1 text-[12px] text-em-muted">
          {m.status === 'paused' && m.pausedReason === 'render' ? t('ui.scr.models.status.pausedrender', { percent: pct })
            : partial ? t('ui.scr.models.status.partial', { percent: pct })
            : t(`ui.scr.models.status.${m.status}`)}{m.errorCode ? ` · ${t(`err.${m.errorCode}.title`)} · ${m.errorCode}` : ''}
        </span>
        {m.status === 'installed' && <Button el="scr.models.row.remove" size={28} variant="danger-ghost" onClick={() => setConfirm('remove')}>{t('ui.common.remove')}</Button>}
        {(m.status === 'not-installed' || m.status === 'failed') && (
          <Button el="scr.models.row.install" size={28} variant="primary" disabledReason={priv ? t('err.EM-8202.title') : null} onClick={install}>{partial ? t('ui.scr.models.resume') : t('ui.scr.models.install')}</Button>
        )}
        {(m.status === 'downloading' || m.status === 'verifying') && <Button el="scr.models.row.pause" size={28} variant="ghost" onClick={() => act(runtime.api.cancelModel(m.key))}>{t('ui.scr.models.pause')}</Button>}
        {(busyStatus(m.status) || partial) && <Button el="scr.models.row.cancel" size={28} variant="ghost" onClick={() => act(runtime.api.cancelModel(m.key, true))}>{t('ui.common.cancel')}</Button>}
      </div>
      {busyStatus(m.status) && (
        <div data-el="scr.models.row.progress" className="flex items-center gap-2">
          <Progress value={m.bytesTotal ? m.bytesDone / m.bytesTotal : null} label={name} />
          <span className="t-mono shrink-0 text-[11px] text-em-muted">{formatBytes(m.bytesDone, lang)} / {formatBytes(m.bytesTotal, lang)}</span>
        </div>
      )}
      {confirm === 'install' && (
        <div data-el="scr.models.row.install.confirm" role="alertdialog" aria-label={t('err.EM-7005.title')} className="flex flex-wrap items-center gap-2 rounded-[6px] bg-em-panel-2 p-2 text-[12px]">
          <span className="flex-1 text-em-warn">{t('err.EM-7005.body', { model: name })} <span className="t-mono text-em-muted">EM-7005</span></span>
          <Button size={28} variant="ghost" onClick={() => setConfirm(null)}>{t('ui.common.cancel')}</Button>
          <Button el="scr.models.row.install.anyway" size={28} variant="primary" onClick={() => act(runtime.api.installModel(m.key))}>{t('ui.scr.models.installanyway')}</Button>
        </div>
      )}
      {confirm === 'remove' && (
        <div data-el="scr.models.row.remove.confirm" role="alertdialog" aria-label={t('ui.scr.models.remove.confirm', { model: name, size: formatBytes(m.bytesTotal, lang) })} className="flex flex-wrap items-center gap-2 rounded-[6px] bg-em-panel-2 p-2 text-[12px]">
          <span className="flex-1">{t('ui.scr.models.remove.confirm', { model: name, size: formatBytes(m.bytesTotal, lang) })}</span>
          <Button size={28} variant="ghost" onClick={() => setConfirm(null)}>{t('ui.common.cancel')}</Button>
          <Button el="scr.models.row.remove.yes" size={28} variant="danger" onClick={() => act(runtime.api.removeModel(m.key))}>{t('ui.common.remove')}</Button>
        </div>
      )}
      {open && <ModelCard m={m} />}
    </div>
  );
}

/** `focus` (FR-037): model key to scroll to and highlight, from a Catalogue Card's model badge. */
export function ModelsScreen({ onClose, focus }: { onClose: () => void; focus?: string }) {
  const { state, runtime, actions, t, lang } = useStore();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [purpose, setPurpose] = useState<Purpose | 'all'>('all');
  const [installed, setInstalled] = useState<'all' | 'installed' | 'not'>('all');
  const [fitsOnly, setFitsOnly] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const reload = () => {
    void actions.loadModels();
    runtime.api.listModels().then((r) => setSummary({ totalInstalledBytes: r.totalInstalledBytes, diskFreeBytes: r.diskFreeBytes, ...(r.registry ? { registry: r.registry } : {}) })).catch(() => undefined);
  };
  useEffect(reload, [actions, runtime]); // eslint-disable-line react-hooks/exhaustive-deps
  const focused = useRef(false);
  useEffect(() => {
    if (!focus || focused.current) return;
    const row = [...document.querySelectorAll<HTMLElement>('[data-el="scr.models.row"]')].find((r) => r.dataset['modelKey'] === focus);
    if (row) { focused.current = true; row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true }); }
  }, [focus, state.models]);
  const tier = state.hardware?.tier ?? 'T0';
  const priv = Boolean(state.settings?.privateMode);
  const shown = state.models.filter((m) => (purpose === 'all' || m.task === purpose) && (installed === 'all' || (installed === 'installed') === (m.status === 'installed')) && (!fitsOnly || m.tiers.includes(tier)));
  const engines = [...new Set(state.models.map((m) => m.engine))];
  const used = summary?.totalInstalledBytes ?? state.models.filter((m) => m.status === 'installed').reduce((a, m) => a + m.bytesTotal, 0);
  const openFolder = async (engine: string) => {                                                    // FR-126; EM-8303 shows the path
    setFolderError(null);
    let p = '';
    try { p = (await runtime.api.revealModelsFolder(engine)).path; if (!window.expertmotion?.openFolder) throw new Error('no shell'); await window.expertmotion.openFolder(p); }
    catch (e) { if (!p) actions.error(e); else setFolderError(p); }
  };
  return (
    <Modal el="scr.models" sheet width={680} title={t('ui.scr.models.title')} onClose={onClose}>
      <div data-el="scr.models.tier" className="mb-3 rounded-[8px] border border-em-line p-2">{t('ui.scr.models.tier', { tier, desc: t(`ui.scr.models.tier.${tier}`) })}</div>
      {priv && <p className="mb-2 text-em-private">{t('err.EM-8202.title')}</p>}
      {summary?.registry?.code && <p data-el="scr.models.registry" className="mb-2 text-[12px] text-em-warn">{t(`err.${summary.registry.code}.title`)} · {t(`err.${summary.registry.code}.body`)} <span className="t-mono text-em-muted">{summary.registry.code}</span></p>}
      <div data-el="scr.models.filter" className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
        <select aria-label={t('ui.scr.models.filter.purpose')} data-el="scr.models.filter.purpose" className={cx(inputCls, '!h-7 !w-auto')} value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose | 'all')}>
          <option value="all">{t('ui.scr.models.filter.allpurposes')}</option>
          {PURPOSES.map((p) => <option key={p} value={p}>{t(`ui.scr.models.task.${p}`)}</option>)}
        </select>
        <select aria-label={t('ui.scr.models.filter.installed')} data-el="scr.models.filter.installed" className={cx(inputCls, '!h-7 !w-auto')} value={installed} onChange={(e) => setInstalled(e.target.value as 'all' | 'installed' | 'not')}>
          <option value="all">{t('ui.scr.models.filter.any')}</option>
          <option value="installed">{t('ui.scr.models.status.installed')}</option>
          <option value="not">{t('ui.scr.models.status.not-installed')}</option>
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" data-el="scr.models.filter.fits" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} />{t('ui.scr.models.filter.fits')}</label>
        {(purpose !== 'all' || installed !== 'all' || fitsOnly) && <Button size={28} variant="ghost" onClick={() => { setPurpose('all'); setInstalled('all'); setFitsOnly(false); }}>{t('ui.common.clear')}</Button>}
      </div>
      <div data-el="scr.models.list" className="flex flex-col gap-3">
        {shown.length === 0 && <p className="text-em-muted">{t('ui.scr.models.filter.none')}</p>}
        {PURPOSES.map((p) => {
          const group = shown.filter((m) => m.task === p);
          if (!group.length) return null;
          return (
            <div key={p} data-purpose={p}>
              <div className="t-label mb-1">{t(`ui.scr.models.task.${p}`)}</div>
              {group.map((m) => <ModelRow key={m.key} m={m} focus={focus} onChanged={reload} />)}
            </div>
          );
        })}
      </div>
      <div data-el="scr.models.footer" className="mt-4 flex flex-col gap-1 border-t border-em-line pt-2 text-[12px]">
        <div>{t('ui.scr.models.footer', { used: formatBytes(used, lang), free: summary ? `${formatNumber(summary.diskFreeBytes / 1e9, lang, 0)} GB` : '…' })}</div>
        <div className="flex flex-wrap gap-1">
          {engines.map((e) => <Button key={e} el="scr.models.folder" size={28} variant="ghost" icon={<FolderOpen size={14} />} onClick={() => void openFolder(e)}>{t('ui.scr.models.openfolder', { engine: e })}</Button>)}
        </div>
        {folderError && <p role="alert" className="text-em-warn">{t('err.EM-8303.title')} · {t('err.EM-8303.body', { path: folderError })} <span className="t-mono text-em-muted">EM-8303</span></p>}
      </div>
    </Modal>
  );
}
