import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, type TestService } from '../helpers.js';
import { BUILD_DATE, fpA, fpB, MACHINE_A, makeDevKey, payloadFor, signedRevocationList, signPayload } from '../license/helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { createHardwareModule } from '../../src/modules/hardware.js';
import { createLicenseModule, type LicenseOptions } from '../../src/modules/license.js';
import { createDiagnosticsModule } from '../../src/modules/diagnostics.js';
import { eventsModule } from '../../src/modules/events.js';
import { tierFor, type RawHardware } from '../../src/s3/hardware.js';
import { readZip } from '../../src/s3/zip.js';
import { s3 } from '../../src/s3/state.js';
import { addProject, body, collectSse, waitFor } from './s3-helpers.js';

const SECRET = `sk-or-v1-${'f00dcafe'.repeat(5)}LAST`;
const hw = (vramMb: number | null, ramTotalMb = 16384, model = 'GeForce RTX'): RawHardware => ({ cpuModel: 'Intel(R) Core(TM) i5-1235U', cpuThreads: 12, ramTotalMb, gpus: vramMb === null ? [] : [{ vendor: 'NVIDIA', model, vramMb }], nvenc: true });

describe('hardware tier rule (PERFORMANCE §1)', () => {
  it('T0 / T1 / T2 by VRAM; virtual adapters and unknown VRAM count as no GPU', () => {
    expect(tierFor([]).tier).toBe('T0');
    expect(tierFor([{ vendor: 'Intel', model: 'Iris Xe', vramMb: 128 }]).tier).toBe('T0');
    expect(tierFor([{ vendor: 'AMD', model: 'Radeon', vramMb: null }]).tier).toBe('T0');
    expect(tierFor([{ vendor: 'NVIDIA', model: 'GTX 1650', vramMb: 4096 }]).tier).toBe('T1');
    expect(tierFor([{ vendor: 'Intel', model: 'UHD', vramMb: 1024 }, { vendor: 'NVIDIA', model: 'RTX 4060', vramMb: 8188 }]).tier).toBe('T1');
    expect(tierFor([{ vendor: 'NVIDIA', model: 'RTX 3070', vramMb: 8192 }]).tier).toBe('T2');
    expect(tierFor([{ vendor: 'VMware, Inc.', model: 'SVGA 3D', vramMb: 16384 }]).tier).toBe('T0');
    expect(tierFor([{ vendor: 'Microsoft', model: 'Microsoft Basic Display Adapter', vramMb: 8192 }, { vendor: 'NVIDIA', model: 'GTX 1050', vramMb: 2048 }]).gpu?.model).toBe('GTX 1050');
  });
});

describe('hardware, settings and events over HTTP', () => {
  let s: TestService; let detected: RawHardware = hw(4096, 4096); let detections = 0;
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, createHardwareModule({ detect: async () => { detections++; return detected; }, detectOnStart: false, tickMs: 40, refreshMinMs: 200 }), eventsModule] });
  });
  afterAll(async () => { await s.close(); });

  it('profile is detected once, persisted, rate-limited, and the tier hook follows it', async () => {
    expect(s.ctx.hooks.tier()).toBe('T0');
    const p = await body<{ tier: string; vramMb: number; warnings: string[]; nvenc: boolean }>(await s.api('/hardware/profile'));
    expect(p).toMatchObject({ tier: 'T1', vramMb: 4096, warnings: ['EM-8305'], nvenc: true });
    expect(s.ctx.hooks.tier()).toBe('T1');
    await s.api('/hardware/profile');
    expect(detections).toBe(1);
    const limited = await s.api('/hardware/profile/refresh', { method: 'POST' });
    expect(limited.status).toBe(429);
    expect((await body<{ error: { code: string } }>(limited)).error.code).toBe('EM-9005');
    detected = hw(12288);
    const emitted: string[] = []; const orig = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (n, d) => { emitted.push(`${n}:${String(d['scope'] ?? '')}`); return orig(n, d); };
    await new Promise((r) => setTimeout(r, 220));
    expect(await body(await s.api('/hardware/profile/refresh', { method: 'POST' }))).toMatchObject({ tier: 'T2', warnings: [] });
    s.ctx.bus.emit = orig;
    expect(emitted).toContain('settings.changed:hardware');
    expect((s.ctx.db.prepare('SELECT count(*) n FROM hardware_profiles WHERE is_current = 1').get() as { n: number }).n).toBe(1);
  });

  it('live meter answers from node:os', async () => {
    const t = await body<{ cpuPercent: number; ramTotalMb: number; processMb: number; workload: { rendering: boolean; agentRuns: number } }>(await s.api('/hardware/live'));
    expect(t.ramTotalMb).toBeGreaterThan(0); expect(t.processMb).toBeGreaterThan(0);
    expect(t.workload).toEqual({ rendering: false, ingesting: 0, downloading: 0, agentRuns: 0, items: [] });
  });

  it('hardware.tick only reaches clients that asked for it, and stops when they leave', async () => {
    const plain = collectSse(`${s.base}/api/v1/events?token=${s.token}`, () => false, 400);
    const ticks = await collectSse(`${s.base}/api/v1/events?token=${s.token}&hardware=1`, (ev) => ev.filter((e) => e.event === 'hardware.tick').length >= 2, 3000);
    expect(ticks.filter((e) => e.event === 'hardware.tick').length).toBeGreaterThanOrEqual(2);
    expect((await plain).some((e) => e.event === 'hardware.tick')).toBe(false);
    await waitFor(() => s3(s.ctx).hardwareSubscribers === 0);
    expect((await s.api('/events?projectId=nope')).status).toBe(400);
  });

  it('settings: validation, Private Mode event, output folder restricted to the user profile', async () => {
    expect(await body(await s.api('/settings'))).toMatchObject({ privateMode: false, uiLanguage: 'en', telemetry: false });
    expect((await s.api('/settings', { method: 'PUT', json: { nope: 1 } })).status).toBe(400);
    expect((await s.api('/settings', { method: 'PUT', json: { autosaveDebounceMs: 5 } })).status).toBe(400);
    expect((await s.api('/settings', { method: 'PUT', json: { telemetry: true } })).status).toBe(400);
    const etc = await s.api('/settings', { method: 'PUT', json: { outputFolder: '/etc' } });
    expect(etc.status).toBe(403);
    expect((await body<{ error: { code: string } }>(etc)).error.code).toBe('EM-8302');
    const folder = path.join(os.homedir(), 'Videos', 'Expertmotion');
    expect(await body(await s.api('/settings', { method: 'PUT', json: { outputFolder: folder, uiLanguage: 'id' } }))).toMatchObject({ outputFolder: folder, uiLanguage: 'id', privateMode: false });
    const ev = collectSse(`${s.base}/api/v1/events?token=${s.token}`, (e) => e.some((x) => x.event === 'settings.changed' && x.data['scope'] === 'privateMode'));
    await new Promise((r) => setTimeout(r, 50));
    await s.api('/settings', { method: 'PUT', json: { privateMode: true } });
    const pm = (await ev).find((x) => x.data['scope'] === 'privateMode')!;
    expect(pm.data['privateMode']).toBe(true);
    expect(s.ctx.egress.isPrivate()).toBe(true);
    await s.api('/settings', { method: 'PUT', json: { privateMode: false } });
    expect((s.ctx.db.prepare("SELECT count(*) n FROM audit_log WHERE event LIKE 'privatemode.%'").get() as { n: number }).n).toBe(2);
  });

  it('FR-099: Settings keep the Editor layout (settings.json state); unknown buckets are rejected', async () => {
    const layout = { panelSizes: { standard: { agent: 400, lib: 280 } }, libCollapsed: false, agentCollapsed: true, outputCollapsed: true };
    expect(await body(await s.api('/settings', { method: 'PUT', json: { layout } }))).toMatchObject({ layout });
    expect((await body<{ layout: unknown }>(await s.api('/settings'))).layout).toEqual(layout);
    expect((await s.api('/settings', { method: 'PUT', json: { layout: { panelSizes: { huge: {} } } } })).status).toBe(400);
  });

  it('cache clear removes regenerable variants inside the data folders only', async () => {
    const projectId = addProject(s); const assetId = s.ctx.newId(); const now = new Date().toISOString();
    const dir = path.join(s.ctx.paths.media, projectId, assetId); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'proxy.mp4'), Buffer.alloc(1000)); fs.writeFileSync(path.join(dir, 'thumb.jpg'), Buffer.alloc(10)); fs.writeFileSync(path.join(dir, 'original.mp4'), Buffer.alloc(50));
    const outside = path.join(s.cfg.dataDir, 'outside.txt'); fs.writeFileSync(outside, 'keep');
    const ins = s.ctx.db.prepare("INSERT INTO assets(id, project_id, kind, name, sha256, bytes, original_path, proxy_path, thumb_path, status, created_at, updated_at) VALUES (?,?,'video','a.mp4',?,?,?,?,?,'ready',?,?)");
    ins.run(assetId, projectId, 'h1', 50, `${projectId}/${assetId}/original.mp4`, `${projectId}/${assetId}/proxy.mp4`, `${projectId}/${assetId}/thumb.jpg`, now, now);
    ins.run(s.ctx.newId(), projectId, 'h2', 1, 'x', '../outside.txt', null, now, now);
    fs.writeFileSync(path.join(s.ctx.paths.tmp, 'still-1.png'), Buffer.alloc(200));
    const r = await body<{ freedBytes: number }>(await s.api('/settings/caches/clear', { method: 'POST', json: { scope: ['proxies', 'stills'] } }));
    expect(r.freedBytes).toBe(1200);
    expect(fs.existsSync(path.join(dir, 'proxy.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'thumb.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'original.mp4'))).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readdirSync(s.ctx.paths.tmp)).toEqual([]);
    expect(s.ctx.db.prepare('SELECT proxy_path p, thumb_path t, status s FROM assets WHERE id = ?').get(assetId)).toEqual({ p: null, t: `${projectId}/${assetId}/thumb.jpg`, s: 'ready' });
    s.ctx.db.prepare("UPDATE assets SET status = 'ingesting' WHERE id = ?").run(assetId);
    expect((await s.api('/settings/caches/clear', { method: 'POST', json: {} })).status).toBe(409);
  });
});

describe('licence integration (dev keys only, injected fingerprint)', () => {
  const key = makeDevKey('T1');
  const now = () => new Date('2026-11-20T10:00:00Z');
  const base: LicenseOptions = { keys: () => [key.entry], fingerprintSource: { platform: 'test', read: async () => MACHINE_A }, buildDate: BUILD_DATE, now, revocationCopies: () => [] };
  let s: TestService;
  const events: Array<{ n: string; d: Record<string, unknown> }> = [];
  const boot = async (opts: LicenseOptions, dataDir?: string, dbKeyHex?: string) => {
    s = await startService({ modules: [health, createLicenseModule(opts)], ...(dataDir ? { dataDir } : {}), ...(dbKeyHex ? { cfg: { dbKeyHex } } : {}) });
    const orig = s.ctx.bus.emit.bind(s.ctx.bus); s.ctx.bus.emit = (n, d) => { events.push({ n, d }); return orig(n, d); };
  };
  beforeAll(async () => { await boot(base); });
  afterAll(async () => { await s.close(); });
  type Lic = { status: string; code: string | null; machineCode: string; limits: { watermark: boolean; maxResolution: string }; updatesEligible: boolean; warnings: string[]; tier: string | null };

  it('starts in Trial Mode with this machine\'s code', async () => {
    const l = await body<Lic>(await s.api('/license'));
    expect(l).toMatchObject({ status: 'trial', machineCode: fpA.machineCode, limits: { watermark: true, maxResolution: '720p' }, updatesEligible: false });
    expect(s.ctx.hooks.isTrial()).toBe(true);
  });

  it('rejects a key for another computer, a tampered key and garbage', async () => {
    const other = await s.api('/license/activate', { method: 'POST', json: { key: signPayload(payloadFor(fpB), key) } });
    expect(other.status).toBe(422);
    expect((await body<{ error: { code: string } }>(other)).error.code).toBe('EM-5003');
    const good = signPayload(payloadFor(fpA), key);
    const parts = good.split('-'); const p = parts[2]!; parts[2] = p.slice(0, 10) + (p[10] === 'A' ? 'B' : 'A') + p.slice(11);
    const tampered = await body<{ error: { code: string } }>(await s.api('/license/activate', { method: 'POST', json: { key: parts.join('-') } }));
    expect(['EM-5002', 'EM-5006']).toContain(tampered.error.code);
    expect((await body<{ error: { code: string } }>(await s.api('/license/activate', { method: 'POST', json: { key: 'X'.repeat(60) } }))).error.code).toBe('EM-5006');
    expect(s.ctx.hooks.isTrial()).toBe(true);
  });

  it('activates a key bound to this Machine Code; the token is sealed at rest; deactivate returns to Trial Mode', async () => {
    const good = signPayload(payloadFor(fpA), key);
    const r = await s.api('/license/activate', { method: 'POST', json: { key: good } });
    const txt = await r.text();
    expect(r.status).toBe(200);
    expect(txt).not.toContain(good.slice(10, 60));
    expect(JSON.parse(txt)).toMatchObject({ status: 'active', tier: 'standard', updatesEligible: true, limits: { watermark: false, maxResolution: '2160p' } });
    expect(s.ctx.hooks.isTrial()).toBe(false);
    const row = s.ctx.db.prepare('SELECT token_enc, status, fingerprint_hash FROM license WHERE id = 1').get() as { token_enc: Buffer; status: string; fingerprint_hash: string };
    expect(row.status).toBe('active'); expect(row.fingerprint_hash).toBe(fpA.fpHex);
    expect(row.token_enc.includes(Buffer.from(good.slice(4, 40)))).toBe(false);
    expect(events.some((e) => e.n === 'license.changed' && (e.d['licence'] as { status: string }).status === 'active')).toBe(true);
    expect((await s.api('/license/deactivate', { method: 'POST', json: { confirm: false } })).status).toBe(400);
    expect(await body(await s.api('/license/deactivate', { method: 'POST', json: { confirm: true } }))).toMatchObject({ status: 'trial' });
    expect((s.ctx.db.prepare('SELECT token_enc FROM license WHERE id = 1').get() as { token_enc: Buffer | null }).token_enc).toBeNull();
    expect(s.ctx.hooks.isTrial()).toBe(true);
  });

  it('a build after updatesUntil activates with EM-5005 and keeps Trial exports', async () => {
    const r = await body<Lic>(await s.api('/license/activate', { method: 'POST', json: { key: signPayload(payloadFor(fpA, { upd: '2026-01-31' }), key) } }));
    expect(r).toMatchObject({ status: 'updates-expired', updatesEligible: false, warnings: ['EM-5005'], limits: { watermark: true } });
    expect(s.ctx.hooks.isTrial()).toBe(true);
  });

  it('the hourly check re-verifies the stored key and announces a clock rollback (EM-5007) without changing the status', async () => {
    let t = new Date('2026-11-20T10:00:00Z');
    const { dataDir, dbKeyHex } = s.cfg;
    await s.api('/license/activate', { method: 'POST', json: { key: signPayload(payloadFor(fpA), key) } });
    await s.close();
    await boot({ ...base, now: () => t, tickMs: 30 }, dataDir, dbKeyHex);
    expect(await body(await s.api('/license'))).toMatchObject({ status: 'active', clockAnomaly: false });
    events.length = 0;
    t = new Date('2026-10-01T10:00:00Z');                                       // clock set back > 24 h
    for (let i = 0; i < 50 && !events.some((e) => e.n === 'license.changed'); i++) await new Promise((r) => setTimeout(r, 20));
    const ev = events.find((e) => e.n === 'license.changed');
    expect(ev?.d['licence']).toMatchObject({ status: 'active', clockAnomaly: true });
    await s.close();
    await boot(base, dataDir, dbKeyHex);
  });

  it('survives a restart, and a newer signed revoked.json revokes the stored key at startup', async () => {
    await s.api('/license/activate', { method: 'POST', json: { key: signPayload(payloadFor(fpA), key) } });
    const { dataDir, dbKeyHex } = s.cfg;
    await s.close();
    await boot(base, dataDir, dbKeyHex);
    expect(await body(await s.api('/license'))).toMatchObject({ status: 'active' });
    expect(s.ctx.hooks.isTrial()).toBe(false);
    await s.close();
    const list = signedRevocationList([{ lid: payloadFor(fpA).lid, epoch: 1, reason: 'refund' }], key);
    events.length = 0;
    await boot({ ...base, revocationCopies: () => [{ bytes: list.bytes, signatureText: list.sig }] }, dataDir, dbKeyHex);
    expect(await body(await s.api('/license'))).toMatchObject({ status: 'revoked', code: 'EM-5004', limits: { watermark: true } });
    expect(s.ctx.hooks.isTrial()).toBe(true);
    expect(s.ctx.bus.lastSeq).toBeGreaterThanOrEqual(1);                       // license.changed emitted during start
    expect(s.ctx.db.prepare("SELECT details_json d FROM audit_log WHERE event = 'license.status-changed' ORDER BY id DESC LIMIT 1").get()).toEqual({ d: JSON.stringify({ from: 'active', to: 'revoked', code: 'EM-5004' }) });
  });
});

describe('diagnostics and shutdown', () => {
  let s: TestService; let shutdowns = 0;
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, providersModule, createHardwareModule({ detect: async () => hw(8192), detectOnStart: false }),
      createLicenseModule({ keys: () => [], fingerprintSource: { platform: 'test', read: async () => MACHINE_A }, revocationCopies: () => [] }), createDiagnosticsModule({ onShutdown: () => { shutdowns++; }, shutdownDelayMs: 20 })] });
    await s.api('/providers/connections', { method: 'POST', json: { provider: 'openrouter', label: 'k', secret: SECRET, validateNow: false } });
    await s.api('/hardware/profile');
    s.ctx.log.error({ code: 'EM-4103', detail: `failed with ${SECRET}` }, 'provider error');
    fs.appendFileSync(path.join(s.ctx.paths.logs, `engine-${new Date().toISOString().slice(0, 10)}.log`),
      `{"level":"warn","msg":"raw ${SECRET} at ${os.homedir()}/Videos/x.mp4 key x'${s.cfg.dbKeyHex}' Bearer ${s.token}"}\n`);
  });
  afterAll(async () => { await s.close(); });

  it('bundle: expected files, everything redacted, no database, keys, token or media', async () => {
    const projectId = addProject(s); const versionId = s.ctx.newId(); const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO composition_versions(id, project_id, hash, model_json, cause, duration_ms, created_at) VALUES (?,?,?,?,'system',0,?)")
      .run(versionId, projectId, 'h', JSON.stringify({ tracks: { text: [{ id: 't1', text: 'Rahasia judul' }] } }), now);
    s.ctx.db.prepare('UPDATE projects SET head_version_id = ? WHERE id = ?').run(versionId, projectId);
    const r = await body<{ path: string; bytes: number; contents: string[] }>(await s.api('/diagnostics/bundle', { method: 'POST', json: { includeStructure: true } }));
    expect(path.dirname(r.path)).toBe(s.ctx.paths.logs);
    expect(r.contents).toEqual(expect.arrayContaining(['versions.json', 'hardware.json', 'settings.json', 'license.json', 'projects.json', 'render-jobs.json', 'migrations.json', 'env.json', 'events.json', `structure/${projectId}.json`]));
    expect(r.contents.some((c) => c.startsWith('logs/service-'))).toBe(true);
    expect(r.contents.some((c) => /\.(db|sqlite|mp4|wav|png|jpg)$/.test(c) || c.includes('keyring'))).toBe(false);
    const zip = readZip(fs.readFileSync(r.path));
    expect([...zip.keys()]).toEqual(r.contents);
    const all = [...zip.values()].map((b) => b.toString('utf8')).join('\n');
    for (const needle of [SECRET, 'f00dcafef00dcafe', s.cfg.dbKeyHex, s.token, os.homedir(), 'Rahasia']) expect(all).not.toContain(needle);
    expect(all).toContain('[13 chars]');
    expect(JSON.parse(zip.get('hardware.json')!.toString()).profile).toMatchObject({ tier: 'T2' });
    expect(JSON.parse(zip.get('license.json')!.toString())).toMatchObject({ status: 'trial', fingerprintPrefix: fpA.fpHex.slice(0, 8) });
    expect(JSON.parse(zip.get('events.json')!.toString()).join('\n')).toContain('EM-4103');
  });

  it('R-182 lists recent EM codes with time and job id (FR-150)', async () => {
    const projectId = addProject(s); const versionId = s.ctx.newId(); const jobId = s.ctx.newId();
    s.ctx.db.prepare("INSERT INTO composition_versions(id, project_id, hash, model_json, cause, duration_ms, created_at) VALUES (?,?,?,'{}','system',0,?)").run(versionId, projectId, 'h3', new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO render_jobs(id, project_id, version_id, output_profile_json, performance_profile, status, error_code, created_at, finished_at) VALUES (?,?,?,'{}','standard','failed','EM-3201',?,?)")
      .run(jobId, projectId, versionId, '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:01.000Z');
    const r = await body<{ items: Array<{ at: string; code: string; source: string; ref: string | null }> }>(await s.api('/diagnostics/codes?limit=20'));
    expect(r.items[0]).toEqual({ at: '2099-01-01T00:00:01.000Z', code: 'EM-3201', source: 'render', ref: jobId });
    expect(r.items.some((e) => e.code === 'EM-4103' && e.source === 'log')).toBe(true);
    s.ctx.db.prepare("UPDATE render_jobs SET status = 'cancelled' WHERE id = ?").run(jobId);
  });

  it('health with the token adds build date, Private Mode and engine facts; without it stays reduced', async () => {
    const open = await body<Record<string, unknown>>(await s.api('/health', { auth: false }));
    expect(Object.keys(open).sort()).toEqual(['mode', 'status', 'uptimeMs', 'version']);
    const full = await body<{ buildDate: string; privateMode: boolean; engine: { ok: boolean } }>(await s.api('/health'));
    expect(full.buildDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(full.privateMode).toBe(false); expect(typeof full.engine.ok).toBe('boolean');
  });

  it('log tail is redacted and level-filtered', async () => {
    const r = await body<{ lines: string[] }>(await s.api('/diagnostics/logs?lines=50&level=warn'));
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.every((l) => /"level":"(warn|error)"/.test(l))).toBe(true);
    expect(r.lines.join('\n')).not.toContain(SECRET);
    expect((await s.api('/diagnostics/logs?lines=5000')).status).toBe(400);
  });

  it('shutdown: trusted caller only, refuses while rendering unless forced, then signals', async () => {
    const shut = (json: unknown, shell = true) => s.api('/service/shutdown', { method: 'POST', json, ...(shell ? { headers: { 'X-Expertmotion-Caller': 'shell' } } : {}) });
    expect((await shut({ reason: 'window-closed' }, false)).status).toBe(403);
    const projectId = addProject(s); const versionId = s.ctx.newId(); const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO composition_versions(id, project_id, hash, model_json, cause, duration_ms, created_at) VALUES (?,?,?,'{}','system',0,?)").run(versionId, projectId, 'h2', now);
    s.ctx.db.prepare("INSERT INTO render_jobs(id, project_id, version_id, output_profile_json, performance_profile, status, created_at) VALUES (?,?,?,'{}','standard','rendering',?)").run(s.ctx.newId(), projectId, versionId, now);
    const busy = await shut({ reason: 'window-closed' });
    expect(busy.status).toBe(409);
    expect((await body<{ error: { code: string } }>(busy)).error.code).toBe('EM-8304');
    const ok = await shut({ reason: 'update', force: true });
    expect(ok.status).toBe(202);
    expect(await body(ok)).toHaveProperty('acceptedAt');
    await waitFor(() => shutdowns === 1);
  });
});
