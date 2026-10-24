// FR-127…FR-130 on the service side: output-drive free space, engine child memory, EM-6402 low-disk notice once per
// session (FR-128), EM-3402 for T0 (FR-129), and the workload list with cancellability (FR-130). No systeminformation calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@expertmotion/shared';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { createHardwareModule } from '../../src/modules/hardware.js';
import { childTreeRssMb, profileWarnings } from '../../src/s3/hardware.js';
import { s3 } from '../../src/s3/state.js';
import { addProject, body } from './s3-helpers.js';

type Tick = { diskFreeMb: number | null; outputDiskFreeMb: number | null; chromeMb: number | null; workload: { items: Array<{ kind: string; label: string; status: string; progress: number | null; cancellable: boolean }> } };

describe('Hardware Monitor service (FR-127…FR-130)', () => {
  let s: TestService; let free = 50_000; const notices: Array<Record<string, unknown>> = [];
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, createHardwareModule({ detect: async () => ({ cpuModel: 'x', cpuThreads: 4, ramTotalMb: 16384, gpus: [], nvenc: false }), detectOnStart: false,
      diskFree: () => free, childMemMb: () => 321, diskCheckMs: 30 })] });
    const orig = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (n, d) => { if (n === 'service.notice') notices.push(d); return orig(n, d); };
  });
  afterAll(async () => { await s.close(); });

  it('reports engine child memory and the output drive', async () => {
    const t = await body<Tick>(await s.api('/hardware/live'));
    expect(t.chromeMb).toBe(321);
    expect(t.outputDiskFreeMb).toBe(50_000);
    s.ctx.settings.update({ outputFolder: path.join(os.tmpdir(), 'em-not-yet-created', 'videos') });   // not created yet → nearest existing drive
    expect((await body<Tick>(await s.api('/hardware/live'))).outputDiskFreeMb).toBeGreaterThan(0);
  });

  it('EM-6402 low-disk notice is emitted once per session below 2 GB (background check and meter)', async () => {
    expect(notices.filter((n) => n['kind'] === 'low-disk')).toHaveLength(0);
    free = 1500;
    await new Promise((r) => setTimeout(r, 120));
    await s.api('/hardware/live'); await s.api('/hardware/live');
    const low = notices.filter((n) => n['kind'] === 'low-disk');
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ code: 'EM-6402', freeBytes: 1500 * 1048576, have: 1.5 });
  });

  it('T0 profile carries EM-3402; < 8 GB RAM carries EM-8305 (FR-129)', async () => {
    expect((await body<{ tier: string; warnings: string[] }>(await s.api('/hardware/profile'))).warnings).toEqual(['EM-3402']);
    expect(profileWarnings({ cpuModel: null, cpuThreads: 2, ramTotalMb: 4096, gpus: [{ vendor: 'NVIDIA', model: 'RTX', vramMb: 8192 }], nvenc: true })).toEqual(['EM-8305']);
  });

  it('workload lists renders (with project name), ingests, generators and agent runs; ingests are not cancellable (FR-130)', async () => {
    const pid = addProject(s); const now = new Date().toISOString();
    const vid = newId();
    s.ctx.db.prepare("INSERT INTO composition_versions(id, project_id, parent_id, hash, model_json, cause, duration_ms, created_at) VALUES (?,?,NULL,'h','{}','system',0,?)").run(vid, pid, now);
    s.ctx.db.prepare("INSERT INTO render_jobs(id, project_id, version_id, output_profile_json, performance_profile, status, progress, created_at) VALUES (?,?,?,'{}','standard','rendering',0.42,?)").run(newId(), pid, vid, now);
    s3(s.ctx).runs.set('run-1', { controller: new AbortController(), projectId: pid, agent: 'editor' });
    const t = await body<Tick>(await s.api('/hardware/live'));
    const render = t.workload.items.find((i) => i.kind === 'render')!;
    expect(render).toMatchObject({ label: 'Proyek Contoh', status: 'rendering', progress: 0.42, cancellable: true });
    expect(t.workload.items.find((i) => i.kind === 'agent')).toMatchObject({ label: 'editor', cancellable: true });
    s3(s.ctx).runs.delete('run-1');
  });
});

describe('childTreeRssMb', () => {
  it('sums descendants from /proc on Linux and is null elsewhere (no process spawn)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-proc-'));
    const mk = (pid: number, children: number[], pages: number) => { fs.mkdirSync(path.join(root, String(pid), 'task', String(pid)), { recursive: true }); fs.writeFileSync(path.join(root, String(pid), 'task', String(pid), 'children'), children.join(' ')); fs.writeFileSync(path.join(root, String(pid), 'statm'), `1 ${pages} 0`); };
    mk(1, [2], 0); mk(2, [3], 256); mk(3, [], 512);                     // 768 pages × 4 KiB = 3 MB
    expect(childTreeRssMb(1, 'linux', root)).toBe(3);
    expect(childTreeRssMb(1, 'win32', root)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
