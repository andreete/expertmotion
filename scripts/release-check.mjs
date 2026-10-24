#!/usr/bin/env node
// Release gate (DEPLOYMENT_AND_PACKAGING.md, SEC-045, SEC-072, SEC-092…096): run by `npm run release:win` BEFORE anything is built.
// Fails while any Operator-supplied value is still a placeholder, and lists exactly what the Operator must supply.
// Usage: node scripts/release-check.mjs [--root=<repo>] [--allow-placeholders]
//   --allow-placeholders  prints the same list but exits 0; only for the Linux TEST cross-build (scripts/cross-build-win.sh,
//                         poc/WINDOWS_RUNBOOK.md §7). A build made that way must never be shipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const root = path.resolve(argv.find((a) => a.startsWith('--root='))?.slice(7) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const allow = argv.includes('--allow-placeholders');
const env = process.env;
const problems = [];
const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { problems.push(`${rel}: file missing`); return ''; } };

// 1. Licence verification public key (LICENSE_OPERATIONS.md; SEC-045)
if (/PLACEHOLDER_REPLACE/.test(read('apps/service/src/license/keys.ts')))
  problems.push('apps/service/src/license/keys.ts: PRODUCTION_PUBLIC_KEY_A1_HEX is a placeholder → paste the Operator\'s Ed25519 licence public key (hex).');
// 2. Model manifest public key (SEC-072)
if (/PLACEHOLDER_REPLACE/.test(read('packages/models/src/signed-registry.ts')))
  problems.push('packages/models/src/signed-registry.ts: MANIFEST_PUBLIC_KEY_M1_HEX is a placeholder → paste the Operator\'s offline manifest-signing public key (hex).');
// 3. Model registry hashes/revisions (LOCAL_AI_MODELS §4: pinned HF commit + sha256 per file)
{
  const reg = read('packages/models/src/registry.ts');
  const uses = reg.split('\n').filter((l) => /\bTO_PIN\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/export const TO_PIN\b/.test(l) && !/\/\/.*TO_PIN/.test(l.replace(/'[^']*'/g, '')));
  if (uses.length) problems.push(`packages/models/src/registry.ts: ${uses.length} line(s) still use TO_PIN → pin every model file to an HF commit (revision) and its sha256.`);
}
// 4. Code-signing publisher and update feed (SEC-092, SEC-096)
const pub = env.EM_PUBLISHER_NAME ?? '';
if (!pub || /[<>]/.test(pub)) problems.push('EM_PUBLISHER_NAME is not set → the exact subject CN of the Operator\'s OV code-signing certificate (electron-builder publisherName).');
const feed = env.EM_FEED_URL ?? '';
if (!/^https:\/\//.test(feed) || /\.(example|invalid|test|localhost)(\/|$)|example\.(com|org)/.test(feed)) problems.push('EM_FEED_URL is not set to the real HTTPS update feed → the pinned electron-updater feed URL (SEC-096).');
// 5. Release signing key for the integrity manifest (apps/desktop/scripts/harden.mjs)
if (!env.EM_RELEASE_PRIVATE_KEY_PEM) problems.push('EM_RELEASE_PRIVATE_KEY_PEM is not set → the Ed25519 release private key (PEM) that signs the integrity manifest.');
if (!env.EM_ENGINE_PUBLIC_KEY_B64) problems.push('EM_ENGINE_PUBLIC_KEY_B64 is not set → the matching public key (SPKI DER, base64) embedded in the main bundle.');

if (!problems.length) { console.log('release-check: OK — no placeholders left.'); process.exit(0); }
console[allow ? 'warn' : 'error'](`release-check: ${problems.length} item(s) the Operator must supply before a release:\n  - ${problems.join('\n  - ')}`);
if (allow) { console.warn('release-check: --allow-placeholders given — TEST build only, never ship it.'); process.exit(0); }
process.exit(1);
