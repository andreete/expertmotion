// Licence operations (LICENSE_OPERATIONS.md §8, §10) shared by the CLI (src/cli.mjs) and the
// Operator's admin app (apps/admin). Policy lives here once: Machine Code checks, the rebind limit,
// duplicate orders, revoked/deleted licences, revocation epochs. These functions never print and never
// touch the passphrase; the caller hands in `loadKey()`, which is only invoked once every check passed.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendAudit, deriveRevocationEntries, licenceState, readAudit, REBIND_LIMIT, rebindsInLast12Months } from './audit.mjs';
import { CliError } from './errors.mjs';
import { addMonths, decodeMachineCode, emailHash, isoDate, isoSeconds, ulid } from './format.mjs';
import { buildPayload, signRevocationList, signToken } from './token.mjs';

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const TIERS = ['standard', 'pro'];
export const REVOKE_REASONS = ['refund', 'fraud'];

export function parseMonths(raw = '12') {
  const s = String(raw);
  if (!/^\d{1,3}$/.test(s)) throw new CliError('--updates-months must be a whole number of months (0-999).', 2);
  return Number(s);
}

export function parseLid(raw) {
  const lid = String(raw ?? '').trim().toUpperCase();
  if (!ULID_RE.test(lid)) throw new CliError('--lid must be a 26-character ULID.', 2);
  return lid;
}

/** Machine Code → fingerprint fields; refuses a missing code, CRC mismatch (RISK-022) and unusable codes. */
export function machineFromCode(mc, command) {
  if (mc === undefined || mc === null || String(mc).trim() === '') {
    throw new CliError(
      `${command} requires the Creator's Machine Code (--fingerprint MC1-…). Every Licence Key is bound to exactly one computer; there is no unbound or floating key.`,
      2,
    );
  }
  const d = decodeMachineCode(String(mc));
  if (!d.ok) {
    throw new CliError(
      d.reason === 'crc'
        ? 'Machine Code checksum does not match — probably a typo. Ask the Creator to copy it again with the Copy button.'
        : 'This is not a valid Machine Code (expected MC1- followed by 42 base32 characters).',
      3,
    );
  }
  if (d.present.filter(Boolean).length < 2) {
    throw new CliError('This Machine Code has fewer than two readable components; a key bound to it could never verify. Ask the Creator for diagnostics.', 3);
  }
  return d;
}

export function validateName(name) {
  const n = String(name ?? '').trim();
  if (n === '' || [...n].length > 64 || /[\u0000-\u001f\u007f]/.test(n)) throw new CliError('--name must be 1-64 characters without control characters.', 2);
  return n;
}

export function validateEmail(email) {
  const e = String(email ?? '').trim();
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e) || e.length > 254) throw new CliError('--email does not look like an email address.', 2);
  return e;
}

export function writeLicenceFiles(outDir, lid, rev, key) {
  mkdirSync(outDir, { recursive: true });
  const latest = path.join(outDir, `${lid}.emlicense`);
  writeFileSync(latest, `${key}\n`);
  writeFileSync(path.join(outDir, `${lid}.r${rev}.emlicense`), `${key}\n`);
  return latest;
}

/** Sign a payload, write the .emlicense files and append the audit row. */
export function signAndRecord({ auditPath, outDir }, { action, key, lid, rev, name, email, tier, machine, upd, order = '', reason = '', note = '', now }) {
  const payload = buildPayload({
    lid, name, eh: emailHash(email), tier, fp: machine.fp, fpc: machine.fpc, iat: isoSeconds(now), upd, rev,
  });
  const token = signToken(payload, key);
  const file = writeLicenceFiles(outDir, lid, rev, token);
  appendAudit(auditPath, {
    timestamp_utc: isoSeconds(now), action, lid, kid: key.kid, rev, name, email, tier, fp_hex: machine.fp,
    machine_code: machine.machineCode, updates_until: upd, order_ref: order, reason, operator_note: note,
  });
  return { payload, token, file };
}

export function requireActiveState(rows, lid, command) {
  const st = licenceState(rows, lid);
  if (!st || !st.latestKey) throw new CliError(`No licence ${lid} in the audit log.`, 3);
  if (st.revoked) throw new CliError(`Licence ${lid} was revoked (${st.rows.filter((r) => r.action === 'revoke').map((r) => r.reason).join(', ')}); ${command} is not allowed. Issue a new licence for a new purchase.`, 3);
  if (st.latestKey.email === 'deleted') throw new CliError(`Licence ${lid} had its personal data deleted; the email hash cannot be recomputed. Issue a new licence.`, 3);
  return st;
}

/**
 * issue: a new lid bound to one Machine Code.
 * @returns {{action:'issue', payload, token, file, machineCode}}
 */
export function issueLicence({ auditPath, outDir, loadKey, name, email, tier = 'standard', machineCode, months = '12', order = '', override = '', note = '', now = new Date() }) {
  const machine = machineFromCode(machineCode, 'issue');
  const n1 = validateName(name);
  const e1 = validateEmail(email);
  if (!TIERS.includes(tier)) throw new CliError('--tier must be standard or pro.', 2);
  const n = parseMonths(months);
  const key = loadKey();
  const rows = readAudit(auditPath);
  const ord = String(order ?? '').trim();
  const ovr = String(override ?? '').trim();
  if (ord && rows.some((r) => r.action === 'issue' && r.order_ref === ord) && !ovr) {
    throw new CliError(`Order ${ord} already has a licence (see audit). Use rebind/renew, or --override "<reason>" for a second licence.`, 3);
  }
  const lid = ulid(now.getTime());
  const r = signAndRecord({ auditPath, outDir }, {
    action: 'issue', key, lid, rev: 0, name: n1, email: e1, tier, machine, upd: addMonths(isoDate(now), n), order: ord, reason: ovr, note, now,
  });
  return { action: 'issue', ...r, machineCode: machine.machineCode };
}

/** rebind: same lid, new Machine Code, rev+1; the previous key is revoked via revoked.json. */
export function rebindLicence({ auditPath, outDir, loadKey, lid: rawLid, machineCode, override = '', order = '', note, now = new Date() }) {
  const lid = parseLid(rawLid);
  const machine = machineFromCode(machineCode, 'rebind');
  const rows = readAudit(auditPath);
  const st = requireActiveState(rows, lid, 'rebind');
  const count = rebindsInLast12Months(rows, lid, now);
  const ovr = String(override ?? '').trim();
  if (count >= REBIND_LIMIT && !ovr) {
    throw new CliError(
      `EM-5008 Transfer limit reached: licence ${lid} has been moved ${count} times in the last 12 months (limit ${REBIND_LIMIT}). `
        + 'No key was issued. If you decide to allow it, re-run with --override "<reason>" (recorded in the audit log).',
      3,
      'EM-5008',
    );
  }
  if (st.latestKey.machine_code === machine.machineCode && !ovr) {
    throw new CliError(`Licence ${lid} is already bound to this Machine Code. Resend out/${lid}.emlicense instead, or use --override.`, 3);
  }
  const key = loadKey();
  const rev = st.currentRev + 1;
  const last = st.latestKey;
  const r = signAndRecord({ auditPath, outDir }, {
    action: 'rebind', key, lid, rev, name: last.name, email: last.email, tier: last.tier, machine, upd: last.updates_until,
    order: order ?? '', reason: ovr, note: note ?? `move ${count + 1} of ${REBIND_LIMIT} in 12 months`, now,
  });
  return { action: 'rebind', ...r, machineCode: machine.machineCode, revocationEpoch: rev };
}

/** renew: updatesUntil = max(old, today) + N months; rev+1; the previous key is revoked. */
export function renewLicence({ auditPath, outDir, loadKey, lid: rawLid, months = '12', order = '', note = '', now = new Date() }) {
  const lid = parseLid(rawLid);
  const n = parseMonths(months);
  const rows = readAudit(auditPath);
  const st = requireActiveState(rows, lid, 'renew');
  const last = st.latestKey;
  const machine = decodeMachineCode(last.machine_code);
  if (!machine.ok) throw new CliError(`Audit row for ${lid} has an unreadable Machine Code.`, 4);
  const key = loadKey();
  const today = isoDate(now);
  const upd = addMonths(last.updates_until > today ? last.updates_until : today, n);
  const rev = st.currentRev + 1;
  const r = signAndRecord({ auditPath, outDir }, {
    action: 'renew', key, lid, rev, name: last.name, email: last.email, tier: last.tier, machine, upd, order: order ?? '', note: note ?? '', now,
  });
  return { action: 'renew', ...r, machineCode: machine.machineCode, revocationEpoch: rev };
}

/** revoke: appends a revoke row; epoch = current rev + 1 so no issued key for the lid stays valid. */
export function revokeLicence({ auditPath, lid: rawLid, reason, note = '', order = '', now = new Date() }) {
  const lid = parseLid(rawLid);
  if (reason === undefined || String(reason).trim() === '') throw new CliError('Missing --reason refund|fraud.', 2);
  if (!REVOKE_REASONS.includes(reason)) throw new CliError('--reason must be refund or fraud.', 2);
  const rows = readAudit(auditPath);
  const st = licenceState(rows, lid);
  if (!st) throw new CliError(`No licence ${lid} in the audit log.`, 3);
  if (st.revoked) throw new CliError(`Licence ${lid} is already revoked.`, 3);
  const epoch = st.currentRev + 1;
  const last = st.latestKey ?? st.rows[st.rows.length - 1];
  appendAudit(auditPath, {
    timestamp_utc: isoSeconds(now), action: 'revoke', lid, kid: last.kid, rev: epoch, name: last.name, email: last.email, tier: last.tier,
    fp_hex: last.fp_hex, machine_code: last.machine_code, updates_until: last.updates_until, order_ref: order ?? '', reason, operator_note: note ?? '',
  });
  return { action: 'revoke', lid, epoch, reason };
}

/** Deterministic revoked.json bytes from the audit log (idempotent; §8.2). */
export function revocationListBytes(rows) {
  const entries = deriveRevocationEntries(rows);
  const tsList = (entries.length ? entries.map((e) => e.ts) : rows.map((r) => r.timestamp_utc)).sort();
  const generatedAt = tsList[tsList.length - 1] ?? '1970-01-01T00:00:00Z';
  const lines = entries.map((e) => `    ${JSON.stringify({ lid: e.lid, epoch: e.epoch, reason: e.reason })}`);
  const json = `{\n  "v": 1,\n  "generatedAt": ${JSON.stringify(generatedAt)},\n  "entries": [${lines.length ? `\n${lines.join(',\n')}\n  ` : ''}]\n}\n`;
  return { bytes: Buffer.from(json, 'utf8'), count: entries.length, generatedAt };
}

/** export-revocations: rebuild revoked.json from the audit log, sign it, write revoked.json + .sig. */
export function exportRevocations({ auditPath, out, loadKey }) {
  const rows = readAudit(auditPath);
  const key = loadKey();
  const { bytes, count, generatedAt } = revocationListBytes(rows);
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, bytes);
  writeFileSync(`${out}.sig`, signRevocationList(bytes, key));
  return { out, sig: `${out}.sig`, entries: count, generatedAt, kid: key.kid };
}
