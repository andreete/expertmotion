// Startup orchestration (FR-184): the splash is on screen from the first frame; the live runtime (which waits for the Shell's
// first `ready`) is created behind it. Service state pushes drive the splash step; a failure before the Editor mounted shows
// the splash error (Try again → Shell retry, else reload; Open log folder). Once the Editor mounted, later failures are the
// Editor's own sys.fatal (App.tsx), so a mounted Editor never unmounts because of a push.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ShellBridge } from '../api/client.js';
import type { Runtime, ServiceStatus } from '../state/runtime.js';
import { Splash } from './Splash.js';
import { noteShellSince, startupLang } from './progress.js';

export interface BootProps {
  /** Creates the runtime; `onService` receives every service state as soon as the channel exists. Called once. */
  start: (onService: (s: ServiceStatus) => void) => Promise<Runtime>;
  bridge?: ShellBridge | undefined;
  children: (runtime: Runtime) => ReactNode;
}

export function Boot({ start, bridge, children }: BootProps) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [svc, setSvc] = useState<ServiceStatus | null>(null);
  const mounted = useRef(false);
  const live = useRef(true);                                   // a ref, not a closure flag: StrictMode re-runs the effect once
  const started = useRef<Promise<Runtime> | null>(null);
  useEffect(() => {
    live.current = true;
    started.current ??= start((s) => { noteShellSince(s.sinceMs); if (live.current) setSvc(s); });
    void started.current.then((rt) => { if (live.current) setRuntime(rt); });
    return () => { live.current = false; };
  }, [start]);
  const failed = svc?.status === 'failed';
  if (runtime && (!failed || mounted.current)) { mounted.current = true; return <>{children(runtime)}</>; }
  const retry = async () => {
    const ok = bridge?.retryStartup ? await bridge.retryStartup().catch(() => false) : false;
    if (!ok) window.location.reload();
  };
  return (
    <Splash lang={startupLang()} phase={svc?.status === 'starting' ? svc.phase : svc?.status === 'ready' ? 'project' : undefined} progress={svc?.progress}
      failure={failed ? { code: svc.code ?? 'EM-8002', logsDir: svc.logsDir } : null}
      onRetry={() => void retry()}
      {...(bridge?.openFolder ? { onOpenLogs: (dir: string) => void bridge.openFolder?.(dir) } : {})} />
  );
}
