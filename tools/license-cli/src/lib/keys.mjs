// Operator key handling. The private key is read ONLY from a file outside the repository
// (--key-file or EXPERTMOTION_LICENSE_KEY_FILE). It is never printed.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { CliError } from './errors.mjs';

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m) => new Uint8Array(createHash('sha512').update(ed.etc.concatBytes(...m)).digest());
}

export const KEY_FILE_FORMAT = 'expertmotion-license-private-key/1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `p` lies inside this repository (private keys must never live there, AGENTS.md rule 7). */
export function isInsideRepo(p) {
  const target = realOrResolved(p);
  const root = realOrResolved(REPO_ROOT);
  if (!existsSync(path.join(root, 'AGENTS.md'))) return false; // CLI copied out of the repo (offline machine)
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function validKid(kid) {
  return typeof kid === 'string' && /^[A-Z0-9]{2}$/.test(kid);
}

export function publicKeyHexFromSeed(seed) {
  return Buffer.from(ed.getPublicKey(seed)).toString('hex');
}

export function sign(message, seed) {
  return ed.sign(message, seed);
}

export function verify(signature, message, publicKeyHex) {
  try {
    return ed.verify(signature, message, Buffer.from(publicKeyHex, 'hex'), { zip215: false });
  } catch {
    return false;
  }
}

function seal(seed, passphrase) {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(seed), c.final()]);
  return {
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, saltHex: salt.toString('hex') },
    cipher: { name: 'aes-256-gcm', ivHex: iv.toString('hex'), tagHex: c.getAuthTag().toString('hex'), ctHex: ct.toString('hex') },
  };
}

function unseal(obj, passphrase) {
  const { kdf, cipher } = obj;
  if (kdf?.name !== 'scrypt' || cipher?.name !== 'aes-256-gcm') throw new CliError('Unsupported sealed key format.', 4);
  const key = scryptSync(passphrase, Buffer.from(kdf.saltHex, 'hex'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem * 2 });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(cipher.ivHex, 'hex'));
  d.setAuthTag(Buffer.from(cipher.tagHex, 'hex'));
  try {
    return new Uint8Array(Buffer.concat([d.update(Buffer.from(cipher.ctHex, 'hex')), d.final()]));
  } catch {
    throw new CliError('Wrong passphrase or corrupted sealed key file.', 4);
  }
}

function readPassphrase(opts) {
  if (opts['passphrase-file']) return readFileSync(opts['passphrase-file'], 'utf8').replace(/\r?\n$/, '');
  if (process.env.EXPERTMOTION_LICENSE_PASSPHRASE) return process.env.EXPERTMOTION_LICENSE_PASSPHRASE;
  return null;
}

/** keygen: writes a new key file (mode 0600) outside the repo; returns {kid, publicKeyHex, path}. */
export function keygen(opts) {
  const kid = opts.kid;
  if (!validKid(kid)) throw new CliError('--kid must be two characters A-Z/0-9, e.g. A1.', 2);
  const out = opts.out ?? process.env.EXPERTMOTION_LICENSE_KEY_FILE;
  if (!out) throw new CliError('keygen needs --out <path> (outside the repository) for the private key file.', 2);
  if (isInsideRepo(out)) throw new CliError(`Refusing to write a private key inside the repository (${out}).`, 4);
  if (existsSync(out)) throw new CliError(`Refusing to overwrite existing key file ${out}.`, 4);
  const seed = ed.utils.randomPrivateKey();
  const publicKeyHex = publicKeyHexFromSeed(seed);
  let file = { format: KEY_FILE_FORMAT, kid, publicKeyHex, createdAt: new Date().toISOString(), sealed: false };
  if (opts.seal) {
    const pass = readPassphrase(opts);
    if (!pass || pass.length < 12) throw new CliError('--seal needs a passphrase of at least 12 characters (EXPERTMOTION_LICENSE_PASSPHRASE or --passphrase-file).', 2);
    file = { ...file, sealed: true, ...seal(seed, pass) };
  } else {
    file = { ...file, seedHex: Buffer.from(seed).toString('hex') };
  }
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { kid, publicKeyHex, path: out, sealed: file.sealed };
}

/** Load the signing key. Returns {kid, seed, publicKeyHex}. */
export function loadPrivateKey(opts) {
  const p = opts['key-file'] ?? process.env.EXPERTMOTION_LICENSE_KEY_FILE;
  if (!p) throw new CliError('No signing key: pass --key-file <path> or set EXPERTMOTION_LICENSE_KEY_FILE (a file outside the repository).', 4);
  const devFixture = path.basename(p).includes('DEV-ONLY') && realOrResolved(p).startsWith(path.join(realOrResolved(REPO_ROOT), 'tools', 'license-cli', 'test', 'fixtures') + path.sep);
  if (isInsideRepo(p) && !devFixture) {
    throw new CliError(`Refusing to use a private key stored inside the repository (${p}).`, 4);
  }
  if (!existsSync(p)) throw new CliError(`Key file not found: ${p}`, 4);
  if (process.platform !== 'win32' && (statSync(p).mode & 0o077) !== 0) {
    process.stderr.write(`warning: key file ${p} is readable by group/others; chmod 600 it.\n`);
  }
  let obj;
  try {
    obj = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new CliError(`Key file ${p} is not valid JSON.`, 4);
  }
  if (obj.format !== KEY_FILE_FORMAT || !validKid(obj.kid)) throw new CliError(`Key file ${p} has an unknown format.`, 4);
  let seed;
  if (obj.sealed) {
    const pass = readPassphrase(opts);
    if (!pass) throw new CliError('Sealed key: provide EXPERTMOTION_LICENSE_PASSPHRASE or --passphrase-file.', 4);
    seed = unseal(obj, pass);
  } else {
    seed = new Uint8Array(Buffer.from(String(obj.seedHex ?? ''), 'hex'));
  }
  if (seed.length !== 32) throw new CliError('Key file does not contain a 32-byte Ed25519 seed.', 4);
  const publicKeyHex = publicKeyHexFromSeed(seed);
  if (obj.publicKeyHex && obj.publicKeyHex !== publicKeyHex) throw new CliError('Key file public key does not match its private key.', 4);
  return { kid: obj.kid, seed, publicKeyHex };
}

/**
 * Public key table for `verify`: --public-keys <json [{kid, publicKeyHex, status}]>,
 * or --kid + --public-key <hex>, or derived from --key-file.
 */
export function loadPublicKeys(opts) {
  if (opts['public-keys']) {
    const arr = JSON.parse(readFileSync(opts['public-keys'], 'utf8'));
    if (!Array.isArray(arr)) throw new CliError('--public-keys must be a JSON array of {kid, publicKeyHex, status}.', 2);
    return arr.filter((e) => validKid(e.kid) && /^[0-9a-f]{64}$/.test(e.publicKeyHex));
  }
  if (opts['public-key']) {
    if (!validKid(opts.kid) || !/^[0-9a-f]{64}$/.test(opts['public-key'])) throw new CliError('--public-key needs 64 hex chars and --kid.', 2);
    return [{ kid: opts.kid, publicKeyHex: opts['public-key'], status: 'active' }];
  }
  if (opts['key-file'] || process.env.EXPERTMOTION_LICENSE_KEY_FILE) {
    const k = loadPrivateKey(opts);
    return [{ kid: k.kid, publicKeyHex: k.publicKeyHex, status: 'active' }];
  }
  throw new CliError('verify needs --public-keys <file>, --kid + --public-key <hex>, or --key-file.', 2);
}
