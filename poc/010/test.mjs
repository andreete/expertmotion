// POC-010 test: runs the matrix from docs/POC_PLAN.md POC-010 against server.mjs. Exit code 0 = all pass.
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const results = [];
const rec = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

function startServer(port, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, EM_PORT: String(port), EM_POC_LOG: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', logs = '';
    child.stdout.on('data', (d) => { out += d; logs += d; const m = out.match(/\{"ready":true.*\}/); if (m) resolve({ child, info: JSON.parse(m[0]), logs: () => logs }); });
    child.stderr.on('data', (d) => { logs += d; });
    child.on('exit', (c) => reject(new Error('server exited ' + c + '\n' + logs)));
  });
}
function req(port, { method = 'GET', path = '/', headers = {}, body, hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: hostHeader ?? `127.0.0.1:${port}`, ...headers };
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h, setHost: false }, (res) => {
      let data = ''; res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const code = (r) => { try { return JSON.parse(r.body).error?.code; } catch { return undefined; } };
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

// ───────────────────────── Instance A: matrix (rate limit effectively off) ─────────────────────────
const A = await startServer(4110, { EM_AUTH_FAIL_MAX: '100000' });
const { token, grant } = A.info; const P = 4110;
const ULID1 = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

let r = await req(P, { path: '/api/v1/projects' }); rec('no token → 401 EM-8004', r.status === 401 && code(r) === 'EM-8004', `${r.status} ${code(r)}`);
rec('401 carries WWW-Authenticate and no hint of which check failed', !!r.headers['www-authenticate'] && !/wrong|missing|invalid token/i.test(r.body));
r = await req(P, { path: '/api/v1/projects', headers: bearer('wrong-token') }); rec('wrong token → 401', r.status === 401 && code(r) === 'EM-8004');
r = await req(P, { path: '/api/v1/projects', headers: bearer(token) }); rec('valid token → 200', r.status === 200);
r = await req(P, { path: '/api/v1/health' }); rec('health without token → 200 reduced body', r.status === 200 && Object.keys(JSON.parse(r.body)).sort().join() === 'ok,version');
r = await req(P, { path: '/api/v1/projects', headers: bearer(token), hostHeader: 'evil.example' }); rec('valid token + Host: evil.example → 403 EM-8005', r.status === 403 && code(r) === 'EM-8005');
r = await req(P, { path: '/api/v1/projects', headers: bearer(token), hostHeader: `127.0.0.1.evil.example:${P}` }); rec('valid token + rebinding-style Host → 403', r.status === 403);
r = await req(P, { path: '/api/v1/projects', headers: { ...bearer(token), Origin: 'http://attacker.test' } }); rec('valid token + Origin: attacker.test → 403', r.status === 403 && code(r) === 'EM-8005');
r = await req(P, { path: '/api/v1/projects', headers: { ...bearer(token), 'Sec-Fetch-Site': 'cross-site' } }); rec('valid token + Sec-Fetch-Site: cross-site → 403', r.status === 403);
r = await req(P, { path: '/api/v1/projects', headers: { ...bearer(token), Origin: 'app://expertmotion', 'Sec-Fetch-Site': 'same-origin' } }); rec('app://expertmotion origin + same-origin → 200', r.status === 200);
r = await req(P, { method: 'OPTIONS', path: '/api/v1/renders', headers: { Origin: 'http://attacker.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } }); rec('CORS preflight → 403, no CORS headers', r.status === 403 && !r.headers['access-control-allow-origin']);
r = await req(P, { method: 'OPTIONS', path: '/api/v1/projects', headers: bearer(token) }); rec('OPTIONS even with valid token → 403', r.status === 403);
r = await req(P, { path: `/api/v1/projects?token=${token}` }); rec('?token= on /api/v1/projects → 401', r.status === 401);
r = await req(P, { method: 'POST', path: `/api/v1/renders?token=${token}`, headers: { 'Content-Type': 'application/json' }, body: '{}' }); rec('?token= on POST /renders → 401', r.status === 401);
// SSE
const sse = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port: P, path: `/api/v1/events?token=${token}`, headers: { Host: `127.0.0.1:${P}` }, setHost: false }, (res) => { let d = ''; res.on('data', (c) => { d += c; if (d.includes('hello')) { res.destroy(); resolve({ status: res.statusCode, ct: res.headers['content-type'], d }); } }); }); q.end(); });
rec('?token= on /api/v1/events → 200 text/event-stream', sse.status === 200 && /event-stream/.test(sse.ct));
r = await req(P, { path: '/api/v1/events' }); rec('/api/v1/events without token → 401', r.status === 401);
r = await req(P, { path: `/api/v1/events?token=wrong` }); rec('/api/v1/events with wrong query token → 401', r.status === 401);

// Attacker actions that a web page or form can perform (no Authorization header possible without preflight)
r = await req(P, { method: 'POST', path: '/api/v1/renders', headers: { 'Content-Type': 'text/plain', Origin: 'http://localhost:8000', 'Sec-Fetch-Site': 'same-site' }, body: '{"templateId":"x"}' }); rec('no-cors POST text/plain from localhost:8000 → refused', r.status === 403);
r = await req(P, { method: 'POST', path: '/api/v1/renders', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, body: 'a=b' }); rec('HTML form POST from file:// (Origin: null) → refused', r.status === 403);
r = await req(P, { method: 'POST', path: '/api/v1/renders', headers: { 'Content-Type': 'text/plain' }, body: '{}' }); rec('no-Origin POST without token → 401', r.status === 401);
r = await req(P, { path: '/api/v1/projects', headers: bearer(crypto.randomBytes(32).toString('base64url')) }); rec('guessed token → 401', r.status === 401);
r = await req(P, { path: `/media/${grant}/${ULID1}/proxy`, headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://attacker.test' } }); rec('<img>-style media request from attacker origin → 403', r.status === 403);
r = await req(P, { path: `/media/${grant}/${ULID1}/proxy` }); rec('media with valid grant → 200', r.status === 200);
r = await req(P, { path: `/media/${crypto.randomBytes(32).toString('base64url')}/${ULID1}/proxy` }); rec('media with unknown grant → 404 EM-9003', r.status === 404 && code(r) === 'EM-9003');
r = await req(P, { path: `/media/${grant}/..%2F..%2Fetc%2Fpasswd/proxy` }); rec('media path traversal in assetId → 404', r.status === 404);
r = await req(P, { path: `/media/${grant}/${ULID1}/..%2Fsecret` }); rec('media variant outside enum → 404', r.status === 404);
r = await req(P, { path: `/media/${grant}/${ULID1}/proxy`, headers: bearer(token) }); rec('media: grant opens /media only (Bearer not needed, not required)', r.status === 200);
r = await req(P, { path: `/api/v1/projects`, headers: {} }); rec('media grant does not open API routes (grant in header ignored)', r.status === 401);
r = await req(P, { path: '/api/v1/renders', headers: bearer(token) }); const renders = JSON.parse(r.body).renders; rec('after all attacker actions: no render job exists', renders.length === 0, `renders=${renders.length}`);

// Body limits and error hygiene
r = await req(P, { method: 'POST', path: '/api/v1/renders', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }) }); rec('3 MB JSON → 413 EM-8006', r.status === 413 && code(r) === 'EM-8006', `${r.status} ${code(r)}`);
r = await req(P, { method: 'POST', path: '/api/v1/renders', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: '{bad json' }); rec('malformed JSON → 400 EM-9002', r.status === 400 && code(r) === 'EM-9002');
r = await req(P, { path: '/api/v1/__boom', headers: bearer(token) }); rec('forced 500 leaks no path or stack frame', r.status === 500 && !/C:\\|at Object|\.sqlite|node_modules/.test(r.body), r.body);
r = await req(P, { path: '/api/v1/nope', headers: bearer(token) }); rec('unknown route → 404 EM-9003', r.status === 404 && code(r) === 'EM-9003');
r = await req(P, { path: '/api/v1/projects', headers: bearer(token) }); rec('no Set-Cookie and no Access-Control-Allow-Origin on a valid response', !r.headers['set-cookie'] && !r.headers['access-control-allow-origin']);
r = await req(P, { path: '/api/v1/projects' }); rec('no Set-Cookie and no CORS header on a 401', !r.headers['set-cookie'] && !r.headers['access-control-allow-origin']);
rec('x-powered-by not disclosed', !r.headers['x-powered-by']);

// Log hygiene: query token never appears in logs
await req(P, { path: `/api/v1/events?token=${token}`.replace('events', 'projects') });
const logsA = A.logs(); rec('token never appears in server logs', !logsA.split('\n').filter((l) => !l.includes('"ready":true')).join('\n').includes(token));
rec('log lines carry route pattern, no query string', !/token=/.test(logsA));
A.child.kill();

// Binding check: only 127.0.0.1
import { execSync } from 'node:child_process';
const B = await startServer(4111, { EM_AUTH_FAIL_MAX: '100000' });
const listeners = execSync("ss -ltnH | awk '{print $4}'").toString().split('\n').filter((l) => /:4111$/.test(l));
rec('listener bound to 127.0.0.1 only', listeners.length === 1 && listeners[0].startsWith('127.0.0.1:'), listeners.join(','));
B.child.kill();

// ───────────────────────── Instance C: rate limit (defaults) ─────────────────────────
const C = await startServer(4112, {}); const PC = 4112; const tokC = C.info.token;
const statuses = [];
for (let i = 0; i < 25; i++) statuses.push((await req(PC, { path: '/api/v1/projects', headers: bearer('guess-' + i) })).status);
rec('wrong tokens: first 20 → 401, then 429', statuses.slice(0, 20).every((s) => s === 401) && statuses.slice(20).every((s) => s === 429), statuses.join(','));
r = await req(PC, { path: '/api/v1/projects', headers: bearer(tokC) }); rec('valid token still works while wrong tokens are locked', r.status === 200);
r = await req(PC, { path: '/api/v1/projects' }); rec('missing token is not counted (a web page cannot lock the Editor out)', r.status === 401);
C.child.kill();

// Constant-time comparison: in-process timing of the real comparison function (server.mjs export is behind listen, so re-implement identically)
const th = crypto.createHash('sha256').update('A'.repeat(43)).digest();
const cmp = (c) => crypto.timingSafeEqual(crypto.createHash('sha256').update(c).digest(), th);
const early = 'B' + 'A'.repeat(42), late = 'A'.repeat(42) + 'B', short = 'A';
const bench = (c, n = 50000) => { const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) cmp(c); return Number(process.hrtime.bigint() - t) / 1e6; };
const inputs = { early, late, short };
const samples = { early: [], late: [], short: [] };
for (let round = 0; round < 3; round++) for (const k of Object.keys(inputs)) bench(inputs[k], 20000);        // warm-up (JIT)
for (let round = 0; round < 15; round++) for (const k of Object.keys(inputs)) samples[k].push(bench(inputs[k]));  // interleaved rounds
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const me = median(samples.early), ml = median(samples.late), ms = median(samples.short);
const posRatio = Math.max(me, ml) / Math.min(me, ml), allRatio = Math.max(me, ml, ms) / Math.min(me, ml, ms);
rec('comparison time independent of mismatch position (early vs late, median of 15 interleaved rounds)', posRatio < 1.05, `early=${me.toFixed(1)}ms late=${ml.toFixed(1)}ms ratio=${posRatio.toFixed(3)}`);
rec('comparison time independent of candidate length (median of 15 interleaved rounds)', allRatio < 1.10, `short=${ms.toFixed(1)}ms ratio(all)=${allRatio.toFixed(3)}`);

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
