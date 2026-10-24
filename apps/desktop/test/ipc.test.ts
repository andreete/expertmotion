import { describe, expect, it } from 'vitest';
import { isTrustedSender } from '../src/lib/ipc.js';

describe('IPC sender validation (SEC-030)', () => {
  it('accepts the Editor main frame on the app origin', () => {
    expect(isTrustedSender({ url: 'app://expertmotion/index.html', isMainFrame: true })).toBe(true);
  });

  it('rejects iframes even on the app origin', () => {
    expect(isTrustedSender({ url: 'app://expertmotion/index.html', isMainFrame: false })).toBe(false);
  });

  it('rejects foreign origins', () => {
    expect(isTrustedSender({ url: 'https://attacker.test/', isMainFrame: true })).toBe(false);
    expect(isTrustedSender({ url: 'app://evil/index.html', isMainFrame: true })).toBe(false);
  });

  it('accepts the dev origin only when it is in the policy', () => {
    const facts = { url: 'http://127.0.0.1:4120/', isMainFrame: true };
    expect(isTrustedSender(facts)).toBe(false);
    expect(isTrustedSender(facts, { devOrigins: ['http://127.0.0.1:4120'] })).toBe(true);
  });
});
