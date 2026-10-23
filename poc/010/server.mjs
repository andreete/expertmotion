// POC-010: Service Token + Host/Origin guard. Implements SEC-004…SEC-016 for three routes. Throwaway.
import express from 'express';
import crypto from 'node:crypto';

const PORT = Number(process.env.EM_PORT ?? 4110);
const TOKEN = process.env.EM_TOKEN ?? crypto.randomBytes(32).toString('base64url');
const FAIL_MAX = Number(process.env.EM_AUTH_FAIL_MAX ?? 20);     // SEC-011
const LOCK_MS = Number(process.env.EM_AUTH_LOCK_MS ?? 60_000);
const DEV_ORIGIN = process.env.EM_UI_ORIGIN ?? '';               // dev-only extra origin (SEC-006)
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const VARIANTS = new Set(['original', 'playable', 'proxy', 'thumb', 'filmstrip', 'waveform']);
const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });

// sha256 both sides so timingSafeEqual always compares equal-length buffers (SEC-004: no length leak).
const tokenHash = crypto.createHash('sha256').update(TOKEN).digest();
export function tokenMatches(candidate) {
  const h = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
  return crypto.timingSafeEqual(h, tokenHash);
}

const state = { renders: [], failures: [], lockedUntil: 0 };
const mediaGrants = new Map([[process.env.EM_POC_GRANT ?? crypto.randomBytes(32).toString('base64url'), { projectId: 'p1' }]]);
const GRANT = [...mediaGrants.keys()][0];
const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// Access log: method, route pattern, status, duration; never query, headers or body (SEC-015).
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const pattern = req.route?.path ?? req.path.replace(/^\/media\/[^/]+\/.*/, '/media/:grant/…').split('?')[0];
    if (process.env.EM_POC_LOG === '1') console.log(JSON.stringify({ m: req.method, r: pattern, s: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
  });
  next();
});

// 1. Host / Origin / Sec-Fetch-Site guard (SEC-006), before auth and before routing.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set(['app://expertmotion', ...(DEV_ORIGIN ? [DEV_ORIGIN] : [])]);
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(String(req.headers.host ?? '').toLowerCase())) return err(res, 403, 'EM-8005', 'Request refused.');
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return err(res, 403, 'EM-8005', 'Request refused.');
  const sfs = req.headers['sec-fetch-site'];
  if (sfs !== undefined && !['same-origin', 'none'].includes(String(sfs)) && !(DEV_ORIGIN && origin === DEV_ORIGIN)) return err(res, 403, 'EM-8005', 'Request refused.');
  if (req.method === 'OPTIONS') return err(res, 403, 'EM-8005', 'Request refused.');   // no CORS, SEC-012
  next();
});

// 2. Media grants (exception 2 of SEC-016): bound to /media/* only.
app.get('/media/:grant/:assetId/:variant', (req, res) => {
  const { grant, assetId, variant } = req.params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(grant) || !ULID.test(assetId) || !VARIANTS.has(variant)) return err(res, 404, 'EM-9003', 'Not found.');
  if (!mediaGrants.has(grant)) return err(res, 404, 'EM-9003', 'Not found.');
  res.type('application/octet-stream').send(Buffer.from('poc-media-bytes'));
});

// 3. Auth (SEC-004/005/016). Health is open and reduced. Token in query only on /api/v1/events.
function auth(req, res, next) {
  if (req.method === 'GET' && req.path === '/api/v1/health') return next();
  const header = req.headers.authorization;
  const queryOk = req.method === 'GET' && req.path === '/api/v1/events';
  let presented = null;
  if (typeof header === 'string' && header.startsWith('Bearer ')) presented = header.slice(7);
  else if (queryOk && typeof req.query.token === 'string') presented = req.query.token;
  if (presented === null) { res.set('WWW-Authenticate', 'Bearer realm="expertmotion"'); return err(res, 401, 'EM-8004', 'Authentication required.'); }
  if (tokenMatches(presented)) return next();               // valid tokens are never rate-limited
  // Wrong token presented: count it. Missing tokens are not counted (a web page cannot add the header
  // without a preflight, so a page cannot lock the Editor out; see process.md Entry 3 / SEC-011).
  const now = Date.now();
  state.failures = state.failures.filter((t) => now - t < 60_000); state.failures.push(now);
  if (state.failures.length > FAIL_MAX || now < state.lockedUntil) {
    if (now >= state.lockedUntil) state.lockedUntil = now + LOCK_MS;
    res.set('Retry-After', String(Math.ceil((state.lockedUntil - now) / 1000)));
    return err(res, 429, 'EM-9005', 'Too many attempts. Try again in a minute.');
  }
  res.set('WWW-Authenticate', 'Bearer realm="expertmotion"');
  return err(res, 401, 'EM-8004', 'Authentication required.');
}
app.use(auth);

app.use(express.json({ limit: '2mb' }));                    // after auth (SEC-004, SEC-009)

app.get('/api/v1/health', (_req, res) => res.json({ ok: true, version: '0.0.0-poc' }));
app.get('/api/v1/projects', (_req, res) => res.json({ projects: [{ id: 'p1', name: 'Demo' }] }));
app.post('/api/v1/renders', (req, res) => { state.renders.push({ id: state.renders.length + 1, body: req.body }); res.status(202).json({ id: state.renders.length }); });
app.get('/api/v1/renders', (_req, res) => res.json({ renders: state.renders }));
app.get('/api/v1/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\nevent: hello\ndata: {"ok":true}\n\n');
  const t = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => clearInterval(t));
});
app.get('/api/v1/__boom', () => { throw new Error('secret path C:\\Users\\x\\db.sqlite at Object.<anonymous>'); });

// Central error mapper (SEC-013): code + generic message only.
app.use((e, _req, res, _next) => {
  if (e?.type === 'entity.too.large') return err(res, 413, 'EM-8006', 'Request too large.');
  if (e?.type === 'entity.parse.failed') return err(res, 400, 'EM-9002', 'Invalid request.');
  if (process.env.EM_POC_LOG === '1') console.error('internal', e);
  return err(res, 500, 'EM-9001', 'Something went wrong.');
});
app.use((_req, res) => err(res, 404, 'EM-9003', 'Not found.'));

const server = app.listen(PORT, '127.0.0.1', () => {
  const a = server.address();
  if (a.address !== '127.0.0.1') { console.error('refusing to run: not bound to 127.0.0.1'); process.exit(1); }   // SEC-007
  console.log(JSON.stringify({ ready: true, port: a.port, token: TOKEN, grant: GRANT }));
});
