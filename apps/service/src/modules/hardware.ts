// Hardware module: R-150…R-152 and the tier hook. Profile from systeminformation (lazy, at startup and on demand, ≥ 30 s apart),
// cached in hardware_profiles; live meter from node:os; `hardware.tick` every 2 s only while an SSE client asked for it.
import { availableMemBytes } from '../services/memory.js';
import os from 'node:os';
import type { Tier } from '@expertmotion/composition-model';
import { EmError } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { emit } from '../s3/dto.js';
import { s3 } from '../s3/state.js';
import { CpuMeter, detectWithSysteminformation, diskFreeMb, diskFreeMbNearest, engineMemorySampler, profileWarnings, shellMemory, tierFor, type RawHardware } from '../s3/hardware.js';
import { s2 } from '../s2/state.js';

/** FR-128: data-drive free space below this raises EM-6402 once per session. */
export const LOW_DISK_MB = 2048;
export interface WorkloadItem { kind: 'render' | 'download' | 'ingest' | 'generator' | 'agent'; id: string; label: string; status: string; progress: number | null; cancellable: boolean; pausedReason: 'render' | null }

export interface HardwareProfileDto { tier: Tier; cpuModel: string | null; cpuThreads: number; ramTotalMb: number; gpuVendor: string | null; gpuModel: string | null; vramMb: number | null; nvenc: boolean; detectedAt: string; warnings: string[] }
export interface HardwareOptions { detect?: () => Promise<RawHardware>; detectOnStart?: boolean; startDelayMs?: number; tickMs?: number; refreshMinMs?: number;
  /** FR-128 background disk check interval (statfs only; default 60 s) and an injectable reader for tests. */
  diskCheckMs?: number; diskFree?: (dir: string) => number | null; childMemMb?: () => number | null; shellMemMb?: () => number | null }

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
  const diskFree = opts.diskFree ?? diskFreeMb; const childMem = opts.childMemMb ?? engineMemorySampler(); const shellMem = opts.shellMemMb ?? (() => shellMemory.get());
  const perCtx = new WeakMap<ServiceContext, { profile: HardwareProfileDto | null; lastDetect: number; inflight: Promise<HardwareProfileDto> | null; timer: NodeJS.Timeout | null; startTimer: NodeJS.Timeout | null; meter: CpuMeter;
    diskTimer: NodeJS.Timeout | null; startDiskTimer?: NodeJS.Timeout; lowDiskSent: boolean }>();
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
  const rows = <T>(ctx: ServiceContext, sql: string): T[] => { try { return ctx.db.prepare(sql).all() as T[]; } catch { return []; } };

  /** FR-128: EM-6402 once per session when the data drive has < 2 GB free (statfs: one syscall, no process spawn). */
  function checkDisk(ctx: ServiceContext, freeMb = diskFree(ctx.paths.data)): number | null {
    const s = st(ctx);
    if (freeMb !== null && freeMb < LOW_DISK_MB && !s.lowDiskSent) {
      s.lowDiskSent = true;
      emit(ctx, 'service.notice', { kind: 'low-disk', code: 'EM-6402', freeBytes: freeMb * 1048576, have: Math.round((freeMb / 1024) * 10) / 10 });
      ctx.log.warn({ code: 'EM-6402', freeMb }, 'low disk space on the data drive');
    }
    return freeMb;
  }

  /** FR-130: running and queued work with progress, cancellability and "paused during render". Cheap DB reads only. */
  function workloadItems(ctx: ServiceContext): WorkloadItem[] {
    const out: WorkloadItem[] = [];
    for (const r of rows<{ id: string; status: string; progress: number; name: string | null }>(ctx, "SELECT r.id, r.status, r.progress, p.name FROM render_jobs r LEFT JOIN projects p ON p.id = r.project_id WHERE r.status IN ('rendering','queued') ORDER BY r.created_at"))
      out.push({ kind: 'render', id: r.id, label: r.name ?? '', status: r.status, progress: r.status === 'rendering' ? r.progress : null, cancellable: true, pausedReason: null });
    for (const d of s2(ctx).models?.workload() ?? [])
      out.push({ kind: 'download', id: d.key, label: d.label, status: d.status, progress: d.bytesTotal ? d.bytesDone / d.bytesTotal : null, cancellable: true, pausedReason: d.pausedReason });
    for (const a of rows<{ id: string; name: string }>(ctx, "SELECT id, name FROM assets WHERE status = 'ingesting' ORDER BY created_at LIMIT 50"))
      out.push({ kind: 'ingest', id: a.id, label: a.name, status: 'ingesting', progress: null, cancellable: false, pausedReason: null });
    for (const g of rows<{ id: string; kind: string; status: string; progress: number }>(ctx, "SELECT id, kind, status, progress FROM generator_jobs WHERE status IN ('running','queued') ORDER BY created_at"))
      out.push({ kind: 'generator', id: g.id, label: g.kind, status: g.status, progress: g.status === 'running' ? g.progress : null, cancellable: true, pausedReason: null });
    for (const [id, r] of s3(ctx).runs) out.push({ kind: 'agent', id, label: r.agent, status: 'running', progress: null, cancellable: true, pausedReason: null });
    return out;
  }

  function tick(ctx: ServiceContext) {
    const mem = process.memoryUsage();
    const out = ctx.settings.get().outputFolder;
    return { at: ctx.now(), cpuPercent: st(ctx).meter.sample(), ramFreeMb: Math.round(availableMemBytes() / 1048576), ramTotalMb: Math.round(os.totalmem() / 1048576), processMb: Math.round(mem.rss / 1048576),
      chromeMb: childMem(), shellMb: shellMem(), diskFreeMb: checkDisk(ctx), outputDiskFreeMb: out ? diskFreeMbNearest(out) : diskFree(ctx.paths.outputs), gpuPercent: null,
      workload: { rendering: count(ctx, "SELECT count(*) n FROM render_jobs WHERE status = 'rendering'") > 0, ingesting: count(ctx, "SELECT count(*) n FROM assets WHERE status = 'ingesting'"),
        downloading: count(ctx, "SELECT count(*) n FROM models WHERE status IN ('downloading','verifying')"), agentRuns: s3(ctx).runs.size, items: workloadItems(ctx) } };
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
      perCtx.set(ctx, { profile: cur ? rowDto(cur) : null, lastDetect: 0, inflight: null, timer: null, startTimer: null, meter: new CpuMeter(), diskTimer: null, lowDiskSent: false });
      // First check ~10 s after start (the Editor's event stream is usually connected by then), then every minute until sent.
      const first = setTimeout(() => checkDisk(ctx), Math.min(10_000, opts.diskCheckMs ?? 10_000)); first.unref();
      const dt = setInterval(() => { if (!st(ctx).lowDiskSent) checkDisk(ctx); }, opts.diskCheckMs ?? 60_000); dt.unref(); st(ctx).diskTimer = dt;
      st(ctx).startDiskTimer = first;
      ctx.hooks.tier = () => st(ctx).profile?.tier ?? 'T0';
      s3(ctx).onHardwareSubscribers.add((n) => onSubscribers(ctx, n));
      if (opts.detectOnStart !== false) {
        const t = setTimeout(() => { redetect(ctx).catch((e: unknown) => ctx.log.warn({ err: String(e) }, 'hardware detection failed')); }, opts.startDelayMs ?? 1500);
        t.unref(); st(ctx).startTimer = t;
      }
    },
    async stop(ctx) {
      const s = perCtx.get(ctx); if (!s) return;
      if (s.timer) clearInterval(s.timer); if (s.startTimer) clearTimeout(s.startTimer); if (s.diskTimer) clearInterval(s.diskTimer); if (s.startDiskTimer) clearTimeout(s.startDiskTimer);
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
