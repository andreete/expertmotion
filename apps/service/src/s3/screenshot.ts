// web.screenshot (FR-305, ADR-041): a PNG of a page's top through the bundled Chrome Headless Shell, driven by Remotion's browser
// classes (`openBrowser` + the renderer's BrowserPage `goto` and the CDP session's `Page.captureScreenshot`, pinned 4.0.535).
// The command-line `--screenshot` of chrome-headless-shell hangs on the build host, so it is never used. One Chrome at a time:
// screenshots queue behind each other here, wait for the render queue to go idle, and borrow the warm Engine browser when one
// is held (engine-browser.ts) instead of launching a second one. Failures map to EM-4409.
import { EmError, errorMessage } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { engineBrowserOf } from '../services/engine-browser.js';
import { renderServiceOf } from '../s2/render-service.js';
import type { ScreenshotViewport } from './research.js';

export const SCREENSHOT_NAV_TIMEOUT_MS = 20_000;
/** Overall cap (browser start + navigation + capture); the render queue wait has its own cap. */
export const SCREENSHOT_TOTAL_TIMEOUT_MS = 45_000;
export const SCREENSHOT_RENDER_WAIT_MS = 45_000;
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 Expertmotion';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Expertmotion';
/** phone: a 1080×1920 shot at scale 1 with a phone user agent; desktop: 1440×900 CSS px at 1.5× (2160×1350 PNG). */
export const VIEWPORTS: Record<ScreenshotViewport, { width: number; height: number; scale: number; mobile: boolean; userAgent: string }> = {
  phone: { width: 1080, height: 1920, scale: 1, mobile: true, userAgent: PHONE_UA },
  desktop: { width: 1440, height: 900, scale: 1.5, mobile: false, userAgent: DESKTOP_UA },
};

export interface ScreenshotResult { png: Buffer; width: number; height: number }
/** The subset of Remotion's HeadlessBrowser / Page the screenshot needs (kept loose so tests can fake it). */
export interface BrowserForShots {
  newPage(o: { context: () => null; logLevel: 'error'; indent: boolean; pageIndex: number; onBrowserLog: null; onLog: () => void }): Promise<PageForShots>;
  close(o: { silent: boolean }): Promise<unknown>;
}
export interface PageForShots {
  setViewport(v: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  setDefaultNavigationTimeout?(ms: number): void;
  goto(o: { url: string; timeout: number }): Promise<unknown>;
  _client(): { send(method: string, params?: Record<string, unknown>): Promise<{ value: unknown }> };
  close(): Promise<void>;
}

/** PNG IHDR → width / height (the honest size of what was captured). */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.subarray(1, 4).toString('latin1') !== 'PNG') return { width: 0, height: 0 };
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
});

/** One page → PNG on an open browser. The page is always closed; the browser is the caller's. */
export async function captureOnBrowser(browser: BrowserForShots, url: string, viewport: ScreenshotViewport, timeoutMs = SCREENSHOT_NAV_TIMEOUT_MS): Promise<ScreenshotResult> {
  const v = VIEWPORTS[viewport];
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => undefined });
  try {
    const cdp = page._client();
    await cdp.send('Network.setUserAgentOverride', { userAgent: v.userAgent, acceptLanguage: 'id,en;q=0.8' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { mobile: v.mobile, width: v.width, height: v.height, deviceScaleFactor: v.scale, screenOrientation: { angle: 0, type: 'portraitPrimary' } });
    if (v.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true }).catch(() => undefined);
    page.setDefaultNavigationTimeout?.(timeoutMs);
    await page.goto({ url, timeout: timeoutMs });
    await new Promise((r) => setTimeout(r, 600));                                  // lazy pictures and web fonts of the first screen
    const { value } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: v.width, height: v.height, scale: 1 }, captureBeyondViewport: false, fromSurface: true });
    const data = (value as { data?: unknown } | undefined)?.data;
    if (typeof data !== 'string' || !data) throw new Error('Chrome returned no picture');
    const png = Buffer.from(data, 'base64');
    const size = pngSize(png);
    if (!size.width) throw new Error('Chrome returned no PNG');
    return { png, ...size };
  } finally { await page.close().catch(() => undefined); }
}

let turn: Promise<unknown> = Promise.resolve();
/** Screenshots run one after another (and never beside a render): the shared-server rule "one Chrome at a time". */
export function screenshotTurn<T>(fn: () => Promise<T>): Promise<T> {
  const p = turn.then(fn, fn);
  turn = p.catch(() => undefined);
  return p;
}

export interface ScreenshotDeps {
  /** Opens a browser (default: Remotion `openBrowser` with ctx.resources.browserExecutable, swangle). */
  open?: () => Promise<BrowserForShots>;
  /** Waits for the render queue to go idle (default: renderServiceOf(ctx).idle(), capped). */
  waitForRenders?: () => Promise<void>;
}
export async function openShotBrowser(ctx: ServiceContext): Promise<BrowserForShots> {
  const R = await import('@remotion/renderer');
  const b = await R.openBrowser('chrome', { browserExecutable: ctx.resources.browserExecutable ?? null, chromiumOptions: { gl: 'swangle', headless: true }, logLevel: 'error' });
  return b as unknown as BrowserForShots;
}
/**
 * FR-305: the PNG of `url`'s top in the chosen viewport. Borrows the warm Engine browser when it is held, else opens one and
 * closes it afterwards. Every failure (no browser, navigation timeout, a page that refuses to load) is EM-4409.
 */
export async function screenshotPage(ctx: ServiceContext, url: string, viewport: ScreenshotViewport, deps: ScreenshotDeps = {}): Promise<ScreenshotResult> {
  return screenshotTurn(async () => {
    const t0 = Date.now();
    try {
      await withTimeout(deps.waitForRenders ? deps.waitForRenders() : renderServiceOf(ctx).idle(), SCREENSHOT_RENDER_WAIT_MS, 'waiting for the running render');
      const warm = engineBrowserOf(ctx);
      const borrowed = warm ? await warm.acquire() : null;
      let own: BrowserForShots | null = null; let healthy = false;
      try {
        const browser = (borrowed as unknown as BrowserForShots | null) ?? (own = await withTimeout(deps.open ? deps.open() : openShotBrowser(ctx), SCREENSHOT_TOTAL_TIMEOUT_MS, 'starting Chrome'));
        const r = await withTimeout(captureOnBrowser(browser, url, viewport), SCREENSHOT_TOTAL_TIMEOUT_MS, 'capturing the page');
        healthy = true;
        ctx.log.info({ host: new URL(url).hostname, viewport, width: r.width, height: r.height, bytes: r.png.length, ms: Date.now() - t0, borrowed: !!borrowed }, 'web.screenshot captured');
        return r;
      } finally {
        if (borrowed) warm!.release(healthy);
        if (own) await own.close({ silent: true }).catch(() => undefined);
      }
    } catch (e) {
      if (e instanceof EmError) throw e;
      const why = errorMessage(e).replace(/\s+/g, ' ').slice(0, 160);
      ctx.log.warn({ host: (() => { try { return new URL(url).hostname; } catch { return url.slice(0, 60); } })(), viewport, ms: Date.now() - t0, err: why }, 'web.screenshot failed');
      throw new EmError('EM-4409', `The page could not be captured (${why}).`, { details: { url, viewport } });
    }
  });
}
