// OPT-IN real-browser check of web.screenshot (FR-305, ADR-041): the bundled / Remotion Chrome Headless Shell captures a tiny local
// http page on a 41xx port through `screenshotPage` (openBrowser → newPage → goto → CDP Page.captureScreenshot). Skipped unless
// EM_SCREENSHOT_SMOKE=1 (Chrome start + capture takes several seconds and the shared server allows one Chrome at a time):
//   EM_SCREENSHOT_SMOKE=1 bash scripts/run-capped.sh npx vitest run apps/service/test/s3/screenshot-real.test.ts
// Last real run on the shared Linux server: see process.md Entry 40 (service agent report).
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { pngSize, screenshotPage } from '../../src/s3/screenshot.js';

const enabled = process.env['EM_SCREENSHOT_SMOKE'] === '1';
const PORT = 4173;
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Expertmotion shot</title>
<style>body{margin:0;background:#101010;color:#FFD400;font:bold 64px sans-serif}h1{padding:40px}.box{width:90vw;height:40vh;background:#E53935;margin:20px auto}</style></head>
<body><h1>NETIZEN BOIKOT!</h1><div class="box"></div><p style="color:#fff;padding:40px">UA: <span id="ua"></span></p><script>document.getElementById('ua').textContent=navigator.userAgent</script></body></html>`;

describe.skipIf(!enabled)('web.screenshot through the real Chrome Headless Shell (opt-in)', () => {
  let s: TestService; let server: http.Server;
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule] });
    server = http.createServer((req, res) => { if (req.url === '/slow') { setTimeout(() => { res.end(PAGE); }, 30_000); return; } res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(PAGE); });
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await s.close(); });

  it('captures a 1080×1920 phone PNG and a 2160×1350 desktop PNG of a local page', { timeout: 120_000 }, async () => {
    const t0 = Date.now();
    const phone = await screenshotPage(s.ctx, `http://127.0.0.1:${PORT}/`, 'phone', { waitForRenders: async () => undefined });
    const tPhone = Date.now() - t0;
    expect(pngSize(phone.png)).toEqual({ width: 1080, height: 1920 });
    expect(phone.png.length).toBeGreaterThan(2000);
    const t1 = Date.now();
    const desktop = await screenshotPage(s.ctx, `http://127.0.0.1:${PORT}/`, 'desktop', { waitForRenders: async () => undefined });
    expect(pngSize(desktop.png)).toEqual({ width: 2160, height: 1350 });
    // eslint-disable-next-line no-console
    console.log(`[screenshot-real] phone ${phone.png.length} B in ${tPhone} ms (incl. Chrome start), desktop ${desktop.png.length} B in ${Date.now() - t1} ms`);
  }, 120_000);

  it('a page that never answers fails with EM-4409 within the navigation timeout', { timeout: 90_000 }, async () => {
    const t0 = Date.now();
    await expect(screenshotPage(s.ctx, `http://127.0.0.1:${PORT}/slow`, 'phone', { waitForRenders: async () => undefined })).rejects.toMatchObject({ code: 'EM-4409' });
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 90_000);
});
