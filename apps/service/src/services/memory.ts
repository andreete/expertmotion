// Available physical memory. Node's os.freemem() is MemFree on Linux (excludes reclaimable page cache) and so under-reports
// badly on a busy machine; MemAvailable is what the kernel says can be allocated without swapping. Windows/macOS: os.freemem()
// already returns available memory. Inside a cgroup with a memory limit (dev server), the remaining headroom is also respected.
import fs from 'node:fs';
import os from 'node:os';

export function availableMemBytes(readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'), platform = process.platform): number {
  let avail = os.freemem();
  if (platform !== 'linux') return avail;
  try { const m = /^MemAvailable:\s+(\d+) kB$/m.exec(readFile('/proc/meminfo')); if (m) avail = Number(m[1]) * 1024; } catch { /* keep freemem */ }
  try {
    const cg = /^0::(.*)$/m.exec(readFile('/proc/self/cgroup'))?.[1];
    if (cg) {
      const base = `/sys/fs/cgroup${cg}`;
      const max = readFile(`${base}/memory.max`).trim();
      if (max !== 'max') avail = Math.min(avail, Math.max(0, Number(max) - Number(readFile(`${base}/memory.current`).trim())));
    }
  } catch { /* no cgroup v2 limit */ }
  return avail;
}
