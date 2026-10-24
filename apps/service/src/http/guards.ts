// Request guards (SECURITY SEC-004…016; ported from POC-010, which passed its curl and browser test suites).
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ServiceConfig } from '../config.js';

const err = (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });

export function makeTokenMatcher(token: string): (candidate: unknown) => boolean {
  const h = crypto.createHash('sha256').update(token).digest();
  return (c) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(c ?? '')).digest(), h);
}

/**
 * Host / Origin / Sec-Fetch-Site allow-list; OPTIONS refused except for the dev UI origin (no CORS in production).
 * Exception for `/media/<grant>/…` (R-040/R-041; the grant in the path is the credential, SEC-010): the Player (`app://expertmotion`,
 * dev UI origin) and the Remotion render page during a render job (`mediaOrigins`, added by the renders module for the job's
 * duration) fetch media cross-origin with Range, so those origins get CORS headers on media paths only.
 */
export function hostOriginGuard(cfg: ServiceConfig, mediaOrigins: ReadonlySet<string> = new Set()) {
  const hosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  const origins = new Set(['app://expertmotion', ...(cfg.dev && cfg.uiOrigin ? [cfg.uiOrigin, cfg.uiOrigin.replace('127.0.0.1', 'localhost')] : [])]);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return err(res, 403, 'EM-8005', 'Request refused.');
    const origin = req.headers.origin;
    const media = req.path.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS');
    if (media) {
      if (origin !== undefined && !origins.has(origin) && !mediaOrigins.has(origin)) return err(res, 403, 'EM-8005', 'Request refused.');
      if (origin !== undefined) {
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD'); res.setHeader('Access-Control-Allow-Headers', 'Range');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }
    if (origin !== undefined && !origins.has(origin)) return err(res, 403, 'EM-8005', 'Request refused.');
    const sfs = req.headers['sec-fetch-site'];
    const devOrigin = cfg.dev && origin !== undefined && origins.has(origin) && origin !== 'app://expertmotion';
    if (sfs !== undefined && !['same-origin', 'none'].includes(String(sfs)) && !devOrigin) return err(res, 403, 'EM-8005', 'Request refused.');
    if (devOrigin) { res.setHeader('Access-Control-Allow-Origin', origin!); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Expertmotion-Caller, Idempotency-Key, Last-Event-ID'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE'); }
    if (req.method === 'OPTIONS') return devOrigin ? res.status(204).end() : err(res, 403, 'EM-8005', 'Request refused.');
    next();
  };
}

/** Bearer token on every /api/v1 route except GET /health; `?token=` only on the SSE routes; wrong tokens rate-limited (SEC-011 as amended by POC-010). */
export function authGuard(cfg: ServiceConfig, opts: { failMax?: number; lockMs?: number } = {}) {
  const matches = makeTokenMatcher(cfg.token);
  const failMax = opts.failMax ?? 20, lockMs = opts.lockMs ?? 60_000;
  let failures: number[] = [], lockedUntil = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/v1/')) return next();
    if (req.method === 'GET' && req.path === '/api/v1/health') return next();
    const sse = req.method === 'GET' && (req.path === '/api/v1/events' || /^\/api\/v1\/renders\/[^/]+\/events$/.test(req.path));
    const header = req.headers.authorization;
    let presented: string | null = null;
    if (typeof header === 'string' && header.startsWith('Bearer ')) presented = header.slice(7);
    else if (sse && typeof req.query['token'] === 'string') presented = req.query['token'];
    if (presented === null) { res.setHeader('WWW-Authenticate', 'Bearer realm="expertmotion"'); return err(res, 401, 'EM-8004', 'Authentication required.'); }
    if (matches(presented)) return next();
    const now = Date.now();
    failures = failures.filter((t) => now - t < 60_000); failures.push(now);
    if (failures.length > failMax || now < lockedUntil) {
      if (now >= lockedUntil) lockedUntil = now + lockMs;
      res.setHeader('Retry-After', String(Math.ceil((lockedUntil - now) / 1000)));
      return err(res, 429, 'EM-9005', 'Too many attempts. Try again in a minute.');
    }
    res.setHeader('WWW-Authenticate', 'Bearer realm="expertmotion"');
    return err(res, 401, 'EM-8004', 'Authentication required.');
  };
}
