// R-001 GET /health (unauthenticated, no secrets) and R-002 GET /version.
import os from 'node:os';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';

const started = Date.now();
export const health: ServiceModule = {
  name: 'health',
  register(router, ctx) {
    route(router, 'get', '/health', {}, () => ({ status: 'ok', version: ctx.cfg.version, uptimeMs: Date.now() - started }));
    route(router, 'get', '/version', {}, () => ({ version: ctx.cfg.version, node: process.versions.node, platform: process.platform, arch: os.arch(), schemaVersion: 1, dev: ctx.cfg.dev }));
  },
};
