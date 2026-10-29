// Route helper: Zod-validated params/query/body, async handlers, EmError → envelope. Every module registers through this.
import type { Request, Response, Router } from 'express';
import type { z } from 'zod';
import { EmError, errorMessage } from '@expertmotion/shared';

export interface Handler<P, Q, B> { (input: { params: P; query: Q; body: B; req: Request; res: Response }): unknown | Promise<unknown> }
export interface RouteSpec<P, Q, B> { params?: z.ZodType<P>; query?: z.ZodType<Q>; body?: z.ZodType<B>; status?: number }
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const zodToEm = (where: string, e: z.ZodError) => { const i = e.issues[0]; return new EmError('EM-9002', `Invalid request: ${i?.message ?? 'bad input'}`, { status: 400, path: [where, ...(i?.path ?? []).map(String)].join('.') }); };

export function route<P = Record<string, string>, Q = Record<string, unknown>, B = unknown>(router: Router, method: Method, path: string, spec: RouteSpec<P, Q, B>, handler: Handler<P, Q, B>): void {
  router[method](path, async (req, res, next) => {
    try {
      const p = spec.params ? spec.params.safeParse(req.params) : { success: true as const, data: req.params as unknown as P };
      if (!p.success) throw zodToEm('params', p.error);
      const q = spec.query ? spec.query.safeParse(req.query) : { success: true as const, data: req.query as unknown as Q };
      if (!q.success) throw zodToEm('query', q.error);
      const b = spec.body ? spec.body.safeParse(req.body ?? {}) : { success: true as const, data: req.body as B };
      if (!b.success) throw zodToEm('body', b.error);
      const out = await handler({ params: p.data, query: q.data, body: b.data, req, res });
      // a streamed body (sendFile) may not have sent its headers yet when the handler returns: never answer 204 over it
      if (res.headersSent || res.writableEnded || res.locals['emStreaming'] === true) return;
      if (out === undefined) { res.status(spec.status ?? 204).end(); return; }
      res.status(spec.status ?? 200).json(out);
    } catch (e) { next(e); }
  });
}

export function errorMapper(log: (o: object) => void) {
  return (e: unknown, _req: Request, res: Response, _next: unknown) => {
    void _next;
    const t = (e as { type?: string })?.type;
    if (t === 'entity.too.large') return res.status(413).json({ error: { code: 'EM-8006', message: 'Request too large.' } });
    if (t === 'entity.parse.failed') return res.status(400).json({ error: { code: 'EM-9002', message: 'Invalid request.' } });
    if (e instanceof EmError) { if (e.status >= 500) log({ level: 'error', code: e.code, msg: e.message, cause: errorMessage(e.cause) }); return res.status(e.status).json(e.toEnvelope()); }
    log({ level: 'error', code: 'EM-9001', msg: errorMessage(e), stack: (e as Error)?.stack });
    return res.status(500).json({ error: { code: 'EM-9001', message: 'Something went wrong.' } });
  };
}
