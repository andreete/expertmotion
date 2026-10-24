// Models module: R-140…R-144 (API_SPECIFICATION §6.14) on packages/models via s2/models-service.ts.
import { z } from 'zod';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { freeBytes } from '../s2/common.js';
import { modelsServiceOf, type ModelsOptions } from '../s2/models-service.js';

const Key = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/) });

export function createModelsModule(opts: ModelsOptions = {}): ServiceModule {
  return {
    name: 'models',
    start(ctx) {
      const svc = modelsServiceOf(ctx, opts); svc.recover();
      ctx.settings.onChange((s, changed) => { if (changed.includes('privateMode')) svc.onPrivateMode(s.privateMode); });   // FR-161
    },
    async stop(ctx) { const m = modelsServiceOf(ctx, opts); for (const d of m.defs()) await m.cancel(d.key).catch(() => undefined); },
    register(router, ctx) {
      const svc = modelsServiceOf(ctx, opts);
      route(router, 'get', '/models', {}, async () => {                                                                    // R-140
        const items = await Promise.all(svc.defs().map((d) => svc.dto(d)));
        const totalInstalledBytes = items.filter((i) => i['status'] === 'installed').reduce((a, i) => a + Number(i['bytesTotal']), 0);
        return { items, tier: ctx.hooks.tier(), totalInstalledBytes, diskFreeBytes: await (opts.freeBytes ?? freeBytes)(ctx.paths.models), registry: svc.registrySource() };
      });
      route(router, 'get', '/models/:key', { params: Key }, ({ params }) => svc.dto(svc.require(params.key)));                // R-141
      route(router, 'post', '/models/:key/install', { params: Key, status: 202 }, ({ params }) => svc.install(params.key));   // R-142
      route(router, 'post', '/models/:key/cancel', { params: Key, query: z.object({ discard: z.enum(['true', 'false']).optional() }) },
        ({ params, query }) => svc.cancel(params.key, query.discard === 'true'));                                           // R-143 (Pause keeps the .part; discard = Cancel)
      route(router, 'post', '/models/engines/:engine/reveal', { params: z.object({ engine: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/) }) },
        ({ params }) => ({ path: svc.engineDir(params.engine) }));                                                          // R-146 (FR-126 open folder)
      route(router, 'delete', '/models/:key', { params: Key }, async ({ params }) => { await svc.remove(params.key); return undefined; });   // R-144
    },
  };
}
export const modelsModule: ServiceModule = createModelsModule();
