// sys.crash (FR-185; QA 2026-10-26): top-level error boundary. An exception in the React tree used to unmount everything and
// leave a black window; now the Creator sees "Something went wrong — Reload" with the EM-8009 code and the error message,
// and the error (with stack) goes to the Shell log through the preload's logError bridge (validated and capped in main).
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, FilePlus2, FolderOpen, FolderSearch, RefreshCw, RotateCcw } from 'lucide-react';
import { translate } from '../i18n/index.js';
import { AppMark } from '../components/AppMark.js';
import { startupLang } from './progress.js';
import { getLogsDir, noteEditorCrash, requestBootAction } from './session-guard.js';

export const EDITOR_ERROR_CODE = 'EM-8009';

/** Key-like strings never leave the Editor in a log line (provider keys, Licence Keys, bearer tokens); the Shell redacts again. */
export function redactLogText(s: string): string {
  return s.replace(/sk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]').replace(/AIza[A-Za-z0-9_-]{8,}/g, 'AIza[REDACTED]')
    .replace(/EM1-[A-Za-z0-9_.-]{12,}/g, 'EM1-[REDACTED]').replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]').replace(/([?&]token=)[^&\s'")]+/gi, '$1[REDACTED]');
}

/** Sends one Editor error to the Shell log (no bridge in the browser dev build: console instead). Never throws.
 *  `section` names the panel whose boundary caught it (FR-200); it travels as a message prefix (the Shell's schema is strict). */
export function logEditorError(err: unknown, source: 'error-boundary' | 'window-error' | 'unhandled-rejection', extraStack?: string, section?: string): void {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'non-error thrown');
    const stack = redactLogText([e.stack ?? '', extraStack ?? ''].filter(Boolean).join('\n--- component stack ---\n'));
    const message = redactLogText(`${section ? `[section:${section}] ` : ''}${e.name}: ${e.message}`);
    const entry = { level: 'error' as const, code: EDITOR_ERROR_CODE, message: message.slice(0, 4000), source, ...(stack ? { stack: stack.slice(0, 20_000) } : {}) };
    const bridge = typeof window !== 'undefined' ? window.expertmotion : undefined;
    if (bridge?.logError) void Promise.resolve(bridge.logError(entry)).catch(() => undefined);
    else console.error('[em] editor error', entry.message);
  } catch { /* logging must never throw */ }
}

interface State { error: Error | null }
export class ErrorBoundary extends Component<{ children: ReactNode; onReload?: () => void }, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: unknown): State { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    noteEditorCrash();                                     // FR-202: counts against the project opened just before (crash-loop guard)
    logEditorError(error, 'error-boundary', info.componentStack ?? undefined);
  }
  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const lang = startupLang();
    const t = (k: string) => translate(lang, k);
    const doReload = this.props.onReload ?? (() => window.location.reload());
    // FR-202: never only "Reload" — another project, a new one, or the log folder are always one click away.
    const go = (action: 'reload' | 'pick' | 'new') => () => { requestBootAction(action); doReload(); };
    const logs = getLogsDir();
    const bridge = typeof window !== 'undefined' ? window.expertmotion : undefined;
    const second = 'inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-em-line px-3 text-em-text hover:bg-em-panel-2';
    return (
      <div data-el="sys.crash" role="alertdialog" aria-labelledby="sys-crash-title" className="flex h-full w-full flex-col items-center justify-center gap-4 bg-em-bg p-8 text-em-text">
        <AppMark size={48} />
        <div className="w-[520px] max-w-full rounded-[8px] border-l-2 border-em-danger bg-em-panel px-4 py-3">
          <div className="flex items-center gap-2 text-em-danger">
            <AlertTriangle size={16} aria-hidden />
            <h1 id="sys-crash-title" className="flex-1 text-[15px] font-semibold">{t('ui.sys.crash.title')}</h1>
            <span data-el="sys.crash.code" className="t-mono select-all text-em-muted">{EDITOR_ERROR_CODE}</span>
          </div>
          <p className="mt-1 text-em-text-2">{t('ui.sys.crash.body')}</p>
          <p data-el="sys.crash.message" className="t-mono mt-2 max-h-[72px] overflow-auto break-words text-[11px] text-em-muted select-all">{`${error.name}: ${error.message}`.slice(0, 300)}</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {logs && bridge?.openFolder && (
              <button type="button" data-el="sys.crash.logs" onClick={() => void Promise.resolve(bridge.openFolder?.(logs)).catch(() => undefined)} className={`${second} mr-auto`}>
                <FolderSearch size={14} aria-hidden />{t('ui.sys.crash.logs')}
              </button>
            )}
            <button type="button" data-el="sys.crash.pick" onClick={go('pick')} className={second}><FolderOpen size={14} aria-hidden />{t('ui.sys.crash.pick')}</button>
            <button type="button" data-el="sys.crash.new" onClick={go('new')} className={second}><FilePlus2 size={14} aria-hidden />{t('ui.sys.crash.new')}</button>
            <button type="button" data-el="sys.crash.reload" onClick={go('reload')}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-em-accent px-3 font-semibold text-em-accent-ink hover:bg-em-accent-hover">
              <RotateCcw size={14} aria-hidden />{t('ui.sys.crash.reload')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * sys.section (FR-200): a boundary around one Editor panel (Library, Player, Timeline, assistant chat, Providers, dialogs). A
 * render error inside it shows an inline card "This part failed to load — Reload part" while the rest of the Editor keeps
 * working; Reload part remounts only that panel (it never remounts by itself, so a panel that keeps failing cannot loop).
 * Every hit goes to the Shell log (component stack, redacted) with the section name. The top-level ErrorBoundary stays as the
 * last resort.
 */
export class SectionBoundary extends Component<{ section: string; children: ReactNode; className?: string; onClose?: () => void }, { error: Error | null; nonce: number }> {
  override state = { error: null as Error | null, nonce: 0 };
  static getDerivedStateFromError(error: unknown): Partial<{ error: Error | null }> { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    logEditorError(error, 'error-boundary', info.componentStack ?? undefined, this.props.section);
  }
  private reload = () => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }));
  override render(): ReactNode {
    const { error, nonce } = this.state;
    if (!error) return <SectionKey key={nonce}>{this.props.children}</SectionKey>;
    const t = (k: string) => translate(startupLang(), k);
    return (
      <div data-el="sys.section.error" data-section={this.props.section} role="alert" className={this.props.className ?? 'flex h-full w-full min-h-[96px] items-center justify-center p-3'}>
        <div className="flex max-w-[360px] flex-col gap-1.5 rounded-[8px] border-l-2 border-em-danger bg-em-panel-2 px-3 py-2 text-[12px] text-em-text">
          <div className="flex items-center gap-1.5 text-em-danger"><AlertTriangle size={14} aria-hidden /><span className="flex-1 font-semibold">{t('ui.sys.section.title')}</span>
            <span className="t-mono text-em-muted select-all">{EDITOR_ERROR_CODE}</span></div>
          <p data-el="sys.section.message" className="t-mono max-h-[48px] overflow-auto break-words text-[11px] text-em-muted select-all">{redactLogText(`${error.name}: ${error.message}`).slice(0, 200)}</p>
          <div className="flex justify-end gap-2">
            {this.props.onClose && <button type="button" data-el="sys.section.close" onClick={this.props.onClose} className="h-7 rounded-[6px] px-2 text-em-text-2 hover:bg-em-panel">{t('ui.common.close')}</button>}
            <button type="button" data-el="sys.section.reload" onClick={this.reload}
              className="inline-flex h-7 items-center gap-1 rounded-[6px] bg-em-accent px-2 font-semibold text-em-accent-ink hover:bg-em-accent-hover"><RefreshCw size={12} aria-hidden />{t('ui.sys.section.reload')}</button>
          </div>
        </div>
      </div>
    );
  }
}
/** Keyed wrapper so "Reload part" remounts the panel with fresh state. */
function SectionKey({ children }: { children: ReactNode }) { return <>{children}</>; }
