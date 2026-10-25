// App shell: Header, three columns (Library / Stage / Agent), banners, toasts, live region, screens as modals.
// Responsive rules (EDITOR_INTERACTION_MODEL.md §9–§10, FR-099): side panels shrink to their minimums, then collapse to a rail
// in the order Library → Agent before the Stage gets narrower than 640 px; < 1024 both collapse with a non-blocking toast.
// Dividers resize the columns and the Player/Timeline split; sizes are kept per window-width bucket in prefs and mirrored
// to the Local Service Settings `layout` (FR-155).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, ChevronLeft, ChevronRight, ShieldCheck, Sparkles, Type, Upload, WifiOff, Wrench, X } from 'lucide-react';
import { useStore } from './state/store.js';
import { I18nContext, translate, type I18n } from './i18n/index.js';
import { Header } from './header/Header.js';
import { LibraryPanel } from './library/LibraryPanel.js';
import { StagePlayer } from './stage/Player.js';
import { TimelineView } from './stage/Timeline.js';
import { AgentPanel } from './agent/AgentPanel.js';
import { Button, IconButton, cx } from './components/ui.js';
import { useShortcuts } from './shortcuts.js';
import { Onboarding } from './screens/Onboarding.js';
import { Tour } from './screens/Tour.js';
import { LicenseScreen } from './screens/License.js';
import { ProvidersScreen } from './screens/Providers.js';
import { ModelsScreen } from './screens/Models.js';
import { CustomRatioDialog, HistoryScreen, NewProjectDialog, OpenProjectDialog, ProjectSettingsDialog, RecoverDialog } from './screens/ProjectDialogs.js';
import { ExportDialog } from './screens/Export.js';
import { GenerateSheet } from './screens/Generate.js';
import { AboutScreen, BackupDialog, ConfirmModal, DiagnosticsScreen, HelpScreen, ShortcutSheet } from './screens/Misc.js';
import { CloseRenderDialog, LifecycleEffects, UnsavedDialog } from './screens/Lifecycle.js';
import type { LibMode } from './state/reducer.js';
import { Splitter } from './components/Splitter.js';
import { LAYOUT, bucketFor, clamp, defaultSizes, resolveColumns, timelineMax } from './layout.js';
import { layoutOf, type PanelSizes } from './prefs.js';

function useWindowWidth(): number {
  const [w, setW] = useState(typeof window === 'undefined' ? 1440 : window.innerWidth);
  useEffect(() => { const on = () => setW(window.innerWidth); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  return w;
}

export function App() {
  const store = useStore();
  const { state, actions, prefs, setPrefs, lang } = store;
  const i18n = useMemo<I18n>(() => ({ lang, t: (k, v) => translate(lang, k, v), setLang: (l) => void actions.setLanguage(l) }), [lang, actions]);
  const width = useWindowWidth();
  const tiny = width < 1024;
  const [libOverlay, setLibOverlay] = useState(false);
  const collapse = useMemo(() => ({ toggleLibrary: () => setPrefs({ libCollapsed: !prefs.libCollapsed }), toggleAgent: () => setPrefs({ agentCollapsed: !prefs.agentCollapsed }) }), [prefs, setPrefs]);
  // ── panel sizes (live while dragging, persisted on release / key press) ──
  const bucket = bucketFor(width);
  const [live, setLive] = useState<PanelSizes>({});
  const stageRef = useRef<HTMLDivElement>(null);
  const stored = { ...defaultSizes(bucket), ...(prefs.panelSizes[bucket] ?? {}) };
  const want = { ...stored, ...live };
  // FR-099: Library then Agent collapse (rail) automatically before the Stage would get narrower than 640 px.
  const cols = resolveColumns({ width: Math.max(width, 1024), lib: want.lib, agent: want.agent, libOpen: !prefs.libCollapsed, agentOpen: !prefs.agentCollapsed && !tiny });
  const libCollapsed = !cols.libOpen, agentCollapsed = !cols.agentOpen;
  const narrow = libCollapsed && !prefs.libCollapsed;                          // auto-collapsed: the rail opens the Library as an overlay
  const tlMax = timelineMax(stageRef.current?.clientHeight ?? 0);
  const tlHeight = clamp(want.timeline, LAYOUT.timeline.min, tlMax);
  const resize = (key: keyof PanelSizes, min: number, max: number) => (raw: number, commit: boolean) => {
    if (key === 'lib' && raw < LAYOUT.lib.collapseBelow) {                       // dragging the Library below 240 collapses it to the rail (§9)
      setLive({}); if (commit) setPrefs({ libCollapsed: true }); return;
    }
    const v = Math.round(clamp(raw, min, max));
    if (!commit) { setLive((l) => ({ ...l, [key]: v })); return; }
    setLive({});
    setPrefs({ panelSizes: { ...prefs.panelSizes, [bucket]: { ...(prefs.panelSizes[bucket] ?? {}), [key]: v } } });
  };
  const reset = (key: keyof PanelSizes) => () => {
    setLive({});
    const { [key]: _drop, ...rest } = prefs.panelSizes[bucket] ?? {};
    setPrefs({ panelSizes: { ...prefs.panelSizes, [bucket]: rest } });
  };
  useShortcuts(collapse);
  useUpdateBridge();
  useLayoutSync();
  const warned = useRef(false);
  useEffect(() => { if (tiny && !warned.current) { warned.current = true; actions.toast('info', 'ui.window.small'); } }, [tiny, actions]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  if (state.boot === 'no-service') return <I18nContext.Provider value={i18n}>{state.fatal ? <FatalOverlay /> : <NoService />}</I18nContext.Provider>;
  return (
    <I18nContext.Provider value={i18n}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ minWidth: 1024 }}>
        <Header />
        <Banners />
        <main className="relative flex min-h-0 flex-1">
          {libCollapsed ? (
            <Rail side="left" onExpand={() => (narrow ? setLibOverlay((o) => !o) : setPrefs({ libCollapsed: false }))} />
          ) : (
            <>
              <div className="shrink-0" style={{ width: cols.lib }}><LibraryPanel /></div>
              <Splitter el="lib.divider" orientation="vertical" value={cols.lib} min={LAYOUT.lib.min} max={cols.libMax} label={store.t('a11y.layout.divider.library')}
                onChange={resize('lib', LAYOUT.lib.min, cols.libMax)} onReset={reset('lib')} />
            </>
          )}
          {libCollapsed && libOverlay && (
            <div className="absolute bottom-0 left-12 top-0 z-30 w-[300px] border-r border-em-line" style={{ boxShadow: 'var(--sh-2)' }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setLibOverlay(false); }}><LibraryPanel /></div>
          )}
          <div ref={stageRef} data-region="stage" aria-label={store.t('a11y.region.stage')} className="flex min-w-[640px] flex-1 flex-col gap-1 p-2">
            <StagePlayer />
            <Splitter el="stage.divider" orientation="horizontal" invert value={tlHeight} min={LAYOUT.timeline.min} max={tlMax} label={store.t('a11y.layout.divider.timeline')}
              onChange={resize('timeline', LAYOUT.timeline.min, tlMax)} onReset={reset('timeline')} />
            <TimelineView height={tlHeight} />
          </div>
          {agentCollapsed ? <Rail side="right" onExpand={() => setPrefs({ agentCollapsed: false })} /> : (
            <>
              <Splitter el="agent.divider" orientation="vertical" invert value={cols.agent} min={LAYOUT.agent.min} max={cols.agentMax} label={store.t('a11y.layout.divider.agent')}
                onChange={resize('agent', LAYOUT.agent.min, cols.agentMax)} onReset={reset('agent')} />
              <div className="shrink-0" style={{ width: cols.agent }}><AgentPanel /></div>
            </>
          )}
        </main>
        <Toasts />
        <LiveRegion />
        <Screens />
        <LifecycleEffects />
        <Tour />
        {state.fatal && <FatalOverlay />}
      </div>
    </I18nContext.Provider>
  );
}

function Rail({ side, onExpand }: { side: 'left' | 'right'; onExpand: () => void }) {
  const { actions, t } = useStore();
  const mode = (m: LibMode) => () => { actions.setLibMode(m); onExpand(); };
  return (
    <nav aria-label={t(side === 'left' ? 'a11y.region.library' : 'a11y.region.agent')} className={cx('flex w-12 shrink-0 flex-col items-center gap-1 bg-em-panel py-2', side === 'left' ? 'border-r border-em-line' : 'border-l border-em-line')}>
      <IconButton label={t('ui.common.expand')} icon={side === 'left' ? <ChevronRight size={16} /> : <ChevronLeft size={16} />} onClick={onExpand} />
      {side === 'left' ? <>
        <IconButton label={t('ui.hdr.menu.home')} icon={<Type size={16} />} onClick={mode('home')} />
        <IconButton label={t('ui.hdr.menu.design')} icon={<Sparkles size={16} />} onClick={mode('design')} />
        <IconButton label={t('ui.hdr.menu.tools')} icon={<Wrench size={16} />} onClick={mode('tools')} />
        <IconButton label={t('ui.lib.assets.title')} icon={<Upload size={16} />} onClick={onExpand} />
      </> : <IconButton label={t('ui.agent.editor.title')} icon={<Boxes size={16} />} onClick={onExpand} />}
    </nav>
  );
}

function Banners() {
  const { state, actions, runtime, dispatch, t } = useStore();
  return (
    <>
      {state.update && <UpdateBanner />}
      {state.stream === 'offline' && (
        <div data-el="sys.offline" role="region" aria-live="assertive" className="z-50 flex items-center gap-2 border-b border-em-warn bg-em-panel px-3 py-1.5 text-em-warn">
          <WifiOff size={16} /><span className="font-semibold">{t('ui.sys.offline.title')}</span><span className="flex-1 text-em-text-2">{t('ui.sys.offline.body', { n: Math.min(3, state.streamAttempt) })}</span>
          <Button size={28} onClick={() => void runtime.healthCheck().then((h) => { if (h) void actions.reloadState(); })}>{t('ui.sys.offline.retry')}</Button>
        </div>
      )}
      {state.settings?.privateMode && (
        <div data-el="sys.privatemode.banner" role="region" aria-live="polite" className="z-50 flex items-center gap-2 border-b border-em-private/60 bg-em-panel px-3 py-1.5 text-em-private">
          <ShieldCheck size={16} /><span className="flex-1">{t('ui.sys.privatemode.banner')}</span>
          <Button size={28} variant="ghost" onClick={() => void actions.setPrivateMode(false)}>{t('ui.sys.privatemode.off')}</Button>
        </div>
      )}
    </>
  );
}

/** FR-154: info/success auto-dismiss after 6 s (the "Saved" tick after 1.5 s); warn and error stay until dismissed. */
export const toastDismissMs = (toast: { kind: string; textKey: string; sticky: boolean }): number | null =>
  toast.sticky || toast.kind === 'warn' || toast.kind === 'danger' ? null : toast.textKey === 'ui.sys.toast.saved' ? 1500 : 6000;

/** sys.update (FR-152, FR-162): background download (Download stays as a manual start while it waits), EM-8105 Restart now / Later,
 *  deferred while a render runs, paused by Private Mode, EM-8104 / EM-8102 with Try again. */
function UpdateBanner() {
  const { state, dispatch, t } = useStore();
  const u = state.update!;
  const shell = typeof window !== 'undefined' ? window.expertmotion : undefined;
  const act = (a: 'download' | 'restart' | 'later' | 'check') => { void shell?.updateAction?.(a); if (a === 'later') dispatch({ type: 'dismissUpdate' }); };
  const status = state.settings?.privateMode ? 'paused' : (u.status ?? (u.downloaded ? 'downloaded' : 'available'));
  const rendering = state.renders.some((j) => j.status === 'rendering' || j.status === 'queued');
  return (
    <div data-el="sys.update" data-status={status} role="region" aria-live="polite" className={cx('z-50 flex items-center gap-2 border-b bg-em-panel px-3 py-1.5', status === 'paused' ? 'border-em-private/60 text-em-private' : status === 'error' ? 'border-em-danger text-em-danger' : 'border-em-info/60 text-em-info')}>
      <span className="flex-1">
        {status === 'paused' ? t('ui.sys.update.paused')
          : status === 'downloading' ? t('ui.sys.update.downloading', { version: u.version, percent: u.percent ?? 0 })
            : status === 'downloaded' ? t('err.EM-8105.body', { version: u.version })
              : status === 'deferred' ? t('ui.sys.update.deferred', { version: u.version })
                : status === 'error' ? `${t(`err.${u.code ?? 'EM-8101'}.title`)} · ${u.code ?? 'EM-8101'}`
                  : t('ui.sys.update.available', { version: u.version })}
      </span>
      {status === 'available' && <Button el="sys.update.download" size={28} onClick={() => act('download')}>{t('ui.sys.update.download')}</Button>}
      {status === 'downloaded' && <Button el="sys.update.restart" size={28} variant="primary" disabledReason={rendering ? t('ui.sys.update.wait') : null} onClick={() => act('restart')}>{t('ui.sys.update.restartnow')}</Button>}
      {status === 'error' && (u.code === 'EM-8104' || u.code === 'EM-8102' || u.code === 'EM-8101') && <Button el="sys.update.retry" size={28} onClick={() => act('check')}>{t('ui.sys.update.retry')}</Button>}
      {(status === 'downloaded' || status === 'available') && <Button el="sys.update.later" size={28} variant="ghost" onClick={() => act('later')}>{t('ui.sys.update.later')}</Button>}
      <IconButton label={t('ui.common.dismiss')} icon={<X size={14} />} size={28} onClick={() => dispatch({ type: 'dismissUpdate' })} />
    </div>
  );
}

/**
 * FR-099 / FR-155: the panel layout lives in the Local Service Settings (`layout`, the settings.json state), so it survives a
 * UI cache reset and a reinstall of the Editor. Loaded once when Settings arrive; saved 500 ms after the last change.
 */
function useLayoutSync() {
  const { state, prefs, setPrefs, runtime, dispatch } = useStore();
  const loaded = useRef(false);
  const layout = layoutOf(prefs);
  const key = JSON.stringify(layout);
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (loaded.current || !state.settings) return;
    loaded.current = true;
    const l = state.settings.layout;
    if (l) { lastSaved.current = JSON.stringify({ ...layout, ...l }); setPrefs(l); } else lastSaved.current = key;
  }, [state.settings]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!loaded.current || lastSaved.current === key) return;
    const h = setTimeout(() => {
      lastSaved.current = key;
      void runtime.api.putSettings({ layout }).then((s) => dispatch({ type: 'settings', settings: s })).catch(() => undefined);
    }, 500);
    return () => clearTimeout(h);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Subscribes to the Shell's updater state (absent in the browser dev build). */
function useUpdateBridge() {
  const { dispatch } = useStore();
  useEffect(() => {
    const shell = typeof window !== 'undefined' ? window.expertmotion : undefined;
    if (!shell?.onUpdateState) return;
    void shell.getUpdateState?.().then((u) => { if (u) dispatch({ type: 'update', update: u }); }).catch(() => undefined);
    const off = shell.onUpdateState((u) => dispatch({ type: 'update', update: u }));
    return () => { if (typeof off === 'function') off(); };
  }, [dispatch]);
}

function Toasts() {
  const { state, dispatch, t } = useStore();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const schedule = useCallback((id: string, ms: number) => {
    if (timers.current.has(id)) return;
    timers.current.set(id, setTimeout(() => { timers.current.delete(id); dispatch({ type: 'dismissToast', id }); }, ms));
  }, [dispatch]);
  useEffect(() => {
    for (const toast of state.toasts) { const ms = toastDismissMs(toast); if (ms !== null) schedule(toast.id, ms); }
  }, [state.toasts, schedule]);
  const pause = (id: string) => { const h = timers.current.get(id); if (h) { clearTimeout(h); timers.current.delete(id); } };
  const tone = { info: 'border-em-info', success: 'border-em-success', warn: 'border-em-warn', danger: 'border-em-danger' } as const;
  return (
    <div className="pointer-events-none fixed bottom-[260px] right-4 z-40 flex w-[340px] flex-col gap-2">
      {[...state.toasts].reverse().map((toast) => (
        <div key={toast.id} data-el="sys.toast" data-kind={toast.kind} onMouseEnter={() => pause(toast.id)} onMouseLeave={() => { if (toastDismissMs(toast) !== null) schedule(toast.id, 3000); }}
          className={cx('pointer-events-auto flex items-start gap-2 rounded-[8px] border-l-2 bg-em-panel px-3 py-2', tone[toast.kind])} style={{ boxShadow: 'var(--sh-2)' }}>
          <div className="flex-1">
            <div>{t(toast.textKey, toast.vars)}{toast.count > 1 && <span className="t-mono ml-1 text-em-muted">×{toast.count}</span>}</div>
            {toast.code && <div className="t-mono text-[11px] text-em-muted select-all">{toast.code}</div>}
          </div>
          {toast.action && <button type="button" data-el="sys.toast.action" className="font-semibold text-em-accent" onClick={() => { toast.action!.run(); dispatch({ type: 'dismissToast', id: toast.id }); }}>{t(toast.action.labelKey)}</button>}
          <button type="button" aria-label={t('ui.common.dismiss')} onClick={() => dispatch({ type: 'dismissToast', id: toast.id })} className="text-em-muted"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

/** sys.live: visually hidden polite region; at most one announcement per 2 s, coalesced (ACCESSIBILITY_AND_I18N.md §2). */
function LiveRegion() {
  const { state } = useStore();
  const [text, setText] = useState('');
  const last = useRef(0);
  const queued = useRef<string | null>(null);
  useEffect(() => {
    if (!state.live) return;
    const now = Date.now();
    if (now - last.current >= 2000) { last.current = now; setText(state.live.text); return; }
    queued.current = state.live.text;
    const h = setTimeout(() => { if (queued.current) { last.current = Date.now(); setText(queued.current); queued.current = null; } }, 2000 - (now - last.current));
    return () => clearTimeout(h);
  }, [state.live]);
  return <div data-el="sys.live" aria-live="polite" role="status" className="sr-only">{text}</div>;
}

function Screens() {
  const { state, actions } = useStore();
  const s = state.screen;
  if (!s) return null;
  const close = () => actions.setScreen(null);
  switch (s.kind) {
    case 'onboarding': return <Onboarding onClose={close} />;
    case 'license': return <LicenseScreen onClose={close} />;
    case 'providers': return <ProvidersScreen onClose={close} {...(s.focus ? { focus: s.focus } : {})} />;
    case 'models': return <ModelsScreen onClose={close} {...(s.focus ? { focus: s.focus } : {})} />;
    case 'project.new': return <NewProjectDialog onClose={close} saveAs={s.saveAs === true} />;
    case 'unsaved': return <UnsavedDialog screen={s} onClose={close} />;
    case 'close.render': return <CloseRenderDialog screen={s} onClose={close} />;
    case 'project.open': return <OpenProjectDialog onClose={close} />;
    case 'project.settings': return <ProjectSettingsDialog onClose={close} />;
    case 'project.recover': return <RecoverDialog onClose={close} />;
    case 'export': return <ExportDialog onClose={close} />;
    case 'generate': return <GenerateSheet kind={s.generator} onClose={close} />;
    case 'diagnostics': return <DiagnosticsScreen onClose={close} />;
    case 'about': return <AboutScreen onClose={close} />;
    case 'help': return <HelpScreen onClose={close} {...(s.topic ? { topic: s.topic } : {})} />;
    case 'backup': return <BackupDialog mode="backup" onClose={close} />;
    case 'restore': return <BackupDialog mode="restore" onClose={close} />;
    case 'ratio.custom': return <CustomRatioDialog onClose={close} />;
    case 'history': return <HistoryScreen onClose={close} />;
    case 'shortcuts': return <ShortcutSheet onClose={close} />;
    case 'confirm': return <ConfirmModal screen={s} onClose={close} />;
    default: return null;
  }
}

/**
 * sys.fatal (FR-171, FR-176): the Shell gave up restarting the Local Service (EM-8002) or cannot unlock project storage (EM-6001).
 * Shown in the Editor — not only as a native box — with Open Diagnostics (the logs folder; the Service-side Diagnostics screen is
 * unreachable without a Service) and Quit. The Editor stays mounted behind it, so selection and composer drafts are kept.
 */
function FatalOverlay() {
  const { state, t } = useStore();
  const f = state.fatal;
  if (!f) return null;
  const bridge = typeof window !== 'undefined' ? window.expertmotion : undefined;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-8">
      <div data-el="sys.fatal" role="alertdialog" aria-modal="true" aria-labelledby="sys-fatal-title" className="max-w-[560px] rounded-[12px] border border-em-danger bg-em-panel p-6">
        <h1 id="sys-fatal-title" className="mb-2 text-[20px] font-semibold">{t(`err.${f.code}.title`)}</h1>
        <p className="mb-3 text-em-text-2">{t(`err.${f.code}.body`)}</p>
        {f.code === 'EM-6001' && <p className="mb-3 text-em-text-2">{t('ui.sys.fatal.storage.hint')}</p>}
        <p className="t-mono mb-4 text-[12px] text-em-text-2">{f.code}</p>
        <div className="flex justify-end gap-2">
          {f.logsDir && bridge?.openFolder && (
            <Button el="sys.fatal.diagnostics" onClick={() => void bridge.openFolder?.(f.logsDir!)}>{t('ui.sys.fatal.diagnostics')}</Button>
          )}
          <Button el="sys.fatal.quit" variant="primary" onClick={() => window.close()}>{t('ui.sys.fatal.quit')}</Button>
        </div>
      </div>
    </div>
  );
}

/** The first load failed. Inside the Shell: plain copy and Retry (the Shell keeps the Service running and pushes a new
 *  endpoint after a restart, which reboots the Editor by itself). In a plain browser (development): how to point it at a Service. */
function NoService() {
  const { t } = useStore();
  const inShell = typeof window !== 'undefined' && window.expertmotion !== undefined;
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div data-el="sys.offline" className="max-w-[520px] rounded-[12px] border border-em-line bg-em-panel p-6">
        <h1 className="mb-2 text-[20px] font-semibold">{t('ui.sys.offline.title')}</h1>
        {inShell ? (
          <>
            <p className="mb-4 text-em-text-2">{t('ui.sys.noservice.shell')}</p>
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => window.location.reload()}>{t('ui.sys.offline.retry')}</Button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-3 text-em-text-2">{t('ui.sys.noservice.body')}</p>
            <pre className="t-mono rounded-[6px] bg-em-bg p-2 text-[12px]">VITE_EM_API=http://127.0.0.1:4110 VITE_EM_TOKEN=… npx vite apps/ui{'\n'}VITE_EM_MOCK=1 npx vite apps/ui</pre>
          </>
        )}
      </div>
    </div>
  );
}
