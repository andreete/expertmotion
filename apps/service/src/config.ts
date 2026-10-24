// Service configuration. Production: bootstrap message from the Desktop Shell over parentPort (SEC-002, never argv/env).
// Development (SEC-014): EM_PORT / EM_TOKEN / EM_DATA_DIR / EM_UI_ORIGIN / EM_DB_KEY, only when not packaged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ServiceConfig {
  port: number; token: string; dataDir: string; dbKeyHex: string; dev: boolean; uiOrigin?: string;
  version: string; mediaGrantTtlMs: number;
}
export const VERSION = '0.1.0';
export const PROD_PORT_RANGE = [47600, 47699] as const;

export function devConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const dataDir = path.resolve(env['EM_DATA_DIR'] ?? path.join(process.cwd(), '.em-dev-data'));
  fs.mkdirSync(dataDir, { recursive: true });
  let token = env['EM_TOKEN'];
  if (!token) { token = crypto.randomBytes(32).toString('base64url'); fs.writeFileSync(path.join(dataDir, 'dev-token'), token, { mode: 0o600 }); }
  const keyFile = path.join(dataDir, 'dev-db-key');
  let dbKeyHex = env['EM_DB_KEY'];
  if (!dbKeyHex) { if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 }); dbKeyHex = fs.readFileSync(keyFile, 'utf8').trim(); }
  const uiOrigin = env['EM_UI_ORIGIN'] ?? `http://127.0.0.1:${env['EM_UI_PORT'] ?? 4120}`;
  return { port: Number(env['EM_PORT'] ?? 4110), token, dataDir, dbKeyHex, dev: true, uiOrigin, version: VERSION, mediaGrantTtlMs: Number(env['EM_MEDIA_GRANT_TTL_H'] ?? 12) * 3_600_000 };
}

export interface Bootstrap { type: 'bootstrap'; token: string; port: number; dataDir: string; dbKeyHex: string; promptKeyHalf?: string }
export function prodConfig(b: Bootstrap): ServiceConfig {
  if (!/^[A-Za-z0-9_-]{43}$/.test(b.token) || !/^[0-9a-f]{64}$/.test(b.dbKeyHex) || b.port < PROD_PORT_RANGE[0] || b.port > PROD_PORT_RANGE[1]) throw new Error('invalid bootstrap');
  return { port: b.port, token: b.token, dataDir: b.dataDir, dbKeyHex: b.dbKeyHex, dev: false, version: VERSION, mediaGrantTtlMs: 12 * 3_600_000 };
}

/** Data directory layout (ARCHITECTURE §8). */
export function paths(dataDir: string) {
  const p = { data: path.join(dataDir, 'data'), db: path.join(dataDir, 'data', 'expertmotion.db'), checkpoints: path.join(dataDir, 'data', 'checkpoints'),
    media: path.join(dataDir, 'media'), outputs: path.join(dataDir, 'outputs'), models: path.join(dataDir, 'models'), logs: path.join(dataDir, 'logs'), tmp: path.join(dataDir, 'tmp'), backups: path.join(dataDir, 'backups') };
  for (const d of [p.data, p.checkpoints, p.media, p.outputs, p.models, p.logs, p.tmp, p.backups]) fs.mkdirSync(d, { recursive: true });
  return p;
}
export type Paths = ReturnType<typeof paths>;
