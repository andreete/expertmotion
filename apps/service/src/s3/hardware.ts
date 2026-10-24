// Hardware Tier rule (PERFORMANCE §1) and the cheap meter (PERFORMANCE §6: node:os only, every 2 s while subscribed).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tier } from '@expertmotion/composition-model';

export interface GpuFacts { vendor: string | null; model: string | null; vramMb: number | null }
export interface RawHardware { cpuModel: string | null; cpuThreads: number; ramTotalMb: number; gpus: GpuFacts[]; nvenc: boolean }

const VIRTUAL = /(basic display|basic render|virtualbox|vmware|hyper-v|parsec|remote|citrix|llvmpipe|swiftshader|qxl|virtio)/i;

/** T2 ≥ 8 GB VRAM, T1 ≥ 4 GB, T0 otherwise (no GPU, unknown VRAM, < 4 GB, or only virtual adapters). */
export function tierFor(gpus: readonly GpuFacts[]): { tier: Tier; gpu: GpuFacts | null } {
  const real = gpus.filter((g) => !VIRTUAL.test(`${g.vendor ?? ''} ${g.model ?? ''}`));
  const best = [...real].sort((a, b) => (b.vramMb ?? -1) - (a.vramMb ?? -1))[0] ?? null;
  const v = best?.vramMb ?? null;
  return { tier: v !== null && v >= 8192 ? 'T2' : v !== null && v >= 4096 ? 'T1' : 'T0', gpu: best };
}

export function profileWarnings(raw: RawHardware): string[] {
  const w: string[] = [];
  if (tierFor(raw.gpus).tier === 'T0') w.push('EM-3402');                 // FR-129: shown once per install by the Editor
  if (raw.ramTotalMb > 0 && raw.ramTotalMb < 8 * 1024) w.push('EM-8305');
  return w;
}

/** systeminformation, imported lazily (on Windows each call spawns PowerShell; never polled more often than every 30 s). */
export async function detectWithSysteminformation(): Promise<RawHardware> {
  const mod = (await import('systeminformation')) as unknown as { default?: unknown };
  const si = (mod.default ?? mod) as { cpu(): Promise<{ manufacturer?: string; brand?: string; cores?: number }>; mem(): Promise<{ total: number }>;
    graphics(): Promise<{ controllers: Array<{ vendor?: string; model?: string; vram?: number | null }> }> };
  const [cpu, mem, gfx] = await Promise.all([si.cpu(), si.mem(), si.graphics()]);
  const gpus = (gfx.controllers ?? []).map((c) => ({ vendor: c.vendor || null, model: c.model || null, vramMb: typeof c.vram === 'number' && c.vram > 0 ? Math.round(c.vram) : null }));
  const name = [cpu.manufacturer, cpu.brand].filter(Boolean).join(' ').trim();
  return { cpuModel: name || os.cpus()[0]?.model || null, cpuThreads: os.availableParallelism?.() ?? os.cpus().length, ramTotalMb: Math.round(mem.total / 1048576),
    gpus, nvenc: gpus.some((g) => /nvidia/i.test(`${g.vendor} ${g.model}`) && (g.vramMb ?? 0) >= 2048) };
}

export class CpuMeter {
  private prev = this.read();
  private read() { let idle = 0, total = 0; for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.irq + t.idle; } return { idle, total }; }
  /** CPU % since the previous call (0 on the first). */
  sample(): number {
    const cur = this.read(); const dt = cur.total - this.prev.total; const di = cur.idle - this.prev.idle; this.prev = cur;
    return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 1000) / 10)) : 0;
  }
}
export function diskFreeMb(dir: string): number | null {
  try { const s = fs.statfsSync(dir); return Math.round((s.bavail * s.bsize) / 1048576); } catch { return null; }
}

/** Nearest existing ancestor (an output folder that does not exist yet still reports its drive). */
export function diskFreeMbNearest(dir: string): number | null {
  let d = dir;
  for (let i = 0; i < 32; i++) { const v = diskFreeMb(d); if (v !== null) return v; const up = path.dirname(d); if (up === d) break; d = up; }
  return null;
}

/**
 * Resident memory of every descendant process (Chrome Headless Shell, FFmpeg, engine binaries) of `rootPid`, in MB.
 * Linux: /proc reads only (no spawn). Elsewhere null here; Windows uses `WindowsEngineMemory` (one `tasklist` at most every
 * 30 s, never PowerShell/WMI per tick: PERFORMANCE §6, NFR-009). The Shell reports its own Electron processes (`shellMemory`).
 */
export function childTreeRssMb(rootPid = process.pid, platform: NodeJS.Platform = process.platform, procRoot = '/proc'): number | null {
  if (platform !== 'linux') return null;
  const page = 4096; let bytes = 0; let seen = 0;
  const children = (pid: number): number[] => {
    try {
      return fs.readdirSync(`${procRoot}/${pid}/task`).flatMap((tid) => { try { return fs.readFileSync(`${procRoot}/${pid}/task/${tid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } });
    } catch { return []; }
  };
  const stack = children(rootPid);
  if (!fs.existsSync(`${procRoot}/${rootPid}/task`)) return null;
  while (stack.length && seen < 256) {
    const pid = stack.pop()!; seen += 1;
    try { const rss = Number(fs.readFileSync(`${procRoot}/${pid}/statm`, 'utf8').split(' ')[1]); if (Number.isFinite(rss)) bytes += rss * page; } catch { /* exited */ }
    stack.push(...children(pid));
  }
  return Math.round(bytes / 1048576);
}

/** Image names of the Engine children on Windows (Chrome Headless Shell, FFmpeg/ffprobe, the Remotion compositor). */
export const ENGINE_IMAGES = ['chrome-headless-shell.exe', 'ffmpeg.exe', 'ffprobe.exe', 'remotion.exe'] as const;

/** Sum of the "Mem Usage" column (KiB, any locale's digit grouping) of `tasklist /fo csv /nh` rows whose image is an Engine image. */
export function parseTasklistCsv(csv: string, images: readonly string[] = ENGINE_IMAGES): number {
  const want = new Set(images.map((i) => i.toLowerCase()));
  let kib = 0;
  for (const line of csv.split(/\r?\n/)) {
    const cols = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    if (cols.length < 5 || !want.has(cols[0]!.toLowerCase())) continue;
    const n = Number(cols[4]!.replace(/[^0-9]/g, ''));
    if (Number.isFinite(n)) kib += n;
  }
  return Math.round(kib / 1024);
}

/**
 * FR-127 Engine children on Windows without a per-tick spawn: one `tasklist.exe /fo csv /nh` at most every `minMs` (30 s),
 * started only while the meter is read (Hardware Monitor open); between samples the cached value is returned. Matching is
 * by image name (tasklist has no parent pid), so another program's ffmpeg.exe would be counted too — documented as approximate.
 */
export class WindowsEngineMemory {
  private value: number | null = null; private at = Number.NEGATIVE_INFINITY; private inflight = false;
  constructor(private readonly run: (exe: string, args: string[], cb: (err: Error | null, out: string) => void) => void = (exe, args, cb) => {
    execFile(exe, args, { windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (err, out) => cb(err, String(out ?? '')));
  }, private readonly minMs = 30_000, private readonly now: () => number = Date.now) {}
  sample(): number | null {
    if (!this.inflight && this.now() - this.at >= this.minMs) {
      this.inflight = true; this.at = this.now();
      const exe = path.join(process.env['SYSTEMROOT'] ?? 'C:\\Windows', 'System32', 'tasklist.exe');
      try {
        this.run(exe, ['/fo', 'csv', '/nh'], (err, out) => { this.inflight = false; if (!err) this.value = parseTasklistCsv(out); });
      } catch { this.inflight = false; }
    }
    return this.value;
  }
}

/** Engine child memory for the meter: /proc on Linux, the throttled tasklist sampler on Windows, null elsewhere. */
export function engineMemorySampler(platform: NodeJS.Platform = process.platform): () => number | null {
  if (platform === 'win32') { const w = new WindowsEngineMemory(); return () => w.sample(); }
  return () => childTreeRssMb(process.pid, platform);
}

/** FR-127 Shell (Electron main, renderer, GPU) memory pushed by the Desktop Shell over parentPort every 30 s; stale after 90 s. */
const shell = { mb: null as number | null, at: 0 };
export const shellMemory = {
  set(mb: number, at = Date.now()): void { if (Number.isFinite(mb) && mb >= 0 && mb < 1_000_000) { shell.mb = Math.round(mb); shell.at = at; } },
  get(now = Date.now()): number | null { return shell.mb !== null && now - shell.at <= 90_000 ? shell.mb : null; },
  reset(): void { shell.mb = null; shell.at = 0; },
};
