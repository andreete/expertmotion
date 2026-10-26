// sys.splash (FR-184; QA 2026-10-26 "sering blackscreen"): the branded startup screen. Rendered before anything is awaited,
// it names the current step (integrity → keyring → service → project), shows a thin progress bar, the elapsed seconds after
// 5 s, a "still working" line after 20 s, and on a failure the EM- code, one sentence, Try again and Open log folder.
// Presentational: the phase comes from the Shell push (main.tsx / Boot) or from the store (first project load, App).
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, RotateCcw } from 'lucide-react';
import type { StartupPhase } from '../api/client.js';
import { translate, type Lang } from '../i18n/index.js';
import { AppMark } from '../components/AppMark.js';
import { Button, cx } from '../components/ui.js';
import { SPLASH_ELAPSED_AFTER_MS, SPLASH_SLOW_AFTER_MS, splashProgress, startupElapsedMs } from './progress.js';

export interface SplashProps {
  lang: Lang;
  phase?: StartupPhase | undefined;
  progress?: number | undefined;
  failure?: { code: string; logsDir?: string | undefined } | null | undefined;
  onRetry?: () => void;
  onOpenLogs?: (dir: string) => void;
  /** Overlay mode covers the (still empty) Editor while the first project loads. */
  overlay?: boolean;
}

export function Splash({ lang, phase, progress, failure, onRetry, onOpenLogs, overlay }: SplashProps) {
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const [, setTick] = useState(0);                               // re-render twice a second; the time itself is read below
  const now = Date.now();
  const phaseSince = useRef<{ phase: StartupPhase | undefined; at: number }>({ phase, at: Date.now() });
  if (phaseSince.current.phase !== phase) phaseSince.current = { phase, at: Date.now() };
  useEffect(() => {
    if (failure) return;
    const h = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(h);
  }, [failure]);
  const elapsed = startupElapsedMs(now);
  const value = splashProgress(phase, progress, now - phaseSince.current.at);
  const step = t(phase ? `ui.sys.splash.${phase}` : 'ui.sys.splash.starting');
  return (
    <div data-el="sys.splash" data-phase={failure ? 'failed' : (phase ?? 'starting')}
      className={cx('flex h-full w-full flex-col items-center justify-center gap-5 bg-em-bg p-8 text-em-text', overlay && 'fixed inset-0 z-[90]')}>
      <AppMark size={64} />
      <div className="text-[18px] font-semibold tracking-tight">Expertmotion</div>
      {failure ? (
        <div data-el="sys.splash.error" role="alert" className="w-[380px] max-w-full rounded-[8px] border-l-2 border-em-danger bg-em-panel px-4 py-3">
          <div className="flex items-center gap-2 text-em-danger">
            <AlertTriangle size={16} aria-hidden />
            <span className="flex-1 font-semibold">{t(`err.${failure.code}.title`) === `err.${failure.code}.title` ? t('ui.sys.splash.failed') : t(`err.${failure.code}.title`)}</span>
            <span data-el="sys.splash.code" className="t-mono select-all text-em-muted">{failure.code}</span>
          </div>
          <p className="mt-1 text-em-text-2">{t('ui.sys.splash.failed.body')}</p>
          <div className="mt-3 flex gap-2">
            {onRetry && <Button el="sys.splash.retry" variant="primary" size={28} icon={<RotateCcw size={14} />} onClick={onRetry}>{t('ui.sys.splash.retry')}</Button>}
            {failure.logsDir && onOpenLogs && <Button el="sys.splash.logs" size={28} icon={<FolderOpen size={14} />} onClick={() => onOpenLogs(failure.logsDir!)}>{t('ui.sys.splash.logs')}</Button>}
          </div>
        </div>
      ) : (
        <div className="flex w-[280px] max-w-full flex-col items-center gap-2" role="status" aria-live="polite">
          <div data-el="sys.splash.progress" role="progressbar" aria-label={step} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}
            className="h-[3px] w-full overflow-hidden rounded-full bg-em-panel-2">
            <div className="h-full rounded-full bg-em-accent" style={{ width: `${Math.round(value * 100)}%`, transition: 'width 400ms ease-out' }} />
          </div>
          <div className="flex w-full items-center gap-2 text-em-text-2">
            <span data-el="sys.splash.step" className="flex-1 truncate">{step}</span>
            {elapsed >= SPLASH_ELAPSED_AFTER_MS && <span data-el="sys.splash.elapsed" className="t-mono text-em-muted">{t('ui.sys.splash.elapsed', { s: Math.floor(elapsed / 1000) })}</span>}
          </div>
          {elapsed >= SPLASH_SLOW_AFTER_MS && <div data-el="sys.splash.slow" className="w-full text-[12px] text-em-muted">{t('ui.sys.splash.slow')}</div>}
        </div>
      )}
    </div>
  );
}
