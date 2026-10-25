/**
 * Main-process handlers of Expertmotion License Admin (LICENSE_OPERATIONS.md §10.5). Electron-free so
 * they are unit-tested directly; main.ts only wires them to ipcMain and supplies the platform
 * functions (dialogs, clipboard, reveal in folder).
 *
 * Every request goes through `invoke`: argument validation (validate.ts) → network policy → handler →
 * {ok:true, result} | {ok:false, error}. Paths coming from the renderer are accepted only when main
 * produced them itself (a dialog result or a file this app wrote), so a compromised renderer cannot
 * make main write a key or read a file at an arbitrary location.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Channel } from './channels.js';
import { AdminError, toWireError, type WireError } from './errors.js';
import {
  decodeMachineCode, emailBody, exportRevocations, groupKey, isoDate, issueLicence, KEY_FILE_FORMAT, keygen, licenceState,
  loadPrivateKey, readAudit, REBIND_LIMIT, rebindLicence, rebindsInLast12Months, renewLicence, revokeLicence, upInterfaces,
  verifyKey, verifyRevocationList, type KeyOpResult, type Machine, type PublicKey,
} from './license-lib.js';
import { isDirectory, keyLocationProblem, workspacePaths } from './paths.js';
import { createKeySession, DEFAULT_IDLE_MS, type LockReason, type SigningKey } from './session.js';
import { loadSettings, saveSettings, type Settings } from './settings.js';
import { MIN_PASSPHRASE } from './strength.js';
import { validateArgs } from './validate.js';

export interface Platform {
  pickFolder(purpose: 'keyFolder' | 'workspace' | 'export'): Promise<string | null>;
  pickKeyFile(): Promise<string | null>;
  writeClipboard(text: string): void;
  showInFolder(p: string): void;
}

export interface AdminDeps {
  settingsFile: string;
  defaultWorkspace: string;
  idleMs?: number;
  now?: () => Date;
  /** names of non-loopback interfaces that are up (default: the CLI's upInterfaces) */
  upInterfaces?: () => string[];
  onLock?: (reason: LockReason) => void;
}

export type InvokeResult = { ok: true; result: unknown } | { ok: false; error: WireError };

type Args = Record<string, unknown>;
type Lang = 'en' | 'id';

/** Commands that hold or use the private key: refused while online under the strict policy (§10.2). */
const SIGNING: ReadonlySet<Channel> = new Set<Channel>([
  'em-admin:key.create', 'em-admin:key.open', 'em-admin:licence.issue', 'em-admin:licence.rebind', 'em-admin:licence.renew',
  'em-admin:licence.revoke', 'em-admin:revocations.export',
]);

export interface MachineCodeCheck {
  ok: boolean;
  reason?: 'empty' | 'format' | 'crc' | 'components';
  message: string;
  machineCode?: string;
  readableComponents?: number;
}

/** Live Machine Code check for the Issue/Rebind forms (same decoder as the CLI). */
export function checkMachineCode(input: string): MachineCodeCheck {
  if (input.trim() === '') return { ok: false, reason: 'empty', message: 'Paste the Machine Code from the Creator (Help > Licence > Copy).' };
  const d = decodeMachineCode(input);
  if (!d.ok) {
    return d.reason === 'crc'
      ? { ok: false, reason: 'crc', message: 'Checksum does not match: probably a typo. Ask the Creator to copy it again with the Copy button.' }
      : { ok: false, reason: 'format', message: 'Not a Machine Code (expected MC1- followed by 42 characters).' };
  }
  const readable = d.present.filter(Boolean).length;
  if (readable < 2) return { ok: false, reason: 'components', readableComponents: readable, machineCode: d.machineCode, message: 'Fewer than two readable components: a key bound to it could never verify. Ask the Creator for diagnostics.' };
  return { ok: true, machineCode: d.machineCode, readableComponents: readable, message: `Valid Machine Code (${readable} of 3 components readable).` };
}

export function createAdmin(deps: AdminDeps) {
  const now = deps.now ?? (() => new Date());
  const ifaces = deps.upInterfaces ?? upInterfaces;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const session = createKeySession({ idleMs, now: () => now().getTime(), ...(deps.onLock ? { onLock: deps.onLock } : {}) });
  let settings: Settings = loadSettings(deps.settingsFile, deps.defaultWorkspace);
  const approved = new Set<string>();
  // the last key file opened here (main wrote it to settings itself) can be reopened without browsing
  if (settings.lastKeyFile) approved.add(path.resolve(settings.lastKeyFile));

  const persist = (): void => saveSettings(deps.settingsFile, settings);
  const approve = (p: string): string => {
    const r = path.resolve(p);
    approved.add(r);
    return r;
  };
  const requireApproved = (p: unknown, what: string): string => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !approved.has(path.resolve(p))) {
      throw new AdminError('PATH', `${what}: choose it with the Browse button.`);
    }
    return path.resolve(p);
  };
  const ws = () => workspacePaths(settings.workspaceDir);
  const loadKey = (): SigningKey => session.require();
  const lang = (a: Args): Lang => (a.lang === 'id' || a.lang === 'en' ? a.lang : settings.lang);

  const network = () => {
    const up = ifaces();
    return { up, online: up.length > 0, policy: settings.networkPolicy };
  };
  const guardNetwork = (channel: Channel): void => {
    if (!SIGNING.has(channel)) return; // verify/list/history are read-only (the CLI's --allow-network case)
    const n = network();
    if (n.online && n.policy === 'strict') {
      throw new AdminError(
        'NETWORK',
        `Refused: network interface(s) up (${n.up.join(', ')}). Disconnect this computer (Wi-Fi off, cable out), or switch Settings > Network policy to "Warn only" if you accept signing on an online PC.`,
      );
    }
  };

  const rememberKey = (kid: string, publicKeyHex: string, file: string): void => {
    settings.knownKeys = [{ kid, publicKeyHex, file }, ...settings.knownKeys.filter((k) => !(k.kid === kid && k.publicKeyHex === publicKeyHex))].slice(0, 20);
    settings.lastKeyFile = file;
    persist();
  };

  const keyResult = (r: KeyOpResult, action: string, l: Lang) => {
    approve(r.file);
    return {
      action, lid: r.payload.lid, rev: r.payload.rev, kid: r.token.split('-')[1], updatesUntil: r.payload.upd, file: r.file, key: r.token,
      keyGrouped: groupKey(r.token), machineCode: r.machineCode, revocationEpoch: r.revocationEpoch ?? null,
      emailText: emailBody({ name: r.payload.name, lid: r.payload.lid, key: r.token, machineCode: r.machineCode, updatesUntil: r.payload.upd, lang: l, updated: action !== 'issue', signature: settings.signature }),
    };
  };

  const summaries = (query: string) => {
    const rows = readAudit(ws().auditPath);
    const q = query.trim().toLowerCase();
    const lids = [...new Set(rows.map((r) => r.lid))];
    const t = now();
    const list = lids.map((lid) => {
      const st = licenceState(rows, lid)!;
      const latest = st.latestKey ?? st.rows[st.rows.length - 1]!;
      const lastRow = st.rows[st.rows.length - 1]!;
      return {
        lid, name: latest.name, email: latest.email, tier: latest.tier, kid: latest.kid, rev: st.currentRev,
        machineCode: latest.machine_code, updatesUntil: latest.updates_until, orderRef: (st.rows.find((r) => r.order_ref) ?? latest).order_ref,
        status: st.revoked ? 'revoked' : 'active', lastAction: lastRow.action, lastTimestamp: lastRow.timestamp_utc,
        rebindsLast12Months: rebindsInLast12Months(rows, lid, t), rebindLimit: REBIND_LIMIT,
        _search: st.rows.map((r) => [r.lid, r.name, r.email, r.order_ref, r.machine_code].join(' ')).join(' ').toLowerCase(),
      };
    });
    return list
      .filter((s) => q === '' || s._search.includes(q))
      .map(({ _search, ...s }) => s)
      .sort((a, b) => (a.lastTimestamp < b.lastTimestamp ? 1 : a.lastTimestamp > b.lastTimestamp ? -1 : 0));
  };

  const publicKeys = () => {
    const st = session.status();
    const list: PublicKey[] = settings.knownKeys.map((k) => ({ kid: k.kid, publicKeyHex: k.publicKeyHex, status: 'active' }));
    if (st.unlocked && st.kid && st.publicKeyHex && !list.some((k) => k.kid === st.kid && k.publicKeyHex === st.publicKeyHex)) {
      list.unshift({ kid: st.kid, publicKeyHex: st.publicKeyHex, status: 'active' });
    }
    return list;
  };

  const handlers: Record<Channel, (a: Args, p: Platform) => unknown> = {
    'em-admin:state.get': () => ({
      key: session.status(),
      idleMs,
      network: network(),
      settings: { workspaceDir: settings.workspaceDir, networkPolicy: settings.networkPolicy, signature: settings.signature, lang: settings.lang, lastKeyFile: settings.lastKeyFile, knownKeys: settings.knownKeys },
      paths: ws(),
    }),
    'em-admin:activity.touch': () => {
      session.touch();
      return { ok: true };
    },
    'em-admin:settings.update': (a) => {
      if (a.workspaceDir !== undefined) {
        const d = requireApproved(a.workspaceDir, 'Workspace folder');
        if (!isDirectory(d)) throw new AdminError('PATH', 'Workspace folder does not exist.');
        settings.workspaceDir = d;
      }
      if (a.networkPolicy === 'strict' || a.networkPolicy === 'warn') settings.networkPolicy = a.networkPolicy;
      if (typeof a.signature === 'string') settings.signature = a.signature.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Expertmotion Support';
      if (a.lang === 'en' || a.lang === 'id') settings.lang = a.lang;
      persist();
      return { saved: true };
    },
    'em-admin:dialog.pickFolder': async (a, p) => {
      const r = await p.pickFolder(a.purpose as 'keyFolder' | 'workspace' | 'export');
      return r ? approve(r) : null;
    },
    'em-admin:dialog.pickKeyFile': async (_a, p) => {
      const r = await p.pickKeyFile();
      return r ? approve(r) : null;
    },
    'em-admin:dialog.openPath': (a, p) => {
      p.showInFolder(requireApproved(a.path, 'File'));
      return { shown: true };
    },
    'em-admin:clipboard.write': (a, p) => {
      p.writeClipboard(a.text as string);
      return { copied: true };
    },
    'em-admin:key.create': (a) => {
      const folder = requireApproved(a.folder, 'Key folder');
      if (!isDirectory(folder)) throw new AdminError('PATH', 'Key folder does not exist.');
      const problem = keyLocationProblem(folder);
      if (problem) throw new AdminError('PATH', problem);
      const pass = a.passphrase as string;
      if (pass !== a.passphraseConfirm) throw new AdminError('PASSPHRASE', 'The two passphrases do not match.');
      if ([...pass].length < MIN_PASSPHRASE) throw new AdminError('PASSPHRASE', `The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
      const kid = a.kid as string;
      const out = path.join(folder, `expertmotion-signing-key-${kid}.json`);
      keygen({ kid, out, seal: true, passphrase: pass });
      const key: SigningKey = loadPrivateKey({ 'key-file': out, passphrase: pass });
      session.unlock(key, out);
      approve(out);
      rememberKey(key.kid, key.publicKeyHex, out);
      return {
        kid: key.kid, publicKeyHex: key.publicKeyHex, file: out,
        keyTableEntry: `{ kid: '${key.kid}', publicKeyHex: '${key.publicKeyHex}', status: 'active', since: '${isoDate(now())}' },`,
      };
    },
    'em-admin:key.open': (a) => {
      const file = requireApproved(a.file, 'Key file');
      const problem = keyLocationProblem(path.dirname(file));
      if (problem) throw new AdminError('PATH', problem);
      let meta: { format?: unknown; sealed?: unknown };
      try {
        meta = JSON.parse(readFileSync(file, 'utf8')) as typeof meta;
      } catch {
        throw new AdminError('ENV', 'This file is not an Expertmotion signing key file.');
      }
      if (meta.format !== KEY_FILE_FORMAT) throw new AdminError('ENV', 'This file is not an Expertmotion signing key file.');
      if (meta.sealed !== true) throw new AdminError('POLICY', 'This key file is not sealed (a development key). The admin app opens sealed keys only; create a sealed key under Keys.');
      if (a.passphrase === '') throw new AdminError('PASSPHRASE', 'Enter the passphrase of this key file.');
      let key: SigningKey;
      try {
        key = loadPrivateKey({ 'key-file': file, passphrase: a.passphrase as string });
      } catch (e) {
        if (e instanceof Error && /passphrase/i.test(e.message)) throw new AdminError('PASSPHRASE', 'Wrong passphrase, or the key file is damaged.');
        throw e;
      }
      session.unlock(key, file);
      rememberKey(key.kid, key.publicKeyHex, file);
      return { kid: key.kid, publicKeyHex: key.publicKeyHex, file };
    },
    'em-admin:key.lock': () => {
      session.lock('manual');
      return { locked: true };
    },
    'em-admin:machineCode.check': (a) => checkMachineCode(a.machineCode as string),
    'em-admin:licence.issue': (a) => {
      const r = issueLicence({
        ...ws(), loadKey, name: a.name as string, email: a.email as string, tier: (a.tier as string | undefined) ?? 'standard', machineCode: a.machineCode as string,
        months: String(a.updatesMonths), order: (a.orderId as string | undefined) ?? '', override: (a.override as string | undefined) ?? '', note: '', now: now(),
      });
      return keyResult(r, 'issue', lang(a));
    },
    'em-admin:licence.list': (a) => ({ licences: summaries((a.query as string | undefined) ?? ''), auditPath: ws().auditPath }),
    'em-admin:licence.history': (a) => {
      const lid = (a.lid as string).toUpperCase();
      return { lid, rows: readAudit(ws().auditPath).filter((r) => r.lid === lid) };
    },
    'em-admin:licence.rebind': (a) => {
      const r = rebindLicence({ ...ws(), loadKey, lid: a.lid as string, machineCode: a.machineCode as string, override: (a.override as string | undefined) ?? '', order: '', now: now() });
      return keyResult(r, 'rebind', lang(a));
    },
    'em-admin:licence.renew': (a) => {
      const r = renewLicence({ ...ws(), loadKey, lid: a.lid as string, months: String(a.updatesMonths), order: (a.orderId as string | undefined) ?? '', note: '', now: now() });
      return keyResult(r, 'renew', lang(a));
    },
    'em-admin:licence.revoke': (a) => {
      session.require(); // revoking is an Operator action: require the unlocked key like the other mutations
      return revokeLicence({ auditPath: ws().auditPath, lid: a.lid as string, reason: a.reason as string, note: (a.note as string | undefined) ?? '', order: '', now: now() });
    },
    'em-admin:revocations.export': (a) => {
      const dir = a.folder === undefined ? ws().distDir : requireApproved(a.folder, 'Export folder');
      const r = exportRevocations({ auditPath: ws().auditPath, out: path.join(dir, 'revoked.json'), loadKey });
      approve(r.out);
      approve(r.sig);
      return r;
    },
    'em-admin:licence.verify': (a) => {
      const keys = publicKeys();
      if (keys.length === 0) throw new AdminError('ENV', 'No public key known yet: open or create the signing key once under Keys.');
      const ctx: { keys: PublicKey[]; machine?: Machine; revocations?: Map<string, number> } = { keys };
      const mc = typeof a.machineCode === 'string' ? a.machineCode.trim() : '';
      if (mc !== '') {
        const c = checkMachineCode(mc);
        if (!c.ok && c.reason !== 'components') throw new AdminError('EINVAL', `Machine Code: ${c.message}`);
        const d = decodeMachineCode(mc);
        if (d.ok) ctx.machine = d;
      }
      const { revokedPath } = ws();
      let revocation: { checked: boolean; file: string; note: string } = { checked: false, file: revokedPath, note: 'No revoked.json in the workspace yet (export it under Licences).' };
      if (existsSync(revokedPath) && existsSync(`${revokedPath}.sig`)) {
        const epochs = verifyRevocationList(readFileSync(revokedPath), readFileSync(`${revokedPath}.sig`, 'utf8'), keys);
        revocation = epochs
          ? { checked: true, file: revokedPath, note: 'Checked against the workspace revoked.json.' }
          : { checked: false, file: revokedPath, note: 'The workspace revoked.json signature does not verify with the known public keys; revocation not checked.' };
        if (epochs) ctx.revocations = epochs;
      }
      const r = verifyKey(a.key as string, ctx);
      return {
        valid: r.valid, code: r.code, kid: r.kid ?? null, payload: r.payload ?? null,
        fingerprint: r.fingerprint ? { compared: r.fingerprint.compared, matched: r.fingerprint.matched } : null,
        checked: { signature: true, fingerprint: Boolean(ctx.machine), revocation: revocation.checked },
        revocation,
      };
    },
  };

  return {
    session,
    /** used by main for dialog results it produced itself (and by tests) */
    approvePath: approve,
    /** validate → network policy → handler; never throws */
    async invoke(channel: unknown, rawArgs: unknown, platform: Platform): Promise<InvokeResult> {
      try {
        const args = validateArgs(channel, rawArgs);
        const ch = channel as Channel;
        guardNetwork(ch);
        const result = await handlers[ch](args, platform);
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: toWireError(e) };
      }
    },
  };
}

export type Admin = ReturnType<typeof createAdmin>;
