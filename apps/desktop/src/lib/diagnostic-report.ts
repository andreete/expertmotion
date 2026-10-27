/**
 * Native diagnostic report (FR-199, SEC-105): a zip the Creator saves from the tray ("Simpan laporan diagnostik ke Desktop") or
 * the Start-menu shortcut "Expertmotion – Diagnostik" (`Expertmotion.exe --diagnostics`), built by the Shell alone, so it works
 * while the Editor window is black or the Local Service is down. No `electron` import (unit-tested on Linux); main.ts passes
 * the Electron facts (versions, GPU status) in.
 *
 * Contents (exactly; SECURITY.md SEC-105):
 *   - `logs/<shell|service|engine>-<today|yesterday>.log[.old]` (UTC dates, the rotation's names), each ≤ MAX_LOG_BYTES (tail),
 *   - `crash/crash-<shell|service>-<ts>.txt`, the newest MAX_CRASH_FILES of the last 7 days, each ≤ MAX_CRASH_BYTES (tail),
 *   - `system.json`: app / Electron / Chromium / Node versions, platform, arch, OS release, CPU model + count, RAM, locale,
 *     PLATFORM.json of the engines, graphics mode, previous session marker, GPU feature status and the GPU summary
 *     (vendor / device ids and names, driver vendor / version only),
 *   - `README.txt`: what is inside and what is not.
 * Never: the database, keyring.bin, settings.json, media, outputs, models, project names or text, provider keys, the Service Token.
 * Every text entry is redacted again (the shared SEC-100 patterns + the user's home folder → `~` + JSON key fields), even though
 * the log lines were redacted when written.
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { redact } from '@expertmotion/shared';

export const MAX_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_CRASH_FILES = 20;
export const MAX_CRASH_BYTES = 256 * 1024;
export const CRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAGNOSTICS_SWITCH = '--diagnostics';

/** Day stamps (UTC, as in `createRotatingLog`) of today and yesterday. */
export function reportDays(now: number): string[] {
  return [new Date(now).toISOString().slice(0, 10), new Date(now - 86_400_000).toISOString().slice(0, 10)];
}

const LOG_NAME = /^(shell|service|engine)-(\d{4}-\d{2}-\d{2})\.log(\.old)?$/;
const CRASH_NAME = /^crash-(shell|service)-\d{8}-\d{6}\.txt$/;

export interface FileFact { name: string; mtimeMs: number; size: number }

/** Which files of the logs folder go into the report (pure; tested). Everything else in the folder is left out. */
export function selectReportFiles(files: readonly FileFact[], now: number): { logs: string[]; crashes: string[] } {
  const days = new Set(reportDays(now));
  const logs = files.filter((f) => { const m = LOG_NAME.exec(f.name); return m !== null && days.has(m[2]!); }).map((f) => f.name).sort();
  const crashes = files.filter((f) => CRASH_NAME.test(f.name) && now - f.mtimeMs <= CRASH_MAX_AGE_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)).slice(0, MAX_CRASH_FILES).map((f) => f.name).sort();
  return { logs, crashes };
}

/** The report's redaction (applied to every entry): SEC-100 patterns, home folder → `~`, secret-looking JSON fields. */
export function scrubReportText(text: string, homeDir: string): string {
  let out = redact(text);
  if (homeDir.length > 3) {
    for (const h of new Set([homeDir, homeDir.replaceAll('\\', '\\\\'), homeDir.replaceAll('\\', '/')])) out = out.split(h).join('~');
  }
  return out
    .replace(/x'[0-9a-fA-F]{64}'/g, "x'[REDACTED]'")
    .replace(/(\\?"(?:apiKey|api_key|secret|dbKey|dbKeyHex|token|serviceToken|password|licenseKey|licenceKey)\\?"\s*:\s*\\?")[^"\\]+/gi, '$1[REDACTED]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[REDACTED-HEX]');
}

/** GPU summary from `app.getGPUInfo('basic')`: device ids, names and driver only (no machine-specific serials). */
export function summarizeGpuInfo(raw: unknown): { devices: Array<Record<string, unknown>>; driverVersion?: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const devices = Array.isArray(r['gpuDevice']) ? r['gpuDevice'] : [];
  const pick = (d: unknown): Record<string, unknown> => {
    const o = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of ['active', 'vendorId', 'deviceId', 'vendorString', 'deviceString', 'driverVendor', 'driverVersion', 'driverDate']) {
      const v = o[k];
      if (typeof v === 'number') out[k] = k === 'vendorId' || k === 'deviceId' ? `0x${v.toString(16).padStart(4, '0')}` : v;
      else if (typeof v === 'string' || typeof v === 'boolean') out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
    }
    return out;
  };
  const list = devices.slice(0, 4).map(pick);
  const active = list.find((d) => d['active'] === true) ?? list[0];
  const driver = active?.['driverVersion'];
  return { devices: list, ...(typeof driver === 'string' ? { driverVersion: driver } : {}) };
}

/** One short line for the Shell log at startup: `vendor/device driver` of the active GPU. */
export function gpuLogFields(summary: ReturnType<typeof summarizeGpuInfo>, featureStatus: unknown): Record<string, unknown> {
  const active = summary?.devices.find((d) => d['active'] === true) ?? summary?.devices[0];
  const fs = typeof featureStatus === 'object' && featureStatus !== null ? featureStatus as Record<string, unknown> : {};
  const pickStatus: Record<string, unknown> = {};
  for (const k of ['gpu_compositing', 'webgl', 'webgl2', 'rasterization', 'video_decode', 'video_encode', 'opengl', 'skia_graphite', 'webgpu']) if (typeof fs[k] === 'string') pickStatus[k] = fs[k];
  return {
    gpu: active ? `${String(active['vendorId'] ?? '?')}/${String(active['deviceId'] ?? '?')}` : 'unknown',
    ...(active?.['deviceString'] ? { gpuName: active['deviceString'] } : {}),
    ...(active?.['driverVendor'] ? { driverVendor: active['driverVendor'] } : {}),
    ...(summary?.driverVersion ? { driverVersion: summary.driverVersion } : {}),
    featureStatus: pickStatus,
  };
}

/** `Expertmotion-diagnostik-YYYYMMDD-HHMMSS.zip` (local time: the name the Creator sees on the Desktop). */
export function reportFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Expertmotion-diagnostik-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

export const REPORT_README = [
  'Laporan diagnostik Expertmotion / Expertmotion diagnostic report',
  '',
  'Isi / Contents:',
  '  logs/    catatan Shell, layanan dan engine hari ini dan kemarin (rahasia disamarkan)',
  '           Shell, service and engine logs of today and yesterday (secrets redacted)',
  '  crash/   catatan crash 7 hari terakhir / crash notes of the last 7 days',
  '  system.json  versi aplikasi, Windows, CPU, RAM, kartu grafis (GPU) dan mode grafis',
  '               app, OS, CPU, RAM, GPU versions and the graphics mode',
  '',
  'Tidak termasuk / Not included: proyek, media, hasil render, database, kunci penyedia AI, kunci lisensi, pengaturan.',
  'Not included: projects, media, renders, the database, provider keys, the licence key, settings.',
  'Laporan ini tidak dikirim ke mana pun. Kirim sendiri ke dukungan bila diminta.',
  'This report is never sent anywhere by Expertmotion. Send it to support yourself if asked.',
  '',
].join('\r\n');

export interface ZipEntry { name: string; data: Buffer | string }

/** CRC-32 (IEEE); `zlib.crc32` when the runtime has it (Node ≥ 22.2), else a table. */
let crcTable: Uint32Array | null = null;
export function crc32(buf: Buffer): number {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === 'function') return native(buf) >>> 0;
  if (crcTable === null) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP (PKZIP 2.0, deflate, UTF-8 names, no ZIP64) — the same format as the Service's diagnostics bundle. */
export function createZip(entries: readonly ZipEntry[], date = new Date()): Buffer {
  const dosTime = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const dosDate = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Last `maxBytes` of a file, starting at a line boundary when cut. */
export function tailFile(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size; const len = Math.min(size, maxBytes); const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const s = buf.toString('utf8');
    return size > len ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { closeSync(fd); }
}

export interface ReportInput {
  logsDir: string;
  homeDir: string;
  now: number;
  /** system.json content (main collects it; scrubbed here too). */
  system: Record<string, unknown>;
}

/** Builds the report entries from the logs folder (reads only the selected files). */
export function buildReportEntries(input: ReportInput): ZipEntry[] {
  let facts: FileFact[] = [];
  try {
    facts = readdirSync(input.logsDir).flatMap((name) => {
      try { const st = statSync(join(input.logsDir, name)); return st.isFile() ? [{ name, mtimeMs: st.mtimeMs, size: st.size }] : []; } catch { return []; }
    });
  } catch { /* no logs folder yet */ }
  const { logs, crashes } = selectReportFiles(facts, input.now);
  const scrub = (t: string) => scrubReportText(t, input.homeDir);
  const entries: ZipEntry[] = [{ name: 'README.txt', data: REPORT_README }];
  for (const f of logs) { try { entries.push({ name: `logs/${f}`, data: scrub(tailFile(join(input.logsDir, f), MAX_LOG_BYTES)) }); } catch { /* vanished */ } }
  for (const f of crashes) { try { entries.push({ name: `crash/${f}`, data: scrub(tailFile(join(input.logsDir, f), MAX_CRASH_BYTES)) }); } catch { /* vanished */ } }
  entries.push({ name: 'system.json', data: scrub(JSON.stringify({ ...input.system, reportFiles: { logs, crashes } }, null, 2)) });
  return entries;
}

/** Reads a small JSON file or returns null (PLATFORM.json, gpu-info.json, session.json). */
export function readSmallJson(file: string, maxBytes = 64 * 1024): unknown {
  try { const st = statSync(file); if (st.size > maxBytes) return null; return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
