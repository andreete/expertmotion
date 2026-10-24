// App shell: Header, three columns (Library / Stage / Agent), banners, toasts, live region, screens as modals.
// Responsive rules (EDITOR_INTERACTION_MODEL.md §9–§10): ≥ 1280 defaults; 1024–1279 Library collapses to a rail and Agent
// narrows to 320; < 1024 both collapse with a non-blocking toast.
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
import { Onboarding, Tour } from './screens/Onboarding.js';
import { LicenseScreen } from './screens/License.js';
import { ProvidersScreen } from './screens/Providers.js';
import { ModelsScreen } from './screens/Models.js';
import { CustomRatioDialog, HistoryScreen, NewProjectDialog, OpenProjectDialog, ProjectSettingsDialog, RecoverDialog } from './screens/ProjectDialogs.js';
import { ExportDialog } from './screens/Export.js';
import { GenerateSheet } from './screens/Generate.js';
import { AboutScreen, BackupDialog, ConfirmModal, DiagnosticsScreen, ShortcutSheet } from './screens/Misc.js';
import type { LibMode } from './state/reducer.js';

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
  const narrow = width < 1280, tiny = width < 1024;
  const [libOverlay, setLibOverlay] = useState(false);
  const libCollapsed = prefs.libCollapsed || narrow;
  const agentCollapsed = prefs.agentCollapsed || tiny;
  const collapse = useMemo(() => ({ toggleLibrary: () => setPrefs({ libCollapsed: !prefs.libCollapsed }), toggleAgent: () => setPrefs({ agentCollapsed: !prefs.agentCollapsed }) }), [prefs, setPrefs]);
  useShortcuts(collapse);
  const warned = useRef(false);
  useEffect(() => { if (tiny && !warned.current) { warned.current = true; actions.toast('info', 'ui.window.small'); } }, [tiny, actions]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  if (state.boot === 'no-service') return <I18nContext.Provider value={i18n}><NoService /></I18nContext.Provider>;
  return (
    <I18nContext.Provider value={i18n}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ minWidth: 1024 }}>
        <Header />
        <Banners />
        <main className="relative flex min-h-0 flex-1">
          {libCollapsed ? (
            <Rail side="left" onExpand={() => (narrow ? setLibOverlay((o) => !o) : setPrefs({ libCollapsed: false }))} />
          ) : (
            <div className="w-[300px] shrink-0 border-r border-em-line"><LibraryPanel /></div>
          )}
          {libCollapsed && libOverlay && (
            <div className="absolute bottom-0 left-12 top-0 z-30 w-[300px] border-r border-em-line" style={{ boxShadow: 'var(--sh-2)' }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setLibOverlay(false); }}><LibraryPanel /></div>
          )}
          <div data-region="stage" aria-label={store.t('a11y.region.stage')} className="flex min-w-[560px] flex-1 flex-col gap-2 p-2">
            <StagePlayer />
            <TimelineView />
          </div>
          {agentCollapsed ? <Rail side="right" onExpand={() => setPrefs({ agentCollapsed: false })} /> : (
            <div className={cx('shrink-0 border-l border-em-line', narrow ? 'w-[320px]' : 'w-[360px]')}><AgentPanel /></div>
          )}
        </main>
        <Toasts />
        <LiveRegion />
        <Screens />
        <Tour />
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
      {state.update && (
        <div data-el="sys.update" role="region" aria-live="polite" className="z-50 flex items-center gap-2 border-b border-em-info/60 bg-em-panel px-3 py-1.5 text-em-info">
          <span className="flex-1">{state.update.downloaded ? t('ui.sys.update.restart') : t('ui.sys.update.available', { version: state.update.version })}</span>
          <IconButton label={t('ui.common.dismiss')} icon={<X size={14} />} size={28} onClick={() => dispatch({ type: 'dismissUpdate' })} />
        </div>
      )}
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

function Toasts() {
  const { state, dispatch, t } = useStore();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const schedule = useCallback((id: string, ms: number) => {
    if (timers.current.has(id)) return;
    timers.current.set(id, setTimeout(() => { timers.current.delete(id); dispatch({ type: 'dismissToast', id }); }, ms));
  }, [dispatch]);
  useEffect(() => {
    for (const toast of state.toasts) if (!toast.sticky) schedule(toast.id, toast.kind === 'success' ? 6000 : toast.kind === 'warn' ? 8000 : toast.textKey === 'ui.sys.toast.saved' ? 1500 : 4000);
  }, [state.toasts, schedule]);
  const pause = (id: string) => { const h = timers.current.get(id); if (h) { clearTimeout(h); timers.current.delete(id); } };
  const tone = { info: 'border-em-info', success: 'border-em-success', warn: 'border-em-warn', danger: 'border-em-danger' } as const;
  return (
    <div className="pointer-events-none fixed bottom-[260px] right-4 z-40 flex w-[340px] flex-col gap-2">
      {state.toasts.map((toast) => (
        <div key={toast.id} data-el="sys.toast" role={toast.kind === 'danger' ? 'alert' : 'status'} onMouseEnter={() => pause(toast.id)} onMouseLeave={() => { if (!toast.sticky) schedule(toast.id, 3000); }}
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
    case 'providers': return <ProvidersScreen onClose={close} />;
    case 'models': return <ModelsScreen onClose={close} />;
    case 'project.new': return <NewProjectDialog onClose={close} />;
    case 'project.open': return <OpenProjectDialog onClose={close} />;
    case 'project.settings': return <ProjectSettingsDialog onClose={close} />;
    case 'project.recover': return <RecoverDialog onClose={close} />;
    case 'export': return <ExportDialog onClose={close} />;
    case 'generate': return <GenerateSheet kind={s.generator} onClose={close} />;
    case 'diagnostics': return <DiagnosticsScreen onClose={close} />;
    case 'about': return <AboutScreen onClose={close} />;
    case 'backup': return <BackupDialog mode="backup" onClose={close} />;
    case 'restore': return <BackupDialog mode="restore" onClose={close} />;
    case 'ratio.custom': return <CustomRatioDialog onClose={close} />;
    case 'history': return <HistoryScreen onClose={close} />;
    case 'shortcuts': return <ShortcutSheet onClose={close} />;
    case 'confirm': return <ConfirmModal screen={s} onClose={close} />;
    default: return null;
  }
}

function NoService() {
  const { t } = useStore();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div data-el="sys.offline" className="max-w-[520px] rounded-[12px] border border-em-line bg-em-panel p-6">
        <h1 className="mb-2 text-[20px] font-semibold">{t('ui.sys.offline.title')}</h1>
        <p className="mb-3 text-em-text-2">{t('ui.sys.noservice.body')}</p>
        <pre className="t-mono rounded-[6px] bg-em-bg p-2 text-[12px]">VITE_EM_API=http://127.0.0.1:4110 VITE_EM_TOKEN=… npx vite apps/ui{'\n'}VITE_EM_MOCK=1 npx vite apps/ui</pre>
      </div>
    </div>
  );
}
