// QA P1 2026-10-29 (round 1): a wrong key (Anthropic 401 "invalid x-api-key") was only ever shown as "New keys can take 1–2
// minutes to become active". The provider's reason is always named; the hint only for a key from the last 5 minutes and only
// next to that reason. The same for OpenAI, Gemini (400 API_KEY_INVALID, was EM-4105) and OpenRouter.
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { validateKey } from '../../src/s3/adapters.js';
import { keyRefusedMessage } from '../../src/s3/keys.js';
import { fakeEgress, json } from './s3-helpers.js';

const INVALID = {
  anthropic: () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
  openai: () => json(401, { error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }),
  google: () => json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }),
  openrouter: () => json(401, { error: { message: 'User not found.', code: 401 } }),
} as const;
const fetchOf = (r: () => Response) => (async () => r()) as unknown as typeof fetch;

describe('QA P1: an invalid key is named as invalid, with the provider reason', () => {
  it('every provider\'s invalid-key answer is EM-4002 with the provider reason (Gemini 400 included)', async () => {
    await expect(validateKey('anthropic', 'k', fetchOf(INVALID.anthropic))).rejects.toMatchObject({ code: 'EM-4002', details: { status: 401, reason: 'invalid x-api-key' } });
    await expect(validateKey('openai', 'k', fetchOf(INVALID.openai))).rejects.toMatchObject({ code: 'EM-4002', details: { status: 401, reason: expect.stringMatching(/^Incorrect API key provided: sk-proj-ab…/) } });
    await expect(validateKey('google', 'k', fetchOf(INVALID.google))).rejects.toMatchObject({ code: 'EM-4002', details: { status: 400, reason: 'API key not valid. Please pass a valid API key.' } });
    await expect(validateKey('google', 'k', fetchOf(() => json(400, { error: { code: 400, message: 'API key expired. Please renew the API key.', status: 'INVALID_ARGUMENT' } })))).rejects.toMatchObject({ code: 'EM-4002' });
    await expect(validateKey('openrouter', 'k', fetchOf(INVALID.openrouter))).rejects.toMatchObject({ code: 'EM-4002', details: { status: 401, reason: 'User not found.' } });
    // a 400 that is not about the key stays a refusal
    await expect(validateKey('google', 'k', fetchOf(() => json(400, { error: { code: 400, message: 'Invalid JSON payload received.', status: 'INVALID_ARGUMENT' } })))).rejects.toMatchObject({ code: 'EM-4105' });
  });

  it('keyRefusedMessage: the reason always, the 1–2 minute hint only for a recent key AND only next to a reason', () => {
    expect(keyRefusedMessage('anthropic', 'invalid x-api-key', false)).toBe('anthropic says this key is not valid: "invalid x-api-key". Check that it was copied completely and is still active.');
    expect(keyRefusedMessage('anthropic', 'invalid x-api-key', true)).toMatch(/"invalid x-api-key"\. .* New keys can take 1–2 minutes to become active\.$/);
    expect(keyRefusedMessage('anthropic', undefined, true)).not.toContain('1–2 minutes');
    expect(keyRefusedMessage('anthropic', '', false)).not.toContain('1–2 minutes');
  });

  describe('routes', () => {
    let s: TestService; let accept = true;
    beforeAll(async () => {
      s = await startService({ modules: [health, settingsModule, providersModule] });
      fakeEgress(s, [(c) => {
        if (!c.url.startsWith('https://api.anthropic.com/')) return undefined;
        if (!accept) return INVALID.anthropic();
        return c.url.includes('/models') ? json(200, { data: [{ id: 'claude-test', display_name: 'Claude Test', max_input_tokens: 200000 }], has_more: false }) : undefined;
      }]);
    });
    afterAll(async () => { await s.close(); });
    afterEach(() => { vi.useRealTimers(); accept = true; });

    it('dry run with a wrong Anthropic key: 422 EM-4002, the message names "invalid x-api-key"', async () => {
      accept = false;
      const r = await s.api('/providers/validate', { method: 'POST', json: { provider: 'anthropic', secret: 'sk-ant-api03-wrongwrongwrong' } });
      expect(r.status).toBe(422);
      const e = ((await r.json()) as { error: { code: string; message: string; details: { reason?: string; recentKey?: boolean } } }).error;
      expect(e.code).toBe('EM-4002');
      expect(e.details).toMatchObject({ reason: 'invalid x-api-key', recentKey: true });
      expect(e.message).toContain('"invalid x-api-key"');
    });

    it('a stored connection older than 5 minutes: the reason, and NO "1–2 minutes" hint', async () => {
      const add = await s.api('/providers/connections', { method: 'POST', json: { provider: 'anthropic', label: 'Claude', secret: 'sk-ant-api03-goodgoodgood' } });
      expect(add.status).toBe(201);
      const id = ((await add.json()) as { id: string }).id;
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 6 * 60_000);
      s.ctx.db.prepare('UPDATE provider_connections SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 6 * 60_000).toISOString(), id);
      accept = false;
      const r = await s.api(`/providers/connections/${id}/validate`, { method: 'POST' });
      expect(r.status).toBe(422);
      const e = ((await r.json()) as { error: { code: string; message: string; details: { reason?: string; recentKey?: boolean } } }).error;
      expect(e).toMatchObject({ code: 'EM-4002', details: { reason: 'invalid x-api-key', recentKey: false } });
      expect(e.message).toContain('invalid x-api-key');
      expect(e.message).not.toContain('1–2 minutes');
    });
  });
});
