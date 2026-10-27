// Entry 28: the dev-only provider stub (EM_DEV_PROVIDER_STUB) behind the egress module — dev builds only, 127.0.0.1 only, never
// 3000/4000, the allow-list still checks the ORIGINAL https URL, and release builds compile it out.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { devProviderStubOrigin, stubUrl, withDevProviderStub } from '../../src/s3/dev-provider-stub.js';
import { createEgress } from '../../src/services/egress.js';
import { listModels } from '../../src/s3/adapters.js';

describe('devProviderStubOrigin', () => {
  it('is on only in dev, for plain http on 127.0.0.1 with a port', () => {
    expect(devProviderStubOrigin(true, 'http://127.0.0.1:4140')).toBe('http://127.0.0.1:4140');
    expect(devProviderStubOrigin(true, 'http://127.0.0.1:4140/')).toBe('http://127.0.0.1:4140');
    expect(devProviderStubOrigin(false, 'http://127.0.0.1:4140')).toBeNull();          // packaged Service: cfg.dev = false
    expect(devProviderStubOrigin(true, undefined)).toBeNull();
    for (const bad of ['https://127.0.0.1:4140', 'http://localhost:4140', 'http://10.0.0.2:4140', 'http://127.0.0.1', 'http://127.0.0.1:4000', 'http://127.0.0.1:3000',
      'http://u:p@127.0.0.1:4140', 'http://127.0.0.1:4140/x', 'http://127.0.0.1:4140/?a=1', 'not a url', 'http://evil.example:4140'])
      expect(devProviderStubOrigin(true, bad), bad).toBeNull();
  });
});

describe('stub rewrite', () => {
  const o = 'http://127.0.0.1:4140';
  it('maps the four provider hosts to a path prefix and leaves everything else alone', () => {
    expect(stubUrl('https://api.anthropic.com/v1/models?limit=1000', o)).toBe(`${o}/anthropic/v1/models?limit=1000`);
    expect(stubUrl('https://openrouter.ai/api/v1/chat/completions', o)).toBe(`${o}/openrouter/api/v1/chat/completions`);
    expect(stubUrl('https://api.openai.com/v1/models', o)).toBe(`${o}/openai/v1/models`);
    expect(stubUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-pro:generateContent', o)).toBe(`${o}/gemini/v1beta/models/gemini-3.5-pro:generateContent`);
    expect(stubUrl('https://huggingface.co/x/resolve/main/model.onnx', o)).toBe('https://huggingface.co/x/resolve/main/model.onnx');
    expect(stubUrl('http://api.anthropic.com/v1/models', o)).toBe('http://api.anthropic.com/v1/models');   // only https provider URLs
  });

  it('runs behind the egress checks: allow-list and Private Mode see the original URL', async () => {
    const seen: string[] = [];
    const impl = (async (u: string | URL | Request) => { seen.push(typeof u === 'string' ? u : u instanceof URL ? u.href : u.url);
      return new Response(JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
    let priv = false;
    const egress = createEgress({ isPrivate: () => priv, impl: withDevProviderStub(impl, o) });
    const rows = await listModels('anthropic', 'sk-ant-test', egress.for('provider-models'));
    expect(rows.map((r) => [r.modelId, r.label])).toEqual([['claude-opus-5-5', 'Claude Opus 5.5']]);
    expect(seen).toEqual([`${o}/anthropic/v1/models?limit=1000`]);
    await expect(egress.for('provider')('https://evil.example/v1/models')).rejects.toMatchObject({ code: 'EM-8203' });
    priv = true;
    await expect(egress.for('provider')('https://api.anthropic.com/v1/models')).rejects.toMatchObject({ code: 'EM-8202' });
    expect(seen).toHaveLength(1);
    // Request objects keep method and body
    priv = false;
    await withDevProviderStub(impl, o)(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(seen.at(-1)).toBe(`${o}/openai/v1/chat/completions`);
  });
});

describe('release builds', () => {
  it('build.mjs --encrypt-prompts defines EM_DEV_PROVIDER_STUB (and the agent dump) as undefined', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/build.mjs'), 'utf8');
    expect(src).toMatch(/encrypt \? \{[^}]*'process\.env\.EM_DEV_PROVIDER_STUB': 'undefined'/);
    expect(src).toMatch(/encrypt \? \{[^}]*'process\.env\.EM_DEBUG_AGENT_DUMP': 'undefined'/);
  });
});
