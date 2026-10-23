// POC-010 browser half: a real Chromium page from another origin (http://localhost:8010) and from file:// attacks the Service.
import http from 'node:http'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
import { launch, openPage } from './cdp.mjs';
const here = new URL('.', import.meta.url).pathname;
const results = []; const rec = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const svc = spawn(process.execPath, [`${here}../010/server.mjs`], { env: { ...process.env, EM_PORT: '4110', EM_POC_LOG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; const info = await new Promise((res) => svc.stdout.on('data', (d) => { logs += d; const m = logs.match(/\{"ready":true.*\}/); if (m) res(JSON.parse(m[0])); }));
const page = fs.readFileSync(`${here}attacker.html`);
const atk = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); }).listen(8010, '127.0.0.1');
const chrome = await launch(9333);
try {
  for (const [label, url] of [['http://localhost:8010', 'http://localhost:8010/attacker.html'], ['file://', `file://${here}attacker.html`]]) {
    const p = await openPage(chrome.port, url);
    const r = await p.evaluate('window.__run()');
    console.log(`INFO  ${label} page results: ${JSON.stringify(r)}`);
    rec(`${label}: cross-origin GET cannot read data`, String(r.corsGet).startsWith('blocked'), r.corsGet);
    rec(`${label}: guessed Bearer header is stopped by the CORS preflight`, String(r.bearerGuess).startsWith('blocked'), r.bearerGuess);
    rec(`${label}: EventSource without token fails`, r.eventSource === 'error', r.eventSource);
    rec(`${label}: <img> with an unknown media grant fails`, r.img === 'error', r.img);
    p.close();
  }
  const lines = logs.split('\n').filter((l) => l.startsWith('{"m"')).map((l) => JSON.parse(l));
  const posts = lines.filter((l) => l.m === 'POST');
  rec('every POST that reached the Service was refused (403/401)', posts.length > 0 && posts.every((l) => l.s === 403 || l.s === 401), JSON.stringify(posts.map((l) => l.s)));
  rec('no request from the pages was answered 2xx except /health', lines.filter((l) => l.s < 300 && !String(l.r).includes('health')).length === 0, `${lines.length} requests logged`);
  const check = await (await fetch('http://127.0.0.1:4110/api/v1/renders', { headers: { Authorization: `Bearer ${info.token}` } })).json();
  rec('server state unchanged: no render job was created', check.renders.length === 0, `renders=${check.renders.length}`);
  rec('token never appears in server logs', !logs.split('\n').filter((l) => !l.includes('"ready"')).join('\n').includes(info.token));
} finally { chrome.close(); atk.close(); svc.kill(); }
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
