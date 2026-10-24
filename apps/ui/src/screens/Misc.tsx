// Diagnostics (scr.diagnostics), About (scr.about), Backup/Restore (scr.backup), shortcut sheet, confirmation modal.
import { useEffect, useState } from 'react';
import { useStore } from '../state/store.js';
import type { Screen } from '../state/reducer.js';
import { Button, ErrorBox, Field, Modal, Progress, inputCls } from '../components/ui.js';
import { formatBytes } from '../i18n/index.js';

export function DiagnosticsScreen({ onClose }: { onClose: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  const [tab, setTab] = useState<'logs' | 'versions' | 'hardware'>('logs');
  const [lines, setLines] = useState<string[]>([]);
  const [bundle, setBundle] = useState<{ path: string; bytes: number } | null>(null);
  useEffect(() => { runtime.api.diagnosticsLogs(200, 'info').then((r) => setLines(r.lines)).catch(() => setLines([])); }, [runtime]);
  const h = state.health;
  return (
    <Modal el="scr.diagnostics" sheet width={640} title={t('ui.scr.diagnostics.title')} onClose={onClose}
      footer={<Button variant="primary" onClick={() => void runtime.api.diagnosticsBundle(Boolean(state.settings?.diagnosticsIncludeStructure)).then(setBundle).catch(actions.error)}>{t('ui.scr.diagnostics.bundle')}</Button>}>
      <div role="tablist" className="mb-2 flex gap-2">
        {(['logs', 'versions', 'hardware'] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={tab === k ? 'border-b-2 border-em-accent' : 'text-em-muted'}>{t(`ui.scr.diagnostics.tab.${k}`)}</button>)}
      </div>
      {tab === 'logs' && <pre className="t-mono max-h-80 overflow-auto rounded-[6px] bg-em-bg p-2 text-[11px] whitespace-pre-wrap">{lines.join('\n') || '—'}</pre>}
      {tab === 'versions' && <dl className="grid grid-cols-[auto_1fr] gap-x-3 t-mono"><dt>app</dt><dd>{h?.version ?? '—'}</dd><dt>mode</dt><dd>{h?.mode ?? '—'}</dd><dt>engine</dt><dd>{h?.engine?.bundleVersion ?? '—'}</dd><dt>remotion</dt><dd>{h?.engine?.remotionVersion ?? '—'}</dd><dt>db</dt><dd>{h?.db?.schemaVersion ?? '—'}</dd><dt>runtime</dt><dd>{runtimeLabel(runtime.mode)}</dd></dl>}
      {tab === 'hardware' && <dl className="grid grid-cols-[auto_1fr] gap-x-3 t-mono"><dt>tier</dt><dd>{state.hardware?.tier}</dd><dt>cpu</dt><dd>{state.hardware?.cpuModel} · {state.hardware?.cpuThreads}</dd><dt>ram</dt><dd>{formatBytes((state.hardware?.ramTotalMb ?? 0) * 1e6, lang)}</dd><dt>gpu</dt><dd>{state.hardware?.gpuModel ?? '—'}</dd></dl>}
      <p className="mt-2 text-[12px] text-em-muted">{t('ui.scr.diagnostics.redacted')}</p>
      {bundle && <p className="t-mono mt-2 select-all">{bundle.path} · {formatBytes(bundle.bytes, lang)}</p>}
    </Modal>
  );
}
const runtimeLabel = (m: string) => (m === 'mock' ? 'mock (VITE_EM_MOCK=1)' : 'local service');

export function AboutScreen({ onClose }: { onClose: () => void }) {
  const { state, t } = useStore();
  return (
    <Modal el="scr.about" width={420} title={t('ui.scr.about.title')} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <div className="text-[24px] font-bold">Expertmotion</div>
        <div className="t-mono text-em-muted">{state.health?.version ?? '—'}</div>
        <div>{t(`ui.scr.license.status.${state.licence?.status ?? 'trial'}`)}</div>
        <details><summary className="cursor-pointer">{t('ui.scr.about.notices')}</summary><p className="mt-1 text-[12px] text-em-muted">{t('ui.scr.about.notices.body')}</p></details>
        <details><summary className="cursor-pointer">{t('ui.scr.about.limitations')}</summary><p className="mt-1 text-[12px] text-em-muted">{t('ui.scr.about.limitations.body')}</p></details>
        {state.settings?.privateMode && <p className="text-em-private">{t('ui.scr.about.updatespaused')}</p>}
      </div>
    </Modal>
  );
}

export function BackupDialog({ mode, onClose }: { mode: 'backup' | 'restore'; onClose: () => void }) {
  const { state, runtime, actions, dispatch, t } = useStore();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [plain, setPlain] = useState(false);
  const [includeOutputs, setIncludeOutputs] = useState(false);
  const [file, setFile] = useState('');
  const [error, setError] = useState<string | null>(null);
  const job = state.backupJob?.mode === mode ? state.backupJob : null;
  const passOk = plain || (pass.length >= 8 && pass === pass2);
  const backup = async () => {
    if (!state.project) return;
    setError(null);
    try {
      const r = await runtime.api.backupProject(state.project.id, { folder: state.settings?.outputFolder ?? '', ...(plain ? {} : { passphrase: pass }), includeOutputs });
      dispatch({ type: 'backupJob', job: { jobId: r.jobId, percent: 0, done: false, mode: 'backup' } });
    } catch (e) { setError((e as { code?: string }).code ?? 'EM-6301'); }
  };
  const restore = async () => {
    setError(null);
    try { const r = await runtime.api.restoreProject({ path: file, ...(pass ? { passphrase: pass } : {}), onConflict: 'copy' }); dispatch({ type: 'backupJob', job: { jobId: r.jobId, percent: 0, done: false, mode: 'restore' } }); }
    catch (e) { setError((e as { code?: string }).code ?? 'EM-6302'); }
  };
  const close = () => { dispatch({ type: 'backupJob', job: null }); onClose(); };
  return (
    <Modal el="scr.backup" width={480} title={mode === 'backup' ? t('ui.scr.backup.title') : t('ui.scr.restore.title')} onClose={close}
      footer={job?.done ? <Button variant="primary" onClick={close}>{t('ui.common.done')}</Button>
        : mode === 'backup' ? <Button el="scr.backup.backup.start" variant="primary" loading={Boolean(job)} disabledReason={passOk ? null : t('ui.scr.backup.passphrase.mismatch')} onClick={() => void backup()}>{t('ui.scr.backup.start')}</Button>
          : <Button el="scr.backup.restore.start" variant="primary" loading={Boolean(job)} disabledReason={file ? null : t('ui.scr.restore.file.required')} onClick={() => void restore()}>{t('ui.scr.restore.start')}</Button>}>
      {mode === 'backup' ? (
        <div className="flex flex-col gap-1">
          {!plain && <>
            <Field label={t('ui.scr.backup.passphrase')} htmlFor="em-bk-p" hint={t('ui.scr.backup.passphrase.hint')}><input id="em-bk-p" data-el="scr.backup.backup.passphrase" type="password" className={inputCls} value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
            <Field label={t('ui.scr.backup.passphrase.confirm')} htmlFor="em-bk-p2"><input id="em-bk-p2" type="password" className={inputCls} value={pass2} onChange={(e) => setPass2(e.target.value)} /></Field>
          </>}
          <label className="flex items-center gap-2"><input data-el="scr.backup.backup.plain" type="checkbox" checked={plain} onChange={(e) => setPlain(e.target.checked)} />{t('ui.scr.backup.plain')}</label>
          {plain && <p className="rounded-[6px] border border-em-warn p-2 text-[12px] text-em-warn">{t('ui.scr.backup.plain.warning')}</p>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={includeOutputs} onChange={(e) => setIncludeOutputs(e.target.checked)} />{t('ui.scr.backup.outputs')}</label>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Field label={t('ui.scr.restore.file')} htmlFor="em-rs-f">
            <div className="flex gap-2"><input id="em-rs-f" data-el="scr.backup.restore.file" className={inputCls} value={file} onChange={(e) => setFile(e.target.value)} placeholder="…\\project.emzip" />
              <Button onClick={() => void window.expertmotion?.pickFiles?.({ accept: '.emzip,.zip' }).then((p) => { if (p[0]) setFile(p[0]); })}>{t('ui.scr.project.open.browse')}</Button></div>
          </Field>
          <Field label={t('ui.scr.restore.passphrase')} htmlFor="em-rs-p"><input id="em-rs-p" data-el="scr.backup.restore.passphrase" type="password" className={inputCls} value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
          <p className="text-[12px] text-em-muted">{t('ui.scr.restore.note')}</p>
        </div>
      )}
      {job && <div data-el="scr.backup.progress" className="mt-2 flex flex-col gap-1"><Progress value={job.percent / 100} label={t('ui.scr.backup.progress')} /><span className="text-[12px] text-em-muted">{job.done ? (job.path ? t('ui.scr.backup.done', { path: job.path }) : t('ui.scr.restore.done')) : `${job.percent} %`}</span></div>}
      {error && <ErrorBox code={error} />}
    </Modal>
  );
}

export const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'ui.key.play'], ['← / →', 'ui.key.frame'], ['Shift+← / →', 'ui.key.second'], ['Home / End', 'ui.key.startend'], ['Ctrl+S', 'ui.key.save'], ['Ctrl+Z / Ctrl+Y', 'ui.key.undoredo'],
  ['Ctrl+Enter', 'ui.key.execute'], ['Esc', 'ui.key.escape'], ['/', 'ui.key.search'], ['1 / 2 / 3', 'ui.key.modes'], ['Ctrl+E', 'ui.key.export'], ['Ctrl+I', 'ui.key.import'],
  ['Ctrl+N / Ctrl+O', 'ui.key.newopen'], ['A', 'ui.key.ask'], ['F', 'ui.key.fullscreen'], ['Ctrl+B / Ctrl+Shift+B', 'ui.key.panels'], ['Shift+?', 'ui.key.sheet'],
];
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { t } = useStore();
  return (
    <Modal el="scr.shortcuts" width={480} title={t('ui.hdr.menu.help.shortcuts')} onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">{SHORTCUTS.map(([k, v]) => <div key={k} className="contents"><dt className="t-mono">{k}</dt><dd>{t(v)}</dd></div>)}</dl>
    </Modal>
  );
}

export function ConfirmModal({ screen, onClose }: { screen: Extract<Screen, { kind: 'confirm' }>; onClose: () => void }) {
  const { t } = useStore();
  return (
    <Modal el="scr.confirm" width={420} title={t(screen.titleKey, screen.vars)} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button><Button variant={screen.danger ? 'danger' : 'primary'} onClick={() => { onClose(); screen.onConfirm(); }}>{t(screen.confirmKey)}</Button></>}>
      {screen.bodyKey && <p>{t(screen.bodyKey, screen.vars)}</p>}
    </Modal>
  );
}
