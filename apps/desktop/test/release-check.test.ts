// Release safety: scripts/release-check.mjs fails while Operator placeholders remain (run first by `npm run release:win`).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(__dirname, '../../../scripts/release-check.mjs');
function fakeRepo(placeholders: boolean): string {
  const r = mkdtempSync(join(tmpdir(), 'em-relcheck-'));
  const put = (rel: string, text: string) => { mkdirSync(join(r, rel, '..'), { recursive: true }); writeFileSync(join(r, rel), text); };
  put('apps/service/src/license/keys.ts', `export const PRODUCTION_PUBLIC_KEY_A1_HEX = '${placeholders ? 'PLACEHOLDER_REPLACE_WITH_X' : 'ab'.repeat(32)}';`);
  put('packages/models/src/signed-registry.ts', `export const MANIFEST_PUBLIC_KEY_M1_HEX = '${placeholders ? 'PLACEHOLDER_REPLACE_WITH_Y' : 'cd'.repeat(32)}';`);
  put('packages/models/src/registry.ts', `// TO_PIN until pinned\nexport const TO_PIN = 'TO_PIN' as const;\n${placeholders ? "const f = { sha256: TO_PIN, revision: TO_PIN };\n" : "const f = { sha256: 'ee', revision: 'abc' };\n"}`);
  return r;
}
const run = (root: string, env: Record<string, string>, extra: string[] = []) =>
  spawnSync(process.execPath, [script, `--root=${root}`, ...extra], { env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8' });
const good = { EM_PUBLISHER_NAME: 'PT Contoh Kreatif', EM_FEED_URL: 'https://updates.expertmotion.app/win', EM_RELEASE_PRIVATE_KEY_PEM: 'pem', EM_ENGINE_PUBLIC_KEY_B64: 'b64', EM_MODEL_CDN_URL: 'https://models.expertmotion.app',
  EM_LICENSE_PUBLIC_KEY_A1_HEX: 'ab'.repeat(32), EM_MANIFEST_PUBLIC_KEY_M1_HEX: 'cd'.repeat(32) };

describe('release-check', () => {
  it('fails and lists every placeholder the Operator must supply', () => {
    const r = run(fakeRepo(true), {});
    expect(r.status).toBe(1);
    for (const s of ['EM_LICENSE_PUBLIC_KEY_A1_HEX', 'EM_MANIFEST_PUBLIC_KEY_M1_HEX', 'TO_PIN', 'EM_PUBLISHER_NAME', 'EM_FEED_URL', 'EM_RELEASE_PRIVATE_KEY_PEM', 'EM_ENGINE_PUBLIC_KEY_B64', 'EM_MODEL_CDN_URL']) expect(r.stderr).toContain(s);
  });
  it('rejects the example feed URL and a placeholder publisher', () => {
    const r = run(fakeRepo(false), { ...good, EM_FEED_URL: 'https://updates.expertmotion.example/win', EM_PUBLISHER_NAME: '<exact certificate subject CN>' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('EM_FEED_URL'); expect(r.stderr).toContain('EM_PUBLISHER_NAME');
  });
  it('flags the model CDN placeholder, http and r2.dev; with a real CDN, TO_PIN is only a note (signed CDN manifest pins the files)', () => {
    for (const bad of ['', 'PLACEHOLDER_SET_EM_MODEL_CDN_URL', 'http://models.expertmotion.app', 'https://pub-0123.r2.dev', 'https://models.expertmotion.example']) {
      const r = run(fakeRepo(false), { ...good, EM_MODEL_CDN_URL: bad });
      expect(r.status, bad).toBe(1); expect(r.stderr).toContain('EM_MODEL_CDN_URL');
    }
    const pinned = run(fakeRepo(true), { ...good, EM_MODEL_CDN_URL: 'https://models.expertmotion.app/v1' });
    expect(pinned.stderr).not.toContain('TO_PIN'); expect(pinned.stdout).toContain('TO_PIN');
  });
  it('rejects public keys that are not 64 hex characters', () => {
    const r = run(fakeRepo(false), { ...good, EM_LICENSE_PUBLIC_KEY_A1_HEX: 'xyz', EM_MANIFEST_PUBLIC_KEY_M1_HEX: 'ab'.repeat(31) });
    expect(r.status).toBe(1); expect(r.stderr).toContain('EM_LICENSE_PUBLIC_KEY_A1_HEX'); expect(r.stderr).toContain('EM_MANIFEST_PUBLIC_KEY_M1_HEX');
  });
  it('passes when everything is supplied; --allow-placeholders lets only a test build continue', () => {
    expect(run(fakeRepo(false), good).status).toBe(0);
    const t = run(fakeRepo(true), {}, ['--allow-placeholders']);
    expect(t.status).toBe(0);
    expect(t.stderr).toContain('never ship');
  });
});
