// Project dialogs (scr.project.new / .open / .settings / .recover), Custom ratio (scr.ratio.custom), Version history (scr.history).
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { FPS_VALUES, RATIOS, RESOLUTIONS, type Ratio, type Resolution } from '@expertmotion/composition-model';
import { resolveDimensions } from '@expertmotion/engine/formats';
import { useStore } from '../state/store.js';
import type { CheckpointDto, Fps, ProjectDto, VersionDto } from '../api/types.js';
import { Button, Empty, Field, IconButton, Modal, inputCls, cx } from '../components/ui.js';
import { formatDate, formatDuration, type Lang } from '../i18n/index.js';

export function NewProjectDialog({ onClose, saveAs }: { onClose: () => void; saveAs?: boolean }) {
  const { state, actions, runtime, t } = useStore();
  const [name, setName] = useState(saveAs && state.project ? `${state.project.name} copy` : t('ui.hdr.title.untitled'));
  const [fps, setFps] = useState<Fps>(state.settings?.defaultFps ?? 30);
  const [ratio, setRatio] = useState<Ratio | 'auto'>('auto');
  const [resolution, setResolution] = useState<Resolution>(state.settings?.defaultResolution ?? '1080p');
  const create = async () => {
    if (!name.trim()) return;
    if (saveAs && state.project) {
      try { const p = await runtime.api.duplicateProject(state.project.id, name.trim()); await actions.openProject(p.id); onClose(); } catch (e) { actions.error(e); }
      return;
    }
    await actions.createProject({ name: name.trim(), settings: { fps, resolution, ...(ratio === 'auto' ? { autoRatio: true, ratio: state.settings?.defaultRatio ?? '9:16' } : { ratio, autoRatio: false }) } });
    onClose();
  };
  return (
    <Modal el="scr.project.new" width={420} title={saveAs ? t('ui.hdr.menu.file.saveas') : t('ui.scr.project.new.title')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button><Button variant="primary" disabledReason={name.trim() ? null : t('ui.hdr.title.error')} onClick={() => void create()}>{t('ui.scr.project.new.create')}</Button></>}>
      <Field label={t('ui.scr.project.name')} htmlFor="em-new-name"><input id="em-new-name" data-el="scr.project.new.name" className={inputCls} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} /></Field>
      {!saveAs && <>
        <Field label={t('ui.scr.project.fps')} htmlFor="em-new-fps"><select id="em-new-fps" className={inputCls} value={fps} onChange={(e) => setFps(Number(e.target.value) as Fps)}>{FPS_VALUES.map((f) => <option key={f} value={f}>{f} fps</option>)}</select></Field>
        <Field label={t('ui.scr.project.ratio')} htmlFor="em-new-ratio"><select id="em-new-ratio" className={inputCls} value={ratio} onChange={(e) => setRatio(e.target.value as Ratio | 'auto')}><option value="auto">{t('ui.agent.output.ratio.auto')}</option>{RATIOS.filter((r) => r !== 'custom').map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
        <Field label={t('ui.scr.project.resolution')} htmlFor="em-new-res"><select id="em-new-res" className={inputCls} value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>{RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
      </>}
    </Modal>
  );
}

export function OpenProjectDialog({ onClose }: { onClose: () => void }) {
  const { state, actions, runtime, t, lang } = useStore();
  const [items, setItems] = useState<ProjectDto[] | null>(null);
  const [confirm, setConfirm] = useState<ProjectDto | null>(null);
  const [typed, setTyped] = useState('');
  const load = () => runtime.api.listProjects({ limit: 200 }).then((p) => setItems(p.items)).catch((e) => { actions.error(e); setItems([]); });
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const del = async (p: ProjectDto) => { try { await runtime.api.deleteProject(p.id); setConfirm(null); setTyped(''); if (p.id === state.project?.id) actions.setScreen(null); await load(); } catch (e) { actions.error(e); } };
  return (
    <Modal el="scr.project.open" title={t('ui.scr.project.open.title')} onClose={onClose}
      footer={<Button onClick={() => void window.expertmotion?.pickFolder?.()}>{t('ui.scr.project.open.browse')}</Button>}>
      <ul data-el="scr.project.open.list" className="flex flex-col gap-1">
        {items === null && <li className="text-em-muted">{t('ui.common.loading')}</li>}
        {items?.length === 0 && <li><Empty title={t('ui.scr.project.open.empty')} /></li>}
        {items?.map((p) => (
          <li key={p.id} className={cx('flex items-center gap-2 rounded-[6px] border px-2 py-1.5', p.id === state.project?.id ? 'border-em-accent' : 'border-em-line')}>
            <button type="button" className="flex flex-1 flex-col text-left" onClick={() => { void actions.openProject(p.id); onClose(); }}>
              <span className="font-medium">{p.name}</span>
              <span className="text-[11px] text-em-muted">{p.openedAt ? formatDate(p.openedAt, lang as Lang) : '—'} · {formatDuration(p.durationMs)} · {t('ui.scr.project.open.assets', { count: p.assetCount })}</span>
            </button>
            <IconButton el="scr.project.open.delete" label={t('ui.scr.project.open.delete', { name: p.name })} icon={<Trash2 size={14} />} size={28} onClick={() => setConfirm(p)} />
          </li>
        ))}
      </ul>
      {confirm && (
        <div role="alertdialog" className="mt-3 rounded-[8px] border border-em-danger p-2">
          <p className="mb-2">{t('ui.scr.project.open.delete.confirm', { name: confirm.name })}</p>
          <input aria-label={t('ui.scr.project.open.delete.type')} placeholder={confirm.name} value={typed} onChange={(e) => setTyped(e.target.value)} className={cx(inputCls, 'mb-2')} />
          <div className="flex gap-2"><Button variant="danger" disabledReason={typed === confirm.name ? null : t('ui.scr.project.open.delete.type')} onClick={() => void del(confirm)}>{t('ui.common.delete')}</Button><Button variant="ghost" onClick={() => setConfirm(null)}>{t('ui.common.cancel')}</Button></div>
        </div>
      )}
    </Modal>
  );
}

export function ProjectSettingsDialog({ onClose }: { onClose: () => void }) {
  const { state, actions, t, lang } = useStore();
  const s = state.head?.model?.settings ?? state.project?.settings;
  const [name, setName] = useState(state.project?.name ?? '');
  const [fps, setFps] = useState<Fps>((s?.fps ?? 30) as Fps);
  const [ratio, setRatio] = useState<Ratio>(s?.ratio ?? '16:9');
  const [res, setRes] = useState<Resolution>(s?.resolution ?? '1080p');
  const [projLang, setProjLang] = useState<'id' | 'en'>(s?.language ?? 'id');
  const [uiLang, setUiLang] = useState<Lang>(lang);
  const [folder, setFolder] = useState(state.settings?.outputFolder ?? '');
  const [policy, setPolicy] = useState<'fit-content' | 'fixed'>(state.head?.model?.durationPolicy ?? 'fit-content');
  const save = async () => {
    if (name.trim() && name.trim() !== state.project?.name) await actions.renameProject(name.trim());
    await actions.updateProjectSettings({ fps, ratio, resolution: res, language: projLang });
    if (uiLang !== lang) await actions.setLanguage(uiLang);
    if (folder !== state.settings?.outputFolder) await actions.putSettings({ outputFolder: folder });
    onClose();
  };
  return (
    <Modal el="scr.project.settings" title={t('ui.scr.project.settings.title')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{t('ui.common.cancel')}</Button><Button variant="primary" onClick={() => void save()}>{t('ui.common.save')}</Button></>}>
      <Field label={t('ui.scr.project.name')} htmlFor="em-ps-name"><input id="em-ps-name" data-el="scr.project.settings.name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('ui.scr.project.fps')} htmlFor="em-ps-fps" hint={t('ui.scr.project.fps.note')}><select id="em-ps-fps" data-el="scr.project.settings.fps" className={inputCls} value={fps} onChange={(e) => setFps(Number(e.target.value) as Fps)}>{FPS_VALUES.map((f) => <option key={f} value={f}>{f} fps</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('ui.scr.project.ratio')} htmlFor="em-ps-ratio"><select id="em-ps-ratio" data-el="scr.project.settings.ratio" className={inputCls} value={ratio} onChange={(e) => setRatio(e.target.value as Ratio)}>{RATIOS.filter((r) => r !== 'custom' || s?.customRatio).map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
        <Field label={t('ui.scr.project.resolution')} htmlFor="em-ps-res"><select id="em-ps-res" data-el="scr.project.settings.resolution" className={inputCls} value={res} onChange={(e) => setRes(e.target.value as Resolution)}>{RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
      </div>
      <Field label={t('ui.scr.project.duration.policy')} htmlFor="em-ps-dur" hint={t('ui.scr.project.duration.note')}>
        <select id="em-ps-dur" data-el="scr.project.settings.duration.policy" className={inputCls} value={policy} onChange={(e) => setPolicy(e.target.value as 'fit-content' | 'fixed')}>
          <option value="fit-content">{t('ui.scr.project.duration.fit')}</option><option value="fixed">{t('ui.scr.project.duration.fixed')}</option>
        </select>
      </Field>
      <Field label={t('ui.scr.project.output.folder')} htmlFor="em-ps-folder">
        <div className="flex gap-2"><input id="em-ps-folder" data-el="scr.project.settings.output.folder" className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} />
          <Button onClick={() => void window.expertmotion?.pickFolder?.().then((f) => { if (f) setFolder(f); })}>{t('ui.scr.project.open.browse')}</Button></div>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('ui.scr.project.language')} htmlFor="em-ps-lang"><select id="em-ps-lang" className={inputCls} value={projLang} onChange={(e) => setProjLang(e.target.value as 'id' | 'en')}><option value="id">{t('ui.common.lang.id')}</option><option value="en">{t('ui.common.lang.en')}</option></select></Field>
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
            <Button el="scr.project.recover.restore" size={28} onClick={() => void restore(c)}>{t('ui.scr.project.recover.restore')}</Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

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
