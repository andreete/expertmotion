// Licence module integration: R-160…R-162 and the licence gate (LICENSE_OPERATIONS §6 steps 11–12, §7, §9).
// No Trial Mode (Operator decision 2026-10-25): until a Licence Key verifies as `licensed`, every /api/v1 route except the
// few the licence screen needs answers EM-5010 (`licenceGate`). Activation attempts are rate-limited (EM-5011, growing lockout).
// Verification is the pure src/license code; this module reads the fingerprint once per launch, loads the newest trusted
// revoked.json, persists the result in the `license` table (token AES-256-GCM sealed), ticks lastSeen hourly and at stop,
// and emits `license.changed`. Only the embedded PUBLIC key table is used; no private key exists in the service.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { EmError, type EmCode } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { computeFingerprint, defaultFingerprintSource, embeddedKeyTable, MAX_REVOCATION_LIST_BYTES, newestTrustedList, readLocalFingerprint, tickClock, verifyLicense,
  type FingerprintSource, type LastSeenStore, type LicenseResult, type LocalFingerprint, type PublicKeyEntry, type TrustedRevocationList } from '../license/index.js';
import { createSecretBox } from '../s3/crypto.js';
import { audit, emit } from '../s3/dto.js';

/** Compiled release date (LICENSE_OPERATIONS §6 step 9). Doc gap: the build script should inject it; until then this constant is the Stage 3 date. */
/** Release date, injected by the service build (scripts/build.mjs define EM_BUILD_DATE); source runs use the value below. */
declare const EM_BUILD_DATE: string | undefined;
export const BUILD_DATE: string = typeof EM_BUILD_DATE === 'string' ? EM_BUILD_DATE : '2026-10-24';
const TOKEN_AAD = 'license:token';

export interface LicenseOptions {
  keys?: () => readonly PublicKeyEntry[];
  fingerprintSource?: FingerprintSource;
  buildDate?: string;
  revocationCopies?: (ctx: ServiceContext) => Array<{ bytes: Uint8Array; signatureText: string }>;
  now?: () => Date;
  tickMs?: number;
  /** activation rate limit (defaults: 5 failed attempts per 60 s, then 60 s lockout doubling per lockout up to 1 h) */
  activationLimit?: Partial<ActivationLimit>;
}
export interface ActivationLimit { maxFailures: number; windowMs: number; baseLockMs: number; maxLockMs: number }
export const DEFAULT_ACTIVATION_LIMIT: ActivationLimit = { maxFailures: 5, windowMs: 60_000, baseLockMs: 60_000, maxLockMs: 3_600_000 };
interface Row { token_enc: Buffer | null; status: string; last_seen_at: string }
interface State { ready: Promise<void>; fp: LocalFingerprint | null; result: LicenseResult | null; revocations: TrustedRevocationList | null; memLastSeen: Date | null; timer: NodeJS.Timeout | null; limiter: ActivationLimiter }

const MESSAGES: Record<string, string> = {
  'EM-5002': 'This key failed verification. Copy it again from your purchase email, including every character.',
  'EM-5003': 'This key is bound to a different computer. Send this computer\'s Machine Code to support to get a key for it.',
  'EM-5004': 'This licence was revoked. Contact support if you believe this is a mistake.',
  'EM-5005': 'This key covers versions released before its updates date; this version is newer. Install an earlier version, or renew.',
  'EM-5006': 'This does not look like an Expertmotion key. Keys start with "EM1-".',
  'EM-5009': 'This key was issued for a newer version of Expertmotion. Update Expertmotion, then enter the key again.',
};

function defaultCopies(ctx: ServiceContext): Array<{ bytes: Uint8Array; signatureText: string }> {
  const dirs = [ctx.resources.licenseDir, ctx.paths.data];
  const out: Array<{ bytes: Uint8Array; signatureText: string }> = [];
  for (const d of dirs) {
    try {
      const f = path.join(d, 'revoked.json');
      if (!fs.existsSync(f) || fs.statSync(f).size > MAX_REVOCATION_LIST_BYTES) continue;
      out.push({ bytes: fs.readFileSync(f), signatureText: fs.readFileSync(`${f}.sig`, 'utf8') });
    } catch { /* unreadable copy ignored */ }
  }
  return out;
}


/**
 * Activation rate limit (SEC, Operator decision 2026-10-25): failed attempts inside `windowMs` are counted; reaching
 * `maxFailures` locks activation for `baseLockMs`, doubling with every further lockout up to `maxLockMs`. A successful
 * activation resets everything. In memory per launch: brute force against an Ed25519 signature is infeasible anyway; the limit
 * slows scripted guessing and keeps the audit log readable.
 */
export class ActivationLimiter {
  private failures: number[] = [];
  private lockouts = 0;
  private lockedUntil = 0;
  constructor(private readonly cfg: ActivationLimit, private readonly clock: () => number = Date.now) {}
  /** milliseconds until the next attempt is allowed (0 = allowed now) */
  retryAfterMs(): number { return Math.max(0, this.lockedUntil - this.clock()); }
  fail(): void {
    const t = this.clock();
    if (this.lockouts > 0 && this.lockedUntil > 0 && t - this.lockedUntil > this.cfg.maxLockMs) this.lockouts = 0;   // long quiet period: start over
    this.failures = this.failures.filter((x) => t - x < this.cfg.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.cfg.maxFailures) {
      this.lockedUntil = t + Math.min(this.cfg.baseLockMs * 2 ** this.lockouts, this.cfg.maxLockMs);
      this.lockouts++;
      this.failures = [];
    }
  }
  succeed(): void { this.failures = []; this.lockouts = 0; this.lockedUntil = 0; }
}

/** Routes the licence screen needs while the product is locked (method + path relative to /api/v1). */
const OPEN_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/health$/], ['GET', /^\/version$/],                                     // status, About line
  ['GET', /^\/license$/], ['POST', /^\/license\/activate$/],                          // status, Machine Code, activation
  ['GET', /^\/settings$/], ['PUT', /^\/settings$/],                                   // language / theme only (checked below)
  ['GET', /^\/events$/],                                                              // license.changed while the screen is open
  ['POST', /^\/service\/shutdown$/], ['GET', /^\/renders$/],                          // Shell lifecycle: close/update checks
];
/** Settings keys the licence screen may change while locked. */
export const UNLICENSED_SETTINGS: ReadonlySet<string> = new Set(['uiLanguage', 'theme']);

export function isOpenWhileUnlicensed(method: string, p: string, body: unknown): boolean {
  if (!OPEN_ROUTES.some(([m, re]) => m === method && re.test(p))) return false;
  if (method === 'PUT' && p === '/settings') return !!body && typeof body === 'object' && Object.keys(body).every((k) => UNLICENSED_SETTINGS.has(k));
  return true;
}

export function createLicenseModule(opts: LicenseOptions = {}): ServiceModule {
  const keys = opts.keys ?? embeddedKeyTable;
  const now = opts.now ?? (() => new Date());
  const states = new WeakMap<ServiceContext, State>();
  const st = (ctx: ServiceContext) => states.get(ctx)!;
  const boxFor = (ctx: ServiceContext) => createSecretBox(ctx.cfg.dbKeyHex);
  const row = (ctx: ServiceContext) => ctx.db.prepare('SELECT token_enc, status, last_seen_at FROM license WHERE id = 1').get() as Row | undefined;

  const lastSeen = (ctx: ServiceContext): LastSeenStore => ({
    get: () => { const r = row(ctx); const s = st(ctx).memLastSeen; const d = r ? new Date(r.last_seen_at) : null; return d && (!s || d > s) ? d : s; },
    set: (d) => { st(ctx).memLastSeen = d; ctx.db.prepare('UPDATE license SET last_seen_at = ? WHERE id = 1').run(d.toISOString()); },
  });
  const verify = (ctx: ServiceContext, token: string | null) => verifyLicense(token, { keys: keys(), fingerprint: st(ctx).fp!, buildDate: opts.buildDate ?? BUILD_DATE, revocations: st(ctx).revocations, now, lastSeen: lastSeen(ctx) });

  function persist(ctx: ServiceContext, r: LicenseResult, token: Buffer | null | undefined) {
    const at = ctx.now(); const ls = (lastSeen(ctx).get() ?? now()).toISOString();
    const lh = r.licensee ? crypto.createHash('sha256').update(r.licensee.lid).digest('hex').slice(0, 16) : null;
    const status = r.status;
    ctx.db.prepare(`INSERT INTO license(id, token_enc, status, tier, licensee_hash, updates_until, last_seen_at, fingerprint_hash, updated_at) VALUES (1,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ${token === undefined ? '' : 'token_enc=excluded.token_enc, '}status=excluded.status, tier=excluded.tier, licensee_hash=excluded.licensee_hash, updates_until=excluded.updates_until, last_seen_at=excluded.last_seen_at, fingerprint_hash=excluded.fingerprint_hash, updated_at=excluded.updated_at`)
      .run(token ?? null, status, r.tier, lh, r.updatesUntil, ls, st(ctx).fp!.fpHex, at);
    st(ctx).result = r;
  }
  function dto(ctx: ServiceContext) {
    const r = st(ctx).result!;
    return { status: r.status, code: r.code ?? null, tier: r.tier, licenseeHash: r.licensee ? crypto.createHash('sha256').update(r.licensee.lid).digest('hex').slice(0, 16) : null,
      licenseeName: r.licensee?.name ?? null, updatesUntil: r.updatesUntil ? `${r.updatesUntil}T00:00:00.000Z` : null, updatesEligible: r.status === 'licensed',
      machineCode: st(ctx).fp!.machineCode, clockAnomaly: r.clockAnomaly, warnings: r.warnings.map((w) => w.code) };
  }
  const changed = (ctx: ServiceContext) => emit(ctx, 'license.changed', { licence: dto(ctx) });

  async function load(ctx: ServiceContext) {
    const s = st(ctx);
    try { s.fp = await readLocalFingerprint(opts.fingerprintSource ?? defaultFingerprintSource()); } catch (e) {
      ctx.log.warn({ err: String(e) }, 'machine fingerprint unreadable'); s.fp = computeFingerprint({ machineGuid: null, diskSerial: null, cpuModel: null });
    }
    s.revocations = newestTrustedList((opts.revocationCopies ?? defaultCopies)(ctx), keys());
    const r0 = row(ctx);
    let token: string | null = null;
    if (r0?.token_enc) { try { token = boxFor(ctx).open(r0.token_enc, TOKEN_AAD); } catch { ctx.log.warn({}, 'stored licence token unreadable; unlicensed'); } }
    const r = verify(ctx, token);
    persist(ctx, r, undefined);
    if (r0 && r0.status !== r.status) { audit(ctx, 'license.status-changed', { from: r0.status, to: r.status, code: r.code ?? null }); changed(ctx); }
  }

  /** Hourly licence check (FR-134): re-verifies the stored key offline (revocation, eligibility vs build date, clock) and announces changes. */
  function recheck(ctx: ServiceContext) {
    const s = st(ctx); const before = s.result;
    let token: string | null = null;
    const r0 = row(ctx);
    if (r0?.token_enc) { try { token = boxFor(ctx).open(r0.token_enc, TOKEN_AAD); } catch { token = null; } }
    const r = verify(ctx, token);
    tickClock({ now, lastSeen: lastSeen(ctx) });
    if (before && before.status === r.status && before.clockAnomaly === r.clockAnomaly) { s.result = r; return; }
    persist(ctx, r, undefined);
    if (before && before.status !== r.status) audit(ctx, 'license.status-changed', { from: before.status, to: r.status, code: r.code ?? null });
    changed(ctx);
  }

  return {
    name: 'license',
    start(ctx) {
      const s: State = { ready: Promise.resolve(), fp: null, result: null, revocations: null, memLastSeen: null, timer: null,
        limiter: new ActivationLimiter({ ...DEFAULT_ACTIVATION_LIMIT, ...opts.activationLimit }, () => now().getTime()) };
      states.set(ctx, s);
      ctx.hooks.isLicensed = () => s.result?.status === 'licensed';
      s.ready = load(ctx).catch((e: unknown) => { ctx.log.error({ err: String(e) }, 'licence load failed'); });
      s.timer = setInterval(() => { if (s.fp) { try { recheck(ctx); } catch { /* db closed */ } } }, opts.tickMs ?? 3_600_000);   // FR-134: startup + hourly
      s.timer.unref();
    },
    async stop(ctx) {
      const s = states.get(ctx); if (!s) return;
      if (s.timer) clearInterval(s.timer);
      await s.ready;
      if (s.fp) { try { tickClock({ now, lastSeen: lastSeen(ctx) }); } catch { /* ignore */ } }
    },
    /** Licence gate: mounted on /api/v1 before every module's routes (http/app.ts). */
    middleware(ctx): RequestHandler {
      return (req: Request, res: Response, next: NextFunction) => {
        const s = states.get(ctx);
        void (s?.ready ?? Promise.resolve()).then(() => {
          if (s?.result?.status === 'licensed' || isOpenWhileUnlicensed(req.method, req.path, req.body)) return next();
          const status = s?.result?.status ?? 'unlicensed';
          res.status(403).json({ error: { code: 'EM-5010', message: 'Activate Expertmotion with a Licence Key to continue.', details: { status } } });
        }, next);
      };
    },
    register(router, ctx) {
      route(router, 'get', '/license', {}, async () => { await st(ctx).ready; return dto(ctx); });

      route(router, 'post', '/license/activate', { body: z.object({ key: z.string().min(40).max(4096) }).strict() }, async ({ body, res }) => {
        await st(ctx).ready;
        const limiter = st(ctx).limiter;
        const wait = limiter.retryAfterMs();
        if (wait > 0) {
          const seconds = Math.ceil(wait / 1000);
          res.setHeader('Retry-After', String(seconds));
          throw new EmError('EM-5011', `Too many activation attempts. Try again in ${seconds} seconds.`, { status: 429, details: { retryAfterSeconds: seconds } });
        }
        const r = verify(ctx, body.key);
        if (r.status !== 'licensed') {
          limiter.fail();
          audit(ctx, 'license.rejected', { code: r.code ?? 'EM-5006' });
          const code = (r.code ?? 'EM-5006') as EmCode;
          throw new EmError(code, MESSAGES[code] ?? 'This key failed verification.', { status: 422, details: { status: r.status, ...(code === 'EM-5005' && r.updatesUntil ? { date: r.updatesUntil } : {}) } });
        }
        limiter.succeed();
        persist(ctx, r, boxFor(ctx).seal(r.keyInput ?? body.key.trim(), TOKEN_AAD));
        audit(ctx, 'license.activated', { tier: r.tier, status: r.status });
        changed(ctx);
        return dto(ctx);
      });

      route(router, 'post', '/license/deactivate', { body: z.object({ confirm: z.literal(true) }).strict() }, async () => {
        await st(ctx).ready;
        persist(ctx, verify(ctx, null), null);
        audit(ctx, 'license.deactivated');
        changed(ctx);
        return dto(ctx);
      });
    },
  };
}
export const licenseModule: ServiceModule = createLicenseModule();
