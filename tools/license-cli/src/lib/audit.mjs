// Append-only audit log (LICENSE_OPERATIONS.md §10.3) and revocation derivation (§8.2, §10.2).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const AUDIT_COLUMNS = [
  'timestamp_utc', 'action', 'lid', 'kid', 'rev', 'name', 'email', 'tier', 'fp_hex',
  'machine_code', 'updates_until', 'order_ref', 'reason', 'operator_note',
];
export const ACTIONS = ['issue', 'rebind', 'renew', 'revoke', 'refund', 'reissue'];
/** Actions that produce a new Licence Key. */
export const KEY_ACTIONS = new Set(['issue', 'rebind', 'renew', 'reissue']);
/** Revocation reason per action (§8.2 reasons). */
const REVOCATION_REASON = { rebind: 'rebind', renew: 'renewal', reissue: 'keyrotation' };

export const REBIND_LIMIT = 3;

export function defaultAuditPath(opts) {
  return opts.audit ?? process.env.EXPERTMOTION_LICENSE_AUDIT ?? path.join('audit', 'licences.csv');
}

// Spreadsheet formula-injection guard: storefront data is untrusted.
function escapeCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  s = s.replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return /[",]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}
function unescapeCell(s) {
  return /^'[=+\-@\t]/.test(s) ? s.slice(1) : s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(unescapeCell);
}

export function readAudit(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  if (header.join(',') !== AUDIT_COLUMNS.join(',')) throw new Error(`Audit log ${file} has unexpected columns.`);
  return lines.slice(1).map((l) => {
    const cells = parseCsvLine(l);
    const row = Object.fromEntries(AUDIT_COLUMNS.map((c, i) => [c, cells[i] ?? '']));
    row.rev = Number(row.rev);
    return row;
  });
}

export function appendAudit(file, row) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  if (!existsSync(file)) appendFileSync(file, `${AUDIT_COLUMNS.join(',')}\n`, { mode: 0o600 });
  appendFileSync(file, `${AUDIT_COLUMNS.map((c) => escapeCell(row[c])).join(',')}\n`);
}

export function rowsFor(rows, lid) {
  return rows.filter((r) => r.lid === lid);
}

/** State of one licence from its audit rows. */
export function licenceState(rows, lid) {
  const mine = rowsFor(rows, lid);
  if (mine.length === 0) return null;
  const keyRows = mine.filter((r) => KEY_ACTIONS.has(r.action));
  const latestKey = keyRows[keyRows.length - 1] ?? null;
  const currentRev = Math.max(...mine.map((r) => r.rev));
  const revoked = mine.some((r) => r.action === 'revoke');
  return { lid, rows: mine, latestKey, currentRev, revoked };
}

/** Re-binds of `lid` within the rolling 12 months before `now`. */
export function rebindsInLast12Months(rows, lid, now) {
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - 12);
  return rowsFor(rows, lid).filter((r) => r.action === 'rebind' && Date.parse(r.timestamp_utc) > since.getTime()).length;
}

/** Full revocation list from the audit log (idempotent): highest epoch per lid. */
export function deriveRevocationEntries(rows) {
  const byLid = new Map();
  for (const r of rows) {
    let reason = null;
    if (r.action === 'revoke') reason = r.reason === 'fraud' ? 'fraud' : 'refund';
    else if (REVOCATION_REASON[r.action]) reason = REVOCATION_REASON[r.action];
    if (!reason) continue;
    const prev = byLid.get(r.lid);
    if (!prev || r.rev >= prev.epoch) byLid.set(r.lid, { lid: r.lid, epoch: r.rev, reason, ts: r.timestamp_utc });
  }
  return [...byLid.values()].sort((a, b) => (a.lid < b.lid ? -1 : a.lid > b.lid ? 1 : 0));
}
