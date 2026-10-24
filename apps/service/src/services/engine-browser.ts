// FR-003 Engine browser warm-up. After start the Service may launch the Chrome Headless Shell once, in the background, so the
// first export does not pay the browser start. Memory policy (PERFORMANCE §2, shared-server rule): at most ONE browser, only when
// plenty of RAM is free, only after an idle delay, closed again after an idle period; the render queue borrows this same browser
// (Remotion `puppeteerInstance`) instead of launching a second one. A failed warm-up is logged and ignored (renders launch their own).
import type { ServiceContext } from '../context.js';

export interface BrowserLike { close(opts: { silent: boolean }): Promise<unknown> }
export interface WarmTimers { set(fn: () => void, ms: number): unknown; clear(t: unknown): void }
export interface EngineBrowserOptions {
  open: () => Promise<BrowserLike>;
  freeMemBytes: () => number;
  /** Below this much free RAM the warm-up is skipped (default 3 GiB: the Standard profile needs 2 GiB on top of the browser). */
  minFreeBytes?: number;
  /** An idle warm browser is closed after this long (default 120 s). */
  idleCloseMs?: number;
  timers?: WarmTimers;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const realTimers: WarmTimers = { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (t) => clearTimeout(t as NodeJS.Timeout) };

export class EngineBrowser {
  private browser: BrowserLike | null = null;
  private opening: Promise<BrowserLike | null> | null = null;
  private borrowed = false;
  private idle: unknown = null;
  private stopped = false;
  private readonly t: WarmTimers;
  constructor(private readonly o: EngineBrowserOptions) { this.t = o.timers ?? realTimers; }

  /** True while a launched browser is held (idle or lent to a render). */
  get ready(): boolean { return this.browser !== null; }

  /** Launches the browser unless one exists, memory is short or the service is stopping. Never throws. */
  async warm(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.browser) return true;
    if (this.opening) return (await this.opening) !== null;
    const free = this.o.freeMemBytes();
    if (free < (this.o.minFreeBytes ?? 3 * 1024 ** 3)) { this.o.log?.('engine warm-up skipped: low memory', { freeMb: Math.round(free / 1048576) }); return false; }
    this.opening = this.o.open().then((b) => {
      if (this.stopped) { void b.close({ silent: true }).catch(() => undefined); return null; }
      this.browser = b; this.armIdle(); this.o.log?.('engine browser warm'); return b;
    }, (e: unknown) => { this.o.log?.('engine warm-up failed', { err: String(e).slice(0, 300) }); return null; })
      .finally(() => { this.opening = null; });
    return (await this.opening) !== null;
  }

  /** The warm browser for one render (null: none warm, or already lent, so the caller launches its own). */
  async acquire(): Promise<BrowserLike | null> {
    if (this.opening) await this.opening;
    if (!this.browser || this.borrowed) return null;
    this.borrowed = true; this.disarm();
    return this.browser;
  }

  /** Back from a render. An unhealthy browser (failed/cancelled render) is closed rather than reused. */
  release(healthy: boolean): void {
    if (!this.borrowed) return;
    this.borrowed = false;
    if (!healthy || this.stopped) { void this.drop(); return; }
    this.armIdle();
  }

  async stop(): Promise<void> { this.stopped = true; if (this.opening) await this.opening; await this.drop(); }

  private armIdle(): void { this.disarm(); this.idle = this.t.set(() => { if (!this.borrowed) void this.drop(); }, this.o.idleCloseMs ?? 120_000); }
  private disarm(): void { if (this.idle !== null) { this.t.clear(this.idle); this.idle = null; } }
  private async drop(): Promise<void> {
    this.disarm();
    const b = this.browser; this.browser = null; this.borrowed = false;
    if (b) { try { await b.close({ silent: true }); } catch { /* already gone */ } }
  }
}

const instances = new WeakMap<ServiceContext, EngineBrowser>();
export const engineBrowserOf = (ctx: ServiceContext): EngineBrowser | undefined => instances.get(ctx);
export function setEngineBrowser(ctx: ServiceContext, b: EngineBrowser | undefined): void { if (b) instances.set(ctx, b); else instances.delete(ctx); }

/**
 * Whether to warm at all: `EM_ENGINE_WARMUP=1` forces it on, `=0` off; otherwise only packaged builds (the bundled browser exists
 * and the machine is a Creator PC), never under tests.
 */
export function warmupEnabled(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  if (env['EM_ENGINE_WARMUP'] === '1') return true;
  if (env['EM_ENGINE_WARMUP'] === '0' || env['VITEST']) return false;
  return packaged;
}
