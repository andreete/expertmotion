// sys.crash (FR-185; QA 2026-10-26): top-level error boundary. An exception in the React tree used to unmount everything and
// leave a black window; now the Creator sees "Something went wrong — Reload" with the EM-8009 code and the error message,
// and the error (with stack) goes to the Shell log through the preload's logError bridge (validated and capped in main).
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { translate } from '../i18n/index.js';
import { AppMark } from '../components/AppMark.js';
import { startupLang } from './progress.js';

export const EDITOR_ERROR_CODE = 'EM-8009';

/** Sends one Editor error to the Shell log (no bridge in the browser dev build: console instead). Never throws. */
export function logEditorError(err: unknown, source: 'error-boundary' | 'window-error' | 'unhandled-rejection', extraStack?: string): void {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'non-error thrown');
    const stack = [e.stack ?? '', extraStack ?? ''].filter(Boolean).join('\n--- component stack ---\n');
    const entry = { level: 'error' as const, code: EDITOR_ERROR_CODE, message: `${e.name}: ${e.message}`.slice(0, 4000), source, ...(stack ? { stack: stack.slice(0, 20_000) } : {}) };
    const bridge = typeof window !== 'undefined' ? window.expertmotion : undefined;
    if (bridge?.logError) void Promise.resolve(bridge.logError(entry)).catch(() => undefined);
    else console.error('[em] editor error', entry.message);
  } catch { /* logging must never throw */ }
}

interface State { error: Error | null }
export class ErrorBoundary extends Component<{ children: ReactNode; onReload?: () => void }, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: unknown): State { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  override componentDidCatch(error: unknown, info: ErrorInfo): void { logEditorError(error, 'error-boundary', info.componentStack ?? undefined); }
  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const lang = startupLang();
    const t = (k: string) => translate(lang, k);
    const reload = this.props.onReload ?? (() => window.location.reload());
    return (
      <div data-el="sys.crash" role="alertdialog" aria-labelledby="sys-crash-title" className="flex h-full w-full flex-col items-center justify-center gap-4 bg-em-bg p-8 text-em-text">
        <AppMark size={48} />
        <div className="w-[440px] max-w-full rounded-[8px] border-l-2 border-em-danger bg-em-panel px-4 py-3">
          <div className="flex items-center gap-2 text-em-danger">
            <AlertTriangle size={16} aria-hidden />
            <h1 id="sys-crash-title" className="flex-1 text-[15px] font-semibold">{t('ui.sys.crash.title')}</h1>
            <span data-el="sys.crash.code" className="t-mono select-all text-em-muted">{EDITOR_ERROR_CODE}</span>
          </div>
          <p className="mt-1 text-em-text-2">{t('ui.sys.crash.body')}</p>
          <p data-el="sys.crash.message" className="t-mono mt-2 max-h-[72px] overflow-auto break-words text-[11px] text-em-muted select-all">{`${error.name}: ${error.message}`.slice(0, 300)}</p>
          <div className="mt-3 flex justify-end">
            <button type="button" data-el="sys.crash.reload" onClick={reload}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-em-accent px-3 font-semibold text-em-accent-ink hover:bg-em-accent-hover">
              <RotateCcw size={14} aria-hidden />{t('ui.sys.crash.reload')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
