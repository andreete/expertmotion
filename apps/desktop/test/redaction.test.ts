import { describe, expect, it } from 'vitest';
import { redact } from '@expertmotion/shared';

// The Shell logs through @expertmotion/shared `redact` (SEC-100); apps/desktop must not import
// service code, but the redactor lives in shared and is the single source of patterns.
describe('log redaction (SEC-100) as used by the Shell', () => {
  it('redacts bearer tokens, query tokens, grants and provider keys', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop0123456789')).toContain('[REDACTED]');
    expect(redact('GET /api/v1/events?token=supersecretvalue1234')).toContain('token=[REDACTED]');
    expect(redact('sk-ant-0123456789abcdef')).toContain('[REDACTED]');
    const media = '/media/' + 'a'.repeat(43) + '/01H.../thumb';
    expect(redact(media)).toContain('[REDACTED]');
  });

  it('leaves ordinary log text intact', () => {
    expect(redact('service ready on 127.0.0.1:42350')).toBe('service ready on 127.0.0.1:42350');
  });
});
