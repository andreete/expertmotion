// Hardware module: R-150…R-152 and the tier hook. Profile from systeminformation (lazy, at startup and on demand, ≥ 30 s apart),
// cached in hardware_profiles; live meter from node:os; `hardware.tick` every 2 s only while an SSE client asked for it.
import os from 'node:os';
import type { Tier } from '@expertmotion/composition-model';
import { EmError } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { emit } from '../s3/dto.js';
import { s3 } from '../s3/state.js';
import { CpuMeter, detectWithSysteminformation, diskFreeMb, profileWarnings, tierFor, type RawHardware } from '../s3/hardware.js';

export interface HardwareProfileDto { tier: Tier; cpuModel: string | null; cpuThreads: number; ramTotalMb: number; gpuVendor: string | null; gpuModel: string | null; vramMb: number | null; nvenc: boolean; detectedAt: string; warnings: string[] }
export interface HardwareOptions { detect?: () => Promise<RawHardware>; detectOnStart?: boolean; startDelayMs?: number; tickMs?: number; refreshMinMs?: number }

interface ProfileRow { id: string; detected_at: string; tier: Tier; cpu_model: string | null; cpu_threads: number | null; ram_total_mb: number | null; gpu_vendor: string | null; gpu_model: string | null; vram_mb: number | null; nvenc: number | null; benchmark_json: string | null }
const rowDto = (r: ProfileRow): HardwareProfileDto => {
  const extra = r.benchmark_json ? (JSON.parse(r.benchmark_json) as { warnings?: string[] }) : {};
  return { tier: r.tier, cpuModel: r.cpu_model, cpuThreads: r.cpu_threads ?? 0, ramTotalMb: r.ram_total_mb ?? 0, gpuVendor: r.gpu_vendor, gpuModel: r.gpu_model, vramMb: r.vram_mb, nvenc: !!r.nvenc, detectedAt: r.detected_at, warnings: extra.warnings ?? [] };
};
const fallbackProfile = (now: string): HardwareProfileDto => ({ tier: 'T0', cpuModel: os.cpus()[0]?.model ?? null, cpuThreads: os.availableParallelism?.() ?? os.cpus().length, ramTotalMb: Math.round(os.totalmem() / 1048576),
  gpuVendor: null, gpuModel: null, vramMb: null, nvenc: false, detectedAt: now, warnings: [] });

export function createHardwareModule(opts: HardwareOptions = {}): ServiceModule {
  const detect = opts.detect ?? detectWithSysteminformation;
  const tickMs = opts.tickMs ?? 2000; const refreshMinMs = opts.refreshMinMs ?? 30_000;
  const perCtx = new WeakMap<ServiceContext, { profile: HardwareProfileDto | null; lastDetect: number; inflight: Promise<HardwareProfileDto> | null; timer: NodeJS.Timeout | null; startTimer: NodeJS.Timeout | null; meter: CpuMeter }>();
  const st = (ctx: ServiceContext) => perCtx.get(ctx)!;

  async function redetect(ctx: ServiceContext): Promise<HardwareProfileDto> {
    const s = st(ctx);
    if (s.inflight) return s.inflight;
    s.lastDetect = Date.now();
    s.inflight = (async () => {
      const raw = await detect();
      const { tier, gpu } = tierFor(raw.gpus);
      const p: HardwareProfileDto = { tier, cpuModel: raw.cpuModel, cpuThreads: raw.cpuThreads, ramTotalMb: raw.ramTotalMb, gpuVendor: gpu?.vendor ?? null, gpuModel: gpu?.model ?? null,
        vramMb: gpu?.vramMb ?? null, nvenc: raw.nvenc, detectedAt: ctx.now(), warnings: profileWarnings(raw) };
      const id = ctx.newId();
      ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE hardware_profiles SET is_current = 0 WHERE is_current = 1').run();
        ctx.db.prepare('INSERT INTO hardware_profiles(id, detected_at, tier, cpu_model, cpu_threads, ram_total_mb, gpu_vendor, gpu_model, vram_mb, nvenc, benchmark_json, is_current) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)')
          .run(id, p.detectedAt, p.tier, p.cpuModel, p.cpuThreads, p.ramTotalMb, p.gpuVendor, p.gpuModel, p.vramMb, p.nvenc ? 1 : 0, JSON.stringify({ warnings: p.warnings, gpus: raw.gpus.length }));
        ctx.db.prepare('DELETE FROM hardware_profiles WHERE id NOT IN (SELECT id FROM hardware_profiles ORDER BY detected_at DESC LIMIT 5)').run();
      })();
      const before = s.profile?.tier;
      s.profile = p;
      if (before !== undefined && before !== p.tier) emit(ctx, 'settings.changed', { scope: 'hardware', tier: p.tier });
      ctx.log.info({ tier: p.tier, ramTotalMb: p.ramTotalMb, vramMb: p.vramMb }, 'hardware profile detected');
      return p;
    })().finally(() => { s.inflight = null; });
    return s.inflight;
  }

  const count = (ctx: ServiceContext, sql: string): number => { try { return (ctx.db.prepare(sql).get() as { n: number }).n; } catch { return 0; } };
  function tick(ctx: ServiceContext) {
    const mem = process.memoryUsage();
    return { at: ctx.now(), cpuPercent: st(ctx).meter.sample(), ramFreeMb: Math.round(os.freemem() / 1048576), ramTotalMb: Math.round(os.totalmem() / 1048576), processMb: Math.round(mem.rss / 1048576),
      chromeMb: null, diskFreeMb: diskFreeMb(ctx.paths.data), gpuPercent: null,
      workload: { rendering: count(ctx, "SELECT count(*) n FROM render_jobs WHERE status = 'rendering'") > 0, ingesting: count(ctx, "SELECT count(*) n FROM assets WHERE status = 'ingesting'"),
        downloading: count(ctx, "SELECT count(*) n FROM models WHERE status IN ('downloading','verifying')"), agentRuns: s3(ctx).runs.size } };
  }
  function onSubscribers(ctx: ServiceContext, n: number) {
    const s = st(ctx);
    if (n > 0 && !s.timer) { s.timer = setInterval(() => emit(ctx, 'hardware.tick', tick(ctx)), tickMs); s.timer.unref(); }
    else if (n === 0 && s.timer) { clearInterval(s.timer); s.timer = null; }
  }

  return {
    name: 'hardware',
    start(ctx) {
      const cur = ctx.db.prepare('SELECT * FROM hardware_profiles WHERE is_current = 1 ORDER BY detected_at DESC LIMIT 1').get() as ProfileRow | undefined;
      perCtx.set(ctx, { profile: cur ? rowDto(cur) : null, lastDetect: 0, inflight: null, timer: null, startTimer: null, meter: new CpuMeter() });
      ctx.hooks.tier = () => st(ctx).profile?.tier ?? 'T0';
      s3(ctx).onHardwareSubscribers.add((n) => onSubscribers(ctx, n));
      if (opts.detectOnStart !== false) {
        const t = setTimeout(() => { redetect(ctx).catch((e: unknown) => ctx.log.warn({ err: String(e) }, 'hardware detection failed')); }, opts.startDelayMs ?? 1500);
        t.unref(); st(ctx).startTimer = t;
      }
    },
    async stop(ctx) {
      const s = perCtx.get(ctx); if (!s) return;
      if (s.timer) clearInterval(s.timer); if (s.startTimer) clearTimeout(s.startTimer);
      await s.inflight?.catch(() => undefined);
    },
    register(router, ctx) {
      route(router, 'get', '/hardware/profile', {}, async () => st(ctx).profile ?? (await redetect(ctx).catch(() => fallbackProfile(ctx.now()))));
      route(router, 'post', '/hardware/profile/refresh', {}, async () => {
        const s = st(ctx);
        if (!s.inflight && Date.now() - s.lastDetect < refreshMinMs) throw new EmError('EM-9005', 'Hardware was checked a moment ago. Try again in half a minute.', { status: 429 });
        try { return await redetect(ctx); } catch (e) { throw new EmError('EM-9001', 'Something went wrong.', { cause: e }); }
      });
      route(router, 'get', '/hardware/live', {}, () => tick(ctx));
    },
  };
}
export const hardwareModule: ServiceModule = createHardwareModule();
