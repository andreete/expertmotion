// Project dialogs (scr.project.new / .open / .settings / .recover), Custom ratio (scr.ratio.custom), Version history (scr.history).
// FR-009 New (duration policy, output folder), FR-010 Open (thumbnail, last modified, disk usage), FR-013 Save As (duplicate),
// FR-015 Settings (Edit Intents via R-018), FR-016 Recovery (hash, size), FR-178 Delete (typed name with Outputs, keep Outputs).
import { useEffect, useState } from 'react';
import { Film, Trash2 } from 'lucide-react';
import { FPS_VALUES, RATIOS, RESOLUTIONS, type Ratio, type Resolution } from '@expertmotion/composition-model';
import { resolveDimensions } from '@expertmotion/engine/formats';
import { outputDefaults, useStore } from '../state/store.js';
import type { CheckpointDto, DiskUsageDto, Fps, ProjectDto, ProjectSettingsExtras, VersionDto } from '../api/types.js';
import { Button, Empty, Field, IconButton, Modal, Spinner, inputCls, cx } from '../components/ui.js';
import { formatBytes, formatDate, formatDuration, type Lang } from '../i18n/index.js';
import { guardUnsaved } from './Lifecycle.js';
import { withoutScratch } from '../startup/scratch.js';
import { channelProfileRatio } from '../agent/reels.js';

const MIN_FIXED_S = 1, MAX_FIXED_S = 1800;     // FR-015: fixed duration 1 s … 30 min

/** Duration policy select plus the fixed length in seconds (FR-009, FR-015). */
function DurationFields({ prefix, el, policy, setPolicy, seconds, setSeconds }: { prefix: string; el: string; policy: DurationPolicy; setPolicy: (p: DurationPolicy) => void; seconds: string; setSeconds: (s: string) => void }) {
  const { t } = useStore();
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label={t('ui.scr.project.duration.policy')} htmlFor={`${prefix}-dur`} hint={t('ui.scr.project.duration.note')}>
        <select id={`${prefix}-dur`} data-el={`${el}.duration.policy`} className={inputCls} value={policy} onChange={(e) => setPolicy(e.target.value as DurationPolicy)}>
          <option value="fit-content">{t('ui.scr.project.duration.fit')}</option><option value="fixed">{t('ui.scr.project.duration.fixed')}</option>
        </select>
      </Field>
      {policy === 'fixed' && (
        <Field label={t('ui.scr.project.duration.seconds')} htmlFor={`${prefix}-dur-s`}>
          <input id={`${prefix}-dur-s`} data-el={`${el}.duration.fixed`} type="number" min={MIN_FIXED_S} max={MAX_FIXED_S} step={1} className={inputCls} value={seconds} onChange={(e) => setSeconds(e.target.value)} />
        </Field>
      )}
    </div>
  );
}
type DurationPolicy = 'fit-content' | 'fixed';
const fixedMsOf = (seconds: string): number | null => { const n = Math.round(Number(seconds)); return Number.isFinite(n) && n >= MIN_FIXED_S && n <= MAX_FIXED_S ? n * 1000 : null; };

function FolderField({ id, el, value, onChange, placeholder }: { id: string; el: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const { t } = useStore();
  return (
    <Field label={t('ui.scr.project.output.folder')} htmlFor={id} hint={t('ui.scr.project.output.folder.hint')}>
      <div className="flex gap-2"><input id={id} data-el={el} className={inputCls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        <Button onClick={() => void window.expertmotion?.pickFolder?.(value ? { defaultPath: value } : {}).then((f) => { if (f) onChange(f); })}>{t('ui.scr.project.open.browse')}</Button></div>
    </Field>
  );
}

export function NewProjectDialog({ onClose, saveAs }: { onClose: () => void; saveAs?: boolean }) {
  const { state, actions, runtime, t } = useStore();
  const [name, setName] = useState(saveAs && state.project ? `${state.project.name} copy` : t('ui.hdr.title.untitled'));
  const [fps, setFps] = useState<Fps>(state.settings?.defaultFps ?? 30);
  // FR-009: the New dialog defaults to 9:16 (or the Settings default ratio); Auto stays an explicit choice.
  // FR-28x: a channel profile that names Reels / Shorts / TikTok / 9:16 (or 16:9) wins over the Settings default for new projects.
  const channelRatio = channelProfileRatio(state.settings?.channelProfile);
  const [ratio, setRatio] = useState<Ratio | 'auto'>(channelRatio ?? outputDefaults(state).ratio);
  const [resolution, setResolution] = useState<Resolution>(state.settings?.defaultResolution ?? '1080p');
  // QA UX round 1: Custom ratio right here (same 1:3…3:1 bounds as scr.ratio.custom)
  const [cw, setCw] = useState('2'); const [ch, setCh] = useState('3');
  const cwn = Math.round(Number(cw)), chn = Math.round(Number(ch));
  const customOk = cwn >= 1 && chn >= 1 && cwn / chn <= 3 && chn / cwn <= 3;
  const [policy, setPolicy] = useState<DurationPolicy>('fit-content');
  const [seconds, setSeconds] = useState('15');
  const defaultFolder = state.settings?.outputFolder ?? '';
  const [folder, setFolder] = useState(defaultFolder);
  const fixedMs = policy === 'fixed' ? fixedMsOf(seconds) : null;
  const reason = !name.trim() ? t('ui.hdr.title.error') : policy === 'fixed' && fixedMs === null ? t('ui.scr.project.duration.range') : ratio === 'custom' && !saveAs && !customOk ? t('ui.scr.ratio.custom.clamp') : null;
  const create = async () => {
    if (reason) return;
    if (saveAs && state.project) {
      // FR-013: Save As duplicates the open Project (R-019) and switches to the copy; the original is untouched.
      try { const p = await runtime.api.duplicateProject(state.project.id, name.trim()); await actions.openProject(p.id); onClose(); } catch (e) { actions.error(e); }
      return;
    }
    const created = await actions.createProject({
      name: name.trim(), settings: { fps, resolution, ...(ratio === 'auto' ? { autoRatio: true, ratio: state.settings?.defaultRatio ?? '9:16' } : ratio === 'custom' ? { ratio: state.settings?.defaultRatio ?? '9:16', autoRatio: false } : { ratio, autoRatio: false }) },
      ...(policy === 'fixed' && fixedMs !== null ? { durationPolicy: 'fixed' as const, fixedDurationMs: fixedMs } : {}),
      ...(folder.trim() && folder.trim() !== defaultFolder ? { outputFolder: folder.trim() } : {}),
    });
    // Custom: the same Output Settings pick as scr.ratio.custom, on the new project (project creation takes pixel sizes ≥ 240 only)
    if (created && ratio === 'custom' && customOk) await actions.layoutPick({ ratio: 'custom', customRatio: { w: cwn, h: chn } });
    onClose();
  };
  return (
    <Modal el="scr.project.new" width={460} title={saveAs ? t('ui.hdr.menu.file.saveas') : t('ui.scr.project.new.title')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button><Button el={saveAs ? 'scr.project.saveas.create' : 'scr.project.new.create'} variant="primary" disabledReason={reason} onClick={() => void create()}>{saveAs ? t('ui.scr.project.saveas.create') : t('ui.scr.project.new.create')}</Button></>}>
      <Field label={t('ui.scr.project.name')} htmlFor="em-new-name"><input id="em-new-name" data-el="scr.project.new.name" className={inputCls} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} /></Field>
      {saveAs && <p className="text-[12px] text-em-muted">{t('ui.scr.project.saveas.note')}</p>}
      {!saveAs && <>
        <Field label={t('ui.scr.project.fps')} htmlFor="em-new-fps"><select id="em-new-fps" data-el="scr.project.new.fps" className={inputCls} value={fps} onChange={(e) => setFps(Number(e.target.value) as Fps)}>{FPS_VALUES.map((f) => <option key={f} value={f}>{f} fps</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('ui.scr.project.ratio')} htmlFor="em-new-ratio" {...(channelRatio && ratio === channelRatio ? { hint: <span data-el="scr.project.new.ratio.channel">{t('ui.scr.project.ratio.channel')}</span> } : {})}><select id="em-new-ratio" data-el="scr.project.new.ratio" className={inputCls} value={ratio} onChange={(e) => setRatio(e.target.value as Ratio | 'auto')}><option value="auto">{t('ui.agent.output.ratio.auto')}</option>{RATIOS.map((r) => <option key={r} value={r}>{r === 'custom' ? t('ui.agent.output.ratio.custom') : r}</option>)}</select></Field>
          <Field label={t('ui.scr.project.resolution')} htmlFor="em-new-res"><select id="em-new-res" data-el="scr.project.new.resolution" className={inputCls} value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>{RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
        </div>
        {ratio === 'custom' && (
          <div data-el="scr.project.new.customratio" className="grid grid-cols-2 gap-2">
            <Field label={t('ui.scr.ratio.custom.width')} htmlFor="em-new-cw"><input id="em-new-cw" data-el="scr.project.new.customratio.width" type="number" min={1} className={inputCls} value={cw} onChange={(e) => setCw(e.target.value)} /></Field>
            <Field label={t('ui.scr.ratio.custom.height')} htmlFor="em-new-ch"><input id="em-new-ch" data-el="scr.project.new.customratio.height" type="number" min={1} className={inputCls} value={ch} onChange={(e) => setCh(e.target.value)} /></Field>
            {!customOk && <p className="col-span-2 text-[12px] text-em-danger">{t('ui.scr.ratio.custom.clamp')}</p>}
          </div>
        )}
        <DurationFields prefix="em-new" el="scr.project.new" policy={policy} setPolicy={setPolicy} seconds={seconds} setSeconds={setSeconds} />
        <FolderField id="em-new-folder" el="scr.project.new.output.folder" value={folder} onChange={setFolder} placeholder={t('ui.scr.project.output.folder.default')} />
      </>}
    </Modal>
  );
}

/** FR-010: project thumbnail (R-027), fetched with the Service Token and shown from a blob URL. */
export function ProjectThumb({ id }: { id: string }) {
  const { runtime } = useStore();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, made: string | null = null;
    void runtime.api.projectThumbnail(id).then((b) => { if (alive && b) { made = URL.createObjectURL(b); setUrl(made); } });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [id, runtime]);
  return (
    <span data-el="scr.project.open.thumb" className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-em-line bg-em-bg">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <Film size={16} className="text-em-muted" aria-hidden />}
    </span>
  );
}

export function OpenProjectDialog({ onClose }: { onClose: () => void }) {
  const { state, actions, runtime, dispatch, t, lang } = useStore();
  const [items, setItems] = useState<ProjectDto[] | null>(null);
  const [usage, setUsage] = useState<DiskUsageDto | null>(null);
  const [confirm, setConfirm] = useState<ProjectDto | null>(null);
  const [typed, setTyped] = useState('');
  const [keepOutputs, setKeepOutputs] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);              // FR-186: "Membuka proyek…" on the chosen row
  const load = () => {
    void runtime.api.listProjects({ limit: 200 }).then((p) => setItems(withoutScratch(p.items))).catch((e) => { actions.error(e); setItems([]); });   // FR-260
    void runtime.api.diskUsage().then(setUsage).catch(() => setUsage(null));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const use = (id: string) => usage?.items.find((u) => u.projectId === id);
  const pick = (p: ProjectDto) => {
    if (p.id === state.project?.id) { onClose(); return; }
    // FR-174: switching away from unsaved UI state asks first (the prompt replaces this dialog).
    if (opening) return;
    if (state.project?.dirty) { guardUnsaved({ state, actions }, () => { void actions.openProject(p.id); actions.setScreen(null); }); return; }
    setOpening(p.id);
    void actions.openProject(p.id).finally(() => { setOpening(null); onClose(); });
  };
  const del = async (p: ProjectDto) => {
    try {
      await runtime.api.deleteProject(p.id, { permanent: true, keepOutputs });
      setConfirm(null); setTyped(''); setKeepOutputs(true);
      if (p.id === state.project?.id) { dispatch({ type: 'projectClosed' }); void actions.openBlankProject(); }   // FR-260: an empty project, not the Start screen
      actions.toast('success', 'ui.scr.project.open.deleted', { name: p.name });
      load();
    } catch (e) { actions.error(e); }
  };
  const needsTyping = (p: ProjectDto) => (use(p.id)?.outputCount ?? 0) > 0;
  return (
    <Modal el="scr.project.open" title={t('ui.scr.project.open.title')} onClose={onClose}
      footer={<>
        {usage && <span data-el="scr.project.open.usage.total" className="mr-auto text-[12px] text-em-muted">{t('ui.scr.project.open.usage.total', { total: formatBytes(usage.totalBytes, lang), free: formatBytes(usage.freeBytes, lang) })}</span>}
        <Button onClick={() => void window.expertmotion?.pickFolder?.()}>{t('ui.scr.project.open.browse')}</Button>
      </>}>
      <ul data-el="scr.project.open.list" className="flex flex-col gap-1">
        {items === null && <li className="text-em-muted">{t('ui.common.loading')}</li>}
        {items?.length === 0 && <li><Empty title={t('ui.scr.project.open.empty')} /></li>}
        {items?.map((p) => (
          <li key={p.id} className={cx('flex items-center gap-2 rounded-[6px] border px-2 py-1.5', p.id === state.project?.id ? 'border-em-accent' : 'border-em-line')}>
            <button type="button" className="flex flex-1 items-center gap-2 text-left" onClick={() => pick(p)}>
              <ProjectThumb id={p.id} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{p.name}</span>
                <span className="text-[11px] text-em-muted">{t('ui.scr.project.open.modified', { date: formatDate(p.updatedAt, lang as Lang) })} · {formatDuration(p.durationMs)} · {t('ui.scr.project.open.assets', { count: p.assetCount })}</span>
              </span>
              {opening === p.id ? <span data-el="scr.project.open.opening" role="status" className="shrink-0 text-[12px]"><Spinner size={14} label={t('ui.scr.project.open.opening')} /></span>
                : use(p.id) && <span data-el="scr.project.open.usage" className="t-mono shrink-0 text-[11px] text-em-muted">{formatBytes(use(p.id)!.totalBytes, lang)}</span>}
            </button>
            <IconButton el="scr.project.open.delete" label={t('ui.scr.project.open.delete', { name: p.name })} icon={<Trash2 size={14} />} size={28} onClick={() => { setConfirm(p); setTyped(''); setKeepOutputs(true); }} />
          </li>
        ))}
      </ul>
      {confirm && (
        <div role="alertdialog" aria-label={t('ui.scr.project.open.delete', { name: confirm.name })} className="mt-3 rounded-[8px] border border-em-danger p-2">
          <p className="mb-2">{t('ui.scr.project.open.delete.confirm', { name: confirm.name })}</p>
          {(use(confirm.id)?.outputCount ?? 0) > 0 && (
            <label className="mb-2 flex items-center gap-2">
              <input type="checkbox" data-el="scr.project.open.delete.keepoutputs" checked={keepOutputs} onChange={(e) => setKeepOutputs(e.target.checked)} />
              <span>{t('ui.scr.project.open.delete.keepoutputs', { count: use(confirm.id)?.outputCount ?? 0 })}</span>
            </label>
          )}
          {needsTyping(confirm) && <input aria-label={t('ui.scr.project.open.delete.type')} placeholder={confirm.name} value={typed} onChange={(e) => setTyped(e.target.value)} className={cx(inputCls, 'mb-2')} />}
          <div className="flex gap-2">
            <Button el="scr.project.open.delete.confirm" variant="danger" disabledReason={!needsTyping(confirm) || typed === confirm.name ? null : t('ui.scr.project.open.delete.type')} onClick={() => void del(confirm)}>{t('ui.common.delete')}</Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('ui.common.cancel')}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function ProjectSettingsDialog({ onClose }: { onClose: () => void }) {
  const { state, actions, runtime, t, lang } = useStore();
  const s = state.head?.model?.settings ?? state.project?.settings;
  const [name, setName] = useState(state.project?.name ?? '');
  const [fps, setFps] = useState<Fps>((s?.fps ?? 30) as Fps);
  const [ratio, setRatio] = useState<Ratio>(s?.ratio ?? '16:9');
  const [res, setRes] = useState<Resolution>(s?.resolution ?? '1080p');
  const [projLang, setProjLang] = useState<'id' | 'en'>(s?.language ?? 'id');
  const [uiLang, setUiLang] = useState<Lang>(lang);
  const [folder, setFolder] = useState<string | null>(null);              // null until R-017 answered
  const [policy, setPolicy] = useState<DurationPolicy>(state.head?.model?.durationPolicy ?? 'fit-content');
  const [seconds, setSeconds] = useState(String(Math.round((state.head?.model?.fixedDurationMs ?? 15_000) / 1000)));
  const pid = state.project?.id;
  useEffect(() => {
    if (!pid) return;
    runtime.api.getProjectSettings(pid).then((x) => setFolder((x as ProjectSettingsExtras).outputFolder ?? '')).catch(() => setFolder(''));
  }, [pid, runtime]);
  const fixedMs = policy === 'fixed' ? fixedMsOf(seconds) : null;
  const save = async () => {
    if (!pid || !s) return;
    if (name.trim() && name.trim() !== state.project?.name) await actions.renameProject(name.trim());
    // FR-015: fps, ratio/resolution and duration policy go through R-018, which records them as Edit Intents compiled into ops.
    try {
      await runtime.api.putProjectSettings(pid, { ...s, fps, ratio, resolution: res, language: projLang, durationPolicy: policy, ...(policy === 'fixed' && fixedMs !== null ? { fixedDurationMs: fixedMs } : {}),
        ...(folder !== null ? { outputFolder: folder.trim() || null } : {}) });
      await actions.refreshHead();
    } catch (e) { actions.error(e); return; }
    if (uiLang !== lang) await actions.setLanguage(uiLang);
    onClose();
  };
  const reason = policy === 'fixed' && fixedMs === null ? t('ui.scr.project.duration.range') : null;
  return (
    <Modal el="scr.project.settings" title={t('ui.scr.project.settings.title')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button><Button variant="primary" disabledReason={reason} onClick={() => void save()}>{t('ui.common.save')}</Button></>}>
      <Field label={t('ui.scr.project.name')} htmlFor="em-ps-name"><input id="em-ps-name" data-el="scr.project.settings.name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('ui.scr.project.fps')} htmlFor="em-ps-fps" hint={t('ui.scr.project.fps.note')}><select id="em-ps-fps" data-el="scr.project.settings.fps" className={inputCls} value={fps} onChange={(e) => setFps(Number(e.target.value) as Fps)}>{FPS_VALUES.map((f) => <option key={f} value={f}>{f} fps</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('ui.scr.project.ratio')} htmlFor="em-ps-ratio"><select id="em-ps-ratio" data-el="scr.project.settings.ratio" className={inputCls} value={ratio} onChange={(e) => setRatio(e.target.value as Ratio)}>{RATIOS.filter((r) => r !== 'custom' || s?.customRatio).map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
        <Field label={t('ui.scr.project.resolution')} htmlFor="em-ps-res"><select id="em-ps-res" data-el="scr.project.settings.resolution" className={inputCls} value={res} onChange={(e) => setRes(e.target.value as Resolution)}>{RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
      </div>
      <DurationFields prefix="em-ps" el="scr.project.settings" policy={policy} setPolicy={setPolicy} seconds={seconds} setSeconds={setSeconds} />
      <FolderField id="em-ps-folder" el="scr.project.settings.output.folder" value={folder ?? ''} onChange={setFolder} placeholder={state.settings?.outputFolder || t('ui.scr.project.output.folder.default')} />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('ui.scr.project.language')} htmlFor="em-ps-lang"><select id="em-ps-lang" data-el="scr.project.settings.language" className={inputCls} value={projLang} onChange={(e) => setProjLang(e.target.value as 'id' | 'en')}><option value="id">{t('ui.common.lang.id')}</option><option value="en">{t('ui.common.lang.en')}</option></select></Field>
        <Field label={t('ui.scr.project.uilanguage')} htmlFor="em-ps-uilang"><select id="em-ps-uilang" className={inputCls} value={uiLang} onChange={(e) => setUiLang(e.target.value as Lang)}><option value="en">{t('ui.common.lang.en')}</option><option value="id">{t('ui.common.lang.id')}</option></select></Field>
      </div>
    </Modal>
  );
}

export function RecoverDialog({ onClose }: { onClose: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  const [items, setItems] = useState<CheckpointDto[] | null>(null);
  useEffect(() => { if (state.project) runtime.api.listCheckpoints(state.project.id).then((r) => setItems(r.items)).catch(() => setItems([])); }, [state.project, runtime]);
  const restore = async (c: CheckpointDto) => {
    if (!state.project) return;
    try { await runtime.api.restoreCheckpoint(state.project.id, c.id); await actions.refreshHead(); actions.toast('success', 'ui.scr.project.recover.done'); onClose(); } catch (e) { actions.error(e); }
  };
  return (
    <Modal el="scr.project.recover" title={t('ui.scr.project.recover.title')} onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>{t('ui.scr.project.recover.openlast')}</Button>}>
      <ul data-el="scr.project.recover.list" className="flex flex-col gap-1">
        {items === null && <li className="text-em-muted">{t('ui.common.loading')}</li>}
        {items?.length === 0 && <li className="text-em-muted">{t('err.EM-6202.title')}</li>}
        {items?.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded-[6px] border border-em-line px-2 py-1.5">
            <span className="flex-1">{formatDate(c.createdAt, lang)} · {t(`ui.scr.project.recover.reason.${c.reason}`)} · {formatDuration(c.durationMs)}</span>
            {/* FR-016: version hash (the checkpoint's integrity hash) and file size */}
            {c.hash && <span data-el="scr.project.recover.hash" className="t-mono text-[11px] text-em-muted" title={c.hash}>v{c.hash.slice(0, 6)}</span>}
            {c.bytes !== undefined && <span className="t-mono text-[11px] text-em-muted">{formatBytes(c.bytes, lang)}</span>}
            <Button el="scr.project.recover.restore" size={28} onClick={() => void restore(c)}>{t('ui.scr.project.recover.restore')}</Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** FR-092: ratios beyond the seven buttons (all inside 1:3…3:1). */
export const EXTRA_RATIOS: ReadonlyArray<readonly [number, number]> = [[21, 9], [2, 1], [191, 100], [3, 2], [2, 3], [1, 2], [9, 21]];
export function CustomRatioDialog({ onClose }: { onClose: () => void }) {
  const { state, actions, t } = useStore();
  const cur = state.head?.model?.settings.customRatio;
  const [w, setW] = useState(String(cur?.w ?? 2));
  const [h, setH] = useState(String(cur?.h ?? 3));
  const wn = Math.round(Number(w)), hn = Math.round(Number(h));
  const valid = wn >= 1 && hn >= 1 && wn / hn <= 3 && hn / wn <= 3;
  const dims = valid ? resolveDimensions('custom', state.head?.model?.settings.resolution ?? '1080p', { w: wn, h: hn }) : null;
  return (
    <Modal el="scr.ratio.custom" width={420} title={t('ui.scr.ratio.custom.title')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button><Button el="scr.ratio.custom.apply" variant="primary" disabledReason={valid ? null : t('err.EM-2402.title')} onClick={() => { void actions.layoutPick({ ratio: 'custom', customRatio: { w: wn, h: hn } }); onClose(); }}>{t('ui.scr.ratio.custom.apply')}</Button></>}>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('ui.scr.ratio.custom.width')} htmlFor="em-cr-w"><input id="em-cr-w" data-el="scr.ratio.custom.width" type="number" min={1} className={inputCls} value={w} onChange={(e) => setW(e.target.value)} /></Field>
        <Field label={t('ui.scr.ratio.custom.height')} htmlFor="em-cr-h"><input id="em-cr-h" data-el="scr.ratio.custom.height" type="number" min={1} className={inputCls} value={h} onChange={(e) => setH(e.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('ui.scr.ratio.custom.presets')}>
        {EXTRA_RATIOS.map(([pw, ph]) => (
          <button key={`${pw}:${ph}`} type="button" data-el="scr.ratio.custom.preset" aria-pressed={wn === pw && hn === ph} onClick={() => { setW(String(pw)); setH(String(ph)); }}
            className={cx('t-mono rounded-[6px] border px-1.5 py-0.5 text-[11px]', wn === pw && hn === ph ? 'border-em-accent text-em-accent' : 'border-em-line text-em-text-2 hover:border-em-line-strong')}>{pw}:{ph}</button>
        ))}
      </div>
      <div data-el="scr.ratio.custom.preview" className="flex h-40 items-center justify-center rounded-[8px] border border-em-line bg-em-bg">
        {dims ? <div className="flex items-center justify-center border-2 border-em-accent text-[11px]" style={{ width: (dims.width / Math.max(dims.width, dims.height)) * 120, height: (dims.height / Math.max(dims.width, dims.height)) * 120 }}><span className="t-mono">{dims.width}×{dims.height}</span></div>
          : <span className="text-em-danger">{t('ui.scr.ratio.custom.clamp')}</span>}
      </div>
    </Modal>
  );
}

export function HistoryScreen({ onClose }: { onClose: () => void }) {
  const { state, runtime, actions, t, lang } = useStore();
  const [items, setItems] = useState<VersionDto[] | null>(null);
  useEffect(() => { if (state.project) runtime.api.listVersions(state.project.id, { limit: 100 }).then((p) => setItems(p.items)).catch(() => setItems([])); }, [state.project, state.head?.id, runtime]);
  const go = async (v: VersionDto) => {
    if (!state.project) return;
    const cps = await runtime.api.listCheckpoints(state.project.id).catch(() => ({ items: [] as CheckpointDto[] }));
    const cp = cps.items.find((c) => c.versionId === v.id);
    if (cp) { await runtime.api.restoreCheckpoint(state.project.id, cp.id).catch(actions.error); await actions.refreshHead(); return; }
    // No checkpoint for that version: walk with undo/redo until the head matches (versions are linear in the MVP).
    const idx = items?.findIndex((x) => x.id === v.id) ?? -1, headIdx = items?.findIndex((x) => x.id === state.head?.id) ?? -1;
    if (idx < 0 || headIdx < 0) return;
    for (let i = 0; i < Math.abs(idx - headIdx); i++) { if (idx > headIdx) await actions.undo(); else await actions.redo(); }
  };
  return (
    <Modal el="scr.history" sheet width={480} title={t('ui.scr.history.title')} onClose={onClose}>
      <ul data-el="scr.history.list" className="flex flex-col gap-1">
        {items === null && <li className="text-em-muted">{t('ui.common.loading')}</li>}
        {items?.map((v) => (
          <li key={v.id} data-el="scr.history.item" className={cx('flex items-center gap-2 rounded-[6px] border px-2 py-1.5', v.id === state.head?.id ? 'border-em-accent' : 'border-em-line')}>
            <span className="t-mono text-em-muted">v{v.hash.slice(0, 6)}</span>
            <span className="flex-1">{t(`ui.scr.history.cause.${v.cause}`)} · {formatDate(v.createdAt, lang)} · {formatDuration(v.durationMs)}</span>
            {v.id !== state.head?.id && <Button el="scr.history.item.restore" size={28} onClick={() => void go(v)}>{t('ui.scr.history.goto')}</Button>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
