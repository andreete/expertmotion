// Minimal Chrome DevTools Protocol client (Node 22 global WebSocket) driving Remotion's pinned Chrome Headless Shell.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const root = new URL('../../', import.meta.url).pathname;
export const CHROME = `${root}node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell`;

export async function launch(port = 9333) {
  const userDir = fs.mkdtempSync('/tmp/em-cdp-');
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, '--no-first-run', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const close = () => { proc.kill('SIGKILL'); fs.rmSync(userDir, { recursive: true, force: true }); };
  return { port, close };
}
export async function openPage(port, url, { width = 800, height = 1000 } = {}) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const events = []; const consoleLines = [];
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { r, j } = pending.get(msg.id); pending.delete(msg.id); msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result); } else { events.push(msg); if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(msg.params.args.map((a) => a.value ?? a.description).join(' ')); if (msg.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION ' + JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)); } };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  for (let i = 0; i < 200 && !events.some((e) => e.method === 'Page.loadEventFired'); i++) await new Promise((r) => setTimeout(r, 50));
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const screenshot = async (clip) => Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false })).data, 'base64');
  return { send, evaluate, screenshot, consoleLines, close: () => ws.close() };
}
