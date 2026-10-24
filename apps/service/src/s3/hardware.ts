// Hardware Tier rule (PERFORMANCE §1) and the cheap meter (PERFORMANCE §6: node:os only, every 2 s while subscribed).
import fs from 'node:fs';
import os from 'node:os';
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
