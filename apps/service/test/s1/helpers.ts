// S1 test helpers: boot health + projects + composition + intents with fake asset facts, capture SSE bus events.
import type { AssetFacts } from '@expertmotion/composition-model';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { projectsModule } from '../../src/modules/projects.js';
import { compositionModule } from '../../src/modules/composition.js';
import { intentsModule } from '../../src/modules/intents.js';
import type { ServiceConfig } from '../../src/config.js';

export const ASSETS: AssetFacts[] = [
  { id: 'a1', kind: 'video', status: 'ready', durationMs: 10_000, name: 'unboxing.mp4', hasAudio: true },
  { id: 'a2', kind: 'video', status: 'ready', durationMs: 6000, name: 'fitur.mp4' },
  { id: 'a3', kind: 'video', status: 'ready', durationMs: 5000, name: 'penutup.mp4' },
];
export const MODULES = [health, projectsModule, compositionModule, intentsModule] as const;

export interface Ev { name: string; data: Record<string, unknown> }
export interface S1Service extends TestService { events: Ev[]; json<T = any>(p: string, init?: Parameters<TestService['api']>[1]): Promise<{ status: number; body: T }>; waitFor(pred: (e: Ev) => boolean, ms?: number): Promise<Ev> }

export async function startS1(opts: { dataDir?: string; cfg?: Partial<ServiceConfig>; assets?: AssetFacts[] } = {}): Promise<S1Service> {
  const s = await startService({ modules: MODULES, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), ...(opts.cfg ? { cfg: opts.cfg } : {}) });
  const assets = opts.assets ?? ASSETS;
  s.ctx.hooks.assetFacts = () => assets;
  const events: Ev[] = [];
  const emit = s.ctx.bus.emit.bind(s.ctx.bus);
  s.ctx.bus.emit = (name, data) => { events.push({ name, data }); return emit(name, data); };
  const out = s as S1Service;
  out.events = events;
  out.json = async (p, init) => { const r = await s.api(p, init); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : undefined }; };
  out.waitFor = async (pred, ms = 5000) => {
    const t0 = Date.now();
    for (;;) { const e = events.find(pred); if (e) return e; if (Date.now() - t0 > ms) throw new Error('timed out waiting for event'); await new Promise((r) => setTimeout(r, 20)); }
  };
  return out;
}

export async function newProject(s: S1Service, name = `P ${Math.random().toString(36).slice(2, 8)}`, settings: Record<string, unknown> = {}) {
  const r = await s.json('/projects', { method: 'POST', json: { name, settings } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body as { id: string; headHash: string; headVersionId: string; name: string };
}
/** Insert clips through hooks.applyOps (what the assets module's Insert does). */
export function insertClips(s: S1Service, projectId: string, assetIds: string[]): string {
  return s.ctx.hooks.applyOps(projectId, assetIds.map((assetId) => ({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId } })), { kind: 'asset', summary: 'insert' });
}
export async function headHash(s: S1Service, projectId: string): Promise<string> {
  return (await s.json(`/projects/${projectId}/composition?model=false`)).body.head.hash as string;
}
