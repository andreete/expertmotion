#!/usr/bin/env node
// expertmotion-license — Operator CLI (LICENSE_OPERATIONS.md §10). Offline only; never sends mail;
// never prints the private key. Private keys live in files OUTSIDE the repository.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { defaultAuditPath, licenceState, readAudit, REBIND_LIMIT, rebindsInLast12Months } from './lib/audit.mjs';
import { emailBody } from './lib/email.mjs';
import { CliError } from './lib/errors.mjs';
import { decodeMachineCode, emailHash, isoDate, isoSeconds } from './lib/format.mjs';
import { keygen, loadPrivateKey, loadPublicKeys } from './lib/keys.mjs';
import { enforceOffline } from './lib/net.mjs';
import {
  exportRevocations, issueLicence, machineFromCode, parseLid, rebindLicence, renewLicence, revocationListBytes, revokeLicence, signAndRecord,
} from './lib/ops.mjs';
import { verifyKey, verifyRevocationList } from './lib/token.mjs';

const HELP = `expertmotion-license — Operator CLI for Expertmotion Licence Keys (offline; LICENSE_OPERATIONS.md §10)

Usage: node tools/license-cli/src/cli.mjs <command> [options]

Commands
  keygen  --kid A1 --out <file> [--seal]
          Create a signing key pair; prints the public key hex for the app's key table.
          --seal encrypts the key file (passphrase from EXPERTMOTION_LICENSE_PASSPHRASE or --passphrase-file).
  issue   --name "<name>" --email <email> --fingerprint MC1-… [--tier standard|pro]
          [--updates-months 12] [--order ORD-…] [--override "<reason>"]
          Issue a key bound to ONE computer. The Creator's Machine Code is mandatory.
  rebind  --lid <ULID> --fingerprint MC1-… [--override "<reason>"]
          Move a licence to a new computer: same lid, new fingerprint, rev+1, old key revoked
          via revoked.json. Max ${REBIND_LIMIT} per rolling 12 months (EM-5008) unless --override.
  renew   --lid <ULID> [--updates-months 12] [--order ORD-…]
          Extend updatesUntil from max(old, today); rev+1; the previous key is revoked.
  revoke  --lid <ULID> --reason refund|fraud [--note "<text>"]
          Revoke every key issued for the lid (epoch = current rev + 1).
  verify  (--key EM1-… | --license-file <file.emlicense>) [--fingerprint MC1-…]
          [--revoked revoked.json] [--build-date YYYY-MM-DD] [--allow-network]
          Offline check (§6 steps 1-9 for the inputs given); prints the Payload and the EM- code.
  export-revocations [--out dist/revoked.json]
          Rebuild revoked.json from the audit log (idempotent), sign it, write revoked.json.sig.
  reissue (--all-active | --lid <ULID>) --kid B2
          Re-sign licences with a new key after rotation/compromise (rev+1), write an email batch.
  audit   (--lid <ULID> | --email <email>) [--allow-network]
          Print the audit history of a licence.

Common options
  --key-file <file>     signing key (or EXPERTMOTION_LICENSE_KEY_FILE); must be outside the repository
  --audit <file>        audit CSV (or EXPERTMOTION_LICENSE_AUDIT; default audit/licences.csv)
  --out-dir <dir>       where .emlicense files go (default out/)
  --lang en|id          language shown first in the email body (default en)
  --signature "<text>"  operator signature line for emails
  --public-keys <file>  verify: JSON [{kid, publicKeyHex, status}] (or --kid + --public-key <hex>)
  --json                machine-readable output
  --dev-allow-network   DEVELOPMENT/TESTS ONLY: run despite network interfaces being up
  -h, --help            this help

Exit codes: 0 ok, 1 key not valid (verify), 2 usage error, 3 refused by policy, 4 environment/key problem.
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  kid: { type: 'string' }, out: { type: 'string' }, seal: { type: 'boolean' }, 'passphrase-file': { type: 'string' },
  'key-file': { type: 'string' }, audit: { type: 'string' }, 'out-dir': { type: 'string' },
  name: { type: 'string' }, email: { type: 'string' }, tier: { type: 'string' }, fingerprint: { type: 'string' },
  'updates-months': { type: 'string' }, order: { type: 'string' }, lid: { type: 'string' }, override: { type: 'string' },
  reason: { type: 'string' }, note: { type: 'string' }, key: { type: 'string' }, 'license-file': { type: 'string' },
  'public-keys': { type: 'string' }, 'public-key': { type: 'string' }, revoked: { type: 'string' }, 'build-date': { type: 'string' },
  'all-active': { type: 'boolean' }, lang: { type: 'string' }, signature: { type: 'string' }, json: { type: 'boolean' },
  'allow-network': { type: 'boolean' }, 'dev-allow-network': { type: 'boolean' },
};

const print = (s) => process.stdout.write(`${s}\n`);

function req(opts, name, hint = '') {
  const v = opts[name];
  if (v === undefined || String(v).trim() === '') throw new CliError(`Missing --${name}${hint ? ` ${hint}` : ''}.`, 2);
  return String(v).trim();
}

const parseLidOpt = (opts) => parseLid(req(opts, 'lid'));
const files = (opts) => ({ auditPath: defaultAuditPath(opts), outDir: opts['out-dir'] ?? 'out' });

function report(opts, data, text) {
  if (opts.json) print(JSON.stringify(data, null, 2));
  else print(text);
}

function issueLike(opts, result, action) {
  const { payload, token, file } = result;
  const body = emailBody({
    name: payload.name, lid: payload.lid, key: token, machineCode: result.machineCode, updatesUntil: payload.upd,
    lang: opts.lang, updated: action !== 'issue', signature: opts.signature,
  });
  report(
    opts,
    { action, lid: payload.lid, rev: payload.rev, kid: token.split('-')[1], updatesUntil: payload.upd, file, key: token, revocationEpoch: result.revocationEpoch ?? null },
    [
      `${action}: lid ${payload.lid} rev ${payload.rev} → ${file}`,
      ...(result.revocationEpoch !== undefined
        ? [`Revocation entry {lid: ${payload.lid}, epoch: ${result.revocationEpoch}} recorded; run export-revocations and ship revoked.json so older keys stop working.`]
        : []),
      '',
      token,
      '',
      '--- email body ---',
      body,
    ].join('\n'),
  );
}

// ---------------- commands ----------------

function cmdKeygen(opts) {
  const r = keygen(opts);
  report(opts, r, [
    `Key ${r.kid} written to ${r.path}${r.sealed ? ' (sealed)' : ' (NOT sealed — development only; use --seal for production)'}.`,
    `Public key hex (set EM_LICENSE_PUBLIC_KEY_A1_HEX for kid A1, or EM_MANIFEST_PUBLIC_KEY_M1_HEX for kid M1, when building a release):`,
    r.publicKeyHex,
    `  { kid: '${r.kid}', publicKeyHex: '${r.publicKeyHex}', status: 'active', since: '${isoDate(new Date())}' },`,
  ].join('\n'));
}

function cmdIssue(opts) {
  machineFromCode(opts.fingerprint, 'issue'); // Machine Code is checked first (same order as before the ops refactor)
  const r = issueLicence({
    ...files(opts), loadKey: () => loadPrivateKey(opts), machineCode: opts.fingerprint, name: req(opts, 'name'), email: req(opts, 'email'),
    tier: opts.tier ?? 'standard', months: opts['updates-months'] ?? '12', order: opts.order ?? '', override: opts.override ?? '', note: opts.note ?? '',
  });
  issueLike(opts, r, 'issue');
}

function cmdRebind(opts) {
  const r = rebindLicence({
    ...files(opts), loadKey: () => loadPrivateKey(opts), lid: parseLidOpt(opts), machineCode: opts.fingerprint,
    override: opts.override ?? '', order: opts.order ?? '', note: opts.note,
  });
  issueLike(opts, r, 'rebind');
}

function cmdRenew(opts) {
  const r = renewLicence({
    ...files(opts), loadKey: () => loadPrivateKey(opts), lid: parseLidOpt(opts), months: opts['updates-months'] ?? '12',
    order: opts.order ?? '', note: opts.note ?? '',
  });
  issueLike(opts, r, 'renew');
}

function cmdRevoke(opts) {
  const lid = parseLidOpt(opts);
  const reason = req(opts, 'reason', 'refund|fraud');
  const r = revokeLicence({ auditPath: defaultAuditPath(opts), lid, reason, note: opts.note ?? '', order: opts.order ?? '' });
  report(opts, r, `revoke: ${r.lid} epoch ${r.epoch} (${r.reason}). Run export-revocations and publish revoked.json the same day.`);
}

function cmdVerify(opts) {
  let input = opts.key;
  if (!input && opts['license-file']) input = readFileSync(opts['license-file'], 'utf8');
  if (!input) throw new CliError('verify needs --key EM1-… or --license-file <file>.', 2);
  const keys = loadPublicKeys(opts);
  const ctx = { keys };
  if (opts.fingerprint) {
    const d = decodeMachineCode(opts.fingerprint);
    if (!d.ok) throw new CliError(d.reason === 'crc' ? 'Machine Code checksum mismatch (typo?).' : 'Invalid Machine Code.', 3);
    ctx.machine = d;
  }
  if (opts.revoked) {
    const sigPath = `${opts.revoked}.sig`;
    if (!existsSync(sigPath)) throw new CliError(`Missing signature file ${sigPath}.`, 4);
    const epochs = verifyRevocationList(readFileSync(opts.revoked), readFileSync(sigPath, 'utf8'), keys);
    if (!epochs) throw new CliError('revoked.json signature does not verify with the given public keys.', 4);
    ctx.revocations = epochs;
  }
  if (opts['build-date']) ctx.buildDate = opts['build-date'];
  const r = verifyKey(input, ctx);
  const data = {
    code: r.code, valid: r.valid, kid: r.kid ?? null, payload: r.payload ?? null,
    fingerprint: r.fingerprint ? { compared: r.fingerprint.compared, matched: r.fingerprint.matched } : null,
    checked: { signature: true, revocation: Boolean(ctx.revocations), fingerprint: Boolean(ctx.machine), buildDate: Boolean(ctx.buildDate) },
  };
  report(opts, data, [
    r.valid ? 'VALID' : `NOT VALID: ${r.code}`,
    r.payload ? JSON.stringify(r.payload, null, 2) : '',
    r.fingerprint ? `fingerprint components matched: ${r.fingerprint.matched} of ${r.fingerprint.compared}` : '(fingerprint not checked: pass --fingerprint MC1-…)',
  ].filter(Boolean).join('\n'));
  if (!r.valid) process.exitCode = 1;
}

export { revocationListBytes };

function cmdExportRevocations(opts) {
  const r = exportRevocations({ auditPath: defaultAuditPath(opts), out: opts.out ?? path.join('dist', 'revoked.json'), loadKey: () => loadPrivateKey(opts) });
  report(opts, r, `export-revocations: ${r.entries} entries, generatedAt ${r.generatedAt}, signed with ${r.kid} → ${r.out} (+ .sig)`);
}

function cmdReissue(opts) {
  const key = loadPrivateKey(opts);
  if (opts.kid && opts.kid !== key.kid) throw new CliError(`--kid ${opts.kid} does not match the key file's kid ${key.kid}.`, 2);
  const rows = readAudit(defaultAuditPath(opts));
  let lids;
  if (opts['all-active']) lids = [...new Set(rows.map((r) => r.lid))];
  else if (opts.lid) lids = [parseLidOpt(opts)];
  else throw new CliError('reissue needs --all-active or --lid.', 2);
  const now = new Date();
  const batch = [];
  const done = [];
  for (const lid of lids) {
    const st = licenceState(rows, lid);
    if (!st || !st.latestKey || st.revoked || st.latestKey.email === 'deleted') continue;
    const last = st.latestKey;
    const machine = decodeMachineCode(last.machine_code);
    if (!machine.ok) continue;
    const rev = st.currentRev + 1;
    const r = signAndRecord(files(opts), {
      action: 'reissue', key, lid, rev, name: last.name, email: last.email, tier: last.tier, machine, upd: last.updates_until, reason: 'keyrotation', note: opts.note ?? '', now,
    });
    batch.push(`To: ${last.email}\nAttachment: ${r.file}\n\n${emailBody({ name: last.name, lid, key: r.token, machineCode: machine.machineCode, updatesUntil: last.updates_until, lang: opts.lang, updated: true, signature: opts.signature })}`);
    done.push({ lid, rev, file: r.file });
  }
  const dir = opts['out-dir'] ?? 'out';
  mkdirSync(dir, { recursive: true });
  const batchFile = path.join(dir, `reissue-batch-${isoSeconds(now).replace(/[:]/g, '')}.txt`);
  writeFileSync(batchFile, batch.join('\n========================================\n\n'), { mode: 0o600 });
  report(opts, { action: 'reissue', kid: key.kid, count: done.length, licences: done, batchFile }, `reissue: ${done.length} licence(s) re-signed with ${key.kid}; email batch → ${batchFile}. Run export-revocations.`);
}

function cmdAudit(opts) {
  const rows = readAudit(defaultAuditPath(opts));
  let mine;
  if (opts.lid) mine = rows.filter((r) => r.lid === opts.lid.toUpperCase());
  else if (opts.email) {
    const target = emailHash(opts.email);
    mine = rows.filter((r) => r.email !== 'deleted' && emailHash(r.email) === target);
  } else throw new CliError('audit needs --lid or --email.', 2);
  const summary = opts.lid ? { rebindsLast12Months: rebindsInLast12Months(rows, opts.lid.toUpperCase(), new Date()), limit: REBIND_LIMIT } : {};
  report(opts, { rows: mine, ...summary }, [
    ...mine.map((r) => `${r.timestamp_utc}  ${r.action.padEnd(7)} ${r.lid} rev ${r.rev} kid ${r.kid} upd ${r.updates_until} ${r.reason}`),
    opts.lid ? `re-binds in the last 12 months: ${summary.rebindsLast12Months} of ${REBIND_LIMIT}` : '',
  ].filter(Boolean).join('\n') || '(no rows)');
}

const COMMANDS = {
  keygen: cmdKeygen, issue: cmdIssue, rebind: cmdRebind, renew: cmdRenew, revoke: cmdRevoke, verify: cmdVerify,
  'export-revocations': cmdExportRevocations, reissue: cmdReissue, audit: cmdAudit,
};

export function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\nRun with --help for usage.\n`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  const command = positionals[0];
  if (opts.help || !command) {
    process.stdout.write(HELP);
    return command || opts.help ? 0 : 2;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    process.stderr.write(`error: unknown command "${command}". Run with --help.\n`);
    return 2;
  }
  try {
    enforceOffline(command, opts);
    fn(opts);
    return process.exitCode ?? 0;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`error: ${e.message}\n`);
      return e.exitCode;
    }
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 4;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) process.exitCode = main(process.argv.slice(2));
