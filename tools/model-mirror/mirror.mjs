#!/usr/bin/env node
// expertmotion model mirror — Operator tool (DEPLOYMENT_AND_PACKAGING.md §16). Never shipped to Creators.
//   node tools/model-mirror/mirror.mjs prepare --out <dir> --cdn https://models.<domain> [--revision <map.json>] [--only k1,k2] [--include-verify] [--seq N] [--registry <defs.json>]
//   node tools/model-mirror/mirror.mjs sign    --out <dir> --key <sealed key file> [--passphrase-file <file>]
//   node tools/model-mirror/mirror.mjs verify  --out <dir> [--public-key <hex> --kid M1]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MirrorError, FREE_TIER_BYTES, MANIFEST_FILE, SIG_FILE, prepare, signDir } from './lib/mirror-lib.mjs';

const HELP = `expertmotion model mirror — mirrors the downloadable Local Models to the Operator's CDN (Cloudflare R2)

  prepare --out <dir> --cdn <https base URL>
          [--revision <file.json>]   {"<model key>" | "<hf owner/repo>": "<40-hex commit>"}; otherwise the x-repo-commit
                                     response header of Hugging Face is recorded
          [--only key1,key2]         mirror only these models (the full set exceeds the R2 free tier)
          [--include-verify]         also mirror models whose licence.redistribution is 'verify' (after the Operator verified it)
          [--seq N]                  manifest sequence (default: previous models.json seq + 1, or 1)
          [--registry <defs.json>]   registry rows as JSON (default: @expertmotion/models, built by \`npm run typecheck\`)
          HF_TOKEN (env, optional)   Hugging Face token for gated repos; sent to huggingface.co only
  sign    --out <dir> --key <key file> [--passphrase-file <file>]
          key file = expertmotion-license-private-key/1 (create with: node tools/license-cli/src/cli.mjs keygen --kid M1 --seal --out <path outside the repo>);
          passphrase from --passphrase-file or EXPERTMOTION_LICENSE_PASSPHRASE
  verify  --out <dir> [--kid M1 --public-key <64 hex>]   checks models.json + .sig with the app's verifySignedRegistry
          (default keys: the manifest key table compiled into @expertmotion/models)

Output layout (upload all of it except dot-files): <dir>/m/<sha256>, <dir>/models.json, <dir>/models.json.sig`;

const opts = {
  out: { type: 'string' }, cdn: { type: 'string' }, revision: { type: 'string' }, only: { type: 'string' }, 'include-verify': { type: 'boolean' },
  seq: { type: 'string' }, registry: { type: 'string' }, key: { type: 'string' }, 'passphrase-file': { type: 'string' }, kid: { type: 'string' },
  'public-key': { type: 'string' }, help: { type: 'boolean', short: 'h' },
};

async function loadModels() {
  try { return await import('@expertmotion/models'); } catch (e) {
    throw new MirrorError(`cannot load @expertmotion/models (${e.message.split('\n')[0]}); run \`npm run typecheck\` (builds packages/models/dist) or pass --registry <defs.json>`, 4);
  }
}

async function cmdPrepare(v) {
  if (!v.out || !v.cdn) throw new MirrorError('prepare needs --out <dir> and --cdn <https base URL>', 2);
  const defs = v.registry ? JSON.parse(readFileSync(v.registry, 'utf8')) : Object.values((await loadModels()).registry);
  if (!Array.isArray(defs)) throw new MirrorError('--registry must be a JSON array of registry rows', 2);
  const revisions = v.revision ? JSON.parse(readFileSync(v.revision, 'utf8')) : null;
  for (const [k, rev] of Object.entries(revisions ?? {})) if (!/^[0-9a-f]{40}$/.test(String(rev))) throw new MirrorError(`--revision: ${k} must map to a 40-hex commit sha`, 2);
  const seq = v.seq === undefined ? null : Number(v.seq);
  if (seq !== null && (!Number.isInteger(seq) || seq < 1)) throw new MirrorError('--seq must be a positive integer', 2);
  const only = v.only ? v.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const r = await prepare({ defs, out: path.resolve(v.out), cdn: v.cdn, fetch: globalThis.fetch, hfToken: process.env.HF_TOKEN || null, revisions, only, includeVerify: !!v['include-verify'], seq });
  const gb = (b) => (b / 1e9).toFixed(2);
  console.log(`\nmodels.json: seq ${r.manifest.seq}, ${r.manifest.models.length} model(s), ${gb(r.totalBytes)} GB → ${r.manifestPath}`);
  for (const m of r.manifest.models) console.log(`  ${m.key.padEnd(26)} ${gb(m.files.reduce((a, f) => a + f.bytes, 0)).padStart(7)} GB  ${m.files.map((f) => `${f.name}@${f.revision.slice(0, 10)}`).join(', ')}`);
  if (r.overFreeTier) console.warn(`warning: ${gb(r.totalBytes)} GB exceeds the R2 free tier (${gb(FREE_TIER_BYTES)} GB); use --only or accept paid storage.`);
  if (r.failed.length) { console.error(`${r.failed.length} file(s) failed (left out of models.json; run prepare again to resume):`); for (const f of r.failed) console.error(`  ${f.key}/${f.file}: ${f.error}`); return 1; }
  console.log(`next: node tools/model-mirror/mirror.mjs sign --out ${v.out} --key <manifest key file>`);
  return 0;
}

async function cmdSign(v) {
  if (!v.out || !v.key) throw new MirrorError('sign needs --out <dir> and --key <key file>', 2);
  const { loadPrivateKey } = await import('../license-cli/src/lib/keys.mjs');           // sealed key handling (scrypt + AES-256-GCM), refuses keys inside the repo
  let key;
  try { key = loadPrivateKey({ 'key-file': v.key, ...(v['passphrase-file'] ? { 'passphrase-file': v['passphrase-file'] } : {}) }); }
  catch (e) { throw new MirrorError(e.message, e.exitCode ?? 4); }
  const r = await signDir({ out: path.resolve(v.out), key });
  console.log(`${SIG_FILE}: kid ${r.kid}, seq ${r.seq}, ${r.models} model(s); public key ${r.publicKeyHex}`);
  try {
    const { embeddedManifestKeys } = await loadModels();
    const match = embeddedManifestKeys().find((k) => k.kid === r.kid && k.publicKeyHex === r.publicKeyHex);
    if (!match) console.warn(`warning: kid ${r.kid} / this public key is not in MANIFEST_KEY_TABLE (packages/models/src/signed-registry.ts) of this checkout; apps built from it will refuse the manifest (unknown-kid / bad-signature / no-keys).`);
  } catch { /* registry package not built: skip the cross-check */ }
  return 0;
}

async function cmdVerify(v) {
  if (!v.out) throw new MirrorError('verify needs --out <dir>', 2);
  const { verifySignedRegistry } = await loadModels();
  const bytes = readFileSync(path.join(v.out, MANIFEST_FILE));
  const sig = readFileSync(path.join(v.out, SIG_FILE), 'utf8');
  const keys = v['public-key'] ? [{ kid: v.kid ?? 'M1', publicKeyHex: v['public-key'], status: 'active', since: '' }] : undefined;
  const r = verifySignedRegistry(bytes, sig, keys ? { keys } : {});
  if (!r.ok) { console.error(`verify: REFUSED (${r.reason}) — the app would keep its current list and log EM-7111`); return 1; }
  console.log(`verify: OK — kid ${r.kid}, seq ${r.registry.seq}, ${r.registry.models.length} model(s)`);
  return 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return 0; }
  const { values } = parseArgs({ args: rest, options: opts, strict: true, allowPositionals: false });
  if (values.help) { console.log(HELP); return 0; }
  const run = { prepare: cmdPrepare, sign: cmdSign, verify: cmdVerify }[cmd];
  if (!run) throw new MirrorError(`unknown command ${cmd}\n\n${HELP}`, 2);
  return run(values);
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(`model-mirror: ${e instanceof MirrorError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? e.message : e?.stack ?? e}`);
  process.exitCode = e instanceof MirrorError ? e.exitCode : 1;
});
