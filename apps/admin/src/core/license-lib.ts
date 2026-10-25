/**
 * The one import point for the Operator CLI's library (tools/license-cli/src/lib). The admin app does
 * not reimplement any crypto, encoding or licence policy; it calls the same functions the CLI uses.
 * The library is plain JS; this file only adds TypeScript signatures for what the admin app uses.
 */
import * as audit from '../../../../tools/license-cli/src/lib/audit.mjs';
import * as email from '../../../../tools/license-cli/src/lib/email.mjs';
import * as format from '../../../../tools/license-cli/src/lib/format.mjs';
import * as keys from '../../../../tools/license-cli/src/lib/keys.mjs';
import * as net from '../../../../tools/license-cli/src/lib/net.mjs';
import * as ops from '../../../../tools/license-cli/src/lib/ops.mjs';
import * as token from '../../../../tools/license-cli/src/lib/token.mjs';

export interface AuditRow {
  timestamp_utc: string; action: string; lid: string; kid: string; rev: number; name: string; email: string; tier: string;
  fp_hex: string; machine_code: string; updates_until: string; order_ref: string; reason: string; operator_note: string;
}
export interface LicenceStateT { lid: string; rows: AuditRow[]; latestKey: AuditRow | null; currentRev: number; revoked: boolean }
export interface Machine { ok: true; components: Uint8Array[]; present: boolean[]; fpc: string[]; fp: string; machineCode: string }
export type MachineDecode = Machine | { ok: false; reason: 'format' | 'crc' };
export interface Payload { eh: string; feat: string[]; fp: string; fpc: string[]; iat: string; lid: string; name: string; rev: number; tier: string; upd: string; v: 1 }
export interface SealedKey { kid: string; seed: Uint8Array; publicKeyHex: string }
export interface PublicKey { kid: string; publicKeyHex: string; status: string }
export interface KeyOpResult { action: string; payload: Payload; token: string; file: string; machineCode: string; revocationEpoch?: number }
export interface VerifyResult { code: string | null; valid: boolean; kid?: string; payload?: Payload; fingerprint?: { ok: boolean; compared: number; matched: number }; revokedEpoch?: number }
type LoadKey = () => SealedKey;
interface Files { auditPath: string; outDir: string }

export const readAudit = audit.readAudit as (file: string) => AuditRow[];
export const licenceState = audit.licenceState as (rows: AuditRow[], lid: string) => LicenceStateT | null;
export const rebindsInLast12Months = audit.rebindsInLast12Months as (rows: AuditRow[], lid: string, now: Date) => number;
export const REBIND_LIMIT = audit.REBIND_LIMIT as number;

export const emailBody = email.emailBody as (a: { name: string; lid: string; key: string; machineCode: string; updatesUntil: string; lang?: string; updated?: boolean; signature?: string }) => string;

export const decodeMachineCode = format.decodeMachineCode as (input: string) => MachineDecode;
export const groupKey = format.groupKey as (key: string) => string;
export const isoDate = format.isoDate as (d: Date) => string;

export const isInsideRepo = keys.isInsideRepo as (p: string) => boolean;
export const keygen = keys.keygen as (opts: { kid: string; out: string; seal: boolean; passphrase: string }) => { kid: string; publicKeyHex: string; path: string; sealed: boolean };
export const loadPrivateKey = keys.loadPrivateKey as (opts: { 'key-file': string; passphrase: string }) => SealedKey;
export const KEY_FILE_FORMAT = keys.KEY_FILE_FORMAT as string;

export const upInterfaces = net.upInterfaces as () => string[];

export const issueLicence = ops.issueLicence as (a: Files & {
  loadKey: LoadKey; name: string; email: string; tier: string; machineCode: string; months: string; order: string; override: string; note: string; now: Date;
}) => KeyOpResult;
export const rebindLicence = ops.rebindLicence as (a: Files & { loadKey: LoadKey; lid: string; machineCode: string; override: string; order: string; note?: string; now: Date }) => KeyOpResult;
export const renewLicence = ops.renewLicence as (a: Files & { loadKey: LoadKey; lid: string; months: string; order: string; note: string; now: Date }) => KeyOpResult;
export const revokeLicence = ops.revokeLicence as (a: { auditPath: string; lid: string; reason: string; note: string; order: string; now: Date }) => { action: 'revoke'; lid: string; epoch: number; reason: string };
export const exportRevocations = ops.exportRevocations as (a: { auditPath: string; out: string; loadKey: LoadKey }) => { out: string; sig: string; entries: number; generatedAt: string; kid: string };

export const verifyKey = token.verifyKey as (input: string, ctx: { keys: PublicKey[]; machine?: Machine; revocations?: Map<string, number>; buildDate?: string }) => VerifyResult;
export const verifyRevocationList = token.verifyRevocationList as (bytes: Uint8Array, sigText: string, keys: PublicKey[]) => Map<string, number> | null;
