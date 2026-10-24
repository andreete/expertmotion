/**
 * Machine Fingerprint (LICENSE_OPERATIONS.md §5).
 * Hashing, normalisation and the 2-of-3 tolerance rule are pure. Component collection sits behind
 * `FingerprintSource`; raw values never leave this module's caller, are never logged, never persisted.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { base32Decode, base32Encode, COMPONENT_BYTES, encodeMachineCode, type ComponentTriple } from './format.js';

export const FP_SALTS = [
  'expertmotion.fp.v1.machineguid',
  'expertmotion.fp.v1.diskserial',
  'expertmotion.fp.v1.cpumodel',
] as const;

/** Raw component values as read from the OS. `null` = unreadable / missing. */
export interface RawComponents {
  readonly machineGuid: string | null;
  readonly diskSerial: string | null;
  readonly cpuModel: string | null;
}

export interface FingerprintSource {
  readonly platform: string;
  read(): Promise<RawComponents>;
}

// ---------- normalisation (§5.1) ----------

export function normaliseMachineGuid(v: string | null): string | null {
  const s = (v ?? '').trim().toLowerCase();
  return s === '' ? null : s;
}

export function normaliseDiskSerial(v: string | null): string | null {
  const s = (v ?? '').trim().toUpperCase().replace(/\s+/g, ' ').replace(/[^A-Z0-9]/g, '');
  return s === '' ? null : s;
}

export function normaliseCpuModel(v: string | null): string | null {
  const s = (v ?? '')
    .replace(/\(R\)|\(TM\)|®|™/gi, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

// ---------- hashing (§5.2) ----------

const ZERO = new Uint8Array(COMPONENT_BYTES);

/** c_i = first 8 bytes of SHA-256(UTF8(SALT_i) ‖ 0x00 ‖ UTF8(value)); 8 zero bytes when missing. */
export function componentHash(salt: string, normalisedValue: string | null): Uint8Array {
  if (normalisedValue === null) return ZERO.slice();
  const h = createHash('sha256').update(salt, 'utf8').update(new Uint8Array([0])).update(normalisedValue, 'utf8').digest();
  return new Uint8Array(h.subarray(0, COMPONENT_BYTES));
}

export function isMissingComponent(c: Uint8Array): boolean {
  return c.length !== COMPONENT_BYTES || c.every((b) => b === 0);
}

/** fp = hex(SHA-256(c1 ‖ c2 ‖ c3)). */
export function combinedFingerprintHex(components: ComponentTriple): string {
  const h = createHash('sha256');
  for (const c of components) h.update(c);
  return h.digest('hex');
}

export interface LocalFingerprint {
  /** c1..c3 */
  readonly components: ComponentTriple;
  /** which components were readable on this machine */
  readonly present: readonly [boolean, boolean, boolean];
  /** combined hash (`fp`) */
  readonly fpHex: string;
  /** base32 component strings (`fpc`) */
  readonly fpc: readonly [string, string, string];
  /** Creator-visible Machine Code */
  readonly machineCode: string;
}

export function fingerprintFromComponents(components: ComponentTriple): LocalFingerprint {
  return {
    components,
    present: [!isMissingComponent(components[0]), !isMissingComponent(components[1]), !isMissingComponent(components[2])],
    fpHex: combinedFingerprintHex(components),
    fpc: [base32Encode(components[0]), base32Encode(components[1]), base32Encode(components[2])],
    machineCode: encodeMachineCode(components),
  };
}

export function computeFingerprint(raw: RawComponents): LocalFingerprint {
  return fingerprintFromComponents([
    componentHash(FP_SALTS[0], normaliseMachineGuid(raw.machineGuid)),
    componentHash(FP_SALTS[1], normaliseDiskSerial(raw.diskSerial)),
    componentHash(FP_SALTS[2], normaliseCpuModel(raw.cpuModel)),
  ]);
}

// ---------- tolerance rule (§5.4) ----------

export interface FingerprintMatch {
  readonly ok: boolean;
  /** positions readable on both sides */
  readonly compared: number;
  /** positions that compared equal */
  readonly matched: number;
  /** positions (0-based) unreadable on this machine; for support diagnostics only */
  readonly unreadableLocal: readonly number[];
}

/**
 * 2-of-3 rule: 3 comparable → ≥ 2 equal; 2 comparable (one missing locally or in the Payload) → both equal;
 * ≤ 1 comparable → mismatch. The tolerance exists only for hardware drift on the SAME machine:
 * a different computer differs in at least c1 and c2 and is rejected.
 */
export function matchFingerprint(local: LocalFingerprint, payloadFpc: readonly string[]): FingerprintMatch {
  let compared = 0;
  let matched = 0;
  const unreadableLocal: number[] = [];
  for (let i = 0; i < 3; i++) {
    const localC = local.components[i as 0 | 1 | 2];
    const localPresent = local.present[i as 0 | 1 | 2];
    if (!localPresent) unreadableLocal.push(i);
    const remote = base32Decode(payloadFpc[i] ?? '');
    const remotePresent = remote !== null && !isMissingComponent(remote);
    if (!localPresent || !remotePresent) continue;
    compared++;
    if (constantTimeEqual(localC, remote)) matched++;
  }
  const ok = compared === 3 ? matched >= 2 : compared === 2 ? matched === 2 : false;
  return { ok, compared, matched, unreadableLocal };
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

// ---------- OS collection ----------

/** Injected command runner so the parsers can be tested without the OS. */
export type ExecFn = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

const EXEC_TIMEOUT_MS = 8000;

export const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

async function tryExec(exec: ExecFn, file: string, args: readonly string[]): Promise<string | null> {
  try {
    return await exec(file, args, EXEC_TIMEOUT_MS);
  } catch {
    return null;
  }
}

/** Parse `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` output. */
export function parseRegQueryMachineGuid(stdout: string): string | null {
  const m = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/.exec(stdout);
  return m?.[1] ?? null;
}

/** First non-empty trimmed line. */
export function firstLine(stdout: string | null): string | null {
  if (stdout === null) return null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return null;
}

/**
 * PowerShell: serial of the physical disk that hosts the Windows system volume (§5.1 c2),
 * fallback lowest disk Index. Uses the same Win32_DiskDrive.SerialNumber that systeminformation reads.
 */
export const WINDOWS_DISK_SERIAL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$dd=$null',
  'try {',
  '  $sd=(Get-CimInstance Win32_OperatingSystem).SystemDrive',
  '  $ld=Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID=\'"+$sd+"\'")',
  '  $parts=Get-CimAssociatedInstance -InputObject $ld -ResultClassName Win32_DiskPartition',
  '  foreach($p in $parts){ $d=Get-CimAssociatedInstance -InputObject $p -ResultClassName Win32_DiskDrive; if($d){ $dd=$d | Select-Object -First 1; break } }',
  '} catch {}',
  'if(-not $dd){ $dd=Get-CimInstance Win32_DiskDrive | Sort-Object Index | Select-Object -First 1 }',
  'if($dd){ [Console]::Out.WriteLine([string]$dd.SerialNumber) }',
].join('\n');

export class WindowsFingerprintSource implements FingerprintSource {
  readonly platform = 'win32';
  constructor(
    private readonly exec: ExecFn = defaultExec,
    private readonly cpuModel: () => string | null = () => os.cpus()[0]?.model ?? null,
  ) {}

  async read(): Promise<RawComponents> {
    const [reg, disk] = await Promise.all([
      tryExec(this.exec, 'reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']),
      tryExec(this.exec, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_DISK_SERIAL_SCRIPT]),
    ]);
    return {
      machineGuid: reg === null ? null : parseRegQueryMachineGuid(reg),
      diskSerial: firstLine(disk),
      cpuModel: this.cpuModel(),
    };
  }
}

/** Development fallback for Linux/macOS (the product ships on Windows first). */
export class PosixFingerprintSource implements FingerprintSource {
  constructor(
    readonly platform: string = process.platform,
    private readonly exec: ExecFn = defaultExec,
    private readonly readText: (p: string) => Promise<string> = (p) => readFile(p, 'utf8'),
    private readonly cpuModel: () => string | null = () => os.cpus()[0]?.model ?? null,
  ) {}

  async read(): Promise<RawComponents> {
    return this.platform === 'darwin' ? this.readDarwin() : this.readLinux();
  }

  private async readLinux(): Promise<RawComponents> {
    let machineGuid: string | null = null;
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        machineGuid = firstLine(await this.readText(p));
        if (machineGuid) break;
      } catch {
        /* try next */
      }
    }
    let diskSerial: string | null = null;
    const rootSource = firstLine(await tryExec(this.exec, 'findmnt', ['-no', 'SOURCE', '/']));
    if (rootSource && rootSource.startsWith('/dev/')) {
      const parent = firstLine(await tryExec(this.exec, 'lsblk', ['-no', 'PKNAME', rootSource]));
      const device = parent ? `/dev/${parent}` : rootSource;
      diskSerial = firstLine(await tryExec(this.exec, 'lsblk', ['-dno', 'SERIAL', device]));
    }
    return { machineGuid, diskSerial, cpuModel: this.cpuModel() };
  }

  private async readDarwin(): Promise<RawComponents> {
    const io = await tryExec(this.exec, 'ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const uuid = io ? /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(io)?.[1] ?? null : null;
    const serial = io ? /"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/.exec(io)?.[1] ?? null : null;
    return { machineGuid: uuid, diskSerial: serial, cpuModel: this.cpuModel() };
  }
}

export function defaultFingerprintSource(platform: string = process.platform): FingerprintSource {
  return platform === 'win32' ? new WindowsFingerprintSource() : new PosixFingerprintSource(platform);
}

/** Read once per launch and cache the result in memory (§5.1); the caller owns the cache. */
export async function readLocalFingerprint(source: FingerprintSource = defaultFingerprintSource()): Promise<LocalFingerprint> {
  return computeFingerprint(await source.read());
}

