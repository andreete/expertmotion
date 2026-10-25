// Operator model mirror (Operator decision 2026-10-25: model files are served from the Operator's Cloudflare R2 CDN;
// DEPLOYMENT_AND_PACKAGING.md §16, LOCAL_AI_MODELS.md §4.5, SEC-071/SEC-072). Node ESM, no npm dependencies of its own:
// node:crypto (sha256, Ed25519) and tools/license-cli/src/lib/keys.mjs (sealed key files) only.
//
// prepare: downloads every `availability: 'download'` file from its upstream URL, streaming to `<out>/.partial/` while hashing
//          (never buffering a file in memory; HTTP Range resume), stores it as `<out>/m/<sha256>` (opaque object names) and writes
//          `<out>/models.json` (schema 1, seq = previous + 1) with CDN URLs `<cdn>/m/<sha256>`.
// sign:    writes `<out>/models.json.sig` = {"kid","sig"} (Ed25519 over the exact models.json bytes), as verifySignedRegistry expects.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';

export const MANIFEST_FILE = 'models.json';
export const SIG_FILE = 'models.json.sig';
export const STATE_FILE = '.mirror-state.json';
export const OBJECT_DIR = 'm';
export const FREE_TIER_BYTES = 10 * 1000 ** 3;            // Cloudflare R2 free tier: 10 GB storage (Operator decision 2026-10-25)
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export class MirrorError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

/** The CDN base URL must be https with a DNS host name, no credentials/port/query/fragment; returned without a trailing slash. */
export function normalizeCdn(raw) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { throw new MirrorError(`--cdn is not a URL: ${raw}`, 2); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port || !u.hostname.includes('.') || /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname))
    throw new MirrorError(`--cdn must be https://<host name>[/path] without credentials, port, query or fragment: ${raw}`, 2);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Hugging Face `https://huggingface.co/<owner>/<repo>/resolve/<rev>/<path>` → { repo, rev, path }, else null. */
export function parseHfUrl(url) {
  const m = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url);
  return m ? { repo: m[1], rev: m[2], path: m[3] } : null;
}
/** The upstream URL pinned to `rev` (Hugging Face URLs only; other hosts are returned unchanged). */
export function withRevision(url, rev) {
  const hf = parseHfUrl(url);
  return hf && rev ? `https://huggingface.co/${hf.repo}/resolve/${rev}/${hf.path}` : url;
}

/**
 * Which registry models are mirrored, and why the others are not. Rules: availability 'download' only; a listed file set is
 * required; licence.redistribution 'no' is never mirrored; 'verify' only with includeVerify (RISK-002: dataset licence unverified).
 */
export function selectModels(defs, { only = null, includeVerify = false } = {}) {
  const chosen = []; const skipped = [];
  for (const d of defs) {
    if (only && !only.includes(d.key)) continue;
    if (d.availability !== 'download') { skipped.push({ key: d.key, why: `availability is '${d.availability}', not 'download'${d.licence?.redistribution === 'no' ? `; licence "${d.licence.name}" does not allow redistribution` : ''}` }); continue; }
    if (!KEY_RE.test(d.key)) { skipped.push({ key: d.key, why: 'model key does not match the manifest schema' }); continue; }
    if (d.licence?.redistribution === 'no') { skipped.push({ key: d.key, why: `licence "${d.licence.name}" does not allow redistribution (redistribution: 'no'); Creators must fetch it from the vendor` }); continue; }
    if (d.licence?.redistribution === 'verify' && !includeVerify) { skipped.push({ key: d.key, why: `licence "${d.licence.name}" is not verified for redistribution (redistribution: 'verify'); pass --include-verify once the Operator has verified it` }); continue; }
    if (!Array.isArray(d.files) || d.files.length === 0) { skipped.push({ key: d.key, why: 'the registry lists no files for it yet (file list TO_PIN)' }); continue; }
    if (d.files.length > 16) { skipped.push({ key: d.key, why: 'more than 16 files (manifest schema limit)' }); continue; }
    const bad = d.files.find((f) => !SAFE_NAME.test(f.name));
    if (bad) { skipped.push({ key: d.key, why: `file name ${bad.name} is not a plain file name` }); continue; }
    chosen.push(d);
  }
  if (only) for (const k of only) if (!defs.some((d) => d.key === k)) skipped.push({ key: k, why: 'not in the registry' });
  return { chosen, skipped };
}

/** Revision for a file: `--revision` map by model key, then by Hugging Face repo (`owner/name`), else null. */
export function revisionFor(revisions, def, file) {
  if (!revisions) return null;
  if (typeof revisions[def.key] === 'string') return revisions[def.key];
  const hf = parseHfUrl(file.url);
  if (hf && typeof revisions[hf.repo] === 'string') return revisions[hf.repo];
  return null;
}

export async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return fallback; throw new MirrorError(`${p} is not valid JSON: ${e.message}`); }
}
async function writeJsonAtomic(p, value) {
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, p);
}
async function sizeOf(p) { try { return (await stat(p)).size; } catch { return -1; } }
async function hashExisting(p, hash) { for await (const c of createReadStream(p)) hash.update(c); return hash; }

const stateKey = (def, file) => `${def.key}/${file.name}`;

/**
 * Streams one upstream file to `<out>/.partial/<key>/<name>.part` (resuming with Range), hashing as it goes; then moves it to
 * `<out>/m/<sha256>`. Redirects are followed by hand (max 10, https only) so the Hugging Face `x-repo-commit` header of the first
 * hop can be recorded; once known, resumes use `resolve/<commit>/` so every byte comes from the same revision.
 */
export async function mirrorFile(def, file, { out, fetch, revision, hfToken = null, log = () => undefined, onProgress = () => undefined }) {
  const partDir = path.join(out, '.partial', def.key);
  const part = path.join(partDir, `${file.name}.part`);
  const meta = `${part}.json`;
  await mkdir(partDir, { recursive: true });
  const prior = await readJson(meta, null);
  let rev = revision ?? prior?.revision ?? null;
  let url = withRevision(file.url, rev);
  let have = await sizeOf(part);
  if (have < 0 || !prior || prior.upstream !== file.url || (revision && prior.revision && revision !== prior.revision)) { await rm(part, { force: true }); have = 0; }
  await writeJsonAtomic(meta, { upstream: file.url, revision: rev });

  let res;
  for (let hop = 0; ; hop++) {
    const headers = { 'Accept-Encoding': 'identity', 'User-Agent': 'expertmotion-model-mirror/1' };
    if (have > 0) headers.Range = `bytes=${have}-`;
    if (hfToken && new URL(url).hostname === 'huggingface.co') headers.Authorization = `Bearer ${hfToken}`;   // gated repos; never sent to redirect targets
    res = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
    const commit = res.headers.get('x-repo-commit');
    if (!rev && commit && COMMIT.test(commit)) {
      rev = commit;
      await writeJsonAtomic(meta, { upstream: file.url, revision: rev });
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc || hop >= 10) throw new MirrorError(`${def.key}/${file.name}: redirect without target or too many redirects`);
      const next = new URL(loc, url);
      if (next.protocol !== 'https:') throw new MirrorError(`${def.key}/${file.name}: refusing a non-https redirect to ${next.host}`);
      await res.body?.cancel?.().catch(() => undefined);
      url = next.toString();
      continue;
    }
    break;
  }
  const hasher = createHash('sha256');
  if (res.status === 416 && have > 0) { await res.body?.cancel?.().catch(() => undefined); await hashExisting(part, hasher); }   // the part is already complete
  else if (res.status === 200 || res.status === 206) {
    let append = false;
    if (res.status === 206) {
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '');
      if (!m || Number(m[1]) !== have) { await rm(part, { force: true }); throw new MirrorError(`${def.key}/${file.name}: unexpected Content-Range; partial removed, run prepare again`); }
      append = true;
      await hashExisting(part, hasher);                                          // resume: hash the bytes already on disk, then the stream
    } else have = 0;
    const ws = createWriteStream(part, { flags: append ? 'a' : 'w' });
    let done = have; let last = 0;
    try {
      if (res.body) {
        for await (const chunk of res.body) {
          hasher.update(chunk);
          if (!ws.write(chunk)) await once(ws, 'drain');
          done += chunk.byteLength;
          if (done - last >= 64 * 1024 * 1024) { last = done; onProgress({ key: def.key, file: file.name, bytesDone: done, bytesTotal: file.bytes }); }
        }
      }
    } finally {
      ws.end();
      await once(ws, 'close').catch(() => undefined);
    }
  } else {
    await res.body?.cancel?.().catch(() => undefined);
    throw new MirrorError(`${def.key}/${file.name}: upstream answered HTTP ${res.status} for ${url}`);
  }

  const sha256 = hasher.digest('hex');
  const bytes = await sizeOf(part);
  if (SHA.test(file.sha256 ?? '') && file.sha256 !== sha256) {
    await rm(part, { force: true });
    throw new MirrorError(`${def.key}/${file.name}: sha256 ${sha256} does not match the registry's pinned ${file.sha256}; partial removed`);
  }
  if (file.bytesExact && file.bytes !== bytes) throw new MirrorError(`${def.key}/${file.name}: ${bytes} bytes, the registry pins ${file.bytes}`);
  if (!file.bytesExact && file.bytes > 0 && Math.abs(bytes - file.bytes) / file.bytes > 0.15) log(`warning: ${def.key}/${file.name} is ${bytes} bytes; the registry estimate is ${file.bytes} (update registry.ts sizes)`);
  if (!rev) { rev = 'main'; log(`warning: ${def.key}/${file.name}: no revision known (no --revision entry and no x-repo-commit header); recorded as 'main'`); }
  await mkdir(path.join(out, OBJECT_DIR), { recursive: true });
  const dest = path.join(out, OBJECT_DIR, sha256);
  if ((await sizeOf(dest)) === bytes) await rm(part, { force: true }); else await rename(part, dest);
  await rm(meta, { force: true });
  return { name: file.name, bytes, sha256, revision: rev.slice(0, 80), upstream: file.url };
}

/**
 * prepare: mirrors every selected file (skipping those already complete in `<out>/.mirror-state.json` whose object exists with
 * the recorded size), then writes `<out>/models.json` and removes a stale `models.json.sig`. Returns a summary.
 */
export async function prepare({ defs, out, cdn, fetch, hfToken = null, revisions = null, only = null, includeVerify = false, seq = null, now = () => new Date(), log = console.log }) {
  const base = normalizeCdn(cdn);
  await mkdir(out, { recursive: true });
  const { chosen, skipped } = selectModels(defs, { only, includeVerify });
  for (const s of skipped) log(`skip ${s.key}: ${s.why}`);
  const statePath = path.join(out, STATE_FILE);
  const state = await readJson(statePath, { schema: 1, files: {} });
  const failed = [];
  for (const def of chosen) {
    for (const file of def.files) {
      const k = stateKey(def, file);
      const rec = state.files[k];
      const pinnedRev = revisionFor(revisions, def, file);
      if (rec && rec.upstream === file.url && (!pinnedRev || pinnedRev === rec.revision) && (await sizeOf(path.join(out, OBJECT_DIR, rec.sha256))) === rec.bytes) { log(`ok   ${k} (already mirrored, ${rec.sha256.slice(0, 12)}…)`); continue; }
      log(`get  ${k} ← ${withRevision(file.url, pinnedRev)}`);
      try {
        state.files[k] = await mirrorFile(def, file, { out, fetch, revision: pinnedRev, hfToken, log, onProgress: (p) => log(`     ${p.file}: ${(p.bytesDone / 1e6).toFixed(0)} / ${(p.bytesTotal / 1e6).toFixed(0)} MB`) });
        await writeJsonAtomic(statePath, state);
        log(`done ${k} → m/${state.files[k].sha256}`);
      } catch (e) {
        failed.push({ key: def.key, file: file.name, error: e.message });
        log(`FAIL ${k}: ${e.message} (the partial is kept; run prepare again to resume)`);
      }
    }
  }
  const manifestPath = path.join(out, MANIFEST_FILE);
  const previous = await readJson(manifestPath, null);
  const nextSeq = seq ?? (Number.isInteger(previous?.seq) ? previous.seq + 1 : 1);
  if (previous && Number.isInteger(previous.seq) && nextSeq <= previous.seq) throw new MirrorError(`--seq ${nextSeq} must be greater than the previous manifest's seq ${previous.seq}`, 2);
  const manifest = buildManifest({ defs: chosen, state, cdn: base, seq: nextSeq, issuedAt: now().toISOString() });
  await writeFile(`${manifestPath}.tmp-${process.pid}`, manifestBytes(manifest));
  await rename(`${manifestPath}.tmp-${process.pid}`, manifestPath);
  await rm(path.join(out, SIG_FILE), { force: true });
  const totalBytes = manifest.models.reduce((a, m) => a + m.files.reduce((b, f) => b + f.bytes, 0), 0);
  return { manifest, skipped, failed, totalBytes, overFreeTier: totalBytes > FREE_TIER_BYTES, manifestPath };
}

/** Manifest from the mirror state: models whose every file is mirrored, files in registry order, URL `<cdn>/m/<sha256>`. */
export function buildManifest({ defs, state, cdn, seq, issuedAt }) {
  if (!Number.isInteger(seq) || seq < 1) throw new MirrorError(`seq must be a positive integer (got ${seq})`, 2);
  const base = normalizeCdn(cdn);
  const models = [];
  for (const def of defs) {
    const recs = def.files.map((f) => state.files[stateKey(def, f)]);
    if (recs.some((r) => !r)) continue;
    models.push({ key: def.key, ...(def.version ? { version: String(def.version).slice(0, 40) } : {}),
      files: recs.map((r) => ({ name: r.name, bytes: r.bytes, sha256: r.sha256, url: `${base}/${OBJECT_DIR}/${r.sha256}`, revision: r.revision })) });
  }
  return { schema: 1, seq, issuedAt, models };
}
export const manifestBytes = (manifest) => Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const publicKeyHexOfSeed = (seed) => createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' }))
  .export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

/** {"kid","sig"} over the exact bytes (Ed25519, node:crypto); self-verified before it is returned. */
export function signManifestBytes(bytes, { kid, seed }) {
  if (!/^[A-Z0-9]{2}$/.test(kid)) throw new MirrorError(`kid must be two characters A-Z/0-9 (got ${kid})`, 2);
  if (!seed || seed.length !== 32) throw new MirrorError('the key file does not hold a 32-byte Ed25519 seed', 4);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const sig = edSign(null, bytes, key);
  const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHexOfSeed(seed), 'hex')]), format: 'der', type: 'spki' });
  if (!edVerify(null, bytes, pub, sig)) throw new MirrorError('self-verification of the new signature failed', 1);
  return { kid, sig: sig.toString('base64') };
}

/** Basic shape check before signing (the app's verifySignedRegistry is the authority; `verify` runs it when available). */
export function checkManifestShape(m) {
  const problems = [];
  if (m?.schema !== 1) problems.push('schema must be 1');
  if (!Number.isInteger(m?.seq) || m.seq < 1) problems.push('seq must be a positive integer');
  if (typeof m?.issuedAt !== 'string' || Number.isNaN(Date.parse(m.issuedAt))) problems.push('issuedAt must be an ISO date-time');
  if (!Array.isArray(m?.models) || m.models.length > 200) problems.push('models must be an array of at most 200');
  for (const x of m?.models ?? []) {
    if (!KEY_RE.test(x.key ?? '')) problems.push(`bad key ${x.key}`);
    for (const f of x.files ?? []) {
      if (!SAFE_NAME.test(f.name ?? '') || !SHA.test(f.sha256 ?? '') || !Number.isInteger(f.bytes) || f.bytes <= 0 || !String(f.url ?? '').startsWith('https://')) problems.push(`bad file entry in ${x.key}: ${f.name}`);
    }
    if (!x.files?.length || x.files.length > 16) problems.push(`${x.key}: 1…16 files required`);
  }
  if (!m?.models?.length) problems.push('the manifest lists no model (nothing was mirrored)');
  return problems;
}

/** sign: reads `<out>/models.json`, writes `<out>/models.json.sig`. `key` = { kid, seed } (from loadPrivateKey). */
export async function signDir({ out, key }) {
  const bytes = await readFile(path.join(out, MANIFEST_FILE)).catch(() => { throw new MirrorError(`${path.join(out, MANIFEST_FILE)} not found; run prepare first`, 2); });
  let m;
  try { m = JSON.parse(bytes.toString('utf8')); } catch { throw new MirrorError('models.json is not valid JSON', 1); }
  const problems = checkManifestShape(m);
  if (problems.length) throw new MirrorError(`models.json is not signable:\n  - ${problems.join('\n  - ')}`, 1);
  const env = signManifestBytes(bytes, key);
  await writeFile(path.join(out, SIG_FILE), `${JSON.stringify(env)}\n`);
  return { ...env, seq: m.seq, models: m.models.length, publicKeyHex: publicKeyHexOfSeed(key.seed) };
}
