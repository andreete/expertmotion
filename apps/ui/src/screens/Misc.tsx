// Diagnostics (scr.diagnostics), About (scr.about), offline Help (scr.help), Backup/Restore (scr.backup), shortcut sheet, confirmation modal.
import { useEffect, useState } from 'react';
import { Copy, ShieldCheck } from 'lucide-react';
import { copyText, DOCS_URL } from '../api/client.js';
import type { RecentCodeDto } from '../api/types.js';
import { useStore } from '../state/store.js';
import { ExternalLink } from '../components/ExternalLink.js';
import { licenceView } from './License.js';
import { ProfileTable } from '../agent/OutputSettings.js';
import type { Screen } from '../state/reducer.js';
import type { DiskUsageDto } from '../api/types.js';
import { Button, ErrorBox, Field, Modal, Progress, inputCls } from '../components/ui.js';
import { formatBytes } from '../i18n/index.js';

export function DiagnosticsScreen({ onClose }: { onClose: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  const [tab, setTab] = useState<'logs' | 'events' | 'versions' | 'hardware'>('logs');
  const [lines, setLines] = useState<string[]>([]);
  const [codes, setCodes] = useState<RecentCodeDto[]>([]);
  const [bundle, setBundle] = useState<{ path: string; bytes: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { runtime.api.diagnosticsLogs(200, 'info').then((r) => setLines(r.lines)).catch(() => setLines([])); }, [runtime]);
  useEffect(() => { runtime.api.diagnosticsCodes(50).then((r) => setCodes(r.items)).catch(() => setCodes([])); }, [runtime]);
  const h = state.health;
  const lic = licenceView(state.licence);
  const copyPath = (p: string) => { void copyText(p).then(setCopied); };
  const makeBundle = async () => {
    setError(null); setCopied(false);
    try { const b = await runtime.api.diagnosticsBundle(Boolean(state.settings?.diagnosticsIncludeStructure)); setBundle(b); copyPath(b.path); }   // FR-150: writes the zip and copies its path
    catch (e) { setError((e as { code?: string }).code ?? 'EM-9006'); }
  };
  return (
    <Modal el="scr.diagnostics" sheet width={640} title={t('ui.scr.diagnostics.title')} onClose={onClose}
      footer={<Button variant="primary" onClick={() => void makeBundle()}>{t('ui.scr.diagnostics.bundle')}</Button>}>
      <div data-el="scr.diagnostics.licence" className="mb-2 flex flex-wrap items-center gap-2 rounded-[6px] border border-em-line px-2 py-1">
        <span className="t-label">{t('ui.scr.diagnostics.licence')}</span><span>{t(`ui.scr.license.status.${lic.status}`)}</span>{lic.code && <span className="t-mono text-em-muted">{lic.code}</span>}
        {lic.clock && <span className="t-mono text-em-muted">EM-5007</span>}<span className="flex-1" />
        {state.settings?.privateMode && <span data-el="scr.diagnostics.private" className="flex items-center gap-1 text-em-private"><ShieldCheck size={14} />{t('ui.scr.diagnostics.private')}</span>}
      </div>
      <div role="tablist" className="mb-2 flex gap-2">
        {(['logs', 'events', 'versions', 'hardware'] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={tab === k ? 'border-b-2 border-em-accent' : 'text-em-muted'}>{t(`ui.scr.diagnostics.tab.${k}`)}</button>)}
      </div>
      {tab === 'logs' && <pre className="t-mono max-h-80 overflow-auto rounded-[6px] bg-em-bg p-2 text-[11px] whitespace-pre-wrap">{lines.join('\n') || '—'}</pre>}
      {tab === 'events' && (
        <table data-el="scr.diagnostics.codes" className="w-full text-[12px]"><tbody>
          {codes.length === 0 && <tr><td className="text-em-muted">{t('ui.scr.diagnostics.codes.none')}</td></tr>}
          {codes.map((c, i) => <tr key={`${c.code}-${c.ref ?? i}`}><td className="t-mono pr-2 text-em-muted">{new Date(c.at).toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB')}</td><td className="t-mono pr-2">{c.code}</td><td className="pr-2">{t(`err.${c.code}.title`)}</td><td className="t-mono text-em-muted">{c.source}{c.ref ? ` · ${c.ref}` : ''}</td></tr>)}
        </tbody></table>
      )}
      {tab === 'versions' && <dl className="grid grid-cols-[auto_1fr] gap-x-3 t-mono"><dt>app</dt><dd>{h?.version ?? '—'}</dd><dt>build</dt><dd>{h?.buildDate ?? '—'}</dd><dt>mode</dt><dd>{h?.mode ?? '—'}</dd><dt>engine</dt><dd>{h?.engine?.bundleVersion ?? '—'}{h?.engine?.code ? ` · ${h.engine.code}` : ''}</dd><dt>remotion</dt><dd>{h?.engine?.remotionVersion ?? '—'}</dd><dt>db</dt><dd>{h?.db?.schemaVersion ?? '—'}</dd><dt>runtime</dt><dd>{runtimeLabel(runtime.mode)}</dd></dl>}
      {tab === 'hardware' && <dl className="grid grid-cols-[auto_1fr] gap-x-3 t-mono"><dt>tier</dt><dd>{state.hardware?.tier}</dd><dt>cpu</dt><dd>{state.hardware?.cpuModel} · {state.hardware?.cpuThreads}</dd><dt>ram</dt><dd>{formatBytes((state.hardware?.ramTotalMb ?? 0) * 1e6, lang)}</dd><dt>gpu</dt><dd>{state.hardware?.gpuModel ?? '—'}</dd></dl>}
      <p className="mt-2 text-[12px] text-em-muted">{t('ui.scr.diagnostics.redacted')}</p>
      {error && <ErrorBox code={error} />}
      {bundle && (
        <div data-el="scr.diagnostics.bundle.path" className="mt-2 flex items-center gap-2">
          <code className="t-mono flex-1 truncate select-all">{bundle.path} · {formatBytes(bundle.bytes, lang)}</code>
          <Button size={28} icon={<Copy size={14} />} onClick={() => copyPath(bundle.path)}>{copied ? t('ui.common.copied') : t('ui.common.copy')}</Button>
          <Button size={28} variant="ghost" onClick={() => void window.expertmotion?.openFolder?.(bundle.path)}>{t('ui.scr.export.openfolder')}</Button>
        </div>
      )}
    </Modal>
  );
}
const runtimeLabel = (m: string) => (m === 'mock' ? 'mock (VITE_EM_MOCK=1)' : 'local service');

/** FR-151: every bundled Engine Binary and font family with its licence (full texts: THIRD_PARTY_NOTICES.txt, scripts/stage-desktop.mjs). */
export const BUNDLED_NOTICES: ReadonlyArray<{ name: string; licence: string; gpl?: boolean }> = [
  { name: 'Remotion (engine, renderer, player)', licence: 'Remotion License' },
  { name: 'Chrome Headless Shell (Chromium)', licence: 'BSD-3-Clause and others' },
  { name: 'FFmpeg n7.1 in the Remotion compositor (libx264, libfdk-aac)', licence: 'GPL-2.0-or-later build', gpl: true },
  { name: 'FFmpeg for import (resources/bin)', licence: 'LGPL-2.1-or-later' },
  { name: 'whisper.cpp (captions)', licence: 'MIT' },
  { name: 'sherpa-onnx (voices)', licence: 'Apache-2.0' },
  { name: 'espeak-ng phonemiser inside sherpa-onnx', licence: 'GPL-3.0-or-later', gpl: true },
  { name: 'stable-diffusion.cpp (thumbnails)', licence: 'MIT' },
  { name: 'ACE-Step (music, optional download)', licence: 'Apache-2.0' },
  { name: 'Design Preset fonts', licence: 'SIL Open Font License 1.1' },
  { name: 'Electron, React, Express, SQLite3 Multiple Ciphers', licence: 'MIT' },
];

/** QA UX round 1: the renderer's own platform, so About does not say "Windows account" on Linux / macOS. */
export function clientPlatform(): 'win32' | 'linux' | 'darwin' {
  const p = typeof navigator === 'undefined' ? '' : `${(navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /mac/i.test(p) ? 'darwin' : /linux|x11|ubuntu/i.test(p) && !/android/i.test(p) ? 'linux' : 'win32';
}

export function AboutScreen({ onClose }: { onClose: () => void }) {
  const { state, t } = useStore();
  const os = clientPlatform();
  const lic = licenceView(state.licence);
  return (
    <Modal el="scr.about" width={520} title={t('ui.scr.about.title')} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <div className="text-[24px] font-bold">Expertmotion</div>
        <div className="t-mono text-em-muted">{state.health?.version ?? '—'}</div>
        <div data-el="scr.about.builddate" className="t-mono text-[12px] text-em-muted">{t('ui.scr.about.builddate', { date: state.health?.buildDate ?? '—' })}</div>
        <div>{lic.status === 'licensed' ? t(lic.bodyKey, lic.vars) : `${t(`ui.scr.license.status.${lic.status}`)} · ${t(lic.bodyKey, lic.vars)}`}</div>
        <p data-el="scr.about.remotion" className="text-[12px] text-em-text-2">{t('ui.scr.about.remotion')}</p>
        {/* Operator 2026-10-26 (less wordy): the component list is collapsed; the GPL source offer below stays visible. */}
        <details><summary className="cursor-pointer">{t('ui.scr.about.notices')}</summary>
          <p className="mt-1 text-[12px] text-em-muted">{t('ui.scr.about.notices.body')}</p>
          <ul data-el="scr.about.notices.list" className="mt-1 flex flex-col gap-0.5 text-[12px]">
            {BUNDLED_NOTICES.map((n) => <li key={n.name} className="flex gap-2"><span className="flex-1">{n.name}</span><span className="t-mono text-em-muted">{n.licence}</span></li>)}
          </ul>
          <p className="mt-1 text-[12px] text-em-muted">{t('ui.scr.about.notices.file')}</p>
        </details>
        <p data-el="scr.about.gpl" className="rounded-[6px] border border-em-line p-2 text-[12px] text-em-text-2">{t('ui.scr.about.gpl')}</p>
        {/* FR-176 / ADR-006: the honest boundary statement (SECURITY.md §1) — never "unreadable" or "cannot be reverse-engineered" */}
        <p data-el="scr.about.security" className="rounded-[6px] border border-em-line p-2 text-[12px] text-em-text-2">{t(os === 'linux' ? 'ui.scr.about.security.linux' : os === 'darwin' ? 'ui.scr.about.security.mac' : 'ui.scr.about.security')}</p>
        <details><summary className="cursor-pointer">{t('ui.scr.about.limitations')}</summary><p className="mt-1 text-[12px] text-em-muted">{t('ui.scr.about.limitations.body.now')}</p></details>
        {state.settings?.privateMode && <p className="text-em-private">{t('ui.scr.about.updatespaused')}</p>}
      </div>
    </Modal>
  );
}

/** FR-148: the offline help ships inside the Editor build; the online documentation is a link (EM-8202 copyable URL in Private Mode). */
export const HELP_SECTIONS = ['start', 'import', 'design', 'agents', 'export', 'performance', 'private', 'licence', 'trouble'] as const;
/** FR-091: `topic` opens and scrolls to one section (Output Settings ▸ profile ▸ Learn more → `performance`). */
export function HelpScreen({ onClose, topic }: { onClose: () => void; topic?: (typeof HELP_SECTIONS)[number] }) {
  const { actions, setPrefs, t } = useStore();
  const open = topic ?? 'start';
  useEffect(() => { if (topic) document.querySelector(`[data-help-section="${topic}"]`)?.scrollIntoView?.({ block: 'start' }); }, [topic]);
  return (
    <Modal el="scr.help" sheet width={600} title={t('ui.scr.help.title')} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={() => { onClose(); setPrefs({ tourDone: false }); window.dispatchEvent(new CustomEvent('em:tour', { detail: { source: 'help' } })); }}>{t('ui.hdr.menu.help.tour')}</Button>
        <Button variant="ghost" onClick={() => actions.setScreen({ kind: 'shortcuts' })}>{t('ui.hdr.menu.help.shortcuts')}</Button>
        <Button variant="ghost" onClick={() => actions.setScreen({ kind: 'diagnostics' })}>{t('ui.hdr.menu.help.diagnostics')}</Button>
      </>}>
      <p className="mb-3 text-em-text-2">{t('ui.scr.help.offline')}</p>
      {/* QA UX round 1: the AI chat is the main way to work, so Help starts there */}
      <div data-el="scr.help.ai" className="mb-3 flex flex-col gap-2 rounded-[8px] border border-em-accent/60 bg-em-accent/10 p-3">
        <span className="font-semibold">{t('ui.scr.help.ai.title')}</span>
        <p className="text-[13px] text-em-text-2">{t('ui.scr.help.ai.body')}</p>
        <div><Button el="scr.help.ai.open" variant="primary" size={28} onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: { agent: 'editor' } })); }}>{t('ui.scr.help.ai.open')}</Button></div>
      </div>
      <div data-el="scr.help.sections" className="flex flex-col gap-2">
        {HELP_SECTIONS.map((k) => (
          <details key={k} data-help-section={k} open={k === open} className="rounded-[6px] border border-em-line px-2 py-1">
            <summary className="cursor-pointer font-semibold">{t(`ui.scr.help.${k}.title`)}</summary>
            <p className="mt-1 whitespace-pre-line text-[13px] text-em-text-2">{t(`ui.scr.help.${k}.body`)}</p>
            {k === 'performance' && <ProfileTable />}
          </details>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-1">
        <span className="t-label">{t('ui.scr.help.online.label')}</span>
        <ExternalLink el="scr.help.online" url={DOCS_URL} label={DOCS_URL} action={t('ui.scr.help.online.label')} />
      </div>
    </Modal>
  );
}

export function BackupDialog({ mode, onClose }: { mode: 'backup' | 'restore'; onClose: () => void }) {
  const { state, runtime, actions, dispatch, t, lang } = useStore();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [plain, setPlain] = useState(false);
  const [includeOutputs, setIncludeOutputs] = useState(false);
  const [file, setFile] = useState('');
  const [error, setError] = useState<string | null>(null);
  // FR-017: Creator-chosen location (defaults to the output folder) and a size estimate from R-026 (originals + JSON, Outputs optional).
  const [folder, setFolder] = useState(state.settings?.outputFolder ?? '');
  const [usage, setUsage] = useState<DiskUsageDto | null>(null);
  // FR-314 (QA 2026-10-31 "saya tidak tau tersimpan dimana"): the Service reports no backup default of its own — the folder field starts
  // at the app's output folder (R-002), which is the only default known here; the result row shows the real path the Service wrote.
  const defaultFolder = state.settings?.outputFolder?.trim() || null;
  const shell = typeof window !== 'undefined' ? window.expertmotion : undefined;
  const [copied, setCopied] = useState(false);
  const pid = state.project?.id;
  useEffect(() => { if (mode === 'backup' && pid) runtime.api.diskUsage(pid).then(setUsage).catch(() => setUsage(null)); }, [mode, pid, runtime]);
  const est = usage?.items[0] ? usage.items[0].backupBytes + (includeOutputs ? usage.items[0].backupOutputsBytes : 0) : null;
  const tooBig = est !== null && usage !== null && est > usage.freeBytes;
  const job = state.backupJob?.mode === mode ? state.backupJob : null;
  const passOk = plain || (pass.length >= 8 && pass === pass2);
  const backup = async () => {
    if (!state.project) return;
    setError(null);
    try {
      const r = await runtime.api.backupProject(state.project.id, { folder: folder.trim(), ...(plain ? {} : { passphrase: pass }), includeOutputs });
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
        : mode === 'backup' ? <Button el="scr.backup.backup.start" variant="primary" loading={Boolean(job)} disabledReason={!folder.trim() ? t('ui.scr.backup.folder.required') : passOk ? null : t('ui.scr.backup.passphrase.mismatch')} onClick={() => void backup()}>{t('ui.scr.backup.start')}</Button>
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
          <Field label={t('ui.scr.backup.folder')} htmlFor="em-bk-folder">
            <div className="flex gap-2"><input id="em-bk-folder" data-el="scr.backup.backup.folder" className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} />
              <Button onClick={() => void window.expertmotion?.pickFolder?.(folder ? { defaultPath: folder } : {}).then((f) => { if (f) setFolder(f); })}>{t('ui.scr.project.open.browse')}</Button></div>
          </Field>
          {defaultFolder && <p data-el="scr.backup.backup.folder.default" className="text-[12px] text-em-muted">{t('ui.scr.backup.folder.default', { path: defaultFolder })}</p>}
          {est !== null && usage && <p data-el="scr.backup.backup.estimate" className={tooBig ? 'text-[12px] text-em-danger' : 'text-[12px] text-em-muted'}>{t(tooBig ? 'ui.scr.backup.estimate.toobig' : 'ui.scr.backup.estimate', { size: formatBytes(est, lang), free: formatBytes(usage.freeBytes, lang) })}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Field label={t('ui.scr.restore.file')} htmlFor="em-rs-f">
            <div className="flex gap-2"><input id="em-rs-f" data-el="scr.backup.restore.file" className={inputCls} value={file} onChange={(e) => setFile(e.target.value)} placeholder="…\\project.emproj" />
              <Button onClick={() => void window.expertmotion?.pickFiles?.({ filters: [{ name: 'Expertmotion backup', extensions: ['emproj', 'zip'] }], multiple: false }).then((p) => { if (p[0]) setFile(p[0]); })}>{t('ui.scr.project.open.browse')}</Button></div>
          </Field>
          <Field label={t('ui.scr.restore.passphrase')} htmlFor="em-rs-p"><input id="em-rs-p" data-el="scr.backup.restore.passphrase" type="password" className={inputCls} value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
          <p className="text-[12px] text-em-muted">{t('ui.scr.restore.note')}</p>
        </div>
      )}
      {job && <div data-el="scr.backup.progress" className="mt-2 flex flex-col gap-1"><Progress value={job.percent / 100} label={t('ui.scr.backup.progress')} /><span className="text-[12px] text-em-muted">{job.done ? (job.path ? t('ui.scr.backup.done', { path: job.path }) : t('ui.scr.restore.done')) : `${job.percent} %`}</span></div>}
      {job?.done && job.mode === 'backup' && job.path && (
        // FR-314: the full path, copyable, with Open folder (Shell bridge only) and Copy path — the toast above stays.
        <div data-el="scr.backup.result" role="status" className="mt-2 flex flex-col gap-1 rounded-[6px] border-l-2 border-em-info bg-em-panel-2 px-2 py-1.5 text-[12px]">
          <span className="font-semibold">{t('ui.scr.backup.result.title')}</span>
          <code data-el="scr.backup.result.path" className="t-mono select-all break-all text-[11px] text-em-text-2">{job.path}</code>
          <div className="flex gap-2">
            {shell?.openFolder && <Button el="scr.backup.result.open" size={28} onClick={() => void shell.openFolder?.(job.path!)}>{t('ui.scr.export.openfolder')}</Button>}
            <Button el="scr.backup.result.copy" size={28} icon={<Copy size={14} />} onClick={() => void copyText(job.path!).then((ok) => { if (ok) setCopied(true); })}>{copied ? t('ui.common.copied') : t('ui.scr.backup.result.copy')}</Button>
          </div>
        </div>
      )}
      {job?.done && job.mode === 'restore' && job.code === 'EM-6303' && (
        // FR-018: a project with the same identity exists, so the backup became a renamed copy; nothing was overwritten.
        <div data-el="scr.backup.restore.renamed" data-code="EM-6303" role="status" className="mt-2 flex flex-col gap-1 rounded-[6px] border-l-2 border-em-info bg-em-panel-2 px-2 py-1.5 text-[12px]">
          <span className="font-semibold">{t('err.EM-6303.title')} <span className="t-mono text-[11px] text-em-muted">EM-6303</span></span>
          <span className="text-em-text-2">{t('err.EM-6303.body', { name: (job.name ?? '').replace(/ \(restored( \d+)?\)$/, '') })}</span>
          {job.projectId && <div><Button el="scr.backup.restore.open" size={28} onClick={() => { void actions.openProject(job.projectId!); onClose(); }}>{t('err.EM-6303.action')}</Button></div>}
        </div>
      )}
      {error && <ErrorBox code={error} />}
    </Modal>
  );
}

/** FR-153 shortcut sheet (`?`): redo shown as Ctrl+Shift+Z (Ctrl+Y also works); Ctrl+Enter sends the chat message. */
export const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'ui.key.play'], ['← / →', 'ui.key.frame'], ['Shift+← / →', 'ui.key.second'], ['Home / End', 'ui.key.startend'], ['Ctrl+S', 'ui.key.save'], ['Ctrl+Z / Ctrl+Shift+Z', 'ui.key.undoredo'],
  ['Ctrl+Enter', 'ui.key.send'], ['Esc', 'ui.key.escape'], ['/', 'ui.key.search'], ['1 / 2 / 3', 'ui.key.modes'], ['Ctrl+E', 'ui.key.export'], ['Ctrl+I', 'ui.key.import'],
  ['Ctrl+N / Ctrl+O', 'ui.key.newopen'], ['A', 'ui.key.ask'], ['Delete / Backspace', 'ui.key.delete'], ['Shift+F10', 'ui.key.menu'], ['Ctrl+C / Ctrl+X / Ctrl+V', 'ui.key.clipboard'], ['Ctrl+R / F5', 'ui.key.reload'], ['Ctrl+Shift+L', 'ui.key.logs'], ['F', 'ui.key.fullscreen'], ['Ctrl+B / Ctrl+Shift+B', 'ui.key.panels'], ['Shift+?', 'ui.key.sheet'],
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
