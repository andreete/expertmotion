// Express app factory. Order: Host/Origin guard → auth → JSON body (2 MB) → /api/v1 routes → 404 → error mapper.
import express from 'express';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from '../modules/types.js';
import { authGuard, hostOriginGuard } from './guards.js';
import { errorMapper } from './route.js';

export function createApp(ctx: ServiceContext, modules: readonly ServiceModule[]): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(hostOriginGuard(ctx.cfg, ctx.mediaOrigins));
  app.use(authGuard(ctx.cfg));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  app.use('/api/v1', express.json({ limit: '2mb' }));
  const router = express.Router();
  for (const m of modules) m.register(router, ctx);
  app.use('/api/v1', router);
  const rootRouter = express.Router();
  for (const m of modules) m.registerRoot?.(rootRouter, ctx);
  app.use(rootRouter);
  app.use((_req, res) => { res.status(404).json({ error: { code: 'EM-9003', message: 'Not found.' } }); });
  app.use(errorMapper((o) => ctx.log.error(o)));
  return app;
}
